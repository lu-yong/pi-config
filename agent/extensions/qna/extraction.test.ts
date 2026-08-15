import assert from "node:assert/strict";
import { test } from "node:test";

import {
	type BranchEntry,
	fingerprint,
	getLastAssistantText,
	parseQuestions,
	shouldAutoExtract,
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
