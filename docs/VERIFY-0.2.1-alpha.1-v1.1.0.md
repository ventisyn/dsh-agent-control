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
node test/restart-helper.test.mjs   22 / 22 pass
node test/host.test.mjs             44 / 44 pass
node test/client.test.mjs           54 / 54 pass
node test/turn-delete.test.mjs      25 / 25 pass
node test/session-delete.test.mjs   23 / 23 pass
                                    ─────────────
                                    222 项全绿
```

`npm test` 里的 `node --check` 覆盖 17 个 `.mjs`/`.js` 文件（本机沙箱下 `node --test` 那一步会 `spawn EPERM` 假失败，所以测试逐个直跑，见 AGENTS.md 第 5 节）。

## 6. M6 真机端到端（一次性备用实例）✅

环境：一次性 profile（从 shipped web 模板初始化）+ `link:` 装本仓库，独立端口，与主实例完全隔离。6.1–6.13 用的是**命令行拉起**的实例；6.14 那次是**由 DSHL 拉起**的实例（见 6.10、6.14）。

### 6.1 插件加载与状态接口 ✅

`GET /api/agent-control/restart/status` → 200：

```json
{ "ok": true, "version": "0.2.1-alpha.1-v1.1.0", "bootId": "b-…", "pid": 21952, "startedAt": …,
  "port": 3080, "canRestart": true, "blockers": { "sessions": [], "jobs": 0 }, "pending": null, "last": null }
```

（端口是占位值：AGENTS.md 第 8 节要求仓库里不写本机端口，真实端口记在 `AGENTS.local.md`。）

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

**本项目的决定（2026-10-05，用户拍板）**：**只做文档化 + 设置页的「关闭实例」**，不再为它加代码——

- 不加「自动检测到 DSHL 托管就禁用模型工具」的开关（argv 与命令行启动完全一样，检测不可靠；而孤儿现在能自己收尾，见 6.15）；
- 不去改写启动器的记录文件（格式不透明、判据是 PID，见下表，而且那是把插件绑死在一个第三方私有实现上）。

**DSHL 的实例识别机制（读它自己的日志与二进制字符串得出，不是猜）**：

| 问题 | 答案 | 证据 |
| --- | --- | --- |
| 它靠什么认一个实例 | **它自己 spawn 的那个子进程 PID**（外加子进程 stdout 里的 `dsh web: …?token=…` 横幅用于判就绪） | 日志：`启动命令（原生）："…dsh.cmd" --profile restart-proto --port <端口> --no-open` → `Harness 进程已启动（原生），PID 25508` → `<34 · Harness Watcher PID 25508> … 已就绪：http://…（判定依据：token 横幅）` → 我们重启后同一行 watcher 记 `已退出（代码 0）` |
| 会不会事后重新发现 | **不会（运行期间）**。它只在**自己启动时**做一次「核验并恢复监控」，判据是记录的进程**是否还活着 + 身份是否相符** | 二进制字符串：`实例记录 {0} 的进程已退出或身份不符，未接管。`、`无法读取实例恢复记录，已跳过（不会接管或终止进程）`、`保留实例并退出` / `会保存对接记录，下次启动自动核验并恢复监控` |
| 它把记录存在哪 | `%LOCALAPPDATA%\DSHL\Sessions\<id>.session`，**加密/不透明**（998 字节高熵数据，解码后无任何可读字段） | 实测解码该文件 |
| 能不能让辅助进程去更新它 | **不能，也不该做**：格式不透明、判据是 PID，而且那是第三方启动器的私有实现——AGENTS.md 反复禁止依赖这类内部结构（换一个版本就静默失效） |

（仍未验证：DSHL 是暂时没跟上还是永远不会重新发现；「放生的实例 + 再点一次启动」会发生什么——故意没试，避免在同一台机器上制造第二份写同一 `$DSH_HOME` 的实例。）

### 6.11 插件行的 `config:` 真的会传进 `apply` ✅

评审的担心：如果 Loader 不把插件行的 `config` 交给 `apply`，`auto` 会**静默不生效**（回退方向是 `ask`，所以安全，但没人验证过）。

做法：把仓库 `cordis.patch.yml` 里的 `approval` 从 `ask` 改成 `auto` → 重启备用实例 → 读 `/restart/status` 里本轮新增的 `approvalMode` 字段：

