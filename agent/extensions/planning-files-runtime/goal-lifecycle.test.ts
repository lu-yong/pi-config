import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import {
	createGoalLifecycle,
	type CompletionAuditCall,
	type GoalLifecycle,
	type GoalLifecycleContext,
	type GoalLifecycleEvent,
	type GoalLifecycleResult,
	type OutgoingGoalMessage,
	type OutgoingGoalMessageOptions,
} from "./goal-lifecycle.ts";
import type { AuditModelResult } from "./audit.ts";
import { MESSAGE_TYPE_CONTINUATION, type CompleteGoalParams } from "./types.ts";
import { fileExists, getPaths, readText, writeText } from "./utils.ts";
import { defaultGoalState, hasActiveGoal, readGoalState, writeGoalState } from "./state.ts";
import { initializePlanningWorkspace, readPlanningSections } from "./workspace.ts";
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

// ---- harness: captured messages + scripted context ----

type SentMessage = { message: OutgoingGoalMessage; options: OutgoingGoalMessageOptions };

function createHarness(options: { failSends?: boolean; failNotify?: boolean } = {}) {
	const sent: SentMessage[] = [];
	const log: string[] = [];
	let failSends = options.failSends ?? false;
	let failNotify = options.failNotify ?? false;
	const context = (): GoalLifecycleContext => ({
		notify: (message, level) => {
			if (failNotify) throw new Error("notify exploded");
			log.push(`notify:${level}:${message}`);
		},
	});
	return {
		sent,
		log,
		context,
		deps: {
			sendMessage: (message, sendOptions) => {
				if (failSends) throw new Error("send exploded");
				sent.push({ message, options: sendOptions });
				log.push(`send:${message.customType}`);
			},
		},
		clearSent: () => sent.splice(0),
		setFailSends: (next: boolean) => (failSends = next),
		setFailNotify: (next: boolean) => (failNotify = next),
	};
}

type Harness = ReturnType<typeof createHarness>;

// ---- canned completion-audit transports (the model port, scripted) ----

const auditUsage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };

const auditModel = (result: AuditModelResult): CompletionAuditCall => async () => result;

/** A host with no auditor at all: the transport itself reports the failure. */
const noAuditor: CompletionAuditCall = async () => ({ kind: "failed", reason: "no model is available for the completion audit" });

/** Complete through the lifecycle interface (audit included) with a canned transport. */
const complete = (run: GoalLifecycle, params: CompleteGoalParams, harness: Harness, modelCall: CompletionAuditCall = noAuditor) =>
	run.complete(params, harness.context(), { modelCall });

/** Decide a settled run's continuation at Pi's before-settle boundary. */
function decideContinuation(run: GoalLifecycle, harness: Harness, outcome: "completed" | "aborted" | "error" = "completed"): OutgoingGoalMessage | undefined {
	const result = run.handle({ type: "before-settle", outcome }, harness.context());
	assert.equal(result.error, undefined);
	return result.continuation?.message;
}

/** The goal as the lifecycle currently sees it — read the way a host would, through the projection. */
const stateOf = (run: GoalLifecycle) => run.view().projection.goalState;

/** An accepted operation that asks nothing more of the host: no error, continuation, or audit — only the projection. */
function assertAcceptedQuietly(result: GoalLifecycleResult): void {
	const { projection, ...outcome } = result;
	assert.deepEqual(outcome, { error: undefined });
	assert.ok(projection);
}

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

/** One productive settled turn: a progress tool call, a completed turn, and the boundary decision. */
function settleWithProgress(run: GoalLifecycle, harness: Harness): OutgoingGoalMessage | undefined {
	run.handle({ type: "progress-tool-called" }, harness.context());
	run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
	return decideContinuation(run, harness);
}

