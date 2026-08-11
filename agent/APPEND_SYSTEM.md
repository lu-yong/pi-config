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

## Fast Repository Search

When composing ad-hoc shell commands for repository inspection:

- Prefer `rg` over shell `grep` for text and code searches.
- Prefer `fd` over shell `find` for file or directory discovery.
- Prefer `rg --files` when enumerating repository files.
- Fall back to `grep` or `find` only when their exact semantics are required or when `rg` or `fd` is unavailable.
- Do not mechanically rewrite existing project scripts solely to replace `grep` or `find`.
- Remember that `rg` and `fd` respect ignore files and skip some hidden content by default; adjust flags when the requested search scope requires it.
- This preference applies to shell commands, not to Pi's built-in tools named `grep` and `find`, which are backed by `rg` and `fd`.
