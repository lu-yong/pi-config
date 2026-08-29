import assert from "node:assert/strict";
import { test } from "node:test";

import {
	type BranchEntry,
	fingerprint,
	getLastAssistantText,
	hasTrailingQuestion,
	parseQuestions,
	questionScanTail,
	rawQuestionScanWindow,
	sanitizeForQuestionScan,
	shouldAutoExtract,
	stripFencedCodeBlocks,
	stripIndentedCodeBlocks,
	stripInlineCode,
	stripUrls,
} from "./extraction.ts";

function assistant(stopReason: string, texts: string[]): BranchEntry {
	return {
		type: "message",
		message: { role: "assistant", stopReason, content: texts.map((text) => ({ type: "text", text })) },
	};
}

test("parseQuestions reads well-formed multi-question output", () => {
	const parsed = parseQuestions("[Q] 用哪个方案?\n[O] A\n[O] B\n\n[Q] 何时开始?\n[O] 现在\n[O] 稍后\n");
	assert.deepEqual(parsed, [
		{ question: "用哪个方案?", options: ["A", "B"] },
		{ question: "何时开始?", options: ["现在", "稍后"] },
	]);
});

test("parseQuestions returns nothing for [NONE]", () => {
	assert.deepEqual(parseQuestions("[NONE]"), []);
	assert.deepEqual(parseQuestions("[Q] 忽略\n[O] A\n[NONE]\n"), []);
});

test("parseQuestions drops questions without options", () => {
	const parsed = parseQuestions("[Q] 无选项\n[Q] 有选项\n[O] A\n");
	assert.deepEqual(parsed, [{ question: "有选项", options: ["A"] }]);
});

test("parseQuestions ignores [O] lines before any [Q]", () => {
	const parsed = parseQuestions("[O] 孤儿\n[Q] 问题\n[O] A\n");
	assert.deepEqual(parsed, [{ question: "问题", options: ["A"] }]);
});

test("parseQuestions tolerates surrounding whitespace", () => {
	const parsed = parseQuestions("   \n  [Q]    问题   \n\t[O]   A  \n");
	assert.deepEqual(parsed, [{ question: "问题", options: ["A"] }]);
});

test("parseQuestions yields nothing when the model ignores the [Q]/[O] protocol", () => {
	// 模型不听话是常态（尤其廉价模型）。这时必须安静地返回空，让调用方走"未发现问题"，
	// 而不是造出半截问题去打扰用户。
	assert.deepEqual(parseQuestions("Sure! Here are the questions:\n\n1. 用哪个方案?\n2. 何时开始?"), []);
	assert.deepEqual(parseQuestions(""), []);
	assert.deepEqual(parseQuestions("   \n\n  "), []);
	// 标记必须大写且顶格（trim 之后）：小写、行中出现的都不算。
	assert.deepEqual(parseQuestions("[q] 小写\n[o] A"), []);
	assert.deepEqual(parseQuestions("问题是 [Q] 什么\n[O] A"), []);
	// 标记后面没有内容也不算。
	assert.deepEqual(parseQuestions("[Q]\n[O]\n"), []);
});

test("parseQuestions still reads blocks the model wrapped in a code fence", () => {
	// system prompt 里的示例用了 <code> 标签，模型经常自作主张换成 ``` 包一层。
	assert.deepEqual(parseQuestions("```\n[Q] 用哪个方案?\n[O] A\n[O] B\n```"), [
		{ question: "用哪个方案?", options: ["A", "B"] },
	]);
});

test("fingerprint is stable per input and separates different inputs", () => {
	assert.equal(fingerprint("hello"), fingerprint("hello"));
	assert.notEqual(fingerprint("hello"), fingerprint("hellp"));
	assert.equal(typeof fingerprint(""), "string");
});

test("shouldAutoExtract requires a question mark", () => {
	assert.equal(shouldAutoExtract("没有问号", new Set()), false);
	assert.equal(shouldAutoExtract("Which one?", new Set()), true);
	assert.equal(shouldAutoExtract("选哪个？", new Set()), true);
});

test("shouldAutoExtract skips already-seen text", () => {
	const text = "Which one?";
	assert.equal(shouldAutoExtract(text, new Set([fingerprint(text)])), false);
	assert.equal(shouldAutoExtract(text, new Set(["other"])), true);
});

// ---- 净化: 围栏代码块 ----

test("stripFencedCodeBlocks removes backtick fences including the language tag", () => {
	const text = "开头\n```ts\nconst a = x ? y : z;\n```\n结尾";
	assert.equal(stripFencedCodeBlocks(text), "开头\n结尾");
});

