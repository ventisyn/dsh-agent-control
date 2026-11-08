# VERIFY — 0.2.2-rc.1-v1.5.3

> 本版只调整完成提醒的**时序**：先响铃声、再弹系统通知，避免两个提示音撞在一起；
> 通知形状、权限模型、探针与设置 Schema 都不变。

## 1. 问题

Windows 上的系统通知自身也会有一声提示音（由系统按应用的通知设置决定，网页的 `silent` 不一定压得住）。
真实使用中「任务完成 → 响铃 + 弹通知」会出现两个声音叠在一起。

## 2. 改动

| 位置 | 改动 |
| --- | --- |
| `client.js` | 完成边沿不再立即弹通知，而是先 `playCompletionChime`，再延迟 600ms 调 `showCompletionNotification`（`scheduleCompletionNotification`）。「测试通知」按钮走同一条路径：先响铃、再弹窗。通知仍保持 `silent: true`。 |
| `client.js`（排障） | `observe.setNotificationDelay(ms)` / `observe.notificationDelay()`：把延迟临时改成 0 或其它值，便于测试与排查。 |
| `test/client.test.mjs` | 新增 1 项：延迟窗口内不弹、窗口结束后弹出；其余通知用例显式把延迟设为 0。 |
| 文档 | `AGENTS.md` 3.11 补时序说明；`README.md` 与测试数同步。 |

## 3. 离线测试

`client` 88、`host` 83、`features` 18、`locale` 5、`session-delete` 40、`turn-delete` 25、
`restart` 54、`restart-helper` 22，合计 **335 项全部通过**（逐文件直跑）。

## 4. 真机背景（承接 v1.5.2）

- 用户在真实浏览器里点击后，**Windows 通知中心确实出现了「任务完成 / 一轮回复已经结束 / 127.0.0.1:10729」并被折叠了 8 条**——通知链路完全正常。
- 当时「不弹横幅」是系统把 Brave 的 `ShowBanner` 关成了 0（只进通知中心），属于 Windows 按应用的通知设置。
- 同一条通知附带系统提示音，正是本版要解决的冲突来源。

## 5. 仍未验证

- **两个声音错开后的实际听感**：只验证了时序（延迟窗口）与 `silent: true` 的参数，没有真人听感确认。
- **系统提示音是否被 `silent` 完全压制**：由操作系统按应用决定，网页侧无法保证；本版用「错开时序」兜底。
- **Electron 桌面版**：只保证代码路径一致。
