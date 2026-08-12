import fs from "node:fs";
import path from "node:path";
import { PLANNING_FILES } from "./types.ts";
import type { GoalCompletion, GoalContract } from "./types.ts";
import { archiveStamp, ensureDir, fileExists, getPaths, trimEmptyLines, writeText } from "./utils.ts";
import { createProgressTemplate, finalizeProgressMarkdown, finalizeTaskPlanMarkdown } from "./markdown.ts";

// Kept as a compatibility export for callers that used the workspace template helper.
export { createProgressTemplate } from "./markdown.ts";

// ---- file detection ----

export function hasPlanningFiles(cwd: string): boolean {
	const paths = getPaths(cwd);
	return PLANNING_FILES.some((name) => fileExists(paths.files[name]));
}

// ---- templates ----

export function createTaskPlanTemplate(goal?: GoalContract): string {
	const goalSection = goal?.objective || "[One sentence describing the end state]";
	const criteriaSection = goal && goal.successCriteria.length > 0
		? `\n## Goal Success Criteria\n${goal.successCriteria.map((item) => `- ${item}`).join("\n")}\n`
		: "";
	const constraintsSection = goal && goal.constraints.length > 0
		? `\n## Goal Constraints\n${goal.constraints.map((item) => `- ${item}`).join("\n")}\n`
		: "";
	const outOfScopeSection = goal && goal.outOfScope.length > 0
		? `\n## Goal Out of Scope\n${goal.outOfScope.map((item) => `- ${item}`).join("\n")}\n`
		: "";
	const blockedSection = goal?.blockerRule
		? `\n## If Blocked\n${goal.blockerRule}\n`
		: "";
	const keyQuestions = goal
		? [
			"1. Which files or systems must change to satisfy the goal?",
			"2. How will each success criterion be verified before declaring completion?",
		]
		: ["1. [Question to answer]", "2. [Question to answer]"];
	return trimEmptyLines(`# Task Plan: ${goal ? "Goal Implementation" : "[Brief Description]"}
<!--
  WHAT: This is your roadmap for the current work.
  WHY: After many tool calls, original goals and discoveries can get forgotten.
  WHEN: Keep this file current before and after meaningful work.
-->

## Goal
${goalSection}
${criteriaSection}${constraintsSection}${outOfScopeSection}${blockedSection}
## Current Phase
Phase 1

## Next Concrete Action
- [Describe the immediate next step]

## Blocker
[empty]

## Phases

### Phase 1: Requirements & Discovery
- [ ] Understand the current task and repository context
- [ ] Identify constraints and requirements
- [ ] Document findings in findings.md
- **Status:** in_progress

### Phase 2: Planning & Structure
- [ ] Define the technical approach
- [ ] Decide file/module touch points
- [ ] Document decisions with rationale
- **Status:** pending

### Phase 3: Implementation
- [ ] Execute the plan step by step
- [ ] Test incrementally
- [ ] Keep planning files updated
- **Status:** pending

### Phase 4: Testing & Verification
- [ ] Verify all requirements are met
- [ ] Document test results in progress.md
- [ ] Fix any issues found
- **Status:** pending

### Phase 5: Delivery
- [ ] Review all output files
- [ ] Ensure deliverables are complete
- [ ] Deliver to the user
- **Status:** pending

## Key Questions
${keyQuestions.join("\n")}

## Decisions Made
| Decision | Rationale |
|----------|-----------|
|          |           |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
|       | 1       |            |

## Notes
- Update phase status as you progress: pending → in_progress → complete
- Re-read this plan before major decisions
- Log errors to avoid repetition
- Never repeat a failed action unchanged
`);
}

export function createFindingsTemplate(goal?: GoalContract): string {
	const goalContext = goal
		? [
			"## Goal Context",
			`- Objective: ${goal.objective}`,
			...goal.constraints.map((item) => `- Constraint: ${item}`),
			...goal.outOfScope.map((item) => `- Out of scope: ${item}`),
			"",
		].join("\n")
		: "";
	return trimEmptyLines(`# Findings

${goalContext}## Confirmed Constraints
- [empty]

## Repo / System Findings
- [empty]

## Design Decisions
- [empty]

## Notes
- [empty]
`);
}


// ---- workspace lifecycle ----

export function initializePlanningWorkspace(cwd: string, goal?: GoalContract, runId?: number): void {
	const paths = getPaths(cwd);
	ensureDir(paths.root);
	writeText(paths.files["task_plan.md"], `${createTaskPlanTemplate(goal)}\n`);
	writeText(paths.files["findings.md"], `${createFindingsTemplate(goal)}\n`);
	writeText(paths.files["progress.md"], `${createProgressTemplate(goal, runId)}\n`);
}

export type GoalWorkspaceFileOps = {
	readFileSync(target: string, encoding: "utf8"): string;
	writeFileSync(target: string, content: string, encoding: "utf8"): void;
	renameSync(source: string, destination: string): void;
	rmSync(target: string, options: { force: true }): void;
};