test("stripFencedCodeBlocks removes tilde fences", () => {
	assert.equal(stripFencedCodeBlocks("开头\n~~~python\nx = a if b else c  # ?\n~~~\n结尾"), "开头\n结尾");
});

test("stripFencedCodeBlocks keeps a tilde fence from closing a backtick fence", () => {
	const text = "a\n```\n~~~\n还在块里?\n```\nb";
	assert.equal(stripFencedCodeBlocks(text), "a\nb");
});

test("stripFencedCodeBlocks honours longer fences and indented fences", () => {
	assert.equal(stripFencedCodeBlocks("a\n````md\n```\n里面?\n```\n````\nb"), "a\nb");
	assert.equal(stripFencedCodeBlocks("a\n   ```\n里面?\n   ```\nb"), "a\nb");
});

test("stripFencedCodeBlocks drops everything after an unterminated fence", () => {
	// 宁可漏触发也不要把半截代码当散文。
	assert.equal(stripFencedCodeBlocks("散文\n```\n没闭合?\n"), "散文");
});

test("stripFencedCodeBlocks rejects a backtick info string that contains a backtick", () => {
	// CommonMark: 反引号开围栏的 info string 里不许再出现反引号，所以这一行不是开围栏，是散文。
	const text = "```a`b\n后面还要继续吗？";
	assert.equal(stripFencedCodeBlocks(text), text);
	// 波浪号围栏没有这条限制：同样的 info string 能开围栏，后面的内容按代码删掉。
	assert.equal(stripFencedCodeBlocks("~~~a`b\n后面还要继续吗？"), "");
});

test("stripFencedCodeBlocks does not let a fence line with trailing content close a block", () => {
	// 闭围栏后面只允许空白；``` 后面跟了字的这一行仍然在块里。
	assert.equal(stripFencedCodeBlocks("a\n```\n里面?\n``` 还没完\n还在块里?\n```\nb"), "a\nb");
});

// ---- 净化: 缩进代码块 ----

test("stripIndentedCodeBlocks removes a 4-space block that follows a blank line", () => {
	const text = '最终实现：\n\n    const label = ready ? "yes" : "no";\n    const id = user?.id;\n';
	assert.equal(sanitizeForQuestionScan(text).includes("?"), false);
	assert.equal(shouldAutoExtract(text, new Set()), false);
});

test("stripIndentedCodeBlocks keeps indented continuation lines inside a list", () => {
	// markdown 里列表内容本来就缩进；把它当代码剥掉会把真问题一起吃掉。
	const text = "两条路：\n\n- 方案 A：先收紧触发\n\n    这一条还有个补充，要我按它改吗？\n";
	assert.equal(shouldAutoExtract(text, new Set()), true);
	assert.equal(stripIndentedCodeBlocks("1. 第一步\n\n    继续说明？"), "1. 第一步\n\n    继续说明？");
});

test("stripIndentedCodeBlocks does not let an indented block interrupt a paragraph", () => {
	// 前面没有空行时，缩进行只是段落的续行（CommonMark 同样如此），不能当代码删掉。
	assert.equal(stripIndentedCodeBlocks("这句话没写完\n    要继续吗？"), "这句话没写完\n    要继续吗？");
});

test("stripIndentedCodeBlocks treats a tab-indented block the same as four spaces", () => {
	assert.equal(stripIndentedCodeBlocks("实现：\n\n\tconst id = user?.id;\n"), "实现：\n\n");
});

// ---- 净化: 行内代码 ----

test("stripInlineCode removes single-backtick spans", () => {
	assert.equal(sanitizeForQuestionScan("看 `cond ? a : b` 这一行").includes("?"), false);
});

test("stripInlineCode handles multi-backtick delimiters", () => {
	assert.equal(stripInlineCode("前 ``a ` b?`` 后").includes("?"), false);
});

test("stripInlineCode keeps an unmatched backtick run as plain text", () => {
	assert.equal(stripInlineCode("剩下一个 ` 反引号?"), "剩下一个 ` 反引号?");
});

