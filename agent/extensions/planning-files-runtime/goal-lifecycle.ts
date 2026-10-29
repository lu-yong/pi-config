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
	MESSAGE_TYPE_CONTINUATION,
	MESSAGE_TYPE_GOAL_IMPL,
	MESSAGE_TYPE_GOAL_SET,
} from "./types.ts";
import { defaultGoalDraft, defaultGoalState, readGoalState, readGoalStateForUpdate, writeGoalState } from "./state.ts";
import { mergeDraft } from "./draft.ts";
import { runCompletionAudit, type AuditModelResult, type AuditUsage } from "./audit.ts";
import { ensureDir, fileExists, getPaths, normalizeString, normalizeStringArray, nowIso, readText, tailLines } from "./utils.ts";
import {
	appendProgressTimeline,
	PROGRESS_HEADINGS,
	type ProgressHeading,
	archivePlanningWorkspace,
	createGoalDesignSkeleton,
	finalizeGoalWorkspace,
	getPlanningSnapshot,
	hasPlanningFiles,
	initializePlanningWorkspace,
} from "./workspace.ts";
import { buildGoalImplPrompt, buildGoalSetPrompt } from "./prompts.ts";

/**
 * Goal lifecycle — a single deep module that owns the whole goal lifecycle
 * policy: state transitions (drafting → ready → active/paused/complete),
 * effect execution, the independent completion audit and its
 * adjudication (rejected blocks, unavailable fails open, cancellation keeps
 * the run active), and the Continuation decision for the active
 * implementation run.
 *
 * Pi hooks only express GoalLifecycleEvent values and read the
 * GoalLifecycleResult projection (error/continuation). They never
 * see the internal effect vocabulary. The automatic
 * Continuation is decided at Pi's agent_before_settle boundary and returned
 * as data — Pi schedules the next model request itself, so nothing here races
 * compaction for the idle window. "Goal implementation run" (see CONTEXT.md)
 * denotes the ready → active process identified by runId; this module tracks
 * it but is not named after it.
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

/**
 * Transport for the completion audit: one auditor model call. Production
 * adapts `ctx.modelRegistry.streamSimple` (model selection included); tests
 * adapt canned responses. A transport that cannot reach a model reports
 * `{ kind: "failed" }` — completion then fails open.
 */
export type CompletionAuditCall = (system: string, user: string, signal?: AbortSignal) => Promise<AuditModelResult>;

/** Run result projection: what the caller needs to know after an operation. */
export type GoalLifecycleResult = {
	/** Single error channel: the rejected or failed operation, and why. */
	error?: { operation: string; reason: string };
	/** Settled-run Continuation for Pi's agent_before_settle boundary, when the run should continue. */
	continuation?: { message: OutgoingGoalMessage };
	/** Completion-audit projection: note for the host's success message, plus the auditor's usage for session accounting. Present whenever a completion audit was attempted. */
	audit?: { note: string; usage?: AuditUsage };
};

/** Pi-side capabilities injected per operation; the module stays UI-agnostic. */
export interface GoalLifecycleContext {
	resumedFromPreviousSession?: boolean;
	notify(message: string, level: "warning"): void;
	refresh(): void;
}

export interface GoalLifecycleDeps {
	sendMessage(message: OutgoingGoalMessage, options: OutgoingGoalMessageOptions): void;
}

export type GoalLifecycleEvent =
	| { type: "restore" }
	| { type: "sync" }
	| { type: "reset" }
	| { type: "start-drafting"; input?: string }
	| { type: "save-draft"; params: SaveGoalDraftParams }
	| { type: "commit"; params: CommitGoalParams }
	| { type: "implementation-request"; supplementalInput?: string }
	| { type: "pause"; params: PauseGoalParams }
	| { type: "agent-start" }
	| { type: "turn-start" }
	| { type: "progress-tool-called" }
	| { type: "turn-end"; stopReason?: string; errorMessage?: string; usageTokens?: number }
	| { type: "before-settle"; outcome: "completed" | "aborted" | "error" }
	| { type: "agent-settled"; aborted?: boolean };

