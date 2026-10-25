import fs from "node:fs";
import type { DraftingStage, GoalContract, GoalDraft, GoalOverlayState, GoalOverlayStatus } from "./types.ts";
import { fileExists, getPaths, normalizeString, normalizeStringArray, nowIso, readText, writeTextAtomic } from "./utils.ts";

// ---- defaults ----

export function defaultGoalDraft(): GoalDraft {
	return {
		sourceTopic: "",
		supplementalInputs: [],
		clarificationSummary: [],
		objective: "",
		successCriteria: [],
		constraints: [],
		outOfScope: [],
		blockerRule: "",
		openQuestions: [],
		nextRecommendedQuestion: "",
		draftingStage: "as-is",
	};
}

export function defaultGoalState(): GoalOverlayState {
	return {
		version: 1,
		status: "none",
		updatedAt: nowIso(),
		draft: defaultGoalDraft(),
		goal: null,
		impl: {
			runId: 0,
			tokensUsed: 0,
			planningResetRequired: false,
			initializedAt: null,
			lastResumedAt: null,
			pausedReason: "",
			pausedSuggestedAction: "",
			completedSummary: "",
		},
	};
}

// ---- normalisation ----

export function normalizeGoalDraft(value: unknown): GoalDraft {
	const raw = (value ?? {}) as Record<string, unknown>;
	const stage = normalizeString(raw.draftingStage);
	const validStages: DraftingStage[] = ["as-is", "design", "story", "task"];
	return {
		sourceTopic: normalizeString(raw.sourceTopic),
		supplementalInputs: normalizeStringArray(raw.supplementalInputs),
		clarificationSummary: normalizeStringArray(raw.clarificationSummary),
		objective: normalizeString(raw.objective),
		successCriteria: normalizeStringArray(raw.successCriteria),
		constraints: normalizeStringArray(raw.constraints),
		outOfScope: normalizeStringArray(raw.outOfScope),
		blockerRule: normalizeString(raw.blockerRule),
		openQuestions: normalizeStringArray(raw.openQuestions),
		nextRecommendedQuestion: normalizeString(raw.nextRecommendedQuestion),
		draftingStage: (validStages as string[]).includes(stage) ? (stage as DraftingStage) : "as-is",
	};
}

export function normalizeGoalContract(value: unknown): GoalContract | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const objective = normalizeString(raw.objective);
	const successCriteria = normalizeStringArray(raw.successCriteria);
	const constraints = normalizeStringArray(raw.constraints);
	const outOfScope = normalizeStringArray(raw.outOfScope);
	const blockerRule = normalizeString(raw.blockerRule);
	if (!objective) return null;
	const budgetRaw = raw.tokenBudget;
	const tokenBudget = typeof budgetRaw === "number" && Number.isSafeInteger(budgetRaw) && budgetRaw > 0 ? budgetRaw : undefined;
	return {
		objective,
		successCriteria,
		constraints,
		outOfScope,
		blockerRule,
		tokenBudget,
	};
}

export function normalizeGoalState(value: unknown): GoalOverlayState {
	if (!value || typeof value !== "object") return defaultGoalState();
	const raw = value as Record<string, unknown>;
	const status = normalizeString(raw.status);
	const goal = normalizeGoalContract(raw.goal);
	const implRaw = (raw.impl ?? {}) as Record<string, unknown>;
	const normalizedStatus = ["none", "drafting", "ready", "active", "paused", "complete"].includes(status)
		? (status as GoalOverlayStatus)
		: goal
			? "ready"
			: "none";
	return {
		version: 1,
		status: normalizedStatus,
		updatedAt: normalizeString(raw.updatedAt) || nowIso(),
		draft: normalizeGoalDraft(raw.draft),
		goal,
		impl: {
			runId: typeof implRaw.runId === "number" && Number.isFinite(implRaw.runId) ? Math.max(0, Math.trunc(implRaw.runId)) : 0,
			tokensUsed:
				typeof implRaw.tokensUsed === "number" && Number.isFinite(implRaw.tokensUsed) && implRaw.tokensUsed >= 0
					? Math.trunc(implRaw.tokensUsed)
					: 0,
			planningResetRequired: implRaw.planningResetRequired === true,
			initializedAt: normalizeString(implRaw.initializedAt) || null,
			lastResumedAt: normalizeString(implRaw.lastResumedAt) || null,
			pausedReason: normalizeString(implRaw.pausedReason),
			pausedSuggestedAction: normalizeString(implRaw.pausedSuggestedAction),
			completedSummary: normalizeString(implRaw.completedSummary),
		},
	};
}

// ---- I/O ----

/** Read for lifecycle decisions: never turn corrupt/unreadable state into an empty goal. */
export function readGoalStateForUpdate(cwd: string): GoalOverlayState | null {
	const target = getPaths(cwd).goalState;
	let text: string;
	try {
		text = fs.readFileSync(target, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const raw = JSON.parse(text);
	const normalized = normalizeGoalState(raw);
	if (raw === null || typeof raw !== "object"
		|| normalized.status !== raw.status
		|| (raw.goal != null && normalized.goal === null)) {
		throw new Error(`Invalid goal state in ${target}; repair the file before continuing.`);
	}
	return normalized;
}

export function readGoalState(cwd: string): GoalOverlayState {
	const target = getPaths(cwd).goalState;
	if (!fileExists(target)) return defaultGoalState();
	try {
		return normalizeGoalState(JSON.parse(readText(target)));
	} catch {
		return defaultGoalState();
	}
}

/** Stable read-only query for extensions that must yield control to an active goal run. */
export function hasActiveGoal(cwd: string): boolean {
	return readGoalState(cwd).status === "active";
}

export function writeGoalState(cwd: string, state: GoalOverlayState): GoalOverlayState {
	const target = getPaths(cwd).goalState;
	const next: GoalOverlayState = {
		...state,
		updatedAt: nowIso(),
	};
	// Atomic replacement: a failed write must never truncate or corrupt the
	// persisted goal state (memory and disk must agree on the prior state).
	writeTextAtomic(target, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}
