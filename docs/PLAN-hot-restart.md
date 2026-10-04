# 计划：为 dsh-agent-control 增加「无缝热重启」

> 状态：**规划稿（未实现）**。规划与验收由规划者负责，实现由执行模型负责。
> 本文只写**已核对的事实**与**必须先用原型验证的假设**，两者严格分开（第 1、4 节）。
> 不写本机路径、端口、实例名（AGENTS.md 第 5 节）。

## 0. 目标与非目标

**目标**

1. 模型可调用工具 `restart_harness`，**必须说明原因**；重启成功后**该会话自动继续**，不打断工作流。
2. 用户可在「设置」里点击按钮重启，界面风格与 DSH 原生设置页对齐。
3. 两个入口共用同一个重启操作（`requestRestart`），护栏、状态、日志一致。

**非目标**（写明是为了防止执行模型自作主张）

- 不做配置回滚（重启后新进程起不来就如实报错，不改 profile）。
- 不控制 DSHL 里的其他实例，不改 DSHL，不假设 DSHL 有任何重启接口。
- 不做「重启后自动打开浏览器」。
- 不新增批量/定时重启。

## 1. 已核对的事实（来源：已装 DSH 0.2.1-alpha.1 的源码）

| # | 事实 | 推论 |
| --- | --- | --- |
| F1 | DSH **没有**内置重启。`dsh` 启动器只负责启动，退出靠 `appExit`（`ctx.appExit(code)` → 5 秒内有界关停，`process-shutdown`）。 | 重启 = 「退出自己 + 有人再拉起」，必须由插件自己实现。 |
| F2 | Web 服务端口、host 来自启动参数/配置；`webServer` 在 `dispose` 时 `server.close()` 并 `closeAllConnections()`。 | 新进程必须等旧进程释放端口后才能绑定同一端口。 |
| F3 | 浏览器鉴权：**进程启动令牌**每次启动重新随机生成（`processLaunchToken`），但**签名密钥持久化**在凭据库（`initializeSecret` 读已有记录），cookie 绑定 authority 并有有效期。 | 理论上重启后浏览器 cookie 仍有效、无需重新登录。**待验证（S4）**。 |
| F4 | 插件自建路由（`webServer.register`）**不走鉴权链路**（AGENTS.md 3.5）。 | 重启接口若不加防护，任何能访问端口的页面都能 CSRF 触发重启。**必须加 Origin/Host 校验**（第 3.3 节）。 |
| F5 | 工具接口：`ctx.tools.register(ToolDefinition)`；`execute(args, exec)`；`exec.concludeTurn()` 可让「本轮在此工具结果提交后结束」；定义里必须有 `output`（schema + render）。 | 可以让工具成功返回后立刻结束这一轮。 |
| F6 | 会话在进程重启后**不是活的**；`sessionController.resolveAgent(sessionId)` 会按需 `agents.resume(...)` 把持久化会话拉起（会话控制器内部也是这么做的）；`sessionController.prompt({requestId, sessionId, mode, content}, signal)` 投递用户消息。 | 新进程启动后可以由插件主动拉起会话并投递一条续作消息。**签名与返回形状待核（S5）**。 |
| F7 | 会话日志格式 v4 的**加载校验器比运行时 append 更严**（AGENTS.md 坑 ⑪）。工具调用若没有对应结果就进程死亡，日志尾部不合法。 | **绝不能在工具执行期间退出进程**：必须先让工具结果落盘、本轮 `turn/end`，再退出（第 2 节时序）。 |
| F8 | `agent.whenIdle()`、`sessions.flush(session): Promise<boolean>`、`ctx.agents.list()`（含 `status`）、`ctx.get('jobs').list()` 均为公开面。 | 可用于「等本轮结束」「检查别的会话/后台任务在忙」。 |
| F9 | 沙箱：原生 exe 的 stdout 接管道会失败（AGENTS.local.md 第 2 节）。 | 派生辅助进程时 `stdio` 只用 `'ignore'` 或文件描述符，**不要用 pipe**；测试直接 `node test/x.test.mjs` 跑。 |
| F10 | 插件 host 端**不得 import 任何 `@deepseek-ai/*`**（AGENTS.md 3.7）。 | 辅助脚本、工具定义、审批调用全部只用 Node 内置模块 + `ctx` 服务。 |

