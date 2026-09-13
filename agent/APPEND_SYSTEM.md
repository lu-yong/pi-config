## Local Delegation Policy

Use `pi-herdr-agents`' own tool guidance for delegation, model selection, asynchronous delivery, and worktree lifecycle. Keep local policy limited to this environment's differences:

- Reuse package roles unless a task calls for a purpose-specific local role. Local `code-reviewer` uses the `code-review` skill; it does not replace the package's generic `reviewer`.
- For a write-enabled bundled `worker` in this hashline environment, supply `tools: "read,bash,write,replace,insert,anchor_grep,undo_last_change,find,ls"` instead of its `edit` defaults. Tool overrides replace the whole list; other specialists must retain their required registered capabilities without exceeding the parent's restrictions.
- The local `--readonly` flag does not automatically propagate to children. For a read-only parent, exploration, or report-only review, explicitly restrict tools to `read,anchor_grep,find,ls` and prohibit writes, installs, commits, generated artifacts, and further delegation. Never use a child to bypass the parent's restrictions.
- Supply required Git or command evidence to shell-less children within the parent's restrictions; `/goal-review` prepares this evidence for `code-reviewer`. Do not add `bash` merely to bypass a read-only boundary. Tool allowlists are not a process/extension sandbox.

## Blocking Commands — Use Herdr Panes

Use `bash` for ordinary one-shot, non-interactive commands that terminate on their own. For user input, an editor/TUI, or a long-running ordinary process, use a dedicated Herdr terminal pane rather than blocking the parent shell.

- Verify `HERDR_ENV=1` and the installed CLI syntax (`herdr --help`, `herdr pane`) before controlling panes. Preserve cwd and focus: use `--current` or an explicit pane ID and `--no-focus`; never target whichever pane happens to be focused.
- Parse the new pane ID from the creation response, then use `herdr pane run <pane-id> <command>`. These one-shot control commands may run through `bash`; the actual interactive/long-running command stays in the pane.
- Report the pane ID, actual startup/readiness evidence, and how to stop the process. Only close panes created for this task, after their work is no longer needed.
- A terminal server is not a subagent task. Do not substitute `subagent({ interactive: true })`: `interactive` controls status notifications, not generic process hosting or automatic shutdown.
- If Herdr or the required tool is unavailable, explain the limitation and give a manual terminal command or perform only the safe local portion. Do not invent a replacement tool or silently use `nohup`/background shell jobs.

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
