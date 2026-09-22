import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getPaths } from "./utils.ts";
import { gateDraftingToolCall, isLivePlanningMutation, isMeaningfulProgressToolCall } from "./guards.ts";
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
	assert.equal(isLivePlanningMutation("read", { path: planningFile }, cwd), false);
	assert.equal(isLivePlanningMutation("bash", { command: "pwd" }, cwd), false);
});

test("hashline anchor tools count as meaningful progress", () => {
	assert.equal(isMeaningfulProgressToolCall("replace", {}), true);
	assert.equal(isMeaningfulProgressToolCall("insert", {}), true);
	assert.equal(isMeaningfulProgressToolCall("undo_last_change", {}), true);
	assert.equal(isMeaningfulProgressToolCall("undo_last_replace", {}), true);
	assert.equal(isMeaningfulProgressToolCall("read", { path: "src/app.ts" }), false);
	assert.equal(isMeaningfulProgressToolCall("bash", { command: "echo hi" }), false);
});
