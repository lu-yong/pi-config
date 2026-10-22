/**
 * Picker session (the /extmgr interaction): the deep module that owns the
 * complete interactive state (package snapshot, write tier, cursor identity,
 * filter, net pending changes, hidden-standalone count), the projection of that
 * state onto rendered rows, and the timing of in-flight toggles.
 *
 * Hosts — Pi's `ctx.ui.custom()` in production, headless drivers in tests —
 * see only the component seam (`render`/`handleInput`) plus `open()` and
 * `settle()`. They never learn which facts exist, when they are refreshed,
 * or in which order writes and reloads may interleave:
 *
 * - Every Enter enqueues a toggle on a serial queue. The row identity and
 *   the write tier are captured at enqueue time, so a Tab pressed while a
 *   toggle is in flight cannot relabel it; the enable/disable action is
 *   re-derived from the freshest snapshot at execution time, so two quick
 *   Enters on one row behave like a switch (on → off → on), not a doubled
 *   write.
 * - Apply (`a`) drains the queue first, then requests exactly one reload
 *   and closes: an in-flight write is never lost to the reload and the
 *   reload is never skipped. Closing (`q`/Esc) is immediate; a write that
 *   is still in flight completes in the background without a reload.
 *
 * Sessions list package extensions only (ADR-0002); standalone extensions
 * surface as the `+N standalone hidden` count.
 */

import type { ExtmgrEnv } from "./env.ts";
import { persistToggle, type ToggleAction, type ToggleFn, type ToggleTier } from "./persist.ts";
import { orderEntries, renderPickerView, type PickerTheme } from "./picker.ts";
import { loadSnapshot, type LoadedEntry, type SourceInfoLike } from "./snapshot.ts";

/** Host services the session needs: notifications, the interactive mount,
 * the reload primitive, and the project-trust verdict. */
export interface PickerHost {
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		custom?(
			factory: (
				tui: { requestRender(): void; terminal?: { rows: number } },
				theme: unknown,
				keybindings: { matches(data: string, keybinding: string): boolean },
				done: (result: unknown) => void,
			) => unknown,
			options?: { overlay?: boolean },
		): Promise<unknown>;
	};
	reload(): Promise<void> | void;
	isProjectTrusted?(): boolean;
}

export interface PickerSessionDeps {
	env: ExtmgrEnv;
	liveSources?: () => SourceInfoLike[];
	host: PickerHost;
	/** Persistence seam: production wires `persistToggle`; tests may inject a
	 * controllable stand-in to pin in-flight ordering. */
	persist?: ToggleFn;
}

/** Everything a render needs, recomputed from state on demand — there is no
 * second copy of any fact to keep in sync. */
interface InteractionState {
	packages: LoadedEntry[];
	standaloneCount: number;
	tier: ToggleTier;
	/** Cursor by row identity, so refreshes keep the selection without the
	 * session re-deriving indexes. */
	selectedId: string | undefined;
	filterText: string;
	filterActive: boolean;
	pending: Map<string, { id: string; tier: ToggleTier; initial: "on" | "off" }>;
}

export interface PickerComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
}

interface TuiLike {
	requestRender?: () => void;
	terminal?: { rows?: number };
}

interface KeybindingsLike {
	matches(data: string, keybinding: string): boolean;
}

export class PickerSession {
	private readonly deps: PickerSessionDeps & { persist: ToggleFn };
	private readonly state: InteractionState;
	private queue: Promise<unknown> = Promise.resolve();
	private theme: PickerTheme | undefined;
	private requestRenderFn: (() => void) | undefined;
	private done: ((result: unknown) => void) | undefined;
	private disposed = false;
	private closed = false;
	/** Set between Apply and close: input is dead for that window. */
	private applying = false;

	private constructor(deps: PickerSessionDeps, initial: { packages: LoadedEntry[]; standaloneCount: number }) {
		this.deps = { liveSources: () => [], ...deps, persist: deps.persist ?? persistToggle };
		this.state = {
			packages: initial.packages,
			standaloneCount: initial.standaloneCount,
			tier: "global",
			selectedId: orderEntries(initial.packages)[0]?.id,
			filterText: "",
			filterActive: false,
			pending: new Map(),
		};
	}

