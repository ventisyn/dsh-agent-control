# VERIFY — 0.2.2-rc.1-v1.4.0

> 本版新增两个**独立开关**的浏览器端功能：任务完成提醒（`notify` 行）与每轮花费（`cost` 行）。
> 验证在**隔离实例**（独立 `DSH_HOME`、独立端口、不碰真实数据）上进行；被测插件是该分支的
> 本地工作副本（`link:` 安装），依赖树用 junction 复用真实 profile。
> 记录里不写端口、路径、用户名等本机信息。

## 1. 改了什么

| 位置 | 改动 |
| --- | --- |
| `package.json` | `version` 提到 `0.2.2-rc.1-v1.4.0`；`exports` 增加 `./notify`、`./cost` 与各自的 locale 子路径；`npm test` 的语法检查加两个组件入口 |
| `src/shared.mjs` | `PATHS.notifyStatus` / `PATHS.costStatus`；`FEATURES.notify` / `FEATURES.cost` |
| `src/host-wiring.mjs` | `applyNotifyFeature` / `applyCostFeature`：各只注册一条只读探针，无 POST、无模型工具 |
| `src/notify-plugin.mjs`、`src/cost-plugin.mjs` | 两个组件行的入口（结构照抄 session / turn / restart 行） |
| `src/index.mjs` | 两条「没有自己那一行时由主入口代装」的分支 |
| `cordis.patch.yml` | 五行 → 六行：主行 + session / turn / restart / notify / cost |
| `locale/notify/`、`locale/cost/` | 两行在插件列表里的说明文字（en / zh） |
| `client.js` | 两个独立探针、三条槽位条目（花费徽章 + 两节设置页）、铃声运行时只在 notify 可用时装配；Web Audio 合成三种提示音；价目表与峰谷判定 |
| `test/*.test.mjs` | 五条探针、八条槽位条目、notify / cost 各自关闭时另一侧照常、金额/峰谷/设置/铃声边沿 |

## 2. 验证结果

### 2.1 六行结构与两条探针 ✅

`dsh --profile <隔离 profile> --dump-config` 的 `# == dsh-agent-control` 段列出六行：

```
agent-control            （主行）
agent-control-session
agent-control-turn
agent-control-restart
agent-control-notify
agent-control-cost
```

页面上下文里探测：

| 路由 | 结果 |
| --- | --- |
| `GET /api/agent-control/notify/status` | 200 `{ ok: true, enabled: true }` |
| `GET /api/agent-control/cost/status` | 200 `{ ok: true, enabled: true }` |
| `GET /api/agent-control/observe/status`（上一版的路由） | 404（升级后旧路由确实消失） |

### 2.2 插件列表与说明文字 ✅

插件详情页的「包含的组件」显示 **共 6 个 · 6 运行中**，其中两行的说明文字来自新加的 locale 文件：

- `dsh-agent-control/notify` — 「任务完成提醒：说完一轮时响一声提示音（可选音效与音量）。」
- `dsh-agent-control/cost` — 「每轮花费：在每轮回复下方显示这一轮大概花了多少钱（按 token 用量与价目表估算）。」

排障抓手 `window.__dshAgentControl.features()` 返回
`{ session: true, turn: true, restart: true, notify: true, cost: true }`。

### 2.3 设置页三节 ✅

设置面板里本插件的三个页签都在：**热重启**、**任务完成提醒**、**每轮花费**。

- 任务完成提醒：开关、音效（三音 / 单音 / 钟声 / 不响）、试听、音量（默认 60%）、提醒范围（所有会话 / 仅当前会话）。
- 每轮花费：花费开关、价目表说明、保存价目表 / 恢复内置价目表。

### 2.4 每轮花费徽章（真实一轮）✅

在隔离实例里发一条普通消息，等一轮结束：

- 回复下方出现徽章 `¥0.0288`，`data-agent-control-turn-cost="known"`；
- `title` 明细为：`输入（未命中缓存）: 28743 × ¥1/M`、`输入（命中缓存）: 256 × ¥0.02/M`、
  `输出: 3 × ¥4/M`、`合计（估算）: ¥0.0288`、`按空闲时段单价计算`；
- 该轮结束时是北京时间夜间（空闲时段），因此用的是 `deepseek-flash` 空闲单价（1 / 0.02 / 4），
  与内置表一致；金额是估算，不是账单。

### 2.5 完成提醒真的触发了 ✅

同一轮结束时，排障抓手 `window.__dshAgentControl.observe.stats()` 的 `chimes` 从 0 变成 **1**：
订阅 `uiSession.sessionStatus`、识别 `running` 的 true → false 边沿、调用播放这条链路在真实页面上成立。

> 只验证到「播放调用发生」，没有做人耳听觉确认（见「仍然未验证」）。

### 2.6 两个开关互不影响（双向）✅

在隔离 profile 的 `cordis.patch.yml` 里写入 `- id: agent-control-notify` + `disabled: true`，重启后：

| 检查 | 结果 |
| --- | --- |
| `/notify/status` | **404** |
| `/cost/status` | 200 |
| `features()` | `notify: false`、`cost: true` |
| 每轮花费徽章 | 仍在（`¥0.0288`） |
| 设置页 | 只剩「热重启」「每轮花费」 |

反向：把 `disabled` 改到 `- id: agent-control-cost`，重启后：

| 检查 | 结果 |
| --- | --- |
| `/notify/status` | 200 |
| `/cost/status` | **404** |
| `features()` | `notify: true`、`cost: false` |
| 每轮花费徽章 | 已消失 |
| 设置页 | 只剩「热重启」「任务完成提醒」 |

与 AGENTS.md 3.10 / 3.11 / 3.12 的语义一致：两个开关是独立的，关掉一个不影响另一个。

## 3. 离线测试

逐个直跑（本机沙箱下 `node --test` 通配会 spawn EPERM）：`host` 83、`client` 81、`features` 18、
`locale` 5、`session-delete` 40、`turn-delete` 25、`restart` 54、`restart-helper` 22，合计 **328 项全部通过**；
`node --check` 覆盖全部改动源文件与测试文件。

## 4. 仍然未验证

- **GitHub 安装形态**：本轮验证用的是 `link:` 本地工作副本；发布后以 `github:…#release/<版本>` 安装的包
  没有单独复验（内容相同，只是获取方式不同）。
- **人耳听觉**：只验证了播放调用（`stats.chimes` 递增）与 AudioContext 可用，没有确认实际听到声音，
  也没有验证系统音量/静音键、浏览器站点静音的影响。
- **高峰时段计价**：验证发生在空闲时段；高峰（工作日 09:00–12:00、14:00–18:00）只有离线单测覆盖，
  且节假日按工作日算会高估一倍，未在真实节假日核对。
- **未知模型「—」与多路由的一轮**：只有离线测试；真机上还没有碰到不在价目表里的路由。
- **主行被关掉时两行 fiber 停在 pending**：离线覆盖（服务依赖语义），本轮未在隔离实例上再关一次主行。
- **子代理会话完成不响铃**：离线覆盖判断分支，真机没有造子代理会话验证。
- **localStorage 的跨浏览器/隐私模式行为**：未测；设置只存在当前浏览器，换浏览器回到默认值。
- **多标签页**：同一浏览器开两个页面时，两个页面都会各自响铃（每个页面一份订阅），未专门验证。
