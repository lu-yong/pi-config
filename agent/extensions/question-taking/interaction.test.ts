import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { askExtractedQuestions, type ExtractedQuestion } from "./interaction.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const TAB = "\t";
const ENTER = "\r";
const ESC = "\x1b";

/**
 * 无头 driver：以最小 tui/theme 桩驱动真实组件的 handleInput/render，
 * 会话按 askExtractedQuestions 的逐题顺序出现。
 */
interface Session {
	press(data: string): void;
	render(width: number): string[];
	invalidate(): void;
	readonly doneCount: number;
}

function createDriver() {
	const sessions: Session[] = [];
	const ui = {
		custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => unknown) =>
			new Promise((resolve, reject) => {
				let doneCount = 0;
				const done = (value: unknown) => {
					doneCount++;
					resolve(value);
				};
				try {
					const component = factory(
						{ requestRender() {}, terminal: { rows: 24 } },
						{ fg: (_color: string, text: string) => text },
						{},
						done,
					) as { render(width: number): string[]; handleInput(data: string): void; invalidate?(): void };
					sessions.push({
						press: (data) => component.handleInput(data),
						render: (width) => component.render(width),
						invalidate: () => component.invalidate?.(),
						get doneCount() {
							return doneCount;
						},
					});
				} catch (error) {
					reject(error);
				}
			}),
	};
	return { ui, sessions };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function session(driver: ReturnType<typeof createDriver>, index: number): Promise<Session> {
	while (driver.sessions.length <= index) await tick();
	return driver.sessions[index]!;
}

async function press(session: Session, keys: string[]) {
	for (const key of keys) {
		session.press(key);
		await tick();
	}
}

async function type(session: Session, text: string) {
	await press(session, [...text]);
}

test("两题按顺序作答：导航可见、回答按题序返回、每题只完成一次", async () => {
	const inputs: ExtractedQuestion[] = [
		{ question: "用哪个数据库？", options: ["Postgres", "SQLite"] },
		{ question: "要迁移吗？", options: ["现在迁", "以后再说"] },
	];
	const driver = createDriver();
	const promise = askExtractedQuestions(driver.ui, inputs);

	const first = await session(driver, 0);
	const initial = first.render(60);
	assert.ok(initial.some((line) => line.includes("用哪个数据库？")));
	assert.ok(initial.some((line) => line.includes("1. Postgres")));
	assert.ok(initial.some((line) => line.includes("2. SQLite")));
	assert.equal(first.doneCount, 0);

	await press(first, [DOWN]);
	assert.ok(first.render(60).some((line) => line.includes("> 2. SQLite")));
	await press(first, [ENTER]);

	const second = await session(driver, 1);
	assert.ok(second.render(60).some((line) => line.includes("要迁移吗？")));
	await press(second, [ENTER]);

	assert.deepEqual(await promise, [
		{ question: "用哪个数据库？", answer: "SQLite" },
		{ question: "要迁移吗？", answer: "现在迁" },
	]);
	assert.equal(first.doneCount, 1);
	assert.equal(second.doneCount, 1);
});

test("任何一题取消都返回 null：首题直接取消", async () => {
	const driver = createDriver();
	const promise = askExtractedQuestions(driver.ui, [{ question: "Q?", options: ["A", "B"] }]);

	const first = await session(driver, 0);
	await press(first, [ESC]);

	assert.equal(await promise, null);
	assert.equal(first.doneCount, 1);
});

test("第二题取消同样返回 null，首题作答被丢弃", async () => {
	const driver = createDriver();
	const promise = askExtractedQuestions(driver.ui, [
		{ question: "第一题？", options: ["A1"] },
		{ question: "第二题？", options: ["B1"] },
	]);

	await press(await session(driver, 0), [ENTER]);
	const second = await session(driver, 1);
	await press(second, [ESC]);

	assert.equal(await promise, null);
	assert.equal(second.doneCount, 1);
});

