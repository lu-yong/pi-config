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

/** Read the live planning state callers reason about, without exposing markdown. */
export function getPlanningSnapshot(cwd: string, resumedFromPreviousSession: boolean): PlanningSnapshot {
	const paths = getPaths(cwd);
	const taskPlan = readText(paths.files["task_plan.md"]);
	return {
		planningRoot: paths.root,
		files: paths.files,
		goalDesignPath: paths.goalDesign,
		tasksDir: paths.tasksDir,
		goalStatePath: paths.goalState,
		exists: hasPlanningFiles(cwd),
		currentPhase: firstMeaningfulLine(extractSection(taskPlan, HEADINGS.currentPhase)),
		goalFromPlan: firstMeaningfulLine(extractSection(taskPlan, HEADINGS.goal)),
		nextAction: firstMeaningfulLine(extractSection(taskPlan, HEADINGS.nextAction)),
		blocker: firstMeaningfulLine(extractSection(taskPlan, HEADINGS.blocker)),
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

export type PlanningArchiveFileOps = {
	renameSync(source: string, destination: string): void;
	copyFileSync(source: string, destination: string): void;
	cpSync(source: string, destination: string, options: { recursive: true }): void;
	rmSync(target: string, options: { force: true; recursive?: true }): void;
};

type PlanningArchiveEntry = {
	source: string;
	destination: string;
	kind: "file" | "directory";
};

const defaultPlanningArchiveFileOps: PlanningArchiveFileOps = {
	renameSync: (source, destination) => fs.renameSync(source, destination),
	copyFileSync: (source, destination) => fs.copyFileSync(source, destination),
	cpSync: (source, destination, options) => fs.cpSync(source, destination, options),
	rmSync: (target, options) => fs.rmSync(target, options),
};

function archiveErrorCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code ?? "")
		: "";
}

function archiveErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class ArchiveEntryRecoveryError extends Error {
	readonly recoveryReason: string;

	constructor(message: string, recoveryReason: string) {
		super(message);
		this.recoveryReason = recoveryReason;
	}
}

function copyArchiveEntry(entry: PlanningArchiveEntry, ops: PlanningArchiveFileOps): void {
	if (entry.kind === "directory") {
		ops.cpSync(entry.source, entry.destination, { recursive: true });
		return;
	}
	ops.copyFileSync(entry.source, entry.destination);
}

function removeArchiveEntry(target: string, kind: PlanningArchiveEntry["kind"], ops: PlanningArchiveFileOps): void {
	if (kind === "directory") {
		ops.rmSync(target, { force: true, recursive: true });
		return;
	}
	ops.rmSync(target, { force: true });
}

function moveArchiveEntry(entry: PlanningArchiveEntry, ops: PlanningArchiveFileOps): void {
	try {
		ops.renameSync(entry.source, entry.destination);
		return;
	} catch (error) {
		if (archiveErrorCode(error) !== "EXDEV") throw error;
	}

	try {
		copyArchiveEntry(entry, ops);
	} catch (error) {
		try {
			removeArchiveEntry(entry.destination, entry.kind, ops);
		} catch (cleanupError) {
			throw new Error(`${archiveErrorMessage(error)} Cross-device copy cleanup also failed: ${archiveErrorMessage(cleanupError)}`);
		}
		throw error;
	}

	try {
		removeArchiveEntry(entry.source, entry.kind, ops);
	} catch (error) {
		try {
			copyArchiveEntry({ source: entry.destination, destination: entry.source, kind: entry.kind }, ops);
			removeArchiveEntry(entry.destination, entry.kind, ops);
		} catch (recoveryError) {
			throw new ArchiveEntryRecoveryError(
				archiveErrorMessage(error),
				`Cross-device source removal recovery failed: ${archiveErrorMessage(recoveryError)}`,
			);
		}
		throw error;
	}
}

export function archivePlanningWorkspace(
	cwd: string,
	options: {
		includeGoalState: boolean;
		includeGoalDesign: boolean;
		label: string;
		fileOps?: PlanningArchiveFileOps;
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
		kind: "file",
	}));
	if (includeTasks) {
		entries.push({ source: paths.tasksDir, destination: path.join(archiveDir, "tasks"), kind: "directory" });
	}

	const ops = options.fileOps ?? defaultPlanningArchiveFileOps;
	const moved: PlanningArchiveEntry[] = [];
	try {
		for (const entry of entries) {
			moveArchiveEntry(entry, ops);
			moved.push(entry);
		}
		return archiveDir;
	} catch (error) {
		const rollbackErrors: string[] = error instanceof ArchiveEntryRecoveryError
			? [`current entry: ${error.recoveryReason}`]
			: [];
		for (const entry of [...moved].reverse()) {
			try {
				moveArchiveEntry({ source: entry.destination, destination: entry.source, kind: entry.kind }, ops);
			} catch (rollbackError) {
				rollbackErrors.push(`${path.basename(entry.source)}: ${archiveErrorMessage(rollbackError)}`);
			}
		}

		const reason = archiveErrorMessage(error);
		if (rollbackErrors.length > 0) {
			throw new Error(`${reason} Archive rollback also failed (${rollbackErrors.join("; ")}). Partial archive retained at ${archiveDir}.`);
		}
		try {
			ops.rmSync(archiveDir, { force: true, recursive: true });
		} catch (cleanupError) {
			throw new Error(`${reason} Workspace restored, but incomplete archive cleanup failed: ${archiveErrorMessage(cleanupError)}`);
		}
		throw error;
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
