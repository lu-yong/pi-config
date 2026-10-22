# ADR-0003: extmgr picker 采用 pi-footer 视觉语言(原型变体 A footer-menu)

- 状态:已接受
- 日期:2026-10-22

## 背景

/extmgr picker 原是一张平铺四列表格(Extension/Global/Project/Effective/Loaded 列宽协商、分组标题),与 ~/.pi 现有 pi-footer 配置界面的视觉语言脱节。用一次性原型(`agent/extensions/extmgr/prototype/extmgr-picker-prototype.ts`,3 个结构迥异变体、←/→ 实时切换、enter/tab 可试交互)对照验证:A footer-menu(平铺行)、B table(分组列)、C master-detail(包列表+详情框)。

## 决策

选定 **变体 A footer-menu**,即 pi-footer widget-list 的同构形态:

- 圆角边框(`╭── Extensions ─╮`),每行 `│ … │` 包裹,整行截断+补齐;
- `•标题` + dim 副标题、dim 快捷键提示行、dim 计数行(含 ADR-0002 的 `+N standalone hidden`);
- 行结构 = 行首彩色 on/off 标记(活动写入层状态)+ 名称 + dim 详情尾(`G:x P:y · loaded`);多文件包行名带 `pkg/file` 前缀,入口文件显示包名;
- 选中行 `›` 前缀,整行用主题 `selectedBg` + accent 高亮;
- 主题色通过 `PickerTheme` 结构化接缝注入:运行时 `Theme` 结构化满足,无头测试用恒等主题保持纯文本断言。

交互键位不变(j/k、Enter、Tab、/、a、q),只有视觉变化。

## 理由

与 pi-footer 的 widget-list 同构(行首状态标记 + dim 尾注),学习成本为零;整行截断天然适配窄终端,不需要表格列宽协商;B 保留列结构仍是旧表格的心智,C 的包粒度列表把文件级状态挤进详情框,日常启停场景多一步。

## 后果

- 原型文件保留在 `agent/extensions/extmgr/prototype/` 作为决策的一手来源,不参与加载
- 后续 picker 改版应先跑原型变体对照,再折回(沿用本次流程)
