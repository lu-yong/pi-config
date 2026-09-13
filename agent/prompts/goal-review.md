---
name: goal-review
description: Prepare review evidence and dispatch the local code-reviewer role through Herdr.
argument-hint: "<goal, commit/range, PR, or working-tree scope>"
---

Act only as the review dispatcher. The `code-reviewer` role owns execution policy; the `code-review` skill owns review criteria and report format. Do not perform the review or implement fixes in the parent.

1. Require `subagent` and `HERDR_ENV=1`. Resolve the effective `code-reviewer` definition and confirm it loads `code-review` as a read-only leaf; project roles can override the global role. If unavailable or incompatible, report the blocker instead of using a shell or silently substituting the package's generic `reviewer`.
2. Load `code-review` for its scope/preflight rules only. Prepare the full user target/spec, canonical checkout path, exact base/head SHAs, explicit staged/unstaged/untracked scope, complete inventory and diff (including deleted and in-scope untracked content), and available verification evidence. Stay read-only within the parent's restrictions; inline evidence is valid. Clarify unidentifiable scope, reject invalid fixed points, and never silently truncate evidence.
3. Choose an exact authenticated model and a supported thinking level under the delegation policy. Independent review requires a different underlying family from the producer; disclose unknown authorship or unavailable independent coverage. Resolve `selectedModel`, `selectedThinking`, `reviewCwd`, and `reviewTask` from this preflight.

Launch one ordinary-pane child. Let the role supply `skills` and lifecycle defaults; retain the explicit read-only tool boundary and omit `worktree`/`fork`:

```typescript
subagent({
  name: "goal-review-review",
  agent: "code-reviewer",
  model: selectedModel,
  thinking: selectedThinking,
  cwd: reviewCwd,
  tools: "read,anchor_grep,find,ls",
  task: reviewTask
});
```

Print `name | agent kind | role | model | worktree`. Results arrive automatically: continue independent work or end the turn; do not poll or query progress. Recheck the pinned state before presenting the review unchanged, apart from a short preface for model identity, failures, drift, or coverage gaps. Recover a truncated completed report once from its returned session path or disclose the missing coverage; never invent findings or checks.

## User Review Target

$@
