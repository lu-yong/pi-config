import type { GoalDraft, GoalOverlayState, PlanningSnapshot } from "./types.ts";
import { readText, tailLines, truncate } from "./utils.ts";
import { NETWORK_COMMANDS } from "../command-policy/policy.ts";

// ---- draft summary ----

export function summarizeDraft(state: GoalDraft): string[] {
	const lines: string[] = [];
	if (state.sourceTopic) lines.push(`- Source topic: ${state.sourceTopic}`);
	if (state.objective) lines.push(`- Objective draft: ${state.objective}`);
	if (state.successCriteria.length > 0) lines.push(`- Success criteria: ${state.successCriteria.join("; ")}`);
	if (state.constraints.length > 0) lines.push(`- Constraints: ${state.constraints.join("; ")}`);
	if (state.outOfScope.length > 0) lines.push(`- Out of scope: ${state.outOfScope.join("; ")}`);
	if (state.blockerRule) lines.push(`- If blocked: ${state.blockerRule}`);
	if (state.openQuestions.length > 0) lines.push(`- Open questions (${state.openQuestions.length}): ${state.openQuestions.join("; ")}`);
	if (state.nextRecommendedQuestion) lines.push(`- Recommended next question: ${state.nextRecommendedQuestion}`);
	return lines;
}

// ---- prompt builders ----

export function buildGoalSetPrompt(goalState: GoalOverlayState, supplementalInput?: string): string {
	const draft = goalState.draft;
	const currentGoal = goalState.goal;
	const draftSummary = summarizeDraft(draft);
	const stage = draft.draftingStage || "as-is";
	return [
		"[PLAN GOAL SET]",
		"Goal drafting in 4 stages. Output to .pi/planning/goal-design.md.",
		"Each stage: analyze -> write -> auto-advance. Ask user only if missing key info.",
		"Track stage in .goal-state.json draftingStage. Can go back if user changes mind.",
		"",
		"Stage 1 as-is: Read code. Map real paths, APIs, DB schema, components. List affected modules.",
		"  Output -> goal-design.md ## Design.",
		"Stage 2 design: Recommend 1 approach. Note alternatives + why rejected.",
		"  Cover compat, rollback, test strategy. Output -> goal-design.md ## Design.",
		"Stage 3 story: Vertical slices. Each = end-to-end deliverable.",
		"  Per Story: what, which layers, acceptance. Check vs architecture.md.",
		"  Flag single-layer Stories. Output -> goal-design.md ## Story Breakdown.",
		"Stage 4 task: Break Stories into Tasks. 1 commit per Task.",
		"  Mark hard/soft deps. Mark TDD (unit|component|integration|no).",
		"  Output index table -> goal-design.md ## Task Plan.",
		"  Write each Task card -> tasks/task-NN.md.",
		"",
		"Read-only bash protocol for goal drafting:",
		"  - Bash is fail-closed. Compound commands (&&, ||, ;, |, newlines) are allowed only when every segment is an approved read-only command.",
		"  - Redirects other than stderr to /dev/null (`2>/dev/null`), backticks, $(), subshells, and unknown commands are always rejected.",
		`  - Network commands are blocked during drafting: ${[...NETWORK_COMMANDS].join(", ")}.`,
		"  - Prefer the read tool for file contents; do not assume helpers such as sed are whitelisted.",
		"  - Example allowed: `pwd && git status --short`. Example rejected: `rg --files | sed -n '1,240p'` (sed not whitelisted).",
		"",
		"All done + contract complete -> commit_plan_goal.",
		"",
		"Output style: caveman. Drop filler. Tech precision. Arrow for causality.",
		"",
		`Current stage: ${stage}`,
		`Goal overlay status: ${goalState.status}`,
		...(currentGoal ? ["", "Committed goal:", `- Objective: ${currentGoal.objective}`] : []),
		...(currentGoal?.successCriteria.length ? [`- Success criteria: ${currentGoal.successCriteria.join("; ")}`] : []),
		"",
		"Current draft state:",
		...(draftSummary.length > 0 ? draftSummary : ["- (empty draft)"]),
		...(supplementalInput ? ["", "New user input for this drafting step:", supplementalInput] : []),
	].join("\n");
}