## 2. 总体设计与时序

新增三块（均无运行时依赖）：

| 文件 | 作用 |
| --- | --- |
| `src/restart.mjs` | **纯逻辑**（不 import cordis）：阻塞项计算、限频、启动规格（argv 重放）构造、`pending.json`/`last.json` 读写、过期判断。可离线单测。 |
| `src/restart-helper.mjs` | **独立可执行脚本**（只用 `node:*`）：旧进程退出后拉起新进程并探测就绪。由旧进程 `spawn(detached)` 起，不属于插件 fiber。 |
| `src/restart-tool.mjs` | `restart_harness` 工具定义 + 与 `src/index.mjs` 共用的 `requestRestart` 接线。 |

`src/index.mjs` 只加接线（路由、工具注册、启动时「续作」）。`client.js` 增加设置页与进度浮层。

### 2.1 模型发起的重启（主路径）

```
模型调用 restart_harness({reason, resume_note?})
 ├─ 1 守卫：调用者是根 agent（子代理拒绝）→ 限频 → 阻塞项（别的会话在跑 / 后台任务 / 已有进行中的重启）
 │          → 预检（能写 pending 目录、辅助脚本在、启动规格可得、appExit 可用）→ 审批（见 3.4）
 ├─ 2 写 pending.json（state=scheduled，含 sessionId、reason、resume_note、restartId、createdAt、oldPid）
 ├─ 3 立即返回成功结果 + exec.concludeTurn()     ← 工具结果落盘，本轮随后以 turn/end 收尾
 └─ 4 后台任务（不在工具调用栈里）：
        await agent.whenIdle()（≤30s）→ await sessions.flush(session) 必须为 true
        → 再查一次阻塞项（出现新阻塞 → 取消重启、清 pending、向该会话投递「重启已取消：原因」）
        → spawn(detached) 辅助进程 → pending.state=helper-started → ctx.appExit(0)

辅助进程（独立于旧进程）：
 等旧 pid 退出（≤30s；超时后硬杀）→ 等端口释放（≤15s）
 → 用重放的启动规格 spawn 新 dsh（stdio 重定向到日志文件）
 → 轮询 GET /api/agent-control/restart/status，等到 bootId ≠ 旧 bootId（≤90s）
 → 写 last.json {restartId, ok, newPid, durationMs, logFile, degraded?} → 退出

新进程（插件 apply 内，应用就绪后）：
 读 pending.json → 过期（>10 分钟）直接丢弃并记 warn
 → 先删/改写 pending（至多一次投递，宁可漏不重复）
 → 对每个条目：resolveAgent(sessionId) 拉起会话 → prompt() 投递续作消息
 → 投递失败如实写入 last.json（界面横幅显示「未能自动续上」）
```

**续作消息**（模型可见，中文，带机器可读首行）：

```
[系统通知 · DSH 已热重启]
原因：<reason>
耗时：<N> 秒
你重启前留下的续作说明：<resume_note 或「无」>
请从中断处继续刚才的工作；先快速确认重启生效（例如检查刚装的插件是否已加载），无需向用户重复解释。
```

### 2.2 用户在设置里发起的重启

同一个 `requestRestart({source:'ui'})`：无模型流程要打断，**不投递续作消息**。若存在运行中的会话/后台任务，界面显示数量并要求勾选「仍然重启」；勾选后 `force=true`（见 M5，可选）。

### 2.3 浏览器侧

