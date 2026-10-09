import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import {
	createGoalLifecycle,
	type ContinuationTimer,
	type GoalLifecycle,
	type GoalLifecycleContext,
	type GoalLifecycleEvent,
	type OutgoingGoalMessage,
	type OutgoingGoalMessageOptions,
} from "./goal-lifecycle.ts";
import { CONTINUATION_DELAY_MS, MESSAGE_TYPE_CONTINUATION } from "./types.ts";
import { fileExists, getPaths, readText, writeText } from "./utils.ts";
import { defaultGoalState, hasActiveGoal, writeGoalState } from "./state.ts";
import { getPlanningSnapshot, initializePlanningWorkspace } from "./workspace.ts";
import { buildWidgetLines } from "./ui.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-files-runtime-goal-lifecycle-"));
	tempDirectories.push(cwd);
	return cwd;
}

const contractParams = {
	objective: "Ship the goal implementation run",
	successCriteria: ["Run tests pass"],
	constraints: ["Keep runtime behavior unchanged"],
	outOfScope: ["Redesign markdown templates"],
	blockerRule: "Pause with a concrete blocker",
};

// ---- harness: fake timer + captured messages + scripted context ----

type SentMessage = { message: OutgoingGoalMessage; options: OutgoingGoalMessageOptions };

type FakeTimer = ContinuationTimer & {
	fire(): void;
	scheduledDelays(): number[];
	hasPending(): boolean;
};

function createFakeTimer(): FakeTimer {
	let pending: (() => void) | null = null;
	const delays: number[] = [];
	return {
		schedule(callback, delayMs) {
			pending = callback;
			delays.push(delayMs);
		},
		clear() {
			pending = null;
		},
		fire() {
			const callback = pending;
			pending = null;
			callback?.();
		},
		scheduledDelays: () => delays,
		hasPending: () => pending !== null,
	};
}

function createHarness(options: { failSends?: boolean; idle?: boolean; failIdleCheck?: boolean; failNotify?: boolean; failRefresh?: boolean } = {}) {
	const sent: SentMessage[] = [];
	const log: string[] = [];
	const timer = createFakeTimer();
	let idle = options.idle ?? true;
	let failSends = options.failSends ?? false;
	let failNotify = options.failNotify ?? false;
	let failRefresh = options.failRefresh ?? false;
	const context = (): GoalLifecycleContext => ({
		resumedFromPreviousSession: false,
		isIdle: () => {
			if (options.failIdleCheck) throw new Error("stale context");
			return idle;
		},
		notify: (message, level) => {
			if (failNotify) throw new Error("notify exploded");
			log.push(`notify:${level}:${message}`);
		},
		refresh: () => {
			if (failRefresh) throw new Error("refresh exploded");
			log.push("refresh");
		},
	});
	return {
		timer,
		sent,
		log,
		context,
		deps: {
			sendMessage: (message, sendOptions) => {
				if (failSends) throw new Error("send exploded");
				sent.push({ message, options: sendOptions });
				log.push(`send:${message.customType}`);
			},
			timer,
		},
		setIdle: (next: boolean) => (idle = next),
		clearSent: () => sent.splice(0),
		setFailSends: (next: boolean) => (failSends = next),
		setFailNotify: (next: boolean) => (failNotify = next),
		setFailRefresh: (next: boolean) => (failRefresh = next),
	};
}

type Harness = ReturnType<typeof createHarness>;

function prepareDraft(cwd: string, harness: Harness): GoalLifecycle {
	const run = createGoalLifecycle(cwd, harness.deps);
	run.handle({ type: "start-drafting", input: "goal run" }, harness.context());
	run.handle({ type: "save-draft", params: contractParams }, harness.context());
	return run;
}

function prepareActive(cwd: string, harness: Harness): GoalLifecycle {
	const run = prepareDraft(cwd, harness);
	run.handle({ type: "commit", params: contractParams }, harness.context());
	run.handle({ type: "implementation-request" }, harness.context());
	return run;
}

function settleWithProgress(run: GoalLifecycle, harness: Harness): void {
	run.handle({ type: "progress-tool-called" }, harness.context());
	run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
	run.handle({ type: "agent-settled" }, harness.context());
}

