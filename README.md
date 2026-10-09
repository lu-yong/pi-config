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
| `pi-files-widget-overlay` | 浮动文件浏览器、查看器与 Git diff overlay，入口 `/readfiles`，是 tmustier files-widget 的 overlay 化分支 | `pi install npm:pi-files-widget-overlay` |
| `pi-herdr-agents` | 在 Herdr pane 中异步运行 Pi 子 agent，自动回传结果，支持持久专家和隔离 worktree | `pi install npm:pi-herdr-agents` |
| `pi-hashline-edit-pro` | 使用 4 字符锚点安全编辑文件，提供 `read`、`replace`、`replace_match`、`insert`、`copy`、`move`、`anchor_grep`、`undo_last_change`，禁用内置 `edit` | `pi install npm:pi-hashline-edit-pro` |
| `pi-observational-memory` | 跨 compaction、交接和长期会话保存工作记忆 | `pi install npm:pi-observational-memory` |
| `@firstpick/pi-themes-bundle` | 提供多套熟悉的浅色和深色主题 | `pi install npm:@firstpick/pi-themes-bundle` |
| `@juicesharp/rpiv-ask-user-question` | 提供 `ask_user_question` 结构化提问工具，支持单选、多选、自定义回答和选项预览 | `pi install npm:@juicesharp/rpiv-ask-user-question` |

### 网络搜索配置（`web-search.json`）

`web-search.json` 当前默认使用 Z.ai（GLM）搜索，并在搜索后打开摘要审阅界面；Tavily 凭据来自 `TAVILY_API_KEY` 环境变量，仍可通过显式 `provider: "tavily"` 调用：

```json
{
  "provider": "zai",
  "zaiApiKey": "$ZAI_CODING_CN_API_KEY",
  "zaiEndpoint": "china",
  "summaryModel": "cc-switch-zhipu-glm/glm-5.3-flash:low",
  "workflow": "summary-review",
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"]
  }
}
```

`zaiApiKey` 的 `$ZAI_CODING_CN_API_KEY` 是环境变量引用，搜索时实时读取，明文 key 不写入配置；`zaiEndpoint: "china"` 对应 bigmodel.cn 签发的 GLM Coding Plan key，搜索消耗该计划配额。`zai` 本为 explicit-only provider（不会被 `auto` 选中、不参与 `provider: "all"` 聚合），此处通过把 `provider` 设为 `"zai"` 成为默认；每次搜索都会消耗 Coding Plan 配额，需改回按需调用时把 `provider` 改回 `"tavily"` 即可。`summaryModel` 指定摘要草稿与查询重写模型（`provider/model:thinking` 格式，须在 Pi `enabledModels` 白名单内），当前用 GLM-5.3-Flash、thinking `low`。

当前 `ssrf.allowRanges` 为 TUN/fake-IP 代理使用的 `198.18.0.0/15` 合成地址段放行。它是本机网络适配，不是通用推荐配置；迁移时应按实际代理需求保留最小范围，不应关闭 SSRF 校验或把 API Key 写入版本控制。

### 其他本机设置（`settings.json`，不入库）

- `compaction.enabled: true`：启用自动上下文压缩。
- `observational-memory`：按 token 阈值安排观察、反思与压缩，并为本机配置了独立的处理模型；具体提供商与模型不入库。
- `retry`：请求自动重试启用，最多 5 次，基础退避 15 秒。
- 默认模型、默认 thinking 与 `enabledModels` 轮换列表同为易变本机信息，以 `settings.json` 为准，不在此记录。

## 扩展（Extensions）

`agent/extensions/` 下的 `*.ts` 和 `*/index.ts` 会被 Pi 自动发现并全局加载；不需要再在 `settings.json` 中重复声明。没有入口文件的共享模块和测试目录不独立加载。

### readonly-mode

- **文件**：`agent/extensions/readonly-mode/`
- **使用方式**：`pi --readonly`、`/readonly`、`Ctrl+Alt+R`
- **拦截**：启用时拦截具名文件变更工具 `edit`、`write`、`replace`、`replace_match`、`insert`、`copy`、`move`、`undo_last_change` 和旧版 `undo_last_replace`，直接调用和嵌套调用（如通过 codemode）均受限制；`bash` 另按只读命令策略检查。
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
- **实施补充**：`/plan-goal-impl [补充信息]` 将非空参数传入本次启动、恢复或故障恢复重发的执行提示词，例如 `/plan-goal-impl 我已使用重置卡恢复额度，请核对并更新旧的等待条件后继续`。提示模型先核对 `Blocker` / `Next action`，保留历史中断记录与未解决阻塞，不自动覆盖目标硬约束；扩展不按自然语言直接改写规划文件。
- **参数边界**：空白参数等同无参数；补充仅随本次请求传递，不写入 goal state，也不会作为“本次补充”再次注入后续自动 continuation。普通 `active` 状态下，无参数重复调用不做操作，带参数则明确提示改发普通消息或暂停后再恢复；故障恢复重发路径除外。
- **取消行为**：即使最后一条 assistant 消息已正常结束，Pi 收尾时的取消仍会将 `active` goal 暂停并清除待执行的 continuation，不自动续跑。
- **并发限制**：同一项目的 `.pi/planning/` 没有锁或冲突处理，应由单个 Pi 实例写入。

