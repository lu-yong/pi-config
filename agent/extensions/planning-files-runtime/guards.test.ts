import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getPaths } from "./utils.ts";
import { isInPlanningDir } from "./guards.ts";

test("planning directory checks reject sibling prefix paths", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-guards-test-"));
	const planningRoot = getPaths(cwd).root;
	assert.equal(isInPlanningDir(path.join(planningRoot, "task_plan.md"), cwd), true);
	assert.equal(isInPlanningDir(`${planningRoot}-escape/file.txt`, cwd), false);
});
