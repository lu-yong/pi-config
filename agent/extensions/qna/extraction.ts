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

// ---- 触发前的净化 ----
//
// 问号在技术回复里到处都是: 三元/可选链 (`a ? b : c`, `a?.b`)、URL query string、
// 正则、引用的报错。这些都不是在问用户。净化的目标是只留下"散文"，再判定问号。

/** 围栏行: 最多 3 个前导空格 + 3 个以上的 ` 或 ~，其余为 info string */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * 逐行推进围栏状态。返回长度为 lines.length + 1 的数组，
 * states[i] 表示第 i 行**开始之前**是否位于围栏代码块内部（states[0] 恒为 false）。
 *
 * 开围栏行两端状态是 false -> true，闭围栏行是 true -> false，块内行是 true -> true，
 * 于是"两端都为 false"恰好等价于"这一行是散文"。
 */
function fenceStates(lines: readonly string[]): boolean[] {
	const states: boolean[] = [false];
	let openFence: string | null = null;
	for (const line of lines) {
		const match = FENCE_LINE.exec(line);
		if (openFence === null) {
			// 反引号开围栏的 info string 里不允许再出现反引号（CommonMark）
			if (match && (match[1]![0] === "~" || !match[2]!.includes("`"))) openFence = match[1]!;
		} else if (
			// 闭围栏必须同字符、不短于开围栏，且后面只有空白
			match &&
			match[1]![0] === openFence[0] &&
			match[1]!.length >= openFence.length &&
			match[2]!.trim() === ""
		) {
			openFence = null;
		}
		states.push(openFence !== null);
	}
	return states;
}

/**
 * 剥离围栏代码块（``` 与 ~~~，含带语言标注的开围栏），连围栏行一起删掉。
 * 未闭合的围栏一路删到文末 —— 宁可漏触发，也不要把代码当散文。
 */
export function stripFencedCodeBlocks(text: string): string {
	const lines = text.split("\n");
	const states = fenceStates(lines);
	return lines.filter((_, i) => !states[i]! && !states[i + 1]!).join("\n");
}

/** 列表项起始行: 最多 3 个前导空格 + `-`/`*`/`+` 或 `1.`/`1)` 之类的有序标记 */
const LIST_ITEM_LINE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** 缩进代码块的行: 4 个以上前导空格，或一个前导 tab */
const INDENTED_CODE_LINE = /^(?: {4}|\t)/;

/**
 * 剥离缩进代码块（4 空格 / tab 缩进）。在围栏剥离**之后**跑，所以看到的都是围栏外的行。
 *
 * 两条与 CommonMark 对齐的约束，都是为了不误伤散文：
 * 1. 缩进代码块不能打断段落 —— 必须前面有空行（或位于文首）才算开始；
 * 2. 列表内容本来就带缩进，列表上下文里的缩进行是续行而不是代码。
 *    列表上下文一直保持到下一个顶格的非列表行为止 —— 这个方向偏保守：
 *    少剥一段代码顶多多一次模型调用，剥掉了列表里的真问题却会让功能静默失效。
 */
export function stripIndentedCodeBlocks(text: string): string {
	const kept: string[] = [];
	let previousBlank = true; // 文首等同于"前面有空行"
	let inList = false;
	let inCode = false;
	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			kept.push(line);
			previousBlank = true;
			continue;
		}
		if (INDENTED_CODE_LINE.test(line)) {
			if (!inList && (previousBlank || inCode)) {
				inCode = true;
				previousBlank = false;
				continue;
			}
			previousBlank = false;
			kept.push(line);
			continue;
		}
		inCode = false;
		previousBlank = false;
		// 顶格的非列表行关闭列表上下文；缩进 1-3 空格的行有可能是续行，保持原状态。
		if (LIST_ITEM_LINE.test(line)) inList = true;
		else if (!/^[ \t]/.test(line)) inList = false;
		kept.push(line);
	}
	return kept.join("\n");
}

/**
 * 剥离行内代码 span。支持多反引号定界（`` `a` `` 这种），闭合 run 的长度必须与开启 run 相等。
 * 找不到配对时保留这串反引号原样 —— 它只是普通文本。
 *
 * 逐行配对。CommonMark 的 code span 确实允许跨行（段落内），但**绝不跨段落**，
 * 而全文扫描连段落都不看：一个落单的反引号会一路吃到后文第一个反引号，
 * 把中间的真问题整段吞掉，功能静默失效。逐行是更保守的近似 ——
 * 代价只是极少见的跨行 span 漏剥（多一次模型调用）。
 */
export function stripInlineCode(text: string): string {
	return text.split("\n").map(stripInlineCodeLine).join("\n");
}

function stripInlineCodeLine(text: string): string {
	let out = "";
	let index = 0;
	while (index < text.length) {
		if (text[index] !== "`") {
			out += text[index];
			index += 1;
			continue;
		}
		const runStart = index;
		while (index < text.length && text[index] === "`") index += 1;
		const runLength = index - runStart;
		let scan = index;
		let closeEnd = -1;
		while (scan < text.length) {
			if (text[scan] !== "`") {
				scan += 1;
				continue;
			}
			let end = scan;
			while (end < text.length && text[end] === "`") end += 1;
			if (end - scan === runLength) {
				closeEnd = end;
				break;
			}
			scan = end;
		}
		if (closeEnd === -1) {
			out += text.slice(runStart, index);
			continue;
		}
		out += " ";
		index = closeEnd;
	}
	return out;
}

