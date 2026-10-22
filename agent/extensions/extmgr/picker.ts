/**
 * TUI picker for extension management (visual language modeled on
 * pi-footer's config UI: rounded border frame, `•Title` + dim subtitle,
 * dim keymap hint, colored on/off markers with dim detail tails, and a
 * selected row picked out with the theme's selection colors).
 *
 * `ExtensionPicker` implements the pi-tui Component shape (`render(width)`
 * returning lines, optional `handleInput`); width math is pi-tui's, so the
 * merged view and interaction model stay testable headlessly. Interaction
 * state lives in the pure `PickerModel`.
 *
 * Sessions feed the picker package extensions only; standalone extensions
 * are out of extmgr's scope and surface solely as the dim
 * `+N standalone hidden` count line.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { LoadedEntry } from "./index.ts";

/**
 * Color seam for the picker. The runtime `Theme` satisfies this
 * structurally; the identity default keeps headless renders plain text.
 */
export interface PickerTheme {
	fg(color: "accent" | "border" | "dim" | "success" | "warning", text: string): string;
	bg(color: "selectedBg", text: string): string;
	bold(text: string): string;
}

const identityTheme: PickerTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

/** Pure interaction model behind the picker: filter text, write tier,
 * pending list. All state changes are plain data operations. */
export class PickerModel {
	private all: LoadedEntry[];
	private filterText = "";

	constructor(options: PickerOptions) {
		this.all = [...options.entries];
		this.applyToggle = options.applyToggle;
		this.onReload = options.onReload;
		this.tier = options.tier ?? "global";
	}

	setEntries(entries: LoadedEntry[]): void {
		const selectedId = this.selected()?.id;
		this.all = [...entries];
		const nextIndex = selectedId ? this.visible().findIndex((entry) => entry.id === selectedId) : -1;
		this.selectedIndex = nextIndex >= 0 ? nextIndex : 0;
	}

	private applyToggle?: PickerOptions["applyToggle"];
	private onReload?: () => void;
	private selectedIndex = 0;
	private pending: Array<{ id: string; action: string; tier: string }> = [];

	selectIndex(i: number): void {
		this.selectedIndex = i;
	}

	selected(): LoadedEntry | undefined {
		return this.visible()[this.selectedIndex];
	}

	/** Enter: toggle the selected entry at the active tier only. */
	async enter(opts?: { selfConfirmed?: boolean }): Promise<{ ok: true; action: "enable" | "disable" } | { ok: false; reason: string; detail?: string }> {
		const entry = this.selected();
		if (!entry) {
			return { ok: false, reason: "target-not-found", detail: "nothing selected" };
		}
		const state = this.tier === "global" ? entry.states.global : entry.states.project;
		if (state === "unmanaged") {
			return {
				ok: false,
				reason: "unavailable-native-limitation",
				detail: `${entry.name} is not managed at the ${this.tier} tier; toggle it at its owning tier instead.`,
			};
		}
		const action = state === "on" ? "disable" : "enable";
		if (!this.applyToggle) {
			return { ok: false, reason: "unavailable-native-limitation", detail: "no applyToggle wired" };
		}
		const res = await this.applyToggle(entry, action, this.tier, opts);
		if (!res.ok) return res;
		this.pending.push({ id: entry.id, action, tier: this.tier });
		return { ok: true, action };
	}

	getPending(): Array<{ id: string; action: string; tier: string }> {
		return [...this.pending];
	}

	/** Apply: request exactly one reload, clear pending, return immediately. */
	applyPending(): void {
		this.pending = [];
		this.onReload?.();
	}
	private tier: "global" | "project" = "global";

	getTier(): "global" | "project" {
		return this.tier;
	}

	/** Tab: cycle the active write tier global → project → global. */
	switchTier(): void {
		this.tier = this.tier === "global" ? "project" : "global";
	}

	setFilter(text: string): void {
		this.filterText = text;
	}

	getFilter(): string {
		return this.filterText;
	}

	/** Substring filter over names and sources, in rendered row order. */
	visible(): LoadedEntry[] {
		const f = this.filterText.toLowerCase();
		const filtered = f
			? this.all.filter(
					(e) => e.name.toLowerCase().includes(f) || e.packageSource?.toLowerCase().includes(f),
				)
			: [...this.all];
		return orderEntries(filtered);
	}
}
export interface PickerOptions {
	entries: LoadedEntry[];
	/** Active write tier shown in the status line (default global). */
	tier?: "global" | "project";
	/** Persist a toggle at a tier (wired to planToggle + mutateSettings). */
	applyToggle?: (
		entry: LoadedEntry,
		action: "enable" | "disable",
		tier: "global" | "project",
		opts?: { selfConfirmed?: boolean },
	) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
	onReload?: () => void;
}

/** Canonical grouped order: package extensions (sorted by source, then
 * relPath) followed by any remaining entries (sorted by name). The model's
 * visible() and the picker's render both use it so the cursor index maps
 * 1:1 onto rendered rows. Sessions pass packages-only lists; standalone
 * entries only reach this seam through direct unit tests. */
export function orderEntries(entries: LoadedEntry[]): LoadedEntry[] {
	const packages: LoadedEntry[] = [];
	const rest: LoadedEntry[] = [];
	for (const e of entries) {
		if (e.kind === "package" && e.packageSource) packages.push(e);
		else rest.push(e);
	}
	packages.sort((a, b) => {
		const sourceOrder = (a.packageSource ?? "").localeCompare(b.packageSource ?? "");
		if (sourceOrder !== 0) return sourceOrder;
		// The conventional index entry leads its package; then relPath order.
		const isIndex = (e: LoadedEntry) => (e.name === "index.ts" || e.name === "index.js" ? 0 : 1);
		const indexOrder = isIndex(a) - isIndex(b);
		return indexOrder || (a.relPath ?? "").localeCompare(b.relPath ?? "");
	});
	rest.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return [...packages, ...rest];
}

