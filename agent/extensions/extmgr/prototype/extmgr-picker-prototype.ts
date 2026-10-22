// PROTOTYPE — THROWAWAY. Answers: "What should the /extmgr picker look
// like, modeled on pi-footer's design language?" Three structurally
// different variants, switchable with ←/→; packages only (standalone
// extensions are hidden per the new scope decision). No persistence —
// toggles mutate an in-memory mock only.
//
// Run:  node prototype/extmgr-picker-prototype.ts              (interactive)
//       node prototype/extmgr-picker-prototype.ts --screenshot (static, w=80)
//       node prototype/extmgr-picker-prototype.ts --screenshot 100

process.title = "extmgr-picker-prototype";

// ---------------------------------------------------------------------------
// Mock data (packages only; standalone entries exist to prove they're hidden)
// ---------------------------------------------------------------------------

type TierState = "on" | "off" | "unmanaged";

interface Entry {
	name: string; // file basename
	source: string; // npm:package
	relPath: string;
	g: TierState;
	p: TierState;
	loaded: boolean;
}

interface State {
	entries: Entry[]; // mutated in memory by enter
	selected: number;
	tier: "global" | "project";
	variant: 0 | 1 | 2;
	message: string; // transient feedback line
	pending: number;
	standaloneHidden: number;
}

const initialEntries = (): Entry[] => [
	{ name: "index.ts", source: "npm:pi-footer", relPath: "index.ts", g: "on", p: "unmanaged", loaded: true },
	{ name: "index.ts", source: "npm:pi-code-review", relPath: "index.ts", g: "on", p: "unmanaged", loaded: true },
	{ name: "index.ts", source: "npm:pi-task-runner", relPath: "index.ts", g: "on", p: "unmanaged", loaded: true },
	{ name: "jira-adapter.ts", source: "npm:pi-task-runner", relPath: "jira-adapter.ts", g: "on", p: "on", loaded: true },
	{ name: "sql-tools.ts", source: "npm:pi-db-helpers", relPath: "sql-tools.ts", g: "off", p: "on", loaded: true },
	{ name: "index.ts", source: "npm:pi-legacy-panel", relPath: "index.ts", g: "off", p: "unmanaged", loaded: false },
	{ name: "index.ts", source: "npm:extmgr", relPath: "index.ts", g: "on", p: "unmanaged", loaded: true },
];

const state: State = {
	entries: initialEntries(),
	selected: 0,
	tier: "global",
	variant: 0,
	message: "",
	pending: 0,
	standaloneHidden: 2,
};

// ---------------------------------------------------------------------------
// Tiny ANSI helpers (ASCII-only mock data → string length is visible width)
// ---------------------------------------------------------------------------

