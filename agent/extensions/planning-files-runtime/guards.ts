import path from "node:path";
import { MEANINGFUL_PROGRESS_TOOLS, PLANNING_FILE_NAMES } from "./types.ts";
import type { GoalOverlayStatus } from "./types.ts";
import { ensureDir, getPaths } from "./utils.ts";
import { explainUnsafeCommand, NETWORK_COMMANDS, type UnsafeCommandReason } from "../command-policy/policy.ts";

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
 * Check whether a file path resolves inside .pi/planning/. Private: callers
 * go through gateDraftingToolCall, which is also the test surface.
 */
function isInPlanningDir(filePath: string, cwd: string): boolean {
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

// ---- drafting gate ----

const NETWORK_COMMAND_LIST = [...NETWORK_COMMANDS].join(", ");

const DRAFTING_BASH_ADVICE =
	`Goal drafting bash is fail-closed: every segment of a compound command must be an approved read-only command, and network commands (${NETWORK_COMMAND_LIST}) are blocked. Prefer the read tool for file contents, and use save_plan_goal_draft / commit_plan_goal instead of mutating the workspace.`;

/**
 * Turn a policy rejection into a message that names the offending segment, so a
 * blocked compound command does not read as "compound commands are unsupported".
 */
function draftingBashRejection(reason: UnsafeCommandReason): string {
	if (reason.kind === "unparsable") {
		return `Goal drafting blocked this bash command: it could not be parsed into plain read-only segments. Redirects other than stderr to /dev/null (2>/dev/null), backticks, $(), subshells, and unbalanced quotes are always rejected. ${DRAFTING_BASH_ADVICE}`;
	}
	return `Goal drafting blocked this bash command at segment \`${reason.segment}\`: that segment is not an approved read-only command. The remaining segments were not the problem — rerun without this one. ${DRAFTING_BASH_ADVICE}`;
}

/**
 * The single adjudication point for tool calls while a goal is being drafted:
 * write/edit are confined to .pi/planning/, and bash must pass the
 * command-policy 'drafting' profile. Absorbs the status check — outside
 * drafting every call passes. Returns Pi's block shape (a plain object, no Pi
 * type dependency) so the adapter can forward the result unchanged.
 */
export function gateDraftingToolCall(
	status: GoalOverlayStatus,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): { block: true; reason: string } | undefined {
	if (status !== "drafting") return undefined;
	if (toolName === "write" || toolName === "edit") {
		const filePath = typeof input.path === "string" ? input.path : "";
		if (isInPlanningDir(filePath, cwd)) return undefined;
		return {
			block: true,
			reason: toolName === "write"
				? "Goal drafting does not allow creating files outside .pi/planning/. Use save_plan_goal_draft / commit_plan_goal."
				: "Goal drafting only allows editing files within .pi/planning/.",
		};
	}
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const unsafe = explainUnsafeCommand(command, "drafting");
		if (unsafe) return { block: true, reason: draftingBashRejection(unsafe) };
	}
	return undefined;
}
