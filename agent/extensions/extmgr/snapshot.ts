/**
 * Snapshot assembly (read-path composition): native resolution (native.ts —
 * Pi's own resolver is the oracle) + live-loaded annotation, projected onto
 * extmgr's package-only management view. Per ADR-0002 extmgr manages npm
 * packages only; standalone extensions surface as a count, never as rows.
 */

import type { ExtmgrEnv } from "./env.ts";
import { resolveNative } from "./native.ts";
import type { ExtensionEntry } from "./resolve.ts";

export interface SourceInfoLike {
	path: string;
	source: string;
	scope: string;
	origin: string;
}

export type LoadedEntry = ExtensionEntry & { loaded: boolean };

/** Merge live command/tool source metadata into enumerated entries: an
 * entry is loaded when some live SourceInfo was registered from its
 * canonical path (runtime ground truth, per design). Pure — inputs are not
 * mutated. */
export function annotateLoaded(entries: ExtensionEntry[], sources: SourceInfoLike[]): LoadedEntry[] {
	const livePaths = new Set(sources.map((s) => s.path));
	return entries.map((e) => ({ ...e, loaded: livePaths.has(e.id) }));
}

/** A live-source provider that throws is uninformative, not fatal. */
export function safeSources(fn: () => SourceInfoLike[]): SourceInfoLike[] {
	try {
		return fn();
	} catch {
		return [];
	}
}

export interface Snapshot {
	/** Package extensions in resolved order (row order is picker.ts's). */
	packages: LoadedEntry[];
	/** Standalone extensions are not managed; only their count surfaces. */
	standaloneCount: number;
}

/** One read pass: resolve both tiers, annotate live loads, split packages
 * from the hidden standalone count. */
export async function loadSnapshot(env: ExtmgrEnv, liveSources?: () => SourceInfoLike[]): Promise<Snapshot> {
	const annotated = annotateLoaded(await resolveNative(env), safeSources(liveSources ?? (() => [])));
	const packages = annotated.filter((e) => e.kind === "package");
	return { packages, standaloneCount: annotated.length - packages.length };
}
