# CONTRACT：路由、事件、服务与边界（细则）

[AGENTS.md](AGENTS.md) 第 3 节是每节的要点与不变量，本文件是它们的原文：路由表、事件形状、服务边界、实测数字、加载期约束。改这些面时逐条对照。本文件内容按 2026-10-15 从 AGENTS.md 原样搬移，只改了标题层级。

## 1. HTTP 接口（AGENTS.md 3.5）

```
GET  /api/agent-control/sessions               # { ok, sessions: [{ sessionId, workspaceTitle, cwd, running, live, removable, reasons }] }（workspaceTitle 是工作区名，不是会话标题）
GET  /api/agent-control/turns?sessionId=       # { ok, sessionId, turns: number[] }（该会话已删的轮次，墓碑是持久事实）
                                               # ⚠️ 只在**活动会话**上可读：读取走 ctx.sessions.get(id)，重启后没被打开过的会话
                                               # 返回 TARGET_NOT_FOUND（与「本来就没有删除记录」同码）。答案本身是持久的：
                                               # 打开会话后与重启前逐字一致（VERIFY 第 10 节）
GET  /api/agent-control/session/status         # { ok: true, enabled: true } ——「会话」组件的**只读可用性探针**
                                               # 客户端在挂载时各拉一次，探不到（404 / 鉴权 fallback）就不注册对应的界面入口（3.10）
                                               # 只读、无参数、不改状态，所以不加可信校验
POST /api/agent-control/session/delete         # { sessionId }
POST /api/agent-control/turn/delete            # { sessionId, assistantMessageId }
GET  /api/agent-control/turn/status            # 「轮次」组件的只读探针（同上）
GET  /api/agent-control/restart/status         # { ok, bootId, pid, startedAt, port, canRestart, unsupportedReason?,
                                               #   blockers: { sessions: [...], jobs: number }, pending, last }
                                               # 热重启：**同时是辅助进程的就绪探针**，所以它必须允许无凭据访问；
                                               # 只暴露状态，不接受任何状态变更
POST /api/agent-control/restart                # { reason?, force? } → 202 { ok, restartId }
                                               # 唯一会改变进程状态的接口 ⇒ 必须过可信校验（见下）
POST /api/agent-control/shutdown               # { }（可空体）→ 202 { ok }
                                               # 关闭整个实例（ctx.appExit(0)）。**只从界面触发**，没有对应的模型工具：
                                               # 关掉实例会让所有会话一起死且不会自动续作，这个决定只能由人来做。
                                               # 与 /restart 共用同一道可信校验；⚠️ 响应必须**先于**退出发出（见 3.9）
```

失败一律 `{ ok: false, error: { code, message } }`，状态码由错误码映射（400 / 403 / 404 / 409 / 423 / 429 / 501）。**自建路由本身没有 harness 的鉴权**：DSH 的插件自建路由不走 harness 的鉴权链路，端口可达就能发请求。所以四个 POST 路由（`/session/delete`、`/turn/delete`、`/restart`、`/shutdown`）都过同一个 `assertTrustedJsonRequest`（`src/index.mjs`）：先可信校验、后要求 `content-type: application/json`（否则别的网页能用 `<form enctype="text/plain">` 跨站触发）。可信校验**优先用宿主的 `ctx.connection.requestRejection`，宿主服务不可用时靠自实现兜底**（见下面 `POST /restart` 那一条）；删除路由被拒的错误码是 `REQUEST_DENIED`（403，宿主给 401 时照抄 401），与 `RESTART_DENIED` / `SHUTDOWN_DENIED` 分开。`GET /sessions`、`GET /turns` 只读，不加这道校验。因此：

