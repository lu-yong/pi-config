---
name: impl-with-spawn
description: Delegate implementation, fixes, reviews, and multi-step coding work to Pi subagents through interactive_shell. Use for substantial tasks that benefit from decomposition, parallel investigation, or an independent implementation/review pass.
---

# Implement with Pi Subagents

Decompose the user's goal, route each subtask to Pi by default, or to another configured agent when the user explicitly requests it, dispatch the work through `interactive_shell`, then verify and synthesize the results.

## Delegation Interface

All delegated child sessions use structured `spawn`. Keep `worktree` disabled (`worktree: false`) for this workflow so child changes remain in the parent workspace.

```typescript
interactive_shell({
  spawn: {
    agent: "pi",
    prompt: "<self-contained task prompt>",
    worktree: false
  },
  mode: "dispatch",
  background: true,
  reason: "<short subtask label>"
})
```

Keep prompts self-contained. Never place secrets or unnecessary credentials in a child prompt.

## Read-Only Propagation

When the parent session is in read-only mode:

- delegate only exploration, planning, and review work
- repeat the no-write constraint in the child prompt
- never use a subagent to bypass the parent session's write restrictions

Example:

```typescript
interactive_shell({
  spawn: {
    agent: "pi",
    prompt: "Explore the authentication flow. Do not modify files."
  },
  mode: "dispatch",
  background: true,
  reason: "Explore authentication flow"
})
```
The read-only example relies on the workflow-level `worktree: false` requirement above.

## Workflow

### 1. Analyze and Decompose

Split the goal into the smallest useful set of outcome-oriented subtasks. Each prompt must include:

- objective and expected behavior
- relevant paths and known context
- constraints and non-goals
- required verification
- expected final report

Do not delegate tiny tasks where coordination costs more than direct execution.

### 2. Decide Concurrency

Use parallel dispatch only when subtasks:

- have no output dependency
- own disjoint files or are read-only
- cannot invalidate each other's assumptions

If agents may edit the same files, shared configuration, generated artifacts, or a common API contract, run them sequentially. Group mixed work into dependency tiers and parallelize only within a safe tier.

### 3. Dispatch

Default to headless dispatch for finite delegated tasks:

```typescript
interactive_shell({
  spawn: {
    agent: "pi",
    prompt: "<task>",
    worktree: false
  },
  mode: "dispatch",
  background: true,
  reason: "<subtask>"
})
```

Use foreground `dispatch` when the user should see the overlay but does not need ongoing guidance. Use `hands-free` when the user may want to monitor progress, intervene, or provide incremental guidance. Dispatch completion notifications are automatic; do not poll pending dispatch sessions.

For independent subtasks, issue the `interactive_shell` calls together. Give every run a distinct `reason` and a self-contained prompt.
Before dispatching a write-enabled task in a parent workspace with pre-existing changes, record the baseline status and diff for the task's assigned paths. Use that baseline when reviewing the result and preserve unrelated changes.

### 4. Review Results

For every completed run:

1. inspect the reported changes and important output
2. if the run was write-enabled, review the actual diff against the recorded baseline; for a read-only run, review the findings and verify that no files were modified
3. run focused verification in the parent session
4. retry with a focused follow-up if the run failed or remained inadequate
5. after completion, clean up temporary background sessions created by the task

A subagent completion is evidence, not proof. The parent agent remains responsible for correctness and integration.

### 5. Report

- which subtasks were delegated
- files or behavior changed
- verification performed
- unresolved risks or failed runs
Do not dump raw child transcripts unless the user requests them.
