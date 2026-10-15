# PITFALLS — 已经踩过的坑与实现细节

> 本文件是 [AGENTS.md](AGENTS.md) 的**配套细节**，不是必读：AGENTS.md 第 4 节只留最易重犯的几条摘要，
> 全文在这里。换 harness 版本、动删除逻辑、或怀疑「某个功能为什么长这样」时再来读。
>
> 内容按 2026-10-15 的原样搬移（只改了标题层级），**没有改写结论**。

## 1. 已经踩过的坑（换 harness 版本时最容易重犯）

**① 轮次删除在 0.2.x 上一删就「任务正在运行」**

- 现象：点删除 → 弹窗 → 确认 → 提示「任务正在运行，请结束后再删除」，而当时确实没有任务在跑。
- 根因：墓碑用的是旧形状——`surfaceOp` 写成 `{ op, start, end }`（新契约要求 `startSeq` / `endSeq`），并且在 `assistant/message` 上携带了 `sourceEventSeqs`（新契约**禁止**该事件类型携带）。两处都会让事件校验同步抛错。
- 放大问题：`deleteTurn` 把所有非预期异常统一包成 `AGENT_BUSY`，于是「内核不兼容」被显示成「任务忙」，每次排查都找错方向。
- 结论：墓碑形状**跟着会话格式走**（3.2），错误码分出 `DELETE_FAILED`，并且**换 harness 版本时第一件事就是实测一次真删**。

**② 被就地修补过的第三方副本：一重装就回退，也不能当行为参照**

- 现象：一个删除类插件的安装副本**被就地改写过**（包内文件留下了 `*.bak-<时间戳>` 备份）。
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


## 2. 会话删除的「归档遮盖」：完整实现与实测经过

> 对应 AGENTS.md 3.1 的「让那一行真的消失」。那里只留结论，这里是为什么与踩过的顺序问题。

删一个「本次启动后打开过」的会话时，宿主的**会话列表仍然会列出它**：`ApiSessionList.list()` 把 `ctx.sessions` 里活着的
会话也算进去，而插件没有任何公开 API 能把那条内存记录摘掉（`detachEntered` 是 private、`AgentHandle.dispose()` 只交给创建者）。
删完之后它不属于任何工作区，于是被侧栏摆进「未分组」——真机实测：删完那一行还在，下一次列表拉取还会把它带回来
（只发 `api-session/removed` 只能让它闪一下）。

所以删除**之前**先调宿主的公开能力 `workspaceRegistry.archiveSession(id, { stopActivity: true })`：归档正是宿主
「从列表里藏起来」的公开能力（归档行默认不显示，状态会立刻推给界面），用它压住这段窗口。**这不是用归档代替删除**：
磁盘、记账、缓存随后都真的删掉，只刻意保留这一条标记（`keepArchived`，否则删除流程会顺手把它解除、幽灵又被放回来）。

- ⚠️ **顺序不能反**：删完再归档会被宿主拒绝——`live sessions and session persistence hold no such session`。
- ⚠️ **两种拼写都要试**：宿主按存储里的规范 id 找会话（`sessionKnown`：先查 store、再查头部索引），另一种拼写一定被拒。
- 只有**活目标**才归档；归档失败只降级成一条 warning，绝不影响删除结果。
- **删除失败要把这一藏撤回**：`deleteSession` 抛错（`TARGET_NOT_FOUND` / `AGENT_BUSY` / `DELETE_FAILED`）时，接口报失败、会话却已从侧栏消失，是最误导的状态。所以 `archiveForHiding` 先记下调用前这个会话（两种拼写任一）是否**已经在归档集合里**，只有「调用前不在、且本次归档成功」才算自己加的标记（`ownMark`），失败时才 `unarchiveSession`——先试归档成功的那种拼写，再试另一种，逐个试到成功为止。用户原本的归档绝不替他解除；撤回自己失败只记 logger warn，**原来的删除错误原样继续抛出**（`rollbackHidingArchive` 永不抛）。⚠️ `stopActivity: true` 已经把那个会话的 agent 停掉了，这一步**撤不回来**：取消归档只让它重新出现在列表里，不会让 agent 活过来。
- 实例重启后那条内存记录不复存在，标记成了孤儿——`pruneOrphanArchives()` 在启动时清掉它，判据保守：
  **活着、或磁盘上确实还有目录的一律不动**（宁留标记，不误删记账）。

