import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionEntry } from "./resolve.ts";
import { resolveNative } from "./native.ts";
import { planToggle } from "./toggle.ts";
import { mutateSettings } from "./settings-io.ts";
import { PickerModel, ExtensionPicker } from "./picker.ts";
import { fileURLToPath } from "node:url";

export interface ToolMutationResult {
	status: "ok" | "unavailable" | "ambiguous" | "error";
	detail?: string;
	candidates?: string[];
	entry?: ExtensionEntry[];
}

/** Canonical path of this extension's own entry file (self-detection). */
const selfPath = fileURLToPath(import.meta.url);

/**
 * extmgr — in-session extension management for Pi.
 *
 * Interface layer: registers the `manage_extensions` tool (and later the
 * `/extmgr` command), assembles resolution snapshots from the two settings
 * tiers, and merges live annotation.
 */

export interface ExtmgrEnv {
	agentDir: string;
	cwd: string;
}

function defaultEnv(): ExtmgrEnv {
	return { agentDir: join(homedir(), ".pi", "agent"), cwd: process.cwd() };
}

// ---------------------------------------------------------------------------
// Read path: native resolution (native.ts). Snapshot assembly and the
// hand-written enumeration that used to live here were replaced by Pi's own
// resolver — the host's semantics are the oracle, not something to replicate.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Live annotation (loaded markers from runtime SourceInfo)
// ---------------------------------------------------------------------------

export interface SourceInfoLike {
	path: string;
	source: string;
	scope: string;
	origin: string;
}

export type LoadedEntry = ExtensionEntry & { loaded: boolean };

/** Merge live command/tool source metadata into enumerated entries:
 * an entry is loaded when some live SourceInfo was registered from its
 * canonical path (runtime ground truth, per design). Pure — inputs are not
 * mutated. */
export function annotateLoaded(entries: ExtensionEntry[], sources: SourceInfoLike[]): LoadedEntry[] {
	const livePaths = new Set(sources.map((s) => s.path));
	return entries.map((e) => ({ ...e, loaded: livePaths.has(e.id) }));
}

// ---------------------------------------------------------------------------
// manage_extensions tool
// ---------------------------------------------------------------------------

function renderStateTable(entries: ExtensionEntry[]): string {
	const header = "| Name | Source | Tier | Global | Project | Effective |";
	const sep = "| --- | --- | --- | --- | --- | --- |";
	const rows = entries.map((e) => {
		const source = e.kind === "package" ? e.packageSource! : "(standalone)";
		return `| ${e.name} | ${source} | ${e.tier} | ${e.states.global} | ${e.states.project} | ${e.states.effective} |`;
	});
	return [header, sep, ...rows].join("\n");
}

