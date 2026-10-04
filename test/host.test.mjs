/**
 * host 端接线（`src/index.mjs`）的离线测试。
 *
 * 只用假 ctx 驱动真实的路由处理器：HTTP 状态与错误码映射、活会话闸门的两种 id 拼写、
 * 以及「活会话」答案来自 store 现查而不是一份会过期的副本。
 * 会话目录全部建在临时目录里（`DSH_HOME` 指过去），**绝不触碰真实 profile**。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { ERROR_CODES, PATHS, statusForCode } from '../src/shared.mjs'
import { PENDING_MAX_AGE_MS, readLast, readPending, restartDir, writeLast, writePending } from '../src/restart.mjs'
import {
  RESTART_TOOL_NAME,
  checkRestartTrust,
  createRestartState,
  deliverResumes,
  isJsonRequest,
  pinPortIfNeeded,
  preflightRestart,
  registerRestartTool,
  requestRestart,
  resetRestartRuntimeForTest,
  resolveApprovalMode,
} from '../src/restart-tool.mjs'
import { threeTurnSession } from './fake-session.mjs'

const { apply } = await import('../src/index.mjs')

/** 造一个临时 DSH_HOME，并在测试结束后还原环境变量。 */
function tempHome(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-agent-control-host-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

function makeSessionDir(home, dirName) {
  const dir = path.join(home, 'sessions', '--D-work--', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'stub', 'utf8')
  return dir
}

/** 假 ctx：记下注册的路由与 error 日志。`options.host` 用来注入重启时序的假副作用。 */
function makeHost(services = {}, options = {}) {
  const routes = new Map()
  const errors = []
  const warnings = []
  const ctx = {
    effect: (fn) => fn(),
    on() {},
    get: (name) => services[name],
    logger: { error: (message) => errors.push(message), warn: (message) => warnings.push(message) },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  apply(ctx, options.config, options.host)
  return { routes, errors, warnings }
}

/**
 * 带「假副作用」的 host：`schedule` 只把后台时序排进队列（测试自己决定什么时候驱动它），
 * `spawn` / `appExit` 一律是假的——**测试绝不真的派生辅助进程、绝不真的退出进程**。
 */
function makeRestartHost(services = {}, options = {}) {
  const background = []
  const exits = []
  const host = makeHost(services, {
    config: options.config,
    host: {
      schedule: (fn) => {
        background.push(fn)
      },
      spawn: () => {
        throw new Error('测试里不允许派生辅助进程')
      },
      appExit: (code) => {
        exits.push(code)
      },
      ...(options.host ?? {}),
    },
  })
  return { ...host, background, exits }
}

/** 直接驱动 `requestRestart` 时用的 deps（副作用全部是假的）。 */
function makeRestartDeps(ctx, options = {}) {
  return createRestartState(ctx, {
    dshHome: options.dshHome,
    config: options.config,
    argv: options.argv,
    port: options.port,
    schedule: options.schedule ?? (() => {}),
    spawn: options.spawn ?? (() => {
      throw new Error('测试里不允许派生辅助进程')
    }),
    appExit: options.appExit ?? (() => {
      throw new Error('测试里不允许退出进程')
    }),
  })
}

/** 只够 restart-tool 用的最小 ctx（没有路由、没有 webServer）。 */
function makeToolContext(services = {}) {
  const errors = []
  const warnings = []
  const ctx = {
    effect: (fn) => fn(),
    get: (name) => services[name],
    logger: { error: (message) => errors.push(message), warn: (message) => warnings.push(message) },
  }
  return { ctx, errors, warnings }
}

/** 调一次路由，返回 { status, body }。 */
async function call(host, routePath, { method = 'POST', body = '', query = '', headers = {} } = {}) {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)])
  req.method = method
  req.url = routePath + query
  // 默认给一个「同源浏览器 POST」的头：Origin 与 Host 一致，content-type 是 JSON。
  req.headers = {
    host: '127.0.0.1:10727',
    origin: 'http://127.0.0.1:10727',
    'content-type': 'application/json',
    ...headers,
  }
  let status
  let text
  const res = { writeHead: (code) => { status = code }, end: (chunk) => { text = chunk } }
  await host.routes.get(routePath)(req, res)
  return { status, body: JSON.parse(text) }
}

