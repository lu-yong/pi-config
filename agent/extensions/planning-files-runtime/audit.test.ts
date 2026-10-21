import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	parseAuditModelRef,
	resolveAuditModel,
	runCompletionAudit,
	type AuditModelCall,
	type AuditRequest,
} from "./audit.ts";
import type { GoalContract } from "./types.ts";

const goal: GoalContract = {
	objective: "Ship CSV export on the reports page",
	successCriteria: ["Tests cover filtered export", "Docs mention the download button"],
	constraints: ["Keep runtime behavior unchanged"],
	outOfScope: ["PDF export"],
	blockerRule: "Pause with a concrete blocker",
};

const request: AuditRequest = {
	goal,
	summary: "CSV export shipped with tests and docs",
	evidence: ["reports.test.ts covers filtered rows", "docs/reports.md updated"],
	progressTail: "## Progress\n- CSV export implemented\n- tests pass",
};

const USAGE = { input: 900, output: 100, cacheRead: 50, cacheWrite: 10 };

/** Test adapter of the audit model port; also captures the prompt it received. */
function fakeModel(response: string | Error): { call: AuditModelCall; captured: { system: string; user: string }[] } {
	const captured: { system: string; user: string }[] = [];
	const call: AuditModelCall = async (system, user) => {
		captured.push({ system, user });
		if (response instanceof Error) throw response;
		return { kind: "completed", text: response, usage: USAGE };
	};
	return { call, captured };
}

describe("runCompletionAudit", () => {
	test("approves when the verdict approves, and the prompt carries the contract and evidence", async () => {
		const { call, captured } = fakeModel("criterion 1: MET\ncriterion 2: MET\nVERDICT: APPROVE");
		const outcome = await runCompletionAudit(request, call);

		assert.deepEqual(outcome, { kind: "approved", usage: USAGE });
		assert.equal(captured.length, 1);
		assert.ok(captured[0].system.includes("VERDICT"));
		const user = captured[0].user;
		assert.ok(user.includes(goal.objective));
		for (const criterion of goal.successCriteria) assert.ok(user.includes(criterion));
		assert.ok(user.includes("reports.test.ts covers filtered rows"));
		assert.ok(user.includes("CSV export implemented"));
	});

	test("rejects and reports the unmet criteria, with its usage attached", async () => {
		const { call } = fakeModel("criterion 1: MET\ncriterion 2: UNMET - docs do not mention the button\nVERDICT: REJECT");
		const outcome = await runCompletionAudit(request, call);

		assert.equal(outcome.kind, "rejected");
		assert.ok(outcome.kind === "rejected" && outcome.reasons.includes("docs do not mention the button"));
		assert.ok(outcome.kind === "rejected" && outcome.usage === USAGE);
	});

	test("rejects without criterion lines by surfacing the auditor text", async () => {
		const { call } = fakeModel("The evidence does not support completion.\nVERDICT: REJECT");
		const outcome = await runCompletionAudit(request, call);

		assert.equal(outcome.kind, "rejected");
		assert.ok(outcome.kind === "rejected" && outcome.reasons.includes("evidence does not support"));
	});

	test("fails open when the response has no parseable verdict, keeping its usage", async () => {
		const { call } = fakeModel("Looks good to me.");
		const outcome = await runCompletionAudit(request, call);

		assert.deepEqual(outcome, { kind: "unavailable", reason: "auditor response contained no parseable VERDICT line", usage: USAGE });
	});

	test("fails open when the model call throws or reports failure, keeping billed usage", async () => {
		const thrown = await runCompletionAudit(request, fakeModel(new Error("offline")).call);
		assert.equal(thrown.kind, "unavailable");

		const failed: AuditModelCall = async () => ({ kind: "failed", reason: "provider 500", usage: USAGE });
		const outcome = await runCompletionAudit(request, failed);
		assert.deepEqual(outcome, { kind: "unavailable", reason: "provider 500", usage: USAGE });
	});

	test("the last VERDICT line wins when the model reconsiders", async () => {
		const { call } = fakeModel("VERDICT: REJECT\ncriterion 1: MET\ncriterion 2: MET\nVERDICT: APPROVE");
		const outcome = await runCompletionAudit(request, call);

		assert.deepEqual(outcome, { kind: "approved", usage: USAGE });
	});
});

describe("resolveAuditModel", () => {
	test("uses a resolvable configured model with its thinking level", () => {
		const configured = { id: "cfg" };
		const main = { id: "main" };
		const resolved = resolveAuditModel({ provider: "p", id: "cfg", thinking: "high" }, main, () => configured);

		assert.deepEqual(resolved, { model: configured, thinking: "high", notice: null });
	});

	test("falls back to the session model at low thinking, with a notice only when configured", () => {
		const main = { id: "main" };
		const missing = resolveAuditModel({ provider: "p", id: "gone", thinking: null }, main, () => undefined);
		assert.deepEqual(missing, { model: main, thinking: "low", notice: "planning.auditModel p/gone is not available; completion audit falls back to the session model." });

		const unconfigured = resolveAuditModel(null, main, () => undefined);
		assert.deepEqual(unconfigured, { model: main, thinking: "low", notice: null });
	});

	test("returns null when no model exists at all", () => {
		assert.equal(resolveAuditModel({ provider: "p", id: "gone", thinking: null }, undefined, () => undefined), null);
		assert.equal(resolveAuditModel(null, undefined, () => undefined), null);
	});
});

describe("parseAuditModelRef", () => {
	test("reads the planning.auditModel shape and drops invalid thinking", () => {
		assert.deepEqual(
			parseAuditModelRef({ auditModel: { provider: "magpie", id: "zhipu/glm-5.3-flash", thinking: "low" } }),
			{ provider: "magpie", id: "zhipu/glm-5.3-flash", thinking: "low" },
		);
		assert.deepEqual(
			parseAuditModelRef({ auditModel: { provider: "magpie", id: "x", thinking: "sideways" } }),
			{ provider: "magpie", id: "x", thinking: null },
		);
	});

	test("returns null for absent or malformed sections", () => {
		assert.equal(parseAuditModelRef(undefined), null);
		assert.equal(parseAuditModelRef({}), null);
		assert.equal(parseAuditModelRef({ auditModel: "glm" }), null);
		assert.equal(parseAuditModelRef({ auditModel: { provider: "", id: "x" } }), null);
	});
});
