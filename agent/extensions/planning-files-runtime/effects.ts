import type { GoalOverlay, GoalOverlayEffect } from "./goal-overlay.ts";
import {
	CONTINUATION_DELAY_MS,
	MESSAGE_TYPE_CONTINUATION,
	MESSAGE_TYPE_GOAL_IMPL,
	MESSAGE_TYPE_GOAL_SET,
} from "./types.ts";
import { ensureDir, getPaths } from "./utils.ts";
import { archivePlanningWorkspace, createGoalDesignSkeleton, hasPlanningFiles, initializePlanningWorkspace } from "./workspace.ts";
import { buildGoalImplPrompt, buildGoalSetPrompt, getPlanningSnapshot } from "./prompts.ts";
import { appendProgressTimeline } from "./markdown.ts";

/**
 * Executes GoalOverlayEffect lists in order. goal-overlay.ts defines the
 * effect vocabulary and decides transitions; this module is the only place
 * effects touch the filesystem, the timer, or Pi messaging.
 *
 * Pi-facing dependencies (sendMessage, timer, UI refresh) are injected so the
 * executor is testable with fakes; filesystem effects call the workspace and
 * markdown modules directly and are tested against temp directories.
 */

export type AppliedEffects = {
	rejection?: { operation: string; reason: string };
	failure?: { operation: string; reason: string };
};

export type OutgoingGoalMessage = {
	customType: string;
	content: string;
	display: boolean;
};

export type OutgoingGoalMessageOptions = {
	triggerTurn: true;
	deliverAs?: "followUp";
};

export interface ContinuationTimer {
	/** Schedule the single pending continuation callback, replacing any previous one. */
	schedule(callback: () => void, delayMs: number): void;
	/** Cancel the pending callback, if any. */
	clear(): void;
}

export interface GoalEffectExecutorDeps {
	sendMessage(message: OutgoingGoalMessage, options: OutgoingGoalMessageOptions): void;
	timer: ContinuationTimer;
}

export interface ApplyContext {
	cwd: string;
	resumedFromPreviousSession?: boolean;
	refresh(): void;
}

export interface GoalEffectExecutor {
	apply(overlay: GoalOverlay, effects: GoalOverlayEffect[], context: ApplyContext): AppliedEffects;
	/** Operation that stopped the current turn via a stop-turn effect, if any. */
	turnStopped(): string | null;
	/** Reset the stop-turn gate at turn start. */
	resetTurnStopped(): void;
}

/** Default single-slot timer backed by setTimeout. */
export function createSetTimeoutTimer(): ContinuationTimer {
	let handle: ReturnType<typeof setTimeout> | null = null;
	return {
		schedule(callback, delayMs) {
			if (handle) clearTimeout(handle);
			handle = setTimeout(() => {
				handle = null;
				callback();
			}, delayMs);
		},
		clear() {
			if (handle) {
				clearTimeout(handle);
				handle = null;
			}
		},
	};
}

export function createGoalEffectExecutor(deps: GoalEffectExecutorDeps): GoalEffectExecutor {
	let turnStoppedFor: string | null = null;
	let continuationQueuedFor: string | null = null;

	const clearContinuation = (): void => {
		continuationQueuedFor = null;
		deps.timer.clear();
	};

	const queueContinuation = (overlay: GoalOverlay, runId: number, context: ApplyContext): void => {
		const current = overlay.getState();
		if (current.status !== "active" || current.impl.runId !== runId || current.impl.planningResetRequired) return;
		if (continuationQueuedFor === `${runId}`) return;
		clearContinuation();
		continuationQueuedFor = `${runId}`;
		deps.timer.schedule(() => {
			continuationQueuedFor = null;
			apply(overlay, overlay.handle({ type: "continuation-fired", runId }), context);
		}, CONTINUATION_DELAY_MS);
	};

	const apply = (overlay: GoalOverlay, effects: GoalOverlayEffect[], context: ApplyContext): AppliedEffects => {
		let rejection: AppliedEffects["rejection"];
		let failure: AppliedEffects["failure"];
		try {
			for (const effect of effects) {
				switch (effect.type) {
					case "ensure-goal-design":
						ensureDir(getPaths(context.cwd).root);
						createGoalDesignSkeleton(context.cwd);
						break;
					case "archive-implementation-workspace":
						archivePlanningWorkspace(context.cwd, {
							includeGoalState: false,
							includeGoalDesign: false,
							label: effect.label,
						});
						break;
					case "initialize-implementation-workspace":
						initializePlanningWorkspace(context.cwd, effect.goal, effect.runId);
						break;
					case "ensure-implementation-workspace":
						if (!hasPlanningFiles(context.cwd)) initializePlanningWorkspace(context.cwd, effect.goal, effect.runId);
						break;
					case "append-progress":
						appendProgressTimeline(context.cwd, effect.heading, effect.message);
						break;
					case "clear-continuation":
						clearContinuation();
						break;
					case "refresh":
						context.refresh();
						break;
					case "send-goal-set": {
						const snapshot = getPlanningSnapshot(context.cwd, context.resumedFromPreviousSession ?? false);
						deps.sendMessage(
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
						const snapshot = getPlanningSnapshot(context.cwd, context.resumedFromPreviousSession ?? false);
						deps.sendMessage(
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
						queueContinuation(overlay, effect.runId, context);
						break;
					case "send-continuation":
						deps.sendMessage(
							{
								customType: MESSAGE_TYPE_CONTINUATION,
								content: buildGoalImplPrompt(getPlanningSnapshot(context.cwd, context.resumedFromPreviousSession ?? false), "continue"),
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
	};

	return {
		apply,
		turnStopped: () => turnStoppedFor,
		resetTurnStopped: () => {
			turnStoppedFor = null;
		},
	};
}
