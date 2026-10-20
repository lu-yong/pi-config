---
name: impl-with-spawn
description: Decompose substantial implementation goals, choose suitable Pi subagent roles for each task, coordinate dependencies, and verify and integrate their results.
disable-model-invocation: true
---

# Implement with Pi Subagents

Act as the parent orchestrator. Understand the goal, split it into tasks, select suitable roles, coordinate execution, and accept the combined result. Follow `pi-subagent-manager` guidance for thread paths, context inheritance, model selection, asynchronous delivery, and recovery.

## 1. Scope and Build the Task Graph

- Establish the outcome, acceptance criteria, constraints, and non-goals. Do tiny tasks directly when delegation adds no value.
- Split substantial work into bounded investigation, design, implementation, verification, and review outcomes. Record dependencies and file ownership; keep shared planning updates in the parent.
- Obey the parent's read-only restrictions. Do not assume they automatically constrain child tools.

## 2. Select a Role for Each Task

- Call `agent_types` before choosing types. Use `researcher` for investigation, `architect` for design, `coder` for implementation, `tasker` for small jobs, `reviewer` for generic review, and local `code-reviewer` for the `code-review` method when suitable.
- Respect effective project/global definitions and leaf/coordinator boundaries. Report a capability gap rather than inventing a type.
- Models, thinking levels, and tool policies come from role definitions and manager settings. `agent_spawn` has no per-call model, thinking, tools, cwd, or worktree arguments.

## 3. Prepare and Dispatch

- Give each child a bounded objective, relevant context and skill metadata, allowed files, constraints, acceptance checks, commit/no-commit authorization, and expected handoff. Do not include secrets or authorize unrelated work.
- Use task-based kebab-case paths. A path below `/root` inherits that lexical parent's conversation; an independent root starts fresh and needs a self-contained task.
- Agents share the current working directory. Record baseline status/diff before writers. Keep dependent or overlapping writes sequential; parallelize only independent work with clear ownership. Do not assume automatic worktree isolation or uncommitted prerequisites in another checkout.

For each subtask, resolve `taskPath`, `selectedType`, and `taskPrompt` from the task graph:

	agent_spawn({
	  path: taskPath,
	  type: selectedType,
	  task: taskPrompt,
	  wait: false
	});

Launch all independent siblings before waiting. Detached completion returns automatically; continue independent work or end the turn instead of polling. Use `agent_wait` when the result is needed now, and `agent_steer` to supply input or resume retained threads. A reporting timeout does not stop the child.

## 4. Verify, Review, and Integrate

1. Inspect each child's evidence against its outcome. Verify actual writer changes and read-only boundaries; a success message is not acceptance. Use `agent_output` for long final reports.
2. Compare committed/staged/unstaged/untracked changes with the baseline and run parent-side acceptance checks. Child verification does not validate the whole assembled result.
3. Select review roles for the rubric and risk. For `code-review`, use the [goal-review dispatcher](../../prompts/goal-review.md) to pass scope and available skill metadata to `code-reviewer`; the reviewer can gather its own Git evidence.
4. Return incomplete work through `agent_steer` for focused correction. Paused threads need input; completed or stopped threads retain their session. Do not assume failed tasks changed nothing.
5. Integrate accepted results in dependency order and re-run relevant checks. Preserve unrelated work; clean up task-owned resources only after useful state is preserved.

Report task-to-role mapping, delivered outcomes, verification, unresolved gaps, and retained threads. Do not claim completion while required acceptance or review remains unresolved.