const R = "\x1b[0m";
const dim = (s: string) => `\x1b[2m${s}${R}`;
const green = (s: string) => `\x1b[32m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const cyan = (s: string) => `\x1b[36m${s}${R}`;
const bold = (s: string) => `\x1b[1m${s}${R}`;
const sel = (s: string) => `\x1b[7m${s}${R}`;
const border = dim;

const plainWidth = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function pad(s: string, w: number): string {
	return plainWidth(s) >= w ? s : s + " ".repeat(w - plainWidth(s));
}

function cut(s: string, w: number): string {
	if (plainWidth(s) <= w) return s;
	let out = "";
	let width = 0;
	let i = 0;
	let inAnsi = false;
	while (i < s.length && width < w - 1) {
		if (s[i] === "\x1b") inAnsi = true;
		if (!inAnsi) {
			out += s[i];
			width++;
		} else out += s[i];
		if (inAnsi && s[i] === "m") inAnsi = false;
		i++;
	}
	return out + "…" + R;
}

// Frame builders, modeled on pi-footer's OverlayRender / ScreenRender.
function frame(title: string, body: string[], width: number): string[] {
	const inner = width - 2;
	const t = ` ${title} `;
	const right = Math.max(1, inner - 2 - plainWidth(t));
	const lines = [border(`╭──${cyan(bold(t))}${border("─".repeat(right))}╮`)];
	for (const line of body) lines.push(border("│") + pad(cut(line, inner), inner) + border("│"));
	lines.push(border(`╰${"─".repeat(inner)}╯`));
	return lines;
}
const menuTitle = (title: string, desc: string) => green(`•${title}`) + " " + dim(desc);

function stateChip(s: TierState): string {
	if (s === "on") return green("on ");
	if (s === "off") return dim("off");
	return dim("-");
}
function loadedChip(e: Entry): string {
	return e.loaded ? green("●") : dim("○");
}
const effective = (e: Entry) => (e.g === "on" || e.p === "on" ? "on" : "off");
const effChip = (e: Entry) => (effective(e) === "on" ? green("on") : dim("off"));
const pkgName = (source: string) => source.replace(/^npm:/, "");
const rowName = (e: Entry) =>
	e.relPath === "index.ts" ? pkgName(e.source) : e.relPath.replace(/\.ts$/, "");

function statusLine(s: State): string {
	return (
		dim(`write tier: ${s.tier}`) +
		(s.pending ? yellow(` · ${s.pending} pending (a apply)`) : "") +
		(s.message ? yellow(` · ${s.message}`) : "")
	);
}

// ---------------------------------------------------------------------------
// Variant A — "footer-menu": flat widget-list style (marker + name + dim tail)
// ---------------------------------------------------------------------------

function renderA(width: number, s: State): string[] {
	const body: string[] = [];
	body.push(menuTitle("Manage Extensions", "toggle package loading per tier"));
	body.push(dim("↑/↓ select • enter toggle • tab tier • ←/→ variant • q quit"));
	body.push(
		dim(
			`${s.entries.length} file(s) in ${new Set(s.entries.map((e) => e.source)).size} package(s)` +
				(s.standaloneHidden ? ` · +${s.standaloneHidden} standalone hidden` : ""),
		),
	);
	body.push("");
	s.entries.forEach((e, i) => {
		const tierState = s.tier === "global" ? e.g : e.p;
		const marker = tierState === "on" ? green("on ") : dim("off");
		const tail = dim(
			(e.relPath !== "index.ts" ? `${pkgName(e.source)}/${rowName(e)} · ` : "") +
				`G:${e.g === "unmanaged" ? "-" : e.g} P:${e.p === "unmanaged" ? "-" : e.p}` +
				` · ${e.loaded ? "loaded" : "not loaded"}`,
		);
		const text = `${marker} ${rowName(e)} ${tail}`;
		body.push(i === s.selected ? sel(`› ${text}`) : `  ${text}`);
	});
	body.push("");
	body.push(statusLine(s));
	return frame("Extensions", body, width);
}

// ---------------------------------------------------------------------------
// Variant B — "table": grouped columns with colored state chips
// ---------------------------------------------------------------------------

function renderB(width: number, s: State): string[] {
	const body: string[] = [];
	body.push(menuTitle("Manage Extensions", "grouped by package source"));
	body.push(dim("↑/↓ select • enter toggle • tab tier • ←/→ variant • q quit"));
	body.push("");
	const colName = 22;
	const colState = 6;
	body.push(dim(`${"Extension".padEnd(colName)}G     P     Eff   Loaded`));
	body.push("");
	let source = "";
	s.entries.forEach((e, i) => {
		if (e.source !== source) {
			source = e.source;
			const label = ` ${source} `;
			const total = width - 6;
			const left = Math.max(1, Math.floor((total - plainWidth(label)) / 2));
			body.push(dim("─".repeat(left) + label + "─".repeat(Math.max(1, total - left - plainWidth(label)))));
		}
		const name = (e.relPath === "index.ts" ? "" : "  ") + e.relPath.replace(/\.ts$/, "");
		const states = pad(stateChip(e.g), colState) + pad(stateChip(e.p), colState) + effChip(e);
		const text = `${pad(name, colName)}${states}   ${loadedChip(e)}`;
		body.push(i === s.selected ? sel(`› ${text}`) : `  ${text}`);
	});
	body.push("");
	body.push(
		statusLine(s) +
			(s.standaloneHidden ? dim(` · +${s.standaloneHidden} standalone hidden`) : ""),
	);
	return frame("Extensions", body, width);
}

// ---------------------------------------------------------------------------
// Variant C — "master-detail": package list on top, detail pane below
// ---------------------------------------------------------------------------

function renderC(width: number, s: State): string[] {
	const inner = width - 2;
	const body: string[] = [];
	const packages = [...new Set(s.entries.map((e) => e.source))];
	const pkgIndex = Math.max(
		0,
		packages.indexOf(s.entries[s.selected]!.source),
	);
	body.push(menuTitle("Manage Extensions", "one row per package · enter toggles the package"));
	body.push(dim("↑/↓ select • enter toggle package • tab tier • ←/→ variant • q quit"));
	body.push("");
	packages.forEach((pkg, i) => {
		const files = s.entries.filter((e) => e.source === pkg);
		const on = files.some((e) => (s.tier === "global" ? e.g : e.p) === "on");
		const marker = on ? green("on ") : dim("off");
		const text = `${marker} ${pkgName(pkg)} ${dim(`${files.length} file(s)`)}`;
		body.push(i === pkgIndex ? sel(`› ${text}`) : `  ${text}`);
	});
	body.push("");

	// Detail pane: nested box for the selected package.
	const pkg = packages[pkgIndex] ?? packages[0]!;
	const files = s.entries.filter((e) => e.source === pkg);
	const dInner = inner - 4;
	const dTitle = ` ${pkg} `;
	const dRight = Math.max(1, dInner - 2 - plainWidth(dTitle));
	body.push(border(`┌──${cyan(dTitle)}${border("─".repeat(dRight))}┐`));
	for (const e of files) {
		const line = `${pad(e.relPath, 18)}${pad(stateChip(e.g), 6)}${pad(stateChip(e.p), 6)}${effChip(e)}   ${loadedChip(e)}`;
		body.push(border("│") + pad(cut(line, dInner), dInner) + border("│"));
	}
	const action = files.some((e) => (s.tier === "global" ? e.g : e.p) === "on") ? "disable" : "enable";
	body.push(
		border("│") + pad(cut(dim(`enter ${action} @ ${s.tier} · G=global P=project eff=effective ● loaded`), dInner), dInner) + border("│"),
	);
	body.push(border(`└${"─".repeat(dInner)}┘`));
	body.push(statusLine(s));
	return frame("Extensions", body, width);
}

const VARIANTS = [
	{ key: "A", name: "footer-menu", render: renderA },
	{ key: "B", name: "table", render: renderB },
	{ key: "C", name: "master-detail", render: renderC },
] as const;

/** Visually distinct switcher bar below the frame (prototype affordance). */
function switcherBar(s: State): string {
	const label = VARIANTS.map((v, i) =>
		i === s.variant ? yellow(`${v.key} ${v.name}`) : dim(`${v.key} ${v.name}`),
	).join(yellow(" │ "));
	return yellow("◄ ") + label + yellow(" ►") + dim("  ←/→ switch · q quit");
}

function render(width: number, s: State): string {
	return [...VARIANTS[s.variant]!.render(width, s), switcherBar(s)].join("\n");
}

// ---------------------------------------------------------------------------
// Interaction (in-memory only)
// ---------------------------------------------------------------------------

function handleKey(data: string): boolean {
	if (data === "q" || data === "\x1b" || data === "\u0003") return false;
	// Variant C lists packages, not files: move the cursor to the first file
	// of the previous/next package so the highlight tracks the list.
	const move = (d: number) => {
		const n = state.entries.length;
		if (state.variant === 2) {
			// Jump to the first file of the previous/next package group.
			const same = (i: number) => state.entries[i]!.source === state.entries[state.selected]!.source;
			let i = state.selected;
			while (i + d >= 0 && i + d < n && same(i + d)) i += d;
			i += d; // cross into the neighbor group (or clamp at the ends)
			while (i - d >= 0 && i - d < n && state.entries[i]!.source === state.entries[i - d]!.source) i -= d;
			state.selected = Math.max(0, Math.min(n - 1, i));
		} else {
			state.selected = Math.max(0, Math.min(n - 1, state.selected + d));
		}
		state.message = "";
	};
	if (data === "\x1b[A" || data === "k") move(-1);
	else if (data === "\x1b[B" || data === "j") move(1);
	else if (data === "\x1b[D")
		state.variant = ((state.variant - 1 + VARIANTS.length) % VARIANTS.length) as 0 | 1 | 2;
	else if (data === "\x1b[C") state.variant = ((state.variant + 1) % VARIANTS.length) as 0 | 1 | 2;
	else if (data === "1" || data === "2" || data === "3")
		state.variant = (Number(data) - 1) as 0 | 1 | 2;
	else if (data === "\t") {
		state.tier = state.tier === "global" ? "project" : "global";
		state.message = "";
	} else if (data === "\r") {
		const e = state.entries[state.selected]!;
		const key: "g" | "p" = state.tier === "global" ? "g" : "p";
		// Variant C operates on the whole package; A/B on the selected file.
		const targets = state.variant === 2 ? state.entries.filter((x) => x.source === e.source) : [e];
		const cur = e[key];
		if (cur === "unmanaged") {
			state.message = `${e.relPath} not managed at ${state.tier} tier`;
		} else {
			for (const t of targets) {
				t[key] = cur === "on" ? "off" : "on";
				if (t[key] === "on") t.loaded = true;
				else if (effective(t) === "off") t.loaded = false;
			}
			state.pending++;
			state.message = "";
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Main: interactive TUI or --screenshot
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args[0] === "--screenshot") {
	const width = Math.max(60, Number(args[1]) || 80);
	for (const [i, v] of VARIANTS.entries()) {
		state.variant = i as 0 | 1 | 2;
		console.log(`\n===== Variant ${v.key} — ${v.name} (width ${width}) =====`);
		console.log(v.render(width, state).join("\n"));
	}
	process.exit(0);
}

const width = Math.min(100, Math.max(60, process.stdout.columns || 80));
const writeScreen = () => {
	process.stdout.write("\x1b[2J\x1b[H" + render(width, state) + "\n");
};
if (!process.stdin.isTTY) {
	console.log("Interactive mode needs a TTY. Use: --screenshot [width]");
	process.exit(0);
}
writeScreen();
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk: Buffer) => {
	if (!handleKey(chunk.toString())) {
		process.stdout.write("\x1b[2J\x1b[H\x1b[0m");
		process.exit(0);
	}
	writeScreen();
});
