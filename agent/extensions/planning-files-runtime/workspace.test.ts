import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
	archivePlanningWorkspace,
	finalizeGoalWorkspace,
	type GoalWorkspaceFileOps,
	type PlanningArchiveFileOps,
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

function archiveFileOps(renameSync: PlanningArchiveFileOps["renameSync"]): PlanningArchiveFileOps {
	return {
		renameSync,
		copyFileSync: (source, destination) => fs.copyFileSync(source, destination),
		cpSync: (source, destination, options) => fs.cpSync(source, destination, options),
		rmSync: (target, options) => fs.rmSync(target, options),
	};
}

function assertArchiveSeedRestored(
	cwd: string,
	originals: ReturnType<typeof seed>,
	goalState: string,
): void {
	const paths = getPaths(cwd);
	assert.equal(readText(paths.files["task_plan.md"]), originals.taskPlan);
	assert.equal(readText(paths.files["findings.md"]), originals.findings);
	assert.equal(readText(paths.files["progress.md"]), originals.progress);
	assert.equal(readText(paths.goalDesign), originals.goalDesign);
	assert.equal(readText(paths.goalState), goalState);
	assert.equal(readText(path.join(paths.tasksDir, "task-01.md")), originals.taskCard);
	assert.deepEqual(fs.readdirSync(paths.archiveRoot), []);
}

test("restores every source when the second archive move fails", () => {
	const cwd = makeCwd();
	const originals = seed(cwd);
	const paths = getPaths(cwd);
	const goalState = '{"status":"active"}\n';
	writeText(paths.goalState, goalState);
	const fileOps = archiveFileOps((source, destination) => {
		if (source === paths.files["findings.md"]) throw new Error("simulated second move failure");
		fs.renameSync(source, destination);
	});

	assert.throws(
		() => archivePlanningWorkspace(cwd, {
			includeGoalState: true,
			includeGoalDesign: true,
			label: "plan-archive",
			fileOps,
		}),
		/simulated second move failure/,
	);
	assertArchiveSeedRestored(cwd, originals, goalState);
});

test("restores every moved file when the final tasks directory move fails", () => {
	const cwd = makeCwd();
	const originals = seed(cwd);
	const paths = getPaths(cwd);
	const goalState = '{"status":"active"}\n';
	writeText(paths.goalState, goalState);
	const fileOps = archiveFileOps((source, destination) => {
		if (source === paths.tasksDir) throw new Error("simulated tasks move failure");
		fs.renameSync(source, destination);
	});

	assert.throws(
		() => archivePlanningWorkspace(cwd, {
			includeGoalState: true,
			includeGoalDesign: true,
			label: "plan-archive",
			fileOps,
		}),
		/simulated tasks move failure/,
	);
	assertArchiveSeedRestored(cwd, originals, goalState);
});

test("reports rollback failures and retains the partial archive", () => {
	const cwd = makeCwd();
	seed(cwd);
	const paths = getPaths(cwd);
	const fileOps = archiveFileOps((source, destination) => {
		if (source === paths.files["findings.md"]) throw new Error("simulated forward failure");
		if (source.startsWith(paths.archiveRoot) && destination === paths.files["task_plan.md"]) {
			throw new Error("simulated rollback failure");
		}
		fs.renameSync(source, destination);
	});

	assert.throws(
		() => archivePlanningWorkspace(cwd, {
			includeGoalState: true,
			includeGoalDesign: true,
			label: "plan-archive",
			fileOps,
		}),
		/simulated forward failure Archive rollback also failed \(task_plan\.md: simulated rollback failure\)\. Partial archive retained at/,
	);
	assert.equal(fs.existsSync(paths.files["task_plan.md"]), false);
	assert.equal(fs.readdirSync(paths.archiveRoot).length, 1);
});

test("archives files and tasks through the cross-device fallback", () => {
	const cwd = makeCwd();
	const originals = seed(cwd);
	const paths = getPaths(cwd);
	const crossDeviceError = Object.assign(new Error("cross-device move"), { code: "EXDEV" });
	const fileOps = archiveFileOps(() => {
		throw crossDeviceError;
	});

	const archiveDir = archivePlanningWorkspace(cwd, {
		includeGoalState: true,
		includeGoalDesign: true,
		label: "plan-archive",
		fileOps,
	});

	assert.ok(archiveDir);
	assert.equal(readText(path.join(archiveDir, "task_plan.md")), originals.taskPlan);
	assert.equal(readText(path.join(archiveDir, "tasks", "task-01.md")), originals.taskCard);
	assert.equal(fs.existsSync(paths.files["task_plan.md"]), false);
	assert.equal(fs.existsSync(paths.tasksDir), false);
});

test("restores a partially removed cross-device tasks source before rolling back", () => {
	const cwd = makeCwd();
	const originals = seed(cwd);
	const paths = getPaths(cwd);
	const goalState = '{"status":"active"}\n';
	writeText(paths.goalState, goalState);
	const crossDeviceError = Object.assign(new Error("cross-device move"), { code: "EXDEV" });
	const baseOps = archiveFileOps(() => {
		throw crossDeviceError;
	});
	const fileOps: PlanningArchiveFileOps = {
		...baseOps,
		rmSync: (target, options) => {
			if (target === paths.tasksDir) {
				fs.rmSync(path.join(paths.tasksDir, "task-01.md"), { force: true });
				throw new Error("simulated partial tasks removal");
			}
			fs.rmSync(target, options);
		},
	};

	assert.throws(
		() => archivePlanningWorkspace(cwd, {
			includeGoalState: true,
			includeGoalDesign: true,
			label: "plan-archive",
			fileOps,
		}),
		/simulated partial tasks removal/,
	);
	assertArchiveSeedRestored(cwd, originals, goalState);
});