test('请求体不是合法 JSON：400 INVALID_REQUEST，且不当成内部故障记日志', async () => {
  // 早期版本抛的是带 code 的普通 Error，toControlError 不认，于是成了 500 DELETE_FAILED。
  const host = makeHost()
  const response = await call(host, PATHS.sessionDelete, { body: '{bad json' })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, ERROR_CODES.invalidRequest)
  assert.deepEqual(host.errors, [], '参数错误不是内部故障')
})

test('请求体超过上限：400 INVALID_REQUEST', async () => {
  const host = makeHost()
  const response = await call(host, PATHS.sessionDelete, {
    body: JSON.stringify({ sessionId: 'abc', pad: 'x'.repeat(70 * 1024) }),
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, ERROR_CODES.invalidRequest)
  assert.deepEqual(host.errors, [])
})

test('活会话闸门两种拼写都查：用另一种拼写请求也会被 SESSION_LIVE 拒绝', async (t) => {
  // 找目录时两种拼写都会被删；闸门只查一种的话，换个拼写就能把活会话的目录删掉。
  const home = tempHome(t)
  const dir = makeSessionDir(home, 'session-abc')
  const live = { id: 'session-abc' }
  const host = makeHost({ sessions: { get: (id) => (id === 'session-abc' ? live : undefined), list: () => [live] } })

  const response = await call(host, PATHS.sessionDelete, { body: JSON.stringify({ sessionId: 'abc' }) })

  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, ERROR_CODES.sessionLive)
  assert.equal(existsSync(dir), true, '★ 被拒绝时活会话的目录必须原样保留')
})

test('删除成功的响应里 detached 反映真实的记账结果', async (t) => {
  const home = tempHome(t)
  makeSessionDir(home, 'abc')
  const host = makeHost({
    sessions: { get: () => undefined, list: () => [] },
    workspaceRegistry: { list: () => [{ id: 'ws', sessionIds: ['other'], detachSession: async () => {} }] },
  })

  const response = await call(host, PATHS.sessionDelete, { body: JSON.stringify({ sessionId: 'abc' }) })

  assert.equal(response.status, 200)
  assert.equal(response.body.detached, false, '记账里没有它，就不能报已解除')
  assert.match(response.body.warnings.join('\n'), /没有找到这个会话/)
})

test('列表的 live 来自 store 现查：会话关掉后立刻不再是 live（不依赖事件订阅）', async (t) => {
  // 早期版本用模块级集合 + 只订阅一次的事件记账；插件重新 apply 后监听已被注销，
  // 集合里留着早已关掉的会话，界面一直报「还在活动状态」。
  const home = tempHome(t)
  makeSessionDir(home, 'abc')
  const open = new Map([['abc', { id: 'abc' }]])
  const services = { sessions: { get: (id) => open.get(id), list: () => [...open.values()] } }

  makeHost(services) // 第一次 apply
  const host = makeHost(services) // 模拟重新 apply（同一个模块实例）
  const before = await call(host, PATHS.sessions, { method: 'GET' })
  assert.equal(before.body.sessions.find((row) => row.sessionId === 'abc').live, true)

  open.delete('abc') // 会话被关掉
  const after = await call(host, PATHS.sessions, { method: 'GET' })
  assert.equal(after.body.sessions.find((row) => row.sessionId === 'abc').live, false, '★ 关掉的会话不能再被标成 live')
})

test('轮次接口按两种拼写找活会话', async () => {
  const live = { id: 'session-abc', snapshotEvents: () => [] }
  const host = makeHost({ sessions: { get: (id) => (id === 'session-abc' ? live : undefined), list: () => [live] } })
  const response = await call(host, PATHS.turns, { method: 'GET', query: '?sessionId=abc' })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.turns, [])
})

