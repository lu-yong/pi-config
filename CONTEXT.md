# Pi Agent Context

本上下文记录 pi agent 配置仓库的领域术语（planning-files-runtime 及共享扩展模块）。

## Language

**Goal overlay**：附着在 planning workspace 上、用于记录目标澄清结果并追踪其实施状态的目标记录。
_避免_：goal service、task tracker

**Goal implementation run**：Goal overlay 从 ready 进入 active 后，对同一目标进行的一次连续实施过程；runId 用于区分不同运行。
_避免_：每次命令调用、独立任务

**Goal lifecycle**：承载 Goal overlay 完整生命周期策略的模块（`agent/extensions/planning-files-runtime/goal-lifecycle.ts`）——状态转换、效果执行与回滚、Continuation 决策与运行结果投影。Pi 适配层只表达生命周期事件，不接触内部效果词汇。
_避免_：goal service、run controller

**Continuation**：Goal implementation run 在一次 agent run 落定前（Pi 的 `agent_before_settle` 边界）、仍满足继续条件时产出的后续实施步骤；由 Pi 核心调度下一次模型请求，扩展只返回决策数据。
_避免_：自动重试、后台任务

**Read-only command policy（只读命令策略）**：判定一条 bash 命令是否可以在不改动工作区的前提下执行的唯一策略模块（`agent/extensions/command-policy`）。复合命令逐段判定，解析失败一律 fail-closed。profile 为减法限制：`standard` 为完整只读命令面（readonly-mode 使用），`drafting` 在其上额外禁止网络命令（Drafting guard 使用），网络命令清单由 `NETWORK_COMMANDS` 导出供话术同源引用。
_避免_：命令白名单、bash 校验器

**Drafting guard（草拟守卫）**：goal drafting 阶段裁决 write/edit/bash 工具调用的唯一守卫模块（`agent/extensions/planning-files-runtime/guards.ts` 的 `gateDraftingToolCall`）——drafting 状态判断、planning 目录判定、bash 委托 Read-only command policy 的 drafting profile，以及全部拒绝话术都在其后。Pi 适配层只转发它的判决。
_避免_：工具拦截器、hook 校验

**Planning workspace（规划工作区）**：持有 planning 文件格式全部知识（模板、标题名、解析、追加、完结、归档）的唯一深模块（`agent/extensions/planning-files-runtime/workspace.ts`）。调用方只见语义操作，不见 markdown 格式；Goal lifecycle 的效果执行委托它落盘。
_避免_：markdown 工具集、文件助手
