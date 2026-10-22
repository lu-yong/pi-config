# ADR-0002: extmgr 只管理 npm 包扩展,picker 采用 pi-footer 视觉语言

- 状态:已接受
- 日期:2026-10-22

## 背景

extmgr 此前的管理范围覆盖所有已枚举扩展(standalone 文件 + npm 包),picker 是一张平铺的四列表格(Extension/Global/Project/Effective/Loaded)。两个问题:

1. 管理范围过宽——实际需求只围绕 npm 包的启停;standalone 扩展(含 extmgr 自身)不应出现在管理界面里。
2. 表格 UI 与 ~/.pi 现有的 pi-footer 配置界面风格脱节,信息密度和观感都差。

用一次性原型(`agent/extensions/extmgr/prototype/extmgr-picker-prototype.ts`,3 个结构迥异变体、←/→ 切换)对照验证后选定 **变体 A footer-menu**:圆角边框 + `•标题` + dim 副标题/快捷键提示,行首彩色 on/off 标记 + 包名 + dim 详情尾(`G:x P:y · loaded`),选中行用主题 selectedBg 高亮。

## 决策

1. extmgr 的管理范围收窄为 **npm 包扩展**:
   - `/extmgr` picker 与 `manage_extensions` 工具的 list 只显示包条目;
   - enable/disable 目标只匹配包,standalone-only 命中返回明确错误(提示改走 settings 文件);
   - standalone 以 dim 计数行 `+N standalone hidden` 透出,可发现、不占位;
   - picker 里的 extmgr 自禁用确认流程随之移除(extmgr 自身是 standalone,不再可达;`planToggle` 层的自禁用护栏保留)。
2. picker 视觉采用 pi-footer 语言(变体 A):主题色通过 `PickerTheme` 结构化接缝注入,运行时 Theme 直接满足,无头测试用恒等主题保持纯文本断言。

## 理由

管理界面只应出现能被它改变的东西:standalone 条目要么不可写(归属另一层)、要么写出的是用户不期望的 settings 形态,与其显示后拒绝,不如一开始就不出现,用一行 dim 计数说明缺席原因。变体 A 胜出因为它与 pi-footer 的 widget-list 同构(行首状态标记 + dim 尾注),整行截断天然适配窄终端,而且不需要表格列宽协商。

## 后果

- standalone 扩展的启停回归 `pi config` / 手改 settings,extmgr 不再是它的入口
- 交互键位不变(j/k、Enter、Tab、/、a、q),只有视觉与范围变化
- 原型文件保留在 `agent/extensions/extmgr/prototype/` 作为决策的一手来源,不参与加载
- 若未来需要 standalone 管理,应重新设计入口而不是恢复旧表格
