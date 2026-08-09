/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions.
 * The interaction itself lives in the shared question-taking module.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	askQuestionnaire,
	type QuestionTakingQuestion,
	type QuestionnaireResult,
} from "../question-taking/interaction.ts";

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(
	message: string,
	questions: QuestionTakingQuestion[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") return errorResult("Error: UI not available (running in non-interactive mode)");
			if (params.questions.length === 0) return errorResult("Error: No questions provided");

			const result = await askQuestionnaire(ctx.ui, params.questions);
			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((answer) => {
				const question = result.questions.find((candidate) => candidate.id === answer.id);
				const label = question?.label || answer.id;
				if (answer.wasCustom) return `${label}: user wrote: ${answer.label}`;
				return `${label}: user selected: ${answer.index}. ${answer.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const questions = (args.questions as QuestionTakingQuestion[]) || [];
			const labels = questions.map((question) => question.label || question.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${questions.length} question${questions.length !== 1 ? "s" : ""}`);
			if (labels) text += theme.fg("dim", ` (${labels})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);

			const lines = details.answers.map((answer) => {
				if (answer.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${theme.fg("muted", "(wrote) ")}${answer.label}`;
				}
				const display = answer.index ? `${answer.index}. ${answer.label}` : answer.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
