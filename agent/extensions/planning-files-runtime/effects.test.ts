import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { CONTINUATION_DELAY_MS, MESSAGE_TYPE_CONTINUATION, MESSAGE_TYPE_GOAL_SET } from "./types.ts";
import { createGoalOverlay, type GoalOverlay } from "./goal-overlay.ts";
import { createGoalEffectExecutor, type ContinuationTimer, type OutgoingGoalMessage, type OutgoingGoalMessageOptions } from "./effects.ts";
import { fileExists, getPaths, readText, writeText } from "./utils.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-files-runtime-effects-"));
	tempDirectories.push(cwd);
	return cwd;
}

const contractParams = {
	objective: "Ship the effect executor",
	successCriteria: ["Executor tests pass"],
	constraints: ["Keep runtime behavior unchanged"],
	outOfScope: ["Redesign the overlay"],
	blockerRule: "Pause with a concrete blocker",
};

function prepareActiveOverlay(cwd: string): GoalOverlay {
	const overlay = createGoalOverlay(cwd);
	overlay.handle({ type: "start-drafting", input: "executor" });
	overlay.handle({ type: "save-draft", params: contractParams });
	writeText(getPaths(cwd).goalDesign, "# Goal Design\n\n## Design\n- agreed\n");
	overlay.handle({ type: "commit", params: contractParams });
	overlay.handle({ type: "implementation-request" });
	return overlay;
}

function spyRollback(overlay: GoalOverlay): GoalOverlay & { rollbackCount(): number } {
	let rollbacks = 0;
	return {
		handle: (event) => overlay.handle(event),
		getState: () => overlay.getState(),
		rollback: () => {
			rollbacks += 1;
			overlay.rollback();
		},
		turnStoppedBy: () => overlay.turnStoppedBy(),
		rollbackCount: () => rollbacks,
	};
}

type FakeTimer = ContinuationTimer & {
	fire(): void;
	scheduledDelays(): number[];
	clearedCount(): number;
	hasPending(): boolean;
};

function createFakeTimer(): FakeTimer {
	let pending: (() => void) | null = null;
	const delays: number[] = [];
	let cleared = 0;
	return {
		schedule(callback, delayMs) {
			pending = callback;
			delays.push(delayMs);
		},
		clear() {
			pending = null;
			cleared += 1;
		},
		fire() {
			const callback = pending;
			pending = null;
			callback?.();
		},
		scheduledDelays: () => delays,
		clearedCount: () => cleared,
		hasPending: () => pending !== null,
	};
}

type SentMessage = { message: OutgoingGoalMessage; options: OutgoingGoalMessageOptions };

function createHarness(options: { failSends?: boolean } = {}) {
	const sent: SentMessage[] = [];
	const log: string[] = [];
	const timer = createFakeTimer();
	const executor = createGoalEffectExecutor({
		sendMessage: (message, sendOptions) => {
			if (options.failSends) throw new Error("send exploded");
			sent.push({ message, options: sendOptions });
			log.push(`send:${message.customType}`);
		},
		timer,
	});
	const contextFor = (cwd: string) => ({
		cwd,
		resumedFromPreviousSession: false,
		refresh: () => {
			log.push("refresh");
		},
	});
	return { executor, timer, sent, log, contextFor };
}

describe("goal effect executor", () => {
	test("executes effects strictly in array order", () => {
		const cwd = makeCwd();
		const overlay = createGoalOverlay(cwd);
		const { executor, log, contextFor } = createHarness();

		const result = executor.apply(
			overlay,
			[{ type: "refresh" }, { type: "send-goal-set" }, { type: "refresh" }],
			contextFor(cwd),
		);

		assert.deepEqual(log, ["refresh", `send:${MESSAGE_TYPE_GOAL_SET}`, "refresh"]);
		assert.deepEqual(result, { rejection: undefined, failure: undefined });
	});

	test("materializes filesystem effects against the planning workspace", () => {
		const cwd = makeCwd();
		const overlay = createGoalOverlay(cwd);
		const { executor, contextFor } = createHarness();
		const paths = getPaths(cwd);

		executor.apply(
			overlay,
			[
				{ type: "ensure-goal-design" },
				{ type: "initialize-implementation-workspace", goal: contractParams, runId: 1 },
				{ type: "append-progress", heading: "Timeline", message: "executor smoke" },
			],
			contextFor(cwd),
		);

		assert.equal(fileExists(paths.goalDesign), true);
		assert.equal(fileExists(paths.files["task_plan.md"]), true);
		assert.match(readText(paths.files["progress.md"]), /executor smoke/);
	});

	test("returns the rejection carried by reject effects", () => {
		const cwd = makeCwd();
		const overlay = createGoalOverlay(cwd);
		const { executor, contextFor } = createHarness();

		const result = executor.apply(
			overlay,
			[{ type: "reject", operation: "plan-goal-impl", reason: "no goal" }],
			contextFor(cwd),
		);

		assert.deepEqual(result.rejection, { operation: "plan-goal-impl", reason: "no goal" });
		assert.equal(result.failure, undefined);
	});

	test("a failing effect rolls back the overlay, clears the timer, and keeps prior effects", () => {
		const cwd = makeCwd();
		const overlay = spyRollback(createGoalOverlay(cwd));
		const { executor, timer, contextFor } = createHarness({ failSends: true });
		const paths = getPaths(cwd);

		const result = executor.apply(
			overlay,
			[
				{ type: "append-progress", heading: "Timeline", message: "before failure" },
				{ type: "send-goal-set" },
			],
			contextFor(cwd),
		);

		assert.match(result.failure?.reason ?? "", /Goal overlay effect failed; state restored/);
		assert.equal(overlay.rollbackCount(), 1);
		assert.ok(timer.clearedCount() >= 1);
		// Effects before the failing one stay applied; the failure is not transactional.
		assert.match(readText(paths.files["progress.md"]), /before failure/);
	});

	test("schedule-continuation fires the continuation chain back through the overlay", () => {
		const cwd = makeCwd();
		const overlay = prepareActiveOverlay(cwd);
		const { executor, timer, sent, contextFor } = createHarness();
		const runId = overlay.getState().impl.runId;

		executor.apply(overlay, [{ type: "schedule-continuation", runId }], contextFor(cwd));

		assert.deepEqual(timer.scheduledDelays(), [CONTINUATION_DELAY_MS]);

		timer.fire();

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.message.customType, MESSAGE_TYPE_CONTINUATION);
		assert.equal(sent[0]?.options.deliverAs, "followUp");
	});

	test("a continuation firing after pause sends nothing", () => {
		const cwd = makeCwd();
		const overlay = prepareActiveOverlay(cwd);
		const { executor, timer, sent, contextFor } = createHarness();
		const runId = overlay.getState().impl.runId;

		executor.apply(overlay, [{ type: "schedule-continuation", runId }], contextFor(cwd));
		overlay.handle({ type: "pause", params: { reason: "blocked" } });
		timer.fire();

		assert.equal(sent.length, 0);
	});

	test("clear-continuation cancels the pending timer", () => {
		const cwd = makeCwd();
		const overlay = prepareActiveOverlay(cwd);
		const { executor, timer, contextFor } = createHarness();
		const runId = overlay.getState().impl.runId;

		executor.apply(overlay, [{ type: "schedule-continuation", runId }], contextFor(cwd));
		assert.equal(timer.hasPending(), true);
		executor.apply(overlay, [{ type: "clear-continuation" }], contextFor(cwd));
		assert.equal(timer.hasPending(), false);
	});
});
