/**
 * Q&A 抽取器 — 从 AI 回复中提取问题，统一交给 question-taking 交互模块回答
 * 自动触发: AI 回复完成后自动检测问题并弹出选择（可用 settings.json 的 qna.autoExtract 关掉）
 * 手动触发: /qna（不受 qna.autoExtract 影响）
 *
 * 这一层是适配器：读盘、pi 运行时调用都在这里，判定逻辑在 extraction.ts / settings.ts。
 */

import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, ThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";

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
import { authFallbackNotice, parseQnaSettings, resolveExtractionModel, type QnaSettings } from "./settings.ts";

/** 已处理过的消息 ID，防止重复触发 */
const processedMessageIds = new Set<string>();

/** 每次读盘而不是启动时缓存一次，改完 settings.json 立刻生效，不必重启 pi */
function loadSettings(): QnaSettings {
	let raw: string | undefined;
	try {
		raw = fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf8");
	} catch {
		// 文件缺失 / 无权限都按"未配置"处理
	}
	return parseQnaSettings(raw);
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.model) return;
		// 纯内存的判定放最前面：绝大多数回复根本不带尾部问号，不该为它们读两次盘。
		const lastText = lastAssistantText(ctx);
		if (!lastText || !shouldAutoExtract(lastText, processedMessageIds)) return;
		const settings = loadSettings();
		if (!settings.autoExtract) return;
		if (isQnaSuppressedByActiveGoal(ctx.cwd)) return;

		await runQna(ctx, lastText, settings);
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
			// 手动入口刻意不看 autoExtract：那个开关只管自动触发。
			await runQna(ctx, lastText, loadSettings());
		},
	});
}

function lastAssistantText(ctx: ExtensionContext): string | undefined {
	return getLastAssistantText(ctx.sessionManager.getBranch() as unknown as BranchEntry[]);
}

/**
 * 选出本次抽取用的模型并解析鉴权。自动路径和 /qna 共用这一条链路。
 * 任何一步失败都退回 ctx.model，并给一条可见提示；主模型也失败才算真的失败。
 */
async function prepareExtraction(
	ctx: ExtensionContext,
	settings: QnaSettings,
): Promise<{ model: Model<any>; thinking: ThinkingLevel | undefined } | null> {
	const mainModel = ctx.model!;
	const registry = ctx.modelRegistry;
	const choice = resolveExtractionModel<Model<any>>({
		settings,
		mainModel,
		mainModelId: mainModel.id,
		find: (provider, id) => registry.find(provider, id),
		hasAuth: (model) => registry.hasConfiguredAuth(model),
	});
	if (choice.notice) ctx.ui.notify(choice.notice, "warning");

	if (await hasResolvedAuth(ctx, choice.model)) return { model: choice.model, thinking: choice.thinking ?? undefined };

	// hasConfiguredAuth 只看 provider 级配置，真正取 key 仍可能失败（OAuth 过期等）。
	if (!choice.usedFallback) {
		ctx.ui.notify(authFallbackNotice(`${choice.model.provider}/${choice.model.id}`, mainModel.id), "warning");
		if (await hasResolvedAuth(ctx, mainModel)) return { model: mainModel, thinking: undefined };
	}
	ctx.ui.notify(`无法为主模型 ${mainModel.id} 取得 API key`, "error");
	return null;
}

async function hasResolvedAuth(ctx: ExtensionContext, model: Model<any>): Promise<boolean> {
	try {
		// Preserve the existing auth-failure fallback preflight, but never carry its
		// credential snapshot into a request. streamSimple resolves native provider
		// auth again at request time (including endpoint, headers and provider env).
		return (await ctx.modelRegistry.getApiKeyAndHeaders(model)).ok;
	} catch {
		return false;
	}
}

/**
 * 抽取的三种结局。刻意不用 `string | null`：
 * modelRegistry.streamSimple(...).result()，而 .result() 在**错误和中止时都 resolve**
 * （pi-ai/dist/utils/event-stream.js 的 AssistantMessageEventStream），provider 把整个流循环
 * 包在 try/catch 里，catch 中先把 stopReason 置为 "aborted"/"error" 再 push error 事件。
 * 所以 429/402/500 这类失败会以 `stopReason === "error"` + 空 content 的形式**正常返回** ——
 * 用 falsy 判定会把它和"用户按了 Esc"混为一谈，还顺手丢掉 provider 已经写好的 errorMessage。
 */
type ExtractionOutcome =
	| { kind: "aborted" }
	| { kind: "error"; message: string }
	| { kind: "text"; text: string };

function errorMessageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runQna(ctx: ExtensionContext, lastText: string, settings: QnaSettings): Promise<void> {
	const prepared = await prepareExtraction(ctx, settings);
	if (!prepared) return;
	const { model, thinking } = prepared;

	const outcome = await ctx.ui.custom<ExtractionOutcome>((tui, theme, _keybindings, done) => {
		// 显示实际使用的模型，回退发生时不会误导。
		const loader = new BorderedLoader(tui, theme, `抽取问题中... (${model.id})`);
		loader.onAbort = () => done({ kind: "aborted" });

		const doExtract = async (): Promise<ExtractionOutcome> => {
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: lastText }],
				timestamp: Date.now(),
			};
			// The current runtime owns provider dispatch and request-time auth.
			// streamSimple accepts the normalized thinking level, unlike stream.
			const response = await ctx.modelRegistry.streamSimple(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{ reasoning: thinking, signal: loader.signal },
			).result();
			if (response.stopReason === "aborted") return { kind: "aborted" };
			if (response.stopReason === "error") {
				return { kind: "error", message: response.errorMessage ?? "provider 返回了错误但没有给出错误信息" };
			}
			const text = response.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join("\n");
			return { kind: "text", text };
		};

		// Terminal error/aborted responses resolve; also cover a synchronous throw
		// or a rejected result from an extension-provided registry implementation.
		doExtract().then(done, (error) => done({ kind: "error", message: errorMessageOf(error) }));
		return loader;
	});

	if (outcome.kind === "aborted") {
		ctx.ui.notify("取消了抽取", "info");
		return;
	}
	if (outcome.kind === "error") {
		ctx.ui.notify(`抽取失败（${model.id}）：${outcome.message}`, "error");
		return;
	}
	// 拿到了响应但一个字都没有：和中止、和报错都得分开报，否则用户无从判断该改配置还是重试。
	if (outcome.text.trim() === "") {
		ctx.ui.notify(`抽取模型 ${model.id} 没有返回任何文本`, "error");
		return;
	}

	const questions = parseQuestions(outcome.text);
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
