import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { createGoalOverlay, type GoalOverlayEffect } from "./goal-overlay.ts";
import { getPaths, writeText } from "./utils.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-files-runtime-goal-"));
	tempDirectories.push(cwd);
	return cwd;
}

const contractParams = {
	objective: "Ship the goal overlay lifecycle",
	successCriteria: ["Matrix tests pass"],
	constraints: ["Keep baseline planning behavior unchanged"],
	outOfScope: ["Redesign markdown templates"],
	blockerRule: "Pause with a concrete blocker",
};

function effectTypes(effects: GoalOverlayEffect[]): string[] {
	return effects.map((effect) => effect.type);
}

function prepareDraft(cwd: string) {
	const overlay = createGoalOverlay(cwd);
	overlay.handle({ type: "start-drafting", input: "lifecycle" });
	overlay.handle({ type: "save-draft", params: contractParams });
	writeText(getPaths(cwd).goalDesign, "# Goal Design\n\n## Design\n- agreed\n");
	return overlay;
}

function prepareActive(cwd: string) {
	const overlay = prepareDraft(cwd);
	overlay.handle({ type: "commit", params: contractParams });
	overlay.handle({ type: "implementation-request" });
	return overlay;
}

describe("goal overlay event -> effect seam", () => {
	test("covers legal transitions and preserves effect ordering", () => {
		const cwd = makeCwd();
		const overlay = createGoalOverlay(cwd);

		assert.deepEqual(effectTypes(overlay.handle({ type: "start-drafting", input: "lifecycle" })), [
			"ensure-goal-design",
			"clear-continuation",
			"refresh",
			"send-goal-set",
		]);
		assert.equal(overlay.getState().status, "drafting");

		overlay.handle({ type: "save-draft", params: contractParams });
		writeText(getPaths(cwd).goalDesign, "# Goal Design\n\n## Design\n- agreed\n");
		const commitEffects = overlay.handle({ type: "commit", params: contractParams });
		assert.deepEqual(effectTypes(commitEffects), ["clear-continuation", "refresh", "stop-turn"]);
		assert.equal(overlay.getState().status, "ready");

		const startEffects = overlay.handle({ type: "implementation-request" });
		assert.deepEqual(effectTypes(startEffects), [
			"archive-implementation-workspace",
			"initialize-implementation-workspace",
			"append-progress",
			"clear-continuation",
			"refresh",
			"send-goal-impl",
		]);
		assert.equal(overlay.getState().status, "active");
		assert.equal(overlay.getState().impl.runId, 1);

		const pauseEffects = overlay.handle({ type: "pause", params: { reason: "external dependency unavailable" } });
		assert.deepEqual(effectTypes(pauseEffects), ["append-progress", "append-progress", "clear-continuation", "stop-turn", "refresh"]);
		assert.equal(overlay.getState().status, "paused");

		const resumeEffects = overlay.handle({ type: "implementation-request" });
		assert.deepEqual(effectTypes(resumeEffects), ["ensure-implementation-workspace", "append-progress", "clear-continuation", "refresh", "send-goal-impl"]);
		assert.equal(overlay.getState().status, "active");
		assert.equal(overlay.getState().impl.runId, 1);

		const completeEffects = overlay.handle({ type: "complete", params: { summary: "Lifecycle is complete" } });
		assert.deepEqual(effectTypes(completeEffects), ["append-progress", "append-progress", "clear-continuation", "stop-turn", "refresh"]);
		assert.equal(overlay.getState().status, "complete");
	});

	test("rejects every illegal lifecycle operation without mutating state", () => {
		const cwd = makeCwd();
		const overlay = createGoalOverlay(cwd);
		const assertRejected = (event: Parameters<typeof overlay.handle>[0], operation: string) => {
			const before = overlay.getState();
			const effects = overlay.handle(event);
			assert.deepEqual(effectTypes(effects), ["reject"]);
			assert.equal(effects[0]?.type === "reject" ? effects[0].operation : "", operation);
			assert.deepEqual(overlay.getState(), before);
		};

		assertRejected({ type: "save-draft", params: { objective: "not allowed yet" } }, "save_plan_goal_draft");
		assertRejected({ type: "commit", params: contractParams }, "commit_plan_goal");
		assertRejected({ type: "implementation-request" }, "plan-goal-impl");
		assertRejected({ type: "pause", params: { reason: "blocked" } }, "pause_plan_goal");
		assertRejected({ type: "complete", params: { summary: "not active" } }, "complete_plan_goal");

		overlay.handle({ type: "start-drafting", input: "goal" });
		assertRejected({ type: "commit", params: contractParams }, "commit_plan_goal");
		assertRejected({ type: "implementation-request" }, "plan-goal-impl");
	});

	test("active repeated implementation requests are a true no-op", () => {
		const overlay = prepareActive(makeCwd());
		const before = overlay.getState();
		assert.deepEqual(overlay.handle({ type: "implementation-request" }), []);
		assert.deepEqual(overlay.getState(), before);
	});

	test("ready starts a new run while paused resumes the existing run", () => {
		const cwd = makeCwd();
		const overlay = prepareActive(cwd);
		assert.equal(overlay.getState().impl.runId, 1);
		overlay.handle({ type: "pause", params: { reason: "pause" } });
		overlay.handle({ type: "implementation-request" });
		assert.equal(overlay.getState().impl.runId, 1);
		overlay.handle({ type: "complete", params: { summary: "done" } });

		// A new drafting/commit cycle returns to ready; the next implementation is run 2.
		overlay.handle({ type: "start-drafting", input: "second run" });
		overlay.handle({ type: "save-draft", params: contractParams });
		overlay.handle({ type: "commit", params: contractParams });
		overlay.handle({ type: "implementation-request" });
		assert.equal(overlay.getState().status, "active");
		assert.equal(overlay.getState().impl.runId, 2);
	});

	test("restore reloads persisted state and continuation events reject stale run ids", () => {
		const cwd = makeCwd();
		const first = prepareActive(cwd);
		assert.equal(first.getState().impl.runId, 1);

		const restored = createGoalOverlay(cwd);
		assert.equal(restored.getState().status, "active");
		assert.equal(restored.handle({ type: "restore" })[0]?.type, "refresh");
		assert.deepEqual(restored.handle({ type: "continuation-fired", runId: 99 }), []);
		assert.deepEqual(effectTypes(restored.handle({ type: "continuation-fired", runId: 1 })), ["send-continuation"]);

		restored.handle({ type: "pause", params: { reason: "stale continuation check" } });
		assert.deepEqual(restored.handle({ type: "continuation-fired", runId: 1 }), []);
	});

	test("continuation policy is decided by the overlay, not by the timer adapter", () => {
		const overlay = prepareActive(makeCwd());
		overlay.handle({ type: "turn-start" });
		overlay.handle({ type: "progress-tool-called" });
		assert.deepEqual(effectTypes(overlay.handle({ type: "turn-end" })), ["refresh", "queue-continuation"]);

		overlay.handle({ type: "turn-start" });
		assert.deepEqual(effectTypes(overlay.handle({ type: "turn-end" })), ["clear-continuation"]);

		overlay.handle({ type: "turn-start" });
		overlay.handle({ type: "progress-tool-called" });
		const aborted = overlay.handle({ type: "turn-end", stopReason: "aborted" });
		assert.deepEqual(effectTypes(aborted), ["append-progress", "append-progress", "clear-continuation", "refresh"]);
		assert.equal(overlay.getState().status, "paused");
	});

	test("rollback restores the persisted state after an effect failure", () => {
		const cwd = makeCwd();
		const overlay = prepareDraft(cwd);
		overlay.handle({ type: "commit", params: contractParams });
		assert.equal(overlay.getState().status, "ready");
		overlay.rollback();
		assert.equal(overlay.getState().status, "drafting");
		assert.equal(createGoalOverlay(cwd).getState().status, "drafting");
	});
});
