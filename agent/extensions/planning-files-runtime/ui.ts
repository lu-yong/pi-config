import type { PlanningSnapshot } from "./types.ts";

type WidgetPlanProjection = {
	phase?: string;
	next?: string;
	blocker?: string;
};

/**
 * Resolve status-sensitive widget lines without changing the planning workspace's
 * raw snapshot semantics for prompts and continuity checks.
 */
function projectWidgetPlan(state: PlanningSnapshot): WidgetPlanProjection {
	if (state.goalState.status === "complete") {
		return { phase: "Complete", next: "None (goal complete)." };
	}
	if (state.goalState.status === "paused") {
		return {
			phase: state.currentPhase,
			next: state.goalState.impl.pausedSuggestedAction || undefined,
			blocker: state.goalState.impl.pausedReason || state.blocker,
		};
	}
	return { phase: state.currentPhase, next: state.nextAction, blocker: state.blocker };
}

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
	const plan = projectWidgetPlan(state);
	if (plan.phase) lines.push(`phase: ${plan.phase}`);
	if (plan.next) lines.push(`next: ${plan.next}`);
	if (plan.blocker) lines.push(`blocker: ${plan.blocker}`);
	return lines;
}
