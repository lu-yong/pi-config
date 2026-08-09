import assert from "node:assert/strict";
import { test } from "node:test";

import {
	allQuestionsAnswered,
	createQuestionTakingState,
	currentOptions,
	normalizeQuestionnaireQuestions,
	orderedAnswers,
	reduceQuestionTakingState,
	type QuestionTakingQuestion,
} from "./state.ts";

const question = (overrides: Partial<QuestionTakingQuestion> = {}): QuestionTakingQuestion => ({
	id: "scope",
	label: "Scope",
	prompt: "Which scope?",
	options: [
		{ value: "small", label: "Small" },
		{ value: "large", label: "Large" },
	],
	allowOther: true,
	otherLabel: "Type something...",
	...overrides,
});

test("normalizes questionnaire defaults and exposes the custom option", () => {
	const questions = normalizeQuestionnaireQuestions([
		{ id: "scope", prompt: "Which scope?", options: [], allowOther: undefined },
		{ id: "priority", label: "Priority", prompt: "How urgent?", options: [], allowOther: false },
	]);

	assert.equal(questions[0]?.label, "Q1");
	assert.equal(questions[0]?.allowOther, true);
	assert.equal(questions[1]?.label, "Priority");
	assert.equal(questions[1]?.allowOther, false);
	assert.deepEqual(currentOptions({
		...createQuestionTakingState([questions[0]!], "single"),
		questions: [questions[0]!],
	}), [{ value: "__other__", label: "Type something.", isOther: true }]);
});

test("single-question selection completes with a stable answer", () => {
	let state = createQuestionTakingState([question()], "single");
	state = reduceQuestionTakingState(state, { type: "move-option", direction: 1 });
	state = reduceQuestionTakingState(state, { type: "select-option" });

	assert.equal(state.status, "completed");
	assert.deepEqual(state.answers, [{
		id: "scope",
		value: "large",
		label: "Large",
		wasCustom: false,
		index: 2,
	}]);
});

test("empty custom input returns to options while cancellation ends the interaction", () => {
	let state = createQuestionTakingState([question()], "single", { customEmptyBehavior: "reject" });
	state = reduceQuestionTakingState(state, { type: "move-option", direction: 1 });
	state = reduceQuestionTakingState(state, { type: "move-option", direction: 1 });
	state = reduceQuestionTakingState(state, { type: "select-option" });
	state = reduceQuestionTakingState(state, { type: "submit-custom", value: "  " });

	assert.equal(state.status, "active");
	assert.equal(state.inputMode, false);
	assert.equal(state.answers.length, 0);

	state = reduceQuestionTakingState(state, { type: "cancel" });
	assert.equal(state.status, "cancelled");
});

test("questionnaire answers are returned in question order and submit waits for all answers", () => {
	const questions = [question(), question({ id: "priority", label: "Priority" })];
	let state = createQuestionTakingState(questions, "questionnaire");

	state = reduceQuestionTakingState(state, { type: "select-option" });
	state = reduceQuestionTakingState(state, { type: "select-option" });
	assert.equal(allQuestionsAnswered(state), true);
	assert.equal(state.currentIndex, 2);

	state = reduceQuestionTakingState(state, { type: "submit" });
	assert.equal(state.status, "completed");
	assert.deepEqual(orderedAnswers(state).map((answer) => answer.id), ["scope", "priority"]);
});
