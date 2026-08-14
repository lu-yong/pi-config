import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { runPlanArchiveCommand, type PlanArchiveCommandDeps } from "./archive-command.ts";
import { getPaths, writeText } from "./utils.ts";
import { archivePlanningWorkspace } from "./workspace.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-files-runtime-archive-command-"));
	directories.push(cwd);
	return cwd;
}

test("rejects plan-archive while the agent is running before touching the workspace", () => {
	const calls: string[] = [];
	const deps: PlanArchiveCommandDeps = {
		archive: () => {
			calls.push("archive");
			return "/archive";
		},
		clearContinuation: () => calls.push("clear-continuation"),
		dropLifecycle: () => calls.push("drop-lifecycle"),
		refresh: () => calls.push("refresh"),
	};

	runPlanArchiveCommand(
		{
			cwd: "/project",
			isIdle: () => false,
			notify: (message, level) => calls.push(`notify:${level}:${message}`),
		},
		deps,
	);

	assert.deepEqual(calls, [
		"notify:warning:Planning workspace cannot be archived while the agent is running. Wait for it to settle, then retry /plan-archive.",
	]);
});

test("archives an idle active-goal workspace and clears its runtime state", () => {
	const cwd = makeCwd();
	const paths = getPaths(cwd);
	writeText(paths.files["task_plan.md"], "# Task Plan\n");
	writeText(paths.goalState, '{"status":"active"}\n');
	const calls: string[] = [];
	let archiveDir: string | null = null;

	runPlanArchiveCommand(
		{
			cwd,
			isIdle: () => true,
			notify: (message, level) => calls.push(`notify:${level}:${message}`),
		},
		{
			archive: (targetCwd) => {
				calls.push("archive");
				archiveDir = archivePlanningWorkspace(targetCwd, {
					includeGoalState: true,
					includeGoalDesign: true,
					label: "plan-archive",
				});
				return archiveDir;
			},
			clearContinuation: () => calls.push("clear-continuation"),
			dropLifecycle: (targetCwd) => calls.push(`drop-lifecycle:${targetCwd}`),
			refresh: () => calls.push("refresh"),
		},
	);

	assert.ok(archiveDir);
	assert.deepEqual(fs.readdirSync(paths.root), ["archive"]);
	assert.equal(fs.existsSync(paths.files["task_plan.md"]), false);
	assert.equal(fs.existsSync(paths.goalState), false);
	assert.deepEqual(calls, [
		"archive",
		"clear-continuation",
		`drop-lifecycle:${cwd}`,
		"refresh",
		`notify:info:Planning workspace archived to ${archiveDir}.`,
	]);
});

test("keeps runtime state intact when archiving fails", () => {
	const calls: string[] = [];

	runPlanArchiveCommand(
		{
			cwd: "/project",
			isIdle: () => true,
			notify: (message, level) => calls.push(`notify:${level}:${message}`),
		},
		{
			archive: () => {
				calls.push("archive");
				throw new Error("disk unavailable");
			},
			clearContinuation: () => calls.push("clear-continuation"),
			dropLifecycle: () => calls.push("drop-lifecycle"),
			refresh: () => calls.push("refresh"),
		},
	);

	assert.deepEqual(calls, ["archive", "notify:error:Planning workspace archive failed: disk unavailable"]);
});
