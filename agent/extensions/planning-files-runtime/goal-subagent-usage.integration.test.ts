import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Model, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { runAgentLoop, type AgentEvent, type AgentLoopConfig, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createGoalLifecycle, type GoalLifecycleContext } from "./goal-lifecycle.ts";
import { createSubagentUsageTracker } from "./subagent-usage.ts";
import { readGoalState } from "./state.ts";
import { sumUsageTokens } from "./utils.ts";

const contract = {
	objective: "Account for subagent consumption",
	successCriteria: ["Subagent and audit usage are both counted exactly once"],
	constraints: ["Use a scripted model without network access"],
	outOfScope: ["Provider integration"],
	blockerRule: "Pause if blocked",
};
const model: Model<"openai-completions"> = {
	id: "scripted", name: "Scripted", api: "openai-completions", provider: "openai",
	baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
};

function usage(total: number): Usage {
	return {
		input: total - 10, output: 4, cacheRead: 5, cacheWrite: 1, totalTokens: total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], tokens: number): AssistantMessage {
	return { role: "assistant", content, stopReason, usage: usage(tokens), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
}

function scriptedResponses(messages: AssistantMessage[]): StreamFn {
	let index = 0;
	return () => {
		const message = messages[index++];
		assert.ok(message, "the agent loop requested an unexpected extra response");
		const stream = createAssistantMessageEventStream();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			assert.ok(message.stopReason === "stop" || message.stopReason === "toolUse");
			stream.push({ type: "done", reason: message.stopReason, message });
		}
		stream.end(message);
		return stream;
	};
}

/** A pi-subagent-manager ThreadView as its tools report it in `details`. */
function thread(path: string, input: number, output: number) {
	return { path, state: "completed", task: "Do work", inputTokens: input, outputTokens: output };
}

/** Stand-in for a pi-subagent-manager verb: returns its ThreadView totals as details, no native usage. */
function agentTool(name: string, details: unknown): AgentTool {
	return {
		name, label: name, description: "Subagent manager verb stand-in", parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details }),
	};
}

function toolCall(id: string, name: string) {
	return { type: "toolCall" as const, id, name, arguments: {} };
}

/**
 * An active goal run over the real host loop. The tracker rides
 * `config.afterToolCall` — the same channel pi-coding-agent uses to merge an
 * extension's `tool_result` usage into the tool result — and the emit
 * callback mirrors runtime.ts's turn_end consumption.
 */
function activeGoalRun(cwd: string) {
	const run = createGoalLifecycle(cwd, { sendMessage() {} });
	const context: GoalLifecycleContext = { notify() {} };
	assert.equal(run.handle({ type: "start-drafting", input: "Account for subagents" }, context).error, undefined);
	assert.equal(run.handle({ type: "commit", params: contract }, context).error, undefined);
	assert.equal(run.handle({ type: "implementation-request" }, context).error, undefined);
	let tracker = createSubagentUsageTracker();
	const toolUsageByTurn: number[] = [];
	const emit = (event: AgentEvent) => {
		if (event.type === "agent_start" || event.type === "turn_start") {
			assert.equal(run.handle({ type: event.type === "agent_start" ? "agent-start" : "turn-start" }, context).error, undefined);
		} else if (event.type === "turn_end") {
			assert.equal(event.message.role, "assistant");
			const message = event.message as AssistantMessage;
			const toolTokens = event.toolResults.reduce((sum, result) => sum + (result.usage ? sumUsageTokens(result.usage) : 0), 0);
			toolUsageByTurn.push(toolTokens);
			assert.equal(run.handle({ type: "turn-end", stopReason: message.stopReason, usageTokens: sumUsageTokens(message.usage) + toolTokens }, context).error, undefined);
		}
	};
	const config: AgentLoopConfig = {
		model,
		convertToLlm: (messages) => messages as Message[],
		afterToolCall: async ({ toolCall, result }) => {
			const injected = tracker.observe(toolCall.name, result.details, result.usage);
			return injected ? { usage: injected } : undefined;
		},
	};
	const drive = (tools: AgentTool[], responses: AssistantMessage[]) =>
		runAgentLoop(
			[{ role: "user", content: "Continue the goal", timestamp: Date.now() }],
			{ messages: [], tools }, config, emit, undefined, scriptedResponses(responses),
		);
	return {
		run,
		context,
		drive,
		toolUsageByTurn,
		/** Drop the watermark table, as a process restart (/reload) would. */
		reload: () => { tracker = createSubagentUsageTracker(); },
	};
}

