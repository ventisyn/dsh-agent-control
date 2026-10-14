# VERIFY — 0.2.1-alpha.2-v1.3.0

> 这一版是**向后兼容的新功能**：把插件拆成四行，插件列表里可以**逐个组件单独开关**。
> 按 AGENTS.md 第 8 节：本文不写本机路径、profile 名、实例名与端口。

## 1. 改了什么

| 位置 | 改动 |
| --- | --- |
| host | 单一 `apply()` 拆成「一份共享接线 + 三个组件行」：`src/host-wiring.mjs` 是三个组件唯一的接线实现；`src/index.mjs` 瘦成 core（客户端 bundle 交付、启动清理、按行构建） |
| 行结构 | `cordis.patch.yml` 从一行变成四行：主行 `agent-control`（id / name **未改**）+ 组件行 `agent-control-session` / `-turn` / `-restart`；`package.json` 的 `exports` 增加 `./session` / `./turn` / `./restart` |
| client | 挂载时对三个组件各做一次**只读探针**，只给探到的组件注册槽位；`window.__dshAgentControl.features()` 暴露这次探测结果 |
| 新路由 | `GET /api/agent-control/session/status`、`GET /api/agent-control/turn/status`（只读探针）；热重启复用已有的 `GET /restart/status` |
| 配置回归修复 | `approval` 历史上写在主行，拆行后子行会拿不到 → 改为「自己那一行 > 调用方回退 > 进程内记下的主行配置」按优先级**取一份**；`agent-control-restart` 行也带上 `approval` |

**两条关键机制（读宿主实现得出，决定了整个设计的形状）**

1. **被禁用的行，loader 根本不调用它的 `apply`**（`cordis-plugin-loader` 的 `Entry.update` 在 `this.disabled` 时 dispose fiber 并返回）。所以「关掉组件」= 那段接线从未执行，而不是「装上了再关」。
2. 因此主入口**只在某个组件没有自己那一行时**才代装它（`hasOwnRow`）：行在 = 那一行是唯一负责人（开着它自己装，关掉谁都不装）；行不在（只有一行主行的旧配置）= 主入口全装，行为与从前一致。判据是**行存不存在**，不看它开没开。拿不到 loader 服务时按「没有那一行」处理（保守的一侧：查不到行的信息不该让功能消失），重复注册由进程内的**认领表**挡住。

## 2. 怎么测的

**离线**：22 个文件逐个 `node --check`；七个测试文件逐个直接跑（本机沙箱下 `node --test` 会因 spawn 走管道而假失败）。
**真机**：一次性备用实例（独立 `DSH_HOME`、独立 profile、独立端口，插件按 `link:` 指向工作副本），组件开关**全部用界面点击**操作（插件列表里那一行的开关），没有手工改配置。主实例全程只读。

## 3. 结论

### 3.1 四行都在，功能与从前一致 ✅

`--dump-config` 里出现四行（主行 + 三个组件行）；插件列表详情页显示「包含的组件 共 4 个 · 4 运行中」，每行一个开关。
三条探针都 `200 {ok:true,enabled:true}`；`GET /sessions` 正常；`GET /turns?sessionId=<不存在的 id>` 返回 `404 TARGET_NOT_FOUND`（语义正确：只有活动会话的事件流可读）。

### 3.2 关掉一个组件：那一行真的下线，别的组件不受影响 ✅（**界面点击**）

在插件列表里点掉「会话」那一行的开关 → 宿主把 profile 的 patch 写成 `- id: agent-control-session / disabled: true` → 重启实例后：

| 请求 | 结果 |
| --- | --- |
| `GET /api/agent-control/session/status` | **401**（落到宿主的鉴权 fallback；「不是 200」就是判据） |
| `GET /api/agent-control/sessions` | **401** |
| `GET /api/agent-control/turn/status` | **200** ← 别的组件不受影响（本次改动的核心） |
| `GET /api/agent-control/restart/status` | **200** |

界面侧（重新打开页面后）：`window.__dshAgentControl.features()` = `{"session":false,"turn":true,"restart":true}`；会话行「…」菜单的项只剩置顶 / 重命名 / 分叉 / 归档，**全页没有「删除会话」**；回复旁的垃圾桶按钮**仍在**（轮次组件还开着）。
开回来（同一次界面点击，`disabled: false`）→ 重启 → 三条探针全 200、菜单项回来、`features()` 全 true。

### 3.3 旧配置兼容：只有主行的 profile 一切照旧 ✅

