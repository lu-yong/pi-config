/**
 * Golden resolution reference — Pi resource-resolution semantics.
 *
 * Ported from `pi-coding-agent@0.87.1` `dist/core/package-manager.js`,
 * verified against source during exploration. Every case records the rule it
 * pins and the expected outcome. `resolve.ts` tests must reproduce these
 * outcomes; drift here means Pi changed and extmgr must be re-verified.
 *
 * Scope: extensions only (skills/prompts/themes share the same helpers but are
 * out of extmgr's scope).
 */

// ---------------------------------------------------------------------------
// Types (plain data only — no imports, loadable anywhere)
// ---------------------------------------------------------------------------

/** Auto-discovered standalone extension evaluated against a tier's top-level
 * `extensions` override array (source: `isEnabledByOverrides`). */
export interface OverrideCase {
	rule: string;
	/** Tier baseDir (posix absolute). */
	baseDir: string;
	/** Absolute path of the extension file (posix). */
	filePath: string;
	/** Top-level `extensions` array entries from that tier's settings. */
	overrides: string[];
	expectedEnabled: boolean;
}

/** One file of a package, evaluated against the settings entry (`filter`)
 * that controls the package (source: `applyPackageFilter` /
 * `applyPackageDeltaFilter`). */
export interface PackageFilterCase {
	rule: string;
	/** Package root == filter baseDir (posix absolute). */
	packageRoot: string;
	filePath: string;
	/** Object-form settings entry controlling the package (or undefined for a
	 * plain string entry = no filtering). */
	filter:
		| undefined
		| { autoload?: boolean; extensions?: string[] };
	expectedEnabled: boolean;
	/** True when the file must be listed with `enabled: false` (delta entries
	 * only annotate matched files; empty delta arrays annotate nothing). */
	expectedListed: boolean;
}

/** Dedupe of `packages` entries across tiers (source: `dedupePackages` +
 * `findAutoloadDeltaBase`). */
export interface DedupeCase {
	rule: string;
	globalPackages: Array<string | { source: string; autoload?: boolean; extensions?: string[] }>;
	projectPackages: Array<string | { source: string; autoload?: boolean; extensions?: string[] }>;
	/** Sources the resolver must process, in order, with the entry's own
	 * settings object attached (delta base resolves to the user entry). */
	expectedResolutions: Array<{
		source: string;
		scope: "user" | "project";
		/** The settings entry whose filter applies (object form or plain). */
		filter:
			| undefined
			| { autoload?: boolean; extensions?: string[] };
		/** Where the package is read from when filter is defined by a
		 * different tier's entry (delta base). */
		installedFromScope: "user" | "project";
	}>;
}

// ---------------------------------------------------------------------------
// Rule 1 — pattern precedence on auto-discovered standalone extensions
// (isEnabledByOverrides: default on; `!glob` excludes; `+exact` re-includes;
// `-exact` excludes last. Precedence: -exact > +exact > !glob > default-on)
// ---------------------------------------------------------------------------

export const OVERRIDE_PRECEDENCE_CASES: readonly OverrideCase[] = [
	{
		rule: "no patterns → default enabled",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: [],
		expectedEnabled: true,
	},
	{
		rule: "-exact (relative to tier baseDir) disables",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: ["-extensions/qna.ts"],
		expectedEnabled: false,
	},
	{
		rule: "-exact does NOT match by bare file name (exact = rel-to-baseDir or absolute only; bare names only work for glob patterns)",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: ["-qna.ts"],
		expectedEnabled: true,
	},
	{
		rule: "-exact matches absolute posix path",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: ["-/home/u/.pi/agent/extensions/qna.ts"],
		expectedEnabled: false,
	},
	{
		rule: "-exact with ./ prefix normalizes to rel path",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: ["-./extensions/qna.ts"],
		expectedEnabled: false,
	},
	{
		rule: "!glob excludes by relative glob",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: ["!extensions/*.ts"],
		expectedEnabled: false,
	},
	{
		rule: "!glob matches bare name",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: ["!qna.*"],
		expectedEnabled: false,
	},
	{
		rule: "!glob does not match non-matching file",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: ["!other/*.ts"],
		expectedEnabled: true,
	},
	{
		rule: "+exact overrides !glob",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: ["!extensions/*.ts", "+extensions/qna.ts"],
		expectedEnabled: true,
	},
	{
		rule: "-exact overrides +exact",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: ["!extensions/*.ts", "+extensions/qna.ts", "-extensions/qna.ts"],
		expectedEnabled: false,
	},
	{
		rule: "-exact overrides +exact even when listed first",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: ["-extensions/qna.ts", "+extensions/qna.ts"],
		expectedEnabled: false,
	},
	{
		rule: "exact patterns match absolute posix path too (+)",
		baseDir: "/home/u/.pi/agent",
		filePath: "/home/u/.pi/agent/extensions/qna.ts",
		overrides: ["!extensions/*.ts", "+/home/u/.pi/agent/extensions/qna.ts"],
		expectedEnabled: true,
	},
];

