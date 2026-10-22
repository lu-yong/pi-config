import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extmgr from "../index.ts";

/** 5.7 seam: Apply requests exactly one ctx.reload() and returns
 * immediately (spec scenario: Apply triggers reload once). */

let agentDir: string;
let cwd: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "extmgr-apply-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "extmgr-apply-cwd-"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [] }));
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "qna.ts"), "export default () => {};");
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("extmgr /extmgr apply", () => {
	it("apply reloads exactly once", async () => {
		const commands: Array<{
			name: string;
			opts: { handler: (args: string, ctx: unknown) => Promise<unknown> };
		}> = [];
		const pi = {
			registerTool: () => {},
			registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<unknown> }) =>
				commands.push({ name, opts }),
		} as never;
		extmgr(pi, { agentDir, cwd });
		const cmd = commands.find((c) => c.name === "extmgr")!;

		let component: { handleInput(data: string): void; render(width: number): string[] } | undefined;
		let closed!: Promise<unknown>;
		const reload = vi.fn();
		const keybindings = {
			matches: (data: string, binding: string) => data === "ctrl+x" && binding === "tui.input.tab",
		};
		const ctx = {
			mode: "tui",
			ui: {
				notify: vi.fn(),
				custom: vi.fn((
					factory: (
						tui: { requestRender(): void; terminal: { rows: number } },
						theme: unknown,
						keybindings: typeof keybindings,
						done: (result: unknown) => void,
					) => { handleInput(data: string): void; render(width: number): string[] },
				) => {
					closed = new Promise<unknown>((resolve) => {
						component = factory({ requestRender: () => {}, terminal: { rows: 24 } }, {}, keybindings, resolve);
					});
					return closed;
				}),
			},
			reload,
			isProjectTrusted: () => true,
		};

		// The command opens a custom TUI component and resolves without a return value.
		expect(await cmd.opts.handler("", ctx)).toBeUndefined();
		expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
		expect(component).toBeDefined();

		component!.handleInput("ctrl+x");
		const text = component!.render(100).join("\n");
		expect(text).toContain("write tier: project");

		// Packages-only scope: the standalone qna.ts is not listed, only counted.
		expect(text).not.toContain("qna.ts");
		expect(text).toContain("+1 standalone hidden");

		// Apply closes the picker and requests exactly one reload.
		expect(reload).not.toHaveBeenCalled();
		component!.handleInput("a");
		await closed;
		expect(reload).toHaveBeenCalledTimes(1);
	});
});
