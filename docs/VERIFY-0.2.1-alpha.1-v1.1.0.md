# VERIFY — 0.2.1-alpha.1-v1.1.0（热重启）

> 状态：**进行中**。M0（原型）已实测并记录在案；M3（host 接线）、M4（设置页）、M6（端到端）的实测结果**尚未**写入本文。
> 未验证项集中列在第 7 节，**不要**把本文当作「全部通过」。
> 按 AGENTS.md 第 8 节：本文不写本机路径、profile 名、实例名与端口。

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
- 结论：停机时间由**新进程的启动耗时**主导，不由旧进程关停主导；`expectedDowntimeSeconds` 按 10 秒量级给用户预期是合理的。

## 2. S2：启动现场能否原样重放 ✅

进程里真实的 `process.argv.slice(1)`（脱敏）：

```
[ "<安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js",
  "--profile", "<profile 名>", "--no-open", "--port", "<端口>" ]
```

- **`dsh web` 只是 `--profile web` 的简写**：`web` 会被启动器当成 `--profile` 的值消化掉，**不会**出现在 app 的 `cmdlineArgs` 里。把 `web` 当位置参数再传一次，web app 自己的 commander 当场拒绝：`error: too many arguments. Expected 0 arguments but got 1: web`（实测）。
- `execPath` 是系统 node、`execArgv` 为 `[]`、`cwd` 继承启动者、env 含 `DSH_HOME`（51 个键）。
- 结论：没有只存在于启动器内存里的状态，`process.argv.slice(1)` 足以重放；**`argv[0]` 是入口脚本路径**，所以重放必须是 `spawn(execPath, [...execArgv, ...argv])`。
- 影响：`appendNoOpen` 不解析 argv（「是不是 web 应用」由 host 显式传入）；`buildLaunchSpec` 的 `argv` 语义固定为 `process.argv.slice(1)`。

## 3. S3：Service 契约 ✅（一项待验）

用 `cordis_inspect_query`（host `Service.listService`）逐个核对，**没有照抄任何现成实现**：

| 需求 | 核对结果 |
| --- | --- |
| 注册工具 | `ctx.tools.register(definition: ToolDefinition): () => void`；定义必须带 `output: { schema, render }` |
| 工具里拿调用者 | `ToolExecutionInput.agent?: Agent` ⇒ `exec.agent?.id` |
| 结束本轮 | `ToolRunContext.concludeTurn()` |
| 审批 | `ctx.approval.request({ agent, toolName, callId?, reason?, signal? })` → `'allowed-once'｜'rejected'｜'cancelled'｜'unavailable'`（**只有 `allowed-once` 是放行**）；要求当时有打开的轮次 |
| 路由可信校验 | `ctx.connection.requestRejection({ headers })` → `401｜403｜undefined`（直接复用宿主自己的 Host/Origin 校验） |
| 拉起会话 / 投递 | `ctx.sessionController.resolveAgent(id)` → `{ agent }｜{ error }`；`prompt({ requestId, sessionId, mode, content }, signal)`，文本块是 `{ type: 'text', text }` |
| 后台任务 | `ctx.jobs.list(caller?)`；⚠️ **按所有者隔离**：不传 caller 只看到无主作业 |
| 端口 | `ctx.webServer.port`（OS 分配后的真实端口）、`ctx.webServer.host`（CLI 明确拒绝 `--host 0.0.0.0`） |
| 退出 | `ctx.get('appExit')`（启动器经 `provideCmdline` 提供，5 秒兜底强退） |

## 4. S4：重启期间的浏览器行为 ✅（人工观察）

用户全程盯住页面的那次重启（旧 pid → 新 pid，停机约 6 秒）：

- 页面**自己恢复**，**不需要手动刷新**；
- **没有** 401，**没有**要求重新登录；
- 恢复后界面可用、会话列表正常。

结论：cookie 的签名密钥是持久化的，进程令牌每次启动重新随机**不影响**已登录的浏览器。⇒ 客户端**不做** `location.reload()`；重启期间只显示非阻塞横幅 + 轮询 `status`，超时才给失败态与手动刷新入口。

## 5. 离线测试 ✅

```
node test/restart.test.mjs          54 / 54 pass
node test/restart-helper.test.mjs   18 / 18 pass
node test/turn-delete.test.mjs      25 / 25 pass
node test/session-delete.test.mjs   23 / 23 pass
node test/client.test.mjs           28 / 28 pass
node test/host.test.mjs              8 /  8 pass
```

（本机沙箱下 `npm test` 的 `node --test` 会 `spawn EPERM` 假失败，所以逐个直跑，见 AGENTS.md 第 5 节。）

## 6. M0 的环境事实（供排障参考）

- 本机 node 版本与 harness 自带的入口脚本路径都可以从 `/proto/status` 一类探针读到；重启不需要它们之外的任何东西。
- 辅助进程写的中文日志**要用 UTF-8 读**，否则在本机默认编码下显示成乱码（原型观察到）。

## 7. 未验证（不要当成通过）

1. **DSHL 拉起的实例没测过**（S1 的核心问题，**零证据**）：原型实例是从命令行起的，而且**它根本没有出现在 DSHL 列表里**（用户更正）——所以「DSHL 会不会杀掉脱离式辅助进程、认不认得起新进程」这几个问题一个都没被回答。已证明的只有「`detached` 子进程能活过一个普通父进程的退出」。
   - ⇒ M6 端到端必须在 **DSHL 拉起的实例**（即主实例、本会话所在的那个）上跑一次；在那之前这条保持未验证。
   - 附带教训：曾经把用户对**另一个实例**的观察误当成这个实例的证据，已在 SPIKE 里更正并写明「引用人工观察要连实例一起记」。
2. **S5 续作投递整条链路**：`resolveAgent` + `prompt` 的签名已核对，M3 也实现了投递，但**没走过真实投递**。
3. **plugin 行的 `config:`（无 schemastery schema）**：M3 用一次性 `DSH_HOME` + `--patch` 做 `--dump-config` 实测 **exit 0 且 `config: { approval: ask }` 完整保留**，并核对了 `@deepseek-ai/cordis` 的 `resolveConfig`（插件无 `Config` schema 时原样返回）；但**真实 mount 时 config 是否传进 `apply` 仍未验证**。
4. **M3（工具注册、审批卡片、单飞、限频、状态路由）与 M4（设置页）的真机行为**：离线测试已覆盖（host 27 项、client 43 项），**真机一行都没跑过**。
5. **`appExit` 在「有正在跑的后台任务 / 终端」时是否同样快**：原型实例是空的。
6. **`--port 0`（OS 随机端口）** 下把实际端口钉进 argv 的做法：有离线测试（`pinPortIfNeeded`），未真机验证。
7. **M4 的全部视觉结论**：没有一张真机截图（执行者没有浏览器），token 名与度量是从已装原生 CSS 里读出来的，明暗主题、与相邻设置页的并排对照都没做过。横幅在设置面板打开时会被挡住（z-index 20 vs 1000）——待定是否要改。
8. **`blockers.sessions[].descendant` 与状态里的 `version`**：M4 的界面按「有就显示」写好了，但宿主目前都不发（见第 8 节的跟进项）。
