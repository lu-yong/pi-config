import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGoalSetPrompt } from "./prompts.ts";
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
