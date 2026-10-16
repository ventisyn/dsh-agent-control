# AGENTS.md

思考用简体中文。本文件给在本仓库干活的 AI 代理和新加入的人。

每次干活都要用的东西（命令、红线、流程、每条契约的要点）在这里；细则按需读：

| 想知道 | 读 |
| --- | --- |
| 路由表、事件形状、服务边界、加载期约束、热重启与组件开关 | [docs/CONTRACT.md](docs/CONTRACT.md) |
| 十一个坑、归档遮盖的实现经过 | [docs/PITFALLS.md](docs/PITFALLS.md) |
| 分支与发布流程 | [docs/RELEASING.md](docs/RELEASING.md) |
| 每次实测的结论与未验证项 | `docs/VERIFY-<完整版本号>.md` |
| 术语与决策 | [GLOSSARY.md](GLOSSARY.md)、`docs/adr/` |

本文件会被整份注入每一次对话。宿主上限 65536 字节，超了整份不发（本机实测过一次）。硬上限 70 KB，目标 50 KB 以内。

## 1. 这是什么

`dsh-agent-control` 是 DSH 的持久插件，管三件破坏性操作：

- **会话级**：列会话、把会话连同磁盘目录与工作区记账一起删掉
- **轮次级**：从**模型可见上下文**里移除一轮对话（会话、后面的轮次、append-only 日志都保留）
- **热重启**：重启宿主进程并在重启后自动续作；另有一个「关闭实例」按钮，只有界面入口

三类操作共用一个确认弹窗、一套失败语义。新能力挂在同一套结构上，不另开插件。

能力与首个完成版本：

| 能力 | 首个完成版本 |
| --- | --- |
| 会话删除（幽灵清理、活会话、归档遮盖、界面让开） | `0.2.0-rc.2-v1.0.0`，`0.2.1-alpha.2-v1.2.0` 收口 |
| 轮次删除 | `0.2.0-rc.2-v1.0.0` |
| 热重启 / 关闭实例（关闭无模型工具） | `0.2.1-alpha.1-v1.1.0` |
| 组件级开关（四行结构） | `0.2.1-alpha.2-v1.3.0` |
| `DELETE_FAILED` 的真实渲染 | 未验证，见 `docs/VERIFY-*` 的「仍然未验证」 |

典型失败模式是**静默降级**：不报错、路由全部 200，但没干活（删除返回成功东西还在、按钮点了没反应），或者换个 harness 版本后插件照常加载、只是永远不生效（见 §4）。本项目只用 DSH 的公开 API，不 fork、不 vendoring、不复制第三方插件源码（公开/私有分界见 3.3）。

## 2. 仓库结构与命令

| 路径 | 作用 |
| --- | --- |
| `src/host-wiring.mjs` | 三个组件的接线实现（路由、错误映射、依赖探测）、组件认领表、行归属判定 |
| `src/index.mjs` | core 行入口：客户端 bundle 交付、启动清理、按行构建各组件 |
| `src/session-plugin.mjs` / `turn-plugin.mjs` / `restart-plugin.mjs` | 三个组件行的入口，可单独加载 |
| `src/session-delete.mjs` / `turn-delete.mjs` | 业务纯逻辑，不 import cordis，可离线单测 |
| `src/restart*.mjs` | `restart` 纯逻辑 / `restart-helper` 辅助进程 / `restart-tool` 接线与护栏 |
| `src/shared.mjs` | host 与 client 共用常量与纯工具（路由路径、错误码、id 校验、轮次括号） |
| `client.js` | 浏览器端 bundle（`window.__ModuleLoader__.load`） |
| `test/*.test.mjs` | 离线测试；另有 `log-inspect.mjs` 取证、`v4-load-check.mjs` 真实加载校验、`fake-session.mjs` 假内核 |
| `cordis.patch.yml` | bundle patch：四行结构（主行 + 三个组件行，见 3.10） |
| `locale/` | 插件列表里那四行的说明文字（`meta.description`），按行分目录存放 |
| `package.json` | `version` 是版本号唯一真源；`exports` 暴露 `./client` 与三个组件子路径 |

```sh
npm test                                                          # node --check + 314 项离线测试
npm run log:inspect -- <会话 id>                                   # 只读诊断器（3.6）
node test/v4-load-check.mjs <DSH 的 node_modules/.pnpm> <会话 id>   # 真实加载校验器复核（不进 npm test）
```

