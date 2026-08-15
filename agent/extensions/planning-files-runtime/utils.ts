import fs from "node:fs";
import path from "node:path";
import { PLANNING_DIR, GOAL_STATE_FILE, GOAL_DESIGN_FILE } from "./types.ts";
import type { PathBundle, PlanningFileName } from "./types.ts";

// ---- time ----

export function nowIso(): string {
	return new Date().toISOString();
}

export function archiveStamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---- file system ----

export function fileExists(target: string): boolean {
	try {
		return fs.existsSync(target);
	} catch {
		return false;
	}
}

export function ensureDir(target: string): void {
	fs.mkdirSync(target, { recursive: true });
}

export function readText(target: string): string {
	try {
		return fs.readFileSync(target, "utf8");
	} catch {
		return "";
	}
}

export function writeText(target: string, content: string): void {
	ensureDir(path.dirname(target));
	fs.writeFileSync(target, content, "utf8");
}

/**
 * Atomically replace `target` with `content`: write the complete bytes to a
 * sibling temporary file, flush them, then rename over the destination. A
 * failure at any point leaves the destination untouched, so a partial write
 * can never masquerade as the persisted value.
 */
export function writeTextAtomic(target: string, content: string): void {
	const directory = path.dirname(target);
	ensureDir(directory);
	const temporary = path.join(directory, `.${path.basename(target)}.atomic-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
	try {
		const handle = fs.openSync(temporary, "w");
		try {
			fs.writeFileSync(handle, content, "utf8");
			fs.fsyncSync(handle);
		} finally {
			fs.closeSync(handle);
		}
		fs.renameSync(temporary, target);
	} finally {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {
			// Best-effort cleanup of a leftover temporary file.
		}
	}
}

export function getPaths(cwd: string): PathBundle {
	const root = path.join(cwd, PLANNING_DIR);
	return {
		root,
		archiveRoot: path.join(root, "archive"),
		goalState: path.join(root, GOAL_STATE_FILE),
		goalDesign: path.join(root, GOAL_DESIGN_FILE),
		tasksDir: path.join(root, "tasks"),
		files: {
			"task_plan.md": path.join(root, "task_plan.md"),
			"findings.md": path.join(root, "findings.md"),
			"progress.md": path.join(root, "progress.md"),
		},
	};
}

// ---- string ----

export function trimEmptyLines(text: string): string {
	return text.trim().replace(/\n{3,}/g, "\n\n");
}

export function tailLines(text: string, count: number): string {
	const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
	return lines.slice(-count).join("\n");
}

export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n...[truncated]`;
}

// ---- normalisation ----

export function normalizeString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const items: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		items.push(trimmed);
	}
	return items;
}
