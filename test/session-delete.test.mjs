/**
 * 会话删除的离线测试。
 *
 * 全部文件操作都在一个临时目录里做，测试结束即删；**绝不触碰真实的 `$DSH_HOME`**。
 * 重点覆盖：两种 id 拼写、活会话被拒、删不净就不解除记账、记账不可用如实回报。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { ERROR_CODES, assertSessionId, sessionDirNames } from '../src/shared.mjs'
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

test('活会话也能删：先停 agent、再删目录，并在结果里如实标注 wasLive', async (t) => {
  const sessions = tempSessionsRoot(t)
  const id = 'aa11bb22-0000-0000-0000-000000000003'
  const dir = makeSessionDir(sessions, '--D-work-alpha--', id)
  const cancelled = []
  const agents = {
    get: (target) => (target === id
      ? { status: 'running', cancel: (cause) => cancelled.push(cause), whenIdle: async () => {} }
      : undefined),
  }

  // v1.2.0 起活会话不再是拒绝理由：实测（0.2.1-alpha.2）写句柄带 FILE_SHARE_DELETE，目录删得掉、
  // 也不会被写回来。内存里那条 store 记录仍然摘不掉，所以如实标 wasLive。
  const slept = []
  const result = await deleteSession({
    sessionsRoot: sessions,
    agents,
    isLive: (target) => target === id,
    sleep: async (ms) => { slept.push(ms) },
  }, id)

  assert.equal(existsSync(dir), false, '★ 活会话的目录必须被真的删掉')
  assert.equal(result.wasLive, true)
  assert.deepEqual(result.liveDescendants, [])
  assert.deepEqual(cancelled, [{ kind: 'user' }], '删之前必须先把它停掉')
  assert.ok(slept.length >= 1, '活会话要复检投影缓存（收尾写入会晚一步）')
})

test('活会话删完、投影缓存被收尾写入写回来一次时，复检要再清掉', async (t) => {
  // 实测（0.2.1-alpha.2）：删一个还在跑的会话时，投影缓存就在删除的同一秒里又被写回一份。
  // 只清一次会留下一个孤儿缓存文件——这条用例把「复检」钉住。
  const sessions = tempSessionsRoot(t)
  const id = 'aa11bb22-0000-0000-0000-000000000004'
  makeSessionDir(sessions, '--D-work-alpha--', id)
  const store = new Set([id])
  let rewrote = 0
  const table = {
    async delete(key) {
      const had = store.delete(key)
      // 第一次成功删除之后，模拟会话收尾时又把这一份写了回来（只发生一次）。
      if (had && rewrote === 0) {
        rewrote += 1
        store.add(id)
      }
      return had
    },
  }
  const slept = []

  const result = await deleteSession({
    sessionsRoot: sessions,
    isLive: () => true,
    projectionCache: table,
    sleep: async (ms) => { slept.push(ms) },
  }, id)

  assert.equal(store.size, 0, '★ 被写回来的那一份必须再清掉')
  assert.ok(result.projectionCache.removed.filter((key) => key === id).length >= 2, '两次删除都要如实记进 removed')
  assert.ok(slept.length >= 1 && slept.length <= 3, '复检次数要有上限，不能一直等下去')
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
  // 注意：只有目标**活在本进程里**（刚开、日志还没落盘）时才保持这个行为；不活的、只剩记账的是「幽灵会话」，
  // 会被清掉（见本文件末尾的幽灵会话用例）。所以这里 isLive 为真。
  const sessions = tempSessionsRoot(t)
  const calls = []
  const workspaceRegistry = {
    list: () => [{ id: 'ws-1', sessionIds: ['ghost'], detachSession: async (id) => { calls.push(`detach:${id}`) } }],
    archivedSessionIds: ['ghost'],
    unarchiveSession: async (id) => { calls.push(`unarchive:${id}`) },
  }
  const agents = { get: () => ({ status: 'running', cancel: () => calls.push('cancel'), whenIdle: async () => {} }) }

  await assert.rejects(
    () => deleteSession({ sessionsRoot: sessions, agents, workspaceRegistry, isLive: (id) => id === 'ghost' }, 'ghost'),
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

test('活着的子代理后代也一起删掉，只是会登记进 liveDescendants', async (t) => {
  const sessions = tempSessionsRoot(t)
  const parent = makeSessionWithHeader(sessions, '--D-work--', 'session-p2', { id: 'session-p2' })
  const child = makeSessionWithHeader(sessions, '--D-work--', 'c2', { id: 'c2', origin: 'subagent', parentSession: 'session-p2' })
  const cache = fakeCacheTable(['session-p2', 'c2'])
  const detached = []
  const workspaceRegistry = { list: () => [{ id: 'ws', sessionIds: ['session-p2'], detachSession: async (id) => detached.push(id) }] }

  const result = await deleteSession({ sessionsRoot: sessions, projectionCache: cache, workspaceRegistry, isLive: (id) => id === 'c2' }, 'session-p2')

  assert.equal(existsSync(parent), false)
  assert.equal(existsSync(child), false, '★ 活着的子代理目录同样要删掉')
  assert.deepEqual(result.liveDescendants, ['c2'])
  assert.deepEqual(detached, ['session-p2'], '记账照常解除')
  assert.equal(cache.store.size, 0, '缓存照常清空')
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

// ---------------------------------------------------------------------------
// 回归：id 为 "." / "session-" / "session-." 时，不得命中整个 slug 目录
// ---------------------------------------------------------------------------

/** 仓库根目录：这组用例的夹具建在这里的一次性目录里，不依赖 os.tmpdir()。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 一次性夹具目录的序号：同一进程里多个用例各取各的，互不覆盖。 */
let fixtureSeq = 0

