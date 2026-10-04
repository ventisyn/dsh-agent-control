/**
 * 热重启的 host 接线：模型工具定义、唯一入口 `requestRestart`、后台时序、状态接口的数据、
 * 新进程的「续作投递」与过期启动规格清理。
 *
 * 分工（docs/PLAN-hot-restart.md 第 2 节）：
 *   - `src/restart.mjs` 是**纯逻辑**（阻塞项、限频、启动规格、状态文件、文案），可离线单测；
 *   - `src/restart-helper.mjs` 是**独立脚本**，旧进程退出后由它拉起新进程并等就绪；
 *   - 本文件把上面两块接到宿主上（`ctx` 服务、工具注册、路由数据），**只 import `node:*` 与
 *     本仓库自己的 `.mjs`**：host 端绝不能 import `@deepseek-ai/*`，顶层 import 解析失败会让
 *     整个插件消失（AGENTS.md 3.7）。
 *
 * 失败语义（全项目最重要的一条）：所有失败都收敛成「明确拒绝 + 说清原因」，**绝不假装重启成功**。
 * 预检不过报 `RESTART_UNSUPPORTED`（这个部署做不到），有阻塞项报 `RESTART_BLOCKED`（现在不行），
 * 审批被拒报 `RESTART_DENIED`（没被批准），三者的处置方式不同，不能混为一谈。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ControlError,
  ERROR_CODES,
  PATHS,
  PLUGIN_NAME,
  sessionDirNames,
  toControlError,
} from './shared.mjs'
import {
  PENDING_STATES,
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
  readLast,
  readPending,
  removeFile,
  restartDir,
  restartLogFile,
  writeJsonAtomic,
  writeLast,
  writePending,
} from './restart.mjs'

/** 模型可见的工具名（与 client 侧的常量副本必须一致，见 shared.mjs 的 PATHS）。 */
export const RESTART_TOOL_NAME = PATHS.restartToolName

/**
 * 给用户与模型的停机预期（秒）。
 *
 * 取 M0 实测的上界量级：停机时间由新进程的启动耗时主导（约 4 秒），两次实测的「新进程开始服务」
 * 分别在 +7.3 s 与 +6.2 s（docs/SPIKE-hot-restart.md 的 S6）。这里写 10 秒，是**预期**而不是承诺；
 * 真实耗时以辅助进程写进 `last.json` 的 `durationMs` 为准。
 */
export const EXPECTED_DOWNTIME_SECONDS = 10

/** 审批缺省策略：走 DSH 审批流。配置写坏了也回退到它（见 `resolveApprovalMode`）。 */
export const DEFAULT_APPROVAL_MODE = 'ask'

/** 界面发起重启时没给原因就用这一句（模型发起时 reason 必填，不适用）。 */
export const DEFAULT_UI_REASON = '用户从设置页发起重启'

/** 等「这一轮结束」的上限：超过就取消重启（宁可不动，也不能在轮次没闭合时退出，见计划 F7）。 */
export const IDLE_TIMEOUT_MS = 30 * 1000

/** 拿不到 `appReady` 时，给应用留多少启动时间再投递续作消息。 */
export const RESUME_FALLBACK_MS = 1500

/** 启动规格文件名（放在重启状态目录里；辅助进程把结果写在同一个目录）。 */
const SPEC_FILE = 'spec.json'

/** 旧启动规格的保留上限：新进程启动时顺手清掉超过这个岁数的 `spec.json`（里面有 env）。 */
const SPEC_MAX_AGE_MS = 60 * 60 * 1000

/** 预检探针文件名：试写一次再删掉，用来确认目录真的可写。 */
const PREFLIGHT_PROBE_FILE = '.preflight-probe.json'

// ---------------------------------------------------------------------------
// 进程内状态（重启即清零）
// ---------------------------------------------------------------------------

/**
 * 进程内的重启运行时状态。
 *
 * ⚠️ 这三个变量**只活在当前进程里，进程一退出就全部清零——这正是我们要的**：
 *   - 单飞锁是「这次运行期间最多有一个重启在走」的约束，新进程不该继承上一个进程的锁
 *     （旧进程退出后锁自然消失，新进程从零开始）；
 *   - 限频账本同理，落盘反而会让新进程拿一个它没发起过的历史去拒绝用户；
 *   - 续作投递标记只对「本次启动」有意义。
 * 因此它们**刻意**不写进任何文件，也不在 `apply` 之间重置（重复 apply 只应共享同一把锁）。
 */
const runtime = {
  /** 进行中的重启（单飞锁）：`null` 表示没有。 */
  inFlight: null,
  /** 限频账本：`[{ at, sessionId, ok }]`（进程内数组，重启后清零，可接受）。 */
  rateHistory: [],
  /** 续作投递是否已经在本进程里安排过（同一次启动只安排一次）。 */
  resumeScheduled: false,
}

/**
 * 仅供离线测试：清空进程内的单飞锁与限频账本。
 *
 * 生产代码**永远不该**调用它——这两个变量在真实进程里只能由「进程退出」清零（见上面 runtime 的说明）。
 * 测试需要它，是因为它们在同一个进程里连续跑多个场景，而单飞锁与限频账本按设计不跨测试重置。
 */
export function resetRestartRuntimeForTest() {
  runtime.inFlight = null
  runtime.rateHistory = []
  runtime.resumeScheduled = false
}

// ---------------------------------------------------------------------------
// 依赖（deps）：一次性从 ctx 上读到的现场 + 可注入的副作用
// ---------------------------------------------------------------------------

/**
 * 从 `ctx` 上读一次现场，做成后续回调共用的 `deps`。
 *
 * 「现场」指重启期间**不会变**的东西：pid、bootId、端口、启动参数、状态目录、辅助脚本路径。
 * 「副作用」指必须能在离线测试里替换掉的东西：`schedule`（后台时序的调度器）、`spawn`（派生辅助
 * 进程）、`appExit`（退出进程）。测试传 `schedule: () => {}` 就永远不会真的派生进程或退出。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {{ dshHome?: string, config?: any, now?: () => number, schedule?: (fn: () => void) => void, spawn?: Function, appExit?: Function, pid?: number, bootId?: string, startedAt?: number, port?: number, isWebApp?: boolean, argv?: string[], helperPath?: string, logFile?: string, statusUrl?: string }} [options] - 覆盖项（测试与特殊部署用）。
 * @returns {any} deps。
 */
