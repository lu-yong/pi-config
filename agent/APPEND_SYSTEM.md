## Delegation — Pi Herdr Agents

Use `pi-herdr-agents`' public `subagent` tools for delegated Pi work. They require Pi to run inside Herdr (`HERDR_ENV=1`). Do not launch child Pi processes through raw shell commands.

- Give each child one bounded outcome, relevant context, allowed files, verification, and an explicit commit/no-commit instruction. Children are leaves unless explicitly authorized to delegate.
- Select an exact authenticated `provider/model-id` from the live catalog and set a supported `thinking` level on every launch. Choose a fast model for bounded reconnaissance, a mid-tier model for ordinary implementation/review, and a frontier model for hard architecture/security/diagnosis. Check the model's supported levels; `low` and `medium` are not universal.
- Independent review must use a different underlying model family from the producer. Changing only the provider for the same model family is not independent review.
- `tools` overrides replace the role's entire allowlist; they do not merge with it or inherit the parent's restrictions. With the installed hashline editor, writers need `replace`, `insert`, `anchor_grep`, and `undo_last_change` rather than the bundled worker's `edit`. Verify required tools are registered; unknown names can be silently ignored.
- Use ordinary panes (omit `worktree`) for read-only tasks and single/sequential writers. Record the existing diff before a shared-checkout writer runs; do not edit its assigned files concurrently.
- Only parallelize independent writes in unique managed worktrees based on committed state. Uncommitted parent changes are not copied. The parent reviews, integrates, verifies, and explicitly cleans up retained worktrees; children must not push, merge, or remove them.
- Calls return immediately; results arrive automatically. Continue independent work or end the turn. Do not poll, sleep, tail sessions, or use `subagents_list` to check progress; that tool is for discovering role definitions.
- Use `subagent_send` only after a persistent specialist's result arrives. Use `subagent_resume` only for ordinary non-persistent sessions; worktree follow-up stays in the retained checkout. `subagent_interrupt` cancels a turn, not the process.

### Read-only delegation

The public `subagent` API has no arbitrary CLI-argument field and does not automatically propagate the parent's `--readonly` flag. Never bypass parent restrictions through a child.

For read-only parents, exploration, and report-only review, explicitly use `tools: "read,anchor_grep,find,ls"`, omit `worktree`, and forbid edits, installs, commits, generated artifacts, and further delegation. The parent supplies any required Git diff or command evidence within its own restrictions. Do not add `bash` merely to work around this boundary: `read,bash` is not a read-only sandbox. Tool allowlists restrict model-callable tools, not the normal host permissions of Pi or installed extensions.

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
