/**
 * 会话删除的离线测试。
 *
 * 全部文件操作都在一个临时目录里做，测试结束即删；**绝不触碰真实的 `$DSH_HOME`**。
 * 重点覆盖：两种 id 拼写、活会话被拒、删不净就不解除记账、记账不可用如实回报。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { ERROR_CODES, sessionDirNames } from '../src/shared.mjs'
import {
  deleteSession,
  detachFromWorkspaces,
  findSessionDirs,
  findSubagentDescendants,
  listSessions,
  readSessionHeader,
  removeProjectionCache,
  stopAgentIfRunning,
} from '../src/session-delete.mjs'

/** 造一个临时 `$DSH_HOME/sessions` 树。 */
function tempSessionsRoot(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-agent-control-test-'))
  const sessions = path.join(root, 'sessions')
  mkdirSync(sessions, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return sessions
}

/** 在某个 slug 下造一个会话目录（含一个会话文件）。 */
function makeSessionDir(sessionsRoot, slug, dirName) {
  const dir = path.join(sessionsRoot, slug, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'stub', 'utf8')
  return dir
}

test('会话 id 有两种磁盘拼写，两种都要认', () => {
  assert.deepEqual(sessionDirNames('1afe9c3b-fd0c-4d6f-9ecf-a1f6261ad721'), [
    '1afe9c3b-fd0c-4d6f-9ecf-a1f6261ad721',
    'session-1afe9c3b-fd0c-4d6f-9ecf-a1f6261ad721',
  ])
  assert.deepEqual(sessionDirNames('session-58a6c1c1-074e-4fcb-af54-04a234428ad3'), [
    'session-58a6c1c1-074e-4fcb-af54-04a234428ad3',
    '58a6c1c1-074e-4fcb-af54-04a234428ad3',
  ])
  // store 自己铸造的形式（不是 UUID）也要能处理。
  assert.deepEqual(sessionDirNames('session-7'), ['session-7', '7'])
})

test('findSessionDirs 跨 slug 找到两种拼写的目录', (t) => {
  const sessions = tempSessionsRoot(t)
  const bare = makeSessionDir(sessions, '--D-work-alpha--', 'aa11bb22-0000-0000-0000-000000000001')
  const prefixed = makeSessionDir(sessions, '--D-work-beta--', 'session-aa11bb22-0000-0000-0000-000000000001')
  makeSessionDir(sessions, '--D-work-gamma--', 'some-other-session')

  const found = findSessionDirs(sessions, 'aa11bb22-0000-0000-0000-000000000001')
  assert.deepEqual(found, [bare, prefixed].sort())
})

test('删除会话：磁盘目录消失，工作区记账被解除', async (t) => {
  const sessions = tempSessionsRoot(t)
  const id = 'aa11bb22-0000-0000-0000-000000000002'
  const dir = makeSessionDir(sessions, '--D-work-alpha--', id)

  const detached = []
  const workspaceRegistry = {
    list: () => [
      { id: 'ws-1', title: 'alpha', path: 'D:\\work\\alpha', sessionIds: [id, 'other'], detachSession: async (target) => { detached.push(target) } },
      { id: 'ws-2', title: 'beta', path: 'D:\\work\\beta', sessionIds: ['other'], detachSession: async (target) => { detached.push(`unexpected:${target}`) } },
    ],
  }

  const result = await deleteSession({ sessionsRoot: sessions, workspaceRegistry }, id)

  assert.equal(existsSync(dir), false, '会话目录必须被真的删掉')
  assert.deepEqual(result.removed, [dir])
  assert.deepEqual(detached, [id], '只应解除包含该会话的那一个工作区')
  assert.equal(result.workspace.detached, true)
  assert.equal(result.detached, true)
  assert.deepEqual(result.workspace.failures, [])
})

test('活会话被拒绝，且磁盘目录原样保留', async (t) => {
  const sessions = tempSessionsRoot(t)
  const id = 'aa11bb22-0000-0000-0000-000000000003'
  const dir = makeSessionDir(sessions, '--D-work-alpha--', id)

  await assert.rejects(
    () => deleteSession({ sessionsRoot: sessions, live: true }, id),
    (error) => {
      assert.equal(error.code, ERROR_CODES.sessionLive)
      // 不能再叫用户「先切走」：切走不会释放会话（真机实测），要说清楚只能重启后删。
      assert.match(error.message, /重启 dsh web/)
      assert.match(error.message, /不会释放/)
      return true
    },
  )
  assert.equal(existsSync(dir), true, '被拒绝时不得动磁盘')
})

test('找不到会话时报 TARGET_NOT_FOUND，不是假的成功', async (t) => {
  const sessions = tempSessionsRoot(t)
  await assert.rejects(
    () => deleteSession({ sessionsRoot: sessions }, 'aa11bb22-0000-0000-0000-000000000004'),
    (error) => error.code === ERROR_CODES.targetNotFound,
  )
})

test('agent 停不下来时抛 AGENT_BUSY，且不删目录', async (t) => {
  const sessions = tempSessionsRoot(t)
  const id = 'aa11bb22-0000-0000-0000-000000000005'
  const dir = makeSessionDir(sessions, '--D-work-alpha--', id)

  const agents = {
    get: () => ({
      status: 'running',
      cancel: () => {},
      // 永远不 idle：模拟卡住的 agent。
      whenIdle: () => new Promise(() => {}),
    }),
  }

  await assert.rejects(
    () => deleteSession({ sessionsRoot: sessions, agents, stopTimeoutMs: 50 }, id),
    (error) => error.code === ERROR_CODES.agentBusy,
  )
  assert.equal(existsSync(dir), true, '停不下来时不得继续硬删')
})

test('stopAgentIfRunning 对不存在的 agent 与 idle 的 agent 都是空操作', async () => {
  assert.deepEqual(await stopAgentIfRunning(undefined, 'x'), { stopped: false, timedOut: false, waited: false })
  assert.deepEqual(
    await stopAgentIfRunning({ get: () => ({ status: 'idle' }) }, 'x'),
    { stopped: false, timedOut: false, waited: false },
  )
})

test('工作区注册表不可用时如实回报「未执行」，不假装清理成功', async () => {
  const result = await detachFromWorkspaces(undefined, 'some-id')
  assert.equal(result.available, false)
  assert.equal(result.detached, false)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /未清理/)
})

