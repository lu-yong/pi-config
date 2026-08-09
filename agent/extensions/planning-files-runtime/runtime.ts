import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	CONTINUATION_DELAY_MS,
	GOAL_TOOL_NAMES,
	MESSAGE_TYPE_CONTINUATION,
	MESSAGE_TYPE_GOAL_IMPL,
	MESSAGE_TYPE_GOAL_SET,
	WIDGET_KEY,
} from "./types.ts";
import type {
	CommitGoalParams,
	CompleteGoalParams,
	PauseGoalParams,
	SaveGoalDraftParams,
} from "./types.ts";
import { ensureDir, getPaths, normalizeString, readText, tailLines } from "./utils.ts";
import { archivePlanningWorkspace, createGoalDesignSkeleton, hasPlanningFiles, initializePlanningWorkspace } from "./workspace.ts";
import { buildGoalImplPrompt, buildGoalSetPrompt, getPlanningSnapshot } from "./prompts.ts";
import { appendProgressTimeline } from "./markdown.ts";
import { buildWidgetLines } from "./ui.ts";
import { isInPlanningDir, isMeaningfulProgressToolCall, isUnsafeDraftingBash, redirectPlanningPath } from "./guards.ts";
import { createGoalOverlay, type GoalOverlay, type GoalOverlayEffect } from "./goal-overlay.ts";

/**
 * Pi is an adapter around the goal overlay. The overlay decides transitions
 * and continuation policy; this module translates Pi events and executes the
 * resulting effects (including timers and follow-up messages).
 */
