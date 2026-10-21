import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import qnaExtension, { runQna } from "./index.ts";
import { normalizeQnaSettings, defaultQnaSettings } from "./settings.ts";
import { SYSTEM_PROMPT } from "./extraction.ts";

// Construct the installed 1.1.0 runtime with NO built-in providers. Even an offline
// refresh of built-ins could inspect real provider environment credentials.
// Only this test helper uses its private constructor; production uses ctx's registry.
const core = new URL("./core/", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { ModelConfig } = await import(new URL("model-config.js", core).href);
const { RuntimeCredentials } = await import(new URL("runtime-credentials.js", core).href);
const { InMemoryCodingAgentModelsStore } = await import(new URL("models-store.js", core).href);
const { setThemeInstance } = await import(new URL("../modes/interactive/theme/theme.js", core).href);
setThemeInstance({ fg: (_color: string, text: string) => text });

async function fixture(t: TestContext) {
	const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("network forbidden in Q&A tests"); });
	const runtime: ModelRuntime = Reflect.construct(ModelRuntime, [
		new RuntimeCredentials(new InMemoryCredentialStore()), await ModelConfig.load(undefined),
		undefined, new InMemoryCodingAgentModelsStore(), [], false,
	]);
	const main = fauxProvider({ provider: "qna-main", api: "qna-native-main", models: [{ id: "main", reasoning: true }] });
	const cheap = fauxProvider({ provider: "qna-cheap", api: "qna-native-cheap", models: [{ id: "cheap", reasoning: true }] });
	runtime.registerNativeProvider(main.provider);
	runtime.registerNativeProvider(cheap.provider);
	await runtime.refresh({ allowNetwork: false });
	const registry = new ModelRegistry(runtime);
	const notices: { message: string; level: string }[] = [];
	const loaders: any[] = [];
	const ctx = {
		model: registry.find("qna-main", "main")!, modelRegistry: registry,
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
			custom: (factory: any) => new Promise((resolve, reject) => {
				let loader: any;
				let settled = false;
				const done = (value: unknown) => {
					if (settled) return;
					settled = true;
					loader?.dispose();
					resolve(value);
				};
				try {
					loader = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, done);
					loaders.push(loader);
				} catch (error) { loader?.dispose(); reject(error); }
			}),
		},
	} as unknown as ExtensionContext;
	t.after(() => { loaders.forEach((loader) => loader.dispose()); assert.equal(fetchMock.mock.callCount(), 0); });
	return { runtime, registry, ctx, main, cheap, notices, loaders };
}

const cheapSettings = normalizeQnaSettings({ qna: { model: { provider: "qna-cheap", id: "cheap", thinking: "high" } } });

test("Q&A uses current ModelRuntime with a native-only faux provider, never the compat API registry", async (t) => {
	const f = await fixture(t);
	f.main.setResponses([fauxAssistantMessage("[NONE]")]);
	await runQna(f.ctx, "Which one?", defaultQnaSettings());
	assert.equal(f.main.state.callCount, 1);
	assert.deepEqual(f.notices, [{ message: "未在 AI 回复中发现问题", level: "info" }]);
});

