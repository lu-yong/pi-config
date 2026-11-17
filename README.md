# Pi Coding Agent 配置

本仓库维护 [Pi Coding Agent](https://pi.dev) 的全局扩展、技能、命令模板和部分配置文件。内容主要用于个人环境，也可供配置 Pi 时参考。

## 仓库内容

| 路径 | 内容 |
|---|---|
| `agent/extensions/` | 全局扩展、共享模块及开发测试 |
| `agent/skills/` | 本仓库维护的 `impl-with-spawn` 和 `wayfinder` 技能 |
| `agent/prompts/` | `/goal-review`、`/wayfinder` 命令模板 |
| `agent/subagent-manager/agents/` | 自定义 `code-reviewer` 子 agent 定义 |
| `agent/keybindings.json` | 键位覆盖 |
| `agent/extensions/pi-footer.json` | pi-footer 显示配置 |
| `web-search.json` | 网络搜索配置 |
| `docs/adr/` | 仓库的架构决策记录 |

`agent/` 对应 `~/.pi/agent/`。Pi 会自动发现 `agent/extensions/` 下的单文件扩展和带 `index.ts` 的扩展目录；共享模块不会独立加载。

## 使用与迁移

仓库不包含完整的 Pi 安装：本机包列表、模型设置和认证信息均未入库。迁移时需自行安装 Pi、所需插件和外部技能，并配置模型及凭据；仅克隆仓库不能还原完整环境。

配置文件是具体设置的依据。修改键位后可运行 `/reload`，并使用 `/hotkeys` 查看快捷键；pi-footer 可通过 `/footer` 配置。网络搜索配置中的凭据引用需要对应环境变量，迁移时也应根据实际网络环境检查配置。

## 安装插件

以下插件需要单独安装，命令默认安装到 Pi 全局配置。安装后仍需根据各插件的说明配置模型、凭据及其他本机设置。

| 插件 | 用途 | 安装命令 |
|---|---|---|
| `pi-web-access` | 网络搜索与网页内容抓取 | `pi install npm:pi-web-access` |
| `pi-files-widget-overlay` | 文件浏览、查看和 Git diff 浮动界面 | `pi install npm:pi-files-widget-overlay` |
| `pi-footer` | 可配置的多行状态栏 | `pi install git:github.com/lu-yong/pi-footer` |
| `pi-subagent-manager` | 管理可恢复的子 agent 线程 | `pi install npm:pi-subagent-manager` |
| `pi-hashline-edit-pro` | 使用行锚点读取和编辑文件 | `pi install npm:pi-hashline-edit-pro` |
| `pi-blackhole` | 上下文压缩与跨压缩的工作记忆 | `pi install npm:pi-blackhole` |
| `@firstpick/pi-themes-bundle` | 浅色和深色主题 | `pi install npm:@firstpick/pi-themes-bundle` |
| `@juicesharp/rpiv-ask-user-question` | 交互式结构化提问 | `pi install npm:@juicesharp/rpiv-ask-user-question` |

## 本仓库维护的扩展

| 扩展 | 用途与入口 |
|---|---|
| `readonly-mode` | 通过 `pi --readonly`、`/readonly` 或 `Ctrl+Alt+R` 启用或切换只读模式；仅可在 agent 空闲时切换。该模式限制文件修改工具和 bash 命令，但不约束所有自定义工具或 MCP，因此不是完整沙箱。 |
| `planning-files-runtime` | 在项目的 `.pi/planning/` 中维护计划和目标。通过 `/plan-goal-set` 制定目标，`/plan-goal-impl` 开始或恢复执行，`/planning-goal` 查看状态；其他命令和使用细节见[扩展说明](agent/extensions/planning-files-runtime/README.md)。 |
| `qna` | 在回复结束后提取问题并提供交互式回答界面，也可通过 `/qna` 手动调用。 |
| `extmgr` | 通过 `/extmgr` 管理已安装 npm 包的启用状态；修改后在界面中应用并重载。独立扩展不在管理范围内。 |

## 技能与子 agent

- [Wayfinder 使用指南](agent/skills/wayfinder/README.md)介绍如何使用 `/wayfinder` 规划多会话工作。它依赖外部命令 [taskmd](https://github.com/driangle/taskmd)，需自行安装。
- `impl-with-spawn` 提供任务拆分和子 agent 协作流程，可通过 `/skill:impl-with-spawn` 使用。
- `/goal-review` 使用 `code-reviewer` 子 agent 评审代码，依赖 `pi-subagent-manager` 和可用的 `code-review` 技能。可通过 `/agents` 管理子 agent，通过 `/agents tree` 查看线程。

除上述仓库维护的技能外，本机还可能安装其他技能和插件；具体可用内容以本机 Pi 配置为准。

## 开发与验证

在 `agent/extensions/` 和 `agent/extensions/extmgr/` 分别运行 `npm install`，安装开发和测试依赖。需要支持直接运行 TypeScript 的 Node.js 版本。

从仓库根目录运行：

```bash
node --test agent/extensions/*/*.test.ts
npm --prefix agent/extensions/extmgr test
npm --prefix agent/extensions run typecheck
```

升级 Pi 后，可运行 `npm --prefix agent/extensions run sync-pi`，将扩展开发依赖同步到当前安装的 Pi 版本。

## 未入库内容

本机的 `agent/settings.json`、模型与认证文件、会话记录、包安装目录和运行缓存不随仓库提供；完整规则见 [`.gitignore`](.gitignore) 和 [`agent/npm/.gitignore`](agent/npm/.gitignore)。不要将 API Key、认证信息或会话内容提交到仓库。
