# Pi Coding Agent 配置

本仓库记录了 [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 的配置文件及插件/扩展安装情况。

## 安装的插件（Packages）

通过 `settings.json` 中的 `packages` 字段安装的 npm 包：

### 1. `pi-web-access`
- **来源**: `npm:pi-web-access`
- **用途**: 为 pi agent 提供网络搜索和网页内容抓取能力（web_search、fetch_content 等工具）
- **版本**: ^0.14.0

### 2. `pi-open-tui`
- **来源**: `npm:pi-open-tui`
- **用途**: 提供终端用户界面（TUI），支持在终端内交互式使用 pi
- **版本**: ^0.2.7

### 3. `@tmustier/pi-files-widget`
- **来源**: `npm:@tmustier/pi-files-widget`
- **用途**: 文件浏览器插件，用于在 TUI 中浏览和管理文件
- **版本**: ^0.2.0

## 扩展（Extensions）

位于 `agent/extensions/` 目录下，使用 pi SDK 注册的自定义 Provider：

### anyrouter-provider
- **文件**: `agent/extensions/anyrouter-provider/index.ts`
- **功能**: 通过 AnyRouter 中转服务注册模型提供商
- **配置**:
  - Base URL: `https://anyrouter.top/v1`
  - API: `openai-responses` 格式
  - API Key: 通过环境变量 `$ANYROUTER_API_KEY` 注入
- **注册的模型**:
  - `gpt-5.6-sol` — GPT-5.6 Sol，支持推理（thinking level: high），272K 上下文窗口，支持文本和图像输入

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
- **文件**: `agent/extensions/readonly-mode/index.ts`
- **功能**: 只读模式 — 限制 agent 只能使用 read-only 工具（read、安全的 bash 命令），
  阻止 edit/write/破坏性 bash 操作。适用于代码审查、实现方案讨论、架构探索等场景。
- **使用方式**:
  - CLI: `pi --readonly`
  - 命令: `/readonly`（切换开关）；`/readonly <prompt>`（一键进入并提问）
  - 快捷键: `Ctrl+Alt+R`（切换开关）
- **防护层次**:
  1. 系统提示注入 — 告知 LLM 遵守只读规则
  2. `tool_call` 事件拦截 — 直接 block edit/write
  3. bash 命令白名单安全检查 — 允许 `ls`/`grep`/`cat`/`git log` 等，拦截 `rm`/`sed`/`sudo`/重定向等
  4. Session entry 持久化 — 跨 `/resume` 和 `/tree` 导航保持状态

## 模型提供商（Providers）

### 已启用的模型（`settings.json` 中 `enabledModels`）
| 模型 ID | 来源 |
|---|---|
| `anyrouter/gpt-5.6-sol` | AnyRouter 扩展 |
| `deepseek/deepseek-v4-pro` | OpenRouter |
| `deepseek/deepseek-v4-flash` | OpenRouter（默认模型） |
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
| `improve-codebase-architecture` | 改进代码库架构 |
| `setup-matt-pocock-skills` | 设置 Matt Pocock 技能 |

## 项目级技能（`.pi/skills/`）

这些是仅在本仓库生效的自定义技能，不会被其他项目加载：

| 技能名称 | 用途 |
|---|---|
| `readme-check` | 代码变更后检查 README 是否漂移，确认后同步更新，再调用 commit-changes 提交 |
| `commit-changes` | 暂存并提交当前所有修改，自动生成 Conventional Commits 格式的提交信息 |

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
| 默认 Provider | `deepseek` |
| 默认模型 | `deepseek-v4-flash` |
| 默认思考级别 | `high` |
| pi 版本 | 0.82.1 |

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
> - `web-search.json` — 搜索服务 API Key
> - `agent/sessions/` — 个人会话历史
> - `agent/npm/node_modules/`、`agent/npm/package-lock.json` — npm 依赖（可还原）
