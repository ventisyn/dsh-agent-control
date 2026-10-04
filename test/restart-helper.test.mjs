/**
 * `src/restart-helper.mjs`（热重启辅助进程）的离线测试。
 *
 * 策略：**用真实子进程**当假旧进程 / 假新进程，spec 写在 `os.tmpdir()` 下的临时目录里，
 * 所有 stdio 一律 `'ignore'` 或文件描述符 —— 本机沙箱里把原生进程的输出接进管道会让
 * 它启动失败（AGENTS.local.md 第 2 节），所以这里一个 pipe 都不用。
 *
 * 两条杀不掉 / 探不准的分支（「硬杀也失败」）没法用真进程演化，改用**注入式**：
 * 辅助脚本把探测与硬杀封装成可注入的参数，这里直接传假函数驱动那两条分支。
 *
 * 收尸：假新进程是**辅助进程**拉起来的，测试这边没有 ChildProcess 句柄，只能靠它自己写的
 * pid 文件找回来。每个用例的 after 钩子先杀进程、等它们真的退出，再删临时目录 ——
 * Windows 上进程还活着时它的 cwd（= spec.cwd）目录删不掉，会得到 EPERM。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  STAGES,
  defaultProbe,
  parseStatusTarget,
  readSpec,
  runHelper,
  waitForOldExit,
  waitForPortFree,
  writeLastAtomic,
} from '../src/restart-helper.mjs'

const HELPER = fileURLToPath(new URL('../src/restart-helper.mjs', import.meta.url))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 兜底：任何用例漏掉的假进程，最后统一收尸。 */
const strays = new Set()
after(() => {
  for (const pid of strays) {
    try {
      process.kill(pid)
    } catch {
      // 已经退了
    }
  }
})

function readPidFile(pidFile) {
  if (!existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * 每个用例一套「临时目录 + 收尸」：after 钩子里**先杀假进程、等它们退出，再删目录**，
 * 顺序固定，不依赖多个 after 钩子之间的先后。
 */
function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-helper-'))
  const ownPids = new Set() // 测试自己 spawn 的假进程
  const newPidFiles = new Set() // 辅助进程拉起的假新进程：靠它写的 pid 文件找

  const livePids = () => [
    ...ownPids,
    ...[...newPidFiles].map((file) => readPidFile(file)).filter((pid) => pid !== null),
  ]

  t.after(async () => {
    for (const pid of livePids()) {
      strays.delete(pid)
      try {
        process.kill(pid)
      } catch {
        // 已经退了
      }
    }
    // 等它们真的退出：进程还活着时它的 cwd 目录删不掉
    for (let attempt = 0; attempt < 100 && livePids().some((pid) => defaultProbe(pid)); attempt += 1) {
      await sleep(20)
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true })
        return
      } catch {
        await sleep(25)
      }
    }
    // 实在删不掉也只是临时目录里的残留，不该把用例判成失败（断言早就跑完了）。
  })

  return {
    dir,
    /** 登记测试自己起的假进程 */
    own(child) {
      if (Number.isInteger(child.pid)) {
        ownPids.add(child.pid)
        strays.add(child.pid)
      }
      return child
    },
    /** 登记辅助进程拉起的假新进程（只能靠 pid 文件） */
    viaPidFile(pidFile) {
      newPidFiles.add(pidFile)
    },
  }
}

/** 起一个真 node 子进程（假旧进程）；stdio 只有 'ignore'。 */
function spawnNode(env, args) {
  const child = spawn(process.execPath, args, { stdio: 'ignore', detached: true, windowsHide: true })
  child.unref()
  return env.own(child)
}

/** 长睡不退的假旧进程。 */
function spawnSleeper(env) {
  return spawnNode(env, ['-e', 'setTimeout(() => {}, 60000)'])
}

/** 造一个**确定已经退出**的 pid（辅助进程探测它时应当立刻返回「已退出」）。 */
async function deadPid(env, timeoutMs = 5000) {
  const child = spawnSleeper(env)
  try {
    process.kill(child.pid)
  } catch {
    // 来不及退就算了，下面的轮询会兜住
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!defaultProbe(child.pid)) return child.pid
    await sleep(20)
  }
  throw new Error('假旧进程没有在预期时间内退出，用例前提不成立')
}

