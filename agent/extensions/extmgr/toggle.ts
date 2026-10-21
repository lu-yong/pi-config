/**
 * Pure toggle planning (IF-5): one requested action → either a
 * `SettingsMutation` (a pure transform of one tier's settings document) or an
 * `Unavailable` reason. Owns all "which native settings form encodes this
 * intent" decisions. Never performs I/O.
 */

import type { ExtensionEntry } from "./resolve.ts";

export type Scope = "global" | "project";
export type SettingsDoc = Record<string, unknown>;

export interface SettingsMutation {
	scope: Scope;
	/** Pure transform: returns the next document; must not mutate the input. */
	apply(doc: SettingsDoc): SettingsDoc;
}

export type PlanReason = "unavailable-native-limitation" | "untrusted-project" | "self-disable-unconfirmed";

export interface PlanInput {
	entry: ExtensionEntry;
	action: "enable" | "disable";
	scope: Scope;
	trusted: boolean;
	isSelf: boolean;
	selfConfirmed?: boolean;
	/** `package` = whole-package toggle (`extensions: []` / plain string);
	 * default `file` toggles one extension file. */
	level?: "file" | "package";
	/** Rel-to-package-root paths of every extension file the package declares
	 * (from enumeration); required for project-tier whole-package disable. */
	packageFiles?: string[];
	/** Tier roots, for standalone disable patterns (rel under the tier's
	 * extensions root, absolute elsewhere). */
	env: { agentDir: string; cwd: string };
}

export type PlanResult =
	| { ok: true; mutation: SettingsMutation }
	| { ok: false; reason: PlanReason; detail: string };

/** Disable pattern for a standalone extension file. Files under the owning
 * tier's `extensions/` root use the rel-to-baseDir form (`pi config` parity);
 * files resolved from outside that root (explicit `extensions:` entries
 * pointing elsewhere) use the absolute path — a rel pattern is interpreted
 * against the tier baseDir and silently fails to match them. */
function standaloneDisablePattern(id: string, scope: Scope, env: { agentDir: string; cwd: string }): string {
	const roots = scope === "global" ? [`${env.agentDir}/extensions/`] : [`${env.cwd}/.pi/extensions/`];
	if (roots.some((root) => id.startsWith(root))) {
		const baseDir = scope === "global" ? env.agentDir : `${env.cwd}/.pi`;
		return `-${id.slice(baseDir.length + 1)}`;
	}
	return `-${id}`;
}

function appendExtensionPattern(pattern: string): (doc: SettingsDoc) => SettingsDoc {
	return (doc) => {
		const extensions = Array.isArray(doc.extensions) ? [...doc.extensions] : [];
		if (!extensions.includes(pattern)) extensions.push(pattern);
		return { ...doc, extensions };
	};
}

export function planToggle(input: PlanInput): PlanResult {
	const { entry, action, scope, level } = input;

	if (input.isSelf && input.action === "disable" && !input.selfConfirmed) {
		return {
			ok: false,
			reason: "self-disable-unconfirmed",
			detail:
				"Disabling extmgr turns off the extension that provides this manager itself. Confirm explicitly to proceed; you can recover later via `pi config` (Extensions) or by editing settings.json.",
		};
	}

	if (scope === "project" && !input.trusted) {
		return {
			ok: false,
			reason: "untrusted-project",
			detail:
				"This project is not trusted, so project-tier settings cannot be written. Grant project trust first (the trust prompt on next start, or Pi's project-trust flow), then retry.",
		};
	}
	if (level === "package") {
		if (entry.kind !== "package" || !entry.packageSource) {
			return {
				ok: false,
				reason: "unavailable-native-limitation",
				detail: "Whole-package toggles require a package target.",
			};
		}
		const source = entry.packageSource;
		if (action === "disable" && scope === "global") {
			// Convert the owning tier's entry to `{ source, extensions: [] }`:
			// disables all extensions while skills/prompts/themes stay declared.
			return { ok: true, mutation: { scope, apply: convertPackageEntry(source) } };
		}
		if (action === "enable" && scope === "global") {
			// Drop extension filters; simplify back to a plain string when no
			// other keys remain.
			return { ok: true, mutation: { scope, apply: simplifyPackageEntry(source) } };
		}
		if (action === "disable" && scope === "project") {
			// pi-config-parity delta over the same-identity global entry: one
			// `-rel` pattern per declared extension file (empty arrays are loader
			// no-ops and are never written).
			const patterns = (input.packageFiles ?? []).map((rel) => `-${rel}`);
			if (patterns.length === 0) {
				return {
					ok: false,
					reason: "unavailable-native-limitation",
					detail: `Package ${source} declares no extension files to disable.`,
				};
			}
			return { ok: true, mutation: { scope, apply: upsertProjectDelta(source, patterns) } };
		}
		return {
			ok: false,
			reason: "unavailable-native-limitation",
			detail: `Cannot ${action} package ${source} at the ${scope} tier in this slice.`,
		};
	}

	if (entry.kind === "standalone" && entry.tier === scope) {
		const pattern = standaloneDisablePattern(entry.id, scope, input.env);
		if (action === "disable") {
			return { ok: true, mutation: { scope, apply: appendExtensionPattern(pattern) } };
		}
		// Re-enable: remove the extmgr-authored disable pattern.
		return { ok: true, mutation: { scope, apply: removeExtensionPattern(pattern) } };
	}

	return {
	ok: false,
	reason: "unavailable-native-limitation",
	detail: `Cannot ${action} this ${entry.kind} extension at the ${scope} tier: the requested control cell is not expressible in native Pi settings.`,
};
}

