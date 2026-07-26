---
name: commit-changes
description: Stage and commit current changes. Use when the user wants to commit, asks to submit changes, or after readme-check finishes.
---

# Commit Changes

将当前未暂存的修改统一提交。

## Step 1: 查看变更

```bash
git status --short
git diff --stat
```

## Step 2: 生成 commit message

根据改动内容生成符合 [Conventional Commits](https://www.conventionalcommits.org/) 规范的中文提交信息：

```
<type>(<scope>): <简短描述>

<详细说明（可选）>
```

type: `feat` | `fix` | `docs` | `refactor` | `chore`

将生成的 message 展示给用户确认。

## Step 3: 确认提交范围

询问用户提交范围：
- 全部修改：`git add -A`
- 部分文件：`git add <files>`

以用户选择为准。

## Step 4: 执行提交

用户确认 message 和范围后：

```bash
git add <files>
git commit -m "<message>"
git log --oneline -1
```

**完成标准：** commit 执行成功，hash 已反馈给用户。

未经用户确认，不得执行 `git commit`。
