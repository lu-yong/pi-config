# Pi Coding Agent 配置

本仓库记录了 [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 的配置文件及插件/扩展安装情况。

## 安装的插件（Packages）

通过 `settings.json` 中的 `packages` 字段安装的 npm 包：

### 1. `pi-web-access`
- **来源**: `npm:pi-web-access`
- **用途**: 为 pi agent 提供网络搜索和网页内容抓取能力（web_search、fetch_content 等工具）
- **版本**: ^0.14.0

### 网络搜索配置（`web-search.json`）

`web-search.json` 配置 `pi-web-access` 的搜索行为。当前默认使用 Tavily，并在搜索后打开摘要审阅界面：

```json
{
  "provider": "tavily",
  "workflow": "summary-review"
}
```

使用 Clash、Mihomo 等 TUN/fake-IP 代理时，公网域名可能会解析到合成保留地址段。可通过 `ssrf.allowRanges` 为该地址段添加最小范围的白名单，以便 `web_search` 和 `fetch_content` 通过 SSRF 地址校验：

```json
{
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"]
  }
}
```

如需在此文件保存搜索服务 API Key，不应将密钥提交到版本控制；当前仓库中的配置不包含 API Key。

### 2. `pi-open-tui`
- **来源**: `npm:pi-open-tui`
- **用途**: 提供终端用户界面（TUI），支持在终端内交互式使用 pi
- **版本**: ^0.2.7

### 3. `@tmustier/pi-files-widget`
- **来源**: `npm:@tmustier/pi-files-widget`
- **用途**: 文件浏览器插件，用于在 TUI 中浏览和管理文件
- **版本**: ^0.2.0

### 4. `pi-interactive-shell`
- **来源**: `npm:pi-interactive-shell`
- **用途**: 通过可观察的终端 overlay 启动和管理 Pi 子 agent，支持 dispatch、hands-free、monitor 和后台会话
- **版本**: 0.13.0

## 扩展（Extensions）

位于 `agent/extensions/` 目录下，使用 pi SDK 注册的自定义扩展：

### anyrouter-provider
- **文件**: `agent/extensions/anyrouter-provider/index.ts`
- **功能**: 通过 AnyRouter 中转服务注册模型提供商，支持两种 API 类型混用
- **配置**（GPT 模型）:
  - Base URL: `https://anyrouter.top/v1`
  - API: `openai-responses` 格式
  - API Key: 通过环境变量 `$ANYROUTER_API_KEY` 注入
- **配置**（Claude 模型）:
  - Base URL: `https://anyrouter.top`（不带 /v1）
  - API: `anthropic-messages` 格式
  - API Key: 复用 `$ANYROUTER_API_KEY`
- **注册的模型**:
  - `gpt-5.6-sol` — GPT-5.6 Sol，支持推理（thinking level: high），272K 上下文窗口，支持文本和图像输入
  - `claude-fable-5` — Claude Fable 5，思考等级 low→xhigh，1M 上下文，128K 输出，支持文本和图像输入
  - `claude-opus-5` — Claude Opus 5，思考等级 low→xhigh，1M 上下文，128K 输出，支持文本和图像输入

### micu-provider
- **文件**: `agent/extensions/micu-provider/index.ts`
- **功能**: 通过 Micu AI 注册模型提供商
- **配置**:
  - Base URL: `https://www.micuapi.ai/v1`
  - API: `openai-responses` 格式
  - API Key: 通过环境变量 `$MICU_API_KEY` 注入
- **注册的模型**:
  - `gpt-5.6-luna` — GPT-5.6 Luna，支持推理，272K 上下文
  - `gpt-5.6-terra` — GPT-5.6 Terra，支持推理，272K 上下文
  - `gpt-5.6-sol` — GPT-5.6 Sol，支持推理，272K 上下文

### readonly-mode
- **文件**:
  - `agent/extensions/readonly-mode/index.ts` — Pi 生命周期适配器，注册命令、快捷键、CLI flag 和事件处理器
  - `agent/extensions/readonly-mode/enforcement.ts` — 只读策略模块，统一处理状态转换、恢复、命令判定、提示事实和阻止原因
- **功能**: 本地核心工具只读模式。阻止 Pi 内置 `edit`/`write`，并对 `bash` 采用 fail-closed 检查；允许明确批准的读取命令、测试和静态检查。测试与静态检查可能生成正常缓存或临时产物，安装、构建、发布和任意脚本仍会被阻止。
- **安全范围**: MCP、技能和其他自定义工具不在此模式的执行限制范围内，仍可能修改外部系统；该模式不是全局无副作用沙箱。
- **使用方式**:
  - CLI: `pi --readonly`
  - 命令: `/readonly`（切换开关）；`/readonly <prompt>`（一键进入并提问）
  - 快捷键: `Ctrl+Alt+R`（切换开关）
- **防护层次**:
  1. 系统提示注入 — 向 LLM 注入与实际执行策略一致的限制和范围
  2. `tool_call` 事件拦截 — 直接 block `edit`/`write`，并校验 `bash` 输入
  3. bash fail-closed 检查 — 逐段校验管道和组合命令，拒绝危险子命令、重定向、后台执行、命令替换和不可信执行路径
  4. Session entry 持久化 — 从当前 active branch 恢复状态；显式 `--readonly` 优先于旧会话状态，用户仍可用 `/readonly` 退出
- **测试**:
  ```bash
  node --test agent/extensions/readonly-mode/*.test.ts
  ```

### planning-files-runtime
- **文件**: `agent/extensions/planning-files-runtime/`
- **功能**: 在每个项目的 `.pi/planning/` 中持久化实施上下文，并在新会话、`resume` 或 `fork` 时重新读取并注入当前计划、发现、进度和目标状态。
- **持久化内容**:
  - `task_plan.md`、`findings.md`、`progress.md`：当前实施的计划、发现与进度
  - `goal-design.md`、`tasks/`、`.goal-state.json`：跨运行的目标蓝图、任务卡和恢复状态
- **使用方式**:
  - `/plan-new`：初始化或归档后重置规划工作区
  - `/plan-goal-set <目标>`：分阶段澄清并保存目标
  - `/plan-goal-impl`：启动或恢复已提交目标的实施
  - `/plan-update`：将当前工作与持久化规划重新对齐
- **并发限制**: 同一项目的 `.pi/planning/` 没有锁或冲突处理，应由单个 Pi 实例写入。

## 模型提供商（Providers）

### 已启用的模型（`settings.json` 中 `enabledModels`）
| 模型 ID | 来源 |
|---|---|
| `anyrouter/gpt-5.6-sol` | AnyRouter 扩展 |
| `anyrouter/claude-fable-5` | AnyRouter 扩展 |
| `anyrouter/claude-opus-5` | AnyRouter 扩展 |
| `deepseek/deepseek-v4-pro` | OpenRouter |
| `deepseek/deepseek-v4-flash` | OpenRouter |
| `micu/gpt-5.6-sol` | Micu AI 扩展 |
| `micu/gpt-5.6-luna` | Micu AI 扩展 |
| `micu/gpt-5.6-terra` | Micu AI 扩展 |
| `noname/gpt-5.6-sol` | Noname 自定义提供商 |

## 安装的技能（Skills）

位于 `agent/skills/` 目录下，这些技能为 pi 提供特定任务的专用指令：

| 技能名称 | 用途 |
|---|---|
| `code-review` | 代码审查（Standards + Spec 双轴审查） |
| `codebase-design` | 模块接口设计/深层模块分析 |
| `diagnosing-bugs` | 硬 Bug 和性能回归的诊断循环 |
| `domain-modeling` | 领域模型构建与术语梳理 |
| `find-skills` | 发现和安装 agent 技能 |
| `grilling` | 对计划/决策进行压力测试 |
| `prototype` | 构建快速原型验证设计 |
| `research` | 基于高信任度主来源的调查 |
| `resolving-merge-conflicts` | Git 合并冲突解决 |
| `tdd` | 测试驱动开发（红-绿-重构） |
| `implement` | 通用功能实现 |
| `handoff` | 任务交接 |
| `teach` | 教学技能 |
| `to-spec` | 按规格说明书实现 |
| `to-tickets` | 将需求拆解为任务单 |
| `triage` | 问题分类与优先级排序 |
| `wayfinder` | 路线规划 |
| `writing-great-skills` | 编写优秀技能文件 |
| `ask-matt` | 向 Matt 提问 |
| `grill-me` | 自我质询 |
| `grill-with-docs` | 带文档的质询 |
| `impl-with-spawn` | 通过 `interactive_shell` 编排 Pi 子 agent 完成实现、修复和审查 |
| `improve-codebase-architecture` | 改进代码库架构 |
| `setup-matt-pocock-skills` | 设置 Matt Pocock 技能 |

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
- `agent/APPEND_SYSTEM.md`：规定阻塞型/TUI 命令使用 `interactive_shell`，并清理临时后台会话

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

## 全局设置摘要（`settings.json`）

| 配置项 | 值 |
|---|---|
| 主题 | `dark` |
| 默认 Provider | `micu` |
| 默认模型 | `gpt-5.6-terra` |
| 默认思考级别 | `medium` |
| pi 版本 | 0.82.1 |

## 键位配置（`agent/keybindings.json`）

| 快捷键 | 操作 |
|---|---|
| `Ctrl+S` | 打开模型选择器 |
| `Alt+S` | 排队发送 follow-up 消息 |

### pi-tokyo-night 插件配置
```json
{
  "panel": true,
  "codexQuota": false,
  "kimiQuota": true,
  "rainRows": 3,
  "rainTickMs": 130,
  "maxRainDrops": 25
}
```

## 模型商店（models-store.json）

包含从 OpenRouter 同步的海量模型列表（60+ 模型），涵盖以下系列：
- **Anthropic**: Claude Opus 4/4.1/4.5/4.6/4.7/4.8/5, Sonnet 4/4.5/4.6/5, Haiku 3/4.5, Fable 5
- **DeepSeek**: V3/V3.1/V3.2/V4 Flash/V4 Pro, R1
- **Google**: Gemini 2.5 Flash/Pro, 3 Flash/Pro, 3.1/3.5/3.6 Flash
- **Meta**: Llama 3.1/3.3/4 Maverick
- **ByteDance Seed**: Seed 1.6/2.0 系列
- 以及更多（Gemma, Nova, Cohere, Inclusion AI 等）

---

> ⚠️ **注意**: 以下敏感文件已在 `.gitignore` 中排除，不会提交到版本控制：
> - `agent/auth.json` — DeepSeek API Key
> - `agent/models.json` — 自定义 Provider API Key
> - `agent/models-store.json` — 模型商店缓存
> - `agent/trust.json` — 信任配置
> - `agent/sessions/` — 个人会话历史
> - `agent/npm/node_modules/`、`agent/npm/package-lock.json` — npm 依赖（可还原）
