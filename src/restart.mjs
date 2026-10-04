/**
 * 热重启的纯逻辑：阻塞项计算、限频、启动规格构造、状态文件读写、续作消息拼装。
 *
 * 与 `src/session-delete.mjs` 一样，本文件**不 import cordis，也不 import 任何 `@deepseek-ai/*` 包**
 * （AGENTS.md 3.7）：只用 Node 内置模块与 `./shared.mjs`，全部外部能力由调用方注入，
 * 离线测试因此可以用假对象驱动真正的判定序列（AGENTS.md 第 6 节）。
 *
 * 失败语义：**能判定的就判死，判不了的一律拒绝**。启动规格少一个字段、形状不对，一律抛
 * `ControlError`（带码），绝不返回半个对象、绝不假装重启可行（docs/PLAN-hot-restart.md 第 8 节）。
 * 唯一的例外是「读状态文件」那一组：重启流程里读失败不该炸掉插件，它们读不出来就返回 `undefined`，
 * 由调用方按「没有待办」处理；写失败则原样抛出，由调用方收敛成明确拒绝。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'

import { ControlError, ERROR_CODES } from './shared.mjs'

/** 限频窗口：这段时间内最多允许 `RATE_LIMIT_MAX` 次重启。 */
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000

/** 窗口内允许的重启次数上限。第 3 次通过，第 4 次拒绝。 */
export const RATE_LIMIT_MAX = 3

/** 同一会话的冷却时间：防止模型陷进「重启 → 继续 → 再重启」的死循环。 */
export const SESSION_COOLDOWN_MS = 60 * 1000

/** 待办记录的过期时间：新进程发现超过这个岁数的待办就丢弃，不再投递续作消息。 */
export const PENDING_MAX_AGE_MS = 10 * 60 * 1000

/**
 * 待办状态机（机器可读，英文）。
 *
 * `scheduled` = 旧进程已写盘、还没派生辅助进程；`helper-started` = 辅助进程已经在跑了。
 * 新进程看到 `helper-started` 才能确定这次重启真的发生过；`scheduled` 可能是写盘之后又取消掉的。
 */
export const PENDING_STATES = Object.freeze({
  scheduled: 'scheduled',
  helperStarted: 'helper-started',
})

/** 状态文件的默认权限：只有当前用户可读写（`spec.json` 里有环境变量，必须收紧）。 */
const DEFAULT_FILE_MODE = 0o600

/** `pending.json` / `last.json` 的文件名。 */
const PENDING_FILE = 'pending.json'
const LAST_FILE = 'last.json'

/** 随机后缀的字符表：小写字母 + 数字（机器可读 id 只用这一组）。 */
const RANDOM_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** reason 的长度上限（字符数，trim 之后算）。 */
const REASON_MAX_LENGTH = 300

/** resume_note 的长度上限（字符数，trim 之后算）。 */
const RESUME_NOTE_MAX_LENGTH = 500

// ---------------------------------------------------------------------------
// 路径与 id
// ---------------------------------------------------------------------------

/**
 * 重启状态目录：`$DSH_HOME/agent-control/restart`。
 *
 * @param {string} dshHome - `$DSH_HOME`。
 * @returns {string} 目录绝对路径。
 * @throws {ControlError} 取不到 DSH_HOME 时抛 RESTART_UNSUPPORTED（没有它就没有可写的地方）。
 */
export function restartDir(dshHome) {
  return path.join(requireDshHome(dshHome), 'agent-control', 'restart')
}

/**
 * 本次重启的日志文件：`$DSH_HOME/logs/agent-control-restart-<yyyyMMdd-HHmmss>.log`。
 *
 * 时间戳按**本地时间**排版，只用于人读与排序（文件名不参与任何逻辑判定）。
 *
 * @param {string} dshHome - `$DSH_HOME`。
 * @param {number} [now] - 时间戳（毫秒）；非有限数时取当下。
 * @returns {string} 日志文件绝对路径。
 * @throws {ControlError} 取不到 DSH_HOME 时抛 RESTART_UNSUPPORTED。
 */
export function restartLogFile(dshHome, now = Date.now()) {
  return path.join(requireDshHome(dshHome), 'logs', `agent-control-restart-${localStamp(now)}.log`)
}

/**
 * 造一个重启 id：`r-<36 进制时间>-<6 位随机>`。
 *
 * 只要求同一台机器上「同毫秒内不重样」：随机后缀有 36^6 种，够用；id 不承担鉴权职责。
 *
 * @param {number} [now] - 时间戳（毫秒）；非有限数时取当下。
 * @returns {string} 非空的重启 id。
 */
