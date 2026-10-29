# planning-files-runtime

A single Pi extension that owns:

- baseline planning files workflow under `.pi/planning/`
- an optional goal overlay that drives focused implementation runs
- goal design blueprint (`goal-design.md`) with staged drafting (4 stages)

## Public commands

- `/plan-archive` — when the agent is idle, archive the complete current workspace at any goal status without creating replacement templates
- `/plan-new` — archive then reset `.pi/planning/`, including goal-design.md + tasks/, and clear the goal overlay
- `/plan-goal-set` — 4-stage goal drafting (as-is → design → story → task), outputs to goal-design.md
- `/plan-goal-impl [supplemental input]` — start or resume the committed goal using Task Plan from goal-design.md as blueprint; pass current facts or instructions to this implementation request
- `/planning-goal` — open a read-only, scrollable TUI overlay with full planning values, goal contract, and drafting context; ↑/↓, PgUp/PgDn, Home/End scroll, Esc or Enter closes

## Managed files

Session tracking (per-run):

- `.pi/planning/task_plan.md`
- `.pi/planning/findings.md`
- `.pi/planning/progress.md`

Goal epic blueprint (cross-run):

- `.pi/planning/goal-design.md` — Design, Story Breakdown, Task Plan index
- `.pi/planning/tasks/task-NN.md` — individual Task cards with deps + TDD

Goal overlay state:

- `.pi/planning/.goal-state.json` — includes `draftingStage` field for 4-stage tracking

## Runtime behavior

- Redirects `task_plan.md`, `findings.md`, `progress.md`, `goal-design.md` into `.pi/planning/`
- Injects planning context + Task index before agent starts
- Drafting stages auto-advance; agent asks user only when key info missing
- Drafting: `write` blocked outside `.pi/planning/`; `edit` allowed inside; `bash` read-only
- `commit_plan_goal` validates `goal-design.md` exists and non-empty
- `/plan-archive` rejects while the agent is running; once idle, it archives all managed files and goal state without reinitializing at any goal status; `/plan-new` archives them and creates a fresh workspace
- Execution follows Task hard/soft deps + TDD (red → green → refactor, 1 commit per Task)
- Automatic continuation: when a settled run still has goal work, the runtime returns the next continuation prompt at Pi's `agent_before_settle` boundary (a hidden `custom_message` entry plus `continue: true`), so Pi itself schedules the next model request — there is no idle-window timer to race auto-compaction. The prompt is rebuilt from the planning files on disk at every decision, and a run only continues when its last turn made meaningful progress.
- Cancellation pauses an `active` goal, including cancellation during Pi cleanup after the last assistant message ended normally; the goal does not resume automatically
- Nonblank `/plan-goal-impl` input is forwarded on a ready start, paused resume, or explicit stalled-run recovery resend. Leading/trailing whitespace is trimmed; multiline content is preserved. Blank input retains the no-argument behavior.
- The prompt asks the agent to reconcile current `Blocker` / `Next action` with the latest user facts before execution: correct obsolete waiting conditions, verify uncertain claims, retain unresolved blockers, and preserve interruption history in `progress.md`. It does not automatically override the goal contract; the runtime does not heuristically rewrite planning files.
- Supplements are request-local: included in the outgoing custom message, not stored in goal state or re-injected as a new supplement into later automatic continuations or runs. A retry must supply any still-needed input again.
- For an ordinary already-active run, a repeated no-argument request is a no-op; nonblank input is explicitly rejected with guidance to send a normal message or pause and retry. Explicit stalled-run recovery is the exception and accepts input.
- If the first implementation start fails while archiving or initializing its workspace, repair the reported error, pause the run, then retry `/plan-goal-impl`. The pending reset survives reloads, so recovery completes the new run’s workspace setup before sending an implementation prompt; automatic continuation waits for initialization.
- `complete_plan_goal` is audited: an independent model call judges the claim against the success criteria using the claimed evidence and the progress.md tail. A REJECT verdict returns an error listing the unmet criteria (goal stays active); an unavailable auditor (no model, provider error, unparseable verdict) fails open and completes with a note. The auditor model is `planning.auditModel` in settings.json (`{ provider, id, thinking }`); unset or unresolvable config falls back to the session model at low thinking.
- Completion finalizes `task_plan.md` and `progress.md` before saving the completed goal state. A finalization or state-write failure leaves the goal active: repair the reported error and retry `complete_plan_goal`. Already finalized files remain in place, and retrying the same completion does not duplicate its evidence or timeline entry.
- Lifecycle reads reject unknown status values and explicitly supplied invalid goal contracts. Repair `.goal-state.json` before continuing; a failed read retains the last known drafting restrictions. Missing optional fields still receive defaults.
- Token accounting: `impl.tokensUsed` accumulates over the goal lifecycle, including drafting, implementation, interrupted/error turns with reported usage, completion audit, and the closing commit/pause/completion responses. Successful commit/pause/completion tools keep accounting ownership through their automatic follow-up turns until `agent_settled`; `turn_start` only releases the tool-stop gate. Settlement, a new `agent_start`, restore, and reset clear that temporary ownership even if state-file reads fail. Start, resume, reload, and re-commit preserve the total; subsequent unrelated runs while ready, paused, or complete do not add usage. Messages steered into an ongoing goal run share that run's accounting. Archiving/resetting the goal with `/plan-archive` or `/plan-new` clears the live counter. Existing saved counts carry forward; amounts discarded by older versions are not reconstructed.
- Optional token budget: pass `tokenBudget` (positive integer) to `commit_plan_goal` only when the user asks for a spend cap. The cap applies to cumulative goal usage. Continuation prompts add a warning at 70% and a wrap-up directive at 90%; crossing 100% pauses the run at the before-settle boundary instead of continuing (a run that settles without progress retains its existing no-continuation semantics and is not force-paused). Resuming does not replenish the budget; use `/plan-goal-set` to revise and re-commit a larger authorized cap when needed. The widget shows `tokens: used / cap (pct)`, or `tokens: used` without a budget.

