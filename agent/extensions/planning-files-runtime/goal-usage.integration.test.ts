import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, Type, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import { runAgentLoop, type AgentEvent, type AgentLoopConfig, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createGoalLifecycle, type GoalLifecycleContext } from "./goal-lifecycle.ts";
import { readGoalState } from "./state.ts";
import { sumUsageTokens } from "./utils.ts";

const contract = {
	objective: "Account for the complete goal run",
	successCriteria: ["Both tool and follow-up responses are counted"],
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

// Exercise the real host loop's scheduling; only the model response transport is scripted.
for (const operation of ["commit", "pause", "complete"] as const) {
	for (const closingStop of ["stop", "aborted", "error"] as const) {
		test(`real agent loop counts ${operation} follow-up (${closingStop}) and excludes the next unrelated run`, async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-usage-loop-"));
			try {
				const run = createGoalLifecycle(cwd, { sendMessage() {} });
				const context: GoalLifecycleContext = { notify() {}, refresh() {} };
				assert.equal(run.handle({ type: "start-drafting", input: "Account for a goal" }, context).error, undefined);
				if (operation !== "commit") {
					assert.equal(run.handle({ type: "commit", params: contract }, context).error, undefined);
					assert.equal(run.handle({ type: "implementation-request" }, context).error, undefined);
				}
				const toolName = `${operation}_plan_goal`;
				const auditUsage = usage(17);
				let executions = 0;
				const tool: AgentTool = {
					name: toolName, label: toolName, description: "Finish this goal stage", parameters: Type.Object({}),
					execute: async () => {
						executions++;
						const result = operation === "complete"
							? await run.complete({ summary: "Done", evidence: ["Scripted check passed"] }, context, {
								modelCall: async () => ({ kind: "completed", text: "criterion 1: MET\nVERDICT: APPROVE", usage: auditUsage }),
							})
							: run.handle(operation === "commit" ? { type: "commit", params: contract } : { type: "pause", params: { reason: "Waiting for input" } }, context);
						assert.equal(result.error, undefined);
						return { content: [{ type: "text", text: "Saved" }], details: {}, ...(result.audit?.usage ? { usage: { ...auditUsage, ...result.audit.usage } } : {}) };
					},
				};
				const order: string[] = [];
				const emit = (event: AgentEvent) => {
					if (event.type === "agent_start" || event.type === "turn_start") {
						order.push(event.type);
						assert.equal(run.handle({ type: event.type === "agent_start" ? "agent-start" : "turn-start" }, context).error, undefined);
					} else if (event.type === "turn_end") {
						order.push(event.type);
						assert.equal(event.message.role, "assistant");
						const message = event.message as AssistantMessage;
						const toolTokens = event.toolResults.reduce((sum, result) => sum + (result.usage ? sumUsageTokens(result.usage) : 0), 0);
						assert.equal(run.handle({ type: "turn-end", stopReason: message.stopReason, usageTokens: sumUsageTokens(message.usage) + toolTokens }, context).error, undefined);
					} else if (event.type === "agent_end") order.push(event.type);
				};
				const config: AgentLoopConfig = { model, convertToLlm: (messages) => messages };
				const messages = await runAgentLoop(
					[{ role: "user", content: "Finish the goal stage", timestamp: Date.now() }],
					{ messages: [], tools: [tool] }, config, emit, undefined,
					scriptedResponses([
						response([{ type: "toolCall", id: "finish", name: toolName, arguments: {} }], "toolUse", 30),
						response([{ type: "text", text: "The goal stage has been saved." }], closingStop, 40),
					]),
				);
				assert.equal(executions, 1);
				assert.deepEqual(order, ["agent_start", "turn_start", "turn_end", "turn_start", "turn_end", "agent_end"]);
				const expected = 70 + (operation === "complete" ? 17 : 0);
				assert.equal(readGoalState(cwd).impl.tokensUsed, expected);
				assert.equal(run.getState().status, operation === "commit" ? "ready" : operation === "pause" ? "paused" : "complete");
				// The session layer emits settlement after the core loop finishes.
				assert.equal(run.handle({ type: "before-settle", outcome: closingStop === "stop" ? "completed" : closingStop }, context).continuation, undefined);
				assert.equal(run.handle({ type: "agent-settled", aborted: closingStop === "aborted" }, context).error, undefined);
				await runAgentLoop(
					[{ role: "user", content: "An unrelated conversation", timestamp: Date.now() }],
					{ messages, tools: [tool] }, config, emit, undefined,
					scriptedResponses([response([{ type: "text", text: "Unrelated answer" }], "stop", 80)]),
				);
				assert.equal(readGoalState(cwd).impl.tokensUsed, expected);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		});
	}
}