export function newRestartId(now = Date.now()) {
  return `r-${base36Time(now)}-${randomSuffix(6)}`
}

/**
 * 造一个启动标识：`b-<36 进制时间>-<6 位随机>`。
 *
 * 每次调用都不同——重启后的「就绪探针」就是拿它跟旧值比对（`status` 里的 bootId 变了 = 新进程活着）。
 *
 * @param {number} [now] - 时间戳（毫秒）；非有限数时取当下。
 * @returns {string} 非空的启动标识。
 */
export function newBootId(now = Date.now()) {
  return `b-${base36Time(now)}-${randomSuffix(6)}`
}

// ---------------------------------------------------------------------------
// 阻塞项
// ---------------------------------------------------------------------------

/**
 * 算出现在重启会打断谁。
 *
 * 规则（docs/PLAN-hot-restart.md 2.1 的守卫）：
 *   - 只有 `status === 'running'` 的 agent 算「在跑」；
 *   - **调用者自己不算阻塞**——它正等着重启，重启就是它要的；
 *   - **调用者的后代算阻塞**：沿 `parentSessionId` 链（可能多级）能追到调用者的 agent，
 *     即使 running 也照算——重启会打断它自己派出去的子代理，那不是「自己的事」；
 *   - 其他 running 的 agent 一律算阻塞；
 *   - `jobs` 里 `running` / `stopping` 的算阻塞，**owner 是调用者自己的也算**（重启同样会打断它）。
 *
 * 返回的 `title` 拿不到就是空串，**不编造**（AGENTS.md 坑 ⑨）；宁可少一行说明，
 * 也不能在给模型的文案里出现「未知」「?」这种假装有信息的占位。
 *
 * 两个 id 的两种磁盘拼写（`<uuid>` 与 `session-<uuid>`）都会被归一后比较，
 * 但返回的 `sessionId` 保持宿主给的**原拼写**——调用方要拿它去查会话。
 *
 * @param {{ agents?: Array<{ id?: unknown, status?: unknown, title?: unknown, parentSessionId?: unknown }>, jobs?: Array<{ id?: unknown, label?: unknown, kind?: unknown, status?: unknown }>, callerId?: unknown }} [input] - 现场快照。
 * @returns {{ sessions: Array<{ sessionId: string, title: string, descendant: boolean }>, jobs: Array<{ id: string, label: string, kind: string }> }} 阻塞明细。
 * @throws {ControlError} `agents` / `jobs` 不是数组时抛 INVALID_REQUEST（宁可拒绝，不假装没阻塞）。
 */
export function computeBlockers(input = {}) {
  const agents = requireList(input.agents, 'agents')
  const jobs = requireList(input.jobs, 'jobs')
  const caller = bareSessionId(input.callerId)

  // 先建索引，才能沿 parentSessionId 往上追（父链上的条目可能不是 running，照样要能查到）。
  const byId = new Map()
  for (const entry of agents) {
    if (!isRecord(entry)) continue
    const id = bareSessionId(entry.id)
    if (id !== '' && !byId.has(id)) byId.set(id, entry)
  }

  const sessions = []
  for (const entry of agents) {
    if (!isRecord(entry) || entry.status !== 'running') continue
    if (caller !== '' && bareSessionId(entry.id) === caller) continue
    sessions.push({
      sessionId: textOf(entry.id),
      title: textOf(entry.title),
      descendant: caller !== '' && isDescendantOf(entry, caller, byId),
    })
  }

  const running = []
  for (const entry of jobs) {
    if (!isRecord(entry)) continue
    if (entry.status !== 'running' && entry.status !== 'stopping') continue
    running.push({ id: textOf(entry.id), label: textOf(entry.label), kind: textOf(entry.kind) })
  }

  return { sessions, jobs: running }
}

/**
 * 把阻塞明细写成一句给模型读的中文。
 *
 * 没有阻塞就是**空串**（调用方据此判断能不能继续），不要去编「一切正常」之类的客套话。
 *
 * @param {{ sessions?: Array<{ sessionId?: unknown, title?: unknown }>, jobs?: unknown[] } | undefined} blockers - `computeBlockers` 的结果。
 * @returns {string} 无阻塞时为空串。
 */