describe("goal lifecycle", () => {
	test("covers the lifecycle transitions and materializes the planning workspace", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		const paths = getPaths(cwd);

		let result = run.handle({ type: "start-drafting", input: "goal run" }, harness.context());
		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "drafting");
		assert.equal(fileExists(paths.goalDesign), true);

		run.handle({ type: "save-draft", params: contractParams }, harness.context());
		result = run.handle({ type: "commit", params: contractParams }, harness.context());
		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "ready");

		result = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "active");
		assert.equal(stateOf(run).impl.runId, 1);
		assert.equal(fileExists(paths.files["task_plan.md"]), true);
		assert.match(readText(paths.files["progress.md"]), /Goal implementation started \(run 1\)/);

		result = run.handle({
			type: "pause",
			params: { reason: "external dependency unavailable", suggestedAction: "Restore the dependency, then retry." },
		}, harness.context());
		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "paused");
		assert.equal(stateOf(run).impl.pausedSuggestedAction, "Restore the dependency, then retry.");
		assert.match(readText(paths.files["progress.md"]), /Goal paused: external dependency unavailable/);

		result = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(stateOf(run).status, "active");
		assert.equal(stateOf(run).impl.runId, 1);
		assert.equal(stateOf(run).impl.pausedSuggestedAction, "");

		result = await complete(run, { summary: "Lifecycle is complete" }, harness);
		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "complete");
		assert.match(readText(paths.files["task_plan.md"]), /## Current Phase\nComplete/);
		assert.match(readText(paths.files["progress.md"]), /Lifecycle is complete/);
	});

	test("rejects every illegal lifecycle operation without mutating state", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		const assertRejected = (event: GoalLifecycleEvent, operation: string) => {
			const before = stateOf(run);
			const result = run.handle(event, harness.context());
			assert.equal(result.error?.operation, operation);
			assert.deepEqual(stateOf(run), before);
		};

		assertRejected({ type: "save-draft", params: { objective: "not allowed yet" } }, "save_plan_goal_draft");
		assertRejected({ type: "commit", params: contractParams }, "commit_plan_goal");
		assertRejected({ type: "implementation-request" }, "plan-goal-impl");
		assertRejected({ type: "pause", params: { reason: "blocked" } }, "pause_plan_goal");
		{
			const before = stateOf(run);
			const result = await run.complete({ summary: "not active" }, harness.context(), { modelCall: noAuditor });
			assert.equal(result.error?.operation, "complete_plan_goal");
			assert.deepEqual(stateOf(run), before);
		}

		run.handle({ type: "start-drafting", input: "goal" }, harness.context());
		assertRejected({ type: "implementation-request" }, "plan-goal-impl");
		// The stored contract comes from the tool params, so a commit with a
		// complete contract succeeds even while the saved draft is still partial.
		const committed = run.handle({ type: "commit", params: contractParams }, harness.context());
		assert.equal(committed.error, undefined);
		assert.equal(stateOf(run).status, "ready");
	});

	test("active repeated implementation requests are a true no-op", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const before = stateOf(run);
		const result = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(result.error, undefined);
		assert.deepEqual(stateOf(run), before);
	});

	test("ready starts a new run while paused resumes the existing run", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		assert.equal(stateOf(run).impl.runId, 1);
		run.handle({ type: "pause", params: { reason: "pause" } }, harness.context());
		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(stateOf(run).impl.runId, 1);
		await complete(run, { summary: "done" }, harness);

		// A new drafting/commit cycle returns to ready; the next implementation is run 2.
		run.handle({ type: "start-drafting", input: "second run" }, harness.context());
		run.handle({ type: "save-draft", params: contractParams }, harness.context());
		run.handle({ type: "commit", params: contractParams }, harness.context());
		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(stateOf(run).status, "active");
		assert.equal(stateOf(run).impl.runId, 2);
	});

	test("restore reloads persisted state", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		prepareActive(cwd, harness);

		const restored = createGoalLifecycle(cwd, harness.deps);
		assert.equal(stateOf(restored).status, "active");
		const result = restored.handle({ type: "restore" }, harness.context());
		assert.equal(result.error, undefined);
		assert.equal(stateOf(restored).status, "active");
	});

	test("turn stop gate is held by the lifecycle and cleared at turn start", async () => {
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
		await complete(run, { summary: "done" }, harness);
		assert.equal(run.turnStoppedBy(), "complete_plan_goal");
	});

	test("a failing effect reports the error and keeps the already-persisted transition", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareDraft(cwd, harness);
		run.handle({ type: "commit", params: contractParams }, harness.context());
		assert.equal(stateOf(run).status, "ready");
		const paths = getPaths(cwd);

		harness.setFailSends(true);
		const result = run.handle({ type: "implementation-request" }, harness.context());
		harness.setFailSends(false);

		assert.match(result.error?.reason ?? "", /Goal operation failed: send exploded/);
		// The transition was already persisted and is kept; effects before the failing send stay applied too.
		assert.equal(stateOf(run).status, "active");
		assert.equal(stateOf(createGoalLifecycle(cwd, harness.deps)).status, "active");
		assert.equal(fileExists(paths.files["task_plan.md"]), true);
		assert.match(readText(paths.files["progress.md"]), /Goal implementation started \(run 1\)/);
	});

	test("a failed first archive is retried after pause and reload before using the new goal", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		initializePlanningWorkspace(cwd, { ...contractParams, objective: "OLD GOAL" }, 0);
		let run = prepareDraft(cwd, harness);
		run.handle({ type: "commit", params: contractParams }, harness.context());
		run.handle({ type: "turn-start" }, harness.context());
		const paths = getPaths(cwd);
		const oldPlan = readText(paths.files["task_plan.md"]);
		writeText(paths.archiveRoot, "block archive directory");
		harness.clearSent();

		const failed = run.handle({ type: "implementation-request" }, harness.context());
		assert.match(failed.error?.reason ?? "", /Pause the run first/);
		assert.equal(readGoalState(cwd).impl.planningResetRequired, true);
		assert.equal(stateOf(run).impl.initializedAt, null);
		assert.equal(harness.sent.length, 0);
		assert.equal(settleWithProgress(run, harness), undefined);
		let audits = 0;
		const completion = await complete(run, { summary: "must not finish the old workspace" }, harness, async () => {
			audits++;
			return { kind: "failed", reason: "unexpected audit" };
		});
		assert.match(completion.error?.reason ?? "", /initialization is incomplete/);
		assert.equal(audits, 0);

		fs.rmSync(paths.archiveRoot);
		assert.equal(run.handle({ type: "pause", params: { reason: "archive repaired" } }, harness.context()).error, undefined);
		run = createGoalLifecycle(cwd, harness.deps);
		const resumed = run.handle({ type: "implementation-request", supplementalInput: "storage repaired" }, harness.context());
		assert.equal(resumed.error, undefined);
		assert.equal(stateOf(run).status, "active");
		assert.equal(stateOf(run).impl.runId, 1);
		assert.equal(readGoalState(cwd).impl.planningResetRequired, false);
		assert.ok(stateOf(run).impl.initializedAt);
		assert.equal(readPlanningSections(cwd).goalFromPlan, contractParams.objective);
		const archives = fs.readdirSync(paths.archiveRoot);
		assert.equal(archives.length, 1);
		assert.equal(readText(path.join(paths.archiveRoot, archives[0]!, "task_plan.md")), oldPlan);
		assert.equal(harness.sent.length, 1);
		assert.doesNotMatch(harness.sent[0]!.message.content, /OLD GOAL/);
		assert.match(harness.sent[0]!.message.content, /storage repaired/);
	});

	test("resume rebuilds all templates after initialization only wrote the task plan", (t) => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareDraft(cwd, harness);
		run.handle({ type: "commit", params: contractParams }, harness.context());
		const paths = getPaths(cwd);
		const writeFile = fs.writeFileSync;
		const write = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
			if (args[0] === paths.files["findings.md"]) throw new Error("findings write failed");
			return writeFile(...args);
		});
		const failed = run.handle({ type: "implementation-request" }, harness.context());
		write.mock.restore();
		assert.match(failed.error?.reason ?? "", /findings write failed/);
		assert.equal(fileExists(paths.files["task_plan.md"]), true);
		assert.equal(fileExists(paths.files["findings.md"]), false);
		assert.equal(readGoalState(cwd).impl.planningResetRequired, true);

		run.handle({ type: "pause", params: { reason: "storage repaired" } }, harness.context());
		harness.clearSent();
		const resumed = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(resumed.error, undefined);
		assert.equal(stateOf(run).impl.runId, 1);
		assert.equal(readGoalState(cwd).impl.planningResetRequired, false);
		for (const name of ["task_plan.md", "findings.md", "progress.md"] as const) {
			assert.ok(readText(paths.files[name]).includes(contractParams.objective));
		}
		assert.equal(harness.sent.length, 1);
	});

	test("an unreadable goal-state path does not publish the transition and a repaired retry is not a no-op", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		run.handle({ type: "start-drafting", input: "goal" }, harness.context());
		run.handle({ type: "save-draft", params: contractParams }, harness.context());
		run.handle({ type: "commit", params: contractParams }, harness.context());
		assert.equal(stateOf(run).status, "ready");
		const goalStatePath = getPaths(cwd).goalState;

		// Make .goal-state.json unwritable: a directory sits where the file must be written.
		fs.rmSync(goalStatePath, { force: true });
		fs.mkdirSync(goalStatePath);

		const result = run.handle({ type: "implementation-request" }, harness.context());
		assert.match(result.error?.reason ?? "", /Goal run failed/);
		assert.equal(stateOf(run).status, "ready"); // memory never published
		assert.equal(hasActiveGoal(cwd), false);

		// Once the storage problem is removed, the request proceeds instead of being an active no-op.
		fs.rmSync(goalStatePath, { recursive: true, force: true });
		writeGoalState(cwd, stateOf(run)); // restore the file, not just directory access
		const retry = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(retry.error, undefined);
		assert.equal(stateOf(run).status, "active");
		assert.equal(stateOf(run).impl.runId, 1);
	});

	test("an unreadable goal-state path during completion leaves the run active and the workspace untouched", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "turn-start" }, harness.context()); // clear the commit stop gate like a real turn would
		const paths = getPaths(cwd);
		settleWithProgress(run, harness);
		const goalStatePath = getPaths(cwd).goalState;

		fs.rmSync(goalStatePath, { force: true });
		fs.mkdirSync(goalStatePath);

		const result = await complete(run, { summary: "cannot persist" }, harness);
		assert.match(result.error?.reason ?? "", /Goal run failed/);
		assert.equal(stateOf(run).status, "active");
		assert.equal(run.turnStoppedBy(), null);
		assert.match(readText(paths.files["task_plan.md"]), /## Current Phase\nPhase 1/); // workspace not finalized

		// Retrying after the storage problem is fixed completes normally.
		fs.rmSync(goalStatePath, { recursive: true, force: true });
		writeGoalState(cwd, stateOf(run));
		const retry = await complete(run, { summary: "cannot persist" }, harness);
		assert.equal(retry.error, undefined);
		assert.equal(stateOf(run).status, "complete");
	});

	test("a failed atomic goal-state write leaves the prior file intact", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		run.handle({ type: "start-drafting", input: "goal" }, harness.context());
		run.handle({ type: "save-draft", params: contractParams }, harness.context());
		run.handle({ type: "commit", params: contractParams }, harness.context());
		assert.equal(stateOf(run).status, "ready");
		const goalStatePath = getPaths(cwd).goalState;
		const original = readText(goalStatePath);
		assert.ok(original.length > 0);

		// A read-only planning directory makes the atomic temp write fail
		// before the destination can be truncated.
		fs.chmodSync(getPaths(cwd).root, 0o555);
		try {
			const result = run.handle({ type: "implementation-request" }, harness.context());
			assert.match(result.error?.reason ?? "", /Goal operation failed/);
			assert.equal(stateOf(run).status, "ready");
			assert.equal(readText(goalStatePath), original); // destination untouched
		} finally {
			fs.chmodSync(getPaths(cwd).root, 0o755);
		}

		// The prior goal state is still loadable after the failure.
		assert.equal(stateOf(createGoalLifecycle(cwd, harness.deps)).status, "ready");
	});

	test("a settled run with progress returns exactly one continuation at the boundary and consumes the progress", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();

		const continuation = settleWithProgress(run, harness);
		assert.ok(continuation);
		assert.equal(continuation.customType, MESSAGE_TYPE_CONTINUATION);
		assert.equal(continuation.display, false);
		assert.match(continuation.content, /mode=continue/);
		// The decision is returned as data: nothing is sent through the adapter.
		assert.equal(harness.sent.length, 0);
		assert.equal(stateOf(run).status, "active");

		// Progress was consumed: a repeat boundary without new work does not continue again.
		run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
		assert.equal(decideContinuation(run, harness), undefined);
		assert.equal(stateOf(run).status, "active");
	});

	test("a run that goes quiet without progress does not continue", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
		assert.equal(decideContinuation(run, harness), undefined);
		assert.equal(stateOf(run).status, "active");
	});

	test("a terminal provider error pauses the goal at the boundary", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();

		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "error", errorMessage: "provider overloaded" }, harness.context());
		const result = run.handle({ type: "before-settle", outcome: "error" }, harness.context());
		assert.equal(result.error, undefined);
		assert.equal(result.continuation, undefined);
		assert.equal(stateOf(run).status, "paused");
		assert.match(stateOf(run).impl.pausedReason, /will not retry automatically: provider overloaded/);
		assert.ok(harness.log.some((line) => line.startsWith("notify:warning:")));
	});

	test("a successful native retry preserves earlier tool progress", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);

		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "error", errorMessage: "temporary overload" }, harness.context());

		// Pi starts a low-level retry run; only a settled run reaches the boundary.
		run.handle({ type: "agent-start" }, harness.context());
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
		assert.ok(decideContinuation(run, harness));
		assert.equal(stateOf(run).status, "active");
	});

	test("aborted settlement pauses the still-active run and pauses only once", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);

		const result = run.handle({ type: "agent-settled", aborted: true }, harness.context());
		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "paused");
		assert.equal(stateOf(createGoalLifecycle(cwd, harness.deps)).status, "paused");
		assert.equal(harness.sent.length, 0);
		const progressPath = getPaths(cwd).files["progress.md"];
		const before = readText(progressPath);
		assert.equal(before.match(/Goal implementation paused: The goal run was interrupted by the user\./g)?.length, 1);
		run.handle({ type: "agent-settled", aborted: true }, harness.context());
		assert.equal(readText(progressPath), before);
	});

	test("an aborted turn pauses immediately", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);

		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "progress-tool-called" }, harness.context());
		const result = run.handle({ type: "turn-end", stopReason: "aborted" }, harness.context());
		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "paused");
		assert.equal(stateOf(run).impl.pausedReason, "The goal run was interrupted by the user.");
		assert.match(readText(getPaths(cwd).files["progress.md"]), /Goal implementation paused: The goal run was interrupted by the user\./);
	});

	test("successful completion finalizes the workspace and releases Q&A suppression", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		settleWithProgress(run, harness);
		const paths = getPaths(cwd);

		const result = await complete(run, { summary: "done", evidence: ["tests pass"] }, harness);
		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "complete");
		assert.equal(hasActiveGoal(cwd), false);
		// A later boundary cannot continue a completed goal.
		assert.equal(decideContinuation(run, harness), undefined);
		assert.match(readText(paths.files["task_plan.md"]), /## Current Phase\nComplete/);
		assert.match(readText(paths.files["progress.md"]), /done \| evidence: tests pass/);
	});

	test("failed completion finalization keeps the run active and succeeds after the plan is repaired", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		settleWithProgress(run, harness);
		run.handle({ type: "turn-start" }, harness.context());
		const paths = getPaths(cwd);

		writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 1\n\n## Blocker\nold\n\n## Blocker\nduplicate\n");
		const originalTaskPlan = readText(paths.files["task_plan.md"]);
		const originalProgress = readText(paths.files["progress.md"]);

		const result = await complete(run, { summary: "cannot finish" }, harness);

		assert.match(result.error?.reason ?? "", /duplicate "## Blocker" headings/);
		assert.match(result.error?.reason ?? "", /current status: active/);
		assert.match(result.error?.reason ?? "", /retry complete_plan_goal/);
		assert.equal(readGoalState(cwd).status, "active");
		assert.equal(run.turnStoppedBy(), null);
		assert.equal(readText(paths.files["task_plan.md"]), originalTaskPlan);
		assert.equal(readText(paths.files["progress.md"]), originalProgress);

		writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 1\n\n## Blocker\n[empty]\n");
		const retry = await complete(run, { summary: "finished", evidence: ["verified"] }, harness);
		assert.equal(retry.error, undefined);
		assert.equal(readGoalState(cwd).status, "complete");
		assert.equal(run.turnStoppedBy(), "complete_plan_goal");
		assert.match(readText(paths.files["task_plan.md"]), /## Current Phase\nComplete/);
		assert.match(readText(paths.files["progress.md"]), /finished \| evidence: verified/);
	});

	test("missing progress.md can be restored before retrying completion", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);

		writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 1\n");
		fs.rmSync(paths.files["progress.md"], { force: true });

		const result = await complete(run, { summary: "cannot finish" }, harness);
		assert.match(result.error?.reason ?? "", /progress.md is required/);
		assert.equal(stateOf(run).status, "active");
		assert.equal(hasActiveGoal(cwd), true);
		writeText(paths.files["progress.md"], "# Progress\n");
		const retry = await complete(run, { summary: "finished" }, harness);
		assert.equal(retry.error, undefined);
		assert.equal(readGoalState(cwd).status, "complete");
		assert.match(readText(paths.files["task_plan.md"]), /## Current Phase\nComplete/);
		assert.match(readText(paths.files["progress.md"]), /finished/);
	});

	test("completion retries a failed state commit without duplicating finalized evidence", async (t) => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "turn-start" }, harness.context());
		const paths = getPaths(cwd);
		const originalState = readText(paths.goalState);
		const renameFile = fs.renameSync;
		const rename = t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
			if (destination === paths.goalState) throw new Error("state commit failed");
			renameFile(source, destination);
		});
		const params = { summary: "finished", evidence: ["verified once"] };
		const failed = await complete(run, params, harness);
		rename.mock.restore();
		assert.match(failed.error?.reason ?? "", /state commit failed/);
		assert.match(failed.error?.reason ?? "", /retry complete_plan_goal/);
		assert.equal(stateOf(run).status, "active");
		assert.equal(run.turnStoppedBy(), null);
		assert.equal(readText(paths.goalState), originalState);
		assert.match(readText(paths.files["task_plan.md"]), /## Current Phase\nComplete/);
		const finalizedProgress = readText(paths.files["progress.md"]);

		const retry = await complete(run, params, harness);
		assert.equal(retry.error, undefined);
		assert.equal(readGoalState(cwd).status, "complete");
		assert.equal(run.turnStoppedBy(), "complete_plan_goal");
		assert.equal(readText(paths.files["progress.md"]), finalizedProgress);
		assert.equal(finalizedProgress.split("goal-completion:run-1:evidence").length - 1, 1);
	});

	test("a malformed stored goal cannot bypass completion auditing", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "turn-start" }, harness.context());
		const paths = getPaths(cwd);
		const malformed = JSON.stringify({ ...stateOf(run), goal: { objective: "" } });
		writeText(paths.goalState, malformed);
		const originalPlan = readText(paths.files["task_plan.md"]);
		const result = await complete(run, { summary: "must not complete" }, harness);
		assert.match(result.error?.reason ?? "", /Invalid goal state/);
		assert.equal(stateOf(run).status, "active");
		assert.equal(run.turnStoppedBy(), null);
		assert.equal(readText(paths.goalState), malformed);
		assert.equal(readText(paths.files["task_plan.md"]), originalPlan);
	});

	test("agent settlement hands back a fresh paused projection without restoring task-plan next actions", () => {
		const cwd = makeCwd();
		initializePlanningWorkspace(cwd);
		writeGoalState(cwd, { ...defaultGoalState(), status: "paused" });
		const paths = getPaths(cwd);
		writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 2/3\n\n## Next Concrete Action\nTask 03\n");
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		let widgetLines = buildWidgetLines(run.view().projection);
		assert.deepEqual(widgetLines?.filter((line) => /^(state|phase|next):/.test(line)), [
			"state: paused",
			"phase: Phase 2/3",
		]);

		// Represents a bash, Python, or custom-tool write with no write/edit tool result.
		writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 4\n\n## Next Concrete Action\nTask 05\n");
		const result = run.handle({ type: "agent-settled" }, harness.context());
		assert.equal(result.error, undefined);
		widgetLines = buildWidgetLines(result.projection);
		assert.deepEqual(widgetLines?.filter((line) => /^(state|phase|next):/.test(line)), [
			"state: paused",
			"phase: Phase 4",
		]);
	});

	test("every result projects the goal it just decided on beside planning sections fresh from disk", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);
		writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 2\n\n## Blocker\nWaiting on review\nsecond line\n");
		const result = run.handle({ type: "pause", params: { reason: "quota" } }, harness.context());
		assert.equal(result.error, undefined);
		assert.equal(result.projection.goalState.status, "paused");
		assert.equal(result.projection.goalState.impl.pausedReason, "quota");
		assert.equal(result.projection.currentPhase, "Phase 2");
		assert.equal(result.projection.blocker, "Waiting on review");
		assert.equal(result.projection.exists, true);
		assert.equal(result.projection.planningRoot, paths.root);
		// A rejected operation still hands back what there is to display.
		const rejected = run.handle({ type: "pause", params: { reason: "again" } }, harness.context());
		assert.equal(rejected.error?.operation, "pause_plan_goal");
		assert.equal(rejected.projection.goalState.impl.pausedReason, "quota");
		// The inspector asks for whole section bodies through the same reader.
		assert.equal(run.view("full").projection.blocker, "Waiting on review\nsecond line");
		assert.equal(run.view().projection.blocker, "Waiting on review");
	});

	test("an unreadable state file projects the last-known goal, never an empty one, while sections stay fresh", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);
		const before = stateOf(run);
		writeText(paths.goalState, "{");
		writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 3\n");
		const view = run.view();
		assert.equal(view.error?.operation, "state-sync");
		assert.match(view.error?.reason ?? "", /cannot read current goal state/);
		assert.deepEqual(view.projection.goalState, before);
		assert.equal(view.projection.currentPhase, "Phase 3");
		assert.equal(readText(paths.goalState), "{"); // looking never writes
		// Once repaired, the next look is clean again.
		writeGoalState(cwd, { ...before, status: "paused" });
		const repaired = run.view();
		assert.equal(repaired.error, undefined);
		assert.equal(repaired.projection.goalState.status, "paused");
	});

	test("a projection is a detached copy: editing it cannot change the lifecycle", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const { projection } = run.view();
		projection.goalState.status = "complete";
		projection.goalState.goal!.constraints.push("smuggled");
		assert.equal(stateOf(run).status, "active");
		assert.deepEqual(run.view().projection.goalState.goal!.constraints, contractParams.constraints);
	});

	test("the prompt sent to the model describes the same goal the result projects", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "pause", params: { reason: "quota" } }, harness.context());
		const external = stateOf(run);
		external.goal!.objective = "Objective revised on disk";
		writeGoalState(cwd, external);
		harness.clearSent();
		const result = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(result.projection.goalState.goal!.objective, "Objective revised on disk");
		assert.match(harness.sent[0].message.content, /Objective: Objective revised on disk/);
		assert.match(harness.sent[0].message.content, new RegExp(`runId=${result.projection.goalState.impl.runId}\\]`));
	});

	test("resume uses externally updated goal and draft without overwriting them", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "pause", params: { reason: "quota" } }, harness.context());
		const external = stateOf(run);
		external.goal!.constraints = ["Updated delegation policy"];
		external.draft.constraints = ["Updated delegation policy"];
		writeGoalState(cwd, external);
		harness.clearSent();
		const result = run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(result.error, undefined);
		assert.deepEqual(result.projection.goalState.goal!.constraints, external.goal!.constraints);
		assert.deepEqual(result.projection.goalState.draft.constraints, external.draft.constraints);
		assert.match(harness.sent[0].message.content, /Updated delegation policy/);
		assert.equal(result.projection.goalState.impl.runId, external.impl.runId);
	});

	test("contract-only disk updates preserve progress and refresh the continuation prompt", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		run.handle({ type: "progress-tool-called" }, harness.context());
		const external = stateOf(run);
		external.goal!.constraints = ["Use the new policy"];
		writeGoalState(cwd, external);
		run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
		const continuation = decideContinuation(run, harness);
		assert.ok(continuation);
		assert.match(continuation.content, /Use the new policy/);
	});

	test("a view imports external state without resetting the turn-stop gate", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareDraft(cwd, harness);
		run.handle({ type: "commit", params: contractParams }, harness.context());
		const external = stateOf(run);
		external.goal!.constraints = ["Latest constraint"];
		writeGoalState(cwd, external);
		const view = run.view();
		assert.equal(view.error, undefined);
		assert.deepEqual(view.projection.goalState.goal!.constraints, external.goal!.constraints);
		assert.equal(run.turnStoppedBy(), "commit_plan_goal");
	});

	test("an external run change cannot inherit old progress", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);
		const external = stateOf(run);
		external.impl.runId++;
		writeGoalState(cwd, external);
		run.view();
		run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
		assert.equal(decideContinuation(run, harness), undefined);
		assert.equal(harness.sent.length, 0);
	});

	for (const badState of ["{", "null", "{}", "[]"]) {
		test(`invalid state ${badState} is not overwritten by a view, resume or the boundary decision`, () => {
			const cwd = makeCwd();
			const harness = createHarness();
			const run = prepareActive(cwd, harness);
			harness.clearSent();
			settleWithProgress(run, harness);
			const before = stateOf(run);
			writeText(getPaths(cwd).goalState, badState);
			assert.equal(run.view().error?.operation, "state-sync");
			for (const type of ["implementation-request", "before-settle"] as const) {
				const result = run.handle(type === "before-settle" ? { type, outcome: "completed" } : { type }, harness.context());
				assert.equal(result.error?.operation, "state-sync");
				assert.equal(result.continuation, undefined);
				// The failed read still hands back something to display: the last-known goal, never an empty one.
				assert.deepEqual(result.projection.goalState, before);
			}
			assert.equal(readText(getPaths(cwd).goalState), badState);
			assert.deepEqual(stateOf(run), before);
			assert.equal(harness.sent.length, 0);
			// The adapter surfaces the sync failure as a warning; the lifecycle
			// only keeps the explicit /plan-goal-impl recovery route.
			writeGoalState(cwd, before);
			assert.equal(run.handle({ type: "implementation-request" }, harness.context()).error, undefined);
			assert.equal(harness.sent.length, 1);
		});
	}

	test("deleted state is not recreated from stale memory", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		fs.rmSync(getPaths(cwd).goalState);
		const result = run.handle({ type: "pause", params: { reason: "do not recreate" } }, harness.context());
		assert.equal(result.error?.operation, "state-sync");
		assert.equal(fileExists(getPaths(cwd).goalState), false);
	});

	test("a failing send does not clobber the externally updated contract", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareDraft(cwd, harness);
		run.handle({ type: "commit", params: contractParams }, harness.context());
		const external = stateOf(run);
		external.goal!.constraints = ["Keep the revised contract on failure"];
		writeGoalState(cwd, external);
		harness.setFailSends(true);
		const result = run.handle({ type: "implementation-request" }, harness.context());
		assert.match(result.error?.reason ?? "", /send exploded/);
		assert.equal(stateOf(run).status, "active");
		assert.deepEqual(result.projection.goalState.goal!.constraints, external.goal!.constraints);
	});

	test("a failed boundary sync keeps an explicit recovery path after repair", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		settleWithProgress(run, harness);
		const before = stateOf(run);
		writeText(getPaths(cwd).goalState, "{");
		const failed = run.handle({ type: "before-settle", outcome: "completed" }, harness.context());
		assert.equal(failed.error?.operation, "state-sync");
		assert.equal(failed.continuation, undefined);
		writeGoalState(cwd, before);
		assert.equal(run.handle({ type: "implementation-request" }, harness.context()).error, undefined);
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
		run.view();
		assert.equal(run.turnStoppedBy(), "pause_plan_goal"); // same turn remains stopped
		const result = run.handle({ type: "turn-start" }, harness.context());
		assert.equal(result.error?.operation, "state-sync");
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
			assertAcceptedQuietly(result);
			assert.equal(stateOf(run).status, "active");
			assert.equal(stateOf(run).impl.runId, 1);
			assert.equal(harness.sent.length, 1);
			assert.ok(harness.sent[0].message.content.includes(`Current user supplement for this implementation request:\n${input}\n`));
			assert.deepEqual(harness.sent[0].options, { triggerTurn: true });
			assert.equal(harness.sent[0].message.display, false);
			assert.deepEqual(stateOf(run).goal, contractParams);
			assert.ok(!JSON.stringify(stateOf(run)).includes(input.split("\n")[0]));
			assert.ok(!readText(getPaths(cwd).goalState).includes(input.split("\n")[0]));
			assert.ok(!readText(getPaths(cwd).goalState).includes('"supplementalInput"'));
			if (status === "paused") assert.match(readText(getPaths(cwd).files["progress.md"]), /Goal paused: 额度耗尽/);

			run.handle({ type: "agent-start" }, harness.context());
			run.handle({ type: "turn-start" }, harness.context());
			const continuation = settleWithProgress(run, harness);
			assert.ok(continuation);
			assert.equal(continuation.customType, MESSAGE_TYPE_CONTINUATION);
			assert.doesNotMatch(continuation.content, /Current user supplement|重置卡/);

			// Neither a later resume nor a different implementation run re-injects the input.
			run.handle({ type: "pause", params: { reason: "other blocker" } }, harness.context());
			run.handle({ type: "implementation-request", supplementalInput: " \t\n　" }, harness.context());
			assert.doesNotMatch(harness.sent.at(-1)!.message.content, /Current user supplement|重置卡/);
			run.handle({ type: "start-drafting", input: "new goal" }, harness.context());
			run.handle({ type: "commit", params: contractParams }, harness.context());
			run.handle({ type: "implementation-request" }, harness.context());
			assert.equal(stateOf(run).impl.runId, 2);
			assert.doesNotMatch(harness.sent.at(-1)!.message.content, /Current user supplement|重置卡/);
		});

		for (const retryInput of [undefined, "本次重试补充\n请重新核验"] as const) {
			test(`${status} send failure reports the error and never caches the failed input (${retryInput ? "supplied" : "omitted"})`, () => {
				const cwd = makeCwd();
				const harness = createHarness();
				const run = prepareDraft(cwd, harness);
				run.handle({ type: "commit", params: contractParams }, harness.context());
				if (status === "paused") {
					run.handle({ type: "implementation-request" }, harness.context());
					run.handle({ type: "pause", params: { reason: "额度耗尽" } }, harness.context());
				}
				harness.clearSent();
				harness.setFailSends(true);
				const failed = run.handle({ type: "implementation-request", supplementalInput: "失败请求的补充" }, harness.context());
				assert.match(failed.error?.reason ?? "", /send exploded/);
				// The message states the preserved status and the route that fits
				// it: a bare /plan-goal-impl retry is a no-op on the active run,
				// so it must point at pausing first.
				assert.match(failed.error?.reason ?? "", /current status: active/);
				assert.match(failed.error?.reason ?? "", /Pause the run first \(pause_plan_goal\)/);
				// The transition was already persisted and kept: the run is
				// active even though its message never went out.
				assert.equal(stateOf(run).status, "active");
				assert.equal(harness.sent.length, 0);
				harness.setFailSends(false);
				// The failed input was never cached: after pausing, a retry sends only what it supplies.
				run.handle({ type: "pause", params: { reason: "重发实现请求" } }, harness.context());
				const retry = run.handle({ type: "implementation-request", supplementalInput: retryInput }, harness.context());
				assertAcceptedQuietly(retry);
				assert.equal(harness.sent.length, 1);
				assert.doesNotMatch(harness.sent[0].message.content, /失败请求的补充/);
				if (retryInput) assert.ok(harness.sent[0].message.content.includes(retryInput));
				else assert.doesNotMatch(harness.sent[0].message.content, /Current user supplement/);
			});
		}
	}

	test("active input rejection preserves state; blank input stays a no-op", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		harness.clearSent();
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop" }, harness.context());
		const before = stateOf(run);
		const diskBefore = readText(getPaths(cwd).goalState);
		const logBefore = [...harness.log];
		const rejected = run.handle({ type: "implementation-request", supplementalInput: "额度已恢复" }, harness.context());
		assert.equal(rejected.error?.operation, "plan-goal-impl");
		assert.match(rejected.error?.reason ?? "", /not accepted.*normal message.*pause.*plan-goal-impl/);
		const blank = run.handle({ type: "implementation-request", supplementalInput: " \t\n　" }, harness.context());
		assertAcceptedQuietly(blank);
		assert.deepEqual(stateOf(run), before);
		assert.equal(readText(getPaths(cwd).goalState), diskBefore);
		assert.deepEqual(harness.log, logBefore);
		assert.equal(harness.sent.length, 0);
		// The rejection does not consume the run's progress: the boundary still continues.
		const continuation = decideContinuation(run, harness);
		assert.ok(continuation);
		assert.doesNotMatch(continuation.content, /Current user supplement|额度已恢复/);
	});

	for (const retryInput of [undefined, "恢复重发补充\n额度已恢复"] as const) {
		test(`active recovery send failures remain retryable without caching input (${retryInput ? "supplied" : "omitted"})`, () => {
			const cwd = makeCwd();
			const harness = createHarness();
			const run = prepareActive(cwd, harness);
			harness.clearSent();
			settleWithProgress(run, harness);
			const before = stateOf(run);
			writeText(getPaths(cwd).goalState, "{");
			const failed = run.handle({ type: "before-settle", outcome: "completed" }, harness.context());
			assert.equal(failed.error?.operation, "state-sync");
			const repaired = writeGoalState(cwd, before);
			harness.setFailSends(true);
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = run.handle({ type: "implementation-request", supplementalInput: "未发送的旧补充" }, harness.context());
				assert.match(result.error?.reason ?? "", /send exploded/);
				assert.deepEqual(result.projection.goalState, repaired);
				assert.equal(harness.sent.length, 0);
			}
			harness.setFailSends(false);
			const result = run.handle({ type: "implementation-request", supplementalInput: retryInput }, harness.context());
			assertAcceptedQuietly(result);
			assert.deepEqual(result.projection.goalState, repaired);
			assert.deepEqual(stateOf(createGoalLifecycle(cwd, harness.deps)), repaired);
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
			const continuation = settleWithProgress(run, harness);
			assert.ok(continuation);
			assert.doesNotMatch(continuation.content, /Current user supplement|恢复重发补充|未发送的旧补充/);
		});
	}
});

