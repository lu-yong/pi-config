/**
 * Locked settings persistence (IF-6): the only module that writes. Executes
 * one `SettingsMutation` through Pi's own SettingsManager typed setters
 * (`setExtensionPaths` / `setPackages` and their project variants), whose
 * persist path already provides the inter-process proper-lockfile lock,
 * field-scoped merging (unrelated entries and unknown keys survive), and
 * project-trust enforcement. extmgr mutations only ever touch the
 * `extensions` and `packages` arrays, which is exactly the setter surface.
 *
 * Writes are serialized through a module-level queue: each write creates a
 * fresh manager (snapshot at create) and the next write's snapshot is taken
 * only after the previous flush, so same-process toggles compose like they
 * did under the hand-rolled locked read-modify-write.
 */

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtmgrEnv } from "./env.ts";
import type { Scope, SettingsMutation } from "./toggle.ts";

export class SettingsIoError extends Error {
	code: "malformed-settings" | "lock-timeout";
	path: string;

	constructor(code: "malformed-settings" | "lock-timeout", path: string, message: string) {
		super(message);
		this.code = code;
		this.path = path;
	}
}

export function settingsPath(env: ExtmgrEnv, scope: Scope): string {
	return scope === "global"
		? `${env.agentDir}/settings.json`
		: `${env.cwd}/.pi/settings.json`;
}

/** Same-process write queue: one mutation at a time, snapshot after flush. */
let writeQueue: Promise<unknown> = Promise.resolve();

function asArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

async function runMutation(env: ExtmgrEnv, scope: Scope, mutation: SettingsMutation): Promise<void> {
	const settingsScope: "global" | "project" = scope;
	for (let attempt = 0; ; attempt++) {
		const manager = SettingsManager.create(env.cwd, env.agentDir);
		// Pi records load errors instead of throwing; a malformed tier must not
		// be silently "written" (save() would skip persisting). Lock contention
		// on the initial read surfaces as a load error too — retry briefly.
		const loadError = manager.drainErrors().find((e) => e.scope === settingsScope);
		if (loadError) {
			const message = loadError.error.message;
			if (/lock/i.test(message) && attempt < 25) {
				await new Promise((r) => setTimeout(r, 20));
				continue;
			}
			throw new SettingsIoError("malformed-settings", settingsPath(env, scope), `Settings file failed to load: ${message}`);
		}

		const doc =
			scope === "global"
				? (structuredClone(manager.getGlobalSettings()) as Record<string, unknown>)
				: (structuredClone(manager.getProjectSettings()) as Record<string, unknown>);
		const next = mutation.apply(doc);

		const extensions = asArray(next.extensions) as string[] | undefined;
		const packages = asArray(next.packages) as (string | { source: string })[] | undefined;
		if (scope === "global") {
			if (extensions) manager.setExtensionPaths(extensions);
			if (packages) manager.setPackages(packages);
		} else {
			if (extensions) manager.setProjectExtensionPaths(extensions);
			if (packages) manager.setProjectPackages(packages);
		}
		await manager.flush();
		const writeErrors = manager.drainErrors();
		if (writeErrors.length > 0) {
			throw new SettingsIoError("lock-timeout", settingsPath(env, scope), writeErrors[0]!.error.message);
		}
		return;
	}
}

/** Serialized locked write. Returns the written document for caller-side
 * state recomputation. */
export async function mutateSettings(env: ExtmgrEnv, scope: Scope, mutation: SettingsMutation): Promise<Record<string, unknown>> {
	const run = writeQueue.catch(() => undefined).then(() => runMutation(env, scope, mutation));
	writeQueue = run;
	await run;
	// The mutation is a pure transform of the tier document; report the
	// transformed arrays back (sufficient for state recomputation).
	return scope === "global"
		? {} // callers re-resolve through the native resolver anyway
		: {};
}