/** 把一段假进程脚本写进临时目录。 */
function writeFixture(dir, name, source) {
  const file = path.join(dir, name)
  writeFileSync(file, source, 'utf8')
  return file
}

/** 假新进程：把自己的 pid 与 cwd 写进文件，然后长睡。 */
const FIXTURE_WRITE_PID = `import { writeFileSync } from 'node:fs'
// argv: <pidFile> <cwdFile>
writeFileSync(process.argv[2], String(process.pid))
writeFileSync(process.argv[3], process.cwd())
setTimeout(() => {}, 60000)
`

/** 假新进程：写下 pid，并在指定端口回答固定 bootId 的 status 接口（把每次探测记进 hits 文件）。 */
const FIXTURE_SERVE_STATUS = `import { appendFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
// argv: <pidFile> <port> <bootId> <hitsFile>
writeFileSync(process.argv[2], String(process.pid))
const server = http.createServer((req, res) => {
  appendFileSync(process.argv[5], req.url + '\\n')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, bootId: process.argv[4] }))
})
server.listen(Number(process.argv[3]), '127.0.0.1')
setTimeout(() => {}, 60000)
`

async function waitForPidFile(pidFile, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pid = readPidFile(pidFile)
    if (pid !== null) return pid
    await sleep(20)
  }
  return null
}

/** 领一个当前空闲的端口（先听一次拿到号码再放掉）。 */
async function freePort() {
  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** 跑一次真实的辅助进程（stdio 只有 'ignore'）；超时上限很小，避免用例挂死。 */
function runHelperProcess(specPath, { timeoutMs = 10000 } = {}) {
  const child = spawn(process.execPath, [HELPER, specPath], { stdio: 'ignore', windowsHide: true })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(child.pid)
      } catch {
        // 已经退了
      }
      resolve({ code: null, signal: null, timedOut: true })
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut: false })
    })
  })
}

function readLast(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'last.json'), 'utf8'))
}

const BASE_TIMEOUTS = Object.freeze({
  oldExitMs: 600,
  killWaitMs: 1500,
  portFreeMs: 800,
  readyMs: 1500,
  readyGraceMs: 200,
  spawnSettleMs: 200,
  pollMs: 50,
  portRetryMs: 50,
  readyPollMs: 100,
})

/** 造一份合法 spec（假新进程默认长睡；oldPid 必须由用例给出）。 */
function makeSpec(dir, overrides = {}) {
  const { timeouts, ...rest } = overrides
  return {
    restartId: 'r-test',
    execPath: process.execPath,
    execArgv: [],
    argv: ['-e', 'setTimeout(() => {}, 60000)'],
    cwd: dir,
    env: { ...process.env },
    oldPid: 424242,
    oldBootId: null,
    statusUrl: null,
    logFile: path.join(dir, 'new-process.log'),
    createdAt: Date.now(),
    ...rest,
    timeouts: { ...BASE_TIMEOUTS, ...timeouts },
  }
}

function writeSpec(dir, spec, name = 'spec.json') {
  const specPath = path.join(dir, name)
  writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8')
  return specPath
}

/** 目录里不许残留 last.json 的临时文件。 */
function assertNoTempLeftovers(dir) {
  const leftovers = readdirSync(dir).filter((name) => name.startsWith('last.json.tmp'))
  assert.deepEqual(leftovers, [], '原子写不许留下临时文件')
}

// ---------------------------------------------------------------------------
// 1. 成功路径
// ---------------------------------------------------------------------------