离线测试不碰真实 profile：会话删除的文件操作全在 `os.tmpdir()` 的临时目录，热重启与关闭实例的测试注入假 spawn/appExit。

⚠️ 受限沙箱里 `node --test` 要为每个测试文件 spawn 子进程并走管道，会报 `Error: spawn EPERM`、七个文件全 ✖。那是沙箱边界，不是测试失败。改为逐个直跑：`restart` 54、`restart-helper` 22、`host` 81、`client` 71、`features` 16、`locale` 5、`turn-delete` 25、`session-delete` 40，合计 314 项（`node test/<文件>.test.mjs`）。改了 `test/` 就同步改这里与 `README` 的「开发」一节。

## 3. 关键机制与契约要点

每节只留要点与不变量，原文在 [docs/CONTRACT.md](docs/CONTRACT.md) 对应小节。

### 3.1 会话删除

硬删除，不可撤销。目标路径 `$DSH_HOME/sessions/<slug>/<sessionId>/`，`<slug>` 靠遍历 `sessions/` 现查，不要从工作区路径推导编码规则。会话 id 在磁盘上有两种拼写（裸 UUID 与 `session-<UUID>`），两种都要认。

固定顺序，顺序错了会留下孤儿目录或错误记账：

```
校验 id → 确认磁盘上有目录（没有 → TARGET_NOT_FOUND，唯一例外是幽灵会话）
       → 找出子代理后代（读会话头：origin=subagent 且 parentSession 指向它，递归；fork 不算）
       → 停掉运行中的 agent（目标 + 后代，cancel + 等静默，有超时上限）
       → 删磁盘目录（目标 + 后代）→ 再删一次（防 dispose 路径重建）→ 确认删净
       → 清工作区记账（两种拼写都认）→ 清投影缓存（走 session_projcache 域的表接口，不能直接删文件）
       → 发宿主的公开事件 api-session/removed（目标 + 每个后代）
```

- 活会话也删（`0.2.1-alpha.2-v1.2.0` 起）：先停 agent 再删。删「本次启动后打开过」的会话时，删除**之前**先调 `workspaceRegistry.archiveSession(id, { stopActivity: true })`，借归档把那条摘不掉的内存记录从侧栏压住，并保留这条标记（`keepArchived`）；删除失败要撤回自己加的那条标记。顺序反了会被宿主拒绝，经过见 [docs/PITFALLS.md](docs/PITFALLS.md) 第 2 节。
- 幽灵会话（只存在于工作区记账、磁盘无目录、且不活在 store 里）：只动记账与投影缓存，报 `ghost: true`、`removed` 为空。目标活着但磁盘还没目录，仍判 `TARGET_NOT_FOUND`。
- 工作区那段可能没执行或部分失败，必须逐项回报，不要 `catch {}` 吞掉——吞掉就分不清「本来就没有」和「清理抛错了」。`detached` 表示记账是否真的解除，不是恒真。
- 「哪些会话活着」每次现查 store，不做模块级缓存：`ctx.on` 随 fiber 卸载注销，内核热重载不重放 `session/created`。

### 3.2 轮次删除

不重写日志、不截断文件。删除一轮 = 追加一笔与内核手动压缩同形的事务，把被删的整轮替换成一条用户消息（`[此处原有一轮对话，已被用户删除；其内容不再提供。]`）：`compaction/start` → `compaction/summary`（带自有 `provider` / `model` 标记）→ `user/message` 替换该区间（`compact-checkpoint`）→ `compaction/end`，`turn: null`。

- 只能落在两个轮次之间：轮次未闭合、有打开的轮次、有进行中的压缩 → `AGENT_BUSY`；已压缩或不连续 → `TURN_COMPACTED`。
- 所有校验在第一个事件写入之前完成，失败是拒绝，不是删一半。
- `flush` 返回值不是 `true` 就报 `DELETE_FAILED`，否则重启后这一轮会复活。
- 删的是模型看得见的面，不是磁盘上的字节：内容仍在日志与附件里，不是安全删除。README 与 UI 文案必须这么写。
- 内核 `/compact` 压掉的轮次不算本插件的删除记录。

### 3.3 公开 API 与私有内部的分界

只依赖公开面。用私有内部写出来的插件能跑，是靠没有契约保证的东西，失效时通常不报错。

