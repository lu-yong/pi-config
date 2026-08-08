## Blocking Commands — Use Interactive Shell

Commands that require user input, open a TUI/editor, or are intended to remain running must use `interactive_shell` rather than `bash`.

- Use `mode="hands-free"` when the user should be able to watch or take over.
- Use `mode="dispatch"` for an asynchronous delegated task that can finish without interaction and report back on completion.
- Use `mode="monitor"` for a long-running process when the agent should be notified by specific output, state changes, or file events.
- Use `bash` for ordinary one-shot, non-interactive commands that are expected to terminate on their own.

Prefer explicit non-interactive flags when available. When a Git command may unexpectedly open an editor, scope the override to that single command:

```bash
GIT_EDITOR=true git ...
GIT_SEQUENCE_EDITOR=true git ...
```