export function blockerMessage(blockers) {
  const sessions = Array.isArray(blockers?.sessions) ? blockers.sessions : []
  const jobs = Array.isArray(blockers?.jobs) ? blockers.jobs : []
  const parts = []
  if (sessions.length > 0) {
    const names = sessions.map((session) => textOf(session?.title) || textOf(session?.sessionId) || '（未知会话）')
    parts.push(`另有 ${sessions.length} 个会话在运行：${names.join('、')}；待其结束后再试`)
  }
  if (jobs.length > 0) {
    parts.push(`另有 ${jobs.length} 个后台任务在运行；先结束或等待它们再试`)
  }
  return parts.join('；')
}

// ---------------------------------------------------------------------------
// 限频
// ---------------------------------------------------------------------------

/**
 * 判断这次重启请求是否被限频挡下。
 *
 * `history` 由调用方记账，**只放真正发起过的重启**（`ok` 字段本函数不看：要不要把失败的尝试也算进去，
 * 是记账方的决定）。两道闸门：
 *   1. 同一会话在 `SESSION_COOLDOWN_MS` 内出现过 ⇒ 拒绝（防模型死循环）；
 *   2. 窗口 `RATE_LIMIT_WINDOW_MS` 内的条目达到 `RATE_LIMIT_MAX` 条 ⇒ 拒绝（恰好第 3 次通过、第 4 次拒绝）。
 *
 * 边界与异常都按「更安全的一侧」定：`at` 正好落在窗口边界（`now - at === 窗口`）**不算**在窗口内
 * （用严格 `>` 判断，否则一次重启会卡住两倍时间）；`now` 早于 `at`（时钟回拨）**直接拒绝**——
 * 时钟不可信时，任何「窗口内还有几次」的计算都是错的，放行可能造成重启风暴。
 *
 * @param {{ history?: Array<{ at?: unknown, sessionId?: unknown, ok?: unknown }>, now?: number, sessionId?: string }} [input] - 账本与当下。
 * @returns {{ ok: true } | { ok: false, code: string, retryAfterMs: number, message: string }} 判定结果。
 * @throws {ControlError} `history` 不是数组、`now` 不是有限数时抛 INVALID_REQUEST。
 */
export function checkRateLimit(input = {}) {
  const now = resolveNow(input.now)
  const history = requireList(input.history, 'history')
  const entries = history.filter((entry) => isRecord(entry) && Number.isFinite(entry.at))

  // 时钟回拨：账本里出现了「未来」的时间戳，此时窗口计算不可信，一律拒绝。
  const future = entries.find((entry) => entry.at > now)
  if (future !== undefined) {
    return limited(
      Math.max(1, Math.ceil(future.at - now)),
      '检测到时钟回拨（重启记录的时间戳晚于当前时间），限频无法可靠计算，已拒绝；请校准系统时间后再试',
    )
  }

  const sessionId = textOf(input.sessionId)
  if (sessionId !== '') {
    let latest
    for (const entry of entries) {
      if (entry.sessionId !== sessionId) continue
      if (latest === undefined || entry.at > latest) latest = entry.at
    }
    if (latest !== undefined && now - latest < SESSION_COOLDOWN_MS) {
      const retryAfterMs = Math.max(1, Math.ceil(SESSION_COOLDOWN_MS - (now - latest)))
      return limited(
        retryAfterMs,
        `同一会话在 ${Math.round(SESSION_COOLDOWN_MS / 1000)} 秒内已经重启过一次；请等待约 ${Math.ceil(retryAfterMs / 1000)} 秒后再试`,
      )
    }
  }

  const inWindow = entries.filter((entry) => entry.at > now - RATE_LIMIT_WINDOW_MS)
  if (inWindow.length >= RATE_LIMIT_MAX) {
    const oldest = inWindow.reduce((min, entry) => Math.min(min, entry.at), Infinity)
    const retryAfterMs = Math.max(1, Math.ceil(oldest + RATE_LIMIT_WINDOW_MS - now))
    return limited(
      retryAfterMs,
      `最近 ${Math.round(RATE_LIMIT_WINDOW_MS / 60000)} 分钟内已经重启过 ${inWindow.length} 次（上限 ${RATE_LIMIT_MAX} 次）；请等待约 ${Math.ceil(retryAfterMs / 1000)} 秒后再试`,
    )
  }

  return { ok: true }
}

