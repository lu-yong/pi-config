import fs from "node:fs";
import path from "node:path";
import { PLANNING_FILES } from "./types.ts";
import type { GoalCompletion, GoalContract, PlanningSnapshot } from "./types.ts";
import { archiveStamp, ensureDir, fileExists, getPaths, nowIso, readText, trimEmptyLines, writeText } from "./utils.ts";
import {
	HEADINGS,
	appendBulletToHeading,
	createProgressTemplate,
	extractSection,
	finalizeProgressMarkdown,
	finalizeTaskPlanMarkdown,
	firstMeaningfulLine,
} from "./markdown.ts";
import { readGoalState } from "./state.ts";

// ---- file detection ----

export function hasPlanningFiles(cwd: string): boolean {
	const paths = getPaths(cwd);
	return PLANNING_FILES.some((name) => fileExists(paths.files[name]));
}

// ---- snapshot ----

/** Read the compact live planning state used by summaries and prompts. */
export function getPlanningSnapshot(cwd: string, resumedFromPreviousSession: boolean): PlanningSnapshot {
	return readPlanningSnapshot(cwd, resumedFromPreviousSession, false);
}

/** Read complete planning section bodies for the inspector, including every line. */
export function getPlanningDetails(cwd: string, resumedFromPreviousSession: boolean): PlanningSnapshot {
	return readPlanningSnapshot(cwd, resumedFromPreviousSession, true);
}

function readPlanningSnapshot(cwd: string, resumedFromPreviousSession: boolean, fullValues: boolean): PlanningSnapshot {
	const paths = getPaths(cwd);
	const taskPlan = readText(paths.files["task_plan.md"]);
	const sectionValue = (heading: string) => {
		const body = extractSection(taskPlan, heading);
		return fullValues ? body : firstMeaningfulLine(body);
	};
	return {
		planningRoot: paths.root,
		files: paths.files,
		goalDesignPath: paths.goalDesign,
		tasksDir: paths.tasksDir,
		goalStatePath: paths.goalState,
		exists: hasPlanningFiles(cwd),
		currentPhase: sectionValue(HEADINGS.currentPhase),
		goalFromPlan: sectionValue(HEADINGS.goal),
		nextAction: sectionValue(HEADINGS.nextAction),
		blocker: sectionValue(HEADINGS.blocker),
		goalState: readGoalState(cwd),
		resumedFromPreviousSession,
	};
}

// ---- timeline ----

/**
 * The progress.md sections the Goal lifecycle appends to. Exported so the
 * producer names a section through the workspace's vocabulary instead of
 * spelling the heading — a rename here updates template and writers together.
 */
export const PROGRESS_HEADINGS = {
	timeline: HEADINGS.timeline,
	blockers: HEADINGS.blockers,
} as const;

export type ProgressHeading = (typeof PROGRESS_HEADINGS)[keyof typeof PROGRESS_HEADINGS];

/** Append a timestamped bullet to a progress.md section, creating it if needed. */
export function appendProgressTimeline(cwd: string, heading: ProgressHeading, message: string): void {
	const paths = getPaths(cwd);
	const target = paths.files["progress.md"];
	const content = readText(target) || createProgressTemplate();
	const next = appendBulletToHeading(content, heading, `[${nowIso()}] ${message}`);
	writeText(target, trimEmptyLines(next).concat("\n"));
}

// ---- templates ----