test("runtime owns request-time native auth, endpoint, headers and env; configured reasoning reaches provider", async (t) => {
	const f = await fixture(t);
	const auth = { apiKey: "offline-dummy", baseUrl: "http://localhost:0/request-time", headers: { "X-Qna-Test": "native" } };
	let authResolutions = 0;
	f.cheap.provider.auth.apiKey!.resolve = async () => {
		authResolutions++;
		return { auth: authResolutions === 1 ? { apiKey: "discarded-preflight-snapshot" } : auth, env: { QNA_TEST_ENV: "offline" } };
	};
	const streamSimple = f.registry.streamSimple.bind(f.registry);
	t.mock.method(f.registry, "streamSimple", (model, context, options) => {
		assert.deepEqual(Object.keys(options!).sort(), ["reasoning", "signal"]);
		return streamSimple(model, context, options);
	});
	f.cheap.setResponses([(context, options, _state, model) => {
		assert.equal(model.baseUrl, auth.baseUrl);
		assert.equal(options?.apiKey, auth.apiKey);
		assert.deepEqual(options?.headers, auth.headers);
		assert.equal(options?.env?.QNA_TEST_ENV, "offline");
		assert.equal(options?.reasoning, "high");
		assert.ok(options?.signal instanceof AbortSignal);
		assert.equal(context.messages[0].role, "system");
		assert.equal(getSystemMessageText(context.messages[0]), SYSTEM_PROMPT);
		assert.equal(context.messages[1].content[0].text, "Which one?");
		return fauxAssistantMessage("[NONE]");
	}]);
	await runQna(f.ctx, "Which one?", cheapSettings);
	assert.equal(f.cheap.state.callCount, 1);
	assert.equal(authResolutions, 2);
	assert.deepEqual(f.notices, [{ message: "未在 AI 回复中发现问题", level: "info" }]);
});

test("configured cheap model auth resolution failure visibly falls back to main, dropping reasoning", async (t) => {
	const f = await fixture(t);
	assert.equal(f.registry.hasConfiguredAuth(f.cheap.getModel()!), true);
	f.cheap.provider.auth.apiKey!.resolve = async () => { throw new Error("offline expired credential"); };
	f.main.setResponses([(_context, options) => {
		assert.equal(options?.reasoning, undefined);
		return fauxAssistantMessage("[NONE]");
	}]);
	await runQna(f.ctx, "Which one?", cheapSettings);
	assert.equal(f.cheap.state.callCount, 0);
	assert.equal(f.main.state.callCount, 1);
	assert.match(f.notices[0].message, /qna-cheap\/cheap.*回退到主模型 main/);
	assert.equal(f.notices[0].level, "warning");
	assert.match(f.loaders[0].render(100).join("\n"), /\(main\)/);
	assert.equal(f.notices[1].level, "info");
});

test("main auth failure is reported without calling either provider", async (t) => {
	const f = await fixture(t);
	f.main.provider.auth.apiKey!.resolve = async () => { throw new Error("offline auth failure"); };
	await runQna(f.ctx, "Which one?", defaultQnaSettings());
	assert.deepEqual(f.notices, [{ message: "无法为主模型 main 取得 API key", level: "error" }]);
	assert.equal(f.main.state.callCount, 0);
});

for (const [name, response, expected] of [
	["error", fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline 429" }), { message: "抽取失败（cheap）：offline 429", level: "error" }],
	["error without message", fauxAssistantMessage("", { stopReason: "error" }), { message: "抽取失败（cheap）：provider 返回了错误但没有给出错误信息", level: "error" }],
	["aborted", fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" }), { message: "取消了抽取", level: "info" }],
	["empty", fauxAssistantMessage(" \n\t"), { message: "抽取模型 cheap 没有返回任何文本", level: "error" }],
] as const) {
	test(`runtime ${name} outcome stays distinct and does not retry the main model`, async (t) => {
		const f = await fixture(t);
		f.cheap.setResponses([response]);
		await runQna(f.ctx, "Which one?", cheapSettings);
		assert.deepEqual(f.notices, [expected]);
		assert.equal(f.cheap.state.callCount, 1);
		assert.equal(f.main.state.callCount, 0);
	});
}

test("loader Esc cancellation propagates its signal to the native provider, with no late error notification", async (t) => {
	const f = await fixture(t);
	let providerFinished!: () => void;
	const finished = new Promise<void>((resolve) => { providerFinished = resolve; });
	f.main.setResponses([async (_context, options) => {
		assert.ok(options?.signal);
		const signal = options.signal;
		f.loaders[0].handleInput("\x1b");
		assert.equal(signal.aborted, true);
		providerFinished();
		return fauxAssistantMessage("late ignored text");
	}]);
	await runQna(f.ctx, "Which one?", defaultQnaSettings());
	await finished;
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(f.notices, [{ message: "取消了抽取", level: "info" }]);
	assert.equal(f.main.state.callCount, 1);
});

test("synchronous registry failure is an error, not a cancellation", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.registry, "streamSimple", () => { throw new Error("offline synchronous failure"); });
	await runQna(f.ctx, "Which one?", defaultQnaSettings());
	assert.deepEqual(f.notices, [{ message: "抽取失败（main）：offline synchronous failure", level: "error" }]);
});

