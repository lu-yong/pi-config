---
name: impl-with-spawn
description: Delegate implementation, fixes, reviews, and multi-step coding work to Pi subagents through interactive_shell. Use for substantial tasks that benefit from decomposition, parallel investigation, or an independent implementation/review pass.
---

# Implement with Pi Subagents

Decompose the user's goal, route each subtask to a Pi model, dispatch the work through `interactive_shell`, then verify and synthesize the results. Use Pi for every delegated coding task.

## Model Routing

Use this strict priority order:

| Priority | Model |
|---|---|
| 1 | `deepseek/deepseek-v4-flash` |
| 2 | `deepseek/deepseek-v4-pro` |
| 3 | `micu/gpt-5.6-terra` |
| 4 | `micu/gpt-5.6-sol` |

Start with the first configured and available model. Move to the next model only when the prior model is unavailable, the run fails, or its result remains inadequate after one focused follow-up. Do not skip ahead unless the user explicitly requests a model.

CRITICAL: `command` and `spawn` are mutually exclusive. Provide exactly one, never both. If you use `command`, do not add `spawn`. If you use `spawn`, do not add `command`.

Structured spawn cannot select a different Pi model per call. For routed work, use only `command` with the full provider/model ID:

```typescript
interactive_shell({
  command: 'pi --model deepseek/deepseek-v4-flash "<self-contained task prompt>"',
  mode: "dispatch",
  background: true,
  reason: "<short subtask label>"
})
```

Shell-quote generated prompts correctly. Never place secrets or unnecessary credentials in a child prompt.

## Read-Only Propagation

When the parent session is in read-only mode:

- delegate only exploration, planning, and review work
- add `--readonly` to every child Pi command
- repeat the no-write constraint in the child prompt
- never use a subagent to bypass the parent session's write restrictions

Example:

```typescript
interactive_shell({
  command: 'pi --readonly --model deepseek/deepseek-v4-flash "Explore the authentication flow. Do not modify files."',
  mode: "dispatch",
  background: true,
  reason: "Explore authentication flow"
})
```

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
  command: 'pi --model deepseek/deepseek-v4-flash "<task>"',
  mode: "dispatch",
  background: true,
  reason: "<subtask>"
})
```

Use foreground `dispatch` when the user should see the overlay. Use `hands-free` only when intervention or incremental guidance is expected. Dispatch completion notifications are automatic; do not poll dispatch sessions.

For independent subtasks, issue the `interactive_shell` calls together. Give every run a distinct `reason` and a self-contained prompt.

### 4. Review Results

For every completed run:

1. inspect the reported changes and important output
2. review the actual diff instead of trusting the summary
3. run focused verification in the parent session
4. retry with the next routed model if the run failed or remained inadequate
5. clean up temporary background sessions

A subagent completion is evidence, not proof. The parent agent remains responsible for correctness and integration.

### 5. Report

Summarize:

- which subtasks were delegated and to which models
- files or behavior changed
- verification performed
- unresolved risks or failed runs

Do not dump raw child transcripts unless the user requests them.
