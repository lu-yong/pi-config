import type {
	CommitGoalParams,
	CompleteGoalParams,
	GoalCompletion,
	GoalContract,
	GoalOverlayState,
	PauseGoalParams,
	SaveGoalDraftParams,
} from "./types.ts";
import {
	CONTINUATION_DELAY_MS,
	MESSAGE_TYPE_CONTINUATION,
	MESSAGE_TYPE_GOAL_IMPL,
	MESSAGE_TYPE_GOAL_SET,
} from "./types.ts";
import { defaultGoalDraft, defaultGoalState, readGoalState, writeGoalState } from "./state.ts";
import { goalContractFromDraft, mergeDraft } from "./draft.ts";
import { ensureDir, fileExists, getPaths, normalizeString, normalizeStringArray, nowIso, readText } from "./utils.ts";
import {
	archivePlanningWorkspace,
	createGoalDesignSkeleton,
	finalizeGoalWorkspace,
	hasPlanningFiles,
	initializePlanningWorkspace,
} from "./workspace.ts";
import { buildGoalImplPrompt, buildGoalSetPrompt, getPlanningSnapshot } from "./prompts.ts";
import { appendProgressTimeline } from "./markdown.ts";

/**
 * Goal lifecycle — a single deep module that owns the whole goal lifecycle
 * policy: state transitions (drafting → ready → active/paused/complete),
 * effect execution and rollback, and Continuation scheduling for the active
 * implementation run.
 *
 * Pi hooks only express GoalLifecycleEvent values and read the
 * GoalLifecycleResult projection (rejection/failure). They never see the
 * internal effect vocabulary, the rollback protocol, or the Continuation
 * timer callback. "Goal implementation run" (see CONTEXT.md) denotes the
 * ready → active process identified by runId; this module schedules and
 * tracks it but is not named after it.
 */

// ---- public vocabulary (the only surface Pi hooks and tests use) ----

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

/** Run result projection: what the caller needs to know after an operation. */
export type GoalLifecycleResult = {
	rejection?: { operation: string; reason: string };
	failure?: { operation: string; reason: string };
};

/** Pi-side capabilities injected per operation; the module stays UI-agnostic. */
export interface GoalLifecycleContext {
	resumedFromPreviousSession?: boolean;
	isIdle(): boolean;
	notify(message: string, level: "warning"): void;
	refresh(): void;
}

export interface GoalLifecycleDeps {
	sendMessage(message: OutgoingGoalMessage, options: OutgoingGoalMessageOptions): void;
	timer: ContinuationTimer;
}

export type GoalLifecycleEvent =
	| { type: "restore" }
	| { type: "reset" }
	| { type: "start-drafting"; input?: string }
	| { type: "save-draft"; params: SaveGoalDraftParams }
	| { type: "commit"; params: CommitGoalParams }
	| { type: "implementation-request" }
	| { type: "pause"; params: PauseGoalParams }
	| { type: "complete"; params: CompleteGoalParams }
	| { type: "agent-start" }
	| { type: "turn-start" }
	| { type: "progress-tool-called" }
	| { type: "turn-end"; stopReason?: string; errorMessage?: string }
	| { type: "agent-settled" };

export interface GoalLifecycle {
	handle(event: GoalLifecycleEvent, context: GoalLifecycleContext): GoalLifecycleResult;
	getState(): GoalOverlayState;
	/** Operation that stopped the current turn (commit/pause/complete), if any. */
	turnStoppedBy(): string | null;
}

// ---- internal effect vocabulary (never leaves this module) ----

type GoalLifecycleEffect =
	| { type: "ensure-goal-design" }
	| { type: "archive-implementation-workspace"; label: string }
	| { type: "initialize-implementation-workspace"; goal: GoalContract; runId: number }
	| { type: "ensure-implementation-workspace"; goal: GoalContract; runId: number }
	| { type: "append-progress"; heading: string; message: string }
	| { type: "clear-continuation" }
	| { type: "finalize-goal-workspace"; completion: GoalCompletion }
	| { type: "refresh" }
	| { type: "send-goal-set"; supplementalInput?: string }
	| { type: "send-goal-impl"; mode: "start" | "resume" }
	| { type: "schedule-continuation"; runId: number }
	| { type: "send-continuation"; runId: number }
	| { type: "notify"; level: "warning"; message: string }
	| { type: "reject"; operation: string; reason: string };

