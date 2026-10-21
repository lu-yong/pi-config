/**
 * Native resolution (read path): Pi's own DefaultPackageManager.resolve()
 * is the oracle; this module projects its ResolvedPaths onto extmgr's
 * ExtensionEntry view (tier state matrix + provenance).
 *
 * The hand-written replication of Pi's resolution semantics (pattern
 * precedence, standalone discovery, package replace/delta filters, cross-tier
 * dedupe) lived in resolve.ts before Pi 1.3.0 exported the resolver; keeping
 * it meant re-verifying on every Pi upgrade (commit 378d2d5 fixed one such
 * drift). The golden fixtures in `test/fixtures/resolution-rules.ts` and the
 * tests in `test/native-*.test.ts` now pin Pi's semantics through the native
 * resolver itself.
 *
 * I/O: settings/manifest/package reads happen inside the native resolver.
 * This module never writes and never installs: the `onMissing` hook returns
 * "skip", so a declared-but-missing package simply yields no rows.
 */

import { basename } from "node:path";
import {
	DefaultPackageManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { ExtensionEntry, TierState } from "./resolve.ts";

/** Native PathMetadata (package-manager.d.ts), narrowed to what we map. */
interface PathMetadataLike {
	source: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	baseDir?: string;
	packageRoot?: string;
}

interface ResolvedResourceLike {
	path: string;
	enabled: boolean;
	metadata: PathMetadataLike;
}

export interface NativeEnv {
	agentDir: string;
	cwd: string;
}

/** One native resolve pass. `projectTrusted: false` yields the global-only
 * view (the project tier's settings are ignored entirely). */
async function resolveView(env: NativeEnv, projectTrusted: boolean): Promise<ResolvedResourceLike[]> {
	const settingsManager = SettingsManager.create(env.cwd, env.agentDir, { projectTrusted });
	const manager = new DefaultPackageManager({
		cwd: env.cwd,
		agentDir: env.agentDir,
		settingsManager,
		builtinExtensions: [],
	});
	const resolved = await manager.resolve(() => Promise.resolve("skip"));
	return resolved.extensions as ResolvedResourceLike[];
}

/**
 * Derive the display name the way the old enumeration did: package files and
 * top-level standalone files show their basename; a standalone file inside a
 * subdirectory shows its path relative to the tier's `extensions/` directory
 * (so two `index.ts` siblings stay distinguishable in the picker).
 */
function displayName(res: ResolvedResourceLike): string {
	const meta = res.metadata;
	if (meta.origin === "top-level" && meta.baseDir && res.path.startsWith(`${meta.baseDir}/extensions/`)) {
		return res.path.slice(meta.baseDir.length + "/extensions/".length);
	}
	return basename(res.path);
}

/**
 * Resolve the extension list through Pi's own resolver.
 *
 * Two passes rebuild the per-tier state matrix:
 * - the merged pass (project settings honored) is authoritative: it decides
 *   which rows exist and their effective state; a row whose native scope is
 *   `project` carries the project tier's verdict (package deltas included —
 *   the delta is processed first, so its vote wins `addResource` first-wins);
 * - the global-only pass (project settings ignored) supplies the global
 *   tier's own verdict for the same path. Only paths shared between the two
 *   passes — a project delta resolving over the global install — get both
 *   cells; every other row is unmanaged in the tier that never declared it.
 */
export async function resolveNative(env: NativeEnv): Promise<ExtensionEntry[]> {
	const [merged, globalOnly] = await Promise.all([
		resolveView(env, true),
		resolveView(env, false),
	]);
	const globalVotes = new Map(globalOnly.map((res) => [res.path, res]));

	return merged.map((res): ExtensionEntry => {
		const meta = res.metadata;
		const tier = meta.scope === "user" ? "global" : "project";
		const globalVote = globalVotes.get(res.path);
		const global: TierState = globalVote ? (globalVote.enabled ? "on" : "off") : "unmanaged";
		const project: TierState = tier === "project" ? (res.enabled ? "on" : "off") : "unmanaged";
		const isPackage = meta.origin === "package";
		const root = meta.packageRoot;
		return {
			id: res.path,
			name: displayName(res),
			kind: isPackage ? "package" : "standalone",
			packageSource: isPackage ? meta.source : undefined,
			relPath: isPackage && root && res.path.startsWith(`${root}/`) ? res.path.slice(root.length + 1) : undefined,
			tier,
			states: {
				global,
				project,
				effective: res.enabled ? "on" : "off",
			},
		};
	});
}
