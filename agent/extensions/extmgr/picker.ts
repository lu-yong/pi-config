/**
 * TUI picker for extension management (modeled on Pi's /model picker).
 *
 * `ExtensionPicker` implements the pi-tui Component shape (`render(width)`
 * returning lines, optional `handleInput`); width math is pi-tui's, so the
 * merged view and interaction model stay testable headlessly. Interaction
 * state lives in the pure `PickerModel`.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { LoadedEntry } from "./index.ts";

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
 * relPath) followed by standalone extensions (sorted by name). The model's
 * visible() and the picker's render both use it so the cursor index maps
 * 1:1 onto rendered rows. */
export function orderEntries(entries: LoadedEntry[]): LoadedEntry[] {
	const packages: LoadedEntry[] = [];
	const standalone: LoadedEntry[] = [];
	for (const e of entries) {
		if (e.kind === "package" && e.packageSource) packages.push(e);
		else standalone.push(e);
	}
	packages.sort((a, b) => {
		const sourceOrder = (a.packageSource ?? "").localeCompare(b.packageSource ?? "");
		return sourceOrder || (a.relPath ?? "").localeCompare(b.relPath ?? "");
	});
	standalone.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return [...packages, ...standalone];
}
/** Fit `s` into exactly `width` terminal cells: truncate with an ellipsis
 * when too long, pad with spaces when short. pi-tui's grapheme-cluster
 * implementation (delegates ANSI-aware width, emoji ZWJ sequences). */
function fit(s: string, width: number): string {
	return truncateToWidth(s, width, "…", true);
}

function stateLabel(value: string, compact: boolean): string {
	if (compact && value === "unmanaged") return "-";
	return value;
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

	render(width: number): string[] {
		const lines: string[] = [];
		const compact = width < 82;
		const ultraCompact = width < 32;
		const widths = ultraCompact
			? { name: Math.max(1, width - 12), global: 3, project: 3, effective: 3, loaded: 3 }
			: compact
				? { name: Math.max(1, width - 21), global: 5, project: 5, effective: 5, loaded: 6 }
				: { name: Math.min(40, width - 39), global: 10, project: 10, effective: 11, loaded: 8 };
		const title = `Extension management — write tier: ${this.tier}${this.pendingCount > 0 ? ` — ${this.pendingCount} pending` : ""}${this.filterHint}`;
		lines.push(fit(title, width));
		const headings = ultraCompact
			? ["E", "G", "P", "E", "L"]
			: compact
				? ["Ext", "G", "P", "Eff", "Load"]
				: ["Extension", "Global", "Project", "Effective", "Loaded"];
		lines.push(
			fit(headings[0]!, widths.name) +
				fit(headings[1]!, widths.global) +
				fit(headings[2]!, widths.project) +
				fit(headings[3]!, widths.effective) +
				fit(headings[4]!, widths.loaded),
		);
		lines.push("─".repeat(Math.max(1, width)));

		const ordered = orderEntries(this.entries);
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), ordered.length - this.maxVisible));
		const end = Math.min(start + this.maxVisible, ordered.length);
		let source: string | undefined;
		for (let i = start; i < end; i++) {
			const e = ordered[i]!;
			const group = e.kind === "package" && e.packageSource ? e.packageSource : "(standalone)";
			if (group !== source) {
				lines.push(fit(group, width));
				source = group;
			}
			lines.push(this.renderRow(e, i === this.selectedIndex, widths, compact, ultraCompact));
		}
		if (start > 0 || end < ordered.length) {
			lines.push(fit(`Showing ${start + 1}-${end} of ${ordered.length}`, width));
		}

		if (ordered.length === 0) lines.push(fit("(no matching extensions)", width));

		lines.push("");
		lines.push(fit("j/k move · Enter toggle · Tab tier · / filter · a apply · q close", width));
		return lines;
	}

	private filterHint = "";

	setFilterHint(text: string): void {
		this.filterHint = text ? ` — filter: ${text}` : "";
	}

	private renderRow(
		e: LoadedEntry,
		selected: boolean,
		widths: { name: number; global: number; project: number; effective: number; loaded: number },
		compact: boolean,
		ultraCompact: boolean,
	): string {
		const name = `${selected ? "▶ " : "  "}${displayName(e)}`;
		return (
			fit(name, widths.name) +
			fit(stateLabel(e.states.global, compact), widths.global) +
			fit(stateLabel(e.states.project, compact), widths.project) +
			fit(stateLabel(e.states.effective, compact), widths.effective) +
			fit(ultraCompact ? (e.loaded ? "●" : "-") : e.loaded ? "● yes" : "·", widths.loaded)
		);
	}
}
