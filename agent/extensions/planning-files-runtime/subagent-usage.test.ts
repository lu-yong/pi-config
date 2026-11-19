import assert from "node:assert/strict";
import { test } from "node:test";

import { createSubagentUsageTracker, threadTotalsOf } from "./subagent-usage.ts";
import { sumUsageTokens } from "./utils.ts";

function view(path: string, input: number, output: number) {
	return { path, state: "completed", task: "Do work", inputTokens: input, outputTokens: output };
}

test("threadTotalsOf extracts a single ThreadView and a ThreadView[] list", () => {
	assert.deepEqual(threadTotalsOf(view("/root/research", 100, 10)), [{ path: "/root/research", input: 100, output: 10 }]);
	assert.deepEqual(
		threadTotalsOf([view("/root/a", 1, 2), view("/root/b", 3, 4)]),
		[
			{ path: "/root/a", input: 1, output: 2 },
			{ path: "/root/b", input: 3, output: 4 },
		],
	);
});

test("threadTotalsOf rejects shapes without thread token fields", () => {
	// agent_types entries: name/description, no path or tokens.
	assert.deepEqual(threadTotalsOf([{ name: "coder", description: "Writes code" }, { name: "x", error: "no model" }]), []);
	// agent_output page: has a path but no cumulative token counters.
	assert.deepEqual(threadTotalsOf({ path: "/root/a", text: "result", totalCharacters: 3, nextOffset: null }), []);
	// agent_pause receipt: path but no tokens.
	assert.deepEqual(threadTotalsOf({ path: "/root/a", pauseRequested: true, status: "paused" }), []);
});

test("threadTotalsOf rejects malformed entries individually", () => {
	assert.deepEqual(threadTotalsOf(null), []);
	assert.deepEqual(threadTotalsOf(undefined), []);
	assert.deepEqual(threadTotalsOf("text"), []);
	assert.deepEqual(threadTotalsOf({}), []);
	assert.deepEqual(threadTotalsOf({ path: "/ok", inputTokens: "many" }), []);
	assert.deepEqual(threadTotalsOf({ path: "/neg", inputTokens: -5, outputTokens: -1 }), []);
	assert.deepEqual(threadTotalsOf({ path: "/nan", inputTokens: Number.NaN }), []);
	// Negative tokens drop the field; a valid sibling field still counts.
	assert.deepEqual(threadTotalsOf({ path: "/half", inputTokens: 7, outputTokens: -1 }), [{ path: "/half", input: 7, output: 0 }]);
	assert.deepEqual(threadTotalsOf([null, view("/root/ok", 1, 1), "junk"]), [{ path: "/root/ok", input: 1, output: 1 }]);
});

test("observe ignores tools outside the agent_ prefix", () => {
	const tracker = createSubagentUsageTracker();
	assert.equal(tracker.observe("bash", view("/root/a", 100, 10), undefined), undefined);
	assert.equal(tracker.observe("complete_plan_goal", view("/root/a", 100, 10), undefined), undefined);
});

test("observe steps aside when the tool already reports a native usage", () => {
	const tracker = createSubagentUsageTracker();
	const native = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	assert.equal(tracker.observe("agent_spawn", view("/root/a", 100, 10), native), undefined);
	// The native sighting must not have seeded or reset any watermark: the
	// next spawn observation still counts in full.
	assert.equal(tracker.observe("agent_spawn", view("/root/a", 100, 10), undefined)?.input, 100);
});

test("agent_spawn counts the full observation on first sighting", () => {
	const tracker = createSubagentUsageTracker();
	const usage = tracker.observe("agent_spawn", view("/root/a", 1000, 100), undefined);
	assert.deepEqual(usage, {
		input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	assert.equal(sumUsageTokens(usage!), 1100);
});

test("non-spawn agent tools only seed on first sighting", () => {
	const tracker = createSubagentUsageTracker();
	for (const toolName of ["agent_wait", "agent_steer", "agent_status", "agent_stop"]) {
		assert.equal(tracker.observe(toolName, view("/root/a", 1000, 100), undefined), undefined, toolName);
	}
	// Seeded: the next observation differences from there.
	assert.equal(tracker.observe("agent_wait", view("/root/a", 1100, 130), undefined)?.totalTokens, 130);
});

test("subsequent observations count only the delta", () => {
	const tracker = createSubagentUsageTracker();
	tracker.observe("agent_spawn", view("/root/a", 1000, 100), undefined);
	const usage = tracker.observe("agent_wait", view("/root/a", 1500, 140), undefined);
	assert.equal(usage?.input, 500);
	assert.equal(usage?.output, 40);
	assert.equal(usage?.totalTokens, 540);
	assert.equal(sumUsageTokens(usage!), 540);
	assert.equal(usage?.cacheRead, 0);
	assert.equal(usage?.cacheWrite, 0);
	assert.deepEqual(usage?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	// Equal totals: nothing new to inject.
	assert.equal(tracker.observe("agent_status", view("/root/a", 1500, 140), undefined), undefined);
});

test("watermarks never move backwards: lower totals neither rebate nor enable a recount", () => {
	const tracker = createSubagentUsageTracker();
	tracker.observe("agent_wait", view("/root/a", 1500, 140), undefined);
	// A live partial view reports lower totals: no negative delta, no change.
	assert.equal(tracker.observe("agent_status", view("/root/a", 900, 60), undefined), undefined);
	// Recovering to the old level is not new consumption either.
	assert.equal(tracker.observe("agent_status", view("/root/a", 1500, 140), undefined), undefined);
	// Only growth beyond the high-water mark counts again.
	assert.equal(tracker.observe("agent_status", view("/root/a", 1600, 200), undefined)?.totalTokens, 160);
});

test("per-path watermarks stay independent across a status list", () => {
	const tracker = createSubagentUsageTracker();
	tracker.observe("agent_spawn", view("/root/a", 100, 10), undefined);
	// /root/b is unseen here (seeded, not counted); /root/a differences.
	const usage = tracker.observe("agent_status", [view("/root/a", 150, 10), view("/root/b", 500, 50)], undefined);
	assert.equal(usage?.totalTokens, 50);
	// Both seen now: only the respective deltas count.
	const next = tracker.observe("agent_status", [view("/root/a", 160, 20), view("/root/b", 510, 60)], undefined);
	assert.equal(next?.input, 20);
	assert.equal(next?.output, 20);
});

test("a re-spawned path counts in full and resets the watermark", () => {
	const tracker = createSubagentUsageTracker();
	tracker.observe("agent_spawn", view("/root/a", 1000, 100), undefined);
	// `/agents reap` retired that thread; the same path is spawned again and
	// its fresh counters grow to 500/50. Differencing against the stale
	// watermark would swallow this consumption entirely.
	const respawn = tracker.observe("agent_spawn", view("/root/a", 500, 50), undefined);
	assert.equal(respawn?.input, 500);
	assert.equal(respawn?.output, 50);
	assert.equal(respawn?.totalTokens, 550);
	// The watermark now belongs to the new thread: growth differences again.
	assert.equal(tracker.observe("agent_wait", view("/root/a", 700, 90), undefined)?.totalTokens, 240);
});

test("spawn observations with zero totals inject nothing", () => {
	const tracker = createSubagentUsageTracker();
	assert.equal(tracker.observe("agent_spawn", view("/root/a", 0, 0), undefined), undefined);
	// The zero watermark is in place: later growth counts from zero.
	assert.equal(tracker.observe("agent_wait", view("/root/a", 10, 2), undefined)?.totalTokens, 12);
});
