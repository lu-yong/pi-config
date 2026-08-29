import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DEFAULT_AUTO_EXTRACT,
	defaultQnaSettings,
	normalizeQnaModelRef,
	normalizeQnaSettings,
	parseQnaSettings,
	resolveExtractionModel,
	type QnaSettings,
} from "./settings.ts";

interface FakeModel {
	provider: string;
	id: string;
}

const MAIN: FakeModel = { provider: "jucode", id: "gpt-5.6-luna" };
const CHEAP: FakeModel = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };

function resolve(settings: QnaSettings, options: { find?: FakeModel | undefined; hasAuth?: boolean } = {}) {
	return resolveExtractionModel<FakeModel>({
		settings,
		mainModel: MAIN,
		mainModelId: MAIN.id,
		find: () => ("find" in options ? options.find : CHEAP),
		hasAuth: () => options.hasAuth !== false,
	});
}

function settingsFor(model: unknown): QnaSettings {
	return normalizeQnaSettings({ qna: { model } });
}

// ---- autoExtract ----

test("autoExtract defaults to enabled when nothing is configured", () => {
	assert.equal(DEFAULT_AUTO_EXTRACT, true);
	assert.equal(defaultQnaSettings().autoExtract, true);
	assert.equal(parseQnaSettings(undefined).autoExtract, true);
	assert.equal(parseQnaSettings("{}").autoExtract, true);
	assert.equal(parseQnaSettings('{"qna":{}}').autoExtract, true);
});

test("autoExtract can be switched off", () => {
	assert.equal(parseQnaSettings('{"qna":{"autoExtract":false}}').autoExtract, false);
	assert.equal(parseQnaSettings('{"qna":{"autoExtract":true}}').autoExtract, true);
});

test("a non-boolean autoExtract falls back to the default instead of being coerced", () => {
	for (const raw of ['{"qna":{"autoExtract":"false"}}', '{"qna":{"autoExtract":0}}', '{"qna":{"autoExtract":null}}']) {
		assert.equal(parseQnaSettings(raw).autoExtract, true, raw);
	}
});

test("a broken settings file degrades to the defaults without throwing", () => {
	for (const raw of ["", "   ", "not json", "{", '{"qna":', '{"qna":"on"}', '{"qna":[1,2]}', "[]", '"text"', "null"]) {
		assert.deepEqual(parseQnaSettings(raw), defaultQnaSettings(), JSON.stringify(raw));
	}
});

// ---- qna.model 规范化 ----

test("normalizeQnaModelRef accepts a well-formed reference", () => {
	assert.deepEqual(normalizeQnaModelRef({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinking: "low" }), {
		provider: "openrouter",
		id: "z-ai/glm-5.3-flash",
		thinking: "low",
		invalidThinking: false,
	});
});

test("normalizeQnaModelRef rejects missing or mistyped provider/id", () => {
	for (const raw of [
		undefined,
		null,
		"openrouter/glm",
		[],
		{},
		{ provider: "openrouter" },
		{ id: "glm" },
		{ provider: "", id: "glm" },
		{ provider: "openrouter", id: "  " },
		{ provider: 1, id: "glm" },
		{ provider: "openrouter", id: { name: "glm" } },
	]) {
		assert.equal(normalizeQnaModelRef(raw), null, JSON.stringify(raw));
	}
});

test("an invalid thinking level is flagged but keeps the model reference", () => {
	const ref = normalizeQnaModelRef({ provider: "openrouter", id: "glm", thinking: "ultra" });
	assert.deepEqual(ref, { provider: "openrouter", id: "glm", thinking: null, invalidThinking: true });
	assert.equal(normalizeQnaModelRef({ provider: "openrouter", id: "glm" })?.invalidThinking, false);
});

test("modelConfigured separates an absent model key from an invalid one", () => {
	assert.equal(normalizeQnaSettings({ qna: {} }).modelConfigured, false);
	assert.equal(normalizeQnaSettings({ qna: { model: null } }).modelConfigured, false);
	assert.equal(normalizeQnaSettings({ qna: { model: "glm" } }).modelConfigured, true);
	assert.equal(normalizeQnaSettings({ qna: { model: "glm" } }).model, null);
});

// ---- 抽取模型解析与回退 ----

test("an unconfigured extraction model silently uses the main model", () => {
	const resolved = resolve(defaultQnaSettings());
	assert.equal(resolved.model, MAIN);
	assert.equal(resolved.thinking, null);
	assert.equal(resolved.usedFallback, true);
	assert.equal(resolved.notice, null);
});

test("a configured extraction model is used with its thinking level", () => {
	const resolved = resolve(settingsFor({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinking: "low" }));
	assert.equal(resolved.model, CHEAP);
	assert.equal(resolved.thinking, "low");
	assert.equal(resolved.usedFallback, false);
	assert.equal(resolved.notice, null);
});

test("an incomplete or mistyped model config falls back and says so", () => {
	for (const raw of ["glm", 42, {}, { provider: "openrouter" }, { id: "glm" }, { provider: 1, id: 2 }]) {
		const resolved = resolve(settingsFor(raw));
		assert.equal(resolved.model, MAIN, JSON.stringify(raw));
		assert.equal(resolved.usedFallback, true, JSON.stringify(raw));
		assert.match(resolved.notice ?? "", /配置不完整/, JSON.stringify(raw));
		assert.match(resolved.notice ?? "", new RegExp(MAIN.id));
	}
});

test("a model missing from the registry falls back and says so", () => {
	const resolved = resolve(settingsFor({ provider: "openrouter", id: "nope" }), { find: undefined });
	assert.equal(resolved.model, MAIN);
	assert.equal(resolved.usedFallback, true);
	assert.match(resolved.notice ?? "", /不在可用模型目录里/);
	assert.match(resolved.notice ?? "", /openrouter\/nope/);
});

test("a model without an API key falls back and says so", () => {
	const resolved = resolve(settingsFor({ provider: "openrouter", id: "z-ai/glm-5.3-flash" }), { hasAuth: false });
	assert.equal(resolved.model, MAIN);
	assert.equal(resolved.usedFallback, true);
	assert.match(resolved.notice ?? "", /没有可用的 API key/);
});

test("every fallback drops the configured thinking level so the main model keeps its own default", () => {
	const broken = settingsFor({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinking: "max" });
	assert.equal(resolve(broken, { find: undefined }).thinking, null);
	assert.equal(resolve(broken, { hasAuth: false }).thinking, null);
});

test("an invalid thinking level keeps the cheap model but warns", () => {
	const resolved = resolve(settingsFor({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinking: "ultra" }));
	assert.equal(resolved.model, CHEAP);
	assert.equal(resolved.thinking, null);
	assert.equal(resolved.usedFallback, false);
	assert.match(resolved.notice ?? "", /thinking 取值无效/);
});

test("resolution never throws for any malformed settings shape", () => {
	for (const raw of ["not json", "{", '{"qna":{"model":{"provider":[],"id":{}}}}', '{"qna":123}']) {
		assert.doesNotThrow(() => resolve(parseQnaSettings(raw)), raw);
	}
});