/**
 * 往账本里追加一条重启记录，并裁掉窗口外的旧条目。
 *
 * 返回**新数组**，不碰入参（调用方可能正把旧数组交给别处读）。不排序：按时间升序是调用方的契约，
 * 这里悄悄重排只会掩盖调用方的记账 bug。
 *
 * @param {Array<{ at?: unknown, sessionId?: unknown, ok?: unknown }> | undefined} history - 现有账本。
 * @param {{ at?: unknown, sessionId?: unknown, ok?: unknown }} entry - 这次的重启记录（浅拷贝后入账）。
 * @param {number} [now] - 时间戳（毫秒）。
 * @returns {Array<object>} 新账本。
 * @throws {ControlError} `history` 不是数组、`entry` 不是对象、`now` 不是有限数时抛 INVALID_REQUEST。
 */
export function pushRateHistory(history, entry, now = Date.now()) {
  if (!isRecord(entry)) {
    throw new ControlError(ERROR_CODES.invalidRequest, '限频记录必须是一个对象')
  }
  const at = resolveNow(now)
  const kept = requireList(history, 'history').filter(
    (item) => isRecord(item) && Number.isFinite(item.at) && item.at > at - RATE_LIMIT_WINDOW_MS,
  )
  const record = { ...entry }
  // `at` 是窗口计算的唯一依据，缺了它这条记录永远不会被算进去——补成当下，别写出一条查不到的时间。
  if (!Number.isFinite(record.at)) record.at = at
  return [...kept, record]
}

// ---------------------------------------------------------------------------
// 启动参数与启动规格
// ---------------------------------------------------------------------------

/**
 * 在重放的启动参数里补上 `--no-open`。
 *
 * **为什么必须由调用方显式说明「这是不是 web 应用」**：`dsh web` 只是 `--profile web` 的简写，
 * 启动器会把它消化成 `--profile` 的值，进程里真实的 `process.argv.slice(1)` 形如（M0 原型实测，
 * 见 docs/SPIKE-hot-restart.md 的 S2）：
 *
 *     ["C:\\...\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js", "--profile", "<profile 名>", "--no-open", "--port", "10727"]
 *
 * 也就是 `argv[0]` 是 bin.js 的路径，**根本没有 `'web'` 这个 token**；而 `--profile` 后面跟的
 * profile 名又可能恰好叫 `web`。所以「是不是 web 应用」不是纯逻辑层能可靠判定的事实，由 host 接线传入
 * （它运行时就知道自己有没有 `webServer`），本函数只按 `options.isWebApp` 决定加不加。
 * 对别的 app 追加 `--no-open` 会变成用法错误——猜错的代价比不猜大。
 *
 * 位置规则：追加在 `--` **之前**的末尾（`--` 之后是位置参数，不能动），已有 `--no-open` 时不重复追加。
 *
 * @param {string[]} argv - `process.argv.slice(1)` 形态的启动参数。
 * @param {{ isWebApp?: boolean }} [options] - `isWebApp` 缺省 `false`。
 * @returns {string[]} 新数组（入参不变）。
 */
export function appendNoOpen(argv, options = {}) {
  const out = Array.isArray(argv) ? [...argv] : []
  if (options?.isWebApp !== true) return out
  const separator = out.indexOf('--')
  const head = separator === -1 ? out : out.slice(0, separator)
  if (head.includes('--no-open')) return out
  if (separator === -1) out.push('--no-open')
  else out.splice(separator, 0, '--no-open')
  return out
}

/**
 * 把启动现场规范化成可以写进 `spec.json`、并且能被原样重放的启动规格。
 *
 * 返回值**必须可 JSON 序列化**：`env` 的值一律当字符串处理（非字符串用 `String()` 转，
 * `null` / `undefined` 直接丢弃——环境变量里没有这两种值，转成 `'null'` 反而是编造数据）；
 * 可选字段拿不到就写 `null`（不是 `undefined`），这样 `JSON.parse(JSON.stringify(spec))` 与原对象
 * 逐键相等，落盘再读回来不会「少几个键」。键名与形状是冻结契约（docs/PLAN-hot-restart.md 3.5）。
 *
 * ⚠️ **这里不追加 `--no-open`**：那一步由调用方用 `appendNoOpen` 备好再传进来（见该函数的说明）。
 *
 * ⚠️ **`argv` 的形状**：就是 `process.argv.slice(1)`，**第一项是 bin.js 的脚本路径**（不是空数组、
 * 也不含 node 自身）。辅助进程按 `spawn(execPath, [...execArgv, ...argv])` 原样重放——`execPath` 是
 * `node.exe` 时，`argv[0]` 正好充当脚本参数位。把入口脚本从 `argv` 里拿掉会让新进程去执行一个名叫
 * `<profile 名>` 的文件（实测过的 `dsh web` 简写形态尤其容易踩），所以两边的约定必须一致。
 *
 * @param {{ execPath?: unknown, execArgv?: unknown, argv?: unknown, cwd?: unknown, env?: unknown, oldPid?: unknown, oldBootId?: unknown, statusUrl?: unknown, logFile?: unknown, restartId?: unknown, now?: unknown }} [input] - 启动现场。
 * @returns {{ execPath: string, execArgv: string[], argv: string[], cwd: string, env: Record<string, string>, oldPid: number, oldBootId: string | null, statusUrl: string | null, logFile: string | null, restartId: string | null, createdAt: number }} 启动规格。
 * @throws {ControlError} 任何必需字段缺失或形状不对时抛 RESTART_UNSUPPORTED（这个部署重放不了启动，绝不能假装可以）。
 */
