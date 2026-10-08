import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import planningFilesRuntime from "./runtime.ts";
import { defaultGoalState, readGoalState, writeGoalState } from "./state.ts";
import { CONTINUATION_DELAY_MS, MESSAGE_TYPE_CONTINUATION } from "./types.ts";
import { getPaths, writeText } from "./utils.ts";
import { initializePlanningWorkspace } from "./workspace.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function harness(status: "active" | "paused" | "ready" = "active") {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-runtime-"));
	directories.push(cwd);
	const goal = {
		objective: "Implement the current policy",
		successCriteria: ["Tests pass"],
		constraints: ["Original policy"],
		outOfScope: ["Unrelated projects"],
		blockerRule: "Pause when blocked",
	};
	const state = defaultGoalState();
	state.status = status;
	state.goal = goal;
	Object.assign(state.draft, goal);
	state.impl.runId = 3;
	state.impl.pausedReason = status === "paused" ? "Quota exhausted" : "";
	writeGoalState(cwd, state);
	initializePlanningWorkspace(cwd, goal, 3);
	// These callbacks deliberately model the adapter boundary, including nested-tool events.
	const hooks = new Map<string, (event: any, ctx: ExtensionContext) => Promise<unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: any[]) => Promise<unknown> }>();
	const messages: Array<{ customType: string; content: string }> = [];
	const warnings: string[] = [];
	let widget: string[] | undefined;
	let failSend = false;
	const pi = {
		on: (name: string, callback: (event: any, ctx: ExtensionContext) => Promise<unknown>) => hooks.set(name, callback),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		sendMessage: (message: { customType: string; content: string }) => {
			if (failSend) throw new Error("send failed");
			messages.push(message);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		hasUI: true,
		isIdle: () => true,
		ui: {
			setWidget: (_key: string, lines: string[] | undefined) => { widget = lines; },
			notify: (message: string, level: string) => { if (level === "warning") warnings.push(message); },
		},
	} as unknown as ExtensionContext;
	planningFilesRuntime(pi);
	return {
		cwd, ctx, messages, warnings,
		widget: () => widget,
		failSend: () => { failSend = true; },
		event: (name: string, event: unknown = {}) => hooks.get(name)!(event, ctx),
		command: (name: string) => commands.get(name)!.handler("", ctx),
		tool: (name: string, params: unknown) => tools.get(name)!.execute("test", params, new AbortController().signal, undefined, ctx),
	};
}

for (const toolName of ["replace_match", "copy", "move"]) {
	test(`${toolName} nested tool events immediately refresh Blocker and enable continuation`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const h = harness();
		await h.event("session_start", { reason: "new" });
		await h.event("turn_start");
		const event = { toolName, input: {}, parentToolCallId: "codemode", toolCallId: "codemode/1" };
		await h.event("tool_call", event);
		writeText(getPaths(h.cwd).files["task_plan.md"], "# Task Plan\n\n## Blocker\nCurrent blocker\n");
		await h.event("tool_result", event);
		assert.ok(h.widget()?.includes("blocker: Current blocker"));
		await h.event("turn_end", { message: { stopReason: "stop" } });
		await h.event("agent_settled");
		t.mock.timers.tick(CONTINUATION_DELAY_MS);
		assert.equal(h.messages.length, 1);
		assert.equal(h.messages[0].customType, MESSAGE_TYPE_CONTINUATION);
	});
}

test("editing goal JSON refreshes paused Blocker and resume preserves the new policy", async () => {
	const h = harness("paused");
	await h.event("session_start", { reason: "resume" });
	const external = readGoalState(h.cwd);
	external.goal!.constraints = ["Revised policy"];
	external.draft.constraints = ["Revised policy"];
	external.impl.pausedReason = "Current quota blocker";
	writeGoalState(h.cwd, external);
	await h.event("tool_result", { toolName: "replace_match", input: {} });
	assert.ok(h.widget()?.includes("blocker: Current quota blocker"));
	await h.command("plan-goal-impl");
	assert.deepEqual(readGoalState(h.cwd).goal!.constraints, external.goal!.constraints);
	assert.match(h.messages[0].content, /Revised policy/);
	assert.equal(readGoalState(h.cwd).impl.runId, 3);
});

test("before-agent refresh and tool-call drafting gate import external status", async () => {
	const h = harness();
	await h.event("session_start", { reason: "new" });
	const external = readGoalState(h.cwd);
	external.status = "drafting";
	writeGoalState(h.cwd, external);
	const blocked = await h.event("tool_call", { toolName: "write", input: { path: "src/app.ts" } });
	assert.equal((blocked as { block?: boolean })?.block, true);
	await h.event("before_agent_start");
	assert.ok(h.widget()?.includes("goal: drafting"));
});

test("adapter refresh does not discard the lifecycle rollback target", async () => {
	const h = harness("ready");
	await h.event("session_start", { reason: "new" });
	h.failSend();
	await h.command("plan-goal-impl");
	assert.equal(readGoalState(h.cwd).status, "ready");
	assert.ok(h.warnings.some((message) => /state restored/.test(message)));
});

test("bad JSON is reported without replacing the widget with an empty goal or rewriting disk", async () => {
	const h = harness("paused");
	await h.event("session_start", { reason: "new" });
	const before = h.widget();
	writeText(getPaths(h.cwd).goalState, "{");
	await h.event("tool_result", { toolName: "replace_match", input: {} });
	assert.deepEqual(h.widget(), before);
	assert.ok(h.warnings.some((message) => /cannot read current goal state/.test(message)));
	await h.command("plan-goal-impl");
	assert.equal(fs.readFileSync(getPaths(h.cwd).goalState, "utf8"), "{");
	assert.equal(h.messages.length, 0);
});

test("widget sync failure can be repaired and explicitly resumed", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	await h.event("session_start", { reason: "new" });
	await h.event("turn_start");
	await h.event("tool_call", { toolName: "replace_match", input: {} });
	await h.event("turn_end", { message: { stopReason: "stop" } });
	await h.event("agent_settled");
	const before = readGoalState(h.cwd);
	writeText(getPaths(h.cwd).goalState, "{");
	await h.event("tool_result", { toolName: "replace_match", input: {} });
	t.mock.timers.tick(CONTINUATION_DELAY_MS);
	assert.equal(h.messages.length, 0);
	writeGoalState(h.cwd, before);
	await h.command("plan-goal-impl");
	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].customType, MESSAGE_TYPE_CONTINUATION);
});

test("a corrupt state file does not carry a previous turn stop into the repair turn", async () => {
	const h = harness();
	await h.event("session_start", { reason: "new" });
	await h.tool("pause_plan_goal", { reason: "quota" });
	writeText(getPaths(h.cwd).goalState, "{");
	const repair = { toolName: "write", input: { path: getPaths(h.cwd).goalState } };
	assert.equal((await h.event("tool_call", repair) as { block?: boolean })?.block, true);
	await h.event("turn_start");
	assert.equal(await h.event("tool_call", repair), undefined);
	assert.equal(fs.readFileSync(getPaths(h.cwd).goalState, "utf8"), "{");
});
