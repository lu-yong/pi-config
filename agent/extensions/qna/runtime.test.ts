import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import qnaExtension, { runQna } from "./index.ts";
import { ACTIVE_GOAL_QNA_BLOCK_MESSAGE } from "./goal-policy.ts";
import { normalizeQnaSettings, defaultQnaSettings } from "./settings.ts";
import { SYSTEM_PROMPT } from "./extraction.ts";
import { defaultGoalState } from "../planning-files-runtime/state.ts";
import type { GoalOverlayStatus } from "../planning-files-runtime/types.ts";
import { getPaths, writeText } from "../planning-files-runtime/utils.ts";

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
	t.mock.method(f.registry, "streamSimple", (...args: Parameters<typeof streamSimple>) => {
		assert.deepEqual(Object.keys(args[2]!).sort(), ["reasoning", "signal"]);
		return streamSimple(...args);
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
		assert.equal((context.messages[1].content as Array<{ text?: string }>)[0].text, "Which one?");
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
	f.runtime.registerVirtualModel({ provider: "qna-router", id: "auto", name: "QnA router", thinkingLevels: ["high"], route(request) {
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

// ---- runQna 问答成功路径与扩展入口的判定链 ----
//
// 抽取到非空问题列表之后的行为（真实问答组件、汇总写入、指纹去重）需要同时伺候
// 两种 custom 组件：抽取 loader（BorderedLoader，有 dispose）与 question-taking
// 的问答组件（有 handleInput，无 dispose）。fixture 的 custom 桩只认前者的形状。

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 有界等待：组件在微任务链上弹出；等不到就失败，而不是挂住整个文件。 */
async function waitUntil(condition: () => boolean, what: string): Promise<void> {
	for (let attempts = 0; attempts < 1000 && !condition(); attempts++) await tick();
	assert.ok(condition(), what);
}

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qna-runtime-"));
	tempDirectories.push(cwd);
	return cwd;
}

function persistGoalStatus(cwd: string, status: GoalOverlayStatus): void {
	const state = { ...defaultGoalState(), status };
	writeText(getPaths(cwd).goalState, `${JSON.stringify(state, null, 2)}\n`);
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** custom 桩：记录每个弹出的组件；done 幂等结算并按需 dispose（问答组件没有 dispose）。 */
function customStub(components: any[]) {
	return (factory: any) =>
		new Promise((resolve, reject) => {
			let component: any;
			let settled = false;
			const done = (value: unknown) => {
				if (settled) return;
				settled = true;
				component?.dispose?.();
				resolve(value);
			};
			try {
				component = factory(
					{ requestRender() {}, terminal: { rows: 24 } },
					{ fg: (_color: string, text: string) => text },
					{},
					done,
				);
				components.push(component);
			} catch (error) {
				component?.dispose?.();
				reject(error);
			}
		});
}

/** tui 会话分支里最后一条 assistant 消息（默认已完成）。 */
function assistantBranch(text: string, stopReason = "stop") {
	return [
		{
			type: "message",
			message: { role: "assistant", stopReason, content: [{ type: "text", text }], timestamp: 1 },
		},
	];
}

/** 带问答能力的 ctx：custom 换成能伺候问答组件的桩，并挂上 setEditorText。 */
function interactiveCtx(
	f: Fixture,
	editor: string[],
	components: any[],
	overrides: Record<string, unknown> = {},
): ExtensionContext {
	return {
		...f.ctx,
		mode: "tui",
		...overrides,
		ui: {
			notify: (message: string, level: string) => f.notices.push({ message, level }),
			custom: customStub(components),
			setEditorText: (text: string) => editor.push(text),
		},
	} as unknown as ExtensionContext;
}

/** settled 判定链用 ctx：不进问答的用例只需要 branch 与 cwd；overrides 最后展开。 */
function settledCtx(
	f: Fixture,
	options: {
		text?: string;
		stopReason?: string;
		branch?: unknown[];
		cwd?: string;
		overrides?: Record<string, unknown>;
	},
): ExtensionContext {
	return {
		...f.ctx,
		mode: "tui",
		cwd: options.cwd ?? makeCwd(),
		sessionManager: { getBranch: () => options.branch ?? assistantBranch(options.text ?? "", options.stopReason) },
		...options.overrides,
	} as unknown as ExtensionContext;
}

/** 注册扩展并捕获处理器；getSettings 的调用次数用来验证判定链里的读盘时机。 */
function registerQna(getSettings: () => unknown) {
	const registered: {
		settled?: (event: unknown, ctx: ExtensionContext) => Promise<void>;
		qna?: (args: string, ctx: ExtensionContext) => Promise<void>;
	} = {};
	qnaExtension({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
			if (name === "agent_settled") registered.settled = handler;
		},
		registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			if (name === "qna") registered.qna = def.handler;
		},
		getSettings,
	} as never);
	return registered;
}

const autoExtractSettings = { read: () => ({ qna: { autoExtract: true } }) };

test("问答成功路径：两题逐题作答后汇总写入编辑器，格式与通知与实现一致", async (t) => {
	const f = await fixture(t);
	const components: any[] = [];
	const editor: string[] = [];
	const ctx = interactiveCtx(f, editor, components);
	f.cheap.setResponses([
		fauxAssistantMessage("[Q] 用哪个数据库？\n[O] Postgres\n[O] SQLite\n\n[Q] 要迁移吗？\n[O] 现在迁\n[O] 以后再说"),
	]);

	const running = runQna(ctx, "Which database should the nightly report use?", cheapSettings);
	await waitUntil(() => components.length >= 2, "抽取完成后应弹出问答组件");
	assert.ok(
		components[1].render(60).some((line: string) => line.includes("用哪个数据库？")),
		"问答组件渲染抽取出的第一个问题",
	);
	components[1].handleInput(DOWN); // 选中第二项
	components[1].handleInput(ENTER); // 作答
	await waitUntil(() => components.length >= 3, "第一题作答后应弹出第二题");
	components[2].handleInput(ENTER);

	await running;
	assert.equal(f.cheap.state.callCount, 1);
	assert.deepEqual(editor, [
		"### Q&A 汇总\n\n**Q: 用哪个数据库？**\nA: SQLite\n\n**Q: 要迁移吗？**\nA: 现在迁\n\n---\n提交后 AI 将根据你的回答继续处理。",
	]);
	assert.deepEqual(f.notices, [{ message: "已汇总 2 个问题，编辑后提交即可", level: "info" }]);
});

test("问答被跳过：Esc 取消后仅提示已跳过，不写编辑器", async (t) => {
	const f = await fixture(t);
	const components: any[] = [];
	const editor: string[] = [];
	const ctx = interactiveCtx(f, editor, components);
	f.cheap.setResponses([fauxAssistantMessage("[Q] 第一题？\n[O] A\n[O] B\n\n[Q] 第二题？\n[O] C\n[O] D")]);

	const running = runQna(ctx, "Shall we start with the cache layer?", cheapSettings);
	await waitUntil(() => components.length >= 2, "抽取完成后应弹出问答组件");
	components[1].handleInput(ESC); // 跳过首题

	await running;
	assert.deepEqual(f.notices, [{ message: "已跳过 Q&A", level: "info" }]);
	assert.deepEqual(editor, []);
	assert.equal(f.cheap.state.callCount, 1);
});

test("agent_settled 正路径：尾部问号 → 读盘 → 配置的抽取模型 → 问答 → 汇总", async (t) => {
	const f = await fixture(t);
	const settings = {
		read: () => ({ qna: { autoExtract: true, model: { provider: "qna-cheap", id: "cheap", thinking: "high" } } }),
	};
	const readMock = t.mock.method(settings, "read");
	const registered = registerQna(settings.read);
	const components: any[] = [];
	const editor: string[] = [];
	const ctx = interactiveCtx(f, editor, components, {
		cwd: makeCwd(),
		sessionManager: { getBranch: () => assistantBranch("Which language should the release notes use?") },
	});
	f.cheap.setResponses([fauxAssistantMessage("[Q] 语言？\n[O] 中文\n[O] English")]);

	const settled = registered.settled!(undefined, ctx);
	await waitUntil(() => components.length >= 2, "settled 触发抽取后应弹出问答组件");
	components[1].handleInput(ENTER);
	await settled;

	assert.equal(readMock.mock.callCount(), 1, "判定链恰好读一次盘");
	assert.equal(f.cheap.state.callCount, 1, "settled 正路径必须用配置的抽取模型");
	assert.equal(f.main.state.callCount, 0);
	assert.deepEqual(editor, [
		"### Q&A 汇总\n\n**Q: 语言？**\nA: 中文\n\n---\n提交后 AI 将根据你的回答继续处理。",
	]);
	assert.deepEqual(f.notices, [{ message: "已汇总 1 个问题，编辑后提交即可", level: "info" }]);
});

test("settled 的纯内存判定先于读盘：mode/model/文本判定未过时不触发 getSettings", async (t) => {
	const f = await fixture(t);
	const settings = { ...autoExtractSettings };
	const readMock = t.mock.method(settings, "read");
	const registered = registerQna(settings.read);
	// 防御性补一个 [NONE] 响应：若判定链被改坏，模型调用也应快速完成并被断言抓住，而不是挂住。
	f.main.setResponses([() => fauxAssistantMessage("[NONE]")]);

	await registered.settled!(undefined, settledCtx(f, { text: "Which one?", overrides: { mode: "print" } }));
	await registered.settled!(undefined, settledCtx(f, { text: "Which one?", overrides: { model: undefined } }));
	await registered.settled!(undefined, settledCtx(f, { text: "Here is the summary of the change." }));
	await registered.settled!(undefined, settledCtx(f, { text: "Which one?", stopReason: "aborted" }));
	await registered.settled!(undefined, settledCtx(f, { branch: [] }));

	assert.equal(readMock.mock.callCount(), 0, "内存判定未通过时不得读盘");
	assert.equal(f.loaders.length, 0);
	assert.equal(f.main.state.callCount, 0);
	assert.equal(f.cheap.state.callCount, 0);
});

test("autoExtract=true 时 active goal 抑制自动抽取：静默短路，不弹 loader、不调模型", async (t) => {
	const f = await fixture(t);
	const cwd = makeCwd();
	persistGoalStatus(cwd, "active");
	const settings = { ...autoExtractSettings };
	const readMock = t.mock.method(settings, "read");
	const registered = registerQna(settings.read);
	f.main.setResponses([() => fauxAssistantMessage("[NONE]")]);

	await registered.settled!(undefined, settledCtx(f, { text: "Which option looks better?", cwd }));

	assert.equal(readMock.mock.callCount(), 1, "goal 判定发生在读盘（autoExtract）之后");
	assert.equal(f.loaders.length, 0);
	assert.equal(f.main.state.callCount, 0);
	assert.equal(f.cheap.state.callCount, 0);
	assert.deepEqual(f.notices, [], "自动路径的 goal 抑制是静默的");
});

test("指纹在问答前入集：用户跳过后同一回复再次 settled 连读盘都省了", async (t) => {
	const f = await fixture(t);
	const settings = { ...autoExtractSettings };
	const readMock = t.mock.method(settings, "read");
	const registered = registerQna(settings.read);
	const components: any[] = [];
	const editor: string[] = [];
	const ctx = interactiveCtx(f, editor, components, {
		cwd: makeCwd(),
		sessionManager: { getBranch: () => assistantBranch("Shall we enable the retry loop by default?") },
	});
	f.main.setResponses([fauxAssistantMessage("[Q] 开吗？\n[O] 开\n[O] 不开")]);

	const first = registered.settled!(undefined, ctx);
	await waitUntil(() => components.length >= 2, "第一轮抽取后应弹出问答组件");
	components[1].handleInput(ESC); // 用户跳过
	await first;
	assert.deepEqual(f.notices, [{ message: "已跳过 Q&A", level: "info" }]);

	// 同一回复再次 settled：指纹已在问答前入集，纯内存判定就应短路。
	await registered.settled!(undefined, ctx);
	assert.equal(readMock.mock.callCount(), 1, "去重短路发生在读盘之前");
	assert.equal(f.main.state.callCount, 1, "不重复抽取");
	assert.equal(components.length, 2, "不重复弹问答组件");
});

test("/qna 守卫：goal 拒绝最先执行，非 tui / 无模型 / 无 AI 回复各自提示后返回", async (t) => {
	const f = await fixture(t);
	const registered = registerQna(() => ({}));
	f.main.setResponses([() => fauxAssistantMessage("[NONE]")]);
	const base = {
		...f.ctx,
		mode: "tui" as const,
		cwd: makeCwd(),
		sessionManager: { getBranch: () => assistantBranch("Which guard fires first?") },
	} as unknown as ExtensionContext;

	// active goal 的拒绝排在最前（先于模式检查）
	const goalCwd = makeCwd();
	persistGoalStatus(goalCwd, "active");
	await registered.qna!("", { ...base, mode: "print", cwd: goalCwd } as unknown as ExtensionContext);
	assert.deepEqual(f.notices, [{ message: ACTIVE_GOAL_QNA_BLOCK_MESSAGE, level: "warning" }]);

	await registered.qna!("", { ...base, mode: "print" } as unknown as ExtensionContext);
	assert.deepEqual(f.notices.slice(1), [{ message: "qna 需要交互模式", level: "error" }]);

	await registered.qna!("", { ...base, model: undefined } as unknown as ExtensionContext);
	assert.deepEqual(f.notices.slice(2), [{ message: "未选择模型", level: "error" }]);

	await registered.qna!(
		"",
		{ ...base, sessionManager: { getBranch: () => assistantBranch("aborted draft", "aborted") } } as unknown as ExtensionContext,
	);
	assert.deepEqual(f.notices.slice(3), [{ message: "未找到 AI 回复", level: "error" }]);

	assert.equal(f.main.state.callCount, 0);
	assert.equal(f.cheap.state.callCount, 0);
	assert.equal(f.loaders.length, 0);
});
