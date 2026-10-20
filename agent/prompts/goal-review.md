---
name: goal-review
description: Dispatch the local code-reviewer through pi-subagent-manager.
argument-hint: "<goal, commit/range, PR, or working-tree scope>"
---

Act only as the review dispatcher. The `code-reviewer` role owns execution policy; the `code-review` skill owns review criteria and report format. Do not perform the review or implement fixes in the parent.

1. Call `agent_types` and confirm `code-reviewer` is available. If unavailable, report the blocker rather than silently substituting another role.
2. Build `reviewTask` from the full user target/spec, checkout path, explicit commit/range or working-tree scope, available verification evidence, and the `code-review` entry from available skill metadata. If that metadata is missing, report failure and stop. The reviewer gathers Git evidence itself; do not require a parent-prepared diff bundle. Resolve unidentifiable scope before dispatching.
3. Start one fresh reviewer with a unique task-based path outside `/root`, supplying all required context in `reviewTask`. Model and thinking selection come from the effective role and manager settings, not spawn arguments.

	agent_spawn({
	  path: "/goal-review-check",
	  type: "code-reviewer",
	  task: reviewTask,
	  wait: false
	});

Report the thread path and type. Detached results return automatically; continue independent work or end the turn, without polling. A paused thread needs input and `agent_steer` to resume. Retrieve long completed reports with `agent_output`. Present the review unchanged apart from a short preface for failures, drift, or coverage gaps; never invent findings or checks.

## User Review Target

$@
