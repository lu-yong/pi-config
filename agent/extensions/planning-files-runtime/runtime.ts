import { Type } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	MESSAGE_TYPE_PLAN_UPDATE,
	WIDGET_KEY,
} from "./types.ts";
import type {
	CommitGoalParams,
	CompleteGoalParams,
	PauseGoalParams,
	SaveGoalDraftParams,
} from "./types.ts";
import { getPaths, normalizeString, normalizeStringArray, readText, sumUsageTokens, tailLines } from "./utils.ts";
import { parseAuditModelRef, resolveAuditModel, runCompletionAudit, type AuditModelResult } from "./audit.ts";
import { archivePlanningWorkspace, getPlanningSnapshot, initializePlanningWorkspace } from "./workspace.ts";
import { runPlanArchiveCommand } from "./archive-command.ts";
import { runPlanNewCommand } from "./new-command.ts";
import { buildPlanUpdatePrompt } from "./prompts.ts";
import { buildWidgetLines } from "./ui.ts";
import { isLivePlanningMutation, isMeaningfulProgressToolCall, gateDraftingToolCall, redirectPlanningPath } from "./guards.ts";
import { createGoalLifecycle, type GoalLifecycle, type GoalLifecycleContext, type GoalLifecycleResult } from "./goal-lifecycle.ts";

/**
 * Pi is an adapter around the Goal lifecycle. goal-lifecycle.ts owns
 * state transitions, effect execution, rollback, and continuation policy;
 * this module only translates Pi events and reads the operation result projection.
 */
