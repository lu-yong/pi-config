import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { getPaths, writeText } from "../planning-files-runtime/utils.ts";
import { defaultGoalState } from "../planning-files-runtime/state.ts";
import type { GoalOverlayStatus } from "../planning-files-runtime/types.ts";
import { ACTIVE_GOAL_QNA_BLOCK_MESSAGE, isQnaSuppressedByActiveGoal, rejectManualQnaForActiveGoal } from "./goal-policy.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qna-goal-policy-"));
	tempDirectories.push(cwd);
	return cwd;
}

function persistStatus(cwd: string, status: GoalOverlayStatus): void {
	const state = { ...defaultGoalState(), status };
	writeText(getPaths(cwd).goalState, `${JSON.stringify(state, null, 2)}\n`);
}

test("automatic and manual Q&A are suppressed only while a goal is active", () => {
	const cwd = makeCwd();
	for (const status of ["none", "drafting", "ready", "paused", "complete"] as GoalOverlayStatus[]) {
		persistStatus(cwd, status);
		assert.equal(isQnaSuppressedByActiveGoal(cwd), false, status);
	}

	persistStatus(cwd, "active");
	assert.equal(isQnaSuppressedByActiveGoal(cwd), true);
});

test("missing or malformed goal state does not suppress ordinary Q&A", () => {
	const cwd = makeCwd();
	assert.equal(isQnaSuppressedByActiveGoal(cwd), false);

	writeText(getPaths(cwd).goalState, "not-json\n");
	assert.equal(isQnaSuppressedByActiveGoal(cwd), false);
});

test("manual Q&A is rejected with a warning only while a goal is active", () => {
	const cwd = makeCwd();
	const notifications: Array<[string, "warning"]> = [];
	const notify = (message: string, level: "warning") => notifications.push([message, level]);

	assert.equal(rejectManualQnaForActiveGoal(cwd, notify), false);
	persistStatus(cwd, "active");
	assert.equal(rejectManualQnaForActiveGoal(cwd, notify), true);
	assert.deepEqual(notifications, [[ACTIVE_GOAL_QNA_BLOCK_MESSAGE, "warning"]]);
});
