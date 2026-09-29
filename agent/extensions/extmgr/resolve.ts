/**
 * Pure enumeration + effective-state computation for Pi extensions.
 *
 * Replicates Pi's resource-resolution semantics (pattern precedence, per-tier
 * filtering, union, package replace/delta dedupe) as pinned by
 * `test/fixtures/resolution-rules.ts` (ported from pi-coding-agent 0.87.1).
 * No I/O: the snapshot is assembled by the caller (index.ts).
 */

import { basename } from "node:path";
import { minimatch } from "minimatch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = "global" | "project";
export type TierState = "on" | "off" | "unmanaged";

/** Object-form `packages` entry in a settings file. */
export interface PackageSettingsEntry {
	source: string;
	autoload?: boolean;
	extensions?: string[];
}

export interface TierSnapshot {
	/** Tier baseDir (`~/.pi/agent` or `<cwd>/.pi`). */
	baseDir: string;
	/** Parsed settings.json of that tier (tolerant: `{}` when missing). */
	settings: Record<string, unknown>;
	/** Recursive file listing under `<baseDir>/extensions` (posix rel paths,
	 * dot-entries and node_modules skipped, package.json files included). */
	extensionListing: string[];
}

export interface PackageSourceSnapshot {
	/** Settings source string, e.g. `npm:pi-open-tui`. */
	source: string;
	/** The settings entry as declared (string or object form). */
	entry: string | PackageSettingsEntry;
	scope: Tier;
	/** Installed package root (posix abs), undefined when not installed. */
	root?: string;
	/** Recursive file listing of the package root (posix rel paths). */
	rootFiles?: string[];
}

export interface PiManifest {
	extensions?: string[];
}

export interface Snapshot {
	global: TierSnapshot;
	project: TierSnapshot;
	/** Package sources declared by both tiers (raw; dedupe happens here). */
	packages: PackageSourceSnapshot[];
	/** `pi` manifests by absolute directory of the containing package.json. */
	manifests: Record<string, PiManifest | undefined>;
}

export interface ExtensionEntry {
	/** Canonical absolute posix path. */
	id: string;
	/** File basename, e.g. `tui.ts`. */
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

// ---------------------------------------------------------------------------
// Pattern matching (matchesAnyPattern / matchesAnyExactPattern semantics)
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
	return p.split("\\").join("/");
}

function matchesGlob(filePath: string, pattern: string, baseDir: string): boolean {
	const rel = toPosix(relativePosix(baseDir, filePath));
	const name = basename(filePath);
	const abs = toPosix(filePath);
	return minimatch(rel, pattern) || minimatch(name, pattern) || minimatch(abs, pattern);
}

function normalizeExact(pattern: string): string {
	const stripped = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosix(stripped);
}

function matchesExact(filePath: string, pattern: string, baseDir: string): boolean {
	const normalized = normalizeExact(pattern);
	const rel = toPosix(relativePosix(baseDir, filePath));
	const abs = toPosix(filePath);
	return normalized === rel || normalized === abs;
}

function relativePosix(from: string, to: string): string {
	// Both inputs are absolute posix paths.
	if (to.startsWith(from + "/")) return to.slice(from.length + 1);
	return to;
}

/** `isEnabledByOverrides`: default on; `!glob` excludes; `+exact` re-includes;
 * `-exact` excludes with highest precedence. */
export function isEnabledByOverrides(
	filePath: string,
	overrides: string[],
	baseDir: string,
): boolean {
	const excludes = overrides.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
	const forceIncludes = overrides.filter((p) => p.startsWith("+")).map((p) => p.slice(1));
	const forceExcludes = overrides.filter((p) => p.startsWith("-")).map((p) => p.slice(1));
	let enabled = true;
	if (excludes.some((p) => matchesGlob(filePath, p, baseDir))) enabled = false;
	if (forceIncludes.some((p) => matchesExact(filePath, p, baseDir))) enabled = true;
	if (forceExcludes.some((p) => matchesExact(filePath, p, baseDir))) enabled = false;
	return enabled;
}

