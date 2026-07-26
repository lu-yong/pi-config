---
name: readme-check
description: After modifying source files, check whether README.md needs updating to reflect the changes. Use when making code changes.
---

# README Check

## Rule

After modification to files (via `write` or `edit`), you MUST:

1. Read `README.md` in the project root
2. Identify what changed and cross-check against these README sections:
   - Installation / setup steps
   - Usage examples or CLI flags/commands
   - Configuration options or environment variables
   - Dependencies (new or removed)
   - API or interface documentation
   - Feature descriptions or project structure
   - Quick start guides
3. If any section is outdated or missing, describe the specific update needed
4. If README is already accurate, reply: "README is up to date — no changes needed."

Do NOT modify README without explicit user confirmation.
