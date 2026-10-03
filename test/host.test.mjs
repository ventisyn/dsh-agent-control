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

import { ERROR_CODES, PATHS } from '../src/shared.mjs'
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

/** 假 ctx：记下注册的路由与 error 日志。 */
function makeHost(services = {}) {
  const routes = new Map()
  const errors = []
  const ctx = {
    effect: (fn) => fn(),
    on() {},
    get: (name) => services[name],
    logger: { error: (message) => errors.push(message) },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  apply(ctx)
  return { routes, errors }
}

/** 调一次路由，返回 { status, body }。 */
async function call(host, routePath, { method = 'POST', body = '', query = '' } = {}) {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)])
  req.method = method
  req.url = routePath + query
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