test('删一轮：路由在维护租约里写删除事务、按计量填影子价格，/turns 随即报告该轮已删', async () => {
  const { session, turns } = threeTurnSession()
  const live = Object.assign(session, { id: 'session-t' })
  let leased = 0
  let flushed = 0
  const agent = { runMaintenance: (task) => { leased += 1; return task(new AbortController().signal) } }
  const host = makeHost({
    sessions: { get: (id) => (id === 'session-t' ? live : undefined), list: () => [live], flush: async () => { flushed += 1; return true } },
    agents: { get: (id) => (id === 'session-t' ? agent : undefined) },
    tokenMeter: { measure: () => ({ nodes: live.surface.nodes.map((seq) => ({ seq, heuristicTokens: 10 })) }) },
  })
  const before = live.snapshotEvents().length
  const response = await call(host, PATHS.turnDelete, { body: JSON.stringify({ sessionId: 't', assistantMessageId: turns[1].assistantId }) })

  assert.equal(response.status, 200)
  assert.equal(response.body.turn, 2)
  assert.equal(leased, 1, '必须在维护租约里写')
  assert.equal(flushed, 1, '写完要落盘')
  const appended = live.snapshotEvents().slice(before)
  assert.deepEqual(appended.map((event) => event.type), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  assert.equal(appended[1].data.shadowedTokenCount, 20, '影子价格取自 tokenMeter（两个节点 × 10）')

  const listed = await call(host, PATHS.turns, { method: 'GET', query: '?sessionId=session-t' })
  assert.deepEqual(listed.body.turns, [2])
})
test('删会话时通过 storageDomain 的公开表接口清掉投影缓存', async (t) => {
  const home = tempHome(t)
  makeSessionDir(home, 'session-cache1')
  const deleted = []
  const table = { delete: async (key) => { deleted.push(key); return key === 'session-cache1' } }
  const host = makeHost({
    sessions: { get: () => undefined, list: () => [] },
    storageDomain: { get: (name) => (name === 'session_projcache' ? { table: (n) => (n === 'sessions' ? table : undefined) } : undefined) },
  })
  const response = await call(host, PATHS.sessionDelete, { body: JSON.stringify({ sessionId: 'session-cache1' }) })
  assert.equal(response.status, 200)
  assert.deepEqual(deleted.sort(), ['cache1', 'session-cache1'], '两种拼写都要删')
  assert.deepEqual(response.body.projectionCache.removed, ['session-cache1'])
})

// ---------------------------------------------------------------------------
// 热重启（M3）：状态码映射、可信校验、守卫链、状态接口、续作投递
// ---------------------------------------------------------------------------

test('重启错误码到 HTTP 状态的映射：403 / 403 / 409 / 409 / 429 / 501，旧码语义不动', () => {
  assert.equal(statusForCode(ERROR_CODES.restartDenied), 403, '审批被拒 / Origin 校验失败')
  assert.equal(statusForCode(ERROR_CODES.restartForbidden), 403, '子代理调用')
  assert.equal(statusForCode(ERROR_CODES.restartInProgress), 409, '已经有一个在跑')
  assert.equal(statusForCode(ERROR_CODES.restartBlocked), 409, '别的会话 / 后台任务在忙')
  assert.equal(statusForCode(ERROR_CODES.restartRateLimited), 429, '太频繁')
  assert.equal(statusForCode(ERROR_CODES.restartUnsupported), 501, '这个部署做不到')
  // 旧的删除类码一个都不许动。
  assert.equal(statusForCode(ERROR_CODES.deleteFailed), 500)
  assert.equal(statusForCode(ERROR_CODES.sessionLive), 409)
  assert.equal(statusForCode(ERROR_CODES.agentBusy), 423)
})

test('可信校验：同源放行、无 Origin 无自定义头拒绝、宿主拒绝照抄、Origin 与 Host 必须一致', () => {
  const sameOrigin = { host: '127.0.0.1:10727', origin: 'http://127.0.0.1:10727' }
  assert.equal(checkRestartTrust(sameOrigin, undefined), undefined, '同源 POST 放行')
  assert.equal(checkRestartTrust(sameOrigin, 401), 401, '宿主鉴权结论优先，照抄')
  assert.equal(checkRestartTrust(sameOrigin, 403), 403)
  assert.equal(checkRestartTrust({ host: '127.0.0.1:10727' }, undefined), 403, '没有 Origin 就必须带自定义头')
  assert.equal(checkRestartTrust({ host: '127.0.0.1:10727', 'x-dsh-agent-control': '1' }, undefined), undefined)
  assert.equal(checkRestartTrust({ host: '127.0.0.1:10727', origin: 'http://evil.example' }, undefined), 403, 'Origin 的 host 必须等于 Host')
  assert.equal(checkRestartTrust({ origin: 'http://127.0.0.1:10727' }, undefined), 403, '没有 Host 头就无法比对')
  assert.equal(checkRestartTrust({ host: '127.0.0.1:10727', origin: 'null' }, undefined), 403, '解析不出来的 Origin 不可信')
  assert.equal(checkRestartTrust(undefined, undefined), 403, '连头都没有：拒绝')

  assert.equal(isJsonRequest({ 'content-type': 'application/json' }), true)
  assert.equal(isJsonRequest({ 'content-type': 'Application/JSON; charset=utf-8' }), true)
  assert.equal(isJsonRequest({ 'content-type': 'text/plain' }), false)
  assert.equal(isJsonRequest({}), false)
  assert.equal(isJsonRequest(undefined), false)
})

test('POST /restart：请求头不可信 ⇒ 403 RESTART_DENIED；content-type 不是 JSON ⇒ 400；两种都不写待办', async (t) => {
  const home = tempHome(t)
  resetRestartRuntimeForTest()
  const host = makeRestartHost()
  const pendingFile = () => existsSync(path.join(restartDir(home), 'pending.json'))

  const noOrigin = await call(host, PATHS.restart, { body: JSON.stringify({ reason: '装插件' }), headers: { origin: undefined } })
  assert.equal(noOrigin.status, 403)
  assert.equal(noOrigin.body.error.code, ERROR_CODES.restartDenied)

  const wrongOrigin = await call(host, PATHS.restart, { body: JSON.stringify({ reason: '装插件' }), headers: { origin: 'http://evil.example' } })
  assert.equal(wrongOrigin.status, 403)
  assert.equal(wrongOrigin.body.error.code, ERROR_CODES.restartDenied)

  const wrongType = await call(host, PATHS.restart, { body: JSON.stringify({ reason: '装插件' }), headers: { 'content-type': 'text/plain' } })
  assert.equal(wrongType.status, 400)
  assert.equal(wrongType.body.error.code, ERROR_CODES.invalidRequest)

  assert.equal(pendingFile(), false, '★ 被拒绝的请求绝不能留下待办')
})

test('POST /restart：宿主 requestRejection 给 401/403 时照抄该状态', async (t) => {
  tempHome(t)
  resetRestartRuntimeForTest()
  const unauthorized = makeRestartHost({ connection: { requestRejection: () => 401 } })
  const forbidden = makeRestartHost({ connection: { requestRejection: () => 403 } })

  const first = await call(unauthorized, PATHS.restart, { body: JSON.stringify({ reason: '装插件' }) })
  const second = await call(forbidden, PATHS.restart, { body: JSON.stringify({ reason: '装插件' }) })

  assert.equal(first.status, 401)
  assert.equal(second.status, 403)
  assert.equal(first.body.error.code, ERROR_CODES.restartDenied)
  assert.equal(second.body.error.code, ERROR_CODES.restartDenied)
})

test('界面发起：有会话在跑 ⇒ 409 RESTART_BLOCKED（文案点名会话），force=true 才放行', async (t) => {
  const home = tempHome(t)
  resetRestartRuntimeForTest()
  const services = {
    agents: { list: () => [{ id: 'session-a', status: 'running' }], roots: () => [{ id: 'session-a' }] },
    sessions: { get: () => undefined, list: () => [] },
  }
  const blocked = makeRestartHost(services)
  const first = await call(blocked, PATHS.restart, { body: JSON.stringify({ reason: '装插件' }) })

  assert.equal(first.status, 409)
  assert.equal(first.body.error.code, ERROR_CODES.restartBlocked)
  assert.match(first.body.error.message, /另有 1 个会话在运行：session-a/, '★ 文案必须点名是谁在忙，模型才知道等谁')
  assert.equal(existsSync(path.join(restartDir(home), 'pending.json')), false)

  // 勾了「仍然重启」：跳过阻塞项，直接安排。
  const forced = makeRestartHost(services)
  const second = await call(forced, PATHS.restart, { body: JSON.stringify({ reason: '装插件', force: true }) })
  assert.equal(second.status, 202)
  assert.equal(typeof second.body.restartId, 'string')
  assert.equal(readPending(restartDir(home)).createdAt > 0, true)
})

test('预检失败（宿主没有 appExit）⇒ 501 RESTART_UNSUPPORTED，绝不假装成功', async (t) => {
  tempHome(t)
  resetRestartRuntimeForTest()
  // 不注入 appExit，也不给 ctx 提供 appExit 服务。
  const host = makeRestartHost({}, { host: { appExit: undefined } })
  const response = await call(host, PATHS.restart, { body: JSON.stringify({ reason: '装插件' }) })

  assert.equal(response.status, 501)
  assert.equal(response.body.error.code, ERROR_CODES.restartUnsupported)
  assert.match(response.body.error.message, /appExit/)
})

test('读不出「谁在跑」⇒ 501 拒绝，不假装没有阻塞（agents.list() 抛错）', async (t) => {
  tempHome(t)
  resetRestartRuntimeForTest()
  const host = makeRestartHost({
    agents: {
      roots: () => [{ id: 'session-a' }],
      list: () => {
        throw new Error('会话存储挂了')
      },
    },
    sessions: { get: () => undefined, list: () => [] },
  })

  const response = await call(host, PATHS.restart, { body: JSON.stringify({ reason: '装插件' }) })

  assert.equal(response.status, 501)
  assert.equal(response.body.error.code, ERROR_CODES.restartUnsupported)
  assert.match(response.body.error.message, /agents\.list\(\)/)
})

test('预检：重放的启动参数第一项必须是入口脚本（坏命令行宁可不重启）', async (t) => {
  const home = tempHome(t)
  resetRestartRuntimeForTest()
  const { ctx } = makeToolContext()

  // 正常现场：process.argv.slice(1) 的第一项是本测试文件的路径。
  assert.deepEqual(preflightRestart(ctx, makeRestartDeps(ctx, { dshHome: home })), { ok: true })
  // 第一项是选项（例如进程不是用「脚本 + 参数」起的）：重放只会起来一个用法错误的新进程。
  const broken = preflightRestart(ctx, makeRestartDeps(ctx, { dshHome: home, argv: ['--no-open', '--port', '1'] }))
  assert.equal(broken.ok, false)
  assert.match(broken.reason, /入口脚本路径/)
})

test('限频：窗口内第 4 次被 RESTART_RATE_LIMITED 拒绝；被取消的重启如实写进 last.json', async (t) => {
  const home = tempHome(t)
  resetRestartRuntimeForTest()
  const background = []
  const { ctx } = makeToolContext()
  const deps = makeRestartDeps(ctx, { dshHome: home, schedule: (fn) => { background.push(fn) } })

  // 三次「发起了但被取消」的重启：会话不存在 ⇒ 后台时序取消 ⇒ 释放单飞锁。
  // 用三个不同的会话 id，避开「同一会话 60 秒冷却」那条闸门，专测窗口计数。
  for (const sessionId of ['s1', 's2', 's3']) {
    const result = await requestRestart(ctx, deps, { source: 'ui', sessionId, reason: '测试限频' })
    assert.equal(typeof result.restartId, 'string')
    const task = background.shift()
    assert.equal(typeof task, 'function', '后台时序必须被排到调用栈之外')
    await task()
  }

  const last = readLast(restartDir(home))
  assert.match(last.error, /^重启已取消：/, '★ 取消也要留下可读的原因')
  assert.equal(last.stage, 'cancelled')
  assert.equal(readPending(restartDir(home)), undefined, '取消必须清掉待办')

  await assert.rejects(
    () => requestRestart(ctx, deps, { source: 'ui', sessionId: 's4', reason: '测试限频' }),
    (error) => error.code === ERROR_CODES.restartRateLimited && error.status === 429,
  )
})

test('模型工具：子代理调用 ⇒ RESTART_FORBIDDEN（且不写待办）', async (t) => {
  const home = tempHome(t)
  resetRestartRuntimeForTest()
  const registered = []
  const { ctx } = makeToolContext({
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    agents: { roots: () => [{ id: 'session-root' }], list: () => [] },
  })
  registerRestartTool(ctx, makeRestartDeps(ctx, { dshHome: home }))
  const tool = registered[0]
  assert.equal(tool.name, RESTART_TOOL_NAME)

  const value = await tool.execute(
    { reason: '子代理想重启' },
    { agent: { id: 'session-sub' }, concludeTurn: () => { throw new Error('被拒绝时不该结束本轮') } },
  )

  assert.equal(value.error.code, ERROR_CODES.restartForbidden)
  assert.match(value.error.message, /子代理不能重启宿主/)
  assert.equal(readPending(restartDir(home)), undefined)
})

test('模型工具：有别的会话在跑 ⇒ RESTART_BLOCKED，文案告诉模型等谁', async (t) => {
  const home = tempHome(t)
  resetRestartRuntimeForTest()
  const registered = []
  const { ctx } = makeToolContext({
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    agents: {
      roots: () => [{ id: 'session-me' }],
      list: () => [{ id: 'session-me', status: 'running' }, { id: 'session-other', status: 'running' }],
    },
    sessions: { get: () => undefined },
  })
  registerRestartTool(ctx, makeRestartDeps(ctx, { dshHome: home }))

  const value = await registered[0].execute({ reason: '装完了要重启' }, { agent: { id: 'session-me' } })

  assert.equal(value.error.code, ERROR_CODES.restartBlocked)
  assert.match(value.error.message, /session-other/, '调用者自己不算阻塞，别的会话要写清楚')
  assert.doesNotMatch(value.error.message, /session-me、/, '调用者自己不该出现在阻塞名单里')
  assert.equal(readPending(restartDir(home)), undefined)
})

test('模型工具：审批被拒 ⇒ RESTART_DENIED，进程没有动', async (t) => {
  const home = tempHome(t)
  resetRestartRuntimeForTest()
  const registered = []
  const asked = []
  const { ctx } = makeToolContext({
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    agents: { roots: () => [{ id: 'session-me' }], list: () => [] },
    approval: { request: async (request) => { asked.push(request); return 'rejected' } },
  })
  registerRestartTool(ctx, makeRestartDeps(ctx, { dshHome: home }))

  const value = await registered[0].execute({ reason: '装完了要重启' }, { agent: { id: 'session-me' }, callId: 'call-9' })

  assert.equal(value.error.code, ERROR_CODES.restartDenied)
  assert.match(value.error.message, /拒绝了这次重启/)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].toolName, RESTART_TOOL_NAME)
  assert.equal(asked[0].reason, '装完了要重启', '审批卡片要看到原因')
  assert.equal(asked[0].callId, 'call-9')
  assert.equal(readPending(restartDir(home)), undefined, '★ 被拒时什么都不做')
})

