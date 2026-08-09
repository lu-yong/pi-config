import type {
	CommitGoalParams,
	CompleteGoalParams,
	GoalContract,
	GoalOverlayState,
	PauseGoalParams,
	SaveGoalDraftParams,
} from "./types.ts";
import { defaultGoalDraft, defaultGoalState, readGoalState, writeGoalState } from "./state.ts";
import { goalContractFromDraft, mergeDraft } from "./draft.ts";
import { fileExists, getPaths, normalizeString, normalizeStringArray, nowIso, readText } from "./utils.ts";

export type GoalOverlayEvent =
	| { type: "restore" }
	| { type: "reset" }
	| { type: "start-drafting"; input?: string }
	| { type: "save-draft"; params: SaveGoalDraftParams }
	| { type: "commit"; params: CommitGoalParams }
	| { type: "implementation-request" }
	| { type: "pause"; params: PauseGoalParams }
	| { type: "complete"; params: CompleteGoalParams }
	| { type: "turn-start" }
	| { type: "progress-tool-called" }
	| { type: "turn-end"; stopReason?: string }
	| { type: "continuation-fired"; runId: number };

export type GoalOverlayEffect =
	| { type: "ensure-goal-design" }
	| { type: "archive-implementation-workspace"; label: string }
	| { type: "initialize-implementation-workspace"; goal: GoalContract; runId: number }
	| { type: "ensure-implementation-workspace"; goal: GoalContract; runId: number }
	| { type: "append-progress"; heading: string; message: string }
	| { type: "clear-continuation" }
	| { type: "refresh" }
	| { type: "send-goal-set"; supplementalInput?: string }
	| { type: "send-goal-impl"; mode: "start" | "resume" }
	| { type: "schedule-continuation"; runId: number }
	| { type: "send-continuation"; runId: number }
	| { type: "reject"; operation: string; reason: string };

export interface GoalOverlay {
	handle(event: GoalOverlayEvent): GoalOverlayEffect[];
	getState(): GoalOverlayState;
	rollback(): void;
	/** Operation that stopped the current turn (commit/pause/complete), if any. */
	turnStoppedBy(): string | null;
}

function cloneState(state: GoalOverlayState): GoalOverlayState {
	return JSON.parse(JSON.stringify(state)) as GoalOverlayState;
}

function reject(operation: string, reason: string): GoalOverlayEffect[] {
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
 * Goal lifecycle state machine and its private filesystem persistence.
 *
 * Pi hooks should translate inputs into GoalOverlayEvent values and execute the
 * returned effects. They must not decide whether a transition is legal.
 */
export function createGoalOverlay(cwd: string): GoalOverlay {
	let state = readGoalState(cwd);
	let rollbackState: GoalOverlayState | null = null;
	let progressSeenThisTurn = false;
	// In-memory, never persisted: a queued Continuation and the turn-stop gate
	// must not survive a process restart.
	let queuedRunId: number | null = null;
	let turnStopped: string | null = null;

	const persist = (next: GoalOverlayState): void => {
		rollbackState = cloneState(state);
		state = next;
		writeGoalState(cwd, state);
	};

	const rollback = (): void => {
		if (!rollbackState) return;
		state = rollbackState;
		writeGoalState(cwd, state);
		rollbackState = null;
		queuedRunId = null;
	};

	const mutate = (mutation: (current: GoalOverlayState) => GoalOverlayState): void => {
		persist(mutation(state));
	};

	const handle = (event: GoalOverlayEvent): GoalOverlayEffect[] => {
		rollbackState = null;
		switch (event.type) {
			case "restore":
				state = readGoalState(cwd);
				rollbackState = null;
				progressSeenThisTurn = false;
				queuedRunId = null;
				turnStopped = null;
				return [{ type: "refresh" }];

			case "reset":
				rollbackState = cloneState(state);
				state = defaultGoalState();
				progressSeenThisTurn = false;
				queuedRunId = null;
				writeGoalState(cwd, state);
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
					{ type: "append-progress", heading: "Completion Evidence", message: `${summary}${evidence.length > 0 ? ` | evidence: ${evidence.join("; ")}` : ""}` },
					{ type: "append-progress", heading: "Timeline", message: `Goal implementation completed: ${summary}` },
					{ type: "clear-continuation" },
					{ type: "refresh" },
				];
			}

			case "turn-start":
				progressSeenThisTurn = false;
				turnStopped = null;
				return [];

			case "progress-tool-called":
				if (state.status === "active") progressSeenThisTurn = true;
				return [];

			case "turn-end":
				if (state.status === "active" && event.stopReason === "aborted") {
					const reason = "The goal run was interrupted by the user.";
					mutate((current) => ({ ...current, status: "paused", impl: { ...current.impl, pausedReason: reason } }));
					progressSeenThisTurn = false;
					queuedRunId = null;
					return [
						{ type: "append-progress", heading: "Blockers / Interruptions", message: reason },
						{ type: "append-progress", heading: "Timeline", message: `Goal implementation paused: ${reason}` },
						{ type: "clear-continuation" },
						{ type: "refresh" },
					];
				}
				if (state.status !== "active") {
					progressSeenThisTurn = false;
					queuedRunId = null;
					return [{ type: "clear-continuation" }];
				}
				const shouldContinue = progressSeenThisTurn;
				progressSeenThisTurn = false;
				if (!shouldContinue) {
					queuedRunId = null;
					return [{ type: "clear-continuation" }];
				}
				if (queuedRunId === state.impl.runId) return [{ type: "refresh" }];
				queuedRunId = state.impl.runId;
				return [{ type: "refresh" }, { type: "schedule-continuation", runId: state.impl.runId }];

			case "continuation-fired":
				queuedRunId = null;
				if (state.status !== "active" || !state.goal || state.impl.planningResetRequired || state.impl.runId !== event.runId) return [];
				return [{ type: "send-continuation", runId: event.runId }];
		}
	};

	return {
		handle,
		getState: () => cloneState(state),
		rollback,
		turnStoppedBy: () => turnStopped,
	};
}