test("stripInlineCode pairs backticks within a line, never across paragraphs", () => {
	// code span 是段落内的 inline。全文扫描时，一个落单的反引号会一路吃到后文第一个反引号，
	// 把中间的真问题整段吞掉 —— 功能静默失效，比多一次模型调用严重得多。
	const text =
		"注意反引号 ` 这个字符在 markdown 里有特殊含义。\n\n" +
		"我已经把实现改好了，测试也全部通过。\n\n" +
		"要我顺手把 README 也更新一下吗？跑 `npm test` 可以验证。";
	const sanitized = sanitizeForQuestionScan(text);
	assert.equal(sanitized.includes("我已经把实现改好了"), true);
	assert.equal(sanitized.includes("要我顺手把 README 也更新一下吗？"), true);
	assert.equal(sanitized.includes("npm test"), false);
	assert.equal(shouldAutoExtract(text, new Set()), true);
});

// ---- 净化: URL ----

test("stripUrls removes query strings", () => {
	assert.equal(stripUrls("见 https://x.dev/a?b=c&d=e 这里").includes("?"), false);
	assert.equal(stripUrls("见 http://x.dev/a?b=1 这里").includes("?"), false);
});

test("stripUrls keeps markdown link text and the closing paren", () => {
	assert.equal(stripUrls("[文档](https://x.dev/a?b=c) 之后"), "[文档]( ) 之后");
});

// ---- 尾部窗口 ----

test("questionScanTail returns the whole text when it is short", () => {
	assert.equal(questionScanTail("短文本"), "短文本");
});

test("questionScanTail keeps only the trailing window and ignores trailing blank lines", () => {
	// 显式传 limit，断言一个具体的字符串 —— 不跟 QUESTION_SCAN_TAIL_CHARS 耦合，
	// 也不写成 slice(-N).length === N 那种恒真断言。
	assert.equal(questionScanTail(`${"甲".repeat(50)}尾巴？\n\n  \n`, 10), `${"甲".repeat(7)}尾巴？`);
});

// ---- 误触发场景 ----

test("shouldAutoExtract ignores question marks that only appear in code", () => {
	const fenced = "这是实现：\n\n```ts\nconst label = ready ? \"是\" : \"否\";\nconst id = user?.id;\n```\n\n改完了。";
	assert.equal(shouldAutoExtract(fenced, new Set()), false);

	const inline = "我把 `a ? b : c` 换成了 `a?.b`，行为不变。";
	assert.equal(shouldAutoExtract(inline, new Set()), false);
});

test("shouldAutoExtract ignores question marks inside URLs", () => {
	const text = "参考 https://api.example.com/v1/search?q=pi&page=2 里的说明，已经按它改好了。";
	assert.equal(shouldAutoExtract(text, new Set()), false);
});

test("hasTrailingQuestion ignores a question that only appears mid-body", () => {
	// 显式传 limit，不跟 QUESTION_SCAN_TAIL_CHARS 的具体取值耦合。
	const limit = 40;
	const text = `一开始我在想，这里到底要不要加缓存？\n\n${"后来我把结论写在下面，逐条说明。".repeat(10)}\n\n最终按无缓存实现，已经跑通。`;
	assert.equal(hasTrailingQuestion(text, limit), false);
	// 同一段文本，窗口放大到能覆盖全文就会命中 —— 判定确实由 limit 决定，不是别的原因。
	assert.equal(hasTrailingQuestion(text, text.length), true);
});

test("shouldAutoExtract still fires for a genuine trailing question", () => {
	const withCode = "改完了：\n\n```ts\nconst x = a ? b : c;\n```\n\n要我顺手把测试也补上吗？";
	assert.equal(shouldAutoExtract(withCode, new Set()), true);

	const english = "Done. Should I also update the README?";
	assert.equal(shouldAutoExtract(english, new Set()), true);
});

test("shouldAutoExtract still fires when the question sits above a trailing option list", () => {
	// 最常见的提问形状；按"最后一个段落"取会漏掉它，所以尾部窗口用的是字符数。
	const text = "两条路都可行。\n\n你想走哪条？\n\n- 方案 A：先收紧触发\n- 方案 B：先换模型";
	assert.equal(shouldAutoExtract(text, new Set()), true);
});

test("hasTrailingQuestion is the sanitized-tail predicate behind shouldAutoExtract", () => {
	assert.equal(hasTrailingQuestion("行内 `x ? y : z` 而已"), false);
	assert.equal(hasTrailingQuestion("要继续吗？"), true);
});

// ---- 回滑上界 ----

