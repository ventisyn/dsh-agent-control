#!/usr/bin/env node
/**
 * 热重启辅助进程：旧 DSH 进程退出后，把新进程拉起来并等它就绪（`docs/PLAN-hot-restart.md` 2.1 / 4 节 F9 / 5 节 M2）。
 *
 * 设计约束（不要为了「顺手」破坏其中任何一条）：
 *
 * - **独立脚本**：只 import `node:*` 内置模块，不 import 本仓库任何模块、不 import cordis、
 *   也不依赖 `src/restart.mjs` 的导出。它与旧进程之间**只通过两个 JSON 文件通信**：
 *   入参 `spec.json`（路径由命令行给出）与出参 `<spec 所在目录>/last.json`。
 * - **绝不使用管道**（本机沙箱硬约束，AGENTS.local.md 第 2 节）：新进程的 stdout/stderr
 *   重定向到日志文件的文件描述符（`stdio: ['ignore', fd, fd]`），**不用 `'pipe'`**；
 *   本脚本自己也不往 stdout 写任何东西，诊断信息只进 `last.json` 与可选的 `helperLog`。
 * - **所有等待都有上限**：任何一步超时或异常，都要写 `last.json{ok:false, stage}` 并以退出码 1 结束，
 *   绝不静默退出，也不无限等待。
 *
 * 用法：`node src/restart-helper.mjs <specPath>`
 *
 * 时序：
 *   等旧 pid 退出（≤oldExitMs，超时后硬杀再等 ≤killWaitMs）
 *   → 等端口释放（≤portFreeMs；statusUrl 为 null 时跳过）
 *   → 用重放的启动规格 spawn 新 dsh（stdio 重定向到 logFile）
 *   → statusUrl 非 null：轮询 GET statusUrl 直到 bootId ≠ oldBootId（≤readyMs）
 *     statusUrl 为 null：降级路径，等 readyGraceMs 确认新进程没有立刻退出，成功但写 `degraded: true`
 *   → 写 last.json（原子写）→ 退出（成功 0 / 失败 1）
 */
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 失败阶段：写进 `last.json` 的机器可读字段（英文）。 */
export const STAGES = Object.freeze({
  spec: 'spec',
  oldExit: 'old-exit',
  portFree: 'port-free',
  spawn: 'spawn',
  ready: 'ready',
  unknown: 'unknown',
})

/**
 * 各阶段等待上限的缺省值（毫秒）。`spec.timeouts` 里的同名键可覆盖。
 * 前三项是冻结契约里写明的缺省值，其余是本脚本内部的观察窗口。
 */
export const DEFAULT_TIMEOUTS = Object.freeze({
  oldExitMs: 30000, // 等旧进程自己退出
  killWaitMs: 5000, // 硬杀之后再等多久
  portFreeMs: 15000, // 等旧进程释放端口
  readyMs: 90000, // 等新进程就绪（bootId 与旧的不同）
  readyGraceMs: 3000, // 无 statusUrl 的降级路径：确认新进程没有立刻退出
  spawnSettleMs: 500, // 起完新进程后观察「立刻失败」（ENOENT / 立刻退出）的窗口
  pollMs: 200, // 等旧进程退出、硬杀后确认的轮询间隔
  portRetryMs: 250, // 等端口释放的轮询间隔
  readyPollMs: 1000, // 就绪探针轮询间隔
})