/** 在仓库工作区里造一个一次性 `sessions` 根；用例结束即删（`*.tmp` 已被 .gitignore 忽略）。 */
function workspaceSessionsRoot(t) {
  fixtureSeq += 1
  const root = path.join(REPO_ROOT, `.fixture-session-delete-${process.pid}-${fixtureSeq}.tmp`)
  const sessions = path.join(root, 'sessions')
  mkdirSync(sessions, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return sessions
}

/** 两个 slug 下各放几个会话目录（含 UUID、session-<UUID>、session-<n> 三种合法拼写），返回全部目录路径。 */
function seedTwoWorkspaces(sessions) {
  return [
    makeSessionDir(sessions, '--D-work-alpha--', '1afe9c3b-fd0c-4d6f-9ecf-a1f6261ad721'),
    makeSessionDir(sessions, '--D-work-alpha--', 'session-58a6c1c1-074e-4fcb-af54-04a234428ad3'),
    makeSessionDir(sessions, '--D-work-alpha--', 'session-7'),
    makeSessionDir(sessions, '--D-work-beta--', 'aa11bb22-0000-0000-0000-000000000099'),
    makeSessionDir(sessions, '--D-work-beta--', 'session-8'),
  ].sort()
}

/** 盘上 sessions 根下「slug/会话目录」两级的快照（排序），用来断言「一个都不少」。 */
function snapshotSessionDirs(sessions) {
  const out = []
  for (const slug of readdirSync(sessions, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue
    for (const entry of readdirSync(path.join(sessions, slug.name), { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(path.join(sessions, slug.name, entry.name))
    }
  }
  return out.sort()
}

const DANGEROUS_IDS = ['.', 'session-', 'session-.']

test('assertSessionId 拒绝 "." / "session-" / "session-."（INVALID_REQUEST），并保留 ".." 与长度检查', () => {
  for (const id of [...DANGEROUS_IDS, '..', 'session-..', '-a', '.a', 'a/b', 'a\\b', 'a'.repeat(201)]) {
    assert.throws(() => assertSessionId(id), (error) => error.code === ERROR_CODES.invalidRequest, `${JSON.stringify(id)} 必须被拒`)
  }
  // 合法拼写不能回归。
  for (const id of ['1afe9c3b-fd0c-4d6f-9ecf-a1f6261ad721', 'session-58a6c1c1-074e-4fcb-af54-04a234428ad3', 'session-7', 'abc', 'a.b_c:d']) {
    assert.equal(assertSessionId(id), id)
  }
})

test('sessionDirNames 不产出空串、"."、".." 或含路径分隔符的名字', () => {
  for (const id of [...DANGEROUS_IDS, '..', 'session-..', 'a/b', 'a\\b']) {
    for (const name of sessionDirNames(id)) {
      assert.notEqual(name, '', `${JSON.stringify(id)} 不能产出空串`)
      assert.notEqual(name, '.')
      assert.notEqual(name, '..')
      assert.doesNotMatch(name, /[\\/]/)
    }
  }
  assert.deepEqual(sessionDirNames('session-'), ['session-'], '去前缀后的空串被滤掉')
  assert.deepEqual(sessionDirNames('.'), ['session-.'], '"." 本身被滤掉')
  assert.deepEqual(sessionDirNames('session-.'), ['session-.'], '去前缀后的 "." 被滤掉')
  // 合法拼写照旧两种都在。
  assert.deepEqual(sessionDirNames('session-7'), ['session-7', '7'])
  assert.deepEqual(sessionDirNames('abc'), ['abc', 'session-abc'])
})

test('★ 绕过校验直接调 findSessionDirs：三个危险 id 找不到任何目录', (t) => {
  const sessions = workspaceSessionsRoot(t)
  seedTwoWorkspaces(sessions)
  for (const id of [...DANGEROUS_IDS, '..', '']) {
    assert.deepEqual(findSessionDirs(sessions, id), [], `${JSON.stringify(id)} 不能命中任何目录（尤其不能命中 slug 目录本身）`)
  }
})

test('★ 绕过校验直接调 deleteSession：三个危险 id 都是 TARGET_NOT_FOUND，别的会话目录一个都不少', async (t) => {
  const sessions = workspaceSessionsRoot(t)
  const seeded = seedTwoWorkspaces(sessions)
  const calls = []
  const workspaceRegistry = {
    list: () => [{ id: 'ws', sessionIds: DANGEROUS_IDS, detachSession: async (id) => { calls.push(`detach:${id}`) } }],
  }
  const agents = { get: () => ({ status: 'running', cancel: () => calls.push('cancel'), whenIdle: async () => {} }) }

  for (const id of DANGEROUS_IDS) {
    await assert.rejects(
      () => deleteSession({ sessionsRoot: sessions, agents, workspaceRegistry }, id),
      (error) => error.code === ERROR_CODES.targetNotFound,
      `${JSON.stringify(id)} 必须 TARGET_NOT_FOUND`,
    )
    assert.deepEqual(snapshotSessionDirs(sessions), seeded, `★ 删 ${JSON.stringify(id)} 之后别的会话目录一个都不能少`)
  }
  assert.deepEqual(calls, [], '找不到就不能有任何副作用（不停 agent、不动记账）')
})

test('合法 id 仍能正常删除：UUID、session-<UUID>、session-<n>，且只删各自那一个', async (t) => {
  const sessions = workspaceSessionsRoot(t)
  const seeded = seedTwoWorkspaces(sessions)
  const remaining = new Set(seeded)
  for (const [id, dirName] of [
    ['1afe9c3b-fd0c-4d6f-9ecf-a1f6261ad721', '1afe9c3b-fd0c-4d6f-9ecf-a1f6261ad721'],
    ['session-58a6c1c1-074e-4fcb-af54-04a234428ad3', 'session-58a6c1c1-074e-4fcb-af54-04a234428ad3'],
    ['session-7', 'session-7'],
    // 另一种拼写也要认：请求裸 `8`，磁盘上是 `session-8`。
    ['8', 'session-8'],
  ]) {
    assertSessionId(id)
    const target = seeded.find((dir) => path.basename(dir) === dirName)
    const result = await deleteSession({ sessionsRoot: sessions }, id)
    assert.deepEqual(result.removed, [target])
    remaining.delete(target)
    assert.deepEqual(snapshotSessionDirs(sessions), [...remaining].sort(), `删 ${id} 只能少它自己`)
  }
  assert.deepEqual(snapshotSessionDirs(sessions), [seeded.find((dir) => path.basename(dir) === 'aa11bb22-0000-0000-0000-000000000099')])
})

// ---------------------------------------------------------------------------
// 回归：第一帧的压缩内容里偶然出现 zstd 魔数时，会话头不能被切短而读不出来
// ---------------------------------------------------------------------------

/** zstd 帧魔数。 */
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 手工拼一个只含一个 Raw 块的 zstd 帧：内容原样放在帧里，所以内容里的字节**一定**原样出现在压缩数据中。
 *
 * 靠 `zstdCompressSync` 让假魔数「碰巧」留在压缩流里不可靠（压缩器会换成 Huffman / 匹配编码），
 * 夹具必须是确定的。帧格式：魔数 | 帧头描述符 0x20（Single_Segment、1 字节内容大小）| 内容大小 |
 * 块头（3 字节小端：大小<<3 | 类型 Raw<<1 | 最后一块）| 原始内容。
 */
function rawZstdFrame(content) {
  assert.ok(content.length < 256, 'Raw 帧夹具只支持 1 字节内容大小')
  const blockHeader = (content.length << 3) | 1
  return Buffer.concat([
    ZSTD_MAGIC_BYTES,
    Buffer.from([0x20, content.length]),
    Buffer.from([blockHeader & 0xff, (blockHeader >> 8) & 0xff, (blockHeader >> 16) & 0xff]),
    content,
  ])
}

/** 一个字符串字段里**确实**带着魔数四字节的会话头帧（假魔数落在第一帧内部）。 */
function headerFrameWithFakeMagic(header, copies = 1) {
  const [before, after] = JSON.stringify({ type: 'session', version: 4, createdAt: 1, ...header, pad: '@@PAD@@' }).split('@@PAD@@')
  const pads = []
  for (let i = 0; i < copies; i += 1) pads.push(ZSTD_MAGIC_BYTES, Buffer.from(`-gap-${i}-`))
  // 字符串里塞原始字节：解压后 toString('utf8') 会把它们变成替换字符，JSON 仍然合法。
  const frame = rawZstdFrame(Buffer.concat([Buffer.from(before), ...pads, Buffer.from(`${after}\n`)]))
  // 夹具自检：这确实是一个能被 zstd 正常解开的帧。
  assert.ok(zstdDecompressSync(frame).toString('utf8').includes(`"id":"${header.id}"`))
  return frame
}

/** 在仓库工作区里写一个会话目录：给定的若干帧原样拼成日志文件。 */
function writeFramedSession(sessions, dirName, frames) {
  const dir = path.join(sessions, '--D-work--', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  return dir
}

const BODY_FRAME = () => zstdCompressSync(Buffer.from(JSON.stringify({ type: 'turn/start', seq: 0, data: { turn: 1 } }) + '\n'))

test('★ 第一帧压缩内容里含假魔数：会话头照样读得出来（不能被切短成 undefined）', (t) => {
  const sessions = workspaceSessionsRoot(t)
  const first = headerFrameWithFakeMagic({ id: 'c-magic', origin: 'subagent', parentSession: 'session-p-magic' })
  // 夹具前提：假魔数确实落在第一帧**内部**（不是第二帧的真魔数）。
  const fake = first.indexOf(ZSTD_MAGIC_BYTES, 4)
  assert.ok(fake > 4 && fake < first.length, `夹具里必须真的出现假魔数位置（实际 ${fake}，第一帧长 ${first.length}）`)
  const dir = writeFramedSession(sessions, 'c-magic', [first, BODY_FRAME()])

  const header = readSessionHeader(dir)

  assert.equal(header?.id, 'c-magic', '★ 旧实现在假魔数处切断第一帧，解压后的残缺 JSON 解析失败，于是返回 undefined')
  assert.equal(header.origin, 'subagent')
  assert.equal(header.parentSession, 'session-p-magic')
})

test('第一帧里有两处假魔数也能读（逐个候选位置往后试）', (t) => {
  const sessions = workspaceSessionsRoot(t)
  const first = headerFrameWithFakeMagic({ id: 'c-two', origin: 'subagent', parentSession: 'session-p-two' }, 2)
  const positions = []
  for (let at = first.indexOf(ZSTD_MAGIC_BYTES, 4); at !== -1; at = first.indexOf(ZSTD_MAGIC_BYTES, at + 1)) positions.push(at)
  assert.ok(positions.length >= 2, `夹具里要有至少两处假魔数（实际 ${positions}）`)
  const dir = writeFramedSession(sessions, 'c-two', [first, BODY_FRAME()])

  assert.equal(readSessionHeader(dir)?.id, 'c-two')
})

test('★ 第一帧带假魔数的子代理仍被认作后代，不再只留一条「读不出会话头」', async (t) => {
  const sessions = workspaceSessionsRoot(t)
  const parent = writeFramedSession(sessions, 'session-p-magic', [zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'session-p-magic' }) + '\n')), BODY_FRAME()])
  const child = writeFramedSession(sessions, 'c-magic', [headerFrameWithFakeMagic({ id: 'c-magic', origin: 'subagent', parentSession: 'session-p-magic' }), BODY_FRAME()])

  const lineage = findSubagentDescendants(sessions, 'session-p-magic')
  assert.deepEqual(lineage.descendants, ['c-magic'])
  assert.deepEqual(lineage.warnings, [], '读得出来就不该有「读不出会话头」的 warning')

  const result = await deleteSession({ sessionsRoot: sessions }, 'session-p-magic')
  assert.equal(existsSync(parent), false)
  assert.equal(existsSync(child), false, '★ 子代理会话必须跟着删，不能成孤儿')
  assert.deepEqual(result.descendants, ['c-magic'])
})

test('坏文件 / 非 zstd / 只有魔数 / 截断的帧：返回 undefined，不抛', (t) => {
  const sessions = workspaceSessionsRoot(t)
  const good = zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', id: 'x' }) + '\n'))
  const cases = {
    'not-zstd': [Buffer.from('plain text, definitely not zstd')],
    'only-magic': [ZSTD_MAGIC_BYTES],
    'magic-garbage': [ZSTD_MAGIC_BYTES, Buffer.from('garbage garbage garbage')],
    'truncated': [good.subarray(0, Math.floor(good.length / 2))],
    'empty': [Buffer.alloc(0)],
    'not-json': [zstdCompressSync(Buffer.from('this is not json\n'))],
    'json-scalar': [zstdCompressSync(Buffer.from('42\n'))],
  }
  for (const [name, frames] of Object.entries(cases)) {
    const dir = writeFramedSession(sessions, name, frames)
    assert.doesNotThrow(() => readSessionHeader(dir), name)
    assert.equal(readSessionHeader(dir), undefined, name)
  }
})

// ---------------------------------------------------------------------------
// 幽灵会话：只剩工作区记账、磁盘上已经没有目录
// ---------------------------------------------------------------------------

/** 带状态的假注册表：记账 / 归档 / 置顶三个集合，detach / unarchive / unpin 真的改它们，并记录调用。 */
function fakeGhostRegistry({ sessionIds = [], archived = [], pinned = [], detachFails = false } = {}) {
  const state = { sessionIds: new Set(sessionIds), archived: new Set(archived), pinned: new Set(pinned) }
  const calls = []
  const registry = {
    list: () => [{
      id: 'ws-1',
      title: 'alpha',
      path: 'D:\\work\\alpha',
      get sessionIds() { return [...state.sessionIds] },
      detachSession: async (id) => {
        calls.push(`detach:${id}`)
        if (detachFails) throw new Error('记账表锁住了')
        state.sessionIds.delete(id)
      },
    }],
    get archivedSessionIds() { return [...state.archived] },
    get pinnedSessionIds() { return [...state.pinned] },
    unarchiveSession: async (id) => { calls.push(`unarchive:${id}`); state.archived.delete(id) },
    unpinSession: async (id) => { calls.push(`unpin:${id}`); state.pinned.delete(id) },
  }
  return { registry, state, calls }
}

test('★ 幽灵会话（只在记账里、磁盘没有目录、进程里也没有）：记账 / 归档 / 置顶 / 投影缓存都被清，不停 agent、不删目录', async (t) => {
  const sessions = workspaceSessionsRoot(t)
  const seeded = seedTwoWorkspaces(sessions) // 别的会话，必须原封不动
  const id = 'ghost0000-0000-0000-0000-000000000001'
  const { registry, state, calls } = fakeGhostRegistry({ sessionIds: [id, 'other'], archived: [id], pinned: [id] })
  const cache = fakeCacheTable([id, `session-${id}`, 'unrelated'])
  const agentCalls = []
  const agents = { get: () => ({ status: 'running', cancel: () => agentCalls.push('cancel'), whenIdle: async () => {} }) }

  const result = await deleteSession({ sessionsRoot: sessions, agents, workspaceRegistry: registry, projectionCache: cache, isLive: () => false }, id)

  assert.equal(result.ghost, true)
  assert.deepEqual(result.removed, [], '没有目录可删')
  assert.deepEqual(result.dirs, [])
  assert.equal(result.detached, true)
  assert.equal(result.wasLive, false)
  assert.deepEqual([...state.sessionIds], ['other'], '★ 记账里只少了它')
  assert.equal(state.archived.size, 0, '★ 归档集合里的幽灵标记被清')
  assert.equal(state.pinned.size, 0, '★ 置顶集合里的幽灵标记被清')
  assert.deepEqual([...cache.store], ['unrelated'], '★ 投影缓存两种拼写都清')
  assert.deepEqual(agentCalls, [], '不停 agent')
  assert.deepEqual(snapshotSessionDirs(sessions), seeded, '别的会话目录一个都不少')
  assert.deepEqual(calls.sort(), [`detach:${id}`, `unarchive:${id}`, `unpin:${id}`].sort())
})

test('幽灵会话：记账里是带前缀的拼写、请求用裸拼写时，用记账里那一种去解除', async (t) => {
  const sessions = workspaceSessionsRoot(t)
  const id = 'ghost0000-0000-0000-0000-000000000002'
  const { registry, state, calls } = fakeGhostRegistry({ sessionIds: [`session-${id}`] })

  const result = await deleteSession({ sessionsRoot: sessions, workspaceRegistry: registry }, id)

  assert.equal(result.ghost, true)
  assert.deepEqual(calls, [`detach:session-${id}`])
  assert.equal(state.sessionIds.size, 0)
})

test('只在归档集合里的幽灵标记（工作区列表里已经没有它）也算「记账里有」，被清掉', async (t) => {
  const sessions = workspaceSessionsRoot(t)
  const { registry, state } = fakeGhostRegistry({ archived: ['gone-1'] })

  const result = await deleteSession({ sessionsRoot: sessions, workspaceRegistry: registry }, 'gone-1')

  assert.equal(result.ghost, true)
  assert.equal(result.workspace.unarchived, true)
  assert.equal(state.archived.size, 0)
})

test('★ 目标活着但磁盘上还没有目录（刚开、日志没落盘的新会话）：仍是 TARGET_NOT_FOUND，记账原封不动', async (t) => {
  const sessions = workspaceSessionsRoot(t)
  const id = 'fresh000-0000-0000-0000-000000000003'
  const { registry, state, calls } = fakeGhostRegistry({ sessionIds: [id], archived: [id], pinned: [id] })
  const cache = fakeCacheTable([id])

  // 两种拼写的活会话判断由调用方（路由的 findLiveSession）负责；deleteSession 只看它对目标 id 的回答。
  await assert.rejects(
    () => deleteSession({ sessionsRoot: sessions, workspaceRegistry: registry, projectionCache: cache, isLive: (target) => target === id }, id),
    (error) => error.code === ERROR_CODES.targetNotFound,
  )
  assert.deepEqual(calls, [], '★ 活会话没有目录时不能动记账')
  assert.deepEqual([...state.sessionIds], [id])
  assert.equal(state.archived.size, 1)
  assert.equal(state.pinned.size, 1)
  assert.deepEqual([...cache.store], [id], '投影缓存也不动')
})

test('磁盘和记账里都没有：仍是 TARGET_NOT_FOUND，什么都不碰', async (t) => {
  const sessions = workspaceSessionsRoot(t)
  const { registry, state, calls } = fakeGhostRegistry({ sessionIds: ['other'], archived: ['other'] })
  const cache = fakeCacheTable(['other', 'nowhere'])

  await assert.rejects(
    () => deleteSession({ sessionsRoot: sessions, workspaceRegistry: registry, projectionCache: cache }, 'nowhere'),
    (error) => error.code === ERROR_CODES.targetNotFound,
  )
  assert.deepEqual(calls, [])
  assert.deepEqual([...state.sessionIds], ['other'])
  assert.deepEqual([...cache.store].sort(), ['nowhere', 'other'], '连缓存里同名的记录也不动：没确认是幽灵就什么都不做')

  // 没有注册表（terminal-only）同理。
  await assert.rejects(
    () => deleteSession({ sessionsRoot: sessions }, 'nowhere'),
    (error) => error.code === ERROR_CODES.targetNotFound,
  )
})

test('磁盘上还留着以它为父的子代理目录：不算幽灵，仍是 TARGET_NOT_FOUND，子代理目录不动', async (t) => {
  const sessions = workspaceSessionsRoot(t)
  const id = 'ghost0000-0000-0000-0000-000000000004'
  const child = makeSessionWithHeader(sessions, '--D-work--', 'child-1', { id: 'child-1', origin: 'subagent', parentSession: `session-${id}` })
  const { registry, state, calls } = fakeGhostRegistry({ sessionIds: [id] })

  await assert.rejects(
    () => deleteSession({ sessionsRoot: sessions, workspaceRegistry: registry }, id),
    (error) => error.code === ERROR_CODES.targetNotFound,
  )
  assert.equal(existsSync(child), true)
  assert.deepEqual(calls, [])
  assert.equal(state.sessionIds.size, 1)
})

test('幽灵会话的记账清不掉（宿主抛错）：DELETE_FAILED，不假装成功，投影缓存也不动', async (t) => {
  const sessions = workspaceSessionsRoot(t)
  const id = 'ghost0000-0000-0000-0000-000000000005'
  const { registry } = fakeGhostRegistry({ sessionIds: [id], detachFails: true })
  const cache = fakeCacheTable([id])

  await assert.rejects(
    () => deleteSession({ sessionsRoot: sessions, workspaceRegistry: registry, projectionCache: cache }, id),
    (error) => error.code === ERROR_CODES.deleteFailed && /记账表锁住了/.test(error.message),
  )
  assert.deepEqual([...cache.store], [id])
})