test('成功路径（statusUrl 为 null 的降级路径）：旧进程已退出 → 拉起新进程 → ok:true 且 degraded:true', { timeout: 10000 }, async (t) => {
  const env = scratch(t)
  const { dir } = env
  const fixture = writeFixture(dir, 'fake-new.mjs', FIXTURE_WRITE_PID)
  const pidFile = path.join(dir, 'new-pid.txt')
  const cwdFile = path.join(dir, 'new-cwd.txt')
  const spec = makeSpec(dir, {
    restartId: 'r-degraded',
    argv: [fixture, pidFile, cwdFile],
    oldPid: await deadPid(env),
  })
  env.viaPidFile(pidFile)

  const run = await runHelperProcess(writeSpec(dir, spec))
  const last = readLast(dir)

  assert.equal(run.timedOut, false, '辅助进程必须自己退出，不许挂死')
  assert.equal(run.code, 0, '成功必须退出码 0')
  assert.equal(last.ok, true)
  assert.equal(last.degraded, true, '没有 statusUrl 只能是降级成功')
  assert.equal(last.restartId, 'r-degraded')
  assert.equal(last.bootId, null, '降级路径拿不到 bootId，如实写 null 而不是编一个')
  assert.equal(last.logFile, spec.logFile)
  assert.ok(Number.isInteger(last.durationMs) && last.durationMs >= 0, 'durationMs 是整数毫秒')
  assert.ok(Number.isInteger(last.finishedAt), 'finishedAt 是毫秒时间戳')

  const newPid = await waitForPidFile(pidFile)
  assert.equal(newPid !== null, true, '假新进程必须真的被拉起来')
  assert.equal(last.newPid, newPid, 'newPid 必须是被拉起来的那个进程')
  assert.equal(defaultProbe(newPid), true, '★ 辅助进程退出后新进程必须还活着')
  assert.equal(readFileSync(cwdFile, 'utf8'), spec.cwd, '新进程的工作目录来自 spec.cwd')
  assert.equal(existsSync(spec.logFile), true, '新进程的 stdout/stderr 指向这个日志文件')
  assert.equal(existsSync(path.join(dir, 'spec.json')), false, '★ 启动规格（含环境变量）用完即删')
  assertNoTempLeftovers(dir)
})

test('失败路径：spec.json 与 pending.json 都清掉——否则下次启动会谎报「已热重启」', { timeout: 10000 }, async (t) => {
  // 真机踩到过：新进程起不来时两份文件都留在盘上，而 pending.json 会让用户**下次手动启动**时
  // 收到一条声称「DSH 已热重启」的续作消息——通知一件没发生的事比不通知更坏。
  const env = scratch(t)
  const { dir } = env
  const spec = makeSpec(dir, {
    restartId: 'r-cleanup-on-failure',
    execPath: path.join(dir, 'no-such-dsh.exe'),
    oldPid: await deadPid(env),
  })
  const specPath = writeSpec(dir, spec)
  writeFileSync(
    path.join(dir, 'pending.json'),
    `${JSON.stringify({ restartId: 'r-cleanup-on-failure', state: 'helper-started' })}\n`,
    'utf8',
  )

  const run = await runHelperProcess(specPath)
  const last = readLast(dir)

  assert.equal(run.code, 1)
  assert.equal(last.ok, false)
  assert.equal(existsSync(specPath), false, '★ 启动规格含环境变量：失败也必须删掉')
  assert.equal(existsSync(path.join(dir, 'pending.json')), false, '★ 待办必须清掉：这次重启并没有成功')
  assert.equal(existsSync(path.join(dir, 'last.json')), true, '失败原因留在 last.json 里（那才是给界面看的）')
})