export interface GoalLifecycle {
	handle(event: GoalLifecycleEvent, context: GoalLifecycleContext): GoalLifecycleResult;
	/** Complete the active run. The audit is part of completion, not a caller-side precondition. */
	complete(
		params: CompleteGoalParams,
		context: GoalLifecycleContext,
		audit: { modelCall: CompletionAuditCall; signal?: AbortSignal },
	): Promise<GoalLifecycleResult>;
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
	| { type: "append-progress"; heading: ProgressHeading; message: string }
	| { type: "finalize-goal-workspace"; completion: GoalCompletion }
	| { type: "refresh" }
	| { type: "send-goal-set"; supplementalInput?: string }
	| { type: "send-goal-impl"; mode: "start" | "resume"; supplementalInput?: string }
	| { type: "emit-continuation" }
	| { type: "send-continuation"; runId: number; supplementalInput?: string }
	| { type: "notify"; level: "warning"; message: string }
	| { type: "reject"; operation: string; reason: string };

function cloneState(state: GoalOverlayState): GoalOverlayState {
	return JSON.parse(JSON.stringify(state)) as GoalOverlayState;
}

/** Internal events: the public `complete` intent reaches the same transition machinery after its audit. */
type InternalGoalLifecycleEvent = GoalLifecycleEvent | { type: "complete"; params: CompleteGoalParams };

/** Field-wise contract identity: an audit verdict only applies to the goal it judged. */
function sameGoalContract(a: GoalContract, b: GoalContract): boolean {
	return a.objective === b.objective
		&& a.blockerRule === b.blockerRule
		&& a.tokenBudget === b.tokenBudget
		&& JSON.stringify(a.successCriteria) === JSON.stringify(b.successCriteria)
		&& JSON.stringify(a.constraints) === JSON.stringify(b.constraints)
		&& JSON.stringify(a.outOfScope) === JSON.stringify(b.outOfScope);
}

function reject(operation: string, reason: string): GoalLifecycleEffect[] {
	return [{ type: "reject", operation, reason }];
}

function contractFromParams(params: CommitGoalParams): GoalContract | null {
	const objective = normalizeString(params.objective);
	const successCriteria = normalizeStringArray(params.successCriteria);
	const constraints = normalizeStringArray(params.constraints);
	const outOfScope = normalizeStringArray(params.outOfScope);
	const blockerRule = normalizeString(params.blockerRule);
	if (!objective || successCriteria.length === 0 || constraints.length === 0 || outOfScope.length === 0 || !blockerRule) return null;
	const tokenBudget = params.tokenBudget;
	if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) return null;
	return { objective, successCriteria, constraints, outOfScope, blockerRule, ...(tokenBudget !== undefined ? { tokenBudget } : {}) };
}

/**
 * Create the goal lifecycle for one planning workspace (cwd). `deps` are the
 * stable Pi-side capabilities; per-operation context is passed with each event.
 */
