# Pi Coding Agent 配置

本仓库记录了 [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 的配置文件及插件/扩展安装情况。

## 安装的插件（Packages）

以下插件通过 `settings.json` 的 `packages` 字段安装；每个插件的完整安装命令如下：

| 包 | 用途 | Pi 安装命令 |
|---|---|---|
| `pi-web-access` | 网络搜索与网页内容抓取 | `pi install npm:pi-web-access` |
| `pi-open-tui` | 终端用户界面增强 | `pi install npm:pi-open-tui` |
| `@tmustier/pi-files-widget` | TUI 文件浏览器 | `pi install npm:@tmustier/pi-files-widget` |
| `pi-interactive-shell` | 通过 overlay 管理 Pi 子 agent，支持 dispatch、hands-free、monitor 和后台会话 | `pi install npm:pi-interactive-shell` |
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
- **目标模式限制**：当 planning-files-runtime 的 goal 状态为 `active` 时，自动 Q&A 被抑制，手动 `/qna` 会提示先暂停或完成目标，避免打断目标的自动 continuation。

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
| `impl-with-spawn` | 通过 `interactive_shell` 编排 Pi 子 agent 完成实现、修复和审查 |
| `improve-codebase-architecture` | 扫描代码库、生成架构改进报告并通过质询推进选择的改进项 |
| `prototype` | 构建一次性原型验证设计问题 |
| `redmine` | 查询、创建、更新、分析和组织 Nationalchip Redmine 工作项 |
| `update-bu1-sdk-issue-conclusion` | 按规则完成 BU1-SDK-2007-01-UNIFY Redmine issue 的结论更新 |
| `wayfinder` | 通过 taskmd 规划多会话工作，并逐个解决决策 Ticket |
| `writing-great-skills` | 编写和编辑可预测、可维护的 agent skill |

## 项目级技能（`.pi/skills/`）

这些是仅在本仓库生效的自定义技能，不会被其他项目加载：

| 技能名称 | 用途 |
|---|---|
| `readme-check` | 代码变更后检查 README 是否漂移，确认后同步更新，再调用 commit-changes 提交 |
| `commit-changes` | 暂存并提交当前所有修改，自动生成 Conventional Commits 格式的提交信息 |

## 子 Agent 管理

### pi-interactive-shell（`agent/interactive-shell.json`）
- **默认 agent**: 仅使用 `pi`
- **启动快捷键**: `Alt+Shift+P`
- **默认委派模式**: `dispatch` + `background: true`，任务完成后由通知唤醒主 agent，无需轮询
- **监督模式**: 需要用户观察或干预时使用 `hands-free`
- **并行规则**: 仅并行无依赖、只读或文件所有权互不重叠的子任务
- **工作树**: 默认不创建独立 Git worktree

### 模型路由

子 agent 按以下顺序选择第一个已配置且可用的模型；仅在不可用、运行失败或结果仍不充分时升级到下一级：

1. `deepseek/deepseek-v4-flash`
2. `deepseek/deepseek-v4-pro`
3. `micu/gpt-5.6-terra`
4. `micu/gpt-5.6-sol`

动态路由使用 `pi --model <provider/model>` 启动子 agent，因为 structured spawn 不支持逐次指定 Pi 模型。父会话处于只读模式时，所有子 agent 都追加 `--readonly`，不得绕过父会话限制。

### 编排入口
- `impl-with-spawn` skill：拆解实现、修复和审查任务，按依赖层串行或安全并行派发
- `/explore-codebase [主题]`：派出 2-4 个只读 Pi 子 agent 并行探索后汇总
- `agent/APPEND_SYSTEM.md`：规定需要输入、打开 TUI/editor 或持续运行的命令使用 `interactive_shell`，普通一次性非交互命令使用 `bash`；临时仓库检索的 shell 命令优先使用 `rg`、`fd` 和 `rg --files`，仅在需要原命令的精确语义或替代工具不可用时回退到 `grep`/`find`，且不限制 Pi 内置的同名工具

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
