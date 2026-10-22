# Pi Coding Agent 配置

本仓库维护 [Pi Coding Agent](https://pi.dev) 的全局扩展、技能入口和本地使用策略，并记录本机的安装与配置现状。

## 配置范围

- `agent/` 对应 `~/.pi/agent/`，其中的扩展、技能、prompt、键位和追加系统说明面向所有项目。
- `.pi/` 是**本配置仓库自己的项目配置**，目前只剩 `planning/`（planning-files-runtime 的项目状态）；项目级扩展和技能已移除，仓库根的 `AGENTS.md` 提供最小化指引，不再预设工作流。
- `agent/settings.json`、`agent/models.json`、认证文件及 npm 安装目录只保存在本机，未入库。下文的包、模型和默认设置是本机快照，**不是 clone 后即可还原的完整配置**。
- `agent/skills/` 中除 `impl-with-spawn`、`wayfinder` 外均为指向 `~/.cc-switch/skills/` 的软链接。迁移时需另行准备这些技能源，并配置包和模型认证。

## 安装的插件（Packages）

下表列出本机使用的主要包（完整列表以 `agent/settings.json` 的 `packages` 字段为准）；安装命令默认作用于全局配置：

| 包 | 用途 | Pi 安装命令 |
|---|---|---|
| `pi-web-access` | 网络搜索与网页内容抓取 | `pi install npm:pi-web-access` |
| `pi-files-widget-overlay` | 浮动文件浏览器、查看器与 Git diff overlay，入口 `/readfiles`，是 tmustier files-widget 的 overlay 化分支 | `pi install npm:pi-files-widget-overlay` |
| `pi-footer` | 可配置的多行 TUI 状态栏；配置入口 `/footer` | `pi install npm:pi-footer` |
| `pi-subagent-manager` | 在 Pi 内管理可恢复的子 agent 线程，支持并行委派、跟进和结果回传 | `pi install npm:pi-subagent-manager` |
| `pi-hashline-edit-pro` | 使用 4 字符锚点安全编辑文件，提供 `read`、`replace`、`replace_match`、`insert`、`copy`、`move`、`anchor_grep`、`undo_last_change`，禁用内置 `edit` | `pi install npm:pi-hashline-edit-pro` |
| `pi-blackhole` | 算法化压缩接管 `/compact` 与自动压缩，配合观察/反思/丢弃三个后台 worker 保存跨压缩的工作记忆 | `pi install npm:pi-blackhole` |
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
- `pi-blackhole`：压缩阈值默认走预设曲线（随模型窗口按比例触发），三个后台 worker 主用 `magpie/auto/glm-5.3-flash`、回退 `magpie/auto/deepseek-flash`（均 thinking `low`）；配置在 `agent/pi-blackhole/pi-blackhole-config.json`，不入库。
- `retry`：请求自动重试启用，最多 5 次，基础退避 15 秒。
- 默认模型、默认 thinking 与 `enabledModels` 轮换列表同为易变本机信息，以 `settings.json` 为准，不在此记录。

## 扩展（Extensions）

`agent/extensions/` 下的 `*.ts` 和 `*/index.ts` 会被 Pi 自动发现并全局加载；不需要再在 `settings.json` 中重复声明。没有入口文件的共享模块和测试目录不独立加载。

### readonly-mode

- **文件**：`agent/extensions/readonly-mode/`
- **使用方式**：`pi --readonly`、`/readonly`、`Ctrl+Alt+R`（切换仅限 agent 空闲时——指令 section 按 run 贡献，运行中切换会造成提示与工具权限脱节，扩展会拒绝并提示等待空闲）
- **拦截**：启用时拦截具名文件变更工具 `edit`、`write`、`replace`、`replace_match`、`insert`、`copy`、`move`、`undo_last_change` 和旧版 `undo_last_replace`，直接调用和嵌套调用（如通过 codemode）均受限制；`bash` 另按只读命令策略检查。
- **范围**：MCP、技能和其他自定义工具不在此模式的执行限制范围内；它不是全局无副作用沙箱。
- **提示注入**：启用时把只读指令作为 system prompt 的 `readonly-mode` section 贡献（`before_agent_start` 改 `systemPromptOptions.sections`，Pi 按 transcript diff 只落一份 patch；禁用后以 null patch 移除），不再每 run 追加 custom message，也无需 context 过滤清理。
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
- **完成审计**：Goal lifecycle 统一收集证据、执行独立审计并裁决完成：审计拒绝阻止完成；审计不可用时允许完成并提示；取消审计不接受完成。审计结果只适用于被审计的同一目标和实施运行，用量计入目标预算。
- **并发限制**：同一项目的 `.pi/planning/` 没有锁或冲突处理，应由单个 Pi 实例写入。

### qna

- **文件**：`agent/extensions/qna/`
- **功能**：普通 TUI 对话在 agent settled 后自动抽取回复中的用户问题，并通过共享 question-taking 界面收集答案；也可手动运行 `/qna`。
- **触发判定**：自动触发前先剥离围栏/缩进代码块、行内代码和 URL，再只在净化后文本的**末尾 400 字符**内判定问号，避免 `a ? b : c`、`a?.b`、query string、正文中段的反问句造成误触发。去重指纹仍基于原始回复文本。
- **模型调用**：通过 `ctx.modelRegistry.streamSimple(...).result()` 交由当前原生模型运行时调用 native/virtual provider，运行时在请求时解析鉴权及路由；保留现有模型配置和鉴权预检回退。请求阶段的错误、取消或空响应不触发主模型重试，不是所有请求失败都回退。
- **配置**（settings.json 顶层 `qna` 块，经 `pi.getSettings()` 读 global+project 合并视图，项目层可覆盖；快照在 Pi 启动/`/reload` 时载入，改配置需 reload 生效；缺失/损坏一律安全降级到默认值）：

  | 键 | 默认 | 说明 |
  |---|---|---|
  | `autoExtract` | `true` | 自动触发开关；关掉后 `/qna` 手动入口仍然可用 |
  | `model` | 未设置 | 抽取用的廉价模型 `{ provider, id, thinking }`。未配置时静默使用主模型；已配置但解析不出或取不到 API key 时回退到主模型**并提示**。`thinking` 取 `minimal`/`low`/`medium`/`high`/`xhigh`/`max`，非法值保留该模型但丢弃 thinking 并提示 |

- **目标模式限制**：当 planning-files-runtime 的 goal 状态为 `active` 时，自动 Q&A 被抑制，手动 `/qna` 会提示先暂停或完成目标，避免打断目标的自动 continuation。
- **测试**：`node --test agent/extensions/qna/*.test.ts`

`qna` 是回复结束后的问题抽取；包提供的 `ask_user_question` 则由 agent 在执行中主动调用，两者不是同一个入口。`agent/extensions/question-taking/` 只向 qna 提供 `askExtractedQuestions` 逐题问答接口，封装选项导航、自定义输入、取消传播和按题序汇总，没有 `index.ts`，不独立加载。

### extmgr

- **文件**：`agent/extensions/extmgr/`
- **功能**：扩展加载管理器（仅 npm 包，standalone 扩展不在管理范围，界面以 `+N standalone hidden` 计数透出）——`/extmgr` 交互式 picker（pi-footer 风格：圆角边框、行首 on/off 彩色标记、dim 详情尾 `G:x P:y · loaded`、主题色高亮选中行）与 `manage_extensions` 工具（list/enable/disable）。切换写入原生 Pi settings（整包对象条目、项目层 delta 条目），写入形式与 `pi config` 逐字一致；不可达的原生限制格明确返回 unavailable 原因而不是伪造写入。
- **交互**：`j/k` 或方向键移动、`Enter` 在活动写入层切换、`Tab` 切换 global/project 写入层、`/` 子串过滤（文件名与包源）、`a` 应用、`q`/`Esc` 关闭。Enter 切换立即写入设置，按输入顺序串行执行，写入层以按下 Enter 时为准；pending 按扩展和写入层统计净变更，切回原状态后抵消；`a` 等待已排队的切换完成后，恰好触发一次 reload。非 TUI 模式调用 `/extmgr` 会提示改用工具。
- **解析**：读路径直接走 Pi 原生 `DefaultPackageManager.resolve()`（Pi 1.3.0 起从包根导出）：目录发现、manifest 过滤、pattern 优先级、跨层 dedupe 等 host 语义不再由本仓库复刻；`native.ts` 把原生结果投影成 global/project/effective 三态视图（合并视图 + 仅全局视图两次 resolve）。写入保留 proper-lockfile 锁内读-改-写（公开 SettingsManager API 无法表达该临界区），原生 resolver 为 oracle 的差分 fixture 回归仍在。
- **测试**：`npm --prefix agent/extensions/extmgr test`（vitest，独立 package.json，依赖 proper-lockfile/typebox）


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

子 agent 的任务编排与审查使用下文的 `pi-subagent-manager` 入口；不再加载旧角色包提供的 `/plan` 和 `/skill:orchestrate`。

### 外部依赖：taskmd

`wayfinder` 技能依赖本机的 `taskmd` 命令（Markdown 任务管理 CLI，附带 Web 看板与 MCP server），它是显式前置依赖，不随 Pi 自动安装。其来源为 GitHub 项目 [driangle/taskmd](https://github.com/driangle/taskmd)：本机安装的是 release 压缩包 `taskmd-v0.4.1-linux-amd64.tar.gz`，解包后将二进制移至 `~/.local/bin/taskmd`，当前版本 0.4.1（commit `52dd1bf`，2026-08-19 构建）。来源通过二进制内嵌的 Go module 路径（`github.com/driangle/taskmd/...`）确认。该二进制只保存在本机、不入库；迁移机器时需从该项目 release 页重新下载对应平台的压缩包。


## 子 Agent 管理

### pi-subagent-manager

已采用 `pi-subagent-manager` 管理 Pi 子 agent，无需在 Herdr 中启动。使用 `/agents` 配置委派模式和并发限制，使用 `/agents types` 配置角色、模型和工具；修改定义后执行 `/agents reload`，新定义只影响新建线程。

### 角色与本地适配

内置 `architect`、`coder`、`researcher`、`reviewer`、`tasker`、`writer` 六种角色，另保留专用 `code-reviewer`，与通用 `reviewer` 并存。

| 角色 | 来源 | 职责 |
|---|---|---|
| `architect` | 包内 | 架构、权衡、任务分解与经授权的协调 |
| `coder` | 包内 | 实现、调试与验证 |
| `researcher` | 包内 | 代码调查和来源核实 |
| `reviewer` | 包内 | 聚焦可证明的正确性与安全缺陷 |
| `tasker` / `writer` | 包内 | 简短任务 / 文本撰写 |
| `code-reviewer` | `agent/subagent-manager/agents/code-reviewer.md` | 使用 `code-review` skill，审查需求、规范/设计、安全/可靠性 |

自定义定义的优先级为项目 `.pi/agent/subagent-manager/agents/` > 全局 `agent/subagent-manager/agents/` > 包内。Markdown 同名定义完整替换下层定义；YAML 文件仅覆盖设置。旧的 `agent/agents/` 目录不再使用。

`code-reviewer` 的 thinking 固定为 `high`，模型继承父级；允许 `read`、`bash`、`grep`、`find`、`ls`、`agent_update`、`agent_pause`，自行获取 Git 差异，也支持不依赖 diff 的指定范围审计。三个审查维度在同一线程顺序执行，不继续委派。

使用者需保证可用 skill 元数据中包含 `code-review`；该角色按元数据加载，缺失或读取失败直接报告失败并退出，不猜测安装路径。`/goal-review` 会将父会话可用的相关元数据传给子线程。

工具默认按角色的 `tools.allow` 过滤；`All except blocked` / `All` 模式会放宽这一限制。子 agent 共享工作目录和 OS 权限，工具策略不是沙箱；`bash` 只读行为由角色约束，产生文件的测试/构建交给父 agent。不要假定父会话的只读模式自动约束子线程，也不要让多个写入任务同时修改同一文件。

`agent/subagent-manager/settings.json` 和运行状态只保存在本机；仓库仅纳管 `agents/` 下的自定义定义。迁移时安装新包并移除旧的 `pi-herdr-agents` 及其依赖宿主的 `pi-herdr-roles` 包；二者的旧角色、配置和专属命令不再使用。

### 原生入口与保留的工作流

| 入口 | 用途 |
|---|---|
| `/agents` | 配置委派模式、并发限制和显示 |
| `/agents types` | 查看与编辑有效角色、模型和工具 |
| `/agents tree` | 查看、跟进和恢复子线程 |
| `/agents fork:code-reviewer <任务>` | 带入当前对话启动专用评审 |
| `/agents fresh:reviewer <任务>` | 使用独立上下文启动通用评审 |
| `/agents reload` | 重载定义与设置 |
| `/skill:impl-with-spawn <任务>` | 拆分任务、选择角色、派发、验证与整合 |
| `/goal-review <目标或变更范围>` | 将目标、范围及 skill 元数据交给专用 `code-reviewer` |

也可直接说“用 `code-reviewer` subagent 审查最后一次提交”。主 agent 通过 `agent_types` 选择类型，再调用 `agent_spawn`；使用 `agent_steer` 继续已有线程，长报告通过 `agent_output` 获取。独立任务先全部以 `wait: false` 启动，再按需等待；依赖任务顺序执行。

旧包的 `/subagent`、`/plan`、`/skill:orchestrate`、`/iterate`、`/btw` 和 `/worktree` 入口已停用；本地 planning-files-runtime 的 `/plan-*` 命令继续使用。

### 普通交互命令与长期进程

一次性非交互命令使用 `bash`；编辑器、TUI 和服务器可使用独立 Herdr pane，保留 cwd、不抢焦点、按创建响应中的 pane ID 操作。没有 Herdr 时提供手动终端命令。Herdr 仅用于普通终端进程，子 agent 由 `pi-subagent-manager` 管理。

`/wayfinder ui` 也按此规则启动 taskmd Web UI，而不是为服务器派一个 Pi 子 agent；报告 URL、pane ID、启动证据和 Ctrl+C 停止方式。taskmd 仍是显式前置依赖，不会自动安装。

临时仓库检索仍优先使用 `rg`、`fd` 和 `rg --files`；仅在需要精确语义或替代工具不可用时回退到 shell `grep`/`find`，不限制 Pi 内置同名工具。

## Prompt 模板（`agent/prompts/`）

`agent/prompts/` 下的 Markdown 模板注册为自定义 prompt 命令，面向所有项目，与 `extensions/` 的自动发现机制无关：

| 命令 | 文件 | 用途 |
|---|---|---|
| `/goal-review` | `goal-review.md` | 评审派发入口：将目标、范围、已有验证结果及 skill 元数据交给 `code-reviewer`，由子线程自行获取差异并审查；父会话只做派发 |
| `/wayfinder` | `wayfinder.md` | 进入 Personal Wayfinder 技能的薄封装，支持 `init`、`chart`、`work`、`status`、`ui` 等快捷入口；方法论以 `wayfinder` 技能为准 |

`/goal-review` 与 `/wayfinder` 来自这里的模板，其余入口由包或本地扩展提供。

## 架构决策记录（`docs/adr/`）

影响仓库设计的决策记录在 `docs/adr/`。当前仅 ADR-0001：provider 扩展保持独立配置、不提取共享模型目录；文中提到的 provider 扩展目录现已不在本仓库，该篇按历史决策保留。

## TUI 配置

### 主题与模式（`agent/settings.json`，本机）

- **主题**：`tokyo-night-storm`（`@firstpick/pi-themes-bundle` 提供）。
- **TUI 模式**：`fullscreen`。
- 当前没有 `agent/zentui.json`，也未在 `packages` 中启用独立的 zentui 包。

### pi-footer（`agent/extensions/pi-footer.json`）

- **状态与入口**：已启用；`/footer` 打开配置界面，`/footer on`、`/footer off` 控制开关。界面修改需显式保存才写入配置文件。
- **配置纳管**：`agent/extensions/pi-footer.json` 纳入本仓库；默认从 `~/.pi/agent/extensions/pi-footer.json` 读取，可通过 `PI_FOOTER_CONFIG` 指定其他路径。
- **布局**：基于 `default` preset 自定义两行，均使用 `flex-separator` 将后续组件右对齐。
  - 第一行：当前目录（`cwd`）、Git 分支（`git-branch`）、紧凑 diff（`git-diff`）；右侧显示输入/输出 Token（`tokens`）、会话缓存命中率（`cache-hit-rate`）和会话总耗时（`total-time`）。
  - 第二行：模型（`model`，不显示 provider）和思考级别（`thinking-level`）；右侧显示上下文进度条（`context-bar`，`medium` 模式，关闭条件着色）。
- **显示**：点分隔符（`separator: "dot"`）、Nerd Font 图标（`iconMode: "nerd"`，终端需配套字体）、全宽（`widthMode: "full"`）、256 色（`colorLevel: "ansi256"`）；未启用 minimalist 模式。

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

前者覆盖只读命令策略、readonly-mode、planning-files-runtime、qna、共享 question-taking 交互模块和开发依赖版本一致性（`dev-deps/` 包含同步脚本与测试，不是运行时扩展），包括 Q&A 使用原生 `ModelRuntime` 的离线回归，验证 native/virtual provider 调用、请求时鉴权、预检回退和错误/取消处理；后者用 vitest 运行 extmgr 的测试，包括以原生 resolver 为 oracle 的差分回归与三态投影（其用例在 `extmgr/test/` 更深一层，且依赖独立的 node_modules，不被前一条 glob 匹配）。
## 未入库文件与安全

忽略规则见 [`.gitignore`](.gitignore) 与 [`agent/npm/.gitignore`](agent/npm/.gitignore)。以下内容只保存在本机，不随本仓库提交：

| 路径 | 内容 |
|---|---|
| `agent/settings.json` | 本机默认模型、包列表、Q&A / 重试等设置 |
| `agent/pi-blackhole/` | pi-blackhole 的本机配置、会话账本与模型冷却状态 |
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
| `agent/subagent-manager/`（除 `agents/`） | 本机设置与运行状态 |
| `web-search-cache/`、`agent/web-search-cache/` | 网络搜索缓存 |
| `.claude/` | Claude Code 本地设置，由全局 gitignore 排除 |

不要把真实 API Key、认证头或会话内容复制进 README。修改本机配置后，以实际文件和运行时目录为准更新本文，不应仅根据历史清单推断已安装或已可用。
