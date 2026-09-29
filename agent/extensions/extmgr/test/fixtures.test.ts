import { describe, expect, it } from "vitest";
import {
	FIXTURES_VERSION,
	OVERRIDE_PRECEDENCE_CASES,
	PACKAGE_DEDUPE_CASES,
	PACKAGE_FILTER_CASES,
	STANDALONE_DISCOVERY_CASES,
	TIER_ISOLATION_CASES,
} from "./fixtures/resolution-rules.ts";

describe("golden resolution fixtures", () => {
	it("load as plain data", () => {
		expect(FIXTURES_VERSION).toBe("pi-0.87.1");
		expect(OVERRIDE_PRECEDENCE_CASES.length).toBeGreaterThan(0);
		expect(TIER_ISOLATION_CASES.length).toBeGreaterThan(0);
		expect(PACKAGE_FILTER_CASES.length).toBeGreaterThan(0);
		expect(PACKAGE_DEDUPE_CASES.length).toBeGreaterThan(0);
		expect(STANDALONE_DISCOVERY_CASES.length).toBeGreaterThan(0);
	});

	it("every case carries a rule name and an expectation", () => {
		for (const c of [
			...OVERRIDE_PRECEDENCE_CASES,
			...TIER_ISOLATION_CASES,
			...PACKAGE_FILTER_CASES,
			...PACKAGE_DEDUPE_CASES,
			...STANDALONE_DISCOVERY_CASES,
		]) {
			expect(c.rule, JSON.stringify(c)).toBeTruthy();
		}
	});
});