| 需求 | 可以用 | 禁止 |
| --- | --- | --- |
| 找活着的会话 | `ctx.sessions.get(id)` / `list()` | — |
| 摘除已进入 store 的会话 | `enter(session)` 返回的 detach disposer | `SessionStore.detachEntered` / `liveEntryFor` / `store`（private） |
| 读会话事件 / 可见面 | `session.snapshotEvents(from?, to?)`（已标 deprecated，换版本时先确认替代）/ `session.surface.nodes` | `session.events`（旧属性） |
| 追加事件 | `session.append(type, data, intent?)`；`surfaceOp` 恰好 `{ op: 'replace', startSeq, endSeq }` | 旧形状 `{ op, start, end }`；在非 surface 事件上带 `sourceEventSeqs` |
| 停 agent / 等静默 / 拿租约 | `agent.cancel()` / `whenIdle()` / `runMaintenance(task)`，都在 agent 实例上 | 从 `ctx.agents` 找这三个方法 |
| 读领域数据 | `ctx.storageDomain.get(name)` → `.table(n)` / `.global` | 以为 `ctx.storageDomain` 自己有 `.table` |
| 删附件 | 没有公开 API | 假装能删；被删轮次的附件仍留在磁盘上 |

DSH 没有「删除会话」这个公开 API：公开面只有 `create` / `prepare` / `enter` / `announce` / `flush` / `get` / `list` / `registerMessageProjection` / `fork`，没有 `delete` / `remove`。把已进入 store 的会话摘出去的唯一公开途径是 `enter()` 返回的 detach disposer，它只交给创建者（`AgentHandle.dispose()` 只给创建它的 consumer owner），所以内存里那条记录插件摘不掉，进程退出才消失。

`runMaintenance` 拿不到租约时是同步 throw，不是 rejected promise，调用要整个包在 try 里。

### 3.4 确认与提示

四类操作（删会话、删轮次、重启、关闭）共用 `shell.overlay` 里的 `DeleteDialog`，底层是原生 `RiskConfirmation`。弹窗写清目标和后果，要求显式勾选，没有「记住我的选择」，没有一键批量。按钮只派发目标（自定义事件 `dsh-agent-control:request-delete`），弹窗统一监听，所以不会出现两个弹窗抢同一个事件。

会话删除在确认时再查一次列表，目标不在就直说，不让用户对着笼统的失败猜。host 端独立校验一次，不信任前端。

删除失败且错误码是 `TARGET_NOT_FOUND` 时也要刷新列表，否则那一行会一直挂着。

### 3.5 HTTP 接口

```
GET  /api/agent-control/sessions            # { ok, sessions: [{ sessionId, workspaceTitle, cwd, running, live, removable, reasons }] }
GET  /api/agent-control/turns?sessionId=    # { ok, sessionId, turns: number[] }，只有活动会话可读，未打开 → TARGET_NOT_FOUND
GET  /api/agent-control/session/status      # 组件探针，只读
GET  /api/agent-control/turn/status         # 组件探针，只读
POST /api/agent-control/session/delete      # { sessionId }
POST /api/agent-control/turn/delete         # { sessionId, assistantMessageId }
GET  /api/agent-control/restart/status      # 重启状态 + 辅助进程就绪探针 + 重启组件探针，不做可信校验
POST /api/agent-control/restart             # { reason?, force? } → 202
POST /api/agent-control/shutdown            # {} → 202，只有界面入口，没有模型工具
```

- 失败一律 `{ ok: false, error: { code, message } }`，状态码 400 / 403 / 404 / 409 / 423 / 429 / 501。
- 自建路由不走 harness 的鉴权链路。四个 POST 路由都过 `assertTrustedJsonRequest`：先可信校验（宿主 `connection.requestRejection` 优先，自实现同源 Origin / 自定义头兜底），再要求 JSON content-type。请求体必须校验字段、类型、id 形状（只允许 `[A-Za-z0-9._:-]`、首字符是字母或数字、拒绝 `..`）与 64 KiB 上限。不校验的话，`.` 或 `session-.` 会拼出 slug 目录本身，被当成会话目录整个删掉。
- 错误码：`TARGET_NOT_FOUND` / `TURN_NOT_CLOSED` / `TURN_COMPACTED` / `AGENT_BUSY` / `DELETE_FAILED` / `REQUEST_DENIED` / `RESTART_*` / `SHUTDOWN_*`。`DELETE_FAILED` 必须单独存在：把未知异常都归成 `AGENT_BUSY`，每次兼容性故障都会显示成「任务正在运行，请结束后再删除」。
- 路由注册要把 disposer 返回出去（`ctx.effect(() => ctx.webServer.register({...}))`）：`register` 对重复 `(kind, path)` 会抛错。
- `/restart` 的三重校验、`/shutdown` 的响应顺序、端口绑定风险：[docs/CONTRACT.md](docs/CONTRACT.md) 第 1 节。