export function buildLaunchSpec(input = {}) {
  const execPath = requireSpecText(input.execPath, '取不到运行时路径（process.execPath），无法重放启动')

  if (!Array.isArray(input.argv) || input.argv.length === 0) {
    throw unsupported('取不到启动参数（argv），无法重放启动')
  }
  const argv = input.argv.map((item, index) => {
    if (typeof item !== 'string' || item === '') {
      throw unsupported(`启动参数 argv[${index}] 不是非空字符串，无法重放启动`)
    }
    return item
  })

  let execArgv = []
  if (input.execArgv !== undefined && input.execArgv !== null) {
    if (!Array.isArray(input.execArgv)) {
      throw unsupported('运行时参数（execArgv）不是数组，无法重放启动')
    }
    execArgv = input.execArgv.map((item, index) => {
      if (typeof item !== 'string' || item === '') {
        throw unsupported(`运行时参数 execArgv[${index}] 不是非空字符串，无法重放启动`)
      }
      return item
    })
  }

  const cwd = requireSpecText(input.cwd, '取不到工作目录（cwd），无法重放启动')

  if (!isRecord(input.env)) {
    throw unsupported('取不到环境变量（env），无法重放启动')
  }
  const env = {}
  for (const [key, value] of Object.entries(input.env)) {
    if (value === undefined || value === null) continue
    env[key] = typeof value === 'string' ? value : String(value)
  }
  if (Object.keys(env).length === 0) {
    throw unsupported('环境变量（env）是空的，无法重放启动')
  }

  if (!Number.isSafeInteger(input.oldPid) || input.oldPid <= 0) {
    throw unsupported('取不到旧进程 pid（oldPid），无法确认旧进程已经退出')
  }

  let createdAt
  if (input.now === undefined || input.now === null) createdAt = Date.now()
  else if (Number.isFinite(input.now)) createdAt = input.now
  else throw unsupported('now 不是有限数，无法给启动规格打时间戳')

  return {
    execPath,
    execArgv,
    argv,
    cwd,
    env,
    oldPid: input.oldPid,
    oldBootId: optionalSpecText(input.oldBootId, 'oldBootId'),
    // statusUrl 为 null 表示新进程无法探测就绪：辅助进程会走降级路径（不假装成功）。
    statusUrl: optionalSpecText(input.statusUrl, 'statusUrl'),
    logFile: optionalSpecText(input.logFile, 'logFile'),
    restartId: optionalSpecText(input.restartId, 'restartId'),
    createdAt,
  }
}

/**
 * 待办记录是否已经过期。
 *
 * `createdAt` 不是有限数（缺字段、被改坏、根本不是对象）**一律算过期**：宁可漏投一次续作消息，
 * 也不能拿一条来路不明的待办去打断新进程里的会话。
 *
 * @param {{ createdAt?: unknown } | undefined} entry - 待办记录。
 * @param {number} [now] - 当下时间戳（毫秒）。
 * @param {number} [maxAgeMs] - 过期阈值，缺省 `PENDING_MAX_AGE_MS`。
 * @returns {boolean} 是否过期。
 * @throws {ControlError} `now` 不是有限数时抛 INVALID_REQUEST。
 */
export function isStale(entry, now = Date.now(), maxAgeMs = PENDING_MAX_AGE_MS) {
  const at = resolveNow(now)
  const limit = Number.isFinite(maxAgeMs) ? maxAgeMs : PENDING_MAX_AGE_MS
  const createdAt = isRecord(entry) ? entry.createdAt : undefined
  if (!Number.isFinite(createdAt)) return true
  return at - createdAt > limit
}

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