export default function planningFilesRuntime(pi: ExtensionAPI): void {
	let state = getPlanningSnapshot(process.cwd(), false);
	const lifecycles = new Map<string, GoalLifecycle>();

	function lifecycleFor(cwd: string): GoalLifecycle {
		let lifecycle = lifecycles.get(cwd);
		if (!lifecycle) {
			lifecycle = createGoalLifecycle(cwd, {
				sendMessage: (message, options) => pi.sendMessage(message, options),
			});
			lifecycles.set(cwd, lifecycle);
		}
		return lifecycle;
	}

	function contextFor(ctx: ExtensionContext, resumedFromPreviousSession = false): GoalLifecycleContext {
		return {
			resumedFromPreviousSession,
			notify: (message, level) => ctx.ui.notify(message, level),
			refresh: () => refresh(ctx, resumedFromPreviousSession, false),
		};
	}
	function refresh(ctx: ExtensionContext, resumedFromPreviousSession = state.resumedFromPreviousSession, syncGoal = true): void {
		// Widget projection is best-effort; a failure here must never roll back
		// persisted goal state, but it must be visible instead of silently leaving
		// a stale widget in place.
		try {
			const lifecycle = lifecycleFor(ctx.cwd);
			// Lifecycle effects already own an in-flight transaction; do not re-enter it.
			if (syncGoal) {
				const result = lifecycle.handle({ type: "sync" }, contextFor(ctx, resumedFromPreviousSession));
				if (result.failure) throw new Error(result.failure.reason);
			}
			state = getPlanningSnapshot(ctx.cwd, resumedFromPreviousSession);
			state.goalState = lifecycle.getState();
		} catch (error) {
			reportRefreshFailure(ctx, "读取 planning 快照失败", error);
			return;
		}
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(state), { placement: "aboveEditor" });
		} catch (error) {
			reportRefreshFailure(ctx, "更新 planning widget 失败", error);
		}
	}
	function reportRefreshFailure(ctx: ExtensionContext, label: string, error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		const message = `${label}: ${detail}`;
		if (ctx.hasUI) {
			try {
				ctx.ui.notify(message, "warning");
				return;
			} catch {
				// fall through to stderr
			}
		}
		console.error(`[planning-files-runtime] ${message}`);
	}
	function notifyRejection(ctx: ExtensionContext, result: GoalLifecycleResult): void {
		const message = result.failure?.reason ?? result.rejection?.reason;
		if (message) ctx.ui.notify(message, "warning");
	}

	function toolError(result: GoalLifecycleResult): { content: Array<{ type: "text"; text: string }>; isError: true; details: undefined } | undefined {
		const message = result.failure?.reason ?? result.rejection?.reason;
		if (!message) return undefined;
		return { content: [{ type: "text", text: message }], isError: true, details: undefined };
	}


	// ---- tools ----
	pi.registerTool({
		name: "save_plan_goal_draft",
		label: "Save Plan Goal Draft",
		description: "Persist a partially clarified goal draft for later continuation.",
		promptSnippet: "Persist partial goal clarification for /plan-goal-set.",
		promptGuidelines: ["Use save_plan_goal_draft to persist partially clarified goal information during /plan-goal-set drafting."],
		parameters: Type.Object({
			sourceTopic: Type.Optional(Type.String({ description: "Original goal topic, if being set or corrected" })),
			clarificationSummary: Type.Optional(Type.Array(Type.String(), { description: "Short bullets summarizing what is now clear" })),
			objective: Type.Optional(Type.String({ description: "Current draft objective" })),
			successCriteria: Type.Optional(Type.Array(Type.String(), { description: "Current draft success criteria" })),
			constraints: Type.Optional(Type.Array(Type.String(), { description: "Hard constraints the implementation must respect" })),
			outOfScope: Type.Optional(Type.Array(Type.String(), { description: "Explicitly excluded work" })),
			blockerRule: Type.Optional(Type.String({ description: "What the agent should do if blocked" })),
			openQuestions: Type.Optional(Type.Array(Type.String(), { description: "Remaining open questions that still need user input" })),
			nextRecommendedQuestion: Type.Optional(Type.String({ description: "The single next question the agent most wants to ask" })),
			draftingStage: Type.Optional(Type.String({ description: "Current drafting stage: as-is, design, story, or task" })),
		}),
		async execute(_toolCallId, params: SaveGoalDraftParams, _signal, _onUpdate, ctx) {
			const lifecycle = lifecycleFor(ctx.cwd);
			const result = lifecycle.handle({ type: "save-draft", params }, contextFor(ctx));
			const error = toolError(result);
			if (error) return error;
			const next = lifecycle.getState();
			return {
				content: [{ type: "text", text: `Saved goal draft with ${next.draft.openQuestions.length} open question(s).` }],
				details: { status: next.status, openQuestions: next.draft.openQuestions },
			};
		},
	});

	pi.registerTool({
		name: "commit_plan_goal",
		label: "Commit Plan Goal",
		description: "Commit a clarified goal so /plan-goal-impl can execute it.",
		promptSnippet: "Commit a fully clarified goal contract for later implementation.",
		promptGuidelines: ["Use commit_plan_goal only when the goal contract is concrete enough to start implementation later with /plan-goal-impl."],
		parameters: Type.Object({
			objective: Type.String({ description: "One-sentence goal objective" }),
			successCriteria: Type.Array(Type.String(), { description: "Observable evidence that the goal is complete" }),
			constraints: Type.Array(Type.String(), { description: "Hard constraints the implementation must respect" }),
			outOfScope: Type.Array(Type.String(), { description: "Explicitly excluded work" }),
			blockerRule: Type.String({ description: "What the agent should do if blocked" }),
			tokenBudget: Type.Optional(Type.Integer({ minimum: 1, description: "Optional token spend cap for this goal; set only when the user asked for one" })),
		}),
		async execute(_toolCallId, params: CommitGoalParams, _signal, _onUpdate, ctx) {
			const lifecycle = lifecycleFor(ctx.cwd);
			const result = lifecycle.handle({ type: "commit", params }, contextFor(ctx));
			const error = toolError(result);
			if (error) return error;
			const goal = lifecycle.getState().goal;
			return {
				content: [{ type: "text", text: `Committed plan goal: ${goal?.objective ?? params.objective}` }],
				details: { status: lifecycle.getState().status, goal },
			};
		},
	});

	pi.registerTool({
		name: "pause_plan_goal",
		label: "Pause Plan Goal",
		description: "Pause the active goal implementation because of a real blocker.",
		promptSnippet: "Pause the active goal run when a real blocker prevents the next reasonable step.",
		promptGuidelines: ["Use pause_plan_goal instead of just chatting when a real blocker stops goal implementation."],
		parameters: Type.Object({
			reason: Type.String({ description: "Concrete blocker reason" }),
			suggestedAction: Type.Optional(Type.String({ description: "Suggested next user action" })),
		}),
		async execute(_toolCallId, params: PauseGoalParams, _signal, _onUpdate, ctx) {
			const lifecycle = lifecycleFor(ctx.cwd);
			const result = lifecycle.handle({ type: "pause", params }, contextFor(ctx));
			const error = toolError(result);
			if (error) return error;
			return {
				content: [{ type: "text", text: `Paused plan goal: ${normalizeString(params.reason)}` }],
				details: { status: lifecycle.getState().status, reason: normalizeString(params.reason), suggestedAction: normalizeString(params.suggestedAction) },
			};
		},
	});

	pi.registerTool({
		name: "complete_plan_goal",
		label: "Complete Plan Goal",
		description: "Mark the active goal implementation complete. An independent model audits the claim against the success criteria before completion is accepted.",
		promptSnippet: "Complete the active goal run after success criteria are truly satisfied and evidence is recorded; the claim is independently audited.",
		parameters: Type.Object({
			summary: Type.String({ description: "Completion summary" }),
			evidence: Type.Optional(Type.Array(Type.String(), { description: "Concrete evidence that the goal is complete" })),
		}),
		async execute(_toolCallId, params: CompleteGoalParams, signal, _onUpdate, ctx) {
			const lifecycle = lifecycleFor(ctx.cwd);
			const current = lifecycle.getState();
			let audit: Awaited<ReturnType<typeof runCompletionAudit>> | null = null;
			if (current.status === "active" && current.goal) {
				audit = await runCompletionAudit(
					{
						goal: current.goal,
						summary: normalizeString(params.summary),
						evidence: normalizeStringArray(params.evidence),
						progressTail: tailLines(readText(getPaths(ctx.cwd).files["progress.md"]), 80),
					},
					(system, user) => callAuditor(ctx, system, user, signal),
				);
				// A user cancellation during the audit must not accept the goal:
				// the aborted settlement pauses the still-active run instead.
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Goal completion cancelled: the audit was aborted before a verdict. The goal stays active." }],
						isError: true,
						details: undefined,
						...(audit && "usage" in audit && audit.usage ? { usage: audit.usage as Usage } : {}),
					};
				}
				if (audit.kind === "rejected") {
					return {
						content: [
							{
								type: "text",
								text: `Goal completion rejected by independent audit. Unmet or unevidenced criteria: ${audit.reasons} Close the gaps, record concrete evidence in progress.md, then call complete_plan_goal again; if the criteria are met but cannot be evidenced, call pause_plan_goal and explain.`,
							},
						],
						isError: true,
						details: undefined,
						...(audit.usage ? { usage: audit.usage as Usage } : {}),
					};
				}
			}
			const result = lifecycle.handle({ type: "complete", params }, contextFor(ctx));
			const error = toolError(result);
			if (error) return { ...error, ...(audit && "usage" in audit && audit.usage ? { usage: audit.usage as Usage } : {}) };
			const auditNote = audit
				? audit.kind === "approved"
					? " (independent audit: approved)"
					: ` (independent audit skipped: ${audit.reason})`
				: "";
			return {
				content: [{ type: "text", text: `Completed plan goal: ${normalizeString(params.summary)}${auditNote}` }],
				details: { status: lifecycle.getState().status, summary: normalizeString(params.summary), evidence: normalizeStringArray(params.evidence) },
				// The audit module types usage as a structural subset; the production
				// adapter supplies the provider's full Usage object, so re-widen it here
				// for session accounting.
				...(audit && "usage" in audit && audit.usage ? { usage: audit.usage as Usage } : {}),
			};
		},
	});

	// ---- completion audit adapter ----

	/** Read `planning.auditModel` on every completion, so config edits apply
	 * without a restart. `pi.getSettings()` returns the merged global+project
	 * view (custom keys are preserved as-is). */
	function readAuditModelRef() {
		try {
			return parseAuditModelRef((pi.getSettings() as { planning?: unknown }).planning);
		} catch {
			return null;
		}
	}

	/** Production adapter of the audit model port: one provider-neutral streamSimple call. */
	async function callAuditor(ctx: ExtensionContext, system: string, user: string, signal: AbortSignal | undefined): Promise<AuditModelResult> {
		const resolved = resolveAuditModel(readAuditModelRef(), ctx.model, (provider, id) => ctx.modelRegistry.find(provider, id));
		if (!resolved) return { kind: "failed", reason: "no model is available for the completion audit" };
		if (resolved.notice) ctx.ui.notify(resolved.notice, "warning");
		const response = await ctx.modelRegistry.streamSimple(
			resolved.model,
			{ systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] },
			{ reasoning: resolved.thinking, ...(signal ? { signal } : {}) },
		).result();
		if (response.stopReason === "error") {
			return { kind: "failed", reason: `auditor request failed${response.errorMessage ? `: ${response.errorMessage}` : ""}`, ...(response.usage ? { usage: response.usage } : {}) };
		}
		if (response.stopReason === "aborted") return { kind: "failed", reason: "auditor request was aborted", ...(response.usage ? { usage: response.usage } : {}) };
		const text = response.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		return { kind: "completed", text, ...(response.usage ? { usage: response.usage } : {}) };
	}

	// ---- commands ----
	pi.registerCommand("plan-archive", {
		description: "Archive the current .pi/planning workspace without creating a new one, regardless of goal status.",
		handler: async (_args, ctx) => {
			runPlanArchiveCommand(
				{
					cwd: ctx.cwd,
					isIdle: () => ctx.isIdle(),
					notify: (message, level) => ctx.ui.notify(message, level),
				},
				{
					archive: (cwd) => archivePlanningWorkspace(cwd, { includeGoalState: true, includeGoalDesign: true, label: "plan-archive" }),
					dropLifecycle: (cwd) => lifecycles.delete(cwd),
					refresh: () => refresh(ctx, false),
				},
			);
		},
	});

	pi.registerCommand("plan-new", {
		description: "Initialize or reset .pi/planning and clear any current goal overlay.",
		handler: async (_args, ctx) => {
			runPlanNewCommand(
				{
					cwd: ctx.cwd,
					isIdle: () => ctx.isIdle(),
					notify: (message, level) => ctx.ui.notify(message, level),
				},
				{
					archive: (cwd) => archivePlanningWorkspace(cwd, { includeGoalState: true, includeGoalDesign: true, label: "plan-reset" }),
					initialize: (cwd) => initializePlanningWorkspace(cwd),
					reset: () => {
						const lifecycle = lifecycleFor(ctx.cwd);
						const result = lifecycle.handle({ type: "reset" }, contextFor(ctx));
						notifyRejection(ctx, result);
						return !(result.failure || result.rejection);
					},
				},
			);
		},
	});

	pi.registerCommand("plan-goal-set", {
		description: "Create or continue clarifying a goal overlay without resetting current planning files.",
		handler: async (args, ctx) => {
			const lifecycle = lifecycleFor(ctx.cwd);
			notifyRejection(ctx, lifecycle.handle({ type: "start-drafting", input: args }, contextFor(ctx)));
		},
	});

	pi.registerCommand("plan-goal-impl", {
		description: "Start or resume implementing the committed goal using planning files as the execution tracker.",
		handler: async (args, ctx) => {
			const lifecycle = lifecycleFor(ctx.cwd);
			notifyRejection(ctx, lifecycle.handle({ type: "implementation-request", supplementalInput: args }, contextFor(ctx)));
		},
	});

	pi.registerCommand("plan-update", {
		description: "Check whether current progress and findings stay aligned with the planning files. If aligned, have the agent update the planning files; if not, ask the user whether to reset and rewrite, or pause first.",
		handler: async (_args, ctx) => {
			const snapshot = getPlanningSnapshot(ctx.cwd, state.resumedFromPreviousSession);
			state = snapshot;

			if (!snapshot.exists) {
				ctx.ui.notify("没有 planning files，无需更新。", "info");
				return;
			}

			pi.sendMessage(
				{
					customType: MESSAGE_TYPE_PLAN_UPDATE,
					content: buildPlanUpdatePrompt(snapshot),
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});

	// ---- events ----
	pi.on("session_start", async (event, ctx) => {
		const resumed = event.reason === "resume" || event.reason === "fork";
		const lifecycle = lifecycleFor(ctx.cwd);
		const result = lifecycle.handle({ type: "restore" }, contextFor(ctx, resumed));
		notifyRejection(ctx, result);
		refresh(ctx, resumed);
		if (!state.exists && lifecycle.getState().status === "none") return;
		const label = resumed ? "Planning runtime resumed." : `Planning runtime attached to ${state.planningRoot}`;
		ctx.ui.notify(label, "info");
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		refresh(ctx, state.resumedFromPreviousSession);
	});

	pi.on("agent_start", async (_event, ctx) => {
		const lifecycle = lifecycleFor(ctx.cwd);
		const result = lifecycle.handle({ type: "agent-start" }, contextFor(ctx, state.resumedFromPreviousSession));
		notifyRejection(ctx, result);
	});

	pi.on("turn_start", async (_event, ctx) => {
		const lifecycle = lifecycleFor(ctx.cwd);
		lifecycle.handle({ type: "turn-start" }, contextFor(ctx));
	});

	pi.on("tool_call", async (event, ctx) => {
		const lifecycle = lifecycleFor(ctx.cwd);
		const turnStoppedFor = lifecycle.turnStoppedBy();
		if (turnStoppedFor) {
			return { block: true, reason: `${turnStoppedFor} already completed in this turn. Stop and summarize instead of calling more tools.` };
		}
		redirectPlanningPath(event as { toolName: string; input: Record<string, unknown> }, ctx.cwd);
		// Keep drafting decisions current too; a failed read leaves the last-known gate
		// in place while file tools remain available to repair the state file.
		notifyRejection(ctx, lifecycle.handle({ type: "sync" }, contextFor(ctx)));
		const blocked = gateDraftingToolCall(lifecycle.getState().status, event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		if (blocked) return blocked;
		if (isMeaningfulProgressToolCall(event.toolName, event.input as Record<string, unknown>)) {
			lifecycle.handle({ type: "progress-tool-called" }, contextFor(ctx));
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (isLivePlanningMutation(event.toolName, event.input as Record<string, unknown>, ctx.cwd)) refresh(ctx, false);
	});

	pi.on("turn_end", async (event, ctx) => {
		const lifecycle = lifecycleFor(ctx.cwd);
		const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } } | undefined;
		// Nested model calls (the completion audit) report their usage on tool
		// results; count them toward the budget alongside the assistant message.
		const toolUsage = ((event.toolResults as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }[] | undefined) ?? []).reduce(
			(sum, result) => sum + (result.usage ? sumUsageTokens(result.usage) : 0),
			0,
		);
		const messageUsage = message?.role === "assistant" && message.usage ? sumUsageTokens(message.usage) : 0;
		const usageTokens = messageUsage + toolUsage > 0 ? messageUsage + toolUsage : undefined;
		const result = lifecycle.handle(
			{ type: "turn-end", stopReason: message?.stopReason, errorMessage: message?.errorMessage, usageTokens },
			contextFor(ctx, state.resumedFromPreviousSession),
		);
		notifyRejection(ctx, result);
	});

	pi.on("agent_settled", async (event, ctx) => {
		const lifecycle = lifecycleFor(ctx.cwd);
		notifyRejection(ctx, lifecycle.handle({ type: "agent-settled", aborted: event.aborted }, contextFor(ctx, state.resumedFromPreviousSession)));
	});

	// The automatic Continuation rides Pi's native boundary: return the
	// rebuilt continuation prompt as a custom_message entry and let Pi
	// schedule the next model request. No idle-window race with compaction.
	pi.on("agent_before_settle", async (event, ctx) => {
		const lifecycle = lifecycleFor(ctx.cwd);
		const result = lifecycle.handle({ type: "before-settle", outcome: event.outcome }, contextFor(ctx, state.resumedFromPreviousSession));
		notifyRejection(ctx, result);
		const message = result.continuation?.message;
		if (!message) return undefined;
		return {
			entries: [{ type: "custom_message", customType: message.customType, content: message.content, display: false }],
			continue: true,
		};
	});
}