export default function planningFilesRuntime(pi: ExtensionAPI): void {
	let state = getPlanningSnapshot(process.cwd(), false);
	let turnStoppedFor: string | null = null;
	let continuationQueuedFor: string | null = null;
	let continuationTimer: ReturnType<typeof setTimeout> | null = null;
	const overlays = new Map<string, GoalOverlay>();

	function overlayFor(cwd: string): GoalOverlay {
		let overlay = overlays.get(cwd);
		if (!overlay) {
			overlay = createGoalOverlay(cwd);
			overlays.set(cwd, overlay);
		}
		return overlay;
	}

	function clearContinuation(): void {
		continuationQueuedFor = null;
		if (continuationTimer) {
			clearTimeout(continuationTimer);
			continuationTimer = null;
		}
	}

	function refresh(ctx: ExtensionContext, resumedFromPreviousSession = state.resumedFromPreviousSession): void {
		state = getPlanningSnapshot(ctx.cwd, resumedFromPreviousSession);
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(state), { placement: "aboveEditor" });
	}

	type AppliedEffects = { rejection?: { operation: string; reason: string }; failure?: { operation: string; reason: string }; };

	function applyGoalEffects(
		effects: GoalOverlayEffect[],
		ctx: ExtensionContext,
		overlay: GoalOverlay,
		resumedFromPreviousSession = false,
	): AppliedEffects {
		let rejection: AppliedEffects["rejection"];
		let failure: AppliedEffects["failure"];
		try {
		for (const effect of effects) {
			switch (effect.type) {
				case "ensure-goal-design":
					ensureDir(getPaths(ctx.cwd).root);
					createGoalDesignSkeleton(ctx.cwd);
					break;
				case "archive-implementation-workspace":
					archivePlanningWorkspace(ctx.cwd, {
						includeGoalState: false,
						includeGoalDesign: false,
						label: effect.label,
					});
					break;
				case "initialize-implementation-workspace":
					initializePlanningWorkspace(ctx.cwd, effect.goal, effect.runId);
					break;
				case "ensure-implementation-workspace":
					if (!hasPlanningFiles(ctx.cwd)) initializePlanningWorkspace(ctx.cwd, effect.goal, effect.runId);
					break;
				case "append-progress":
					appendProgressTimeline(ctx.cwd, effect.heading, effect.message);
					break;
				case "clear-continuation":
					clearContinuation();
					break;
				case "refresh":
					refresh(ctx, resumedFromPreviousSession);
					break;
				case "send-goal-set": {
					const snapshot = getPlanningSnapshot(ctx.cwd, resumedFromPreviousSession);
					pi.sendMessage(
						{
							customType: MESSAGE_TYPE_GOAL_SET,
							content: buildGoalSetPrompt(snapshot.goalState, effect.supplementalInput),
							display: false,
						},
						{ triggerTurn: true },
					);
					break;
				}
				case "send-goal-impl": {
					const snapshot = getPlanningSnapshot(ctx.cwd, resumedFromPreviousSession);
					pi.sendMessage(
						{
							customType: MESSAGE_TYPE_GOAL_IMPL,
							content: buildGoalImplPrompt(snapshot, effect.mode),
							display: false,
						},
						{ triggerTurn: true },
					);
					break;
				}
				case "queue-continuation":
					queueContinuation(ctx, overlay, effect.runId);
					break;
				case "send-continuation":
					pi.sendMessage(
						{
							customType: MESSAGE_TYPE_CONTINUATION,
							content: buildGoalImplPrompt(getPlanningSnapshot(ctx.cwd, resumedFromPreviousSession), "continue"),
							display: false,
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
					break;
				case "stop-turn":
					turnStoppedFor = effect.operation;
					break;
				case "reject":
					rejection = { operation: effect.operation, reason: effect.reason };
					break;
			}
		}
		} catch (error) {
			overlay.rollback();
			clearContinuation();
			const message = error instanceof Error ? error.message : String(error);
			failure = { operation: "effect-execution", reason: `Goal overlay effect failed; state restored. Retry the operation. ${message}` };
		}
		return { rejection, failure };
	}

	function queueContinuation(ctx: ExtensionContext, overlay: GoalOverlay, runId: number): void {
		const current = overlay.getState();
		if (current.status !== "active" || current.impl.runId !== runId || current.impl.planningResetRequired) return;
		if (continuationQueuedFor === `${runId}`) return;
		clearContinuation();
		continuationQueuedFor = `${runId}`;
		continuationTimer = setTimeout(() => {
			continuationTimer = null;
			continuationQueuedFor = null;
			applyGoalEffects(overlay.handle({ type: "continuation-fired", runId }), ctx, overlay, state.resumedFromPreviousSession);
		}, CONTINUATION_DELAY_MS);
	}

	function notifyRejection(ctx: ExtensionContext, result: AppliedEffects): void {
		const message = result.failure?.reason ?? result.rejection?.reason;
		if (message) ctx.ui.notify(message, "warning");
	}

	function toolError(result: AppliedEffects): { content: Array<{ type: "text"; text: string }>; isError: true; details: undefined } | undefined {
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
			const overlay = overlayFor(ctx.cwd);
			const result = applyGoalEffects(overlay.handle({ type: "save-draft", params }), ctx, overlay);
			const error = toolError(result);
			if (error) return error;
			const next = overlay.getState();
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
			const overlay = overlayFor(ctx.cwd);
			const result = applyGoalEffects(overlay.handle({ type: "commit", params }), ctx, overlay);
			const error = toolError(result);
			if (error) return error;
			const goal = overlay.getState().goal;
			return {
				content: [{ type: "text", text: `Committed plan goal: ${goal?.objective ?? params.objective}` }],
				details: { status: overlay.getState().status, goal },
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
			const overlay = overlayFor(ctx.cwd);
			const result = applyGoalEffects(overlay.handle({ type: "pause", params }), ctx, overlay);
			const error = toolError(result);
			if (error) return error;
			return {
				content: [{ type: "text", text: `Paused plan goal: ${normalizeString(params.reason)}` }],
				details: { status: overlay.getState().status, reason: normalizeString(params.reason), suggestedAction: normalizeString(params.suggestedAction) },
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
			const overlay = overlayFor(ctx.cwd);
			const result = applyGoalEffects(overlay.handle({ type: "complete", params }), ctx, overlay);
			const error = toolError(result);
			if (error) return error;
			return {
				content: [{ type: "text", text: `Completed plan goal: ${normalizeString(params.summary)}` }],
				details: { status: overlay.getState().status, summary: normalizeString(params.summary), evidence: params.evidence ?? [] },
			};
		},
	});

	// ---- commands ----
	pi.registerCommand("plan-new", {
		description: "Initialize or reset .pi/planning and clear any current goal overlay.",
		handler: async (_args, ctx) => {
			archivePlanningWorkspace(ctx.cwd, { includeGoalState: true, includeGoalDesign: true, label: "plan-reset" });
			initializePlanningWorkspace(ctx.cwd);
			const overlay = overlayFor(ctx.cwd);
			applyGoalEffects(overlay.handle({ type: "reset" }), ctx, overlay);
			ctx.ui.notify("Planning workspace reset. Goal overlay cleared.", "info");
		},
	});

	pi.registerCommand("plan-goal-set", {
		description: "Create or continue clarifying a goal overlay without resetting current planning files.",
		handler: async (args, ctx) => {
			const overlay = overlayFor(ctx.cwd);
			notifyRejection(ctx, applyGoalEffects(overlay.handle({ type: "start-drafting", input: args }), ctx, overlay));
		},
	});

	pi.registerCommand("plan-goal-impl", {
		description: "Start or resume implementing the committed goal using planning files as the execution tracker.",
		handler: async (_args, ctx) => {
			const overlay = overlayFor(ctx.cwd);
			notifyRejection(ctx, applyGoalEffects(overlay.handle({ type: "implementation-request" }), ctx, overlay));
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
					customType: "planning-files-runtime-update-context",
					content: [
						"[PLAN UPDATE]",
						"Refresh planning files (task_plan.md, findings.md, progress.md) with current workspace context.",
						"",
						"## Planning File Location (REQUIRED)",
						`All planning files for this project live under ${snapshot.planningRoot}.`,
						"Do NOT create or write task_plan.md, findings.md, or progress.md anywhere else (e.g. repo root or docs/).",
						"Always write/edit using these exact paths:",
						`- ${snapshot.files["task_plan.md"]}`,
						`- ${snapshot.files["findings.md"]}`,
						`- ${snapshot.files["progress.md"]}`,
						"",
						"## Continuity Check",
						"Compare actual progress & findings against what's recorded in planning files:",
						"- Is the last recorded progress in progress.md a continuation of what you're doing now?",
						"- Are the findings and decisions in findings.md still valid in the current context?",
						"- Is task_plan.md's phase/next-action still what you should be working on?",
						"- Are there new findings or progress not yet recorded?",
						"",
						"### If it IS a continuation",
						"Use write/edit to update the planning files at the exact paths above:",
						"- findings.md: append new discoveries",
						"- progress.md: append new progress",
						"- task_plan.md: update phase, next action, blocker, etc.",
						"",
						"### If it is NOT a continuation (progress doesn't align, context changed, old records stale)",
						"Don't write yet. Explain what changed and ask the user:",
						"1. **reset** — Archive current planning files, reinitialize, then write fresh content",
						"2. **write-anyway** — Append current context to planning files despite discontinuity",
						"3. **abort** — Don't write, wait for user decision",
						"",
						"## Current Planning State",
						`Phase: ${snapshot.currentPhase ?? "(missing)"}`,
						`Next action: ${snapshot.nextAction ?? "(missing)"}`,
						`Blocker: ${snapshot.blocker ?? "(none)"}`,
						"",
						"## task_plan.md",
						readText(snapshot.files["task_plan.md"]) || "(missing)",
						"",
						"## findings.md (tail)",
						tailLines(readText(snapshot.files["findings.md"]), 30) || "(missing)",
						"",
						"## progress.md (tail)",
						tailLines(readText(snapshot.files["progress.md"]), 30) || "(missing)",
					].join("\n"),
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});

	// ---- events ----
	pi.on("session_start", async (event, ctx) => {
		const resumed = event.reason === "resume" || event.reason === "fork";
		const overlay = overlayFor(ctx.cwd);
		const result = applyGoalEffects(overlay.handle({ type: "restore" }), ctx, overlay, resumed);
		notifyRejection(ctx, result);
		refresh(ctx, resumed);
		if (!state.exists && overlay.getState().status === "none") return;
		const label = resumed ? "Planning runtime resumed." : `Planning runtime attached to ${state.planningRoot}`;
		ctx.ui.notify(label, "info");
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		refresh(ctx, state.resumedFromPreviousSession);
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnStoppedFor = null;
		const overlay = overlayFor(ctx.cwd);
		overlay.handle({ type: "turn-start" });
	});

	pi.on("tool_call", async (event, ctx) => {
		if (turnStoppedFor) {
			return { block: true, reason: `${turnStoppedFor} already completed in this turn. Stop and summarize instead of calling more tools.` };
		}
		redirectPlanningPath(event as { toolName: string; input: Record<string, unknown> }, ctx.cwd);
		const overlay = overlayFor(ctx.cwd);
		const goalState = overlay.getState();
		if (goalState.status === "drafting") {
			if (event.toolName === "write") {
				const filePath = typeof event.input.path === "string" ? event.input.path : "";
				if (!isInPlanningDir(filePath, ctx.cwd)) {
					return { block: true, reason: "Goal drafting does not allow creating files outside .pi/planning/. Use save_plan_goal_draft / commit_plan_goal." };
				}
			}
			if (event.toolName === "edit") {
				const filePath = typeof event.input.path === "string" ? event.input.path : "";
				if (!isInPlanningDir(filePath, ctx.cwd)) {
					return { block: true, reason: "Goal drafting only allows editing files within .pi/planning/." };
				}
			}
			if (event.toolName === "bash") {
				const command = typeof event.input.command === "string" ? event.input.command : "";
				if (isUnsafeDraftingBash(command)) {
					return { block: true, reason: "Goal drafting bash allows one approved read-only command per call. Do not use &&, ||, ;, |, redirects, backticks, $(), subshells, line continuations, or newline-separated commands. Retry with separate calls such as `pwd`, `rg --files -g '!node_modules' -g '!.git'`, and `git status --short`. Use only the read tool or whitelisted commands; helpers such as sed may be rejected. Use save_plan_goal_draft / commit_plan_goal instead of mutating the workspace." };
				}
			}
		}
		if (isMeaningfulProgressToolCall(event.toolName, event.input as Record<string, unknown>)) {
			overlay.handle({ type: "progress-tool-called" });
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (["write", "edit", ...GOAL_TOOL_NAMES].includes(event.toolName)) refresh(ctx, false);
	});

	pi.on("turn_end", async (event, ctx) => {
		const overlay = overlayFor(ctx.cwd);
		const stopReason = (event.message as { stopReason?: string } | undefined)?.stopReason;
		const result = applyGoalEffects(overlay.handle({ type: "turn-end", stopReason }), ctx, overlay, state.resumedFromPreviousSession);
		notifyRejection(ctx, result);
	});
}
