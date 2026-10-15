/**
 * dsh-agent-control — host 端「按组件接线」的唯一实现。
 *
 * 三个组件（会话删除 / 轮次删除 / 热重启与关闭）各自可以被单独开关：在插件列表里关掉某个组件，
 * 宿主会把 patch 里对应的那一行写成 `disabled: true`，而 loader 对禁用的行**根本不会调用它的
 * apply**（`cordis-plugin-loader` 的 `Entry.update` 在 `this.disabled` 时直接返回）。
 *
 * 因此：
 *   - 每个组件有一份可复用的接线函数（`applySessionFeature` / `applyTurnFeature` /
 *     `applyRestartFeature`），主入口与子插件行调用的是**同一份**实现，不存在两份会漂移的注册代码；
 *   - 主入口只在「那个组件没有自己那一行」时才代装（`hasOwnRow`），否则关掉子行不起作用：
 *     行在 = 那一行是唯一负责人（开着它自己装，关掉谁都不装）；
 *   - 认领表（`claimFeature`）挡住同一进程里的重复注册——`webServer.register` 对同一个
 *     `(kind, path)` 会抛错，工具也不该注册两次。
 *
 * 业务逻辑仍然在 `./session-delete.mjs` / `./turn-delete.mjs` / `./restart*.mjs` 里；
 * 本文件只做接线：路由、错误映射、依赖探测与降级。**不 import 任何 `@deepseek-ai/*`**
 * （host 端顶层 import 解析失败会让整个插件消失，见 AGENTS.md 3.7（细则 docs/CONTRACT.md 第 3 节））。
 *
 * 失败语义（全项目最重要的一条）：任何异常都收敛成「明确拒绝 + 说清原因」，
 * 绝不因为报错而假装删除成功，也绝不把内部故障说成「任务正在运行」。
 */
import os from 'node:os'
import path from 'node:path'

import {
  ControlError,
  ERROR_CODES,
  FEATURES,
  PATHS,
  PLUGIN_NAME,
  assertMessageId,
  assertSessionId,
  sessionDirNames,
  toControlError,
} from './shared.mjs'
import { assertRestartReason } from './restart.mjs'
import { DEFAULT_STOP_TIMEOUT_MS, deleteSession, listSessions } from './session-delete.mjs'
import { deleteTurn, deletedTurns } from './turn-delete.mjs'
import {
  DEFAULT_UI_REASON,
  SHUTDOWN_EXIT_DELAY_MS,
  buildRestartStatus,
  checkRestartTrust,
  createRestartState,
  isJsonRequest,
  registerRestartTool,
  requestRestart,
  requestShutdown,
  startResumeDelivery,
} from './restart-tool.mjs'

/** 请求体上限：删除请求很小，超过就是异常输入。 */
const MAX_BODY_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// 组件认领表与「自己那一行」
// ---------------------------------------------------------------------------

/**
 * 已经注册过的组件（进程内）。
 *
 * 为什么需要：同一个进程里可能有两个来源调用同一份接线——主入口为了兼容「只有一行
 * `agent-control` 的旧 profile」会把三个组件都装一遍，而各个子插件行各自装自己那一个。
 * `webServer.register` 对同一个 `(kind, path)` 会抛错，`tools.register` 也不该把同一份工具
 * 注册两次，所以这里做一道「先到先得」：后到的直接跳过。
 *
 * 认领**跟着 ctx 的 fiber 生命周期走**（`ctx.effect` 的清理里释放），所以热重载 / 关掉再打开
 * 之后重新 apply 还能注册回去——它不是「一个进程只准注册一次」的锁。
 *
 * ⚠️ 离线测试会反复用新的假 ctx apply（假 ctx 的 `effect` 从不 dispose），所以认领表提供
 * `resetFeatureClaimsForTest()`：生产代码永远不该调用它（与 restart-tool 的
 * `resetRestartRuntimeForTest` 同一个约定）。
 */
const featureClaims = new Set()

/**
 * 主行（`agent-control`）那一行的 `config`，由 `src/index.mjs` 在 apply 时记下。
 *
 * 为什么需要：`approval` 这个开关历史上写在主行上，组件拆行之后「热重启」有了自己那一行，而
 * profile 里的旧配置**仍然写在主行**。子行 apply 时拿不到兄弟行的 config，所以主行把它存这里当回退；
 * 子行自己写了 `approval` 就以子行为准（见 `restart-tool.mjs` 的 resolveApprovalMode）。
 * 只读、进程内、不落盘：一个进程只有一份 profile 配置。
 */
let coreRowConfig

/** 记下主行的 `config`（供没有自己配 `approval` 的组件行回退）。 */
export function rememberCoreRowConfig(config) {
  coreRowConfig = config
}

/**
 * 从几份候选配置里挑出**决定审批策略的那一份**（按优先级，先命中的赢）。
 *
 * 为什么是「挑一份」而不是合并：主行与子行都可能写着 `approval`，而它们的优先级不同——
 * 用户在拥有这个组件的那一行上写的才算数。合并（例如 `{...fallback, ...own}`）看似更宽容，实际会在
 * 「子行写了 ask、主行写着 auto」时让主行的值活下来，等于子行上的开关被另一行的旧配置盖掉。
 *
 * @param {...any} candidates - 按优先级排列的配置（自己那一行、调用方给的回退、主行）。
 * @returns {any} 第一个带 `approval` 的配置；都没有时返回第一个候选（`resolveApprovalMode` 回退缺省值）。
 */