export function createRestartState(ctx, options = {}) {
  const startedAt = Number.isFinite(options.startedAt) ? options.startedAt : Date.now()
  const dshHome = textOf(options.dshHome) || defaultDshHome()
  // 取不到 DSH_HOME 时目录是空串：路由照常注册，但每次请求都会以 RESTART_UNSUPPORTED 明确拒绝。
  const dir = safeCall(() => restartDir(dshHome)) ?? ''
  const isWebApp = options.isWebApp === undefined
    ? safeCall(() => ctx?.webServer) !== undefined
    : options.isWebApp === true
  const argv = Array.isArray(options.argv) ? options.argv : process.argv.slice(1)
  const explicitPort = Number.isInteger(options.port) ? options.port : undefined
  // `--port 0` = 让 OS 随机分配端口。此时 `webServer.port` 才是真实端口，
  // 不把它写回启动参数的话，新进程会再随机一次、浏览器手上的 URL 当场失效（SPIKE S2 遗留风险 2）。
  const pinPort = safeCall(() => ctx?.get?.('webStartup')?.port) === 0
  const explicitStatusUrl = textOf(options.statusUrl)

  const deps = {
    dshHome,
    dir,
    startedAt,
    pid: Number.isInteger(options.pid) ? options.pid : process.pid,
    bootId: textOf(options.bootId) || newBootId(startedAt),
    host: safeCall(() => ctx?.webServer?.host),
    isWebApp,
    logFile: textOf(options.logFile) || safeCall(() => restartLogFile(dshHome)) || '',
    helperPath: textOf(options.helperPath) || helperScriptPath(),
    execPath: typeof process.execPath === 'string' ? process.execPath : '',
    cwd: process.cwd(),
    env: process.env,
    approvalMode: resolveApprovalMode(options.config),
    now: typeof options.now === 'function' ? options.now : () => Date.now(),
    // 后台时序必须**不在工具调用栈里**跑：setTimeout(0) 把控制权先还给工具层，
    // 让工具结果先落盘、这一轮先结束（计划 2.1 第 3–4 步）。
    //
    // ⚠️ 这个定时器**刻意不 unref**：它必须真的跑完（哪怕进程此刻已经没有别的事可做），
    // 否则「工具返回成功 → 进程正常退出 → 待办留在盘上」会变成一次假重启。
    schedule: typeof options.schedule === 'function' ? options.schedule : (fn) => {
      setTimeout(fn, 0)
    },
    spawn: typeof options.spawn === 'function' ? options.spawn : spawn,
    appExit: typeof options.appExit === 'function' ? options.appExit : undefined,
  }

  // 端口相关的三项做成**惰性读取**：`webServer.port` 只有 listen 完成之后才是真实端口
  // （`--port 0` 时更是 OS 事后分配的）。快照读到 0 会让就绪探针与端口钉住同时失效，
  // 而这两件事恰好是「重启之后浏览器还能不能连上」的关键，所以每次用的时候现读。
  Object.defineProperties(deps, {
    port: {
      enumerable: true,
      get: () => explicitPort ?? (safeCall(() => ctx?.webServer?.port) ?? null),
    },
    statusUrl: {
      enumerable: true,
      get: () => (explicitStatusUrl !== '' ? explicitStatusUrl : statusUrlFor(deps.port)),
    },
    argvForReplay: {
      enumerable: true,
      get: () => pinPortIfNeeded(appendNoOpen(argv, { isWebApp }), { pin: pinPort, port: deps.port }),
    },
  })
  return deps
}

/**
 * 手工校验审批策略配置（host 端不 import schemastery，见计划 3.4）。
 *
 * 未知值一律回退 `ask`：配置写错一个词就变成「免审批重启」是不可接受的，宁可多问一次。
 *
 * @param {{ approval?: unknown } | undefined} config - 插件行的 `config:`。
 * @returns {'ask' | 'auto'} 生效的策略。
 */
export function resolveApprovalMode(config) {
  const value = config?.approval
  if (value === 'auto' || value === 'ask') return value
  return DEFAULT_APPROVAL_MODE
}

/** 会话日志根目录的同一套约定：`$DSH_HOME` 缺省回退 `~/.dsh`。 */
function defaultDshHome() {
  const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return home !== '' ? home : path.join(os.homedir(), '.dsh')
}

/** 本插件自己的辅助脚本（与本文件同目录）。用 `import.meta.url` 解析，不依赖 cwd。 */
function helperScriptPath() {
  return safeCall(() => fileURLToPath(new URL('./restart-helper.mjs', import.meta.url))) ?? ''
}

/** 插件版本（读自己 `package.json` 的 `version`，只读一次）。 */
let pluginVersionCache

/**
 * 读本插件的版本号（给设置页的「运行状态」显示）。
 *
 * 读不到就返回**空串**：状态里干脆不带这个键，界面那一行不显示——
 * 编一个版本号或显示「未知」都是假装有信息（AGENTS.md 坑 ⑨）。
 *
 * @returns {string} 版本号，读不到时为空串。
 */
function pluginVersion() {
  if (pluginVersionCache !== undefined) return pluginVersionCache
  pluginVersionCache = ''
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url))
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed?.version === 'string' && parsed.version !== '') pluginVersionCache = parsed.version
  } catch {
    // 打包/裁剪过的部署里 package.json 可能不在：那是「读不到」，不是错误。
  }
  return pluginVersionCache
}

/**
 * 新进程的就绪探针地址。
 *
 * **探测地址固定用 `127.0.0.1`**：`webServer.host === '0.0.0.0'` 只是「监听所有网卡」，
 * 通过回环地址一样连得上；反过来把 `statusUrl` 写成 `0.0.0.0` 在部分栈上会被拒。
 *
 * @param {number | null} port - 监听端口（OS 分配后的真实端口）。
 * @returns {string} 完整 URL；没有端口时返回空串（= 无法探测就绪，由辅助进程走降级路径）。
 */