// ---------------------------------------------------------------------------
// Standalone discovery (collectAutoExtensionEntries semantics, data-driven)
// ---------------------------------------------------------------------------

const CODE_EXT = /\.(ts|js)$/;

/** Turn a tier's recursive `extensions/` listing into the files Pi loads. */
export function discoverStandaloneFiles(listing: string[]): string[] {
	const top = listing.filter((rel) => !rel.includes("/") && CODE_EXT.test(rel));
	const byDir = new Map<string, string[]>();
	for (const rel of listing) {
		const idx = rel.lastIndexOf("/");
		if (idx === -1) continue;
		const dir = rel.slice(0, idx);
		if (!byDir.has(dir)) byDir.set(dir, []);
		byDir.get(dir)!.push(rel.slice(idx + 1));
	}
	const subResults: string[] = [];
	for (const [dir, files] of byDir) {
		// Only immediate subdirectories of the tier's extensions/ root.
		if (dir.includes("/")) continue;
		if (files.includes("index.ts")) {
			subResults.push(`${dir}/index.ts`);
			continue;
		}
		if (files.includes("index.js")) {
			subResults.push(`${dir}/index.js`);
		}
	}
	return [...top, ...subResults].sort();
}

// ---------------------------------------------------------------------------
// Package file enumeration
// ---------------------------------------------------------------------------

/** Extension files of an installed package: manifest entries, else the
 * conventional `extensions/` subtree (smart discovery). */
export function packageExtensionFiles(pkg: PackageSourceSnapshot, manifest?: PiManifest): string[] {
	if (!pkg.root) return [];
	const entries = manifest?.extensions;
	if (entries && entries.length > 0) {
		const rootFiles = new Set(pkg.rootFiles ?? []);
		const out: string[] = [];
		for (const raw of entries) {
			// Override patterns (!/+/-) are filters, not source entries.
			if (raw.startsWith("!") || raw.startsWith("+") || raw.startsWith("-")) continue;
			const e = raw.replace(/^\.\//, "");
			if (e.includes("*") || e.includes("?")) {
				// Glob entry: match package-root-relative paths (Pi expandPackageGlob).
				for (const rel of rootFiles) {
					if (minimatch(rel, e)) out.push(`${pkg.root}/${rel}`);
				}
				continue;
			}
			if (rootFiles.has(e)) {
				out.push(`${pkg.root}/${e}`);
				continue;
			}
			// Directory entry: smart-discover extension files inside (Pi
			// collectResourceFiles → collectAutoExtensionEntries).
			const prefix = `${e}/`;
			const sub = [...rootFiles].filter((rel) => rel.startsWith(prefix)).map((rel) => rel.slice(prefix.length));
			for (const rel of discoverStandaloneFiles(sub)) {
				out.push(`${pkg.root}/${prefix}${rel}`);
			}
		}
		return out;
	}
	const strip = "extensions/";
	const conventional = (pkg.rootFiles ?? [])
		.filter((rel) => rel.startsWith(strip))
		.map((rel) => rel.slice(strip.length));
	return discoverStandaloneFiles(conventional).map((rel) => `${pkg.root}/${strip}${rel}`);
}

function asStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function tierOwnedStates(tier: Tier, on: boolean): ExtensionEntry["states"] {
	const state: TierState = on ? "on" : "off";
	return {
		global: tier === "global" ? state : "unmanaged",
		project: tier === "project" ? state : "unmanaged",
		effective: on ? "on" : "off",
	};
}

// ---------------------------------------------------------------------------
// Package filter semantics (applyPatterns / applyAutoloadDisabledPatterns)
// ---------------------------------------------------------------------------

/** Replace-entry filter: plain includes narrow, `!` excludes, `+` exact
 * force-includes, `-` exact force-excludes (highest precedence). Empty
 * pattern array disables every file. */
function applyPackagePatterns(files: string[], patterns: string[], baseDir: string): Map<string, boolean> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];
	for (const p of patterns) {
		if (p.startsWith("+")) forceIncludes.push(p.slice(1));
		else if (p.startsWith("-")) forceExcludes.push(p.slice(1));
		else if (p.startsWith("!")) excludes.push(p.slice(1));
		else includes.push(p);
	}
	let result = includes.length === 0 ? [...files] : files.filter((f) => includes.some((p) => matchesGlob(f, p, baseDir)));
	if (excludes.length > 0) result = result.filter((f) => !excludes.some((p) => matchesGlob(f, p, baseDir)));
	if (forceIncludes.length > 0) {
		for (const f of files) {
			if (!result.includes(f) && forceIncludes.some((p) => matchesExact(f, p, baseDir))) result.push(f);
		}
	}
	if (forceExcludes.length > 0) result = result.filter((f) => !forceExcludes.some((p) => matchesExact(f, p, baseDir)));
	return new Map(files.map((f) => [f, result.includes(f)]));
}