function pickApprovalConfig(...candidates) {
  return candidates.find((candidate) => candidate?.approval !== undefined) ?? candidates[0]
}

/** 仅供离线测试：清空组件认领表。 */
export function resetFeatureClaimsForTest() {
  featureClaims.clear()
}

/**
 * 这一行的 `config.enabled` 是不是明确写成了 false。
 *
 * 缺省（没写 / undefined）= 启用；**只有明确的 `false` 才算关掉**——写成 `"false"` 这类笔误时
 * 宁可多装一个组件，也不要因为一个错别字让组件静默消失。
 *
 * @param {{ enabled?: unknown } | undefined} config - 插件行的 `config:`。
 * @returns {boolean} 明确关掉时为 true。
 */
export function featureDisabled(config) {
  return config?.enabled === false
}

/**
 * 这个组件有没有「自己那一行」（`dsh-agent-control/session` 等）。
 *
 * 为什么主入口必须知道这件事：插件列表右侧的开关会往 profile 的 patch 里写一条
 * `{ id, disabled: true }` 覆盖行，而 loader 对禁用的行**根本不会调用它的 apply**。主入口若无条件
 * 把三个组件全装上，关掉某个子行就完全不起作用——路由还在、界面也照样显示它的入口。
 *
 * 判据是 loader 里的**行存不存在**（不看它开没开）：行在 = 这一行是唯一负责人（开着：它自己装；
 * 关掉：谁都不装，于是路由消失、界面入口随之消失）；行不在（例如只有一行 `agent-control` 的旧
 * profile）= 主入口负责，行为与以前完全一致。
 *
 * 拿不到 loader 服务时返回 false（= 没有自己那一行，主入口照旧全装）：这是保守的一侧——查不到
 * 行的信息不该让全部功能消失；至于万一重复注册，由认领表挡住。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {'session' | 'turn' | 'restart'} feature - 组件名。
 * @returns {boolean} 有自己那一行时为 true。
 */
export function hasOwnRow(ctx, feature) {
  const loader = safeCall(() => ctx.get?.('loader'))
  if (loader === undefined || loader === null || typeof loader.entries !== 'function') return false
  const rows = safeCall(() => [...loader.entries()])
  if (!Array.isArray(rows)) return false
  const wanted = FEATURES[feature]?.plugin ?? `${PLUGIN_NAME}/${feature}`
  return rows.some((entry) => rowMatchesName(entry?.options?.name, wanted))
}

/** 行的模块名是不是这一行：`dsh-agent-control/session`（也认被套进别的前缀的写法）。 */
function rowMatchesName(name, wanted) {
  return typeof name === 'string' && (name === wanted || name.endsWith(`/${wanted}`))
}

/**
 * 认领一个组件：先到先得；已经被认领过就跳过这次注册。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {'session' | 'turn' | 'restart'} feature - 组件名。
 * @returns {boolean} 这次该由调用者注册时为 true。
 */
function claimFeature(ctx, feature) {
  if (featureClaims.has(feature)) {
    // 预期内的正常情况之一（另一个来源先装了），所以只在 debug / info 级别留一条线索：
    // 它不该让用户在日志里看到一个「警告」。
    logQuiet(ctx, `${PLUGIN_NAME}: 组件 ${feature} 已经注册过，跳过重复注册`)
    return false
  }
  featureClaims.add(feature)
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      featureClaims.delete(feature)
    }, `${PLUGIN_NAME}: claim ${feature}`)
  }
  return true
}

/** 记一条「不是故障」的日志：优先 debug，其次 info，两个都没有就静默。 */
function logQuiet(ctx, message) {
  const logger = safeCall(() => ctx?.logger)
  const write = typeof logger?.debug === 'function'
    ? logger.debug
    : (typeof logger?.info === 'function' ? logger.info : undefined)
  if (write === undefined) return
  safeCall(() => write.call(logger, message))
}

// ---------------------------------------------------------------------------
// 三个组件的接线
// ---------------------------------------------------------------------------

/**
 * 装「会话」组件：列会话 + 删会话（含幽灵清理）+ 自己的只读探针。
 *
 * 由主入口（这个组件没有自己那一行时）或 `src/session-plugin.mjs`（`agent-control-session` 行）调用。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {{ stopTimeoutMs?: number }} [host] - 副作用注入（离线测试把停 agent 的超时压小）。
 * @returns {void}
 */
export function applySessionFeature(ctx, host) {
  if (!claimFeature(ctx, 'session')) return
  registerRoute(ctx, 'GET', FEATURES.session.probe, () => handleFeatureStatus())
  registerRoute(ctx, 'GET', PATHS.sessions, (innerCtx) => handleListSessions(innerCtx))
  registerRoute(ctx, 'POST', PATHS.sessionDelete, (innerCtx, payload, url, req) => handleDeleteSession(
    innerCtx,
    payload,
    url,
    req,
    { stopTimeoutMs: host?.stopTimeoutMs },
  ))
}

