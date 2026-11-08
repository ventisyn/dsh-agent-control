# VERIFY — 0.2.2-rc.1-v1.5.0

> 本版相对 `0.2.2-rc.1-v1.4.0` **只有一处功能改动**：任务完成提醒那一行（`agent-control-notify`）新增「系统通知」子开关；
> 探针 `GET /api/agent-control/notify/status` 不变。纯客户端能力（浏览器 `Notification` API），host 端零改动，
> 网页版与 Electron 桌面版走同一份代码。
> **真机结果由 Lead 补充**；本文件先记录范围、改动与离线测试。记录里不写端口、路径、用户名等本机信息。

## 1. 版本与范围

| 项 | 值 |
| --- | --- |
| harness 版本线 | `0.2.2-rc.1` |
| 插件版本 | `0.2.2-rc.1-v1.5.0`（Y 位：向后兼容的新功能） |
| 上一版 | `0.2.2-rc.1-v1.4.0` |
| 功能改动 | 仅 notify 行的「系统通知」子开关（默认关） |
| host 端改动 | 无：路由、探针、组件行结构、错误码、`localStorage` 键都不变 |
| 数据改动 | 无：新设置项 `systemNotify` 仍存在 `localStorage` 的 `dsh-agent-control:observe` 里 |
| 组件行 | 仍是六行（core + session / turn / restart / notify / cost），开关语义不变 |

范围边界（本版明确不做的）：

- 不调 PowerShell / osascript / 系统级通知通道：只用浏览器标准的 `Notification` API。
- 不在完成边沿请求权限、不做授权引导弹窗：权限只从设置页的用户手势发起。
- 不新增 host 路由、模型工具或错误码：notify 行在 host 端仍然只有一条只读探针。
- 不改变铃声的判据与落点：完成边沿、`running` 的 true → false、子代理跳过、`scope=current` 全部沿用 v1.4.0。

## 2. 改动清单

| 位置 | 改动 |
| --- | --- |
| `client.js` | 系统通知运行时（构造器 / 权限 / 请求 / 弹出 / 聚焦 / 会话标题）、完成边沿的两个子开关、设置页的「系统通知」行、排障抓手与计数、`MESSAGES` 的 `notify.system.*`（zh / en） |
| `test/client.test.mjs` | 新增 4 项系统通知测试（详见下方） |
| `locale/notify/zh.json`、`locale/notify/en.json` | `meta.description` 增加「可选系统通知」；键与导出位置不变 |
| `package.json` | `version` 提到 `0.2.2-rc.1-v1.5.0`；`description` 与 `keywords`（加 `system-notification`）同步；测试脚本与 `exports` 无改动 |
| 文档 | `AGENTS.md`（3.11 / 3.8 / 3.12、能力表、测试数）、`README.md`、`docs/CONTRACT.md`（第 1、4、6 节）、`docs/PITFALLS.md`（新增坑 ⑫）；新增本文件 |

`client.js` 的改动点（按实现）：

- 默认值与归一化：`DEFAULT_OBSERVE_PREFS.systemNotify = false`；`normalizeObservePrefs` 只认 `source.systemNotify === true`（旧设置没有这个字段时按 `false`）。
- 能力探测：`notificationCtor()` / `notificationPermission()`（`granted` / `denied` / `default` / `unsupported`）/ `requestNotificationPermission()`（已经 `granted` / `denied` 或环境不支持时直接返回现状，不反复请求）。
- 通知形状：`showCompletionNotification(sessionId)` —— title「任务完成」、body 会话标题（拿不到标题时「一轮回复已经结束」）、`silent: true`、`tag` 为 `dsh-agent-control:<sessionId>`；`onclick` 关闭通知、聚焦窗口并调 `uiWorkspace.openSession(sessionId)`。权限不是 `granted` 时返回 `false`，不抛错。
- 完成边沿：`notifyCompletedSessions` 分别算 `wantChime`（`chime === true` 且 `sound !== 'none'`）与 `wantBanner`（`systemNotify === true` 且权限 `granted`）；铃声一次快照最多一声，通知按会话各一条。
- 设置页：notify 节新增「系统通知」行——复选框（`onChange` 里请求权限，允许才置 `true`）、权限状态文案、「测试通知」按钮（`granted` 才可点；点了手动弹一条并置 `true`）。环境不支持时复选框禁用。
- 排障抓手：`window.__dshAgentControl.observe.systemNotify = { supported, permission, request, show }`；`observe.stats()` 由 `{ chimes }` 变为 `{ chimes, notifications }`。
- 文案：`client.js` 内嵌 `MESSAGES` 的 `notify.system.*`（zh / en 两套）。