重启期间 HTTP 不可达。客户端：检测到状态请求失败 → 显示「DSH 正在重启…」浮层 → 轮询 `status`，发现 `bootId` 变化 → 若 DSH 客户端自己没有重连则 `location.reload()`（**S4 决定是否需要**）。120 秒仍不通 → 显示失败态（含日志文件名与「请手动启动」提示）。

## 3. 契约（接口先冻结，UI 与 host 才能并行）

### 3.1 工具 `restart_harness`

| 参数 | 类型 | 说明（直接写进 schema 的 description） |
| --- | --- | --- |
| `reason` | string，必填，1–300 字符 | 为什么需要重启、重启后期望什么变化。会原样展示给用户（审批卡片与设置页「最近一次重启」）并写进续作消息。 |
| `resume_note` | string，选填，≤500 字符 | 重启后你要接着做的事。会原样放进续作消息，用来保持工作流。 |

- 工具描述（英文，短）：重启 DeepSeek Harness 进程以使需要重启才生效的改动（如宿主插件代码）生效；重启在本轮结束后进行，本会话随后自动续作；其他会话或后台任务正在运行时会被拒绝。**不要**在描述里重复参数规则（agent-experience：参数规则写在参数上）。
- 成功输出：`{ scheduled: true, restartId, expectedDowntimeSeconds }`，并 `concludeTurn()`。
- 失败输出：错误码 + 一句可操作的话（例如 `RESTART_BLOCKED`：「另有 2 个会话在运行：<标题>…；待其结束后再试」）。**错误文本是模型读的，必须告诉它下一步怎么办。**
- 仅根 agent 可用；子代理调用 → 拒绝（`RESTART_FORBIDDEN`）。

### 3.2 HTTP（新增，前缀沿用 `/api/agent-control`）

```
GET  /restart/status
  → { ok, bootId, pid, startedAt, port, canRestart, unsupportedReason?,
      blockers: { sessions: [{ sessionId, title? }], jobs: number },
      pending: { restartId, state, source, reason, createdAt } | null,
      last: { restartId, ok, finishedAt, durationMs, source, reason, degraded?, logFile?, resume: 'delivered'|'failed'|'none' } | null }

POST /restart            body: { reason?: string, force?: boolean }
  → 202 { ok, restartId }
```

新错误码（`src/shared.mjs`，host 与 client 共用）：

| 码 | HTTP | 含义 |
| --- | --- | --- |
| `RESTART_BLOCKED` | 409 | 别的会话/后台任务在忙（`detail` 带明细） |
| `RESTART_IN_PROGRESS` | 409 | 已有进行中的重启 |
| `RESTART_RATE_LIMITED` | 429 | 限频（默认 10 分钟内最多 3 次；上次续作 60 秒内再次请求同一会话也拒绝，防死循环） |
| `RESTART_UNSUPPORTED` | 501 | 预检失败（取不到启动规格 / 无 `appExit` / 辅助脚本缺失…）；**不得假装成功** |
| `RESTART_DENIED` | 403 | 审批被拒，或 Origin 校验失败 |

### 3.3 安全（必做，验收会专项检查）

- `POST /restart` 必须：`Content-Type: application/json`；`Origin` 存在时其 host 必须等于 `Host` 头；缺失 `Origin` 且缺失自定义头 `x-dsh-agent-control: 1` → 拒绝。优先复用公开的 `ctx.connection.requestRejection(...)`（若签名合适，S3 核对），否则自行实现上述校验。
- 请求体上限沿用 64 KiB；`reason` 长度、`force` 类型严格校验。
- 辅助进程的启动规格只来自**本插件写的 spec 文件**（用户私有目录），不接受 HTTP 传入的命令。
- 不记录环境变量内容到日志（env 只用于传给新进程，日志只记变量**名数量**）。

### 3.4 审批（已确认：走 DSH 审批流，可配置）

