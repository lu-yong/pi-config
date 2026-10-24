import type { DraftingStage, GoalDraft, SaveGoalDraftParams } from "./types.ts";
import { normalizeString, normalizeStringArray } from "./utils.ts";

/**
 * Merge tool params into an existing draft, preserving unchanged fields.
 */
export function mergeDraft(current: GoalDraft, params: SaveGoalDraftParams): GoalDraft {
	const validStages: DraftingStage[] = ["as-is", "design", "story", "task"];
	const nextStage = params.draftingStage !== undefined
		? (normalizeString(params.draftingStage) as DraftingStage)
		: undefined;
	const next: GoalDraft = {
		...current,
		sourceTopic: params.sourceTopic !== undefined ? normalizeString(params.sourceTopic) : current.sourceTopic,
		objective: params.objective !== undefined ? normalizeString(params.objective) : current.objective,
		blockerRule: params.blockerRule !== undefined ? normalizeString(params.blockerRule) : current.blockerRule,
		nextRecommendedQuestion: params.nextRecommendedQuestion !== undefined
			? normalizeString(params.nextRecommendedQuestion)
			: current.nextRecommendedQuestion,
		supplementalInputs: current.supplementalInputs,
		clarificationSummary: params.clarificationSummary !== undefined
			? normalizeStringArray(params.clarificationSummary)
			: current.clarificationSummary,
		successCriteria: params.successCriteria !== undefined ? normalizeStringArray(params.successCriteria) : current.successCriteria,
		constraints: params.constraints !== undefined ? normalizeStringArray(params.constraints) : current.constraints,
		outOfScope: params.outOfScope !== undefined ? normalizeStringArray(params.outOfScope) : current.outOfScope,
		openQuestions: params.openQuestions !== undefined ? normalizeStringArray(params.openQuestions) : current.openQuestions,
		draftingStage: nextStage && (validStages as string[]).includes(nextStage) ? nextStage : current.draftingStage,
	};
	return next;
}