/**
 * 装「轮次」组件：列已删轮次 + 删一轮 + 自己的只读探针。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {{ stopTimeoutMs?: number }} [host] - 副作用注入（当前未用，保持与另外两个组件一致的签名）。
 * @returns {void}
 */
export function applyTurnFeature(ctx, host) {
  if (!claimFeature(ctx, 'turn')) return
  registerRoute(ctx, 'GET', FEATURES.turn.probe, () => handleFeatureStatus())
  registerRoute(ctx, 'GET', PATHS.turns, (innerCtx, _payload, url) => handleListDeletedTurns(innerCtx, _payload, url))
  registerRoute(ctx, 'POST', PATHS.turnDelete, (innerCtx, payload, _url, req) => handleDeleteTurn(innerCtx, payload, _url, req))
}

/**
 * 装「热重启」组件：状态 / 重启 / 关闭三条路由 + `restart_harness` 工具 + 启动后的续作投递。
 *
 * ⚠️ `GET /restart/status` 同时是**辅助进程的就绪探针**，也是客户端判断「这个组件在不在」的探针
 * （它只读、不改变状态，见 AGENTS.md 3.5（细则 docs/CONTRACT.md 第 1 节））。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} [host] - 副作用注入（`schedule` / `spawn` / `appExit` / `deferExit` 等，离线测试用）。
 *   能决定审批策略的 `config` 放在 `host.config`；`host.fallbackConfig` 是低优先级的回退（主入口代装
 *   时给的是主行那一份），两者都没有时再用 `rememberCoreRowConfig` 记下的主行配置。
 * @returns {void}
 */
export function applyRestartFeature(ctx, host) {
  if (!claimFeature(ctx, 'restart')) return
  // 审批策略的来源按优先级挑**一个**：自己那一行的 `config` > 调用方给的 `fallbackConfig` >
  // 进程里记下的主行配置。绝不能把几份直接合并——合并会让「子行写了 ask、主行写着 auto」时
  // 主行的值把子行的选择盖掉（主行与子行**都**带 `approval` 是常态）。
  const config = pickApprovalConfig(host?.config, host?.fallbackConfig, coreRowConfig)
  // 重启现场的「快照 + 副作用」在这里读一次；两条路由与工具共用同一份（单飞锁、限频账本因此只有一份）。
  const restart = createRestartState(ctx, { ...host, config })
  registerRoute(ctx, 'GET', PATHS.restartStatus, (innerCtx) => handleRestartStatus(innerCtx, restart))
  registerRoute(ctx, 'POST', PATHS.restart, (innerCtx, payload, _url, req) => handleRestartRequest(
    innerCtx,
    restart,
    payload,
    req,
  ), '重启请求失败')
  // 关闭实例：**只有界面这一条入口**（刻意没有模型工具，见 AGENTS.md 3.4）。
  // 可信校验与 /restart 完全一致——它是同一类「让进程消失」的能力。
  registerRoute(ctx, 'POST', PATHS.shutdown, (innerCtx, _payload, _url, req) => handleShutdownRequest(
    innerCtx,
    restart,
    req,
  ), '关闭实例请求失败')
  // 模型入口。注册失败只在 restart-tool 内部记日志：界面入口必须照常可用。
  registerRestartTool(ctx, restart)
  // 新进程这一侧：应用就绪后消费上一次重启留下的待办，投递续作消息；顺带清掉含 env 的启动规格。
  startResumeDelivery(ctx, restart)
}

/**
 * 注册一条 HTTP 路由，并把 disposer 交给 `ctx.effect`。
 *
 * `register` 对重复 `(kind, path)` 会抛错，所以 disposer 必须真的返回出去（写成返回 `undefined`
 * 的箭头函数时注销就完全靠 fiber 卸载，重复 apply 会撞上，见 AGENTS.md 3.5（细则 docs/CONTRACT.md 第 1 节））。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {'GET' | 'POST'} method - 该路由接受的方法。
 * @param {string} routePath - 路由路径。
 * @param {Function} handler - 业务处理。
 * @param {string} [fallbackMessage] - 异常本身没有 message 时的兜底说明。
 * @returns {void}
 */
function registerRoute(ctx, method, routePath, handler, fallbackMessage) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: routePath,
    handler: wrap(ctx, method, handler, fallbackMessage),
  }), `${PLUGIN_NAME}: ${method} ${routePath}`)
}

/**
 * 组件的只读可用性探针。
 *
 * 客户端在挂载时各拉一次，拿到 `{ ok: true, enabled: true }` 才注册对应的界面入口；
 * 组件关掉时这条路由根本不存在（404 或落宿主的鉴权 fallback），客户端于是不注册入口。
 * **只读、无参数、不改状态、不做可信校验**（GET 只读路由本来就没有那道闸门，AGENTS.md 3.5，细则 docs/CONTRACT.md 第 1 节）。
 *
 * @returns {Promise<{ status: number, body: any }>} 响应。
 */
async function handleFeatureStatus() {
  return { status: 200, body: { ok: true, enabled: true } }
}

