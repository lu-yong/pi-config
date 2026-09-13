---
name: impl-with-spawn
description: Decompose substantial implementation goals, choose suitable Pi subagent roles for each task, coordinate dependencies, and verify and integrate their results.
disable-model-invocation: true
---

# Implement with Pi Subagents

Act as the parent orchestrator, not a wrapper around one worker. Preserve the full workflow: understand the goal, split it into tasks, select appropriate roles, coordinate execution, and accept the combined result. Use `pi-herdr-agents`' own guidance for tool mechanics, model routing, asynchronous delivery, recovery, and worktree lifecycle.

## 1. Scope and Build the Task Graph

- Confirm the requested outcome, acceptance criteria, constraints, and non-goals. Do tiny tasks directly when delegation adds no value.
- Split substantial work into bounded outcomes. Identify investigation, design/decision, implementation, verification, and review needs rather than treating every subtask as coding.
- Record dependencies, read-only versus writing tasks, and file ownership. Keep shared planning/progress updates in the parent.
- In a read-only parent session, stop at investigation/review and obey the local read-only delegation policy.

## 2. Select a Role for Each Task

- Discover the effective available roles when needed and inspect their responsibilities/capabilities. Choose a suitable role separately for each subtask; do not default the entire task graph to `worker`.
- Typical fits include `scout` for code investigation, `worker` for a defined implementation, `reviewer` for generic review, and local `code-reviewer` for the `code-review` method. These are examples, not a closed list; use another available specialist when it better matches the task.
- Reuse package roles rather than creating local copies just to dispatch work. Respect project/global overrides and the extension's leaf/coordinator policy. Report a capability gap instead of inventing a role.
- Select an exact authenticated model and supported thinking level for each chosen role/task under the extension's routing guidance. Do not assume every child needs the same model.

## 3. Prepare and Dispatch

- Each child receives its selected role, bounded objective, context, allowed files, constraints, acceptance/verification requirements, commit/no-commit authorization, and expected handoff. Do not include secrets or authorize unrelated work.
- Derive the effective tool list from the selected role and local policy: apply installed-editor compatibility to writing tasks and explicit read-only limits where required. Tool overrides replace the whole list; preserve other required specialist capabilities without widening parent restrictions.
- Keep dependent or overlapping writes sequential. Use ordinary panes for read-only tasks and single/sequential writers; only genuinely independent parallel writers need separate managed worktrees under the tool's rules.
- Record baseline status/diff before a shared-checkout writer and avoid concurrent edits to its assigned files. Never assume uncommitted prerequisites are available in a new worktree.

Resolve the variables below for **each subtask** from the role selection and task graph; `selectedRole` is not fixed to `worker`:

```typescript
subagent({
  name: taskName,
  agent: selectedRole,
  model: selectedModel,
  thinking: selectedThinking,
  cwd: selectedCheckout,
  tools: selectedTools,
  task: taskPrompt
});
```

Add a unique `worktree` only for an eligible independent writing task. Follow the extension's naming/reporting and automatic-result-delivery rules. Do independent work or end the turn after launching.

## 4. Verify, Review, and Integrate

1. Inspect every role's returned evidence against its assigned outcome. Verify actual changes for writers and the no-write boundary for read-only tasks; a success message is not acceptance.
2. Compare committed/staged/unstaged/untracked changes with the recorded baseline and run parent-side acceptance/integration checks. Child verification covers its task, not the whole assembled result.
3. Choose review roles to match the requested rubric and risk. For the local `code-review` method, use the [goal-review dispatcher](../../prompts/goal-review.md) to prepare scope/evidence and launch `code-reviewer`; generic or specialized reviews may use other suitable roles. Review retained results in their existing checkout, without creating a new worktree for review.
4. Return incomplete work for a focused correction using an appropriate role and the extension's recovery mechanism, or report the blocker. Do not assume failed tasks changed nothing.
5. Integrate accepted results in dependency order, synthesize investigation/review findings, and re-run relevant checks. Preserve unrelated work and clean up task-owned resources only after useful state is preserved.

Report the task-to-role mapping, delivered outcomes, verification, unresolved gaps, and retained workspaces. Do not claim completion while an acceptance criterion or required review remains unresolved.