test("hasTrailingQuestion caps how far the tail window slides back", () => {
	const limit = 20;
	const question = "要不要加缓存？我觉得不用。";
	const tail = "\n\n已经跑通。";
	const code = `\n\n\`\`\`\n${"x = a ? b : c;\n".repeat(20)}\`\`\``;

	// 没有代码块时这个 limit 看得见那个问号 —— 说明窗口本身够大。
	assert.equal(hasTrailingQuestion(question + tail, limit), true);
	// 中间塞进一段长代码后，回滑被原文侧的上界挡住，窗口里只剩结论那句。
	assert.equal(hasTrailingQuestion(question + code + tail, limit), false);
	// 上界封的是"回滑多远"，不是"跳过尾部代码块"这件事本身：短代码块照样跳得过去。
	assert.equal(hasTrailingQuestion("要我继续吗？\n\n```\nx = a ? b : c;\n```", limit), true);
});

test("shouldAutoExtract ignores a mid-body question buried behind a long trailing diff", () => {
	// review 的反例：40 行 diff 结尾时，净化后的窗口会滑到 diff 之前的散文上，
	// 而中段反问句最爱待在那儿。原文侧的上界正是为这个场景设的。
	const diff = Array.from({ length: 40 }, (_, i) => `+  const cached = await store.get(key); // line ${i}`).join("\n");
	const text = `你说得对，我改用方案 B 了。至于要不要顺便加缓存？我觉得没必要，数据量太小。\n\n改动如下：\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n已经跑通全部测试。`;
	assert.equal(shouldAutoExtract(text, new Set()), false);

	// 同样长度的代码块，但结尾确实是个问句时仍要触发。
	assert.equal(shouldAutoExtract(`\`\`\`diff\n${diff}\n\`\`\`\n\n要我顺手把测试也补上吗？`, new Set()), true);
});

test("rawQuestionScanWindow never cuts into the middle of a fenced block", () => {
	// 切点落进围栏内部时必须往后挪：把闭围栏当成开围栏会让 stripFencedCodeBlocks
	// 删光它后面的散文，也就是那句真问题。
	const body = "x = a ? b : c;\n".repeat(20);
	const text = `开头的话。\n\n\`\`\`\n${body}\`\`\`\n\n要我继续吗？`;
	const window = rawQuestionScanWindow(text, 60);
	assert.equal(window.includes("```"), false);
	assert.equal(window.endsWith("要我继续吗？"), true);
	// 短到不需要截断时原样返回。
	assert.equal(rawQuestionScanWindow(text, text.length), text);
});

test("rawQuestionScanWindow always keeps the last line, however long it is", () => {
	const long = `${"甲".repeat(500)}要继续吗？`;
	assert.equal(rawQuestionScanWindow(long, 10), long);
	assert.equal(hasTrailingQuestion(long, 20), true);
});

test("shouldAutoExtract fingerprints the original text, not the sanitized one", () => {
	// 两条回复只有代码块不同；若按净化文本去重，它们会撞成同一个指纹而互相吞掉。
	const first = "```ts\nconst a = 1;\n```\n\n要继续吗？";
	const second = "```ts\nconst b = 2;\n```\n\n要继续吗？";
	assert.notEqual(fingerprint(first), fingerprint(second));

	const seen = new Set([fingerprint(first)]);
	assert.equal(shouldAutoExtract(first, seen), false);
	assert.equal(shouldAutoExtract(second, seen), true);
});

test("getLastAssistantText picks the newest assistant text", () => {
	const branch: BranchEntry[] = [assistant("stop", ["旧"]), assistant("stop", ["新"])];
	assert.equal(getLastAssistantText(branch), "新");
});

test("getLastAssistantText joins multiple text parts", () => {
	assert.equal(getLastAssistantText([assistant("stop", ["a", "b"])]), "a\nb");
});

test("getLastAssistantText returns undefined when the message did not stop", () => {
	assert.equal(getLastAssistantText([assistant("stop", ["旧"]), assistant("toolUse", ["新"])]), undefined);
});

test("getLastAssistantText skips trailing non-assistant entries", () => {
	const branch: BranchEntry[] = [
		assistant("stop", ["答案"]),
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "问题" }] } },
		{ type: "checkpoint" },
	];
	assert.equal(getLastAssistantText(branch), "答案");
});

test("getLastAssistantText returns undefined for an empty branch or textless message", () => {
	assert.equal(getLastAssistantText([]), undefined);
	assert.equal(getLastAssistantText([assistant("stop", [])]), undefined);
});

test("getLastAssistantText falls through a textless assistant message to an older one", () => {
	// Pins continue-vs-return semantics: a textless stopped message must not end the walk.
	assert.equal(getLastAssistantText([assistant("stop", ["旧"]), assistant("stop", [])]), "旧");
});