- 请求体必须校验：字段存在、类型、id 形状（只允许 `[A-Za-z0-9._:-]`、**首字符必须是字母或数字**、去掉 `session-` 前缀后同样如此、拒绝 `..`；否则 `.` / `session-` / `session-.` 会拼出 slug 目录本身，被当成会话目录整个删掉）、长度上限、请求体上限 64 KiB
- **不要在 UI 之外额外暴露批量删除**，除非当轮就想清楚误删的后果
- 端口若绑到非回环地址（`webServer.config.host` 支持 `0.0.0.0`），等于把「删除我的会话」暴露给整个网络；文档与 README 里要写明
- **`POST /restart` 是这里唯一会改变进程状态的接口，可信校验（两个删除路由与 `/shutdown` 用的是同一道）**：优先用宿主公开的 `ctx.connection.requestRejection({ headers })`（它做的是宿主自己的 Host/Origin 校验**加浏览器鉴权**，返回 401/403 就照抄）；拿不到该服务时退回自实现——`Origin` 存在时其 host 必须等于 `Host` 头，缺失 `Origin` 时必须带自定义头 `x-dsh-agent-control: 1`。缺了这道校验，任何能打开一个网页的人都能 CSRF 掉整个实例。
  - ⚠️ **实测（v1.1.0）**：`requestRejection` 会把「没有浏览器凭据」的请求**直接判 401**，所以回调里的自实现路径在正常部署下**根本走不到**——这不是缺陷，是比计划更严的结果：界面上同源已登录的请求照常通过，脚本/未登录调用者拿到 401 而不是靠一个自定义头就能放行。
- `GET /restart/status` **故意不做可信校验**：辅助进程在新进程刚起来、还没有任何凭据的时候就要靠它判断就绪。它只读、不改变任何状态，可以接受这个暴露面（能访问端口的人能读到 pid / 端口 / 阻塞会话 id / 最近一次结果）。

**路由注册必须把 disposer 返回出去**（`ctx.effect(() => ctx.webServer.register({...}))`）：`register` 对重复 `(kind, path)` 会抛错；如果注册写成返回 `undefined` 的箭头函数，注销就完全靠 fiber 卸载——重复 `apply` 会撞上（第 4 节）。


## 2. 会话日志诊断器（AGENTS.md 3.6）

轮次删除的正确性看不见摸不着（界面上少了几行而已），所以**不要靠感觉判断**。`test/log-inspect.mjs`
是只读诊断器，回答三个问题：

| 问题 | 它给出的证据 |
| --- | --- |
| 删除到底发生了没有 | 墓碑清单：`seq` / 遮蔽 `turn` / 区间 `startSeq..endSeq` / 写入时间 |
| 删的范围对不对 | 逐轮「磁盘 seq 区间 vs 表面可见条数」对照，以及**独立复刻**的 surface 代数结果 |
| 还剩什么 | 被遮蔽事件的原文预览 —— **这就是「不是安全删除」的直接证据** |

墓碑的**形状**也顺手核对（`id` 是非空字符串、`surfaceOp` 恰好 `op/startSeq/endSeq` 三个键、
`sourceEventSeqs` 只在 `system/message` 上）——坑 ① 与坑 ⑧ 都会在这里当场露出来。

```sh
node test/log-inspect.mjs <会话 id | 日志文件路径> [--json]
```

⚠️ 两个必须知道的实现细节：会话日志是**多帧拼接**的 zstd（单帧解压只得到 253 字节的会话头，
看起来像日志空了，见第 9 节第 6 步）；它**只读**，不写文件、不碰 profile。


## 3. 加载期：别让一个 import 弄死整个插件（AGENTS.md 3.7）

本插件运行在**别人的进程**里，裸模块（`@deepseek-ai/*`）能不能解析取决于宿主 loader。顶层静态 import 一旦解析失败，**整个插件消失**：host 模块加载失败 → 所有路由 404 → 界面上什么都不出现。因此：