/**
 * 读一个 JSON 文件。
 *
 * 读不到、不是合法 JSON、顶层不是对象（数组、`null`、字符串…）**都返回 `undefined`**，不抛——
 * 这个函数只服务于重启流程的状态文件，读坏了应当被当成「没有」，而不是让插件加载失败。
 *
 * @param {string} file - 文件绝对路径。
 * @returns {Record<string, unknown> | undefined} 解析出的对象，或 `undefined`。
 */
export function readJson(file) {
  if (typeof file !== 'string' || file === '') return undefined
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  return isRecord(value) ? value : undefined
}

/**
 * 原子地写一个 JSON 文件：同目录临时文件 → `fsync` → `rename`。
 *
 * 同目录是必须的（跨卷 `rename` 不是原子操作，会退化成复制）。权限默认 `0o600`：
 * `spec.json` 里有环境变量，`pending.json` 里有工作内容，都不该对同机其他用户可读。
 *
 * 写失败**原样抛出**（不吞、不改写成别的错误），由调用方收敛成明确拒绝；临时文件在失败路径上
 * 会被清掉，成功路径上不会留下任何残留（改名之后目录里只剩目标文件）。
 *
 * @param {string} file - 目标文件绝对路径。
 * @param {unknown} value - 要写入的值（必须可 JSON 序列化）。
 * @param {{ mode?: number }} [options] - `mode` 缺省 `0o600`。
 * @returns {string} 目标文件路径。
 * @throws {ControlError} 值不可 JSON 序列化时抛 INVALID_REQUEST。
 * @throws {Error} 文件系统错误原样抛出。
 */
export function writeJsonAtomic(file, value, options = {}) {
  if (typeof file !== 'string' || file === '') {
    throw new ControlError(ERROR_CODES.invalidRequest, '写入状态文件需要一个文件路径')
  }
  const text = JSON.stringify(value, null, 2)
  if (typeof text !== 'string') {
    throw new ControlError(ERROR_CODES.invalidRequest, '要写入的值不是可 JSON 序列化的内容')
  }
  const mode = Number.isInteger(options?.mode) ? options.mode : DEFAULT_FILE_MODE
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomSuffix(6)}.tmp`)

  let fd
  try {
    fd = openSync(temp, 'w', mode)
    writeSync(fd, `${text}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, file)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 关闭失败不掩盖原始错误。
      }
    }
    try {
      rmSync(temp, { force: true })
    } catch {
      // 临时文件清不掉同样不掩盖原始错误：路径已经写在文件名里，够排查了。
    }
    throw error
  }
  return file
}

/**
 * 删掉一个文件，不存在就算了（幂等）。
 *
 * @param {string} file - 文件绝对路径。
 * @returns {boolean} 是否真的删掉了一个存在的文件。
 */
export function removeFile(file) {
  if (typeof file !== 'string' || file === '') return false
  const existed = existsSync(file)
  // `force` 让「本来就没有」不算失败；权限之类的真实错误照样抛出去。
  rmSync(file, { force: true })
  return existed
}

/**
 * 读待办记录 `pending.json`。
 *
 * @param {string} dir - 状态目录（`restartDir`）。
 * @returns {Record<string, unknown> | undefined} 待办记录，或 `undefined`（没有 / 读坏了）。
 */
export function readPending(dir) {
  return readJson(safeJoin(dir, PENDING_FILE))
}

/**
 * 写待办记录 `pending.json`（`mkdir -p` + 原子写，权限 `0o600`）。
 *
 * @param {string} dir - 状态目录（`restartDir`）。
 * @param {Record<string, unknown>} entry - 待办记录（至少要有 `state` 与 `createdAt`，由调用方保证）。
 * @returns {Record<string, unknown>} 写入的 entry（原对象）。
 * @throws {ControlError} `entry` 不是对象、或缺目录时抛 INVALID_REQUEST。
 */
export function writePending(dir, entry) {
  if (!isRecord(entry)) {
    throw new ControlError(ERROR_CODES.invalidRequest, '待办记录必须是一个对象')
  }
  writeJsonAtomic(path.join(requireStateDir(dir), PENDING_FILE), entry)
  return entry
}