### 3.6 取证：`test/log-inspect.mjs`

轮次删除在界面上只是少了几行，不要凭感觉判断。这个只读诊断器回答三问：删了没有（墓碑清单）、删的范围对不对（逐轮磁盘 seq 与表面可见条数对照，独立复刻 surface 代数）、还剩什么（被遮蔽事件原文，也就是「不是安全删除」的证据）。

`node test/log-inspect.mjs <会话 id | 日志文件路径> [--json]`

⚠️ 会话日志是多帧拼接的 zstd。`zstdDecompressSync` 只解第一帧，而第一帧只有 253 字节的会话头，看起来像日志空了。要按魔数 `28 b5 2f fd` 逐帧切，或 `createZstdDecompress()` 把整块 buffer 一次 `end()`（分多次 `write()` 同样只解第一帧，且不报错）。完整用法与输出样例：[docs/CONTRACT.md](docs/CONTRACT.md) 第 2 节。

### 3.7 加载期的命脉：别让一个 import 弄死整个插件

本插件跑在别人的进程里，裸模块能不能解析取决于宿主 loader。顶层静态 import 解析失败，整个插件消失：host 模块加载失败 → 路由全 404 → 界面什么都不出现。所以 host 端不 import 任何 `@deepseek-ai/*`，只用 Node 内置模块与 `ctx` 上的服务；客户端每次 `require` 解构出来的东西都假定可能不存在，包在 try/catch 里并准备兜底。

排障抓手：`window.__dshAgentControl.usingNativePrimitives()`、`.features()`、`.apply`。

### 3.8 数据与运行环境

插件自己不落数据文件：没有配置、没有审计日志、没有缓存。唯一的持久事实是写进会话日志的删除事务。

唯一的受控例外是热重启的交接文件 `$DSH_HOME/agent-control/restart/`：`pending.json` 读一次就删，`spec.json`（含 env，权限仅当前用户，env 值绝不写进日志）启动后删，`last.json` 留给设置页；新进程的 stdout/stderr 写到 `$DSH_HOME/logs/agent-control-restart-<时间戳>.log`。不要再往这个目录加东西。

### 3.9 热重启与关闭实例

唯一入口是 `requestRestart`：模型工具 `restart_harness` 与 `POST /restart` 走同一条路径，守卫、限频、审批、时序一致。三条不能违反：

1. 不在工具执行期间退出进程。工具先返回结果，退出由后台任务在双门之后执行。
2. `flush` 不为 `true` 就不退出。宁可这次不重启，也不写坏日志尾部。
3. `force` 只跳过阻塞项，单飞与预检永不跳过。

- 辅助进程（`src/restart-helper.mjs`）活在旧进程之外，只认文件，不 import 本仓库任何模块，stdio 只能是 `'ignore'` 或文件描述符。
- `last.json` 有两个写入者：新进程写身份与续作结果，辅助进程写重放结果。两边都合并写，且辅助进程只在 `restartId` 相同时合并。刚就绪的头几秒它是 `{ok:false}`，约 8–11 秒后才 `ok:true`。
- 宿主的作业列表按所有者隔离，看不到别的会话启动的后台任务。桌面启动器（DSHL）托管的实例重启后会变成孤儿进程：启动器按自己 spawn 的 PID 认实例，新 PID 不会被认领。本项目不为它加代码，收尾交给设置页的「关闭实例」。
- 关闭实例不等空闲，但尽力 flush（每个活动会话最多等 500 ms）。响应顺序是硬要求：先发 202，再用 `deferExit` 退出，反过来的话 202 会被 `closeAllConnections()` 掐断。幂等，退出窗口内第二次得到 409。
- 状态机、续作投递、限频账本、DSHL 细节：[docs/CONTRACT.md](docs/CONTRACT.md) 第 5 节。