describe("goal lifecycle", () => {
	test("covers the lifecycle transitions and materializes the planning workspace", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		const paths = getPaths(cwd);

		let result = run.handle({ type: "start-drafting", input: "goal run" }, harness.context());
		assert.equal(result.rejection, undefined);
		assert.equal(result.failure, undefined);
		assert.equal(run.getState().status, "drafting");
		assert.equal(fileExists(paths.goalDesign), true);

		run.handle({ type: "save-draft", params: contractParams }, harness.context());
		result = run.handle({ type: "commit", params: contractParams }, harness.context());
		assert.equal(result.rejection, undefined);
		assert.equal(run.getState().status, "ready");

		result = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(result.rejection, undefined);
		assert.equal(run.getState().status, "active");
		assert.equal(run.getState().impl.runId, 1);
		assert.equal(fileExists(paths.files["task_plan.md"]), true);
		assert.match(readText(paths.files["progress.md"]), /Goal implementation started \(run 1\)/);

		result = run.handle({
			type: "pause",
			params: { reason: "external dependency unavailable", suggestedAction: "Restore the dependency, then retry." },
		}, harness.context());
		assert.equal(result.rejection, undefined);
		assert.equal(run.getState().status, "paused");
		assert.equal(run.getState().impl.pausedSuggestedAction, "Restore the dependency, then retry.");
		assert.match(readText(paths.files["progress.md"]), /Goal paused: external dependency unavailable/);

		result = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(run.getState().status, "active");
		assert.equal(run.getState().impl.runId, 1);
		assert.equal(run.getState().impl.pausedSuggestedAction, "");

		result = run.handle({ type: "complete", params: { summary: "Lifecycle is complete" } }, harness.context());
		assert.equal(result.rejection, undefined);
		assert.equal(result.failure, undefined);
		assert.equal(run.getState().status, "complete");
		assert.match(readText(paths.files["task_plan.md"]), /## Current Phase\nComplete/);
		assert.match(readText(paths.files["progress.md"]), /Lifecycle is complete/);
	});

	test("rejects every illegal lifecycle operation without mutating state", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		const assertRejected = (event: GoalLifecycleEvent, operation: string) => {
			const before = run.getState();
			const result = run.handle(event, harness.context());
			assert.equal(result.rejection?.operation, operation);
			assert.deepEqual(run.getState(), before);
		};

		assertRejected({ type: "save-draft", params: { objective: "not allowed yet" } }, "save_plan_goal_draft");
		assertRejected({ type: "commit", params: contractParams }, "commit_plan_goal");
		assertRejected({ type: "implementation-request" }, "plan-goal-impl");
		assertRejected({ type: "pause", params: { reason: "blocked" } }, "pause_plan_goal");
		assertRejected({ type: "complete", params: { summary: "not active" } }, "complete_plan_goal");

		run.handle({ type: "start-drafting", input: "goal" }, harness.context());
		assertRejected({ type: "commit", params: contractParams }, "commit_plan_goal");
		assertRejected({ type: "implementation-request" }, "plan-goal-impl");
	});

	test("active repeated implementation requests are a true no-op", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const before = run.getState();
		const result = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(result.rejection, undefined);
		assert.equal(result.failure, undefined);
		assert.deepEqual(run.getState(), before);
	});

	test("ready starts a new run while paused resumes the existing run", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		assert.equal(run.getState().impl.runId, 1);
		run.handle({ type: "pause", params: { reason: "pause" } }, harness.context());
		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(run.getState().impl.runId, 1);
		run.handle({ type: "complete", params: { summary: "done" } }, harness.context());

		// A new drafting/commit cycle returns to ready; the next implementation is run 2.
		run.handle({ type: "start-drafting", input: "second run" }, harness.context());
		run.handle({ type: "save-draft", params: contractParams }, harness.context());
		run.handle({ type: "commit", params: contractParams }, harness.context());
		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(run.getState().status, "active");
		assert.equal(run.getState().impl.runId, 2);
	});

	test("restore reloads persisted state", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		prepareActive(cwd, harness);

		const restored = createGoalLifecycle(cwd, harness.deps);
		assert.equal(restored.getState().status, "active");
		const result = restored.handle({ type: "restore" }, harness.context());
		assert.equal(result.rejection, undefined);
		assert.equal(result.failure, undefined);
		assert.equal(restored.getState().status, "active");
	});

	test("turn stop gate is held by the lifecycle and cleared at turn start", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareDraft(cwd, harness);
		assert.equal(run.turnStoppedBy(), null);

		run.handle({ type: "commit", params: contractParams }, harness.context());
		assert.equal(run.turnStoppedBy(), "commit_plan_goal");
		run.handle({ type: "turn-start" }, harness.context());
		assert.equal(run.turnStoppedBy(), null);

		run.handle({ type: "implementation-request" }, harness.context());
		run.handle({ type: "pause", params: { reason: "blocked" } }, harness.context());
		assert.equal(run.turnStoppedBy(), "pause_plan_goal");
		run.handle({ type: "turn-start" }, harness.context());

		run.handle({ type: "implementation-request" }, harness.context());
		run.handle({ type: "complete", params: { summary: "done" } }, harness.context());
		assert.equal(run.turnStoppedBy(), "complete_plan_goal");
	});

	test("a failing effect rolls back the lifecycle state but keeps prior effects", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareDraft(cwd, harness);
		run.handle({ type: "commit", params: contractParams }, harness.context());
		assert.equal(run.getState().status, "ready");
		const paths = getPaths(cwd);

		harness.setFailSends(true);
		const result = run.handle({ type: "implementation-request" }, harness.context());
		harness.setFailSends(false);

		assert.match(result.failure?.reason ?? "", /Goal run failed; state restored/);
		assert.equal(run.getState().status, "ready");
		assert.equal(createGoalLifecycle(cwd, harness.deps).getState().status, "ready");
		// Effects before the failing send stay applied; the failure is not transactional.
		assert.equal(fileExists(paths.files["task_plan.md"]), true);
		assert.match(readText(paths.files["progress.md"]), /Goal implementation started \(run 1\)/);
	});

	test("an unreadable goal-state path does not publish the transition and a repaired retry is not a no-op", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		run.handle({ type: "start-drafting", input: "goal" }, harness.context());
		run.handle({ type: "save-draft", params: contractParams }, harness.context());
		run.handle({ type: "commit", params: contractParams }, harness.context());
		assert.equal(run.getState().status, "ready");
		const goalStatePath = getPaths(cwd).goalState;

		// Make .goal-state.json unwritable: a directory sits where the file must be written.
		fs.rmSync(goalStatePath, { force: true });
		fs.mkdirSync(goalStatePath);

		const result = run.handle({ type: "implementation-request" }, harness.context());
		assert.match(result.failure?.reason ?? "", /Goal run failed/);
		assert.equal(run.getState().status, "ready"); // memory never published
		assert.equal(hasActiveGoal(cwd), false);

		// Once the storage problem is removed, the request proceeds instead of being an active no-op.
		fs.rmSync(goalStatePath, { recursive: true, force: true });
		writeGoalState(cwd, run.getState()); // restore the file, not just directory access
		const retry = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(retry.failure, undefined);
		assert.equal(retry.rejection, undefined);
		assert.equal(run.getState().status, "active");
		assert.equal(run.getState().impl.runId, 1);
	});

	test("an unreadable goal-state path during completion leaves the run active and the workspace untouched", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "turn-start" }, harness.context()); // clear the commit stop gate like a real turn would
		const paths = getPaths(cwd);
		settleWithProgress(run, harness);
		assert.equal(harness.timer.hasPending(), true);
		const goalStatePath = getPaths(cwd).goalState;

		fs.rmSync(goalStatePath, { force: true });
		fs.mkdirSync(goalStatePath);

		const result = run.handle({ type: "complete", params: { summary: "cannot persist" } }, harness.context());
		assert.match(result.failure?.reason ?? "", /Goal run failed/);
		assert.equal(run.getState().status, "active");
		assert.equal(run.turnStoppedBy(), null);
		assert.equal(harness.timer.hasPending(), false); // pending continuation cleared
		assert.match(readText(paths.files["task_plan.md"]), /## Current Phase\nPhase 1/); // workspace not finalized

		// Retrying after the storage problem is fixed completes normally.
		fs.rmSync(goalStatePath, { recursive: true, force: true });
		writeGoalState(cwd, run.getState());
		const retry = run.handle({ type: "complete", params: { summary: "cannot persist" } }, harness.context());
		assert.equal(retry.failure, undefined);
		assert.equal(run.getState().status, "complete");
	});

	test("a failed reset effect reports failure and rolls back the lifecycle", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareDraft(cwd, harness);
		assert.equal(run.getState().status, "drafting");

		// A throwing UI refresh makes the reset effect fail; the run must
		// surface it as a failure result (the adapter can then suppress the
		// unconditional "reset succeeded" notification).
		const result = run.handle(
			{ type: "reset" },
			{ ...harness.context(), refresh: () => { throw new Error("ui exploded"); } },
		);
		assert.match(result.failure?.reason ?? "", /Goal run failed; state restored/);
		assert.equal(run.getState().status, "drafting"); // rolled back, not wiped
		assert.equal(createGoalLifecycle(cwd, harness.deps).getState().status, "drafting");
	});

	test("a failed atomic goal-state write leaves the prior file intact", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		run.handle({ type: "start-drafting", input: "goal" }, harness.context());
		run.handle({ type: "save-draft", params: contractParams }, harness.context());
		run.handle({ type: "commit", params: contractParams }, harness.context());
		assert.equal(run.getState().status, "ready");
		const goalStatePath = getPaths(cwd).goalState;
		const original = readText(goalStatePath);
		assert.ok(original.length > 0);

		// A read-only planning directory makes the atomic temp write fail
		// before the destination can be truncated.
		fs.chmodSync(getPaths(cwd).root, 0o555);
		try {
			const result = run.handle({ type: "implementation-request" }, harness.context());
			assert.match(result.failure?.reason ?? "", /Goal run failed; state preserved/);
			assert.equal(run.getState().status, "ready");
			assert.equal(readText(goalStatePath), original); // destination untouched
		} finally {
			fs.chmodSync(getPaths(cwd).root, 0o755);
		}

		// The prior goal state is still loadable after the failure.
		assert.equal(createGoalLifecycle(cwd, harness.deps).getState().status, "ready");
	});

	test("continuation waits for agent settlement and LLM failure pauses the goal", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "progress-tool-called" }, harness.context());
		let result = run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
		assert.equal(result.rejection, undefined);
		result = run.handle({ type: "agent-settled" }, harness.context());
		assert.equal(result.failure, undefined);
		assert.deepEqual(harness.timer.scheduledDelays(), [CONTINUATION_DELAY_MS]);

		harness.timer.fire();
		assert.equal(harness.sent.length, 1);
		assert.equal(harness.sent[0]?.message.customType, MESSAGE_TYPE_CONTINUATION);
		assert.equal(harness.sent[0]?.options.deliverAs, "followUp");
		harness.timer.fire();
		assert.equal(harness.sent.length, 1);

		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "progress-tool-called" }, harness.context());
		result = run.handle({ type: "turn-end", stopReason: "error", errorMessage: "provider overloaded" }, harness.context());
		assert.equal(result.rejection, undefined);
		result = run.handle({ type: "agent-settled" }, harness.context());
		assert.equal(result.failure, undefined);
		assert.equal(run.getState().status, "paused");
		assert.match(run.getState().impl.pausedReason, /will not retry automatically: provider overloaded/);
		assert.ok(harness.log.some((line) => line.startsWith("notify:warning:")));
		assert.equal(harness.timer.hasPending(), false);
	});

	test("a successful native retry preserves earlier tool progress", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);

		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "error", errorMessage: "temporary overload" }, harness.context());

		// Pi starts a low-level retry run before agent_settled; this only cancels stale timers.
		run.handle({ type: "agent-start" }, harness.context());
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
		run.handle({ type: "agent-settled" }, harness.context());
		assert.equal(run.getState().status, "active");
		assert.deepEqual(harness.timer.scheduledDelays(), [CONTINUATION_DELAY_MS]);
	});

	test("aborted settlement clears a pending continuation and pauses only once", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);
		assert.equal(harness.timer.hasPending(), true);

		const result = run.handle({ type: "agent-settled", aborted: true }, harness.context());
		assert.equal(result.failure, undefined);
		assert.equal(result.rejection, undefined);
		assert.equal(run.getState().status, "paused");
		assert.equal(harness.timer.hasPending(), false);
		assert.equal(createGoalLifecycle(cwd, harness.deps).getState().status, "paused");
		harness.timer.fire();
		assert.equal(harness.sent.length, 0);
		const progressPath = getPaths(cwd).files["progress.md"];
		const before = readText(progressPath);
		assert.equal(before.match(/Goal implementation paused: The goal run was interrupted by the user\./g)?.length, 1);
		run.handle({ type: "agent-settled", aborted: true }, harness.context());
		assert.equal(readText(progressPath), before);
	});

	test("aborted settlement preserves pause effect rollback and clears its timer", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);
		assert.equal(harness.timer.hasPending(), true);
		harness.setFailRefresh(true);
		const result = run.handle({ type: "agent-settled", aborted: true }, harness.context());
		assert.match(result.failure?.reason ?? "", /Goal run failed; state restored.*refresh exploded/);
		assert.equal(run.getState().status, "active");
		assert.equal(createGoalLifecycle(cwd, harness.deps).getState().status, "active");
		assert.equal(harness.timer.hasPending(), false);
		harness.timer.fire();
		assert.equal(harness.sent.length, 0);
	});

	test("an aborted turn pauses immediately", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);

		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "progress-tool-called" }, harness.context());
		const result = run.handle({ type: "turn-end", stopReason: "aborted" }, harness.context());
		assert.equal(result.rejection, undefined);
		assert.equal(run.getState().status, "paused");
		assert.equal(run.getState().impl.pausedReason, "The goal run was interrupted by the user.");
		assert.match(readText(getPaths(cwd).files["progress.md"]), /Goal implementation paused: The goal run was interrupted by the user\./);
	});

	test("a continuation is discarded when Pi becomes busy before the timer fires", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);

		harness.setIdle(false);
		harness.timer.fire();

		assert.equal(harness.sent.length, 0);
		assert.equal(run.getState().status, "active");
	});

	test("a stale extension context discards the continuation fail-closed", () => {
		const cwd = makeCwd();
		const harness = createHarness({ failIdleCheck: true });
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);
		harness.timer.fire();

		assert.equal(harness.sent.length, 0);
		assert.equal(run.getState().status, "active");
	});

	test("a continuation firing after pause sends nothing", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);
		assert.equal(harness.timer.hasPending(), true);

		run.handle({ type: "pause", params: { reason: "blocked" } }, harness.context());
		assert.equal(harness.timer.hasPending(), false);
		harness.timer.fire();

		assert.equal(harness.sent.length, 0);
	});

	test("a failed continuation delivery pauses the run and keeps the retry path deterministic", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness); // schedules the continuation

		harness.setFailSends(true);
		harness.timer.fire();
		harness.setFailSends(false);

		// The stall is visible: paused with a diagnostic reason, timer cleared, warning shown.
		assert.equal(run.getState().status, "paused");
		assert.match(run.getState().impl.pausedReason, /Continuation delivery failed/);
		assert.equal(harness.timer.hasPending(), false);
		assert.ok(harness.log.some((line) => line.startsWith("notify:warning:")));
		assert.equal(harness.sent.length, 0); // the continuation message itself never went out

		// Retry is deterministic: /plan-goal-impl resumes the same run and schedules again.
		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(run.getState().status, "active");
		assert.equal(run.getState().impl.runId, 1);
		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
		run.handle({ type: "agent-settled" }, harness.context());
		assert.equal(harness.timer.hasPending(), true);
	});

	test("continuation recovery keeps the paused commit when the progress append fails", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);

		harness.setFailSends(true);
		// progress.md becomes unwritable so the pause diagnostics fail after the commit.
		const progressPath = getPaths(cwd).files["progress.md"];
		fs.rmSync(progressPath, { force: true });
		fs.mkdirSync(progressPath);
		harness.timer.fire();
		harness.setFailSends(false);

		// The committed pause survives the diagnostic failure.
		assert.equal(run.getState().status, "paused");
		assert.match(run.getState().impl.pausedReason, /Continuation delivery failed/);
		assert.equal(harness.timer.hasPending(), false);
		assert.equal(createGoalLifecycle(cwd, harness.deps).getState().status, "paused"); // persisted

		// Retry is deterministic: /plan-goal-impl resumes the same run.
		fs.rmSync(progressPath, { recursive: true, force: true });
		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(run.getState().status, "active");
		assert.equal(run.getState().impl.runId, 1);
	});

	test("continuation recovery keeps the paused commit when the warning notification fails", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);

		harness.setFailSends(true);
		harness.setFailNotify(true);
		harness.timer.fire();
		harness.setFailSends(false);
		harness.setFailNotify(false);

		assert.equal(run.getState().status, "paused");
		assert.match(run.getState().impl.pausedReason, /Continuation delivery failed/);
		assert.equal(harness.timer.hasPending(), false);
		assert.equal(createGoalLifecycle(cwd, harness.deps).getState().status, "paused");

		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(run.getState().status, "active");
		assert.equal(run.getState().impl.runId, 1);
	});

	test("continuation recovery keeps the paused commit when the UI refresh fails", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);

		harness.setFailSends(true);
		harness.setFailRefresh(true);
		harness.timer.fire();
		harness.setFailSends(false);
		harness.setFailRefresh(false);

		assert.equal(run.getState().status, "paused");
		assert.match(run.getState().impl.pausedReason, /Continuation delivery failed/);
		assert.equal(harness.timer.hasPending(), false);
		assert.equal(createGoalLifecycle(cwd, harness.deps).getState().status, "paused");

		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(run.getState().status, "active");
		assert.equal(run.getState().impl.runId, 1);
	});

	test("a failed recovery commit leaves a re-sendable recovery intent for /plan-goal-impl", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);

		harness.setFailSends(true);
		// Break the goal-state storage so the pause recovery commit fails too.
		fs.chmodSync(getPaths(cwd).root, 0o555);
		harness.timer.fire();
		harness.setFailSends(false);

		// Both delivery and the recovery commit failed: still active (memory
		// and disk agree), no timer, no continuation sent, stall is visible.
		assert.equal(run.getState().status, "active");
		assert.equal(harness.timer.hasPending(), false);
		assert.equal(harness.sent.length, 0);
		assert.ok(harness.log.some((line) => line.startsWith("notify:warning:")));

		// Restore storage; the warning's command now actually recovers the run
		// by re-sending the same run's continuation.
		fs.chmodSync(getPaths(cwd).root, 0o755);
		const result = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(result.failure, undefined);
		assert.equal(result.rejection, undefined);
		assert.equal(run.getState().status, "active");
		assert.equal(run.getState().impl.runId, 1);
		assert.equal(harness.sent.length, 1);
		assert.equal(harness.sent[0]?.message.customType, MESSAGE_TYPE_CONTINUATION);
		assert.match(harness.sent[0]?.message.content, /runId=1/);

		// The recovery intent is consumed: a second request is a true no-op.
		const before = run.getState();
		const again = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(again.failure, undefined);
		assert.deepEqual(run.getState(), before);
		assert.equal(harness.sent.length, 1);
	});

	test("agent start cancels a settled continuation before it can fire", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);

		run.handle({ type: "agent-start" }, harness.context());
		assert.equal(harness.timer.hasPending(), false);
		harness.timer.fire();

		assert.equal(harness.sent.length, 0);
	});

	test("successful completion finalizes the workspace, clears the timer, and releases Q&A suppression", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		settleWithProgress(run, harness);
		assert.equal(harness.timer.hasPending(), true);
		const paths = getPaths(cwd);

		const result = run.handle({ type: "complete", params: { summary: "done", evidence: ["tests pass"] } }, harness.context());
		assert.equal(result.failure, undefined);
		assert.equal(run.getState().status, "complete");
		assert.equal(hasActiveGoal(cwd), false);
		assert.equal(harness.timer.hasPending(), false);
		assert.match(readText(paths.files["task_plan.md"]), /## Current Phase\nComplete/);
		assert.match(readText(paths.files["progress.md"]), /done \| evidence: tests pass/);
	});

	test("failed completion finalization rolls back lifecycle and transient gates", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		settleWithProgress(run, harness);
		const paths = getPaths(cwd);

		writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 1\n\n## Blocker\nold\n\n## Blocker\nduplicate\n");
		const originalTaskPlan = readText(paths.files["task_plan.md"]);
		const originalProgress = readText(paths.files["progress.md"]);

		const result = run.handle({ type: "complete", params: { summary: "should roll back" } }, harness.context());

		assert.ok(result.failure);
		assert.equal(run.getState().status, "active");
		assert.equal(hasActiveGoal(cwd), true);
		assert.equal(run.turnStoppedBy(), null);
		assert.equal(harness.timer.hasPending(), false);
		// The failed completion must not leak partial finalization into the workspace.
		assert.equal(readText(paths.files["task_plan.md"]), originalTaskPlan);
		assert.equal(readText(paths.files["progress.md"]), originalProgress);
	});

	test("missing progress.md returns a clear failure and rolls completion back to active", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);

		writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 1\n");
		fs.rmSync(paths.files["progress.md"], { force: true });

		const result = run.handle({ type: "complete", params: { summary: "cannot finish" } }, harness.context());
		assert.match(result.failure?.reason ?? "", /progress.md is required/);
		assert.equal(run.getState().status, "active");
		assert.equal(hasActiveGoal(cwd), true);
	});

	test("agent settlement refreshes a paused widget without restoring task-plan next actions", () => {
		const cwd = makeCwd();
		initializePlanningWorkspace(cwd);
		writeGoalState(cwd, { ...defaultGoalState(), status: "paused" });
		const paths = getPaths(cwd);
		writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 2/3\n\n## Next Concrete Action\nTask 03\n");
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		let widgetLines = buildWidgetLines(getPlanningSnapshot(cwd, false));
		assert.deepEqual(widgetLines?.filter((line) => /^(goal|phase|next):/.test(line)), [
			"goal: paused",
			"phase: Phase 2/3",
		]);

		// Represents a bash, Python, or custom-tool write with no write/edit tool result.
		writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 4\n\n## Next Concrete Action\nTask 05\n");
		const result = run.handle(
			{ type: "agent-settled" },
			{
				...harness.context(),
				refresh: () => {
					widgetLines = buildWidgetLines(getPlanningSnapshot(cwd, false));
				},
			},
		);
		assert.equal(result.failure, undefined);
		assert.deepEqual(widgetLines?.filter((line) => /^(goal|phase|next):/.test(line)), [
			"goal: paused",
			"phase: Phase 4",
		]);
	});

	test("resume uses externally updated goal and draft without overwriting them", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "pause", params: { reason: "quota" } }, harness.context());
		const external = run.getState();
		external.goal!.constraints = ["Updated delegation policy"];
		external.draft.constraints = ["Updated delegation policy"];
		writeGoalState(cwd, external);
		harness.clearSent();
		const result = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(result.failure, undefined);
		assert.equal(result.rejection, undefined);
		assert.deepEqual(run.getState().goal!.constraints, external.goal!.constraints);
		assert.deepEqual(getPlanningSnapshot(cwd, false).goalState.draft.constraints, external.draft.constraints);
		assert.match(harness.sent[0].message.content, /Updated delegation policy/);
		assert.equal(run.getState().impl.runId, external.impl.runId);
	});

	for (const status of ["paused", "complete"] as const) {
		test(`external ${status} cancels a queued continuation without reviving the run`, () => {
			const cwd = makeCwd();
			const harness = createHarness();
			const run = prepareActive(cwd, harness);
			harness.clearSent();
			settleWithProgress(run, harness);
			writeGoalState(cwd, { ...run.getState(), status });
			const before = readText(getPaths(cwd).goalState);
			harness.timer.fire();
			assert.equal(harness.sent.length, 0);
			assert.equal(run.getState().status, status);
			assert.equal(readText(getPaths(cwd).goalState), before);
		});
	}

	test("contract-only disk updates preserve progress and refresh the continuation prompt", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		run.handle({ type: "progress-tool-called" }, harness.context());
		const external = run.getState();
		external.goal!.constraints = ["Use the new policy"];
		writeGoalState(cwd, external);
		run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
		run.handle({ type: "agent-settled" }, harness.context());
		assert.equal(harness.timer.hasPending(), true);
		harness.timer.fire();
		assert.equal(harness.sent.length, 1);
		assert.match(harness.sent[0].message.content, /Use the new policy/);
	});

	test("sync imports external state without resetting the turn-stop gate", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareDraft(cwd, harness);
		run.handle({ type: "commit", params: contractParams }, harness.context());
		const external = run.getState();
		external.goal!.constraints = ["Latest constraint"];
		writeGoalState(cwd, external);
		const result = run.handle({ type: "sync" }, harness.context());
		assert.equal(result.failure, undefined);
		assert.deepEqual(run.getState().goal!.constraints, external.goal!.constraints);
		assert.equal(run.turnStoppedBy(), "commit_plan_goal");
	});

	test("an external run change cannot inherit old progress or a pending continuation", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);
		const external = run.getState();
		external.impl.runId++;
		writeGoalState(cwd, external);
		run.handle({ type: "sync" }, harness.context());
		assert.equal(harness.timer.hasPending(), false);
		run.handle({ type: "agent-settled" }, harness.context());
		harness.timer.fire();
		assert.equal(harness.sent.length, 0);
	});

	for (const badState of ["{", "null", "{}", "[]"]) {
		test(`invalid state ${badState} is not overwritten by sync, resume or continuation`, () => {
			const cwd = makeCwd();
			const harness = createHarness();
			const run = prepareActive(cwd, harness);
			harness.clearSent();
			settleWithProgress(run, harness);
			const before = run.getState();
			writeText(getPaths(cwd).goalState, badState);
			harness.timer.fire();
			for (const type of ["sync", "implementation-request", "agent-settled"] as const) {
				const result = run.handle({ type }, harness.context());
				assert.equal(result.failure?.operation, "state-sync");
			}
			assert.equal(readText(getPaths(cwd).goalState), badState);
			assert.deepEqual(run.getState(), before);
			assert.equal(harness.sent.length, 0);
			assert.equal(harness.timer.hasPending(), false);
			assert.ok(harness.log.some((line) => line.startsWith("notify:warning:")));
			writeGoalState(cwd, before);
			assert.equal(run.handle({ type: "implementation-request" }, harness.context()).failure, undefined);
			assert.equal(harness.sent.length, 1);
		});
	}

	test("deleted state is not recreated from stale memory", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		fs.rmSync(getPaths(cwd).goalState);
		const result = run.handle({ type: "pause", params: { reason: "do not recreate" } }, harness.context());
		assert.equal(result.failure?.operation, "state-sync");
		assert.equal(fileExists(getPaths(cwd).goalState), false);
	});

	test("effect rollback preserves the externally updated contract", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareDraft(cwd, harness);
		run.handle({ type: "commit", params: contractParams }, harness.context());
		const external = run.getState();
		external.goal!.constraints = ["Keep the revised contract on failure"];
		writeGoalState(cwd, external);
		harness.setFailSends(true);
		const result = run.handle({ type: "implementation-request" }, harness.context());
		assert.match(result.failure?.reason ?? "", /state restored/);
		assert.equal(run.getState().status, "ready");
		assert.deepEqual(getPlanningSnapshot(cwd, false).goalState.goal!.constraints, external.goal!.constraints);
	});

	test("sync failure before timer firing keeps an explicit recovery path after repair", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);
		const before = run.getState();
		writeText(getPaths(cwd).goalState, "{");
		assert.equal(run.handle({ type: "sync" }, harness.context()).failure?.operation, "state-sync");
		assert.equal(harness.timer.hasPending(), false);
		writeGoalState(cwd, before);
		assert.equal(run.handle({ type: "implementation-request" }, harness.context()).failure, undefined);
		assert.equal(harness.sent.length, 1);
		assert.equal(harness.sent[0].message.customType, MESSAGE_TYPE_CONTINUATION);
		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(harness.sent.length, 1);
	});

	test("a new turn releases the previous stop gate even when goal state is unreadable", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "pause", params: { reason: "quota" } }, harness.context());
		writeText(getPaths(cwd).goalState, "{");
		run.handle({ type: "sync" }, harness.context());
		assert.equal(run.turnStoppedBy(), "pause_plan_goal"); // same turn remains stopped
		const result = run.handle({ type: "turn-start" }, harness.context());
		assert.equal(result.failure?.operation, "state-sync");
		assert.equal(run.turnStoppedBy(), null); // the next turn can repair the file
		assert.equal(readText(getPaths(cwd).goalState), "{");
	});

	for (const status of ["ready", "paused"] as const) {
		test(`${status} implementation input is request-local, not durable state or automatic continuation input`, () => {
			const cwd = makeCwd();
			const harness = createHarness();
			const run = prepareDraft(cwd, harness);
			run.handle({ type: "commit", params: contractParams }, harness.context());
			if (status === "paused") {
				run.handle({ type: "implementation-request" }, harness.context());
				run.handle({ type: "pause", params: { reason: "额度耗尽", suggestedAction: "等待重置" } }, harness.context());
			}
			harness.clearSent();
			const input = "我使用重置卡，额度已恢复\n  请核验后继续。";
			const result = run.handle({ type: "implementation-request", supplementalInput: ` \n${input}\n ` }, harness.context());
			assert.deepEqual(result, { rejection: undefined, failure: undefined });
			assert.equal(run.getState().status, "active");
			assert.equal(run.getState().impl.runId, 1);
			assert.equal(harness.sent.length, 1);
			assert.ok(harness.sent[0].message.content.includes(`Current user supplement for this implementation request:\n${input}\n`));
			assert.deepEqual(harness.sent[0].options, { triggerTurn: true });
			assert.equal(harness.sent[0].message.display, false);
			assert.deepEqual(run.getState().goal, contractParams);
			assert.ok(!JSON.stringify(run.getState()).includes(input.split("\n")[0]));
			assert.ok(!readText(getPaths(cwd).goalState).includes(input.split("\n")[0]));
			assert.ok(!readText(getPaths(cwd).goalState).includes('"supplementalInput"'));
			if (status === "paused") assert.match(readText(getPaths(cwd).files["progress.md"]), /Goal paused: 额度耗尽/);

			run.handle({ type: "agent-start" }, harness.context());
			run.handle({ type: "turn-start" }, harness.context());
			settleWithProgress(run, harness);
			harness.timer.fire();
			assert.equal(harness.sent.length, 2);
			assert.equal(harness.sent[1].message.customType, MESSAGE_TYPE_CONTINUATION);
			assert.doesNotMatch(harness.sent[1].message.content, /Current user supplement|重置卡/);

			// Neither a later resume nor a different implementation run re-injects the input.
			run.handle({ type: "pause", params: { reason: "other blocker" } }, harness.context());
			run.handle({ type: "implementation-request", supplementalInput: " \t\n　" }, harness.context());
			assert.doesNotMatch(harness.sent.at(-1)!.message.content, /Current user supplement|重置卡/);
			run.handle({ type: "start-drafting", input: "new goal" }, harness.context());
			run.handle({ type: "commit", params: contractParams }, harness.context());
			run.handle({ type: "implementation-request" }, harness.context());
			assert.equal(run.getState().impl.runId, 2);
			assert.doesNotMatch(harness.sent.at(-1)!.message.content, /Current user supplement|重置卡/);
		});

		for (const retryInput of [undefined, "本次重试补充\n请重新核验"] as const) {
			test(`${status} send failure rolls back and retries with only the new input (${retryInput ? "supplied" : "omitted"})`, () => {
				const cwd = makeCwd();
				const harness = createHarness();
				const run = prepareDraft(cwd, harness);
				run.handle({ type: "commit", params: contractParams }, harness.context());
				if (status === "paused") {
					run.handle({ type: "implementation-request" }, harness.context());
					run.handle({ type: "pause", params: { reason: "额度耗尽" } }, harness.context());
				}
				const before = run.getState();
				harness.clearSent();
				harness.setFailSends(true);
				const failed = run.handle({ type: "implementation-request", supplementalInput: "失败请求的补充" }, harness.context());
				assert.match(failed.failure?.reason ?? "", /state restored/);
				assert.deepEqual(run.getState(), before);
				// Rollback persists the prior contract/run with a fresh write timestamp.
				assert.deepEqual({ ...createGoalLifecycle(cwd, harness.deps).getState(), updatedAt: before.updatedAt }, before);
				assert.equal(harness.sent.length, 0);
				assert.equal(harness.timer.hasPending(), false);
				harness.setFailSends(false);
				const retry = run.handle({ type: "implementation-request", supplementalInput: retryInput }, harness.context());
				assert.deepEqual(retry, { rejection: undefined, failure: undefined });
				assert.equal(run.getState().impl.runId, 1);
				assert.equal(harness.sent.length, 1);
				assert.doesNotMatch(harness.sent[0].message.content, /失败请求的补充/);
				if (retryInput) assert.ok(harness.sent[0].message.content.includes(retryInput));
				else assert.doesNotMatch(harness.sent[0].message.content, /Current user supplement/);
			});
		}
	}

	test("active input rejection preserves state and pending continuation; blank input stays a no-op", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		settleWithProgress(run, harness);
		harness.clearSent();
		const before = run.getState();
		const diskBefore = readText(getPaths(cwd).goalState);
		const logBefore = [...harness.log];
		const rejected = run.handle({ type: "implementation-request", supplementalInput: "额度已恢复" }, harness.context());
		assert.equal(rejected.rejection?.operation, "plan-goal-impl");
		assert.match(rejected.rejection?.reason ?? "", /not accepted.*normal message.*pause.*plan-goal-impl/);
		assert.equal(rejected.failure, undefined);
		const blank = run.handle({ type: "implementation-request", supplementalInput: " \t\n　" }, harness.context());
		assert.deepEqual(blank, { rejection: undefined, failure: undefined });
		assert.deepEqual(run.getState(), before);
		assert.equal(readText(getPaths(cwd).goalState), diskBefore);
		assert.deepEqual(harness.log, logBefore);
		assert.equal(harness.sent.length, 0);
		assert.equal(harness.timer.hasPending(), true);
		harness.timer.fire();
		assert.equal(harness.sent.length, 1);
		assert.doesNotMatch(harness.sent[0].message.content, /Current user supplement|额度已恢复/);
	});

	for (const retryInput of [undefined, "恢复重发补充\n额度已恢复"] as const) {
		test(`active recovery send failures remain retryable without caching input (${retryInput ? "supplied" : "omitted"})`, () => {
			const cwd = makeCwd();
			const harness = createHarness();
			const run = prepareActive(cwd, harness);
			harness.clearSent();
			settleWithProgress(run, harness);
			const before = run.getState();
			writeText(getPaths(cwd).goalState, "{");
			harness.timer.fire();
			const repaired = writeGoalState(cwd, before);
			harness.setFailSends(true);
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = run.handle({ type: "implementation-request", supplementalInput: "未发送的旧补充" }, harness.context());
				assert.match(result.failure?.reason ?? "", /state preserved.*send exploded/);
				assert.deepEqual(run.getState(), repaired);
				assert.equal(harness.sent.length, 0);
				assert.equal(harness.timer.hasPending(), false);
			}
			harness.setFailSends(false);
			const result = run.handle({ type: "implementation-request", supplementalInput: retryInput }, harness.context());
			assert.deepEqual(result, { rejection: undefined, failure: undefined });
			assert.deepEqual(run.getState(), repaired);
			assert.deepEqual(createGoalLifecycle(cwd, harness.deps).getState(), repaired);
			assert.equal(harness.sent.length, 1);
			assert.equal(harness.sent[0].message.customType, MESSAGE_TYPE_CONTINUATION);
			assert.deepEqual(harness.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
			assert.doesNotMatch(harness.sent[0].message.content, /未发送的旧补充/);
			if (retryInput) assert.ok(harness.sent[0].message.content.includes(retryInput));
			else assert.doesNotMatch(harness.sent[0].message.content, /Current user supplement/);
			run.handle({ type: "implementation-request" }, harness.context());
			assert.equal(harness.sent.length, 1); // Recovery consumed only by successful delivery.
			run.handle({ type: "agent-start" }, harness.context());
			run.handle({ type: "turn-start" }, harness.context());
			settleWithProgress(run, harness);
			harness.timer.fire();
			assert.equal(harness.sent.length, 2);
			assert.doesNotMatch(harness.sent[1].message.content, /Current user supplement|恢复重发补充|未发送的旧补充/);
		});
	}
});
