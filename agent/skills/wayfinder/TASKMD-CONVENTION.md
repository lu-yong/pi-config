# taskmd Convention for Personal Wayfinder

This document is the **storage and command convention** layer for Personal Wayfinder.  
Methodology lives in [SKILL.md](SKILL.md). Do not redefine method here.

## Prerequisites

- Binary: `taskmd` must be available on PATH
- If missing: stop; user installs or explicitly authorizes agent install
- No silent fallback tracker

## Paths

| Purpose | Path |
|---|---|
| Wayfinder Workspace | `.pi/wayfinder/` |
| taskmd ticket directory | `.pi/wayfinder/tickets/` |

Always pass the ticket directory explicitly to taskmd, for example:

```bash
taskmd --task-dir .pi/wayfinder/tickets <command>
```

Use the project's actual relative/absolute path for the current repo.

## Identity tags

All Wayfinder records must carry a `wayfinder:*` tag. Untagged taskmd records are out of Wayfinder logic.

| Record | Required tags |
|---|---|
| Map | `wayfinder:map` |
| Research Ticket | `wayfinder:research` |
| Prototype Ticket | `wayfinder:prototype` |
| Grilling Ticket | `wayfinder:grilling` |
| Setup Ticket | `wayfinder:setup` |

Optional extra tag for bulk filtering: `wayfinder`

Do **not** rely on taskmd `type` / `group` / `scope` for first-class Wayfinder identity. Tags are the membership system.

## Status conventions

| Object | Status | Meaning |
|---|---|---|
| Active Map | `in-progress` | Current map being worked |
| Historical Map | `completed` or `cancelled` | Closed map |
| Current Ticket | `in-progress` | Session focus |
| Ready / waiting Ticket | `pending` | Not started; may wait on deps |
| Answered Ticket | `completed` | Decision recorded, including negative answers |
| Abandoned Ticket | `cancelled` | Lost relevance before answer |
| Exceptionally stuck Ticket | `blocked` | Real external blocker only |

Rules:

- Only one Active Map (`wayfinder:map` + `in-progress`)
- Only one Current Ticket (non-map + `in-progress`) preferred
- Ordinary unmet dependencies stay `pending`
- Reserve `blocked` for real exceptions

## Relationship model

| Relationship | Meaning | taskmd expression |
|---|---|---|
| Parent | Ticket belongs to Map | Ticket `parent` = Map id |
| Dependency | Downstream waits for upstream | Ticket `dependencies` / `--depends-on` |

Important:

- Parent is **membership only**
- Dependency is the only relationship that shapes Frontier
- Tickets must **not** depend on the Map itself just to express membership

Direction:

- `B --depends-on A` means B waits for A
- A is upstream of B

## Titles

| Object | Title format |
|---|---|
| Map | `Wayfinder: <Destination>` |
| Ticket | plain human question / decision name |

No type prefixes in Ticket titles. Type lives in tags.

## Body templates

### Map body

```markdown
## Destination

## Notes

## Decisions So Far

## Not Yet Specified

## Out of Scope
```

All five sections must exist even when empty.

### Ticket body

```markdown
## Question

## Why Now

## Notes

## Resolution

## Follow-ups
```

All five sections must exist even when empty.

## Decision double-write

When completing a Ticket:

1. Fill Ticket `## Resolution`
2. Append one line to Map `## Decisions So Far`:

```markdown
- [<Ticket title>](link-or-id-context) — <one-line gist>
```

Prefer named references over bare ids in human-facing text.

## Frontier query intent

Frontier candidates are Tickets that:

1. are tagged `wayfinder:research|prototype|grilling|setup` (not `wayfinder:map`)
2. belong to the Active Map (parent)
3. have `status=pending`
4. have all dependencies satisfied / completed
5. are not already the Current Ticket

Practical composition:

- use taskmd dependency-aware next/list features where available
- filter to Wayfinder tags + `status=pending`
- skip map records
- if user named a Ticket, that overrides automatic selection

Suggested mental command shape (adapt to installed taskmd version):

```bash
taskmd --task-dir .pi/wayfinder/tickets next \
  --filter status=pending \
  --filter tag=wayfinder:research
# also consider prototype / grilling / setup tags as needed
```

If native next/filter cannot express everything cleanly, list + filter in agent logic. Correctness of frontier semantics beats clever one-liners.

## Common operations

Exact flags may vary by taskmd version. Prefer:

1. discover actual CLI help (`taskmd --help`, `taskmd add --help`, etc.)
2. then apply the semantics below

### Init workspace

```bash
mkdir -p .pi/wayfinder/tickets
# optional: smoke-check taskmd against the dir
taskmd --task-dir .pi/wayfinder/tickets list
```

