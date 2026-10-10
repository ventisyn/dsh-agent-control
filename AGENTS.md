# AGENTS.md

思考使用简体中文
给在本仓库工作的 AI 编码代理（以及新加入的人）的操作手册。

**动手前先读第 4 节「与 DSH 版本的耦合点」、第 7 节「Git 提交规范」、第 10 节「分支开发流程」与第 11 节「版本号规范」；改完按第 9 节自检清单实测。** 本仓库若已有 `GLOSSARY.md` 与 `docs/adr/`，也要先读——它们是本项目自己的术语表与非显性决策（第 2 节）。

> ✅ **轮次删除已恢复（`0.2.0-rc.2-v1.0.0` 起，`0.2.1-alpha.1-v1.0.1` 沿用）**：改用与内核**手动压缩同形**的事务（`compaction/start` → `compaction/summary` → `compact-checkpoint` 替换 → `compaction/end`，`turn: null`），见 3.2。v1.0.0 的 `system/message` 墓碑会让会话**重启后打不开**（坑 ⑪），已不再写入。新写法已用 DSH 的**真实** v4 加载校验器在本机全部 60 个会话上逐轮模拟验证：244 次删除全部通过，旧写法对照组全部失败（`test/v4-load-check.mjs`）；**真机闭环也已走通**：删一轮 → 重启 `dsh web` → 打开会话正常加载、继续对话正常、模型确认看不到被删内容（`docs/VERIFY-0.2.0-rc.2-v1.0.0.md` 第 8 节）。
>
> ⚠️ **现状：离线测试 225 项通过（v1.0.0 真机复验时是 51 项，v1.0.1 是 84 项）。** 实测结论：
>
> - **删一轮**（完整链路）：墓碑以 `provider: dsh-agent-control` 落盘（`seq=41 turn=2 range=26..28`，`id` 是字符串）。~~带墓碑的日志被真内核完整重放~~——**错误结论**，重启后打开会话即「历史加载失败」（坑 ⑪）；删会话验证到磁盘/记账无残留，但**投影缓存 `session_projcache/sessions/<id>.json` 在本轮开发分支实测中残留**（见 3.3）
> - **拒绝路径**：`SESSION_LIVE`（409）、`TARGET_NOT_FOUND`（404）、参数校验含路径穿越（400）、错误方法（405）
> - **界面行为**：只隐藏目标轮次（坑 ⑩）、删除后**实时**更新不需刷新（6.2）、同步时不再让已藏的行闪现一帧（6.3）、删除时该轮**收起折叠**（6.4）——四条都已由用户真机确认
>
> **尚未验证**（只剩一条）：`DELETE_FAILED` 从真实失败渲染——本轮**试过造这个失败但没造出来**（Node 在 Windows 上带全部共享位打开文件，宿主的 `rm` 挡不住；只读缓存只进 warnings），证据链两段各自成立、接口未串起来（VERIFY 第 11.7 节）。
>
> **已收口**（VERIFY 第 10、11 节）：
>
> - `GET /turns` 跨重启——**答案是持久的，但只有在本次进程里打开过的会话才读得到**（未打开 → `TARGET_NOT_FOUND`，与「没有删除记录」同码）；重启后打开会话，已删轮次**不复活**（turn 2 的 6 行全隐藏、其余轮次完好，`/turns` 请求在页面加载后 11.2s 拿到 382 字节的非错误响应）。
> - **会话删除的成功路径**：连删若干会话，`removed` / `detached` / `projectionCache.removed` 逐字段核对，全盘复核**目录与缓存零残留**、`workspace.json` 不再提到被删 id；删一个派生过 3 个子代理的会话时，**父与子四个目录、四条缓存一次性删净**。
> - **「切走就能删」被彻底证伪**：重启后请用户切走，`/sessions` 仍报该会话 `live: true`；切走不释放、页面重载不释放（11.3），**只有重启进程**。
> - **删除后列表就地刷新**（VERIFY 第 11.5→本轮）：重启后删一个**没打开过**的会话，页面标记存活、`performance.timeOrigin` 不变（**没有整页重载**）、目标行消失、弹窗关闭。
> - **`TURN_COMPACTED` 真实样本**（VERIFY 第 12 节）：`/compact` 压过 4 轮会话后去删 turn 1，弹窗显示「这一轮已被压缩或不再连续，无法单独删除。（第 1 轮已经不在可见面上，无法单独删除）」；日志里**零**本插件删除事务（拒绝发生在写入之前），`GET /turns` 仍答 `[]`——**内核压缩掉的轮次不算本插件的删除记录**，且内核那边字段名确实是 `shadowedRange {start,end}`。

这个插件的失败模式大多是**静默降级**：不报错、不崩溃、路由全部 200，只是悄悄没干活——删除「成功」返回但会话/轮次照旧存在，UI 上的删除按钮点了没反应，或者换个 harness 版本后插件依然加载正常、只是永远不生效（第 4 节列了三个已经踩过的真实例子）。

**本仓库是独立实现**：只使用 DSH 的公开 API，不 fork、不 vendoring 任何第三方插件源码，也不复制它们的实现（判断依据见第 3.3 节）。

## 1. 这是什么

`dsh-agent-control` 是 DeepSeek Harness（DSH）的持久插件，把「删掉一个会话」和「删掉一轮对话」这两件**破坏性、不可撤销**的操作收进一个插件，用同一套确认与失败语义管理：

- **会话级（Session）**：列出会话、把一个会话连同它的磁盘目录与工作区记账一起彻底删除
- **轮次级（Turn）**：从**模型可见上下文**里删掉一轮已结束的对话（问题 + 回复 + 该轮工具记录），会话本身、之后的轮次与 append-only 日志都保留

设计目标：**破坏性操作只有一个入口、一套确认、一种失败语义**；新增能力（例如归档会话、导出会话、清理附件、批量清理）挂到同一套结构上，而不是再开一个插件。

## 2. 仓库结构

| 路径 | 作用 |
| --- | --- |
| `src/index.mjs` | host 端插件入口：`apply` / `inject` / `name`，注册 HTTP 路由与生命周期，只做接线，不写业务 |
| `src/session-delete.mjs` | 会话删除：定位磁盘目录、停 agent、清工作区记账、确认删净（不 import cordis，可用假对象单测） |
| `src/turn-delete.mjs` | 轮次删除：算轮次区间、算 surface 区间、追加删除事务（压缩同形四件套）、认识新旧两种删除记录 |
| `src/restart.mjs` | **热重启的纯逻辑**：阻塞项计算、限频、启动规格（argv 重放）构造、`pending.json`/`last.json` 读写与过期判断（不 import cordis，可离线单测） |
| `src/restart-helper.mjs` | **热重启的辅助进程**：旧进程退出后拉起新进程并探测就绪。单文件、只用 `node:*`、不 import 本仓库任何模块；由旧进程以 `detached` 派生，**活在旧进程之外** |
| `src/restart-tool.mjs` | **热重启与关闭实例的接线**：`restart_harness` 工具定义 + 唯一入口 `requestRestart`（守卫、审批、单飞、退出时序），以及 `requestShutdown`（只判定 + 返回退出动作，**没有模型工具**）；工具与 HTTP 路由共用它们 |
| `src/shared.mjs` | host 与 client 共用的常量与纯工具（路由路径、错误码、id 校验、轮次括号） |
| `client.js` | 浏览器端 bundle，经 `window.__ModuleLoader__.load({ id: 'dsh-agent-control', factory })` 注册 |
| `test/*.test.mjs` | 离线测试（`npm test` 的主体），六个文件分别覆盖轮次删除、会话删除、客户端 bundle、host 接线、热重启纯逻辑、热重启辅助进程（`host.test.mjs`：HTTP 状态映射与活会话闸门） |
| `test/log-inspect.mjs` | **只读**会话日志诊断器（3.6）：解压 `session.v4.jsonl.zstd`、列墓碑、独立复刻 surface 代数、打印「磁盘 vs 模型可见」对照。**故意不叫 `*.test.mjs`** —— 它没有测试项，命名成测试文件会白白抬高 `node --test` 的计数、让「196 项」这个对照基准漂移。它是**取证工具**，用法与两个必知的实现细节见第 9 节 |
| `test/fake-session.mjs` | 假内核：复刻 append 时的 surface 校验规则，让区间算错在离线阶段就失败 |
| `test/v4-load-check.mjs` | 用 DSH 安装目录里**真实的** v4 加载校验器检查会话日志，并在内存里逐轮模拟删除（坑 ⑪ 的防线）。依赖本机 DSH 安装，**不进** `npm test` |
| `package.json` | `main` / `exports`（`.` 与 `./client`）、`dsh.bundle.patch`、`dsh.client.platform = web` |
| `cordis.patch.yml` | bundle patch：`insert` 插件行（id `agent-control`） |
| `docs/` | `VERIFY-0.2.0-rc.2-v1.0.0.md` 与 `VERIFY-0.2.1-alpha.1-v1.0.1.md`（均已落地，含未验证项清单）；`GUIDE.md`、`screenshots/` 未落地 |

