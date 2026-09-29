import { describe, expect, it } from "vitest";
import { annotateLoaded } from "../index.ts";
import type { ExtensionEntry } from "../resolve.ts";

/** IF seam: index.ts live-annotation merge helper. SourceInfo data is a
 * stubbed system boundary (comes from pi.getCommands()/getAllTools()). */

function entry(id: string): ExtensionEntry {
	return {
		id,
		name: id.slice(id.lastIndexOf("/") + 1),
		kind: "standalone",
		tier: "global",
		states: { global: "on", project: "unmanaged", effective: "on" },
	};
}

describe("annotateLoaded", () => {
	it("command-registering extension is marked loaded", () => {
		const entries = [entry("/home/u/.pi/agent/extensions/qna.ts"), entry("/home/u/.pi/agent/extensions/other.ts")];
		const sources = [
			// One command and one tool both registered by qna.ts; other.ts has nothing live.
			{ path: "/home/u/.pi/agent/extensions/qna.ts", source: "auto", scope: "user", origin: "top-level" },
			{ path: "/home/u/.pi/agent/extensions/qna.ts", source: "auto", scope: "user", origin: "top-level" },
		];

		const annotated = annotateLoaded(entries, sources);

		expect(annotated.find((e) => e.id.endsWith("qna.ts"))?.loaded).toBe(true);
		expect(annotated.find((e) => e.id.endsWith("other.ts"))?.loaded).toBe(false);
		// Pure merge: input entries are not mutated.
		expect(entries[0]).not.toHaveProperty("loaded");
	});
});
