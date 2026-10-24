/**
 * Shared toggle persistence for the `manage_extensions` tool and the picker
 * session: plan (toggle.ts, whose guards include the project-trust check) +
 * locked write (settings-io.ts), with the plan's result surfaced unchanged
 * by both callers. Never re-derived at the call sites.
 */

import { fileURLToPath } from "node:url";
import type { ExtmgrEnv } from "./env.ts";
import type { ExtensionEntry } from "./resolve.ts";
import { mutateSettings } from "./settings-io.ts";
import { planToggle, type PlanReason } from "./toggle.ts";

/** Canonical path of extmgr's own entry file (self-detection). */
const selfEntryPath = fileURLToPath(new URL("./index.ts", import.meta.url));

export type ToggleAction = "enable" | "disable";
export type ToggleTier = "global" | "project";

export type PersistToggleResult =
	| { ok: true }
	| { ok: false; detail: string; reason: PlanReason };

export async function persistToggle(
	env: ExtmgrEnv,
	entries: ExtensionEntry[],
	targetEntry: ExtensionEntry,
	action: ToggleAction,
	scope: ToggleTier,
	trusted: boolean,
	opts?: { selfConfirmed?: boolean },
): Promise<PersistToggleResult> {
	const isPackage = targetEntry.kind === "package" && targetEntry.packageSource;
	const pkgFiles = isPackage
		? entries
				.filter((e) => e.packageSource === targetEntry.packageSource)
				.map((e) => e.relPath!)
				.filter((p): p is string => Boolean(p))
		: [];
	const plan = planToggle({
		entry: targetEntry,
		action,
		scope,
		trusted,
		isSelf: targetEntry.id === (env.selfPath ?? selfEntryPath),
		selfConfirmed: opts?.selfConfirmed,
		level: isPackage ? "package" : "file",
		packageFiles: pkgFiles,
		env,
	});
	if (!plan.ok) {
		return { ok: false, detail: plan.detail, reason: plan.reason };
	}
	await mutateSettings(env, scope, plan.mutation);
	return { ok: true };
}
