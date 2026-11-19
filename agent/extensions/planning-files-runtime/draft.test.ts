import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeDraft } from "./draft.ts";
import { defaultGoalDraft } from "./state.ts";
import type { SaveGoalDraftParams } from "./types.ts";

test("mergeDraft keeps the current drafting stage unless a valid stage is supplied", () => {
	const current = { ...defaultGoalDraft(), draftingStage: "design" as const };
	assert.equal(mergeDraft(current, { objective: "next" }).draftingStage, "design");
	assert.equal(mergeDraft(current, {}).draftingStage, "design");
	// The tool schema types draftingStage as a bare string, so any value can arrive.
	for (const invalid of ["bogus", "  ", ""]) {
		const params = { draftingStage: invalid } as SaveGoalDraftParams;
		assert.equal(mergeDraft(current, params).draftingStage, "design", JSON.stringify(invalid));
	}
	assert.equal(mergeDraft(current, { draftingStage: undefined }).draftingStage, "design");
	assert.equal(mergeDraft(current, { draftingStage: "task" }).draftingStage, "task");
	// The merge never mutates the draft it was given.
	assert.equal(current.draftingStage, "design");
	assert.equal(current.objective, "");
});

test("mergeDraft replaces supplied fields and preserves the rest", () => {
	const current = { ...defaultGoalDraft(), sourceTopic: "original topic", objective: "old objective" };
	const merged = mergeDraft(current, { objective: "new objective", successCriteria: ["criterion"], openQuestions: ["question"] });
	assert.equal(merged.sourceTopic, "original topic");
	assert.equal(merged.objective, "new objective");
	assert.deepEqual(merged.successCriteria, ["criterion"]);
	assert.deepEqual(merged.openQuestions, ["question"]);
	assert.deepEqual(merged.constraints, []);
});
