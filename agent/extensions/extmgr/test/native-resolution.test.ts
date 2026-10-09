import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../index.ts";
import { resolveExtensions } from "../resolve.ts";

// The host resolver is the oracle; fixtures never use a machine-specific package path.

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
		manifest: ["./src/*.ts", "!src/*.ts", "+src/public.ts", "+src/private.ts"], filter: ["!src/*.ts", "+src/public.ts", "-src/private.ts"], files: sourceFiles, expected: ["src/private.ts", "src/public.ts"],
	},
	"explicit files are not narrowed by directory index discovery": {
		manifest: ["./dist/index.js", "./dist/mcp-cli.js"], files: { "dist/index.js": code, "dist/mcp-cli.js": code }, expected: ["dist/index.js", "dist/mcp-cli.js"],
	},
};

describe("current Pi DefaultPackageManager differential (offline temporary fixtures)", () => {
	for (const [name, fixture] of Object.entries(fixtures)) {
		it(name, async () => {
			const temp = mkdtempSync(join(tmpdir(), "extmgr-native-"));
			try {
				const env = { agentDir: join(temp, "agent"), cwd: join(temp, "project") };
				const source = "npm:extmgr-fixture";
				const root = fixture.standalone ? join(env.agentDir, "extensions") : join(env.agentDir, "npm/node_modules/extmgr-fixture");
				const put = (path: string, content: string) => {
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, content);
				};
				mkdirSync(env.cwd, { recursive: true });
				put(join(root, "package.json"), JSON.stringify({ name: "extmgr-fixture", version: "1.0.0", ...(fixture.manifest ? { pi: { extensions: fixture.manifest } } : {}) }));
				for (const [rel, content] of Object.entries(fixture.files)) put(join(root, rel), content);
				put(join(env.agentDir, "settings.json"), JSON.stringify({ packages: fixture.standalone ? [] : [fixture.filter ? { source, extensions: fixture.filter } : source] }));
				const settingsManager = SettingsManager.create(env.cwd, env.agentDir);
				const manager = new DefaultPackageManager({ ...env, settingsManager, builtinExtensions: [] });
				const native = await manager.resolve(() => { throw new Error("fixture must never install or access the network"); });
				const expected = fixture.expected.map((rel) => join(root, rel)).sort();
				expect(native.extensions.map((entry: { path: string }) => entry.path).sort()).toEqual(expected);
				const local = resolveExtensions(buildSnapshot(env));
				expect(local.map((entry) => entry.id).sort()).toEqual(expected);
				expect(local.map((entry) => ({ path: entry.id, enabled: entry.states.effective === "on" })).sort((a, b) => a.path.localeCompare(b.path)))
					.toEqual(native.extensions.map((entry: { path: string; enabled: boolean }) => ({ path: entry.path, enabled: entry.enabled })).sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path)));
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		});
	}
});
