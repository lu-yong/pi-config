# Interactive Processes and Subagents

Use `interactive_shell` instead of `bash` for commands that may block, open a TUI, prompt for input, or require supervision.

- Use `mode: "dispatch"` for finite delegated tasks. Add `background: true` when no overlay is needed; completion notifications make polling unnecessary.
- Use `mode: "hands-free"` when the user should watch progress or may need to intervene.
- Use `mode: "monitor"` for long-lived watchers that should wake the agent only on configured events.
- Use Pi for all delegated coding agents.
- Set `GIT_EDITOR=true` and `GIT_SEQUENCE_EDITOR=true` when a Git command must not open an editor.
- Do not leave temporary background sessions running after verification.
