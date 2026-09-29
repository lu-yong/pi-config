/** Shared environment injection: where the two settings tiers live. */
export interface ExtmgrEnv {
	/** Global agent directory (`~/.pi/agent`). */
	agentDir: string;
	/** Current project working directory. */
	cwd: string;
	/** Test seam: overrides the detected extmgr entry file for self checks. */
	selfPath?: string;
}
