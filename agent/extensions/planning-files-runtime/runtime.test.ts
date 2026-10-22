import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OutgoingGoalMessage, OutgoingGoalMessageOptions } from "./goal-lifecycle.ts";
import planningFilesRuntime from "./runtime.ts";
import { defaultGoalState, readGoalState, writeGoalState } from "./state.ts";
import { MESSAGE_TYPE_CONTINUATION, MESSAGE_TYPE_GOAL_IMPL } from "./types.ts";
import { getPaths, writeText } from "./utils.ts";
import { initializePlanningWorkspace } from "./workspace.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function harness(status: "none" | "drafting" | "ready" | "active" | "paused" | "complete" = "active") {
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
	const messages: Array<OutgoingGoalMessage & { options: OutgoingGoalMessageOptions }> = [];
	const warnings: string[] = [];
	let widget: string[] | undefined;
	let failSend = false;
	const pi = {
		on: (name: string, callback: (event: any, ctx: ExtensionContext) => Promise<unknown>) => hooks.set(name, callback),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		sendMessage: (message: OutgoingGoalMessage, options: OutgoingGoalMessageOptions) => {
			if (failSend) throw new Error("send failed");
			messages.push({ ...message, options });
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
		failSend: (fail = true) => { failSend = fail; },
		event: (name: string, event: unknown = {}) => hooks.get(name)!(event, ctx),
		/** Invoke the native before-settle boundary; returns the hook's entries/continue decision. */
		boundary: (outcome: "completed" | "aborted" | "error" = "completed") => hooks.get("agent_before_settle")!({ outcome }, ctx) as Promise<BoundaryDecision>,
		command: (name: string, args = "") => commands.get(name)!.handler(args, ctx),
		tool: (name: string, params: unknown, signal?: AbortSignal) => tools.get(name)!.execute("test", params, signal ?? new AbortController().signal, undefined, ctx),
	};
}

/** A boundary continuation entry as Pi would receive it. */
type BoundaryDecision = { entries: Array<{ type: string; customType: string; content: string; display: boolean }>; continue: boolean } | undefined;

function continuationEntry(decision: BoundaryDecision): { type: string; customType: string; content: string; display: boolean } {
	assert.ok(decision?.continue, "boundary must request continuation");
	assert.equal(decision.entries.length, 1);
	return decision.entries[0];
}

for (const toolName of ["replace_match", "copy", "move"]) {
	test(`${toolName} nested tool events immediately refresh Blocker and enable continuation`, async () => {
		const h = harness();
		await h.event("session_start", { reason: "new" });
		await h.event("turn_start");
		const event = { toolName, input: {}, parentToolCallId: "codemode", toolCallId: "codemode/1" };
		await h.event("tool_call", event);
		writeText(getPaths(h.cwd).files["task_plan.md"], "# Task Plan\n\n## Blocker\nCurrent blocker\n");
		await h.event("tool_result", event);
		assert.ok(h.widget()?.includes("blocker: Current blocker"));
		await h.event("turn_end", { message: { stopReason: "stop" } });
		const entry = continuationEntry(await h.boundary());
		assert.equal(entry.type, "custom_message");
		assert.equal(entry.customType, MESSAGE_TYPE_CONTINUATION);
	});
}

test("settlement with progress continues through the native boundary entry, not a queued message", async () => {
	const h = harness();
	await h.event("session_start", { reason: "new" });
	await h.event("agent_start");
	await h.event("turn_start");
	await h.event("tool_call", { toolName: "replace_match", input: {} });
	await h.event("turn_end", { message: { stopReason: "stop" } });
	const entry = continuationEntry(await h.boundary());
	assert.equal(entry.type, "custom_message");
	assert.equal(entry.customType, MESSAGE_TYPE_CONTINUATION);
	assert.equal(entry.display, false);
	assert.match(entry.content, /mode=continue/);
	// The adapter never enqueues the automatic continuation itself; Pi owns the next request.
	assert.equal(readGoalState(h.cwd).status, "active");
	assert.equal(h.messages.length, 0);
});

