/**
 * question-taking — 逐题收集用户对「抽取式问题」的回答。
 *
 * 接口只有一个 askExtractedQuestions：传入问题清单，拿到按序回答；任何一题
 * 被取消（Esc）都返回 null。选项渲染、自定义输入、按键路由是模块内部实现，
 * 调用方（qna）不需要知道。
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export type QuestionTakingUI = Pick<ExtensionUIContext, "custom">;

export interface ExtractedQuestion {
	question: string;
	options: string[];
	allowOther?: boolean;
}

export interface ExtractedAnswer {
	question: string;
	answer: string;
}

/** 一题的最终结局：作答完成拿到答案，或用户跳过。 */
interface QuestionOutcome {
	status: "completed" | "cancelled";
	value: string;
}

/** 一题会话内的可变视图状态；对外不可见。 */
interface QuestionViewState {
	optionIndex: number;
	inputMode: boolean;
	status: "active" | "completed" | "cancelled";
}

interface RenderOption {
	value: string;
	label: string;
	isOther?: boolean;
}

const OTHER_LABEL = "Type something.";

function optionsFor(question: ExtractedQuestion): RenderOption[] {
	const base: RenderOption[] = question.options.map((option) => ({ value: option, label: option }));
	if (question.allowOther !== true) return base;
	return [...base, { value: "__other__", label: OTHER_LABEL, isOther: true }];
}

export async function askExtractedQuestions(
	ui: QuestionTakingUI,
	inputs: ExtractedQuestion[],
): Promise<ExtractedAnswer[] | null> {
	const answers: ExtractedAnswer[] = [];
	for (let index = 0; index < inputs.length; index++) {
		const input = inputs[index]!;
		const outcome = await askOneQuestion(ui, input);
		if (outcome.status !== "completed") return null;
		answers.push({ question: input.question, answer: outcome.value });
	}
	return answers;
}

async function askOneQuestion(ui: QuestionTakingUI, question: ExtractedQuestion): Promise<QuestionOutcome> {
	return ui.custom<QuestionOutcome>((tui, theme, _keybindings, done) => {
		const options = optionsFor(question);
		let view: QuestionViewState = { optionIndex: 0, inputMode: false, status: "active" };
		let outcome: QuestionOutcome | undefined;
		let cachedLines: string[] | undefined;

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
			if (outcome && view.status !== "active") done(outcome);
		}

		function setView(next: QuestionViewState) {
			view = next;
			refresh();
			finishIfDone();
		}

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			// 空的自定义输入不作答，退回选项列表
			if (!trimmed) {
				editor.setText("");
				setView({ ...view, inputMode: false });
				return;
			}
			editor.setText("");
			outcome = { status: "completed", value: trimmed };
			setView({ ...view, inputMode: false, status: "completed" });
		};

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const renderWidth = Math.max(1, width);

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

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			addWrappedWithPrefix(" ", theme.fg("text", question.question));
			lines.push("");
			for (let i = 0; i < options.length; i++) {
				const option = options[i]!;
				const isSelected = i === view.optionIndex;
				const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
				const pencil = option.isOther && view.inputMode ? " ✎" : "";
				const color = isSelected || (option.isOther && view.inputMode) ? "accent" : "text";
				addWrappedWithPrefix(prefix, theme.fg(color, `${i + 1}. ${option.label}${pencil}`));
			}
			lines.push("");

			if (view.inputMode) {
				addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
				for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
				lines.push("");
				addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
			} else {
				addWrappedWithPrefix(" ", theme.fg("dim", "↑↓ 导航 • Enter 选择 • Esc 跳过"));
			}
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			cachedLines = lines;
			return lines;
		}

		function handleInput(data: string) {
			if (view.status !== "active") return;

			if (view.inputMode) {
				// Esc 退出自定义输入回到选项；其余按键交给编辑器
				if (matchesKey(data, Key.escape)) {
					editor.setText("");
					setView({ ...view, inputMode: false });
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				setView({ ...view, optionIndex: Math.max(0, view.optionIndex - 1) });
				return;
			}
			if (matchesKey(data, Key.down)) {
				const max = Math.max(0, options.length - 1);
				setView({ ...view, optionIndex: Math.min(max, view.optionIndex + 1) });
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const selected = options[view.optionIndex];
				if (!selected) return;
				if (selected.isOther) {
					setView({ ...view, inputMode: true });
					return;
				}
				outcome = { status: "completed", value: selected.value };
				setView({ ...view, status: "completed" });
				return;
			}
			if (matchesKey(data, Key.escape)) {
				outcome = { status: "cancelled", value: "" };
				setView({ ...view, status: "cancelled" });
				return;
			}
			// 其余按键（Tab、左右方向等）在选项模式下是死键
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}
