import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";

import { defaultGoalState } from "./state.ts";
import type { GoalOverlayStatus, PlanningSnapshot } from "./types.ts";
import { buildWidgetLines, buildGoalDetailFields, PlanningGoalDialog } from "./ui.ts";

function snapshot(status: GoalOverlayStatus): PlanningSnapshot {
	return {
		planningRoot: "/project/.pi/planning",
		files: { "task_plan.md": "/project/.pi/planning/task_plan.md", "findings.md": "/project/.pi/planning/findings.md", "progress.md": "/project/.pi/planning/progress.md" },
		goalDesignPath: "/project/.pi/planning/goal-design.md",
		tasksDir: "/project/.pi/planning/tasks",
		goalStatePath: "/project/.pi/planning/.goal-state.json",
		exists: true,
		currentPhase: "Phase 5",
		nextAction: "complete_plan_goal: stale action",
		blocker: "stale blocker",
		goalState: { ...defaultGoalState(), status },
		resumedFromPreviousSession: false,
	};
}

test("completed Goal widget uses the canonical terminal projection", () => {
	const lines = buildWidgetLines(snapshot("complete")) ?? [];
	assert.ok(lines.includes("state: complete"));
	assert.ok(lines.includes("phase: Complete"));
	assert.ok(lines.includes("next: None (goal complete)."));
	assert.ok(!lines.some((line) => line.startsWith("blocker:")));
	assert.ok(!lines.some((line) => line.includes("Phase 5")));
	assert.ok(!lines.some((line) => line.includes("stale")));
});

test("non-complete Goal widget keeps task-plan-derived values", () => {
	const lines = buildWidgetLines(snapshot("active")) ?? [];
	assert.ok(lines.includes("phase: Phase 5"));
	assert.ok(lines.includes("next: complete_plan_goal: stale action"));
	assert.ok(lines.includes("blocker: stale blocker"));
});

test("paused Goal widget projects persisted pause context over stale task-plan fields", () => {
	const state = snapshot("paused");
	state.goalState.impl.pausedReason = "SVD tuner service crashed during PAT filter configuration";
	state.goalState.impl.pausedSuggestedAction = "Repair the service, then rerun Task 05.";
	const lines = buildWidgetLines(state) ?? [];
	assert.ok(lines.includes("state: paused"));
	assert.ok(lines.includes("phase: Phase 5"));
	assert.ok(lines.includes("next: Repair the service, then rerun Task 05."));
	assert.ok(lines.includes("blocker: SVD tuner service crashed during PAT filter configuration"));
	assert.ok(!lines.includes("next: complete_plan_goal: stale action"));
	assert.ok(!lines.includes("blocker: stale blocker"));
});

test("summary keeps long fields on one line, fits terminal columns, and uses accent labels", () => {
	const state = snapshot("active");
	const value = "中文🙂e\u0301 objective\nsecond line\t".repeat(20);
	state.goalState.goal = { objective: value, successCriteria: [], constraints: [], outOfScope: [], blockerRule: "" };
	state.currentPhase = state.nextAction = state.blocker = value;
	state.goalState.goal.tokenBudget = 10000;
	state.goalState.impl.tokensUsed = 7500;
	const styled: string[] = [];
	const theme = { fg: (color: string, text: string) => { assert.equal(color, "accent"); styled.push(text); return "\x1b[34m" + text + "\x1b[39m"; } };
	for (const width of [0, 1, 2, 3, 12, 40, 80]) {
		const lines = buildWidgetLines(state, width, theme)!;
		assert.equal(lines.length, 9);
		assert.ok(lines.every((line) => visibleWidth(line) <= width && !/[\r\n\t]/u.test(line)));
	}
	const lines = buildWidgetLines(state, 40)!;
	for (const label of ["objective", "phase", "next", "blocker"]) {
		assert.ok(lines.map(stripAnsi).find((line) => line.startsWith(label + ":"))?.endsWith("..."));
	}
	assert.equal(lines.at(-1), "tokens: 8k / 10k (75%)");
	assert.ok(styled.includes("Planning goal") && styled.includes("objective:") && styled.includes("tokens:"));
	assert.equal(new Map(buildGoalDetailFields(state)).get("objective"), value);
});

test("draft summary and inspector use the current draft and expose its full context", () => {
	const state = snapshot("drafting");
	Object.assign(state.goalState.draft, {
		objective: "Draft objective", draftingStage: "design", nextRecommendedQuestion: "Current question?",
		openQuestions: ["Question one?", "Question two?"], constraints: ["Draft constraint"],
	});
	const lines = buildWidgetLines(state)!;
	assert.ok(lines.includes("state: drafting"));
	assert.ok(lines.includes("objective: Draft objective"));
	assert.ok(lines.includes("next: Current question?"));
	assert.equal(lines.at(-1), "tokens: 0");
	const details = new Map(buildGoalDetailFields(state));
	assert.equal(details.get("stage"), "design");
	assert.equal(details.get("open questions"), "• Question one?\n• Question two?");
	assert.equal(details.get("constraints"), "• Draft constraint");
});