// ---------------------------------------------------------------------------
// Rule 2 — tier isolation: each tier's overrides apply only to that tier's
// resources; per-tier resolution then union (addAutoDiscoveredResources).
// ---------------------------------------------------------------------------

export const TIER_ISOLATION_CASES: readonly OverrideCase[] = [
	{
		rule: "global -exact does not touch project-tier file",
		baseDir: "/home/u/.pi/agent",
		filePath: "/work/proj/.pi/extensions/helper.ts",
		overrides: ["-helper.ts"],
		expectedEnabled: true,
	},
	{
		rule: "project-tier file controlled by project baseDir rel path",
		baseDir: "/work/proj/.pi",
		filePath: "/work/proj/.pi/extensions/helper.ts",
		overrides: ["-extensions/helper.ts"],
		expectedEnabled: false,
	},
	{
		rule: "same file reachable from both tiers stays on unless its owning tier disables it",
		baseDir: "/work/proj/.pi",
		filePath: "/work/proj/.pi/extensions/helper.ts",
		overrides: ["-extensions/other.ts"],
		expectedEnabled: true,
	},
];

// ---------------------------------------------------------------------------
// Rule 3 — package filters (applyPackageFilter for replace entries,
// applyPackageDeltaFilter for autoload:false delta entries)
// ---------------------------------------------------------------------------

export const PACKAGE_FILTER_CASES: readonly PackageFilterCase[] = [
	{
		rule: "plain string entry (no filter) → all package files enabled",
		packageRoot: "/home/u/.pi/agent/npm/node_modules/pi-open-tui",
		filePath: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/extensions/tui.ts",
		filter: undefined,
		expectedEnabled: true,
		expectedListed: true,
	},
	{
		rule: "replace entry with extensions: [] disables every file",
		packageRoot: "/home/u/.pi/agent/npm/node_modules/pi-open-tui",
		filePath: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/extensions/tui.ts",
		filter: { extensions: [] },
		expectedEnabled: false,
		expectedListed: true,
	},
	{
		rule: "replace entry with -rel disables that file only",
		packageRoot: "/home/u/.pi/agent/npm/node_modules/pi-open-tui",
		filePath: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/extensions/tui.ts",
		filter: { extensions: ["-extensions/tui.ts"] },
		expectedEnabled: false,
		expectedListed: true,
	},
	{
		rule: "replace entry plain include narrows to matching files",
		packageRoot: "/home/u/.pi/agent/npm/node_modules/pi-open-tui",
		filePath: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/extensions/other.ts",
		filter: { extensions: ["extensions/tui.ts"] },
		expectedEnabled: false,
		expectedListed: true,
	},
	{
		rule: "replace entry !glob excludes matching files",
		packageRoot: "/home/u/.pi/agent/npm/node_modules/pi-open-tui",
		filePath: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/extensions/tui.ts",
		filter: { extensions: ["!extensions/t*.ts"] },
		expectedEnabled: false,
		expectedListed: true,
	},
	{
		rule: "delta entry (autoload:false) with extensions: [] annotates nothing — base entry stays authoritative",
		packageRoot: "/home/u/.pi/agent/npm/node_modules/pi-open-tui",
		filePath: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/extensions/tui.ts",
		filter: { autoload: false, extensions: [] },
		expectedEnabled: true,
		expectedListed: false,
	},
	{
		rule: "delta entry with -rel disables that file",
		packageRoot: "/home/u/.pi/agent/npm/node_modules/pi-open-tui",
		filePath: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/extensions/tui.ts",
		filter: { autoload: false, extensions: ["-extensions/tui.ts"] },
		expectedEnabled: false,
		expectedListed: true,
	},
	{
		rule: "delta entry patterns are relative to the package root (bare file at root, not tier baseDir)",
		packageRoot: "/home/u/.pi/agent/npm/node_modules/pi-open-tui",
		filePath: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/tui.ts",
		filter: { autoload: false, extensions: ["-tui.ts"] },
		expectedEnabled: false,
		expectedListed: true,
	},
	{
		rule: "delta entry glob disable also matches",
		packageRoot: "/home/u/.pi/agent/npm/node_modules/pi-open-tui",
		filePath: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/extensions/tui.ts",
		filter: { autoload: false, extensions: ["!**/tui.ts"] },
		expectedEnabled: false,
		expectedListed: true,
	},
	{
		rule: "later delta pattern wins for the same file",
		packageRoot: "/home/u/.pi/agent/npm/node_modules/pi-open-tui",
		filePath: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/extensions/tui.ts",
		filter: { autoload: false, extensions: ["-extensions/tui.ts", "+extensions/tui.ts"] },
		expectedEnabled: true,
		expectedListed: true,
	},
];

