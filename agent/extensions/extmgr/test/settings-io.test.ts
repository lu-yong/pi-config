import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateSettings } from "../settings-io.ts";
import lockfile from "proper-lockfile";
import { planToggle, type SettingsMutation } from "../toggle.ts";
import type { ExtensionEntry } from "../resolve.ts";

/** IF-6 seam: integration with real temp dirs and the real proper-lockfile. */

let agentDir: string;
let cwd: string;

function globalSettingsPath(): string {
	return join(agentDir, "settings.json");
}

function writeGlobalSettings(doc: unknown): void {
	writeFileSync(globalSettingsPath(), JSON.stringify(doc, null, "\t"), "utf-8");
}

function readGlobalSettings(): Record<string, unknown> {
	return JSON.parse(readFileSync(globalSettingsPath(), "utf-8"));
}

function standaloneEntry(name: string, tier: "global" | "project" = "global"): ExtensionEntry {
	const baseDir = tier === "global" ? agentDir : join(cwd, ".pi");
	return {
		id: join(baseDir, "extensions", name),
		name,
		kind: "standalone",
		tier,
		states: { global: tier === "global" ? "on" : "unmanaged", project: tier === "project" ? "on" : "unmanaged", effective: "on" },
	};
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "extmgr-io-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "extmgr-io-cwd-"));
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "qna.ts"), "export default () => {};");
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("mutateSettings", () => {
	it("disable standalone appends -pattern and preserves existing entries", async () => {
		writeGlobalSettings({
			theme: "tokyo-night",
			extensions: ["!other.ts"],
			packages: ["npm:pkg-a"],
			unknownFutureKey: { nested: [1, 2] },
		});

		const plan = planToggle({
			entry: standaloneEntry("qna.ts"),
			action: "disable",
			scope: "global",
			trusted: true,
			isSelf: false,
		});
		expect(plan.ok).toBe(true);

		await mutateSettings({ agentDir, cwd }, "global", plan.ok ? plan.mutation : undefined!);

		const doc = readGlobalSettings();
		// New pattern appended at the end; pre-existing entries unchanged, in order.
		expect(doc.extensions).toEqual(["!other.ts", "-extensions/qna.ts"]);
		expect(doc.theme).toBe("tokyo-night");
		expect(doc.packages).toEqual(["npm:pkg-a"]);
		expect(doc.unknownFutureKey).toEqual({ nested: [1, 2] });
	});

	it("whole-package disable writes object form", async () => {
		writeGlobalSettings({ packages: ["npm:other-pkg", "npm:pi-open-tui"] });

		const plan = planToggle({
			entry: {
				id: join(agentDir, "npm/node_modules/pi-open-tui"),
				name: "pi-open-tui",
				kind: "package",
				packageSource: "npm:pi-open-tui",
				tier: "global",
				states: { global: "on", project: "unmanaged", effective: "on" },
			},
			action: "disable",
			scope: "global",
			trusted: true,
			isSelf: false,
			level: "package",
		});
		expect(plan.ok).toBe(true);

		await mutateSettings({ agentDir, cwd }, "global", plan.ok ? plan.mutation : undefined!);

		const doc = readGlobalSettings();
		// Entry converted in place; unrelated package untouched; no skills/prompts
		// keys added (their loading stays declared by the package itself).
		expect(doc.packages).toEqual(["npm:other-pkg", { source: "npm:pi-open-tui", extensions: [] }]);
	});

	it("re-enable restores plain string entry", async () => {
		writeGlobalSettings({
			packages: ["npm:other-pkg", { source: "npm:pi-open-tui", extensions: [] }],
			extensions: ["!keep-me.ts", "-extensions/qna.ts"],
		});

		const packagePlan = planToggle({
			entry: {
				id: join(agentDir, "npm/node_modules/pi-open-tui"),
				name: "pi-open-tui",
				kind: "package",
				packageSource: "npm:pi-open-tui",
				tier: "global",
				states: { global: "off", project: "unmanaged", effective: "off" },
			},
			action: "enable",
			scope: "global",
			trusted: true,
			isSelf: false,
			level: "package",
		});
		expect(packagePlan.ok).toBe(true);
		await mutateSettings({ agentDir, cwd }, "global", packagePlan.ok ? packagePlan.mutation : undefined!);

		let doc = readGlobalSettings();
		expect(doc.packages).toEqual(["npm:other-pkg", "npm:pi-open-tui"]);

		// Standalone re-enable removes the extmgr-authored pattern only.
		const standalonePlan = planToggle({
			entry: standaloneEntry("qna.ts"),
			action: "enable",
			scope: "global",
			trusted: true,
			isSelf: false,
		});
		expect(standalonePlan.ok).toBe(true);
		await mutateSettings({ agentDir, cwd }, "global", standalonePlan.ok ? standalonePlan.mutation : undefined!);

		doc = readGlobalSettings();
		expect(doc.extensions).toEqual(["!keep-me.ts"]);
	});

	it("concurrent writes serialize under lock", async () => {
		writeGlobalSettings({ theme: "keep", extensions: ["!keep-me.ts"] });

		// (a) An external writer (Pi /settings, second extmgr session) holds the
		// lock mid-write; our toggle must wait, then apply on top of its change.
		const release = await lockfile.lock(join(agentDir, "settings.json"), { realpath: false });
		const externalWrite = (async () => {
			await new Promise((r) => setTimeout(r, 80));
			// External change lands while the lock is theirs.
			const raw = JSON.parse(readFileSync(globalSettingsPath(), "utf-8"));
			raw.defaultProvider = "someone-else";
			writeFileSync(globalSettingsPath(), JSON.stringify(raw, null, 2), "utf-8");
			await new Promise((r) => setTimeout(r, 40));
			await release();
		})();

		const qnaPlan = planToggle({
			entry: standaloneEntry("qna.ts"),
			action: "disable",
			scope: "global",
			trusted: true,
			isSelf: false,
		});

		// (b) A second extmgr write races ours; the lock serializes both.
		const otherPlan = planToggle({
			entry: standaloneEntry("other.ts"),
			action: "disable",
			scope: "global",
			trusted: true,
			isSelf: false,
		});

		await Promise.all([
			externalWrite,
			mutateSettings({ agentDir, cwd }, "global", (qnaPlan as { ok: true; mutation: SettingsMutation }).mutation),
			mutateSettings({ agentDir, cwd }, "global", (otherPlan as { ok: true; mutation: SettingsMutation }).mutation),
		]);

		const doc = readGlobalSettings();
		expect(doc.defaultProvider).toBe("someone-else");
		expect(doc.theme).toBe("keep");
		expect(doc.extensions).toHaveLength(3);
		expect(doc.extensions![0]).toBe("!keep-me.ts");
		expect(new Set(doc.extensions!.slice(1))).toEqual(new Set(["-extensions/qna.ts", "-extensions/other.ts"]));
	});
});