`test/client.test.mjs` 新增的 4 项：

1. 完成边沿按会话弹一条，标题是会话名，点击跳回该会话；
2. 未授权或开关关掉时安静跳过，`show()` 如实返回 `false`；
3. 权限只在主动调用时申请，已授权后不再反复请求；
4. 设置节里能渲染开关与权限状态，未授权时也如实说明。

## 3. 离线测试

逐个直跑（受限沙箱下 `node --test` 通配会 spawn EPERM）：`client` 85、`host` 83、`features` 18、
`locale` 5、`session-delete` 40、`turn-delete` 25、`restart` 54、`restart-helper` 22，合计 **332 项全部通过**；
`npm test` 的 `node --check` 覆盖全部源文件与测试文件。

与 v1.4.0 的 328 项相比只多了 `client` 的 4 项（81 → 85），其余文件计数不变；`locale` 仍是 5 项（说明文字的断言是通用的，不按字面锁定）。

## 4. 真机验证

### 4.1 结果：隔离实例（独立 DSH_HOME，本地 link 安装）

| 项 | 结果 |
| --- | --- |
| 插件加载 | 页面里 `window.__dshAgentControl` 存在，`features()` 报 `session / turn / restart / notify` 全为 `true`（cost 在本次隔离 profile 里处于关闭状态，与本版无关） |
| 设置页「系统通知」行 | 「任务完成提醒」一节出现该行：描述、复选框、「尚未授权」状态、「测试通知」按钮（未授权时禁用） |
| 权限初值 | `Notification` 构造可用、`permission: 'default'`、`systemNotify: false`（旧设置缺字段时也按 `false`） |
| 未授权时勾选 | 真实点击复选框后 `permission` 仍为 `default`、`systemNotify` 保持 `false`——开关不会错误打开 |
| 完成边沿 | 页面内用 `Notification` 替身模拟已授权后触发一次完成：弹 1 条，title「任务完成」、body 是会话标题、`tag` 为 `dsh-agent-control:<sessionId>`、`silent: true`；`observe.stats().notifications` 递增 |
| 无标题会话 | 正文退回「一轮回复已经结束」 |
| 点击通知 | `onclick()` 关闭该条（`closed: true`）、不抛错；跳转走 `uiWorkspace.openSession`（同一入口已在删除流程验证过） |
| 关掉子开关 | `systemNotify: false` 时完成边沿不再弹，计数不变 |
| 两个子开关独立 | `chime: false` + `systemNotify: true` 时只弹不响（`chimes` 不变） |
| 与 cost 行独立 | 隔离实例里 cost 行恰好关闭，系统通知与设置节照常出现 |
| 真实系统横幅 | **未验证**：headless 浏览器里 `requestPermission()` 只返回 `default`（CDP 授予也未生效），因此「点允许后弹出系统通知」没有真机证据 |

### 4.2 仍未验证的项

- [ ] 真实授权提示：允许后 `systemNotify: true`、刷新页面仍「已授权」；拒绝后显示「已被浏览器阻止」且完成边沿不再请求。
- [ ] 「测试通知」按钮在已授权后的实际弹出。
- [ ] 真实系统横幅的外观、免打扰 / 专注助手是否吞掉通知、`silent` 的实际听觉。
- [ ] 同一会话连续完成时同 `tag` 的替换表现为「替换而非堆叠」。
- [ ] 点击通知的窗口聚焦与真实会话切换（只验证了 `close` 与不抛错）。
- [ ] `scope=current` 与子代理会话跳过（只有离线测试覆盖）。
- [ ] 首次快照 / 重复快照不弹（离线测试覆盖，真机未复测）。
- [ ] `notify/status` 真机 200、关掉 notify 行后 404（本版未改这条路由，沿用 v1.4.0 结论）。
- [ ] Electron 桌面版的通知身份、静音与点击聚焦。
- [ ] 多标签页各自弹一条。

## 5. 仍未验证

- **真实授权与系统横幅**：见 4.2（headless 环境无法完成授权）。
- **浏览器静默忽略非手势权限请求**：按浏览器规范实现（坑 ⑫），本版未在真机上复现失败态。
- **Electron 桌面版**：通知身份、静音与点击聚焦只保证代码路径一致，未在桌面版实测。
- **系统级抑制与多标签**：免打扰 / 专注助手 / 站点静音、以及同一浏览器两个页面各自弹一条，均未专门验证。
- **无 `Notification` 的受限环境**：只有离线单测覆盖。
- **人耳听觉**：与 v1.4.0 相同，只验证播放调用与计数，未确认实际听到声音。
- **GitHub 安装形态**：沿用 v1.4.0 的结论，本版未重新装包复验。
