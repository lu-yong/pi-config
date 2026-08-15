import type { GoalCompletion, GoalContract } from "./types.ts";
import { nowIso, trimEmptyLines } from "./utils.ts";

/**
 * The planning-file heading vocabulary. Templates, parsing and finalization all
 * reference these constants so a heading is spelled in exactly one place.
 */
export const HEADINGS = {
	goal: "Goal",
	currentPhase: "Current Phase",
	nextAction: "Next Concrete Action",
	blocker: "Blocker",
	timeline: "Timeline",
	workCompleted: "Work Completed",
	verification: "Verification",
	blockers: "Blockers / Interruptions",
	completionEvidence: "Completion Evidence",
} as const;

type MarkdownSection = {
	name: string;
	start: number;
	headingLine: string;
	headingEol: string;
	bodyStart: number;
	end: number;
};

function newlineOf(markdown: string): "\r\n" | "\n" {
	return markdown.includes("\r\n") ? "\r\n" : "\n";
}

function hasTrailingNewline(markdown: string): boolean {
	return /(?:\r\n|\n)$/.test(markdown);
}

function sectionsOf(markdown: string): MarkdownSection[] {
	const headings: Array<Omit<MarkdownSection, "end">> = [];
	const linePattern = /.*(?:\r\n|\n|$)/g;
	let fence: { marker: "`" | "~"; length: number } | null = null;
	for (let match = linePattern.exec(markdown); match && match[0] !== ""; match = linePattern.exec(markdown)) {
		const full = match[0];
		const headingEol = full.endsWith("\r\n") ? "\r\n" : full.endsWith("\n") ? "\n" : "";
		const line = headingEol ? full.slice(0, -headingEol.length) : full;
		const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
		if (fenceMatch) {
			const run = fenceMatch[1]!;
			const marker = run[0] as "`" | "~";
			const rest = fenceMatch[2] ?? "";
			if (!fence) {
				// Backtick info strings cannot contain a backtick; tilde info strings are unrestricted.
				if (marker === "~" || !rest.includes("`")) fence = { marker, length: run.length };
			} else if (marker === fence.marker && run.length >= fence.length && rest.trim() === "") {
				fence = null;
			}
			continue;
		}
		if (fence) continue;
		const headingMatch = line.match(/^##[ \t]+([^\r\n]*?)[ \t]*$/);
		if (!headingMatch) continue;
		headings.push({
			name: (headingMatch[1] ?? "").trim(),
			start: match.index,
			headingLine: line,
			headingEol,
			bodyStart: linePattern.lastIndex,
		});
	}
	return headings.map((heading, index) => ({
		...heading,
		end: headings[index + 1]?.start ?? markdown.length,
	}));
}

function appendSections(markdown: string, bodies: Array<{ heading: string; body: string }>): string {
	if (bodies.length === 0) return markdown;
	const eol = newlineOf(markdown);
	const trailing = hasTrailingNewline(markdown);
	let result = markdown;
	if (result.length > 0) {
		if (result.endsWith(`${eol}${eol}`)) {
			// Existing blank-line separation is already sufficient.
		} else if (result.endsWith(eol)) {
			result += eol;
		} else {
			result += `${eol}${eol}`;
		}
	}
	result += bodies.map(({ heading, body }) => `## ${heading}${eol}${body}`).join(`${eol}${eol}`);
	return trailing ? `${result}${eol}` : result;
}

function assertUniqueLiveSections(sections: MarkdownSection[]): void {
	// Legacy-name support was removed: fail loudly instead of leaving the stale
	// section in place alongside a freshly appended canonical one.
	if (sections.some((section) => section.name === "Next Action")) {
		throw new Error(`Cannot finalize task_plan.md: legacy "## Next Action" heading is no longer supported; rename it to "## ${HEADINGS.nextAction}".`);
	}
	for (const heading of [HEADINGS.currentPhase, HEADINGS.nextAction, HEADINGS.blocker] as const) {
		const count = sections.filter((section) => section.name === heading).length;
		if (count > 1) throw new Error(`Cannot finalize task_plan.md: duplicate \"## ${heading}\" headings.`);
	}
}

/**
 * Project only the task plan's standard live-state sections into their terminal
 * values. All unrelated bytes remain outside the replaced section ranges.
 */
export function finalizeTaskPlanMarkdown(markdown: string): string {
	const eol = newlineOf(markdown);
	const trailing = hasTrailingNewline(markdown);
	const sections = sectionsOf(markdown);
	assertUniqueLiveSections(sections);

	const terminalBodies = [
		{ heading: HEADINGS.currentPhase, body: "Complete" },
		{ heading: HEADINGS.nextAction, body: "- None (goal complete)." },
		{ heading: HEADINGS.blocker, body: "[empty]" },
	];
	const desired = new Map(terminalBodies.map((entry) => [entry.heading, entry] as const));
	const replacements: Array<{ start: number; end: number; text: string }> = [];
	const found = new Set<string>();
	for (const section of sections) {
		const projection = desired.get(section.name);
		if (!projection) continue;
		found.add(projection.heading);
		const terminalSection = section.end === markdown.length;
		const suffix = terminalSection ? (trailing ? eol : "") : `${eol}${eol}`;
		replacements.push({
			start: section.start,
			end: section.end,
			text: `${section.headingLine}${section.headingEol || eol}${projection.body}${suffix}`,
		});
	}

	let result = markdown;
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		result = `${result.slice(0, replacement.start)}${replacement.text}${result.slice(replacement.end)}`;
	}

	const missing = terminalBodies.filter(({ heading }) => !found.has(heading));
	return appendSections(result, missing);
}