export function createGoalLifecycle(cwd: string, deps: GoalLifecycleDeps): GoalLifecycle {
	let state = readGoalState(cwd);
	let progressSeenThisRun = false;
	let terminalStopReason: string | undefined;
	let terminalErrorMessage = "";
	// In-memory, never persisted: the turn-stop gate and the recovery intent
	// must not survive a process restart.
	let turnStopped: string | null = null;
	// A successful terminal tool owns its automatic follow-up turns until the
	// agent run settles, independently of the per-turn tool-stop gate.
	let countClosingRun = false;
	// Set when a lost Continuation's pause recovery could not be persisted:
	// the run stays active (memory and disk agree), and an explicit
	// /plan-goal-impl re-sends the same run's continuation once storage works.
	let recoveryPending = false;

	/** Import disk changes at event boundaries, not just into the widget projection. */
	const syncState = (): void => {
		const next = readGoalStateForUpdate(cwd);
		if (!next) {
			if (state.status !== "none") throw new Error(".goal-state.json disappeared; restore it or use /plan-new before continuing.");
			return;
		}
		if (next.status !== state.status || next.impl.runId !== state.impl.runId
			|| next.impl.planningResetRequired !== state.impl.planningResetRequired) {
			progressSeenThisRun = false;
			terminalStopReason = undefined;
			terminalErrorMessage = "";
			recoveryPending = false;
		}
		// Contract-only edits must not erase progress or the current turn-stop gate.
		state = next;
	};

	/**
	 * Persist before publishing: a goal-state write failure must not leave
	 * memory ahead of disk.
	 */
	const persist = (next: GoalOverlayState): void => {
		state = writeGoalState(cwd, next);
	};

	const mutate = (mutation: (current: GoalOverlayState) => GoalOverlayState): void => {
		persist(mutation(state));
	};

	/**
	 * Pause the active run for a system-detected reason (user interruption,
	 * provider failure, exhausted budget): persist the paused state, then
	 * report through progress, clear any pending continuation, and refresh.
	 * All three pause paths share this one policy.
	 */
	const pauseForSystem = (reason: string, options: { suggestedAction?: string; notify?: string } = {}): GoalLifecycleEffect[] => {
		mutate((current) => ({
			...current,
			status: "paused",
			impl: { ...current.impl, pausedReason: reason, pausedSuggestedAction: options.suggestedAction ?? "" },
		}));
		progressSeenThisRun = false;
		return [
			{ type: "append-progress", heading: PROGRESS_HEADINGS.blockers, message: reason },
			{ type: "append-progress", heading: PROGRESS_HEADINGS.timeline, message: `Goal implementation paused: ${reason}` },
			...(options.notify ? [{ type: "notify", level: "warning", message: options.notify }] as GoalLifecycleEffect[] : []),
			{ type: "refresh" },
		];
	};
	/** Recovery guidance follows the saved status and the operation that failed. */
	const effectFailureGuidance = (effect: GoalLifecycleEffect | undefined): string => {
		if (effect?.type === "finalize-goal-workspace") {
			return "Repair the workspace or storage error, then retry complete_plan_goal; the goal remains active.";
		}
		switch (state.status) {
			case "complete":
				return "The completion is already saved; use /plan-new to archive the workspace and start a new goal.";
			case "active":
				return recoveryPending && !state.impl.planningResetRequired
					? "Retry /plan-goal-impl; it re-sends the continuation."
					: "Pause the run first (pause_plan_goal), then retry /plan-goal-impl; a bare retry is a no-op while the run is active.";
			case "paused":
				return "The pause was saved; resume with /plan-goal-impl.";
			case "drafting":
				return "Retry /plan-goal-set to re-create the goal design and re-send the drafting prompt.";
			case "ready":
				return "The commit was saved; start implementation with /plan-goal-impl.";
			default:
				return "Retry the operation, or use /plan-new to repair the workspace if the failure persists.";
		}
	};

	// ---- state machine: GoalLifecycleEvent -> internal effects ----

	const transition = (event: InternalGoalLifecycleEvent): GoalLifecycleEffect[] => {
		switch (event.type) {
			case "sync":
				return [];

			case "restore":
				state = readGoalStateForUpdate(cwd) ?? defaultGoalState();
				progressSeenThisRun = false;
				terminalStopReason = undefined;
				terminalErrorMessage = "";
				turnStopped = null;
				recoveryPending = false;
				return [{ type: "refresh" }];

			case "reset":
				persist(defaultGoalState());
				progressSeenThisRun = false;
				terminalStopReason = undefined;
				terminalErrorMessage = "";
				recoveryPending = false;
				return [{ type: "refresh" }];

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
						impl: { ...current.impl, planningResetRequired: false, pausedReason: "", pausedSuggestedAction: "", completedSummary: "" },
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
						impl: { ...current.impl, pausedReason: "", pausedSuggestedAction: "", completedSummary: "" },
					}));
				}

				return [
					{ type: "ensure-goal-design" },
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
				const goal = contractFromParams(event.params);
				if (!goal) {
					return reject(
						"commit_plan_goal",
						"Goal commit rejected: objective, successCriteria, constraints, outOfScope, and blockerRule must all be non-empty, and tokenBudget, when present, must be a positive integer.",
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
					impl: { ...current.impl, planningResetRequired: true, pausedReason: "", pausedSuggestedAction: "", completedSummary: "" },
				}));
				turnStopped = "commit_plan_goal";
				countClosingRun = true;
				return [
					{ type: "refresh" },
				];
			}

			case "implementation-request": {
				const supplementalInput = normalizeString(event.supplementalInput) || undefined;
				if (state.status === "active") {
					// A stalled run — its Continuation was lost to a failed
					// delivery and the pause recovery could not be persisted —
					// is recoverable by re-sending the same run's continuation.
					if (recoveryPending && state.goal && !state.impl.planningResetRequired) {
						return [{ type: "send-continuation", runId: state.impl.runId, supplementalInput }];
					}
					if (supplementalInput) {
						return reject("plan-goal-impl", "Goal implementation is already active; this supplemental input was not accepted. Send it as a normal message, or pause the run and retry /plan-goal-impl with the input.");
					}
					return [];
				}
				if (state.status !== "ready" && state.status !== "paused") {
					return reject("plan-goal-impl", "No committed goal is ready to implement. Run /plan-goal-set first.");
				}
				if (!state.goal) return reject("plan-goal-impl", "No committed goal is ready to implement. Run /plan-goal-set first.");
				if (state.status === "ready" || state.impl.planningResetRequired) {
					const runId = state.status === "ready" ? state.impl.runId + 1 : state.impl.runId || 1;
					mutate((current) => ({
						...current,
						status: "active",
						impl: {
							...current.impl,
							runId,
							// Keep the reset pending until both archive and initialization succeed.
							planningResetRequired: true,
							initializedAt: null,
							lastResumedAt: nowIso(),
							pausedReason: "",
							pausedSuggestedAction: "",
						},
					}));
					return [
						{ type: "archive-implementation-workspace", label: `before-goal-run-${runId}` },
						{ type: "initialize-implementation-workspace", goal: state.goal, runId },
						{ type: "append-progress", heading: PROGRESS_HEADINGS.timeline, message: `Goal implementation started (run ${runId})` },
						{ type: "refresh" },
						{ type: "send-goal-impl", mode: "start", supplementalInput },
					];
				}

				const runId = state.impl.runId || 1;
				mutate((current) => ({
					...current,
					status: "active",
					impl: { ...current.impl, runId, planningResetRequired: false, lastResumedAt: nowIso(), pausedReason: "", pausedSuggestedAction: "" },
				}));
				return [
					{ type: "ensure-implementation-workspace", goal: state.goal, runId },
					{ type: "append-progress", heading: PROGRESS_HEADINGS.timeline, message: `Goal implementation resumed (run ${runId})` },
					{ type: "refresh" },
					{ type: "send-goal-impl", mode: "resume", supplementalInput },
				];
			}

			case "pause": {
				if (state.status !== "active") {
					return reject("pause_plan_goal", "pause_plan_goal rejected: no active goal implementation is running.");
				}
				const reason = normalizeString(event.params.reason);
				if (!reason) return reject("pause_plan_goal", "pause_plan_goal rejected: reason is required.");
				const suggestedAction = normalizeString(event.params.suggestedAction);
				mutate((current) => ({
					...current,
					status: "paused",
					impl: { ...current.impl, pausedReason: reason, pausedSuggestedAction: suggestedAction },
				}));
				turnStopped = "pause_plan_goal";
				countClosingRun = true;
				recoveryPending = false;
				return [
					{ type: "append-progress", heading: PROGRESS_HEADINGS.blockers, message: `Goal paused: ${reason}${suggestedAction ? ` | suggested action: ${suggestedAction}` : ""}` },
					{ type: "append-progress", heading: PROGRESS_HEADINGS.timeline, message: `Goal implementation paused: ${reason}` },
					{ type: "refresh" },
				];
			}

			case "complete": {
				if (state.status !== "active") {
					return reject("complete_plan_goal", "complete_plan_goal rejected: only an active goal implementation can be completed.");
				}
				if (state.impl.planningResetRequired) {
					return reject("complete_plan_goal", "Goal workspace initialization is incomplete. Pause the run, then retry /plan-goal-impl before completing it.");
				}
				const summary = normalizeString(event.params.summary);
				if (!summary) return reject("complete_plan_goal", "complete_plan_goal rejected: summary is required.");
				const evidence = normalizeStringArray(event.params.evidence);
				return [
					{ type: "finalize-goal-workspace", completion: { summary, evidence, runId: state.impl.runId } },
				];
			}

			case "agent-start":
				recoveryPending = false;
				return [];

			case "turn-start":
				recoveryPending = false;
				return [];

			case "progress-tool-called":
				if (state.status === "active") progressSeenThisRun = true;
				return [];

			case "turn-end": {
				terminalStopReason = event.stopReason;
				terminalErrorMessage = normalizeString(event.errorMessage);
				// Count this turn's tokens before any stop handling: provider-error
				// responses still consume input tokens, and an aborted turn may have
				// streamed partial output before the user pressed Esc. A terminal
				// tool changes status before turn-end, but its follow-up responses
				// still belong to this goal until the agent run settles.
				const usageTokens = event.usageTokens;
				if ((state.status === "drafting" || state.status === "active" || countClosingRun) && usageTokens !== undefined && usageTokens > 0) {
					mutate((current) => ({ ...current, impl: { ...current.impl, tokensUsed: current.impl.tokensUsed + usageTokens } }));
				}
				if (state.status === "active" && event.stopReason === "aborted") {
					return pauseForSystem("The goal run was interrupted by the user.");
				}
				if (state.status !== "active" || event.stopReason === "error") return [];
				return [{ type: "refresh" }];
			}

			case "before-settle": {
				// The terminal stop reason is authoritative here: an aborted turn
				// already paused at turn-end, so this branch only decides whether
				// a completed run continues.
				if (state.status !== "active" || state.impl.planningResetRequired) {
					progressSeenThisRun = false;
					return [{ type: "refresh" }];
				}
				if (terminalStopReason === "error") {
					const detail = terminalErrorMessage || "unknown provider error";
					return pauseForSystem(`LLM request failed and Pi will not retry automatically: ${detail}`, {
						notify: "Goal implementation paused because the LLM request failed and Pi will not retry automatically. Switch models or retry /plan-goal-impl later.",
					});
				}
				if (!progressSeenThisRun) {
					return [{ type: "refresh" }];
				}
				progressSeenThisRun = false;
				// Budget applies only on the continuation path: a run that already
				// went quiet without progress stays under its existing semantics.
				const tokenBudget = state.goal?.tokenBudget;
				if (tokenBudget !== undefined && state.impl.tokensUsed >= tokenBudget) {
					return pauseForSystem(
						`Token budget exhausted: ${state.impl.tokensUsed} / ${tokenBudget} tokens used over this goal's lifecycle.`,
						{
							suggestedAction: "Use /plan-goal-set to revise and re-commit this goal with a larger tokenBudget, then resume with /plan-goal-impl. Resuming preserves cumulative token usage.",
							notify: "Goal implementation paused: token budget exhausted. Increase the goal's tokenBudget before continuing; /plan-goal-impl preserves cumulative token usage.",
						},
					);
				}
				return [{ type: "refresh" }, { type: "emit-continuation" }];
			}

			case "agent-settled":
				// Notification-only: the continuation decision already happened at
				// before-settle. This is the fallback for a cancellation that arrives
				// during Pi cleanup after a normal final message, when the settled
				// run-level signal is the first reliable place to pause.
				if (state.status !== "active") {
					progressSeenThisRun = false;
					return [{ type: "refresh" }];
				}
				if (event.aborted) return pauseForSystem("The goal run was interrupted by the user.");
				return [{ type: "refresh" }];
		}
	};

	// ---- effect execution ----

	const execute = (effects: GoalLifecycleEffect[], context: GoalLifecycleContext): GoalLifecycleResult => {
		let error: GoalLifecycleResult["error"];
		let continuation: GoalLifecycleResult["continuation"];
		let executingEffect: GoalLifecycleEffect | undefined;
		try {
			for (const effect of effects) {
				executingEffect = effect;
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
						mutate((current) => ({
							...current,
							impl: { ...current.impl, planningResetRequired: false, initializedAt: nowIso() },
						}));
						break;
					case "ensure-implementation-workspace":
						if (!hasPlanningFiles(cwd)) initializePlanningWorkspace(cwd, effect.goal, effect.runId);
						break;
					case "append-progress":
						appendProgressTimeline(cwd, effect.heading, effect.message);
						break;
					case "finalize-goal-workspace":
						finalizeGoalWorkspace(cwd, effect.completion);
						// Finalization is idempotent; only publish completion after it succeeds.
						mutate((current) => ({
							...current,
							status: "complete",
							impl: { ...current.impl, completedSummary: effect.completion.summary, pausedReason: "", pausedSuggestedAction: "" },
						}));
						turnStopped = "complete_plan_goal";
						countClosingRun = true;
						recoveryPending = false;
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
								content: buildGoalImplPrompt(snapshot, effect.mode, effect.supplementalInput),
								display: false,
							},
							{ triggerTurn: true },
						);
						break;
					}
					case "emit-continuation": {
						// The prompt is rebuilt from the planning files on disk at decision
						// time, so the continuation never depends on prior conversation
						// context. Pi commits the entry and performs the next request.
						continuation = {
							message: {
								customType: MESSAGE_TYPE_CONTINUATION,
								content: buildGoalImplPrompt(getPlanningSnapshot(cwd, context.resumedFromPreviousSession ?? false), "continue"),
								display: false,
							},
						};
						break;
					}
					case "send-continuation":
						deps.sendMessage(
							{
								customType: MESSAGE_TYPE_CONTINUATION,
								content: buildGoalImplPrompt(getPlanningSnapshot(cwd, context.resumedFromPreviousSession ?? false), "continue", effect.supplementalInput),
								display: false,
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
						// Consume explicit recovery only after delivery succeeds, so failed retries remain retryable.
						recoveryPending = false;
						break;
					case "notify":
						context.notify(effect.message, effect.level);
						break;
					case "reject":
						error = { operation: effect.operation, reason: effect.reason };
						break;
				}
			}
		} catch (caught) {
			// Preserve completed writes and offer a retry route for the failed effect.
			continuation = undefined;
			const detail = caught instanceof Error ? caught.message : String(caught);
			error = {
				operation: "effect-execution",
				reason: `Goal operation failed: ${detail} Saved changes are preserved (current status: ${state.status}). ${effectFailureGuidance(executingEffect)}`,
			};
		}
		return { error, ...(continuation ? { continuation } : {}) };
	};

	/**
	 * Single guarded path for any event: run the transition, execute its
	 * effects, and turn transition-time failures (e.g. goal-state writes)
	 * into a result instead of an uncaught throw.
	 */
	const runInternal = (event: InternalGoalLifecycleEvent, context: GoalLifecycleContext): GoalLifecycleResult => {
		// The turn boundary is independent of disk health: a new turn must be able
		// to repair a bad state file instead of inheriting the previous stop gate.
		if (event.type === "turn-start") turnStopped = null;
		// End accounting ownership even if a corrupt state file prevents the
		// lifecycle transition. A new run must not inherit stale ownership.
		if (event.type === "agent-start" || event.type === "agent-settled" || event.type === "restore" || event.type === "reset") {
			countClosingRun = false;
		}
		if (event.type !== "restore" && event.type !== "reset") {
			try {
				syncState();
			} catch (error) {
				// Keep an explicit retry route once the file has been repaired.
				if (state.status === "active") recoveryPending = true;
				const detail = error instanceof Error ? error.message : String(error);
				return { error: { operation: "state-sync", reason: `Goal run failed: cannot read current goal state; no state was written. ${detail}` } };
			}
		}
		try {
			return execute(transition(event), context);
		} catch (caught) {
			// A transition-time failure (e.g. the goal-state write) wrote
			// nothing — memory and disk still agree — so a literal retry of
			// the same operation is the correct first route.
			const detail = caught instanceof Error ? caught.message : String(caught);
			return { error: { operation: "effect-execution", reason: `Goal operation failed: ${detail} No state was written; saved changes are preserved (current status: ${state.status}). Retry the operation, or use /plan-new to repair the workspace if the failure persists.` } };
		}
	};

	const handle = (event: GoalLifecycleEvent, context: GoalLifecycleContext): GoalLifecycleResult => runInternal(event, context);

	/**
	 * Completion is one operation here: read the recorded evidence, audit the
	 * claim independently, adjudicate the verdict, then run the completion
	 * transition. The caller supplies only the model transport (and the
	 * tool-call abort signal); it cannot complete without the audit and never
	 * needs to know the ordering.
	 *
	 * Policy: a rejected verdict blocks completion; an unavailable auditor
	 * fails open with a visible note; a user cancellation during the audit
	 * keeps the run active; and a goal/run that changed while the audit was
	 * in flight is never completed on the old verdict. Auditor usage rides on
	 * the result so the host can account for it exactly once.
	 */
	const complete = async (
		params: CompleteGoalParams,
		context: GoalLifecycleContext,
		audit: { modelCall: CompletionAuditCall; signal?: AbortSignal },
	): Promise<GoalLifecycleResult> => {
		// Import disk state first so the audited identity and the transition see
		// the same fresh view; a broken state file is reported by the transition.
		try {
			syncState();
		} catch {
			// runInternal re-runs the guarded sync and reports the failure.
		}
		const summary = normalizeString(params.summary);
		let auditProjection: { note: string; usage?: AuditUsage } | undefined;
		// An invalid request must not spend audit tokens; nor must a run that
		// is not active (the transition rejects both with its standard reasons).
		if (summary && state.status === "active" && state.goal && !state.impl.planningResetRequired) {
			const auditedGoal = state.goal;
			const auditedRunId = state.impl.runId;
			const outcome = await runCompletionAudit(
				{
					goal: auditedGoal,
					summary,
					evidence: normalizeStringArray(params.evidence),
					progressTail: tailLines(readText(getPaths(cwd).files["progress.md"]), 80),
				},
				(system, user) => audit.modelCall(system, user, audit.signal),
			);
			const usage = "usage" in outcome && outcome.usage ? outcome.usage : undefined;
			const auditResult = (reason: string): GoalLifecycleResult => ({
				error: { operation: "complete_plan_goal", reason },
				...(usage ? { audit: { note: "", usage } } : {}),
			});
			// A user cancellation during the audit must not accept the goal: the
			// aborted settlement pauses the still-active run instead.
			if (audit.signal?.aborted) {
				return auditResult("Goal completion cancelled: the audit was aborted before a verdict. The goal stays active.");
			}
			if (outcome.kind === "rejected") {
				return auditResult(
					`Goal completion rejected by independent audit. Unmet or unevidenced criteria: ${outcome.reasons} Close the gaps, record concrete evidence in progress.md, then call complete_plan_goal again; if the criteria are met but cannot be evidenced, call pause_plan_goal and explain.`,
				);
			}
			// A long audit raced the world: re-import disk state and make sure the
			// verdict still describes the goal this transition would complete.
			try {
				syncState();
			} catch {
				// runInternal re-runs the guarded sync and reports the failure.
			}
			if (state.status === "active" && state.goal && (state.impl.runId !== auditedRunId || !sameGoalContract(state.goal, auditedGoal))) {
				return auditResult(
					"Goal completion not applied: the goal or implementation run changed while the audit was in flight. Re-check the current goal and call complete_plan_goal again.",
			);
			}
			auditProjection = {
				note: outcome.kind === "approved" ? " (independent audit: approved)" : ` (independent audit skipped: ${outcome.reason})`,
				...(usage ? { usage } : {}),
			};
		}
		const result = runInternal({ type: "complete", params }, context);
		return auditProjection ? { ...result, audit: auditProjection } : result;
	};

	return {
		handle,
		complete,
		getState: () => cloneState(state),
		turnStoppedBy: () => turnStopped,
	};
}
