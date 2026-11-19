import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { budgetPromptLines, buildGoalImplPrompt, buildGoalSetPrompt, buildPlanUpdatePrompt } from "./prompts.ts";
import { readPlanningSections } from "./workspace.ts";
import type { PlanningSnapshot } from "./types.ts";
import { defaultGoalState } from "./state.ts";
import { NETWORK_COMMANDS } from "../command-policy/policy.ts";

test("goal drafting prompt explains the fail-closed bash policy", () => {
	const state = defaultGoalState();
	state.status = "drafting";
	const prompt = buildGoalSetPrompt(state);

	assert.ok(prompt.includes("every segment is an approved read-only command"));
	assert.ok(prompt.includes("Redirects other than stderr to /dev/null (`2>/dev/null`), backticks, $(), subshells, and unknown commands are always rejected."));
	assert.ok(prompt.includes(`Network commands are blocked during drafting: ${[...NETWORK_COMMANDS].join(", ")}.`));
	assert.ok(prompt.includes("`pwd && git status --short`"));
});

test("goal drafting prompt renders the draft summary, current stage, and the empty-draft placeholder", () => {
	const state = defaultGoalState();
	const empty = buildGoalSetPrompt(state);
	assert.ok(empty.includes("Current stage: as-is"));
	assert.ok(empty.includes("Goal overlay status: none"));
	assert.ok(empty.includes("Current draft state:\n- (empty draft)"));
	assert.doesNotMatch(empty, /Committed goal|New user input for this drafting step/);

	state.status = "drafting";
	state.draft = {
		...state.draft,
		sourceTopic: "ship the export",
		objective: "Ship CSV export",
		successCriteria: ["Tests pass"],
		constraints: ["No new deps"],
		outOfScope: ["PDF export"],
		blockerRule: "Pause and ask",
		openQuestions: ["Which storage?", "Which UI?"],
		nextRecommendedQuestion: "Which storage?",
		draftingStage: "story",
	};
	const prompt = buildGoalSetPrompt(state);
	assert.ok(prompt.includes("Current stage: story"));
	assert.ok(prompt.includes("- Source topic: ship the export"));
	assert.ok(prompt.includes("- Objective draft: Ship CSV export"));
	assert.ok(prompt.includes("- Success criteria: Tests pass"));
	assert.ok(prompt.includes("- Constraints: No new deps"));
	assert.ok(prompt.includes("- Out of scope: PDF export"));
	assert.ok(prompt.includes("- If blocked: Pause and ask"));
	assert.ok(prompt.includes("- Open questions (2): Which storage?; Which UI?"));
	assert.ok(prompt.includes("- Recommended next question: Which storage?"));
	assert.doesNotMatch(prompt, /- \(empty draft\)/);
});

test("goal drafting prompt echoes the committed goal and the drafting step's new user input", () => {
	const state = defaultGoalState();
	state.status = "drafting";
	state.goal = {
		objective: "Committed objective",
		successCriteria: ["criterion one"],
		constraints: [],
		outOfScope: [],
		blockerRule: "Ask the user",
	};
	assert.ok(buildGoalSetPrompt(state).includes("Committed goal:\n- Objective: Committed objective"));
	assert.doesNotMatch(buildGoalSetPrompt(state, ""), /New user input for this drafting step/);
	const prompt = buildGoalSetPrompt(state, "Use sqlite");
	assert.ok(prompt.includes("Committed goal:\n- Objective: Committed objective"));
	assert.ok(prompt.includes("- Success criteria: criterion one"));
	assert.ok(prompt.includes("New user input for this drafting step:\nUse sqlite"));

	state.goal = { ...state.goal, successCriteria: [] };
	assert.doesNotMatch(buildGoalSetPrompt(state, "Use sqlite"), /- Success criteria/);
});

test("plan update prompt pins exact planning file paths and the continuity check", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-prompts-test-"));
	try {
		const snapshot: PlanningSnapshot = { ...readPlanningSections(cwd), goalState: defaultGoalState() };
		const prompt = buildPlanUpdatePrompt(snapshot);

		assert.ok(prompt.includes("[PLAN UPDATE]"));
		assert.ok(prompt.includes(snapshot.files["task_plan.md"]));
		assert.ok(prompt.includes(snapshot.files["findings.md"]));
		assert.ok(prompt.includes(snapshot.files["progress.md"]));
		assert.ok(prompt.includes("## Continuity Check"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

for (const mode of ["start", "resume", "continue"] as const) {
	test(`implementation prompt reconciles current user facts without overriding the contract (${mode})`, (t) => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-impl-prompt-"));
		t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const snapshot: PlanningSnapshot = { ...readPlanningSections(cwd), goalState: defaultGoalState() };
		snapshot.goalState.goal = {
			objective: "完成实现", successCriteria: ["测试通过"], constraints: ["不能部署"],
			outOfScope: ["修改依赖"], blockerRule: "遇到真实阻塞先暂停",
		};
		snapshot.blocker = "额度耗尽";
		snapshot.nextAction = "等待明天额度重置";
		const input = "我使用重置卡，额度已恢复\n请先核验当前额度。\n  不要删除历史记录。";
		const baseline = buildGoalImplPrompt(snapshot, mode);
		for (const empty of [undefined, "", " \t\n\r\n　"]) {
			assert.equal(buildGoalImplPrompt(snapshot, mode, empty), baseline);
		}
		assert.doesNotMatch(baseline, /Current user supplement/);
		const prompt = buildGoalImplPrompt(snapshot, mode, `  ${input}\n`);
		assert.ok(prompt.includes(`Current user supplement for this implementation request:\n${input}\n`));
		assert.ok(prompt.includes("Re-read the current Blocker and Next action in task_plan.md"));
		assert.ok(prompt.includes("latest user-provided current facts"));
		assert.ok(prompt.includes("Correct obsolete waiting conditions and next actions"));
		assert.ok(prompt.includes("Do not blindly clear all blockers; retain unresolved blockers"));
		assert.ok(prompt.includes("verify uncertain claims before proceeding"));
		assert.ok(prompt.includes("Preserve historical interruption and blocker facts in progress.md"));
		assert.ok(prompt.includes("does not automatically override the committed goal's hard constraints"));
		assert.ok(prompt.includes("ask for clarification rather than overriding it"));
		assert.ok(prompt.includes("不能部署"));
		assert.ok(prompt.includes("等待明天额度重置"));
		assert.equal(snapshot.blocker, "额度耗尽");
		assert.equal(buildGoalImplPrompt(snapshot, mode), baseline);
	});
}

test("budget prompt lines escalate at the thresholds", () => {
	assert.deepEqual(budgetPromptLines(10, undefined), []);
	assert.deepEqual(budgetPromptLines(100, 1000), ["Token budget: 100 / 1k tokens used (10%)."]);
	assert.deepEqual(budgetPromptLines(700, 1000), [
		"Token budget: 700 / 1k tokens used (70%).",
		"Budget warning: prioritize the remaining success criteria; avoid exploratory work.",
	]);
	assert.deepEqual(budgetPromptLines(900, 1000), [
		"Token budget: 900 / 1k tokens used (90%).",
		"Budget critical: stop starting new tasks. Finish the current task, record evidence in progress.md, then call complete_plan_goal or pause_plan_goal.",
	]);
});
