// ---- constants ----

export const WIDGET_KEY = "planning-files-runtime";
export const MESSAGE_TYPE_GOAL_SET = "planning-files-runtime-goal-set";
export const MESSAGE_TYPE_GOAL_IMPL = "planning-files-runtime-goal-impl";
export const MESSAGE_TYPE_CONTINUATION = "planning-files-runtime-goal-continuation";
export const MESSAGE_TYPE_PLAN_UPDATE = "planning-files-runtime-update-context";
export const PLANNING_DIR = ".pi/planning";
export const GOAL_STATE_FILE = ".goal-state.json";
export const GOAL_DESIGN_FILE = "goal-design.md";
export const PLANNING_FILES = ["task_plan.md", "findings.md", "progress.md"] as const;
export const PLANNING_FILE_NAMES = [...PLANNING_FILES, GOAL_DESIGN_FILE] as const;
export const GOAL_TOOL_NAMES = [
	"save_plan_goal_draft",
	"commit_plan_goal",
	"pause_plan_goal",
	"complete_plan_goal",
] as const;
/** Fraction of the token budget at which the next continuation prompt carries a warning line. */
export const BUDGET_WARN_THRESHOLD = 0.7;
/** Fraction of the token budget at which the next continuation prompt demands wrap-up. */
export const BUDGET_CRITICAL_THRESHOLD = 0.9;
/** Non-mutating tools that still count as progress for an active goal run; every file-mutation tool counts too. */
export const PROGRESS_QUERY_TOOLS: ReadonlySet<string> = new Set(["bash", "grep", "find"]);
/** pi-subagent-manager tool names all start with this prefix; their result details carry cumulative ThreadView totals. */
export const SUBAGENT_TOOL_PREFIX = "agent_";
/**
 * Spawning always creates a fresh thread whose token counters start at zero
 * (the manager refuses an existing path), so a spawn observation is counted in
 * full and resets that path's watermark — also after `/agents reap` retires a
 * completed thread and the same path is spawned again.
 */
export const SUBAGENT_SPAWN_TOOL = "agent_spawn";

// ---- types ----

export type DraftingStage = "as-is" | "design" | "story" | "task";
export type PlanningFileName = (typeof PLANNING_FILES)[number];
export type GoalOverlayStatus = "none" | "drafting" | "ready" | "active" | "paused" | "complete";

export type GoalDraft = {
	sourceTopic: string;
	supplementalInputs: string[];
	clarificationSummary: string[];
	objective: string;
	successCriteria: string[];
	constraints: string[];
	outOfScope: string[];
	blockerRule: string;
	openQuestions: string[];
	nextRecommendedQuestion: string;
	draftingStage: DraftingStage;
};

export type GoalContract = {
	objective: string;
	successCriteria: string[];
	constraints: string[];
	outOfScope: string[];
	blockerRule: string;
	/** Optional token spend cap for the goal; set at commit only when the user asks for one. */
	tokenBudget?: number;
};

export type GoalCompletion = {
	summary: string;
	evidence: string[];
	runId: number;
};

export type GoalImplState = {
	runId: number;
	/** Cumulative tokens for this goal, including drafting and every implementation resume. Reset with the planning workspace. */
	tokensUsed: number;
	planningResetRequired: boolean;
	initializedAt: string | null;
	lastResumedAt: string | null;
	pausedReason: string;
	pausedSuggestedAction: string;
	completedSummary: string;
};

export type GoalOverlayState = {
	version: 1;
	status: GoalOverlayStatus;
	updatedAt: string;
	draft: GoalDraft;
	goal: GoalContract | null;
	impl: GoalImplState;
};

/** What the Planning workspace reads off disk: where the files live and the task_plan.md section values. */
export type PlanningSections = {
	planningRoot: string;
	files: Record<PlanningFileName, string>;
	exists: boolean;
	currentPhase?: string;
	goalFromPlan?: string;
	nextAction?: string;
	blocker?: string;
};

/**
 * Read-only projection of one planning workspace: its sections joined with
 * the goal state. Only the Goal lifecycle produces one, so every consumer
 * (widget, inspector, prompts) sees the goal the lifecycle is deciding on.
 */
export type PlanningSnapshot = PlanningSections & { goalState: GoalOverlayState };

export type PathBundle = {
	root: string;
	archiveRoot: string;
	goalState: string;
	goalDesign: string;
	tasksDir: string;
	files: Record<PlanningFileName, string>;
};

export type SaveGoalDraftParams = {
	sourceTopic?: string;
	clarificationSummary?: string[];
	objective?: string;
	successCriteria?: string[];
	constraints?: string[];
	outOfScope?: string[];
	blockerRule?: string;
	openQuestions?: string[];
	nextRecommendedQuestion?: string;
	draftingStage?: DraftingStage;
};

export type CommitGoalParams = GoalContract;

export type PauseGoalParams = {
	reason: string;
	suggestedAction?: string;
};

export type CompleteGoalParams = {
	summary: string;
	evidence?: string[];
};