test('工作区 detach 抛错时记进 failures，不吞掉', async () => {
  const result = await detachFromWorkspaces({
    list: () => [{ id: 'ws-1', title: 't', path: 'p', sessionIds: ['target'], detachSession: async () => { throw new Error('表锁住了') } }],
  }, 'target')

  assert.equal(result.available, true)
  assert.equal(result.detached, false)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /表锁住了/)
})

test('归档与置顶集合里的会话也会被清理', async () => {
  const calls = []
  const result = await detachFromWorkspaces({
    list: () => [],
    archivedSessionIds: ['target'],
    pinnedSessionIds: ['target'],
    unarchiveSession: async (id) => calls.push(`unarchive:${id}`),
    unpinSession: async (id) => calls.push(`unpin:${id}`),
  }, 'target')

  assert.deepEqual(calls.sort(), ['unarchive:target', 'unpin:target'])
  assert.equal(result.unarchived, true)
  assert.equal(result.unpinned, true)
})

test('listSessions 合并记账与磁盘，并标注只剩目录的残留', (t) => {
  const sessions = tempSessionsRoot(t)
  const tracked = 'aa11bb22-0000-0000-0000-000000000006'
  const orphan = 'aa11bb22-0000-0000-0000-000000000007'
  makeSessionDir(sessions, '--D-work-alpha--', tracked)
  makeSessionDir(sessions, '--D-work-alpha--', orphan)

  const rows = listSessions({
    sessionsRoot: sessions,
    workspaceRegistry: {
      list: () => [{ id: 'ws-1', title: 'alpha', path: 'D:\\work\\alpha', sessionIds: [tracked] }],
    },
  })

  const byId = new Map(rows.map((row) => [row.sessionId, row]))
  assert.equal(byId.get(tracked).workspaceTitle, 'alpha', '这是工作区的名字，不是会话标题')
  assert.deepEqual(byId.get(tracked).reasons, [], '记账里有的会话不该被标成残留')
  assert.equal(byId.has(orphan), true)
  assert.deepEqual(byId.get(orphan).reasons, ['磁盘上有目录，但工作区记账里已经没有它'])
  assert.equal(rows.length, 2)
})

