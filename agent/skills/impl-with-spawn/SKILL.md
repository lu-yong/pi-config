---
name: impl-with-spawn
description: Delegate implementation, fixes, reviews, and multi-step coding work to Pi subagents through pi-herdr-agents. Use for substantial tasks that benefit from decomposition, parallel investigation, or an independent implementation/review pass.
disable-model-invocation: true
---

# Implement with Pi Subagents

Keep this skill's existing invocation (`/skill:impl-with-spawn`); delegation now uses `pi-herdr-agents`' public `subagent` tools. All children run Pi in Herdr panes. The parent decomposes the work, verifies results, and owns integration.

## Prerequisites and Routing

- Require the `subagent` tool and Pi running inside Herdr (`HERDR_ENV=1`). If unavailable, explain the limitation and continue only work that can safely be done locally; do not launch a replacement child through `bash`.
- Discover roles with `subagents_list` when needed, not to check running tasks. Prefer leaf roles: `scout`, `worker`, and `reviewer`.
- Set an exact authenticated `provider/model-id` and a supported `thinking` level on every child. Choose model tier first: fast for bounded reconnaissance/mechanical work, mid for ordinary implementation/review, frontier for architecture/security/hard diagnosis. Then choose low/minimal, medium, or high reasoning as supported; some models only support `off`, `high`, and `max`.
- Independent review uses a different underlying model family from the producer. A different provider serving the same family is not independent review. If no eligible reviewer is available, disclose the gap rather than silently claiming independence.
- Per-call `tools` replaces the entire role allowlist; it is not an intersection with the role or parent's tools. Use actual registered names. An empty list is not a safe restriction, and unknown tool names may be silently ignored.
- With the installed hashline editor, a bounded writer's tool list is `read,bash,write,replace,insert,anchor_grep,undo_last_change,find,ls`. Do not rely on bundled `edit` defaults. Add task-specific tools only when needed and permitted; keep child delegation disabled.

## Read-Only Delegation

The public API neither accepts arbitrary child CLI flags nor automatically forwards the parent's `--readonly` flag. For a read-only parent, delegate only exploration or report-only review and never use a child to bypass restrictions.

Use `tools: "read,anchor_grep,find,ls"` for read-only children, omit `worktree`, and explicitly prohibit edits, commits, installs, generated artifacts, and further delegation. Have the parent supply any required Git diff, test results, or command evidence within its own restrictions. Do not add `bash` to work around the boundary: `read,bash` can mutate files. This is a model-tool restriction, not a process/extension sandbox; Herdr may still add its child-to-parent `caller_ping` tool.

## Workflow

### 1. Analyze and Decompose

Split the goal into the smallest useful set of outcome-oriented subtasks. Every prompt must include:

- objective and expected behavior
- relevant paths and known context
- allowed files, constraints, and non-goals
- required verification and expected final report
- explicit commit or no-commit instruction
- no further delegation, push, merge, deploy, branch switching, or cleanup unless explicitly authorized

Do not delegate tiny tasks where coordination costs more than direct execution. Never put secrets or unnecessary credentials in a child prompt.

### 2. Decide Concurrency and Checkout Ownership

- Read-only work uses ordinary panes; omit `worktree` entirely (it is an optional object, not a boolean).
- A single or sequential writer may use the parent checkout. Record baseline status/diff for its assigned paths, preserve pre-existing changes, and do not edit those paths while the child works.
- Parallel independent writers require separate managed worktrees with unique branches. Their base is committed `HEAD` unless an explicit committed revision is supplied; uncommitted/untracked parent changes are not copied.
- Dependent tasks, overlapping behavior, shared configuration, generated artifacts, or a common API contract stay sequential. Integrate and verify prerequisites before launching dependent work.
- Only the parent updates shared planning/progress files; isolated worktrees do not coordinate those files automatically.

### 3. Launch

Choose a short task slug. Name children `<task>-<role>[-n]`, using roles `plan`, `research`, `ui`, `api`, `build`, `test`, `review`, `browser`, `security`, `perf`, or `merge`.

Resolve `selectedModel` and `selectedThinking` from the live authenticated catalog before using these illustrative calls; neither is an inherited default.

```typescript
subagent({
  name: "feature-api",
  agent: "worker",
  model: selectedModel,
  thinking: selectedThinking,
  cwd: "/absolute/path/to/project",
  tools: "read,bash,write,replace,insert,anchor_grep,undo_last_change,find,ls",
  task: "<bounded task, allowed files, constraints, tests, report; do not commit>"
});
```

For each parallel independent writer, add a unique managed worktree:

```typescript
subagent({
  name: "feature-ui",
  agent: "worker",
  model: selectedModel,
  thinking: selectedThinking,
  cwd: "/absolute/path/to/project",
  tools: "read,bash,write,replace,insert,anchor_grep,undo_last_change,find,ls",
  worktree: { branch: "feature/ui", base: "<committed-base-sha>" },
  task: "<bounded independent task>; test and commit only the assigned changes. Do not push, merge, switch branches, or remove the worktree."
});
```

Only request a commit when authorized by the user/repository policy. Otherwise require a no-commit handoff and preserve the dirty worktree for parent inspection.

After the final launch, print `name | agent kind | role | model | worktree` and use those names in handoffs. Calls return immediately. Results arrive automatically: continue independent work or end the turn. Do not poll, sleep, tail session files, query progress, or invent results.

Ordinary-pane model fallback lists may be used only with exact authenticated candidates. They retry provider/agent errors, not a completed but inadequate answer. Worktree launches do not support fallback lists.

### 4. Review and Verify

For each returned result:

1. Inspect the report and cited evidence. A completion is a handoff, not proof of success.
2. Compare shared-checkout edits with the recorded baseline. For a worktree, inspect its reported path, base/head SHAs, committed diff, and staged/unstaged/untracked state. `clean` does not mean there are no commits ahead of base.
3. Run focused verification as the parent. For read-only children, check findings and confirm assigned files were not modified.
4. Arrange a separate, cross-family reviewer when useful. Review an existing worktree via ordinary-pane `cwd: "<retained-worktree-path>"`, never by creating another worktree. Supply a pinned inventory and complete diff/before-after evidence, including deleted content, because shell-less reviewers cannot recover Git blobs themselves.
5. Integrate deliberately, one result at a time, and re-run relevant checks. Preserve unrelated parent changes.

For a failed or incomplete task, report the gap and choose one bounded recovery:

- ordinary, non-persistent child: `subagent_resume` with the returned session path and a focused follow-up, only when its stored model is usable
- idle persistent specialist: `subagent_send`; never send while busy, and stop it with `subagent_stop` when done
- worktree child: continue in the retained checkout after the previous process exits; public `subagent_resume` does not reattach it
- unusable model or crashed persistent specialist: preserve evidence and launch a new eligible child, rather than pretending resume changes its model

`subagent_interrupt` cancels the active turn; it does not terminate the process or prove completion. `interactive: true` controls status notifications, not persistence or generic process hosting.

### 5. Cleanup and Report

Ordinary disposable panes close automatically after delivery. Managed worktrees remain. Remove only task-owned worktrees after preserving useful changes and inspecting actual state, using the cleanup command from the result; never force-delete dirty work. Branch cleanup is separate. Do not close user panes or unrelated workspaces.

Report delegated subtasks, files/behavior changed, verification performed, remaining worktrees, and unresolved failures or coverage gaps. Do not dump raw child transcripts.