| 插件行里的值 | 状态接口报告 |
| --- | --- |
| `approval: auto` | `"approvalMode": "auto"` |
| `approval: ask`（改回） | `"approvalMode": "ask"` |

⇒ 配置**确实**到了 `apply`，而且跟着配置走（不是硬编码）。`approvalMode` 就是为「可验证」加进状态接口的：读代码推断不算数，能看见才算。

### 6.12 过期 pending 被丢弃 ✅

把一条 `createdAt` = 11 分钟前的 `pending.json` 手工写进交接目录，然后用**原型插件的路由**触发重启（它不写 pending，所以不会被覆盖）：

- 重启后 `pending.json` **被删掉**（目录里只剩 `last.json`）；
- `last.json` = `{ restartId: "r-stale-probe", source: "model", reason: "过期待办探针…", resume: "none" }`——**没有投递续作消息**，符合「过期就丢弃、只记 warn」。

⚠️ 「记 warn」这半条**取不到证**：`ctx.logger` 的输出在这个部署里没有落点——实例 stdout 里没有（日志文件只有那一行 token 横幅），`$DSH_HOME` 下也没有日志文件，连原型插件自己的 `logger.info` 都一无所踪。所以凡是**必须让人看见**的信息，本插件一律写进 `last.json` / HTTP 响应 / 续作消息，不依赖 logger。

### 6.13 新进程起不来 ⇒ 失败态 + 日志文件名 ✅（并修掉一个真 bug）

把一次性 profile 的用户层 patch 故意写坏（YAML 缩进错）→ 触发一次重启 → 新进程加载 profile 失败、立刻退出：

```json
{ "restartId": "r-muuaiy0w-…", "ok": false, "stage": "spawn", "durationMs": 760,
  "error": "新进程启动后立刻退出（退出码 1）",
  "logFile": "…/logs/agent-control-restart-20261005-044439.log", "newPid": 10496 }
```

- **760 毫秒**就定性，没有耗满 90 秒的 `readyMs`：辅助进程看到子进程立刻退出就直接判失败（这正是「不无限转圈」）；
- 日志文件里是**原始错误**：`failed to parse overlay … YAMLException: bad indentation of a mapping entry (9:4)`，界面拿到文件名就能指路。

**顺带发现并修掉的 bug**：失败时 `spec.json`（含环境变量）与 `pending.json` **都留在盘上**。后者更糟——用户下次手动启动时，新进程会读到一条「上次那次其实失败了的热重启」待办，投出一条**声称已经重启过**的续作消息（通知一件没发生的事）。修法：辅助进程**成功时删 `spec.json`**（pending 留给新进程投递）、**失败时两份都删**，失败原因只留在 `last.json`。已加两条测试（成功：spec 删 / pending 留；失败：两份都删）。

### 6.14 模型路径闭环：真机 + 真模型 + **本会话自己** ✅

重启电脑后，本会话所在的实例（**由 DSHL 启动**）里插件已注册：`restart_harness` **出现在模型的工具表里**——「工具注册」这条从此不再是离线推断。

接着按顺序做了三件事：

1. **阻塞路径（验收第 7 条）**：先起一个后台作业 + 一个子代理会话，再调用工具 → 工具**没有安排任何重启**，返回：

   > 重启未安排：另有 1 个会话在运行：`6b96c2b5-…`；待其结束后再试；另有 1 个后台任务在运行；先结束或等待它们再试（`RESTART_BLOCKED`）

   （拿不到会话标题就显示 id，不编造——坑 ⑨；「别的会话」与「后台任务」两类阻塞都点到了，文案直接告诉模型下一步怎么办。）
2. **清场后再调用工具** → `已安排重启（r-muuyaig4-jmmb79）：本轮结束后执行，预计停机约 10 秒，之后这个会话会自动继续。` → 审批卡片（`approval: ask`）被批准。
3. **本会话真的收到了那条续作消息**（原因、耗时、续作说明原样带回），实测停机 **7 秒**；`last.json`：

```json
{ "restartId": "r-muuyaig4-jmmb79", "ok": true, "newPid": 9536, "bootId": "b-…",
  "durationMs": 6995, "source": "model", "resume": "delivered",
  "sessionId": "session-fbb24cf8-…", "logFile": "…/agent-control-restart-20261005-151321.log" }
```