test('listSessions 把两种拼写归一成同一个会话，不重复列两行', (t) => {
  const sessions = tempSessionsRoot(t)
  const id = 'aa11bb22-0000-0000-0000-000000000008'
  // 磁盘上只有带前缀的那一种拼写，而记账里是裸 id。
  makeSessionDir(sessions, '--D-work-alpha--', `session-${id}`)

  const rows = listSessions({
    sessionsRoot: sessions,
    workspaceRegistry: {
      list: () => [{ id: 'ws-1', title: 'alpha', path: 'D:\\work\\alpha', sessionIds: [id] }],
    },
  })

  assert.equal(rows.length, 1, '同一个会话不能因为拼写不同被列成两行')
  assert.equal(rows[0].sessionId, id)
  assert.equal(rows[0].workspaceTitle, 'alpha')
  assert.deepEqual(rows[0].reasons, [])
})

test('listSessions 在记账用带前缀拼写、磁盘用裸拼写时也只列一行', (t) => {
  // 真实 profile 就是这个形状：记账里是 `session-<uuid>`，磁盘目录是 `<uuid>`。
  // 早期实现直接比较字符串，于是同一个会话被列成两行——一行有标题，另一行
  // 被标成「记账里已经没有它」的孤儿。
  const sessions = tempSessionsRoot(t)
  const id = '58a6c1c1-074e-4fcb-af54-04a234428ad3'
  makeSessionDir(sessions, '--D-work-alpha--', id)
  makeSessionDir(sessions, '--D-work-alpha--', `session-${id}`)

  const rows = listSessions({
    sessionsRoot: sessions,
    liveSessionIds: [`session-${id}`],
    workspaceRegistry: {
      list: () => [{ id: 'ws-1', title: '真实标题', path: 'D:\\work\\alpha', sessionIds: [`session-${id}`] }],
    },
  })

  assert.equal(rows.length, 1, '同一个会话必须只有一行')
  assert.equal(rows[0].workspaceTitle, '真实标题')
  assert.equal(rows[0].live, true)
  assert.deepEqual(rows[0].reasons, [], '记账里有的会话不该被标成孤儿')
})

// ---------------------------------------------------------------------------
// id 两种拼写下的边界：闸门、agent、记账都必须两种都认
// ---------------------------------------------------------------------------

test('磁盘上没有目录时什么都不做：不停 agent、不动记账，直接 TARGET_NOT_FOUND', async (t) => {
  // 早期版本先清了记账才报「找不到」：一次 404 背后其实改动了工作区。
  const sessions = tempSessionsRoot(t)
  const calls = []
  const workspaceRegistry = {
    list: () => [{ id: 'ws-1', sessionIds: ['ghost'], detachSession: async (id) => { calls.push(`detach:${id}`) } }],
    archivedSessionIds: ['ghost'],
    unarchiveSession: async (id) => { calls.push(`unarchive:${id}`) },
  }
  const agents = { get: () => ({ status: 'running', cancel: () => calls.push('cancel'), whenIdle: async () => {} }) }

  await assert.rejects(
    () => deleteSession({ sessionsRoot: sessions, agents, workspaceRegistry }, 'ghost'),
    (error) => error.code === ERROR_CODES.targetNotFound,
  )
  assert.deepEqual(calls, [], '★ 报「找不到」时不能有任何副作用')
})

test('记账用带前缀拼写、请求用裸拼写时，记账同样被解除（用记账里那一种拼写）', async (t) => {
  const sessions = tempSessionsRoot(t)
  const id = 'aa11bb22-0000-0000-0000-000000000009'
  makeSessionDir(sessions, '--D-work-alpha--', `session-${id}`)
  const detached = []
  const calls = []
  const workspaceRegistry = {
    list: () => [{ id: 'ws-1', sessionIds: [`session-${id}`], detachSession: async (target) => { detached.push(target) } }],
    archivedSessionIds: [`session-${id}`],
    pinnedSessionIds: [`session-${id}`],
    unarchiveSession: async (target) => { calls.push(`unarchive:${target}`) },
    unpinSession: async (target) => { calls.push(`unpin:${target}`) },
  }

  const result = await deleteSession({ sessionsRoot: sessions, workspaceRegistry }, id)

  assert.deepEqual(detached, [`session-${id}`], '★ 必须用记账里的拼写去解除')
  assert.deepEqual(calls.sort(), [`unarchive:session-${id}`, `unpin:session-${id}`])
  assert.equal(result.detached, true)
})