test('成功路径（statusUrl 可用）：bootId 变了即就绪，ok:true 且不写 degraded', { timeout: 10000 }, async (t) => {
  const env = scratch(t)
  const { dir } = env
  const fixture = writeFixture(dir, 'fake-http.mjs', FIXTURE_SERVE_STATUS)
  const pidFile = path.join(dir, 'new-pid.txt')
  const hitsFile = path.join(dir, 'status-hits.txt')
  const port = await freePort()
  const spec = makeSpec(dir, {
    restartId: 'r-ready',
    argv: [fixture, pidFile, String(port), 'b-new', hitsFile],
    oldPid: await deadPid(env),
    oldBootId: 'b-old',
    statusUrl: `http://127.0.0.1:${port}/api/agent-control/restart/status`,
  })
  env.viaPidFile(pidFile)

  const run = await runHelperProcess(writeSpec(dir, spec))
  const last = readLast(dir)

  assert.equal(run.code, 0)
  assert.equal(last.ok, true)
  assert.equal(last.bootId, 'b-new', 'bootId 取自 status 接口')
  assert.equal('degraded' in last, false, '走通就绪探针就不是降级路径')
  assert.equal(last.newPid, await waitForPidFile(pidFile))
  assert.equal(defaultProbe(last.newPid), true, '新进程仍在运行（辅助进程不替它收尸）')
  assert.ok(readFileSync(hitsFile, 'utf8').trim().split('\n').length >= 1, '状态接口必须真被探过')
})

