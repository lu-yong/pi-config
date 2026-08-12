import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultGoalState } from "./state.ts";
import type { PlanningSnapshot } from "./types.ts";
import { buildWidgetLines } from "./ui.ts";

function snapshot(status: "complete" | "active"): PlanningSnapshot {
	return {
		planningRoot: "/project/.pi/planning",
		files: { "task_plan.md": "/project/.pi/planning/task_plan.md", "findings.md": "/project/.pi/planning/findings.md", "progress.md": "/project/.pi/planning/progress.md" },
		goalDesignPath: "/project/.pi/planning/goal-design.md",
		tasksDir: "/project/.pi/planning/tasks",
		goalStatePath: "/project/.pi/planning/.goal-state.json",
		exists: true,
		currentPhase: "Phase 5",
		nextAction: "complete_plan_goal: stale action",
		blocker: "stale blocker",
		goalState: { ...defaultGoalState(), status },
		resumedFromPreviousSession: false,
	};
}

test("completed Goal widget uses the canonical terminal projection", () => {
	const lines = buildWidgetLines(snapshot("complete")) ?? [];
	assert.ok(lines.includes("goal: complete"));
	assert.ok(lines.includes("phase: Complete"));
	assert.ok(lines.includes("next: None (goal complete)."));
	assert.ok(!lines.some((line) => line.startsWith("blocker:")));
	assert.ok(!lines.some((line) => line.includes("Phase 5")));
	assert.ok(!lines.some((line) => line.includes("stale")));
});

test("non-complete Goal widget keeps task-plan-derived values", () => {
	const lines = buildWidgetLines(snapshot("active")) ?? [];
	assert.ok(lines.includes("phase: Phase 5"));
	assert.ok(lines.includes("next: complete_plan_goal: stale action"));
	assert.ok(lines.includes("blocker: stale blocker"));
});