/**
 * 所有会改变状态的 POST 路由共用的两道闸门：先可信、后 JSON content-type。
 *
 * 自建路由不走 harness 的鉴权链路（AGENTS.md 3.5，细则 docs/CONTRACT.md 第 1 节），而 `<form enctype="text/plain">` 能让别的网页
 * 跨站发出一个「简单请求」——体里拼出 JSON、content-type 却是 text/plain。所以两道都要：
 *   1. 可信：宿主 `connection.requestRejection` 的结论优先（401 / 403 照抄），再用本插件自己的
 *      同源 Origin / 自定义头 `x-dsh-agent-control: 1` 规则兜底（宿主服务不可用时只剩这一道）；
 *   2. `content-type` 必须是 JSON（跨站表单发不出这个头，除非先过 CORS 预检）。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} req - node IncomingMessage（要读 headers）。
 * @param {string} deniedCode - 不可信时用的错误码（重启 / 关闭 / 删除各用各的，处置文案不同）。
 * @returns {void}
 * @throws {ControlError} 不可信（带宿主给的 401 / 403 状态）或不是 JSON 请求（400）时抛出。
 */
function assertTrustedJsonRequest(ctx, req, deniedCode) {
  const rejection = safeCall(() => ctx.get?.('connection')?.requestRejection?.({ headers: req?.headers }))
  const denied = checkRestartTrust(req?.headers, rejection)
  if (denied !== undefined) {
    throw new ControlError(
      deniedCode,
      denied === 401
        ? '这次请求没有通过宿主的鉴权（401）；请从已登录的界面发起，或重新登录后再试'
        : '这次请求没有通过可信校验（403）：需要一个同源的浏览器请求，或带上 x-dsh-agent-control: 1 头',
      { status: denied },
    )
  }
  if (!isJsonRequest(req?.headers)) {
    throw new ControlError(ERROR_CODES.invalidRequest, '只接受 content-type: application/json 的请求')
  }
}

/**
 * `GET /api/agent-control/restart/status`：重启现场与最近一次结果。
 *
 * **不做可信校验**：辅助进程要用它当就绪探针（普通 `fetch`，既没有 Origin 也没有自定义头），
 * 加校验会让重启永远「确认不了就绪」。它只读，不改任何状态；`POST /restart` 才是那道必须守的门。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} restart - `createRestartState` 的结果。
 * @returns {Promise<{ status: number, body: any }>} 响应。
 */
async function handleRestartStatus(ctx, restart) {
  return { status: 200, body: buildRestartStatus(ctx, restart) }
}

/**
 * `POST /api/agent-control/restart`：用户从设置页发起重启。
 *
 * 三重输入校验，缺一不可：
 *   1. 可信：先问宿主的 `connection.requestRejection`，再用本插件自己的同源/自定义头规则兜底
 *      （自建路由不走 harness 鉴权链路，AGENTS.md 3.5，细则 docs/CONTRACT.md 第 1 节）；
 *   2. `content-type` 必须是 JSON（跨站表单能发简单请求，但发不出这个头）；
 *   3. `reason` 走 `assertRestartReason`（界面可以不写，缺省用一句默认中文），`force` 只认 `true`。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} restart - `createRestartState` 的结果。
 * @param {any} payload - 请求体。
 * @param {any} req - node IncomingMessage（要读 headers）。
 * @returns {Promise<{ status: number, body: any }>} 响应（202 = 已安排，不是「已经重启完成」）。
 * @throws {ControlError} 拒绝时抛出，由 wrap 映射成 HTTP。
 */
async function handleRestartRequest(ctx, restart, payload, req) {
  assertTrustedJsonRequest(ctx, req, ERROR_CODES.restartDenied)
  const rawReason = payload?.reason
  const reason = rawReason === undefined || rawReason === null || (typeof rawReason === 'string' && rawReason.trim() === '')
    ? DEFAULT_UI_REASON
    : assertRestartReason(rawReason)
  const result = await requestRestart(ctx, restart, {
    source: 'ui',
    reason,
    // 只有明确的 true 才算「仍然重启」：字符串 "true"、1 之类一律当没勾选，不替用户下这个决定。
    force: payload?.force === true,
  })
  return { status: 202, body: { ok: true, restartId: result.restartId } }
}

/**
 * `POST /api/agent-control/shutdown`：用户从界面关闭这个实例。
 *
 * 闸门与 `/restart` 完全一致：先问宿主的 `connection.requestRejection`，再用本插件自己的
 * 同源/自定义头规则兜底，然后要求 `content-type: application/json`。请求体不要求任何字段
 * （空体与 `{}` 都算数）——「关掉这个实例」不需要参数，界面点一下就是全部意图。
 *
 * ⚠️ **顺序是硬要求：先把 202 发出去，再请求退出。** `ctx.appExit(0)` 会 dispose 整棵树，
 * webServer 的 dispose 里有 `server.closeAllConnections()`；先退出的话这条 202 会被当场掐断，
 * 浏览器只看到网络错误，而客户端正是靠这个 202 才敢进「正在关闭」状态（掐断了就显示成「关不掉」）。
 * 所以 `requestShutdown` 只判定 + 标记，真正的退出排到响应之后的下一拍。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} restart - `createRestartState` 的结果。
 * @param {any} req - node IncomingMessage（要读 headers）。
 * @returns {Promise<{ status: number, body: any }>} 202 = 已经接受这次关闭（不是「已经关掉了」）。
 * @throws {ControlError} 拒绝时抛出，由 wrap 映射成 HTTP（403 / 409 / 501）。
 */