test("a boundary without progress returns no continuation", async () => {
	const h = harness();
	await h.event("session_start", { reason: "new" });
	await h.event("turn_start");
	await h.event("turn_end", { message: { stopReason: "stop" } });
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.messages.length, 0);
});

for (const progress of [true, false]) {
	test(`settlement cancellation after a normal stop pauses with progress=${progress}`, async () => {
		const h = harness();
		await h.event("session_start", { reason: "new" });
		await h.event("agent_start");
		await h.event("turn_start");
		if (progress) await h.event("tool_call", { toolName: "replace_match", input: {} });
		await h.event("turn_end", { message: { stopReason: "stop" } });
		await h.event("agent_settled", { aborted: true });
		assert.equal(h.messages.length, 0);
		const state = readGoalState(h.cwd);
		assert.equal(state.status, "paused");
		assert.equal(state.impl.pausedReason, "The goal run was interrupted by the user.");
		assert.equal(state.impl.pausedSuggestedAction, "");
		assert.ok(h.widget()?.includes("goal: paused"));
		// The cancelled run can no longer continue.
		assert.equal(await h.boundary(), undefined);
		const progressPath = getPaths(h.cwd).files["progress.md"];
		const before = fs.readFileSync(progressPath, "utf8");
		assert.equal(before.match(/Goal implementation paused: The goal run was interrupted by the user\./g)?.length, 1);
		await h.event("agent_settled", { aborted: true });
		assert.equal(fs.readFileSync(progressPath, "utf8"), before);
		assert.deepEqual(h.warnings, []);
	});
}

test("settlement cancellation takes precedence over a terminal provider error", async () => {
	const h = harness();
	await h.event("session_start", { reason: "new" });
	await h.event("turn_start");
	await h.event("tool_call", { toolName: "replace_match", input: {} });
	await h.event("turn_end", { message: { stopReason: "error", errorMessage: "provider overloaded" } });
	assert.equal(readGoalState(h.cwd).status, "active");
	await h.event("agent_settled", { aborted: true });
	assert.equal(h.messages.length, 0);
	assert.equal(readGoalState(h.cwd).status, "paused");
	assert.equal(readGoalState(h.cwd).impl.pausedReason, "The goal run was interrupted by the user.");
	assert.deepEqual(h.warnings, []);
	assert.doesNotMatch(fs.readFileSync(getPaths(h.cwd).files["progress.md"], "utf8"), /LLM request failed/);
});

test("a terminal provider error at the boundary pauses without continuing", async () => {
	const h = harness();
	await h.event("session_start", { reason: "new" });
	await h.event("turn_start");
	await h.event("tool_call", { toolName: "replace_match", input: {} });
	await h.event("turn_end", { message: { stopReason: "error", errorMessage: "provider overloaded" } });
	assert.equal(await h.boundary("error"), undefined);
	assert.equal(readGoalState(h.cwd).status, "paused");
	assert.match(readGoalState(h.cwd).impl.pausedReason, /will not retry automatically: provider overloaded/);
	assert.equal(h.messages.length, 0);
});

test("settlement cancellation after a continuation decision pauses the goal", async () => {
	const h = harness();
	await h.event("session_start", { reason: "new" });
	await h.event("turn_start");
	await h.event("tool_call", { toolName: "replace_match", input: {} });
	await h.event("turn_end", { message: { stopReason: "stop" } });
	assert.equal(continuationEntry(await h.boundary()).customType, MESSAGE_TYPE_CONTINUATION);
	await h.event("agent_settled", { aborted: true });
	assert.equal(h.messages.length, 0);
	assert.equal(readGoalState(h.cwd).status, "paused");
	assert.equal(await h.boundary(), undefined);
});