/** http/https URL，包括 query string；markdown 链接与尖括号 autolink 的定界符不吃进来 */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()[\]{}"'`]+/gi;

/** 剥离 URL —— `?foo=bar` 的问号从来不是在问用户 */
export function stripUrls(text: string): string {
	return text.replace(URL_PATTERN, " ");
}

/** 净化管线: 先围栏（内部可能含反引号和 URL），再缩进代码块，再行内代码，最后裸 URL */
export function sanitizeForQuestionScan(text: string): string {
	return stripUrls(stripInlineCode(stripIndentedCodeBlocks(stripFencedCodeBlocks(text))));
}

/**
 * 尾部窗口大小。中文约 2-4 句 + 一份短选项列表，英文约 3-4 句，都落得进来。
 */
export const QUESTION_SCAN_TAIL_CHARS = 400;

/**
 * 取净化后文本的尾部窗口。
 *
 * 选"末尾 N 字符"而不是"最后一个非空段落"，原因有二：
 * 1. 真实回复里最常见的提问形状是"问题？\n\n- 选项 A\n- 选项 B" —— 问句落在倒数第二段，
 *    按段落取会直接漏掉；漏掉真问题比多看一段话代价大得多（前者让功能失效，后者只是多一次模型调用）。
 * 2. markdown 的段落边界本身是模糊的（列表、表格、标题，以及剥离围栏后留下的空行），
 *    而字符窗口不需要解析、不会被结构骗到。
 *
 * 语义上这个窗口只决定"从结尾往回看多远"：贴着结尾的问号永远在窗口内，不受段落长度影响。
 */
export function questionScanTail(text: string, limit: number = QUESTION_SCAN_TAIL_CHARS): string {
	const trimmed = text.replace(/\s+$/, "");
	return trimmed.length <= limit ? trimmed : trimmed.slice(-limit);
}

/**
 * 净化前先在**原文**侧截掉的窗口大小，表示为尾部窗口的倍数。
 *
 * 净化会让尾部窗口"回滑"：尾部的代码被剥掉后，窗口滑到代码块**之前**的散文上。
 * 这一半是刻意的 —— "问题？\n```code```" 是完全合法的形状，不回滑就看不见那个问句。
 * 但回滑距离必须有上界，否则一段几百行的尾部代码块能把窗口一路推到整条回复的开头，
 * 让中段的反问句（"要不要顺便加缓存？我觉得没必要"）误触发。
 *
 * 取 3 倍：窗口本身 400 字符，原文侧 1200 字符足够容下"问句 + 一段几十行的代码块"，
 * 再远的散文就不该算"尾部"了。
 *
 * 已知残留：这是上界，不是消除。回复总长在 1200 字符以内时，尾部代码块被剥掉后剩下的
 * 散文短到能整个落进 400 字符窗口，中段反问句仍会误触发（实测边界约 1200 字符）。
 * 这是刻意留下的 —— 收紧它就会让"问题？\n```code```"这类形状漏掉真问题，而漏报是静默
 * 失效、比多一次抽取调用更难发现。残留的代价只是一次廉价模型调用后返回 [NONE]。
 */
export const QUESTION_SCAN_RAW_MULTIPLIER = 3;

/**
 * 原文侧的尾部截断，给回滑距离封顶。按行切，并保证切点不落在围栏代码块内部。
 *
 * 切点落进围栏内部时**往后**挪到围栏闭合之后：宁可少看一点，也不能把闭围栏当成开围栏 ——
 * 那会让 stripFencedCodeBlocks 把它后面的散文（往往正是那句真问题）整段删掉。
 * 最后一行永远保留，避免单行超长时窗口退化成空串。
 */
export function rawQuestionScanWindow(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const lines = text.split("\n");
	const states = fenceStates(lines);
	let start = lines.length - 1;
	let budget = limit - lines[start]!.length;
	while (start > 0) {
		const cost = lines[start - 1]!.length + 1;
		if (cost > budget) break;
		budget -= cost;
		start -= 1;
	}
	while (start < lines.length && states[start]!) start += 1;
	return lines.slice(start).join("\n");
}

/** 净化后，仅在尾部窗口内判定是否存在问号 */
export function hasTrailingQuestion(text: string, limit: number = QUESTION_SCAN_TAIL_CHARS): boolean {
	const raw = rawQuestionScanWindow(text, limit * QUESTION_SCAN_RAW_MULTIPLIER);
	return /[？?]/.test(questionScanTail(sanitizeForQuestionScan(raw), limit));
}

/**
 * 自动触发判定: 尾部（净化后）含问号且未处理过。
 * 指纹刻意基于**原始文本**计算 —— 去重要认的是"这条回复处理过没有"，
 * 换成净化文本会让两条只有代码块不同的回复撞成同一个指纹。
 */
export function shouldAutoExtract(text: string, seen: ReadonlySet<string>): boolean {
	if (!hasTrailingQuestion(text)) return false;
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
