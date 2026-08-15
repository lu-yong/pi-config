/**
 * Q&A 抽取管线 — 纯逻辑，不依赖 pi 运行时
 * 包含 [Q]/[O] 协议定义与解析、会话文本提取、指纹与自动触发判定
 */

export interface QItem {
	question: string;
	options: string[];
}

/** 抽取器的 system prompt，与 parseQuestions 共同定义 [Q]/[O] 协议 */
export const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, find ALL questions that need a decision/answer from the user.

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

/** 会话条目的最小结构描述，避免依赖 pi 类型 */
export interface BranchContentPart {
	type: string;
	text?: string;
}

export interface BranchMessage {
	role?: string;
	stopReason?: string;
	content?: BranchContentPart[];
}

export interface BranchEntry {
	type?: string;
	message?: BranchMessage;
}

/** 从会话分支中取最后一条已完成 assistant 消息的文本。 */
export function getLastAssistantText(branch: readonly (BranchEntry | undefined)[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "assistant") continue;
		if (message.stopReason !== "stop") return undefined;
		const parts = (message.content ?? [])
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text);
		if (parts.length > 0) return parts.join("\n");
	}
	return undefined;
}

export function fingerprint(text: string): string {
	let hash = 0;
	for (let i = 0; i < text.length; i++) {
		hash = (hash * 31 + text.charCodeAt(i)) | 0;
	}
	return hash.toString(36);
}

/** 自动触发判定: 文本含问号且未处理过 */
export function shouldAutoExtract(text: string, seen: ReadonlySet<string>): boolean {
	if (!/[？?]/.test(text)) return false;
	return !seen.has(fingerprint(text));
}

export function parseQuestions(text: string): QItem[] {
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
