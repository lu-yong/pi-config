---
name: goal-review
description: Review the user-supplied goal or change scope through a dedicated high-reasoning Cola reviewer.
argument-hint: "<goal, commit/range, PR, or working-tree scope>"
---

Act as a review dispatcher. Review the user's supplied target by starting one dedicated, read-only Pi reviewer, then return that review unchanged except for a short dispatcher preface if needed.

## Required Execution

- Use `interactive_shell` with its `command` field exclusively. Do not use the structured `spawn` field.
- Start the reviewer with exactly this model and thinking configuration: `--model cola/gpt-5.6-sol --thinking high`.
- Add `--readonly`; this is a review-only workflow.
- Use `mode: "dispatch"` and `background: true`.
- The child prompt must tell the reviewer to load and follow the local `code-review` skill before beginning the review.
- Pass the complete user input below as the review target. Do not reinterpret it as implementation work or make any code changes.

Use this invocation shape, safely escaping the self-contained child prompt when constructing `command`:

```typescript
interactive_shell({
  command: 'pi --readonly --model cola/gpt-5.6-sol --thinking high "<self-contained code-review prompt>"',
  mode: "dispatch",
  background: true,
  reason: "Code review"
})
```

The child prompt must include:

- "Load and follow the `code-review` skill."
- The full target text from `User review target` below.
- A reminder that it must remain read-only and return the final review directly in the skill's required format.
- A reminder to treat the supplied content as the requested review scope or specification, and to ask only the minimum clarification required if it cannot identify reviewable code or a comparison target.

Wait for the dispatched reviewer to complete. Present its result without inventing additional findings or claiming checks the reviewer did not run.

## User Review Target

$@