拆成 `src/*.mjs` 而不是姊妹项目那样的单文件，是因为**核心逻辑必须能离线单测**：轮次删除是一段容易算错的区间代数，只有把纯逻辑与 cordis 接线分开，才能在 `npm test` 里覆盖（第 5、9 节）。

客户端 UI（槽位名与 `order` **从 DSH 已登记的槽位约定沿用**；落地前用 `cordis_inspect_query` 的 `Slots.listSubTree` 现查过，四个都是 `list` 槽位，必须给 `id`）：

| 槽位 | entry id | order | 作用 |
| --- | --- | --- | --- |
| `sidebar.workspaces.session.menu.item` | `agent-control-session-menu` | 500 | 会话行「…」菜单里的删除项（原生项是 100 置顶 / 200 重命名 / 300 分叉 / 400 归档，删除排最后；用原生 `MenuItemButton` 的 `danger` + `separatorBefore`） |
| `conversation.chat.assistant-actions` | `agent-control-turn-delete` | 90 | 每条已结束回复旁的垃圾桶按钮（28×28、与「复制 / 分叉」同款，原生 `Tooltip` 气泡） |
| `shell.overlay` | `agent-control-dialog` | 100 | 两种删除共用的确认弹窗 |
| `conversation.chat.turnTail` | `agent-control-turn-marker` | 90 | 已删除轮次的隐藏标记 |

**已核对的真实 DOM 契约（`dsh-client-ui-chat` 的 `ChatNodeSeat` + `TurnTailNodeView`）**：每个节点行是一个 `div`，带

```js
"data-chat-flow-kind": routedNode.kind,  // 'system-prompt' / 'user' / 'steering' / 'turn-trigger' / 'turn-process' / 'turn-error' / 'turn-max-tokens' / 'turn-tail'
"data-chat-turn": turn,                  // ← 这一行**属于哪一轮**（隐藏已删轮次就靠它）
"data-turn-tail": data.turn,             // 只有该轮的尾巴行有
```

外面套一层 `[data-chat-flow]`（滚动列，或 `data-step-process-content` 分组座位）。
**不要顺着兄弟节点推断轮次边界**——见第 4 节坑 ⑩。

**会话行一律走官方槽位，不做 DOM 注入**：`SessionRowOwnerProps` 直接给出 `sessionId` 与 `displayTitle`，**不需要靠标题去猜目标**（靠标题猜会在同名会话上删错，见第 4 节坑 ③）。

样式只用 DSH 设计 token（`--dsw-alias-*` / `--dsh-*`），不要自己造色值；控件级的度量与 token 抄已装原生组件库的 CSS，**不要只靠 `Theme.listTokens` 定 token 名**——它只列「可覆盖」子集（见第 4 节）。

## 3. 关键机制

> 每个依赖的 DSH Service 签名，写代码前都要用 `cordis_inspect_query`（`Service.listService` 带 `service` 参数）拿到**精确契约**再用，不要凭记忆或照抄本节，也不要照抄任何现成实现——它们正是踩在这里的（第 4 节）。

### 3.1 会话删除（已实现）

**删除是硬删除、不可撤销**：磁盘上用递归强制删除，没有回收站、没有备份、没有软删除。目标路径是 `<DSH_HOME>/sessions/<slug>/<sessionId>/`，其中 `<slug>` **靠遍历 `sessions/` 现查**，不要自己从工作区路径推导编码规则（会随版本变化）。

会话 id 在磁盘上有**两种拼写**（裸 UUID 与 `session-<UUID>`），两种都要处理——只认一种就会删不干净，表现为「删了又回来」。早先见过的删除实现里，正则只接受 UUID 形式，而 store 自己铸造的 id 形如 `session-<n>`，这类会话**根本没被覆盖**（第 4 节）。

删除必须按**固定顺序**（顺序错了会留下孤儿目录或错误的记账）：

```
校验 id → 拒绝活会话（两种拼写都查）→ 确认磁盘上有目录（没有 → TARGET_NOT_FOUND，不产生任何副作用）
        → 找出子代理后代（读会话头：origin=subagent 且 parentSession 指向它，递归；fork 不算）
          → 任一后代活着 → SESSION_LIVE，整次放弃、什么都不动
        → 停掉运行中的 agent（目标 + 后代；cancel + 等静默，有超时上限）
        → 删磁盘目录（目标 + 后代）→ 再删一次（防 dispose 路径重建）→ 确认删净
        → 才清工作区记账（两种拼写都认，用记账里那一种去解除）
        → 清投影缓存（`ctx.storageDomain.get('session_projcache').table('sessions').delete`，两种拼写）
```

**「不留残留」的范围（0.2.0-rc.2 实测，用一个真实会话 id 全盘 grep 得出）**：会话目录、`storages/workspace.json` 里的记账、`storages/session_projcache/sessions/<id>.json`、以及子代理会话（`origin: 'subagent'` 的独立会话，实测 59 个会话里有 25 个是子代理；父会话头里写 `session-<uuid>`，子代理目录是裸 uuid）。**刻意不碰**：别的插件自己的数据（如审批插件的 `auto-approve/events.jsonl` 里有 sessionId 字段——那是它的审计记录，不归我们删）、内容寻址的共享附件、别的会话日志/缓存里**提到**这个 id 的文本（例如子代理的提示词里写着父会话 id）。投影缓存**必须走域的表接口删**，不能直接删 json 文件：域在内存里持有一份，直接删文件会在下次写入时被写回来。

**id 两种拼写贯穿每一道闸门**：找目录时两种拼写都会被删，所以活会话闸门（`ctx.sessions.get`）、agent 查找、工作区/归档/置顶记账也必须两种都查——只查一种，用另一种拼写请求就能绕过闸门删掉活会话的目录（已修复的真实 bug）。响应里的 `detached` 等于记账是否真的被解除，不是恒真。

**「哪些会话活着」每次现查 store**，不在模块级别缓存：`ctx.on` 的监听随插件 fiber 卸载而注销，而 host 模块不会被重新 import（坑 ⑦），内核也不会在热重载时重放 `session/created`——缓存一份副本必然过期。

**DSH 没有「删除会话」这个公开 API。** 已在 `0.2.0-rc.2` 核对过 `SessionStore`（即 `ctx.sessions`）的公开面：`create` / `prepare` / `enter` / `announce` / `flush` / `get` / `list` / `registerMessageProjection` / `fork`，**没有任何 `delete` / `remove`**；把已进入 store 的会话摘出去的唯一公开途径是 `enter(session)` 返回的那个 **detach disposer**，而 `detachEntered` 是 `private`。

**关键推论：那个 disposer 只交给创建者，插件拿不到。** 它由 agent 工厂在 `AgentRegistry.create()` 时持有（类型文档原话：the disposer is a CAPABILITY），`ctx.sessions` 上没有任何办法再取回它。所以本插件的删除是**两段拼接**——磁盘目录 + 工作区记账——外加一道**拒绝活会话**的闸门：

```
活会话 → 拒绝（SESSION_LIVE），提示重启后不打开它直接删（切走没用，见下）；
否则   → 删磁盘目录 → 确认删净 → 清工作区记账
```

⚠️ **「活会话」≈「本次启动后打开过的会话」**（0.2.0-rc.2 真机实测）：切换到别的会话**不会**让它下线。Web 端由 `dsh-api-session-controller` 打开会话并持有 `AgentHandle`，它没有空闲回收、也没有关闭入口；`AgentRegistry` 的公开面（`get` / `list` / `roots` / `create` / `resume` …）同样没有卸载手段。所以会话会一直驻留到 `dsh web` 退出，用户唯一的出路是**重启后不打开它、直接从侧栏菜单删除**。文案必须照这个说，早期版本写的「先切换到别的会话再删」是错的。
（**实测闭环**：重启后请用户切走，复查 `GET /sessions` 该会话仍是 `live: true`；页面 `location.reload()` 之后也仍是——**只有重启进程才释放**。见 VERIFY 第 11.3、11.5 节。）

为什么不是「删了磁盘、内存里的条目留着」：那会留下「目录没了但会话还在列表里」的半删除现场，且活着的会话可能继续追加事件、把目录写回来。**宁可拒绝一次操作，也不制造一个说不清的状态。**

**绝不假装删成功**：工作区那段可能没执行（没有注册表）或部分失败，这些都必须单独回报，不能合并成一个布尔。有一种常见写法是「无论如何都删下去」：把 `storageDomain` 的每一次失败都 `catch {}` 吞掉，于是 `projRemoved` / `workspaceRemoved` 为假时**分不清「本来就没有」和「清理抛错了」**——本仓库不采用这种写法。

