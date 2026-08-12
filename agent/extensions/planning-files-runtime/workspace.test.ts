import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { finalizeGoalWorkspace, type GoalWorkspaceFileOps } from "./workspace.ts";
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

test("a later replacement failure restores both original files", () => {
	const cwd = makeCwd();
	const originals = seed(cwd);
	const paths = getPaths(cwd);
	let renameCount = 0;
	const real: GoalWorkspaceFileOps = {
		readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
		writeFileSync: (target, content, encoding) => fs.writeFileSync(target, content, encoding),
		renameSync: (source, destination) => {
			renameCount += 1;
			if (renameCount === 2) throw new Error("simulated progress rename failure");
			fs.renameSync(source, destination);
		},
		rmSync: (target, options) => fs.rmSync(target, options),
	};
	assert.throws(() => finalizeGoalWorkspace(cwd, completion, { fileOps: real }), /simulated progress rename failure/);
	assert.equal(readText(paths.files["task_plan.md"]), originals.taskPlan);
	assert.equal(readText(paths.files["progress.md"]), originals.progress);
});