### 3.10 组件级开关（四行结构）

插件列表里本插件下有四行：core（`agent-control`）加三个组件行（`agent-control-session` / `-turn` / `-restart`）。右侧开关调用宿主的 `pluginManager/setPluginEnabled(entryId, enabled)`，宿主把那一行标成 `disabled` 写进 profile 的 patch，重启实例后生效。

- 开关是**两级**的：主行是总闸，三个组件行是分闸。主行 `provide` 出本体服务 `agentControlCore`，组件行 `inject` 它——**主行被关掉时服务不存在，组件行的 fiber 停在 `pending`，一个路由都不会注册**；宿主自己的 inventory 把 pending 如实报给界面，不会显示成运行中。
- 为什么用服务依赖而不是进程内的布尔标志：loader 用 `Promise.all` 并发创建各行，谁先 `apply` 没有保证，靠顺序的写法会随机失败。服务依赖是 cordis 与官方插件的标准做法（`dsh-skill-filesystem` 声明 `inject: ['skills']`、`dsh-storage-json` 声明 `inject: ['storage']`）。
- 代价：组件行**不能再单独加载**（依赖是硬的）。旧配置（只有主行）不受影响，那条路是主行代装。
- 被禁用的行，loader 不调用它的 `apply`。所以关掉一个组件 = 那段接线从未执行，而不是装上了再关。接线函数里另有一道兜底：拿不到本体服务就整个跳过。
- 谁负责注册：行树里有 `dsh-agent-control/<组件>` 这一行，就由那一行负责（关掉时谁都不装）；没有那一行（例如只有一行 `agent-control` 的旧 profile），由主入口代装，行为与从前一致。
- 三个组件的接线只有一份实现：`src/host-wiring.mjs` 的 `applySessionFeature` / `applyTurnFeature` / `applyRestartFeature`。进程内的认领表挡住重复注册（`webServer.register` 对同一 `(kind, path)` 会抛错），认领随 `ctx.effect` 清理释放。
- 客户端先探测、后注册，因为槽位一旦注册不能在运行中卸载。探不到就不注册对应槽位：宁可少一个按钮，也不留一个点了报错的按钮。
- `approval` 按「自己那一行 > 回退 > 主行」取一份，不要合并几份，否则主行的旧值会盖掉子行的选择。`config.enabled: false` 也能关一个组件，只有明确的 `false` 才算关。
- 别改主行的 id / name：宿主开关按 id 往 profile 的 patch 里写覆盖行，改名会让升级后的旧行失配。
- 每行在插件列表里的说明文字取自 `meta.description`：主行在 `locale/<语言>.json`，三个组件行在 `locale/<组件>/<语言>.json`，由 `package.json` 的 `exports` 暴露。**子路径那三行永远不读 package.json**，没有 locale 文件就是空白。`files` 里必须带 `locale`，否则发布出去的包没有它。
- 判定实现、为什么行归属在 apply 时就能看见、认领表测试钩子：[docs/CONTRACT.md](docs/CONTRACT.md) 第 6 节。

## 4. 与 DSH 版本的耦合点

| 位置 | 取值 | 什么时候改 |
| --- | --- | --- |
| 分支名 / 安装 ref | `<harness 版本>-v<插件版本>`，与 `package.json` 的 `version` 完全一致 | 每次发布（从 dev 分支改名而来） |
| `package.json` 的 `version` | 完整版本号，唯一真源 | 开 dev 时提到目标版本 |

分支名是完整版本号，profile 名只是其中的 harness 版本，两者不相等，改动时分别对齐，都现查。实测记录在 `docs/VERIFY-<完整版本号>.md`，含未验证项。profile 路径不写死在源码里：需要时按 `profileContext.patchPath` → `profileContext.dir` → 命令行 `--profile <name>` 依次解析，拿不到就不写，只记 warn。

换 harness 版本时最容易重犯的三条（全文：[docs/PITFALLS.md](docs/PITFALLS.md)）：

1. 「append 没抛错」不等于「日志合法」。格式校验（`Relationships.requireStep`）只在加载时查，运行中写进去的非法事件要等重启才炸成「历史加载失败」。往会话日志里写东西之后，跑 `test/v4-load-check.mjs` 复核，并重启后再打开一次那个会话（坑 ⑪）。
2. id 的两种拼写每一步都要认。只认一种就会「删了又回来」，或让另一种拼写绕过闸门（坑 ①）。
3. 别把所有非预期异常都归成 `AGENT_BUSY`。内部故障要原样暴露成 `DELETE_FAILED`，否则每次兼容性失败都显示成「任务正在运行」。

