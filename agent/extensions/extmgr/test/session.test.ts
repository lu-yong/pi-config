import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPickerSession, type PickerComponent, type PickerHost } from "../index.ts";
import { persistToggle, type ToggleFn, type ToggleAction, type ToggleTier } from "../persist.ts";

/**
 * Session seam: the mounted component (`render` + `handleInput`) over a
 * real temp-dir environment — Enter→persist→refresh→Apply, in-flight
 * ordering (Tab / Apply / double Enter), refusals, failures, and reload
 * behavior. Deferred `persist` injections pin the in-flight timing.
 */

let agentDir: string;
let cwd: string;

function writeRel(rel: string, content: string, root: string): void {
	const full = join(root, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "extmgr-session-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "extmgr-session-cwd-"));
	writeRel("settings.json", JSON.stringify({ packages: ["npm:pi-hashline-edit-pro"] }), agentDir);
	const pkgRoot = join(agentDir, "npm/node_modules/pi-hashline-edit-pro");
	writeRel("package.json", JSON.stringify({ name: "pi-hashline-edit-pro", version: "1.0.0", pi: { extensions: ["ext/hashline.ts"] } }), pkgRoot);
	writeRel("ext/hashline.ts", "export default () => {};", pkgRoot);
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

/** Mounted-session stand-in: captures the component `ctx.ui.custom` would
 * build and the promise `open()` resolves on close. */
function mountHost(): {
	host: PickerHost;
	component: () => PickerComponent;
	/** Resolves when the session closes; only meaningful after open(). */
	closed: () => Promise<unknown>;
} {
	let component: PickerComponent | undefined;
	let closed!: Promise<unknown>;
	const host: PickerHost = {
		ui: {
			notify: vi.fn(),
			custom: ((factory: unknown) => {
				closed = new Promise((resolve) => {
					component = (factory as never as (...args: unknown[]) => PickerComponent)(
						{ requestRender: () => {}, terminal: { rows: 24 } },
						{},
						{ matches: () => false },
						resolve,
					);
				});
				return closed;
			}) as never,
		},
		reload: vi.fn(),
		isProjectTrusted: () => true,
	};
	return { host, component: () => component!, closed: () => closed };
}

const globalDoc = () => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));