test('模型工具：审批服务不存在 ⇒ RESTART_DENIED（不静默放行）；approval=auto 才免审批', async (t) => {
  const home = tempHome(t)
  resetRestartRuntimeForTest()
  const registered = []
  const { ctx } = makeToolContext({
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    agents: { roots: () => [{ id: 'session-me' }], list: () => [] },
  })
  registerRestartTool(ctx, makeRestartDeps(ctx, { dshHome: home }))

  const denied = await registered[0].execute({ reason: '装完了要重启' }, { agent: { id: 'session-me' } })
  assert.equal(denied.error.code, ERROR_CODES.restartDenied)
  assert.match(denied.error.message, /审批服务/)
  assert.equal(readPending(restartDir(home)), undefined)

  // 配置成 auto：不需要审批服务也能安排（限频与阻塞项仍然生效）。
  const autoRegistered = []
  const auto = makeToolContext({
    tools: { register: (definition) => { autoRegistered.push(definition); return () => {} } },
    agents: { roots: () => [{ id: 'session-me' }], list: () => [] },
  })
  registerRestartTool(auto.ctx, makeRestartDeps(auto.ctx, { dshHome: home, config: { approval: 'auto' } }))
  const allowed = await autoRegistered[0].execute({ reason: '装完了要重启' }, { agent: { id: 'session-me' } })
  assert.equal(allowed.scheduled, true)
})

