import { describe, expect, it } from "vitest";
import { resolveExtensions, type Snapshot } from "../resolve.ts";
import { OVERRIDE_PRECEDENCE_CASES, PACKAGE_FILTER_CASES, TIER_ISOLATION_CASES } from "./fixtures/resolution-rules.ts";
import type { PackageSettingsEntry } from "../resolve.ts";

/** Pure-seam fixtures for IF-4 (spec scenario: Enumerate global package
 * extensions). Paths are posix; no filesystem involved. */

function baseSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		global: { baseDir: "/home/u/.pi/agent", settings: {}, extensionListing: [], ...overrides.global },
		project: { baseDir: "/work/proj/.pi", settings: {}, extensionListing: [], ...overrides.project },
		packages: overrides.packages ?? [],
		manifests: overrides.manifests ?? {},
	};
}

describe("resolveExtensions", () => {
	it("enumerates package extensions with provenance", () => {
		const root = "/home/u/.pi/agent/npm/node_modules/pi-open-tui";
		const snapshot = baseSnapshot({
			global: { baseDir: "/home/u/.pi/agent", settings: { packages: ["npm:pi-open-tui"] }, extensionListing: [] },
			packages: [
				{
					// Manifest-declared extension (`pi` key).
					source: "npm:pi-open-tui",
					entry: "npm:pi-open-tui",
					scope: "global",
					root,
					rootFiles: ["package.json", "extensions/tui.ts"],
				},
				{
					// Conventional `extensions/` directory, smart discovery.
					source: "npm:pi-conv",
					entry: "npm:pi-conv",
					scope: "global",
					root: "/home/u/.pi/agent/npm/node_modules/pi-conv",
					rootFiles: ["package.json", "extensions/plain.ts", "extensions/sub/index.ts", "extensions/sub/util.ts"],
				},
			],
			manifests: {
				[root]: { extensions: ["extensions/tui.ts"] },
			},
		});

		const entries = resolveExtensions(snapshot);

		const manifestEntry = entries.find((e) => e.packageSource === "npm:pi-open-tui");
		expect(manifestEntry).toBeDefined();
		expect(manifestEntry).toMatchObject({
			id: `${root}/extensions/tui.ts`,
			name: "tui.ts",
			kind: "package",
			packageSource: "npm:pi-open-tui",
			relPath: "extensions/tui.ts",
			tier: "global",
			states: { global: "on", project: "unmanaged", effective: "on" },
		});

		// Conventional dir: top-level file + subdir index (one entry each).
		const conv = entries.filter((e) => e.packageSource === "npm:pi-conv");
		expect(conv.map((e) => e.relPath).sort()).toEqual(["extensions/plain.ts", "extensions/sub/index.ts"]);
		for (const e of conv) {
			expect(e.tier).toBe("global");
			expect(e.kind).toBe("package");
			expect(e.id.startsWith("/home/u/.pi/agent/npm/node_modules/pi-conv/")).toBe(true);
		}
	});
	it("enumerates standalone entries in both tiers without duplicates", () => {
		const snapshot = baseSnapshot({
			global: {
				baseDir: "/home/u/.pi/agent",
				settings: {},
				extensionListing: ["qna.ts", "notes.js"],
			},
			project: {
				baseDir: "/work/proj/.pi",
				settings: {},
				extensionListing: ["helper.ts"],
			},
		});

		const entries = resolveExtensions(snapshot);

		const qna = entries.find((e) => e.id === "/home/u/.pi/agent/extensions/qna.ts");
		expect(qna).toMatchObject({
			kind: "standalone",
			tier: "global",
			states: { global: "on", project: "unmanaged", effective: "on" },
		});
		const helper = entries.find((e) => e.id === "/work/proj/.pi/extensions/helper.ts");
		expect(helper).toMatchObject({
			kind: "standalone",
			tier: "project",
			states: { global: "unmanaged", project: "on", effective: "on" },
		});

		// No duplicate entries for the same canonical path.
		expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
	});

	it("globally disabled standalone reports off/unmanaged/off", () => {
		const snapshot = baseSnapshot({
			global: {
				baseDir: "/home/u/.pi/agent",
				settings: { extensions: ["-extensions/qna.ts"] },
				extensionListing: ["qna.ts"],
			},
		});

		const qna = resolveExtensions(snapshot).find((e) => e.name === "qna.ts");
		expect(qna?.states).toEqual({ global: "off", project: "unmanaged", effective: "off" });
	});

	it("applies golden pattern-precedence and tier-isolation cases per tier", () => {
		const cases = [...OVERRIDE_PRECEDENCE_CASES, ...TIER_ISOLATION_CASES];
		for (const c of cases) {
			// Determine the owning tier: the fixture's baseDir when the file sits
			// under it, otherwise derive the owning baseDir from the file path
			// (cross-tier isolation cases) and treat c.baseDir as the writer tier.
			const ownsFile = c.filePath.startsWith(`${c.baseDir}/extensions/`);
			const ownerBaseDir = ownsFile ? c.baseDir : c.filePath.replace(/\/extensions\/[^/]+$/, "");
			const ownerTier: "global" | "project" = ownerBaseDir === c.baseDir ? (c.baseDir.includes("/proj") ? "project" : "global") : ownerBaseDir.includes("/proj") ? "project" : "global";
			const writerTier: "global" | "project" = ownerTier === "global" ? "project" : "global";
			const relInExtensions = c.filePath.slice(c.filePath.lastIndexOf("/") + 1);

			const snapshot = baseSnapshot({
				global: {
					baseDir: ownerTier === "global" ? ownerBaseDir : writerTier === "global" ? "/home/u/.pi/agent" : "/home/u/.pi/agent",
					settings: {},
					extensionListing: [],
				},
				project: {
					baseDir: ownerTier === "project" ? ownerBaseDir : "/work/proj/.pi",
					settings: {},
					extensionListing: [],
				},
			});
			snapshot[ownerTier].extensionListing = [relInExtensions];
			snapshot[ownerTier].baseDir = ownerBaseDir;
			// The tier whose settings carry the overrides:
			const settingsTier = ownsFile ? ownerTier : writerTier;
			snapshot[settingsTier].settings = { extensions: c.overrides };

			const entry = resolveExtensions(snapshot).find((e) => e.id === c.filePath);
			expect(entry, c.rule).toBeDefined();
			expect(
				entry!.states,
				c.rule,
			).toEqual({
				global: ownerTier === "global" ? (c.expectedEnabled ? "on" : "off") : "unmanaged",
				project: ownerTier === "project" ? (c.expectedEnabled ? "on" : "off") : "unmanaged",
				effective: c.expectedEnabled ? "on" : "off",
			});
		}
	});

	it("project delta disables one package extension only", () => {
		const root = "/home/u/.pi/agent/npm/node_modules/pi-open-tui";
		const snapshot = baseSnapshot({
			global: {
				baseDir: "/home/u/.pi/agent",
				settings: { packages: ["npm:pi-open-tui"] },
				extensionListing: [],
			},
			project: {
				baseDir: "/work/proj/.pi",
				settings: { packages: [{ source: "npm:pi-open-tui", autoload: false, extensions: ["-tui.ts"] }] },
				extensionListing: [],
			},
			packages: [
				{
					source: "npm:pi-open-tui",
					entry: { source: "npm:pi-open-tui", autoload: false, extensions: ["-tui.ts"] },
					scope: "project",
					// No project install: the delta resolves over the global install.
				},
				{ source: "npm:pi-open-tui", entry: "npm:pi-open-tui", scope: "global", root, rootFiles: ["package.json", "tui.ts", "other.ts"] },
			],
			manifests: { [root]: { extensions: ["tui.ts", "other.ts"] } },
		});

		const entries = resolveExtensions(snapshot);

		const tui = entries.find((e) => e.relPath === "tui.ts");
		expect(tui, "delta-disabled file enumerated once").toBeDefined();
		expect(tui?.states).toEqual({ global: "on", project: "off", effective: "off" });

		const other = entries.find((e) => e.relPath === "other.ts");
		expect(other?.states).toEqual({ global: "on", project: "unmanaged", effective: "on" });

		// No duplicate rows for the same package file.
		expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
	});

	it("project replace entry replaces the same-identity global entry", () => {
		const gRoot = "/home/u/.pi/agent/npm/node_modules/pi-replace";
		const pRoot = "/work/proj/.pi/npm/node_modules/pi-replace";
		const snapshot = baseSnapshot({
			global: {
				baseDir: "/home/u/.pi/agent",
				settings: { packages: ["npm:pi-replace"] },
				extensionListing: [],
			},
			project: {
				baseDir: "/work/proj/.pi",
				settings: { packages: [{ source: "npm:pi-replace", extensions: [] }] },
				extensionListing: [],
			},
			packages: [
				{ source: "npm:pi-replace", entry: { source: "npm:pi-replace", extensions: [] }, scope: "project", root: pRoot, rootFiles: ["package.json", "extensions/a.ts", "extensions/b.ts"] },
				{ source: "npm:pi-replace", entry: "npm:pi-replace", scope: "global", root: gRoot, rootFiles: ["package.json", "extensions/a.ts", "extensions/b.ts"] },
			],
			manifests: {
				[pRoot]: { extensions: ["extensions/a.ts", "extensions/b.ts"] },
				[gRoot]: { extensions: ["extensions/a.ts", "extensions/b.ts"] },
			},
		});

		const entries = resolveExtensions(snapshot);
		// Only the project install is enumerated (replace, not union).
		expect(entries.map((e) => e.id).sort()).toEqual([`${pRoot}/extensions/a.ts`, `${pRoot}/extensions/b.ts`]);
		for (const e of entries) {
			expect(e.states, e.id).toEqual({ global: "unmanaged", project: "off", effective: "off" });
		}
	});

	it("applies golden package-filter cases (replace and delta semantics)", () => {
		for (const c of PACKAGE_FILTER_CASES) {
			const relPath = c.filePath.slice(c.packageRoot.length + 1);
			const entry: string | PackageSettingsEntry =
				c.filter === undefined ? "npm:pi-open-tui" : { source: "npm:pi-open-tui", ...c.filter };
			const snapshot = baseSnapshot({
				packages: [
					{
						source: "npm:pi-open-tui",
						entry,
						scope: "global",
						root: c.packageRoot,
						rootFiles: ["package.json", relPath],
					},
				],
				manifests: { [c.packageRoot]: { extensions: [relPath] } },
			});

			const found = resolveExtensions(snapshot).find((e) => e.id === c.filePath);
			if (!c.expectedListed) {
				expect(found, c.rule).toBeUndefined();
				continue;
			}
			const isDelta = c.filter?.autoload === false;
			const tierState = c.expectedEnabled ? "on" : "off";
			expect(found?.states, c.rule).toEqual(
				isDelta
					? { global: "unmanaged", project: tierState, effective: tierState }
					: { global: tierState, project: "unmanaged", effective: tierState },
			);
		}
	});
});
