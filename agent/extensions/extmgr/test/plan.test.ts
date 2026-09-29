import { describe, expect, it } from "vitest";
import { planToggle } from "../toggle.ts";
import type { ExtensionEntry } from "../resolve.ts";

/** IF-5 seam: pure planning fixtures (spec scenario: Project tier requires
 * trust; Unreachable control cells are surfaced). */

function entry(overrides: Partial<ExtensionEntry> = {}): ExtensionEntry {
	return {
		id: "/work/proj/.pi/extensions/helper.ts",
		name: "helper.ts",
		kind: "standalone",
		tier: "project",
		states: { global: "unmanaged", project: "on", effective: "on" },
		...overrides,
	};
}

describe("planToggle guards", () => {
	it("project toggle refused when untrusted", () => {
		const plan = planToggle({
			entry: entry(),
			action: "disable",
			scope: "project",
			trusted: false,
			isSelf: false,
		});

		expect(plan.ok).toBe(false);
		if (!plan.ok) {
			expect(plan.reason).toBe("untrusted-project");
			expect(plan.detail).toMatch(/trust/i);
		}
	});

	it("unreachable cells return reason without mutation", () => {
		const globalStandalone = entry({
			id: "/home/u/.pi/agent/extensions/qna.ts",
			name: "qna.ts",
			tier: "global",
			states: { global: "on", project: "unmanaged", effective: "on" },
		});
		const globallyDisabled = entry({
			id: "/home/u/.pi/agent/extensions/qna.ts",
			name: "qna.ts",
			tier: "global",
			states: { global: "off", project: "unmanaged", effective: "off" },
		});

		// Cell 1: disable a global standalone at the project tier.
		const disableAtProject = planToggle({
			entry: globalStandalone,
			action: "disable",
			scope: "project",
			trusted: true,
			isSelf: false,
		});
		expect(disableAtProject).toMatchObject({ ok: false, reason: "unavailable-native-limitation" });

		// Cell 2: re-enable at the project tier an extension disabled globally.
		const enableAtProject = planToggle({
			entry: globallyDisabled,
			action: "enable",
			scope: "project",
			trusted: true,
			isSelf: false,
		});
		expect(enableAtProject).toMatchObject({ ok: false, reason: "unavailable-native-limitation" });
		expect((enableAtProject as { detail: string }).detail).toMatch(/native Pi settings/i);
	});
});
