import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { orderEntries, renderPickerView, type PickerView } from "../picker.ts";
import type { LoadedEntry } from "../index.ts";

/** Render seam: `renderPickerView(view, width)` — the projection is pure
 * data, so every visual fact is pinned through the view alone (spec
 * scenario: Picker shows merged view; ADR-0003 footer visual language). */

const entries: LoadedEntry[] = [
	{
		id: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/extensions/tui.ts",
		name: "tui.ts",
		kind: "package",
		packageSource: "npm:pi-open-tui",
		relPath: "extensions/tui.ts",
		tier: "global",
		states: { global: "off", project: "unmanaged", effective: "off" },
		loaded: false,
	},
	{
		id: "/work/proj/.pi/extensions/helper.ts",
		name: "helper.ts",
		kind: "standalone",
		tier: "project",
		states: { global: "unmanaged", project: "on", effective: "on" },
		loaded: true,
	},
];

function view(rows: LoadedEntry[], overrides: Partial<PickerView> = {}): PickerView {
	return {
		rows: orderEntries(rows),
		cursorIndex: 0,
		tier: "global",
		pendingCount: 0,
		hiddenStandaloneCount: 0,
		filterText: "",
		maxVisible: 10,
		...overrides,
	};
}

describe("renderPickerView", () => {
	it("renders the pi-footer style merged state view", () => {
		const text = renderPickerView(view(entries, { hiddenStandaloneCount: 1 }), 100).join("\n");

		// Framed layout: border box, title row, dim hint, count line.
		expect(text).toContain("╭──");
		expect(text).toContain("•Manage Extensions");
		expect(text).toContain("j/k move");
		expect(text).toContain("2 file(s) in 1 package(s) · +1 standalone hidden");

		// Both fed rows render with tier states and loaded detail.
		expect(text).toContain("tui.ts");
		expect(text).toContain("pi-open-tui/tui.ts");
		expect(text).toContain("helper.ts");
		expect(text).toContain("G:off P:-");
		expect(text).toContain("G:- P:on");

		// The globally disabled package extension shows its states.
		const tuiRow = text.split("\n").find((l) => l.includes("tui.ts"))!;
		expect(tuiRow).toContain("off"); // global off / effective off
		expect(tuiRow).toContain("not loaded");

		// The loaded entry shows the live marker text.
		const helperRow = text.split("\n").find((l) => l.includes("helper.ts"))!;
		expect(helperRow).toContain("loaded");

		// Status line carries the write tier.
		expect(text).toContain("write tier: global");
	});

	it("renders plugin names instead of index.ts entry files", () => {
		const idxEntries: LoadedEntry[] = [
			{
				id: "/home/u/.pi/agent/npm/node_modules/pi-open-tui/extensions/index.ts",
				name: "index.ts",
				kind: "package",
				packageSource: "npm:pi-open-tui",
				relPath: "extensions/index.ts",
				tier: "global",
				states: { global: "on", project: "unmanaged", effective: "on" },
				loaded: true,
			},
			{
				id: "/home/u/.pi/agent/extensions/extmgr/index.ts",
				name: "extmgr/index.ts",
				kind: "standalone",
				tier: "global",
				states: { global: "on", project: "unmanaged", effective: "on" },
				loaded: false,
			},
		];
		const lines = renderPickerView(view(idxEntries), 100);

		// The conventional entry filename never appears.
		expect(lines.join("\n")).not.toContain("index.ts");

		const pkgRow = lines.find((l) => l.includes("› "))!;
		expect(pkgRow).toContain("pi-open-tui");

		// Standalone dir entries collapse to the plugin dir name.
		const extRow = lines.find((l) => l.includes("extmgr"))!;
		expect(extRow).toContain("extmgr");
		expect(lines.join("\n")).not.toContain("extmgr/index.ts");
	});

	it("fits compact rows to narrow terminals and scrolls long lists", () => {
		const many: LoadedEntry[] = Array.from({ length: 12 }, (_, i) => ({
			...entries[1]!,
			id: `/work/proj/.pi/extensions/extension-${String(i).padStart(2, "0")}.ts`,
			name: `extension-${String(i).padStart(2, "0")}-with-a-long-name.ts`,
		}));
		const lines = renderPickerView(view(many, { maxVisible: 4, cursorIndex: 8 }), 48);
		const listRows = lines.filter((line) => line.includes("on") || line.includes("extension-"));
		expect(listRows.every((line) => visibleWidth(line) <= 48)).toBe(true);
		expect(lines.join("\n")).toContain("Showing 7-10 of 12");
		expect(lines.some((line) => line.includes("›") && line.includes("extension-08"))).toBe(true);
		expect(lines.some((line) => line.includes("extension-00"))).toBe(false);
		expect(renderPickerView(view(many, { maxVisible: 4, cursorIndex: 8 }), 18).every((line) => visibleWidth(line) <= 18)).toBe(true);
	});

	it("shows pending, filter, and empty-list facts in the status area", () => {
		const pending = renderPickerView(view(entries, { pendingCount: 2 }), 100).join("\n");
		expect(pending).toContain("2 pending (a apply)");

		const filtered = renderPickerView(view([entries[0]!], { filterText: "tui" }), 100).join("\n");
		expect(filtered).toContain("filter: tui");

		const empty = renderPickerView(view([], { filterText: "zzz" }), 100).join("\n");
		expect(empty).toContain("(no matching extensions)");
	});

	it("orders duplicate package paths consistently", () => {
		const duplicate = { ...entries[0]!, id: `${entries[0]!.id}-copy` };
		expect(orderEntries([duplicate, entries[0]!]).map((entry) => entry.id)).toEqual([
			duplicate.id,
			entries[0]!.id,
		]);
	});
});