- 默认 `ask`：工具 `execute` 内调用 `ctx.approval.request(...)`（`approval` 服务，会把请求/结果写入请求会话的日志），审批卡片展示 `reason`。**被拒 → 返回 `RESTART_DENIED`，什么都不做。**
- 可配置为 `auto`（免审批）：仍受限频与阻塞项约束。配置通过 plugin 行 `config:` 读取，缺省 = `ask`；host 不 import schemastery，所以**手工校验**（未知值回退 `ask`）。若 Loader 拒绝无 schema 的 `config:`，退为模块常量 + 在 README 说明（S3 核对，结果写进 VERIFY 文档）。
- UI 触发的重启：用户点按钮本身即授权，不再走 `approval`。

### 3.5 持久化（对 AGENTS.md 3.8「不落数据文件」的**受控例外**）

目录：`$DSH_HOME/agent-control/restart/`（新增）。

| 文件 | 内容 | 写入方 |
| --- | --- | --- |
| `pending.json` | 第 2.1 节的待办（原子写：写临时文件再 rename） | 旧进程；新进程消费后删除 |
| `spec.json` | 启动规格：`execPath`、`execArgv`、`argv.slice(1)`、`cwd`、`env`、`oldPid`、`port` | 旧进程 |
| `last.json` | 最近一次结果（给设置页展示） | 辅助进程 / 新进程 |
| `../logs/agent-control-restart-<时间戳>.log`（实际放 `$DSH_HOME/logs/`） | 新进程 stdout/stderr | 辅助进程 |

`spec.json` 含 env，**文件权限仅当前用户**；用完即删。**必须同步更新 AGENTS.md 3.8**，写明这是唯一的例外及原因。

## 4. 必须先验证的假设（M0 原型，全部通过才能进 M1）

不要凭源码阅读就开写。M0 产出一份 `docs/SPIKE-hot-restart.md`（每项：做了什么、观察到什么、结论、对计划的影响）。

| # | 要回答的问题 | 做法 | 失败时的退路 |
| --- | --- | --- | --- |
| S1 | **DSHL 如何托管进程？** 旧进程退出时 DSHL 把实例标成「已停止」吗？会不会杀掉整个进程树/Job（导致脱离式新进程被一并杀死）？新进程它能认出来并继续显示「运行中」吗？ | 在**备用实例**（不是主用实例）上装一个最小原型：路由 `POST /proto/restart`，只做「spawn detached helper → appExit → helper 拉起新进程」，不接会话。人工观察 DSHL 界面。 | 若 DSHL 杀进程树：helper 用 `CREATE_BREAKAWAY_FROM_JOB`（Node `detached` 已部分覆盖）或 `cmd /c start`；若仍不行，退化为「只退出，由用户/DSHL 点启动」并**如实改写 UI 文案**。把观察结果告诉规划者。 |
| S2 | `process.argv` / `execArgv` / `process.env` / `cwd` 是否足以**原样重放**启动？有没有只存在于启动器内存里的状态？ | 原型里把规格（脱敏）写日志，与 DSHL 里该实例的实际启动命令对比。 | 无法重放 → `canRestart=false`，`unsupportedReason` 说明。 |
| S3 | 工具注册与审批：`tools.register` 的真实签名；新工具默认是否被「权限预设」拦下/静默放行；`approval.request` 的入参与返回；`ctx.connection.requestRejection` 能否用于路由；无 schema 的 plugin `config:` 是否可行。 | `cordis_inspect_query`（`Service.listService`，**`input` 必须是对象；若工具包装层一直报 must be an object，直接读 `.d.ts`**）。 | 见 3.3、3.4 的退路。 |
| S4 | **重启后浏览器 cookie 是否仍有效？** DSH 客户端会自动重连还是必须刷新？ | 在原型实例上重启，观察：未刷新页面的行为；刷新后是否 401。 | cookie 失效 → 辅助进程把带令牌的 URL 写进 `last.json`，界面给出「点此重新登录」；并把此风险写进 README。 |
| S5 | 续作投递：`resolveAgent`、`prompt` 的真实签名与返回；`requestId` 的类型；续作消息在聊天里如何显示；对一个「刚被重启打断、尾部有 `turn/end`」的会话 resume 是否正常；`UserMessage` 有没有合适的 `source` 可标明「系统注入」。 | 用一次真实的「写 pending → 手动重启 → 新进程投递」走通，再用 `test/log-inspect.mjs` 与 `test/v4-load-check.mjs` 检查日志合法。 | `prompt` 不可用 → 退到 agent inbox（`runtime-types.d.ts` 里的 `send(message, target, wakeup)`）。 |
| S6 | `ctx.appExit(0)` 在 Windows 是否真能让进程在 5 秒内退出并释放端口？ | 原型计时。 | 辅助进程超时后硬杀旧 pid（已写进时序）。 |