还要盯的耦合面，换版本时逐条实测：会话目录形状与两种拼写；`surfaceOp` 字段名与 `sourceEventSeqs` 的适用类型；压缩与投影（已压缩的轮次必须判 `TURN_COMPACTED`）；`runMaintenance` 的租约语义；文件删除是否受沙箱约束（会话目录在 `$DSH_HOME` 下、不在工作区内，策略解析必须带作用域）；服务签名漂移。

## 5. 开发环境

- 无构建步骤、无运行时依赖。`package.json` 既没有 `dependencies` 也没有 `peerDependencies`，保持这样。
- 测试跑法与沙箱绕法见第 2 节。
- ⚠️ 沙箱下 `os.tmpdir()` 指向沙箱私有临时目录，与实例进程看到的真实临时目录不是同一个。不要靠 `tmpdir()` 去找另一个进程写的文件，要显式给出真实路径。
- ⚠️ 不要用 `(Get-Content x) -replace … | Set-Content x -NoNewline` 批量改文本：PowerShell 会把数组元素不带分隔符地拼在一起，整个文件被压成一行（踩过，三个 markdown 因此报废）。改文件用编辑工具，或在管道里显式 `-join "\`n"` 并保留结尾换行。
- 客户端测试不需要真 react，用记账替身调用组件，验证注册形状、每处 `require` 解构出来的东西、组件能否被构造。它不验证真实渲染，那要靠第 9 节的界面实测。
- 写代码前用 `cordis_inspect_list` / `cordis_inspect_query` 查 Service 契约、Event、Config schema、Slot 树与主题 token。
- 本机特有的信息（操作系统、安装路径、用户名、实例名、端口、沙箱怪癖）写到 `AGENTS.local.md`。

### 装进 profile 验证

```sh
dsh plugin --profile <profile 名> add github:ventisyn/dsh-agent-control#<已发布的完整版本号>   # git 引用
dsh plugin --profile <profile 名> add link:<本地 clone 路径>                                  # 本地链接，开发期最快
```

⚠️ pnpm 的 lockfile 锁的是 commit hash，推了新提交后必须重跑一次 `add`，否则装进去的还是旧 commit。

⚠️ 验证前先把功能重叠的插件从 profile 移除：同名槽位只能有一个主人，否则会出现两个垃圾桶按钮、两个弹窗互相监听同一个事件。移除后确认磁盘副本真的消失（`node_modules/` 下不该再有它的目录），并用一次轻量删除实测确认旧行为已下线——只删配置行而文件仍在时，加载器仍可能把它捞起来。逐步命令与判据：[docs/CONTRACT.md](docs/CONTRACT.md) 第 7 节。

## 6. 版本号与发布流程

版本号是 `<harness 版本>-v<插件版本>`，例如 `0.2.1-alpha.2-v1.3.1`。`package.json` 的 `version` 是唯一真源，它同时是版本分支名、tag 名 `release/<完整版本号>` 与 GitHub Release 的标题（标题不带 `release/` 前缀）。

插件版本 `X.Y.Z`：X 是不兼容的破坏性变更（路由路径、请求结构、错误码含义、旧日志不再兼容），Y 是向后兼容的新功能，Z 是向后兼容的修复，纯文档改动走 Z。换 harness 版本等于新开一条版本线，插件版本继续累加，不重置。

实验版本 `X.Y.Z-expN`（如 `1.1.0-exp1`）不占正式号，转正时正式版本修订版 +1：`1.1.0-exp4 → 1.1.1`。实验版本同样写进 `package.json`，dev 分支名也用它。

```
第零步  先开 dev 分支再动任何文件：git checkout -b <目标完整版本号>/dev
第一步  评估目标版本号（X / Y / Z 三选一，评错了 git branch -m 改名重来）
第二步  开发：把 package.json 的 version 提到目标版本 → 提交 chore: start <目标完整版本号>
        → 改代码 → npm test → 按第 9 节实测
第三步  发布前隐私检查（判据与清单只在本机文件里，公开仓库不写检查项）
第四步  验收通过后改名发布：dev 改名成版本分支 → 先删远端 dev 再推版本分支
        → tag → GitHub Release → 移默认分支 → 按保留策略删旧分支
```

