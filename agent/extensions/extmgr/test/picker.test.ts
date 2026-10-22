import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ExtensionPicker, orderEntries, PickerModel } from "../picker.ts";
import type { LoadedEntry } from "../index.ts";

/** Picker seam: component render(width) + pure model behind it
 * (spec scenario: Picker shows merged view). */

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

describe("ExtensionPicker", () => {
	it("renders the pi-footer style merged state view", () => {
		const picker = new ExtensionPicker({ entries });
		picker.setHiddenStandaloneCount(1);
		const text = picker.render(100).join("\n");

		// Framed layout: border box, title row, dim hint, count line.
		expect(text).toContain("╭──");
		expect(text).toContain("•Manage Extensions");
		expect(text).toContain("j/k move");
		expect(text).toContain("2 file(s) in 1 package(s) · +1 standalone hidden");

		// Both fed entries render with tier states and loaded detail.
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
		const picker = new ExtensionPicker({ entries: idxEntries });
		picker.setSelectedIndex(0);
		const lines = picker.render(100);

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
		const picker = new ExtensionPicker({ entries: Array.from({ length: 12 }, (_, i) => ({
			...entries[1]!,
			id: `/work/proj/.pi/extensions/extension-${String(i).padStart(2, "0")}.ts`,
			name: `extension-${String(i).padStart(2, "0")}-with-a-long-name.ts`,
		})) });
		picker.setMaxVisible(4);
		picker.setSelectedIndex(8);

		const lines = picker.render(48);
		const listRows = lines.filter((line) => line.includes("on") || line.includes("extension-"));
		expect(listRows.every((line) => visibleWidth(line) <= 48)).toBe(true);
		expect(lines.join("\n")).toContain("Showing 7-10 of 12");
		expect(lines.some((line) => line.includes("›") && line.includes("extension-08"))).toBe(true);
		expect(lines.some((line) => line.includes("extension-00"))).toBe(false);
		expect(picker.render(18).every((line) => visibleWidth(line) <= 18)).toBe(true);
	});

	it("orders duplicate package paths consistently", () => {
		const duplicate = { ...entries[0]!, id: `${entries[0]!.id}-copy` };
		expect(orderEntries([duplicate, entries[0]!]).map((entry) => entry.id)).toEqual([
			duplicate.id,
			entries[0]!.id,
		]);
	});


	describe("PickerModel filter", () => {
		const filterEntries: LoadedEntry[] = [
			{
				id: "/a/extensions/pi-hashline-edit-pro.ts",
				name: "pi-hashline-edit-pro.ts",
				kind: "standalone",
				tier: "global",
				states: { global: "on", project: "unmanaged", effective: "on" },
				loaded: true,
			},
			{
				id: "/b/extensions/other.ts",
				name: "other.ts",
				kind: "package",
				packageSource: "npm:pi-open-tui",
				relPath: "extensions/other.ts",
				tier: "global",
				states: { global: "on", project: "unmanaged", effective: "on" },
				loaded: false,
			},
		];

		it("filter narrows and restores", () => {
			const model = new PickerModel({ entries: filterEntries });
			expect(model.visible()).toHaveLength(2);

			// Substring over names and package sources.
			model.setFilter("hashline");
			expect(model.visible().map((e) => e.name)).toEqual(["pi-hashline-edit-pro.ts"]);
			model.setFilter("open-tui");
			expect(model.visible().map((e) => e.name)).toEqual(["other.ts"]);

			// Clearing the filter restores the full list.
			model.setFilter("");
			expect(model.visible()).toHaveLength(2);
		});

		it("preserves the selected extension when entries refresh", () => {
			const model = new PickerModel({ entries: filterEntries });
			const selectedId = filterEntries[0]!.id;
			model.selectIndex(model.visible().findIndex((entry) => entry.id === selectedId));

			model.setEntries(filterEntries.map((entry) => ({
				...entry,
				states: { ...entry.states, effective: "off" },
			})));

			expect(model.selected()?.id).toBe(selectedId);
		});

		it("tab cycles tier", () => {
			const model = new PickerModel({ entries: filterEntries });
			expect(model.getTier()).toBe("global");

			model.switchTier(); // first Tab: project, indicator follows
			expect(model.getTier()).toBe("project");

			model.switchTier(); // second Tab: back to global
			expect(model.getTier()).toBe("global");
		});

		describe("PickerModel enter", () => {
			it("enter toggles only at active tier", async () => {
				const applied: Array<{ id: string; action: string; tier: string }> = [];
				const model = new PickerModel({
					entries,
					applyToggle: async (entry, action, tier) => {
						applied.push({ id: entry.id, action, tier });
						return { ok: true } as const;
					},
				});

				// Cursor on tui.ts: global off → enable at the active global tier.
				const tuiIndex = model.visible().findIndex((e) => e.name === "tui.ts");
				model.selectIndex(tuiIndex);
				let res = await model.enter();
				expect(res.ok).toBe(true);
				expect(applied).toEqual([{ id: entries[0]!.id, action: "enable", tier: "global" }]);

				// helper.ts is unmanaged at the global tier → unavailable, no write.
				const helperIndex = model.visible().findIndex((e) => e.name === "helper.ts");
				model.selectIndex(helperIndex);
				res = await model.enter();
				expect(res.ok).toBe(false);
				expect(res.reason).toBe("unavailable-native-limitation");
				expect(applied).toHaveLength(1);

				// Tab to project tier: helper.ts project on → disable at project only.
				model.switchTier();
				res = await model.enter();
				expect(res.ok).toBe(true);
				expect(applied[1]).toEqual({ id: entries[1]!.id, action: "disable", tier: "project" });

				// tui.ts is unmanaged at the project tier → refuses there too.
				model.selectIndex(model.visible().findIndex((e) => e.name === "tui.ts"));
				res = await model.enter();
				expect(res.ok).toBe(false);
				expect(applied).toHaveLength(2);
			});

		it("pending accumulates without reload", async () => {
			const applied: Array<{ id: string; action: string; tier: string }> = [];
			const onReload = vi.fn();
			const model = new PickerModel({
				entries,
				onReload,
				applyToggle: async (entry, action, tier) => {
					applied.push({ id: entry.id, action, tier });
					return { ok: true } as const;
				},
			});

			// Two toggles at different tiers accumulate as pending.
			model.selectIndex(model.visible().findIndex((e) => e.name === "tui.ts"));
			expect((await model.enter()).ok).toBe(true);
			model.switchTier();
			model.selectIndex(model.visible().findIndex((e) => e.name === "helper.ts"));
			expect((await model.enter()).ok).toBe(true);

			expect(applied).toHaveLength(2);
			expect(model.getPending()).toEqual([
				{ id: entries[0]!.id, action: "enable", tier: "global" },
				{ id: entries[1]!.id, action: "disable", tier: "project" },
			]);

			// Counter is shown; entering never triggers a reload (Apply does).
			const picker = new ExtensionPicker({ entries });
			picker.setPendingCount(model.getPending().length);
			expect(picker.render(100).join("\n")).toContain("2 pending");
			expect(onReload).not.toHaveBeenCalled();
		});
		});
	});
});