test("an aborted turn followed by aborted settlement does not log a second pause", async () => {
	const h = harness();
	await h.event("session_start", { reason: "new" });
	await h.event("turn_start");
	await h.event("tool_call", { toolName: "replace_match", input: {} });
	await h.event("turn_end", { message: { stopReason: "aborted" } });
	assert.equal(readGoalState(h.cwd).status, "paused");
	const progressPath = getPaths(h.cwd).files["progress.md"];
	const before = fs.readFileSync(progressPath, "utf8");
	await h.event("agent_settled", { aborted: true });
	assert.equal(h.messages.length, 0);
	assert.equal(fs.readFileSync(progressPath, "utf8"), before);
});

for (const status of ["none", "drafting", "ready", "paused", "complete"] as const) {
	test(`aborted settlement preserves an already ${status} goal`, async () => {
		const h = harness(status);
		await h.event("session_start", { reason: "new" });
		const before = readGoalState(h.cwd);
		const progressPath = getPaths(h.cwd).files["progress.md"];
		const progressBefore = fs.readFileSync(progressPath, "utf8");
		await h.event("turn_end", { message: { stopReason: "stop" } });
		assert.equal(await h.boundary(), undefined);
		await h.event("agent_settled", { aborted: true });
		assert.equal(h.messages.length, 0);
		assert.deepEqual(readGoalState(h.cwd), before);
		assert.equal(fs.readFileSync(progressPath, "utf8"), progressBefore);
		assert.deepEqual(h.warnings, []);
	});
}

