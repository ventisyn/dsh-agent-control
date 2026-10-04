# VERIFY — 0.2.1-alpha.1-v1.1.0（热重启）

> 记录 `docs/PLAN-hot-restart.md` 的 M0–M6 实测。**未验证项集中在第 8 节**，不要当成全部通过。
> 按 AGENTS.md 第 8 节：本文不写本机路径、profile 名、实例名与端口（除「一次性备用实例」这类描述）。

## 1. M0 原型：热重启在真机上跑通了 ✅

在一个**一次性 profile**（从 shipped web 模板初始化，与本机既有 profile 完全隔离）上装一个最小原型插件（临时目录，`link:` 安装；**不进主线**），它只做「`spawn(detached)` 辅助进程 → `appExit(0)` → 辅助进程拉起新进程」。

两次完整重启的时间线（`t0` = 触发时刻）：

| 阶段 | 第 1 次 | 第 2 次 |
| --- | --- | --- |
| 旧进程退出（辅助进程等到的时刻） | +0.65 s | ~+0.6 s |
| 端口释放（外部探测到连接被拒） | +0.57 s | +0.55 s |
| 新进程被派生 | +0.69 s | ~+0.7 s |
| 新进程开始服务（新 `bootId` 可读） | +7.3 s | +6.2 s |
| 其中：派生 → 插件 apply（DSH 自身启动耗时） | ~4.3 s | ~3.7 s |

- 两次都写出 `last.json{ok:true}`，`bootId` 每次都变，新进程接管**同一端口**并正常服务。
- 旧进程的退出**没有**触及启动器 5 秒的 force-exit 兜底（整棵树 0.7 秒内 dispose 完）。
- 结论：停机时间由**新进程的启动耗时**主导，不由旧进程关停主导。

## 2. S2：启动现场能否原样重放 ✅

进程里真实的 `process.argv.slice(1)`（脱敏）：

```
[ "<安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js",
  "--profile", "<profile 名>", "--no-open", "--port", "<端口>" ]
```

- **`dsh web` 只是 `--profile web` 的简写**：`web` 会被启动器当成 `--profile` 的值消化掉，**不会**出现在 app 的 `cmdlineArgs` 里。把 `web` 当位置参数再传一次，web app 自己的 commander 当场拒绝：`error: too many arguments. Expected 0 arguments but got 1: web`（实测）。
- `execPath` 是系统 node、`execArgv` 为 `[]`、`cwd` 继承启动者、env 含 `DSH_HOME`（51 个键）。
- 结论：没有只存在于启动器内存里的状态，`process.argv.slice(1)` 足以重放；**`argv[0]` 是入口脚本路径**，所以重放必须是 `spawn(execPath, [...execArgv, ...argv])`。

## 3. S3：Service 契约 ✅

用 `cordis_inspect_query` 逐个核对（host `Service.listService`），**没有照抄任何现成实现**：

| 需求 | 核对结果 |
| --- | --- |
| 注册工具 | `ctx.tools.register(definition: ToolDefinition): () => void`；定义必须带 `output: { schema, render }` |
| 工具里拿调用者 | `ToolExecutionInput.agent?: Agent` ⇒ `exec.agent?.id` |
| 结束本轮 | `ToolRunContext.concludeTurn()` |
| 审批 | `ctx.approval.request({ agent, toolName, callId?, reason?, signal? })` → `'allowed-once'｜'rejected'｜'cancelled'｜'unavailable'`（只有 `allowed-once` 放行）；要求当时有打开的轮次 |
| 路由可信校验 | `ctx.connection.requestRejection({ headers })` → `401｜403｜undefined`——**它同时做浏览器鉴权**，见第 6.2 节的实测后果 |
| 拉起会话 / 投递 | `ctx.sessionController.resolveAgent(id)` → `{ agent }｜{ error }`；`prompt({ requestId, sessionId, mode, content }, signal)`，文本块 `{ type: 'text', text }` |
| 后台任务 | `ctx.jobs.list(caller?)`；⚠️ **按所有者隔离**：不传 caller 只看到无主作业 |
| 端口 | `ctx.webServer.port`（OS 分配后的真实端口）、`ctx.webServer.host` |
| 退出 | `ctx.get('appExit')`（启动器提供，5 秒兜底强退） |

