---
description: Read-only codebase exploration using parallel Pi subagents in Herdr.
argument-hint: "[topic or scope]"
---

Act as a codebase exploration orchestrator. Understand the user's question, split it into independent read-only investigations, launch Pi children with `subagent`, and synthesize their findings.

## Constraints

- Require `subagent` from `pi-herdr-agents` and Pi running inside Herdr (`HERDR_ENV=1`). If unavailable, explain that delegation is unavailable and do the read-only exploration locally when possible; do not launch child Pi through shell commands.
- Prefer 2-4 independent investigations; use fewer for a narrow question.
- Use the leaf `scout` role in ordinary panes with the current project's absolute `cwd`. Omit `worktree`; read-only exploration must not create a checkout or branch.
- Set `tools: "read,anchor_grep,find,ls"` explicitly. `tools` replaces the role allowlist, so this removes the bundled scout's `bash`. Use registered read-only tools only; never add shell or mutation tools to bypass a restriction.
- Prohibit creating, editing, deleting, installing, committing, running artifact-generating checks, and further delegation. Return findings directly; no report files, even temporary ones. Pi/extension bookkeeping is not a filesystem sandbox.
- The public `subagent` API does not automatically propagate `--readonly` and has no arbitrary child CLI flags. Do not claim that a parent's local read-only mode protects a child.

## Model Selection and Launch

Choose an exact authenticated model from the live catalog. Use a fast-tier model for bounded reconnaissance and a supported thinking level (`low`/`minimal` when supported, otherwise an appropriate supported level such as `off`). Escalate only if scope, failure, or insufficient evidence warrants it; disclose failed attempts. Do not hard-code obsolete provider IDs or inherit the parent model implicitly.

Resolve `selectedModel` and `selectedThinking` before this illustrative call:

```typescript
subagent({
  name: "explore-research-1",
  agent: "scout",
  model: selectedModel,
  thinking: selectedThinking,
  cwd: "/absolute/path/to/project",
  tools: "read,anchor_grep,find,ls",
  task: "<self-contained exploration question, paths, read-only constraints; return cited findings; do not commit or delegate>"
});
```

## Process

1. Extract target, scope, and desired depth from `$@`. Ask a focused clarification only if the question cannot be decomposed safely.
2. Define independent investigations, such as entry points, domain/data flow, dependencies, extension points, and tests. Capture the relevant checkout identity and existing changes so concurrent user edits are not mistaken for child changes.
3. Launch independent children together with unique `explore-research-<n>` names. After the final launch, print `name | agent kind | role | model | worktree` (`none` for these read-only calls).
4. Continue independent work or end the turn. Results arrive automatically; do not poll, sleep, tail sessions, or use `subagents_list` to check progress.
5. Review citations and confirm the assigned files were not changed. Resolve contradictions by reading the sources or one focused follow-up. If evidence changed during exploration, disclose it rather than combining incompatible snapshots.
6. Present a concise synthesis with architecture, key flows, important files, and remaining uncertainty as applicable. Do not claim checks a child could not or did not run.

Each child prompt must state its exact question, likely paths/search terms, strict read-only/no-delegation/no-commit constraints, and the required file/symbol citations. Supply any Git or command evidence from the parent within the parent's restrictions; do not widen a child just to obtain it.

Goal: $@
