import type { GoalContract } from "./types.ts";
import { truncate } from "./utils.ts";

/**
 * Independent completion audit — a deep module whose whole interface is
 * `runCompletionAudit(request, callModel)`.
 *
 * Behind that seam sits everything about auditing: the auditor prompt, the
 * VERDICT protocol, response parsing, and the fail-open policy when the
 * auditor cannot answer. The model call itself is an injected port (true
 * external dependency): production adapts `ctx.modelRegistry.streamSimple`,
 * tests adapt canned responses. Model selection and settings parsing live
 * here too as pure functions, so the runtime adapter stays thin wiring.
 *
 * Fail-open is deliberate: the auditor is a checker, not a gate that may
 * brick completion on infrastructure failure. A rejected verdict blocks
 * completion; an unavailable auditor does not.
 */

// ---- public vocabulary ----

/** Pi-ai thinking levels, mirrored locally to keep this module dependency-free. */
export type AuditThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** `planning.auditModel` reference from settings.json. */
export type AuditModelRef = { provider: string; id: string; thinking: AuditThinkingLevel | null };

/** Structural subset of pi-ai's Usage; keeps this module free of pi imports. */
export type AuditUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type AuditRequest = {
	goal: GoalContract;
	summary: string;
	evidence: string[];
	/** Tail of progress.md — the recorded evidence the claim is judged against. */
	progressTail: string;
};

/** Port: one auditor model call. Adapters classify their own transport failures. */
export type AuditModelCall = (system: string, user: string) => Promise<AuditModelResult>;

export type AuditModelResult =
	| { kind: "completed"; text: string; usage?: AuditUsage }
	| { kind: "failed"; reason: string; usage?: AuditUsage };

export type AuditOutcome =
	| { kind: "approved"; usage?: AuditUsage }
	| { kind: "rejected"; reasons: string; usage?: AuditUsage }
	| { kind: "unavailable"; reason: string; usage?: AuditUsage };

// ---- the interface ----

export async function runCompletionAudit(request: AuditRequest, callModel: AuditModelCall): Promise<AuditOutcome> {
	const { system, user } = buildAuditMessages(request);
	let result: AuditModelResult;
	try {
		result = await callModel(system, user);
	} catch (error) {
		return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
	if (result.kind === "failed") return { kind: "unavailable", reason: result.reason, ...(result.usage ? { usage: result.usage } : {}) };
	const usage = result.usage;
	const verdict = parseAuditVerdict(result.text);
	if (!verdict) {
		// Tokens were still spent; keep the usage for session accounting.
		return { kind: "unavailable", reason: "auditor response contained no parseable VERDICT line", ...(usage ? { usage } : {}) };
	}
	if (verdict.approved) return { kind: "approved", ...(usage ? { usage } : {}) };
	return { kind: "rejected", reasons: verdict.reasons, ...(usage ? { usage } : {}) };
}

// ---- model selection ----

/**
 * Decide which model audits: a resolvable `planning.auditModel` reference
 * wins; anything else falls back to the session model at low thinking.
 * Returns null only when no model exists at all.
 */
export function resolveAuditModel<TModel>(
	ref: AuditModelRef | null,
	mainModel: TModel | undefined,
	find: (provider: string, id: string) => TModel | undefined,
): { model: TModel; thinking: AuditThinkingLevel; notice: string | null } | null {
	if (ref) {
		const configured = find(ref.provider, ref.id);
		if (configured) return { model: configured, thinking: ref.thinking ?? "low", notice: null };
	}
	if (!mainModel) return null;
	return {
		model: mainModel,
		thinking: "low",
		notice: ref ? `planning.auditModel ${ref.provider}/${ref.id} is not available; completion audit falls back to the session model.` : null,
	};
}

/** Parse the `planning` settings object into an audit model reference. */
export function parseAuditModelRef(planning: unknown): AuditModelRef | null {
	if (!planning || typeof planning !== "object" || Array.isArray(planning)) return null;
	const raw = (planning as Record<string, unknown>).auditModel;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const ref = raw as Record<string, unknown>;
	const provider = typeof ref.provider === "string" ? ref.provider.trim() : "";
	const id = typeof ref.id === "string" ? ref.id.trim() : "";
	if (!provider || !id) return null;
	const thinking = typeof ref.thinking === "string" && THINKING_LEVELS.includes(ref.thinking) ? (ref.thinking as AuditThinkingLevel) : null;
	return { provider, id, thinking };
}

// ---- implementation: prompt, protocol, parsing ----

const AUDITOR_SYSTEM_PROMPT = [
	"You are an independent completion auditor for a coding-agent goal run. You did not do the work.",
	"Judge only from the goal contract, the completion claim, and the recorded evidence.",
	"",
	"Rules:",
	"- Evaluate each success criterion separately. Evidence must be concrete: changed files, passing tests, command output, or produced report content. Restated claims are not evidence.",
	"- Constraints and out-of-scope items are context; they do not decide the verdict.",
	"- If the evidence for a criterion is missing or only asserted, that criterion is UNMET.",
	"",
	"Output format:",
	"- One line per criterion: \"criterion N: MET\" or \"criterion N: UNMET - <what is missing>\"",
	"- Last line exactly: \"VERDICT: APPROVE\" when every criterion is MET, otherwise \"VERDICT: REJECT\".",
].join("\n");

function buildAuditMessages(request: AuditRequest): { system: string; user: string } {
	const criteria = request.goal.successCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n");
	const evidence = request.evidence.length > 0 ? request.evidence.map((item) => `- ${item}`).join("\n") : "- (none)";
	const user = [
		`Goal objective: ${request.goal.objective}`,
		"Success criteria:",
		criteria,
		`Constraints (context): ${request.goal.constraints.join("; ") || "(none)"}`,
		`Out of scope (context): ${request.goal.outOfScope.join("; ") || "(none)"}`,
		`Completion summary: ${request.summary}`,
		"Claimed evidence:",
		evidence,
		"",
		"progress.md tail (recorded evidence, may be partial):",
		truncate(request.progressTail.trim(), 4000) || "(empty)",
	].join("\n");
	return { system: AUDITOR_SYSTEM_PROMPT, user };
}

type ParsedVerdict = { approved: true } | { approved: false; reasons: string };

/** The last VERDICT line wins; anything without one is unparseable. */
function parseAuditVerdict(text: string): ParsedVerdict | null {
	const matches = [...text.matchAll(/VERDICT:\s*(APPROVE|REJECT)/gi)];
	if (matches.length === 0) return null;
	if (matches[matches.length - 1][1].toUpperCase() === "APPROVE") return { approved: true };
	const unmet = text
		.split(/\r?\n/)
		.filter((line) => /^\s*criterion\s*\d+\s*:\s*UNMET/i.test(line))
		.map((line) => line.trim());
	if (unmet.length > 0) return { approved: false, reasons: unmet.join("; ") };
	return { approved: false, reasons: truncate(text.trim(), 400) || "auditor rejected without stating reasons" };
}
