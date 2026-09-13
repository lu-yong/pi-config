# Pi Coding Agent 配置

本仓库维护 [Pi Coding Agent](https://pi.dev) 的全局扩展、技能入口和本地使用策略，并记录本机的安装与配置现状。

## 配置范围

- `agent/` 对应 `~/.pi/agent/`，其中的扩展、技能、prompt、键位和追加系统说明面向所有项目。
- `.pi/` 是**本配置仓库自己的项目配置**；其中的扩展和技能在本仓库被信任后加载，不会因此成为其他项目的全局资源。
- `agent/settings.json`、`agent/models.json`、认证文件及 npm 安装目录只保存在本机，未入库。下文的包、模型和默认设置是本机快照，**不是 clone 后即可还原的完整配置**。
- `agent/skills/` 中除 `impl-with-spawn`、`wayfinder` 外均为指向 `~/.cc-switch/skills/` 的软链接。迁移时需另行准备这些技能源，并配置包和模型认证。

## 安装的插件（Packages）

当前 `agent/settings.json` 的 `packages` 字段配置了以下 8 个包；安装命令默认作用于全局配置：

| 包 | 用途 | Pi 安装命令 |
|---|---|---|
| `pi-web-access` | 网络搜索与网页内容抓取 | `pi install npm:pi-web-access` |
| `pi-open-tui` | 终端用户界面增强 | `pi install npm:pi-open-tui` |
| `@tmustier/pi-files-widget` | TUI 文件浏览器 | `pi install npm:@tmustier/pi-files-widget` |
| `pi-herdr-agents` | 在 Herdr pane 中异步运行 Pi 子 agent，自动回传结果，支持持久专家和隔离 worktree | `pi install npm:pi-herdr-agents` |
| `pi-hashline-edit-pro` | 使用 4 字符锚点安全编辑文件，提供 `read`、`replace`、`insert`、`anchor_grep`、`undo_last_change`，禁用内置 `edit` | `pi install npm:pi-hashline-edit-pro` |
| `pi-observational-memory` | 跨 compaction、交接和长期会话保存工作记忆 | `pi install npm:pi-observational-memory` |
| `@firstpick/pi-themes-bundle` | 提供多套熟悉的浅色和深色主题 | `pi install npm:@firstpick/pi-themes-bundle` |
| `@juicesharp/rpiv-ask-user-question` | 提供 `ask_user_question` 结构化提问工具，支持单选、多选、自定义回答和选项预览 | `pi install npm:@juicesharp/rpiv-ask-user-question` |

### 网络搜索配置（`web-search.json`）

`web-search.json` 当前默认使用 Tavily，并在搜索后打开摘要审阅界面：

```json
{
  "provider": "tavily",
  "workflow": "summary-review",
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"]
  }
}
```

当前 `ssrf.allowRanges` 为 TUN/fake-IP 代理使用的 `198.18.0.0/15` 合成地址段放行。它是本机网络适配，不是通用推荐配置；迁移时应按实际代理需求保留最小范围，不应关闭 SSRF 校验或把 API Key 写入版本控制。

## 扩展（Extensions）

`agent/extensions/` 下的 `*.ts` 和 `*/index.ts` 会被 Pi 自动发现并全局加载；不需要再在 `settings.json` 中重复声明。没有入口文件的共享模块和测试目录不独立加载。

### readonly-mode

- **文件**：`agent/extensions/readonly-mode/`
- **功能**：按工具名拦截本地文件修改；当前代码阻止 `edit`、`write`、`replace` 和 `undo_last_replace`，并对 `bash` 采用 fail-closed 检查。
- **使用方式**：`pi --readonly`、`/readonly`、`Ctrl+Alt+R`
- **范围**：MCP、技能和其他自定义工具不在此模式的执行限制范围内；它不是全局无副作用沙箱。
- **当前限制**：拦截名单尚未适配 hashline 的 `insert` 和 `undo_last_change`，不能据此认为全部写工具都已被禁用。只读子 agent 仍需遵循下文的显式工具限制。
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
- **触发判定**：自动触发前先剥离围栏/缩进代码块、行内代码和 URL，再只在净化后文本的**末尾 400 字符**内判定问号，避免 `a ? b : c`、`a?.b`、query string、正文中段的反问句造成误触发。去重指纹仍基于原始回复文本。
- **配置**（`agent/settings.json` 顶层 `qna` 块，缺失/损坏一律安全降级到默认值）：

  | 键 | 默认 | 说明 |
  |---|---|---|
  | `autoExtract` | `true` | 自动触发开关；关掉后 `/qna` 手动入口仍然可用 |
  | `model` | 未设置 | 抽取用的廉价模型 `{ provider, id, thinking }`。未配置时静默使用主模型；已配置但解析不出或取不到 API key 时回退到主模型**并提示**。`thinking` 取 `minimal`/`low`/`medium`/`high`/`xhigh`/`max`，非法值保留该模型但丢弃 thinking 并提示 |

- **本机设置**：`autoExtract: true`，抽取模型为 `openrouter/deepseek/deepseek-v4.1-flash`，`thinking: low`。
- **目标模式限制**：当 planning-files-runtime 的 goal 状态为 `active` 时，自动 Q&A 被抑制，手动 `/qna` 会提示先暂停或完成目标，避免打断目标的自动 continuation。
- **测试**：`node --test agent/extensions/qna/*.test.ts`

`qna` 是回复结束后的问题抽取；包提供的 `ask_user_question` 则由 agent 在执行中主动调用，两者不是同一个入口。`agent/extensions/question-taking/` 是 qna 使用的共享交互模块，没有 `index.ts`，不独立加载。

### readme-check

- **文件**：`.pi/extensions/readme-check.ts`
- **范围**：仅在本配置仓库（`~/.pi`）被信任后作为项目扩展加载。
- **功能**：监听 `write`、`edit`、`replace` 和 `undo_last_replace` 的工具调用，通过 `input.path` 记录文件，并在 agent settled 后提醒检查 README 是否漂移。
- **当前限制**：未追踪 `insert` / `undo_last_change`；不携带 `path` 的纯锚点 `replace` 调用也不会被记录。它是尽力提醒，不是完整的变更审计。

### Herdr 本机集成

`agent/extensions/herdr-agent-state.ts` 由 Herdr 安装和管理，用于上报 Pi 会话与运行状态。它在本机存在并被自动发现，但已被 `.gitignore` 排除，不是本仓库维护的扩展源码；更新 Herdr 集成可能覆盖它。

## 模型提供商（Providers）

### 本机自定义 provider（`agent/models.json`）

模型来自 Pi 的 provider 目录与本机 `agent/models.json`。原先的 `anyrouter-provider`、`cola-provider`、`micu-provider`、`micu-xai-provider` 扩展目录已不存在；当前自定义 provider 如下，均使用 `openai-responses`：

| Provider ID | Base URL | 当前定义的模型 | 上下文窗口（token） |
|---|---|---|---|
| `colaai` | `https://code28.ccwu.cc/v1` | `gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol` | Luna 为 1,000,000；Terra / Sol 为 272,000 |
| `cc-switch-deep-seek` | `https://api.deepseek.com/v1` | `deepseek-v4-flash` | 1,000,000 |
| `anyrouter` | `https://anyrouter.top/v1` | `gpt-6-astra` | 1,000,000 |
| `fastai` | `https://www.fastaitoken.com/v1` | `gpt-5.6-terra`、`gpt-5.6-sol` | 272,000 |
| `jucode` | `https://api.jucode.cn/v1` | `gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol` | 1,000,000 |

上述 DeepSeek Flash 的 `maxTokens` 为 384,000，其余模型为 128,000。这里记录的是本机配置，不是服务端能力保证；实际可用模型、认证与限制应以本机 `/model` 和服务端为准。凭据由本机认证/provider 配置提供，不应复制到 README 或版本控制中。

### 快捷轮换范围（`agent/settings.json` 的 `enabledModels`）

`enabledModels` 是 `Ctrl+P` / `Shift+Ctrl+P` 的轮换范围，不是所有已认证模型的完整目录。当前配置为：

| 模型 ID | 本地配置状态 |
|---|---|
| `cc-switch-deep-seek/deepseek-v4-flash` | 已在 `models.json` 定义 |
| `cc-switch-deep-seek/deepseek-v4-pro` | 已列入轮换范围，但该 provider 下尚无对应定义 |
| `colaai/gpt-5.6-luna` | 已在 `models.json` 定义 |
| `colaai/gpt-5.6-terra` | 已在 `models.json` 定义 |
| `colaai/gpt-5.6-sol` | 已在 `models.json` 定义 |
| `fastai/gpt-5.6-terra` | 已在 `models.json` 定义 |
| `fastai/gpt-5.6-sol` | 已在 `models.json` 定义 |
| `jucode/gpt-5.6-luna` | 已在 `models.json` 定义 |
| `jucode/gpt-5.6-terra` | 已在 `models.json` 定义 |
| `jucode/gpt-5.6-sol` | 已在 `models.json` 定义 |
| `anyrouter/gpt-6-astra` | 已在 `models.json` 定义 |

当前默认启动模型为 `fastai/gpt-5.6-terra`，默认 thinking 为 `high`；会话选择或 CLI 参数可以覆盖启动默认值。

**已知配置不一致**：`cc-switch-deep-seek/deepseek-v4-pro` 目前无法匹配模型，需另行补充定义或调整轮换列表；本 README 仅记录现状，不把它描述为已可用模型。可用 `/model` 或 `pi --list-models` 检查实时目录。

## 安装的技能（Skills）

当前 `agent/skills/` 有以下 19 个技能入口。Pi 会发现这些目录和软链接，按需读取技能内容；标记 **†** 的 9 个技能配置了 `disable-model-invocation: true`，不进入模型的默认技能提示列表，需通过 `/skill:<名称>` 显式调用。

| 技能名称 | 用途 |
|---|---|
| `adb` | Android Debug Bridge 设备检查、AOSP/vendor bring-up、HAL 调试、日志收集、文件传输和设备操作 |
| `code-review` | 从规格、规范/设计、安全/可靠性三个独立维度，对提交和工作区变更进行基于证据的代码审查，并明确测试覆盖 |
| `codebase-design` | 深模块设计的共享词汇，用于接口设计、模块边界、可测试性和代码导航 |
| `commit-gerrit` † | 按本地规则快照提交 Nationalchip Gerrit 评审，提交前确认 issue、提交说明、amend 选择和目标分支 |
| `domain-modeling` | 构建和完善项目领域模型、术语与决策记录 |
| `gerrit` | 只读查询 Nationalchip Gerrit 的变更、修订、补丁、项目和账号信息 |
| `grill-with-docs` † | 结合文档通过质询完善计划或设计 |
| `grilling` | 对计划或设计进行全面压力测试 |
| `handoff` † | 将当前会话整理成交接文档供其他 agent 继续工作 |
| `herdr` | 用户明确要求时，通过 Herdr CLI 检查/控制 pane、tab、workspace 和普通终端进程 |
| `humanize-tech-docs` † | 编写或审查面向零背景读者的技术文档，以可核查事实、示例和独立读者验收减少理解障碍 |
| `impl-with-spawn` † | 父 agent 的实现编排：拆分任务、按需选择角色、排序、派发、验证与整合 |
| `improve-codebase-architecture` † | 扫描代码库、生成架构改进报告并通过质询推进选择的改进项 |
| `prototype` | 构建一次性原型验证设计问题 |
| `redmine` | 查询、创建、更新、分析和组织 Nationalchip Redmine 工作项 |
| `refresh-bu1-sdk-rules` † | 从 Redmine Wiki 刷新 BU1-SDK Gerrit / Redmine 本地规则快照，展示差异并在确认后更新 |
| `update-issue-conclusion` † | 检查 Redmine issue、最新本地提交及 Gerrit 变更，起草合规中文结论并在确认后更新 |
| `wayfinder` | 通过 taskmd 规划多会话工作，并逐个解决决策 Ticket |
| `writing-great-skills` † | 编写和编辑可预测、可维护的 agent skill |

`pi-herdr-agents` 包另提供 `/skill:orchestrate`，用于准备证据、并行派出独立审查者并由父 agent 汇总；无需复制到本地 skills 目录。

## 项目级技能（`.pi/skills/`）

这些是仅在本仓库生效的自定义技能，不会被其他项目加载：

| 技能名称 | 用途 |
|---|---|
| `readme-check` | 代码变更后检查 README 是否漂移，确认后同步更新，再调用 commit-changes 提交 |
| `commit-changes` | 生成中文 Conventional Commits 提交说明，经用户确认说明和文件范围后暂存、提交；不会未经确认提交全部修改 |

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

包内还提供 `planner`、`poteto`、`adversarial-reviewer` 和 `visual-tester` 等角色；完整的有效角色和来源以 `/subagent list` 为准。`visual-tester` 需要另备 `chrome-cdp` 技能，并非安装本包即可直接使用。

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

包还提供 `/plan`、`/iterate`、`/btw` / `/btw-close`、`/worktree <名称> [任务]` / `/worktree list`。其中 `/plan` 是包内编排流程，与本地 planning-files-runtime 的 `/plan-*` 命令不是同一套工作流。

### 普通交互命令与长期进程

`agent/APPEND_SYSTEM.md` 将代理委派与终端进程分开：一次性非交互命令使用 `bash`；编辑器、TUI 和服务器使用独立 Herdr pane，保留 cwd、不抢焦点、按创建响应中的 pane ID 操作。没有 Herdr 时提供手动终端命令，不静默退回 `nohup` 或后台 shell 作业。

`/wayfinder ui` 也按此规则启动 taskmd Web UI，而不是为服务器派一个 Pi 子 agent；报告 URL、pane ID、启动证据和 Ctrl+C 停止方式。taskmd 仍是显式前置依赖，不会自动安装。

临时仓库检索仍优先使用 `rg`、`fd` 和 `rg --files`；仅在需要精确语义或替代工具不可用时回退到 shell `grep`/`find`，不限制 Pi 内置同名工具。

## TUI 配置

### 主题与模式（`agent/settings.json`，本机）

- **主题**：`tokyo-night-storm`（`@firstpick/pi-themes-bundle` 提供）。
- **TUI 模式**：`regular`。
- 当前没有 `agent/zentui.json`，也未在 `packages` 中启用独立的 zentui 包。

### open-tui（`agent/open-tui.json`）

- **状态**：已启用；可通过 `/open-tui` 打开配置界面。
- **图标模式**：`auto`。
- **底部栏显式启用项**（`footerSegments`）：`cwd`、`gitBranch`、`gitStatus`、`context`、`tokens`、`cost`。
- **底部栏显式关闭项**：`gitCommit`、`runtime`；未配置的项遵循包默认值。
- **回合统计**（`telemetry`）：已启用 TPS、TTFT、耗时、Token 数、停顿数和费用显示。

## 键位配置（`agent/keybindings.json`）

下表区分本机覆盖与 Pi 默认键位；未覆盖的动作沿用 Pi 默认值。修改键位后执行 `/reload`，完整快捷键可通过 `/hotkeys` 查看。

| 快捷键 | 操作 | 来源 |
|---|---|---|
| `Enter` | 发送当前消息 | Pi 默认 |
| `Shift+Enter`、`Ctrl+J`、`Alt+Enter` | 在当前消息中换行 | 本机 `tui.input.newLine` |
| `Alt+S` | 排队发送 follow-up 消息 | 本机 `app.message.followUp` |
| `Up`、`Ctrl+K` | 选择列表的上一项 | 本机 `tui.select.up` |
| `Down`、`Ctrl+J` | 选择列表的下一项 | 本机 `tui.select.down` |
| `Ctrl+L` | 打开模型选择器 | Pi 默认 `app.model.select` |
| `Ctrl+S` | 在模型/思考级别选择器内保存启动默认值，或在 scoped-models 界面保存轮换配置 | Pi 默认，非打开模型选择器 |

## 本地扩展开发与验证

`agent/extensions/package.json` 为本地扩展开发声明 Pi 依赖，当前 `pi-ai`、`pi-coding-agent`、`pi-tui` 都固定为 `0.85.1`。升级全局 Pi 后，可从仓库根目录同步这些开发依赖：

```bash
npm --prefix agent/extensions run sync-pi
```

在开发依赖已安装、Node.js 支持直接运行 TypeScript 的环境中，从仓库根目录运行：

```bash
node --test agent/extensions/*/*.test.ts
```

测试包括只读命令策略、readonly-mode、planning-files-runtime、qna、共享 question-taking 状态和开发依赖版本一致性；`dev-deps/` 只有测试，不是运行时扩展。

## 未入库文件与安全

忽略规则见 [`.gitignore`](.gitignore) 与 [`agent/npm/.gitignore`](agent/npm/.gitignore)。以下内容只保存在本机，不随本仓库提交：

| 路径 | 内容 |
|---|---|
| `agent/settings.json` | 本机默认模型、包列表、Q&A / 记忆等设置 |
| `agent/models.json` | 本机 provider / 模型定义及可能包含的认证配置 |
| `agent/auth.json` | Provider 认证凭据 |
| `agent/models-store.json` | 模型目录缓存 |
| `agent/trust.json` | 项目信任记录 |
| `agent/sessions/` | 个人会话历史 |
| `agent/npm/`（除 `.gitignore`） | 包安装清单、lockfile 和 `node_modules`，由 Pi 包管理维护 |
| `agent/extensions/node_modules/`、`agent/extensions/package-lock.json` | 本地扩展开发依赖与 lockfile |
| `agent/extensions/herdr-agent-state.ts` | Herdr 管理的本机集成 |
| `agent/cache`、`agent/projects-memory`、`agent/fff`、`agent/.pi-hermes-locks*`、`agent/pi-hermes-memory` | 本地缓存、记忆与历史运行状态 |

不要把真实 API Key、认证头或会话内容复制进 README。修改本机配置后，以实际文件和运行时目录为准更新本文，不应仅根据历史清单推断已安装或已可用。
