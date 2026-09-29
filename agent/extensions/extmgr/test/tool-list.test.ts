import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extmgr from "../index.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * IF-2 seam: manage_extensions tool execute, integration over temp dirs
 * (no live Pi). Stubbed boundaries: the ExtensionAPI shape and the tool ctx.
 */

let agentDir: string;
let cwd: string;

function writeFile(rel: string, content: string, root: string = agentDir) {
	const full = join(root, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

function makePi() {
	const tools: ToolDefinition[] = [];
	return {
		tools,
		pi: {
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			registerCommand: () => {},
		} as never,
	};
}

const ctxStub = { isProjectTrusted: () => true, mode: "tui" } as never;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "extmgr-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "extmgr-cwd-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("manage_extensions list", () => {
	it("returns one row per extension with tier states", async () => {
		// Global tier: one standalone extension + one npm package with a
		// manifest-declared extension. No project tier content.
		writeFile("extensions/qna.ts", "export default () => {};");
		writeFile("settings.json", JSON.stringify({ packages: ["npm:pkg-a"] }));
		const pkgRoot = join(agentDir, "npm/node_modules/pkg-a");
		writeFile("package.json", JSON.stringify({ name: "pkg-a", pi: { extensions: ["ext/a.ts"] } }), pkgRoot);
		writeFile("ext/a.ts", "export default () => {};", pkgRoot);

		const { pi, tools } = makePi();
		extmgr(pi, { agentDir, cwd });

		expect(tools.map((t) => t.name)).toContain("manage_extensions");
		const tool = tools.find((t) => t.name === "manage_extensions")!;

		const result = await tool.execute("call-1", { action: "list" }, undefined, undefined, ctxStub);

		// One state row per enumerated extension.
		const rows = (result.details as { rows: unknown[] }).rows;
		expect(rows).toHaveLength(2);

		const byName = new Map(
			rows.map((r) => {
				const row = r as { name: string };
				return [row.name, r];
			}),
		);

		const qna = byName.get("qna.ts") as Record<string, unknown>;
		expect(qna).toMatchObject({
			kind: "standalone",
			tier: "global",
			states: { global: "on", project: "unmanaged", effective: "on" },
		});

		const pkgExt = byName.get("a.ts") as Record<string, unknown>;
		expect(pkgExt).toMatchObject({
			kind: "package",
			packageSource: "npm:pkg-a",
			tier: "global",
			states: { global: "on", project: "unmanaged", effective: "on" },
		});

		// Human-facing content includes a state table naming both entries.
		const text = (result.content as Array<{ type: string; text: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(text).toContain("qna.ts");
		expect(text).toContain("a.ts");
	});
});
