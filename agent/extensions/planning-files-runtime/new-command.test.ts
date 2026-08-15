import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { runPlanNewCommand, type PlanNewCommandDeps } from "./new-command.ts";
import { getPaths, writeText } from "./utils.ts";
import { archivePlanningWorkspace, initializePlanningWorkspace } from "./workspace.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-files-runtime-new-command-"));
	directories.push(cwd);
	return cwd;
}

test("rejects plan-new while the agent is running before touching the workspace", () => {
	const calls: string[] = [];
	const deps: PlanNewCommandDeps = {
		archive: () => {
			calls.push("archive");
			return "/archive";
		},
		initialize: () => calls.push("initialize"),
		reset: () => {
			calls.push("reset");
			return true;
		},
	};

	runPlanNewCommand(
		{
			cwd: "/project",
			isIdle: () => false,
			notify: (message, level) => calls.push(`notify:${level}:${message}`),
		},
		deps,
	);

	assert.deepEqual(calls, [
		"notify:warning:Planning workspace cannot be reset while the agent is running. Wait for it to settle, then retry /plan-new.",
	]);
});

test("skips initialization and reset when archiving fails", () => {
	const calls: string[] = [];

	runPlanNewCommand(
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
			initialize: () => calls.push("initialize"),
			reset: () => {
				calls.push("reset");
				return true;
			},
		},
	);

	assert.deepEqual(calls, ["archive", "notify:warning:Planning workspace archive failed: disk unavailable"]);
});

test("skips reset when initialization fails", () => {
	const calls: string[] = [];

	runPlanNewCommand(
		{
			cwd: "/project",
			isIdle: () => true,
			notify: (message, level) => calls.push(`notify:${level}:${message}`),
		},
		{
			archive: () => {
				calls.push("archive");
				return "/archive";
			},
			initialize: () => {
				calls.push("initialize");
				throw new Error("permission denied");
			},
			reset: () => {
				calls.push("reset");
				return true;
			},
		},
	);

	assert.deepEqual(calls, ["archive", "initialize", "notify:warning:Planning workspace initialization failed: permission denied"]);
});

test("stays quiet when the lifecycle reset is rejected", () => {
	const calls: string[] = [];

	runPlanNewCommand(
		{
			cwd: "/project",
			isIdle: () => true,
			notify: (message, level) => calls.push(`notify:${level}:${message}`),
		},
		{
			archive: () => "/archive",
			initialize: () => calls.push("initialize"),
			reset: () => {
				calls.push("reset");
				return false;
			},
		},
	);

	assert.deepEqual(calls, ["initialize", "reset"]);
});

test("archives, re-initializes and resets an idle workspace", () => {
	const cwd = makeCwd();
	const paths = getPaths(cwd);
	writeText(paths.files["task_plan.md"], "# Task Plan\n");
	writeText(paths.goalState, '{"status":"active"}\n');
	const calls: string[] = [];

	runPlanNewCommand(
		{
			cwd,
			isIdle: () => true,
			notify: (message, level) => calls.push(`notify:${level}:${message}`),
		},
		{
			archive: (targetCwd) => {
				calls.push("archive");
				return archivePlanningWorkspace(targetCwd, { includeGoalState: true, includeGoalDesign: true, label: "plan-reset" });
			},
			initialize: (targetCwd) => {
				calls.push("initialize");
				initializePlanningWorkspace(targetCwd);
			},
			reset: () => {
				calls.push("reset");
				return true;
			},
		},
	);

	assert.equal(fs.existsSync(paths.goalState), false);
	assert.equal(fs.existsSync(path.join(paths.root, "archive")), true);
	assert.equal(fs.existsSync(paths.files["task_plan.md"]), true);
	assert.deepEqual(calls, ["archive", "initialize", "reset", "notify:info:Planning workspace reset. Goal overlay cleared."]);
});