- **host 端不 import 任何 `@deepseek-ai/*` 包**，只用 Node 内置模块与 `ctx` 上的服务。（v1.0.0 曾在 `src/tombstone.mjs` 懒加载 `@deepseek-ai/dsh-llm`，实测从插件位置**解析不到**、一直走兜底；删除事务改为自己构造消息后，这个文件已删除。）
- **客户端 `require` 解构出来的每个东西都要假定可能不存在**：`require('@deepseek-ai/dsh-client-ui-primitives')` 包在 try/catch 里，拿不到就退回自带的内联 SVG 垃圾桶与确认框（**仍然要求显式勾选**）。这类问题在别处真实发生过：一个不存在的图标名就让组件渲染抛错（第 4 节坑 ③）。

排障抓手：浏览器控制台里 `window.__dshAgentControl.usingNativePrimitives()` 告诉你这次用的是原生原语还是兜底；`window.__dshAgentControl.features()` 给出这次挂载探测到的组件开关（`true` / `false` / `null`，见 3.10）；`window.__dshAgentControl.apply` 是注册函数本体。


## 4. 数据与运行环境（AGENTS.md 3.8）

**这个插件自己不落任何数据文件**：没有配置、没有审计日志、没有缓存。唯一的持久事实是它写进会话日志的**墓碑**，那份数据归会话自己所有。删除操作的可观测性靠 harness 日志与接口响应，不要为了「看着专业」造一份本地流水。

**唯一的受控例外：热重启的交接文件**（`<DSH_HOME>/agent-control/restart/`）。理由是这个功能**必须跨进程边界传递状态**——旧进程在退出前要把「重启后该做什么」交给一个还不存在的新进程，除了磁盘没有别的通道：

