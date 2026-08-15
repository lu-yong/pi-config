export type PlanNewCommandContext = {
	cwd: string;
	isIdle(): boolean;
	notify(message: string, level: "info" | "warning" | "error"): void;
};

export type PlanNewCommandDeps = {
	archive(cwd: string): string | null;
	initialize(cwd: string): void;
	/** Applies the lifecycle reset. Returns true when the reset was accepted. */
	reset(): boolean;
};

export function runPlanNewCommand(context: PlanNewCommandContext, deps: PlanNewCommandDeps): void {
	if (!context.isIdle()) {
		context.notify("Planning workspace cannot be reset while the agent is running. Wait for it to settle, then retry /plan-new.", "warning");
		return;
	}

	try {
		deps.archive(context.cwd);
	} catch (error) {
		context.notify(`Planning workspace archive failed: ${reasonOf(error)}`, "warning");
		return;
	}

	try {
		deps.initialize(context.cwd);
	} catch (error) {
		context.notify(`Planning workspace initialization failed: ${reasonOf(error)}`, "warning");
		return;
	}

	if (!deps.reset()) return;
	context.notify("Planning workspace reset. Goal overlay cleared.", "info");
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