function statusUrlFor(port) {
  return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}${PATHS.restartStatus}` : ''
}

/**
 * `--port 0` 时把真实端口钉进重放的启动参数。
 *
 * 为什么必须做：`--port 0` 的语义是「让 OS 随便给一个」，重放同一份 argv 会再随机一次，
 * 浏览器上的地址与新实例对不上（docs/SPIKE-hot-restart.md 的 S2 遗留风险 2）。
 * 已有的 `--port`（`--port 0` 或 `--port=0`）**原地替换**而不是追加，避免 commander 拿到两个值。
 *
 * @param {string[]} argv - 启动参数（含 bin.js 脚本路径）。
 * @param {{ pin?: boolean, port?: number | null }} [options] - `pin` 为真且端口有效时才动手。
 * @returns {string[]} 新数组（入参不变）。
 */
export function pinPortIfNeeded(argv, options = {}) {
  const out = Array.isArray(argv) ? [...argv] : []
  if (options.pin !== true || !Number.isInteger(options.port) || options.port <= 0) return out
  const separator = out.indexOf('--')
  const head = separator === -1 ? out : out.slice(0, separator)
  for (let index = 0; index < head.length; index += 1) {
    if (head[index] === '--port' && index + 1 < head.length) {
      out[index + 1] = String(options.port)
      return out
    }
    if (typeof head[index] === 'string' && head[index].startsWith('--port=')) {
      out[index] = `--port=${options.port}`
      return out
    }
  }
  if (separator === -1) out.push('--port', String(options.port))
  else out.splice(separator, 0, '--port', String(options.port))
  return out
}

// ---------------------------------------------------------------------------
// 预检
// ---------------------------------------------------------------------------

/**
 * 重启预检：**这个部署现在能不能重启**。任何一项拿不到都如实拒绝，绝不假装可以。
 *
 * 「目录可写」只能靠真写一次确认（Windows 上 `access()` 会说谎），所以这里写一个探针文件再删掉；
 * 它每次调用都会做一次小文件写入——状态接口会经常被轮询，但这点代价换来的是**不撒谎的
 * `canRestart`**，值得。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} deps - `createRestartState` 的结果。
 * @returns {{ ok: true } | { ok: false, reason: string }} 判定结果（不抛异常）。
 */
export function preflightRestart(ctx, deps) {
  const fail = (reason) => ({ ok: false, reason })
  if (typeof appExitOf(ctx, deps) !== 'function') {
    return fail('宿主没有提供 appExit，无法在后台安全退出旧进程')
  }
  if (typeof deps.execPath !== 'string' || deps.execPath === '') {
    return fail('取不到运行时路径（process.execPath），无法重放启动')
  }
  if (!Array.isArray(deps.argvForReplay) || deps.argvForReplay.length === 0) {
    return fail('取不到启动参数（process.argv），无法重放启动')
  }
  if (deps.dir === '') {
    return fail('取不到 DSH_HOME，无法定位重启状态目录')
  }
  if (deps.helperPath === '' || !existsSync(deps.helperPath)) {
    return fail(`重启辅助脚本不存在：${deps.helperPath || '（路径未知）'}`)
  }
  // 重放的 argv 第一项必须是入口脚本路径（M0 实测：`process.argv.slice(1)` 的第一项是 bin.js）。
  // 第一项是选项、或整个数组是空的，说明这个进程不是以「脚本 + 参数」的方式起的，
  // 重放它只会起来一个用法错误的新进程——而那时旧进程已经退了，没有回滚（计划第 7 节的风险）。
  if (typeof deps.argvForReplay?.[0] !== 'string' || deps.argvForReplay[0].startsWith('-')) {
    return fail(`启动参数的第一项不是入口脚本路径（${JSON.stringify(deps.argvForReplay?.[0] ?? null)}），无法重放启动`)
  }
  const probe = path.join(deps.dir, PREFLIGHT_PROBE_FILE)
  try {
    writeJsonAtomic(probe, { at: deps.now(), pid: deps.pid })
    removeFile(probe)
  } catch (error) {
    return fail(`重启状态目录不可写：${deps.dir}（${describeError(error)}）`)
  }
  return { ok: true }
}

/** `appExit` 的取值：优先注入实现（测试），否则现查宿主服务。 */
function appExitOf(ctx, deps) {
  if (typeof deps?.appExit === 'function') return deps.appExit
  return safeCall(() => ctx?.get?.('appExit'))
}

// ---------------------------------------------------------------------------
// 可信校验（POST /restart 必做）
// ---------------------------------------------------------------------------

/**
 * `POST /restart` 的可信校验（纯函数，可离线单测）。
 *
 * 两道闸门，**宿主的口径优先、本插件自己的口径兜底**：
 *   1. `ctx.connection.requestRejection({ headers })` 返回 401 / 403 时**照抄**该状态；自建路由
 *      本来就不走 harness 的鉴权链路（AGENTS.md 3.5），宿主愿意替我们判一次就用它的结论。
 *   2. 再按本插件自己的规则判一次：`origin` 存在时它的 host 必须等于 `host` 头；`origin` 缺失时
 *      必须带自定义头 `x-dsh-agent-control: 1`。
 *
 * 为什么第 2 步在服务可用时**也要**做：`requestRejection` 的口径随宿主版本变，而重启接口是
 * 「让进程消失」的能力，多一道同源/自定义头校验只会更保守，不会多放行一个请求。
 *
 * @param {Readonly<Record<string, string | string[] | undefined>> | undefined} headers - 请求头。
 * @param {401 | 403 | undefined} [rejection] - 宿主 `requestRejection` 的结论。
 * @returns {401 | 403 | undefined} 拒绝状态；`undefined` = 放行。
 */
export function checkRestartTrust(headers, rejection) {
  if (rejection === 401 || rejection === 403) return rejection

  const origin = headerValue(headers, 'origin')
  const host = headerValue(headers, 'host')
  if (origin !== '') {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      // `origin: null`（沙箱 iframe、file://）之类的值解析不出来，一律当不可信。
      return 403
    }
    if (host === '' || originHost !== host) return 403
    return undefined
  }
  return headerValue(headers, 'x-dsh-agent-control') === '1' ? undefined : 403
}

/**
 * `content-type` 必须是 `application/json`（允许带 `; charset=...` 参数）。
 *
 * @param {Readonly<Record<string, string | string[] | undefined>> | undefined} headers - 请求头。
 * @returns {boolean} 是否是 JSON 请求。
 */
export function isJsonRequest(headers) {
  const raw = headerValue(headers, 'content-type')
  if (raw === '') return false
  return raw.split(';')[0].trim().toLowerCase() === 'application/json'
}

/** 读一个请求头，取第一个值并 trim（node 的 headers 值可能是数组）。 */
function headerValue(headers, name) {
  if (headers === null || typeof headers !== 'object') return ''
  const raw = headers[name] ?? headers[name.toLowerCase()]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : ''
}

// ---------------------------------------------------------------------------
// 唯一入口
// ---------------------------------------------------------------------------

/**
 * 发起一次热重启：**工具与 HTTP 两条入口都走这里**，护栏、状态、日志因此只有一份。
 *
 * 守卫顺序（每条拒绝都带一个能指导下一步的错误码）：
 *   ① 单飞：已有进行中的重启 ⇒ `RESTART_IN_PROGRESS`；
 *   ② 限频：`checkRateLimit` ⇒ `RESTART_RATE_LIMITED`；
 *   ③ 阻塞项：别的会话 / 后台任务在跑 ⇒ `RESTART_BLOCKED`（`force` 可跳过，界面上的「仍然重启」）；
 *   ④ 预检：`appExit` / 启动规格 / 辅助脚本 / 目录可写 ⇒ `RESTART_UNSUPPORTED`；
 *   ⑤ 审批（仅模型发起且策略不是 `auto`）⇒ `RESTART_DENIED`；
 *   ⑥ 写 `pending.json`、记一次限频，把后台时序排到调用栈之外。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} deps - `createRestartState` 的结果。
 * @param {{ source?: 'model' | 'ui', reason?: string, resumeNote?: string, sessionId?: string, agent?: any, force?: boolean, exec?: any, callId?: any, signal?: AbortSignal }} request - 请求。
 * @returns {Promise<{ restartId: string, expectedDowntimeSeconds: number }>} 已安排的重启。
 * @throws {ControlError} 被拒绝时抛出（带码，路由层映射成 HTTP；工具层映射成结构化错误值）。
 */
export async function requestRestart(ctx, deps, request = {}) {
  const now = deps.now()
  const source = request.source
  if (source !== 'model' && source !== 'ui') {
    throw new ControlError(ERROR_CODES.invalidRequest, `未知的重启来源：${String(source)}`)
  }
  const sessionId = textOf(request.sessionId) || textOf(request.agent?.id)
  const force = request.force === true

  // ① 单飞：进程内一把锁（见 runtime 的说明）。
  if (runtime.inFlight !== null) {
    throw new ControlError(
      ERROR_CODES.restartInProgress,
      `已经有一次重启在进行中（${runtime.inFlight.restartId}，状态 ${runtime.inFlight.state}）；等它结束或新进程起来之后再试`,
    )
  }

  // ② 限频：账本在进程内，重启后清零（可接受，见 runtime 的说明）。
  const limit = checkRateLimit({ history: runtime.rateHistory, now, sessionId })
  if (limit.ok !== true) {
    throw new ControlError(ERROR_CODES.restartRateLimited, limit.message, { detail: { retryAfterMs: limit.retryAfterMs } })
  }

  // ③ 阻塞项：`force` 只跳过这一条，预检与单飞**永远不跳过**。
  if (!force) {
    const blockers = collectBlockers(ctx, sessionId)
    const message = blockerMessage(blockers)
    if (message !== '') {
      throw new ControlError(ERROR_CODES.restartBlocked, message, {
        detail: {
          blockers: {
            sessions: blockers.sessions.map((row) => ({ sessionId: row.sessionId, ...(row.title === '' ? {} : { title: row.title }) })),
            jobs: blockers.jobs.length,
          },
        },
      })
    }
  }

  // ④ 预检。
  const preflight = preflightRestart(ctx, deps)
  if (preflight.ok !== true) {
    throw new ControlError(ERROR_CODES.restartUnsupported, preflight.reason)
  }

  // ⑤ 审批：模型发起且策略为 `ask` 时必须拿到 `allowed-once`。
  const reason = textOf(request.reason)
  if (source === 'model' && deps.approvalMode !== 'auto') {
    const approval = safeCall(() => ctx?.get?.('approval'))
    if (approval === undefined || typeof approval.request !== 'function') {
      // 审批服务不存在时**不静默放行**：拿不到授权就等于没被授权。
      throw new ControlError(
        ERROR_CODES.restartDenied,
        '宿主没有提供审批服务，无法确认这次重启是否被授权，已按拒绝处理；如需免审批，请把插件配置的 approval 设为 auto',
      )
    }
    let outcome
    try {
      outcome = await approval.request({
        agent: request.agent,
        toolName: RESTART_TOOL_NAME,
        callId: request.exec?.callId ?? request.callId,
        reason: reason === '' ? '（未说明原因）' : reason,
        signal: request.exec?.signal ?? request.signal,
      })
    } catch (error) {
      // 审批要求当时有打开的轮次；没有轮次时它 reject。如实转成拒绝并附上原始信息。
      throw new ControlError(ERROR_CODES.restartDenied, `审批请求本身失败了（例如当时没有打开的轮次），已按拒绝处理：${describeError(error)}`)
    }
    if (outcome !== 'allowed-once') throw deniedByOutcome(outcome)
  }

  // ⑥ 落盘 → 记账 → 排后台时序。
  const restartId = newRestartId(now)
  const entry = {
    restartId,
    sessionId,
    source,
    reason,
    resumeNote: textOf(request.resumeNote) || null,
    state: PENDING_STATES.scheduled,
    createdAt: now,
    oldPid: deps.pid,
    oldBootId: deps.bootId,
  }
  try {
    writePending(deps.dir, entry)
  } catch (error) {
    throw new ControlError(ERROR_CODES.restartUnsupported, `写不进重启待办文件（${deps.dir}）：${describeError(error)}`)
  }

  runtime.rateHistory = pushRateHistory(runtime.rateHistory, { at: now, sessionId, ok: true }, now)
  const state = {
    restartId,
    sessionId,
    source,
    reason,
    resumeNote: entry.resumeNote,
    force,
    startedAt: now,
    entry,
    // 状态机上给界面/日志看的字段；`state` 与 pending.json 里的一致。
    state: PENDING_STATES.scheduled,
  }
  runtime.inFlight = state
  // 排到调用栈之外：`schedule` 的缺省实现是 `setTimeout(fn, 0)`，它忽略返回值；
  // 回调返回的 promise **永不 reject**（见 runRestartSequence 的兜底），所以生产路径上不会出现
  // unhandled rejection，而离线测试可以 `await` 它来驱动整个时序。
  deps.schedule(() => runRestartSequence(ctx, deps, state))
  return { restartId, expectedDowntimeSeconds: EXPECTED_DOWNTIME_SECONDS }
}

/** 审批结果 → 拒绝原因。`allowed-once` 之外的每一种都说清是哪一种。 */
function deniedByOutcome(outcome) {
  const detail = {
    rejected: '用户在审批卡片上拒绝了这次重启',
    cancelled: '审批被取消（发起方中断或界面关掉了这次询问）',
    unavailable: '审批服务这次无法给出结论（没有可用的审批应答方），按未授权处理',
  }[outcome]
  const suffix = detail === undefined ? `审批返回了无法识别的结果：${String(outcome)}` : detail
  return new ControlError(ERROR_CODES.restartDenied, `${suffix}；进程没有做任何改动`)
}

// ---------------------------------------------------------------------------
// 阻塞项
// ---------------------------------------------------------------------------

/**
 * 收集现场并算阻塞项。
 *
 * ⚠️ **作业列表是不完整的**：宿主的 `jobs.list(caller)` 按所有者隔离，只返回「调用者自己的 +
 * 无主的」作业，**别的会话的后台任务本插件看不见**（契约见 SPIKE S3）。所以这里算出来的
 * `jobs` 是「至少这么多」，不是全量——不要在任何文案里把它说成全量。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {string} callerId - 调用者会话 id（空串 = 不排除任何人，界面用）。
 * @returns {{ sessions: Array<{ sessionId: string, title: string, descendant: boolean }>, jobs: Array<{ id: string, label: string, kind: string }> }} 阻塞明细。
 * @throws {ControlError} 现场形状不对时抛 INVALID_REQUEST（宁可拒绝，也不假装没有阻塞）。
 */
function collectBlockers(ctx, callerId) {
  const agentsService = safeCall(() => ctx?.get?.('agents'))
  const sessionsService = safeCall(() => ctx?.get?.('sessions'))
  const agents = []
  if (isService(agentsService)) {
    const listed = safeCall(() => agentsService.list?.())
    // 服务在、列表读不出来 ⇒ **不假装没有人跑**，直接按「这个部署判不了」拒绝。
    if (!Array.isArray(listed)) throw blockersUnreadable('agents.list()')
    for (const agent of listed) {
      agents.push({
        id: agent?.id,
        status: agent?.status,
        // 父会话从会话头的 parentSession 读：computeBlockers 靠它判断「是不是调用者自己派出去的子代理」。
        parentSessionId: safeCall(() => sessionsService?.get?.(agent?.id)?.header?.parentSession),
      })
    }
  }
  const jobsService = safeCall(() => ctx?.get?.('jobs'))
  let jobs = []
  if (isService(jobsService)) {
    const listed = callerId === ''
      ? safeCall(() => jobsService.list?.())
      : safeCall(() => jobsService.list?.(callerId))
    if (!Array.isArray(listed)) throw blockersUnreadable('jobs.list()')
    jobs = listed
  }
  return computeBlockers({ agents, jobs, callerId })
}

/** 服务是否存在（cordis 的可选服务拿不到时是 `undefined`）。 */
function isService(service) {
  return service !== undefined && service !== null
}

/** 读不出「谁在跑」时的拒绝：这个部署判不了，就不重启。 */
function blockersUnreadable(name) {
  return new ControlError(
    ERROR_CODES.restartUnsupported,
    `读不到运行中的会话/后台任务列表（${name} 不可用），无法确认这次重启不会打断别人；为安全起见已拒绝`,
  )
}

// ---------------------------------------------------------------------------
// 后台时序（不在工具调用栈里）
// ---------------------------------------------------------------------------

/**
 * 后台时序的入口：**永不 reject**（`schedule` 的缺省实现是 `setTimeout`，没人接住它的 promise）。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} deps - deps。
 * @param {any} state - `requestRestart` 里的那次重启状态。
 * @returns {Promise<void>} 时序结束（成功时进程已请求退出）。
 */
async function runRestartSequence(ctx, deps, state) {
  if (runtime.inFlight !== state) return
  try {
    await restartSequence(ctx, deps, state)
  } catch (error) {
    // 兜底：连取消流程自己都抛了（几乎不该发生），也要留下日志、绝不让 promise 变成 unhandled rejection。
    ctx.logger?.error?.(`${PLUGIN_NAME}: 重启 ${state.restartId} 的时序发生未预期错误：${describeError(error)}`)
    await safeCancel(ctx, deps, state, `重启流程内部错误：${describeError(error)}`)
  }
}

/**
 * 工具结果落盘之后才跑的时序（计划 2.1 第 4 步）。
 *
 * **绝不在工具执行期间退出进程**：先等这一轮结束（`whenIdle`），再确认日志落盘（`flush === true`），
 * 再复查阻塞项，最后才派生辅助进程并退出。任何一步不满足都取消重启，并如实记进 `last.json`。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} deps - deps。
 * @param {any} state - `requestRestart` 里的那次重启状态。
 * @returns {Promise<void>} 时序结束（成功时进程已请求退出）。
 */
async function restartSequence(ctx, deps, state) {
  if (state.sessionId !== '') {
    const agent = findAgent(ctx, state.sessionId)
    if (agent === undefined) {
      return await cancelRestart(ctx, deps, state, `找不到发起重启的会话 ${state.sessionId}，无法确认这一轮已经结束`)
    }
    if (typeof agent.whenIdle !== 'function') {
      return await cancelRestart(ctx, deps, state, '宿主没有提供 agent.whenIdle，无法确认这一轮已经结束')
    }
    let idle
    try {
      idle = await settleWithin(agent.whenIdle(), IDLE_TIMEOUT_MS)
    } catch (error) {
      return await cancelRestart(ctx, deps, state, `等待这一轮结束时出错：${describeError(error)}`)
    }
    if (idle !== true) {
      return await cancelRestart(ctx, deps, state, `等待这一轮结束超过 ${Math.round(IDLE_TIMEOUT_MS / 1000)} 秒`)
    }

    const sessionsService = safeCall(() => ctx?.get?.('sessions'))
    const session = findSession(sessionsService, state.sessionId)
    if (session === undefined) {
      return await cancelRestart(ctx, deps, state, `会话 ${state.sessionId} 不在活动状态，无法确认日志已经落盘`)
    }
    if (typeof sessionsService?.flush !== 'function') {
      return await cancelRestart(ctx, deps, state, '宿主没有提供 sessions.flush，无法确认日志已经落盘')
    }
    let flushed
    try {
      flushed = await sessionsService.flush(session)
    } catch (error) {
      return await cancelRestart(ctx, deps, state, `会话日志落盘失败：${describeError(error)}`)
    }
    if (flushed !== true) {
      // 计划 2.1：`flush` 不为 true 就**绝不退出**——宁可这次不重启，也不能写坏日志尾部。
      return await cancelRestart(ctx, deps, state, '会话日志没有完成落盘（flush 没有返回 true），为避免日志尾部非法已放弃重启')
    }
  }

  // 复查阻塞项：等待期间可能又来了新会话或新任务。`force`（用户勾了「仍然重启」）不再复查。
  if (state.force !== true) {
    const blockers = collectBlockers(ctx, state.sessionId)
    const message = blockerMessage(blockers)
    if (message !== '') {
      return await cancelRestart(ctx, deps, state, message)
    }
  }

  const specPath = path.join(deps.dir, SPEC_FILE)
  const spec = buildLaunchSpec({
    execPath: deps.execPath,
    execArgv: process.execArgv,
    argv: deps.argvForReplay,
    cwd: deps.cwd,
    env: deps.env,
    oldPid: deps.pid,
    oldBootId: deps.bootId,
    // 空串 = 无法探测就绪：辅助进程会走降级路径（成功但标 degraded，不假装确认过）。
    statusUrl: deps.statusUrl === '' ? null : deps.statusUrl,
    logFile: deps.logFile === '' ? null : deps.logFile,
    restartId: state.restartId,
    now: deps.now(),
  })
  // 启动规格里有环境变量，权限 0o600 且**用完即删**（新进程负责删，见 cleanupSpec）。
  writeJsonAtomic(specPath, spec)

  const child = deps.spawn(deps.execPath, [deps.helperPath, specPath], {
    cwd: deps.cwd,
    detached: true,
    // 沙箱下原生进程的输出接管道会失败（AGENTS.local.md 第 2 节）：只用 'ignore'。
    stdio: 'ignore',
    windowsHide: true,
  })
  if (typeof child?.unref === 'function') child.unref()

  const withHelper = { ...state.entry, state: PENDING_STATES.helperStarted }
  writePending(deps.dir, withHelper)
  state.state = PENDING_STATES.helperStarted
  ctx.logger?.warn?.(`${PLUGIN_NAME}: 重启 ${state.restartId} 的辅助进程已启动（pid=${child?.pid ?? '未知'}），现在退出旧进程`)

  const appExit = appExitOf(ctx, deps)
  if (typeof appExit !== 'function') {
    // 预检已经查过，这里再查一次只是防御：真走到这里就取消，绝不「反正 helper 起来了就假装成功」。
    return await cancelRestart(ctx, deps, state, '宿主没有提供 appExit，辅助进程已启动但无法退出旧进程（请手动重启）')
  }
  appExit(0)
}

/** 取消流程本身的兜底：它自己抛了也只记录，不让调用方的 promise 炸掉。 */
async function safeCancel(ctx, deps, state, reason) {
  try {
    await cancelRestart(ctx, deps, state, reason)
  } catch (error) {
    ctx.logger?.error?.(`${PLUGIN_NAME}: 取消重启 ${state.restartId} 时又出错了：${describeError(error)}`)
  }
}

/**
 * 取消重启：清单飞锁与 `pending.json`、如实记一条失败结果、尽力通知发起会话。
 *
 * 与「内部故障」区分：这里的 `error` 文案永远是「重启已取消：<原因>」，原因本身来自上面每一步的
 * 具体判定，不是笼统的「失败」。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} deps - deps。
 * @param {any} state - 要取消的那次重启。
 * @param {string} reason - 中文原因（会原样写进 `last.json.error` 与通知消息）。
 * @returns {Promise<void>} 结束。
 */
async function cancelRestart(ctx, deps, state, reason) {
  if (runtime.inFlight === state) runtime.inFlight = null
  safeCall(() => clearPending(deps.dir))
  const now = deps.now()
  const patch = {
    restartId: state.restartId,
    ok: false,
    error: `重启已取消：${reason}`,
    stage: 'cancelled',
    source: state.source,
    reason: state.reason,
    finishedAt: now,
    durationMs: Math.max(0, now - state.startedAt),
    // 这次没有起辅助进程，上一次的日志文件与这次无关：清掉，别让界面指向一个不相干的文件。
    logFile: null,
    resume: 'none',
  }
  if (state.sessionId !== '') {
    const notice = await notifySession(
      ctx,
      state.sessionId,
      `[系统通知 · DSH 热重启已取消]\n原因：${reason}\n进程没有退出，也没有重启。请按上面的原因处理后再试。`,
      `notice-${state.restartId}`,
    )
    if (notice.ok === true) patch.cancelNotice = 'delivered'
    else {
      patch.cancelNotice = 'failed'
      patch.cancelNoticeError = notice.message
    }
  }
  const written = writeLastMerged(ctx, deps, patch)
  const line = `${PLUGIN_NAME}: 重启 ${state.restartId} 已取消：${reason}`
  if (written.ok === true) ctx.logger?.warn?.(line)
  else ctx.logger?.error?.(`${line}（写 last.json 也失败了：${written.message}）`)
}

/**
 * 合并写 `last.json`。
 *
 * ⚠️ **只在同一次重启（`restartId` 相同）时合并**：这份文件跨重启复用，无条件合并会把上一次的
 * `sessionId` / `resumeAt` / `newPid` / `logFile` 带进这一次，设置页就会显示不属于这次重启的信息。
 * 真机踩到过：一次界面重启的卡片上写着上一次模型重启的耗时与日志文件。
 * 正常流程里新进程写「身份」、辅助进程写「结果」，两者带同一个 `restartId`，所以仍然合并得上。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} deps - deps。
 * @param {Record<string, unknown>} patch - 要写进去的字段（**必须带 `restartId`**）。
 * @returns {{ ok: true } | { ok: false, message: string }} 写入结果。
 */
function writeLastMerged(ctx, deps, patch) {
  const previous = readLast(deps.dir) ?? {}
  const sameRestart = typeof patch?.restartId === 'string'
    && patch.restartId !== ''
    && previous.restartId === patch.restartId
  const next = sameRestart ? { ...previous, ...patch } : { ...patch }
  try {
    writeLast(deps.dir, next)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: describeError(error) }
  }
}

/** 按两种拼写找 agent（`session-<n>` 与裸 id 在磁盘/内存里并存）。 */
function findAgent(ctx, sessionId) {
  const agentsService = safeCall(() => ctx?.get?.('agents'))
  return findById(sessionId, (id) => safeCall(() => agentsService?.get?.(id)))
}

/** 按两种拼写找活会话。 */
function findSession(sessionsService, sessionId) {
  return findById(sessionId, (id) => safeCall(() => sessionsService?.get?.(id)))
}

/** 依次用两种拼写取值，返回第一个非 null/undefined 的结果。 */
function findById(sessionId, lookup) {
  for (const id of sessionDirNames(sessionId)) {
    const found = lookup(id)
    if (found !== undefined && found !== null) return found
  }
  return undefined
}

/** 给一个 promise 加超时：超时返回 `false`，正常返回 `true`。 */
async function settleWithin(promise, timeoutMs) {
  let timer
  const timeout = new Promise((resolve) => {
    // 同样刻意不 unref：等这一轮结束期间进程必须活着，否则时序会被「进程先退出」腰斩。
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve(promise).then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 新进程：续作投递与过期规格清理
// ---------------------------------------------------------------------------

/**
 * 安排「应用就绪之后投递续作消息」。
 *
 * 优先用宿主自己的启动成功信号 `ctx.get('appReady').onReady(...)`（启动没成功就不会回调）；
 * 拿不到就退回一个固定延时。同一进程只安排一次。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} deps - deps。
 * @returns {void}
 */
export function startResumeDelivery(ctx, deps) {
  if (runtime.resumeScheduled) return
  runtime.resumeScheduled = true
  const run = () => {
    void deliverResumes(ctx, deps)
  }
  const ready = safeCall(() => ctx?.get?.('appReady'))
  if (ready !== undefined && typeof ready.onReady === 'function') {
    try {
      // `onReady` 自己会处理「已经就绪」的情况（就绪后会立刻回调一次）。
      const register = () => ready.onReady(run)
      if (typeof ctx?.effect === 'function') ctx.effect(register, `${PLUGIN_NAME}: restart resume delivery`)
      else register()
      return
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN_NAME}: 注册应用就绪回调失败，改用定时投递：${describeError(error)}`)
    }
  }
  const timer = setTimeout(run, RESUME_FALLBACK_MS)
  if (typeof timer?.unref === 'function') timer.unref()
}