## 5. 里程碑与任务包（给执行模型）

依赖关系：`M0 → (M1 ∥ M2) → M3 → M6`；`M4` 在 3.2 契约冻结后可与 M1–M3 并行；`M5` 可选。

> **统一前置**（每个执行模型都要做）：读 `AGENTS.md` 第 4、6、7、9、10、11 节；当前版本分支是已发布分支，**不要直接在上面提交**。第一个任务包的执行者先 `git checkout -b 0.2.1-alpha.1-v1.1.0/dev` 并提交 `chore: start 0.2.1-alpha.1-v1.1.0`（新功能 → Y+1）。提交信息用英文祈使句、约定式；不得出现本机路径/端口/实例名。

### M0 原型与验证（1 个执行者，需要备用 DSH 实例）
- 产出：`docs/SPIKE-hot-restart.md`（第 4 节全部 S1–S6）。原型代码**用完即删，不进主线**。
- **验收**：每个 S 有「观察到的事实」而不是「应该」；S1/S4 附人工观察结论；规划者据此修订本文。

### M1 纯逻辑与测试：`src/restart.mjs` + `test/restart.test.mjs`
- `computeBlockers({agents, jobs, callerId})`：别的 `running` agent、运行中的后台任务；**调用者自身不算**；调用者的子代理在跑 → 算阻塞。
- `checkRateLimit(history, now, sessionId)`；`buildLaunchSpec(proc)`：重放 argv，Web 应用若无 `--no-open` 则追加（只在确认是 web 应用时）；`readPending/writePending`（原子写）、`isStale`。
- 全部用假对象测；覆盖：自身不算阻塞、子代理阻塞、限频边界、过期、`--no-open` 不重复追加、spec 缺字段 → 抛 `RESTART_UNSUPPORTED`。
- **验收**：`node test/restart.test.mjs` 全绿；原有 84 项仍绿。

### M2 辅助进程：`src/restart-helper.mjs`
- 单文件、仅 `node:*`；入参是 spec 文件路径；按第 2.1 节时序实现；所有等待有超时；任何失败写 `last.json{ok:false, error}`，**不吞异常**。
- 测试：用假「旧进程」（会按信号退出的 node 脚本）与假「新进程」（监听端口并回答 status 的 node 脚本）验证：成功、旧进程不退（硬杀）、新进程起不来（超时失败）、端口被占。spawn 用 `stdio:'ignore'`（F9）。
- **验收**：测试全绿；失败路径下 `last.json` 内容正确。

### M3 host 接线：`src/restart-tool.mjs` + `src/index.mjs` + `src/shared.mjs`
- 注册工具、两条路由、`bootId`、新进程「就绪后续作」；`requestRestart` 为唯一入口。
- 工具描述/参数描述按 `agent-experience`：删显而易见的约束，参数规则写在参数上，每个事实只说一次。
- 路由安全按 3.3；错误码按 3.2；`DELETE_FAILED` 语义不动。
- 扩展 `test/host.test.mjs`：状态码映射、Origin 校验、阻塞、审批拒绝、单飞锁。
- `package.json`：`scripts.test` 的 `node --check` 列表加入新文件；`files` 已含 `src`。
- **验收**：`npm test` 的等价直跑全绿；`/restart/status` 在备用实例上返回正确形状。