### Create Map

Verified against taskmd `0.2.6`:

```bash
taskmd -d .pi/wayfinder/tickets add "Wayfinder: <Destination>" \
  --tags wayfinder:map --status in-progress --format json
```

Then overwrite the created markdown body with the Map template. Default `taskmd add` body is Objective/Tasks/Acceptance Criteria and is not Wayfinder-shaped.

### Create Ticket

```bash
taskmd -d .pi/wayfinder/tickets add "<question-focused title>" \
  --tags wayfinder:<type> --status pending --parent <map-id> --format json
```

Then overwrite the body with the Ticket template.

- dependencies: only after related ids exist

### Wire dependencies

Second pass after create:

```bash
# conceptual
taskmd -d .pi/wayfinder/tickets set <ticket-id> --depends-on <upstream-id>
# multiple: --depends-on 002,003
```

### Mark Current Ticket

```bash
taskmd -d .pi/wayfinder/tickets set <ticket-id> --status in-progress
```

Set chosen Ticket to `status=in-progress`.  
Ensure no other non-map Ticket remains `in-progress` unless the user intentionally overrides.

### Complete Ticket

```bash
taskmd -d .pi/wayfinder/tickets set <ticket-id> --status completed
# or: taskmd -d .pi/wayfinder/tickets set <ticket-id> --done
```

1. write `## Resolution`
2. append Map `## Decisions So Far`
3. set status `completed`
4. graduate fog / out-of-scope as needed

### Cancel Ticket

Use when the Ticket is abandoned or mis-scoped before resolution:

- status `cancelled`
- if out of scope: also record on Map `## Out of Scope`

### Open Web UI

Human inspection surface. This is a long-running **ordinary process**, not a Pi subagent. Keep the agent's mutations on the taskmd CLI; never drive the web UI to change state.

1. Confirm taskmd is installed and the Wayfinder workspace exists. Check the installed `taskmd web start --help` before relying on flags. If taskmd is missing, follow the prerequisite rule above; do not install silently.
2. For automated launch, require `HERDR_ENV=1` and the `herdr` CLI. Follow the installed Herdr skill/CLI syntax (`herdr --help`, `herdr pane`). Do not control a focused Herdr session from outside it.
3. Inspect `herdr pane layout --current`, then create a sibling pane with the current project's cwd and no focus change. Choose `right` for a wide pane or `down` for a narrow/tall one; for example:

   ```bash
   herdr pane split --current --direction right --cwd "$PWD" --no-focus
   ```

4. Read `.result.pane.pane_id` from the successful response and use that exact value as `pane_id` below. Do not target the caller or guess an ID. Submit the server command in the new pane:

   ```bash
   herdr pane run "$pane_id" 'taskmd -d .pi/wayfinder/tickets web start --port 8080 --open'
   herdr pane read "$pane_id" --source recent-unwrapped --lines 60
   ```

5. Report the pane ID, actual startup output, and URL (default `http://localhost:8080`, actual port wins). A successful `pane run` only confirms submission, not readiness. If output does not yet establish readiness, say so; on failure report it rather than claiming the UI is running.
6. The user can inspect the pane and press Ctrl+C to stop the server. For agent-assisted cleanup, use `herdr pane send-keys "$pane_id" ctrl+c`, then close only this task-created pane once its process/output is no longer needed. Do not close user panes or workspaces.

The Herdr control commands are one-shot `bash` calls; the server itself runs in its terminal pane. Do not host it inside `subagent`, block the parent with the foreground server, or use `nohup`/an untracked background shell job.

If Herdr is unavailable, do not pretend a pane was created. Give this command for the user to run in a separate terminal at the project root, and explain that Ctrl+C stops it:

```bash
taskmd -d .pi/wayfinder/tickets web start --port 8080 --open
```


## Status report fields

`/wayfinder status` should summarize at least:

- taskmd available? yes/no
- workspace path exists?
- Active Map name + destination gist
- Current Ticket name (if any)
- Frontier candidates (named)
- blocked exceptions
- recent Decisions So Far (tail)

No hidden mutation during status.

## Validation / cleanup checks

Stop and ask the human when detecting:

- multiple Active Maps
- multiple Current Tickets without explicit user intent
- Wayfinder-tagged records outside `.pi/wayfinder/tickets/`
- Tickets without parent Map
- circular dependencies (use taskmd validate if available)

## Language boundary

- This convention doc and the skill docs are English
- Human conversation may be Chinese
- Keep canonical terms untranslated: Map, Ticket, Frontier, Destination, Current Ticket
