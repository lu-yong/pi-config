import path from "node:path";
import { MEANINGFUL_PROGRESS_TOOLS, PLANNING_FILE_NAMES } from "./types";
import { ensureDir, getPaths } from "./utils";

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
 * Block dangerous bash commands during goal drafting.
 */
const DRAFTING_READ_COMMANDS = new Set([
	"cat", "cut", "date", "diff", "dirname", "echo", "file", "find", "git", "grep", "head",
	"ls", "nl", "printf", "pwd", "readlink", "realpath", "rg", "ripgrep", "sort", "stat", "tail",
	"tree", "uniq", "uname", "wc", "which", "whoami",
]);

const DRAFTING_APPROVED_SCRIPTS = /^(test|lint|typecheck|type-check|check)(:[A-Za-z0-9_.-]+)?$|^format:check$/;

export function isUnsafeDraftingBash(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return true;
	if (/[;&|<>`$()]/.test(trimmed)) return true;
	if (/\\\n/.test(trimmed)) return true;

	const argv = trimmed.split(/\s+/);
	const executable = argv[0] ?? "";
	const name = path.basename(executable);
	if (!DRAFTING_READ_COMMANDS.has(name) && !["npm", "pnpm", "yarn", "bun", "eslint", "tsc"].includes(name)) return true;
	if (name === "git") return isUnsafeDraftingGit(argv.slice(1));
	if (["npm", "pnpm", "yarn", "bun"].includes(name)) return isUnsafeDraftingPackage(name, argv.slice(1));
	if (name === "eslint") return argv.slice(1).includes("--fix");
	if (name === "tsc") return !argv.slice(1).some((arg) => ["--noEmit", "--showConfig", "--version", "--help"].includes(arg));
	if (["find", "sort"].includes(name) && argv.slice(1).some((arg) => ["-delete", "-exec", "-execdir", "-o", "--output", "-o"].includes(arg) || arg.startsWith("--output="))) return true;
	return false;
}

function isUnsafeDraftingGit(args: string[]): boolean {
	const subcommand = args.find((arg) => !arg.startsWith("-"));
	return !["status", "diff", "log", "show", "grep", "ls-files", "ls-tree", "rev-parse", "describe", "blame"].includes(subcommand ?? "");
}

function isUnsafeDraftingPackage(command: string, args: string[]): boolean {
	const subcommand = args[0];
	if (subcommand === "test" || subcommand === "t") return false;
	if (subcommand === "run" || subcommand === "run-script") return !DRAFTING_APPROVED_SCRIPTS.test(args[1] ?? "");
	return !(command === "pnpm" && DRAFTING_APPROVED_SCRIPTS.test(subcommand ?? ""));
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