**plugin 行的 `config:` 是否被接受**：用一次性 `DSH_HOME` + `--patch <repo>/cordis.patch.yml --dump-config` 实测 **exit 0**，末层输出完整保留 `config: { approval: ask }`；并核对了 `@deepseek-ai/cordis` 的 `resolveConfig`（插件无 `Config` schema 时原样返回 config）。**真实 mount 时 config 传进 `apply` 未单独取证**（但第 6 节的端到端跑在带这行 config 的 profile 上，插件行为正常）。

## 4. S4：重启期间的浏览器行为 ✅（人工观察）

用户全程盯住页面的那次重启（停机约 6 秒）：

- 页面**自己恢复**，**不需要手动刷新**；
- **没有** 401，**没有**要求重新登录；
- 恢复后界面可用、会话列表正常。

结论：cookie 的签名密钥是持久化的，进程令牌每次启动重新随机**不影响**已登录的浏览器。⇒ 客户端**不做** `location.reload()`；只有失败态里用户点「刷新页面」才 reload。

## 5. 离线测试 ✅

```
node test/restart.test.mjs          54 / 54 pass
node test/restart-helper.test.mjs   21 / 21 pass
node test/host.test.mjs             29 / 29 pass
node test/client.test.mjs           43 / 43 pass
node test/turn-delete.test.mjs      25 / 25 pass
node test/session-delete.test.mjs   23 / 23 pass
                                    ─────────────
                                    195 项全绿
```

`npm test` 里的 `node --check` 覆盖 17 个 `.mjs`/`.js` 文件（本机沙箱下 `node --test` 那一步会 `spawn EPERM` 假失败，所以测试逐个直跑，见 AGENTS.md 第 5 节）。

## 6. M6 真机端到端（一次性备用实例）✅

环境：一次性 profile（从 shipped web 模板初始化）+ `link:` 装本仓库，独立端口，与主实例完全隔离。**注意：这个实例是由命令行拉起的，不代表 DSHL 托管的形态（见第 8 节第 1 条）。**

### 6.1 插件加载与状态接口 ✅

`GET /api/agent-control/restart/status` → 200：

```json
{ "ok": true, "version": "0.2.1-alpha.1-v1.1.0", "bootId": "b-…", "pid": 21952, "startedAt": …,
  "port": 10725, "canRestart": true, "blockers": { "sessions": [], "jobs": 0 }, "pending": null, "last": null }
```

### 6.2 安全：无凭据的 POST 被拒 ✅（实测结论与计划的预期不同）

| 请求 | 结果 |
| --- | --- |
| 无 `Origin`、无自定义头 | **401** `RESTART_DENIED`（宿主鉴权拒绝） |
| 带浏览器 cookie + 同源 `Origin` | **202** `{ ok: true, restartId: "r-…" }` |

⚠️ **计划 3.3 的预期是 403**。真正发生的是：`ctx.connection.requestRejection` 不只校验 Host/Origin，**还做浏览器鉴权**，所以「没有登录凭据」的请求在 Origin 校验之前就被 401 挡掉了。这是**更严**的结果，不是漏洞：

- 界面路径（同源 + 已登录）正常；
- 未登录/非浏览器调用者拿到 401，而不是靠一个自定义头就能放行；
- 只有当部署里**没有** `connection` 服务时，才退回「Origin 必须等于 Host，否则必须带 `x-dsh-agent-control: 1`」的自实现。

`GET /restart/status` **故意不做可信校验**：辅助进程在新进程刚起来、还没有任何凭据时就要靠它判断就绪；它只读、不改变状态（能访问该端口的人可以读到 pid / 端口 / 阻塞会话 id / 最近一次结果）。

### 6.3 UI 路径的一次完整重启 ✅

带 cookie 的 `POST /restart` → 202 → 服务不可达（+0.52 s）→ 新 `bootId` 可读（+5.7 s），旧 pid → 新 pid，全程无人工干预。

### 6.4 模型路径 + 审批 + 续作投递（S5）✅ —— 事件序列实证

用户在一个会话里让模型调用 `restart_harness`（`reason` + `resume_note`），批准审批卡片。会话日志（用只读转储器按帧解压后逐条打出）**关键片段**：

