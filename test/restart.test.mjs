/**
 * 热重启纯逻辑的离线测试。
 *
 * 覆盖真正容易算错的地方：阻塞项归属（自己 / 后代 / 别的会话 / 后台任务）、限频的三道边界
 * （窗口边界、会话冷却、时钟回拨）、`--no-open` 的追加位置、启动规格的字段校验与 JSON 往返、
 * 状态文件的原子写与坏内容容错、续作消息模板、参数长度边界。
 *
 * 全部用假对象驱动，不碰真实的 `$DSH_HOME`；文件操作只在 `os.tmpdir()` 下建临时目录，测试结束即删。
 * 本机沙箱下 `node --test` 会因 spawn 走管道而假失败（AGENTS.local.md 第 2 节），所以直接跑：
 * `node test/restart.test.mjs`。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ERROR_CODES } from '../src/shared.mjs'
import {
  PENDING_MAX_AGE_MS,
  PENDING_STATES,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  SESSION_COOLDOWN_MS,
  appendNoOpen,
  assertRestartReason,
  assertResumeNote,
  blockerMessage,
  buildLaunchSpec,
  buildResumeMessage,
  checkRateLimit,
  clearPending,
  computeBlockers,
  isStale,
  newBootId,
  newRestartId,
  pushRateHistory,
  readJson,
  readLast,
  readPending,
  removeFile,
  restartDir,
  restartLogFile,
  writeJsonAtomic,
  writeLast,
  writePending,
} from '../src/restart.mjs'

/** 造一个临时「$DSH_HOME」，测试结束整棵删掉。 */
function tempHome(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-agent-control-restart-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** 一份完整可用的启动现场，供 `buildLaunchSpec` 的用例按需覆盖字段。 */
function launchInput(overrides = {}) {
  return {
    execPath: 'C:\\runtime\\node.exe',
    execArgv: ['--enable-source-maps'],
    argv: ['C:\\dsh\\bin.js', '--profile', 'example', 'web', '--port', '10727'],
    cwd: 'D:\\work\\example',
    env: { PATH: 'C:\\runtime', PORT: '10727' },
    oldPid: 4321,
    oldBootId: 'b-old',
    statusUrl: 'http://127.0.0.1:10727/api/agent-control/restart/status',
    logFile: 'C:\\home\\.dsh\\logs\\agent-control-restart-20260101-000000.log',
    restartId: 'r-old',
    now: 1_700_000_000_000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 阻塞项
// ---------------------------------------------------------------------------

test('computeBlockers：调用者自己不算阻塞，别的 running 会话算', () => {
  const blockers = computeBlockers({
    agents: [
      { id: 'caller', status: 'running', title: '我自己' },
      { id: 'other', status: 'running', title: '别的会话' },
      { id: 'idle-one', status: 'idle', title: '没在跑' },
    ],
    jobs: [],
    callerId: 'caller',
  })

  assert.deepEqual(blockers.sessions, [{ sessionId: 'other', title: '别的会话', descendant: false }])
  assert.deepEqual(blockers.jobs, [])
})

test('computeBlockers：多级后代算阻塞，且标出 descendant: true', () => {
  const blockers = computeBlockers({
    agents: [
      { id: 'caller', status: 'running' },
      { id: 'child', status: 'running', parentSessionId: 'caller' },
      { id: 'grandchild', status: 'running', parentSessionId: 'child' },
      { id: 'stranger', status: 'running', parentSessionId: 'someone-else' },
    ],
    jobs: [],
    callerId: 'caller',
  })

  assert.deepEqual(
    blockers.sessions.map((session) => [session.sessionId, session.descendant]),
    [['child', true], ['grandchild', true], ['stranger', false]],
  )
})

test('computeBlockers：非 running 的子代理与其他会话都不算阻塞', () => {
  const blockers = computeBlockers({
    agents: [
      { id: 'caller', status: 'running' },
      { id: 'idle-child', status: 'idle', parentSessionId: 'caller' },
      { id: 'done-child', status: 'completed', parentSessionId: 'caller' },
      { id: 'idle-other', status: 'idle' },
    ],
    jobs: [],
    callerId: 'caller',
  })

  assert.deepEqual(blockers.sessions, [])
})

test('computeBlockers：title 拿不到就是空串，不编造', () => {
  const blockers = computeBlockers({
    agents: [{ id: 'other', status: 'running' }, { id: 'named', status: 'running', title: '有标题' }],
    jobs: [],
    callerId: 'caller',
  })

  assert.deepEqual(blockers.sessions, [
    { sessionId: 'other', title: '', descendant: false },
    { sessionId: 'named', title: '有标题', descendant: false },
  ])
})

test('computeBlockers：session- 前缀与裸 id 指的是同一个会话', () => {
  const blockers = computeBlockers({
    agents: [
      { id: 'abc', status: 'running' },
      { id: 'session-kid', status: 'running', parentSessionId: 'session-abc' },
    ],
    jobs: [],
    callerId: 'session-abc',
  })

  // 自己（裸 id 拼写）被跳过；子代理两种拼写混用也照样认出父子关系。
  assert.deepEqual(blockers.sessions, [{ sessionId: 'session-kid', title: '', descendant: true }])
})

test('computeBlockers：父链成环时不当成后代，也不会转不出来', () => {
  const blockers = computeBlockers({
    agents: [
      { id: 'caller', status: 'running' },
      { id: 'a', status: 'running', parentSessionId: 'b' },
      { id: 'b', status: 'running', parentSessionId: 'a' },
    ],
    jobs: [],
    callerId: 'caller',
  })

  assert.deepEqual(blockers.sessions.map((session) => session.descendant), [false, false])
})

test('computeBlockers：后台任务 running / stopping 算阻塞，completed 不算', () => {
  const blockers = computeBlockers({
    agents: [],
    jobs: [
      { id: 'job-1', label: '跑测试', kind: 'shell', status: 'running' },
      { id: 'job-2', label: '收尾中', kind: 'shell', status: 'stopping' },
      { id: 'job-3', label: '早就完了', kind: 'shell', status: 'completed' },
    ],
    callerId: 'caller',
  })

  assert.deepEqual(blockers.jobs, [
    { id: 'job-1', label: '跑测试', kind: 'shell' },
    { id: 'job-2', label: '收尾中', kind: 'shell' },
  ])
})

test('computeBlockers：调用者自己的后台任务也算阻塞', () => {
  const blockers = computeBlockers({
    agents: [],
    jobs: [{ id: 'job-1', label: '我在跑的命令', kind: 'shell', status: 'running', ownerSessionId: 'caller' }],
    callerId: 'caller',
  })

  assert.equal(blockers.jobs.length, 1)
})

test('computeBlockers：agents / jobs 不是数组时拒绝，不假装没有阻塞', () => {
  assert.throws(
    () => computeBlockers({ agents: 'nope', jobs: [], callerId: 'caller' }),
    (error) => error.code === ERROR_CODES.invalidRequest,
  )
  assert.throws(
    () => computeBlockers({ agents: [], jobs: { running: 2 }, callerId: 'caller' }),
    (error) => error.code === ERROR_CODES.invalidRequest,
  )
  // 缺字段按「没有」处理：终端的 profile 里可能压根没有 jobs 服务。
  assert.deepEqual(computeBlockers({ callerId: 'caller' }), { sessions: [], jobs: [] })
})

// ---------------------------------------------------------------------------
// 阻塞文案
// ---------------------------------------------------------------------------

test('blockerMessage：没有阻塞时返回空串', () => {
  assert.equal(blockerMessage({ sessions: [], jobs: [] }), '')
  assert.equal(blockerMessage(undefined), '')
})

test('blockerMessage：只有会话时列出数量与标题', () => {
  const message = blockerMessage({
    sessions: [
      { sessionId: 's1', title: '修 bug' },
      { sessionId: 's2', title: '写文档' },
    ],
    jobs: [],
  })

  assert.match(message, /另有 2 个会话在运行/)
  assert.match(message, /修 bug/)
  assert.match(message, /写文档/)
  assert.match(message, /待其结束后再试/)
  assert.ok(!message.includes('后台任务'))
})

test('blockerMessage：会话 + 后台任务两段都写', () => {
  const message = blockerMessage({
    sessions: [{ sessionId: 's1', title: '修 bug' }],
    jobs: [{ id: 'j1' }, { id: 'j2' }],
  })

  assert.match(message, /另有 1 个会话在运行：修 bug/)
  assert.match(message, /另有 2 个后台任务在运行/)
  assert.match(message, /先结束或等待它们再试/)
})

test('blockerMessage：没有标题时用 sessionId，都没有也不编造', () => {
  assert.match(blockerMessage({ sessions: [{ sessionId: 's9', title: '' }], jobs: [] }), /：s9/)
  assert.match(blockerMessage({ sessions: [{ sessionId: '', title: '' }], jobs: [] }), /（未知会话）/)
})

// ---------------------------------------------------------------------------
// 限频
// ---------------------------------------------------------------------------

test('checkRateLimit：窗口内恰好第 3 次通过、第 4 次拒绝', () => {
  const now = 1_000_000_000
  const two = [{ at: now - 2000 }, { at: now - 1000 }]

  assert.deepEqual(checkRateLimit({ history: two, now, sessionId: 's1' }), { ok: true })

  const denied = checkRateLimit({ history: [...two, { at: now - 500 }], now, sessionId: 's1' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, ERROR_CODES.restartRateLimited)
  assert.ok(Number.isInteger(denied.retryAfterMs) && denied.retryAfterMs > 0, 'retryAfterMs 必须是正整数')
  assert.match(denied.message, /上限 3 次/)
  assert.match(denied.message, /等待约 \d+ 秒后再试/)
  // 最早那条出了窗口就能再来一次：等的是 now-2000 那条。
  assert.equal(denied.retryAfterMs, RATE_LIMIT_WINDOW_MS - 2000)
})

test('checkRateLimit：正好落在窗口边界上的条目不算在窗口内', () => {
  const now = 1_000_000_000
  const onEdge = Array.from({ length: RATE_LIMIT_MAX }, () => ({ at: now - RATE_LIMIT_WINDOW_MS }))
  assert.deepEqual(checkRateLimit({ history: onEdge, now, sessionId: 's1' }), { ok: true })

  const justInside = Array.from({ length: RATE_LIMIT_MAX }, () => ({ at: now - RATE_LIMIT_WINDOW_MS + 1 }))
  assert.equal(checkRateLimit({ history: justInside, now, sessionId: 's1' }).ok, false)
})

test('checkRateLimit：同一会话 60 秒冷却内再次请求被拒，retryAfterMs 为正', () => {
  const now = 5_000_000
  const denied = checkRateLimit({ history: [{ at: now - SESSION_COOLDOWN_MS + 1, sessionId: 's1' }], now, sessionId: 's1' })

  assert.equal(denied.ok, false)
  assert.equal(denied.code, ERROR_CODES.restartRateLimited)
  assert.equal(denied.retryAfterMs, 1)
  assert.match(denied.message, /同一会话/)
  assert.match(denied.message, /等待约 1 秒/)
})

test('checkRateLimit：同会话冷却正好满 60 秒就不再拦', () => {
  const now = 5_000_000
  const history = [{ at: now - SESSION_COOLDOWN_MS, sessionId: 's1' }]
  assert.deepEqual(checkRateLimit({ history, now, sessionId: 's1' }), { ok: true })
  // 冷却只管它自己那个会话，别的会话不受影响。
  assert.deepEqual(checkRateLimit({ history, now, sessionId: 's2' }), { ok: true })
})

test('checkRateLimit：时钟回拨（记录里的 at 晚于 now）按拒绝处理', () => {
  const now = 5_000_000
  const denied = checkRateLimit({ history: [{ at: now + 3000, sessionId: 's9' }], now, sessionId: 's1' })

  assert.equal(denied.ok, false)
  assert.equal(denied.retryAfterMs, 3000)
  assert.match(denied.message, /时钟回拨/)
})

test('checkRateLimit：at 不是有限数的记录不参与计算', () => {
  const now = 5_000_000
  const history = [{ at: 'x' }, { at: Number.NaN }, { at: now - 10 }]
  assert.deepEqual(checkRateLimit({ history, now, sessionId: 's1' }), { ok: true })
})

test('checkRateLimit：history 不是数组、now 不是有限数时拒绝', () => {
  assert.throws(
    () => checkRateLimit({ history: 'nope', now: 1, sessionId: 's1' }),
    (error) => error.code === ERROR_CODES.invalidRequest,
  )
  assert.throws(
    () => checkRateLimit({ history: [], now: Number.NaN, sessionId: 's1' }),
    (error) => error.code === ERROR_CODES.invalidRequest,
  )
})

test('pushRateHistory：裁掉窗口外的旧条目，返回新数组且不改入参', () => {
  const now = 10_000_000
  const history = [
    { at: now - RATE_LIMIT_WINDOW_MS - 1, sessionId: 'old' },
    { at: now - 1000, sessionId: 'keep' },
  ]
  const snapshot = history.map((entry) => ({ ...entry }))

  const next = pushRateHistory(history, { at: now, sessionId: 'new', ok: true }, now)

  assert.notEqual(next, history, '必须返回新数组')
  assert.deepEqual(next.map((entry) => entry.sessionId), ['keep', 'new'])
  assert.deepEqual(history, snapshot, '入参不能被改')
})

test('pushRateHistory：缺 at 的新条目补成当下，缺 history 按空账本处理', () => {
  const now = 10_000_000
  const next = pushRateHistory(undefined, { sessionId: 'new' }, now)

  assert.equal(next.length, 1)
  assert.equal(next[0].at, now)
  assert.throws(
    () => pushRateHistory([], 'not-an-object', now),
    (error) => error.code === ERROR_CODES.invalidRequest,
  )
})

// ---------------------------------------------------------------------------
// --no-open
// ---------------------------------------------------------------------------

test('appendNoOpen：isWebApp 为 true 时追加到末尾', () => {
  const argv = ['C:\\dsh\\bin.js', '--profile', 'example', 'web', '--port', '10727']
  const next = appendNoOpen(argv, { isWebApp: true })

  assert.deepEqual(next, [...argv, '--no-open'])
})

test('appendNoOpen：isWebApp 为 false 或缺省时原样返回副本', () => {
  const argv = ['C:\\dsh\\bin.js', '--profile', 'example', 'terminal']

  assert.deepEqual(appendNoOpen(argv, { isWebApp: false }), argv)
  assert.deepEqual(appendNoOpen(argv), argv)
  assert.deepEqual(appendNoOpen(argv, {}), argv)
  // 别的 app 不认这个 flag，追加过去会变成用法错误——所以缺省绝不放行。
  assert.ok(!appendNoOpen(argv).includes('--no-open'))
})

test('appendNoOpen：已有 --no-open 时不重复追加', () => {
  const argv = ['C:\\dsh\\bin.js', '--profile', 'example', 'web', '--no-open']
  const next = appendNoOpen(argv, { isWebApp: true })

  assert.deepEqual(next, argv)
  assert.equal(next.filter((item) => item === '--no-open').length, 1)
})

test('appendNoOpen：追加在 -- 之前，-- 之后的内容一个都不动', () => {
  const argv = ['C:\\dsh\\bin.js', '--profile', 'example', 'web', '--', 'positional']
  const next = appendNoOpen(argv, { isWebApp: true })

  assert.deepEqual(next, ['C:\\dsh\\bin.js', '--profile', 'example', 'web', '--no-open', '--', 'positional'])
  assert.equal(next.indexOf('--no-open'), next.indexOf('--') - 1)
})

test('appendNoOpen：-- 之后的 --no-open 不算已有，仍按 web 规则追加', () => {
  const argv = ['C:\\dsh\\bin.js', 'web', '--', '--no-open']
  const next = appendNoOpen(argv, { isWebApp: true })

  assert.deepEqual(next, ['C:\\dsh\\bin.js', 'web', '--no-open', '--', '--no-open'])
})

test('appendNoOpen：返回新数组，原数组不变', () => {
  const argv = ['C:\\dsh\\bin.js', 'web']
  const snapshot = [...argv]
  const next = appendNoOpen(argv, { isWebApp: true })

  assert.notEqual(next, argv)
  assert.deepEqual(argv, snapshot)
  // 空 argv：没有 --no-open，调用方又说了「这是 web 应用」，于是照加（空 argv 本身过不了 buildLaunchSpec）。
  assert.deepEqual(appendNoOpen([], { isWebApp: true }), ['--no-open'])
  assert.deepEqual(appendNoOpen([], { isWebApp: false }), [])
})

// ---------------------------------------------------------------------------
// 启动规格
// ---------------------------------------------------------------------------

test('buildLaunchSpec：完整入参通过，键名符合冻结契约', () => {
  const spec = buildLaunchSpec(launchInput())

  assert.deepEqual(Object.keys(spec), [
    'execPath', 'execArgv', 'argv', 'cwd', 'env', 'oldPid', 'oldBootId', 'statusUrl', 'logFile', 'restartId', 'createdAt',
  ])
  assert.equal(spec.execPath, 'C:\\runtime\\node.exe')
  assert.deepEqual(spec.execArgv, ['--enable-source-maps'])
  assert.equal(spec.oldPid, 4321)
  assert.equal(spec.oldBootId, 'b-old')
  assert.equal(spec.createdAt, 1_700_000_000_000)
  assert.equal(spec.env.PORT, '10727')
})

test('buildLaunchSpec：返回值可以 JSON 往返（含 env 全是字符串）', () => {
  const spec = buildLaunchSpec(launchInput())
  const roundTrip = JSON.parse(JSON.stringify(spec))

  assert.deepEqual(roundTrip, spec)
  for (const value of Object.values(spec.env)) {
    assert.equal(typeof value, 'string')
  }
  // 缺省的可选字段写成 null，而不是在序列化时把键丢掉。
  const bare = buildLaunchSpec(launchInput({ oldBootId: undefined, statusUrl: null, logFile: '', restartId: undefined }))
  assert.deepEqual(JSON.parse(JSON.stringify(bare)), bare)
  assert.deepEqual([bare.oldBootId, bare.statusUrl, bare.logFile, bare.restartId], [null, null, null, null])
})

test('buildLaunchSpec：execPath / argv / cwd / oldPid 缺失或非法一律抛 RESTART_UNSUPPORTED', () => {
  const cases = [
    { input: { execPath: '' }, name: 'execPath 空' },
    { input: { execPath: undefined }, name: 'execPath 缺' },
    { input: { argv: [] }, name: 'argv 空数组' },
    { input: { argv: undefined }, name: 'argv 缺' },
    { input: { argv: ['ok', ''] }, name: 'argv 里有空串' },
    { input: { cwd: '' }, name: 'cwd 空' },
    { input: { cwd: '   ' }, name: 'cwd 全是空白' },
    { input: { oldPid: 0 }, name: 'oldPid 为 0' },
    { input: { oldPid: -1 }, name: 'oldPid 为负' },
    { input: { oldPid: '4321' }, name: 'oldPid 是字符串' },
    { input: { env: {} }, name: 'env 空对象' },
    { input: { env: 'PATH=x' }, name: 'env 不是对象' },
    { input: { execArgv: '--enable-source-maps' }, name: 'execArgv 不是数组' },
    { input: { statusUrl: 42 }, name: 'statusUrl 不是字符串' },
    { input: { now: Number.NaN }, name: 'now 不是有限数' },
  ]

  for (const { input, name } of cases) {
    assert.throws(
      () => buildLaunchSpec(launchInput(input)),
      (error) => error.code === ERROR_CODES.restartUnsupported && typeof error.message === 'string' && error.message !== '',
      `${name} 必须抛 RESTART_UNSUPPORTED`,
    )
  }
})

test('buildLaunchSpec：execArgv 缺省为空数组', () => {
  assert.deepEqual(buildLaunchSpec(launchInput({ execArgv: undefined })).execArgv, [])
  assert.deepEqual(buildLaunchSpec(launchInput({ execArgv: [] })).execArgv, [])
})

test('buildLaunchSpec：env 的非字符串值 String()，null / undefined 丢弃', () => {
  const spec = buildLaunchSpec(launchInput({ env: { A: '1', B: 2, C: true, D: null, E: undefined } }))

  assert.deepEqual(spec.env, { A: '1', B: '2', C: 'true' })
})

test('buildLaunchSpec：不追加 --no-open（那是调用方用 appendNoOpen 备好的）', () => {
  const argv = ['C:\\dsh\\bin.js', '--profile', 'example', 'web']
  const spec = buildLaunchSpec(launchInput({ argv }))

  assert.deepEqual(spec.argv, argv)
  assert.ok(!spec.argv.includes('--no-open'))

  const prepared = appendNoOpen(argv, { isWebApp: true })
  assert.deepEqual(buildLaunchSpec(launchInput({ argv: prepared })).argv, [...argv, '--no-open'])
})

// ---------------------------------------------------------------------------
// 过期判断
// ---------------------------------------------------------------------------

test('isStale：新鲜 / 过期 / createdAt 非法', () => {
  const now = 10_000_000

  assert.equal(isStale({ createdAt: now - 1000 }, now), false)
  assert.equal(isStale({ createdAt: now - 1000 }, now, 500), true)
  assert.equal(isStale({ createdAt: now - PENDING_MAX_AGE_MS }, now), false, '正好等于上限不算过期')
  assert.equal(isStale({ createdAt: now - PENDING_MAX_AGE_MS - 1 }, now), true)

  assert.equal(isStale({ createdAt: 'yesterday' }, now), true)
  assert.equal(isStale({}, now), true)
  assert.equal(isStale(undefined, now), true)
  assert.equal(isStale(null, now), true)
})

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

test('状态文件：writePending → readPending 往返，目录会被建出来', (t) => {
  const dir = path.join(tempHome(t), 'agent-control', 'restart')
  const entry = { restartId: 'r-1', state: PENDING_STATES.scheduled, reason: '装了新插件', createdAt: 1 }

  assert.equal(writePending(dir, entry), entry)
  assert.deepEqual(readPending(dir), entry)
})

test('状态文件：默认权限收紧到仅当前用户（POSIX 上验 0o600）', (t) => {
  const dir = path.join(tempHome(t), 'agent-control', 'restart')
  const file = path.join(dir, 'spec.json')
  writeJsonAtomic(file, { env: { PATH: 'x' } })

  if (process.platform === 'win32') {
    // Windows 上 POSIX 权限位没有意义（Node 只映射只读位），这里只确认内容写得进去。
    assert.deepEqual(readJson(file), { env: { PATH: 'x' } })
    return
  }
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('状态文件：坏 JSON / 非对象 / 读不到都返回 undefined，不抛', (t) => {
  const root = tempHome(t)
  const dir = path.join(root, 'agent-control', 'restart')
  mkdirSync(dir, { recursive: true })

  // 读不到
  assert.equal(readPending(dir), undefined)
  assert.equal(readLast(dir), undefined)
  assert.equal(readJson(path.join(dir, 'nope.json')), undefined)

  // 坏 JSON
  writeFileSync(path.join(dir, 'pending.json'), '{ 这不是 JSON', 'utf8')
  assert.equal(readPending(dir), undefined)

  // 合法 JSON 但顶层不是对象
  for (const text of ['[1,2,3]', 'null', '"text"', '42']) {
    writeFileSync(path.join(dir, 'pending.json'), text, 'utf8')
    assert.equal(readPending(dir), undefined, `顶层是 ${text} 时应当当没有`)
  }
})

test('状态文件：写入后目录里只剩目标文件，没有残留临时文件', (t) => {
  const dir = path.join(tempHome(t), 'agent-control', 'restart')

  writePending(dir, { state: PENDING_STATES.helperStarted, createdAt: 1 })
  writeLast(dir, { restartId: 'r-1', ok: true })
  writeJsonAtomic(path.join(dir, 'spec.json'), { execPath: 'x' })

  assert.deepEqual(readdirSync(dir).sort(), ['last.json', 'pending.json', 'spec.json'])
})

test('状态文件：原子写覆盖旧内容，写完之后读回来是新值', (t) => {
  const dir = path.join(tempHome(t), 'agent-control', 'restart')

  writePending(dir, { state: PENDING_STATES.scheduled })
  writePending(dir, { state: PENDING_STATES.helperStarted })
  assert.equal(readPending(dir).state, PENDING_STATES.helperStarted)

  writeLast(dir, { ok: false, error: '新进程没起来' })
  assert.equal(readLast(dir).error, '新进程没起来')
})

test('状态文件：writeJsonAtomic 拒绝不可序列化的值', (t) => {
  const dir = path.join(tempHome(t), 'agent-control', 'restart')

  assert.throws(
    () => writeJsonAtomic(path.join(dir, 'x.json'), undefined),
    (error) => error.code === ERROR_CODES.invalidRequest,
  )
  assert.throws(
    () => writeJsonAtomic('', { a: 1 }),
    (error) => error.code === ERROR_CODES.invalidRequest,
  )
})

test('状态文件：clearPending 幂等，removeFile 同理', (t) => {
  const dir = path.join(tempHome(t), 'agent-control', 'restart')
  const file = path.join(dir, 'pending.json')

  writePending(dir, { state: PENDING_STATES.scheduled, createdAt: 1 })
  assert.equal(clearPending(dir), true)
  assert.equal(readPending(dir), undefined)
  assert.equal(clearPending(dir), false, '再清一次不抛错')

  assert.equal(removeFile(file), false, '删不存在的文件不抛错')
  assert.equal(removeFile(''), false)
})

test('状态文件：缺目录时写入被拒绝，读取则当作没有', () => {
  assert.throws(
    () => writePending('', { state: PENDING_STATES.scheduled }),
    (error) => error.code === ERROR_CODES.invalidRequest,
  )
  assert.throws(
    () => writeLast(undefined, { ok: true }),
    (error) => error.code === ERROR_CODES.invalidRequest,
  )
  assert.throws(
    () => writePending('/tmp/whatever', 'not-an-object'),
    (error) => error.code === ERROR_CODES.invalidRequest,
  )
  assert.equal(readPending(''), undefined)
  assert.equal(readLast(''), undefined)
})

// ---------------------------------------------------------------------------
// 续作消息
// ---------------------------------------------------------------------------

test('buildResumeMessage：首行是机器可读标记，正文含原因、秒数与续作说明', () => {
  const message = buildResumeMessage({ reason: '装了新插件', durationMs: 42_400, resumeNote: '继续跑测试' })

  assert.equal(message, [
    '[系统通知 · DSH 已热重启]',
    '原因：装了新插件',
    '耗时：42 秒',
    '你重启前留下的续作说明：继续跑测试',
    '请从中断处继续刚才的工作；先快速确认重启生效（例如检查刚装的插件是否已加载），无需向用户重复解释。',
  ].join('\n'))
})

test('buildResumeMessage：没有续作说明时写「无」', () => {
  assert.match(buildResumeMessage({ reason: 'x' }), /续作说明：无/)
  assert.match(buildResumeMessage({ reason: 'x', resumeNote: '   ' }), /续作说明：无/)
  assert.match(buildResumeMessage({ reason: 'x', resumeNote: 42 }), /续作说明：无/)
})

test('buildResumeMessage：durationMs 缺失或非法时写「未知」', () => {
  for (const durationMs of [undefined, null, Number.NaN, Infinity, '5000']) {
    const message = buildResumeMessage({ reason: 'x', durationMs })
    assert.match(message, /耗时：未知/, `${String(durationMs)} 应当写「未知」`)
    assert.ok(!message.includes('未知 秒'))
  }
  assert.match(buildResumeMessage({ reason: 'x', durationMs: 0 }), /耗时：0 秒/)
})

test('buildResumeMessage：字段全缺也不抛错，原因不编造', () => {
  const message = buildResumeMessage({})

  assert.match(message, /原因：未说明/)
  assert.match(message, /耗时：未知/)
})

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

test('assertRestartReason：1 / 300 字符通过，301 字符拒绝', () => {
  assert.equal(assertRestartReason('a'), 'a')
  assert.equal(assertRestartReason('原'.repeat(300)).length, 300)
  assert.throws(
    () => assertRestartReason('原'.repeat(301)),
    (error) => error.code === ERROR_CODES.invalidRequest && /上限 300/.test(error.message),
  )
  assert.equal(assertRestartReason('  需要重启  '), '需要重启', '返回 trim 后的值')
})

test('assertRestartReason：空串、只有空白、非字符串都拒绝', () => {
  for (const value of ['', '   ', undefined, null, 42, {}]) {
    assert.throws(
      () => assertRestartReason(value),
      (error) => error.code === ERROR_CODES.invalidRequest,
      `${String(value)} 应当被拒绝`,
    )
  }
})

test('assertResumeNote：undefined / null / 空串归一成 undefined', () => {
  assert.equal(assertResumeNote(undefined), undefined)
  assert.equal(assertResumeNote(null), undefined)
  assert.equal(assertResumeNote(''), undefined)
  assert.equal(assertResumeNote('   '), undefined)
})

test('assertResumeNote：500 字符通过，501 字符拒绝，非字符串拒绝', () => {
  assert.equal(assertResumeNote('字'.repeat(500)).length, 500)
  assert.throws(
    () => assertResumeNote('字'.repeat(501)),
    (error) => error.code === ERROR_CODES.invalidRequest && /上限 500/.test(error.message),
  )
  for (const value of [42, true, {}]) {
    assert.throws(
      () => assertResumeNote(value),
      (error) => error.code === ERROR_CODES.invalidRequest,
      `${String(value)} 应当被拒绝`,
    )
  }
  assert.equal(assertResumeNote('  接着修 bug  '), '接着修 bug')
})

// ---------------------------------------------------------------------------
// 路径与 id
// ---------------------------------------------------------------------------

test('restartDir：拼出 $DSH_HOME/agent-control/restart，dshHome 为空则拒绝', () => {
  assert.equal(restartDir('C:\\home\\.dsh'), path.join('C:\\home\\.dsh', 'agent-control', 'restart'))
  for (const value of ['', '   ', undefined, null]) {
    assert.throws(
      () => restartDir(value),
      (error) => error.code === ERROR_CODES.restartUnsupported,
      `${String(value)} 应当抛 RESTART_UNSUPPORTED`,
    )
  }
})

test('restartLogFile：文件名用本地时间排成 yyyyMMdd-HHmmss', () => {
  const now = new Date(2026, 0, 2, 3, 4, 5).getTime()
  const file = restartLogFile('C:\\home\\.dsh', now)

  assert.equal(file, path.join('C:\\home\\.dsh', 'logs', 'agent-control-restart-20260102-030405.log'))
  assert.throws(() => restartLogFile('', now), (error) => error.code === ERROR_CODES.restartUnsupported)
})

test('newRestartId / newBootId：形状正确且每次调用都不同', () => {
  const restartId = newRestartId(1_700_000_000_000)
  assert.match(restartId, /^r-[0-9a-z]+-[a-z0-9]{6}$/)
  assert.ok(restartId.length > 0)

  const boots = new Set(Array.from({ length: 200 }, () => newBootId()))
  assert.equal(boots.size, 200)
  assert.match([...boots][0], /^b-[0-9a-z]+-[a-z0-9]{6}$/)

  const restarts = new Set(Array.from({ length: 200 }, () => newRestartId()))
  assert.equal(restarts.size, 200)
})
