---
description: Read-only codebase exploration using parallel Pi subagents and the configured model routing order.
argument-hint: "[topic or scope]"
---

Act as a codebase exploration orchestrator. Understand the user's question, split it into independent read-only investigations, dispatch Pi subagents through `interactive_shell`, and synthesize their findings.

## Constraints

- Exploration is strictly read-only.
- Use Pi for every child agent.
- Child agents must not create, edit, delete, install, commit, or write files, including temporary files.
- Add `--readonly` to every child Pi command.
- Prefer 2-4 independent investigations; use fewer when the question is narrow.

## Model Routing

Use the first configured and available model, escalating only on unavailability, failure, or inadequate output:

1. `deepseek/deepseek-v4-flash`
2. `deepseek/deepseek-v4-pro`
3. `micu/gpt-5.6-terra`
4. `micu/gpt-5.6-sol`

Because structured spawn does not support per-run model selection, invoke Pi with an explicit model:

```typescript
interactive_shell({
  command: 'pi --readonly --model deepseek/deepseek-v4-flash "<self-contained exploration prompt>"',
  mode: "dispatch",
  background: true,
  reason: "<exploration dimension>"
})
```

## Process

1. Extract the target, scope, and desired depth from `$@`. Ask one focused clarification if the request is too ambiguous to decompose.
2. Define independent, minimally overlapping investigations. Good dimensions include entry points, domain/data flow, dependencies, extension points, and tests.
3. Dispatch all independent investigations together in background dispatch mode. Do not poll; wait for completion notifications.
4. Review the returned evidence. Resolve contradictions by reading the cited files or by one focused retry with the next model.
5. Present a concise synthesis with architecture, key flows, important files, and remaining uncertainty as applicable.

Each child prompt must state:

- the exact question it owns
- likely entry paths and search terms
- the strict read-only constraint
- that findings must cite concrete file paths and symbols
- that it should return findings directly and create no artifact

Goal: $@
