import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { defaultGoalState, hasActiveGoal, readGoalState, readGoalStateForUpdate } from "./state.ts";
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

test("legacy paused state defaults a missing suggested action", () => {
	const cwd = makeCwd();
	const state = defaultGoalState();
	writeText(getPaths(cwd).goalState, `${JSON.stringify({
		...state,
		status: "paused",
		impl: { ...state.impl, pausedReason: "blocked" },
	}, null, 2)}\n`);
	const restored = readGoalState(cwd);
	assert.equal(restored.status, "paused");
	assert.equal(restored.impl.pausedReason, "blocked");
	assert.equal(restored.impl.pausedSuggestedAction, "");
});

test("lifecycle reads reject unreadable state while read-only queries remain compatible", () => {
	const cwd = makeCwd();
	assert.equal(readGoalStateForUpdate(cwd), null);
	persistStatus(cwd, "paused");
	const target = getPaths(cwd).goalState;
	const original = fs.readFileSync(target, "utf8");
	fs.chmodSync(target, 0o000);
	try {
		assert.throws(() => readGoalStateForUpdate(cwd), { code: "EACCES" });
		assert.equal(hasActiveGoal(cwd), false);
	} finally {
		fs.chmodSync(target, 0o600);
	}
	assert.equal(fs.readFileSync(target, "utf8"), original);
	assert.equal(readGoalStateForUpdate(cwd)?.status, "paused");
});


test("goal state round-trips the token budget fields", () => {
	const cwd = makeCwd();
	const base = defaultGoalState();
	const state = {
		...base,
		status: "active" as const,
		goal: { objective: "o", successCriteria: ["s"], constraints: ["c"], outOfScope: ["x"], blockerRule: "b", tokenBudget: 5000 },
		impl: { ...base.impl, runId: 3, tokensUsed: 1234 },
	};
	writeText(getPaths(cwd).goalState, `${JSON.stringify(state)}\n`);
	const read = readGoalState(cwd);
	assert.equal(read.goal?.tokenBudget, 5000);
	assert.equal(read.impl.tokensUsed, 1234);
});

test("invalid token budget fields normalize to defaults", () => {
	const cwd = makeCwd();
	const base = defaultGoalState();
	const state = {
		...base,
		goal: { objective: "o", successCriteria: ["s"], constraints: ["c"], outOfScope: ["x"], blockerRule: "b", tokenBudget: -3 },
		impl: { ...base.impl, tokensUsed: "lots" },
	};
	writeText(getPaths(cwd).goalState, `${JSON.stringify(state)}\n`);
	const read = readGoalState(cwd);
	assert.equal(read.goal?.tokenBudget, undefined);
	assert.equal(read.impl.tokensUsed, 0);
});