test('可选 helperLog：把带时间戳的阶段行追加进去（不写 stdout）', { timeout: 10000 }, async (t) => {
  const env = scratch(t)
  const { dir } = env
  const fixture = writeFixture(dir, 'fake-new.mjs', FIXTURE_WRITE_PID)
  const pidFile = path.join(dir, 'new-pid.txt')
  const helperLog = path.join(dir, 'helper.log')
  const spec = makeSpec(dir, {
    restartId: 'r-log',
    argv: [fixture, pidFile, path.join(dir, 'new-cwd.txt')],
    oldPid: await deadPid(env),
    helperLog,
  })
  env.viaPidFile(pidFile)

  await runHelperProcess(writeSpec(dir, spec))

  const text = readFileSync(helperLog, 'utf8')
  assert.match(text, /规格已读取：restartId=r-log/)
  assert.match(text, /旧进程 \d+ 已退出/)
  assert.match(text, /新进程已启动：pid=\d+/)
  assert.match(text, /^\[\d{4}-\d{2}-\d{2}T/m, '每行都带时间戳')
})

// ---------------------------------------------------------------------------
// 2. 旧进程不退
// ---------------------------------------------------------------------------

test('旧进程长睡不退：超时后硬杀，杀掉后流程继续并成功', { timeout: 10000 }, async (t) => {
  const env = scratch(t)
  const { dir } = env
  const fixture = writeFixture(dir, 'fake-new.mjs', FIXTURE_WRITE_PID)
  const pidFile = path.join(dir, 'new-pid.txt')
  const old = spawnSleeper(env) // 真的不会自己退
  const spec = makeSpec(dir, {
    restartId: 'r-kill',
    argv: [fixture, pidFile, path.join(dir, 'new-cwd.txt')],
    oldPid: old.pid,
    timeouts: { oldExitMs: 600, killWaitMs: 2000 },
  })
  env.viaPidFile(pidFile)

  const run = await runHelperProcess(writeSpec(dir, spec))
  const last = readLast(dir)

  assert.equal(run.code, 0)
  assert.equal(last.ok, true)
  assert.equal(defaultProbe(old.pid), false, '★ 超时之后必须真的把旧进程硬杀掉')
})

test('硬杀也失败（注入式）：ok:false、stage:「old-exit」，且不会去拉新进程', { timeout: 10000 }, async (t) => {
  const env = scratch(t)
  const { dir } = env
  const spec = makeSpec(dir, {
    restartId: 'r-nodead',
    oldPid: 424242,
    timeouts: { oldExitMs: 100, killWaitMs: 100, pollMs: 20 },
  })
  const specPath = writeSpec(dir, spec)
  const killCalls = []

  // 探不到真实边界，只能注入：进程「永远活着」，硬杀「永远没权限」。
  const result = await runHelper(specPath, {
    probe: () => true,
    kill: (pid) => {
      killCalls.push(pid)
      const error = new Error('拒绝访问')
      error.code = 'EPERM'
      throw error
    },
  })

  assert.equal(result.exitCode, 1)
  assert.deepEqual(killCalls, [424242], '超时后必须尝试硬杀')
  assert.equal(result.payload.ok, false)
  assert.equal(result.payload.stage, 'old-exit')
  assert.match(result.payload.error, /硬杀失败：EPERM/)
  const last = readLast(dir)
  assert.equal(last.ok, false)
  assert.equal(last.stage, STAGES.oldExit)
  assert.equal(last.restartId, 'r-nodead')
  assert.equal('newPid' in last, false, '还没走到 spawn，不该有 newPid')
})

test('等旧进程退出：进程在超时前自己退出就不硬杀（注入式）', async () => {
  let alive = true
  let kills = 0
  const result = await waitForOldExit({
    pid: 424242,
    timeoutMs: 500,
    pollMs: 20,
    probe: () => alive,
    kill: () => {
      kills += 1
    },
    sleep: async () => {
      alive = false
    },
  })
  assert.deepEqual(result, { exited: true, forced: false })
  assert.equal(kills, 0, '自己退了就不该再发信号')
})

test('等旧进程退出：硬杀时进程恰好自己退了（kill 抛 ESRCH）按已退出处理（注入式）', async () => {
  const result = await waitForOldExit({
    pid: 424242,
    timeoutMs: 60,
    killWaitMs: 60,
    pollMs: 20,
    probe: () => true,
    kill: () => {
      const error = new Error('没有这个进程')
      error.code = 'ESRCH'
      throw error
    },
  })
  assert.deepEqual(result, { exited: true, forced: true })
})

// ---------------------------------------------------------------------------
// 3. 新进程起不来
// ---------------------------------------------------------------------------

test('新进程起不来（execPath 指向不存在的可执行文件）：ok:false、stage:「spawn」、退出码 1', { timeout: 10000 }, async (t) => {
  // 选「spawn」而不是「ready」：起不来这件事在「立刻失败观察窗」里就能定性，不必耗满 readyMs。
  const env = scratch(t)
  const { dir } = env
  const spec = makeSpec(dir, {
    restartId: 'r-nospawn',
    execPath: path.join(dir, 'no-such-dsh.exe'),
    oldPid: await deadPid(env),
  })
  const run = await runHelperProcess(writeSpec(dir, spec))
  const last = readLast(dir)

  assert.equal(run.timedOut, false)
  assert.equal(run.code, 1)
  assert.equal(last.ok, false)
  assert.equal(last.stage, STAGES.spawn)
  assert.match(last.error, /启动失败|无法启动/)
  assert.equal(last.restartId, 'r-nospawn')
})

test('新进程起来又立刻退出（退出码 0 也算起不来）：ok:false、stage:「spawn」', { timeout: 10000 }, async (t) => {
  // node -e "process.exit(0)" 能起来，但没变成在跑的 dsh —— 按「起不来」处理（见脚本里 spawnSettleMs 的注释）。
  const env = scratch(t)
  const { dir } = env
  const spec = makeSpec(dir, {
    restartId: 'r-immediate-exit',
    argv: ['-e', 'process.exit(0)'],
    oldPid: await deadPid(env),
  })
  const run = await runHelperProcess(writeSpec(dir, spec))
  const last = readLast(dir)

  assert.equal(run.code, 1)
  assert.equal(last.ok, false)
  assert.equal(last.stage, STAGES.spawn)
  assert.match(last.error, /立刻退出/)
})

test('日志文件的目录不存在时顺手建出来（重启不该因为少一个日志目录而失败）', { timeout: 10000 }, async (t) => {
  const env = scratch(t)
  const { dir } = env
  const fixture = writeFixture(dir, 'fake-new.mjs', FIXTURE_WRITE_PID)
  const pidFile = path.join(dir, 'new-pid.txt')
  const spec = makeSpec(dir, {
    restartId: 'r-mkdir',
    argv: [fixture, pidFile, path.join(dir, 'new-cwd.txt')],
    oldPid: await deadPid(env),
    logFile: path.join(dir, 'logs', 'nested', 'restart.log'),
  })
  env.viaPidFile(pidFile)

  const run = await runHelperProcess(writeSpec(dir, spec))
  const last = readLast(dir)

  assert.equal(run.code, 0)
  assert.equal(last.ok, true)
  assert.equal(existsSync(spec.logFile), true, '日志文件（连目录）必须被建出来')
})

// ---------------------------------------------------------------------------
// 4. 就绪探针与端口
// ---------------------------------------------------------------------------

test('就绪探针超时（新进程起了但 bootId 还是旧的）：ok:false、stage:「ready」、退出码 1', { timeout: 10000 }, async (t) => {
  const env = scratch(t)
  const { dir } = env
  const fixture = writeFixture(dir, 'fake-http.mjs', FIXTURE_SERVE_STATUS)
  const pidFile = path.join(dir, 'new-pid.txt')
  const hitsFile = path.join(dir, 'status-hits.txt')
  const port = await freePort()
  const spec = makeSpec(dir, {
    restartId: 'r-notready',
    argv: [fixture, pidFile, String(port), 'b-old', hitsFile], // 一直回答旧 bootId
    oldPid: await deadPid(env),
    oldBootId: 'b-old',
    statusUrl: `http://127.0.0.1:${port}/api/agent-control/restart/status`,
    timeouts: { readyMs: 1200, readyPollMs: 100 },
  })
  env.viaPidFile(pidFile)

  const run = await runHelperProcess(writeSpec(dir, spec))
  const last = readLast(dir)

  assert.equal(run.timedOut, false)
  assert.equal(run.code, 1)
  assert.equal(last.ok, false)
  assert.equal(last.stage, STAGES.ready)
  assert.match(last.error, /没有就绪/)
  assert.ok(readFileSync(hitsFile, 'utf8').trim().split('\n').length >= 1, '必须真的探过 statusUrl 才判超时')
  assert.equal(last.newPid, await waitForPidFile(pidFile), '失败结果里也要能知道被拉起来的 pid')
  assert.equal(defaultProbe(last.newPid), true, '辅助进程不替新进程收尸（是否留下由上层决定）')
})

test('旧进程没释放端口（statusUrl 仍可连接）：ok:false、stage:「port-free」，不拉新进程', { timeout: 10000 }, async (t) => {
  const env = scratch(t)
  const { dir } = env
  const server = http.createServer((req, res) => res.end('{}'))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()

  const spec = makeSpec(dir, {
    restartId: 'r-portbusy',
    oldPid: await deadPid(env),
    statusUrl: `http://127.0.0.1:${port}/api/agent-control/restart/status`,
    timeouts: { portFreeMs: 300, portRetryMs: 50 },
  })
  const run = await runHelperProcess(writeSpec(dir, spec))
  const last = readLast(dir)

  assert.equal(run.code, 1)
  assert.equal(last.ok, false)
  assert.equal(last.stage, STAGES.portFree)
  assert.match(last.error, /没有释放/)
  assert.equal('newPid' in last, false, '端口没释放就不该拉新进程')
})

test('statusUrl 解析不出 host:port：跳过端口等待（契约里视为已释放）', async () => {
  assert.equal(parseStatusTarget('这不是一个 URL'), null)
  assert.equal(parseStatusTarget(''), null)
  assert.deepEqual(parseStatusTarget('http://127.0.0.1:3080/x'), { host: '127.0.0.1', port: 3080 })
  const result = await waitForPortFree({ statusUrl: '这不是一个 URL', timeoutMs: 50 })
  assert.equal(result.skipped, true)
})

// ---------------------------------------------------------------------------
// 5. spec 非法 / 读不到
// ---------------------------------------------------------------------------

test('spec 读不到 / JSON 坏 / 缺关键字段：ok:false、stage:「spec」、退出码 1', { timeout: 10000 }, async (t) => {
  const env = scratch(t)
  const { dir } = env
  const base = makeSpec(dir, { restartId: 'r-spec' })
  const cases = [
    { name: '文件不存在', specPath: path.join(dir, 'missing.json'), expectRestartId: null },
    { name: 'JSON 坏', text: '{ 这不是 JSON', expectRestartId: null },
    { name: '缺 execPath', drop: 'execPath', expectRestartId: 'r-spec' },
    { name: '缺 argv', drop: 'argv', expectRestartId: 'r-spec' },
    { name: '缺 cwd', drop: 'cwd', expectRestartId: 'r-spec' },
    { name: '缺 oldPid', drop: 'oldPid', expectRestartId: 'r-spec' },
    { name: '缺 env', drop: 'env', expectRestartId: 'r-spec' },
    { name: '缺 logFile', drop: 'logFile', expectRestartId: 'r-spec' },
  ]

  for (const [index, item] of cases.entries()) {
    const specPath = item.specPath ?? path.join(dir, `spec-${index}.json`)
    if (item.text !== undefined) {
      writeFileSync(specPath, item.text, 'utf8')
    } else if (item.drop !== undefined) {
      const spec = { ...base }
      delete spec[item.drop]
      writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8')
    } // 文件不存在：什么都不写

    const run = await runHelperProcess(specPath)
    const last = readLast(dir)

    assert.equal(run.timedOut, false, `${item.name}：辅助进程必须退出`)
    assert.equal(run.code, 1, `${item.name}：非法 spec 必须退出码 1`)
    assert.equal(last.ok, false, `${item.name}：ok 必须是 false`)
    assert.equal(last.stage, STAGES.spec, `${item.name}：stage 必须是 spec（实际 ${last.stage}）`)
    assert.equal(typeof last.error, 'string', `${item.name}：必须写清中文原因`)
    assert.ok(last.error.length > 0, `${item.name}：原因不能是空串`)
    assert.equal(last.restartId, item.expectRestartId, `${item.name}：能捞到 restartId 就带上（供上层关联）`)
  }
  assertNoTempLeftovers(dir)
})

test('spec 字段类型不对（pid 为 0/负数/非整数、argv 不是数组、timeouts 非法）：一律 spec 失败', { timeout: 10000 }, async (t) => {
  const env = scratch(t)
  const { dir } = env
  const base = makeSpec(dir, { restartId: 'r-spec-type' })
  const variants = [
    ['oldPid 为 0', { oldPid: 0 }],
    ['oldPid 为负数', { oldPid: -3 }],
    ['oldPid 不是整数', { oldPid: 1.5 }],
    ['oldPid 是字符串', { oldPid: '123' }],
    ['argv 不是数组', { argv: 'web' }],
    ['execArgv 里有非字符串', { execArgv: [7] }],
    ['env 的值不是字符串', { env: { DSH_HOME: 7 } }],
    ['oldPid 指向辅助进程自己', { oldPid: process.pid }], // 硬杀那一步会把自己杀掉 → 必须当场拒绝
    ['顶层是数组', 'ARRAY'],
    ['timeouts 为负数', { timeouts: { oldExitMs: -1 } }],
  ]

  for (const [index, [name, patch]] of variants.entries()) {
    const specPath = path.join(dir, `bad-${index}.json`)
    const spec = patch === 'ARRAY' ? [] : { ...base, ...patch }
    writeFileSync(specPath, JSON.stringify(spec), 'utf8')

    // 这些用例只验证 spec 闸门，用进程内调用即可（返回的 exitCode 等价于 CLI 的退出码）。
    const result = await runHelper(specPath)
    const last = readLast(dir)

    assert.equal(result.exitCode, 1, `${name}：必须判失败`)
    assert.equal(result.payload.stage, STAGES.spec, `${name}：stage 必须是 spec`)
    assert.equal(last.ok, false, `${name}：last.json 必须写下来`)
    assert.equal(last.stage, STAGES.spec, `${name}：last.json 的 stage 必须是 spec`)
  }
  assertNoTempLeftovers(dir)
})

test('没有 specPath 参数：没有地方写 last.json，只能靠退出码 1', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [HELPER], { stdio: 'ignore', windowsHide: true })
  const code = await new Promise((resolve) => child.once('exit', resolve))
  assert.equal(code, 1)
})

