# Pi Agent Context

本上下文记录 pi agent 配置仓库的领域术语（planning-files-runtime 及共享扩展模块）。

## Language

**Goal overlay**：附着在 planning workspace 上、用于记录目标澄清结果并追踪其实施状态的目标记录。
_避免_：goal service、task tracker

**Goal implementation run**：Goal overlay 从 ready 进入 active 后，对同一目标进行的一次连续实施过程；runId 用于区分不同运行。
_避免_：每次命令调用、独立任务

**Continuation**：Goal implementation run 在一次 agent turn 完成后、仍满足继续条件时产生的后续实施步骤。
_避免_：自动重试、后台任务

**Read-only command policy（只读命令策略）**：判定一条 bash 命令是否可以在不改动工作区的前提下执行的唯一策略模块（`agent/extensions/command-policy`）。复合命令逐段判定，解析失败一律 fail-closed。profile 为减法限制：`standard` 为完整只读命令面（readonly-mode 使用），`drafting` 在其上额外禁止网络命令（goal drafting 守卫使用）。
_避免_：命令白名单、bash 校验器