⇒ 验收第 1、2、3、4、5 条在**真机 + 真模型**下闭环。这是 `last.json` 首次在真机上写出 `source: "model"` + `resume: "delivered"`，也是「耗时」首次用上辅助进程的实测值（6995 ms → 消息里的「7 秒」）。

**顺带记录（用户日常使用中自然发生的孤儿）**：DSHL 日志显示它在 15:06:38 启动了同一个 profile（PID 13240），15:12:47 那个进程「已退出（代码 0）」——也就是说**孤儿状态在本机已经真实发生过**：启动器认为实例已停止，而它当时正服务着这个会话（写这段时的 pid 9536 同样不在 DSHL 的跟踪里）。这正是 6.10 描述的后果，不是特意制造的。

### 6.15 「关闭实例」在真机上闭环 ✅（本轮新增的能力）

背景：被启动器失去跟踪的实例（6.10）以前只能去任务管理器收尸。现在设置页多了一行「关闭实例」，走 `POST /api/agent-control/shutdown`——**刻意不做成模型工具**：关掉实例会让所有会话一起死，而且不会自动恢复（AGENTS.md 第 6 节：破坏性操作只从界面触发）。

在一个**一次性实例**（自己起的，独立端口）上实测：

| 步骤 | 结果 |
| --- | --- |
| `GET /restart/status` | `canShutdown: true` |
| 无 Origin、无浏览器凭据的 `POST /shutdown` | **401**（与 `/restart` 共用同一道可信校验；没有 Origin 时自实现那条也要求自定义头） |
| 带浏览器凭据 + 同源 `Origin` | **202 `{ok:true}`，用时 12 毫秒** |
| 紧接着第二次 POST（还在 300 ms 退出窗口里） | **409 `RESTART_IN_PROGRESS`**：「实例正在关闭：关闭请求已经发出，退出动作已经安排好，不会再安排第二次」 |
| 实例何时不可达 | **+535 ms**；启动它的那个作业收到**退出码 0**（干净退出，不是被杀） |

⇒ 三个要点都验证到了：

1. **202 抢在拆树之前发出**（12 ms vs 300 ms 的延迟退出）。这一点是硬要求：`appExit` 触发的 dispose 里有 `server.closeAllConnections()`，先退出就会把这条 202 掐断，而客户端正是靠它才敢进「正在关闭」状态。
2. **重复点击不会排第二次退出**（幂等，409 而不是又关一次）。
3. **退出是真退出**：进程自己走的，作业收到 0；没有一个「假装关掉了」的分支。

关掉之后，`/restart/status` 立即不可达（该实例的一次性用途结束，作业也随之完成）。

**仍缺**：浏览器里的视觉确认（新那一行、确认框、「DSH 正在关闭…」/「实例已关闭」横幅）——客户端测试覆盖了态机与渲染结构，但没有真机截图。

### 6.16 「关闭会不会写坏日志尾部？」——源码结论 + 补上 flush ✅

评审问到这个，查了内核源码，答案是**不会损坏**，但原实现少了一半该做的事，已补：

1. **尾部是未闭合轮次，是内核一等公民的合法状态**（崩溃、关窗口、启动器停止都是它）。`@deepseek-ai/dsh-session` 里就有专门的 crash-recovery 入口：

   ```js
   /**
   * Crash-recovery entry point: synthetic closers that balance a persisted log
   * whose tail turn was interrupted. ...
   */
   function interruptedTurnClosers(events) {
     return openTurnClosers(events, { kind: "interrupted" });
   }
   ```

   它补上缺失的 `step/end` 与 `turn/end {kind:'interrupted'}`；悬空的工具调用还会补一条合成结果（`ToolOutcomeUnknownError` / `ToolNotStartedError`，取决于工具是否已经开始）。v4 加载校验器**也不要求尾轮闭合**——坑 ⑪ 那条约束的是 `system/message`/`developer/message`/`assistant/attempt` 必须落在**打开**的轮次与步骤里，与「尾部没闭合」不冲突。
