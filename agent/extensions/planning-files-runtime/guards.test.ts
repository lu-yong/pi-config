import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getPaths } from "./utils.ts";
import { gateDraftingToolCall, isLivePlanningMutation, isMeaningfulProgressToolCall, redirectPlanningPath } from "./guards.ts";
import { NETWORK_COMMANDS } from "../command-policy/policy.ts";

function makeCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "planning-guards-test-"));
}

test("drafting gate passes every tool call outside drafting", () => {
	const cwd = makeCwd();
	assert.equal(gateDraftingToolCall("none", "write", { path: "src/app.ts" }, cwd), undefined);
	assert.equal(gateDraftingToolCall("active", "bash", { command: "rm -rf /" }, cwd), undefined);
});

test("drafting gate allows write/edit inside the planning dir", () => {
	const cwd = makeCwd();
	const planningRoot = getPaths(cwd).root;
	assert.equal(gateDraftingToolCall("drafting", "write", { path: path.join(planningRoot, "goal-design.md") }, cwd), undefined);
	assert.equal(gateDraftingToolCall("drafting", "edit", { path: path.join(planningRoot, "task_plan.md") }, cwd), undefined);
});

test("drafting gate blocks write/edit outside the planning dir, including sibling prefix escapes", () => {
	const cwd = makeCwd();
	const planningRoot = getPaths(cwd).root;
	const write = gateDraftingToolCall("drafting", "write", { path: "src/app.ts" }, cwd);
	assert.equal(write?.block, true);
	assert.match(write!.reason, /does not allow creating files outside/);
	const escape = gateDraftingToolCall("drafting", "edit", { path: `${planningRoot}-escape/file.txt` }, cwd);
	assert.equal(escape?.block, true);
	assert.match(escape!.reason, /only allows editing files within/);
	// A missing path never passes as an in-planning write.
	assert.equal(gateDraftingToolCall("drafting", "write", {}, cwd)?.block, true);
});

test("drafting gate blocks anchor edits that do not name a target inside the planning dir", () => {
	const cwd = makeCwd();
	const planningFile = path.join(getPaths(cwd).root, "goal-design.md");
	// Default pi-hashline-edit-pro setup: anchor calls carry no path.
	for (const toolName of ["replace", "replace_match", "insert", "copy", "move", "undo_last_change"]) {
		const pathless = gateDraftingToolCall("drafting", toolName, { anchor: "abcd", text: "x" }, cwd);
		assert.equal(pathless?.block, true, toolName);
		assert.match(pathless!.reason, new RegExp(`blocked ${toolName}: .*does not name a target file`));
	}
	for (const toolName of ["replace", "replace_match", "insert", "undo_last_change"]) {
		const outside = gateDraftingToolCall("drafting", toolName, { path: "src/app.ts" }, cwd);
		assert.equal(outside?.block, true, toolName);
		assert.match(outside!.reason, /targets a file outside it/);
		assert.equal(gateDraftingToolCall("drafting", toolName, { path: planningFile }, cwd), undefined, toolName);
	}
	// copy/move take a source-or-destination path: never provably inside.
	for (const toolName of ["copy", "move"]) {
		assert.equal(gateDraftingToolCall("drafting", toolName, { path: planningFile }, cwd)?.block, true, toolName);
	}
	assert.equal(gateDraftingToolCall("active", "replace", {}, cwd), undefined);
	assert.equal(gateDraftingToolCall("drafting", "read", { path: "src/app.ts" }, cwd), undefined);
	assert.equal(gateDraftingToolCall("drafting", "custom_deploy", {}, cwd), undefined);
});