describe("workspace hand-over (/plan-archive, /plan-new)", () => {
	const archiveWorkspace = (run: GoalLifecycle, harness: Harness, agentIdle = true) =>
		run.handle({ type: "archive-workspace", agentIdle }, harness.context());
	const newWorkspace = (run: GoalLifecycle, harness: Harness, agentIdle = true) =>
		run.handle({ type: "new-workspace", agentIdle }, harness.context());
	const infoNotices = (harness: Harness) => harness.log.filter((line) => line.startsWith("notify:info:")).map((line) => line.slice("notify:info:".length));
	/** The single archive directory a hand-over produced, checked for its label. */
	function onlyArchive(cwd: string, label: string): string {
		const archives = fs.readdirSync(getPaths(cwd).archiveRoot);
		assert.equal(archives.length, 1);
		assert.match(archives[0]!, new RegExp(`-${label}$`));
		return path.join(getPaths(cwd).archiveRoot, archives[0]!);
	}

	for (const [name, send, reason] of [
		["archive-workspace", archiveWorkspace, "Planning workspace cannot be archived while the agent is running. Wait for it to settle, then retry /plan-archive."],
		["new-workspace", newWorkspace, "Planning workspace cannot be reset while the agent is running. Wait for it to settle, then retry /plan-new."],
	] as const) {
		test(`${name} is rejected while the agent is running, before anything is touched`, () => {
			const cwd = makeCwd();
			const harness = createHarness();
			const run = prepareActive(cwd, harness);
			const paths = getPaths(cwd);
			const before = { state: stateOf(run), files: fs.readdirSync(paths.root).sort(), plan: readText(paths.files["task_plan.md"]) };
			const logBefore = [...harness.log];
			const result = send(run, harness, false);
			assert.equal(result.error?.reason, reason);
			assert.deepEqual(stateOf(run), before.state);
			assert.deepEqual(fs.readdirSync(paths.root).sort(), before.files);
			assert.equal(readText(paths.files["task_plan.md"]), before.plan);
			assert.equal(result.projection.goalState.status, "active");
			assert.deepEqual(harness.log, logBefore);
		});
	}

	test("archiving carries the whole workspace away, goal included, and forgets the goal", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);
		writeText(path.join(paths.tasksDir, "task-01.md"), "# Task 01\n");
		const savedState = readText(paths.goalState);
		const savedPlan = readText(paths.files["task_plan.md"]);

		const result = archiveWorkspace(run, harness);
		assert.equal(result.error, undefined);
		// Nothing is left behind and no replacement is created.
		assert.deepEqual(fs.readdirSync(paths.root), ["archive"]);
		const archiveDir = onlyArchive(cwd, "plan-archive");
		assert.deepEqual(fs.readdirSync(archiveDir).sort(), [".goal-state.json", "findings.md", "goal-design.md", "progress.md", "task_plan.md", "tasks"]);
		assert.equal(readText(path.join(archiveDir, ".goal-state.json")), savedState); // the goal is archived as it was, still active
		assert.equal(readText(path.join(archiveDir, "task_plan.md")), savedPlan);
		assert.equal(readText(path.join(archiveDir, "tasks", "task-01.md")), "# Task 01\n");
		assert.deepEqual(infoNotices(harness), [`Planning workspace archived to ${archiveDir}.`]);
		// Memory agrees with the now-empty disk: the result, later looks, and a reload all see no goal.
		assert.equal(result.projection.exists, false);
		assert.equal(result.projection.goalState.status, "none");
		assert.equal(result.projection.goalState.goal, null);
		assert.equal(stateOf(run).impl.tokensUsed, 0);
		assert.equal(run.view().error, undefined);
		assert.equal(stateOf(createGoalLifecycle(cwd, harness.deps)).status, "none");
		// The archived run cannot continue, and a new goal can start in the same session.
		assert.equal(settleWithProgress(run, harness), undefined);
		assert.equal(run.handle({ type: "start-drafting", input: "next goal" }, harness.context()).error, undefined);
		assert.equal(stateOf(run).status, "drafting");
		assert.equal(stateOf(run).impl.runId, 0);
	});

	test("archiving releases the archived goal's turn-stop gate and closing accounting", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "pause", params: { reason: "quota" } }, harness.context());
		assert.equal(run.turnStoppedBy(), "pause_plan_goal");
		assert.equal(archiveWorkspace(run, harness).error, undefined);
		assert.equal(run.turnStoppedBy(), null);
		// A closing response of the archived goal must not write a state file back.
		assert.equal(run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 50 }, harness.context()).error, undefined);
		assert.equal(fileExists(getPaths(cwd).goalState), false);
		assert.equal(stateOf(run).impl.tokensUsed, 0);
	});

	test("archiving an empty directory reports that there is nothing to archive", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		const result = archiveWorkspace(run, harness);
		assert.equal(result.error, undefined);
		assert.deepEqual(infoNotices(harness), ["No current planning workspace to archive."]);
		assert.equal(fileExists(getPaths(cwd).archiveRoot), false);
		assert.equal(result.projection.exists, false);
	});

	for (const [name, send, label] of [["archive-workspace", archiveWorkspace, "plan-archive"], ["new-workspace", newWorkspace, "plan-reset"]] as const) {
		test(`${name} works on an unreadable state file and archives it byte for byte`, () => {
			const cwd = makeCwd();
			const harness = createHarness();
			const run = prepareActive(cwd, harness);
			const paths = getPaths(cwd);
			writeText(paths.goalState, "{broken");
			assert.equal(run.view().error?.operation, "state-sync"); // every other route is stuck
			const result = send(run, harness);
			assert.equal(result.error, undefined);
			assert.equal(readText(path.join(onlyArchive(cwd, label), ".goal-state.json")), "{broken");
			assert.equal(stateOf(run).status, "none");
			assert.equal(run.view().error, undefined);
		});
	}

	test("a failed archive keeps the workspace and the goal, and can be retried", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);
		const before = { state: stateOf(run), plan: readText(paths.files["task_plan.md"]), disk: readText(paths.goalState) };
		fs.rmSync(paths.archiveRoot, { recursive: true, force: true });
		writeText(paths.archiveRoot, "block archive directory");

		const result = archiveWorkspace(run, harness);
		assert.match(result.error?.reason ?? "", /^Planning workspace archive failed: .*EEXIST/);
		assert.doesNotMatch(result.error?.reason ?? "", /Goal operation failed|plan-goal-impl/);
		assert.deepEqual(stateOf(run), before.state);
		assert.equal(readText(paths.goalState), before.disk);
		assert.equal(readText(paths.files["task_plan.md"]), before.plan);
		assert.equal(result.projection.goalState.status, "active");
		assert.deepEqual(infoNotices(harness), []);

		fs.rmSync(paths.archiveRoot);
		assert.equal(archiveWorkspace(run, harness).error, undefined);
		assert.equal(stateOf(run).status, "none");
		assert.deepEqual(fs.readdirSync(paths.root), ["archive"]);
	});

	test("a new workspace archives the old one whole and starts blank with no goal", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 300 }, harness.context());
		await complete(run, { summary: "done" }, harness);
		const savedState = readText(paths.goalState);
		const savedPlan = readText(paths.files["task_plan.md"]);
		assert.match(savedPlan, new RegExp(contractParams.objective));

		const result = newWorkspace(run, harness);
		assert.equal(result.error, undefined);
		const archiveDir = onlyArchive(cwd, "plan-reset");
		assert.deepEqual(fs.readdirSync(archiveDir).sort(), [".goal-state.json", "findings.md", "goal-design.md", "progress.md", "task_plan.md", "tasks"]);
		assert.equal(readText(path.join(archiveDir, ".goal-state.json")), savedState);
		assert.equal(readText(path.join(archiveDir, "task_plan.md")), savedPlan);
		// The live workspace is the blank template: no goal contract, design, or task cards carried over.
		assert.deepEqual(fs.readdirSync(paths.root).sort(), [".goal-state.json", "archive", "findings.md", "progress.md", "task_plan.md"]);
		assert.match(readText(paths.files["task_plan.md"]), /# Task Plan: \[Brief Description\]/);
		assert.doesNotMatch(readText(paths.files["task_plan.md"]), new RegExp(contractParams.objective));
		const disk = readGoalState(cwd);
		assert.equal(disk.status, "none");
		assert.equal(disk.goal, null);
		assert.equal(disk.impl.tokensUsed, 0);
		assert.equal(disk.impl.runId, 0);
		assert.deepEqual(stateOf(run), disk);
		assert.deepEqual(infoNotices(harness), ["Planning workspace reset. Goal overlay cleared."]);
		assert.equal(result.projection.exists, true);
		assert.equal(result.projection.goalState.status, "none");
		assert.equal(result.projection.currentPhase, "Phase 1");
		assert.equal(run.turnStoppedBy(), null);
	});

	test("a new workspace in an empty directory creates the templates without an archive", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = createGoalLifecycle(cwd, harness.deps);
		const paths = getPaths(cwd);
		assert.equal(newWorkspace(run, harness).error, undefined);
		assert.deepEqual(fs.readdirSync(paths.root).sort(), [".goal-state.json", "findings.md", "progress.md", "task_plan.md"]);
		assert.equal(readGoalState(cwd).status, "none");
		assert.deepEqual(infoNotices(harness), ["Planning workspace reset. Goal overlay cleared."]);
	});

	test("a new workspace whose archive fails initializes nothing and keeps the goal", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);
		const before = { state: stateOf(run), plan: readText(paths.files["task_plan.md"]) };
		fs.rmSync(paths.archiveRoot, { recursive: true, force: true });
		writeText(paths.archiveRoot, "block archive directory");
		const result = newWorkspace(run, harness);
		assert.match(result.error?.reason ?? "", /^Planning workspace archive failed: /);
		assert.deepEqual(stateOf(run), before.state);
		assert.equal(readText(paths.files["task_plan.md"]), before.plan);
		assert.deepEqual(infoNotices(harness), []);
	});

	test("a new workspace whose initialization fails leaves no dangling goal and can be retried", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);
		const savedState = readText(paths.goalState);
		// A dangling link is invisible to the archive but cannot be written through.
		fs.rmSync(paths.files["progress.md"]);
		fs.symlinkSync(path.join(cwd, "missing-directory", "progress.md"), paths.files["progress.md"]);

		const failed = newWorkspace(run, harness);
		assert.match(failed.error?.reason ?? "", /^Planning workspace initialization failed: .*ENOENT.*already archived; retry \/plan-new/);
		assert.deepEqual(infoNotices(harness), []);
		// The old goal is in the archive, not half-alive in memory: no "state file disappeared" trap.
		assert.equal(readText(path.join(onlyArchive(cwd, "plan-reset"), ".goal-state.json")), savedState);
		assert.equal(stateOf(run).status, "none");
		assert.equal(failed.projection.goalState.status, "none");
		assert.equal(fileExists(paths.goalState), false);
		assert.equal(run.view().error, undefined);
		assert.equal(run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 10 }, harness.context()).error, undefined);

		fs.rmSync(paths.files["progress.md"]);
		assert.equal(newWorkspace(run, harness).error, undefined);
		assert.equal(readGoalState(cwd).status, "none");
		assert.match(readText(paths.files["progress.md"]), /Planning workspace initialized/);
		assert.deepEqual(infoNotices(harness), ["Planning workspace reset. Goal overlay cleared."]);
	});
});