### M4 设置页 UI：`client.js`
- 槽位：`settings.section`（`list` 种类，必填 `id`，建议 `id: agent-control-restart`；**先用 `Slots.listSubTree` 且 `input={"root":"settings.section"}` 现查注册形状与 owner props**，不要照抄本文）。
- 内容（自上而下）：① 运行状态（版本、pid、已运行时长、端口、bootId 简写）；② 阻塞提示（几个会话/任务在忙，列标题）；③ 主按钮「重启 DSH」（危险态，沿用原生 `Button` 变体）+ 确认弹窗（复用现有 `DeleteDialog` 的事件通信模式 `dsh-agent-control:request-*`，**别另起第二个弹窗宿主**）；④ 「最近一次重启」卡片（时间、来源 模型/用户、原因、耗时、续作结果）；⑤ 进度态机：`idle → confirming → requested → shutting-down → starting → reconnecting → done | failed`。
- 浮层：重启期间用 `shell.overlay` 里的非阻塞横幅，不盖住整页。
- **风格对齐 DSH（硬要求）**：只用 DSH token（`--dsw-alias-*` / `--dsh-*`）；度量与 token 抄已装原生组件库 CSS（`dsh-client-ui-primitives` 的 `settings-form/fields.module.css`、`Button.module.css`、`Input.module.css`），**不要靠 `Theme.listTokens` 定名**（AGENTS.md 坑 ⑤）；与现有设置页（如语言/外观行）并排对照间距、字号、行高、分隔线、悬停/禁用/焦点态；明暗两套主题都要看。拿不到的原语一律在 try/catch 里降级（AGENTS.md 3.7）。
- 文案中文；重启期间按钮禁用并显示进度，不允许重复提交。
- `test/client.test.mjs` 增加：注册形状（槽位名、id、order）、每处 `require` 解构、状态机纯函数用例。
- **验收**：离线测试绿；**界面必须由规划者/用户看截图验收**（执行模型若没有浏览器控制，必须明说，并请用户提供明/暗主题各一张截图）。

### M5（可选）强制重启与被打断会话的续作
- UI 勾选「仍然重启」→ 对运行中的会话 `agent.cancel` 并等静默（复用 `session-delete.mjs` 的停 agent 逻辑），把它们以 `kind:'interrupted'` 写入 pending，新进程投递「你的任务被重启打断，请检查进度后继续」。
- 默认不做；只有 M6 通过后、用户明确要求才做。

### M6 文档、版本与端到端
- 更新 `AGENTS.md`：3.8（受控例外）、2 节结构表、3.5 接口表、新增 3.9「热重启」与错误码、第 9 节自检加重启项；新增 `docs/VERIFY-<完整版本号>.md` 记录实测与**未验证项**（沿用现有风格）；`README.md` 加使用说明与风险（尤其「端口暴露到非回环地址」「重启会中断后台任务」）。
- `package.json` 的 `version` → `0.2.1-alpha.1-v1.1.0`；关键词加 `restart`。
- **端到端必须在备用实例先跑一遍，再上主用实例**。步骤见第 6 节。

## 6. 验收清单（规划者逐条核对，不接受「应该可以」）

**自动化**：`npm test` 等价直跑（逐个 `node test/*.test.mjs`）全绿；`node --check` 覆盖新文件；老的 84 项不减少。

**端到端（备用实例，然后主用实例）**

