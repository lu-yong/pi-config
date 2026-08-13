import type { AppliedEffects } from "./effects.ts";
import type { GoalOverlay, GoalOverlayEffect } from "./goal-overlay.ts";

export interface AgentSettledRuntime {
	apply(effects: GoalOverlayEffect[]): AppliedEffects;
	notify(result: AppliedEffects): void;
	refresh(): void;
}

/** Keep the planning projection synchronized after the complete agent run settles. */
export function handleAgentSettled(overlay: GoalOverlay, runtime: AgentSettledRuntime): void {
	const result = runtime.apply(overlay.handle({ type: "agent-settled" }));
	runtime.notify(result);
	runtime.refresh();
}
