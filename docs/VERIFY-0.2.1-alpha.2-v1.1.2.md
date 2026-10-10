# VERIFY — 0.2.1-alpha.2-v1.1.2

> 这是**换 harness 版本**之后的兼容性复验版本（`0.2.1-alpha.1` → `0.2.1-alpha.2`）：相对
> `0.2.1-alpha.1-v1.1.1` **没有任何行为改动**，唯一的代码改动是 `package.json` 的 `version`。
> v1.1.0 / v1.1.1 的功能实测见各自那份 VERIFY；本文只记这次复验的结论与**仍然未验证**的东西。
> 按 AGENTS.md 第 8 节：本文不写本机路径、profile 名、实例名与端口。

## 1. 为什么单独发一版

按第 11 节：**换 harness 版本 = 新开一条版本线，插件版本继续累加**，`package.json` 的 `version` 是唯一真源。
已发布的 `0.2.1-alpha.1-v1.1.1` 在 `0.2.1-alpha.2` 上**能跑**（见第 3 节实测），但它的版本前缀与运行环境对不上；
这一版把版本线切到 `0.2.1-alpha.2`，并把复验结论落成这份记录。

本轮**没有改任何源码**：复验没有发现需要适配的漂移。

## 2. 实测环境与方法

- 运行环境：已装 DSH `0.2.1-alpha.2` 的实例；被测代码按**已发布的版本分支** `release/0.2.1-alpha.1-v1.1.1` 装载
  （即与 v1.1.1 逐字相同，只有版本号不同）。
- 离线与静态：六个测试文件逐个直跑（本机沙箱下 `node --test` 的汇总模式会假失败，见 AGENTS.md 第 5 节）；
  宿主与客户端契约直接读 `0.2.1-alpha.2` 安装目录里的类型定义与客户端 bundle。
- 真机：接口探测 + 一次真实的会话删除；删除后用日志诊断器与**真实 v4 加载校验器**复核。

## 3. 结论

### 3.1 装载与路由（✅）

| 检查 | 结果 |
| --- | --- |
| `GET /api/agent-control/sessions` | **200**；会话数与界面一致，`live` / `running` 标注正确 |
| `GET /api/agent-control/restart/status` | **200**；`version` / `pid` / `port` / `blockers` 齐全，`canRestart` 与 `canShutdown` 均为 true |

### 3.2 错误语义（✅ 与前几版一致）

| 请求 | 结果 |
| --- | --- |
| 删一个**活动**会话 | `409 SESSION_LIVE`（文案仍指向「重启后不打开它直接删」） |
| 删不存在的会话 | `404 TARGET_NOT_FOUND` |
| `sessionId` 含 `../` | `400 INVALID_REQUEST` |
| 缺 `assistantMessageId` | `400 INVALID_REQUEST` |
| 用 `GET` 打 `POST` 路由 | `405`（`Allow: POST`） |
| 未注册路由 | 落到宿主鉴权 fallback（`401`），没有误接管 |

### 3.3 删除事务的格式（✅ 用 0.2.1-alpha.2 自带的校验器跑）

`node test/v4-load-check.mjs <0.2.1-alpha.2 的 node_modules/.pnpm> <会话 id>`：

- 原日志：**OK**
- 对照组（v1.0.0 的 `system/message` 旧墓碑）：**FAIL** —— `system/message does not match an open turn and step`（证明校验器确实在跑）
- 按当前写法逐轮模拟删除：**OK**（两个会话分别遮蔽 75 与 8 个节点）

### 3.4 真机删会话（✅ 全链路）

删掉一个验收过程中现造的一次性会话，返回值逐字段核对：

- `removed` / `dirs`：会话目录被删；`descendants: []`
- `projectionCache.removed`：命中（**裸 UUID 拼写**）—— 与磁盘上带 `session-` 前缀的那种拼写不同，两种都被覆盖
- `workspace.available: true`、`detached: false` + warning「工作区记账里没有找到这个会话，记账没有变动」——**如实回报，没有假装成功**
- 事后复查：会话目录（两种拼写）、投影缓存（两种拼写）、`workspace.json` 里的提及，**全部为零**

### 3.5 宿主 API 无破坏性漂移（✅ 逐条核对）

在 `0.2.1-alpha.2` 安装目录里直接读类型定义：`runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>)`
（**签名与 alpha.1 逐字一致**）、`whenIdle()`、`snapshotEvents()`、`registerMessageProjection()`、`detachSession()`、
`requestRejection()`、`storageDomain`、`appExit` —— 八个依赖面全部仍在。

### 3.6 客户端耦合（✅ 静态核对）

四个槽位（`sidebar.workspaces.session.menu.item` / `conversation.chat.assistant-actions` / `shell.overlay` /
`conversation.chat.turnTail`）都还在；`assistant-actions` 依旧**只传 `messageId`**（坑 ⑨ 的前提未变）；
`data-chat-flow-kind` / `data-chat-turn` / `data-turn-tail` 三个 DOM 属性仍在；
`MenuItemButton`（含 `danger` / `separatorBefore`）、`RiskConfirmation`、`Modal`、`Tooltip` 四个原语仍导出。

### 3.7 离线测试（✅）

六个文件逐个直跑：`restart` 54、`restart-helper` 22、`host` 44、`client` 57、`turn-delete` 25、`session-delete` 23
—— **合计 225 项全过、0 失败**。

## 4. 仍然未验证（不要当成全部通过）

1. **真机删轮次的成功路径**：需要「活动且空闲」的会话。本轮造的一次性子代理会话在子代理结束的瞬间就脱离了 store，
   删除请求被正确判成 `TARGET_NOT_FOUND` —— 那是一条**拒绝路径**的实测，不是成功路径。
2. **界面点击**：垃圾桶按钮、确认弹窗、关闭实例模态在 `0.2.1-alpha.2` 上**没有用人眼点过**；第 3.6 节只是静态核对。
3. **热重启与关闭实例没有真跑**（会中断正在使用的实例）；`/restart/status` 报 `canRestart` / `canShutdown` 均为 true，
   只说明启动规格与 `appExit` 取得到。
4. **`GET /turns` 跨重启、`TURN_COMPACTED`、`DELETE_FAILED` 渲染**等 v1.0.1 / v1.1.0 里已经收口的项目，本轮**没有重跑**
   （本版没有行为改动，结论沿用那两份记录）。
5. **v1.1.0 第 8 节的其它未验证项照旧有效**。

## 5. 发布前隐私检查

按 AGENTS.md 第 10 节第三步（本机清单，条目不进仓库）过了一遍：本版新增的全部字节 = 一个版本号改动 + 本文；
没有凭据、真实邮箱、本机路径、profile 名与端口；提交身份是 noreply 邮箱；仓库里没有图片与二进制文件。

**结论：已过。**