function createTaskPlanTemplate(goal?: GoalContract): string {
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

## ${HEADINGS.goal}
${goalSection}
${criteriaSection}${constraintsSection}${outOfScopeSection}${blockedSection}
## ${HEADINGS.currentPhase}
Phase 1

## ${HEADINGS.nextAction}
- [Describe the immediate next step]

## ${HEADINGS.blocker}
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

function createFindingsTemplate(goal?: GoalContract): string {
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

function replaceFileAtomically(target: string, content: string): void {
	const temporary = path.join(path.dirname(target), `.${path.basename(target)}.goal-finalize-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
	try {
		fs.writeFileSync(temporary, content, "utf8");
		fs.renameSync(temporary, target);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

/**
 * Finalize both human-readable Goal projections. Each file is replaced
 * atomically in turn; a failure throws naming the file that failed and the
 * files already finalized are left in place.
 */
export function finalizeGoalWorkspace(
	cwd: string,
	completion: GoalCompletion,
	options: { timestamp?: string } = {},
): void {
	const paths = getPaths(cwd);
	const taskPlanPath = paths.files["task_plan.md"];
	const progressPath = paths.files["progress.md"];
	let originalTaskPlan: string;
	try {
		originalTaskPlan = fs.readFileSync(taskPlanPath, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot finalize Goal workspace: task_plan.md is required. ${reason}`);
	}
	let originalProgress: string;
	try {
		originalProgress = fs.readFileSync(progressPath, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot finalize Goal workspace: progress.md is required. ${reason}`);
	}
	const nextTaskPlan = finalizeTaskPlanMarkdown(originalTaskPlan);
	const nextProgress = finalizeProgressMarkdown(originalProgress, completion, options.timestamp ?? new Date().toISOString());
	if (nextTaskPlan === originalTaskPlan && nextProgress === originalProgress) return;

	const pending: Array<{ name: string; target: string; next: string }> = [];
	if (nextTaskPlan !== originalTaskPlan) pending.push({ name: "task_plan.md", target: taskPlanPath, next: nextTaskPlan });
	if (nextProgress !== originalProgress) pending.push({ name: "progress.md", target: progressPath, next: nextProgress });
	const finalized: string[] = [];
	for (const file of pending) {
		try {
			replaceFileAtomically(file.target, file.next);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const landed = finalized.length > 0
				? ` ${finalized.join(" and ")} ${finalized.length > 1 ? "were" : "was"} already finalized and left in place.`
				: "";
			throw new Error(`Cannot finalize Goal workspace: writing ${file.name} failed: ${reason}.${landed}`);
		}
		finalized.push(file.name);
	}
}

type PlanningArchiveEntry = {
	source: string;
	destination: string;
};

function archiveErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function moveArchiveEntry(entry: PlanningArchiveEntry): void {
	try {
		fs.renameSync(entry.source, entry.destination);
	} catch (error) {
		throw new Error(`${path.basename(entry.source)}: ${archiveErrorMessage(error)}`);
	}
}

export function archivePlanningWorkspace(
	cwd: string,
	options: {
		includeGoalState: boolean;
		includeGoalDesign: boolean;
		label: string;
	},
): string | null {
	const paths = getPaths(cwd);
	const sources = [
		...PLANNING_FILES.map((name) => paths.files[name]),
		...(options.includeGoalState ? [paths.goalState] : []),
		...(options.includeGoalDesign && fileExists(paths.goalDesign) ? [paths.goalDesign] : []),
	].filter((target) => fileExists(target));
	const includeTasks = options.includeGoalDesign && fileExists(paths.tasksDir);
	if (sources.length === 0 && !includeTasks) return null;

	ensureDir(paths.archiveRoot);
	const archiveDir = path.join(paths.archiveRoot, `${archiveStamp()}-${options.label}`);
	ensureDir(archiveDir);
	const entries: PlanningArchiveEntry[] = sources.map((source) => ({
		source,
		destination: path.join(archiveDir, path.basename(source)),
	}));
	if (includeTasks) {
		entries.push({ source: paths.tasksDir, destination: path.join(archiveDir, "tasks") });
	}

	const moved: PlanningArchiveEntry[] = [];
	try {
		for (const entry of entries) {
			moveArchiveEntry(entry);
			moved.push(entry);
		}
		return archiveDir;
	} catch (error) {
		const restoreErrors: string[] = [];
		for (const entry of [...moved].reverse()) {
			try {
				moveArchiveEntry({ source: entry.destination, destination: entry.source });
			} catch (restoreError) {
				restoreErrors.push(archiveErrorMessage(restoreError));
			}
		}
		const reason = archiveErrorMessage(error);
		const restoration = restoreErrors.length > 0
			? `Restoring the workspace also failed (${restoreErrors.join("; ")}).`
			: "The workspace was restored.";
		throw new Error(`${reason}. ${restoration} Partial archive retained at ${archiveDir}.`);
	}
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