**磁盘现状（已实测）**：`<DSH_HOME>/sessions/<slug>/<id>/session.v4.jsonl.zstd`，`<slug>` 是工作区路径的转义形式（例如 `--D--…-dsh-agent-control--`，非 ASCII 会被转义成 `~XXXX~`），且**同一个 slug 下裸 UUID 与 `session-<UUID>` 目录并存**。所以：`<slug>` 只靠遍历，id 两种拼写都要覆盖。

### 3.2 轮次删除（已实现）

**不重写日志、不截断文件**。DSH 的会话日志是 append-only 的事件流。删除一轮 = 追加一笔**与内核手动压缩（`dsh-compaction-basic` 的 `compactNow`，owner 为 null）同形**的事务，只是「摘要」不由模型生成，而是一句固定的删除提示：

```
定位目标 assistant 消息 → 取它所属轮次 → 该轮必须已闭合（turn/start … turn/end）
  → 当时不能有打开的轮次、不能有进行中的压缩（独立压缩只能落在轮次之间）→ 否则 AGENT_BUSY
  → 算出该轮在可见面上的连续区间（与别的内容共用节点 / 不连续 → TURN_COMPACTED）
  → 在 agent.runMaintenance(task) 里同步追加四个事件：
      compaction/start   { compactionId, turn: null }
      compaction/summary { compactionId, summary, shadowedRange, shadowedSeqs, shadowedTokenCount,
                           provider: 'dsh-agent-control', model: 'turn-delete' }
      user/message       replace 该区间，source { kind: 'compact-checkpoint', compactionId }，
                         sourceEventSeqs = [startSeq, summarySeq, ...被遮蔽节点]，内容是一句删除提示
      compaction/end     { compactionId, turn: null }
  → flush 成功（返回值不是 false）才算成功
```

要点：

- **为什么是压缩事务**：格式 v4 加载时要求 `system/message` 落在打开的轮次与步骤里（坑 ⑪），被删的轮次已经结束，旧墓碑没有合法位置；**独立压缩事务**是格式本身为「在轮次之间改写可见面」准备的通道。`dsh-compaction` 的不变量（`invariant.js`）在 append 时校验它，v4 加载校验器在重启时再校验一次——两道都已核对。
- **模型看到什么**：被删的整轮换成一条用户消息「[此处原有一轮对话，已被用户删除；其内容不再提供。]」。刻意如此：直接抽掉会让上下文前后衔接不上。
- **影子价格** `shadowedTokenCount`：取 `ctx.tokenMeter.measure(session).nodes` 中被遮蔽节点的 `heuristicTokens` 之和（与内核压缩同口径），拿不到计量服务时按字符数粗估；估偏只影响上下文用量的估计。
- **事务中途失败**：照抄内核手动压缩——`compaction/start` 一写下就是会话级压缩锁，之后任何一步失败都补一个带 `error` 的 `compaction/end` 放锁；放不掉就在错误里如实说明。
- **识别**：`deletedTurns(events)` 同时认新事务（`compaction/summary` + 自有标记，轮次号从被遮蔽节点反推）与 v1.0.0 旧墓碑。**内核 `/compact` 压掉的轮次不算「已删除轮次」**——那是宿主的压缩呈现（界面照常显示该轮），插件不该把它报成自己删的；实测见 VERIFY 第 12.3 节。
- **压缩过的轮次怎么拒**：内核压缩把它移出可见面之后，去删它会命中 `planTurnRemoval` 的「已经不在可见面上」分支 → `TURN_COMPACTED`，并且**不写任何事件**；界面文案是「这一轮已被压缩或不再连续，无法单独删除。」外加宿主原文。
- **删的是「模型看得见的面」，不是磁盘上的字节**。被删内容仍完整留在日志与附件里——**这不是安全删除**，README 与 UI 文案必须如实说明。
- **失败必须是拒绝，不是删一半**：所有校验都在第一个事件写入之前完成。
- **换 harness 版本时**：先跑 `node test/v4-load-check.mjs <DSH 的 node_modules/.pnpm> <会话 id>`，确认对照组（旧墓碑）FAIL、新写法 OK，再做真机删除 + 重启 + 打开会话。

「flush 成功」要**看返回值**：`ctx.sessions.flush(session)` 返回 `Promise<boolean>`（是否至少有一个持久化监听器参与），`false` 表示事务只在内存日志里、重启后这一轮会复活，必须报 `DELETE_FAILED`。重复请求走「已删过」分支时也要**再 flush 一次**。

错误码（host 与 client 共用，`src/shared.mjs`）：

| 码 | 含义 | 客户端文案方向 |
| --- | --- | --- |
| `TARGET_NOT_FOUND` | 会话不再存活 / 消息找不到 | 目标已不存在 |
| `TURN_NOT_CLOSED` | 目标轮次还没结束 | 这一轮还没结束 |
| `TURN_COMPACTED` | 该轮已被压缩或不再连续 | 这一轮已无法单独删除 |
| `AGENT_BUSY` | 拿不到维护租约，agent 确实在干活 | 任务正在运行 |
| `DELETE_FAILED` | 其他内部失败 | **不得**显示成「任务正在运行」 |

`DELETE_FAILED` 单独存在是刻意的：如果把所有未知异常都归成 `AGENT_BUSY`，每一次真实的兼容性失败都会显示成「任务正在运行，请结束后再删除」——**最误导的一种静默降级**。内部失败必须原样暴露。

`runMaintenance` 的契约里有两个容易写错的地方：它挂在 **Agent 实例**上（`ctx.agents` 注册表**没有** `runMaintenance` / `cancel` / `whenIdle`，那三个都在 `agent` 对象上）；拿不到租约时是**同步 throw**（不是返回 rejected promise），所以「先 `await` 再 try」的写法根本接不住——必须把调用整个包在 try 里。

### 3.3 公开 API 与私有内部的分界（已核对）⚠️

**这是本项目的核心约束**：那些依赖私有内部结构写出来的插件之所以「能跑」，一半靠的是没有契约保证的东西。下面这张表是 0.2.0-rc.2 的核对结果——**左列可以用，右列禁止用**（用了就等于把插件绑死在一个补丁版本上，而且失效时通常不报错）。

| 需求 | 公开、可以用 | 私有、禁止 |
| --- | --- | --- |
| 找活着的会话 | `ctx.sessions.get(id)` / `list()` | — |
| 摘除已进入 store 的会话 | `enter(session)` 返回的 detach disposer | `SessionStore.detachEntered`（`private`）、`liveEntryFor`（`private`）、`store` 字段（`private`） |
| 读会话事件 | `session.snapshotEvents(from?, to?)`（⚠️ 0.2.0-rc.2 起标了 `@deprecated`、「new calls are prohibited」，换 harness 版本时优先确认替代 API） | `session.events`（旧属性，0.1.2-alpha.1 起已不是公开面） |
| 读当前可见面 | `session.surface.nodes` | — |
| 追加事件 / 墓碑 | `session.append(type, data, intent?)`，`surfaceOp` 的合法形状是 `{ op: 'replace', startSeq, endSeq }`（**恰好三个键**） | 旧形状 `{ op, start, end }`（那两个名字是内部 plan 的字段，不是入参） |
| 引用被遮蔽的源事件 | `sourceEventSeqs`，**只允许**出现在 surface 事件类型上（`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`） | 在 `assistant/message` 上携带（内核直接抛 `embeds its source stream`）；在非 surface 类型上携带 |
| 停 agent / 等静默 / 拿租约 | `agent.cancel(cause, options?)`、`agent.whenIdle()`、`agent.runMaintenance(task)` | 从 `ctx.agents` 上找这三个方法（不在那里） |
| 读领域数据 | `ctx.storageDomain.get(name)` → `.table(n)` / `.global` | 以为 `ctx.storageDomain` 自己有 `.table` / `.global`（那两个在 Domain 句柄上） |
| 删附件 | —（**没有公开 API**） | `attachments` 是模块级 `WeakMap`，不是会话成员；拿不到就别假装能删 |

**已核对的磁盘/域名字面量（实测）**：`$DSH_HOME/storages/` 下是 `workspace.json`（工作区记账）与 `session_projcache/sessions/<会话 id>.json`（投影缓存，实测文件名带 `session-` 前缀）。本插件按 `ctx.workspaceRegistry` 的公开接口清记账，并按 `ctx.storageDomain.get('session_projcache')` → `.table('sessions')` → `.delete(id)` 清投影缓存（`KvTable.delete` 同时更新域的内存表与磁盘文档）。早期版本**没有**清缓存：v1.0.0 的「缓存里不残留」是偶然，本轮开发分支实测删除后**残留了** `session_projcache/sessions/session-<id>.json`，全盘扫描还找到 8 个早已删掉的会话留下的缓存记录。注意磁盘上的文件名是**带前缀**的 `session-<uuid>.json`（不是早先写的裸 UUID）——所以两种拼写都要删。拿不到域时如实回报「缓存没清」，不要退回去直接删文件。