const defaultGoalWorkspaceFileOps: GoalWorkspaceFileOps = {
	readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
	writeFileSync: (target, content, encoding) => fs.writeFileSync(target, content, encoding),
	renameSync: (source, destination) => fs.renameSync(source, destination),
	rmSync: (target, options) => fs.rmSync(target, options),
};

function replaceFileAtomically(target: string, content: string, ops: GoalWorkspaceFileOps): void {
	const temporary = path.join(path.dirname(target), `.${path.basename(target)}.goal-finalize-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
	try {
		ops.writeFileSync(temporary, content, "utf8");
		ops.renameSync(temporary, target);
	} finally {
		ops.rmSync(temporary, { force: true });
	}
}

/**
 * Finalize both human-readable Goal projections as one compensating workspace
 * operation. Individual replacements are atomic; caught later failures restore
 * both originals before the error is returned to the overlay executor.
 */
export function finalizeGoalWorkspace(
	cwd: string,
	completion: GoalCompletion,
	options: { fileOps?: GoalWorkspaceFileOps; timestamp?: string } = {},
): void {
	const paths = getPaths(cwd);
	const taskPlanPath = paths.files["task_plan.md"];
	const progressPath = paths.files["progress.md"];
	const ops = options.fileOps ?? defaultGoalWorkspaceFileOps;
	let originalTaskPlan: string;
	try {
		originalTaskPlan = ops.readFileSync(taskPlanPath, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot finalize Goal workspace: task_plan.md is required. ${reason}`);
	}
	let originalProgress: string;
	try {
		originalProgress = ops.readFileSync(progressPath, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot finalize Goal workspace: progress.md is required. ${reason}`);
	}
	const nextTaskPlan = finalizeTaskPlanMarkdown(originalTaskPlan);
	const nextProgress = finalizeProgressMarkdown(originalProgress, completion, options.timestamp ?? new Date().toISOString());
	if (nextTaskPlan === originalTaskPlan && nextProgress === originalProgress) return;

	try {
		if (nextTaskPlan !== originalTaskPlan) replaceFileAtomically(taskPlanPath, nextTaskPlan, ops);
		if (nextProgress !== originalProgress) replaceFileAtomically(progressPath, nextProgress, ops);
	} catch (error) {
		const restoreErrors: string[] = [];
		for (const [target, original] of [[taskPlanPath, originalTaskPlan], [progressPath, originalProgress]] as const) {
			try {
				replaceFileAtomically(target, original, ops);
			} catch (restoreError) {
				restoreErrors.push(`${path.basename(target)}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
			}
		}
		const reason = error instanceof Error ? error.message : String(error);
		const restoration = restoreErrors.length > 0 ? ` Restoration also failed (${restoreErrors.join("; ")}).` : " Both files were restored.";
		throw new Error(`Cannot finalize Goal workspace: ${reason}.${restoration}`);
	}
}

export function archivePlanningWorkspace(cwd: string, options: { includeGoalState: boolean; includeGoalDesign: boolean; label: string }): string | null {
	const paths = getPaths(cwd);
	const archiveTargets = [
		...PLANNING_FILES.map((name) => paths.files[name]),
		...(options.includeGoalState ? [paths.goalState] : []),
		...(options.includeGoalDesign && fileExists(paths.goalDesign) ? [paths.goalDesign] : []),
	].filter((target) => fileExists(target));
	if (archiveTargets.length === 0 && !(options.includeGoalDesign && fileExists(paths.tasksDir))) return null;
	ensureDir(paths.archiveRoot);
	const archiveDir = path.join(paths.archiveRoot, `${archiveStamp()}-${options.label}`);
	ensureDir(archiveDir);
	for (const target of archiveTargets) {
		const destination = path.join(archiveDir, path.basename(target));
		try {
			fs.renameSync(target, destination);
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
			if (code !== "EXDEV") throw error;
			fs.copyFileSync(target, destination);
			fs.rmSync(target, { force: true });
		}
	}
	// Archive tasks/ directory if it exists (only during plan-new reset)
	if (options.includeGoalDesign && fileExists(paths.tasksDir)) {
		try {
			fs.renameSync(paths.tasksDir, path.join(archiveDir, "tasks"));
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
			if (code !== "EXDEV") throw error;
			// cross-device fallback: skip (tasks dir is ephemeral)
		}
	}
	return archiveDir;
}

export function createGoalDesignSkeleton(cwd: string): void {
	const paths = getPaths(cwd);
	ensureDir(paths.root);
	ensureDir(paths.tasksDir);
	if (!fileExists(paths.goalDesign)) {
		writeText(paths.goalDesign, trimEmptyLines(`# Goal Design

## Design

## Story Breakdown

## Task Plan
`) + "\n");
	}
}