test('模型工具：成功 ⇒ scheduled + 结束本轮 + 待办落盘；随后再进行中的重启被单飞挡下', async (t) => {
  const home = tempHome(t)
  resetRestartRuntimeForTest()
  const registered = []
  const asked = []
  const { ctx } = makeToolContext({
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    agents: { roots: () => [{ id: 'session-me' }], list: () => [] },
    approval: { request: async (request) => { asked.push(request); return 'allowed-once' } },
  })
  const deps = makeRestartDeps(ctx, { dshHome: home })
  registerRestartTool(ctx, deps)
  const tool = registered[0]

  let concluded = 0
  const exec = { agent: { id: 'session-me' }, callId: 'call-1', concludeTurn: () => { concluded += 1 } }
  const value = await tool.execute({ reason: '装完宿主插件要重启', resume_note: '确认插件已加载' }, exec)

  assert.equal(value.scheduled, true)
  assert.equal(typeof value.restartId, 'string')
  assert.equal(value.expectedDowntimeSeconds, 10)
  assert.equal(concluded, 1, '★ 成功必须结束本轮，好让工具结果先落盘再退出进程')

  const pending = readPending(restartDir(home))
  assert.equal(pending.restartId, value.restartId)
  assert.equal(pending.state, 'scheduled')
  assert.equal(pending.sessionId, 'session-me')
  assert.equal(pending.source, 'model')
  assert.equal(pending.reason, '装完宿主插件要重启')
  assert.equal(pending.resumeNote, '确认插件已加载')
  assert.equal(pending.oldBootId, deps.bootId)
  assert.equal(Number.isSafeInteger(pending.oldPid), true)

  const again = await tool.execute({ reason: '再来一次' }, { agent: { id: 'session-me' } })
  assert.equal(again.error.code, ERROR_CODES.restartInProgress, '单飞：同一时刻只能有一次重启')
})

