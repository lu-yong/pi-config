import path from "node:path";
import { MEANINGFUL_PROGRESS_TOOLS, PLANNING_FILE_NAMES } from "./types.ts";
import { ensureDir, getPaths } from "./utils.ts";

/**
 * Resolve a user-facing path to the planning directory equivalent.
 * Returns undefined if the input isn't one of the managed planning file names.
 */
export function getRedirectPath(inputPath: string, cwd: string): string | undefined {
	const normalized = inputPath.trim();
	if (!normalized) return undefined;
	const base = path.basename(normalized);
	if (!PLANNING_FILE_NAMES.includes(base as typeof PLANNING_FILE_NAMES[number])) return undefined;
	const target = path.join(getPaths(cwd).root, base);
	const resolvedTarget = path.resolve(target);
	const resolvedInput = path.resolve(cwd, normalized);
	if (resolvedInput === resolvedTarget) return undefined;
	return target;
}

/**
 * Redirect read/write/edit tool calls for planning file names into .pi/planning/.
 * Returns true when a redirect was applied.
 */
export function redirectPlanningPath(
	event: { toolName: string; input: Record<string, unknown> },
	cwd: string,
): boolean {
	if (!["read", "write", "edit"].includes(event.toolName)) return false;
	const rawPath = event.input.path;
	if (typeof rawPath !== "string") return false;
	const redirected = getRedirectPath(rawPath, cwd);
	if (!redirected) return false;
	ensureDir(getPaths(cwd).root);
	event.input.path = redirected;
	return true;
}

/**
 * Check whether a file path resolves inside .pi/planning/.
 */
export function isInPlanningDir(filePath: string, cwd: string): boolean {
	const planningRoot = path.resolve(getPaths(cwd).root);
	const resolved = path.resolve(cwd, filePath);
	const relative = path.relative(planningRoot, resolved);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Determine whether a tool call represents meaningful progress
 * (eligible to trigger continuation of an active goal run).
 */
export function isMeaningfulProgressToolCall(toolName: string, input: Record<string, unknown>): boolean {
	if (!MEANINGFUL_PROGRESS_TOOLS.has(toolName)) return false;
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command.trim() : "";
		if (!command || /^echo\b/.test(command)) return false;
	}
	return true;
}
