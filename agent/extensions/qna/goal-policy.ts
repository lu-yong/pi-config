import { hasActiveGoal } from "../planning-files-runtime/state.ts";

export const ACTIVE_GOAL_QNA_BLOCK_MESSAGE =
	"当前有 active goal，/qna 已禁用，以避免打断目标的自动执行。请先暂停或完成目标后再使用 /qna。";

/** Automatic and manual Q&A must not take control while goal implementation is active. */
export function isQnaSuppressedByActiveGoal(cwd: string): boolean {
	return hasActiveGoal(cwd);
}

export function rejectManualQnaForActiveGoal(
	cwd: string,
	notify: (message: string, level: "warning") => void,
): boolean {
	if (!isQnaSuppressedByActiveGoal(cwd)) return false;
	notify(ACTIVE_GOAL_QNA_BLOCK_MESSAGE, "warning");
	return true;
}
