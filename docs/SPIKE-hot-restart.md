# SPIKE：热重启 M0 原型验证（`0.2.1-alpha.1-v1.1.0`）

> 对应 `docs/PLAN-hot-restart.md` 第 4 节的 S1–S6。**原型代码在临时目录里，用完即删，不进主线**（本文件是唯一留下的东西）。
> 按 AGENTS.md 第 8 节：本文件不写本机路径、profile 名、实例名与端口。

状态：**M0 完成**（S1 部分验证、S5 未验证），结论已回填 `docs/PLAN-hot-restart.md`。

## 方法

在一个**一次性 profile**（`--from-default-profile web` 初始化，与本机既有 profile 完全隔离）上 `link:` 安装一个最小原型插件：

| 路由 | 作用 |
| --- | --- |
| `GET /proto/status` | 打印当前进程的启动现场：`bootId` / `pid` / `port` / `execPath` / `execArgv` / `argv` / `cwd` / env 键数量 |
| `POST /proto/restart` | 写 `spec.json` → `spawn(detached, stdio:'ignore')` 起辅助进程 → 400 ms 后 `ctx.appExit(0)` |
| `GET /proto/last` | 辅助进程写下的结果 |

辅助进程：等旧 pid 退出 → 等端口释放 → 按重放规格 `spawn` 新进程（stdio 重定向到日志文件，不用管道）→ 轮询 `/proto/status` 直到 `bootId` 变化 → 写 `last.json`。

人工观察两项（由用户完成）：浏览器页面的表现、DSHL 列表里该实例的状态。

---

## S1：DSHL 如何托管进程 —— **部分验证**

**观察到的事实**

- `detached: true` + `stdio: 'ignore'` 起来的辅助进程**活过了父进程的退出**：父进程（一次性的 harness 后台作业，非 DSHL）退出后，辅助进程继续跑完整个时序并写出 `last.json{ok:true}`。
- 新进程接管同一端口并正常服务（两次重启都成功，`bootId` 每次都变）。
- 用户观察：DSHL 列表里该实例**全程显示「运行中」**，重启前后没有出现「已停止」，也没有变成僵尸条目或消失。

**没验证的**

- 这个实例是**从命令行**拉起的，不是 DSHL 拉起的。DSHL 对自己拉起的进程是否使用 kill-on-close 的 Job 对象，仍然未知——这正是 S1 原本要问的问题。
- 因此「DSHL 不杀脱离式子进程」这个结论**只能说与观察一致**，不能说已证明。

**对计划的影响**

- 辅助进程先用 `detached: true` 的现状实现（已验证可用），**保留**计划里写的 `CREATE_BREAKAWAY_FROM_JOB` / `cmd /c start` 退路，但不预先实现。
- M6 的端到端**必须在一个由 DSHL 拉起的实例上再走一遍**；在那之前，S1 在 VERIFY 文档里记为未验证项。

## S2：启动能否原样重放 —— **已验证**

真实 `process.argv.slice(1)`（脱敏）：

```
[ "<安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js",
  "--profile", "<profile 名>", "--no-open", "--port", "<端口>" ]
```

- **`dsh web` 只是 `--profile web` 的简写**：`web` 会被启动器当成 `--profile` 的值消化掉，**不会**留在 app 的 `cmdlineArgs` 里。把 `web` 当位置参数再传一次，web app 自己的 commander 会拒绝：
  `error: too many arguments. Expected 0 arguments but got 1: web`（实测）。
- `execPath` 是**系统 node**（不是版本目录里的私带 node），`execArgv` 为 `[]`，`cwd` 继承启动者，env 键数量 51（含 `DSH_HOME`）。
- 结论：**`process.argv.slice(1)` 足以原样重放**，没有只存在于启动器内存里的状态。**`argv[0]` 是 bin.js 的脚本路径**，因此重放必须是 `spawn(execPath, [...execArgv, ...argv])`。

**对计划的影响（重要）**

- `appendNoOpen` **不解析 argv**：「是不是 web 应用」由 host 接线传入（它运行时就有 `webServer`）。原计划里「Web 应用若无 `--no-open` 则追加」的判定条件按此收紧。
- `buildLaunchSpec` 的 `argv` 语义固定为 `process.argv.slice(1)`（**含入口脚本路径**）；辅助进程不解释 argv、只重放。
- 「`--port 0`（让 OS 选端口）」会让新实例换一个端口，浏览器 URL 随之失效 ⇒ M3 需要在写 spec 时**钉住当前实际端口**（`webServer.port` 给出的是 OS 分配后的真实端口）。

## S3：服务契约 —— **已验证（除一项）**

用 `cordis_inspect_query`（host `Service.listService`）拿到的精确契约：