### qna

- **文件**：`agent/extensions/qna/`
- **功能**：普通 TUI 对话在 agent settled 后自动抽取回复中的用户问题，并通过共享 question-taking 界面收集答案；也可手动运行 `/qna`。
- **触发判定**：自动触发前先剥离围栏/缩进代码块、行内代码和 URL，再只在净化后文本的**末尾 400 字符**内判定问号，避免 `a ? b : c`、`a?.b`、query string、正文中段的反问句造成误触发。去重指纹仍基于原始回复文本。
- **模型调用**：通过 `ctx.modelRegistry.streamSimple(...).result()` 交由当前原生模型运行时调用 native/virtual provider，运行时在请求时解析鉴权及路由；保留现有模型配置和鉴权预检回退。请求阶段的错误、取消或空响应不触发主模型重试，不是所有请求失败都回退。
- **配置**（`agent/settings.json` 顶层 `qna` 块，缺失/损坏一律安全降级到默认值）：

  | 键 | 默认 | 说明 |
  |---|---|---|
  | `autoExtract` | `true` | 自动触发开关；关掉后 `/qna` 手动入口仍然可用 |
  | `model` | 未设置 | 抽取用的廉价模型 `{ provider, id, thinking }`。未配置时静默使用主模型；已配置但解析不出或取不到 API key 时回退到主模型**并提示**。`thinking` 取 `minimal`/`low`/`medium`/`high`/`xhigh`/`max`，非法值保留该模型但丢弃 thinking 并提示 |

- **目标模式限制**：当 planning-files-runtime 的 goal 状态为 `active` 时，自动 Q&A 被抑制，手动 `/qna` 会提示先暂停或完成目标，避免打断目标的自动 continuation。
- **测试**：`node --test agent/extensions/qna/*.test.ts`

`qna` 是回复结束后的问题抽取；包提供的 `ask_user_question` 则由 agent 在执行中主动调用，两者不是同一个入口。`agent/extensions/question-taking/` 是 qna 使用的共享交互模块，没有 `index.ts`，不独立加载。

### extmgr

- **文件**：`agent/extensions/extmgr/`
- **功能**：扩展加载管理器——`/extmgr` 交互式 picker（分组显示 global/project/effective/loaded 四列合并视图）与 `manage_extensions` 工具（list/enable/disable）。切换写入原生 Pi settings（独立扩展 `-extensions/<rel>` 精确模式、整包对象条目、项目层 delta 条目），写入形式与 `pi config` 逐字一致；不可达的原生限制格（如项目层控制全局独立扩展）明确返回 unavailable 原因而不是伪造写入。
- **交互**：`j/k` 或方向键移动、`Enter` 在活动写入层切换、`Tab` 切换 global/project 写入层、`/` 子串过滤（文件名与包源）、`a` 应用并恰好触发一次 reload、`q`/`Esc` 关闭；禁用 extmgr 自身需确认并提示 `pi config` 恢复路径。非 TUI 模式调用 `/extmgr` 会提示改用工具。
- **解析与回归边界**：目录自身和直接子目录按有效 `package.json` 的 `pi.extensions` 入口、`index.ts`、`index.js` 的顺序选择；目录自身有入口时优先于同级文件扫描。目录入口优先级与 package manifest 过滤已通过离线临时 fixture 对照当前 Pi 原生 `DefaultPackageManager` resolver 回归；差分测试仅覆盖这些场景，不代表整个解析器与原生完全等价。
- **测试**：`npm --prefix agent/extensions/extmgr test`（vitest，独立 package.json，依赖 proper-lockfile/typebox/minimatch）

### readme-check

- **文件**：`.pi/extensions/readme-check.ts`
- **范围**：仅在本配置仓库（`~/.pi`）被信任后作为项目扩展加载。
- **功能**：监听 `write`、`edit`、`replace` 和 `undo_last_replace` 的工具调用，通过 `input.path` 记录文件，并在 agent settled 后提醒检查 README 是否漂移。
- **当前限制**：未追踪 `insert` / `undo_last_change`；不携带 `path` 的纯锚点 `replace` 调用也不会被记录。它是尽力提醒，不是完整的变更审计。

### Herdr 本机集成

`agent/extensions/herdr-agent-state.ts` 由 Herdr 安装和管理，用于上报 Pi 会话与运行状态。它在本机存在并被自动发现，但已被 `.gitignore` 排除，不是本仓库维护的扩展源码；更新 Herdr 集成可能覆盖它。

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