**附件的现状**：删除轮次**不会**清理附件字节，而且当前内核也没有公开的附件清理 API。因此「被删轮次的图片/文件仍留在 `$DSH_HOME/attachments`」是**已知且无法在本插件内解决**的限制——必须写进 README 与 UI 文案，不要留白让人以为已经清干净。

**关于归档**：内核确实有**归档**能力（`ctx.workspaceRegistry.archiveSession(sessionId)` / `unarchiveSession`），它是「藏起来」不是「删掉」，与硬删除是两件事。未来若加「归档」功能，走这条公开 API；**不要用归档去实现删除**，也不要让两者在 UI 上互相混淆。

### 3.4 确认与提示（已实现）

两类操作都是破坏性的，**都过同一个确认弹窗**（`shell.overlay` 里的 `DeleteDialog`，底层用原生 `RiskConfirmation`：确认按钮在勾选之前是禁用的）：

- 弹窗里写清**目标是什么**（会话名 + id / 第几轮 + 消息 id）与**到底会发生什么**（会话：连同磁盘目录与记账一起永久删除；轮次：只从模型上下文移除，日志仍在）
- 两类都要求**显式勾选**，没有「记住我的选择」，也不提供「一键删多轮」
- 按钮与弹窗之间用自定义事件 `dsh-agent-control:request-delete` 通信：按钮只负责派发目标，弹窗统一监听。这样一个弹窗就能服务两类操作，不会出现两个弹窗同时响应
- 会话删除在确认时**再查一次列表**：目标不存在 → `TARGET_NOT_FOUND`，仍是活会话 → `SESSION_LIVE`，两条都在弹窗里说清楚，而不是让用户对着一个笼统的失败猜。host 端仍会独立校验一次（不信任前端）

### 3.5 HTTP 接口（已实现）

