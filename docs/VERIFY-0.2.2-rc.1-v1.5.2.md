# VERIFY — 0.2.2-rc.1-v1.5.2

> 本版只修「测试通知」按钮在**授权请求永不落定**时的无反馈问题；通知形状、权限模型、
> 完成边沿、探针与设置 Schema 都不变。

## 1. 问题

在真实实例的页面上点「测试通知」，点击前后界面没有任何变化：没有「已发出」、没有「没有授予通知权限」，
`observe.stats().notifications` 也不变。按钮本身可点（v1.5.1 已不再依赖过期的权限状态）。

复现时页面里的 `Notification.permission` 是 `default`，`requestNotificationPermission()` 调用后
返回的 Promise 既不弹授权框也不落定——于是 `.then` 里的结果展示永远不会执行。

## 2. 根因

`requestPermission()` 在部分环境（无头浏览器、被站点策略阻断的页面）会返回一个**永不落定**的 Promise。
v1.5.1 直接 `pending.then(...)`，没有超时，所以点击后既没有成功反馈、也没有失败反馈。

## 3. 改动

| 位置 | 改动 |
| --- | --- |
| `client.js` | `requestNotificationPermission()` 增加 6 秒超时兜底：超时按当前权限返回结果，调用方总能拿到一个值。点击「测试通知」后**立即**显示「正在申请通知权限…」，授权框未回也不至于像没点上。测试通知改为带声音（`silent: false`）并继续用唯一 tag，方便确认它真的出现了。 |
| `test/client.test.mjs` | 新增 1 项：`requestPermission()` 返回永不落定的 Promise 时，`request()` 仍在超时后返回当前权限。 |
| 文档 | `AGENTS.md` / `README.md` 测试数；`docs/PITFALLS.md` 坑 ⑬ 补充「Promise 永不落定」这一条。 |

## 4. 离线测试

`client` 87、`host` 83、`features` 18、`locale` 5、`session-delete` 40、`turn-delete` 25、
`restart` 54、`restart-helper` 22，合计 **334 项全部通过**（逐文件直跑）。

## 5. 真机复现与验证

| 项 | 结果 |
| --- | --- |
| 复现 | 在真实实例页面上点击「测试通知」：点击前后页面文本没有任何变化，`stats().notifications` 保持 0，`Notification.permission` 仍为 `default` |
| 修复后的行为（离线覆盖） | 点击立即显示「正在申请通知权限…」；授权请求超时后显示「浏览器没有授予通知权限」；已授权时显示「已发出」 |
| 已授权时真实弹出 | 此前在隔离实例上以页面内替身验证过（title / 会话标题 / tag / silent），本版只把测试通知改为带声音 |

## 6. 仍未验证

- **真实浏览器里点「允许」后 Windows 通知中心是否出现横幅**：本机浏览器环境无法完成真实授权，
  这一步仍然只有离线与替身证据。
- **系统级抑制**：专注助手 / Windows 通知设置是否吞掉横幅，未测。
- **Electron 桌面版**：只保证代码路径一致。