```
seq 21  tool/call        name=restart_harness
seq 22  approval/asked   toolName=restart_harness callId=call_00_…      ← 宿主审批服务写的审计对
seq 23  approval/decided outcome=allowed-once
seq 24  tool/result      isError=false                                   ← 工具结果已落盘
seq 25  step/end
seq 26  turn/end         reason={"kind":"completed"}                     ← ★ 本轮正常结束（验收第 2 条）
seq 27  session/end-seed
seq 28  agent/inbox/spliced
seq 29  turn/start       turn=2                                          ← 新进程把会话拉起来
seq 32  user/message     "[系统通知 · DSH 已热重启] 原因：M6 验收：验证热重启 耗时：6 秒
                          你重启前留下的续作说明：报一下你重启后看到的…"   ← ★ 续作消息（S5）
seq 36+ （模型继续干活：pwsh 工具调用…）
seq 49  turn/end         reason={"kind":"completed"}
```

- **没有在工具执行期间退出进程**：`tool/result` → `step/end` → `turn/end` 顺序正确，日志尾部合法。
- **续作消息真的投出去了**，而且**带上了实测耗时（6 秒）**与模型自己写的原因/续作说明。
- 用户观察：审批卡片出现并可批准；本轮正常结束；页面短暂不可用后**自己恢复**；同一会话收到续作通知并继续干活。

### 6.5 用真实加载校验器复核 ✅

```
node test/v4-load-check.mjs <DSH 的 node_modules/.pnpm> session-38607d8e-…
{
  "events": 50,
  "original": "OK",                                          ← 含重启的会话日志能被真实 v4 校验器加载
  "legacyTombstone": "FAIL system/message does not match an open turn and step",   ← 对照组如期失败
  "turns": { "1": "OK（遮蔽 7 个节点）", "2": "OK（遮蔽 6 个节点）" }
}
```

`test/log-inspect.mjs` 对同一会话：25 个 zstd 帧、坏帧 0、解析失败行 0、50 条事件、两个轮次都闭合。

### 6.6 `last.json` 的两次写入（**踩到并修掉一个真 bug**）⚠️→✅

第一次真机重启后，设置页的「最近一次重启」**只有一个时间和 pid**：`source` / `reason` / `resume` 全丢。

- 根因：`last.json` 有**两个写入者**——新进程在 `appReady` 时写「谁发起的、为什么、续作投递成不成」，辅助进程探测到就绪后写「重放结果、新 pid、耗时」。新进程就绪与辅助进程探测到就绪之间隔着一个轮询间隔，所以**辅助进程总是后写**，而它写的是**整份覆盖**，于是把新进程那几个字段冲掉了。
- 修复：辅助进程改成**合并写**，且只在 `restartId` 相同时合并（`last.json` 跨重启复用，无条件合并会把上一次的 `resume: 'delivered'` 带到这一次）；新进程额外把 `restartId` / `source` / `reason` 一并写下来。耗时也修了一个竞态：辅助进程多半还没写，这时退回「待办创建 → 现在」，不再显示「未知」。
- 修复后实测：`last.json` 同时含两边的字段

```json
{ "restartId": "r-muu9ld0f-srras7", "ok": true, "newPid": 12496, "bootId": "b-…",
  "durationMs": 5914, "finishedAt": …, "logFile": "…/agent-control-restart-20261005-041331.log",
  "source": "model", "reason": "M6 验收：验证热重启", "resume": "delivered",
  "resumeAt": …, "sessionId": "session-38607d8e-…" }
```

- **同一处还有第二半**（DSHL 那轮重启时发现）：插件这边（host）的 `writeLastMerged` 是**无条件合并**，于是这次重启的记录会把**上一次**的 `sessionId` / `resumeAt` / `logFile` / `newPid` 带过来——设置页上出现过「这次界面重启的卡片写着上一次模型重启的耗时与日志文件」。修法与辅助进程同一条规则：**只在 `restartId` 相同时合并**（三个写入者都带 `restartId`，所以正常流程仍然合并得上）。修复后真机复查：一次界面重启的最终记录里只有它自己的字段：`{ restartId: "r-muu9uoof-…", source: "ui", reason: "…", resume: "none", durationMs: 5897, newPid: 5320, logFile: "…041947.log" }`，没有上一轮的残留。

### 6.7 设置页 ✅（用户确认 + 截图）

用户确认设置里能看到「热重启」页，内容正常，并提供了**明、暗两套主题的截图**：左侧导航多出「热重启」（排在原生页之后），页面里「运行状态」（版本 / 进程号 / 已运行 / 端口 / 启动标识）、危险态「重启 DSH」按钮、「最近一次重启」（时间 / 来源 / 原因 / 耗时 / 结果 / 续作 / 日志）齐全，行分隔与左标签右值的排布与相邻原生设置页一致。

### 6.8 交接文件的清理 ✅