2. **但「日志能读回来」不等于「已经记录的事件可以丢」**：`sessions.flush(session)` 返回「是否至少有一个持久化监听器参与」，而轮次删除那边早就证实过「flush 不为 true 时事件只在内存里、重启后会复活」——也就是说确实存在缓冲区。所以关闭**不等空闲，但退出前会尽力 flush**：
   - 每个活动会话最多等 `SHUTDOWN_FLUSH_TIMEOUT_MS = 500`；
   - 刷不动 / 抛错 / 没有 `sessions` 服务，一律**照常退出**（这个按钮的语义是「现在就停」，不能被持久化层卡成「关不掉」）；
   - 失败只进 logger（响应早已发出，报什么都到不了界面）。
3. 三条测试钉住这个行为：**响应之前不刷也不退**、**每个活动会话都刷一次**、**flush 卡住或抛错都不挡退出**（221 项里的 3 项）。

### 6.17 顺带修掉：重启的日志文件名带着上一次启动的时间戳 ✅

清掉 M0 原型时顺手核对 `last.json`，发现 `logFile` 指向 `…-155256.log`，而那次重启实际发生在 **16:36:34**——原因是日志文件名在**进程启动时**就算好、之后每次重启都沿用。

后果不是功能故障，而是**诊断误导**：界面的「最近一次重启」、以及失败态里那句「日志文件：…」都会指着一个时间对不上的文件，让人以为信息是旧的（验收第 11 条恰好就是靠这个文件名指路的）。

修法：新增 `deps.freshLogFile()`，在**真正重启的那一刻**用 `deps.now()` 现算文件名；调用方显式注入 `logFile` 时不给这个口子（测试与特殊部署注入的值仍然说了算）。已加测试（把时钟拨快两小时，断言名字跟着走）。

**真机复核（同一天 17:19 → 17:22，连续两次重启刚好构成前后对照）**：

| 重启完成时刻 | 执行它的那个进程启动于 | `last.json.logFile` | 判定 |
| --- | --- | --- | --- |
| 17:19:32 | 16:36:34（旧代码） | `…-163634.log` | 旧行为：沿用「进程启动时刻」 |
| 17:22:05 | 17:19:32（已含修复） | `…-172200.log` | ✅ 现算：与重启时刻一致（该文件的实际写入时间也正是 17:22:05） |

### 6.18 设置页截图（用户提供，明暗各一张）+ 顺带修掉一个版式缺陷 ✅

**这一轮拿到的截图**：明、暗两套主题的设置页，含新加的「关闭实例」行。据此确认：

- 「关闭实例」行与「重启 DSH」行同结构、同分隔线，按钮是同一套危险态；文案与设计一致（停整个进程 / 任务与会话会中断 / **不会自动重启** / 「实例被启动器失去跟踪时…这里是唯一的收尾入口」）；
- 「运行状态」显示版本 `0.2.1-alpha.1-v1.1.0`、进程号 18700、端口与启动标识；
- **「最近一次重启」显示的就是 6.14 那次模型发起的重启**（时间 16:36:35 / 来源「模型」/ 耗时 8 秒 / 结果「成功」/ 续作「已自动续上」）——即整条链路在界面上也是通的。

**截图暴露的缺陷（已修）**：模型写的「原因」可以长到 300 字，而键值网格当时是
`grid-template-columns: max-content max-content` + `flex: none`——长值把网格撑到内容那么宽，于是左侧标题被压成**一字一行**（「最/近/一/次/重/启」竖排），面板底部还出现了横向滚动条。

修法：值列改成 `minmax(0,320px)`（shrink-to-fit 下等于 `min(内容宽度, 320px)`：短的照旧贴着，长的换行）、标签加 `white-space: nowrap` 永不折行。另加一条**源码钉子**测试（不是渲染测试）：谁把 `max-content max-content` 改回来都会当场挂。

### 6.19 「关闭实例」的确认框截图（用户提供）✅

用户点了「关闭 DSH」但**没有确认**，把确认框截了下来。据此确认：

