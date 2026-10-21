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

	it("picker enter shows confirm dialog and persists only on accept", async () => {
		const env = { agentDir, cwd, selfPath: join(agentDir, "extensions", "guard.ts") };
		const confirm = vi.fn().mockResolvedValue(true);
		const inputHandlers: Array<(data: string) => void> = [];
		const ctx = {
			mode: "tui",
			ui: {
				notify: vi.fn(),
				confirm,
				custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => { handleInput?: (data: string) => void }) => {
					const comp = factory({ requestRender: () => {} }, {}, { matches: () => false }, () => {});
					inputHandlers.push((data: string) => comp.handleInput?.(data));
					return new Promise(() => {});
				},
			},
			reload: vi.fn(),
			isProjectTrusted: () => true,
		};
		const session = await openPickerSession(env, [], ctx as never);
		void session.open(); // materializes the component and its handleInput
		session.model.selectIndex(session.model.visible().findIndex((e) => e.name === "guard.ts"));

		// Enter on the self entry: dialog names pi config; accept persists.
		inputHandlers[0]!("\r");
		await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(confirm.mock.calls[0]![1]).toMatch(/pi config/);
		await vi.waitFor(() => {
			const doc = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(doc.extensions).toContain("-extensions/guard.ts");
		});
	});

	it("picker enter declining the dialog writes nothing", async () => {
		const env = { agentDir, cwd, selfPath: join(agentDir, "extensions", "guard.ts") };
		const confirm = vi.fn().mockResolvedValue(false);
		const inputHandlers: Array<(data: string) => void> = [];
		const ctx = {
			mode: "tui",
			ui: {
				notify: vi.fn(),
				confirm,
				custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => { handleInput?: (data: string) => void }) => {
					const comp = factory({ requestRender: () => {} }, {}, { matches: () => false }, () => {});
					inputHandlers.push((data: string) => comp.handleInput?.(data));
					return new Promise(() => {});
				},
			},
			reload: vi.fn(),
			isProjectTrusted: () => true,
		};
		const session = await openPickerSession(env, [], ctx as never);
		void session.open();
		session.model.selectIndex(session.model.visible().findIndex((e) => e.name === "guard.ts"));

		inputHandlers[0]!("\r");
		await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		await new Promise((r) => setImmediate(r));
		const doc = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(doc.extensions).toEqual([]);
	});

	it("tool disables self only with confirmSelfDisable", async () => {
		const env = { agentDir, cwd, selfPath: join(agentDir, "extensions", "guard.ts") };
		const commands: Array<{ name: string; opts: { handler: unknown } }> = [];
		let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<{ details: unknown }> } | undefined;
		const pi = {
			registerTool: (t: typeof tool) => {
				tool = t;
			},
			registerCommand: (name: string, opts: { handler: unknown }) => commands.push({ name, opts }),
		};
		extmgr(pi as never, env);

		// Without confirmation: refused, nothing written.
		const refused = await tool!.execute("c1", { action: "disable", target: "guard", scope: "global" });
		const details = refused.details as { result?: { status?: string; detail?: string } };
		expect(details.result?.status).toBe("unavailable");
		expect(details.result?.detail).toMatch(/self-disable-unconfirmed/);
		let doc = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(doc.extensions).toEqual([]);

		// With confirmation: persisted.
		const done = await tool!.execute("c2", {
			action: "disable",
			target: "guard",
			scope: "global",
			confirmSelfDisable: true,
		});
		const doneDetails = done.details as { result?: { status?: string } };
		expect(doneDetails.result?.status).toBe("ok");
		doc = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(doc.extensions).toContain("-extensions/guard.ts");
	});
});
