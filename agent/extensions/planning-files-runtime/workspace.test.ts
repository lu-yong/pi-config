import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
	archivePlanningWorkspace,
	finalizeGoalWorkspace,
	getPlanningSnapshot,
	initializePlanningWorkspace,
} from "./workspace.ts";
import { getPaths, readText, writeText } from "./utils.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-files-runtime-workspace-"));
	directories.push(cwd);
	return cwd;
}

const completion = { summary: "Workspace finalized", evidence: ["tests pass"], runId: 3 };

function seed(cwd: string): { taskPlan: string; progress: string; findings: string; goalDesign: string; taskCard: string } {
	const paths = getPaths(cwd);
	const taskPlan = "# Task Plan\n\n## Current Phase\nPhase 2\n\n## Next Concrete Action\n- do work\n\n## Blocker\n[empty]\n\n## Findings\n- untouched\n";
	const progress = "# Progress\n\n## Timeline\n- old\n\n## Completion Evidence\n- [empty]\n";
	const findings = "# Findings\n\n- preserve findings bytes\n";
	const goalDesign = "# Goal Design\n\n- preserve design bytes\n";
	const taskCard = "# Task 01\n\n- preserve task-card bytes\n";
	writeText(paths.files["task_plan.md"], taskPlan);
	writeText(paths.files["progress.md"], progress);
	writeText(paths.files["findings.md"], findings);
	writeText(paths.goalDesign, goalDesign);
	writeText(path.join(paths.tasksDir, "task-01.md"), taskCard);
	return { taskPlan, progress, findings, goalDesign, taskCard };
}