/**
 * 清掉待办记录（幂等：本来就没有也算成功）。
 *
 * 新进程**投递之前**就要清掉它：至多投递一次，宁可漏投，也不能因为中途崩溃而重复投递。
 *
 * @param {string} dir - 状态目录（`restartDir`）。
 * @returns {boolean} 是否真的删掉了文件。
 * @throws {ControlError} 缺目录时抛 INVALID_REQUEST。
 */
export function clearPending(dir) {
  return removeFile(path.join(requireStateDir(dir), PENDING_FILE))
}

/**
 * 读最近一次重启的结果 `last.json`。
 *
 * @param {string} dir - 状态目录（`restartDir`）。
 * @returns {Record<string, unknown> | undefined} 结果记录，或 `undefined`（没有 / 读坏了）。
 */
export function readLast(dir) {
  return readJson(safeJoin(dir, LAST_FILE))
}

/**
 * 写最近一次重启的结果 `last.json`（`mkdir -p` + 原子写，权限 `0o600`）。
 *
 * @param {string} dir - 状态目录（`restartDir`）。
 * @param {Record<string, unknown>} record - 结果记录。
 * @returns {Record<string, unknown>} 写入的 record（原对象）。
 * @throws {ControlError} `record` 不是对象、或缺目录时抛 INVALID_REQUEST。
 */
export function writeLast(dir, record) {
  if (!isRecord(record)) {
    throw new ControlError(ERROR_CODES.invalidRequest, '重启结果记录必须是一个对象')
  }
  writeJsonAtomic(path.join(requireStateDir(dir), LAST_FILE), record)
  return record
}

// ---------------------------------------------------------------------------
// 续作消息与入参校验
// ---------------------------------------------------------------------------

/**
 * 拼装重启后投递给会话的续作消息（docs/PLAN-hot-restart.md 2.1）。
 *
 * 首行是机器可读标记，正文全中文。这个函数跑在**新进程**里、读的是落盘的待办，
 * 所以它**不抛错**：字段缺了就写「未说明」「未知」「无」，绝不因为一条记录写坏而让续作流程炸掉，
 * 也绝不编造原因（AGENTS.md 坑 ⑨）。
 *
 * @param {{ reason?: unknown, durationMs?: unknown, resumeNote?: unknown }} [input] - 待办里的字段。
 * @returns {string} 多行中文消息。
 */
export function buildResumeMessage(input = {}) {
  const reason = textOf(input.reason) || '未说明'
  const duration = Number.isFinite(input.durationMs)
    ? `${Math.max(0, Math.round(input.durationMs / 1000))} 秒`
    : '未知'
  const note = textOf(input.resumeNote) || '无'
  return [
    '[系统通知 · DSH 已热重启]',
    `原因：${reason}`,
    `耗时：${duration}`,
    `你重启前留下的续作说明：${note}`,
    '请从中断处继续刚才的工作；先快速确认重启生效（例如检查刚装的插件是否已加载），无需向用户重复解释。',
  ].join('\n')
}

/**
 * 校验并规范化工具参数 `reason`。
 *
 * @param {unknown} value - 待校验的值。
 * @returns {string} trim 后的原因（1–300 字符）。
 * @throws {ControlError} 非字符串、空串、超长时抛 INVALID_REQUEST。
 */
export function assertRestartReason(value) {
  if (typeof value !== 'string') {
    throw new ControlError(ERROR_CODES.invalidRequest, `reason 必须是字符串（1–${REASON_MAX_LENGTH} 字符）`)
  }
  const reason = value.trim()
  if (reason === '') {
    throw new ControlError(ERROR_CODES.invalidRequest, '缺少 reason：必须说明为什么需要重启')
  }
  if (reason.length > REASON_MAX_LENGTH) {
    throw new ControlError(ERROR_CODES.invalidRequest, `reason 过长：${reason.length} 字符，上限 ${REASON_MAX_LENGTH} 字符`)
  }
  return reason
}

/**
 * 校验并规范化工具参数 `resume_note`。
 *
 * 选填：`undefined` / `null` / 空串（含只有空白）都归一成 `undefined`，由调用方按「没留说明」处理。
 *
 * @param {unknown} value - 待校验的值。
 * @returns {string | undefined} trim 后的续作说明，或 `undefined`。
 * @throws {ControlError} 非字符串（且不是 null/undefined）、超长时抛 INVALID_REQUEST。
 */