重启稳定后 `$DSH_HOME/agent-control/restart/` 里**只剩 `last.json`**：`pending.json` 被新进程消费后删除、`spec.json`（含环境变量）用完即删。没有别的残留。

### 6.9 回归：原有删除功能 ✅

重启之后 `GET /api/agent-control/sessions` 与 `/restart/status` 都是 200，会话列表正常返回。
（更细的删除实测见 `docs/VERIFY-0.2.1-alpha.1-v1.0.1.md`，本轮没有重跑全部删除用例。）

### 6.10 S1：DSHL 亲手拉起的实例 ✅（结论一条正、一条负）

用户用 **DSHL 启动同一个一次性 profile**（另一个端口），并在它的设置页点了「重启 DSH」。监测到的结果：

| 观测 | 结果 |
| --- | --- |
| 辅助进程是否被 DSHL 杀掉 | **没有**。旧 pid → 新 pid，停机 5.2 秒，新进程接管同一端口并持续服务（事后复查 `GET /restart/status` 仍是 200） |
| DSHL 是否认得重启后的新进程 | **不认得**。用户观察到 DSHL 的实例列表里**不再显示这个实例**，而它其实还活着 |

→ 结论：**`CREATE_BREAKAWAY_FROM_JOB` 那条退路不需要实现**；但热重启在 DSHL 托管的用法下会交出一个**孤儿进程**——DSHL 里看不到、也停不掉它，还可能允许对同一个 profile 再启动一次（两个实例争端口）。这条已写进 README 与 AGENTS.md 的已知限制。
（未验证：DSHL 是暂时没跟上还是永远不会重新发现它；「放生的实例 + 再点一次启动」会发生什么——故意没试，避免在同一台机器上制造第二份写同一 `$DSH_HOME` 的实例。）

## 7. 本机环境事实（供排障参考）

- **沙箱下的 `node` 看到的 `os.tmpdir()` 是私有的临时目录**，与实例进程看到的真实 `%TEMP%` 不是同一个；同理 `$env:TEMP` 在沙箱里也被改写。写诊断脚本时要显式给出真实路径。
- 会话日志是**多帧拼接**的 zstd：`createZstdDecompress()` + 整块 `end()` 在本机实测**只解出第一帧**（253 字节的会话头），要按魔数 `28 b5 2f fd` 逐帧切。
- 实例日志里的中文要用 UTF-8 读，否则本机默认编码下显示成乱码。

## 8. 未验证（不要当成通过）

1. **DSHL 托管下的收尾没有解决**（S1 本身已回答，见 6.10）：热重启会把实例交成一个 DSHL 不再跟踪的**孤儿进程**——DSHL 里看不到、停不掉。本插件按计划不控制 DSHL，只能文档化。**DSHL 是暂时没跟上还是永远不会重新发现那个进程，没有长时间复看**；「放生的实例 + 再点一次启动」会发生什么也**故意没试**（避免在同一台机器上制造第二份写同一 `$DSH_HOME` 的实例）。
2. **主实例（本会话所在的实例）上没跑过热重启**：所有真机结论都来自一次性备用实例（其中一次由 DSHL 拉起）。要在主实例上用，得先把插件装进主 profile，并接受一次会话中断。
3. **`--port 0`（OS 随机端口）**：`pinPortIfNeeded` 有离线测试，未真机验证。
4. **计划验收里没跑到的几条**（都有离线测试，但没有真机样本）：第 7 条（另一个会话在跑 ⇒ `RESTART_BLOCKED`）、第 9 条（限频第 4 次被拒 / 同会话 60 秒冷却）、第 10 条（并发 ⇒ `RESTART_IN_PROGRESS`）、第 11 条（新进程起不来 ⇒ 失败态与日志文件名）、第 12 条（过期 pending 被丢弃）。
5. **`appExit` 在「有正在跑的后台任务 / 终端」时是否同样快**：本轮实例都是空的。
6. **界面**：截图只覆盖「空闲态」的设置页（明/暗各一张，用户提供）；**重启中 / 失败态的横幅没有截图**，且横幅在设置面板打开时会被挡住（`shell.overlay` 的 z-index 低于设置面板）——是否要改尚未决定。
7. **`config: { approval: ask }` 的真实 mount** 没有单独取证（只 dump 过 + 端到端里行为正常）。
8. **`blockers.sessions[].descendant`**：状态接口**刻意不发**这个字段（状态页不排除任何会话，没有「调用者」可作参照，带了恒为假），界面里的「（子代理）」标记因此不会出现。