test('GET /restart/status：形状齐全，blockers 按现场计数', async (t) => {
  const home = tempHome(t)
  resetRestartRuntimeForTest()
  const host = makeRestartHost({
    agents: {
      roots: () => [{ id: 'session-a' }],
      list: () => [{ id: 'session-a', status: 'running' }, { id: 'session-b', status: 'inactive' }],
    },
    sessions: { get: () => undefined, list: () => [] },
    jobs: {
      list: () => [
        { id: 'bash-1', status: 'running', label: '跑测试', kind: 'bash' },
        { id: 'bash-2', status: 'completed', label: '跑完了', kind: 'bash' },
      ],
    },
  })

  const response = await call(host, PATHS.restartStatus, { method: 'GET' })

  assert.equal(response.status, 200)
  for (const key of ['ok', 'bootId', 'pid', 'startedAt', 'port', 'canRestart', 'blockers', 'pending', 'last']) {
    assert.equal(Object.hasOwn(response.body, key), true, `状态里必须有 ${key}`)
  }
  assert.equal(response.body.ok, true)
  assert.equal(typeof response.body.bootId, 'string')
  assert.equal(response.body.pid, process.pid)
  assert.equal(response.body.canRestart, true)
  assert.equal(Object.hasOwn(response.body, 'unsupportedReason'), false, '能重启就不该有原因')
  assert.equal(response.body.version, '0.2.1-alpha.1-v1.1.0', '版本号读自插件自己的 package.json（设置页要显示）')
  assert.deepEqual(response.body.blockers.sessions.map((row) => row.sessionId), ['session-a'])
  assert.equal(response.body.blockers.jobs, 1, 'jobs 是数量，而且只数在跑的')
  assert.equal(response.body.pending, null)
  assert.equal(response.body.last, null)
  assert.equal(existsSync(path.join(home, 'agent-control', 'restart', 'pending.json')), false)
})