/**
 * 消费一次重启留下的待办：拉起会话并投递续作消息。
 *
 * 顺序上**先删待办再投递**：至多投递一次，宁可漏投也不重复投递（计划 2.1）。投递结果（含原始错误
 * 信息）合并写进 `last.json`，界面据此显示「未能自动续上」。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} deps - deps。
 * @returns {Promise<{ resume: 'delivered' | 'failed' | 'none' }>} 投递结果。
 */
export async function deliverResumes(ctx, deps) {
  const now = deps.now()
  const pending = readPending(deps.dir)
  // 启动规格里有环境变量：这次消费掉待办就说明规格已经用过了，顺手删掉（另加 1 小时的过期兜底）。
  cleanupSpec(ctx, deps, now, { consumed: pending !== undefined })

  if (pending === undefined) return { resume: 'none' }

  // 这份「这次重启是谁发起的、为什么」只有新进程知道（辅助进程只知道怎么重放启动）。
  // 先写下来，辅助进程随后**合并**写自己的成功记录时不会把它冲掉（同 restartId 才合并）。
  const identity = {
    restartId: textOf(pending.restartId) || null,
    source: textOf(pending.source) || null,
    reason: textOf(pending.reason) || null,
  }

  if (isStale(pending, now)) {
    ctx.logger?.warn?.(
      `${PLUGIN_NAME}: 丢弃过期的一次热重启待办（restartId=${textOf(pending.restartId) || '未知'}，创建于 ${String(pending.createdAt)}），不投递续作消息`,
    )
    safeCall(() => clearPending(deps.dir))
    writeLastMerged(ctx, deps, { ...identity, resume: 'none' })
    return { resume: 'none' }
  }

  safeCall(() => clearPending(deps.dir))

  const sessionId = textOf(pending.sessionId)
  if (sessionId === '') {
    // 界面发起的重启：没有要续作的会话（计划 2.2）。
    writeLastMerged(ctx, deps, { ...identity, resume: 'none' })
    return { resume: 'none' }
  }

  const previous = readLast(deps.dir) ?? {}
  const measured = Number.isFinite(previous.durationMs) ? previous.durationMs : undefined
  const fromPending = Number.isFinite(pending.createdAt) ? Math.max(0, now - pending.createdAt) : undefined
  const message = buildResumeMessage({
    reason: pending.reason,
    // 耗时优先用辅助进程实测写下的那个；**它多半还没写**（新进程就绪与辅助进程探测到就绪
    // 之间有最多 1 秒的轮询间隔），这时退回「待办创建 → 现在」，宁可是个偏大的估计，
    // 也不要每次都显示「未知」；两者都拿不到才写「未知」。
    durationMs: measured ?? fromPending,
    resumeNote: pending.resumeNote,
  })
  const restartId = textOf(pending.restartId)
  const result = await deliverToSession(ctx, sessionId, message, `resume-${restartId || newRestartId(now)}`)
  const patch = { ...identity, resume: result.ok === true ? 'delivered' : 'failed', resumeAt: now, sessionId }
  if (result.ok !== true) {
    patch.resumeError = result.message
    ctx.logger?.error?.(`${PLUGIN_NAME}: 重启后的续作消息没能投递到 ${sessionId}：${result.message}`)
  }
  writeLastMerged(ctx, deps, patch)
  return { resume: patch.resume }
}

