/**
 * Q&A 抽取器 — 从 AI 回复中提取问题，统一交给 question-taking 交互模块回答
 * 自动触发: AI 回复完成后自动检测问题并弹出选择
 * 手动触发: /qna
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

import { askExtractedQuestions } from "../question-taking/interaction.ts";
import { isQnaSuppressedByActiveGoal, rejectManualQnaForActiveGoal } from "./goal-policy.ts";
import {
	SYSTEM_PROMPT,
	type BranchEntry,
	fingerprint,
	getLastAssistantText,
	parseQuestions,
	shouldAutoExtract,
} from "./extraction.ts";

/** 已处理过的消息 ID，防止重复触发 */
const processedMessageIds = new Set<string>();

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.model) return;
		if (isQnaSuppressedByActiveGoal(ctx.cwd)) return;
		const lastText = lastAssistantText(ctx);
		if (!lastText || !shouldAutoExtract(lastText, processedMessageIds)) return;

		await runQna(ctx, lastText);
	});

	pi.registerCommand("qna", {
		description: "从最后一条 AI 回复中提取问题，箭头选择回答",
		handler: async (_args, ctx) => {
			if (rejectManualQnaForActiveGoal(ctx.cwd, (message, level) => ctx.ui.notify(message, level))) return;
			if (ctx.mode !== "tui") {
				ctx.ui.notify("qna 需要交互模式", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("未选择模型", "error");
				return;
			}

			const lastText = lastAssistantText(ctx);
			if (!lastText) {
				ctx.ui.notify("未找到 AI 回复", "error");
				return;
			}
			await runQna(ctx, lastText);
		},
	});
}

function lastAssistantText(ctx: ExtensionContext): string | undefined {
	return getLastAssistantText(ctx.sessionManager.getBranch() as unknown as BranchEntry[]);
}

async function runQna(ctx: ExtensionContext, lastText: string): Promise<void> {
	const extraction = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `抽取问题中... (${ctx.model!.id})`);
		loader.onAbort = () => done(null);

		const doExtract = async () => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? `无 API key: ${ctx.model!.provider}` : auth.error);
			}
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: lastText }],
				timestamp: Date.now(),
			};
			const response = await complete(
				ctx.model!,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: loader.signal },
			);
			if (response.stopReason === "aborted") return null;
			return response.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join("\n");
		};

		doExtract().then(done).catch(() => done(null));
		return loader;
	});

	if (!extraction) {
		ctx.ui.notify("取消了抽取", "info");
		return;
	}

	const questions = parseQuestions(extraction);
	if (questions.length === 0) {
		ctx.ui.notify("未在 AI 回复中发现问题", "info");
		return;
	}

	processedMessageIds.add(fingerprint(lastText));

	const answers = await askExtractedQuestions(ctx.ui, questions);
	if (!answers) {
		ctx.ui.notify("已跳过 Q&A", "info");
		return;
	}

	const result =
		"### Q&A 汇总\n\n" +
		answers.map(({ question, answer }) => `**Q: ${question}**\nA: ${answer}`).join("\n\n") +
		"\n\n---\n提交后 AI 将根据你的回答继续处理。";

	ctx.ui.setEditorText(result);
	ctx.ui.notify(`已汇总 ${answers.length} 个问题，编辑后提交即可`, "info");
}
