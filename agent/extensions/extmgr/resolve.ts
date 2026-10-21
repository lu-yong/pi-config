/**
 * Shared entry types for the extension enumeration view.
 *
 * The resolution logic itself (pattern precedence, standalone discovery,
 * package replace/delta filters, cross-tier dedupe) was a hand-written
 * replica of Pi's semantics until Pi 1.3.0 exported the resolver; the read
 * path now goes through `native.ts` (DefaultPackageManager.resolve()).
 * The golden fixtures in `test/fixtures/resolution-rules.ts` keep pinning
 * Pi's semantics through the native resolver.
 */

export type Tier = "global" | "project";
export type TierState = "on" | "off" | "unmanaged";

/** Object-form `packages` entry in a settings file. */
export interface PackageSettingsEntry {
	source: string;
	autoload?: boolean;
	extensions?: string[];
}

export interface ExtensionEntry {
	/** Canonical absolute posix path. */
	id: string;
	/** File basename, or rel-to-`extensions/` path for nested standalone files. */
	name: string;
	kind: "package" | "standalone";
	/** Settings source for package extensions. */
	packageSource?: string;
	/** Path relative to the package root (package extensions). */
	relPath?: string;
	/** Owning tier. */
	tier: Tier;
	states: {
		global: TierState;
		project: TierState;
		effective: "on" | "off";
	};
}