/** 拉起会话并投递一条消息（`resolveAgent` → `prompt`）。失败返回原因，不抛。 */
async function deliverToSession(ctx, sessionId, text, requestId) {
  const controller = safeCall(() => ctx?.get?.('sessionController'))
  if (controller === undefined || typeof controller.resolveAgent !== 'function' || typeof controller.prompt !== 'function') {
    return { ok: false, message: '宿主没有提供 sessionController（resolveAgent / prompt），无法把续作消息投递给会话' }
  }
  let resolved
  try {
    resolved = await controller.resolveAgent(sessionId)
  } catch (error) {
    return { ok: false, message: `拉起会话 ${sessionId} 失败：${describeError(error)}` }
  }
  if (resolved === null || resolved === undefined) {
    return { ok: false, message: `拉起会话 ${sessionId} 时宿主没有返回结果` }
  }
  if (resolved.error !== undefined && resolved.error !== null) {
    return { ok: false, message: `无法拉起会话 ${sessionId}：${describeError(resolved.error)}` }
  }
  try {
    await controller.prompt(
      { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      new AbortController().signal,
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `投递续作消息失败：${describeError(error)}` }
  }
}

/** 往会话里投一条中文说明（取消重启时用）。失败返回原因，不抛。 */
async function notifySession(ctx, sessionId, text, requestId) {
  return await deliverToSession(ctx, sessionId, text, requestId)
}

/**
 * 删掉用完的（或过期的）启动规格文件。
 *
 * `spec.json` 里有完整的环境变量快照，计划 3.5 要求「用完即删」。新进程启动时：
 *   - 有待办（说明这份规格就是刚才那次重启的）⇒ 直接删；
 *   - 没有待办但文件超过 1 小时 ⇒ 当作残留删掉；
 *   - 否则留着（可能属于一次正在进行中的重启，删了辅助进程就读不到规格了）。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} deps - deps。
 * @param {number} now - 当下时间戳。
 * @param {{ consumed: boolean }} options - 待办是否已消费。
 * @returns {void}
 */
function cleanupSpec(ctx, deps, now, options) {
  if (deps.dir === '') return
  const file = path.join(deps.dir, SPEC_FILE)
  let stat
  try {
    stat = statSync(file)
  } catch {
    return // 本来就没有：正常情况
  }
  if (options?.consumed !== true && now - stat.mtimeMs <= SPEC_MAX_AGE_MS) return
  try {
    removeFile(file)
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN_NAME}: 删不掉过期的启动规格 ${file}：${describeError(error)}`)
  }
}

// ---------------------------------------------------------------------------
// 状态接口的数据
// ---------------------------------------------------------------------------

/**
 * `GET /restart/status` 的响应体（纯数据，可离线单测）。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} deps - deps。
 * @returns {any} 状态对象。
 */
export function buildRestartStatus(ctx, deps) {
  const preflight = preflightRestart(ctx, deps)
  let blockers
  let blockerFailure = ''
  try {
    // 界面看的是「现在重启会打断谁」，所以不排除任何会话（callerId 传空串）。
    blockers = collectBlockers(ctx, '')
  } catch (error) {
    blockerFailure = describeError(error)
  }
  const pending = readPending(deps.dir)
  const last = readLast(deps.dir)

  const version = pluginVersion()
  const body = {
    ok: true,
    ...(version === '' ? {} : { version }),
    bootId: deps.bootId,
    pid: deps.pid,
    startedAt: deps.startedAt,
    port: deps.port ?? null,
    // 生效的审批策略：模型工具默认要过审批（`ask`），配置成 `auto` 才免审批。
    // 把它放进状态里是**刻意的**：插件行的 `config:` 到底有没有被 Loader 传到 `apply`，
    // 靠读代码推断不算数，能在这里看见才算实测（见 docs/VERIFY-*.md）。
    approvalMode: deps.approvalMode,
    canRestart: preflight.ok === true && blockerFailure === '',
    blockers: {
      sessions: Array.isArray(blockers?.sessions)
        ? blockers.sessions.map((row) => ({
          sessionId: row.sessionId,
          ...(row.title === '' ? {} : { title: row.title }),
          // 刻意**不**带 `descendant`：状态页看的是「现在重启会打断谁」，它不排除任何会话
          // （callerId 传空串），所以「是不是谁派出去的子代理」在这里没有参照物，带了也恒为假。
          // 真正需要这个区分的是工具路径（那里 callerId 是调用者），它在 blockerMessage 里已经体现。
        }))
        : [],
      jobs: Array.isArray(blockers?.jobs) ? blockers.jobs.length : 0,
    },
    pending: pendingView(pending),
    last: lastView(last),
  }
  const unsupportedReason = preflight.ok === true
    ? (blockerFailure === '' ? '' : `读不到运行中的会话/后台任务：${blockerFailure}`)
    : preflight.reason
  if (unsupportedReason !== '') body.unsupportedReason = unsupportedReason
  return body
}

/** 待办的对外视图（只出计划 3.2 里写明的字段，别的一律不外泄）。 */
function pendingView(pending) {
  if (pending === undefined) return null
  return {
    restartId: textOf(pending.restartId) || null,
    state: textOf(pending.state) || null,
    source: textOf(pending.source) || null,
    reason: textOf(pending.reason) || null,
    createdAt: Number.isFinite(pending.createdAt) ? pending.createdAt : null,
  }
}

/**
 * 最近一次结果的对外视图。
 *
 * 计划 3.2 列的键之外多带了 `error` / `stage` / `newPid`：失败态界面要显示**具体原因**（验收第 11 条），
 * 少了它们就只剩「失败了」。它们都是本插件与辅助进程自己写的字段，不含环境变量。
 */
function lastView(last) {
  if (last === undefined) return null
  const view = {
    restartId: textOf(last.restartId) || null,
    ok: last.ok === true,
    finishedAt: Number.isFinite(last.finishedAt) ? last.finishedAt : null,
    durationMs: Number.isFinite(last.durationMs) ? last.durationMs : null,
    source: textOf(last.source) || null,
    reason: textOf(last.reason) || null,
    resume: ['delivered', 'failed', 'none'].includes(last.resume) ? last.resume : null,
  }
  if (last.degraded === true) view.degraded = true
  if (typeof last.logFile === 'string' && last.logFile !== '') view.logFile = last.logFile
  if (typeof last.error === 'string' && last.error !== '') view.error = last.error
  if (typeof last.stage === 'string' && last.stage !== '') view.stage = last.stage
  if (typeof last.newPid === 'number') view.newPid = last.newPid
  return view
}

// ---------------------------------------------------------------------------
// 工具定义与注册
// ---------------------------------------------------------------------------

/**
 * 模型发起的重启工具。
 *
 * 描述按 agent-experience：英文、短、**只讲什么时候用**；参数规则写在参数自己的 description 上，
 * 不在这里重复（工具定义会被塞进每一次请求的提示里）。
 */
const TOOL_DESCRIPTION =
  'Restart the DeepSeek Harness process so changes that only take effect on restart (for example host plugin code) go live. '
  + 'The restart runs after this turn ends, and this session continues automatically once the new process is up. '
  + 'Rejected while another session or a background job is running.'

const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: {
      type: 'string',
      description:
        'Why the restart is needed and what should change afterwards. Shown to the user verbatim (approval card, settings page) '
        + 'and quoted back to you in the follow-up message. 1-300 characters.',
    },
    resume_note: {
      type: 'string',
      description:
        'What you will do after the restart, so the workflow survives it. Copied verbatim into the message this session receives '
        + 'when it resumes. At most 500 characters.',
    },
  },
  required: ['reason'],
}

/**
 * 工具输出：成功是 `{ scheduled, restartId, expectedDowntimeSeconds }`，
 * 失败是**结构化错误值** `{ error: { code, message } }`。
 *
 * 失败刻意不抛异常：抛异常会被工具运行时包装成通用失败，丢掉我们精心写好的「下一步怎么办」。
 */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scheduled: { type: 'boolean' },
    restartId: { type: 'string' },
    expectedDowntimeSeconds: { type: 'number' },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
}

/**
 * 建工具定义（`ToolDefinition` 的形状见 SPIKE S3）。
 *
 * ⚠️ `parameters` 与 `output.schema` 必须是**原生 JSON Schema**（`required` 是数组、属性上有
 * `description`）：第一方工具用 `@deepseek-ai/dsh-tools` 的 `defineTool` 把作者侧 DSL 编译成这个
 * 形状，而 host 端**不能 import `@deepseek-ai/*`**（AGENTS.md 3.7），所以这里手写编译结果。
 */
function buildRestartToolDefinition(ctx, deps) {
  return {
    name: RESTART_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const error = value !== null && typeof value === 'object' ? value.error : undefined
        if (error !== undefined && error !== null) {
          return [{
            type: 'text',
            text: `重启未安排：${textOf(error.message) || '原因未知'}（${textOf(error.code) || 'UNKNOWN'}）`,
          }]
        }
        const seconds = Number.isFinite(value?.expectedDowntimeSeconds)
          ? value.expectedDowntimeSeconds
          : EXPECTED_DOWNTIME_SECONDS
        return [{
          type: 'text',
          text: `已安排重启（${textOf(value?.restartId) || 'id 未知'}）：本轮结束后执行，预计停机约 ${seconds} 秒，之后这个会话会自动继续。`,
        }]
      },
    },
    execute: async (args, exec) => {
      try {
        const agent = exec?.agent
        const callerId = textOf(agent?.id)
        if (callerId === '') {
          return errorValue(ERROR_CODES.restartForbidden, '拿不到调用者会话，无法确认这次重启由谁发起；请让主会话调用这个工具。')
        }
        const roots = safeCall(() => ctx?.get?.('agents')?.roots?.())
        if (!Array.isArray(roots)) {
          return errorValue(
            ERROR_CODES.restartUnsupported,
            '宿主没有提供 agents.roots()，无法确认调用者是主会话；为安全起见已拒绝，请让主会话发起这次重启。',
          )
        }
        if (!roots.some((root) => sameSession(root?.id, callerId))) {
          // 计划 3.1：只有根 agent 能重启宿主——子代理重启会把派它出来的那一轮一起打断。
          return errorValue(ERROR_CODES.restartForbidden, '子代理不能重启宿主；请让主会话发起这次重启（把需要重启的原因告诉它）。')
        }
        const reason = assertRestartReason(args?.reason)
        const resumeNote = assertResumeNote(args?.resume_note)
        const result = await requestRestart(ctx, deps, {
          source: 'model',
          reason,
          resumeNote,
          sessionId: callerId,
          agent,
          exec,
        })
        // 工具结果会在这之后落盘：让本轮在结果提交后结束，后台时序才等到 whenIdle（计划 2.1 第 3 步）。
        if (typeof exec?.concludeTurn === 'function') exec.concludeTurn()
        return {
          scheduled: true,
          restartId: result.restartId,
          expectedDowntimeSeconds: result.expectedDowntimeSeconds,
        }
      } catch (error) {
        const control = toControlError(error, '重启请求处理失败')
        if (control.code === ERROR_CODES.deleteFailed) {
          // 内部故障：原样记日志，绝不改写成「任务忙」之类的业务原因。
          ctx.logger?.error?.(`${PLUGIN_NAME}: ${RESTART_TOOL_NAME} 内部错误：${control.message}`)
        }
        return errorValue(control.code, control.message)
      }
    },
  }
}

