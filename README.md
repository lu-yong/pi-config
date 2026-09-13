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
| `impl-with-spawn` | 通过 Herdr `subagent` 编排实现、修复和审查；保留原技能名，仅显式调用 |
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

- **运行环境**：安装 Herdr 及其 CLI，并从 Herdr 内启动 Pi（`HERDR_ENV=1`）；安装或改动资源后执行 `/reload` 或重启 Pi。
- **配置状态**：本地 `agent/settings.json` 已安装 `npm:pi-herdr-agents`；原 overlay/spawn 配置已删除，不再使用旧的 dispatch、hands-free、monitor 模式。
- **调用方式**：`subagent` 返回启动确认，完成结果自动唤醒父 agent；不需要轮询、读取运行中的会话日志或调用 `subagents_list` 查进度。后者仅用于发现可用角色。
- **角色发现**：项目 `.pi/agents/` > 全局 `agent/agents/` > 包内定义；常用叶子角色为 `scout`、`worker`、`reviewer`。
- **本地 reviewer**：`agent/agents/reviewer.md` 覆盖包内同名角色，自动加载 `code-review` skill；角色只维护只读工具、独立会话、禁止继续委派和自动结束策略。审查标准与默认报告格式由 skill 统一维护，三条审查轴在同一个子 agent 内串行执行；不固定模型默认值。
- **配置位置**：包的可选覆盖文件是安装根目录的 `config.json`（当前 npm 路径为 `agent/npm/node_modules/pi-herdr-agents/config.json`），不是旧 spawn 配置的改名版。它可能被包更新覆盖；本仓库的编排入口逐次显式传参，不修改已安装包。
- **交互与恢复**：`subagent_interrupt` 只中断当前 turn，不终止会话；普通非持久子会话用 `subagent_resume` 继续，持久专家收到结果后用 `subagent_send` 追加工作，结束时用 `subagent_stop`。`interactive` 控制状态通知，不等于后台服务托管。

### 模型、工具与只读边界

- 每次显式指定实时认证目录中的完整 `provider/model-id` 和该模型支持的 `thinking`，不再依赖固定的旧 provider 路由表。先按任务选 fast / mid / frontier 档，再选推理强度；并非所有模型都支持 `low` 或 `medium`。
- 独立审查必须与产出模型属于不同底层模型家族；仅更换同家族模型的 API provider 不算独立审查。无法满足时应报告覆盖缺口。
- `tools` 参数**替换**角色的整份工具列表，不与父会话限制求交。当前 hashline 编辑器下，实现流程显式使用 `read,bash,write,replace,insert,anchor_grep,undo_last_change,find,ls`，而不是包内 worker 的 `edit` 默认值。
- 探索/只读审查显式限制为 `read,anchor_grep,find,ls`，并禁止写入、安装、提交和继续派生 agent。需要的 Git diff、命令与测试证据由父 agent 在自身权限内提供。
- 父会话的 `--readonly` **不会自动传递**给子进程，公开 `subagent` 参数也没有任意 CLI flags。`read,bash` 不构成只读沙箱；工具列表同样不是针对进程、扩展及其内部状态写入的安全沙箱。

### 并发与 worktree

- 只读任务使用普通 pane，省略 `worktree`；单个或串行写任务可用父 checkout，但要记录原有 diff 并避免父子同时改文件。
- 仅独立的并行写任务使用各自唯一分支的 managed worktree；默认基于**已提交的 HEAD**，不会复制父工作区未提交/未跟踪内容。存在依赖或共同接口的修改仍需串行。
- 父 agent 负责检查实际 diff、验证和整合；共享 planning/progress 文件也只由父 agent 更新。子 agent 默认不 push、merge、deploy 或自行清理工作树。
- worktree 完成后会保留，且不支持 `subagent_resume` 或模型 fallback 列表。后续工作留在原 checkout，确认成果已保留后才显式清理；审查该结果只需把普通 reviewer 的 `cwd` 指向原 worktree。

### 编排入口与试用

| 入口 | 用途 |
|---|---|
| `/subagent list` | 查看包内、全局和项目角色定义 |
| `/explore-codebase [主题]` | 在普通 pane 中派出 2–4 个只读 scout，自动收齐结果后汇总 |
| `/skill:impl-with-spawn <任务>` | 按依赖拆分实现/修复任务，显式配置 hashline 工具并由父 agent 验证 |
| `/goal-review <目标或变更范围>` | 薄入口：按 `code-review` 做范围预检、准备证据并派发本地 `reviewer`；不重复定义审查规范 |
| `/skill:orchestrate <审查范围>` | 使用包提供的多审查者流程，父 agent 汇总证据 |

例如可先试 `/explore-codebase 当前仓库的扩展加载与测试入口`，观察 pane 启动和完成后结果自动回传。

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