/** 带阶段的失败：`stage` 直接进 last.json，`message` 是给人看的中文原因。 */
export class HelperError extends Error {
  constructor(stage, message, options = {}) {
    super(message)
    this.name = 'HelperError'
    this.stage = stage
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** 把任意异常压成一行中文可读文本（带 errno 码）。 */
export function describe(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  const code = typeof error.code === 'string' && error.code !== '' ? `${error.code}: ` : ''
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
  return `${code}${message}`
}

/** 把任何东西收敛成 HelperError：不是 HelperError 的一律算 `unknown` 阶段。 */
export function toHelperError(error) {
  if (error instanceof HelperError) return error
  return new HelperError(STAGES.unknown, `辅助进程内部错误：${describe(error)}`, { cause: error })
}

export function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** ESRCH = 进程不存在；这是唯一能证明「已经退出」的错误码。 */
export function isNoSuchProcess(error) {
  return error?.code === 'ESRCH'
}

/**
 * 探测进程是否还活着（缺省实现）。`EPERM` 之类表示「进程在但没权限」——
 * 保守地当作**仍然存活**，否则会把「杀不掉」误当成「已经退了」。
 */
export function defaultProbe(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isNoSuchProcess(error)
  }
}

/** 硬杀（缺省实现）。失败时抛错，由调用方决定是否算「已退出」。 */
export function defaultKill(pid) {
  process.kill(pid)
}

/** 记录辅助进程自己的阶段日志（可选，写了才用）；写不进去也绝不影响重启本身。 */
export function appendHelperLog(helperLog, line) {
  if (typeof helperLog !== 'string' || helperLog.trim() === '') return
  try {
    appendFileSync(helperLog, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // 诊断日志不是重启的必需品：这里刻意静默（stdout 也不能用）。
  }
}

// ---------------------------------------------------------------------------
// spec.json 读取与校验（缺字段如实失败，不猜）
// ---------------------------------------------------------------------------

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HelperError(STAGES.spec, `启动规格缺少 ${field}（必须是非空字符串）`)
  }
  return value
}

function requireTextArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HelperError(STAGES.spec, `启动规格缺少 ${field}（必须是字符串数组，可以是空数组）`)
  }
  return [...value]
}

function requireEnv(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HelperError(STAGES.spec, '启动规格缺少 env（必须是完整环境变量的对象快照）')
  }
  const env = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new HelperError(STAGES.spec, `启动规格的 env.${key} 必须是字符串`)
    }
    env[key] = item
  }
  return env
}

function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new HelperError(STAGES.spec, `启动规格的 ${field} 必须是正整数（收到 ${JSON.stringify(value)}）`)
  }
  return value
}

function readTimeouts(value) {
  const timeouts = { ...DEFAULT_TIMEOUTS }
  if (value === undefined || value === null) return timeouts
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HelperError(STAGES.spec, '启动规格的 timeouts 必须是对象')
  }
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_TIMEOUTS, key)) continue // 未知键忽略，便于向前兼容
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) {
      throw new HelperError(STAGES.spec, `启动规格的 timeouts.${key} 必须是非负有限数字`)
    }
    timeouts[key] = item
  }
  return timeouts
}

/**
 * 读并校验启动规格。任何字段缺失 / 类型不对 / 读不到 / JSON 坏 → `HelperError('spec')`。
 * `oldPid` 是 0、负数或非整数一律算规格非法（拿它去 kill 会打到进程组或直接抛错）。
 */