async function handleShutdownRequest(ctx, restart, req) {
  assertTrustedJsonRequest(ctx, req, ERROR_CODES.shutdownDenied)
  const result = await requestShutdown(ctx, restart)
  // 兜底：deps 一定带 deferExit（createRestartState 会给），这里再查一次是为了绝不出现
  // 「标记成关闭中、却没人去请求退出」——那才是真的假装关掉了。
  const deferExit = typeof restart?.deferExit === 'function'
    ? restart.deferExit
    : (fn) => {
      setTimeout(fn, SHUTDOWN_EXIT_DELAY_MS)
    }
  deferExit(() => {
    // `exit` 现在是异步的（先尽力 flush 已记录的事件，再请求退出）；它仍然只 reject 一种情况：
    // 宿主拒绝退出（`SHUTDOWN_FAILED`）。这里必须接住——unhandled rejection 会让「关不掉」变成
    // 一个连日志都没有的静默失败。
    try {
      Promise.resolve(result.exit()).catch((error) => {
        // 响应已经发出去了，改不了它（也绝不再回一个「已经关掉」）：**如实记错误日志**。
        // 标记已由 exit 自己复原，用户可以再点一次，或改从启动器/终端停止。
        const control = toControlError(error, '关闭实例失败')
        ctx.logger?.error?.(`${PLUGIN_NAME}: ${control.message}`)
      })
    } catch (error) {
      // `exit` 同步抛出（理论上不该发生，它已经是 async 函数）——同样不能吞。
      const control = toControlError(error, '关闭实例失败')
      ctx.logger?.error?.(`${PLUGIN_NAME}: ${control.message}`)
    }
  })
  return { status: 202, body: { ok: true } }
}

/**
 * `GET /api/agent-control/turns?sessionId=`：这个会话里已经被删掉的轮次。
 *
 * 界面读的是 append-only 日志，被删的轮次仍然在里面，所以要靠墓碑把那一轮藏起来。
 *
 * ⚠️ 「持久」与「可读」是两件事（实测见 docs/VERIFY-*.md 第 10 节）：删除事务确实持久，
 * 但这里读的是**活动会话**的事件流，所以重启后**没被打开过**的会话会返回 TARGET_NOT_FOUND，
 * 与「本来就没有删除记录」在错误码上无法区分；打开会话之后答案与重启前逐字一致。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} _payload - 未使用（GET）。
 * @param {URL} url - 请求 URL（带上查询串）。
 * @returns {Promise<{ status: number, body: any }>} 响应。
 */
async function handleListDeletedTurns(ctx, _payload, url) {
  const sessionId = assertSessionId(url?.searchParams?.get('sessionId'))
  const session = findLiveSession(ctx.get?.('sessions'), sessionId)
  if (session === undefined) {
    throw new ControlError(
      ERROR_CODES.targetNotFound,
      `会话 ${sessionId} 不在活动状态，读不到它的轮次（只有活动会话的事件流可读）`,
    )
  }
  const events = safeCall(() => session.snapshotEvents()) ?? []
  // 新旧两种删除记录都认：删除事务（compaction/summary + 自有标记）与 v1.0.0 的旧墓碑。
  const turns = deletedTurns(events)
  return { status: 200, body: { ok: true, sessionId, turns } }
}

/**
 * `GET /api/agent-control/sessions`：列出可管理的会话。
 *
 * @param {any} ctx - cordis 上下文。
 * @returns {Promise<{ status: number, body: any }>} 响应。
 */
async function handleListSessions(ctx) {
  const sessions = ctx.get?.('sessions')
  const liveIds = new Set()
  for (const session of safeCall(() => sessions?.list()) ?? []) {
    if (typeof session?.id === 'string') liveIds.add(session.id)
  }
  const rows = listSessions({
    sessionsRoot: sessionsRoot(),
    workspaceRegistry: ctx.get?.('workspaceRegistry'),
    liveSessionIds: liveIds,
  }).map((row) => ({
    ...row,
    // 运行中的会话先停再删；这里只如实标注状态，不替用户做判断。
    running: isRunning(ctx, row.sessionId),
  }))
  return { status: 200, body: { ok: true, sessions: rows } }
}

/**
 * `POST /api/agent-control/session/delete`：删除一个会话。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} payload - 请求体。
 * @param {URL} _url - 未使用。
 * @param {any} req - node IncomingMessage（要读 headers 做可信校验）。
 * @param {{ stopTimeoutMs?: number }} [options] - 可选注入（离线测试把停 agent 的超时压小）；缺省取默认值。
 * @returns {Promise<{ status: number, body: any }>} 响应。
 * @throws {ControlError} 校验或删除失败时抛出，由 wrap 映射成 HTTP。
 */