```
GET  /api/agent-control/sessions               # { ok, sessions: [{ sessionId, workspaceTitle, cwd, running, live, removable, reasons }] }（workspaceTitle 是工作区名，不是会话标题）
GET  /api/agent-control/turns?sessionId=       # { ok, sessionId, turns: number[] }（该会话已删的轮次，墓碑是持久事实）
                                               # ⚠️ 只在**活动会话**上可读：读取走 ctx.sessions.get(id)，重启后没被打开过的会话
                                               # 返回 TARGET_NOT_FOUND（与「本来就没有删除记录」同码）。答案本身是持久的：
                                               # 打开会话后与重启前逐字一致（VERIFY 第 10 节）
POST /api/agent-control/session/delete         # { sessionId }
POST /api/agent-control/turn/delete            # { sessionId, assistantMessageId }
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

失败一律 `{ ok: false, error: { code, message } }`，状态码由错误码映射（400 / 403 / 404 / 409 / 423 / 429 / 501）。**删除类的路由没有鉴权**：DSH 的插件自建路由不走 harness 的鉴权链路，谁都能访问这个端口就能调用删除。因此：

- 请求体必须校验：字段存在、类型、id 形状（只允许 `[A-Za-z0-9._:-]`、拒绝 `..`）、长度上限、请求体上限 64 KiB
- **不要在 UI 之外额外暴露批量删除**，除非当轮就想清楚误删的后果
- 端口若绑到非回环地址（`webServer.config.host` 支持 `0.0.0.0`），等于把「删除我的会话」暴露给整个网络；文档与 README 里要写明
- **`POST /restart` 是这里唯一会改变进程状态的接口，必须额外过可信校验**：优先用宿主公开的 `ctx.connection.requestRejection({ headers })`（它做的是宿主自己的 Host/Origin 校验**加浏览器鉴权**，返回 401/403 就照抄）；拿不到该服务时退回自实现——`Origin` 存在时其 host 必须等于 `Host` 头，缺失 `Origin` 时必须带自定义头 `x-dsh-agent-control: 1`。缺了这道校验，任何能打开一个网页的人都能 CSRF 掉整个实例。
  - ⚠️ **实测（v1.1.0）**：`requestRejection` 会把「没有浏览器凭据」的请求**直接判 401**，所以回调里的自实现路径在正常部署下**根本走不到**——这不是缺陷，是比计划更严的结果：界面上同源已登录的请求照常通过，脚本/未登录调用者拿到 401 而不是靠一个自定义头就能放行。
- `GET /restart/status` **故意不做可信校验**：辅助进程在新进程刚起来、还没有任何凭据的时候就要靠它判断就绪。它只读、不改变任何状态，可以接受这个暴露面（能访问端口的人能读到 pid / 端口 / 阻塞会话 id / 最近一次结果）。

**路由注册必须把 disposer 返回出去**（`ctx.effect(() => ctx.webServer.register({...}))`）：`register` 对重复 `(kind, path)` 会抛错；如果注册写成返回 `undefined` 的箭头函数，注销就完全靠 fiber 卸载——重复 `apply` 会撞上（第 4 节）。

### 3.6 怎么证明上面这些真的发生了：`test/log-inspect.mjs`

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

### 3.7 加载期的命脉：别让一个 import 弄死整个插件

本插件运行在**别人的进程**里，裸模块（`@deepseek-ai/*`）能不能解析取决于宿主 loader。顶层静态 import 一旦解析失败，**整个插件消失**：host 模块加载失败 → 所有路由 404 → 界面上什么都不出现。因此：

- **host 端不 import 任何 `@deepseek-ai/*` 包**，只用 Node 内置模块与 `ctx` 上的服务。（v1.0.0 曾在 `src/tombstone.mjs` 懒加载 `@deepseek-ai/dsh-llm`，实测从插件位置**解析不到**、一直走兜底；删除事务改为自己构造消息后，这个文件已删除。）
- **客户端 `require` 解构出来的每个东西都要假定可能不存在**：`require('@deepseek-ai/dsh-client-ui-primitives')` 包在 try/catch 里，拿不到就退回自带的内联 SVG 垃圾桶与确认框（**仍然要求显式勾选**）。这类问题在别处真实发生过：一个不存在的图标名就让组件渲染抛错（第 4 节坑 ③）。

排障抓手：浏览器控制台里 `window.__dshAgentControl.usingNativePrimitives()` 告诉你这次用的是原生原语还是兜底；`window.__dshAgentControl.apply` 是注册函数本体。

### 3.8 数据与运行环境（已实现）

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

### 3.9 热重启（已实现）

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
  - 机制（读启动器日志与其二进制字符串得出）：它**按自己 spawn 的子进程 PID** 认实例（就绪判定 = 读子进程 stdout 的登录横幅）；进程一退出就记「已退出」；只有**它自己启动时**才做一次「核验并恢复监控」，判据是 `实例记录 {0} 的进程已退出或身份不符，未接管` ⇒ 新 PID 不会被认领。它的对接记录是不透明的加密文件（`%LOCALAPPDATA%\DSHL\Sessions\*.session`），**不要**去改写它。
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

## 4. 与 DSH 版本的耦合点 ⚠️

**分支名是完整版本号，profile 名只是其中的 harness 版本 —— 两者不相等**，改动时必须分别对齐（版本分支名等于 `package.json` 的 `version`，用 `git branch` 现查；profile 名就是本机实例名，现查 —— 本文件不复述具体名字，避免腐烂，也避免泄露本机信息）。

| 位置 | 取值 | 什么时候改 |
| --- | --- | --- |
| 分支名 / 安装 ref | `<harness 版本>-v<插件版本>`，与 `package.json` 的 `version` 完全一致 | 每次发布新版本 → 从 dev 分支改名而来（第 10 节） |
| `package.json` 的 `version` | 完整版本号 `<harness 版本>-v<插件版本>`，与分支名一致 —— **唯一真源**（第 11 节） | 同上（第 11 节） |

**实测记录的所在**：`docs/VERIFY-<完整版本号>.md` 是每次实测的正式记录（第 9 节第 8 步），里面同时列出**未验证项**——那部分不要当成通过。

**profile 路径不写死在源码里**：实例名可能被改成别的，写死就有可能改到别人的配置上。若插件需要定位 profile，运行时解析（`profileContext.patchPath` → `profileContext.dir` → 命令行 `--profile <name>`）；拿不到就**不写**，只记 warn。

### 已经踩过的坑（换 harness 版本时最容易重犯，逐条都要避掉）

**① 轮次删除在 0.2.x 上一删就「任务正在运行」**

- 现象：点删除 → 弹窗 → 确认 → 提示「任务正在运行，请结束后再删除」，而当时确实没有任务在跑。
- 根因：墓碑用的是旧形状——`surfaceOp` 写成 `{ op, start, end }`（新契约要求 `startSeq` / `endSeq`），并且在 `assistant/message` 上携带了 `sourceEventSeqs`（新契约**禁止**该事件类型携带）。两处都会让事件校验同步抛错。
- 放大问题：`deleteTurn` 把所有非预期异常统一包成 `AGENT_BUSY`，于是「内核不兼容」被显示成「任务忙」，每次排查都找错方向。
- 结论：墓碑形状**跟着会话格式走**（3.2），错误码分出 `DELETE_FAILED`，并且**换 harness 版本时第一件事就是实测一次真删**。

**② 被就地修补过的第三方副本：一重装就回退，也不能当行为参照**

- 现象：本机 profile 里装过的一个删除类插件**在安装目录里被就地改写过**（包内文件留下了 `*.bak-<时间戳>` 备份）。
- 后果：任何一次重装/更新都会把那份修改冲掉，行为会**悄悄退回**到改动之前；而「声明兼容」（放宽 `peerDependencies`）并不等于 host 端真的适配过——**声明兼容 ≠ 实际兼容**。
- 结论：这也是本仓库选择自己实现而不是 fork 的理由之一。另外，拿别人的实现做行为对照时，**先确认那份副本是不是原始版本**——被就地修补过的副本，它的行为不能作为参照。

**③ 浏览器端依赖了不存在的导出与不存在的 API**（读源码时发现，未在活页面上复验）

- 现象 A：某个图标名在 primitives 里**不存在**（只有同族的另一个名字），组件渲染直接抛 `Element type is invalid`，而插件其它部分照常加载。
- 现象 B：删除后「就地刷新列表 + 自动切到下一个会话」整段是**死代码**——它调的成员在客户端 sessions 服务上根本不存在，于是删除成功后用户仍停在已删除的会话视图上，没有任何报错。
- 结论：**客户端每一次 `require(...)` 解构出来的东西都要在活页面上确认存在**；调用任何服务成员前先查契约，不要按记忆写。这两类失败都不报错、不回滚，只能靠人眼发现。

**④ 注册形状与槽位种类必须现查**

- 槽位的 `kind`（`list` / `chain` / `keyed`）决定哪些注册字段必填：`select` 只属于 `chain`，`list` 要 `id`。按错的 kind 注册时**注册本身可能不抛错**，只是拿不到宿主注入的 props，组件随后在渲染时抛错，被槽位错误边界吞成「什么都不显示」。
- 排查手法：`cordis_inspect_query` → `Slots.listSubTree`，看该槽位声明的 `kind` 与 owner props。

**⑤ `Theme.listTokens` 只列「可覆盖」子集**

它返回的是主题注册表里的 token，**不是**页面上可用的全集——`--dsw-alias-label-tertiary`、`--dsw-radius-md` 之类都不在表上却在实际使用。要拿控件级度量与 token，去读已装的原生组件库 CSS（`@deepseek-ai/dsh-client-ui-primitives` 的 `settings-form/fields.module.css`、`Button.module.css`、`Input.module.css`）；猜 token 名会得到「无样式/不可读」而**不会报错**。

**⑥ 新建 profile 的用户层 `cordis.patch.yml` 默认内容是 `[]`**

若要文本级写入，往 `[]` 后面直接拼块序列项会产出**非法 YAML**，下次启动直接起不来。排查手法：`dsh --profile <名> --dump-config`。

**⑦ host 端改动不会热加载**

`link:` 安装只让「**新装**的 bundle」热激活，**已加载的 host 模块不会因文件改动而重新导入**：新加的路由会一直返回 **401**（落到需要鉴权的 fallback），而原已注册的路由仍然 200。必须重启 `dsh web`（第 9 节第 2 步）。

**⑧ 懒加载的 fallback 缺一个 `id`，于是「每一轮都失败」**

- 现象：点删除 → 弹窗 → 确认 → 宿主拒绝：`format v4 system message id requires a string with content`；同一轮对话本身也报 `本轮运行失败`。DevTools 里 `turn/delete` 是 **500**。
- 根因：墓碑走的是「拿不到内核构造器 → 同形兜底」那条路（**本机上它才是实际生效的路径**，见 3.7），而兜底对象**没有 `id`**。v4 的格式校验器要求 system 消息带**非空字符串** id（`dsh-session-format-v3-to-v4` 的 `string(message["id"], "system message id", true)`）——「内容为空」并不是免票理由。
- 为什么难发现：错误信息指向「格式」，而 `id` 这种东西不会让人想到是**插件自己造消息**时漏的；而且失败发生在格式校验层，看起来像内核的问题。
- **一个已经排掉的更坏情况**：实测确认这次坏事件**没有**落盘（校验在写入前就拒绝了，日志里 0 条坏墓碑）。如果它真写进去了，重启还原时整段日志都会校验失败——那才是灾难。写兜底路径时必须把这条可能性一起考虑。
- 结论：**兜底路径要当主路径来测**。留了注入点 `buildTombstoneMessage({ create: null })`，测试必须覆盖它产出的消息字段（第 9 节第 7 步）。

**⑨ 界面文案不要编造自己拿不到的信息**

- 现象：确认弹窗上写着 `turn ?`——因为 `conversation.chat.assistant-actions` 槽位**只给消息 id**，拿不到轮次号，而文案却去读了 `target.turn`。
- 结论：**拿不到的字段就不要显示**。目标本来就靠「点了哪条回复」确定，文案只需把删的是哪一条指认清楚；轮次号由宿主在删除后返回，服务端也能用 `/turns` 查。用 `?` / `未知` / `--` 占位是在假装有信息，比不显示更糟。

**⑩ 顺着兄弟节点推断轮次边界，把更早的轮次一起隐藏了**

- 现象：用户只删了一轮（第二句），结果**第一句也从界面上消失了**——数据层是对的，界面层多藏了。
- 根因：隐藏已删轮次时从该轮的尾巴行往前逐个 `previousElementSibling`，用
  `cursor.querySelector('[data-chat-flow-kind="turn-tail"]') != null` 判断「是否到了上一轮」。
  `cursor` 往上走到**容器/分组**时，其后代里当然有 `turn-tail`，于是循环一路吃到根部，
  把该轮**之前的所有轮次**全部 `hidden`。兄弟遍历还默认了「所有行同层」这个没被保证过的前提。
- 正确做法：宿主已经在每一行上给出归属——`data-chat-turn`。直接在一个 `[data-chat-flow]`
  容器里取 `[data-chat-turn="N"]` 即可，**不需要推断边界**。
- 附带教训：**认不出归属时就什么都不隐藏**。少藏只是界面滞后（模型那边已经看不到了），
  多藏是用户以为内容丢了。降级方向要选安全的那一侧。
- 排查手法：把 `dsh-client-ui-chat` 的 `lib/client.js` 里 `ChatNodeSeat` 的属性列表挖出来——
  DOM 属性是**读**出来的，不是猜出来的。

**⑪ 墓碑当下合法、重启后整个会话打不开**

- 现象：删一轮 → 界面正常、`/turns` 正常、日志里的墓碑形状检查全过 → 重启 `dsh web` 后打开该会话：「历史加载失败：stored log is corrupt: SessionFormatError: system/message does not match an open turn and step」。
- 根因：格式 v4 的加载校验器（`dsh-session-format-v3-to-v4` 的 `Relationships.requireStep`）要求 `system/message` / `developer/message` / `assistant/attempt` 落在**打开的 turn 与 step** 里、且编号一致。**运行中的内核 append 不查这条**，只在加载时查；墓碑写在已结束的轮次之后，当下一路绿灯，重启才炸。
- 为什么没早发现：v1.0.0 的「真内核重放」没有走加载校验；假内核也没复刻这条规则；形状检查只看字段。三道防线都漏在同一处。
- 结论：**「append 没抛错」不等于「日志合法」**。凡是往会话日志里写东西，都要对照**加载时**的格式校验器逐条核对，并且真机**重启后再打开一次**才算验证。现在改用与内核手动压缩同形的独立压缩事务（3.2），四道防线：host 写入前复算（没有打开的轮次/压缩）、假内核复刻加载规则与压缩不变量、诊断器的「事务检查」、用真实加载校验器离线模拟的 `test/v4-load-check.mjs`。

### 需要重点盯的耦合面（预判，落地时逐条实测）

- **会话在磁盘上的目录形状**：`<DSH_HOME>/sessions/<slug>/<id>/` 的两级结构与 id 的两种拼写都是实现细节。诊断：故意造一个 `session-<n>` 形式的 id，删除必须同样有效。
- **surface 区间代数**：`surfaceOp` 字段名、`sourceEventSeqs` 的适用事件类型、被替换区间能否包含 system prompt 节点——这条链一变，删除要么抛错、要么删错范围。诊断：每次换 harness 版本都按第 9 节第 3 步实测。
- **压缩与投影**：日志被压缩后，某些轮次**本来就不该**可删。要确认这种情况被判 `TURN_COMPACTED`（拒绝并说明原因），而不是删掉一半。
- **`agent.runMaintenance` 的租约语义**：agent 状态卡在非 `idle` 时，租约拿不到——但如果durable 事件里那一轮**已经闭合**，是「状态卡住」而不是「真的在干活」，不能把用户永远挡在门外。区分这两者要靠事件流，不要靠 `agent.status`。
- **文件删除是否受沙箱约束**：会话目录在 `$DSH_HOME` 下，**不在会话工作区内**。删除走 Node 文件 API 还是走 `ctx.fs` + `ctx.sandboxPolicy.resolve({ session })`，直接决定它在别的部署上能否工作（策略解析必须带作用域，拿 `resolve({})` 得到的常常是 profile 目录而不是会话工作区，会误判边界）。拿不到 session 时**不擅自放宽**，退回默认值并记 warn。
- **服务签名漂移**：本插件依赖的每个 Service，换 harness 版本时都要用 `cordis_inspect_query` 重新核对签名，不要照抄本节或任何一个现成实现。

## 5. 开发环境

- **无构建步骤、无运行时依赖**：`package.json` **既没有 `dependencies` 也没有 `peerDependencies`**，请保持。host 端只用 Node 内置模块；客户端只用 loader 注入的 `react`。
- `npm test` = 先对**七个** `src/*.mjs`（`index` / `shared` / `session-delete` / `turn-delete` / `restart` / `restart-helper` / `restart-tool`）与 `client.js`、`test/` 下的九个 `.mjs` 逐个 `node --check`，再跑 `node --test "test/**/*.test.mjs"`（**225 项**）。**离线测试不碰真实 profile**：会话删除的文件操作全部在 `os.tmpdir()` 里的临时目录，用完即清；热重启与关闭实例的测试一律注入假的 spawn/appExit，**绝不真的派生进程或退出**。
- `npm run log:inspect -- <会话 id>` = 跑会话日志诊断器（3.6）。它**不是测试**，不出现在 `npm test` 里。
- ⚠️ **沙箱下 `npm test` 会「假失败」**：`node --test` 默认**要为每个测试文件 spawn 一个子进程并走管道**，受限沙箱里直接报 `Error: spawn EPERM`，六个测试文件全 ✖、`pass 0 fail 6`，看起来像测试坏了——**那是沙箱边界，不是测试失败**。两个办法：
  1. 用更宽的权限跑一次（第 9 节第 1 步）；
  2. **不 spawn 地跑**：逐个直接执行 `node test/restart.test.mjs`（54）、`node test/restart-helper.test.mjs`（22）、`node test/host.test.mjs`（44）、`node test/client.test.mjs`（57）、`node test/turn-delete.test.mjs`（25）、`node test/session-delete.test.mjs`（23），合计同样是 **225 项全绿**。（这个数字随测试增减而变：改了 `test/` 就把本节开头的总数、这里的逐文件数字与 `README` 的「开发」一节一起更新，别让它腐烂。）
  Node 还需要在系统临时目录建目录（写桩模块、建临时会话树），受限时也会以 `EPERM`/`Access is denied` 失败。
