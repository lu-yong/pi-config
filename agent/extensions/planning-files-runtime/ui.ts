import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { PlanningSnapshot } from "./types.ts";
import { formatTokenCount } from "./utils.ts";

type PlanningField = [label: string, value: string];
type PlanningTheme = Pick<Theme, "fg">;

/** Persisted values are plain text; only the UI may add terminal styling. */
function plainPlanningText(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/\r\n?/gu, "\n")
		.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, "");
}

/** Project terminal and paused states without changing the snapshot used by prompts. */
function projectPlan(state: PlanningSnapshot) {
	if (state.goalState.status === "complete") {
		return { phase: "Complete", next: "None (goal complete)." };
	}
	if (state.goalState.status === "paused") {
		return {
			phase: state.currentPhase,
			next: state.goalState.impl.pausedSuggestedAction || undefined,
			blocker: state.goalState.impl.pausedReason || state.blocker,
		};
	}
	return { phase: state.currentPhase, next: state.nextAction, blocker: state.blocker };
}

function planningFields(state: PlanningSnapshot): PlanningField[] {
	const { goalState } = state;
	const plan = projectPlan(state);
	const drafting = goalState.status === "drafting";
	const fields: PlanningField[] = [
		["dir", state.planningRoot],
		["planning", state.exists ? "initialized" : "not initialized"],
		["state", goalState.status],
	];
	const objective = drafting ? goalState.draft.objective : goalState.goal?.objective;
	if (objective || state.goalFromPlan) fields.push(["objective", objective || state.goalFromPlan!]);
	if (plan.phase) fields.push(["phase", plan.phase]);
	const next = drafting ? goalState.draft.nextRecommendedQuestion || plan.next : plan.next;
	if (next) fields.push(["next", next]);
	if (plan.blocker) fields.push(["blocker", plan.blocker]);
	if (goalState.status !== "none") {
		const used = goalState.impl.tokensUsed;
		const budget = goalState.goal?.tokenBudget;
		const pct = budget === undefined ? undefined : Math.min(999, Math.floor((used / budget) * 100));
		fields.push(["tokens", budget === undefined ? formatTokenCount(used) : `${formatTokenCount(used)} / ${formatTokenCount(budget)} (${pct}%)`]);
	}
	return fields;
}

/** One physical line per field; width is measured in terminal columns, including labels. */
export function buildWidgetLines(state: PlanningSnapshot, width = Infinity, theme?: PlanningTheme): string[] | undefined {
	if (!state.exists && state.goalState.status === "none") return undefined;
	const accent = (value: string) => theme ? theme.fg("accent", value) : value;
	return [
		accent("Planning goal"),
		...planningFields(state).map(([label, value]) => `${accent(`${label}:`)} ${plainPlanningText(value).replace(/\s+/gu, " ").trim()}`),
	].map((line) => Number.isFinite(width) ? truncateToWidth(line, Math.max(0, width), "...") : line);
}

/** Full values for the inspector, including the goal contract and drafting context. */
export function buildGoalDetailFields(state: PlanningSnapshot): PlanningField[] {
	const fields = planningFields(state);
	const { goalState } = state;
	const contract = goalState.status === "drafting" ? goalState.draft : goalState.goal;
	const add = (label: string, value: string | string[] | undefined) => {
		const text = Array.isArray(value) ? value.map((item) => `• ${item}`).join("\n") : value;
		if (text) fields.push([label, text]);
	};
	add("success criteria", contract?.successCriteria);
	add("constraints", contract?.constraints);
	add("out of scope", contract?.outOfScope);
	add("blocker rule", contract?.blockerRule);
	if (goalState.status === "drafting") {
		add("stage", goalState.draft.draftingStage);
		add("source topic", goalState.draft.sourceTopic);
		add("supplemental inputs", goalState.draft.supplementalInputs);
		add("clarification summary", goalState.draft.clarificationSummary);
		add("open questions", goalState.draft.openQuestions);
	}
	if (goalState.status === "complete") add("completion", goalState.impl.completedSummary);
	return fields.map(([label, value]) => [label, plainPlanningText(value)]);
}

/** Bounded, scrollable inspector. Wrapping is applied before paging so no value is lost. */
export class PlanningGoalDialog implements Component {
	private offset = 0;
	private viewport = 1;
	private totalLines = 0;

	private state: PlanningSnapshot;
	private tui: Pick<TUI, "terminal" | "requestRender">;
	private theme: PlanningTheme;
	private keys: Pick<KeybindingsManager, "matches">;
	private done: () => void;

	constructor(state: PlanningSnapshot, tui: Pick<TUI, "terminal" | "requestRender">, theme: PlanningTheme, keys: Pick<KeybindingsManager, "matches">, done: () => void) {
		this.state = state;
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "tui.select.confirm")) {
			this.done();
			return;
		}
		if (this.keys.matches(data, "tui.select.up")) this.offset--;
		else if (this.keys.matches(data, "tui.select.down")) this.offset++;
		else if (matchesKey(data, Key.pageUp)) this.offset -= this.viewport;
		else if (matchesKey(data, Key.pageDown)) this.offset += this.viewport;
		else if (matchesKey(data, Key.home)) this.offset = 0;
		else if (matchesKey(data, Key.end)) this.offset = this.totalLines;
		else return;
		this.offset = Math.max(0, Math.min(this.offset, this.totalLines - this.viewport));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const body = buildGoalDetailFields(this.state).flatMap(([label, value]) => [
			...wrapTextWithAnsi(`${this.theme.fg("accent", `${label}:`)} ${value}`, innerWidth), "",
		]);
		this.totalLines = body.length;
		const height = Math.max(1, Math.min(32, this.tui.terminal.rows - 2));
		this.viewport = Math.max(1, height - 4);
		this.offset = Math.max(0, Math.min(this.offset, body.length - this.viewport));
		const border = (text: string) => this.theme.fg("border", text);
		const row = (text: string) => border("│ ") + truncateToWidth(text, innerWidth, "...", true) + border(" │");
		const lines = [
			border(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
			row(this.theme.fg("accent", "Planning goal")),
			...body.slice(this.offset, this.offset + this.viewport).map(row),
			row(this.theme.fg("dim", `↑↓ scroll · PgUp/PgDn · Home/End · Esc close  ${this.offset + 1}/${body.length}`)),
			border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
		];
		return lines.slice(0, height).map((line) => truncateToWidth(line, Math.max(0, width), ""));
	}
}