function removeExtensionPattern(pattern: string): (doc: SettingsDoc) => SettingsDoc {
	return (doc) => {
		const extensions = Array.isArray(doc.extensions) ? doc.extensions.filter((p) => p !== pattern) : [];
		return { ...doc, extensions };
	};
}

/** Re-enable a package at its owning tier: drop extension filters and
 * simplify the entry back to a plain string when no other keys remain. */
function simplifyPackageEntry(source: string): (doc: SettingsDoc) => SettingsDoc {
	return (doc) => {
		const packages = Array.isArray(doc.packages) ? [...doc.packages] : [];
		const idx = packages.findIndex((p) => (typeof p === "string" ? p === source : p?.source === source));
		if (idx === -1) return doc;
		const current = packages[idx]!;
		if (typeof current === "string") return doc;
		const rest = { ...current };
		delete rest.extensions;
		const keys = Object.keys(rest);
		packages[idx] = keys.length === 1 && "source" in rest ? source : rest;
		return { ...doc, packages };
	};
}

/** Map a `packages` entry: string → `{ source, extensions: [] }`; object →
 * same with `extensions: []`. Leaves non-matching entries untouched, in order. */
function convertPackageEntry(source: string): (doc: SettingsDoc) => SettingsDoc {
	return (doc) => {
		const packages = Array.isArray(doc.packages) ? [...doc.packages] : [];
		const idx = packages.findIndex((p) => (typeof p === "string" ? p === source : p?.source === source));
		if (idx === -1) return doc;
		packages[idx] = { source, extensions: [] };
		return { ...doc, packages };
	};
}

/** Upsert the project-tier delta entry for `source`: append
 * `{ source, autoload: false, extensions: patterns }` when absent; merge into
 * an existing delta; an existing project-owned (replace) entry disables all
 * of its extensions instead. Unrelated entries stay untouched, in order. */
function upsertProjectDelta(source: string, patterns: string[]): (doc: SettingsDoc) => SettingsDoc {
	return (doc) => {
		const packages = Array.isArray(doc.packages) ? [...doc.packages] : [];
		const idx = packages.findIndex((p) => (typeof p === "string" ? p === source : p?.source === source));
		if (idx === -1) {
			packages.push({ source, autoload: false, extensions: patterns });
			return { ...doc, packages };
		}
		const current = packages[idx]!;
		if (typeof current === "string") {
			// Project-owned package: replace form, load none of its extensions.
			packages[idx] = { source, extensions: [] };
			return { ...doc, packages };
		}
		if (current.autoload === false) {
			const merged = [...(current.extensions ?? [])];
			for (const p of patterns) {
				if (!merged.includes(p)) merged.push(p);
			}
			packages[idx] = { ...current, extensions: merged };
			return { ...doc, packages };
		}
		packages[idx] = { ...current, extensions: [] };
		return { ...doc, packages };
	};
}
