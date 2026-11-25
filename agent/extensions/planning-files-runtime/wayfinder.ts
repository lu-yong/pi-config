import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { extractSections } from "./markdown.ts";

const exec = promisify(execFile);
const TASKMD_TIMEOUT_MS = 15_000;
const ticketTags = new Set(["wayfinder:research", "wayfinder:prototype", "wayfinder:grilling", "wayfinder:setup"]);
const templatePlaceholders = new Set([
	"<final answer when done; empty while open>",
	"<what reaching the end of this map looks like>",
	"<domain notes; skills every session should consult; standing preferences>",
]);

type RecordSummary = {
	id: string;
	title: string;
	status: string;
	parent?: string;
	tags?: string[];
	file_path: string;
};

async function taskmd(directory: string, args: string[]) {
	try {
		const run = (scope: string[]) => exec(
			"taskmd",
			["-d", directory, ...scope, ...args],
			{ cwd: directory, maxBuffer: 16 * 1024 * 1024, timeout: TASKMD_TIMEOUT_MS },
		);
		const { stdout, stderr } = await run(["--worktree-scope", "isolated"]).catch((error: unknown) => {
			// Older taskmd releases predate cross-worktree aggregation.
			const stderrText = (error as { stderr?: unknown } | null)?.stderr;
			if (typeof stderrText === "string" && /unknown flag: --worktree-scope/.test(stderrText)) return run([]);
			throw error;
		});
		// taskmd can exit successfully with a partial list after a scan error.
		if (stderr.trim()) throw new Error(stderr.trim());
		return stdout;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("Check that taskmd is installed and .pi/wayfinder/tickets exists in this repository.");
		}
		throw error;
	}
}

function stripFrontmatter(raw: string): string {
	return raw.replace(/^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/, "");
}

function stripHtmlCommentsOutsideCode(text: string): string {
	let result = "";
	let i = 0;
	let atLineStart = true;
	let fence: { marker: "`" | "~"; length: number } | null = null;
	while (i < text.length) {
		if (atLineStart) {
			const lineEnd = text.indexOf("\n", i);
			const end = lineEnd === -1 ? text.length : lineEnd + 1;
			const rawLine = text.slice(i, end);
			const line = rawLine.replace(/\r?\n$/, "");
			const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (fenceMatch) {
				const run = fenceMatch[1]!;
				const marker = run[0] as "`" | "~";
				const rest = fenceMatch[2] ?? "";
				if (!fence && (marker === "~" || !rest.includes("`"))) {
					fence = { marker, length: run.length };
					result += rawLine;
					i = end;
					continue;
				}
				if (fence && marker === fence.marker && run.length >= fence.length && rest.trim() === "") {
					fence = null;
					result += rawLine;
					i = end;
					continue;
				}
			}
			if (fence) {
				result += rawLine;
				i = end;
				continue;
			}
		}
		const ch = text[i]!;
		if (ch === "`") {
			let runEnd = i + 1;
			while (runEnd < text.length && text[runEnd] === "`") runEnd++;
			const ticks = text.slice(i, runEnd);
			const close = text.indexOf(ticks, runEnd);
			if (close !== -1) {
				const span = text.slice(i, close + ticks.length);
				result += span;
				atLineStart = span.endsWith("\n");
				i = close + ticks.length;
				continue;
			}
			result += ticks;
			atLineStart = false;
			i = runEnd;
			continue;
		}
		if (text.startsWith("<!--", i)) {
			const close = text.indexOf("-->", i + 4);
			if (close !== -1) {
				i = close + 3;
				if (atLineStart && (text[i] === "\n" || text.startsWith("\r\n", i))) {
					i += text[i] === "\r" ? 2 : 1;
					continue;
				}
				atLineStart = false;
				continue;
			}
		}
		result += ch;
		atLineStart = ch === "\n";
		i++;
	}
	return result.trim();
}

function section(body: string, name: string, recordTitle: string): string {
	const matches = extractSections(body, name);
	if (matches.length > 1) throw new Error(`${recordTitle} has duplicate "## ${name}" sections.`);
	const cleaned = stripHtmlCommentsOutsideCode(matches[0] ?? "");
	if (!cleaned || templatePlaceholders.has(cleaned)) return "";
	return cleaned;
}