async function handleDeleteSession(ctx, payload, _url, req, options = {}) {
  // 破坏性、不可撤销：先过与 /restart 同口径的两道闸门，再看参数。
  assertTrustedJsonRequest(ctx, req, ERROR_CODES.requestDenied)
  const sessionId = assertSessionId(payload?.sessionId)
  const sessions = ctx.get?.('sessions')
  // 两种拼写都要查：磁盘上找目录时 `session-<id>` 与 `<id>` 都会被删。
  // v1.2.0 起这个判断**不再用来拒绝活会话**（删除对活会话同样执行，先停 agent 再删目录），
  // 只用来在结果里如实标注 `wasLive` / `liveDescendants`；所以传判断函数而不是一个布尔。
  const isLive = (id) => findLiveSession(sessions, id) !== undefined
  const warnings = []
  // 目标「本次启动后打开过」时，宿主的会话列表会一直列着它（内存里那条记录插件摘不掉），删完之后它会以
  // 「不属于任何工作区」的身份挂回侧栏。公开的 `archiveSession` 是宿主自己的「从列表里藏起来」能力，
  // 先借它把那行藏起来——**顺序必须是「先归档、再删」**：真机实测删完再归档会被宿主拒绝，
  // 报 `live sessions and session persistence hold no such session`（那时会话已经不存在了）。
  const hiding = isLive(sessionId)
    ? await archiveForHiding(ctx, sessionId, warnings)
    : { hidden: false, ownMark: false, name: undefined }
  let result
  try {
    result = await deleteSession({
      sessionsRoot: sessionsRoot(),
      agents: ctx.get?.('agents'),
      isLive,
      workspaceRegistry: ctx.get?.('workspaceRegistry'),
      projectionCache: projectionCacheTable(ctx),
      stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      keepArchived: hiding.hidden,
    }, sessionId)
  } catch (error) {
    // 删除没成功，那一藏就不该留下：否则接口报失败、会话却已经从侧栏消失了。
    // 回滚自己加的那条标记；它绝不能盖掉这里要继续抛出的原错误（rollbackHidingArchive 不会抛）。
    if (hiding.ownMark) await rollbackHidingArchive(ctx, sessionId, hiding.name)
    throw error
  }
  warnings.push(...result.warnings, ...result.workspace.warnings)
  if (!result.workspace.available) {
    warnings.push('这个部署没有工作区注册表，工作区记账那一段没有执行')
  }
  warnings.push(...result.workspace.failures)
  // 通知宿主的界面表面「这些会话没了」。宿主的会话索引仍然握有内存里那条记录（本插件摘不掉），
  // 而列表里「不在任何工作区」的会话会被摆进侧栏的「未分组」——真机实测：删掉的会话就那样挂在
  // 未分组里。`api-session/removed` 是宿主自己的公开事件（`dsh-api-remotes` 的 remote-events 里
  // 登记过，签名 `(sessionId: SessionId)`；宿主在 `session/disposed` 时发的就是它），客户端收到就会
  // 把这一行从会话列表里摘掉。发不出去不影响删除本身，所以只降级成 warning。
  for (const id of [result.sessionId, ...result.descendants]) {
    const sent = safeCall(() => {
      ctx.emit('api-session/removed', id)
      return true
    })
    if (sent !== true) warnings.push(`没能通知界面「${id} 已删除」（宿主没有 emit 能力），侧栏可能要刷新之后才会少掉它`)
  }
  return { status: 200, body: { ok: true, ...result, warnings } }
}

/**
 * 把一个「本次启动后打开过」的会话从侧栏藏起来（删除路由在动手**之前**调它）。
 *
 * 宿主的会话列表把「内存里还活着」的会话也算进去，而插件没有公开 API 能把那条记录摘掉——删完之后它会以
 * 「不属于任何工作区」的身份挂回侧栏（真机实测：掉进「未分组」，而且下一次列表拉取就回来）。公开的
 * `archiveSession` 正是宿主自己的「从列表里藏起来」能力（归档行默认不显示，状态会立刻推给界面）。
 *
 * **这不是用归档代替删除**：磁盘、工作区记账、投影缓存随后都会真的删掉；重启之后那条内存记录不复存在，
 * 这条归档标记只剩一条指向已删会话的孤儿（宿主的列表里已经没有它）。失败只降级成 warning。
 *
 * **删除失败时要把这一藏撤回**（见 `rollbackHidingArchive`），但只撤「自己加的」那一条：所以这里要先记下
 * 调用前它是不是已经在归档集合里（用户原本就归档过的会话，回滚时绝不能替用户解除）。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {string} sessionId - 目标会话。
 * @param {string[]} warnings - 收集降级说明。
 * @returns {Promise<{ hidden: boolean, ownMark: boolean, name: string | undefined }>} `hidden`：成功标记为归档
 *   （调用方据此保留这条标记）；`ownMark`：这条标记是本次调用加的（调用前不在归档集合里）——只有它才允许回滚；
 *   `name`：归档成功的那种 id 拼写（回滚时先试它）。
 */
