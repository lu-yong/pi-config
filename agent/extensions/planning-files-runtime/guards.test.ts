import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getPaths } from "./utils.ts";
import { isInPlanningDir, isUnsafeDraftingBash } from "./guards.ts";

test("drafting bash checks fail closed for shell writes and unknown commands", () => {
	assert.equal(isUnsafeDraftingBash("rg TODO agent"), false);
	assert.equal(isUnsafeDraftingBash("git status --short"), false);
	assert.equal(isUnsafeDraftingBash("npm test"), false);
	assert.equal(isUnsafeDraftingBash("echo injected > /tmp/drafting-escape"), true);
	assert.equal(isUnsafeDraftingBash("unknown-command --read-only"), true);
	assert.equal(isUnsafeDraftingBash("python -c 'open(\\\"escape\\\", \\\"w\\\")'"), true);
	assert.equal(
		isUnsafeDraftingBash("pwd && printf '%s\\n' '--- files ---' && rg --files -g '!node_modules' -g '!.git' | sed -n '1,240p' && git status --short"),
		true,
	);
	assert.equal(isUnsafeDraftingBash("pwd\nrm -rf /tmp/drafting-escape"), true);
});

test("planning directory checks reject sibling prefix paths", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-guards-test-"));
	const planningRoot = getPaths(cwd).root;
	assert.equal(isInPlanningDir(path.join(planningRoot, "task_plan.md"), cwd), true);
	assert.equal(isInPlanningDir(`${planningRoot}-escape/file.txt`, cwd), false);
});
