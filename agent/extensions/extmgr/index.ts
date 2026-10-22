import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionEntry } from "./resolve.ts";
import { resolveNative } from "./native.ts";
import { persistToggle } from "./persist.ts";
import { loadSnapshot, type SourceInfoLike, type LoadedEntry } from "./snapshot.ts";
import { openPickerSession, type PickerHost } from "./picker-session.ts";

export { annotateLoaded, loadSnapshot } from "./snapshot.ts";
export type { SourceInfoLike, LoadedEntry, Snapshot } from "./snapshot.ts";
export { persistToggle } from "./persist.ts";
export type { ExtmgrEnv } from "./env.ts";
export { openPickerSession, PickerSession } from "./picker-session.ts";
export type { PickerHost, PickerComponent, PickerSessionDeps } from "./picker-session.ts";
export type { PickerTheme, PickerView } from "./picker.ts";

import type { ExtmgrEnv } from "./env.ts";

/**
 * extmgr — in-session extension management for Pi.
 *
 * Interface layer: registers the `manage_extensions` tool and the
 * `/extmgr` command. Read paths compose native resolution + live
 * annotation (snapshot.ts); writes go through persist.ts; the picker
 * interaction is owned by picker-session.ts.
 */

function defaultEnv(): ExtmgrEnv {
	return { agentDir: join(homedir(), ".pi", "agent"), cwd: process.cwd() };
}

// ---------------------------------------------------------------------------
// manage_extensions tool
// ---------------------------------------------------------------------------

function renderStateTable(entries: ExtensionEntry[]): string {
	const header = "| Name | Source | Tier | Global | Project | Effective |";
	const sep = "| --- | --- | --- | --- | --- | --- |";
	const rows = entries.map((e) => {
		const source = e.packageSource ?? "-";
		return `| ${e.name} | ${source} | ${e.tier} | ${e.states.global} | ${e.states.project} | ${e.states.effective} |`;
	});
	return [header, sep, ...rows].join("\n");
}

export function createManageExtensionsTool(env: ExtmgrEnv, liveSources?: () => SourceInfoLike[]): ToolDefinition {
	return {
		name: "manage_extensions",
		label: "Manage extensions",
		description:
			"List installed Pi extension packages with per-tier and effective states, or enable/disable a package at the global or project tier. Manages npm packages only — standalone extensions are not managed. Persists native Pi settings; changes apply after a reload.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("enable"), Type.Literal("disable")], {
				description: "list: show every package's state; enable/disable: toggle a package.",
			}),
			target: Type.Optional(Type.String({ description: "Package name (substring match), required for enable/disable." })),
			scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")], { description: "Write tier. Default: global." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<{ rows: LoadedEntry[] | ExtensionEntry[]; result?: ToolMutationResult }>> {
			if (params.action === "list") {
				// Scope: extmgr manages package extensions only. Standalone
				// extensions are counted in the note, never listed or toggled.
				const snap = await loadSnapshot(env, liveSources);
				const note = snap.standaloneCount > 0 ? `\n\n(${snap.standaloneCount} standalone extension(s) present — not managed by extmgr)` : "";
				return {
					content: [{ type: "text", text: renderStateTable(snap.packages) + note }],
					details: { rows: snap.packages },
				};
		}
		// Mutation actions: resolve the target to a package, plan, persist, and
		// report resulting states from a fresh snapshot.
		const scope = params.scope ?? "global";
		const trusted = ctx?.isProjectTrusted?.() ?? true;
		const entries = await resolveNative(env);
		const target = params.target ?? "";

		// Fuzzy match (IF-2): substring against package entries only —
		// standalone extensions are out of extmgr's management scope.
		const matched = entries.filter(
			(e) => e.kind === "package" && (e.name.includes(target) || e.packageSource?.includes(target)),
		);
		const pkgSources = [...new Set(matched.map((e) => e.packageSource!))];
		if (matched.length === 0) {
			const standaloneOnly = entries.some(
				(e) => e.kind === "standalone" && (e.name.includes(target) || e.packageSource?.includes(target)),
			);
			const text = standaloneOnly
				? `"${target}" matches only standalone extension(s), which extmgr does not manage; toggle those via settings files.`
				: `No installed package matches "${target}". Call list to see names.`;
			return {
				content: [{ type: "text", text }],
				details: { result: { status: "error", detail: `target-not-found: ${target}` }, rows: entries },
			};
		}
		if (pkgSources.length > 1) {
			return {
				content: [{ type: "text", text: `"${target}" matches multiple packages: ${pkgSources.join(", ")}. Retry with an unambiguous target.` }],
				details: { result: { status: "ambiguous", candidates: pkgSources }, rows: entries },
			};
		}

		const source = pkgSources[0]!;
		const pkgEntries = entries.filter((e) => e.packageSource === source);
		const pkgFiles = pkgEntries.map((e) => e.relPath!);
		if (params.action === "disable" && pkgFiles.length === 0) {
			return {
				content: [{ type: "text", text: `Package ${source} declares no extension files to disable.` }],
				details: { result: { status: "error", detail: `no extension files: ${source}` }, rows: entries },
			};
		}
		const targetEntry = pkgEntries[0]!;

		const out = await persistToggle(env, entries, targetEntry, params.action, scope, trusted);
		if (!out.ok) {
			return {
				content: [{ type: "text", text: out.detail }],
				details: { result: { status: "unavailable", detail: out.detail }, rows: entries },
			};
		}
		const after = await resolveNative(env);
		const affected = after.filter((e) => e.packageSource === source);
		const stillOnGlobally = affected.some((e) => e.states.global === "on");
		const note = scope === "project" && params.action === "disable" && stillOnGlobally ? " (still enabled globally)" : "";
		const text = [
			`${params.action === "disable" ? "Disabled" : "Enabled"} ${source} at the ${scope} tier${note}. Run /reload to apply.`,
			"",
			renderStateTable(affected),
		].join("\n");
		return {
			content: [{ type: "text", text }],
			details: { result: { status: "ok", entry: affected }, rows: after },
		};
	},
};
}

export interface ToolMutationResult {
	status: "ok" | "unavailable" | "ambiguous" | "error";
	detail?: string;
	candidates?: string[];
	entry?: ExtensionEntry[];
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function extmgrExtension(pi: ExtensionAPI, env?: ExtmgrEnv): void {
	const e = env ?? defaultEnv();
	const liveSources = () => {
		try {
			return [
				...pi.getCommands().map((c) => c.sourceInfo),
				...pi.getAllTools().map((t) => t.sourceInfo),
			];
		} catch {
			return [];
		}
	};
	pi.registerTool(createManageExtensionsTool(e, liveSources));
	pi.registerCommand("extmgr", {
		description: "Manage extension loading (interactive picker)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"/extmgr requires interactive (TUI) mode. Use the manage_extensions tool instead.",
					"info",
				);
				return;
			}
			const session = await openPickerSession({ env: e, liveSources, host: ctx as unknown as PickerHost });
			void session.open();
		},
	});
}
