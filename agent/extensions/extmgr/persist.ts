/**
 * Shared toggle persistence for the `manage_extensions` tool and the picker
 * session: plan (toggle.ts) + locked write (settings-io.ts), with the
 * independent blockers (native limitation, missing project trust) combined
 * into one result both callers surface unchanged. Never re-derived at the
 * call sites.
 */

import { fileURLToPath } from "node:url";
import type { ExtmgrEnv } from "./env.ts";
import type { ExtensionEntry } from "./resolve.ts";
import { mutateSettings } from "./settings-io.ts";
import { planToggle } from "./toggle.ts";

/** Canonical path of extmgr's own entry file (self-detection). */
const selfEntryPath = fileURLToPath(new URL("./index.ts", import.meta.url));

export type ToggleAction = "enable" | "disable";
export type ToggleTier = "global" | "project";

export type PersistToggleResult =
	| { ok: true }
	| { ok: false; detail: string; reason: "unavailable-native-limitation" | "self-disable-unconfirmed" };

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
		trusted: true,
		isSelf: targetEntry.id === (env.selfPath ?? selfEntryPath),
		selfConfirmed: opts?.selfConfirmed,
		level: isPackage ? "package" : "file",
		packageFiles: pkgFiles,
		env,
	});
	const trustBlocked = scope === "project" && !trusted;
	if (!plan.ok || trustBlocked) {
		const reasons: string[] = [];
		if (!plan.ok) reasons.push(`${plan.reason}: ${plan.detail}`);
		if (trustBlocked) {
			reasons.push(
				"untrusted-project: This project is not trusted; grant project trust before writing project-tier settings.",
			);
		}
		return {
			ok: false,
			detail: reasons.join(" | "),
			reason: !plan.ok && plan.reason === "self-disable-unconfirmed" ? "self-disable-unconfirmed" : "unavailable-native-limitation",
		};
	}
	await mutateSettings(env, scope, plan.mutation);
	return { ok: true };
}