describe("picker session (component seam)", () => {
	for (const filtered of [false, true]) {
		it(`keeps the Enter target aligned after the selected row disappears (${filtered ? "filtered list becomes empty" : "selects the remaining row"})`, async () => {
			writeRel("settings.json", JSON.stringify({ packages: ["npm:pi-hashline-edit-pro", "npm:probe-b"] }), agentDir);
			const otherRoot = join(agentDir, "npm/node_modules/probe-b");
			writeRel("package.json", JSON.stringify({ name: "probe-b", version: "1.0.0", pi: { extensions: ["ext/probe-b.ts"] } }), otherRoot);
			writeRel("ext/probe-b.ts", "export default () => {};", otherRoot);
			const targets: Array<string | undefined> = [];
			const persist: ToggleFn = async (...args) => {
				targets.push(args[2].packageSource);
				const result = await persistToggle(...args);
				if (result.ok && targets.length === 1) {
					// A package update removes the selected extension while the write runs.
					writeRel("package.json", JSON.stringify({ name: "pi-hashline-edit-pro", version: "2.0.0", pi: { extensions: [] } }), join(agentDir, "npm/node_modules/pi-hashline-edit-pro"));
				}
				return result;
			};
			const { host, component } = mountHost();
			const session = await openPickerSession({ env: { agentDir, cwd }, host, persist });
			void session.open();
			const comp = component();
			if (filtered) {
				comp.handleInput("/");
				for (const ch of "hashline") comp.handleInput(ch);
				comp.handleInput("\r"); // Leave filter editing before toggling.
			}
			comp.handleInput("\r");
			await session.settle();
			const refreshed = comp.render(100).join("\n");
			if (filtered) expect(refreshed).toContain("(no matching extensions)");
			else expect(refreshed).toMatch(/› on\s+probe-b/);

			comp.handleInput("\r");
			await session.settle();
			if (filtered) {
				expect(targets).toEqual(["npm:pi-hashline-edit-pro"]);
				expect(host.ui.notify).toHaveBeenCalledWith("nothing selected", "warning");
			} else {
				expect(targets).toEqual(["npm:pi-hashline-edit-pro", "npm:probe-b"]);
				expect(comp.render(100).join("\n")).toMatch(/› off\s+probe-b/);
			}
			comp.handleInput("q");
		});
	}

	it("enter persists the package toggle, refreshes the view, and Apply reloads exactly once", async () => {
		const { host, component, closed } = mountHost();
		const session = await openPickerSession({ env: { agentDir, cwd }, liveSources: () => [], host });
		void session.open();
		const comp = component();

		// The package row starts enabled at the global tier.
		expect(comp.render(100).join("\n")).toContain("pi-hashline-edit-pro");
		expect(comp.render(100).join("\n")).toMatch(/on\s+pi-hashline-edit-pro/);

		comp.handleInput("\r");
		await session.settle();

		// Enter already persisted (ADR-0002/0003 contract: writes are not
		// deferred to Apply): whole-package disable at the global tier.
		expect(globalDoc().packages).toEqual([{ source: "npm:pi-hashline-edit-pro", extensions: [] }]);
		const after = comp.render(100).join("\n");
		expect(after).toMatch(/off\s+pi-hashline-edit-pro/);
		expect(after).toContain("1 pending (a apply)");

		// Apply: exactly one reload, pending cleared, session closed.
		comp.handleInput("a");
		await closed();
		expect(host.reload).toHaveBeenCalledTimes(1);
		expect(comp.render(100).join("\n")).not.toContain("pending");
	});

	it("keeps the write tier captured when Tab lands during an in-flight toggle", async () => {
		const calls: Array<{ action: ToggleAction; tier: ToggleTier }> = [];
		let release!: () => void;
		const { host, component } = mountHost();
		const persist = vi.fn((...args: Parameters<ToggleFn>) => {
			calls.push({ action: args[3], tier: args[4] });
			return new Promise<void>((resolve) => {
				release = resolve;
			}).then(() => persistToggle(...args));
		});
		const session = await openPickerSession({
			env: { agentDir, cwd },
			liveSources: () => [],
			host,
			persist: persist as never,
		});
		void session.open();
		const comp = component();

		// Enter starts the toggle (deferred); Tab flips the tier mid-flight.
		comp.handleInput("\r");
		await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
		comp.handleInput("\t");
		expect(comp.render(100).join("\n")).toContain("write tier: project");

		release();
		await session.settle();

		// The toggle ran at the tier active when Enter was pressed, and the
		// pending record is labeled with that same captured tier.
		expect(calls).toEqual([{ action: "disable", tier: "global" }]);
		const text = comp.render(100).join("\n");
		expect(text).toContain("write tier: project");
		expect(text).toContain("1 pending (a apply)");
	});

	it("Apply during an in-flight toggle drains the write before its single reload", async () => {
		const events: string[] = [];
		let release!: () => void;
		const { host, component, closed } = mountHost();
		host.reload = vi.fn(async () => {
			events.push("reload");
		});
		const persist = vi.fn(() =>
			new Promise<{ ok: true }>((resolve) => {
				release = () => {
					events.push("write");
					resolve({ ok: true });
				};
			}),
		);
		const session = await openPickerSession({
			env: { agentDir, cwd },
			liveSources: () => [],
			host,
			persist: persist as never,
		});
		void session.open();
		const comp = component();

		comp.handleInput("\r");
		await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));

		// Apply lands while the write is still in flight: no reload yet.
		comp.handleInput("a");
		expect(host.reload).not.toHaveBeenCalled();

		release();
		await closed();
		// The in-flight write settled before the reload, and exactly one
		// reload was requested — the write is not lost to it.
		expect(events).toEqual(["write", "reload"]);
		expect(host.reload).toHaveBeenCalledTimes(1);
	});

	for (const initialEnabled of [true, false]) {
		it(`counts only net changes after repeated toggles from ${initialEnabled ? "on" : "off"}`, async () => {
			if (!initialEnabled) {
				writeRel("settings.json", JSON.stringify({ packages: [{ source: "npm:pi-hashline-edit-pro", extensions: [] }] }), agentDir);
			}
			const initialSettings = globalDoc();
			const { host, component } = mountHost();
			const session = await openPickerSession({ env: { agentDir, cwd }, host });
			void session.open();
			const comp = component();
			for (let i = 0; i < 8; i++) {
				comp.handleInput("\r");
				await session.settle();
				const text = comp.render(100).join("\n");
				if (i % 2 === 0) expect(text).toContain("1 pending (a apply)");
				else expect(text).not.toContain("pending");
			}
			expect(globalDoc()).toEqual(initialSettings);
			comp.handleInput("q");
		});
	}

	it("preserves a project change when the global change is reverted", async () => {
		writeRel(".pi/settings.json", JSON.stringify({ packages: [{ source: "npm:pi-hashline-edit-pro", autoload: false, extensions: ["+ext/hashline.ts"] }] }), cwd);
		const { host, component } = mountHost();
		const session = await openPickerSession({ env: { agentDir, cwd }, host });
		void session.open();
		const comp = component();
		for (const [keys, expected] of [["\t\r", 1], ["\t\r", 2], ["\r", 1], ["\t\r", 1]] as const) {			for (const key of keys) comp.handleInput(key);
			await session.settle();
			const text = comp.render(100).join("\n");
			if (expected) expect(text).toContain(`${expected} pending (a apply)`);
			else expect(text).not.toContain("pending");
		}
		// Project re-enable is unavailable in native settings; rejection adds no pending change.
		expect(host.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Cannot enable package/), "warning");
		comp.handleInput("q");
	});

	it("reverting one extension preserves the other extension's pending change", async () => {
		writeRel("settings.json", JSON.stringify({ packages: ["npm:pi-hashline-edit-pro", "npm:probe-b"] }), agentDir);
		const otherRoot = join(agentDir, "npm/node_modules/probe-b");
		writeRel("package.json", JSON.stringify({ name: "probe-b", version: "1.0.0", pi: { extensions: ["ext/probe-b.ts"] } }), otherRoot);
		writeRel("ext/probe-b.ts", "export default () => {};", otherRoot);
		const initialSettings = globalDoc();
		const { host, component } = mountHost();
		const session = await openPickerSession({ env: { agentDir, cwd }, host });
		void session.open();
		const comp = component();
		for (const [keys, expected] of [["\r", 1], ["j\r", 2], ["k\r", 1], ["j\r", 0]] as const) {
			for (const key of keys) comp.handleInput(key);
			await session.settle();
			const text = comp.render(100).join("\n");
			if (expected) expect(text).toContain(`${expected} pending (a apply)`);
			else expect(text).not.toContain("pending");
		}
		expect(globalDoc()).toEqual(initialSettings);
		comp.handleInput("q");
	});

	for (const initialEnabled of [true, false]) {
		it(`cancels a whole-package change from the other file row (initially ${initialEnabled ? "on" : "off"})`, async () => {
			const pkgRoot = join(agentDir, "npm/node_modules/pi-hashline-edit-pro");
			writeRel("package.json", JSON.stringify({ name: "pi-hashline-edit-pro", version: "1.0.0", pi: { extensions: ["ext/a.ts", "ext/b.ts"] } }), pkgRoot);
			writeRel("ext/a.ts", "export default () => {};", pkgRoot);
			writeRel("ext/b.ts", "export default () => {};", pkgRoot);
			if (!initialEnabled) {
				writeRel("settings.json", JSON.stringify({ packages: [{ source: "npm:pi-hashline-edit-pro", extensions: [] }] }), agentDir);
			}
			const initialSettings = globalDoc();
			const { host, component } = mountHost();
			const session = await openPickerSession({ env: { agentDir, cwd }, host });
			void session.open();
			const comp = component();
			expect(comp.render(100).find((line) => line.includes("›"))).toContain("a.ts");
			comp.handleInput("\r");
			await session.settle();
			expect(comp.render(100).join("\n")).toContain("2 pending (a apply)");

			comp.handleInput("j");
			expect(comp.render(100).find((line) => line.includes("›"))).toContain("b.ts");
			comp.handleInput("\r");
			await session.settle();
			expect(globalDoc()).toEqual(initialSettings);
			expect(comp.render(100).join("\n")).not.toContain("pending");
			comp.handleInput("q");
		});
	}

	it("serializes double Enter into a switch: disable then enable, ending restored", async () => {
		const { host, component } = mountHost();
		const session = await openPickerSession({ env: { agentDir, cwd }, liveSources: () => [], host });
		void session.open();
		const comp = component();

		// Two Enters before the first settles: queued, executed in order,
		// each deriving its action from the freshest state.
		comp.handleInput("\r");
		comp.handleInput("\r");
		await session.settle();

		expect(globalDoc().packages).toEqual(["npm:pi-hashline-edit-pro"]);
		const text = comp.render(100).join("\n");
		expect(text).toMatch(/on\s+pi-hashline-edit-pro/);
		expect(text).not.toContain("pending");
		expect(text).toContain("› on  pi-hashline-edit-pro"); // cursor kept on the row
	});

	it("refuses an unmanaged tier with the explain line and writes nothing", async () => {
		const { host, component } = mountHost();
		const session = await openPickerSession({ env: { agentDir, cwd }, liveSources: () => [], host });
		void session.open();
		const comp = component();

		// The package is unmanaged at the project tier (P:-): Tab, Enter.
		comp.handleInput("\t");
		comp.handleInput("\r");
		await session.settle();

		expect(host.ui.notify).toHaveBeenCalledWith(
			expect.stringMatching(/not managed at the project tier/),
			"warning",
		);
		expect(globalDoc().packages).toEqual(["npm:pi-hashline-edit-pro"]);
		expect(comp.render(100).join("\n")).not.toContain("pending");
	});

	it("notifies persist failures without pending, and Apply still reloads once", async () => {
		const { host, component, closed } = mountHost();
		const persist = vi.fn(async () => {
			throw new Error("boom");
		});
		const session = await openPickerSession({
			env: { agentDir, cwd },
			liveSources: () => [],
			host,
			persist: persist as never,
		});
		void session.open();
		const comp = component();

		comp.handleInput("\r");
		await session.settle();
		expect(host.ui.notify).toHaveBeenCalledWith("Unable to update extension settings: boom", "error");
		expect(comp.render(100).join("\n")).not.toContain("pending");

		comp.handleInput("a");
		await closed();
		expect(host.reload).toHaveBeenCalledTimes(1);
	});

	it("blocks project-tier writes on an untrusted project and writes nothing", async () => {
		const { host, component } = mountHost();
		host.isProjectTrusted = () => false;
		// A project-tier delta makes the package managed (P:off) so the
		// toggle reaches the trust check instead of the unmanaged refusal.
		writeRel(
			".pi/settings.json",
			JSON.stringify({ packages: [{ source: "npm:pi-hashline-edit-pro", autoload: false, extensions: ["-ext/hashline.ts"] }] }),
			cwd,
		);
		const session = await openPickerSession({ env: { agentDir, cwd }, liveSources: () => [], host });
		void session.open();
		const comp = component();

		comp.handleInput("\t");
		comp.handleInput("\r");
		await session.settle();

		expect(host.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/untrusted-project/), "warning");
		expect(globalDoc().packages).toEqual(["npm:pi-hashline-edit-pro"]);
		const projectDoc = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf-8"));
		expect(projectDoc.packages).toEqual([{ source: "npm:pi-hashline-edit-pro", autoload: false, extensions: ["-ext/hashline.ts"] }]);
		expect(comp.render(100).join("\n")).not.toContain("pending");
	});

	it("closes on q without any reload", async () => {
		const { host, component, closed } = mountHost();
		await openPickerSession({ env: { agentDir, cwd }, liveSources: () => [], host });
		void (await openPickerSession({ env: { agentDir, cwd }, liveSources: () => [], host })).open();
		const comp = component();

		comp.handleInput("q");
		await closed();
		expect(host.reload).not.toHaveBeenCalled();
	});

	it("filter narrows rows through input and keeps the cursor on the first match", async () => {
		const { host, component } = mountHost();
		await openPickerSession({ env: { agentDir, cwd }, liveSources: () => [], host });
		void (await openPickerSession({ env: { agentDir, cwd }, liveSources: () => [], host })).open();
		const comp = component();

		comp.handleInput("/");
		for (const ch of "hashline") comp.handleInput(ch);
		let text = comp.render(100).join("\n");
		expect(text).toContain("pi-hashline-edit-pro");
		expect(text).toContain("filter: hashline");

		// A non-matching filter leaves the empty-list line.
		for (const ch of "zzz") comp.handleInput(ch);
		text = comp.render(100).join("\n");
		expect(text).toContain("(no matching extensions)");

		// Backspacing the filter text away restores the full list.
		for (let i = 0; i < "hashlinezzz".length; i++) comp.handleInput("\u007f");
		text = comp.render(100).join("\n");
		expect(text).toContain("pi-hashline-edit-pro");
		expect(text).not.toContain("filter:");
	});
});