async function archiveForHiding(ctx, sessionId, warnings) {
  const registry = safeCall(() => ctx.get?.('workspaceRegistry'))
  if (registry === undefined || registry === null || typeof registry.archiveSession !== 'function') {
    warnings.push(`没能把 ${sessionId} 从侧栏隐藏起来（宿主没有归档能力），它可能留到下次重启`)
    return { hidden: false, ownMark: false, name: undefined }
  }
  // 必须在归档**之前**读：两种拼写任一已在集合里，就说明是用户原本的归档，不是我们加的。
  const alreadyArchived = Array.isArray(registry.archivedSessionIds)
    && sessionDirNames(sessionId).some((name) => registry.archivedSessionIds.includes(name))
  // ⚠️ **两种拼写都要试**：宿主的归档先按存储里的规范 id 找会话（`sessionKnown`：先查 store、再查头部
  // 索引），拿不匹配的那一种去问会被直接拒绝——真机上就是这么报的：
  // `cannot archive session '…': live sessions and session persistence hold no such session`。
  const failures = []
  for (const name of sessionDirNames(sessionId)) {
    try {
      await registry.archiveSession(name, { stopActivity: true })
      return { hidden: true, ownMark: !alreadyArchived, name }
    } catch (error) {
      failures.push(`${name}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  warnings.push(`没能把 ${sessionId} 从侧栏隐藏起来（归档失败：${failures.join('；')}），它可能留到下次重启`)
  return { hidden: false, ownMark: false, name: undefined }
}

/**
 * 删除失败后，撤回 `archiveForHiding` 加的那条归档标记。
 *
 * 先试归档成功的那种拼写，再试另一种，**逐个尝试到成功为止**；失败只记 logger warn。
 * 这个函数**永不抛出**：它在 catch 块里调用，绝不能让回滚自己的错误盖掉原本要抛的那个删除错误。
 *
 * ⚠️ **撤不回来的部分**：`archiveSession(name, { stopActivity: true })` 已经把那个会话的 agent 停掉了，
 * 取消归档只是让它重新出现在列表里，**不会让 agent 活过来**。这是这条路径固有的代价，不假装能撤销。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {string} sessionId - 目标会话。
 * @param {string | undefined} archivedName - 归档成功的那种拼写（先试它）。
 * @returns {Promise<boolean>} 是否撤回成功（调用方一般不用看，仅供测试与排障）。
 */
async function rollbackHidingArchive(ctx, sessionId, archivedName) {
  const registry = safeCall(() => ctx.get?.('workspaceRegistry'))
  const warn = (message) => safeCall(() => ctx.logger?.warn?.(`${PLUGIN_NAME}: ${message}`))
  if (registry === undefined || registry === null || typeof registry.unarchiveSession !== 'function') {
    warn(`删除 ${sessionId} 失败，但宿主没有取消归档的能力，那条为隐藏而加的归档标记没有撤回`)
    return false
  }
  const names = [...new Set([archivedName, ...sessionDirNames(sessionId)].filter((name) => typeof name === 'string'))]
  const failures = []
  for (const name of names) {
    try {
      await registry.unarchiveSession(name)
      return true
    } catch (error) {
      failures.push(`${name}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  warn(`删除 ${sessionId} 失败，撤回隐藏用的归档标记也失败了（${failures.join('；')}），它可能一直藏着直到下次重启`)
  return false
}

/**
 * `POST /api/agent-control/turn/delete`：从模型可见面上删掉一轮。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} payload - 请求体。
 * @param {URL} _url - 未使用。
 * @param {any} req - node IncomingMessage（要读 headers 做可信校验）。
 * @returns {Promise<{ status: number, body: any }>} 响应。
 * @throws {ControlError} 校验或删除失败时抛出，由 wrap 映射成 HTTP。
 */
async function handleDeleteTurn(ctx, payload, _url, req) {
  assertTrustedJsonRequest(ctx, req, ERROR_CODES.requestDenied)
  const sessionId = assertSessionId(payload?.sessionId)
  const assistantMessageId = assertMessageId(payload?.assistantMessageId)
  const sessions = ctx.get?.('sessions')
  const session = findLiveSession(sessions, sessionId)
  if (session === undefined) {
    throw new ControlError(
      ERROR_CODES.targetNotFound,
      `会话 ${sessionId} 不在活动状态，无法删除其中的轮次（只有活动会话的事件流可读）`,
    )
  }
  const result = await deleteTurn({
    session,
    assistantMessageId,
    flush: typeof sessions.flush === 'function'
      ? (target) => sessions.flush(target)
      : undefined,
    // 维护租约：与内核手动压缩一样，只在 agent 空闲时写，并压住之后到来的输入。
    agent: findAgent(ctx, session.id ?? sessionId),
    estimateTokens: (target, seqs) => shadowedTokens(ctx, target, seqs),
  })
  return {
    status: 200,
    body: {
      ok: true,
      sessionId,
      assistantMessageId,
      turn: result.turn,
      seq: result.seq,
      alreadyDeleted: result.alreadyDeleted === true,
    },
  }
}

/**
 * 把 handler 包成 webServer 需要的 `(req, res) => void`，并统一错误映射。
 *
 * 方法不符 → 405（带 allow 头）；JSON 解析失败或字段非法 → 400；
 * 其余按错误码映射，未知一律 500 且保留原始信息。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {'GET' | 'POST'} method - 该路由接受的方法（显式传入，不靠函数身份猜）。
 * @param {(ctx: any, payload: any, url: URL, req: any) => Promise<{ status: number, body: any }>} handler - 业务处理（第四个参数是原始请求，需要读 headers 的路由用）。
 * @param {string} [fallbackMessage] - 异常本身没有 message 时的兜底说明（缺省沿用删除类的文案）。
 * @returns {(req: any, res: any) => Promise<void>} 路由处理器。
 */
function wrap(ctx, method, handler, fallbackMessage = '删除失败') {
  return async (req, res) => {
    try {
      if (req.method !== method) {
        res.writeHead(405, { allow: method, 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: { code: ERROR_CODES.invalidRequest, message: `只接受 ${method}` } }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      let payload = {}
      if (method === 'POST') {
        const raw = await readBody(req)
        if (raw !== '') {
          try {
            payload = JSON.parse(raw)
          } catch {
            // 必须是 ControlError：toControlError 只认它，带 code 的普通 Error 会被归成
            // DELETE_FAILED / 500，还会当成内部故障写进 error 日志。
            throw new ControlError(ERROR_CODES.invalidRequest, '请求体不是合法 JSON')
          }
        }
      }
      const result = await handler(ctx, payload, url, req)
      sendJson(res, result.status, result.body)
    } catch (error) {
      const control = toControlError(error, fallbackMessage)
      if (control.code === ERROR_CODES.deleteFailed) {
        // 内部故障：原样记日志，绝不改写成「任务正在运行」。
        ctx.logger?.error?.(`${PLUGIN_NAME}: ${control.message}`)
      }
      sendJson(res, control.status, {
        ok: false,
        error: { code: control.code, message: control.message, ...(control.detail ?? {}) },
      })
    }
  }
}

/**
 * 读请求体，超过上限直接拒绝（不是悄悄截断）。
 *
 * @param {any} req - node IncomingMessage。
 * @returns {Promise<string>} 请求体文本。
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new ControlError(ERROR_CODES.invalidRequest, `请求体超过 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 回响应。永远是 JSON，且不缓存。
 *
 * @param {any} res - node ServerResponse。
 * @param {number} status - HTTP 状态。
 * @param {any} body - 可序列化的响应体。
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * 会话日志的根目录：`$DSH_HOME/sessions`。
 *
 * `DSH_HOME` 未设置时回退到 `~/.dsh`（与 harness 自身的约定一致）。
 *
 * @returns {string} 目录绝对路径。
 */
export function sessionsRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/** 会话当前是否在跑（用于界面提示，不用于替用户决定）。两种拼写都查。 */
function isRunning(ctx, sessionId) {
  const agents = ctx.get?.('agents')
  return sessionDirNames(sessionId).some((id) => safeCall(() => agents?.get(id))?.status === 'running')
}

/** 按两种拼写找 agent。 */
function findAgent(ctx, sessionId) {
  const agents = ctx.get?.('agents')
  for (const id of sessionDirNames(sessionId)) {
    const agent = safeCall(() => agents?.get(id))
    if (agent !== undefined && agent !== null) return agent
  }
  return undefined
}

/**
 * 被遮蔽节点的 token 影子价格，口径与内核压缩一致：`ctx.tokenMeter.measure(session).nodes`
 * 里对应节点的 `heuristicTokens` 之和。拿不到计量服务时返回 undefined，由删除流程退回粗估。
 */
function shadowedTokens(ctx, session, seqs) {
  const nodes = safeCall(() => ctx.get?.('tokenMeter')?.measure(session)?.nodes)
  if (!Array.isArray(nodes)) return undefined
  const wanted = new Set(seqs)
  let total = 0
  let found = 0
  for (const node of nodes) {
    if (!wanted.has(node?.seq)) continue
    if (!Number.isFinite(node.heuristicTokens)) return undefined
    total += node.heuristicTokens
    found += 1
  }
  return found === wanted.size ? Math.max(0, Math.round(total)) : undefined
}

/**
 * 投影缓存域（`session_projcache`）的 `sessions` 表。
 *
 * 域由 `dsh-session-projection-cache` 打开，插件只能按名字取已打开的域（`ctx.storageDomain.get`），
 * 再用公开的 `KvTable.delete` 删记录——它同时更新内存表与磁盘文档。拿不到就返回 undefined，
 * 由删除流程如实回报「缓存没清」，而不是自己去删 json 文件（内存里那份会在下次写入时把它写回来）。
 *
 * @param {any} ctx - cordis 上下文。
 * @returns {{ delete(key: string): Promise<boolean> } | undefined} 表句柄。
 */
function projectionCacheTable(ctx) {
  return safeCall(() => ctx.get?.('storageDomain')?.get?.('session_projcache')?.table?.('sessions'))
}

/**
 * 按两种拼写找活会话。
 *
 * @param {any} sessions - `ctx.sessions`。
 * @param {string} sessionId - 会话 id（任一拼写）。
 * @returns {any} 命中的活会话；都不在时 undefined。
 */
function findLiveSession(sessions, sessionId) {
  for (const id of sessionDirNames(sessionId)) {
    const session = safeCall(() => sessions?.get(id))
    if (session !== undefined && session !== null) return session
  }
  return undefined
}

/** 调一个可能不存在的服务方法，失败一律当作「拿不到」。 */
function safeCall(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}