export function readSpec(specPath, { read = readFileSync } = {}) {
  let text
  try {
    text = read(specPath, 'utf8')
  } catch (error) {
    throw new HelperError(STAGES.spec, `读不到启动规格文件：${specPath}（${describe(error)}）`)
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new HelperError(STAGES.spec, `启动规格不是合法 JSON：${specPath}（${describe(error)}）`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelperError(STAGES.spec, '启动规格必须是一个 JSON 对象')
  }
  const spec = {
    restartId: requireText(raw.restartId, 'restartId'),
    execPath: requireText(raw.execPath, 'execPath'),
    execArgv: requireTextArray(raw.execArgv, 'execArgv'),
    argv: requireTextArray(raw.argv, 'argv'),
    cwd: requireText(raw.cwd, 'cwd'),
    env: requireEnv(raw.env),
    oldPid: requirePositiveInt(raw.oldPid, 'oldPid'),
    // null 是合法取值：表示「无法比较」（老进程没给 bootId，或没有状态接口）。
    oldBootId: raw.oldBootId === undefined || raw.oldBootId === null ? null : requireText(raw.oldBootId, 'oldBootId'),
    statusUrl: raw.statusUrl === undefined || raw.statusUrl === null ? null : requireText(raw.statusUrl, 'statusUrl'),
    logFile: requireText(raw.logFile, 'logFile'),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : null,
    helperLog: typeof raw.helperLog === 'string' && raw.helperLog.trim() !== '' ? raw.helperLog : null,
    timeouts: readTimeouts(raw.timeouts),
  }
  // 自我保护：oldPid 指向辅助进程自己时，硬杀那一步会把自己杀掉 —— 那样连 last.json 都留不下来。
  if (spec.oldPid === process.pid) {
    throw new HelperError(STAGES.spec, `启动规格的 oldPid 指向辅助进程自己（${process.pid}），拒绝执行`)
  }
  return spec
}

// ---------------------------------------------------------------------------
// 等待旧进程退出
// ---------------------------------------------------------------------------

/**
 * 等旧 pid 退出：轮询探测（≤timeoutMs）→ 超时后硬杀 → 再等 ≤killWaitMs。
 * 硬杀返回 ESRCH 视为「已经退出」；仍存活则 `HelperError('old-exit')`。
 *
 * `probe` / `kill` 可注入（缺省用真实实现），用来在离线测试里覆盖「硬杀也失败」这类分支。
 */
export async function waitForOldExit({
  pid,
  timeoutMs = DEFAULT_TIMEOUTS.oldExitMs,
  killWaitMs = DEFAULT_TIMEOUTS.killWaitMs,
  pollMs = DEFAULT_TIMEOUTS.pollMs,
  probe = defaultProbe,
  kill = defaultKill,
  sleep = defaultSleep,
} = {}) {
  const waitUntil = async (deadline) => {
    for (;;) {
      if (!probe(pid)) return true
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await sleep(Math.max(1, Math.min(pollMs, remaining)))
    }
  }

  if (await waitUntil(Date.now() + timeoutMs)) return { exited: true, forced: false }

  // 超时 → 硬杀，再给一小段时间让它真的退出
  let killError = null
  try {
    kill(pid)
  } catch (error) {
    killError = error
    // 进程恰好在这一刻自己退了：kill 抛 ESRCH，就是「已经退出」。
    if (isNoSuchProcess(error)) return { exited: true, forced: true }
  }

  if (await waitUntil(Date.now() + killWaitMs)) return { exited: true, forced: true }

  throw new HelperError(
    STAGES.oldExit,
    `旧进程 ${pid} 在 ${timeoutMs} 毫秒内没有退出，硬杀后 ${killWaitMs} 毫秒内仍然存活` +
      (killError === null ? '' : `（硬杀失败：${describe(killError)}）`),
  )
}

// ---------------------------------------------------------------------------
// 等端口释放
// ---------------------------------------------------------------------------

/** 从 statusUrl 解析出要等的 host:port；解析不出来返回 null（按契约视为「已释放」）。 */
export function parseStatusTarget(statusUrl) {
  if (typeof statusUrl !== 'string' || statusUrl.trim() === '') return null
  let url
  try {
    url = new URL(statusUrl)
  } catch {
    return null
  }
  const defaultPort = url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : NaN
  const port = url.port === '' ? defaultPort : Number(url.port)
  if (!Number.isInteger(port) || port <= 0) return null
  // IPv6 的 hostname 形如 `[::1]`，net.connect 要的是不带方括号的地址。
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === '') return null
  return { host, port }
}

/** 试连一下：能连上 = true（端口还被占着）。 */
export function canConnect(host, port, { timeoutMs = 1000, connect = net.connect } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let socket
    try {
      socket = connect({ host, port })
    } catch {
      done(false)
      return
    }
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      done(false) // 连不上（既没有 connect 也没有立刻报错）→ 按契约算「已释放」
    })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => {
      socket.destroy()
      done(false) // ECONNREFUSED 等 → 已释放
    })
  })
}

/**
 * 等端口释放：每 portRetryMs 试连一次，直到连不上或超时。
 * `statusUrl` 为 null ⇒ 跳过（返回 `skipped: true`）。
 */