export function createManageExtensionsTool(env: ExtmgrEnv, liveSources?: () => SourceInfoLike[]): ToolDefinition {
	return {
		name: "manage_extensions",
		label: "Manage extensions",
		description:
			"List installed Pi extensions with per-tier and effective states, or enable/disable an extension or package at the global or project tier. Persists native Pi settings; changes apply after a reload.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("enable"), Type.Literal("disable")], {
				description: "list: show every extension's state; enable/disable: toggle a target.",
			}),
			target: Type.Optional(Type.String({ description: "Extension or package name (substring match), required for enable/disable." })),
			scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")], { description: "Write tier. Default: global." })),
			confirmSelfDisable: Type.Optional(Type.Boolean({ description: "Explicit confirmation to disable the extmgr extension itself (after asking the user)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<{ rows: LoadedEntry[] | ExtensionEntry[]; result?: ToolMutationResult }>> {
			if (params.action === "list") {
				const entries = await resolveNative(env);
				const rows = annotateLoaded(entries, liveSources ? liveSources() : []);
				return {
					content: [{ type: "text", text: renderStateTable(rows) }],
					details: { rows },
				};
		}
		// Mutation actions: resolve the target to a package, plan, persist, and
		// report resulting states from a fresh snapshot.
		const scope = params.scope ?? "global";
		const trusted = ctx?.isProjectTrusted?.() ?? true;
		const entries = await resolveNative(env);
		const target = params.target ?? "";

		// Fuzzy match (IF-2): substring against entry names and package sources.
		const matched = entries.filter((e) => e.name.includes(target) || e.packageSource?.includes(target));
		const standaloneMatches = matched.filter((e) => e.kind === "standalone");
		const pkgSources = [...new Set(matched.filter((e) => e.packageSource).map((e) => e.packageSource!))];
		const candidateLabels = [...standaloneMatches.map((e) => `${e.name} (standalone)`), ...pkgSources];
		if (matched.length === 0) {
			return {
				content: [{ type: "text", text: `No installed extension or package matches "${target}". Call list to see names.` }],
				details: { result: { status: "error", detail: `target-not-found: ${target}` }, rows: entries },
			};
		}
		if (candidateLabels.length > 1) {
			return {
				content: [{ type: "text", text: `"${target}" matches multiple targets: ${candidateLabels.join(", ")}. Retry with an unambiguous target.` }],
				details: { result: { status: "ambiguous", candidates: candidateLabels }, rows: entries },
			};
		}

		const isPackage = pkgSources.length === 1;
		const source = pkgSources[0] ?? "";
		const pkgEntries = isPackage ? entries.filter((e) => e.packageSource === source) : [];
		const pkgFiles = pkgEntries.map((e) => e.relPath!);
		if (isPackage && params.action === "disable" && pkgFiles.length === 0) {
			return {
				content: [{ type: "text", text: `Package ${source} declares no extension files to disable.` }],
				details: { result: { status: "error", detail: `no extension files: ${source}` }, rows: entries },
			};
		}
		const targetEntry = isPackage ? pkgEntries[0]! : standaloneMatches[0]!;

		const out = await persistToggle(env, entries, targetEntry, params.action, scope, trusted, {
			selfConfirmed: params.action === "disable" ? Boolean(params.confirmSelfDisable) : undefined,
		});
		if (!out.ok) {
			return {
				content: [{ type: "text", text: out.detail }],
				details: { result: { status: "unavailable", detail: out.detail }, rows: entries },
			};
		}
		const after = await resolveNative(env);
		const affected = isPackage ? after.filter((e) => e.packageSource === source) : after.filter((e) => e.id === targetEntry.id);
		const stillOnGlobally = affected.some((e) => e.states.global === "on");
		const note = scope === "project" && params.action === "disable" && stillOnGlobally ? " (still enabled globally)" : "";
		const text = [
			`${params.action === "disable" ? "Disabled" : "Enabled"} ${isPackage ? source : targetEntry.name} at the ${scope} tier${note}. Run /reload to apply.`,
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

function safeSources(fn: () => SourceInfoLike[]): SourceInfoLike[] {
	try {
		return fn();
	} catch {
		return [];
	}
}

/** Shared toggle persistence for the tool and the picker session.
 * Combines independent blockers (native limitation + missing trust). */
export async function persistToggle(
	env: ExtmgrEnv,
	entries: ExtensionEntry[],
	targetEntry: ExtensionEntry,
	action: "enable" | "disable",
	scope: "global" | "project",
	trusted: boolean,
	opts?: { selfConfirmed?: boolean },
): Promise<{ ok: true } | { ok: false; detail: string; reason: "unavailable-native-limitation" | "self-disable-unconfirmed" }> {
	const isPackage = targetEntry.kind === "package" && targetEntry.packageSource;
	const pkgFiles = isPackage
		? entries
				.filter((e) => e.packageSource === targetEntry.packageSource)
				.map((e) => e.relPath!)
				.filter((p): p is string => Boolean(p))
		: [];
	const plan = planToggle({
		entry: targetEntry,
		action,
		scope,
		trusted: true,
		isSelf: targetEntry.id === (env.selfPath ?? selfPath),
		selfConfirmed: opts?.selfConfirmed,
		level: isPackage ? "package" : "file",
		packageFiles: pkgFiles,
		env,
	});
	const trustBlocked = scope === "project" && !trusted;
	if (!plan.ok || trustBlocked) {
		const reasons: string[] = [];
		if (!plan.ok) reasons.push(`${plan.reason}: ${plan.detail}`);
		if (trustBlocked) {
			reasons.push(
				"untrusted-project: This project is not trusted; grant project trust before writing project-tier settings.",
			);
		}
		return {
			ok: false,
			detail: reasons.join(" | "),
			reason: !plan.ok && plan.reason === "self-disable-unconfirmed" ? "self-disable-unconfirmed" : "unavailable-native-limitation",
		};
	}
	await mutateSettings(env, scope, plan.mutation);
	return { ok: true };
}

interface PickerCtxLike {
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		confirm?(title: string, message: string): Promise<boolean | undefined>;
		custom?(factory: (tui: { requestRender(): void; terminal?: { rows: number } }, theme: unknown, keybindings: { matches(data: string, keybinding: string): boolean }, done: (result: unknown) => void) => unknown, options?: { overlay?: boolean }): Promise<unknown>;
	};
	reload(): Promise<void> | void;
	isProjectTrusted?(): boolean;
}

export interface ExtmgrSession {
	model: PickerModel;
	picker: ExtensionPicker;
	apply(): void;
	close(): void;
	/** Keymap entry point (component handleInput seam). */
	keys(data: string, requestRender?: () => void, keybindings?: { matches(data: string, keybinding: string): boolean }): void;
	/** Mount as the focused interactive component; resolves on close. */
	open(): Promise<unknown>;
}


/** Build the /extmgr picker session: model wired to real persistence,
 * interactive mount, keymap, and a single-reload Apply. */
export async function openPickerSession(
	env: ExtmgrEnv,
	liveSources: () => SourceInfoLike[],
	ctx: PickerCtxLike,
): Promise<ExtmgrSession> {
	const readEntries = async (): Promise<LoadedEntry[]> => annotateLoaded(await resolveNative(env), safeSources(liveSources));
	const model = new PickerModel({
		entries: await readEntries(),
		onReload: () => {
			void ctx.reload();
		},
		applyToggle: async (entry, action, tier, opts) => {
			const out = await persistToggle(
				env,
				await resolveNative(env),
				entry,
				action,
				tier,
				ctx.isProjectTrusted?.() ?? true,
				opts,
			);
			if (!out.ok) {
				return { ok: false, reason: out.reason, detail: out.detail };
			}
			model.setEntries(await readEntries());
			return { ok: true as const };
		},
	});
	const picker = new ExtensionPicker({ entries: model.visible() });
	let filterMode = false;

	const sync = () => {
		picker.setEntries(model.visible());
		picker.setTier(model.getTier());
		picker.setPendingCount(model.getPending().length);
		picker.setSelectedIndex(cursor());
		picker.setFilterHint(filterMode ? model.getFilter() : "");
	};

	/** Current cursor index within the canonical ordered visible rows. */
	const cursor = () => {
		const current = model.selected();
		const idx = model.visible().findIndex((e) => e === current);
		return idx === -1 ? 0 : idx;
	};

	let done: ((result: unknown) => void) | undefined;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		done?.(undefined);
	};

	const apply = () => {
		model.applyPending();
		sync();
	};

	/** Keymap shared by the custom component's handleInput and tests. */
	const keys = (
		data: string,
		requestRender?: () => void,
		keybindings?: { matches(data: string, keybinding: string): boolean },
	) => {
		const input = keybindings?.matches(data, "tui.select.up")
			? "\u001b[A"
			: keybindings?.matches(data, "tui.select.down")
				? "\u001b[B"
				: keybindings?.matches(data, "tui.select.confirm")
					? "\r"
					: keybindings?.matches(data, "tui.input.tab")
						? "\t"
						: keybindings?.matches(data, "tui.select.cancel")
							? "\u001b"
							: data;
		if (filterMode) {
			if (input === "\u001b" || input === "\r") filterMode = false;
			else if (["\u007f", "\b", "\u001b[3~"].includes(data)) model.setFilter(model.getFilter().slice(0, -1));
			else if (data >= " ") model.setFilter(model.getFilter() + data);
			model.selectIndex(0);
			sync();
			requestRender?.();
			return;
		}
		const visible = model.visible();
		const currentIdx = visible.indexOf(model.selected()!);
		switch (input) {
			case "\u001b[A":
			case "k":
				model.selectIndex(Math.max(0, currentIdx - 1));
				break;
			case "\u001b[B":
			case "j":
				model.selectIndex(Math.min(visible.length - 1, currentIdx + 1));
				break;
			case "\r":
				void model.enter().then(async (res) => {
					if (res.ok) {
						sync();
						requestRender?.();
						return;
					}
					if (res.reason === "self-disable-unconfirmed" && ctx.ui.confirm) {
						const yes = await ctx.ui.confirm("Disable extmgr itself?", res.detail ?? "");
						if (yes) {
							const again = await model.enter({ selfConfirmed: true });
							if (!again.ok) {
								ctx.ui.notify(again.detail ?? again.reason ?? "unavailable", "warning");
							}
						} else {
							ctx.ui.notify("Self-disable cancelled.", "info");
						}
						sync();
						requestRender?.();
						return;
					}
					ctx.ui.notify(res.detail ?? res.reason ?? "unavailable", "warning");
				}).catch((error: unknown) => {
					const detail = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Unable to update extension settings: ${detail}`, "error");
					requestRender?.();
				});
				break;
			case "\t":
				model.switchTier();
				break;
			case "/":
				filterMode = true;
				break;
			case "a":
				apply();
				close();
				return;
			case "q":
			case "\u001b":
				close();
				return;
			default:
				return;
		}
		sync();
		requestRender?.();
	};

	/** Mount the picker as the focused interactive component via
	 * ctx.ui.custom(); resolves when the user closes it. Falls back to a
	 * notify hint when custom() is unavailable. */
	const open = async (): Promise<unknown> => {
		if (!ctx.ui.custom) {
			ctx.ui.notify("/extmgr needs an interactive terminal with component support.", "warning");
			return undefined;
		}
		return ctx.ui.custom((tui, _theme, _keybindings, doneCb) => {
			done = doneCb;
			return {
				render: (width: number) => {
					picker.setMaxVisible(Math.max(1, (tui.terminal?.rows ?? 24) - 16));
					return picker.render(width);
				},
				invalidate: () => sync(),
				handleInput: (data: string) => keys(data, () => tui.requestRender(), _keybindings),
				dispose: () => {
					closed = true;
				},
			};
		}, { overlay: true });
	};

	sync();
	return { model, picker, apply, close, keys, open };
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
			const session = await openPickerSession(e, liveSources, ctx as unknown as PickerCtxLike);
			void session.open();
		},
	});
}