test('记账里没有这个会话时 detached 如实为 false，并给出说明（不是写死的 true）', async (t) => {
  const sessions = tempSessionsRoot(t)
  const id = 'aa11bb22-0000-0000-0000-000000000010'
  makeSessionDir(sessions, '--D-work-alpha--', id)

  const result = await deleteSession({
    sessionsRoot: sessions,
    workspaceRegistry: { list: () => [{ id: 'ws-1', sessionIds: ['other'], detachSession: async () => {} }] },
  }, id)

  assert.equal(result.removed.length, 1, '目录照常删除')
  assert.equal(result.detached, false, '★ 记账没动就不能报 detached: true')
  assert.equal(result.workspace.detached, false)
  assert.match(result.workspace.warnings.join('\n'), /没有找到这个会话/)
})

test('stopAgentIfRunning 用另一种拼写也能找到运行中的 agent', async () => {
  const cancelled = []
  const agents = {
    get: (id) => (id === 'session-abc'
      ? { status: 'running', cancel: () => cancelled.push(id), whenIdle: async () => {} }
      : undefined),
  }
  const result = await stopAgentIfRunning(agents, 'abc', 100)
  assert.equal(result.stopped, true)
  assert.deepEqual(cancelled, ['session-abc'])
})

test('listSessions：只剩磁盘目录的会话，store 里以带前缀拼写活着时也标成 live', (t) => {
  // 磁盘目录名会被归一成去掉前缀的 id；早期实现用归一后的 id 去查活会话，
  // 于是带前缀拼写活着的会话被标成「不活跃」，前端预检放行。
  const sessions = tempSessionsRoot(t)
  makeSessionDir(sessions, '--D-work-alpha--', 'session-abc')

  const rows = listSessions({ sessionsRoot: sessions, liveSessionIds: ['session-abc'] })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionId, 'abc')
  assert.equal(rows[0].live, true, '★ 两种拼写任一活着就算活着')
})

// ---------------------------------------------------------------------------
// 不留残留：子代理后代、投影缓存
// ---------------------------------------------------------------------------

/**
 * 造一个带真实会话头的会话目录：多帧 zstd，第一帧是会话头，后面再接一帧事件
 * （和真实日志同形，验证「只解第一帧」的读法）。
 */
function makeSessionWithHeader(sessionsRoot, slug, dirName, header) {
  const dir = path.join(sessionsRoot, slug, dirName)
  mkdirSync(dir, { recursive: true })
  const head = zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, createdAt: 1, ...header }) + '\n'))
  const body = zstdCompressSync(Buffer.from(JSON.stringify({ type: 'turn/start', seq: 0, data: { turn: 1 } }) + '\n'))
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([head, body]))
  return dir
}

/** 记账式的假投影缓存表（与 storage domain 的 KvTable.delete 同形）。 */
function fakeCacheTable(keys) {
  const store = new Set(keys)
  return {
    store,
    async delete(key) {
      return store.delete(key)
    },
  }
}

test('readSessionHeader 只解第一帧，读出多帧日志的会话头', (t) => {
  const sessions = tempSessionsRoot(t)
  const dir = makeSessionWithHeader(sessions, '--D-work--', 'abc', { id: 'abc', origin: 'subagent', parentSession: 'session-p' })
  const header = readSessionHeader(dir)
  assert.equal(header.id, 'abc')
  assert.equal(header.origin, 'subagent')
  assert.equal(header.parentSession, 'session-p')
  // 不是 zstd 的文件读不出来，但不抛错。
  assert.equal(readSessionHeader(makeSessionDir(sessions, '--D-work--', 'stub')), undefined)
})

