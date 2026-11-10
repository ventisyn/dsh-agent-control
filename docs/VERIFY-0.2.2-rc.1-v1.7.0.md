# VERIFY — 0.2.2-rc.1-v1.7.0

> 本版只改「每轮花费」的**呈现**：徽章与明细浮层对齐 DSH 官方轮次尾部「用量」按钮与「本轮用量」面板的样式。
> 价目表、查表顺序、数据来源、设置项与探针都不变。

## 1. 官方风格依据

在运行中的实例上读取官方组件（而不是猜）：

- 官方「用量」按钮（`button.Q51KRG_trigger`）：12px 字号、`label-tertiary` 颜色、
  `height: 28px`、`padding: 0 8px`、`border-radius: 8px`、透明底、`tabular-nums`；
  展开态（`aria-expanded="true"`）用 `--dsw-alias-interactive-bg-hover` 作背景。
- 官方「本轮用量」面板（`.bRhRbq_panel`）：`--dsw-specific-menu` 背景、`radius-lg`、16px 内边距、
  `title`（两端对齐）+ `titleRule`（.5px 分隔线）+ 两列 `dl`（`grid-template-columns: minmax(76px,auto) minmax(0,1fr)`，
  `dt` tertiary、`dd` secondary 且右对齐）。

## 2. 改动

| 位置 | 改动 |
| --- | --- |
| `client.js`（徽章） | `TurnCost` 从「带背景色的 span + 原生 title」改为**按钮**：硬币图标 + 金额，尺寸/颜色/圆角/交互背景全部照官方用量按钮；`aria-haspopup="dialog"`、`aria-expanded`、`focus-visible` 描边。 |
| `client.js`（浮层） | 点击展开明细浮层：标题（本轮花费 + 金额）、分隔线、两列 `dl`（提供方/模型、缓存命中率、四个 token 桶的「数量 · 单价」、合计、计价依据、说明）；未知模型也能展开，列出 token 用量与补价提示。`position: fixed` + 视口边界翻转，点外部或 Esc 收起。 |
| `client.js`（辅助） | 新增 `formatTokenCount`（千分位）、`cacheHitRate`（命中率）、`costDetailRows`（明细行）与硬币图标 `costIcon`；样式沿用官方 token（`--dsw-radius-*`、`--dsw-alias-label-*`、`--dsw-specific-menu`、`--dsw-alias-interactive-bg-hover`），明暗主题自动成立。 |
| `test/client.test.mjs` | 改造徽章用例（按钮 + 浮层内容），新增 1 项：未知模型也能量开明细、列出 token 用量与补价提示。 |

## 3. 隔离实例验证

在独立 DSH_HOME 的隔离实例上（同一套 profile 模板，本地 link 安装）：

| 项 | 结果 |
| --- | --- |
| 徽章计算样式 | `background: rgba(0,0,0,0)`、`border-radius: 8px`、`height: 28px`、`padding: 0 8px`、`color: rgb(173,178,184)`——与官方用量按钮一致 |
| 徽章结构 | `<button type="button" class="dsh-agent-control-cost" data-agent-control-turn-cost="known" aria-haspopup="dialog">` + 硬币图标 + `¥0.0288` |
| 浮层 | 点击后出现 `role="dialog"` 面板，背景 `rgba(48,49,54,0.64)`（与官方 `--dsw-specific-menu` 结果一致）；标题「本轮花费 ¥0.0288」、分隔线、两列明细齐全 |
| 明细内容 | 提供方 / 模型 `deepseek-official/deepseek-flash`、缓存命中 0.9%、`28,743 tok · ¥1/M` / `256 tok · ¥0.02/M` / `3 tok · ¥4/M`、合计 `¥0.0288`、计价依据「DeepSeek 空闲价」、说明「估算，不是账单」 |
| 未知模型 | 徽章显示「—」，展开后列出 token 用量与「在设置页填一条价格」的提示 |

## 4. 离线测试

`client` 91、`host` 83、`features` 18、`locale` 5、`session-delete` 40、`turn-delete` 25、
`restart` 54、`restart-helper` 22，合计 **338 项全部通过**（逐文件直跑）。

## 5. 仍未验证

- **真实用户浏览器的最终视觉**：只在隔离实例里用 Chromium 观察过；不同主题（浅色）下的观感未逐项核对。
- **与官方「用量」按钮并排时的对齐**：两者都在轮次尾部，但徽章在回复下方、官方用量在操作条右侧，实际行距未与官方逐个对齐。
- **超长模型名 / 极大金额**：明细里的 `overflow-wrap: anywhere` 只做了样式层面的处理，没有用真实超长路由验证。
- **浮层在小屏幕上的翻转**：只按 300×300 的估计高度做了上下翻转，未在窄窗口逐项验证。
- **键盘可达性**：按钮可聚焦、Esc 可关闭，但没有做完整的 Tab 顺序与读屏验证。