- ⚠️ **沙箱下 `process.env.TEMP` / `os.tmpdir()` 指向的是沙箱私有临时目录**，与实例进程看到的真实临时目录**不是同一个**。写诊断脚本时不要靠 `tmpdir()` 去找另一个进程写的文件（本机实测踩过），要显式给出真实路径。
- ⚠️ **不要用 `(Get-Content x) -replace … | Set-Content x -NoNewline` 批量改文本**：PowerShell 会把数组元素**不带分隔符**地拼在一起，整个文件被压成一行（本机刚踩过：三个 markdown 文件因此报废，只能从 git 恢复）。改文件用编辑工具，或在管道里显式 `-join "\`n"` 并保留结尾换行。
- DSH 数据目录为 `$DSH_HOME`（默认 `~/.dsh`）；本插件**只有热重启那一处受控例外**会落盘：`$DSH_HOME/agent-control/restart/`（3.8 列了三个文件与各自的生命周期）。删除类功能仍然**不建任何数据目录**，不要去那里找删除相关的东西。
- **客户端测试不需要真 react**：`client.test.mjs` 用记账替身调用组件，因此不依赖运行时里有没有 react，也不依赖 DOM。它验证的是**注册形状、每处 `require` 解构出来的东西、以及组件能否被构造**（这三类正是最容易静默失效的地方），**不验证真实渲染**——那必须靠第 9 节的界面实测。
- 写代码前用 `cordis_inspect_list` / `cordis_inspect_query` 查 Service 契约、Event、Config schema、Slot 树与主题 token，不要猜名字。
- **本机特有的信息不写进本文件**（操作系统、安装路径、用户名、实例名、端口、网络/沙箱怪癖）。需要记录时写到 `AGENTS.local.md`，并确保它在 `.gitignore` 里。

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

## 6. 编码约定

- ESM（`.mjs`），无打包、无依赖；`client.js` 是纯 JS，**不用 JSX、不 import CSS**，用 `React.createElement` 或 `react/jsx-runtime`（由 loader 注入，不进 `dependencies`）。
- 注释、日志、用户可见文案一律中文；发给模型或接口的机器可读字段（错误码、`kind`、事件名）用英文。
- 保持失败语义：**任何异常都必须收敛到「明确拒绝 + 说清原因」，绝不能因为报错而假装删除成功**。删除类操作的默认答案永远是「没做」，不是「大概做了」。
- 破坏性操作**只从 UI 触发**，且必须过一次确认；不要给 agent 工具一个「无声批量删除」的能力，除非当轮明确写清并加护栏。
- 边界由插件自己保证：不替任何子代理或调用方升权，不绕过沙箱、审批瀑布与权限预设。
- 纯逻辑与接线分开（第 2 节）：算区间、算目标路径、算清理步骤的代码不要 import cordis，也不要 `import fs` 之外的东西——它们必须能在 `npm test` 里被假对象驱动。
- 客户端 UI 沿用已登记的槽位与 `order`，不要抢占其他插件的排序。
- 新增能力时同步更新 `docs/GUIDE.md` 与本文件第 3 节；本仓库自己出现新术语或够格的决策时，同步更新本仓库的 `GLOSSARY.md` / `docs/adr/`。

## 7. Git 提交规范

**每次改完代码顺手提交**，不要把多件事攒成一条。提交信息用约定式格式：

```
type[(scope)]: description
```

> **提交信息（标题与正文）统一用英文。** 代码里的注释、日志与 UI 文案仍然是中文（见第 6 节），两者不要混。

### 类型（必填）

| 类型 | 用于 |
| --- | --- |
| `feat` | 新增功能（新的删除能力、新 UI 槽位、新 API） |
| `fix` | 修复 bug（删除不生效、删错范围、UI 异常） |
| `refactor` | 重构 / 调整结构，不改变外部行为 |
| `docs` | 文档（README / GUIDE / AGENTS.md / GLOSSARY.md / ADR） |
| `style` | 格式调整，不影响逻辑 |
| `test` | 测试相关（`test/*.mjs` 离线测试，见第 5 节） |
| `build` | 构建 / 依赖变更（`package.json` 的 `files`、`exports`、`dsh` 字段等） |
| `chore` | 其他杂项（版本号、注释等） |

### 范围（可选，推荐填）

| 范围 | 对应 |
| --- | --- |
| `host` | `src/index.mjs` 的插件主体 / 生命周期 |
| `session` | 会话删除：目标定位、停 agent、内存记账、删盘确认 |
| `turn` | 轮次删除：轮次区间、surface 区间、墓碑 |
| `ui` | `client.js` 的按钮、弹窗、隐藏标记 |
| `api` | `/api/agent-control/*` 路由 |
| `deps` | DSH API 适配（版本漂移） |

### 描述

- 英文**祈使句**、小写开头、结尾不加句号：`fix turn deletion failing on session format 4`（而不是 `Fixed ...` / `fixes ...`）。
- 一行标题控制在 72 字符以内，细节放正文。
- 涉及删除逻辑的改动，在正文里补**根因**与**验证方式**（第 9 节自检清单的哪几项）。

### 示例

```
feat(session): delete a session with its directory and workspace accounting
feat(turn): hide a deleted turn behind a format-aware tombstone
fix(turn): stop reporting internal failures as an busy agent
fix(ui): refresh the session list in place after deletion
docs: describe the session and turn deletion contract
chore: bump version to 0.2.0-rc.2-v1.0.1
```

### 硬性要求

