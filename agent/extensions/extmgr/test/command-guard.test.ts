import { describe, expect, it } from "vitest";
import extmgr from "../index.ts";

/** IF-1 seam: /extmgr command handler with ctx.mode stub (spec scenario:
 * Non-TUI mode guard). */

function makeCommands() {
	const commands: Array<{ name: string; opts: { description: string; handler: (args: string, ctx: unknown) => Promise<void> } }> = [];
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, opts: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.push({ name, opts }),
	} as never;
	extmgr(pi, { agentDir: "/tmp/extmgr-guard-agent", cwd: "/tmp/extmgr-guard-cwd" });
	return commands;
}

describe("/extmgr command", () => {
	it("non-tui mode notifies", async () => {
		const commands = makeCommands();
		expect(commands.map((c) => c.name)).toContain("extmgr");

		const notifications: string[] = [];
		const ctx = {
			mode: "print",
			ui: { notify: (msg: string) => notifications.push(msg) },
		};

		await commands.find((c) => c.name === "extmgr")!.opts.handler("", ctx);

		const text = notifications.join(" ");
		expect(text).toMatch(/interactive/i);
		expect(text).toMatch(/manage_extensions/);
	});
});