test("empty planning stays hidden while its inspector reports the uninitialized state", () => {
	const state = snapshot("none");
	state.exists = false;
	assert.equal(buildWidgetLines(state, 80), undefined);
	assert.equal(new Map(buildGoalDetailFields(state)).get("planning"), "not initialized");
});

test("persisted terminal controls cannot escape the summary or inspector, while UI colors and Unicode survive", () => {
	const state = snapshot("drafting");
	state.goalState.draft.objective = "OBJECTIVE\x1b[2J\x1b[HEND";
	state.goalState.draft.constraints = [
		"CLEAR\x1b[2JEND", "CURSOR\x1b[99;99HEND", "OSC\x1b]52;c;Zm9v\x07END",
	];
	state.goalState.draft.supplementalInputs = [
		"LINK\x1b]8;;https://example.invalid\x1b\\TEXT\x1b]8;;\x1b\\END",
		"中文🙂e\u0301\nSECOND\tTAB\r\nTHIRD\x08\x00\x7f\x9b2JEND",
	];
	const original = structuredClone(state);
	const details = new Map(buildGoalDetailFields(state));
	assert.equal(details.get("constraints"), "• CLEAREND\n• CURSOREND\n• OSCEND");
	assert.equal(details.get("supplemental inputs"), "• LINKTEXTEND\n• 中文🙂e\u0301\nSECOND\tTAB\nTHIRDEND");
	const theme = { fg: (_color: string, text: string) => "\x1b[34m" + text + "\x1b[39m" };
	const host = { terminal: { rows: 18 }, requestRender: () => {} } as ConstructorParameters<typeof PlanningGoalDialog>[1];
	const dialog = new PlanningGoalDialog(state, host, theme, { matches: () => false }, () => {});
	let rendered = buildWidgetLines(state, 100, theme)!.join("\n");
	assert.ok(stripAnsi(rendered).includes("objective: OBJECTIVEEND"));
	for (const width of [1, 12, 42, 100]) {
		dialog.handleInput("\x1b[H");
		let previousPage = "";
		for (let page = 0; page < 40; page++) {
			const lines = dialog.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			const pageText = lines.join("\n");
			if (pageText === previousPage) break;
			previousPage = pageText;
			rendered += "\n" + pageText;
			dialog.handleInput("\x1b[6~");
		}
	}
	assert.ok(rendered.includes("\x1b[34m"), "application-owned styling must remain");
	const withoutTheme = rendered.replace(/\x1b\[(?:0|34|39)m/gu, "");
	assert.doesNotMatch(withoutTheme, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u);
	assert.match(withoutTheme, /CLEAREND/);
	assert.match(withoutTheme, /LINKTEXTEND/);
	assert.match(withoutTheme, /中文🙂e\u0301/u);
	assert.doesNotMatch(withoutTheme, /Zm9v|example\.invalid/);
	assert.deepEqual(state, original, "rendering must not rewrite persisted values");
});

test("inspector wraps all values, scrolls to both ends, closes, and fits resized terminals", () => {
	const state = snapshot("paused");
	state.goalState.impl.pausedReason = "中文🙂 multiline\n".repeat(80) + "LAST_BLOCKER_MARKER";
	let closed = false;
	let renders = 0;
	const host = { terminal: { rows: 16 }, requestRender: () => { renders++; } } as ConstructorParameters<typeof PlanningGoalDialog>[1];
	const theme = { fg: (_color: string, text: string) => text };
	const keys = { matches: (data: string, key: string) => data === key };
	const dialog = new PlanningGoalDialog(state, host, theme, keys, () => { closed = true; });
	const first = dialog.render(42);
	assert.ok(first.join("\n").includes("dir:"));
	let allPages = first.join("\n");
	for (let i = 0; i < 100; i++) {
		dialog.handleInput("\x1b[6~");
		allPages += dialog.render(42).join("\n");
	}
	assert.ok(allPages.includes("LAST_BLOCKER_MARKER"));
	assert.ok(!dialog.render(42).join("\n").includes("dir:"));
	dialog.handleInput("\x1b[H");
	assert.deepEqual(dialog.render(42), first);
	for (const width of [1, 3, 12, 80]) {
		host.terminal.rows = 10;
		dialog.invalidate();
		const lines = dialog.render(width);
		assert.ok(lines.length <= 8 && lines.every((line) => visibleWidth(line) <= width));
	}
	assert.ok(renders > 0);
	dialog.handleInput("tui.select.cancel");
	assert.equal(closed, true);
});
