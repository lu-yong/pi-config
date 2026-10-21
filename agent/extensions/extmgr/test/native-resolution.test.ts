import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveNative } from "../native.ts";
import type { ExtensionEntry } from "../resolve.ts";

// Pi's resolver is the oracle. Fixtures live on disk under temp dirs and use
// no network: a missing source resolves to "skip". Fixture package.json
// files carry a version — Pi skips installs whose version cannot be read.

type Fixture = {
	manifest?: string[];
	files: Record<string, string>;
	standalone?: boolean;
	filter?: string[];
	expected: string[];
};
const code = "export default function () {}\n";
const packageEntry = JSON.stringify({ pi: { extensions: ["./entry.js"] } });
const sourceFiles = {
	"src/public.ts": code,
	"src/private.ts": code,
	"src/other.ts": code,
	"outside.ts": code,
};
const fixtures: Record<string, Fixture> = {
	"directory index.js wins over mcp-cli.js": {
		manifest: ["./dist"], files: { "dist/index.js": code, "dist/mcp-cli.js": code }, expected: ["dist/index.js"],
	},
	"directory index.ts wins over index.js and siblings": {
		manifest: ["./dist"], files: { "dist/index.ts": code, "dist/index.js": code, "dist/helper.ts": code }, expected: ["dist/index.ts"],
	},
	"directory package entry wins over index": {
		manifest: ["./dist"], files: { "dist/package.json": packageEntry, "dist/entry.js": code, "dist/index.js": code }, expected: ["dist/entry.js"],
	},
	"immediate child package entry wins over index": {
		manifest: ["./dist"], files: { "dist/sub/package.json": packageEntry, "dist/sub/entry.js": code, "dist/sub/index.js": code }, expected: ["dist/sub/entry.js"],
	},
	"missing directory package entry falls back to index": {
		manifest: ["./dist"], files: { "dist/package.json": packageEntry, "dist/index.js": code, "dist/helper.js": code }, expected: ["dist/index.js"],
	},
	"conventional extensions directory honors its index": {
		files: { "extensions/index.js": code, "extensions/helper.js": code }, expected: ["extensions/index.js"],
	},
	"standalone root index suppresses siblings": {
		standalone: true, files: { "index.js": code, "mcp-cli.js": code }, expected: ["index.js"],
	},
	"standalone root package entry wins over index": {
		standalone: true, manifest: ["./entry.js"], files: { "entry.js": code, "index.js": code }, expected: ["entry.js"],
	},
	"standalone child package entry wins over index": {
		standalone: true, files: { "sub/package.json": packageEntry, "sub/entry.js": code, "sub/index.js": code }, expected: ["sub/entry.js"],
	},
	"manifest exclusion": {
		manifest: ["./src/*.ts", "!src/private.ts"], files: sourceFiles, expected: ["src/other.ts", "src/public.ts"],
	},
	"manifest exact reinclude overrides exclusion": {
		manifest: ["./src/*.ts", "!src/*.ts", "+./src/public.ts"], files: sourceFiles, expected: ["src/public.ts"],
	},
	"manifest forceexclude wins even before reinclude": {
		manifest: ["./src/*.ts", "-src/private.ts", "+src/private.ts"], files: sourceFiles, expected: ["src/other.ts", "src/public.ts"],
	},
	"manifest plus is exact and cannot discover extra sources": {
		manifest: ["./src/*.ts", "!src/*.ts", "+src/*.ts", "+outside.ts"], files: sourceFiles, expected: [],
	},
	"settings cannot resurrect a manifest exclusion": {
		manifest: ["./src/*.ts", "!src/private.ts"], filter: ["+src/private.ts"], files: sourceFiles, expected: ["src/other.ts", "src/public.ts"],
	},
	"whole-package disable retains only manifest-allowed rows as off": {
		manifest: ["./src/*.ts", "!src/private.ts"], filter: [], files: sourceFiles, expected: ["src/other.ts", "src/public.ts"],
	},
	"settings filters still apply after manifest reinclude": {
		manifest: ["./src/*.ts", "!src/*.ts", "+./src/public.ts", "+./src/private.ts"], filter: ["!src/*.ts", "+src/public.ts", "-src/private.ts"], files: sourceFiles, expected: ["src/private.ts", "src/public.ts"],
	},
	"explicit files are not narrowed by directory index discovery": {
		manifest: ["./dist/index.js", "./dist/mcp-cli.js"], files: { "dist/index.js": code, "dist/mcp-cli.js": code }, expected: ["dist/index.js", "dist/mcp-cli.js"],
	},
};

/** Build one temp two-tier env; returns paths and a cleanup. */
function makeEnv() {
	const temp = mkdtempSync(join(tmpdir(), "extmgr-native-"));
	const env = { agentDir: join(temp, "agent"), cwd: join(temp, "project") };
	mkdirSync(env.cwd, { recursive: true });
	const put = (path: string, content: string) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	};
	return { temp, env, put };
}