/** Row display name: the plugin's own name instead of the conventional
 * `index.ts`/`index.js` entry filename, so the cursor arrow points straight
 * at the plugin name. Package index entries show the package name (`npm:`
 * prefix stripped); standalone `dir/index.ts` entries show `dir`. Other
 * filenames are already informative and stay as-is. */
export function displayName(e: LoadedEntry): string {
	if (e.kind === "package" && e.packageSource) {
		return e.name === "index.ts" || e.name === "index.js"
			? e.packageSource.replace(/^npm:/, "")
			: e.name;
	}
	// Standalone: name is the path under extensions/ (or fall back to it via
	// the canonical id), so `dir/index.ts` collapses to the plugin dir name.
	const rel = e.id.match(/\/extensions\/(.+)$/)?.[1] ?? e.name;
	return rel.replace(/\/index\.(ts|js)$/, "") || e.name;
}

export class ExtensionPicker {
	private entries: LoadedEntry[];
	private tier: "global" | "project";
	private pendingCount = 0;
	private selectedIndex = 0;
	private maxVisible = 10;
	private theme: PickerTheme = identityTheme;
	private hiddenStandalone = 0;
	private filterText = "";

	setSelectedIndex(i: number): void {
		this.selectedIndex = i;
	}

	setMaxVisible(count: number): void {
		this.maxVisible = Math.max(1, count);
	}

	constructor(options: PickerOptions) {
		this.entries = [...options.entries];
		this.tier = options.tier ?? "global";
	}

	setEntries(entries: LoadedEntry[]): void {
		this.entries = [...entries];
	}

	setTier(tier: "global" | "project"): void {
		this.tier = tier;
	}

	setPendingCount(count: number): void {
		this.pendingCount = count;
	}

	/** Color the render (identity default keeps headless tests plain). */
	setTheme(theme: PickerTheme): void {
		this.theme = theme;
	}

	/** Standalone entries are never listed; show only their count. */
	setHiddenStandaloneCount(count: number): void {
		this.hiddenStandalone = count;
	}

	/** Filter text shown in the status line (empty string clears it). */
	setFilter(text: string): void {
		this.filterText = text;
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(1, width - 2);
		// One framed line: borders outside, content truncated/padded to inner.
		const line = (content: string) =>
			t.fg("border", "│") + truncateToWidth(content, inner, "…", true) + t.fg("border", "│");

		const title = " Extensions ";
		const top =
			t.fg("border", "╭──") +
			t.fg("accent", t.bold(title)) +
			t.fg("border", "─".repeat(Math.max(1, inner - 2 - title.length))) +
			t.fg("border", "╮");

		const lines = [top];
		lines.push(line(t.fg("success", "•Manage Extensions") + " " + t.fg("dim", "toggle loading per write tier")));
		lines.push(line(t.fg("dim", "j/k move · enter toggle · tab tier · / filter · a apply · q close")));

		const ordered = orderEntries(this.entries);
		const packageCount = new Set(ordered.filter((e) => e.kind === "package" && e.packageSource).map((e) => e.packageSource)).size;
		const counts = `${ordered.length} file(s) in ${packageCount} package(s)` +
			(this.hiddenStandalone > 0 ? ` · +${this.hiddenStandalone} standalone hidden` : "");
		lines.push(line(t.fg("dim", counts)));
		lines.push(line(""));

		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), ordered.length - this.maxVisible));
		const end = Math.min(start + this.maxVisible, ordered.length);
		for (let i = start; i < end; i++) {
			lines.push(line(this.renderRow(ordered[i]!, i === this.selectedIndex)));
		}
		if (start > 0 || end < ordered.length) {
			lines.push(line(t.fg("dim", `Showing ${start + 1}-${end} of ${ordered.length}`)));
		}
		if (ordered.length === 0) lines.push(line(t.fg("dim", "(no matching extensions)")));
		lines.push(line(""));

		let status = t.fg("dim", `write tier: ${this.tier}`);
		if (this.pendingCount > 0) status += t.fg("warning", ` · ${this.pendingCount} pending (a apply)`);
		if (this.filterText) status += t.fg("dim", ` · filter: ${this.filterText}`);
		lines.push(line(status));

		lines.push(t.fg("border", `╰${"─".repeat(inner)}╯`));
		return lines;
	}

	private renderRow(e: LoadedEntry, selected: boolean): string {
		const t = this.theme;
		// Marker: the active write tier's state — the thing Enter will change.
		const state = this.tier === "global" ? e.states.global : e.states.project;
		const marker =
			state === "on" ? t.fg("success", "on ") : state === "off" ? t.fg("dim", "off") : t.fg("dim", "-");
		const tier = (v: string) => (v === "unmanaged" ? "-" : v);
		// Multi-file package rows carry pkg/file in the name; index rows show
		// the package name. The dim tail then only needs states + live marker.
		const source = e.kind === "package" && e.packageSource ? e.packageSource.replace(/^npm:/, "") : undefined;
		const name =
			source && e.name !== "index.ts" && e.name !== "index.js" ? `${source}/${e.name}` : displayName(e);
		const parts = [
			`G:${tier(e.states.global)} P:${tier(e.states.project)}`,
			e.loaded ? "loaded" : "not loaded",
		];
		const text = `${marker} ${name} ${t.fg("dim", parts.join(" · "))}`;
		return selected ? t.bg("selectedBg", t.fg("accent", `› ${text}`)) : `  ${text}`;
	}
}