export async function waitForPortFree({
  statusUrl,
  timeoutMs = DEFAULT_TIMEOUTS.portFreeMs,
  retryMs = DEFAULT_TIMEOUTS.portRetryMs,
  sleep = defaultSleep,
  connect = canConnect,
} = {}) {
  if (statusUrl === null || statusUrl === undefined) return { skipped: true, waitedMs: 0 }
  const target = parseStatusTarget(statusUrl)
  if (target === null) return { skipped: true, waitedMs: 0, reason: 'statusUrl 解析不出 host:port' }

  const startedAt = Date.now()
  for (;;) {
    if (!(await connect(target.host, target.port))) return { skipped: false, waitedMs: Date.now() - startedAt }
    const remaining = timeoutMs - (Date.now() - startedAt)
    if (remaining <= 0) {
      throw new HelperError(STAGES.portFree, `${target.host}:${target.port} 在 ${timeoutMs} 毫秒内没有释放，新进程无法绑定同一个端口`)
    }
    await sleep(Math.max(1, Math.min(retryMs, remaining)))
  }
}

// ---------------------------------------------------------------------------
// 起新进程 / 等就绪
// ---------------------------------------------------------------------------

/**
 * 用重放的启动规格起新进程。**stdio 只能是 `'ignore'` 或文件描述符**：
 * 本机沙箱下把原生进程的输出接进管道会让它启动失败（AGENTS.local.md 第 2 节）。
 */
export function spawnNewProcess(spec, { spawnFn = spawn, open = openSync, close = closeSync, mkdir = mkdirSync } = {}) {
  const args = [...spec.execArgv, ...spec.argv]
  let fd
  try {
    // 日志目录不存在时顺手建出来（spec 里的路径是本插件自己写的，不是外部输入）；
    // 建不出来就让下面的 open 报错，错误信息里带着路径。
    try {
      mkdir(path.dirname(spec.logFile), { recursive: true })
    } catch {
      // 忽略：交给 open 报错
    }
    fd = open(spec.logFile, 'a')
  } catch (error) {
    throw new HelperError(STAGES.spawn, `打不开新进程的日志文件：${spec.logFile}（${describe(error)}）`)
  }
  let child
  try {
    child = spawnFn(spec.execPath, args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    })
  } catch (error) {
    throw new HelperError(STAGES.spawn, `无法启动新进程：${spec.execPath}（${describe(error)}）`)
  } finally {
    try {
      close(fd)
    } catch {
      // 子进程已经拿到自己的句柄副本，关掉父进程这份失败也无所谓。
    }
  }
  child.unref()
  return child
}

/** 监听子进程的 error/exit，得到一份**不会被后续事件循环吞掉**的状态快照。 */
export function watchChild(child) {
  const state = { error: null, exited: false, exitCode: null, signal: null }
  child.on('error', (error) => {
    state.error = error
  })
  child.on('exit', (code, signal) => {
    state.exited = true
    state.exitCode = code
    state.signal = signal
  })
  return state
}

function describeChildState(state) {
  if (state.error !== null) return `启动失败：${describe(state.error)}`
  if (state.signal !== null) return `被信号 ${state.signal} 终止`
  return `退出码 ${state.exitCode === null ? '未知' : state.exitCode}`
}

async function readBootId(statusUrl, fetchFn, timeoutMs) {
  try {
    const response = await fetchFn(statusUrl, {
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      headers: { accept: 'application/json' },
    })
    const data = await response.json()
    const bootId = data?.bootId
    return { bootId: typeof bootId === 'string' && bootId !== '' ? bootId : null }
  } catch (error) {
    // 探不通是**预期内**的（新进程还没起来）：继续轮询，不在这里失败。
    return { bootId: null, error }
  }
}

/**
 * 轮询 `statusUrl` 直到拿到与 oldBootId 不同的 bootId（≤readyMs）。
 * oldBootId 为 null（无法比较）时，第一个非空 bootId 就算就绪。
 */