test('★ 删除会话时一并删掉它派生的子代理会话（递归），fork 与无关会话不动', async (t) => {
  // 实测：父会话头里是 `session-<uuid>`，子代理目录是裸 uuid；子代理只认 origin=subagent。
  const sessions = tempSessionsRoot(t)
  const parent = makeSessionWithHeader(sessions, '--D-work--', 'session-p1', { id: 'session-p1' })
  const child = makeSessionWithHeader(sessions, '--D-work--', 'c1', { id: 'c1', origin: 'subagent', parentSession: 'session-p1' })
  const grandchild = makeSessionWithHeader(sessions, '--D-work--', 'g1', { id: 'g1', origin: 'subagent', parentSession: 'c1' })
  const fork = makeSessionWithHeader(sessions, '--D-work--', 'f1', { id: 'f1', origin: 'fork', parentSession: 'session-p1' })
  const other = makeSessionWithHeader(sessions, '--D-work--', 'o1', { id: 'o1', origin: 'subagent', parentSession: 'session-zz' })
  const cache = fakeCacheTable(['session-p1', 'c1', 'g1', 'f1', 'o1'])

  const result = await deleteSession({ sessionsRoot: sessions, projectionCache: cache }, 'session-p1')

  assert.deepEqual(result.descendants, ['c1', 'g1'])
  for (const dir of [parent, child, grandchild]) assert.equal(existsSync(dir), false, `${dir} 必须被删掉`)
  assert.equal(existsSync(fork), true, 'fork 是独立对话，不能删')
  assert.equal(existsSync(other), true, '别的会话的子代理不能删')
  assert.deepEqual([...cache.store].sort(), ['f1', 'o1'], '★ 投影缓存里目标与后代的记录都要清掉')
  assert.deepEqual(result.projectionCache.removed.sort(), ['c1', 'g1', 'session-p1'])
})

test('子代理后代里有一个活着，整次删除都拒绝，什么都不动', async (t) => {
  const sessions = tempSessionsRoot(t)
  const parent = makeSessionWithHeader(sessions, '--D-work--', 'session-p2', { id: 'session-p2' })
  const child = makeSessionWithHeader(sessions, '--D-work--', 'c2', { id: 'c2', origin: 'subagent', parentSession: 'session-p2' })
  const cache = fakeCacheTable(['session-p2', 'c2'])
  const detached = []
  const workspaceRegistry = { list: () => [{ id: 'ws', sessionIds: ['session-p2'], detachSession: async (id) => detached.push(id) }] }

  await assert.rejects(
    () => deleteSession({ sessionsRoot: sessions, projectionCache: cache, workspaceRegistry, isLive: (id) => id === 'c2' }, 'session-p2'),
    (error) => {
      assert.equal(error.code, ERROR_CODES.sessionLive)
      assert.match(error.message, /子代理会话 c2/)
      return true
    },
  )
  assert.equal(existsSync(parent), true)
  assert.equal(existsSync(child), true)
  assert.deepEqual(detached, [], '记账不能动')
  assert.equal(cache.store.size, 2, '缓存不能动')
})

test('投影缓存两种拼写都删；缓存服务不可用时如实回报，不假装清理成功', async () => {
  const cache = fakeCacheTable(['session-x', 'x', 'y'])
  const removed = await removeProjectionCache(cache, ['x'])
  assert.equal(removed.available, true)
  assert.deepEqual(removed.removed.sort(), ['session-x', 'x'])
  assert.deepEqual([...cache.store], ['y'])

  const missing = await removeProjectionCache(undefined, ['x'])
  assert.equal(missing.available, false)
  assert.match(missing.warnings.join('\n'), /投影缓存服务不可用/)

  const failing = await removeProjectionCache({ delete: async () => { throw new Error('写链断了') } }, ['x'])
  assert.match(failing.failures.join('\n'), /写链断了/)
})

test('读不出会话头的目录不会被当成后代删掉，并给出说明', (t) => {
  const sessions = tempSessionsRoot(t)
  makeSessionWithHeader(sessions, '--D-work--', 'session-p3', { id: 'session-p3' })
  makeSessionDir(sessions, '--D-work--', 'broken')
  const lineage = findSubagentDescendants(sessions, 'session-p3')
  assert.deepEqual(lineage.descendants, [])
  assert.match(lineage.warnings.join('\n'), /1 个会话目录读不出会话头/)
})