function resolveRecordPath(directory: string, filePath: string): string {
	const root = path.resolve(directory);
	const resolved = path.resolve(root, filePath);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Record path escapes ${directory}: ${filePath}`);
	}
	return resolved;
}

export async function readWayfinderHandoff(cwd: string, mapName: string) {
	const directory = path.join(cwd, ".pi/wayfinder/tickets");
	const records: RecordSummary[] = JSON.parse(await taskmd(directory, ["list", "--sort", "id", "--format", "json"])) ?? [];
	const maps = records.filter(record => record.tags?.includes("wayfinder:map"));
	const active = maps.filter(map => map.status === "in-progress");
	if (active.length > 1) throw new Error(`Multiple Active Maps: ${active.map(map => map.title).join(", ")}`);
	let candidates = active;
	if (mapName) candidates = maps.filter(map => map.title === mapName && ["in-progress", "completed"].includes(map.status));
	else if (!active.length) candidates = maps.filter(map => map.status === "completed");
	if (!candidates.length) throw new Error("No matching active or completed Wayfinder Map.");
	if (candidates.length > 1) {
		throw new Error(`Choose a Map with /wayfinder handoff <full Map title>: ${candidates.map(map => map.title).join(", ")}`);
	}
	const map = candidates[0]!;
	const children = records.filter(record => record.parent === map.id);
	const tickets = children.filter(record => record.tags?.some(tag => ticketTags.has(tag)));
	const untaggedOpen = children.filter(
		record => !record.tags?.some(tag => ticketTags.has(tag)) && !["completed", "cancelled"].includes(record.status),
	);
	if (untaggedOpen.length) {
		throw new Error(
			`Unresolved child records without a Wayfinder ticket tag: ${untaggedOpen.map(record => `${record.title} (${record.status})`).join(", ")}`,
		);
	}
	const open = tickets.filter(ticket => !["completed", "cancelled"].includes(ticket.status));
	if (open.length) throw new Error(`Unresolved Tickets: ${open.map(ticket => `${ticket.title} (${ticket.status})`).join(", ")}`);

	const readBody = async (record: RecordSummary) => stripFrontmatter(await readFile(resolveRecordPath(directory, record.file_path), "utf8"));
	const body = await readBody(map);
	const destination = section(body, "Destination", map.title);
	if (!destination) throw new Error(`${map.title} needs a Destination.`);
	const fog = section(body, "Not Yet Specified", map.title);
	if (fog && !/^(?:[-*]\s+)?(?:none|n\/a|无(?:待决事项)?)[.。]?$/i.test(fog)) {
		throw new Error(`${map.title} has unresolved decisions in Not Yet Specified:\n${fog}`);
	}

	const input = [map.title, `## Destination\n${destination}`];
	for (const heading of ["Notes", "Decisions So Far", "Out of Scope"]) {
		const value = section(body, heading, map.title);
		if (value) input.push(`## ${heading}\n${value}`);
	}
	for (const ticket of tickets.filter(ticket => ticket.status === "completed")) {
		const resolution = section(await readBody(ticket), "Resolution", ticket.title);
		if (!resolution) throw new Error(`${ticket.title} is completed but has no Resolution.`);
		input.push(`### ${ticket.title}\n${resolution}`);
	}
	return { mapId: map.id, active: map.status === "in-progress", topic: input.join("\n\n") };
}

export async function finishWayfinderMap(cwd: string, mapId: string) {
	const directory = path.join(cwd, ".pi/wayfinder/tickets");
	const map: RecordSummary = JSON.parse(await taskmd(directory, ["get", "--exact", "--format", "json", "--", mapId]));
	if (map.id !== mapId || !map.tags?.includes("wayfinder:map")) throw new Error("The handoff Map is no longer available.");
	if (map.status === "in-progress") await taskmd(directory, ["set", "--task-id", mapId, "--status", "completed"]);
}
