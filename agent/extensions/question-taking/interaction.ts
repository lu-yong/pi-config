import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import {
	allQuestionsAnswered,
	createQuestionTakingState,
	currentOptions,
	currentQuestion,
	normalizeQuestionnaireQuestions,
	orderedAnswers,
	reduceQuestionTakingState,
	routeQuestionTakingInput,
	type QuestionTakingAction,
	type QuestionTakingAnswer,
	type QuestionTakingKey,
	type QuestionTakingMode,
	type QuestionTakingOption,
	type QuestionTakingQuestion,
	type QuestionTakingState,
} from "./state.ts";

export * from "./state.ts";

export type QuestionTakingUI = Pick<ExtensionUIContext, "custom">;


export interface QuestionnaireResult {
	questions: QuestionTakingQuestion[];
	answers: QuestionTakingAnswer[];
	cancelled: boolean;
}

export interface ExtractedQuestion {
	question: string;
	options: string[];
	allowOther?: boolean;
}

export interface ExtractedAnswer {
	question: string;
	answer: string;
}

export type Presentation = "questionnaire" | "extracted";

export interface QuestionTakingRunOptions {
	mode: QuestionTakingMode;
	presentation: Presentation;
	customEmptyBehavior?: "reject" | "fallback";
}

/**
 * Run one of the shared question-taking interactions. Adapters should use one
 * of the specialized functions below unless they need a custom presentation.
 */
export async function runQuestionTaking(
	ui: QuestionTakingUI,
	questions: QuestionTakingQuestion[],
	options: QuestionTakingRunOptions,
): Promise<QuestionTakingState> {
	const state = await ui.custom<QuestionTakingState>((tui, theme, _keybindings, done) => {
		let currentState = createQuestionTakingState(questions, options.mode, {
			customEmptyBehavior: options.customEmptyBehavior,
		});
		let cachedLines: string[] | undefined;
		let finished = false;

		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function finishIfDone() {
			if (!finished && currentState.status !== "active") {
				finished = true;
				done(currentState);
			}
		}

		function dispatch(action: QuestionTakingAction) {
			currentState = reduceQuestionTakingState(currentState, action);
			refresh();
			finishIfDone();
		}

		editor.onSubmit = (value) => {
			currentState = reduceQuestionTakingState(currentState, { type: "submit-custom", value });
			editor.setText("");
			refresh();
			finishIfDone();
		};

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const renderWidth = Math.max(1, width);
			const question = currentQuestion(currentState);
			const optionsForQuestion = currentOptions(currentState);
			const isMulti = options.mode === "questionnaire" && questions.length > 1;
			const isSubmitTab = isMulti && currentState.currentIndex === questions.length;

			function addWrapped(text: string) {
				lines.push(...wrapTextWithAnsi(text, renderWidth));
			}

			function addWrappedWithPrefix(prefix: string, text: string) {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= renderWidth) {
					addWrapped(prefix + text);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
				const continuationPrefix = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
				}
			}

			function renderPrompt(prompt: string): string {
				return theme.fg("text", prompt);
			}

			function renderOptions() {
				for (let i = 0; i < optionsForQuestion.length; i++) {
					const option = optionsForQuestion[i]!;
					const selected = i === currentState.optionIndex;
					const isOther = option.isOther === true;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const label = `${i + 1}. ${option.label}${isOther && currentState.inputMode ? " ✎" : ""}`;
					const color = selected || (isOther && currentState.inputMode) ? "accent" : "text";
					addWrappedWithPrefix(prefix, theme.fg(color, label));
					if (option.description) {
						addWrappedWithPrefix("     ", theme.fg("muted", option.description));
					}
				}
			}

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let i = 0; i < questions.length; i++) {
					const tabQuestion = questions[i]!;
					const active = i === currentState.currentIndex;
					const answered = currentState.answers.some((answer) => answer.id === tabQuestion.id);
					const box = answered ? "■" : "□";
					const color = answered ? "success" : "muted";
					const text = ` ${box} ${tabQuestion.label} `;
					const styled = active
						? theme.bg("selectedBg", theme.fg("text", text))
						: theme.fg(color, text);
					tabs.push(`${styled} `);
				}
				const submitText = " ✓ Submit ";
				const submitStyled = isSubmitTab
					? theme.bg("selectedBg", theme.fg("text", submitText))
					: theme.fg(allQuestionsAnswered(currentState) ? "success" : "dim", submitText);
				tabs.push(`${submitStyled} →`);
				addWrappedWithPrefix(" ", tabs.join(""));
				lines.push("");
			}

			if (currentState.inputMode && question) {
				addWrappedWithPrefix(" ", renderPrompt(question.prompt));
				lines.push("");
				renderOptions();
				lines.push("");
				const answerLabel = "Your answer:";
				addWrappedWithPrefix(" ", theme.fg("muted", answerLabel));
				for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
				lines.push("");
				const help = "Enter to submit • Esc to cancel";
				addWrappedWithPrefix(" ", theme.fg("dim", help));
			} else if (isSubmitTab) {
				addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
				lines.push("");
				for (const tabQuestion of questions) {
					const answer = currentState.answers.find((candidate) => candidate.id === tabQuestion.id);
					if (answer) {
						const prefix = answer.wasCustom ? "(wrote) " : "";
						addWrappedWithPrefix(
							" ",
							`${theme.fg("muted", `${tabQuestion.label}: `)}${theme.fg("text", prefix + answer.label)}`,
						);
					}
				}
				lines.push("");
				if (allQuestionsAnswered(currentState)) {
					addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
				} else {
					const missing = questions
						.filter((candidate) => !currentState.answers.some((answer) => answer.id === candidate.id))
						.map((candidate) => candidate.label)
						.join(", ");
					addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
				}
			} else if (question) {
				addWrappedWithPrefix(" ", renderPrompt(question.prompt));
				lines.push("");
				renderOptions();
			}

			lines.push("");
			if (!currentState.inputMode) {
				const help = options.presentation === "extracted"
					? "↑↓ 导航 • Enter 选择 • Esc 跳过"
					: isMulti
						? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
						: "↑↓ navigate • Enter select • Esc cancel";
				addWrappedWithPrefix(" ", theme.fg("dim", help));
			}
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			cachedLines = lines;
			return lines;
		}

		function toKey(data: string): QuestionTakingKey {
			if (matchesKey(data, Key.up)) return "up";
			if (matchesKey(data, Key.down)) return "down";
			if (matchesKey(data, Key.left)) return "left";
			if (matchesKey(data, Key.right)) return "right";
			if (matchesKey(data, Key.shift("tab"))) return "shift-tab";
			if (matchesKey(data, Key.tab)) return "tab";
			if (matchesKey(data, Key.enter)) return "enter";
			if (matchesKey(data, Key.escape)) return "escape";
			return "other";
		}

		function handleInput(data: string) {
			const route = routeQuestionTakingInput(toKey(data), currentState);
			if (route.type === "editor") {
				editor.handleInput(data);
				refresh();
				return;
			}
			if (route.type !== "action") return;
			dispatch(route.action);
			if (route.action.type === "cancel-custom") editor.setText("");
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});

	return state;
}

