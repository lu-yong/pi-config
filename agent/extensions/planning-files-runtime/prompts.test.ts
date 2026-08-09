import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGoalSetPrompt } from "./prompts.ts";
import { defaultGoalState } from "./state.ts";

test("goal drafting prompt explains the single-command bash protocol", () => {
	const state = defaultGoalState();
	state.status = "drafting";
	const prompt = buildGoalSetPrompt(state);

	assert.ok(prompt.includes("Run exactly one approved read-only command per bash call."));
	assert.ok(prompt.includes("Never use shell composition: &&, ||, ;, |, redirects, backticks, $(), subshells, line continuations, or newline-separated commands."));
	assert.ok(prompt.includes("Do not combine pwd, file scanning, and git status. Use separate bash calls."));
	assert.ok(prompt.includes("`pwd`, `rg --files -g '!node_modules' -g '!.git'`, `git status --short`"));
});
