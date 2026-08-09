import type { PlanningSnapshot } from "./types.ts";

/**
 * Build widget lines displayed above the editor.
 */
export function buildWidgetLines(state: PlanningSnapshot): string[] | undefined {
	if (!state.exists && state.goalState.status === "none") return undefined;
	const lines: string[] = [];
	lines.push(`dir: ${state.planningRoot}`);
	lines.push(`planning: ${state.exists ? "initialized" : "not initialized"}`);
	if (state.goalState.status !== "none") {
		lines.push(`goal: ${state.goalState.status}`);
		if (state.goalState.status === "drafting") lines.push(`stage: ${state.goalState.draft.draftingStage}`);
		if (state.goalState.goal?.objective) lines.push(`objective: ${state.goalState.goal.objective}`);
		if (state.goalState.status === "drafting" && state.goalState.draft.nextRecommendedQuestion) {
			lines.push(`next question: ${state.goalState.draft.nextRecommendedQuestion}`);
		}
	}
	if (state.currentPhase) lines.push(`phase: ${state.currentPhase}`);
	if (state.nextAction) lines.push(`next: ${state.nextAction}`);
	if (state.blocker) lines.push(`blocker: ${state.blocker}`);
	return lines;
}
