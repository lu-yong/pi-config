import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { budgetPromptLines, buildGoalImplPrompt, buildGoalSetPrompt, buildPlanUpdatePrompt } from "./prompts.ts";
import { getPlanningSnapshot } from "./workspace.ts";
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

test("plan update prompt pins exact planning file paths and the continuity check", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-prompts-test-"));
	try {
		const snapshot = getPlanningSnapshot(cwd, false);
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
		const snapshot = getPlanningSnapshot(cwd, false);
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