- 标题「关闭 DSH?」，正文用红点警示图标 + 三条事实：「会停止整个 DSH 进程：正在运行的任务、会话以及它们的后台任务都会被中断。关闭之后不会自动重启，要再启动得去启动器或终端。实例被启动器失去跟踪时（例如热重启之后），这是唯一的收尾入口。」
- **必须勾选**「我明白关闭实例会中断正在运行的任务，而且不会自动重启」才能确认——截图里确认按钮正是**禁用态**（这正是「破坏性操作必须过一次显式勾选」的落实）；
- 「取消」与「关闭 DSH」两个动作都在，弹窗与确认框是同一个 overlay 宿主（同一套原生 `RiskConfirmation`）。
- 当时没有别的会话/后台任务在跑，所以正文里没有阻塞明细——那是「有才显示」的（本节只验证了空的那一种）。

**仍缺**：重启中 / 正在关闭 / 失败态三种横幅的截图。

## 7. 本机环境事实（供排障参考）

- **沙箱下的 `node` 看到的 `os.tmpdir()` 是私有的临时目录**，与实例进程看到的真实 `%TEMP%` 不是同一个；同理 `$env:TEMP` 在沙箱里也被改写。写诊断脚本时要显式给出真实路径。
- 会话日志是**多帧拼接**的 zstd：`createZstdDecompress()` + 整块 `end()` 在本机实测**只解出第一帧**（253 字节的会话头），要按魔数 `28 b5 2f fd` 逐帧切。
- 实例日志里的中文要用 UTF-8 读，否则本机默认编码下显示成乱码。
- ⚠️ **PowerShell 陷阱**：`(Get-Content x) -replace … | Set-Content x -NoNewline` 会把数组元素**不带分隔符**地拼在一起，整个文件被压成一行（我因此报废过三个 markdown 文件，只能从 git 恢复）。批量改文本要用编辑工具，或显式 `-join "\`n"`。

## 8. 未验证（不要当成通过）

1. **DSHL 托管下的收尾**：机制已查清（6.10 的表），收尾入口也已给出——设置页的「关闭实例」（6.15）。**决定：只文档化 + 关闭按钮，不加开关**（2026-10-05）。仍未验证的只有：DSHL 是暂时没跟上还是**永远不会**重新发现那个进程（没有长时间复看）；「放生的实例 + 再点一次启动」会发生什么也**故意没试**。
2. **插件还没装进主 profile（`0.2.1-alpha.1`）**：本机目前唯一装着本插件的 profile 是一次性的 `restart-proto`（6.14 的闭环就跑在它上面，且它由 DSHL 拉起）。要把热重启用在你日常那个 profile 上，得先 `dsh plugin --profile <名> add link:<clone 路径>` 并接受一次会话中断。
3. **`--port 0`（OS 随机端口）**：`pinPortIfNeeded` 有离线测试，未真机验证。
4. **限频与并发（验收第 9、10 条）没有真机样本**，而且有一条**结构性观察**：限频账本与单飞锁都在**进程内**，而一次成功的重启会换掉进程——所以「10 分钟 3 次」实际只在「重启被取消/失败、进程活下来」的场景里累计得起来（那正是它要防的模型重试），「同会话 60 秒冷却」则会被重启本身清零。单飞那条：UI 路径从「检查锁」到「加锁」之间**没有 `await`**（审批整段跳过），Node 单线程下是原子的；模型路径有审批的 `await`，但工具调用本身是独占执行的。两条都有离线测试。
5. **`appExit` 在「有正在跑的后台任务 / 终端」时是否同样快**：没测过（有阻塞项时本来就会拒绝重启，所以这个组合很难自然出现）。
6. **界面**：已有「空闲态」的设置页截图（明/暗各一张，含「关闭实例」行，见 6.18）；**重启中 / 失败态 / 正在关闭的横幅、以及「关闭实例」的确认框都还没有截图**。另外横幅在设置面板打开时会被挡住（`shell.overlay` 的 z-index 低于设置面板）——是否要改尚未决定。
7. **`ctx.logger` 的落点未知**（见 6.12 的 ⚠️）：这个部署里它的输出哪里都看不到，所以插件的告警实际上只靠 `last.json` / 响应体 / 续作消息传达。
8. **`blockers.sessions[].descendant`**：状态接口**刻意不发**这个字段（状态页不排除任何会话，没有「调用者」可作参照，带了恒为假），界面里的「（子代理）」标记因此不会出现。阻塞文案里的会话也只有 id（宿主没给标题），没有编造。
