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
- Cancellation pauses an `active` goal and clears any pending continuation, including cancellation during Pi cleanup after the last assistant message ended normally; the goal does not resume automatically
- Nonblank `/plan-goal-impl` input is forwarded on a ready start, paused resume, or explicit stalled-run recovery resend. Leading/trailing whitespace is trimmed; multiline content is preserved. Blank input retains the no-argument behavior.
- The prompt asks the agent to reconcile current `Blocker` / `Next action` with the latest user facts before execution: correct obsolete waiting conditions, verify uncertain claims, retain unresolved blockers, and preserve interruption history in `progress.md`. It does not automatically override the goal contract; the runtime does not heuristically rewrite planning files.
- Supplements are request-local: included in the outgoing custom message, not stored in goal state or re-injected as a new supplement into later automatic continuations or runs. A retry must supply any still-needed input again.
- For an ordinary already-active run, a repeated no-argument request is a no-op; nonblank input is explicitly rejected with guidance to send a normal message or pause and retry. Explicit stalled-run recovery is the exception and accepts input.

Example after resetting a provider quota (run `/reload` after updating the extension):

```text
/plan-goal-impl 我已使用重置卡恢复5小时额度，请核对并更新旧的等待条件后继续。
```

## Dotfiles integration

Version-controlled in `dotfiles`, linked into `~/.pi/agent/extensions/planning-files-runtime` via `just install-pi`.
