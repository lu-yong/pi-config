import type { Usage } from "@earendil-works/pi-ai";

import { SUBAGENT_SPAWN_TOOL, SUBAGENT_TOOL_PREFIX } from "./types.ts";

/**
 * Subagent token observability. pi-subagent-manager's `agent_*` tools report
 * each thread's *cumulative* totals (inputTokens already includes cache
 * read/write), not per-call usage; the goal budget needs the new consumption
 * only. This module turns those observations into per-path deltas mapped onto
 * a Usage object, so subagent spend rides the same tool-result usage channel
 * turn_end already sums — no lifecycle, state, or UI change.
 *
 * Attribution is at observation time: every delta is counted exactly once, in
 * the turn that first observes it. Typical flows (synchronous spawn waits,
 * agent_wait, periodic agent_status) consume and observe within the goal's own
 * turns, so attribution is exact. Only a detached (wait:false) tail observed
 * after a goal archived or reset lands in the goal active at observation time
 * — a bounded one-directional overestimate of the newer goal that never drops
 * or double-counts a delta, and heals to the correct watermark on the next
 * observation.
 *
 * Failure direction is undercount: an unrecognized shape, a foreign tool name,
 * or a natively reported usage field means no injection at all — so an
 * upstream change costs accuracy, never correctness, and a future native
 * usage field (existingUsage) passes through untouched with zero migration.
 */

/** Cumulative totals of one thread, as extracted from a tool result's details. */
export type ThreadTotals = { path: string; input: number; output: number };

/** One thread's token counters as last counted; the watermark never moves backwards. */
type Watermark = { input: number; output: number };

function tokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function threadTotalsOfEntry(entry: unknown): ThreadTotals | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const record = entry as Record<string, unknown>;
	if (typeof record.path !== "string" || record.path.length === 0) return undefined;
	const input = tokenCount(record.inputTokens);
	const output = tokenCount(record.outputTokens);
	// Shapes without thread token fields (agent_types entries, agent_output
	// pages, agent_pause receipts) fail here and are simply not observed.
	if (input === undefined && output === undefined) return undefined;
	return { path: record.path, input: input ?? 0, output: output ?? 0 };
}

/**
 * Defensively extract cumulative thread totals from an agent tool result's
 * `details`: a single ThreadView (agent_spawn/agent_wait/...) or the
 * ThreadView[] list agent_status returns. Invalid entries are dropped
 * individually; a details value with no valid thread yields [].
 */
export function threadTotalsOf(details: unknown): ThreadTotals[] {
	const entries = Array.isArray(details) ? details : [details];
	return entries
		.map(threadTotalsOfEntry)
		.filter((totals): totals is ThreadTotals => totals !== undefined);
}

export type SubagentUsageTracker = {
	/**
	 * Observe one agent tool result and return the Usage to inject, or
	 * undefined when there is nothing to add. A natively reported usage
	 * (existingUsage) always wins: observe steps aside and the host keeps it.
	 */
	observe(toolName: string, details: unknown, existingUsage: unknown): Usage | undefined;
};

/** Session-level watermark table over per-thread cumulative totals. */
export function createSubagentUsageTracker(): SubagentUsageTracker {
	const watermarks = new Map<string, Watermark>();
	return {
		observe(toolName, details, existingUsage) {
			if (existingUsage !== undefined) return undefined;
			if (!toolName.startsWith(SUBAGENT_TOOL_PREFIX)) return undefined;
			let deltaInput = 0;
			let deltaOutput = 0;
			for (const thread of threadTotalsOf(details)) {
				const previous = watermarks.get(thread.path);
				if (toolName === SUBAGENT_SPAWN_TOOL) {
					// A spawn is always a new thread counted from zero, so the
					// whole observation is new consumption. The same holds for a
					// re-spawn after `/agents reap`: the tracker may still hold
					// the retired thread's watermark, and differencing would
					// swallow the new thread's growth. Reset the watermark so
					// later observations difference from here — no overlap,
					// because the retired thread no longer consumes and the new
					// one started at zero.
					deltaInput += thread.input;
					deltaOutput += thread.output;
					watermarks.set(thread.path, { input: thread.input, output: thread.output });
					continue;
				}
				if (!previous) {
					// First sighting through a non-spawn tool (steer after a
					// reload, a grandchild revealed by a list): seed the
					// watermark, count nothing — that consumption predates this
					// tracker and was either never attributed here or already
					// attributed by the tracker of an earlier process.
					watermarks.set(thread.path, { input: thread.input, output: thread.output });
					continue;
				}
				deltaInput += Math.max(0, thread.input - previous.input);
				deltaOutput += Math.max(0, thread.output - previous.output);
				// Live partial views can momentarily report lower totals; the
				// watermark only moves forward so nothing is rebated or recounted.
				watermarks.set(thread.path, {
					input: Math.max(previous.input, thread.input),
					output: Math.max(previous.output, thread.output),
				});
			}
			if (deltaInput <= 0 && deltaOutput <= 0) return undefined;
			// ThreadView.inputTokens already includes cache read/write, so the
			// delta is the full four-field sum the budget counts; cache fields
			// stay zero. Cost stays zero: subagent USD cost is already tracked
			// by pi-subagent-manager's own ledger (pi-subagent:cost:v1).
			return {
				input: deltaInput,
				output: deltaOutput,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: deltaInput + deltaOutput,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		},
	};
}