export async function waitForReady({
  statusUrl,
  oldBootId,
  readyMs = DEFAULT_TIMEOUTS.readyMs,
  pollMs = DEFAULT_TIMEOUTS.readyPollMs,
  childState,
  sleep = defaultSleep,
  fetchFn = fetch,
} = {}) {
  const deadline = Date.now() + readyMs
  let attempts = 0
  let lastBootId = null
  for (;;) {
    attempts += 1
    const probe = await readBootId(statusUrl, fetchFn, Math.min(pollMs, Math.max(1, deadline - Date.now())))
    lastBootId = probe.bootId
    if (probe.bootId !== null && probe.bootId !== oldBootId) return { bootId: probe.bootId, attempts }
    if (childState !== undefined && (childState.exited || childState.error !== null)) {
      throw new HelperError(STAGES.ready, `新进程在就绪探测期间没有继续运行（${describeChildState(childState)}），无法确认重启成功`)
    }
    if (Date.now() >= deadline) {
      throw new HelperError(
        STAGES.ready,
        `新进程在 ${readyMs} 毫秒内没有就绪：${statusUrl} ` +
          (lastBootId === null ? '一直取不到 bootId' : `返回的 bootId 仍是 ${lastBootId}`) +
          `（共探测 ${attempts} 次）`,
      )
    }
    await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())))
  }
}

/** 降级路径（spec 里没有 statusUrl）：等一小段，确认新进程没有立刻退出。 */
export async function waitForDegradedReady({
  graceMs = DEFAULT_TIMEOUTS.readyGraceMs,
  childState = { error: null, exited: false, exitCode: null, signal: null },
  sleep = defaultSleep,
} = {}) {
  await sleep(Math.max(0, graceMs))
  if (childState.error !== null) {
    throw new HelperError(STAGES.ready, `新进程启动失败（${describeChildState(childState)}），无法确认它是否起来`)
  }
  if (childState.exited) {
    throw new HelperError(STAGES.ready, `新进程启动后立刻退出（${describeChildState(childState)}），无法确认它是否起来`)
  }
  return { degraded: true }
}

// ---------------------------------------------------------------------------
// last.json（原子写）
// ---------------------------------------------------------------------------

/**
 * 原子写 `last.json`：先写同目录临时文件，再 rename 覆盖目标（Windows 上 rename 会替换已有文件）。
 * 失败时清掉临时文件，不留残留。
 */