export function buildGoalImplPrompt(
	state: PlanningSnapshot,
	mode: "start" | "resume" | "continue",
	supplementalInput?: string,
): string {
	const input = supplementalInput?.trim();
	const goal = state.goalState.goal;
	if (!goal) {
		return "[PLAN GOAL IMPL]\nNo committed goal exists. Stop and tell the user to run /plan-goal-set first.";
	}
	const findings = truncate(tailLines(readText(state.files["findings.md"]), 20), 1400);
	const progress = truncate(tailLines(readText(state.files["progress.md"]), 20), 1400);
	const taskPlan = truncate(readText(state.files["task_plan.md"]), 2200);
	return [
		`[PLAN GOAL IMPL mode=${mode} runId=${state.goalState.impl.runId}]`,
		"You are executing a committed goal using planning files as working memory.",
		"Planning files are the only durable execution tracker for this run.",
		"",
		"Goal contract:",
		`- Objective: ${goal.objective}`,
		`- Success criteria: ${goal.successCriteria.join("; ")}`,
		`- Constraints: ${goal.constraints.join("; ") || "(none)"}`,
		`- Out of scope: ${goal.outOfScope.join("; ") || "(none)"}`,
		`- If blocked: ${goal.blockerRule}`,
		"",
		"Execution blueprint: .pi/planning/goal-design.md. Read before starting.",
		"  - Tasks have hard/soft deps. Respect topological order.",
		"  - If TDD marked: red -> green -> refactor, then commit.",
		"  - 1 commit per Task. Merge sequentially. No parallel writes.",
		"",
		"Execution protocol:",
		"- Re-read task_plan.md before major decisions.",
		"- Update findings.md after important discoveries or design decisions.",
		"- Update progress.md after meaningful work, verification, blockers, or completion evidence.",
		"- Keep task_plan.md as the source of truth for current phase and next actions.",
		"- Choose the next concrete action and do it; do not keep re-reading state without moving the work forward.",
		"- If you hit a real blocker, call pause_plan_goal with a concrete reason and suggested action.",
		"- Call complete_plan_goal only when the goal contract is actually satisfied and progress.md contains completion evidence.",
		"",
		"Current planning state:",
		`- Phase: ${state.currentPhase ?? "(missing)"}`,
		`- Next action: ${state.nextAction ?? "(missing)"}`,
		`- Blocker: ${state.blocker ?? "(none)"}`,
		"",
		"task_plan.md:",
		taskPlan || "(missing)",
		"",
		"Recent findings:",
		findings || "(missing)",
		"",
		"Recent progress:",
		progress || "(missing)",
		...(input ? [
			"",
			"Current user supplement for this implementation request:",
			input,
			"",
			"Reconciliation required before execution:",
			"- Re-read the current Blocker and Next action in task_plan.md and check them against the latest user-provided current facts above before acting.",
			"- Correct obsolete waiting conditions and next actions using those current facts; do not keep waiting solely because the old planning state says to wait.",
			"- Verify which blockers are actually resolved. Do not blindly clear all blockers; retain unresolved blockers and verify uncertain claims before proceeding.",
			"- Preserve historical interruption and blocker facts in progress.md; distinguish them from the current execution state.",
			"- This supplement does not automatically override the committed goal's hard constraints, success criteria, or scope. If it conflicts with the goal contract, ask for clarification rather than overriding it.",
		] : []),
	].join("\n");
}

// ---- plan update ----

export function buildPlanUpdatePrompt(snapshot: PlanningSnapshot): string {
	return [
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
	].join("\n");
}
