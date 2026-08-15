import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	GOAL_TOOL_NAMES,
	MESSAGE_TYPE_PLAN_UPDATE,
	WIDGET_KEY,
} from "./types.ts";
import type {
	CommitGoalParams,
	CompleteGoalParams,
	PauseGoalParams,
	SaveGoalDraftParams,
} from "./types.ts";
import { normalizeString } from "./utils.ts";
import { archivePlanningWorkspace, getPlanningSnapshot, initializePlanningWorkspace } from "./workspace.ts";
import { runPlanArchiveCommand } from "./archive-command.ts";
import { runPlanNewCommand } from "./new-command.ts";
import { buildPlanUpdatePrompt } from "./prompts.ts";
import { buildWidgetLines } from "./ui.ts";
import { isMeaningfulProgressToolCall, gateDraftingToolCall, redirectPlanningPath } from "./guards.ts";
import { createGoalLifecycle, createSetTimeoutTimer, type GoalLifecycle, type GoalLifecycleContext, type GoalLifecycleResult } from "./goal-lifecycle.ts";

/**
 * Pi is an adapter around the Goal lifecycle. goal-lifecycle.ts owns
 * state transitions, effect execution, rollback, and continuation policy;
 * this module only translates Pi events and reads the operation result projection.
 */
export default function planningFilesRuntime(pi: ExtensionAPI): void {
	let state = getPlanningSnapshot(process.cwd(), false);
	const lifecycles = new Map<string, GoalLifecycle>();
	const timer = createSetTimeoutTimer();

	function lifecycleFor(cwd: string): GoalLifecycle {
		let lifecycle = lifecycles.get(cwd);
		if (!lifecycle) {
			lifecycle = createGoalLifecycle(cwd, {
				sendMessage: (message, options) => pi.sendMessage(message, options),
				timer,
			});
			lifecycles.set(cwd, lifecycle);
		}
		return lifecycle;
	}

	function contextFor(ctx: ExtensionContext, resumedFromPreviousSession = false): GoalLifecycleContext {
		return {
			resumedFromPreviousSession,
			isIdle: () => ctx.isIdle(),
			notify: (message, level) => ctx.ui.notify(message, level),
			refresh: () => refresh(ctx, resumedFromPreviousSession),
		};
	}
	function refresh(ctx: ExtensionContext, resumedFromPreviousSession = state.resumedFromPreviousSession): void {
		state = getPlanningSnapshot(ctx.cwd, resumedFromPreviousSession);
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(state), { placement: "aboveEditor" });
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
		description: "Mark the active goal implementation complete.",
		promptSnippet: "Complete the active goal run after success criteria are truly satisfied and evidence is recorded.",
		promptGuidelines: ["Use complete_plan_goal only after the committed goal has been achieved and progress.md contains completion evidence."],
		parameters: Type.Object({
			summary: Type.String({ description: "Completion summary" }),
			evidence: Type.Optional(Type.Array(Type.String(), { description: "Concrete evidence that the goal is complete" })),
		}),
		async execute(_toolCallId, params: CompleteGoalParams, _signal, _onUpdate, ctx) {
			const lifecycle = lifecycleFor(ctx.cwd);
			const result = lifecycle.handle({ type: "complete", params }, contextFor(ctx));
			const error = toolError(result);
			if (error) return error;
			return {
				content: [{ type: "text", text: `Completed plan goal: ${normalizeString(params.summary)}` }],
				details: { status: lifecycle.getState().status, summary: normalizeString(params.summary), evidence: params.evidence ?? [] },
			};
		},
	});

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
					clearContinuation: () => timer.clear(),
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
		handler: async (_args, ctx) => {
			const lifecycle = lifecycleFor(ctx.cwd);
			notifyRejection(ctx, lifecycle.handle({ type: "implementation-request" }, contextFor(ctx)));
		},
	});

	pi.registerCommand("plan-update", {
		description: "检查当前进展和发现是否与 planning files 记录的内容对齐延续。如果是，让 agent 更新 planning files；如果不是，询问用户是否要 reset 再写，还是先中断。",
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
		const blocked = gateDraftingToolCall(lifecycle.getState().status, event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		if (blocked) return blocked;
		if (isMeaningfulProgressToolCall(event.toolName, event.input as Record<string, unknown>)) {
			lifecycle.handle({ type: "progress-tool-called" }, contextFor(ctx));
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (["write", "edit", ...GOAL_TOOL_NAMES].includes(event.toolName)) refresh(ctx, false);
	});

	pi.on("turn_end", async (event, ctx) => {
		const lifecycle = lifecycleFor(ctx.cwd);
		const message = event.message as { stopReason?: string; errorMessage?: string } | undefined;
		const result = lifecycle.handle(
			{ type: "turn-end", stopReason: message?.stopReason, errorMessage: message?.errorMessage },
			contextFor(ctx, state.resumedFromPreviousSession),
		);
		notifyRejection(ctx, result);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const lifecycle = lifecycleFor(ctx.cwd);
		notifyRejection(ctx, lifecycle.handle({ type: "agent-settled" }, contextFor(ctx, state.resumedFromPreviousSession)));
	});
}
