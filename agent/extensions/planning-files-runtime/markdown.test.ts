import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { finalizeProgressMarkdown, finalizeTaskPlanMarkdown } from "./markdown.ts";

const completion = { summary: "Goal shipped", evidence: ["focused tests pass"], runId: 7 };

const plan = `# Task Plan\n\n## Goal\nKeep this history.\n\n## Current Phase\nPhase 5\n\n## Next Concrete Action\n- complete_plan_goal\n\n## Blocker\nOld blocker\n\n## Phases\n### Phase 5: Delivery\n- [ ] historical checklist\n\n## Notes\nKeep these bytes.\n`;

describe("task-plan completion projection", () => {
	test("writes the standard three terminal sections and preserves history", () => {
		const result = finalizeTaskPlanMarkdown(plan);
		assert.match(result, /## Current Phase\nComplete/);
		assert.match(result, /## Next Concrete Action\n- None \(goal complete\)\./);
		assert.match(result, /## Blocker\n\[empty\]/);
		assert.match(result, /Keep this history\./);
		assert.match(result, /historical checklist/);
		assert.match(result, /Keep these bytes\./);
		assert.doesNotMatch(result, /Old blocker/);
	});

	test("is content-idempotent", () => {
		const once = finalizeTaskPlanMarkdown(plan);
		assert.equal(finalizeTaskPlanMarkdown(once), once);
	});

	test("normalizes the legacy sole Next Action heading", () => {
		const result = finalizeTaskPlanMarkdown(plan.replace("## Next Concrete Action", "## Next Action"));
		assert.match(result, /## Next Concrete Action\n- None \(goal complete\)\./);
		assert.doesNotMatch(result, /^## Next Action$/m);
	});

	test("appends missing live sections without regenerating content", () => {
		const source = "# Task Plan\n\n## Findings\n- preserve\n";
		const result = finalizeTaskPlanMarkdown(source);
		assert.match(result, /## Findings\n- preserve/);
		assert.match(result, /## Current Phase\nComplete/);
		assert.match(result, /## Next Concrete Action\n- None \(goal complete\)\./);
		assert.match(result, /## Blocker\n\[empty\]/);
	});

	test("rejects duplicate or conflicting live headings", () => {
		assert.throws(() => finalizeTaskPlanMarkdown(`${plan}\n## Blocker\nother\n`), /duplicate/);
		assert.throws(() => finalizeTaskPlanMarkdown(plan.replace("## Next Concrete Action", "## Next Action\n\n## Next Concrete Action")), /duplicate or conflicting/);
	});

	test("preserves CRLF and absence of a trailing newline", () => {
		const source = "# Task Plan\r\n\r\n## Current Phase\r\nPhase 1\r\n\r\n## Next Action\r\n- work\r\n\r\n## Blocker\r\nold";
		const result = finalizeTaskPlanMarkdown(source);
		assert.ok(!result.includes("\n") || result.includes("\r\n"));
		assert.ok(!result.endsWith("\n"));
		assert.match(result, /## Next Concrete Action\r\n- None \(goal complete\)\./);
	});

	test("ignores fenced live-heading examples and preserves their bytes", () => {
		const fenced = "```markdown\n## Current Phase\nExample phase\n\n## Next Concrete Action\n- example action\n\n## Blocker\nexample blocker\n```";
		const source = `# Task Plan\n\n## Notes\n${fenced}\n\n## Current Phase\nPhase 4\n\n## Next Concrete Action\n- finish\n\n## Blocker\nreal blocker\n`;
		const result = finalizeTaskPlanMarkdown(source);
		assert.ok(result.includes(fenced));
		assert.equal((result.match(/## Current Phase/g) ?? []).length, 2);
		assert.match(result, /```\n\n## Current Phase\nComplete/);
	});

	test("appends live sections when matching headings exist only inside tilde fences", () => {
		const fenced = "~~~markdown\n## Current Phase\nExample only\n\n## Next Concrete Action\n- example only\n\n## Blocker\nexample only\n~~~";
		const source = `# Task Plan\n\n## Notes\n${fenced}\n`;
		const result = finalizeTaskPlanMarkdown(source);
		assert.ok(result.includes(fenced));
		assert.match(result, /~~~\n\n## Current Phase\nComplete/);
		assert.match(result, /## Blocker\n\[empty\]/);
	});
});

describe("progress completion projection", () => {
	test("appends evidence and timeline once", () => {
		const source = "# Progress\n\n## Timeline\n- prior\n\n## Completion Evidence\n- [empty]\n";
		const once = finalizeProgressMarkdown(source, completion, "2026-08-12T00:00:00.000Z");
		const twice = finalizeProgressMarkdown(once, completion, "2026-08-12T00:00:00.000Z");
		assert.equal(twice, once);
		assert.equal((once.match(/goal-completion:run-7/g) ?? []).length, 2);
		assert.match(once, /Goal shipped \| evidence: focused tests pass/);
		assert.match(once, /Goal implementation completed \(run 7\): Goal shipped/);
	});

	test("ignores progress headings inside fenced examples", () => {
		const fenced = "```markdown\n## Timeline\n- example\n\n## Completion Evidence\n- example\n```";
		const source = `# Progress\n\n## Notes\n${fenced}\n\n## Timeline\n- prior\n\n## Completion Evidence\n- [empty]\n`;
		const result = finalizeProgressMarkdown(source, completion, "2026-08-12T00:00:00.000Z");
		assert.ok(result.includes(fenced));
		assert.equal((result.match(/goal-completion:run-7/g) ?? []).length, 2);
	});
});