function auditUsageOf(total: number) {
	return usage(total);
}

function completeTool(run: ReturnType<typeof createGoalLifecycle>, context: GoalLifecycleContext, auditUsage: Usage): AgentTool {
	return {
		name: "complete_plan_goal", label: "complete_plan_goal", description: "Finish this goal", parameters: Type.Object({}),
		execute: async () => {
			const result = await run.complete({ summary: "Done", evidence: ["Scripted check passed"] }, context, {
				modelCall: async () => ({ kind: "completed", text: "criterion 1: MET\nVERDICT: APPROVE", usage: auditUsage }),
			});
			assert.equal(result.error, undefined);
			return { content: [{ type: "text", text: "Saved" }], details: {}, ...(result.audit?.usage ? { usage: { ...auditUsage, ...result.audit.usage } } : {}) };
		},
	};
}

function scratch(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "planning-subagent-usage-"));
}

test("real agent loop counts a spawned subagent's totals in the spawning turn", async () => {
	const cwd = scratch();
	try {
		const { drive } = activeGoalRun(cwd);
		await drive(
			[agentTool("agent_spawn", thread("/root/research", 1000, 100))],
			[
				response([toolCall("spawn", "agent_spawn")], "toolUse", 30),
				response([{ type: "text", text: "The subagent finished." }], "stop", 40),
			],
		);
		// Turn 1: main turn 30 + injected 1100; turn 2: closing response 40.
		assert.equal(readGoalState(cwd).impl.tokensUsed, 30 + 1100 + 40);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("real agent loop counts only the delta on a later observation of the same thread", async () => {
	const cwd = scratch();
	try {
		const { drive } = activeGoalRun(cwd);
		await drive(
			[agentTool("agent_spawn", thread("/root/research", 1000, 100))],
			[
				response([toolCall("spawn", "agent_spawn")], "toolUse", 30),
				response([{ type: "text", text: "The subagent finished." }], "stop", 40),
			],
		);
		await drive(
			[agentTool("agent_wait", thread("/root/research", 1500, 140))],
			[
				response([toolCall("wait", "agent_wait")], "toolUse", 50),
				response([{ type: "text", text: "Waited." }], "stop", 60),
			],
		);
		assert.equal(readGoalState(cwd).impl.tokensUsed, 30 + 1100 + 40 + 50 + 540 + 60);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("an agent_status list seeds unseen threads and differences seen ones", async () => {
	const cwd = scratch();
	try {
		const { drive } = activeGoalRun(cwd);
		await drive(
			[agentTool("agent_spawn", thread("/root/a", 1000, 100))],
			[
				response([toolCall("spawn", "agent_spawn")], "toolUse", 30),
				response([{ type: "text", text: "Spawned." }], "stop", 40),
			],
		);
		// /root/b is unseen: seeded, not counted; /root/a differences.
		await drive(
			[agentTool("agent_status", [thread("/root/a", 1500, 140), thread("/root/b", 500, 50)])],
			[
				response([toolCall("status", "agent_status")], "toolUse", 50),
				response([{ type: "text", text: "Status." }], "stop", 60),
			],
		);
		// Both seen now: only the respective deltas count.
		await drive(
			[agentTool("agent_wait", thread("/root/b", 510, 60))],
			[
				response([toolCall("wait", "agent_wait")], "toolUse", 70),
				response([{ type: "text", text: "Waited." }], "stop", 80),
			],
		);
		assert.equal(readGoalState(cwd).impl.tokensUsed, (30 + 1100 + 40) + (50 + 540 + 60) + (70 + 20 + 80));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a fresh tracker after a simulated reload seeds instead of recounting prior consumption", async () => {
	const cwd = scratch();
	try {
		const { drive, reload } = activeGoalRun(cwd);
		await drive(
			[agentTool("agent_spawn", thread("/root/research", 1000, 100))],
			[
				response([toolCall("spawn", "agent_spawn")], "toolUse", 30),
				response([{ type: "text", text: "Spawned." }], "stop", 40),
			],
		);
		reload();
		// steer re-exposes the old thread's full totals: seeding only, no
		// recount of the 1100 the previous process already attributed.
		await drive(
			[agentTool("agent_steer", thread("/root/research", 1000, 100)), agentTool("agent_wait", thread("/root/research", 1500, 140))],
			[
				response([toolCall("steer", "agent_steer")], "toolUse", 50),
				response([toolCall("wait", "agent_wait")], "toolUse", 60),
				response([{ type: "text", text: "Resumed and waited." }], "stop", 70),
			],
		);
		assert.equal(readGoalState(cwd).impl.tokensUsed, (30 + 1100 + 40) + 50 + (60 + 540) + 70);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent usage observed after completion does not change the completed goal's total", async () => {
	const cwd = scratch();
	try {
		const auditUsage = auditUsageOf(17);
		const { run, context, drive, toolUsageByTurn } = activeGoalRun(cwd);
		await drive(
			[completeTool(run, context, auditUsage)],
			[
				response([toolCall("finish", "complete_plan_goal")], "toolUse", 30),
				response([{ type: "text", text: "The goal stage has been saved." }], "stop", 40),
			],
		);
		const expected = 30 + 17 + 40;
		assert.equal(readGoalState(cwd).impl.tokensUsed, expected);
		assert.equal(readGoalState(cwd).status, "complete");
		await drive(
			[agentTool("agent_spawn", thread("/root/other", 1000, 100))],
			[
				response([toolCall("spawn", "agent_spawn")], "toolUse", 90),
				response([{ type: "text", text: "Unrelated subagent work." }], "stop", 80),
			],
		);
		// The injection really rode the tool result into the turn...
		assert.equal(toolUsageByTurn.at(-2), 1100);
		// ...but the completed goal's gate does not count it.
		assert.equal(readGoalState(cwd).impl.tokensUsed, expected);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a subagent delta and the completion audit each count once in the same turn", async () => {
	const cwd = scratch();
	try {
		const { run, context, drive } = activeGoalRun(cwd);
		await drive(
			[agentTool("agent_spawn", thread("/root/research", 1000, 100))],
			[
				response([toolCall("spawn", "agent_spawn")], "toolUse", 30),
				response([{ type: "text", text: "Spawned." }], "stop", 40),
			],
		);
		const auditUsage = auditUsageOf(17);
		await drive(
			[agentTool("agent_wait", thread("/root/research", 1500, 140)), completeTool(run, context, auditUsage)],
			[
				response([toolCall("wait", "agent_wait"), toolCall("finish", "complete_plan_goal")], "toolUse", 30),
				response([{ type: "text", text: "Waited and completed." }], "stop", 40),
			],
		);
		// One turn: message 30 + injected subagent delta 540 + audit 17; the
		// closing response 40 counts through the completion's closing-run gate.
		assert.equal(readGoalState(cwd).impl.tokensUsed, (30 + 1100 + 40) + 30 + 540 + 17 + 40);
		assert.equal(readGoalState(cwd).status, "complete");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a re-spawned path counts its fresh totals in full, then differences again", async () => {
	const cwd = scratch();
	try {
		const { drive } = activeGoalRun(cwd);
		await drive(
			[agentTool("agent_spawn", thread("/root/research", 1000, 100))],
			[
				response([toolCall("spawn", "agent_spawn")], "toolUse", 30),
				response([{ type: "text", text: "Spawned." }], "stop", 40),
			],
		);
		// `/agents reap` retired that thread; the same path spawns again and
		// grows to 500/50. Differencing against the stale watermark would
		// swallow the new thread's consumption (max(0, 500-1000) = 0).
		await drive(
			[agentTool("agent_spawn", thread("/root/research", 500, 50)), agentTool("agent_wait", thread("/root/research", 700, 90))],
			[
				response([toolCall("respawn", "agent_spawn")], "toolUse", 50),
				response([toolCall("wait", "agent_wait")], "toolUse", 60),
				response([{ type: "text", text: "Respawned and waited." }], "stop", 70),
			],
		);
		assert.equal(readGoalState(cwd).impl.tokensUsed, (30 + 1100 + 40) + (50 + 550) + (60 + 240) + 70);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
