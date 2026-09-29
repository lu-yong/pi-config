/**
 * Locked settings persistence (IF-6): the only module that writes. Executes
 * one `SettingsMutation` against a tier's settings file under an
 * inter-process `proper-lockfile` lock (the same discipline Pi uses), with
 * atomic temp-file + rename replacement. Unrelated entries and unknown keys
 * are preserved by construction (read-modify-write of the parsed document).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { ExtmgrEnv } from "./env.ts";
import type { Scope, SettingsDoc, SettingsMutation } from "./toggle.ts";

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
	return scope === "global" ? join(env.agentDir, "settings.json") : join(env.cwd, ".pi", "settings.json");
}

/** Lock-free tolerant read for snapshots (IF-4 callers). */
export function readSettings(env: ExtmgrEnv, scope: Scope): SettingsDoc {
	const path = settingsPath(env, scope);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SettingsDoc) : {};
	} catch {
		return {};
	}
}

function parseOrThrow(path: string, raw: string | undefined): SettingsDoc {
	if (raw === undefined) return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as SettingsDoc;
		throw new Error("not an object");
	} catch {
		throw new SettingsIoError("malformed-settings", path, `Settings file is not valid JSON: ${path}`);
	}
}

/** Locked read-modify-write with atomic replacement. Returns the written
 * document for caller-side state recomputation. */
export async function mutateSettings(env: ExtmgrEnv, scope: Scope, mutation: SettingsMutation): Promise<SettingsDoc> {
	const path = settingsPath(env, mutation.scope);
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });

	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(path, { realpath: false, retries: { retries: 25, minTimeout: 20, maxTimeout: 100 } });
	} catch (error) {
		throw new SettingsIoError(
			"lock-timeout",
			path,
			`Could not acquire the settings lock for ${path}: ${(error as Error).message}`,
		);
	}

	try {
		let raw: string | undefined;
		try {
			raw = readFileSync(path, "utf-8");
		} catch {
			raw = undefined; // first write to this tier
		}
		const current = parseOrThrow(path, raw);
		const next = mutation.apply(current);

		const tmp = join(dir, `.${basename(path)}.extmgr-${process.pid}-${Date.now()}.tmp`);
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
		renameSync(tmp, path);
		return next;
	} finally {
		await release();
	}
}
