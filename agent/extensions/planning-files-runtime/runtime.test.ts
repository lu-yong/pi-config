import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createGoalOverlay } from "./goal-overlay.ts";
import { getPlanningSnapshot } from "./prompts.ts";
import { handleAgentSettled } from "./runtime-events.ts";
import { defaultGoalState, writeGoalState } from "./state.ts";
import { buildWidgetLines } from "./ui.ts";
import { getPaths, writeText } from "./utils.ts";
import { initializePlanningWorkspace } from "./workspace.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("agent settlement refreshes a paused widget after an unobserved planning-file mutation", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planning-files-runtime-events-"));
	tempDirectories.push(cwd);
	initializePlanningWorkspace(cwd);
	writeGoalState(cwd, { ...defaultGoalState(), status: "paused" });
	const paths = getPaths(cwd);
	writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 2/3\n\n## Next Concrete Action\nTask 03\n");
	const overlay = createGoalOverlay(cwd);
	let widgetLines = buildWidgetLines(getPlanningSnapshot(cwd, false));
	assert.deepEqual(widgetLines?.filter((line) => /^(goal|phase|next):/.test(line)), [
		"goal: paused",
		"phase: Phase 2/3",
		"next: Task 03",
	]);

	// Represents a bash, Python, or custom-tool write with no write/edit tool result.
	writeText(paths.files["task_plan.md"], "# Task Plan\n\n## Current Phase\nPhase 4\n\n## Next Concrete Action\nTask 05\n");
	let notified = false;
	handleAgentSettled(overlay, {
		apply: (effects) => {
			assert.deepEqual(effects.map((effect) => effect.type), ["clear-continuation"]);
			return {};
		},
		notify: () => {
			notified = true;
		},
		refresh: () => {
			assert.equal(notified, true);
			widgetLines = buildWidgetLines(getPlanningSnapshot(cwd, false));
		},
	});

	assert.deepEqual(widgetLines?.filter((line) => /^(goal|phase|next):/.test(line)), [
		"goal: paused",
		"phase: Phase 4",
		"next: Task 05",
	]);
});