另起一个**只 insert 主行**的 profile（没有三个组件行）：九条路由全部注册（三条探针 200；`/turns` 语义正确的 404；三条 POST-only 路由对 GET 回 405「只接受 POST」= 已注册），且 `restart/status` 报的 `approvalMode` 与主行 `config.approval` 一致（写 `auto` 就报 `auto`，写 `ask` 就报 `ask`）。
**对照四行配置**：主行与组件行都带 `approval` 时以组件行为准；组件行没写时回退主行——这条链由离线用例逐组合钉住（`test/features.test.mjs`）。

### 3.4 开着的时候功能仍然可用（回归）✅

- **删一轮（界面点击）**：垃圾桶 → 确认弹窗 → 勾选 → 删除 → `200 {turn:1,seq:34,alreadyDeleted:false}`；该轮从界面消失，`GET /turns` 返回 `[1]`。
- **删会话（界面点击）**：会话行「…」→「删除会话…」→ `200`；磁盘目录（两种拼写）、工作区记账、投影缓存（两种拼写）都无残留；唯一瞬态是 `archivedSessionIds` 里那条「为隐藏而加的归档标记」，**重启后由 `pruneOrphanArchives()` 清空**（与上一版一致）。
- **热重启**：两条入口各跑一次（页面 `POST /restart` 与设置页按钮），`bootId` / `pid` 都变了，`last.json.ok === true`，`spec.json` / `pending.json` 都已清掉；**重启后九条路由全在**，脚本直连 `POST /restart` 仍 401（可信校验没被拆行弄坏）。
  - 观察到一处时序细节（无害）：刚就绪的头几秒 `last.json` 是 `{ok:false,finishedAt:null}`——新进程先写自己那半（身份 + `resume`），辅助进程随后按同一个 `restartId` **合并**写结果，约 8–11 秒后才是 `ok:true`。这是既有的两写入者设计（`writeLastMerged` 只在 `restartId` 相同时合并），不是本轮引入的。

### 3.5 离线测试 ✅

七个文件逐个直跑：`restart` 54、`restart-helper` 22、`host` 81、`client` 71、`features` 14、`turn-delete` 25、`session-delete` 40 —— **合计 307 项全过、0 失败**（上一版 291）。
新增的 `test/features.test.mjs`（14 项）覆盖：三个子插件各自单独加载只注册自己的路由；主入口一次注册 9 条路由 + 1 个工具不重复；四行都在时仍不重复；某组件行存在（哪怕被关掉）时主入口让开；拿不到 loader 时按旧行为全装；`config.enabled: false` 零注册零订阅；探针只读且拒绝 POST；`cordis.patch.yml` 四行的 id / name 与 `exports` 对得上；`approval` 的四种来源组合。

### 3.6 本轮发现并修掉的配置回归 ✅

**症状**：拆行后热重启那一行读不到主行的 `approval`。用户在主行写 `approval: auto` 时，主入口因为「组件有自己那一行」而让开，那一行没有这个配置 → 静默回退 `ask`：**每次重启都多要一次审批，且不报错**。
**修法**：按优先级**取一份**配置（自己那一行 > 调用方给的回退 > 进程内记下的主行配置）。刻意不合并：`{...fallback, ...own}` 这类写法在「子行写了 `ask`、主行写着 `auto`」时会让主行的值活下来，等于子行上的开关被另一行的旧值盖掉。`cordis.patch.yml` 里 `agent-control-restart` 行补上 `config: approval: ask` 并写明与主行同义。

## 4. 仍然未验证（不要当成全部通过）

1. **关掉组件那一步的重启是冷启动**（沙箱里从宿主后台作业拉起的实例，其 detached 辅助进程会被作业一起收走，热重启在那种形态下起不来），不是辅助进程驱动的热重启。配置生效的判据相同，但严格说那一次不是热重启；**热重启路径本身**在组件全开的形态下单独跑过两次并成功。
2. 设置页按钮那次重启之后只复核了 `/restart/status` + `last.json` + 归档清理，**没有**再全刷一遍九条路由（全量复核是在另一次重启与冷启动之后做的）。
3. **没有**按第 9 节做「用会话 id 对 `$DSH_HOME` 全盘 grep」；删会话的取证止于目录 / 工作区记账 / 投影缓存三处 + 重启后的归档清理。
4. 界面证据以快照 / DOM 文本为准（截图随一次性实例一起清掉了）。
5. 备用实例的插件安装是**手工组装 + 目录联接**，不是 `dsh plugin add`（本机受限会话里包管理器的 store 锁不可配置）；这与上一轮记录一致。
6. **关闭实例**（`POST /shutdown`）本轮没有真跑；只验证了它所在组件被关掉时三条路由一起消失、开着时路由注册齐全。
7. 更细的粒度**做不到**：界面槽位在同一份客户端 bundle 里，所以「轮次删除按钮」与「会话删除按钮」只有组件级开关，没有各自独立的开关。

## 5. 发布前隐私检查

隐私检查：已过（0 处待办）。