async function nativeOracle(env: { agentDir: string; cwd: string }) {
	const settingsManager = SettingsManager.create(env.cwd, env.agentDir);
	const manager = new DefaultPackageManager({ ...env, settingsManager, builtinExtensions: [] });
	return manager.resolve(() => {
		throw new Error("fixture must never install or access the network");
	});
}

describe("current Pi DefaultPackageManager differential (offline temporary fixtures)", () => {
	for (const [name, fixture] of Object.entries(fixtures)) {
		it(name, async () => {
			const { temp, env, put } = makeEnv();
			try {
				const source = "npm:extmgr-fixture";
				const root = fixture.standalone ? join(env.agentDir, "extensions") : join(env.agentDir, "npm/node_modules/extmgr-fixture");
				put(join(root, "package.json"), JSON.stringify({ name: "extmgr-fixture", version: "1.0.0", ...(fixture.manifest ? { pi: { extensions: fixture.manifest } } : {}) }));
				for (const [rel, content] of Object.entries(fixture.files)) put(join(root, rel), content);
				put(join(env.agentDir, "settings.json"), JSON.stringify({ packages: fixture.standalone ? [] : [fixture.filter ? { source, extensions: fixture.filter } : source] }));
				const native = await nativeOracle(env);
				const expected = fixture.expected.map((rel) => join(root, rel)).sort();
				expect(native.extensions.map((entry: { path: string }) => entry.path).sort()).toEqual(expected);
				// The projection used in production must agree with the oracle.
				const local = await resolveNative(env);
				expect(local.map((entry) => entry.id).sort()).toEqual(expected);
				expect(local.map((entry) => ({ path: entry.id, enabled: entry.states.effective === "on" })).sort((a, b) => a.path.localeCompare(b.path)))
					.toEqual(native.extensions.map((entry: { path: string; enabled: boolean }) => ({ path: entry.path, enabled: entry.enabled })).sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path)));
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		});
	}
});

// ---------------------------------------------------------------------------
// State matrix (two native passes): the cells the raw resolver cannot show
// ---------------------------------------------------------------------------

function installPackage(env: { agentDir: string }, name: string, files: string[], manifest?: string[]) {
	const root = join(env.agentDir, "npm/node_modules", name);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0", ...(manifest ? { pi: { extensions: manifest } } : {}) }));
	for (const rel of files) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), code);
	}
	return root;
}

function find(rows: ExtensionEntry[], id: string) {
	return rows.find((e) => e.id === id);
}