逐步命令：[docs/RELEASING.md](docs/RELEASING.md)。

保留策略：Z 位发布不删任何旧分支；Y 位发布按 `X.Y` 分组，每组只留最新一条；X 位发布每个更早的主版本线只留最新一条。`/dev` 同时只有一条，改名成版本分支后下一轮再开。

版本号要落在第一个提交里，所以第一条命令是开 dev 分支。在版本分支上写代码再补开 dev，未提交的改动会跟过来（`git checkout -b` 不动工作区），但改动已经在已发布的版本号下待过一段时间，事后分辨哪些属于这一轮很麻烦。

## 7. 编码约定

- ESM（`.mjs`），无打包、无依赖。`client.js` 是纯 JS，不用 JSX、不 import CSS，用 `React.createElement` 或 loader 注入的 jsx-runtime。
- 注释、日志、用户可见文案用中文；发给模型或接口的机器可读字段（错误码、`kind`、事件名）用英文。
- 失败语义：异常收敛到「明确拒绝 + 说清原因」，不因为报错而假装成功。删除类操作的默认答案是「没做」。
- 破坏性操作只从 UI 触发，且必须过一次确认。不给 agent 工具无声批量删除的能力，除非当轮写清并加护栏。
- 边界由插件自己保证：不替任何子代理或调用方升权，不绕过沙箱、审批瀑布与权限预设。
- 纯逻辑与接线分开：算区间、算路径、算清理步骤的代码不 import cordis，除 `node:fs` 等内置模块外不 import 别的，要能在 `npm test` 里被假对象驱动。
- 客户端 UI 沿用已登记的槽位与 `order`，不抢其他插件的排序。客户端那一面本文件写得最薄是刻意的：槽位种类、owner props、可用图标名都要在活页面上核对。

## 8. Git 提交规范

格式 `type[(scope)]: description`。提交信息（标题与正文）用英文，代码注释、日志、UI 文案仍是中文。

| 类型 | 用于 | | 范围 | 对应 |
| --- | --- | --- | --- | --- |
| `feat` | 新功能 | | `host` | core 入口与生命周期 |
| `fix` | 修 bug | | `session` | 会话删除 |
| `refactor` | 重构，不改外部行为 | | `turn` | 轮次删除 |
| `docs` | 文档（README / AGENTS.md / docs / GLOSSARY / ADR） | | `ui` | `client.js` 的按钮与弹窗 |
| `style` / `test` / `build` / `chore` | 格式 / 测试 / 构建依赖 / 杂项（版本号、注释） | | `api` / `deps` | 路由 / DSH API 适配 |

- 英文祈使句、小写开头、结尾不加句号。标题 72 字符以内，细节放正文。
- 示例：`feat(session): delete a session with its directory and workspace accounting`、`fix(turn): stop reporting internal failures as an busy agent`、`docs: describe the session and turn deletion contract`、`chore: bump version to <完整版本号>`。
- 涉及删除逻辑的改动，正文补根因与验证方式，写明走了第 9 节的哪几项。
- 提交前必须通过 `npm test`。一条提交只做一件事，行为改动与纯格式改动不混在同一条里。
- 提交信息与文件内容里不出现 token、凭据、本机绝对路径、用户名、主机名、实例名与端口、私有仓库地址。

## 9. 安全红线与自检清单

### 红色底线

- 删除不可撤销。会话删除永久移除磁盘目录，拿不准就拒绝并说明，不「先删了再说」。
- 墓碑不是安全删除。轮次删除只影响模型可见上下文，内容仍在日志与附件里，README、UI 文案与本文件都必须这么写。
- 自建路由没有 harness 鉴权（3.5）。状态变更路由过可信校验 + JSON content-type，请求体必须校验，不提供未加确认的批量删除。
- 删除目标必须在执行前重新解析并确认：路径真实存在、与会话 id 对得上，不相信请求里传来的路径。
- token 与凭据不写进代码、日志或提交，需要时只在内存里传递。
- 本文件、`README`、`docs/` 里不写本机信息。仓库 owner 是例外，它已经写在公开的仓库地址里。
- 不提交 `*.bak-*`、`node_modules`、`AGENTS.local.md` 与本地 profile 产物。
- 发布前过一次隐私检查，清单只放在本机文件里。