包级可选配置持久化在本机 `agent/herdr-agents/config.json`（已被 `.gitignore` 排除）：当前记录状态上报开关、coding/review/recon/qa/architecture/docs 各任务类别的模型候选、`roles.bundled` 启用包内角色、persistent agent 上限（3 个）与 pane 分组布局。本地角色仍直接维护在 `agent/agents/`，不修改安装包。

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

## Prompt 模板（`agent/prompts/`）

`agent/prompts/` 下的 Markdown 模板注册为自定义 prompt 命令，面向所有项目，与 `extensions/` 的自动发现机制无关：

| 命令 | 文件 | 用途 |
|---|---|---|
| `/goal-review` | `goal-review.md` | 评审派发入口：父会话先准备目标/范围与完整差异证据，再以只读工具边界派发本地 `code-reviewer` 子 agent；父会话只做派发，不自行评审或修复 |
| `/wayfinder` | `wayfinder.md` | 进入 Personal Wayfinder 技能的薄封装，支持 `init`、`chart`、`work`、`status`、`ui` 等快捷入口；方法论以 `wayfinder` 技能为准 |

上文「原生入口」表中的 `/goal-review` 与 `/wayfinder` 即来自这里的模板，其余入口由包或本地扩展提供。

## 架构决策记录（`docs/adr/`）

影响仓库设计的决策记录在 `docs/adr/`。当前仅 ADR-0001：provider 扩展保持独立配置、不提取共享模型目录；文中提到的 provider 扩展目录现已不在本仓库，该篇按历史决策保留。

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

`agent/extensions/package.json` 为本地扩展开发声明 Pi 依赖，`pi-ai`、`pi-coding-agent`、`pi-tui` 均固定为本机 Pi 的确切版本。升级 Pi 后，同步这些开发依赖：

```bash
cd agent/extensions && npm run sync-pi
```
也可以从仓库根目录运行 `npm --prefix agent/extensions run sync-pi`。脚本从 PATH 查找已安装的 `pi`，跳过 npm 注入的 `node_modules/.bin`，避免读到开发依赖里的旧版本；支持 Pi 独立安装入口和 npm 全局安装，不再通过 `npm exec` 查找同名 registry 包。运行前应确保终端中的 `pi --version` 可正常执行。

在开发依赖已安装、Node.js 支持直接运行 TypeScript 的环境中，从仓库根目录运行：

```bash
node --test agent/extensions/*/*.test.ts
npm --prefix agent/extensions/extmgr test
```

前者覆盖只读命令策略、readonly-mode、planning-files-runtime、qna、共享 question-taking 状态和开发依赖版本一致性（`dev-deps/` 包含同步脚本与测试，不是运行时扩展），包括 Q&A 使用原生 `ModelRuntime` 的离线回归，验证 native/virtual provider 调用、请求时鉴权、预检回退和错误/取消处理；后者用 vitest 运行 extmgr 的测试，包括目录入口优先级与 manifest 过滤对照原生 resolver 的离线差分回归（其用例在 `extmgr/test/` 更深一层，且依赖独立的 node_modules，不被前一条 glob 匹配）。
## 未入库文件与安全

忽略规则见 [`.gitignore`](.gitignore) 与 [`agent/npm/.gitignore`](agent/npm/.gitignore)。以下内容只保存在本机，不随本仓库提交：

| 路径 | 内容 |
|---|---|
| `agent/settings.json` | 本机默认模型、包列表、Q&A / 记忆 / 重试等设置 |
| `agent/models.json` | 本机 provider / 模型定义及可能包含的认证配置 |
| `agent/auth.json` | Provider 认证凭据 |
| `agent/models-store.json` | 模型目录缓存 |
| `agent/trust.json` | 项目信任记录 |
| `agent/sessions/` | 个人会话历史 |
| `agent/npm/`（除 `.gitignore`） | 包安装清单、lockfile 和 `node_modules`，由 Pi 包管理维护 |
| `agent/extensions/node_modules/`、`agent/extensions/package-lock.json` | 本地扩展开发依赖与 lockfile |
| `agent/extensions/extmgr/node_modules/`、`agent/extensions/extmgr/package-lock.json` | extmgr 独立测试依赖与 lockfile |
| `agent/extensions/herdr-agent-state.ts` | Herdr 管理的本机集成 |
| `agent/cache`、`agent/projects-memory`、`agent/fff`、`agent/.pi-hermes-locks*`、`agent/pi-hermes-memory` | 本地缓存、记忆与历史运行状态 |
| `agent/crashes.json` | Pi 崩溃记录 |
| `agent/herdr-agents/` | pi-herdr-agents 本机包配置（`config.json`） |
| `web-search-cache/`、`agent/web-search-cache/` | 网络搜索缓存 |
| `.claude/` | Claude Code 本地设置，由全局 gitignore 排除 |

不要把真实 API Key、认证头或会话内容复制进 README。修改本机配置后，以实际文件和运行时目录为准更新本文，不应仅根据历史清单推断已安装或已可用。
