# ADR-0002: extmgr 不管理 standalone 扩展——列表隐藏,仅以 dim 计数透出

- 状态:已接受
- 日期:2026-10-22

## 背景

extmgr 此前的管理范围覆盖所有已枚举扩展(standalone 文件 + npm 包):picker 与 `manage_extensions` 工具都会列出 standalone 条目,并支持对它们启停。问题:实际需求只围绕 npm 包的启停;standalone 条目要么在活动写入层不可写(归属另一层),要么写出的是用户不期望的 settings 形态——与其显示后再拒绝,不如一开始就不出现。

配套的界面问题(如何交代 standalone 的缺席)在原型评审时二选一:**显示 dim 计数行 `+N standalone hidden`** vs 完全不提,选定前者。

## 决策

1. extmgr 的管理范围收窄为 **npm 包扩展**:
   - `/extmgr` picker 与 `manage_extensions` 工具的 list 只显示包条目,standalone 一律不出现在列表里;
   - enable/disable 目标只匹配包,standalone-only 命中返回明确错误(提示改走 settings 文件);
   - standalone 的存在以一行 dim 计数 `+N standalone hidden` 透出——可发现、可解释,不占列表位置。
2. picker 里的 extmgr 自禁用确认流程随之移除:extmgr 自身是 standalone 扩展,在新范围下永不可达;`planToggle` 层的自禁用护栏(含 `pi config` 恢复路径提示)保留,作为该模块自身契约继续被测试钉住。

## 理由

管理界面只应出现能被它改变的东西。dim 计数行是"隐藏"与"沉默"之间的折中:用户能看到 standalone 扩展确实存在、只是不受 extmgr 管理,不会误以为它们丢失;同时列表本身保持纯净,每一行都可操作。

## 后果

- standalone 扩展(含 extmgr 自身)的启停回归 `pi config` / 手改 settings,extmgr 不再是它们的入口
- 若未来需要 standalone 管理,应重新设计入口,而不是把旧列表恢复回来
- 同期 picker 的视觉重设计见 ADR-0003
