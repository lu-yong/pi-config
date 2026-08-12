import type { GoalCompletion, GoalContract } from "./types.ts";
import { getPaths, nowIso, readText, trimEmptyLines, writeText } from "./utils.ts";

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
	for (const heading of ["Current Phase", "Blocker"] as const) {
		const count = sections.filter((section) => section.name === heading).length;
		if (count > 1) throw new Error(`Cannot finalize task_plan.md: duplicate \"## ${heading}\" headings.`);
	}
	const nextSections = sections.filter((section) => section.name === "Next Concrete Action" || section.name === "Next Action");
	if (nextSections.length > 1) {
		throw new Error("Cannot finalize task_plan.md: duplicate or conflicting next-action headings.");
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

	const desired = new Map<string, { heading: string; body: string }>([
		["Current Phase", { heading: "Current Phase", body: "Complete" }],
		["Next Concrete Action", { heading: "Next Concrete Action", body: "- None (goal complete)." }],
		["Next Action", { heading: "Next Concrete Action", body: "- None (goal complete)." }],
		["Blocker", { heading: "Blocker", body: "[empty]" }],
	]);
	const replacements: Array<{ start: number; end: number; text: string }> = [];
	const found = new Set<string>();
	for (const section of sections) {
		const projection = desired.get(section.name);
		if (!projection) continue;
		const canonicalName = projection.heading;
		found.add(canonicalName);
		const headingLine = section.name === "Next Action" ? `## ${canonicalName}` : section.headingLine;
		const terminalSection = section.end === markdown.length;
		const suffix = terminalSection ? (trailing ? eol : "") : `${eol}${eol}`;
		replacements.push({
			start: section.start,
			end: section.end,
			text: `${headingLine}${section.headingEol || eol}${projection.body}${suffix}`,
		});
	}

	let result = markdown;
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		result = `${result.slice(0, replacement.start)}${replacement.text}${result.slice(replacement.end)}`;
	}

	const missing = [
		{ heading: "Current Phase", body: "Complete" },
		{ heading: "Next Concrete Action", body: "- None (goal complete)." },
		{ heading: "Blocker", body: "[empty]" },
	].filter(({ heading }) => !found.has(heading));
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
		"Completion Evidence",
		`[${timestamp}] ${evidenceMessage}`,
		`<!-- ${runIdentity}:evidence -->`,
	);
	result = appendCompletionBullet(
		result,
		"Timeline",
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

## Timeline
${initialLine}

## Work Completed
- [empty]

## Verification
- [empty]

## Blockers / Interruptions
- [empty]

## Completion Evidence
- [empty]
`);
}

/**
 * Append a bullet to a markdown heading section.
 * If the heading doesn't exist, it is created.
 * If the first bullet is "[empty]", it is replaced.
 */
export function appendBulletToHeading(markdown: string, heading: string, bullet: string): string {
	const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const sectionPattern = new RegExp(`(## ${escapedHeading}\\n)([\\s\\S]*?)(?=\\n## |$)`);
	const match = markdown.match(sectionPattern);
	if (!match) return `${markdown.trim()}\n\n## ${heading}\n- ${bullet}\n`;
	const prefix = match[1] ?? `## ${heading}\n`;
	const body = (match[2] ?? "").replace(/^- \[empty\]\s*$/m, "").trimEnd();
	const nextBody = body === "" ? `- ${bullet}\n` : `${body}\n- ${bullet}\n`;
	return markdown.replace(sectionPattern, `${prefix}${nextBody}`);
}

/** Append a timestamped bullet to the progress.md timeline section. */
export function appendProgressTimeline(cwd: string, heading: string, message: string): void {
	const paths = getPaths(cwd);
	const target = paths.files["progress.md"];
	const content = readText(target) || createProgressTemplate();
	const next = appendBulletToHeading(content, heading, `[${nowIso()}] ${message}`);
	writeText(target, trimEmptyLines(next).concat("\n"));
}