test("rejected registry result reports provider details rather than cancellation", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.registry, "streamSimple", () => ({ result: async () => { throw new Error("offline rejected result"); } }) as any);
	await runQna(f.ctx, "Which one?", defaultQnaSettings());
	assert.deepEqual(f.notices, [{ message: "抽取失败（main）：offline rejected result", level: "error" }]);
});

test("virtual extraction models route through the current runtime and preserve routed reasoning", async (t) => {
	const f = await fixture(t);
	f.runtime.registerVirtualModel({ provider: "qna-router", id: "auto", thinkingLevels: ["high"], route(request) {
		assert.equal(request.reason, "direct");
		assert.equal(request.thinkingLevel, "high");
		return { model: f.main.getModel()!, thinkingLevel: "low" };
	} });
	await f.runtime.refresh({ allowNetwork: false });
	f.main.setResponses([(_context, options) => {
		assert.equal(options?.reasoning, "low");
		return fauxAssistantMessage("[NONE]");
	}]);
	await runQna(f.ctx, "Which one?", normalizeQnaSettings({ qna: { model: { provider: "qna-router", id: "auto", thinking: "high" } } }));
	assert.equal(f.main.state.callCount, 1);
	assert.deepEqual(f.notices, [{ message: "未在 AI 回复中发现问题", level: "info" }]);
});

// 扩展入口的配置适配：loadSettings 必须把 getSettings() 的完整对象交给
// normalizeQnaSettings（曾经错传 .qna 子对象给 JSON 解析器，导致全部配置静默失效）。
test("extension entry honors autoExtract=false and the configured extraction model", async (t) => {
	const f = await fixture(t);
	const registered: {
		settled?: (event: unknown, ctx: ExtensionContext) => Promise<void>;
		qna?: (args: string, ctx: ExtensionContext) => Promise<void>;
	} = {};
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
			if (name === "agent_settled") registered.settled = handler;
		},
		registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			if (name === "qna") registered.qna = def.handler;
		},
		getSettings: () => ({ qna: { autoExtract: false, model: { provider: "qna-cheap", id: "cheap", thinking: "high" } } }),
	};
	qnaExtension(pi as never);

	// lastAssistantText 走 ctx.sessionManager.getBranch()；给一条带问号的回复。
	const branch = [
		{
			type: "message",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Which one do you prefer?" }], timestamp: 1 },
		},
	];
	const baseCtx = {
		...f.ctx,
		mode: "tui",
		cwd: "/tmp",
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;

	// autoExtract=false：settled 触发直接返回，不弹 loader、不调任何模型。
	await registered.settled!(undefined, baseCtx);
	assert.equal(f.loaders.length, 0);
	assert.equal(f.main.state.callCount, 0);
	assert.equal(f.cheap.state.callCount, 0);

	// 手动 /qna 不看 autoExtract；配置的抽取模型（qna-cheap）必须生效。
	f.cheap.setResponses([() => fauxAssistantMessage("[NONE]")]);
	const editor: string[] = [];
	await registered.qna!("", {
		...baseCtx,
		ui: { ...baseCtx.ui, setEditorText: (text: string) => editor.push(text) },
	} as unknown as ExtensionContext);
	assert.equal(f.cheap.state.callCount, 1, "configured extraction model must be used");
	assert.equal(f.main.state.callCount, 0, "main model must not be called");
});