test('新进程的续作投递：拉起会话、投一次、结果合并写进 last.json', async (t) => {
  const home = tempHome(t)
  const dir = restartDir(home)
  const prompts = []
  let resumed = 0
  const { ctx } = makeToolContext({
    sessionController: {
      resolveAgent: async (sessionId) => { resumed += 1; return { agent: { id: sessionId } } },
      prompt: async (request) => { prompts.push(request); return { accepted: true } },
    },
  })
  const deps = makeRestartDeps(ctx, { dshHome: home })
  writeLast(dir, { restartId: 'r-old', ok: true, durationMs: 6400, finishedAt: 1 })
  writePending(dir, {
    restartId: 'r-1',
    sessionId: 'session-me',
    source: 'model',
    reason: '装完宿主插件',
    resumeNote: '确认插件已加载',
    state: 'helper-started',
    createdAt: Date.now() - 1000,
    oldPid: 1,
  })

  const result = await deliverResumes(ctx, deps)

  assert.equal(result.resume, 'delivered')
  assert.equal(resumed, 1)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].mode, 'queue')
  assert.equal(prompts[0].sessionId, 'session-me')
  assert.equal(typeof prompts[0].requestId, 'string')
  assert.match(prompts[0].content[0].text, /DSH 已热重启/)
  assert.match(prompts[0].content[0].text, /装完宿主插件/)
  assert.match(prompts[0].content[0].text, /确认插件已加载/)
  assert.equal(readPending(dir), undefined, '★ 投递之前就先删待办：至多投一次')
  const last = readLast(dir)
  assert.equal(last.resume, 'delivered')
  assert.equal(last.durationMs, 6400, '合并写：不能把辅助进程写的字段冲掉')
})

