import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { defaultGoalState, hasActiveGoal, readGoalState } from "./state.ts";
import type { GoalOverlayStatus } from "./types.ts";
import { getPaths, writeText } from "./utils.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-files-runtime-state-"));
	tempDirectories.push(cwd);
	return cwd;
}

function persistStatus(cwd: string, status: GoalOverlayStatus): void {
	writeText(getPaths(cwd).goalState, `${JSON.stringify({ ...defaultGoalState(), status }, null, 2)}\n`);
}

test("hasActiveGoal is true only for active goal state", () => {
	const cwd = makeCwd();
	for (const status of ["none", "drafting", "ready", "paused", "complete"] as GoalOverlayStatus[]) {
		persistStatus(cwd, status);
		assert.equal(hasActiveGoal(cwd), false, status);
	}

	persistStatus(cwd, "active");
	assert.equal(hasActiveGoal(cwd), true);
});

test("hasActiveGoal fails open when the state file is missing or malformed", () => {
	const cwd = makeCwd();
	assert.equal(hasActiveGoal(cwd), false);

	writeText(getPaths(cwd).goalState, "not-json\n");
	assert.equal(hasActiveGoal(cwd), false);
});

test("invalid status with a committed goal normalizes to ready", () => {
	const cwd = makeCwd();
	const goal = {
		objective: "Keep the state contract explicit",
		successCriteria: ["State tests pass"],
		constraints: ["Preserve fail-open reads"],
		outOfScope: ["Unrelated extensions"],
		blockerRule: "Pause on blockers",
	};
	writeText(getPaths(cwd).goalState, `${JSON.stringify({ ...defaultGoalState(), status: "unexpected", goal }, null, 2)}\n`);

	assert.equal(readGoalState(cwd).status, "ready");
	assert.equal(hasActiveGoal(cwd), false);
});

