import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planToggle } from "../toggle.ts";
import extmgr, { openPickerSession } from "../index.ts";
import type { ExtensionEntry } from "../resolve.ts";

/** IF-5 `self-disable-unconfirmed`: disabling extmgr itself requires an
 * explicit confirmation naming `pi config` as the recovery path
 * (spec scenario: Self-disable warns). */

let agentDir: string;
let cwd: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "extmgr-self-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "extmgr-self-cwd-"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [] }));
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "guard.ts"), "export default () => {};");
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

const selfEntry: ExtensionEntry = {
	id: "/x/.pi/agent/extensions/extmgr/index.ts",
	name: "index.ts",
	kind: "standalone",
	tier: "global",
	states: { global: "on", project: "unmanaged", effective: "on" },
};

describe("self-disable confirmation", () => {
	it("self-disable requires confirmation", () => {
		// Unconfirmed: refused with the dedicated reason and a pi config hint.
		const refused = planToggle({
			env: { agentDir, cwd },
			entry: selfEntry,
			action: "disable",
			scope: "global",
			trusted: true,
			isSelf: true,
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.reason).toBe("self-disable-unconfirmed");
			expect(refused.detail).toMatch(/pi config/);
		}

		// Confirmed: the disable is planned.
		const confirmed = planToggle({
			env: { agentDir, cwd },
			entry: selfEntry,
			action: "disable",
			scope: "global",
			trusted: true,
			isSelf: true,
			selfConfirmed: true,
		});
		expect(confirmed.ok).toBe(true);

		// Enabling the self entry never needs confirmation.
		const enable = planToggle({
			env: { agentDir, cwd },
			entry: { ...selfEntry, states: { global: "off", project: "unmanaged", effective: "off" } },
			action: "enable",
			scope: "global",
			trusted: true,
			isSelf: true,
		});
		expect(enable.ok).toBe(true);
	});

	it("picker session hides standalone entries (extmgr itself included)", async () => {
		const env = { agentDir, cwd, selfPath: join(agentDir, "extensions", "guard.ts") };
		const notify = vi.fn();
		const ctx = {
			mode: "tui",
			ui: {
				notify,
				custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => { handleInput?: (data: string) => void }) => {
					factory({ requestRender: () => {} }, {}, { matches: () => false }, () => {});
					return new Promise(() => {});
				},
			},
			reload: vi.fn(),
			isProjectTrusted: () => true,
		};
		const session = await openPickerSession(env, [], ctx as never);
		void session.open();

		// Packages only: the standalone guard.ts never reaches the list.
		expect(session.model.visible()).toEqual([]);
		const text = session.picker.render(80).join("\n");
		expect(text).not.toContain("guard.ts");
		expect(text).toContain("+1 standalone hidden");
	});

	it("tool refuses standalone targets — extmgr itself included", async () => {
		const env = { agentDir, cwd, selfPath: join(agentDir, "extensions", "guard.ts") };
		let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<{ details: unknown; content: Array<{ type: string; text: string }> }> } | undefined;
		const pi = {
			registerTool: (t: typeof tool) => {
				tool = t;
			},
			registerCommand: () => {},
		};
		extmgr(pi as never, env);

		// The only installed extension is standalone: refused, nothing written.
		const refused = await tool!.execute("c1", { action: "disable", target: "guard", scope: "global" });
		const details = refused.details as { result?: { status?: string; detail?: string } };
		expect(details.result?.status).toBe("error");
		expect(refused.content[0]!.text).toMatch(/standalone extension\(s\), which extmgr does not manage/);
		const doc = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(doc.extensions).toEqual([]);
	});
});