test('续作投递失败与过期待办：如实记 failed / 直接丢弃，都不重复投递', async (t) => {
  const home = tempHome(t)
  const dir = restartDir(home)
  const prompts = []
  const { ctx, errors } = makeToolContext({
    sessionController: {
      resolveAgent: async () => ({ error: new Error('会话日志的尾部不合法') }),
      prompt: async (request) => { prompts.push(request); return { accepted: true } },
    },
  })
  const deps = makeRestartDeps(ctx, { dshHome: home })
  writePending(dir, { restartId: 'r-2', sessionId: 'session-me', reason: '装插件', state: 'helper-started', createdAt: Date.now() })

  const failed = await deliverResumes(ctx, deps)
  assert.equal(failed.resume, 'failed')
  assert.equal(prompts.length, 0)
  assert.match(readLast(dir).resumeError, /会话日志的尾部不合法/, '真实错误要原样记下来，不能吞')
  assert.equal(errors.length, 1)

  writePending(dir, {
    restartId: 'r-3',
    sessionId: 'session-me',
    reason: '装插件',
    state: 'helper-started',
    createdAt: Date.now() - PENDING_MAX_AGE_MS - 1000,
  })
  const stale = await deliverResumes(ctx, deps)
  assert.equal(stale.resume, 'none')
  assert.equal(prompts.length, 0, '过期就丢弃，绝不投递')
  assert.equal(readPending(dir), undefined)
})

test('审批策略配置手工校验：只认 ask / auto，未知值回退 ask', () => {
  assert.equal(resolveApprovalMode(undefined), 'ask')
  assert.equal(resolveApprovalMode({}), 'ask')
  assert.equal(resolveApprovalMode({ approval: 'auto' }), 'auto')
  assert.equal(resolveApprovalMode({ approval: 'ask' }), 'ask')
  assert.equal(resolveApprovalMode({ approval: 'never' }), 'ask', '写错的词不能让重启变成免审批')
  assert.equal(resolveApprovalMode({ approval: true }), 'ask')
})

test('启动参数重放：--port 0（OS 随机端口）时把真实端口原地钉住，别让新进程换端口', () => {
  const argv = ['/x/bin.js', '--profile', 'web', '--no-open', '--port', '0']
  assert.deepEqual(pinPortIfNeeded(argv, { pin: true, port: 10727 }), ['/x/bin.js', '--profile', 'web', '--no-open', '--port', '10727'])
  assert.deepEqual(pinPortIfNeeded(argv, { pin: false, port: 10727 }), argv, '不钉端口时原样重放')
  assert.deepEqual(pinPortIfNeeded(argv, { pin: true, port: 0 }), argv, '拿不到真实端口就不动它')
  assert.deepEqual(
    pinPortIfNeeded(['/x/bin.js', '--port=0', '--', 'positional'], { pin: true, port: 4321 }),
    ['/x/bin.js', '--port=4321', '--', 'positional'],
  )
  assert.deepEqual(pinPortIfNeeded(['/x/bin.js', '--'], { pin: true, port: 4321 }), ['/x/bin.js', '--port', '4321', '--'])
  assert.deepEqual(pinPortIfNeeded(['/x/bin.js'], { pin: true, port: 4321 }), ['/x/bin.js', '--port', '4321'])

  // 端到端一点：webStartup.port === 0 时，deps 里重放用的 argv 与就绪探针地址都用真实端口。
  const { ctx } = makeToolContext({ webStartup: { port: 0 } })
  ctx.webServer = { port: 10727, host: '127.0.0.1' }
  const deps = makeRestartDeps(ctx, { dshHome: os.tmpdir(), argv: ['/x/bin.js', '--port', '0'] })
  assert.deepEqual(deps.argvForReplay, ['/x/bin.js', '--port', '10727', '--no-open'], '钉住端口 + 补 --no-open')
  assert.equal(deps.statusUrl, 'http://127.0.0.1:10727/api/agent-control/restart/status')
})