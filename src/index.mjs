/**
 * dsh-agent-control — host 端插件。
 *
 * 把「删掉一个会话」和「删掉一轮对话」两件破坏性操作收进一个插件，用同一套
 * 确认与失败语义管理。业务逻辑在 `./session-delete.mjs` 与 `./turn-delete.mjs`
 * （纯逻辑，可离线单测）；本文件只做接线：生命周期、路由、依赖注入、错误映射。
 *
 * 失败语义（全项目最重要的一条）：任何异常都收敛成「明确拒绝 + 说清原因」，
 * 绝不因为报错而假装删除成功，也绝不把内部故障说成「任务正在运行」。
 */
import os from 'node:os'
import path from 'node:path'

import {
  API_PREFIX,
  ControlError,
  ERROR_CODES,
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

/** 插件名（cordis 行 id / loader id 都用它）。 */
export const name = PLUGIN_NAME

/**
 * 依赖声明。
 *
 * 只有 `webServer` 是硬的：没有它就等于没法把能力给到界面。其余服务按可用性探测，
 * 缺失时对应那一段能力降级为「未执行」并如实回报，而不是让整个插件起不来
 * （terminal-only profile 里本来就没有 workspaceRegistry）。
 *
 * 名字不叫 `inject`：客户端 bundle 也导出 `inject`，同名容易在排查时张冠李戴。
 */
export const hostInject = ['webServer']

/** 兼容 cordis 的约定名（插件工厂按 `inject` 读取）。 */
export const inject = hostInject

/** 请求体上限：删除请求很小，超过就是异常输入。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 插件入口：注册路由与热重启工具。
 *
 * **不在模块级别缓存「哪些会话活着」**，每次请求都现查 `ctx.sessions.list()` / `get()`。
 * 早期版本用一个模块级集合加 `session/created` / `session/disposed` 订阅来记账，并且
 * 只在第一次 apply 时订阅——可 `ctx.on` 的监听会随插件 fiber 卸载而注销，而 host 模块
 * 不会被重新 import（AGENTS.md 坑 ⑦），于是重新 apply 之后再也收不到事件，集合里
 * 留着早已关掉的会话，界面一直报「还在活动状态」、删不掉。内核自己的注释也写明
 * 热重载不会重放 `session/created`。store 本身就是权威来源，没有理由再存一份副本。
 *
 * 也刻意不保存任何 disposer：把已进入 store 的会话摘出去，唯一公开途径是
 * `sessions.enter()` 返回的 detach disposer，而它只交给创建者（agent 工厂）。
 * 插件**拿不到**它，`detachEntered` 又是 private，所以本插件**拒绝删除活会话**
 * （见 session-delete.mjs）。
 *
 * 热重启与关闭实例那部分的护栏、状态与日志都在 `./restart-tool.mjs` 里：这里只做接线——那部分的
 * 三条路由（状态 / 重启 / 关闭）、工具注册、启动后的「续作投递」。重启有两条入口（模型工具、
 * 界面按钮），共用同一个 `requestRestart`；关闭**刻意只有界面一条入口**（让所有会话一起死、
 * 又不会自动恢复的操作不该由模型发起，AGENTS.md 第 6 节）。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {{ approval?: unknown }} [config] - 插件行的 `config:`（cordis 把 `cordis.patch.yml` 里那一行
 *   的 `config:` 作为第二个参数传进来）。只认 `approval: 'ask' | 'auto'`，未知值一律回退 `ask`
 *   （host 不 import schemastery，手工校验，见 restart-tool.mjs 的 `resolveApprovalMode`）。
 * @param {{ now?: () => number, schedule?: (fn: () => void) => void, spawn?: Function, appExit?: Function, deferExit?: (fn: () => void) => void, dshHome?: string }} [host] -
 *   **副作用实现**，供离线测试注入。cordis 只传前两个参数，所以生产路径上这里是 `undefined`，
 *   重启用的是真实实现（`setTimeout` / `child_process.spawn` / `ctx.appExit`），关闭用的是
 *   300 ms 的延迟 `setTimeout`。测试必须注入，否则会真的派生辅助进程并退出测试进程。
 * @returns {void}
 */
export function apply(ctx, config, host) {
  // 重启现场的「快照 + 副作用」在这里读一次；两条路由与工具共用同一份（单飞锁、限频账本因此只有一份）。
  const restart = createRestartState(ctx, { ...host, config })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PATHS.sessions,
    handler: wrap(ctx, 'GET', handleListSessions),
  }), `${PLUGIN_NAME}: GET ${PATHS.sessions}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PATHS.sessionDelete,
    handler: wrap(ctx, 'POST', handleDeleteSession),
  }), `${PLUGIN_NAME}: POST ${PATHS.sessionDelete}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PATHS.turns,
    handler: wrap(ctx, 'GET', handleListDeletedTurns),
  }), `${PLUGIN_NAME}: GET ${PATHS.turns}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PATHS.turnDelete,
    handler: wrap(ctx, 'POST', handleDeleteTurn),
  }), `${PLUGIN_NAME}: POST ${PATHS.turnDelete}`)

  // 热重启：状态（新进程的就绪探针也是它）+ 发起。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PATHS.restartStatus,
    handler: wrap(ctx, 'GET', (innerCtx) => handleRestartStatus(innerCtx, restart)),
  }), `${PLUGIN_NAME}: GET ${PATHS.restartStatus}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PATHS.restart,
    handler: wrap(ctx, 'POST', (innerCtx, payload, _url, req) => handleRestartRequest(innerCtx, restart, payload, req), '重启请求失败'),
  }), `${PLUGIN_NAME}: POST ${PATHS.restart}`)

  // 关闭实例：**只有界面这一条入口**（刻意没有模型工具，见 AGENTS.md 第 6 节）。
  // 可信校验与 /restart 完全一致——它是同一类「让进程消失」的能力。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PATHS.shutdown,
    handler: wrap(ctx, 'POST', (innerCtx, _payload, _url, req) => handleShutdownRequest(innerCtx, restart, req), '关闭实例请求失败'),
  }), `${PLUGIN_NAME}: POST ${PATHS.shutdown}`)

  // 模型入口。注册失败只在 restart-tool 内部记日志：界面入口必须照常可用。
  registerRestartTool(ctx, restart)
  // 新进程这一侧：应用就绪后消费上一次重启留下的待办，投递续作消息；顺带清掉含 env 的启动规格。
  startResumeDelivery(ctx, restart)
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
 *      （自建路由不走 harness 鉴权链路，AGENTS.md 3.5）；
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
  const rejection = safeCall(() => ctx.get?.('connection')?.requestRejection?.({ headers: req?.headers }))
  const denied = checkRestartTrust(req?.headers, rejection)
  if (denied !== undefined) {
    throw new ControlError(
      ERROR_CODES.restartDenied,
      denied === 401
        ? '这次请求没有通过宿主的鉴权（401）；请从已登录的界面发起，或重新登录后再试'
        : '这次请求没有通过可信校验（403）：需要一个同源的浏览器请求，或带上 x-dsh-agent-control: 1 头',
      { status: denied },
    )
  }
  if (!isJsonRequest(req?.headers)) {
    throw new ControlError(ERROR_CODES.invalidRequest, '只接受 content-type: application/json 的请求')
  }
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
  const rejection = safeCall(() => ctx.get?.('connection')?.requestRejection?.({ headers: req?.headers }))
  const denied = checkRestartTrust(req?.headers, rejection)
  if (denied !== undefined) {
    throw new ControlError(
      ERROR_CODES.shutdownDenied,
      denied === 401
        ? '这次请求没有通过宿主的鉴权（401）；请从已登录的界面发起，或重新登录后再试'
        : '这次请求没有通过可信校验（403）：需要一个同源的浏览器请求，或带上 x-dsh-agent-control: 1 头',
      { status: denied },
    )
  }
  if (!isJsonRequest(req?.headers)) {
    throw new ControlError(ERROR_CODES.invalidRequest, '只接受 content-type: application/json 的请求')
  }
  const result = await requestShutdown(ctx, restart)
  // 兜底：deps 一定带 deferExit（createRestartState 会给），这里再查一次是为了绝不出现
  // 「标记成关闭中、却没人去请求退出」——那才是真的假装关掉了。
  const deferExit = typeof restart?.deferExit === 'function'
    ? restart.deferExit
    : (fn) => {
      setTimeout(fn, SHUTDOWN_EXIT_DELAY_MS)
    }
  deferExit(() => {
    try {
      result.exit()
    } catch (error) {
      // 响应已经发出去了，改不了它（也绝不再回一个「已经关掉」）：**如实记错误日志**。
      // 标记已由 exit 自己复原，用户可以再点一次，或改从启动器/终端停止。
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
 * @returns {Promise<{ status: number, body: any }>} 响应。
 * @throws {ControlError} 校验或删除失败时抛出，由 wrap 映射成 HTTP。
 */
async function handleDeleteSession(ctx, payload) {
  const sessionId = assertSessionId(payload?.sessionId)
  const sessions = ctx.get?.('sessions')
  // ⚠️ 两种拼写都要查：磁盘上找目录时 `session-<id>` 与 `<id>` 都会被删，
  // 闸门只查一种的话，用另一种拼写请求就能绕过它，把活会话的目录删掉。
  // 子代理后代也要过同一道闸门，所以传判断函数而不是一个布尔。
  const isLive = (id) => findLiveSession(sessions, id) !== undefined
  const result = await deleteSession({
    sessionsRoot: sessionsRoot(),
    agents: ctx.get?.('agents'),
    isLive,
    workspaceRegistry: ctx.get?.('workspaceRegistry'),
    projectionCache: projectionCacheTable(ctx),
    stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
  }, sessionId)
  const warnings = [...result.warnings, ...result.workspace.warnings]
  if (!result.workspace.available) {
    warnings.push('这个部署没有工作区注册表，工作区记账那一段没有执行')
  }
  warnings.push(...result.workspace.failures)
  return { status: 200, body: { ok: true, ...result, warnings } }
}

/**
 * `POST /api/agent-control/turn/delete`：从模型可见面上删掉一轮。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} payload - 请求体。
 * @returns {Promise<{ status: number, body: any }>} 响应。
 * @throws {ControlError} 校验或删除失败时抛出，由 wrap 映射成 HTTP。
 */
async function handleDeleteTurn(ctx, payload) {
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