**「不留残留」的范围（0.2.0-rc.2 实测，用一个真实会话 id 全盘 grep 得出）**：会话目录、`storages/workspace.json` 里的记账、`storages/session_projcache/sessions/<id>.json`、以及子代理会话（`origin: 'subagent'` 的独立会话，实测 59 个会话里有 25 个是子代理；父会话头里写 `session-<uuid>`，子代理目录是裸 uuid）。**刻意不碰**：别的插件自己的数据（如审批插件的 `auto-approve/events.jsonl` 里有 sessionId 字段——那是它的审计记录，不归我们删）、内容寻址的共享附件、别的会话日志/缓存里**提到**这个 id 的文本（例如子代理的提示词里写着父会话 id）。投影缓存**必须走域的表接口删**，不能直接删 json 文件：域在内存里持有一份，直接删文件会在下次写入时被写回来。

**id 两种拼写贯穿每一步**：找目录时两种拼写都会被删，所以 agent 查找、工作区/归档/置顶记账也必须两种都查——只查一种，用另一种拼写请求就能绕过闸门删掉活会话的目录（已修复的真实 bug）。响应里的 `detached` 等于记账是否真的被解除，不是恒真。

**「哪些会话活着」每次现查 store**，不在模块级别缓存：`ctx.on` 的监听随插件 fiber 卸载而注销，而 host 模块不会被重新 import（坑 ⑦），内核也不会在热重载时重放 `session/created`——缓存一份副本必然过期。

**DSH 没有「删除会话」这个公开 API。** 已在 `0.2.1-alpha.2` 复核过 `SessionStore`（即 `ctx.sessions`）的公开面：`create` / `prepare` / `enter` / `announce` / `flush` / `get` / `list` / `registerMessageProjection` / `fork`，**没有任何 `delete` / `remove`**；把已进入 store 的会话摘出去的唯一公开途径是 `enter(session)` 返回的那个 **detach disposer**，而 `detachEntered` 是 `private`。

**那个 disposer 只交给创建者，插件拿不到。** 它由 agent 工厂在 `AgentRegistry.create()` 时持有（类型文档原话：the disposer is a CAPABILITY）；`ctx.agents.get(id)` 只返回裸 `Agent`，`AgentHandle.dispose()` 才是唯一公开的拆除入口，而 handle 只给创建它的 consumer owner（网页端的 `sessionController`），它的公开方法里也没有 close / release，控制器里更没有空闲回收。所以**内存里那条 store 记录，本插件确实摘不掉**——到 `0.2.1-alpha.2` 仍然如此（`GET /turns` 也只对活动会话可读）。

**但磁盘不需要那个 API**（v1.2.0 的实测结论，见 VERIFY）：日志写句柄在 Windows 上带 `FILE_SHARE_DELETE`，删一个**正在写**的会话目录会成功；删完之后目录没有被写回来——期间它一直在追加事件，agent 结束、dispose 走完之后再查仍然不在。于是删除变成：

```
删磁盘目录（目标 + 后代）→ 确认删净 → 清工作区记账 → 清投影缓存
```

活会话不再被拒绝，只多做两件事：**先停 agent**，以及在结果里如实标注 `wasLive` / `liveDescendants`（内存里那条记录还在，进程退出才消失——这是本功能已知、且说清楚的残留）。

**界面那一侧靠「让开」补上最后一环**（学 `ui-workspace` 归档）：客户端用公开的 `sessions.retainInfo(id).retainedBy.mainView > 0` 判断被删的是不是当前正在看的会话，是就 `uiWorkspace.openSession(同工作区里另一个会话)`——它与归档内部那句 `clearMain()`（private）等价，**会连带重写持久化的「当前会话」**，所以重启后界面不会再打开一个已经删掉的会话。

**半删除现场的边界**：磁盘、工作区记账、投影缓存、界面（列表与当前视图）**四样必须一起消失**——只删磁盘不摘记账会留下「目录没了但会话还在列表里」，只删列表不动磁盘就是撒谎。内存里那条 store 记录是唯一例外，而且无害：它不再对应任何磁盘数据，也不再被任何界面打开，进程退出即消失。

**绝不假装删成功**：工作区那段可能没执行（没有注册表）或部分失败，这些都必须单独回报，不能合并成一个布尔。有一种常见写法是「无论如何都删下去」：把 `storageDomain` 的每一次失败都 `catch {}` 吞掉，于是 `projRemoved` / `workspaceRemoved` 为假时**分不清「本来就没有」和「清理抛错了」**——本仓库不采用这种写法。

**磁盘现状（已实测）**：`<DSH_HOME>/sessions/<slug>/<id>/session.v4.jsonl.zstd`，`<slug>` 是工作区路径的转义形式（例如 `--D--…-dsh-agent-control--`，非 ASCII 会被转义成 `~XXXX~`），且**同一个 slug 下裸 UUID 与 `session-<UUID>` 目录并存**。所以：`<slug>` 只靠遍历，id 两种拼写都要覆盖。