Example after resetting a provider quota (run `/reload` after updating the extension):

```text
/plan-goal-impl 我已使用重置卡恢复5小时额度，请核对并更新旧的等待条件后继续。
```

## Planning display

The summary above the editor is headed `Planning goal`. Its title and field labels use the same theme `accent` color as the Agents widget. Fields appear in this order: `dir`, `planning`, `state` (formerly `goal`), `objective`, `phase`, `next`, optional `blocker`, then `tokens`. Missing optional values are omitted. While drafting, `objective` comes from the draft and `next` shows the current recommended question.

Each field occupies one terminal line. Long values are truncated with `...` according to the available terminal columns, including Chinese text and emoji; embedded newlines are collapsed in the summary. `/planning-goal` wraps the original full values and supports scrolling, including success criteria, constraints, exclusions, and drafting questions. It reads complete Markdown section bodies from the current files when opened, retaining all lines and bullets while preserving the paused/completed projections, and does not send a model request. Persisted field values are rendered as plain text: terminal escape sequences and unsafe control characters are removed before UI-owned theme styling; normal newlines and Unicode text remain. Rendering does not rewrite the stored values.

In TUI mode the runtime mounts one persistent component per UI lifetime and requests renders on updates, retaining its slot even while the summary is empty. This avoids the repeated delete/reinsert behavior of `setWidget()` that made planning updates exchange positions with Agents. RPC mode retains string widgets.

## Settings

`~/.pi/agent/settings.json`:

```json
"planning": {
  "auditModel": { "provider": "magpie", "id": "zhipu/glm-5.3-flash", "thinking": "low" }
}
```

Read on every completion, so edits apply without a restart. No `planning` block means the session model audits at low thinking.

## Dotfiles integration

Version-controlled in `dotfiles`, linked into `~/.pi/agent/extensions/planning-files-runtime` via `just install-pi`.
