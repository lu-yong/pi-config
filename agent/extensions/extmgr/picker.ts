/**
 * Pure picker rendering (visual language per ADR-0003: pi-footer's
 * widget-list — rounded border frame, `•Title` + dim subtitle, dim keymap
 * hint, colored on/off markers with dim detail tails, selected row picked
 * out with the theme's selection colors). Rendering is a pure function of a
 * `PickerView` snapshot; all interaction state, its projection onto rows,
 * and the cursor live in picker-session.ts, which builds the view.
 *
 * Sessions feed package extensions only; standalone extensions are out of
 * extmgr's scope (ADR-0002) and surface solely as the dim
 * `+N standalone hidden` count line.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { LoadedEntry } from "./snapshot.ts";

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

/** Canonical grouped order: package extensions (sorted by source, then
 * relPath) followed by any remaining entries (sorted by name). Sessions
 * pass packages-only lists; standalone entries only reach this seam through
 * direct view tests. */
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

/** The complete projection the session renders: ordered+filtered rows, the
 * cursor position within them, and the status facts. Pure data — the
 * session recomputes it on every render, so there is nothing to keep in
 * sync. */
export interface PickerView {
	rows: LoadedEntry[];
	/** Index into `rows`; clamped to the list at render time. */
	cursorIndex: number;
	tier: "global" | "project";
	pendingCount: number;
	hiddenStandaloneCount: number;
	/** Shown in the status line whenever non-empty. */
	filterText: string;
	/** Maximum list rows before the scroll window kicks in. */
	maxVisible: number;
}

export function renderPickerView(view: PickerView, width: number, theme: PickerTheme = identityTheme): string[] {
	const t = theme;
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

	const ordered = view.rows;
	const packageCount = new Set(ordered.filter((e) => e.kind === "package" && e.packageSource).map((e) => e.packageSource)).size;
	const counts = `${ordered.length} file(s) in ${packageCount} package(s)` +
		(view.hiddenStandaloneCount > 0 ? ` · +${view.hiddenStandaloneCount} standalone hidden` : "");
	lines.push(line(t.fg("dim", counts)));
	lines.push(line(""));

	const cursor = Math.max(0, Math.min(view.cursorIndex, Math.max(0, ordered.length - 1)));
	const start = Math.max(0, Math.min(cursor - Math.floor(view.maxVisible / 2), ordered.length - view.maxVisible));
	const end = Math.min(start + view.maxVisible, ordered.length);
	for (let i = start; i < end; i++) {
		lines.push(line(renderRow(ordered[i]!, i === cursor, view.tier, t)));
	}
	if (start > 0 || end < ordered.length) {
		lines.push(line(t.fg("dim", `Showing ${start + 1}-${end} of ${ordered.length}`)));
	}
	if (ordered.length === 0) lines.push(line(t.fg("dim", "(no matching extensions)")));
	lines.push(line(""));

	let status = t.fg("dim", `write tier: ${view.tier}`);
	if (view.pendingCount > 0) status += t.fg("warning", ` · ${view.pendingCount} pending (a apply)`);
	if (view.filterText) status += t.fg("dim", ` · filter: ${view.filterText}`);
	lines.push(line(status));

	lines.push(t.fg("border", `╰${"─".repeat(inner)}╯`));
	return lines;
}

function renderRow(e: LoadedEntry, selected: boolean, tier: "global" | "project", t: PickerTheme): string {
	// Marker: the active write tier's state — the thing Enter will change.
	const state = tier === "global" ? e.states.global : e.states.project;
	const marker =
		state === "on" ? t.fg("success", "on ") : state === "off" ? t.fg("dim", "off") : t.fg("dim", "-");
	const tierState = (v: string) => (v === "unmanaged" ? "-" : v);
	// Multi-file package rows carry pkg/file in the name; index rows show
	// the package name. The dim tail then only needs states + live marker.
	const source = e.kind === "package" && e.packageSource ? e.packageSource.replace(/^npm:/, "") : undefined;
	const name =
		source && e.name !== "index.ts" && e.name !== "index.js" ? `${source}/${e.name}` : displayName(e);
	const parts = [
		`G:${tierState(e.states.global)} P:${tierState(e.states.project)}`,
		e.loaded ? "loaded" : "not loaded",
	];
	const text = `${marker} ${name} ${t.fg("dim", parts.join(" · "))}`;
	return selected ? t.bg("selectedBg", t.fg("accent", `› ${text}`)) : `  ${text}`;
}