1. 模型调用 `restart_harness`（带 reason + resume_note）→ 弹审批卡片，内容含 reason。
2. 批准 → 本轮正常结束（日志里 tool/result 之后是 `turn/end`，**用 `test/log-inspect.mjs` 与 `test/v4-load-check.mjs` 检查日志合法**）。
3. 旧进程退出 → 新进程起来 → DSHL 仍显示该实例「运行中」（S1 结论）。
4. 浏览器不用手动操作即恢复（自动重连或自动刷新）；**没有 401**（S4）。
5. 该会话收到续作消息并**继续完成** resume_note 里的任务；模型能复述重启原因。
6. 重启耗时、`last.json`、设置页「最近一次重启」三者一致。
7. 拒绝路径：另开一个会话让它跑长任务 → 模型发起重启被 `RESTART_BLOCKED` 拒绝，且文案告诉它「等某会话结束」；后台任务在跑同理。
8. 审批被拒 → `RESTART_DENIED`，进程未动。
9. 限频：连续请求第 4 次被拒；重启后 60 秒内同会话再次请求被拒。
10. 并发：重启进行中再点按钮/再调工具 → `RESTART_IN_PROGRESS`。
11. 新进程起不来（人为制造：给 spec 一个坏参数）→ `last.json{ok:false}`，界面显示失败态与日志文件名，**不无限转圈**。
12. 过期 pending（手工改 createdAt 为 11 分钟前）→ 新进程丢弃、不投递、记 warn。
13. 安全：用 `curl`/Node `fetch` 从无 Origin、错误 Origin、非 JSON Content-Type 发 `POST /restart` → 全部拒绝。
14. 设置页：明/暗主题截图，与相邻原生设置页并排对照无明显差异；重启过程中各状态截图。
15. 重启后其他功能回归：会话删除、轮次删除、会话列表仍正常（本插件原有功能）。

## 7. 风险登记

| 风险 | 可能性 | 影响 | 缓解 |
| --- | --- | --- | --- |
| DSHL 杀进程树 / 认不出新进程 | 中 | 高（重启后实例「消失」） | S1 先验证；退路见 4 节 |
| 新进程因配置/插件错误起不来，且无回滚 | 中 | 高（用户得手动处理） | 预检 + 失败态如实展示 + 日志；README 提醒「改了插件配置先确认能启动」 |
| 模型滥用/死循环重启 | 低 | 中 | 审批默认开 + 限频 + 同会话 60 秒冷却 |
| 工具结果未落盘就退出 → 日志尾部非法 | 低（设计已规避） | 高 | `whenIdle` + `flush===true` 双重门，验收 2 专项检查 |
| spec.json 含 env | 低 | 中 | 仅当前用户可读、用完即删、日志不记值 |
| 重启会中断后台任务/终端 | 确定 | 中 | 作为阻塞项拒绝；UI 明示 |
| 端口绑到 `0.0.0.0` 时重启接口暴露 | 低 | 中 | Origin 校验 + README 警告 |

## 8. 给执行模型的通用约束（逐条抄进任务）

- 不要 import `@deepseek-ai/*`（host 端）；客户端 `require` 解构的每样东西都要容错。
- 所有失败收敛成「明确拒绝 + 说清原因」，**不能假装重启成功**；`DELETE_FAILED` 之类旧码语义不动。
- 先查契约再写代码：`cordis_inspect_list` → `cordis_inspect_query`；`input` 必须是对象，不行就读 `.d.ts`。
- 沙箱下 `node --test` 会 `spawn EPERM`——逐个直跑测试文件；派生进程不要用 pipe。
- host 模块改动不会热加载（坑 ⑦）：改完需重启 `dsh web` 才生效；本插件在 `0.2.1-alpha.1` profile 里**当前未安装**，装回用 `dsh plugin --profile <profile 名> add link:<本地 clone 路径>`，该命令需要 `danger-full-access`。
- 本机信息只写 `AGENTS.local.md`。
- 做完一个任务包：跑测试、列出**未验证项**、回报给规划者，不要自行宣布验收通过。