describe("token budget", () => {
	const budgetParams = { ...contractParams, tokenBudget: 1000 };

	function prepareBudgetedActive(cwd: string, harness: Harness): GoalLifecycle {
		const run = createGoalLifecycle(cwd, harness.deps);
		run.handle({ type: "start-drafting", input: "budgeted run" }, harness.context());
		run.handle({ type: "save-draft", params: contractParams }, harness.context());
		run.handle({ type: "commit", params: budgetParams }, harness.context());
		run.handle({ type: "implementation-request" }, harness.context());
		return run;
	}

	test("goal usage accumulates from drafting through interrupted resumes and completion, and reset clears it", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		let run = prepareDraft(cwd, harness);
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 100 }, harness.context());
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "aborted", usageTokens: 20 }, harness.context());
		assert.equal(stateOf(run).status, "drafting");
		assert.equal(readGoalState(cwd).impl.tokensUsed, 120);

		run = createGoalLifecycle(cwd, harness.deps);
		run.handle({ type: "restore" }, harness.context());
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "commit", params: contractParams }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 30 }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 150);
		run.handle({ type: "agent-settled" }, harness.context());
		run.handle({ type: "agent-start" }, harness.context());
		// A later conversation before implementation belongs to no goal turn.
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 40 }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 150);

		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 150);
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 200 }, harness.context());
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "aborted", usageTokens: 50 }, harness.context());
		assert.equal(stateOf(run).status, "paused");
		assert.equal(readGoalState(cwd).impl.tokensUsed, 400);

		run = createGoalLifecycle(cwd, harness.deps);
		run.handle({ type: "restore" }, harness.context());
		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 400);
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 200 }, harness.context());
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "pause", params: { reason: "Manual pause" } }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 25 }, harness.context());
		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 625);

		run.handle({ type: "turn-start" }, harness.context());
		await complete(run, { summary: "done" }, harness);
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 100 }, harness.context());
		assert.equal(stateOf(run).status, "complete");
		assert.equal(readGoalState(cwd).impl.tokensUsed, 725);
		assert.ok(buildWidgetLines(run.view().projection)!.includes("tokens: 725"));
		run.handle({ type: "agent-settled" }, harness.context());
		run.handle({ type: "agent-start" }, harness.context());
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 999 }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 725);

		run.handle({ type: "new-workspace", agentIdle: true }, harness.context());
		assert.equal(readGoalState(cwd).impl.tokensUsed, 0);
		run.handle({ type: "start-drafting", input: "New goal" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 12 }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 12);
	});

	for (const boundary of ["agent-start", "agent-settled", "restore", "new-workspace"] as const) {
		test(`${boundary} clears closing accounting even when the state file is corrupt`, () => {
			const cwd = makeCwd();
			const harness = createHarness();
			const run = prepareDraft(cwd, harness);
			run.handle({ type: "commit", params: contractParams }, harness.context());
			run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 30 }, harness.context());
			const saved = readGoalState(cwd);
			writeText(getPaths(cwd).goalState, "{invalid json");
			const result = run.handle(boundary === "new-workspace" ? { type: boundary, agentIdle: true } : { type: boundary }, harness.context());
			assert.equal(Boolean(result.error), boundary !== "new-workspace");
			// Repair the file without another cleanup event: no old accounting flag may remain.
			writeGoalState(cwd, saved);
			run.handle({ type: "turn-start" }, harness.context());
			run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 40 }, harness.context());
			assert.equal(stateOf(run).impl.tokensUsed, 30);
		});
	}

	test("commit persists a valid tokenBudget and rejects invalid ones", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareDraft(cwd, harness);
		run.handle({ type: "commit", params: budgetParams }, harness.context());
		assert.equal(stateOf(run).goal?.tokenBudget, 1000);

		for (const bad of [0, -5, 1.5]) {
			const other = makeCwd();
			const otherHarness = createHarness();
			const otherRun = prepareDraft(other, otherHarness);
			const rejected = otherRun.handle({ type: "commit", params: { ...contractParams, tokenBudget: bad } }, otherHarness.context());
			assert.ok(rejected.error?.reason.includes("positive integer"));
		}
	});

	test("counts implementation and closing pause turns, then excludes unrelated settled conversations", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness); // no tokenBudget in contractParams
		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 400 }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 400);
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 25 }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 425);

		// Both the tool-calling response and its automatic follow-up belong to the goal.
		run.handle({ type: "pause", params: { reason: "checking" } }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 100 }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 525);

		// A new turn alone is still the automatic response to the pause tool.
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 50 }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 575);
		run.handle({ type: "agent-settled" }, harness.context());
		run.handle({ type: "agent-start" }, harness.context());
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 80 }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 575);
	});

	test("the closing response of a completed goal counts its usage", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 300 }, harness.context());
		await complete(run, { summary: "done" }, harness);
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 120 }, harness.context());
		assert.equal(stateOf(run).status, "complete");
		assert.equal(stateOf(run).impl.tokensUsed, 420);
	});

	test("pauses instead of continuing once the budget is exhausted, and resume preserves lifetime usage", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareBudgetedActive(cwd, harness);
		harness.clearSent();

		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 600 }, harness.context());
		assert.ok(decideContinuation(run, harness)); // 60% — still running

		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 450 }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 1050);
		const result = run.handle({ type: "before-settle", outcome: "completed" }, harness.context());
		assert.equal(result.continuation, undefined);
		assert.equal(stateOf(run).status, "paused");
		assert.match(stateOf(run).impl.pausedReason, /Token budget exhausted: 1050 \/ 1000/);
		assert.match(stateOf(run).impl.pausedSuggestedAction, /\/plan-goal-impl/);
		assert.ok(harness.log.some((entry) => entry.startsWith("notify:warning:") && entry.includes("token budget exhausted")));
		assert.ok(readText(getPaths(cwd).files["progress.md"]).includes("Token budget exhausted"));

		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(stateOf(run).status, "active");
		assert.equal(stateOf(run).impl.tokensUsed, 1050);
		assert.match(harness.sent.at(-1)!.message.content, /105%/);
		run.handle({ type: "turn-start" }, harness.context());
		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 50 }, harness.context());
		assert.equal(decideContinuation(run, harness), undefined);
		assert.equal(stateOf(run).status, "paused");
		assert.equal(stateOf(run).impl.tokensUsed, 1100);

		// Revising the same goal's cap must retain all spending, even though a new implementation run starts.
		run.handle({ type: "start-drafting", input: "Increase the authorized goal budget" }, harness.context());
		run.handle({ type: "commit", params: { ...budgetParams, tokenBudget: 2000 } }, harness.context());
		run.handle({ type: "implementation-request" }, harness.context());
		assert.equal(stateOf(run).impl.tokensUsed, 1100);
		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 100 }, harness.context());
		assert.match(decideContinuation(run, harness)!.content, /60%/);
	});

	test("an exhausted budget does not pause a run that went quiet without progress", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareBudgetedActive(cwd, harness);
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 1200 }, harness.context());
		run.handle({ type: "before-settle", outcome: "completed" }, harness.context());
		assert.equal(stateOf(run).status, "active"); // existing no-progress semantics win
	});

	test("continuation prompts carry the budget line as usage crosses thresholds", () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareBudgetedActive(cwd, harness);

		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 500 }, harness.context());
		let prompt = decideContinuation(run, harness)?.content ?? "";
		assert.ok(prompt.includes("Token budget: 500 / 1k tokens used (50%)."));
		assert.ok(!prompt.includes("Budget warning"));

		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 250 }, harness.context());
		prompt = decideContinuation(run, harness)?.content ?? "";
		assert.ok(prompt.includes("Token budget: 750 / 1k tokens used (75%)."));
		assert.ok(prompt.includes("Budget warning: prioritize the remaining success criteria"));
		assert.ok(!prompt.includes("Budget critical"));

		run.handle({ type: "progress-tool-called" }, harness.context());
		run.handle({ type: "turn-end", stopReason: "stop", usageTokens: 200 }, harness.context());
		prompt = decideContinuation(run, harness)?.content ?? "";
		assert.ok(prompt.includes("Token budget: 950 / 1k tokens used (95%)."));
		assert.ok(prompt.includes("Budget critical: stop starting new tasks"));
	});