### 改完自检清单

只通过语法检查不算完成。

1. `npm test`（`node --check` + 离线测试）。
2. 装进 profile 并重启 `dsh web`。`link:` 只让新装的 bundle 热激活，改动已加载的 host 模块不会生效，新加的路由会一直返回 401。重启前按第 5 节把重叠插件摘干净。
3. 在测试用会话里跑一次完整验证，至少覆盖：
   - 会话列表与界面一致，`live` / `running` 标注正确
   - 删一个不重要的会话：磁盘目录真的消失，`sessions/` 下没有残留，工作区记账里没有它，`storages/session_projcache/sessions/` 下两种拼写都没有；用会话 id 对 `$DSH_HOME` 全盘搜一次，除别的插件的数据与别的会话里提到它的文本外不该有命中
   - 删一个派生过子代理的会话：子代理目录与缓存一起消失，fork 出来的保留
   - 删一个 `session-<n>` 形式的 id，同样成功
   - 删一个仍活着的会话：成功，响应里 `wasLive: true`；删的是正在看的那个时界面切到同工作区的另一个会话，刷新后不停在已不存在的会话上
   - 重复删同一个会话：返回明确的「不存在」，不是 500，也不是假的成功
   - 删中间一轮：该轮从界面与模型上下文消失，前后轮次完好，并让模型确认被删轮次不在上下文里
   - 删最后一轮后新消息能正常追加
   - 删未结束的一轮：拒绝并说明还没结束
   - 在已压缩的会话里删轮次：判 `TURN_COMPACTED`，不删一半
   - 重启后再看：删除记录持久，已删轮次仍不出现，并且真的打开一次该会话确认能加载
4. 失败路径：故意制造内部错误（例如让 append 在 checkpoint 那一步抛错），确认返回 `DELETE_FAILED` 与原始错误信息，界面上不显示「任务正在运行」。
5. 界面：删除后列表就地刷新，不停留在已删除对象上；四类操作都要显式确认；不会同时弹出两个弹窗。
6. 用真实加载校验器复核：`node test/v4-load-check.mjs <DSH 的 node_modules/.pnpm> <会话 id>`。对照组（旧墓碑）必须 FAIL，新写法必须 OK 或被规划阶段明确拒绝。取证用 `node test/log-inspect.mjs <会话 id>`。
7. 把结论与踩到的坑写进 `docs/VERIFY-<完整版本号>.md`，含「仍然未验证」一节。

热重启的改动另按 [docs/CONTRACT.md](docs/CONTRACT.md) 第 5 节那份顺序实测：备用实例优先、安全回归、工具路径、续作、阻塞、拒绝、失败、过期 pending、回归、DSHL 托管形态。

文档重构：跑一遍锚点守恒与字节预算检查，并确认 `node --check` 与离线测试仍全绿。

## 附录：旧节号对照

| 旧编号 | 现在 |
| --- | --- |
| 第 4 节「与 DSH 版本的耦合点」+「已经踩过的坑 ①–⑪」 | §4（摘要）+ [docs/PITFALLS.md](docs/PITFALLS.md) 第 1 节（全文） |
| 第 5 节「开发环境」 | §5 |
| 第 6 节「编码约定」 | §7 |
| 第 7 节「Git 提交规范」 | §8 |
| 第 8 节「安全与隐私红线」 | §9「红色底线」 |
| 第 9 节「改完自检清单」 | §9「改完自检清单」；热重启那份在 [docs/CONTRACT.md](docs/CONTRACT.md) 第 5 节 |
| 第 10 节「分支开发流程」 | §6（摘要）+ [docs/RELEASING.md](docs/RELEASING.md)（全文） |
| 第 11 节「版本号规范」 | §6 |
| 3.1–3.10 | §3 同名小节，全文在 [docs/CONTRACT.md](docs/CONTRACT.md) |
| 旧 3.x 子标题 | 「幽灵会话」→ §3.1；「让那一行真的消失：借归档当临时遮盖」→ §3.1 与 [docs/PITFALLS.md](docs/PITFALLS.md) 第 2 节；「怎么证明上面这些真的发生了」→ §3.6；「X.Y.Z 的含义」→ §6 |
| 「坑 ①–⑪」 | [docs/PITFALLS.md](docs/PITFALLS.md) 第 1 节，编号没改 |