test("allowOther 进入自定义输入：打字作答，答案为输入文本", async () => {
	const driver = createDriver();
	const promise = askExtractedQuestions(driver.ui, [
		{ question: "版本号？", options: ["1.0", "2.0"], allowOther: true },
	]);

	const first = await session(driver, 0);
	await press(first, [DOWN, DOWN, ENTER]);

	const typing = first.render(60);
	assert.ok(typing.some((line) => line.includes("3. Type something. ✎")));
	assert.ok(typing.some((line) => line.includes("Your answer:")));
	assert.equal(first.doneCount, 0);

	await type(first, "3.5.0");
	await press(first, [ENTER]);

	assert.deepEqual(await promise, [{ question: "版本号？", answer: "3.5.0" }]);
	assert.equal(first.doneCount, 1);
});

test("空自定义输入不作答：退回选项列表，随后仍可正常选择", async () => {
	const driver = createDriver();
	const promise = askExtractedQuestions(driver.ui, [
		{ question: "版本号？", options: ["1.0", "2.0"], allowOther: true },
	]);

	const first = await session(driver, 0);
	await press(first, [DOWN, DOWN, ENTER]); // 进入自定义输入
	await press(first, [ENTER]); // 空提交

	assert.equal(first.doneCount, 0);
	const backToOptions = first.render(60);
	assert.ok(backToOptions.some((line) => line.includes("↑↓ 导航")));
	assert.ok(backToOptions.some((line) => line.includes("1. 1.0")));

	await press(first, [UP, UP]); // 光标仍在自定义项，逐项移回首项
	await press(first, [ENTER]);

	assert.deepEqual(await promise, [{ question: "版本号？", answer: "1.0" }]);
});

test("输入模式 Esc 只退出输入不取消整题，再按 Esc 才取消", async () => {
	const driver = createDriver();
	const promise = askExtractedQuestions(driver.ui, [
		{ question: "版本号？", options: ["1.0"], allowOther: true },
	]);

	const first = await session(driver, 0);
	await press(first, [DOWN, ENTER]); // 进入自定义输入
	await press(first, [ESC]);

	assert.equal(first.doneCount, 0);
	assert.ok(first.render(60).some((line) => line.includes("1. 1.0")));

	await press(first, [ESC]);
	assert.equal(await promise, null);
	assert.equal(first.doneCount, 1);
});

test("选项模式下 Tab/左右键是死键，Up 在首项处钳制不回绕", async () => {
	const driver = createDriver();
	const promise = askExtractedQuestions(driver.ui, [{ question: "Q?", options: ["A", "B"] }]);

	const first = await session(driver, 0);
	await press(first, [TAB, LEFT, RIGHT, UP]);

	assert.ok(first.render(60).some((line) => line.includes("> 1. A")));
	assert.equal(first.doneCount, 0);

	await press(first, [ENTER]);
	assert.deepEqual(await promise, [{ question: "Q?", answer: "A" }]);
});

test("窄终端逐行不超宽，宽度变化后按新宽度重绘", async () => {
	const driver = createDriver();
	const promise = askExtractedQuestions(driver.ui, [
		{ question: "这是一个相当长的问题文本，用来检查窄终端下的换行行为", options: ["选项一", "选项二"] },
	]);

	const first = await session(driver, 0);
	const narrow = first.render(16);
	assert.ok(narrow.length > 1);
	for (const line of narrow) {
		assert.ok(visibleWidth(line) <= 16, `line too wide: ${JSON.stringify(line)}`);
	}
	assert.ok(narrow.some((line) => line.includes("导航")));

	first.invalidate();
	const wide = first.render(40);
	assert.equal(visibleWidth(wide[0]!), 40);
	assert.ok(wide.some((line) => line.includes("这是一个相当长的问题文本")));

	await press(first, [ENTER]);
	assert.deepEqual(await promise, [
		{ question: "这是一个相当长的问题文本，用来检查窄终端下的换行行为", answer: "选项一" },
	]);
});

test("空问题清单返回空数组而非 null", async () => {
	const driver = createDriver();
	assert.deepEqual(await askExtractedQuestions(driver.ui, []), []);
});