describe("completion audit", () => {
	test("an approved verdict completes the goal and projects note and usage", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);
		writeText(paths.files["progress.md"], "# Progress\n\n## Timeline\n- tests pass\n");

		const result = await complete(
			run,
			{ summary: "done", evidence: ["tests pass"] },
			harness,
			auditModel({ kind: "completed", text: "criterion 1: MET\nVERDICT: APPROVE", usage: auditUsage }),
		);

		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "complete");
		assert.equal(result.audit?.note, " (independent audit: approved)");
		assert.deepEqual(result.audit?.usage, auditUsage);
		assert.match(readText(paths.files["progress.md"]), /done \| evidence: tests pass/);
	});

	test("a rejected verdict blocks completion, keeps the run active, and carries the auditor usage", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		run.handle({ type: "turn-start" }, harness.context()); // clear the commit stop gate like a real turn would
		const paths = getPaths(cwd);
		const taskPlanBefore = readText(paths.files["task_plan.md"]);
		const progressBefore = readText(paths.files["progress.md"]);

		const result = await complete(
			run,
			{ summary: "done", evidence: ["asserted only"] },
			harness,
			auditModel({ kind: "completed", text: "criterion 1: UNMET - no recorded evidence\nVERDICT: REJECT", usage: auditUsage }),
		);

		assert.equal(result.error?.operation, "complete_plan_goal");
		assert.match(result.error?.reason ?? "", /rejected by independent audit.*criterion 1: UNMET - no recorded evidence/);
		assert.match(result.error?.reason ?? "", /pause_plan_goal/);
		assert.deepEqual(result.audit?.usage, auditUsage);
		assert.equal(stateOf(run).status, "active");
		assert.equal(hasActiveGoal(cwd), true);
		assert.equal(run.turnStoppedBy(), null);
		assert.equal(readText(paths.files["task_plan.md"]), taskPlanBefore);
		assert.equal(readText(paths.files["progress.md"]), progressBefore);
	});

	test("an unavailable auditor fails open with a visible skip note", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);

		const result = await complete(
			run,
			{ summary: "done" },
			harness,
			auditModel({ kind: "failed", reason: "no model is available for the completion audit", usage: auditUsage }),
		);

		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "complete");
		assert.equal(result.audit?.note, " (independent audit skipped: no model is available for the completion audit)");
		assert.deepEqual(result.audit?.usage, auditUsage);
	});

	test("a transport error is an unavailable auditor, not a blocked completion", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const exploding: CompletionAuditCall = async () => {
			throw new Error("network down");
		};

		const result = await complete(run, { summary: "done" }, harness, exploding);

		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "complete");
		assert.equal(result.audit?.note, " (independent audit skipped: network down)");
	});

	test("cancelling the audit keeps the run active and still accounts the spent usage", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);
		const progressBefore = readText(paths.files["progress.md"]);
		const controller = new AbortController();
		const hanging: CompletionAuditCall = (_system, _user, signal) =>
			new Promise((resolve) => {
				signal?.addEventListener("abort", () => resolve({ kind: "failed", reason: "auditor request was aborted", usage: auditUsage }));
			});

		const pending = run.complete({ summary: "done" }, harness.context(), { modelCall: hanging, signal: controller.signal });
		controller.abort();
		const result = await pending;

		assert.equal(result.error?.operation, "complete_plan_goal");
		assert.match(result.error?.reason ?? "", /completion cancelled.*stays active/);
		assert.deepEqual(result.audit?.usage, auditUsage);
		assert.equal(stateOf(run).status, "active");
		assert.equal(hasActiveGoal(cwd), true);
		assert.equal(readText(paths.files["progress.md"]), progressBefore);
	});

	test("a goal that changed while the audit was in flight is not completed on the old verdict", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const paths = getPaths(cwd);
		const progressBefore = readText(paths.files["progress.md"]);
		let releaseAudit!: (result: AuditModelResult) => void;
		const gate = new Promise<AuditModelResult>((resolve) => {
			releaseAudit = resolve;
		});

		const pending = complete(run, { summary: "done" }, harness, () => gate);
		// While the audit runs, the user re-commits a different goal on disk.
		const external = readGoalState(cwd);
		external.goal = { ...external.goal!, objective: "A different objective", successCriteria: ["Different criteria"] };
		external.impl.runId = external.impl.runId + 1;
		writeGoalState(cwd, external);
		releaseAudit({ kind: "completed", text: "VERDICT: APPROVE" });
		const result = await pending;

		assert.equal(result.error?.operation, "complete_plan_goal");
		assert.match(result.error?.reason ?? "", /changed while the audit was in flight/);
		assert.equal(stateOf(run).status, "active");
		assert.equal(readGoalState(cwd).goal?.objective, "A different objective");
		assert.equal(readText(paths.files["progress.md"]), progressBefore);
		assert.doesNotMatch(readText(paths.files["task_plan.md"]), /## Current Phase\nComplete/);
	});

	for (const field of ["successCriteria", "constraints", "outOfScope", "runId"] as const) {
		test(`a changed ${field} alone invalidates an in-flight audit, including embedded newlines`, async () => {
			const cwd = makeCwd();
			const harness = createHarness();
			const run = prepareActive(cwd, harness);
			const paths = getPaths(cwd);
			if (field !== "runId") {
				const initial = readGoalState(cwd);
				initial.goal![field] = ["Tests pass\nDocumentation is updated"];
				writeGoalState(cwd, initial);
			}
			const progressBefore = readText(paths.files["progress.md"]);
			const planBefore = readText(paths.files["task_plan.md"]);
			const gate = Promise.withResolvers<AuditModelResult>();
			const pending = complete(run, { summary: "done" }, harness, () => gate.promise);
			const external = readGoalState(cwd);
			if (field === "runId") external.impl.runId += 1;
			else external.goal![field] = ["Tests pass", "Documentation is updated"];
			writeGoalState(cwd, external);
			gate.resolve({ kind: "completed", text: "VERDICT: APPROVE" });

			const result = await pending;
			assert.match(result.error?.reason ?? "", /changed while the audit was in flight/);
			assert.equal(stateOf(run).status, "active");
			assert.deepEqual(readGoalState(cwd).goal, external.goal);
			assert.equal(readGoalState(cwd).impl.runId, external.impl.runId);
			assert.equal(readText(paths.files["progress.md"]), progressBefore);
			assert.equal(readText(paths.files["task_plan.md"]), planBefore);
		});
	}

	test("the same goal that merely got persisted again still completes after the audit", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		const before = readGoalState(cwd);
		const gate = Promise.withResolvers<AuditModelResult>();

		const pending = complete(run, { summary: "done" }, harness, () => gate.promise);
		// An external re-write of the identical goal/run must not trip the guard.
		writeGoalState(cwd, readGoalState(cwd));
		gate.resolve({ kind: "completed", text: "VERDICT: APPROVE" });
		const result = await pending;

		assert.equal(result.error, undefined);
		assert.equal(stateOf(run).status, "complete");
		assert.equal(readGoalState(cwd).impl.runId, before.impl.runId);
	});

	test("an invalid completion request never spends audit tokens", async () => {
		const cwd = makeCwd();
		const harness = createHarness();
		const run = prepareActive(cwd, harness);
		let calls = 0;
		const counting = auditModel({ kind: "completed", text: "VERDICT: APPROVE" });
		const transport: CompletionAuditCall = async (system, user, signal) => {
			calls += 1;
			return counting(system, user, signal);
		};

		const emptySummary = await run.complete({ summary: "  " }, harness.context(), { modelCall: transport });
		assert.equal(emptySummary.error?.operation, "complete_plan_goal");
		assert.match(emptySummary.error?.reason ?? "", /summary is required/);
		assert.equal(stateOf(run).status, "active");

		// A run that is not active is rejected by the transition without an audit.
		run.handle({ type: "pause", params: { reason: "blocked" } }, harness.context());
		const paused = await run.complete({ summary: "done" }, harness.context(), { modelCall: transport });
		assert.equal(paused.error?.operation, "complete_plan_goal");
		assert.match(paused.error?.reason ?? "", /only an active goal implementation/);

		assert.equal(calls, 0);
	});
});
});