export async function askQuestionnaire(
	ui: QuestionTakingUI,
	inputs: Array<{
		id: string;
		label?: string;
		prompt: string;
		options: QuestionTakingOption[];
		allowOther?: boolean;
	}>,
): Promise<QuestionnaireResult> {
	const questions = normalizeQuestionnaireQuestions(inputs);
	const mode: QuestionTakingMode = questions.length > 1 ? "questionnaire" : "single";
	const result = await runQuestionTaking(ui, questions, {
		mode,
		presentation: "questionnaire",
		customEmptyBehavior: "fallback",
	});
	return { questions, answers: orderedAnswers(result), cancelled: result.status === "cancelled" };
}

export async function askExtractedQuestions(
	ui: QuestionTakingUI,
	inputs: ExtractedQuestion[],
): Promise<ExtractedAnswer[] | null> {
	const answers: ExtractedAnswer[] = [];
	for (let index = 0; index < inputs.length; index++) {
		const input = inputs[index]!;
		const question: QuestionTakingQuestion = {
			id: `extracted-${index}`,
			label: `Q${index + 1}`,
			prompt: input.question,
			options: input.options.map((option) => ({ value: option, label: option })),
			allowOther: input.allowOther === true,
		};
		const result = await runQuestionTaking(ui, [question], {
			mode: "extracted",
			presentation: "extracted",
			customEmptyBehavior: "reject",
		});
		if (result.status !== "completed") return null;
		const answer = result.answers[0];
		if (!answer) return null;
		answers.push({ question: input.question, answer: answer.value });
	}
	return answers;
}