test("planning file names are redirected for every pathed file-mutation tool", () => {
	const cwd = makeCwd();
	const target = path.join(getPaths(cwd).root, "task_plan.md");
	for (const toolName of ["read", "write", "edit", "replace", "insert", "undo_last_change"]) {
		const event = { toolName, input: { path: "task_plan.md" } as Record<string, unknown> };
		assert.equal(redirectPlanningPath(event, cwd), true, toolName);
		assert.equal(event.input.path, target, toolName);
		assert.equal(gateDraftingToolCall("drafting", toolName, event.input, cwd), undefined, toolName);
	}
	const pathless = { toolName: "replace", input: { anchor: "abcd" } as Record<string, unknown> };
	assert.equal(redirectPlanningPath(pathless, cwd), false);
	const other = { toolName: "grep", input: { path: "task_plan.md" } as Record<string, unknown> };
	assert.equal(redirectPlanningPath(other, cwd), false);
});

test("drafting gate delegates bash to the command-policy drafting profile", () => {
	const cwd = makeCwd();
	assert.equal(gateDraftingToolCall("drafting", "bash", { command: "pwd && git status --short" }, cwd), undefined);
	const network = gateDraftingToolCall("drafting", "bash", { command: "curl https://example.com" }, cwd);
	assert.equal(network?.block, true);
	assert.match(network!.reason, /at segment `curl https:\/\/example\.com`/);
	const unparsable = gateDraftingToolCall("drafting", "bash", { command: "echo $(whoami)" }, cwd);
	assert.equal(unparsable?.block, true);
	assert.match(unparsable!.reason, /could not be parsed/);
});

test("drafting gate rejection advice derives the network list from command-policy", () => {
	const cwd = makeCwd();
	const blocked = gateDraftingToolCall("drafting", "bash", { command: "wget https://example.com" }, cwd);
	assert.equal(blocked?.block, true);
	assert.ok(blocked!.reason.includes([...NETWORK_COMMANDS].join(", ")));
});

test("planning mutation predicate refreshes goal and hashline mutations only", () => {
	const cwd = makeCwd();
	const planningFile = path.join(getPaths(cwd).root, "task_plan.md");
	assert.equal(isLivePlanningMutation("pause_plan_goal", {}, cwd), true);
	assert.equal(isLivePlanningMutation("write", { path: planningFile }, cwd), true);
	assert.equal(isLivePlanningMutation("edit", { path: planningFile }, cwd), true);
	assert.equal(isLivePlanningMutation("replace", {}, cwd), true);
	assert.equal(isLivePlanningMutation("insert", {}, cwd), true);
	assert.equal(isLivePlanningMutation("undo_last_change", {}, cwd), true);
	assert.equal(isLivePlanningMutation("write", { path: "src/app.ts" }, cwd), false);
	// A pathed anchor edit is as precise as write: outside the planning dir it does not refresh.
	assert.equal(isLivePlanningMutation("replace", { path: "src/app.ts" }, cwd), false);
	assert.equal(isLivePlanningMutation("replace", { path: planningFile }, cwd), true);
	assert.equal(isLivePlanningMutation("copy", { path: "src/app.ts" }, cwd), true);
	assert.equal(isLivePlanningMutation("read", { path: planningFile }, cwd), false);
	assert.equal(isLivePlanningMutation("bash", { command: "pwd" }, cwd), false);
});

test("hashline anchor tools count as meaningful progress", () => {
	assert.equal(isMeaningfulProgressToolCall("replace", {}), true);
	assert.equal(isMeaningfulProgressToolCall("insert", {}), true);
	assert.equal(isMeaningfulProgressToolCall("undo_last_change", {}), true);
	assert.equal(isMeaningfulProgressToolCall("read", { path: "src/app.ts" }), false);
	assert.equal(isMeaningfulProgressToolCall("bash", { command: "echo hi" }), false);
});

for (const toolName of ["replace_match", "copy", "move"]) {
	test(`${toolName} refreshes planning and counts as progress without an input path`, () => {
		const cwd = makeCwd();
		try {
			assert.equal(isLivePlanningMutation(toolName, {}, cwd), true);
			assert.equal(isMeaningfulProgressToolCall(toolName, {}), true);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
}