/** GoalLifecycleEvent plus the Continuation timer's internal round-trip events. */
type InternalEvent =
	| GoalLifecycleEvent
	| { type: "continuation-discarded"; runId: number }
	| { type: "continuation-fired"; runId: number }
	| { type: "continuation-failed"; runId: number; detail: string }
	| { type: "continuation-diagnostics"; runId: number };
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

function cloneState(state: GoalOverlayState): GoalOverlayState {
	return JSON.parse(JSON.stringify(state)) as GoalOverlayState;
}

function reject(operation: string, reason: string): GoalLifecycleEffect[] {
	return [{ type: "reject", operation, reason }];
}

function isCompleteDraft(state: GoalOverlayState): boolean {
	return goalContractFromDraft(state.draft) !== null;
}

function contractFromParams(params: CommitGoalParams): GoalContract | null {
	const objective = normalizeString(params.objective);
	const successCriteria = normalizeStringArray(params.successCriteria);
	const constraints = normalizeStringArray(params.constraints);
	const outOfScope = normalizeStringArray(params.outOfScope);
	const blockerRule = normalizeString(params.blockerRule);
	if (!objective || successCriteria.length === 0 || constraints.length === 0 || outOfScope.length === 0 || !blockerRule) return null;
	return { objective, successCriteria, constraints, outOfScope, blockerRule };
}

/**
 * Outcome of a rollback attempt: whether a prior state was actually restored
 * (or nothing had been published), and whether restoring it could itself be
 * persisted — a rollback write failure leaves disk validity unknown.
 */
type RollbackOutcome = { restored: boolean; error: string | null };

/**
 * Compose the user-facing failure reason. The message only claims a clean
 * restoration when a rollback write actually succeeded; when nothing was
 * ever published it says the prior state is preserved instead.
 */
function buildFailureReason(message: string, outcome: RollbackOutcome): string {
	if (outcome.error) {
		return `Goal run failed and the prior state could not be persisted; state may be inconsistent. Retry the operation. ${message} Rollback write error: ${outcome.error}`;
	}
	if (outcome.restored) {
		return `Goal run failed; state restored. Retry the operation. ${message}`;
	}
	// Nothing was ever published: the prior state is preserved in memory and on disk.
	return `Goal run failed; state preserved. Retry the operation. ${message}`;
}

/**
 * Create the goal lifecycle for one planning workspace (cwd). `deps` are the
 * stable Pi-side capabilities; per-operation context is passed with each event.
 */
