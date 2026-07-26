---
name: readme-check
description: Check README for drift after code changes. Use when the user modifies source files, finishes a feature, or mentions README drift / README sync.
---

# README Drift Check

## Phase 1: 检查漂移

代码修改完成后，检查 `README.md` 是否与当前代码一致：

1. 阅读项目根目录的 `README.md`
2. 找出本次修改涉及的内容，对照 README 逐项检查：
   - 安装/配置步骤是否仍然准确
   - 使用示例、CLI 命令、API 接口是否匹配
   - 环境变量、配置项是否有新增或移除
   - 依赖项列表是否同步
   - 功能描述、项目结构是否反映当前状态
   - 快速开始指南是否仍然可运行
3. 逐条列出漂移：引用 README 中过时的具体行，并指出导致漂移的代码变更（文件 + 行号）；若 README 缺失内容，指出应插入的位置
4. 若 README 已与代码一致，回复："README 与代码一致，无需更新。"

**完成标准：** 每个受影响的 README 章节，要么给出了行级更新建议（过时内容 + 变更来源），要么确认该章节无需更新。

未经用户确认，不得修改 README。

## Phase 2: 同步 README

用户确认需要更新后：
1. 用 `edit` 精确修改 README.md 中的相关章节
2. 修改完成后告知用户更新摘要

## Phase 3: 提交

README 同步完成后（或 Phase 1 确认无需更新后），调用 `commit-changes` 将 README 与本次代码修改一起提交。
