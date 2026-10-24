import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extmgr from "../index.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** IF-2 seam: manage_extensions mutation actions, integration over temp dirs. */

let agentDir: string;
let cwd: string;

function writeRel(rel: string, content: string, root: string): void {
	const full = join(root, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

function makeTool() {
	const tools: ToolDefinition[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: () => {},
	} as never;
	extmgr(pi, { agentDir, cwd });
	return tools.find((t) => t.name === "manage_extensions")!;
}

const trustedCtx = { isProjectTrusted: () => true, mode: "tui" } as never;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "extmgr-tool-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "extmgr-tool-cwd-"));
	writeRel("settings.json", JSON.stringify({ packages: ["npm:pi-hashline-edit-pro"] }), agentDir);
	const pkgRoot = join(agentDir, "npm/node_modules/pi-hashline-edit-pro");
	writeRel("package.json", JSON.stringify({ name: "pi-hashline-edit-pro", version: "1.0.0", pi: { extensions: ["ext/hashline.ts"] } }), pkgRoot);
	writeRel("ext/hashline.ts", "export default () => {};", pkgRoot);
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("manage_extensions mutations", () => {
	it("project disable writes delta entry", async () => {
		const tool = makeTool();

		const result = await tool.execute(
			"c1",
			{ action: "disable", target: "pi-hashline-edit-pro", scope: "project" },
			undefined,
			undefined,
			trustedCtx,
		);

		// Project settings gain the pi-config-parity delta: autoload:false +
		// one -rel pattern per declared extension file.
		const projectDoc = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf-8"));
		expect(projectDoc.packages).toEqual([
			{ source: "npm:pi-hashline-edit-pro", autoload: false, extensions: ["-ext/hashline.ts"] },
		]);

		// Global settings untouched.
		const globalDoc = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(globalDoc.packages).toEqual(["npm:pi-hashline-edit-pro"]);

		// Result reports the package disabled in this project, still enabled globally.
		const details = result.details as { result?: { status?: string; entry?: Array<{ states?: unknown }> } };
		expect(details.result?.status).toBe("ok");
		const rows = details.result?.entry ?? [];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.states).toEqual({ global: "on", project: "off", effective: "off" });

		const text = (result.content as Array<{ type: string; text: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(text).toMatch(/still enabled globally/i);
	});

	it("standalone targets are refused and packages disambiguate", async () => {
		// Standalone files exist, but extmgr manages packages only: a target
		// matching just standalone entries is refused with nothing written.
		writeRel("settings.json", JSON.stringify({ extensions: [] }), agentDir);
		writeRel("extensions/pi-hashline-edit-pro.ts", "export default () => {};", agentDir);
		let tool = makeTool();
		let result = await tool.execute("c1", { action: "disable", target: "hashline", scope: "global" }, undefined, undefined, trustedCtx);

		let details = result.details as { result?: { status?: string } };
		expect(details.result?.status).toBe("error");
		const text1 = (result.content as Array<{ type: string; text: string }>)[0]!.text;
		expect(text1).toMatch(/standalone extension\(s\), which extmgr does not manage/);
		let doc = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(doc.extensions).toEqual([]); // nothing written

		// Two packages share the substring: ambiguity asks for a retry with
		// package-only candidates.
		writeRel("package.json", JSON.stringify({ name: "pi-hashline-extra", version: "1.0.0", pi: { extensions: ["ext/extra.ts"] } }), join(agentDir, "npm/node_modules/pi-hashline-extra"));
		writeRel("ext/extra.ts", "export default () => {};", join(agentDir, "npm/node_modules/pi-hashline-extra"));
		writeRel("settings.json", JSON.stringify({ packages: ["npm:pi-hashline-edit-pro", "npm:pi-hashline-extra"] }), agentDir);
		tool = makeTool();
		result = await tool.execute("c2", { action: "disable", target: "hashline", scope: "global" }, undefined, undefined, trustedCtx);

		details = result.details as { result?: { status?: string; candidates?: string[] } };
		expect(details.result?.status).toBe("ambiguous");
		expect(new Set(details.result?.candidates)).toEqual(
			new Set(["npm:pi-hashline-edit-pro", "npm:pi-hashline-extra"]),
		);
		doc = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(doc.packages).toEqual(["npm:pi-hashline-edit-pro", "npm:pi-hashline-extra"]); // unchanged
	});

	it("unavailable action explains and writes nothing", async () => {
		// Package target (the beforeEach fixture) blocked at an untrusted
		// project tier: no write happens and the reason is explained.
		const tool = makeTool();

		const result = await tool.execute(
			"c1",
			{ action: "disable", target: "pi-hashline-edit-pro", scope: "project" },
			undefined,
			undefined,
			{ isProjectTrusted: () => false, mode: "tui" } as never,
		);

		const details = result.details as { result?: { status?: string; detail?: string } };
		expect(details.result?.status).toBe("unavailable");
		expect(details.result?.detail).toMatch(/project is not trusted/);

		// Nothing was modified: no project settings created, global untouched.
		expect(existsSync(join(cwd, ".pi", "settings.json"))).toBe(false);
		const doc = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(doc.packages).toEqual(["npm:pi-hashline-edit-pro"]);
	});
});