- 提交前必须通过 `npm test`（`node --check` + 离线测试）；只跑语法检查不算通过。
- 一条提交只做一件事：**行为改动与纯格式改动不要混在同一条提交里**。
- 提交信息与文件内容里**不要出现隐私与敏感信息**：token、凭据、本机绝对路径、用户名、主机名、实例名与端口、私有仓库地址。

## 8. 安全与隐私红线

- **删除是不可撤销的**：会话删除会永久移除磁盘目录。任何「拿不准」的情况一律拒绝并说明，不允许「先删了再说」。
- **不要把墓碑当成安全删除**：轮次删除只影响模型可见上下文，内容仍在日志与附件里。README、UI 文案与本文件都必须如实说明，**不得暗示内容已被彻底清除**。
- **自建路由没有鉴权**（3.5）：请求体必须校验，不得提供未加确认的批量删除；不得把删除能力开放给 agent 工具而没有任何护栏。
- 删除目标必须在**执行前**重新解析并确认（路径真实存在、与会话 id 对得上），不要相信请求里传来的路径。
- 不要把 token / 凭据写进代码、日志或提交，需要凭据时用 `git credential fill` 之类方式**只在内存里传递**。
- 本文件、`README`、`docs/` 里不写本机信息（见第 5 节）：路径、profile 名、实例名、端口一律用 `<profile 名>`、`<本地 clone 路径>` 这类占位符。**仓库 owner 是例外**——它已经写在公开的仓库地址里，安装命令写真实的 `ventisyn` 才能直接复制执行。
- 不要提交 `*.bak-*`、`node_modules`、`AGENTS.local.md` 与本地 profile 产物。
- **发布前必须过一次隐私检查**（第 10 节第三步）：判据与清单**只放在本机文件里**（`AGENTS.local.md`，已被 `.gitignore` 忽略），公开仓库里不写——把「我们怕什么被看到」写进公开仓库，等于把答案一并公开。

## 9. 改完自检清单

任何删除逻辑的改动，都按这个顺序实测（**只通过语法检查不算完成**）：

1. `npm test`（`node --check` + 离线测试）
2. 装进 profile 并**重启 `dsh web`**——已实测：`link:` 安装只让**新装**的 bundle 热激活，**改动已加载的 host 模块不会生效**（新加的路由会一直返回 401）。重启前先按第 5 节把旧插件摘干净
3. 在一个**测试用会话**里跑一次完整验证，至少覆盖：
   - **会话列表**：`GET /api/agent-control/sessions` 返回的会话数与界面上看到的一致；`live` / `running` 标注正确
   - **删除一个不重要的会话**：磁盘目录**真的消失**（不是只剩配置行），`sessions/` 下没有残留，工作区里也没有指向它的记账，`storages/session_projcache/sessions/` 下没有它（两种拼写）的文件；**用会话 id 对 `$DSH_HOME` 全盘 grep 一次**，除了别的插件的数据与别的会话里提到它的文本，不该再有命中
   - **删一个派生过子代理的会话**：子代理会话的目录与缓存一起消失，fork 出来的会话保留
   - **删一个 `session-<n>` 形式的 id**：同样要成功（第 4 节坑 ①）
   - **删一个仍活着的会话**：必须被判 `SESSION_LIVE` 并拒绝，磁盘目录原样保留；界面要说清楚「切走没用，重启后不打开它直接删」
   - **重复删同一个会话**：返回明确的「不存在」，不是 500，也不是假的成功
   - **删中间一轮**：该轮从界面与模型上下文消失，**前后轮次完好**；把会话发给模型确认被删轮次确实不在上下文里
   - **删最后一轮**：成功后新消息能正常追加
   - **删未结束的一轮**：拒绝并说明「还没结束」
   - **在已压缩的会话里删轮次**：拒绝并判 `TURN_COMPACTED`，不是删一半
   - **重启后再看**：删除记录是持久的，已删的轮次在重启后**仍然**不出现在上下文与界面上（这条同时验证 `GET /turns` 的答案跨重启有效）；**并且重启后要真的打开一次该会话**，确认它能加载（坑 ⑪ 就是只看接口、不打开会话漏掉的）
4. **失败路径**：故意制造内部错误（例如让 append 在 checkpoint 那一步抛错），确认返回的是 `DELETE_FAILED` 与原始错误信息，**界面上不显示「任务正在运行」**
5. **界面**：删除后列表**就地刷新**，不停留在已删除对象上；确认弹窗对两类操作都要求显式确认；两种删除不会同时弹出两个弹窗
6. **用真实的加载校验器复核**（不要只信假内核）：`node test/v4-load-check.mjs <DSH 的 node_modules/.pnpm> <会话 id>`。它直接调 DSH 安装目录里的 `restoreReleasedV4Artifact` + `assertReleasedV4Relationships`，在内存里逐轮模拟删除；对照组（旧墓碑）必须 FAIL，新写法必须 OK 或被规划阶段明确拒绝
   - 取证的现成工具是 **`node test/log-inspect.mjs <会话 id>`**：它解压日志、列墓碑、独立复刻一次 surface 代数，并打印「磁盘 vs 模型可见」对照与被遮蔽内容的原文。**「删了没有 / 删对了没有 / 到底还留着什么」这三问都用它回答**，不要每次现写脚本（现写必然重踩下面这个坑）
   - ⚠️ **会话日志是多帧拼接的 zstd**：`zstdDecompressSync(buf)` **只解第一帧**，而第一帧只有 253 字节的会话头 —— 你会得到「这个会话只有 1 行」，看起来像日志被清空了。要按魔数 `28 b5 2f fd` 逐帧切（诊断器就是这么做的），或者 `createZstdDecompress()` 把整块 buffer **一次 `end()`**（分多次 `write()` 同样只解第一帧，且不报错）
8. 把这次实测的结论与踩到的坑写进 `docs/VERIFY-<完整版本号>.md`，并回填本文件里所有「规划」标注

### 热重启的改动，另外按这个顺序实测

热重启的失败模式比删除更阴——**它会把用户正在用的实例弄没**，所以每条都要真跑，不接受「应该可以」：

1. **先在备用实例上跑，再上主用实例**。备用实例用一次性 profile（`--from-default-profile web` 初始化），**不要**拿主实例当试验品。
2. **安全回归**：不带 `Origin` 且不带自定义头的 `POST /restart` 必须 403；`Origin` 与 `Host` 不一致必须 403；非 JSON 的 `Content-Type` 必须 400。这三条用脚本每次都要重跑。
3. **工具路径**：模型调用 `restart_harness`（带 `reason` 与 `resume_note`）→ 审批卡片里能看到 `reason` → 批准 → **本轮正常结束**（日志里 `tool/result` 之后是 `turn/end`，用 `test/log-inspect.mjs` 与 `test/v4-load-check.mjs` 各查一次）。
4. **续作**：新进程起来后那个会话收到续作消息并**继续干活**，模型能复述重启原因。这是 S5，最容易只测一半。
5. **阻塞路径**：另开一个会话跑长任务 → 工具调用被 `RESTART_BLOCKED` 拒绝，且文案告诉模型「等哪个会话结束」。
6. **拒绝路径**：审批被拒 ⇒ `RESTART_DENIED` 且**进程没动**；重启进行中再请求 ⇒ `RESTART_IN_PROGRESS`；限频 ⇒ `RESTART_RATE_LIMITED`。
7. **失败路径**：人为给 spec 一个坏参数 ⇒ 新进程起不来 ⇒ `last.json{ok:false}`，界面显示失败态与日志文件名，**不无限转圈**。
8. **过期 pending**：手工把 `createdAt` 改成 11 分钟前 ⇒ 新进程丢弃、不投递、记 warn。
9. **回归**：重启之后本插件原有的删除功能（会话列表、删会话、删轮次）仍然正常。
10. **DSHL 托管的实例**必须至少跑一次端到端——辅助进程能不能活过由启动器拉起的父进程，只有在那种形态下才算验证过（`docs/SPIKE-hot-restart.md` 的 S1）。

## 10. 分支开发流程

**每个已发布的完整版本对应一条版本分支**（分支名 = 完整版本号）。改动先落在**以目标版本命名**的 `/dev` 分支上，验收通过后**把 dev 改名成版本分支**即可发布。

```
<已发布的完整版本号>          ← 已发布的版本分支（旧分支按保留策略处理）
<目标完整版本号>/dev         ← 正在开发的目标版本（尚未发布）
```

首个版本没有上一条版本分支：`git init` 后直接在 `0.2.0-rc.2-v1.0.0/dev` 上开发，验收后按第四步改名发布。

### 第一步：先评估目标版本号

**开工前就要定下这一轮要发布的版本号** —— 因为分支名从此就是目标版本号：

| 改动性质 | 目标版本（以 `v1.0.0` 为例） |
| --- | --- |
| bug 修复 | `v1.0.1`（Z +1） |
| 向后兼容的新功能 | `v1.1.0`（Y +1，Z 归零） |
| 破坏性变更 | `v2.0.0`（X +1，Y、Z 归零） |

