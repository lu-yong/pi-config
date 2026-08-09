export type QuestionTakingMode = "single" | "questionnaire" | "extracted";

export interface QuestionTakingOption {
	value: string;
	label: string;
	description?: string;
}

export interface QuestionTakingQuestion {
	id: string;
	label: string;
	prompt: string;
	options: QuestionTakingOption[];
	allowOther: boolean;
	otherLabel?: string;
}

export type RenderQuestionOption = QuestionTakingOption & { isOther?: boolean };

export interface QuestionTakingAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

export interface QuestionTakingState {
	mode: QuestionTakingMode;
	questions: QuestionTakingQuestion[];
	currentIndex: number;
	optionIndex: number;
	inputMode: boolean;
	inputQuestionIndex: number | null;
	answers: QuestionTakingAnswer[];
	status: "active" | "cancelled" | "completed";
	customEmptyBehavior: "reject" | "fallback";
}

export type QuestionTakingAction =
	| { type: "move-option"; direction: -1 | 1 }
	| { type: "move-tab"; direction: -1 | 1 }
	| { type: "select-option" }
	| { type: "submit-custom"; value: string }
	| { type: "cancel-custom" }
	| { type: "cancel" }
	| { type: "submit" };

export function renderOptions(question: QuestionTakingQuestion | undefined): RenderQuestionOption[] {
	if (!question) return [];
	if (!question.allowOther) return [...question.options];
	return [...question.options, { value: "__other__", label: question.otherLabel ?? "Type something.", isOther: true }];
}

export function normalizeQuestionnaireQuestions(
	questions: Array<{
		id: string;
		label?: string;
		prompt: string;
		options: QuestionTakingOption[];
		allowOther?: boolean;
	}>,
): QuestionTakingQuestion[] {
	return questions.map((question, index) => ({
		...question,
		label: question.label || `Q${index + 1}`,
		allowOther: question.allowOther !== false,
	}));
}

export function createQuestionTakingState(
	questions: QuestionTakingQuestion[],
	mode: QuestionTakingMode,
	options: { customEmptyBehavior?: "reject" | "fallback" } = {},
): QuestionTakingState {
	return {
		mode,
		questions,
		currentIndex: 0,
		optionIndex: 0,
		inputMode: false,
		inputQuestionIndex: null,
		answers: [],
		status: "active",
		customEmptyBehavior: options.customEmptyBehavior ?? "fallback",
	};
}

export function currentQuestion(state: QuestionTakingState): QuestionTakingQuestion | undefined {
	return state.questions[state.currentIndex];
}

export function currentOptions(state: QuestionTakingState): RenderQuestionOption[] {
	return renderOptions(currentQuestion(state));
}

export function allQuestionsAnswered(state: QuestionTakingState): boolean {
	return state.questions.every((question) => state.answers.some((answer) => answer.id === question.id));
}

export function orderedAnswers(state: QuestionTakingState): QuestionTakingAnswer[] {
	return state.questions.flatMap((question) => state.answers.filter((answer) => answer.id === question.id));
}

function copyState(state: QuestionTakingState, changes: Partial<QuestionTakingState>): QuestionTakingState {
	return { ...state, ...changes, answers: changes.answers ?? state.answers };
}

function upsertAnswer(state: QuestionTakingState, answer: QuestionTakingAnswer): QuestionTakingAnswer[] {
	const existingIndex = state.answers.findIndex((candidate) => candidate.id === answer.id);
	if (existingIndex === -1) return [...state.answers, answer];
	const answers = [...state.answers];
	answers[existingIndex] = answer;
	return answers;
}

function advanceAfterAnswer(state: QuestionTakingState): QuestionTakingState {
	if (state.mode === "single" || state.mode === "extracted") {
		return copyState(state, { status: "completed", inputMode: false, inputQuestionIndex: null });
	}

	const nextIndex = state.currentIndex < state.questions.length - 1 ? state.currentIndex + 1 : state.questions.length;
	return copyState(state, {
		currentIndex: nextIndex,
		optionIndex: 0,
		inputMode: false,
		inputQuestionIndex: null,
	});
}

export function reduceQuestionTakingState(
	state: QuestionTakingState,
	action: QuestionTakingAction,
): QuestionTakingState {
	if (state.status !== "active") return state;

	switch (action.type) {
		case "move-option": {
			const max = Math.max(0, currentOptions(state).length - 1);
			return copyState(state, {
				optionIndex: Math.min(max, Math.max(0, state.optionIndex + action.direction)),
			});
		}
		case "move-tab": {
			if (state.mode !== "questionnaire" || state.questions.length <= 1) return state;
			const totalTabs = state.questions.length + 1;
			return copyState(state, {
				currentIndex: (state.currentIndex + action.direction + totalTabs) % totalTabs,
				optionIndex: 0,
			});
		}
		case "select-option": {
			const question = currentQuestion(state);
			const option = currentOptions(state)[state.optionIndex];
			if (!question || !option) return state;
			if (option.isOther) {
				return copyState(state, { inputMode: true, inputQuestionIndex: state.currentIndex });
			}
			return advanceAfterAnswer(
				copyState(state, {
					answers: upsertAnswer(state, {
						id: question.id,
						value: option.value,
						label: option.label,
						wasCustom: false,
						index: state.optionIndex + 1,
					}),
				}),
			);
		}
		case "submit-custom": {
			if (!state.inputMode || state.inputQuestionIndex === null) return state;
			const question = state.questions[state.inputQuestionIndex];
			if (!question) return state;
			const trimmed = action.value.trim();
			if (!trimmed && state.customEmptyBehavior === "reject") {
				return copyState(state, { inputMode: false, inputQuestionIndex: null });
			}
			const value = trimmed || "(no response)";
			return advanceAfterAnswer(
				copyState(state, {
					answers: upsertAnswer(state, {
						id: question.id,
						value,
						label: value,
						wasCustom: true,
					}),
				}),
			);
		}
		case "cancel-custom":
			return copyState(state, { inputMode: false, inputQuestionIndex: null });
		case "cancel":
			return copyState(state, { status: "cancelled", inputMode: false, inputQuestionIndex: null });
		case "submit":
			if (state.mode === "questionnaire" && state.currentIndex === state.questions.length && allQuestionsAnswered(state)) {
				return copyState(state, { status: "completed" });
			}
			return state;
	}
}