export function writeLastAtomic(dir, payload, { write = writeFileSync, rename = renameSync, remove = unlinkSync, read = readFileSync } = {}) {
  const target = path.join(dir, 'last.json')
  const temp = path.join(dir, `last.json.tmp-${process.pid}-${Date.now().toString(36)}`)
  // ⚠️ **必须合并，不能整份覆盖**：新进程在 `appReady` 时就把「续作投递结果」写进了 last.json，
  // 而那一刻辅助进程通常还没探测到它就绪（轮询间隔 1 秒）——整份覆盖会把 source / reason /
  // resume 全部冲掉，设置页的「最近一次重启」就只剩时间和 pid。真机实测踩到过。
  //
  // 只合并**同一个 restartId** 的旧记录：last.json 跨重启复用，无条件合并会把上一次的
  // `resume: 'delivered'` 带到这一次的结果里，那是编造。
  const existing = readLastRecord(target, read)
  const sameRestart = typeof payload?.restartId === 'string' && payload.restartId !== '' && existing.restartId === payload.restartId
  const merged = sameRestart ? { ...existing, ...payload } : { ...payload }
  try {
    write(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    rename(temp, target)
  } catch (error) {
    try {
      remove(temp)
    } catch {
      // 临时文件可能压根没建出来
    }
    throw error
  }
  return target
}

/** 读已有的 last.json；读不到、坏掉、不是对象都当「没有」——合并的基准缺失不该让重启失败。 */
function readLastRecord(file, read) {
  try {
    const parsed = JSON.parse(read(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * spec 读不出来时的兜底：**只为让失败结果可关联**，从同一份文件里尽量捞 restartId / logFile。
 * 捞不到就是 null，绝不编造。
 */
function salvageSpecFields(specPath) {
  try {
    const raw = JSON.parse(readFileSync(specPath, 'utf8'))
    return {
      restartId: typeof raw?.restartId === 'string' && raw.restartId !== '' ? raw.restartId : null,
      logFile: typeof raw?.logFile === 'string' && raw.logFile !== '' ? raw.logFile : null,
    }
  } catch {
    return { restartId: null, logFile: null }
  }
}

/**
 * 跑完整时序。**不会抛异常**：任何失败都收敛成 `{ ok: false, exitCode: 1, payload }` 并把
 * `last.json` 写下去（除非连目录都写不进去，那种情况只能靠退出码表达）。
 *
 * 可注入项（缺省用真实实现）：`probe` / `kill`（等旧进程退出）、`connect`（等端口释放）、
 * `spawnFn`（起新进程）、`fetchFn`（就绪探针）、`sleep`。
 */
export async function runHelper(specPath, options = {}) {
  const {
    probe = defaultProbe,
    kill = defaultKill,
    connect = canConnect,
    spawnFn = spawn,
    fetchFn = fetch,
    sleep = defaultSleep,
  } = options
  const startedAt = Date.now()
  const dir = path.dirname(path.resolve(specPath))
  const elapsed = () => Date.now() - startedAt

  let spec = null
  let child = null
  let childState = null
  const log = (line) => appendHelperLog(spec?.helperLog, line)

  try {
    spec = readSpec(specPath)
    const { timeouts } = spec
    log(`规格已读取：restartId=${spec.restartId} oldPid=${spec.oldPid} statusUrl=${spec.statusUrl ?? 'null'}`)

    // 1. 等旧进程退出
    const oldExit = await waitForOldExit({
      pid: spec.oldPid,
      timeoutMs: timeouts.oldExitMs,
      killWaitMs: timeouts.killWaitMs,
      pollMs: timeouts.pollMs,
      probe,
      kill,
      sleep,
    })
    log(`旧进程 ${spec.oldPid} 已退出（${oldExit.forced ? '超时后硬杀' : '自行退出'}）`)

    // 2. 等端口释放
    const portFree = await waitForPortFree({
      statusUrl: spec.statusUrl,
      timeoutMs: timeouts.portFreeMs,
      retryMs: timeouts.portRetryMs,
      connect,
      sleep,
    })
    log(portFree.skipped ? `跳过端口等待（${portFree.reason ?? 'statusUrl 为 null'}）` : `端口已释放（等了 ${portFree.waitedMs} 毫秒）`)

    // 3. 起新进程（stdio 走日志文件描述符，绝不用管道）
    child = spawnNewProcess(spec, { spawnFn })
    childState = watchChild(child)
    await sleep(Math.max(0, timeouts.spawnSettleMs))
    if (childState.error !== null) {
      throw new HelperError(STAGES.spawn, `新进程启动失败：${spec.execPath}（${describe(childState.error)}）`)
    }
    if (childState.exited) {
      throw new HelperError(STAGES.spawn, `新进程启动后立刻退出（${describeChildState(childState)}）`)
    }
    log(`新进程已启动：pid=${child.pid}`)

    // 4. 等就绪
    let bootId = null
    let degraded = false
    if (spec.statusUrl === null) {
      const downgraded = await waitForDegradedReady({ graceMs: timeouts.readyGraceMs, childState, sleep })
      degraded = downgraded.degraded
      log(`降级路径：等满 ${timeouts.readyGraceMs} 毫秒，新进程仍在运行（bootId 无法确认）`)
    } else {
      const ready = await waitForReady({
        statusUrl: spec.statusUrl,
        oldBootId: spec.oldBootId,
        readyMs: timeouts.readyMs,
        pollMs: timeouts.readyPollMs,
        childState,
        fetchFn,
        sleep,
      })
      bootId = ready.bootId
      log(`新进程已就绪：bootId=${bootId}（探测 ${ready.attempts} 次）`)
    }

    const payload = {
      restartId: spec.restartId,
      ok: true,
      newPid: child.pid,
      bootId,
      durationMs: elapsed(),
      finishedAt: Date.now(),
      logFile: spec.logFile,
    }
    if (degraded) payload.degraded = true
    writeLastAtomic(dir, payload)
    log(`已写 last.json：ok=true 耗时 ${payload.durationMs} 毫秒`)
    // 成功：启动规格**用完即删**（里面有完整的环境变量快照）。pending.json 留着——
    // 新进程正要靠它投递续作消息。
    discardSpec(specPath, log)
    return { ok: true, exitCode: 0, payload }
  } catch (error) {
    const helperError = toHelperError(error)
    log(`失败：stage=${helperError.stage} ${helperError.message}`)
    // spec 没读出来时（stage: 'spec'）也从同一份文件里尽量捞关联字段，捞不到就是 null。
    const salvaged = spec === null ? salvageSpecFields(specPath) : { restartId: spec.restartId, logFile: spec.logFile }
    const payload = {
      restartId: salvaged.restartId,
      ok: false,
      error: helperError.message,
      stage: helperError.stage,
      durationMs: elapsed(),
      finishedAt: Date.now(),
      logFile: salvaged.logFile,
    }
    // 附加字段（冻结契约里没有，属于**向前兼容的补充**）：失败时也能知道被拉起来的那个 pid 是谁。
    if (child !== null && Number.isInteger(child.pid)) payload.newPid = child.pid
    try {
      writeLastAtomic(dir, payload)
    } catch (writeError) {
      // 连 last.json 都写不下去（例如目录不存在）：只能靠退出码表达。
      payload.writeError = describe(writeError)
    }
    // 失败：**两份都清掉**。真机踩到过——新进程起不来时 `spec.json`（含环境变量）与
    // `pending.json` 会一直留在盘上，而后者更坏：用户下次手动启动时，新进程会读到一个
    // 「上次那次其实失败了的热重启」待办，投出一条**声称已经重启过**的续作消息。宁可不通知，
    // 也不能通知一件没发生的事。失败原因已经完整写进 last.json，不需要靠这两个文件留证。
    discardSpec(specPath, log)
    discardPending(dir, log)
    return { ok: false, exitCode: 1, payload, error: helperError }
  }
}

/**
 * 删掉启动规格（含环境变量快照，计划 3.5 要求「用完即删」）。删不掉只记一行，不影响结果——
 * 新进程侧还有一次过期清理兜底（`cleanupSpec`）。
 */
function discardSpec(specPath, log) {
  try {
    unlinkSync(specPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`删 spec.json 失败（不影响结果）：${describe(error)}`)
  }
}

/** 失败路径专用：清掉待办，避免下次启动投出一条「谎报成功」的续作消息。 */
function discardPending(dir, log) {
  try {
    unlinkSync(path.join(dir, 'pending.json'))
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`删 pending.json 失败：${describe(error)}`)
  }
}

/**
 * CLI 入口。没有 specPath 时**没有地方**可以写 last.json（契约要求它写在 spec 同目录），
 * 只能返回非零退出码。
 */
export async function main(argv = process.argv, options = {}) {
  const specPath = argv[2]
  if (typeof specPath !== 'string' || specPath.trim() === '') return 1
  const result = await runHelper(specPath, options)
  return result.exitCode
}

/** 只有**直接被 node 执行**时才跑 CLI（被 import 时只导出可测函数）。 */
export const isDirectRun = (() => {
  if (import.meta.main === true) return true
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  try {
    return pathToFileURL(entry).href === import.meta.url
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main()
    .then((code) => {
      process.exit(code)
    })
    .catch((error) => {
      // 兜底：连 runHelper 都抛了（不该发生），也要留下 last.json 的失败记录。
      try {
        const specPath = process.argv[2]
        if (typeof specPath === 'string' && specPath.trim() !== '') {
          writeLastAtomic(path.dirname(path.resolve(specPath)), {
            restartId: null,
            ok: false,
            error: `辅助进程内部错误：${describe(error)}`,
            stage: STAGES.unknown,
            durationMs: 0,
            finishedAt: Date.now(),
            logFile: null,
          })
        }
      } catch {
        // 写不下去就只能靠退出码
      }
      process.exit(1)
    })
}
