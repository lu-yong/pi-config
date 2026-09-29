import { describe, expect, it } from "vitest";
import extmgr from "../index.ts";

describe("smoke", () => {
	it("factory loads the extension against a minimal pi shape", () => {
		expect(typeof extmgr).toBe("function");
		expect(() => extmgr({ registerTool: () => {}, registerCommand: () => {} } as never)).not.toThrow();
	});
});