export function assertResumeNote(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ControlError(ERROR_CODES.invalidRequest, `resume_note 必须是字符串（≤${RESUME_NOTE_MAX_LENGTH} 字符）`)
  }
  const note = value.trim()
  if (note === '') return undefined
  if (note.length > RESUME_NOTE_MAX_LENGTH) {
    throw new ControlError(ERROR_CODES.invalidRequest, `resume_note 过长：${note.length} 字符，上限 ${RESUME_NOTE_MAX_LENGTH} 字符`)
  }
  return note
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** `$DSH_HOME` 的取值校验：没有它就没有可写的地方。 */
function requireDshHome(dshHome) {
  const home = textOf(dshHome)
  if (home === '') {
    throw new ControlError(ERROR_CODES.restartUnsupported, '取不到 DSH_HOME，无法定位重启状态目录')
  }
  return home
}

/** 状态目录的取值校验（调用方可能从配置里拿到一个空值）。 */
function requireStateDir(dir) {
  const value = textOf(dir)
  if (value === '') {
    throw new ControlError(ERROR_CODES.invalidRequest, '缺少重启状态目录，无法读写状态文件')
  }
  return value
}

/** 拼路径，但目录为空时返回空串，让 `readJson` 直接返回 `undefined`（读侧不抛错）。 */
function safeJoin(dir, name) {
  const value = textOf(dir)
  return value === '' ? '' : path.join(value, name)
}

/** 统一构造 RESTART_UNSUPPORTED。 */
function unsupported(message) {
  return new ControlError(ERROR_CODES.restartUnsupported, message)
}

/** 统一构造限频拒绝（`retryAfterMs` 一定是正整数）。 */
function limited(retryAfterMs, message) {
  return {
    ok: false,
    code: ERROR_CODES.restartRateLimited,
    retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)),
    message,
  }
}

/** 数组取值：缺省当成空数组，给了别的类型就拒绝（不假装什么都没在跑）。 */
function requireList(value, name) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ControlError(ERROR_CODES.invalidRequest, `${name} 必须是数组`)
  }
  return value
}

/** 时间戳取值：缺省取当下，给了非有限数就拒绝。 */
function resolveNow(now) {
  if (now === undefined || now === null) return Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new ControlError(ERROR_CODES.invalidRequest, 'now 必须是毫秒时间戳（有限数）')
  }
  return now
}

/** 启动规格里的必需文本字段。 */
function requireSpecText(value, message) {
  const text = textOf(value)
  if (text === '') throw unsupported(message)
  return text
}

/** 启动规格里的可选文本字段：拿不到写 `null`（保持 JSON 往返后键不丢）。 */
function optionalSpecText(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw unsupported(`${field} 不是字符串，无法写进启动规格`)
  return value === '' ? null : value
}

/** 是不是「普通的对象」（不是 null、不是数组）。 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 取一个非空字符串字段，拿不到就是空串（不编造，见 AGENTS.md 坑 ⑨）。 */
function textOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

/**
 * 会话 id 归一：去掉 `session-` 前缀。
 *
 * 磁盘与内存里两种拼写并存（见 `sessionDirNames`），比较「是不是同一个会话」时必须归一。
 */
function bareSessionId(value) {
  const id = textOf(value)
  if (id === '') return ''
  return id.startsWith('session-') ? id.slice('session-'.length) : id
}

/**
 * 沿 `parentSessionId` 链往上追，看能不能追到调用者。
 *
 * 环（父链被写坏）时直接判定「不是后代」并停下，绝不无限往上爬。
 */
function isDescendantOf(entry, callerBare, byId) {
  const seen = new Set()
  let current = isRecord(entry) ? bareSessionId(entry.parentSessionId) : ''
  while (current !== '') {
    if (current === callerBare) return true
    if (seen.has(current)) return false
    seen.add(current)
    const parent = byId.get(current)
    current = isRecord(parent) ? bareSessionId(parent.parentSessionId) : ''
  }
  return false
}

/** `<36 进制毫秒时间>`；时间戳不可信时取当下。 */
function base36Time(now) {
  const at = Number.isFinite(now) ? Math.floor(now) : Date.now()
  return at.toString(36)
}

/** `yyyyMMdd-HHmmss`，本地时间。 */
function localStamp(now) {
  const at = new Date(Number.isFinite(now) ? now : Date.now())
  const pad = (value) => String(value).padStart(2, '0')
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

/** 随机后缀：只用于让同一毫秒内多次调用不重样，不承担鉴权职责。 */
function randomSuffix(length) {
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += RANDOM_CHARS[Math.floor(Math.random() * RANDOM_CHARS.length)]
  }
  return out
}