| 需求 | 契约 |
| --- | --- |
| 注册工具 | `ctx.tools.register(definition: ToolDefinition): () => void`；`ToolDefinition extends ToolSchema { output: { schema, render(args, value): ContentBlock[] }, execute(args, exec: ToolRunContext): Promise<unknown>, ... }` |
| 工具里拿到调用者 | `ToolExecutionInput.agent?: Agent`（`Agent = { readonly id: SessionId }`）——`exec.agent?.id` 就是调用者会话 |
| 结束本轮 | `ToolRunContext.concludeTurn(): void` |
| 审批 | `ctx.approval.request({ agent, toolName, callId?, reason?, displayReason?, signal? }): Promise<ApprovalOutcome>`；`ApprovalOutcome = 'allowed-once'｜'rejected'｜'cancelled'｜'unavailable'`（只有 `allowed-once` 是放行）；**要求当时有打开的轮次**，否则 reject |
| 路由的可信校验 | `ctx.connection.requestRejection({ headers }): 401｜403｜undefined` —— 直接复用宿主自己的 Host/Origin 校验 |
| 拉起会话 | `ctx.sessionController.resolveAgent(sessionId): Promise<{ agent } ｜ { error }>` |
| 投递消息 | `ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue'｜'steer', content, clientTimeZone? }, signal)`；文本块是 `{ type: 'text', text }` |
| 后台任务 | `ctx.jobs.list(caller?): JobView[]`；`JobView.status ∈ running｜stopping｜completed｜killed｜failed` |
| 端口/主机 | `ctx.webServer.port`（OS 分配后的真实端口）、`ctx.webServer.host`（`127.0.0.1` 或 `0.0.0.0`，**CLI 明确拒绝 `--host 0.0.0.0`**） |
| 退出 | `ctx.get('appExit')`，由启动器经 `provideCmdline` 提供 |

**未验证**：plugin 行里的 `config:`（`ask` / `auto`）在没有 schemastery schema 时是否被 Loader 接受——留到 M3 实测，失败则退回模块常量并在 README 说明（计划 3.4 的退路）。

## S4：重启后浏览器 —— **已验证（人工观察）**

用户全程盯住页面的那次重启（旧 pid → 新 pid，停机约 6 秒）：

- 页面**自己恢复**，**不需要手动刷新**；
- **没有** 401、**没有**要求重新登录；
- 恢复后界面可用、会话列表正常。

结论：F3 的推论成立（进程令牌每启动随机，但 cookie 的签名密钥持久化）。**客户端不需要 `location.reload()`**；重启期间只做非阻塞横幅 + 轮询 `status`，轮询超时后给失败态与日志文件名，并提供手动刷新入口即可。这条与计划 2.3 的「若客户端自己没重连则 reload」相比是**减法**：不自动刷新，避免打断用户正在看的内容。

## S5：续作投递 —— **未验证**

`resolveAgent` / `prompt` 的签名已核对（见 S3），但**没有走过真实链路**：需要 M3 的 host 接线 + 一次真机重启才能验证。
风险仍在：`requestId` 的形状、`mode: 'queue'` 的语义、冷会话 resume 后立刻投递是否会被丢、以及续作消息在聊天里以什么身份显示。退路保留（计划 4 节 S5 行）。

## S6：`appExit` 与停机时间 —— **已验证**

两次重启的实测时间线（`t0` = POST 触发时刻）：

| 阶段 | 第 1 次 | 第 2 次 |
| --- | --- | --- |
| 旧进程退出（辅助进程等到的时刻） | +0.65 s | ~+0.6 s |
| 端口释放（外部探测到 ECONNREFUSED） | +0.57 s | +0.55 s |
| 新进程被派生 | +0.69 s | ~+0.7 s |
| 新进程开始服务（新 `bootId` 可读） | +7.3 s | +6.2 s |
| 其中：spawn → 插件 apply（DSH 自身启动耗时） | ~4.3 s | ~3.7 s |

- `ctx.appExit(0)` **没有**触及 5 秒的 force-exit 兜底：整棵树的 dispose 在 0.7 秒内完成，端口随即释放。
- 停机时间**由新进程的启动耗时主导**（约 4 秒），不是由旧进程的关停主导。
- 结论：`expectedDowntimeSeconds` 按 **10 秒**量级给用户预期；辅助进程 30 s / 15 s / 90 s 的三段超时都合理（实测远小于它们）。

**未验证**：`appExit` 在「有正在跑的后台任务 / 终端」时是否同样快（本次原型实例是空的）。M6 端到端时留意。

---

## 遗留风险（带进 M3/M6）

1. **DSHL 托管的实例未测**（S1）——M6 必须在 DSHL 拉起的实例上跑一次端到端。
2. **`--port 0` 会换端口**——M3 写 spec 时钉住真实端口。
3. **S5 整条链路未验证**——M3 完成后的第一件事就是投递一次续作消息，并用 `test/log-inspect.mjs` 与 `test/v4-load-check.mjs` 检查日志。
4. **`logFile` 里的中文日志在本机默认编码下会显示成乱码**（原型观察到）：读取日志要用 UTF-8，或由辅助进程写 UTF-8 且文档里写明。
