import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildGoalSetPrompt, buildPlanUpdatePrompt, getPlanningSnapshot } from "./prompts.ts";
import { defaultGoalState } from "./state.ts";

test("goal drafting prompt explains the fail-closed bash policy", () => {
	const state = defaultGoalState();
	state.status = "drafting";
	const prompt = buildGoalSetPrompt(state);

	assert.ok(prompt.includes("every segment is an approved read-only command"));
	assert.ok(prompt.includes("Redirects, backticks, $(), subshells, and unknown commands are always rejected."));
	assert.ok(prompt.includes("curl, wget, ping, nslookup, traceroute, whois, host"));
	assert.ok(prompt.includes("`pwd && git status --short`"));
});

test("plan update prompt pins exact planning file paths and the continuity check", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-prompts-test-"));
	try {
		const snapshot = getPlanningSnapshot(cwd, false);
		const prompt = buildPlanUpdatePrompt(snapshot);

		assert.ok(prompt.includes("[PLAN UPDATE]"));
		assert.ok(prompt.includes(snapshot.files["task_plan.md"]));
		assert.ok(prompt.includes(snapshot.files["findings.md"]));
		assert.ok(prompt.includes(snapshot.files["progress.md"]));
		assert.ok(prompt.includes("## Continuity Check"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