完整规则见第 11 节。**评错了就改名重来**（`git branch -m`），不要带着错的版号继续开发。

### 第二步：开 dev 分支并开发

```sh
git checkout <已发布的完整版本号>          # 上一条版本分支
git pull
git checkout -b <目标完整版本号>/dev      # 名字 = <目标完整版本号>/dev

# 顺手把版本号提到目标版本（唯一真源，见第 11 节）：
#   package.json  ->  "version": "<目标完整版本号>"
git commit -am "chore: start <目标完整版本号>"

# ...改代码...
npm test

# 按第 9 节自检清单实测：装进 profile → 重启 dsh web → 真删一次

git commit -m "fix(turn): ..."              # 规范见第 7 节，可以多条
git push -u origin <目标完整版本号>/dev
```

### 第三步：发布前隐私检查（不可跳过）

**推送 = 永久公开**：分支、tag、Release 与它们能回溯到的历史在那一刻定型，之后**只能往前修，改不掉历史**。所以这一步排在「改名发布」之前。

- **按本机的检查清单逐条过一遍**：清单只存在于本机（第 5 节：这类私有约定写到 `AGENTS.local.md`，它已被 `.gitignore` 忽略），**不写进本仓库**。
- **检查范围是「这次发布会新增的全部字节」**，不是只有代码：新增 / 修改的文件全文、提交信息（标题与正文）、分支名 / tag / Release 标题与说明。
- 命中就**先改再发**；确实改不掉的（已经公开过的旧内容）在当次的 `docs/VERIFY-<完整版本号>.md` 里记一句待办——**不要在公开文档里复述检查项本身**。
- 结论写进当次 `docs/VERIFY-<完整版本号>.md`：一行「隐私检查：已过 / 有几处待办」即可。

### 第四步：验收通过后改名成版本分支

**「验收」的定义就是第 9 节自检清单全部通过。没跑过实测的改动不许改名发布。**

```sh
git checkout <目标完整版本号>/dev
git branch -m <目标完整版本号>/dev <目标完整版本号>    # 改名 = 发布，dev 名消失

# ⚠️ 先删远端 dev，再推版本分支。版本分支名是 dev 名字的前缀，远端不能同时存在
# refs/heads/X 与 refs/heads/X/dev —— 否则 GitHub 以 directory file conflict 拒绝。
git push origin --delete <目标完整版本号>/dev
git push -u origin <目标完整版本号>
git tag release/<目标完整版本号>
git push origin --tags

# ① 建 GitHub Release（不只是打 tag）：DSHL 插件列表把有 Release 的显示成「正式版」、裸 tag
#    显示成「标签」，而列表渲染的是 Release 的**标题**——所以标题写干净的版本号，
#    release/ 前缀只留在 tag 名上（tag 与分支同名会让 git 报 refname is ambiguous）。
gh release create release/<目标完整版本号> --title "<目标完整版本号>" --notes-file <说明.md>

# ② 把 GitHub 默认分支移到新版本：仓库首页与 git clone 默认取的就是它；默认分支也无法被 --delete。
gh api -X PATCH repos/ventisyn/dsh-agent-control -f default_branch=<目标完整版本号>

# 下一轮再从头评估新的目标版本，开 <新目标版本>/dev
```

要点：

- **每次发布都要建 GitHub Release，不能只打 tag**；Release 标题写干净版本号。
- **tag 名带 `release/` 前缀，分支名不带**：两者同名会让 git 报 `refname is ambiguous`。
- **每次发布后把 GitHub 默认分支移到新版本**。
- **先删远端 `/dev`，再推版本分支**（`directory file conflict`）。
- `/dev` 分支**同时只有一条**；它改名成版本分支后，下一轮开新的。
- 版本分支**只由 dev 改名产生**：不要直接在版本分支上提交，也不要为同一个版本另开分支。
- 版本号在 dev 的**第一个提交**里就提到目标版本；中途若改动性质变化，先 `git branch -m` 改成新目标版本名，再改 `package.json`。

### 版本分支保留策略

按**插件版本**分组处理（不区分 harness 前缀）。新发布的版本本身永远保留：

| 本次发布的位 | 动作 |
| --- | --- |
| **Z**（修订版） | 不删任何旧分支 |
| **Y**（次版本） | 按 `X.Y` 分组，**每组只保留最新一条** |
| **X**（主版本） | 按 `X` 分组，**每个更早的主版本线只保留最新一条** |

分支名省略 `<harness 版本>-` 前缀，连续发布时的演进：

| 发布 | 位 | 保留的分支 |
| --- | --- | --- |
| `1.0.0` | — | `1.0.0` |
| `1.0.1` | Z | `1.0.0`、`1.0.1` |
| `1.1.0` | Y | `1.0.1`、`1.1.0`（删除 `1.0.0`） |
| `1.1.1` | Z | `1.0.1`、`1.1.0`、`1.1.1` |
| `1.2.0` | Y | `1.0.1`、`1.1.1`、`1.2.0`（删除 `1.1.0`） |
| `2.0.0` | X | `1.2.0`、`2.0.0`（删除 `1.0.1`、`1.1.1`） |

要点：

- 删分支前先确认该版本 tag 已推送（`git push origin --tags`），这样分支删掉仍能靠 tag 回溯。
- 删远端分支：`git push origin --delete <分支名>`。**如果要删的正好是 GitHub 默认分支，必须先切默认分支**。
- `/dev` 分支不进这套策略，它始终只有一条。

### 在 dev 分支上验证插件

```sh
# 方式一：从 dev 分支装（pnpm 按分支名解析 ref）
dsh plugin --profile <profile 名> add github:ventisyn/dsh-agent-control#<目标完整版本号>/dev

# 方式二（推荐，迭代最快）：链接本地工作副本，改完重启/热加载即生效
dsh plugin --profile <profile 名> add link:<本地 clone 路径>
```

⚠️ 用方式一验证完，记得把 profile 切回**已发布版本分支**的 ref（`#<已发布的完整版本号>`），否则会一直跟着 dev 跑。

## 11. 版本号规范

本插件的版本号**独立于 harness 版本号**，两者拼成完整版本号：

```
<harness 版本>-v<插件版本>          例如 0.2.0-rc.2-v1.0.0
```

- **harness 版本**：完整版本号的前缀（例 `0.2.0-rc.2`）。按约定它同时是 profile 目录名，但插件源码**不依赖**这一点。换 harness 版本 = 新开一条版本线，**插件版本继续累加**。
- **插件版本**：`X.Y.Z`，本插件初代版本为 `v1.0.0`（本项目是全新实现，不继承任何既有插件的版本号，从 1.0.0 起算）；跨 harness 版本**继续累加**，不重置。
- **完整版本号**：写进 `package.json` 的 `version` —— **这是唯一真源**；它同时是**版本分支名**（第 10 节）、发布 tag `release/<完整版本号>` 的名字，以及对应 GitHub Release 的标题（**标题不带 `release/` 前缀**）。不要在 README、源码或别处重复维护。

### X.Y.Z 的含义

| 位 | 递增条件 | 旧版本分支 |
| --- | --- | --- |
| X（主版本） | 不兼容的破坏性变更，例如路由路径或请求结构变化、错误码含义变化、墓碑形状不再兼容旧日志 | 每个更早 X 线只留最新一条 |
| Y（次版本） | 向后兼容的新功能，例如新增可管理的对象类型、新增 UI 槽位 | 每个旧 Y 线只留最新一条 |
| Z（修订版） | 向后兼容的 bug 修复 | 全部保留 |

### 实验版本

- 格式 `X.Y.Z-expN`（例 `1.1.0-exp1`），**不占用正式版本号**，用于在 `/dev` 上反复试的改动。
- 转正时正式版本的**修订版 +1**：`1.1.0-exp4 → 1.1.1`。实验版本号与它的 git tag **保留**，可回溯。
- 实验版本同样写进 `package.json`，即 `0.2.0-rc.2-v1.1.0-exp1`；此时 dev 分支名也用它（`0.2.0-rc.2-v1.1.0-exp1/dev`），转正时改名为正式版本分支（如 `0.2.0-rc.2-v1.1.1`）。

### 版本号在流程里的位置

1. **开 dev 时**：把 `package.json` 的 `version` 提到目标完整版本号，提交 `chore: start <目标完整版本号>`
2. **验收改名后**：打 tag `git tag release/<目标完整版本号>` 并推送

⚠️ 换 harness 版本时：新开版本分支 `<新 harness 版本>-v<下一个插件版本>`，**插件版本继续累加**；并且**必须按第 9 节实测**——会话目录形状、surface 区间代数、槽位种类这类漂移，恰恰是换版本时最容易踩的坑（第 4 节）。
