/**
 * Q&A 抽取器 — 从 AI 回复中提取问题，统一交给 question-taking 交互模块回答
 * 自动触发: AI 回复完成后自动检测问题并弹出选择
 * 手动触发: /qna
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

import { askExtractedQuestions } from "../question-taking/interaction.ts";

interface QItem {
	question: string;
	options: string[];
}

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, find ALL questions that need a decision/answer from the user.

Output each question in this EXACT format (one per block, separated by blank line):

<code>
[Q] 问题文本
[O] 选项1
[O] 选项2
[O] 选项3
</code>

Rules:
- Only extract REAL questions that the user should answer (not rhetorical)
- Provide 2-5 concise options per question
- Keep options mutually exclusive
- If a question is Yes/No, options should be like "是" / "否" or the two clear choices
- Output ONLY the [Q]/[O] blocks, nothing else
- If no questions found, output: [NONE]`;

/** 已处理过的消息 ID，防止重复触发 */
const processedMessageIds = new Set<string>();

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.model) return;
		const lastText = getLastAssistantText(ctx);
		if (!lastText || !hasQuestionMark(lastText)) return;

		const fingerprint = simpleHash(lastText);
		if (processedMessageIds.has(fingerprint)) return;
		await runQna(ctx, lastText);
	});

	pi.registerCommand("qna", {
		description: "从最后一条 AI 回复中提取问题，箭头选择回答",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("qna 需要交互模式", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("未选择模型", "error");
				return;
			}

			const lastText = getLastAssistantText(ctx);
			if (!lastText) {
				ctx.ui.notify("未找到 AI 回复", "error");
				return;
			}
			await runQna(ctx, lastText);
		},
	});
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

	const fingerprint = simpleHash(lastText);
	processedMessageIds.add(fingerprint);

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

/** 从 session 中取最后一条已完成 assistant 消息的文本。 */
function getLastAssistantText(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!("role" in message) || message.role !== "assistant") continue;
		if (message.stopReason !== "stop") return undefined;
		const parts = message.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text);
		if (parts.length > 0) return parts.join("\n");
	}
	return undefined;
}

function hasQuestionMark(text: string): boolean {
	return /[？?]/.test(text);
}

function simpleHash(text: string): string {
	let hash = 0;
	for (let i = 0; i < text.length; i++) {
		hash = (hash * 31 + text.charCodeAt(i)) | 0;
	}
	return hash.toString(36);
}

function parseQuestions(text: string): QItem[] {
	const result: QItem[] = [];
	let current: QItem | null = null;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (/^\[NONE\]$/.test(line)) return [];
		const question = line.match(/^\[Q\]\s*(.+)$/);
		const option = line.match(/^\[O\]\s*(.+)$/);
		if (question) {
			current = { question: question[1]!, options: [] };
			result.push(current);
		} else if (option && current) {
			current.options.push(option[1]!);
		}
	}
	return result.filter((question) => question.options.length > 0);
}