function appendCompletionBullet(markdown: string, heading: string, bullet: string, identity: string): string {
	if (markdown.includes(identity)) return markdown;
	const sections = sectionsOf(markdown).filter((section) => section.name === heading);
	if (sections.length > 1) throw new Error(`Cannot finalize progress.md: duplicate \"## ${heading}\" headings.`);
	if (sections.length === 0) return appendSections(markdown, [{ heading, body: `- ${bullet} ${identity}` }]);

	const section = sections[0]!;
	const eol = newlineOf(markdown);
	const body = markdown.slice(section.bodyStart, section.end);
	const emptyPattern = /^[ \t]*- \[empty\][ \t]*(?:\r\n|\n)?/;
	const withoutEmpty = body.replace(emptyPattern, "");
	const content = withoutEmpty.replace(/(?:\r\n|\n)+$/, "");
	const appended = content.trim().length === 0 ? `- ${bullet} ${identity}` : `${content}${eol}- ${bullet} ${identity}`;
	const terminalSection = section.end === markdown.length;
	const suffix = terminalSection ? (hasTrailingNewline(markdown) ? eol : "") : `${eol}${eol}`;
	return `${markdown.slice(0, section.bodyStart)}${appended}${suffix}${markdown.slice(section.end)}`;
}

/** Append idempotent, timestamped completion projections to progress.md. */
export function finalizeProgressMarkdown(markdown: string, completion: GoalCompletion, timestamp: string): string {
	const evidenceMessage = `${completion.summary}${completion.evidence.length > 0 ? ` | evidence: ${completion.evidence.join("; ")}` : ""}`;
	const runIdentity = `goal-completion:run-${completion.runId}`;
	let result = appendCompletionBullet(
		markdown,
		HEADINGS.completionEvidence,
		`[${timestamp}] ${evidenceMessage}`,
		`<!-- ${runIdentity}:evidence -->`,
	);
	result = appendCompletionBullet(
		result,
		HEADINGS.timeline,
		`[${timestamp}] Goal implementation completed (run ${completion.runId}): ${completion.summary}`,
		`<!-- ${runIdentity}:timeline -->`,
	);
	return result;
}

export function createProgressTemplate(goal?: GoalContract, runId?: number): string {
	const initialLine = goal
		? `- [${nowIso()}] Goal implementation started${typeof runId === "number" ? ` (run ${runId})` : ""}: ${goal.objective}`
		: `- [${nowIso()}] Planning workspace initialized`;
	return trimEmptyLines(`# Progress

## ${HEADINGS.timeline}
${initialLine}

## ${HEADINGS.workCompleted}
- [empty]

## ${HEADINGS.verification}
- [empty]

## ${HEADINGS.blockers}
- [empty]

## ${HEADINGS.completionEvidence}
- [empty]
`);
}

/** Read one section body, or undefined when the heading is absent or empty. */
export function extractSection(text: string, heading: string): string | undefined {
	const section = sectionsOf(text).find((candidate) => candidate.name === heading);
	if (!section) return undefined;
	return text.slice(section.bodyStart, section.end).trim() || undefined;
}

/** First non-blank line of a section body, with any leading bullet marker removed. */
export function firstMeaningfulLine(text: string | undefined): string | undefined {
	if (!text) return undefined;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return trimmed.replace(/^[-*]\s*/, "");
	}
	return undefined;
}

/**
 * Append a bullet to a markdown heading section.
 * If the heading doesn't exist, it is created.
 * If the section carries the "[empty]" placeholder bullet, it is replaced.
 */
export function appendBulletToHeading(markdown: string, heading: string, bullet: string): string {
	const eol = newlineOf(markdown);
	const section = sectionsOf(markdown).find((candidate) => candidate.name === heading);
	if (!section) return `${markdown.trim()}${eol}${eol}## ${heading}${eol}- ${bullet}${eol}`;

	const body = markdown.slice(section.bodyStart, section.end);
	// Anchored at the body start (no /m): a "[empty]" placeholder is only ever
	// the section's first bullet, and /m would also strip one inside a fence.
	const withoutEmpty = body.replace(/^[ \t]*- \[empty\][ \t]*(?:\r\n|\n)?/, "");
	const content = withoutEmpty.replace(/(?:\r\n|\n)+$/, "");
	const appended = content.trim().length === 0 ? `- ${bullet}` : `${content}${eol}- ${bullet}`;
	const terminalSection = section.end === markdown.length;
	const suffix = terminalSection ? (hasTrailingNewline(markdown) ? eol : "") : `${eol}${eol}`;
	return `${markdown.slice(0, section.bodyStart)}${appended}${suffix}${markdown.slice(section.end)}`;
}