/** 结构化错误值（工具的输出形状，见 TOOL_OUTPUT_SCHEMA）。 */
function errorValue(code, message) {
  return { error: { code, message } }
}

/** 两个会话 id 是不是同一个（两种拼写都认）。 */
function sameSession(left, right) {
  const a = textOf(left)
  const b = textOf(right)
  if (a === '' || b === '') return false
  if (a === b) return true
  return sessionDirNames(a).some((name) => sessionDirNames(b).includes(name))
}

/**
 * 注册 `restart_harness` 工具。
 *
 * 注册失败**绝不能连累整个插件**：工具只是两个入口之一，界面上的重启按钮走的是 HTTP 路由，
 * 那条路必须照常可用（AGENTS.md 3.7 的同一道理：一个顶层失败不该让整个插件消失）。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {any} deps - deps。
 * @returns {() => void} 注销函数（拿不到 tools 服务时是空函数）。
 */
export function registerRestartTool(ctx, deps) {
  const tools = safeCall(() => ctx?.get?.('tools'))
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger?.warn?.(`${PLUGIN_NAME}: 这个部署没有 tools 服务，${RESTART_TOOL_NAME} 工具未注册（界面上的重启入口仍然可用）`)
    return () => {}
  }
  const register = () => tools.register(buildRestartToolDefinition(ctx, deps))
  try {
    if (typeof ctx?.effect === 'function') return ctx.effect(register, `${PLUGIN_NAME}: tool ${RESTART_TOOL_NAME}`)
    return register()
  } catch (error) {
    ctx.logger?.error?.(`${PLUGIN_NAME}: 注册工具 ${RESTART_TOOL_NAME} 失败：${describeError(error)}`)
    return () => {}
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 把任意抛出物压成一行中文可读文本（带 errno / 错误码）。 */
function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  const code = typeof error?.code === 'string' && error.code !== '' ? `${error.code}: ` : ''
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : String(error)
  return `${code}${message}`
}

/** 取一个非空字符串，拿不到就是空串（不编造，见 AGENTS.md 坑 ⑨）。 */
function textOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

/** 调一个可能不存在的服务方法，失败一律当作「拿不到」。 */
function safeCall(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}