export function createGoalLifecycle(cwd: string, deps: GoalLifecycleDeps): GoalLifecycle {
	let state = readGoalState(cwd);
	let rollbackState: GoalOverlayState | null = null;
	let progressSeenThisRun = false;
	let terminalStopReason: string | undefined;
	let terminalErrorMessage = "";
	// In-memory, never persisted: a queued Continuation and the turn-stop gate
	// must not survive a process restart.
	let queuedRunId: number | null = null;
	let turnStopped: string | null = null;

	/**
	 * Persist before publishing: a goal-state write failure must not leave
	 * memory ahead of disk, and must not install a rollback target for a
	 * state that never landed.
	 */
	const persist = (next: GoalOverlayState): void => {
		const previous = state;
		writeGoalState(cwd, next);
		rollbackState = cloneState(previous);
		state = next;
	};

	/**
	 * Restore the pre-mutation state, persisting it back. `restored` is false
	 * only when nothing was ever published (so there is nothing to restore);
	 * `error` is set when the rollback write itself failed.
	 */
	const rollback = (): RollbackOutcome => {
		if (!rollbackState) return { restored: false, error: null };
		const target = rollbackState;
		rollbackState = null;
		let writeError: unknown = null;
		try {
			writeGoalState(cwd, target);
		} catch (error) {
			writeError = error;
		}
		state = target;
		progressSeenThisRun = false;
		terminalStopReason = undefined;
		terminalErrorMessage = "";
		queuedRunId = null;
		turnStopped = null;
		if (writeError) return { restored: true, error: writeError instanceof Error ? writeError.message : String(writeError) };
		return { restored: true, error: null };
	};

	const mutate = (mutation: (current: GoalOverlayState) => GoalOverlayState): void => {
		persist(mutation(state));
	};

	// ---- state machine: GoalLifecycleEvent -> internal effects ----

	const transition = (event: InternalEvent): GoalLifecycleEffect[] => {
		rollbackState = null;
		switch (event.type) {
			case "restore":
				state = readGoalState(cwd);
				rollbackState = null;
				progressSeenThisRun = false;
				terminalStopReason = undefined;
				terminalErrorMessage = "";
				queuedRunId = null;
				turnStopped = null;
				return [{ type: "refresh" }];

			case "reset":
				persist(defaultGoalState());
				progressSeenThisRun = false;
				terminalStopReason = undefined;
				terminalErrorMessage = "";
				queuedRunId = null;
				return [{ type: "clear-continuation" }, { type: "refresh" }];

			case "start-drafting": {
				const input = normalizeString(event.input);
				if (state.status === "none" && !input) {
					return reject("plan-goal-set", "Provide a topic: /plan-goal-set <goal topic>");
				}

				if (state.status === "none") {
					mutate((current) => ({
						...current,
						status: "drafting",
						draft: { ...defaultGoalDraft(), sourceTopic: input, supplementalInputs: [input] },
						impl: { ...current.impl, planningResetRequired: false, pausedReason: "", completedSummary: "" },
					}));
				} else if (state.status === "drafting") {
					mutate((current) => ({
						...current,
						status: "drafting",
						draft: {
							...current.draft,
							supplementalInputs: input
								? [...current.draft.supplementalInputs, input].slice(-20)
								: current.draft.supplementalInputs,
						},
					}));
				} else {
					const goal = state.goal;
					mutate((current) => ({
						...current,
						status: "drafting",
						draft: {
							sourceTopic: input || goal?.objective || current.draft.sourceTopic,
							supplementalInputs: input ? [...current.draft.supplementalInputs, input].slice(-20) : current.draft.supplementalInputs,
							clarificationSummary: current.draft.clarificationSummary,
							objective: goal?.objective || current.draft.objective,
							successCriteria: goal?.successCriteria || current.draft.successCriteria,
							constraints: goal?.constraints || current.draft.constraints,
							outOfScope: goal?.outOfScope || current.draft.outOfScope,
							blockerRule: goal?.blockerRule || current.draft.blockerRule,
							openQuestions: current.draft.openQuestions,
							nextRecommendedQuestion: current.draft.nextRecommendedQuestion,
							draftingStage: "as-is",
						},
					}));
				}

				queuedRunId = null;
				return [
					{ type: "ensure-goal-design" },
					{ type: "clear-continuation" },
					{ type: "refresh" },
					{ type: "send-goal-set", ...(input ? { supplementalInput: input } : {}) },
				];
			}

			case "save-draft":
				if (state.status !== "drafting") {
					return reject("save_plan_goal_draft", "save_plan_goal_draft rejected: goal drafting is not in progress.");
				}
				mutate((current) => ({ ...current, status: "drafting", draft: mergeDraft(current.draft, event.params) }));
				return [{ type: "refresh" }];

			case "commit": {
				if (state.status !== "drafting") {
					return reject("commit_plan_goal", "commit_plan_goal rejected: goal drafting is not in progress.");
				}
				if (!isCompleteDraft(state)) {
					return reject(
						"commit_plan_goal",
						"Goal commit rejected: the saved goal draft must contain non-empty objective, successCriteria, constraints, outOfScope, and blockerRule.",
					);
				}
				const goal = contractFromParams(event.params);
				if (!goal) {
					return reject(
						"commit_plan_goal",
						"Goal commit rejected: objective, successCriteria, constraints, outOfScope, and blockerRule must all be non-empty.",
					);
				}
				const goalDesign = getPaths(cwd).goalDesign;
				if (!fileExists(goalDesign) || readText(goalDesign).trim().length === 0) {
					return reject(
						"commit_plan_goal",
						"Goal commit rejected: goal-design.md must exist and be non-empty. Complete the 4 drafting stages first.",
					);
				}
				mutate((current) => ({
					...current,
					status: "ready",
					goal,
					draft: {
						...current.draft,
						...goal,
						openQuestions: [],
						nextRecommendedQuestion: "",
						draftingStage: "as-is",
					},
					impl: { ...current.impl, planningResetRequired: true, pausedReason: "", completedSummary: "" },
				}));
				turnStopped = "commit_plan_goal";
				queuedRunId = null;
				return [
					{ type: "clear-continuation" },
					{ type: "refresh" },
				];
			}

			case "implementation-request":
				if (state.status === "active") return [];
				if (state.status !== "ready" && state.status !== "paused") {
					return reject("plan-goal-impl", "No committed goal is ready to implement. Run /plan-goal-set first.");
				}
				if (!state.goal) return reject("plan-goal-impl", "No committed goal is ready to implement. Run /plan-goal-set first.");
				if (state.status === "ready") {
					const runId = state.impl.runId + 1;
					mutate((current) => ({
						...current,
						status: "active",
						impl: {
							...current.impl,
							runId,
							planningResetRequired: false,
							initializedAt: nowIso(),
							lastResumedAt: nowIso(),
							pausedReason: "",
						},
					}));
					queuedRunId = null;
					return [
						{ type: "archive-implementation-workspace", label: `before-goal-run-${runId}` },
						{ type: "initialize-implementation-workspace", goal: state.goal, runId },
						{ type: "append-progress", heading: "Timeline", message: `Goal implementation started (run ${runId})` },
						{ type: "clear-continuation" },
						{ type: "refresh" },
						{ type: "send-goal-impl", mode: "start" },
					];
				}

				const runId = state.impl.runId || 1;
				mutate((current) => ({
					...current,
					status: "active",
					impl: { ...current.impl, runId, planningResetRequired: false, lastResumedAt: nowIso(), pausedReason: "" },
				}));
				queuedRunId = null;
				return [
					{ type: "ensure-implementation-workspace", goal: state.goal, runId },
					{ type: "append-progress", heading: "Timeline", message: `Goal implementation resumed (run ${runId})` },
					{ type: "clear-continuation" },
					{ type: "refresh" },
					{ type: "send-goal-impl", mode: "resume" },
				];

			case "pause": {
				if (state.status !== "active") {
					return reject("pause_plan_goal", "pause_plan_goal rejected: no active goal implementation is running.");
				}
				const reason = normalizeString(event.params.reason);
				if (!reason) return reject("pause_plan_goal", "pause_plan_goal rejected: reason is required.");
				const suggestedAction = normalizeString(event.params.suggestedAction);
				mutate((current) => ({ ...current, status: "paused", impl: { ...current.impl, pausedReason: reason } }));
				turnStopped = "pause_plan_goal";
				queuedRunId = null;
				return [
					{ type: "append-progress", heading: "Blockers / Interruptions", message: `Goal paused: ${reason}${suggestedAction ? ` | suggested action: ${suggestedAction}` : ""}` },
					{ type: "append-progress", heading: "Timeline", message: `Goal implementation paused: ${reason}` },
					{ type: "clear-continuation" },
					{ type: "refresh" },
				];
			}

			case "complete": {
				if (state.status !== "active") {
					return reject("complete_plan_goal", "complete_plan_goal rejected: only an active goal implementation can be completed.");
				}
				const summary = normalizeString(event.params.summary);
				if (!summary) return reject("complete_plan_goal", "complete_plan_goal rejected: summary is required.");
				const evidence = normalizeStringArray(event.params.evidence);
				mutate((current) => ({ ...current, status: "complete", impl: { ...current.impl, completedSummary: summary, pausedReason: "" } }));
				turnStopped = "complete_plan_goal";
				queuedRunId = null;
				return [
					{ type: "clear-continuation" },
					{ type: "finalize-goal-workspace", completion: { summary, evidence, runId: state.impl.runId } },
				];
			}

			case "agent-start":
				queuedRunId = null;
				return [{ type: "clear-continuation" }];

			case "turn-start":
				turnStopped = null;
				return [];

			case "progress-tool-called":
				if (state.status === "active") progressSeenThisRun = true;
				return [];

			case "turn-end":
				terminalStopReason = event.stopReason;
				terminalErrorMessage = normalizeString(event.errorMessage);
				if (state.status === "active" && event.stopReason === "aborted") {
					const reason = "The goal run was interrupted by the user.";
					mutate((current) => ({ ...current, status: "paused", impl: { ...current.impl, pausedReason: reason } }));
					progressSeenThisRun = false;
					queuedRunId = null;
					return [
						{ type: "append-progress", heading: "Blockers / Interruptions", message: reason },
						{ type: "append-progress", heading: "Timeline", message: `Goal implementation paused: ${reason}` },
						{ type: "clear-continuation" },
						{ type: "refresh" },
					];
				}
				if (state.status !== "active" || event.stopReason === "error") return [{ type: "clear-continuation" }];
				return [{ type: "refresh" }];

			case "agent-settled":
				// The planning projection is always re-synced after the agent run settles.
				if (state.status !== "active") {
					progressSeenThisRun = false;
					queuedRunId = null;
					return [{ type: "clear-continuation" }, { type: "refresh" }];
				}
				if (terminalStopReason === "error") {
					const detail = terminalErrorMessage || "unknown provider error";
					const reason = `LLM request failed and Pi will not retry automatically: ${detail}`;
					mutate((current) => ({ ...current, status: "paused", impl: { ...current.impl, pausedReason: reason } }));
					progressSeenThisRun = false;
					queuedRunId = null;
					return [
						{ type: "append-progress", heading: "Blockers / Interruptions", message: reason },
						{ type: "append-progress", heading: "Timeline", message: `Goal implementation paused: ${reason}` },
						{ type: "clear-continuation" },
						{ type: "notify", level: "warning", message: "Goal implementation paused because the LLM request failed and Pi will not retry automatically. Switch models or retry /plan-goal-impl later." },
						{ type: "refresh" },
					];
				}
				if (!progressSeenThisRun) {
					queuedRunId = null;
					return [{ type: "clear-continuation" }, { type: "refresh" }];
				}
				progressSeenThisRun = false;
				if (queuedRunId === state.impl.runId) return [{ type: "refresh" }];
				queuedRunId = state.impl.runId;
				return [{ type: "refresh" }, { type: "schedule-continuation", runId: state.impl.runId }];

			case "continuation-discarded":
				if (queuedRunId === event.runId) queuedRunId = null;
				return [];

			case "continuation-fired":
				if (queuedRunId !== event.runId) return [];
				queuedRunId = null;
				if (state.status !== "active" || !state.goal || state.impl.planningResetRequired || state.impl.runId !== event.runId) return [];
				return [{ type: "send-continuation", runId: event.runId }];

			case "continuation-failed": {
				// Recovery commit point: persist the deterministic paused
				// state. No effects here — the progress/UI diagnostics are a
				// separate best-effort step that must never roll this back.
				if (state.status !== "active" || !state.goal || state.impl.runId !== event.runId) return [];
				const reason = `Continuation delivery failed and Pi will not retry automatically: ${event.detail}`;
				mutate((current) => ({ ...current, status: "paused", impl: { ...current.impl, pausedReason: reason } }));
				progressSeenThisRun = false;
				queuedRunId = null;
				return [];
			}

			case "continuation-diagnostics":
				if (state.status !== "paused" || state.impl.runId !== event.runId) return [];
				return [
					{ type: "append-progress", heading: "Blockers / Interruptions", message: state.impl.pausedReason },
					{ type: "append-progress", heading: "Timeline", message: `Goal implementation paused: ${state.impl.pausedReason}` },
					{ type: "clear-continuation" },
					{ type: "notify", level: "warning", message: "Goal implementation paused because the continuation could not be delivered. Retry /plan-goal-impl later." },
					{ type: "refresh" },
				];
		}
	};

	// ---- effect execution and rollback ----

	const execute = (effects: GoalLifecycleEffect[], context: GoalLifecycleContext): GoalLifecycleResult => {
		let rejection: GoalLifecycleResult["rejection"];
		let failure: GoalLifecycleResult["failure"];
		try {
			for (const effect of effects) {
				switch (effect.type) {
					case "ensure-goal-design":
						ensureDir(getPaths(cwd).root);
						createGoalDesignSkeleton(cwd);
						break;
					case "archive-implementation-workspace":
						archivePlanningWorkspace(cwd, {
							includeGoalState: false,
							includeGoalDesign: false,
							label: effect.label,
						});
						break;
					case "initialize-implementation-workspace":
						initializePlanningWorkspace(cwd, effect.goal, effect.runId);
						break;
					case "ensure-implementation-workspace":
						if (!hasPlanningFiles(cwd)) initializePlanningWorkspace(cwd, effect.goal, effect.runId);
						break;
					case "append-progress":
						appendProgressTimeline(cwd, effect.heading, effect.message);
						break;
					case "finalize-goal-workspace":
						finalizeGoalWorkspace(cwd, effect.completion);
						break;
					case "clear-continuation":
						deps.timer.clear();
						break;
					case "refresh":
						context.refresh();
						break;
					case "send-goal-set": {
						const snapshot = getPlanningSnapshot(cwd, context.resumedFromPreviousSession ?? false);
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
						const snapshot = getPlanningSnapshot(cwd, context.resumedFromPreviousSession ?? false);
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
					case "schedule-continuation": {
						const runId = effect.runId;
						deps.timer.schedule(() => {
							let idle = false;
							try {
								idle = context.isIdle();
							} catch {
								// A stale extension context is never safe for enqueueing a follow-up.
							}
							if (!idle) {
								transition({ type: "continuation-discarded", runId });
								return;
							}
							const result = runInternal({ type: "continuation-fired", runId }, context);
							if (result.failure) {
								// The follow-up could not be delivered. Commit the
								// deterministic paused state first; the progress/UI
								// diagnostics run separately (best-effort, no state
								// mutation) so a logging or notification failure can
								// never roll the committed pause back to active.
								const committed = runInternal({ type: "continuation-failed", runId, detail: result.failure.reason }, context);
								if (committed.failure) {
									// Even the pause could not be persisted; leave a
									// visible trace instead of a silent dead run.
									execute(
										[{ type: "notify", level: "warning", message: "Goal implementation stalled: the continuation could not be delivered and its recovery state could not be saved. Check storage and retry /plan-goal-impl." }],
										context,
									);
									return;
								}
								runInternal({ type: "continuation-diagnostics", runId }, context);
							}
						}, CONTINUATION_DELAY_MS);
						break;
					}
					case "send-continuation":
						deps.sendMessage(
							{
								customType: MESSAGE_TYPE_CONTINUATION,
								content: buildGoalImplPrompt(getPlanningSnapshot(cwd, context.resumedFromPreviousSession ?? false), "continue"),
								display: false,
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
						break;
					case "notify":
						context.notify(effect.message, effect.level);
						break;
					case "reject":
						rejection = { operation: effect.operation, reason: effect.reason };
						break;
				}
			}
		} catch (error) {
			const outcome = rollback();
			deps.timer.clear();
			const message = error instanceof Error ? error.message : String(error);
			failure = { operation: "effect-execution", reason: buildFailureReason(message, outcome) };
		}
		return { rejection, failure };
	};

	/**
	 * Single guarded path for any event (public or timer-internal): run the
	 * transition, execute its effects, and turn transition-time failures
	 * (e.g. goal-state writes) into a result instead of an uncaught throw.
	 */
	const runInternal = (event: InternalEvent, context: GoalLifecycleContext): GoalLifecycleResult => {
		try {
			return execute(transition(event), context);
		} catch (error) {
			const outcome = rollback();
			deps.timer.clear();
			const message = error instanceof Error ? error.message : String(error);
			return { failure: { operation: "effect-execution", reason: buildFailureReason(message, outcome) } };
		}
	};

	const handle = (event: GoalLifecycleEvent, context: GoalLifecycleContext): GoalLifecycleResult => runInternal(event, context);

	return {
		handle,
		getState: () => cloneState(state),
		turnStoppedBy: () => turnStopped,
	};
}