	/** Build a session from one initial snapshot read. */
	static async start(deps: PickerSessionDeps): Promise<PickerSession> {
		const initial = await loadSnapshot(deps.env, deps.liveSources);
		return new PickerSession(deps, initial);
	}

	/** Mount as the focused interactive component via `ctx.ui.custom()`;
	 * resolves when the session closes. Falls back to a notify hint when
	 * custom() is unavailable. */
	async open(): Promise<unknown> {
		const custom = this.deps.host.ui.custom;
		if (!custom) {
			this.deps.host.ui.notify("/extmgr needs an interactive terminal with component support.", "warning");
			return undefined;
		}
		return custom(
			(tui, theme, keybindings, doneCb) => {
				if (theme && typeof (theme as PickerTheme).fg === "function") this.theme = theme as PickerTheme;
				this.done = doneCb;
				return this.component({ tui, theme: this.theme, keybindings });
			},
			{ overlay: true },
		);
	}

	/** The component seam: pi-tui's Component shape over this session.
	 * Headless drivers pass their own tui/theme/keybindings stand-ins. */
	component(options: { tui?: TuiLike; theme?: PickerTheme; keybindings?: KeybindingsLike } = {}): PickerComponent {
		if (options.theme) this.theme = options.theme;
		if (options.tui?.requestRender) this.requestRenderFn = options.tui.requestRender;
		return {
			render: (width: number) => this.render(width, options.tui?.terminal?.rows),
			handleInput: (data: string) => this.handleInput(data, options.keybindings),
			// Render is a pure function of state — nothing is cached, so an
			// invalidate from the host has nothing to drop.
			invalidate: () => {},
			dispose: () => {
				this.disposed = true;
			},
		};
	}