| 文件 | 内容 | 生命周期 |
| --- | --- | --- |
| `pending.json` | 待续作的会话、原因、续作说明、`restartId`、状态 | 旧进程写；**新进程读一次就删**（至多投递一次，宁可漏不重复）；超过 10 分钟视为过期直接丢弃 |
| `spec.json` | 重放启动所需的现场：`execPath`/`execArgv`/`argv`/`cwd`/**`env`** | 辅助进程读；**新进程启动后删**（含过期清理）。含环境变量，权限收到仅当前用户，且**绝不把 env 的值写进日志**（只记变量名数量） |
| `last.json` | 最近一次重启的结果（时间、耗时、来源、原因、续作是否投递成功） | 给设置页显示，**不删** |
| `<DSH_HOME>/logs/agent-control-restart-<时间戳>.log` | 新进程的 stdout/stderr | 辅助进程重定向写入；排障用，中文内容按 UTF-8 读 |

除此之外**不要再往这个目录加东西**（不要审计流水、不要历史记录）：这个例外的边界就是「跨进程交接所必需」，任何可以放在内存或日志里的东西都不该落盘。

`docs/VERIFY-*.md` 记录每次实测（第 9 节），那是给人和代理看的文档，不是运行时数据。

**客户端这一面本文件写得最薄，是刻意的**：槽位种类、owner props、`ClientSessions` 的真实成员、可用图标名，全都要在**活页面上**核对（`cordis_inspect_query` 的 `Slots.listSubTree`、浏览器控制台、primitives 的导出名单）。本文件里凡是没标「已核对 / 已实测」的客户端说法，都只当线索，不要当契约。


## 5. 热重启与关闭实例（AGENTS.md 3.9）

**动机**：DSH 没有内置重启，而 host 端模块不会热加载（坑 ⑦）——改了宿主插件就必须重启进程，而重启会打断正在做的事。热重启把这件事收进同一个插件：**模型可以请求重启并在重启后自动继续**，用户也可以在设置页点一次（`docs/adr/0001-hot-restart-via-detached-helper.md` 记了为什么是「脱离式辅助进程」）。

**唯一入口是 `requestRestart`**（`src/restart-tool.mjs`）：模型工具 `restart_harness` 与 `POST /restart` 走同一条路径，守卫、限频、审批、时序完全一致。

```
模型路径：守卫 → 审批 → 写 pending → 返回工具结果 + concludeTurn()
   → 后台任务：whenIdle(≤30s) → flush===true → 复查阻塞项 → spec.json → spawn(detached) → appExit(0)
界面路径：同样的守卫（不审批——点按钮本身就是授权）→ 写 pending → 202 → 同一个后台任务
```

**绝不能违反的三条**：

1. **绝不在工具执行期间退出进程**：工具调用没有对应结果就进程死亡，日志尾部不合法（坑 ⑪）。所以工具**先返回结果**，退出由后台任务在双门之后执行。
2. **`flush` 不为 `true` 就不退出**——宁可这次不重启，也不能写坏日志尾部；这种情况走取消路径并如实通知会话。
3. **`force` 只跳过阻塞项**：单飞与预检永不跳过（预检不过 ⇒ `RESTART_UNSUPPORTED`，绝不因为「辅助进程会兜底」就放行）。

**辅助进程**（`src/restart-helper.mjs`）活在旧进程之外：等旧 pid 退出（超时→硬杀）→ 等端口释放 → 按重放规格起新进程（**stdio 只能是 `'ignore'` 或文件描述符**）→ 轮询 `/restart/status` 等 `bootId` 变化 → 写 `last.json`。它**只认文件**，不 import 本仓库任何模块。

**新进程**在应用就绪后读 `pending.json`：过期（>10 分钟）丢弃并 warn → **先删 pending**（至多投递一次）→ `sessionController.resolveAgent` + `prompt` 投递续作消息 → 结果合并写进 `last.json`。界面发起的重启没有要续作的会话，只记 `resume: 'none'`。

⚠️ **`last.json` 有两个写入者**（新进程写「谁发起的 / 为什么 / 续作成不成」，辅助进程写「重放结果 / 新 pid / 耗时」），两边都必须**合并写**，且辅助进程只在 `restartId` 相同时合并——这份文件跨重启复用，无条件合并会把上一次的结果带过来。真机踩过一次：辅助进程整份覆盖，设置页的「最近一次重启」就只剩时间和 pid。

**已知限制（必须如实写进文档，不许假装统计全了）**：

- 宿主的作业列表**按所有者隔离**（`jobs.list(caller)` 只给调用者自己的 + 无主作业），所以「后台任务在跑」这一项**看不到别的会话启动的任务**；别的会话只能靠 agent 的 `running` 状态发现。
- **桌面启动器（DSHL）托管的实例：重启后会变成孤儿进程**。实测（v1.1.0）：重启成功、辅助进程也没被杀，但**启动器认不出新进程**——实例从它的列表里消失，它既看不到也停不掉（要从任务管理器收尸），还可能允许对同一个 profile 再启动一次（两个实例争端口）。
  - 机制（由它自己的日志与可观察行为得出）：它**按自己 spawn 的子进程 PID** 认实例（就绪判定 = 读子进程 stdout 的登录横幅）；进程一退出就记「已退出」；只有**它自己启动时**才做一次「核验并恢复监控」，判据是那条记录的进程**是否还活着、身份是否相符** ⇒ 新 PID 不会被认领。它的对接记录是**私有格式**（`%LOCALAPPDATA%\DSHL\Sessions\*.session`），**不要**去改写它。
  - 这需要启动器提供重启接口才能解决，而计划明确「不控制 DSHL、不假设它有这种接口」，所以只能文档化。
  - **本项目的决定（v1.1.0）**：**不为它加代码**——不加「自动检测到启动器托管就禁用模型工具」的开关（argv 与命令行启动完全一样，检测不可靠），也不去改写启动器的私有记录。孤儿的收尾交给设置页的「关闭实例」。

**界面**：设置页一页（`settings.section`，id `agent-control-restart`）+ `shell.overlay` 里的**非阻塞横幅**。⚠️ **不做自动 `location.reload()`**——S4 实测页面会自己恢复；只有失败态里用户点「刷新页面」才 reload。横幅在设置面板打开时会被挡住（overlay 的 z-index 低于面板），进度此时显示在设置页那一行里。

**关闭实例**（同一页里的第二个按钮，`POST /restart` 之外的 `POST /shutdown`）：

- **刻意不做模型工具**：关掉实例会让所有会话与后台任务一起中断，而且**没有续作**（不会自动回来）。破坏性操作只从界面触发、必须过一次显式勾选确认（第 6 节）。
- 它存在的直接理由是 6.10 那个孤儿场景：启动器失去跟踪后，浏览器是唯一还剩的收尾入口。
- **不等空闲，但会尽力 flush**：`whenIdle` 那一套是热重启为了「等这一轮结束 + 能续作」才要的，关闭不等它；但 `flush`（把已经在内存里的事件刷到盘上）**要做**——不等空闲 ≠ 可以丢已经记录的事件，而 `sessions.flush` 的存在本身就说明有缓冲（轮次删除那边已证实：flush 不为 true 时事件重启后会复活）。做法是每个活动会话最多等 500 ms，刷不动/抛错/服务缺失都照常退出。**尾部未闭合的轮次**由内核自己兜：`@deepseek-ai/dsh-session` 的 `interruptedTurnClosers()` 就是 crash-recovery 入口，打开会话时补 `step/end` + `turn/end {kind:'interrupted'}`。这条差异必须写在代码注释里，别被后人「统一」掉。
- ⚠️ **响应顺序是硬要求**：`requestShutdown` 只判定 + 标记并返回一个 `exit` 动作，**由路由先把 202 发出去**，再用 `deferExit`（`SHUTDOWN_EXIT_DELAY_MS`）请求退出。反过来的话，`appExit` 触发的 dispose 里有 `server.closeAllConnections()`，会把那条 202 掐断，而客户端正是靠它才敢进「正在关闭」状态。
- ⚠️ **这一秒买的是「人眼看得见」**：延迟定在 1000 ms，不是「够把响应刷出去」的 300 ms。真机反馈过一次——300 ms 时进程已经没了，浏览器来得及收到 202、却来不及把「正在关闭」画清楚，用户看到的是「点了没反应，然后页面死了」。**反馈必须出现在弹窗里**（它 portal 到 body，是唯一一定盖得住设置面板的表面）：`closing` / `closed` 要各有自己的呈现，**不许退回普通确认框的样子**——曾经就是这样，用户以为没生效。
- **幂等**：退出窗口内的第二次 `POST /shutdown` 得到 409（不会再排一次退出）；关闭进行中调 `requestRestart` 也是 409，反之亦然。
- `appExit` 不存在 ⇒ 501；`exit` 抛错 ⇒ 复原标记 + `SHUTDOWN_FAILED`，**绝不假装已经关掉**。


## 6. 组件级开关（AGENTS.md 3.10）

插件列表里本插件下有**四行**：core（`agent-control`）+ 三个组件行（`agent-control-session` /
`-turn` / `-restart`）。每一行是 `cordis.patch.yml` 的 `insert:` 里一个 entry；右侧的开关调用宿主的
`pluginManager/setPluginEnabled(entryId, enabled)`：宿主把那一行标成 `disabled` 写进 **profile 的 patch**，
**重启实例后**生效。

**关键：被禁用的行，loader 根本不会调用它的 `apply`。**（`cordis-plugin-loader` 的 `Entry.update`：
`if (this.disabled) { this.fiber?.dispose(); return }`；`Entry.disabled` 连祖先组一起算。）所以「关掉一个组件」
= 那一行的接线从来不执行，而不是「装上了再关」——这也意味着：**主入口不能无条件把三个组件都装上**，
否则关掉子行完全不起作用（路由还在、界面照样显示入口）。

于是「谁负责注册」只有一条规则：

| 情形 | 谁装 |
| --- | --- |
| loader 的行树里有 `dsh-agent-control/<组件>` 这一行 | **那一行**（开着：它自己装；被关掉：谁都不装） |
| 没有那一行（例如只有一行 `agent-control` 的旧 profile） | **主入口**（行为与从前完全一致） |

实现要点：

- 判定在 `hasOwnRow(ctx, feature)`（`src/host-wiring.mjs`）：`ctx.get('loader')` → `loader.entries()` →
  `entry.options.name`。判据是**行存不存在**，不看它开没开（开着的行自己会装；关掉的行走不到 `apply`）。
  **拿不到 loader 服务时返回 false**（= 照旧全装）：这是保守的一侧——查不到行的信息不该让全部功能消失。
  - 为什么这条判定及时：patch 是**一次性**合并成一个 entry 列表再 `root.update(...)` 的
    （`dsh-app-boot` 的 `applyEntryPatches` → `EntryGroup.update`，四个 entry 在同一个 tick 里进入 loader 的
    `store`），所以主入口 apply 时兄弟们已经在树上了。
- 三个组件的接线**只有一份实现**（`src/host-wiring.mjs` 的 `applySessionFeature` / `applyTurnFeature` /
  `applyRestartFeature`）：主入口与三个子插件行调用的是同一份，子插件各自只调用自己那一个。
- **认领表**（`claimFeature`）挡住同一进程里的重复注册：`webServer.register` 对同一个 `(kind, path)`
  会抛错，工具也不该注册两次。先到先得、后到的跳过（只在 debug / info 级留一行线索），认领在
  `ctx.effect` 的清理里释放，所以热重载后还能注册回去。离线测试用
  `resetFeatureClaimsForTest()` 清它（假 ctx 的 `effect` 从不 dispose）。
- 子插件行的 `apply(ctx, config)` 认 `config.enabled`：**只有明确的 `false`** 才算关（缺省 = 开），
  这时直接返回——不注册路由、不注册工具、不订阅事件、也不抛错（关掉一个组件不该让实例起不来）。
  两条路都通：宿主开关写行级 `disabled`（loader 不 apply），手写 `config.enabled: false`（apply 立刻返回）。
- **客户端靠探针判断「组件在不在」**：每个组件在自己的路由命名空间下有一条只读探针
  （`GET /api/agent-control/session/status`、`.../turn/status`；热重启复用已有的 `GET /restart/status`），
  返回 `{ ok: true, enabled: true }`。客户端在挂载时各拉一次，**先探测、后注册**（槽位一旦注册就不能在
  运行中卸载），探不到（404 / 鉴权 fallback / 超时）就不注册对应的槽位内容；方向是安全的那一侧——
  宁可少显示一个按钮，也不留一个点了报错的按钮。排障抓手 `window.__dshAgentControl.features()`
  给出这次探测到的开关（`true` / `false` / `null`）。
- ⚠️ **别改主行的 id / name**（`agent-control` / `dsh-agent-control`）：宿主开关是按 id（+name）往 profile 的
  patch 里写覆盖行的，改名会让升级后的旧行失配（第 4 节）。

## 7. 本地联调与 profile 装/摘（AGENTS.md 第 5 节）

### 装进 profile 验证

```sh
# git 引用（正式）
dsh plugin --profile <profile 名> add github:ventisyn/dsh-agent-control#<已发布的完整版本号>

# 本地链接（开发期更快，改完重启/热加载即生效）
dsh plugin --profile <profile 名> add link:<本地 clone 路径>
```

⚠️ pnpm 的 lockfile 锁的是 **commit hash**（`pnpm-lock.yaml` 里记的是 `codeload.github.com/.../tar.gz/<sha>`）。**推了新提交后必须重跑一次 `add`**，否则装进去的还是旧 commit。

### 从 profile 里摘掉功能重叠的插件

同一批槽位只能有一个主人：注册了同名槽位的插件同时装着，会出现两个垃圾桶按钮、两个弹窗互相监听同一个事件。因此验证本插件前，先把功能重叠的插件从 profile 里移除：

```sh
dsh plugin --profile <profile 名> remove <占用了同名槽位的插件>
```

⚠️ 移除后**检查磁盘副本是否真的消失**（`node_modules/` 下不该再有它的目录），并且**用一次轻量删除实测确认旧行为已经下线**——只删配置行而文件仍在时，加载器仍可能把它捞起来。别只看 `plugin_manager` 的列表就认定已经摘干净。