describe("resolveNative tier state matrix", () => {
	it("standalone rows carry their owning tier only", async () => {
		const { temp, env, put } = makeEnv();
		try {
			put(join(env.agentDir, "extensions/qna.ts"), code);
			put(join(env.cwd, ".pi/extensions/helper.ts"), code);
			const rows = await resolveNative(env);
			expect(find(rows, join(env.agentDir, "extensions/qna.ts"))?.states)
				.toEqual({ global: "on", project: "unmanaged", effective: "on" });
			expect(find(rows, join(env.cwd, ".pi/extensions/helper.ts"))?.states)
				.toEqual({ global: "unmanaged", project: "on", effective: "on" });
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("globally disabled standalone reports off/unmanaged/off", async () => {
		const { temp, env, put } = makeEnv();
		try {
			put(join(env.agentDir, "extensions/qna.ts"), code);
			put(join(env.agentDir, "settings.json"), JSON.stringify({ extensions: ["-extensions/qna.ts"] }));
			const rows = await resolveNative(env);
			expect(find(rows, join(env.agentDir, "extensions/qna.ts"))?.states)
				.toEqual({ global: "off", project: "unmanaged", effective: "off" });
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("project delta disables one package extension only", async () => {
		const { temp, env, put } = makeEnv();
		try {
			const root = installPackage(env, "pi-open-tui", ["tui.ts", "other.ts"], ["tui.ts", "other.ts"]);
			put(join(env.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-open-tui"] }));
			put(join(env.cwd, ".pi/settings.json"), JSON.stringify({ packages: [{ source: "npm:pi-open-tui", autoload: false, extensions: ["-tui.ts"] }] }));
			const rows = await resolveNative(env);
			const tui = find(rows, join(root, "tui.ts"));
			expect(tui, "delta-disabled file enumerated once").toBeDefined();
			expect(tui?.states).toEqual({ global: "on", project: "off", effective: "off" });
			expect(tui?.tier).toBe("project");
			const other = find(rows, join(root, "other.ts"));
			expect(other?.states).toEqual({ global: "on", project: "unmanaged", effective: "on" });
			expect(new Set(rows.map((e) => e.id)).size).toBe(rows.length);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("project replace entry replaces the same-identity global entry", async () => {
		const { temp, env, put } = makeEnv();
		try {
			const gRoot = installPackage(env, "pi-replace", ["extensions/a.ts", "extensions/b.ts"], ["extensions/a.ts", "extensions/b.ts"]);
			const pRoot = join(env.cwd, ".pi/npm/node_modules/pi-replace");
			mkdirSync(pRoot, { recursive: true });
			writeFileSync(join(pRoot, "package.json"), JSON.stringify({ name: "pi-replace", version: "1.0.0", pi: { extensions: ["extensions/a.ts", "extensions/b.ts"] } }));
			for (const rel of ["extensions/a.ts", "extensions/b.ts"]) {
				mkdirSync(dirname(join(pRoot, rel)), { recursive: true });
				writeFileSync(join(pRoot, rel), code);
			}
			put(join(env.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-replace"] }));
			put(join(env.cwd, ".pi/settings.json"), JSON.stringify({ packages: [{ source: "npm:pi-replace", extensions: [] }] }));
			const rows = await resolveNative(env);
			// Only the project install is enumerated (replace, not union).
			expect(rows.map((e) => e.id).sort()).toEqual([join(pRoot, "extensions/a.ts"), join(pRoot, "extensions/b.ts")]);
			for (const e of rows) {
				expect(e.states, e.id).toEqual({ global: "unmanaged", project: "off", effective: "off" });
			}
			void gRoot;
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("same package declared in both tiers as strings → project install wins", async () => {
		const { temp, env, put } = makeEnv();
		try {
			installPackage(env, "pi-dup", ["extensions/a.ts"], ["extensions/a.ts"]);
			const pRoot = join(env.cwd, ".pi/npm/node_modules/pi-dup");
			mkdirSync(join(pRoot, "extensions"), { recursive: true });
			writeFileSync(join(pRoot, "package.json"), JSON.stringify({ name: "pi-dup", version: "1.0.0", pi: { extensions: ["extensions/a.ts"] } }));
			writeFileSync(join(pRoot, "extensions/a.ts"), code);
			put(join(env.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-dup"] }));
			put(join(env.cwd, ".pi/settings.json"), JSON.stringify({ packages: ["npm:pi-dup"] }));
			const rows = await resolveNative(env);
			expect(rows.map((e) => e.id)).toEqual([join(pRoot, "extensions/a.ts")]);
			expect(rows[0]?.tier).toBe("project");
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("package rows expose provenance (source, relPath, name)", async () => {
		const { temp, env, put } = makeEnv();
		try {
			const root = installPackage(env, "pi-open-tui", ["extensions/tui.ts"], ["extensions/tui.ts"]);
			put(join(env.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-open-tui"] }));
			const rows = await resolveNative(env);
			expect(rows[0]).toMatchObject({
				id: join(root, "extensions/tui.ts"),
				name: "tui.ts",
				kind: "package",
				packageSource: "npm:pi-open-tui",
				relPath: "extensions/tui.ts",
				tier: "global",
				states: { global: "on", project: "unmanaged", effective: "on" },
			});
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("nested standalone files keep a distinguishable display name", async () => {
		const { temp, env, put } = makeEnv();
		try {
			// Pi's smart discovery: a nested directory with index.ts yields the
			// index only; a plain top-level file also loads. Nested entries are
			// named rel-to-`extensions/` so siblings stay distinguishable.
			put(join(env.agentDir, "extensions/sub/index.ts"), code);
			put(join(env.agentDir, "extensions/util.ts"), code);
			const rows = await resolveNative(env);
			const names = rows.filter((e) => e.kind === "standalone").map((e) => e.name).sort();
			expect(names).toEqual(["sub/index.ts", "util.ts"]);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("explicitly declared discovery directories keep their directory name", async () => {
		const { temp, env, put } = makeEnv();
		try {
			// Explicit `extensions:` entries resolve with source "local"
			// metadata and no baseDir; names must not collapse to index.ts.
			put(join(env.agentDir, "extensions/qna/index.ts"), code);
			put(join(env.agentDir, "extensions/readonly-mode/index.ts"), code);
			put(join(env.agentDir, "settings.json"), JSON.stringify({ extensions: ["extensions/qna", "extensions/readonly-mode"] }));
			const rows = await resolveNative(env);
			const names = rows.filter((e) => e.kind === "standalone").map((e) => e.name).sort();
			expect(names).toEqual(["qna/index.ts", "readonly-mode/index.ts"]);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("declared but missing package yields no rows (skip, never install)", async () => {
		const { temp, env, put } = makeEnv();
		try {
			put(join(env.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:not-installed-anywhere"] }));
			const rows = await resolveNative(env);
			expect(rows).toEqual([]);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});
