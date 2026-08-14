export type PlanArchiveCommandContext = {
	cwd: string;
	isIdle(): boolean;
	notify(message: string, level: "info" | "warning" | "error"): void;
};

export type PlanArchiveCommandDeps = {
	archive(cwd: string): string | null;
	clearContinuation(): void;
	dropLifecycle(cwd: string): void;
	refresh(): void;
};

export function runPlanArchiveCommand(context: PlanArchiveCommandContext, deps: PlanArchiveCommandDeps): void {
	if (!context.isIdle()) {
		context.notify("Planning workspace cannot be archived while the agent is running. Wait for it to settle, then retry /plan-archive.", "warning");
		return;
	}

	let archiveDir: string | null;
	try {
		archiveDir = deps.archive(context.cwd);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		context.notify(`Planning workspace archive failed: ${reason}`, "error");
		return;
	}

	deps.clearContinuation();
	deps.dropLifecycle(context.cwd);
	deps.refresh();
	if (!archiveDir) {
		context.notify("No current planning workspace to archive.", "info");
		return;
	}
	context.notify(`Planning workspace archived to ${archiveDir}.`, "info");
}