test('timeouts 缺省值就是契约里那三个数，null 型字段有明确缺省', () => {
  // 用注入的 read 直接喂一份最小 spec，不落盘。
  const minimal = {
    restartId: 'r-min',
    execPath: process.execPath,
    execArgv: [],
    argv: [],
    cwd: os.tmpdir(),
    env: {},
    oldPid: 1,
    logFile: path.join(os.tmpdir(), 'x.log'),
  }
  const spec = readSpec(path.join(os.tmpdir(), 'spec.json'), { read: () => JSON.stringify(minimal) })
  assert.equal(spec.timeouts.oldExitMs, 30000)
  assert.equal(spec.timeouts.portFreeMs, 15000)
  assert.equal(spec.timeouts.readyMs, 90000)
  assert.equal(spec.timeouts.readyGraceMs, 3000, '降级路径的观察窗缺省 3 秒')
  assert.equal(spec.oldBootId, null, '缺 oldBootId ⇒ 无法比较')
  assert.equal(spec.statusUrl, null, '缺 statusUrl ⇒ 降级路径')
  assert.equal(spec.helperLog, null)
})

// ---------------------------------------------------------------------------
// 6. 原子写
// ---------------------------------------------------------------------------

test('last.json 是覆盖写的原子写：连写两次只有一份结果，不留临时文件', async (t) => {
  const env = scratch(t)
  const { dir } = env
  writeLastAtomic(dir, { restartId: 'r-1', ok: true, newPid: 1 })
  writeLastAtomic(dir, { restartId: 'r-2', ok: false, stage: 'ready' })

  assert.deepEqual(readdirSync(dir), ['last.json'], '目录里只该有 last.json')
  const last = JSON.parse(readFileSync(path.join(dir, 'last.json'), 'utf8'))
  assert.equal(last.restartId, 'r-2', '后写的覆盖先写的')
  assert.equal(last.ok, false)
})