for (const toolName of ["pause_plan_goal", "complete_plan_goal"]) {
	test(`aborted settlement preserves the result of ${toolName}`, async () => {
		const h = harness();
		await h.event("session_start", { reason: "new" });
		await h.event("turn_start");
		await h.event("tool_call", { toolName: "replace_match", input: {} });
		await h.tool(toolName, { reason: "External blocker", summary: "Done", evidence: ["Tests pass"] });
		const before = readGoalState(h.cwd);
		const progressPath = getPaths(h.cwd).files["progress.md"];
		const progressBefore = fs.readFileSync(progressPath, "utf8");
		await h.event("turn_end", { message: { stopReason: "stop" } });
		assert.equal(await h.boundary(), undefined);
		await h.event("agent_settled", { aborted: true });
		assert.equal(h.messages.length, 0);
		assert.deepEqual(readGoalState(h.cwd), before);
		assert.equal(fs.readFileSync(progressPath, "utf8"), progressBefore);
		assert.deepEqual(h.warnings, []);
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

test("a failed boundary sync warns and can be repaired then explicitly resumed", async () => {
	const h = harness();
	await h.event("session_start", { reason: "new" });
	await h.event("turn_start");
	await h.event("tool_call", { toolName: "replace_match", input: {} });
	await h.event("turn_end", { message: { stopReason: "stop" } });
	const before = readGoalState(h.cwd);
	writeText(getPaths(h.cwd).goalState, "{");
	assert.equal(await h.boundary(), undefined);
	assert.ok(h.warnings.some((message) => /cannot read current goal state/.test(message)));
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

for (const status of ["ready", "paused"] as const) {
	for (const input of ["我使用重置卡，额度已恢复\n  请核验后继续，不要部署。", " \t\n　"]) {
		test(`/plan-goal-impl forwards ${input.trim() ? "multiline input" : "no supplement for whitespace"} from ${status}`, async () => {
			const h = harness(status);
			const paths = getPaths(h.cwd);
			const taskPlan = "# Task Plan\n\n## Next action\n等待明天额度重置\n\n## Blocker\n额度耗尽；另有待核验依赖\n";
			writeText(paths.files["task_plan.md"], taskPlan);
			writeText(paths.files["progress.md"], "# Progress\n\n## Timeline\n- 曾因额度耗尽中断\n");
			await h.event("session_start", { reason: "resume" });
			const before = readGoalState(h.cwd);
			await h.command("plan-goal-impl", ` ${input}\n`);
			assert.equal(h.messages.length, 1);
			assert.equal(h.messages[0].customType, MESSAGE_TYPE_GOAL_IMPL);
			assert.equal(h.messages[0].display, false);
			assert.deepEqual(h.messages[0].options, { triggerTurn: true });
			assert.match(h.messages[0].content, new RegExp(`mode=${status === "ready" ? "start" : "resume"}`));
			if (input.trim()) {
				assert.ok(h.messages[0].content.includes(`Current user supplement for this implementation request:\n${input}\n`));
			} else {
				assert.doesNotMatch(h.messages[0].content, /Current user supplement/);
			}
			assert.equal(readGoalState(h.cwd).status, "active");
			assert.equal(readGoalState(h.cwd).impl.runId, status === "ready" ? 4 : 3);
			assert.deepEqual(readGoalState(h.cwd).goal, before.goal);
			assert.doesNotMatch(fs.readFileSync(paths.goalState, "utf8"), /重置卡|"supplementalInput"/);
			if (status === "paused") {
				// Runtime forwards facts, but does not heuristically clear real planning blockers.
				assert.equal(fs.readFileSync(paths.files["task_plan.md"], "utf8"), taskPlan);
				assert.match(fs.readFileSync(paths.files["progress.md"], "utf8"), /曾因额度耗尽中断/);
				assert.match(h.messages[0].content, /等待明天额度重置/);
			}
			assert.deepEqual(h.warnings, []);
			await h.event("agent_start");
			await h.event("turn_start");
			await h.event("tool_call", { toolName: "replace_match", input: {} });
			await h.event("turn_end", { message: { stopReason: "stop" } });
			const entry = continuationEntry(await h.boundary());
			assert.equal(entry.customType, MESSAGE_TYPE_CONTINUATION);
			assert.doesNotMatch(entry.content, /Current user supplement|重置卡/);
		});
	}
}

test(`/plan-goal-impl explicitly rejects active input without affecting the boundary decision`, async () => {
	const h = harness();
	await h.event("session_start", { reason: "new" });
	await h.event("turn_start");
	await h.event("tool_call", { toolName: "replace_match", input: {} });
	await h.event("turn_end", { message: { stopReason: "stop" } });
	const before = fs.readFileSync(getPaths(h.cwd).goalState, "utf8");
	await h.command("plan-goal-impl", "额度已恢复\n继续执行");
	assert.equal(h.warnings.length, 1);
	assert.match(h.warnings[0], /not accepted.*normal message.*pause.*plan-goal-impl/);
	await h.command("plan-goal-impl");
	await h.command("plan-goal-impl", " \t\n　");
	assert.equal(h.warnings.length, 1);
	assert.equal(h.messages.length, 0);
	assert.equal(fs.readFileSync(getPaths(h.cwd).goalState, "utf8"), before);
	// The rejected input consumed nothing: the boundary still continues the run.
	const entry = continuationEntry(await h.boundary());
	assert.doesNotMatch(entry.content, /Current user supplement|额度已恢复/);
});

for (const input of ["我使用重置卡，额度已恢复\n请继续核验", " \t\n　"]) {
	test(`/plan-goal-impl recovery forwards ${input.trim() ? "supplemental facts" : "whitespace as no supplement"}`, async () => {
		const h = harness();
		await h.event("session_start", { reason: "new" });
		await h.event("turn_start");
		await h.event("tool_call", { toolName: "replace_match", input: {} });
		await h.event("turn_end", { message: { stopReason: "stop" } });
		const before = readGoalState(h.cwd);
		writeText(getPaths(h.cwd).goalState, "{");
		assert.equal(await h.boundary(), undefined);
		assert.equal(h.warnings.length, 1);
		const repaired = writeGoalState(h.cwd, before);
		h.failSend();
		await h.command("plan-goal-impl", "失败的旧补充");
		assert.match(h.warnings.at(-1)!, /state preserved.*send failed/);
		h.failSend(false);
		await h.command("plan-goal-impl", input);
		assert.equal(h.messages.length, 1);
		assert.equal(h.messages[0].customType, MESSAGE_TYPE_CONTINUATION);
		assert.deepEqual(h.messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
		assert.equal(h.messages[0].display, false);
		assert.match(h.messages[0].content, /mode=continue/);
		if (input.trim()) assert.ok(h.messages[0].content.includes(input));
		else assert.doesNotMatch(h.messages[0].content, /Current user supplement/);
		assert.doesNotMatch(h.messages[0].content, /失败的旧补充/);
		assert.deepEqual(readGoalState(h.cwd), repaired);
		await h.command("plan-goal-impl");
		assert.equal(h.messages.length, 1);
	});
}

test("cancelling the pending completion audit keeps the goal active", async () => {
	const h = harness();
	const controller = new AbortController();
	(h.ctx as { model?: unknown }).model = { id: "main" };
	(h.ctx as { modelRegistry?: unknown }).modelRegistry = {
		find: () => undefined,
		// The auditor hangs until the abort signal fires, then reports "aborted".
		streamSimple: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => ({
			result: () =>
				new Promise((resolve) => {
					options.signal?.addEventListener("abort", () =>
						resolve({ stopReason: "aborted", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
					);
				}),
		}),
	};
	await h.event("session_start", { reason: "new" });
	const pending = h.tool("complete_plan_goal", { summary: "Done" }, controller.signal);
	controller.abort();
	const result = (await pending) as { isError?: boolean; content: Array<{ type: string; text: string }> };
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /completion cancelled/);
	assert.equal(readGoalState(h.cwd).status, "active");
});

test("completing without an auditor model fails open with a visible note", async () => {
	const h = harness();
	// Real ExtensionContext always carries a modelRegistry; model absent means no auditor.
	(h.ctx as { modelRegistry?: unknown }).modelRegistry = { find: () => undefined };
	await h.event("session_start", { reason: "new" });
	const result = (await h.tool("complete_plan_goal", { summary: "Done", evidence: ["Tests pass"] })) as {
		content: Array<{ type: string; text: string }>;
	};
	assert.match(result.content[0].text, /independent audit skipped: no model is available for the completion audit/);
	assert.equal(readGoalState(h.cwd).status, "complete");
});

test("an approved verdict completes through the real transport and its usage joins the budget", async () => {
	const h = harness();
	const usage = { input: 30, output: 5, cacheRead: 0, cacheWrite: 0 };
	(h.ctx as { model?: unknown }).model = { id: "main" };
	(h.ctx as { modelRegistry?: unknown }).modelRegistry = {
		find: () => undefined,
		streamSimple: () => ({
			result: async () => ({
				stopReason: "stop",
				content: [{ type: "text", text: "criterion 1: MET\nVERDICT: APPROVE" }],
				usage,
			}),
		}),
	};
	await h.event("session_start", { reason: "new" });
	const result = (await h.tool("complete_plan_goal", { summary: "Done", evidence: ["Tests pass"] })) as {
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
		usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	};
	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /Completed plan goal: Done \(independent audit: approved\)/);
	assert.deepEqual(result.usage, usage);
	assert.equal(readGoalState(h.cwd).status, "complete");
	// The auditor usage rides the tool result into the closing turn's budget exactly once.
	await h.event("turn_end", {
		message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } },
		toolResults: [{ usage }],
	});
	assert.equal(readGoalState(h.cwd).impl.tokensUsed, 47);
});

test("a rejected verdict reports an error through the real transport and keeps the goal active", async () => {
	const h = harness();
	const usage = { input: 25, output: 4, cacheRead: 0, cacheWrite: 0 };
	(h.ctx as { model?: unknown }).model = { id: "main" };
	(h.ctx as { modelRegistry?: unknown }).modelRegistry = {
		find: () => undefined,
		streamSimple: () => ({
			result: async () => ({
				stopReason: "stop",
				content: [{ type: "text", text: "criterion 1: UNMET - no recorded evidence\nVERDICT: REJECT" }],
				usage,
			}),
		}),
	};
	await h.event("session_start", { reason: "new" });
	const result = (await h.tool("complete_plan_goal", { summary: "Done" })) as {
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
		usage?: { input: number; output: number };
	};
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /rejected by independent audit.*criterion 1: UNMET - no recorded evidence.*pause_plan_goal/);
	assert.deepEqual(result.usage, usage);
	assert.equal(readGoalState(h.cwd).status, "active");
});