// ---------------------------------------------------------------------------
// Rule 4 — cross-tier package dedupe (dedupePackages + findAutoloadDeltaBase)
// ---------------------------------------------------------------------------

export const PACKAGE_DEDUPE_CASES: readonly DedupeCase[] = [
	{
		rule: "project entry replaces same-identity global entry",
		globalPackages: ["npm:pi-open-tui"],
		projectPackages: [{ source: "npm:pi-open-tui", extensions: [] }],
		expectedResolutions: [{ source: "npm:pi-open-tui", scope: "project", filter: { extensions: [] }, installedFromScope: "project" }],
	},
	{
		rule: "distinct identities coexist",
		globalPackages: ["npm:pi-open-tui"],
		projectPackages: ["npm:pi-web-access"],
		expectedResolutions: [
			{ source: "npm:pi-open-tui", scope: "user", filter: undefined, installedFromScope: "user" },
			{ source: "npm:pi-web-access", scope: "project", filter: undefined, installedFromScope: "project" },
		],
	},
	{
		rule: "autoload:false project entry is kept as delta over the same-identity global base",
		globalPackages: ["npm:pi-open-tui"],
		projectPackages: [{ source: "npm:pi-open-tui", autoload: false, extensions: ["-extensions/tui.ts"] }],
		expectedResolutions: [
			// Processing order: project entries first, then user entries.
			{
				source: "npm:pi-open-tui",
				scope: "project",
				filter: { autoload: false, extensions: ["-extensions/tui.ts"] },
				installedFromScope: "user",
			},
			{ source: "npm:pi-open-tui", scope: "user", filter: undefined, installedFromScope: "user" },
		],
	},
	{
		rule: "object entry with filters replaces global string entry (not a delta: autoload not false)",
		globalPackages: ["npm:pi-open-tui"],
		projectPackages: [{ source: "npm:pi-open-tui", extensions: ["extensions/tui.ts"] }],
		expectedResolutions: [{ source: "npm:pi-open-tui", scope: "project", filter: { extensions: ["extensions/tui.ts"] }, installedFromScope: "project" }],
	},
	{
		rule: "same package declared in both tiers as strings → project wins",
		globalPackages: ["npm:pi-open-tui"],
		projectPackages: ["npm:pi-open-tui"],
		expectedResolutions: [{ source: "npm:pi-open-tui", scope: "project", filter: undefined, installedFromScope: "project" }],
	},
];

// ---------------------------------------------------------------------------
// Rule 5 — standalone discovery shape (collectAutoExtensionEntries /
// resolveExtensionEntries): inputs for enumeration provenance
// ---------------------------------------------------------------------------

export interface DiscoveryCase {
	rule: string;
	/** Directory listing of a tier's `extensions/` dir (recursive, relative
	 * posix paths). */
	listing: string[];
	/** Files Pi loads as extensions from this listing (absolute posix paths
	 * under the given baseDir). */
	expected: string[];
}

export const STANDALONE_DISCOVERY_CASES: readonly DiscoveryCase[] = [
	{
		rule: "top-level .ts/.js files load directly",
		listing: ["qna.ts", "notes.js", "readme.md", "data.json"],
		expected: ["<base>/qna.ts", "<base>/notes.js"],
	},
	{
		rule: "subdirectory with index.ts loads the index as one extension",
		listing: ["qna.ts", "helper/index.ts", "helper/util.ts"],
		expected: ["<base>/qna.ts", "<base>/helper/index.ts"],
	},
	{
		rule: "subdirectory whose package.json declares pi.extensions: [ext/a.ts, ext/b.ts] loads those entries",
		listing: ["pkg/package.json", "pkg/ext/a.ts", "pkg/ext/b.ts"],
		expected: ["<base>/pkg/ext/a.ts", "<base>/pkg/ext/b.ts"],
	},
	{
		rule: "node_modules and dot-directories are skipped",
		listing: ["qna.ts", "node_modules/x/index.ts", ".hidden/y.ts"],
		expected: ["<base>/qna.ts"],
	},
];

// ---------------------------------------------------------------------------
// Rule 6 — union + loaded dedupe (addResource first-wins by path;
// toResolvedPaths dedupes by canonicalized path, keeps first by precedence
// rank: package(4) > user-local(2)/user-auto(3) > project-local(0)/project-auto(1))
// ---------------------------------------------------------------------------

export const UNION_PRECEDENCE_NOTE = {
	rule: "first addResource for a path wins; list is re-sorted by precedence rank then deduped by canonical path",
	precedenceRank: "package=4, user-top-level-auto=3, user-local=2, project-top-level-auto=1, project-local=0",
	lowerRankSortsFirst: "project entries sort before user entries; earlier-sorted survivor is kept on canonical-path collision",
} as const;

/** Loadability marker for the smoke test. */
export const FIXTURES_VERSION = "pi-0.87.1";
