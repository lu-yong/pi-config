# Pi Coding Agent 配置

本仓库记录了 [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 的配置文件及插件/扩展安装情况。

## 安装的插件（Packages）

以下插件通过 `settings.json` 的 `packages` 字段安装；每个插件的完整安装命令如下：

| 包 | 用途 | Pi 安装命令 |
|---|---|---|
| `pi-web-access` | 网络搜索与网页内容抓取 | `pi install npm:pi-web-access` |
| `pi-open-tui` | 终端用户界面增强 | `pi install npm:pi-open-tui` |
| `@tmustier/pi-files-widget` | TUI 文件浏览器 | `pi install npm:@tmustier/pi-files-widget` |
| `pi-herdr-agents` | 在 Herdr pane 中异步运行 Pi 子 agent，自动回传结果，支持持久专家和隔离 worktree | `pi install npm:pi-herdr-agents` |
| `pi-hashline-edit-pro` | 使用 3 字符 hash 锚点执行安全、抗过期上下文的文件编辑 | `pi install npm:pi-hashline-edit-pro` |
| `pi-observational-memory` | 跨 compaction、交接和长期会话保存工作记忆 | `pi install npm:pi-observational-memory` |
| `@firstpick/pi-themes-bundle` | 提供多套熟悉的浅色和深色主题 | `pi install npm:@firstpick/pi-themes-bundle` |

### 网络搜索配置（`web-search.json`）

`web-search.json` 当前默认使用 Tavily，并在搜索后打开摘要审阅界面：

```json
{
  "provider": "tavily",
  "workflow": "summary-review"
}
```

使用 Clash、Mihomo 等 TUN/fake-IP 代理时，公网域名可能解析到合成保留地址段。可通过 `ssrf.allowRanges` 添加最小范围的白名单，使搜索和抓取通过 SSRF 地址校验。API Key 不应写入版本控制。

## 扩展（Extensions）

`agent/extensions/` 下的 `*.ts` 和 `*/index.ts` 会被 Pi 自动发现并全局加载；不需要再在 `settings.json` 中重复声明。

### Provider 扩展

| 扩展 | Base URL | API Key | 模型 |
|---|---|---|---|
| `anyrouter-provider` | `https://anyrouter.top/v1`；Claude 使用 `https://anyrouter.top` | `$ANYROUTER_API_KEY` | `gpt-5.6-sol`、`claude-fable-5`、`claude-opus-5` |
| `cola-provider` | `https://code28.ccwu.cc/v1` | `$COLA_API_KEY` | `gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol` |
| `micu-provider` | `https://www.micuapi.ai/v1` | `$MICU_API_KEY` | `gpt-5.6-terra`、`gpt-5.6-sol` |
| `micu-xai-provider` | `https://www.micuapi.ai/v1` | `$MICU_XAI_API_KEY` | `grok-4.6` |

OpenAI 模型使用 `openai-responses`，AnyRouter 的 Claude 模型使用 `anthropic-messages`。前三个 provider 的 GPT 模型统一配置为 1,050,000 token 上下文窗口和 128,000 token 最大输出；Micu xAI 的 Grok 4.6 配置为 500,000 token 上下文窗口和 128,000 token 最大输出。实际限制仍以服务端为准。

### readonly-mode

- **文件**：`agent/extensions/readonly-mode/`
- **功能**：本地核心工具只读模式，阻止 `edit`、`write`、`replace` 和 `undo_last_replace`，并对 `bash` 采用 fail-closed 检查。
- **使用方式**：`pi --readonly`、`/readonly`、`Ctrl+Alt+R`
- **范围**：MCP、技能和其他自定义工具不在此模式的执行限制范围内；它不是全局无副作用沙箱。
- **测试**：`node --test agent/extensions/readonly-mode/*.test.ts`

### command-policy

- **文件**：`agent/extensions/command-policy/`
- **功能**：共享的只读命令策略（Read-only command policy）——判定一条 bash 命令是否可以在不改动工作区的前提下执行，复合命令逐段判定，解析失败一律 fail-closed。profile 为减法限制：`standard` 为完整只读命令面，`drafting` 在其上额外禁止网络命令（`curl`、`wget`、`ping`、`nslookup`、`traceroute`、`whois`、`host`）。
- **说明**：非独立扩展（无 `index.ts`，不会被 Pi 自动加载），由 readonly-mode 与 planning-files-runtime 以相对路径导入。
- **测试**：`node --test agent/extensions/command-policy/*.test.ts`

### planning-files-runtime

- **文件**：`agent/extensions/planning-files-runtime/`
- **功能**：在项目 `.pi/planning/` 中持久化当前计划、发现、进度和目标状态。
- **命令**：`/plan-archive`（agent 空闲时仅归档、不新建模板，且不受目标状态限制）、`/plan-new`、`/plan-goal-set`、`/plan-goal-impl`、`/plan-update`
- **并发限制**：同一项目的 `.pi/planning/` 没有锁或冲突处理，应由单个 Pi 实例写入。

### qna

- **文件**：`agent/extensions/qna/`
- **功能**：普通 TUI 对话在 agent settled 后自动抽取回复中的用户问题，并通过共享 question-taking 界面收集答案；也可手动运行 `/qna`。
- **触发判定**：自动触发前先剥离围栏代码块、行内代码和 URL，再只在净化后文本的**末尾 400 字符**内判定问号，避免 `a ? b : c`、`a?.b`、query string、正文中段的反问句造成误触发。去重指纹仍基于原始回复文本。
- **配置**（`agent/settings.json` 顶层 `qna` 块，缺失/损坏一律安全降级到默认值）：

  | 键 | 默认 | 说明 |
  |---|---|---|
  | `autoExtract` | `true` | 自动触发开关；关掉后 `/qna` 手动入口仍然可用 |
  | `model` | 未设置 | 抽取用的廉价模型 `{ provider, id, thinking }`。未配置时静默使用主模型；已配置但解析不出或取不到 API key 时回退到主模型**并提示**。`thinking` 取 `minimal`/`low`/`medium`/`high`/`xhigh`/`max`，非法值保留该模型但丢弃 thinking 并提示 |

- **目标模式限制**：当 planning-files-runtime 的 goal 状态为 `active` 时，自动 Q&A 被抑制，手动 `/qna` 会提示先暂停或完成目标，避免打断目标的自动 continuation。
- **测试**：`node --test agent/extensions/qna/*.test.ts`

### readme-check

- **文件**：`.pi/extensions/readme-check.ts`
- **范围**：仅在本配置仓库（`~/.pi`）中作为项目扩展加载。
- **功能**：追踪 `write`、`edit`、`replace` 和 `undo_last_replace` 修改，并在 agent settled 后提醒检查 README 是否漂移。

## 模型提供商（Providers）

### 已启用的模型（`settings.json` 中 `enabledModels`）

| 模型 ID | 来源 |
|---|---|
| `anyrouter/gpt-5.6-sol` | AnyRouter 扩展 |
| `anyrouter/claude-fable-5` | AnyRouter 扩展 |
| `anyrouter/claude-opus-5` | AnyRouter 扩展 |
| `deepseek/deepseek-v4-pro` | DeepSeek provider |
| `deepseek/deepseek-v4-flash` | DeepSeek provider |
| `micu/gpt-5.6-sol` | Micu AI 扩展 |
| `micu/gpt-5.6-terra` | Micu AI 扩展 |
| `cola/gpt-5.6-sol` | Cola AI 扩展 |
| `cola/gpt-5.6-luna` | Cola AI 扩展 |
| `cola/gpt-5.6-terra` | Cola AI 扩展 |
| `micu-xai/grok-4.6` | Micu xAI 扩展 |

直连 DeepSeek 的 `deepseek-v4-flash` 和 `deepseek-v4-pro` 由 `agent/models.json` 覆盖为 `openai-responses`，使用 `https://api.deepseek.com/responses`。DeepSeek API Key 继续通过既有认证配置或 `$DEEPSEEK_API_KEY` 提供。

provider 扩展中的 API Key 均通过环境变量注入；`agent/models.json` 保存本地模型/provider 配置覆盖。

## 安装的技能（Skills）

当前 `~/.pi/agent/skills/` 目录下的技能（包括软链接）都会被 Pi 加载，以下为完整列表：

| 技能名称 | 用途 |
|---|---|
| `adb` | Android Debug Bridge 设备检查、AOSP/vendor bring-up、HAL 调试、日志收集、文件传输和设备操作 |
| `code-review` | 从规格、规范/设计、安全/可靠性三个独立维度，对提交和工作区变更进行基于证据的代码审查，并明确测试覆盖 |
| `commit-bu1-sdk-gerrit` | 按 BU1-SDK 规则提交 Nationalchip Gerrit review |
| `domain-modeling` | 构建和完善项目领域模型、术语与决策记录 |
| `grill-with-docs` | 结合文档通过质询完善计划或设计 |
| `grilling` | 对计划或设计进行全面压力测试 |
| `handoff` | 将当前会话整理成交接文档供其他 agent 继续工作 |
| `herdr` | 用户明确要求时，通过 Herdr CLI 检查/控制 pane、tab、workspace 和普通终端进程（本地软链接） |
| `impl-with-spawn` | 父 agent 的实现编排：拆分任务、按需选择角色、排序、派发、验证与整合；仅显式调用 |
| `improve-codebase-architecture` | 扫描代码库、生成架构改进报告并通过质询推进选择的改进项 |
| `prototype` | 构建一次性原型验证设计问题 |
| `redmine` | 查询、创建、更新、分析和组织 Nationalchip Redmine 工作项 |
| `update-bu1-sdk-issue-conclusion` | 按规则完成 BU1-SDK-2007-01-UNIFY Redmine issue 的结论更新 |
| `wayfinder` | 通过 taskmd 规划多会话工作，并逐个解决决策 Ticket |
| `writing-great-skills` | 编写和编辑可预测、可维护的 agent skill |

`pi-herdr-agents` 包另提供 `/skill:orchestrate`，用于准备证据、并行派出独立审查者并由父 agent 汇总；无需复制到本地 skills 目录。

## 项目级技能（`.pi/skills/`）

这些是仅在本仓库生效的自定义技能，不会被其他项目加载：

| 技能名称 | 用途 |
|---|---|
| `readme-check` | 代码变更后检查 README 是否漂移，确认后同步更新，再调用 commit-changes 提交 |
| `commit-changes` | 暂存并提交当前所有修改，自动生成 Conventional Commits 格式的提交信息 |

## 子 Agent 管理

### pi-herdr-agents

已采用 `pi-herdr-agents` 作为 Pi 子 agent 的运行机制。需要安装 Herdr 及其 CLI，并从 Herdr 内启动 Pi（`HERDR_ENV=1`）；修改 prompt/全局说明后执行 `/reload` 或重启 Pi。

扩展的工具说明已包含任务拆分、模型与 thinking 选择、异步回传、worktree 和恢复/清理规则。本地不再维护第二份通用委派手册；`agent/APPEND_SYSTEM.md` 只补充 hashline、只读边界和普通终端进程等本地策略。

### 角色与本地适配

`scout`、`worker`、`reviewer` 使用包内定义，不再提供同名本地覆盖。只保留专用 `code-reviewer`，与包内通用 reviewer 并存。项目 `.pi/agents/` 仍优先于全局 `agent/agents/` 和包内定义。

| 角色 | 来源 | 职责 |
|---|---|---|
| `scout` | 包内 | 代码调查、定位相关文件与证据 |
| `worker` | 包内 | 执行明确任务、验证并交接 |
| `reviewer` | 包内 | 使用包内通用审查规范 |
| `code-reviewer` | `agent/agents/code-reviewer.md` | 无 shell 的专用评审，加载 `code-review` skill，使用其审查标准与默认报告格式 |

`code-reviewer` 保持独立会话、禁止继续委派、完成后自动结束；skill 的审查轴在一个子 agent 内串行执行，不固定模型或 thinking 默认值。重命名只区分角色用途，不增加工具权限。

原生 scout/reviewer 的默认工具包含 `bash`，worker 的默认工具包含 `edit`。hashline 兼容和只读限制由 `agent/APPEND_SYSTEM.md` 的本地调用策略处理，不通过复制角色说明实现：写任务按需覆盖编辑工具，探索/只读评审显式收窄为 `read,anchor_grep,find,ls`。最终能力取决于有效角色与本次调用参数；`tools` 覆盖会替换整份列表，不是合并。

父会话的 `--readonly` 不会自动传给子进程，工具列表也不是进程/扩展沙箱。无 shell 的子 agent 所需的 Git diff、命令或测试证据由父 agent 在自身权限内提供。

包级可选配置位于安装根目录的 `config.json`（当前 npm 路径：`agent/npm/node_modules/pi-herdr-agents/config.json`），可能被包更新覆盖。本地角色直接维护在 `agent/agents/`，不修改安装包。

### 原生入口与保留的工作流

| 入口 | 用途 |
|---|---|
| `/subagent list` | 查看有效角色及其来源 |
| `/subagent scout <问题>` | 使用包内 scout 调查代码；需要并行调查时向父 agent 说明 |
| `/subagent worker <明确任务>` | 使用包内 worker 实现任务，启动时应用本地工具适配 |
| `/subagent reviewer <范围与证据>` | 使用包内通用 reviewer |
| `/subagent code-reviewer <范围与证据>` | 直接使用本地 `code-review` 专用评审者 |
| `/skill:impl-with-spawn <任务>` | 拆分任务并为各子任务选择合适角色，再排序、派发、检查与整合；不限于 worker |
| `/goal-review <目标或变更范围>` | 先准备范围与差异证据，再派发本地 `code-reviewer` |
| `/skill:orchestrate <审查范围>` | 使用包提供的多审查者流程 |

`/subagent` 快捷命令会请求父 agent 调用工具，不会原生执行完整的证据准备或多阶段流水线。`code-reviewer` 不依赖 `/goal-review` 才能运行，但直接调用时仍需完整范围和差异证据；需要父 agent 先准备这些输入时使用 `/goal-review`。包内 reviewer 同样要求明确范围与证据，不能把其默认 shell 能力理解为自动补齐所有输入。

### 普通交互命令与长期进程

`agent/APPEND_SYSTEM.md` 将代理委派与终端进程分开：一次性非交互命令使用 `bash`；编辑器、TUI 和服务器使用独立 Herdr pane，保留 cwd、不抢焦点、按创建响应中的 pane ID 操作。没有 Herdr 时提供手动终端命令，不静默退回 `nohup` 或后台 shell 作业。

`/wayfinder ui` 也按此规则启动 taskmd Web UI，而不是为服务器派一个 Pi 子 agent；报告 URL、pane ID、启动证据和 Ctrl+C 停止方式。taskmd 仍是显式前置依赖，不会自动安装。

临时仓库检索仍优先使用 `rg`、`fd` 和 `rg --files`；仅在需要精确语义或替代工具不可用时回退到 shell `grep`/`find`，不限制 Pi 内置同名工具。

## TUI 配置

### open-tui（`agent/open-tui.json`）
- **状态**: 已启用
- **图标模式**: 自动
- **底部栏显示**（footerSegments）:
  - 当前工作目录（cwd）
  - Git 分支（gitBranch）
  - Git 状态（gitStatus）
  - 上下文信息（context）
  - Token 计数（tokens）
  - 费用统计（cost）
- **遥测**（telemetry）: 已启用，记录 TPS、TTFT、耗时、Token 数、停顿数和费用

### zentui（`agent/zentui.json`）
- **配色来源**: starship（终端）、editor（主题）、userMessages（主题）
- **状态行**: 已启用
- **编辑器**: 关闭
- **Copy 友好模式**: 关闭

## 键位配置（`agent/keybindings.json`）

| 快捷键 | 操作 |
|---|---|
| `Enter` | 发送当前消息 |
| `Shift+Enter`、`Ctrl+J`、`Alt+Enter` | 在当前消息中换行 |
| `Ctrl+S` | 打开模型选择器 |
| `Alt+S` | 排队发送 follow-up 消息 |

---

> ⚠️ **注意**: 以下敏感文件已在 `.gitignore` 中排除，不会提交到版本控制：
> - `agent/auth.json` — DeepSeek API Key
> - `agent/models-store.json` — 模型商店缓存
> - `agent/trust.json` — 信任配置
> - `agent/sessions/` — 个人会话历史
> - `agent/npm/node_modules/`、`agent/npm/package-lock.json` — npm 依赖（可还原）