	/** Resolve when every queued toggle (and an Apply's reload, if any) has
	 * settled. Test drivers use this to observe in-flight timing. */
	settle(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	// -- view projection ----------------------------------------------------

	private rows(): LoadedEntry[] {
		const f = this.state.filterText.toLowerCase();
		const filtered = f
			? this.state.packages.filter(
					(e) => e.name.toLowerCase().includes(f) || e.packageSource?.toLowerCase().includes(f),
				)
			: [...this.state.packages];
		return orderEntries(filtered);
	}

	private render(width: number, terminalRows?: number): string[] {
		const rows = this.rows();
		const cursor = Math.max(0, rows.findIndex((e) => e.id === this.state.selectedId));
		return renderPickerView(
			{
				rows,
				cursorIndex: cursor,
				tier: this.state.tier,
				pendingCount: this.state.pending.size,
				hiddenStandaloneCount: this.state.standaloneCount,
				filterText: this.state.filterText,
				maxVisible: Math.max(1, (terminalRows ?? 24) - 16),
			},
			width,
			this.theme,
		);
	}

	// -- interaction ---------------------------------------------------------

	private handleInput(data: string, kb?: KeybindingsLike): void {
		if (this.closed || this.applying) return;
		const input = kb?.matches(data, "tui.select.up")
			? "\u001b[A"
			: kb?.matches(data, "tui.select.down")
				? "\u001b[B"
				: kb?.matches(data, "tui.select.confirm")
					? "\r"
					: kb?.matches(data, "tui.input.tab")
						? "\t"
						: kb?.matches(data, "tui.select.cancel")
							? "\u001b"
							: data;
		if (this.state.filterActive) {
			if (input === "\u001b" || input === "\r") this.state.filterActive = false;
			else if (["\u007f", "\b", "\u001b[3~"].includes(data)) this.state.filterText = this.state.filterText.slice(0, -1);
			else if (data >= " ") this.state.filterText += data;
			this.selectIndex(0);
			this.requestRender();
			return;
		}
		const rows = this.rows();
		const cursor = Math.max(0, rows.findIndex((e) => e.id === this.state.selectedId));
		switch (input) {
			case "\u001b[A":
			case "k":
				this.selectIndex(Math.max(0, cursor - 1));
				break;
			case "\u001b[B":
			case "j":
				this.selectIndex(Math.min(rows.length - 1, cursor + 1));
				break;
			case "\r":
				this.enqueueToggle();
				return; // async: the refresh requests its own render
			case "\t":
				this.state.tier = this.state.tier === "global" ? "project" : "global";
				break;
			case "/":
				this.state.filterActive = true;
				break;
			case "a":
				this.apply();
				return;
			case "q":
			case "\u001b":
				this.close();
				return;
			default:
				return;
		}
		this.requestRender();
	}

	private selectIndex(i: number): void {
		this.state.selectedId = this.rows()[i]?.id;
	}

	// -- in-flight toggle timing ---------------------------------------------

	/** Enter: enqueue a toggle for the selected row at the tier active now.
	 * The queue serializes writes; enqueue-time captures are what the user
	 * saw when pressing the key. */
	private enqueueToggle(): void {
		const entryId = this.state.selectedId;
		const tier = this.state.tier;
		this.queue = this.queue.then(() => this.executeToggle(entryId, tier));
	}

	private async executeToggle(entryId: string | undefined, tier: ToggleTier): Promise<void> {
		const notify = this.deps.host.ui.notify.bind(this.deps.host.ui);
		try {
			// Pre-write read: packageFiles for the plan, and the freshest
			// state to derive the action from (queue order makes this the
			// state after any earlier queued toggle).
			const pre = await loadSnapshot(this.deps.env, this.deps.liveSources);
			const entry = entryId === undefined ? undefined : pre.packages.find((e) => e.id === entryId);
			if (!entry) {
				notify(entryId === undefined ? "nothing selected" : `target-not-found: ${entryId} no longer resolves`, "warning");
				return;
			}
			const cell = tier === "global" ? entry.states.global : entry.states.project;
			if (cell === "unmanaged") {
				notify(`${entry.name} is not managed at the ${tier} tier; toggle it at its owning tier instead.`, "warning");
				return;
			}
			const action: ToggleAction = cell === "on" ? "disable" : "enable";
			const out = await this.deps.persist(
				this.deps.env,
				pre.packages,
				entry,
				action,
				tier,
				this.deps.host.isProjectTrusted?.() ?? true,
			);
			if (!out.ok) {
				notify(out.detail, "warning");
				return;
			}
			const after = await loadSnapshot(this.deps.env, this.deps.liveSources);
			this.state.packages = after.packages;
			this.state.standaloneCount = after.standaloneCount;
			const visibleRows = this.rows();
			if (!visibleRows.some((row) => row.id === this.state.selectedId)) {
				this.state.selectedId = visibleRows[0]?.id;
			}
			// Count net changes per extension/tier, not successful key presses.
			// Enter affects the whole package, including rows the user did not select.
			for (const affected of pre.packages) {
				if (affected.packageSource !== entry.packageSource) continue;
				const initial = affected.states[tier];
				if (initial === "unmanaged") continue;
				const pendingKey = JSON.stringify([affected.id, tier]);
				if (!this.state.pending.has(pendingKey)) {
					this.state.pending.set(pendingKey, { id: affected.id, tier, initial });
				}
			}
			for (const [key, change] of this.state.pending) {
				const current = after.packages.find((row) => row.id === change.id);
				if (!current || current.states[change.tier] === change.initial) this.state.pending.delete(key);
			}
			this.requestRender();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			notify(`Unable to update extension settings: ${detail}`, "error");
			this.requestRender();
		}
	}

	/** Apply: drain every queued toggle, clear pending, request exactly one
	 * reload, then close. The drain ordering is what keeps an in-flight
	 * write ahead of the reload (applied, not lost) without ever issuing a
	 * second reload. */
	private apply(): void {
		if (this.closed || this.applying) return;
		this.applying = true;
		this.queue = this.queue
			.then(async () => {
				this.state.pending.clear();
				await this.deps.host.reload();
			})
			.catch(() => {})
			.finally(() => this.close());
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done?.(undefined);
	}

	private requestRender(): void {
		if (!this.disposed) this.requestRenderFn?.();
	}
}

/** Build the /extmgr picker session over real persistence. */
export async function openPickerSession(deps: PickerSessionDeps): Promise<PickerSession> {
	return PickerSession.start(deps);
}