/** Delta-entry filter (`autoload: false`): annotates only matched files;
 * later patterns win for the same file. Empty array annotates nothing. */
function applyDeltaPatterns(files: string[], patterns: string[], baseDir: string): Map<string, boolean> {
	const result = new Map<string, boolean>();
	for (const pattern of patterns) {
		const exact = pattern.startsWith("+") || pattern.startsWith("-");
		const negated = pattern.startsWith("-") || pattern.startsWith("!");
		const target = pattern.slice(pattern.length > 0 && "+-!".includes(pattern[0]) ? 1 : 0);
		for (const f of files) {
			if (exact ? matchesExact(f, target, baseDir) : matchesGlob(f, target, baseDir)) {
				result.set(f, !negated);
			}
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Package dedupe (dedupePackages + findAutoloadDeltaBase)
// ---------------------------------------------------------------------------

function isDeltaEntry(entry: string | PackageSettingsEntry): boolean {
	return typeof entry === "object" && entry.autoload === false;
}

function packageIdentity(source: string): string {
	if (source.startsWith("npm:")) {
		const spec = source.slice("npm:".length);
		const m = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
		return `npm:${m?.[1] ?? spec}`;
	}
	return source;
}

interface PkgResolution {
	source: string;
	entry: string | PackageSettingsEntry;
	scope: Tier;
	/** Owning tier of the files (delta resolves over the global install). */
	fileTier: Tier;
	root?: string;
	files: string[];
}

function resolvePackageFiles(pkg: PackageSourceSnapshot, snapshot: Snapshot): { root?: string; files: string[]; fileTier: Tier } {
	if (pkg.scope === "project" && isDeltaEntry(pkg.entry)) {
		// findAutoloadDeltaBase: the same-identity global entry is the install base.
		const identity = packageIdentity(pkg.source);
		const base = snapshot.packages.find((p) => p.scope === "global" && packageIdentity(p.source) === identity);
		const root = base?.root ?? pkg.root;
		if (!root) return { root: undefined, files: [], fileTier: "global" };
		const files = packageExtensionFiles({ ...pkg, root, rootFiles: base?.rootFiles ?? pkg.rootFiles }, snapshot.manifests[root]);
		return { root, files, fileTier: "global" };
	}
	if (!pkg.root) return { root: undefined, files: [], fileTier: pkg.scope };
	return { root: pkg.root, files: packageExtensionFiles(pkg, snapshot.manifests[pkg.root]), fileTier: pkg.scope };
}

/** Pi's dedupePackages over [project entries..., user entries...]: first
 * occurrence wins; same-identity user entries survive only when the kept
 * project entry is an autoload:false delta; later project entries replace. */
function dedupePackageSources(packages: PackageSourceSnapshot[], snapshot: Snapshot): PkgResolution[] {
	const ordered = [
		...packages.filter((p) => p.scope === "project"),
		...packages.filter((p) => p.scope === "global"),
	];
	const result: PkgResolution[] = [];
	const seen = new Map<string, number>();
	for (const pkg of ordered) {
		const identity = packageIdentity(pkg.source);
		const index = seen.get(identity);
		if (index === undefined) {
			seen.set(identity, result.length);
			const r = resolvePackageFiles(pkg, snapshot);
			result.push({ source: pkg.source, entry: pkg.entry, scope: pkg.scope, ...r });
			continue;
		}
		const existing = result[index]!;
		if (existing.scope === "project" && pkg.scope === "global" && isDeltaEntry(existing.entry)) {
			const r = resolvePackageFiles(pkg, snapshot);
			result.push({ source: pkg.source, entry: pkg.entry, scope: pkg.scope, ...r });
		} else if (pkg.scope === "project") {
			const r = resolvePackageFiles(pkg, snapshot);
			result[index] = { source: pkg.source, entry: pkg.entry, scope: pkg.scope, ...r };
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Merge a later entry into an earlier one for the same path: the earlier
 * effective state wins (mirrors Pi's first-wins addResource with
 * project-first processing), the later fills unmanaged tier slots. */
function mergeStates(existing: ExtensionEntry["states"], later: ExtensionEntry["states"]): ExtensionEntry["states"] {
	return {
		global: existing.global === "unmanaged" ? later.global : existing.global,
		project: existing.project === "unmanaged" ? later.project : existing.project,
		effective: existing.effective,
	};
}

export function resolveExtensions(snapshot: Snapshot): ExtensionEntry[] {
	const entries: ExtensionEntry[] = [];

	// Standalone extensions per tier.
	for (const tier of ["global", "project"] as const) {
		const t = snapshot[tier];
		const overrides = asStrings(t.settings.extensions);
		for (const rel of discoverStandaloneFiles(t.extensionListing)) {
			const abs = `${t.baseDir}/extensions/${rel}`;
			const on = isEnabledByOverrides(abs, overrides, t.baseDir);
			entries.push({
				id: abs,
				name: rel.includes("/") ? rel : basename(rel),
				kind: "standalone",
				tier,
				states: tierOwnedStates(tier, on),
			});
		}
	}

	// Package extensions: dedupe sources, then emit one entry per file with
	// filter-applied states, merging same-path entries.
	for (const r of dedupePackageSources(snapshot.packages, snapshot)) {
		if (!r.root) continue;
		const filter = typeof r.entry === "object" ? r.entry : undefined;
		let fileStates: Map<string, boolean> | undefined;
		if (filter?.autoload === false) {
			fileStates = applyDeltaPatterns(r.files, filter.extensions ?? [], r.root);
		} else if (filter && filter.extensions !== undefined) {
			fileStates = applyPackagePatterns(r.files, filter.extensions, r.root);
		}
		for (const abs of r.files) {
			const relPath = abs.slice(r.root!.length + 1);
			let entry: ExtensionEntry;
			if (filter?.autoload === false) {
				// Delta: only annotated files get an entry, owned by the project tier;
				// the global base resolution later fills the global slot via merge.
				const annotated = fileStates?.get(abs);
				if (annotated === undefined) continue;
				entry = {
					id: abs,
					name: basename(relPath),
					kind: "package",
					packageSource: r.source,
					relPath,
					tier: r.fileTier,
					states: tierOwnedStates("project", annotated),
				};
			} else {
				// String entry or object entry without delta semantics.
				let on = true;
				if (filter && filter.extensions !== undefined) {
					// Empty pattern array explicitly disables every file.
					on = filter.extensions.length === 0 ? false : (fileStates?.get(abs) ?? false);
				}
				entry = {
					id: abs,
					name: basename(relPath),
					kind: "package",
					packageSource: r.source,
					relPath,
					tier: r.fileTier,
					states: tierOwnedStates(r.fileTier, on),
				};
			}
			const existing = entries.find((e) => e.id === abs);
			if (existing) {
				existing.states = mergeStates(existing.states, entry.states);
			} else {
				entries.push(entry);
			}
		}
	}

	// Dedupe by canonical path, first occurrence wins.
	const seen = new Set<string>();
	return entries.filter((e) => {
		if (seen.has(e.id)) return false;
		seen.add(e.id);
		return true;
	});
}
