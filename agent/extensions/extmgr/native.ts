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
 * Derive the display name: a standalone file under one of the two tiers'
 * `extensions/` roots shows its path relative to that root (so sibling
 * `index.ts` files stay distinguishable); everything else shows its basename.
 * Computed from the tier roots, not `metadata.baseDir`: explicit
 * `extensions:` settings entries resolve with `source: "local"` metadata that
 * carries no baseDir, and the old name would collapse to `index.ts`.
 */
function displayName(res: ResolvedResourceLike, env: NativeEnv): string {
	if (res.metadata.origin === "top-level") {
		for (const root of [`${env.agentDir}/extensions`, `${env.cwd}/.pi/extensions`]) {
			if (res.path.startsWith(`${root}/`)) return res.path.slice(root.length + 1);
		}
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
			name: displayName(res, env),
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