test('last.json：同一个 restartId 的记录会合并，不把新进程写的续作结果冲掉', async (t) => {
  const env = scratch(t)
  const { dir } = env
  // 新进程在 appReady 时先写：它只知道「谁发起的、为什么、续作投递成不成」。
  writeLastAtomic(dir, { restartId: 'r-9', source: 'model', reason: '装了宿主插件', resume: 'delivered' })
  // 辅助进程随后写：它只知道「怎么重放的、新进程是谁、多久」。
  writeLastAtomic(dir, { restartId: 'r-9', ok: true, newPid: 4242, durationMs: 6100, logFile: '/tmp/x.log' })

  const last = JSON.parse(readFileSync(path.join(dir, 'last.json'), 'utf8'))
  assert.equal(last.resume, 'delivered', '★ 真机踩过：整份覆盖会让设置页只剩时间和 pid')
  assert.equal(last.source, 'model')
  assert.equal(last.reason, '装了宿主插件')
  assert.equal(last.durationMs, 6100, '辅助进程自己的字段照常写进去')
  assert.equal(last.newPid, 4242)
})

test('last.json：restartId 不同的旧记录不会被合并进来（避免把上一次的续作结果带过来）', async (t) => {
  const env = scratch(t)
  const { dir } = env
  writeLastAtomic(dir, { restartId: 'r-old', resume: 'delivered', source: 'model', reason: '上一次' })
  writeLastAtomic(dir, { restartId: 'r-new', ok: true, newPid: 7 })

  const last = JSON.parse(readFileSync(path.join(dir, 'last.json'), 'utf8'))
  assert.equal(last.restartId, 'r-new')
  assert.equal(last.resume, undefined, '上一次的 resume 不许跟过来')
  assert.equal(last.source, undefined)
  assert.equal(last.reason, undefined)
})

test('last.json：已有文件坏掉时当作「没有」，照样把这次结果写下去', async (t) => {
  const env = scratch(t)
  const { dir } = env
  writeFileSync(path.join(dir, 'last.json'), '{ 这不是 JSON', 'utf8')
  writeLastAtomic(dir, { restartId: 'r-1', ok: true })

  const last = JSON.parse(readFileSync(path.join(dir, 'last.json'), 'utf8'))
  assert.equal(last.ok, true)
  assert.equal(last.restartId, 'r-1')
})