function expectError(action: () => void): string {
	try {
		action();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	assert.fail("expected action to throw");
}

test("initializes a workspace whose written files read back through the snapshot", () => {
	const cwd = makeCwd();
	const goal = {
		objective: "Ship the facade",
		successCriteria: ["all tests pass"],
		constraints: ["no new deps"],
		outOfScope: ["unrelated refactors"],
		blockerRule: "Ask the user.",
	};
	initializePlanningWorkspace(cwd, goal, 4);

	const snapshot = getPlanningSnapshot(cwd, false);
	assert.equal(snapshot.exists, true);
	assert.equal(snapshot.goalFromPlan, goal.objective);
	assert.equal(snapshot.currentPhase, "Phase 1");
	assert.equal(snapshot.nextAction, "[Describe the immediate next step]");
	assert.equal(snapshot.blocker, "[empty]");

	const paths = getPaths(cwd);
	assert.match(readText(paths.files["findings.md"]), /## Goal Context\n- Objective: Ship the facade/);
	assert.match(readText(paths.files["progress.md"]), /## Timeline\n- \[.+\] Goal implementation started \(run 4\): Ship the facade/);
});

test("initializes an empty workspace without a goal contract", () => {
	const cwd = makeCwd();
	initializePlanningWorkspace(cwd);

	const snapshot = getPlanningSnapshot(cwd, false);
	assert.equal(snapshot.goalFromPlan, "[One sentence describing the end state]");
	assert.equal(snapshot.currentPhase, "Phase 1");
	assert.match(readText(getPaths(cwd).files["progress.md"]), /Planning workspace initialized/);
});

test("finalizes task_plan.md and progress.md together, preserving unrelated sections", () => {
	const cwd = makeCwd();
	const originals = seed(cwd);
	finalizeGoalWorkspace(cwd, completion, { timestamp: "2026-08-12T00:00:00.000Z" });
	const paths = getPaths(cwd);
	const taskPlan = readText(paths.files["task_plan.md"]);
	const progress = readText(paths.files["progress.md"]);
	assert.match(taskPlan, /## Current Phase\nComplete/);
	assert.match(progress, /Workspace finalized/);
	assert.match(taskPlan, /## Findings\n- untouched/);
	assert.equal(readText(paths.files["findings.md"]), originals.findings);
	assert.equal(readText(paths.goalDesign), originals.goalDesign);
	assert.equal(readText(path.join(paths.tasksDir, "task-01.md")), originals.taskCard);
	assert.notEqual(taskPlan, originals.taskPlan);
	assert.notEqual(progress, originals.progress);
	const once = `${taskPlan}|${progress}`;
	finalizeGoalWorkspace(cwd, completion, { timestamp: "2026-08-12T00:00:00.000Z" });
	assert.equal(`${readText(paths.files["task_plan.md"])}|${readText(paths.files["progress.md"])}`, once);
});

test("missing task_plan.md fails without generating a workspace template", () => {
	const cwd = makeCwd();
	const paths = getPaths(cwd);
	writeText(paths.files["progress.md"], "# Progress\n");
	assert.throws(() => finalizeGoalWorkspace(cwd, completion), /task_plan.md is required/);
	assert.equal(fs.existsSync(paths.files["task_plan.md"]), false);
});

test("missing progress.md fails with a clear error without changing task_plan.md", () => {
	const cwd = makeCwd();
	const paths = getPaths(cwd);
	const taskPlan = "# Task Plan\n\n## Current Phase\nPhase 1\n";
	writeText(paths.files["task_plan.md"], taskPlan);
	assert.throws(() => finalizeGoalWorkspace(cwd, completion), /progress.md is required/);
	assert.equal(readText(paths.files["task_plan.md"]), taskPlan);
});

test("a write failure throws naming the file and leaves both originals on disk", () => {
	const cwd = makeCwd();
	const originals = seed(cwd);
	const paths = getPaths(cwd);
	fs.chmodSync(paths.root, 0o500);
	try {
		assert.throws(
			() => finalizeGoalWorkspace(cwd, completion, { timestamp: "2026-08-12T00:00:00.000Z" }),
			/Cannot finalize Goal workspace: writing task_plan\.md failed: EACCES/,
		);
		assert.equal(readText(paths.files["task_plan.md"]), originals.taskPlan);
		assert.equal(readText(paths.files["progress.md"]), originals.progress);
	} finally {
		fs.chmodSync(paths.root, 0o755);
	}
});

test("archives an active planning workspace without creating replacement templates", () => {
	const cwd = makeCwd();
	const originals = seed(cwd);
	const paths = getPaths(cwd);
	const goalState = '{"status":"active"}\n';
	writeText(paths.goalState, goalState);

	const archiveDir = archivePlanningWorkspace(cwd, {
		includeGoalState: true,
		includeGoalDesign: true,
		label: "plan-archive",
	});

	assert.ok(archiveDir);
	assert.deepEqual(fs.readdirSync(paths.root), ["archive"]);
	assert.equal(readText(path.join(archiveDir, "task_plan.md")), originals.taskPlan);
	assert.equal(readText(path.join(archiveDir, "findings.md")), originals.findings);
	assert.equal(readText(path.join(archiveDir, "progress.md")), originals.progress);
	assert.equal(readText(path.join(archiveDir, "goal-design.md")), originals.goalDesign);
	assert.equal(readText(path.join(archiveDir, ".goal-state.json")), goalState);
	assert.equal(readText(path.join(archiveDir, "tasks", "task-01.md")), originals.taskCard);
});

test("returns null for an empty workspace without creating an archive directory", () => {
	const cwd = makeCwd();
	const paths = getPaths(cwd);
	const archiveDir = archivePlanningWorkspace(cwd, {
		includeGoalState: true,
		includeGoalDesign: true,
		label: "plan-archive",
	});

	assert.equal(archiveDir, null);
	assert.equal(fs.existsSync(paths.root), false);
});

function soleArchiveDir(paths: ReturnType<typeof getPaths>): string {
	const entries = fs.readdirSync(paths.archiveRoot);
	assert.equal(entries.length, 1);
	return path.join(paths.archiveRoot, entries[0]);
}

test("restores every moved source when a later archive move fails", () => {
	const cwd = makeCwd();
	const originals = seed(cwd);
	const paths = getPaths(cwd);
	const goalState = '{"status":"active"}\n';
	writeText(paths.goalState, goalState);
	// A read-only directory cannot be renamed across parents (its ".." would
	// need updating), so goal-design.md fails after the earlier files moved.
	fs.rmSync(paths.goalDesign);
	fs.mkdirSync(paths.goalDesign);
	fs.chmodSync(paths.goalDesign, 0o500);

	const message = expectError(() => archivePlanningWorkspace(cwd, {
		includeGoalState: true,
		includeGoalDesign: true,
		label: "plan-archive",
	}));

	assert.match(message, /^goal-design\.md: EACCES/);
	assert.match(message, /The workspace was restored\. Partial archive retained at /);
	assert.ok(message.includes(soleArchiveDir(paths)));
	assert.equal(readText(paths.files["task_plan.md"]), originals.taskPlan);
	assert.equal(readText(paths.files["findings.md"]), originals.findings);
	assert.equal(readText(paths.files["progress.md"]), originals.progress);
	assert.equal(readText(paths.goalState), goalState);
	assert.equal(fs.statSync(paths.goalDesign).isDirectory(), true);
	assert.equal(readText(path.join(paths.tasksDir, "task-01.md")), originals.taskCard);
	assert.deepEqual(fs.readdirSync(soleArchiveDir(paths)), []);
	fs.chmodSync(paths.goalDesign, 0o755);
});

test("restores every moved file when the final tasks directory move fails", () => {
	const cwd = makeCwd();
	const originals = seed(cwd);
	const paths = getPaths(cwd);
	const goalState = '{"status":"active"}\n';
	writeText(paths.goalState, goalState);
	fs.chmodSync(paths.tasksDir, 0o500);

	const message = expectError(() => archivePlanningWorkspace(cwd, {
		includeGoalState: true,
		includeGoalDesign: true,
		label: "plan-archive",
	}));

	assert.match(message, /^tasks: EACCES/);
	assert.match(message, /The workspace was restored\. Partial archive retained at /);
	assert.ok(message.includes(soleArchiveDir(paths)));
	assert.equal(readText(paths.files["task_plan.md"]), originals.taskPlan);
	assert.equal(readText(paths.files["findings.md"]), originals.findings);
	assert.equal(readText(paths.files["progress.md"]), originals.progress);
	assert.equal(readText(paths.goalDesign), originals.goalDesign);
	assert.equal(readText(paths.goalState), goalState);
	assert.equal(readText(path.join(paths.tasksDir, "task-01.md")), originals.taskCard);
	assert.deepEqual(fs.readdirSync(soleArchiveDir(paths)), []);
	fs.chmodSync(paths.tasksDir, 0o755);
});
