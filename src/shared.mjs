/**
 * 本插件的共享常量与纯工具。
 *
 * host 与 client 各有一份自己的常量副本（浏览器 bundle 与 host 模块不共享模块图），
 * 两边的值必须一致——改动这里时同步 client.js 顶部的同名常量。
 */

/** 插件名：bundle patch 行 id、loader 注册 id、日志前缀都用它。 */
export const PLUGIN_NAME = 'dsh-agent-control'

/** HTTP 路由前缀。自建路由不经 harness 鉴权链路（见 AGENTS.md 3.5）。 */
export const API_PREFIX = '/api/agent-control'

export const PATHS = {
  sessions: `${API_PREFIX}/sessions`,
  sessionDelete: `${API_PREFIX}/session/delete`,
  turns: `${API_PREFIX}/turns`,
  turnDelete: `${API_PREFIX}/turn/delete`,
  // 热重启（见 docs/PLAN-hot-restart.md 3.2）。status 是新进程的「就绪探针」，
  // 辅助进程靠它判断新进程是否已经起来了。
  restartStatus: `${API_PREFIX}/restart/status`,
  restart: `${API_PREFIX}/restart`,
}

/**
 * 删除类操作的失败原因。host 与 client 共用，client 按码给文案。
 *
 * `DELETE_FAILED` 与 `AGENT_BUSY` 分开是刻意的：把内部失败说成「任务正在运行」
 * 会让每一次兼容性故障都指向错误的方向（见 AGENTS.md 第 4 节坑 ①）。
 */
export const ERROR_CODES = {
  invalidRequest: 'INVALID_REQUEST',
  targetNotFound: 'TARGET_NOT_FOUND',
  turnNotClosed: 'TURN_NOT_CLOSED',
  turnCompacted: 'TURN_COMPACTED',
  sessionLive: 'SESSION_LIVE',
  agentBusy: 'AGENT_BUSY',
  deleteFailed: 'DELETE_FAILED',
  // 热重启。与删除类共用一个错误码空间：客户端只需要一处映射表。
  restartBlocked: 'RESTART_BLOCKED',
  restartInProgress: 'RESTART_IN_PROGRESS',
  restartRateLimited: 'RESTART_RATE_LIMITED',
  restartUnsupported: 'RESTART_UNSUPPORTED',
  restartDenied: 'RESTART_DENIED',
}

/** 带错误码的失败。路由层按码决定 HTTP 状态。 */
export class ControlError extends Error {
  /**
   * @param {string} code - ERROR_CODES 里的值。
   * @param {string} message - 面向开发者与用户的原因说明（中文）。
   * @param {{ status?: number, detail?: Record<string, unknown> }} [options] - HTTP 状态与附加字段。
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ControlError'
    this.code = code
    this.status = options.status ?? statusForCode(code)
    if (options.detail !== undefined) this.detail = options.detail
  }
}

/**
 * 错误码到 HTTP 状态的映射。
 *
 * 409 表示「目标状态不允许这次操作」，423 表示「宿主正忙」，两者对调用方的含义不同，
 * 不要合并。未知错误一律 500。
 *
 * @param {string} code - ERROR_CODES 里的值。
 * @returns {number} HTTP 状态码。
 */
export function statusForCode(code) {
  switch (code) {
    case ERROR_CODES.invalidRequest: return 400
    case ERROR_CODES.targetNotFound: return 404
    case ERROR_CODES.turnNotClosed:
    case ERROR_CODES.turnCompacted:
    case ERROR_CODES.sessionLive: return 409
    case ERROR_CODES.agentBusy: return 423
    // 重启：403 是「不允许你重启」（审批被拒 / Origin 校验失败），
    // 409 是「现在不行」（有阻塞项 / 已经有一个在跑），429 是「太频繁」，
    // 501 是「这个部署根本做不到」——四者的处置方式完全不同，绝不能合并。
    case ERROR_CODES.restartDenied: return 403
    case ERROR_CODES.restartBlocked:
    case ERROR_CODES.restartInProgress: return 409
    case ERROR_CODES.restartRateLimited: return 429
    case ERROR_CODES.restartUnsupported: return 501
    default: return 500
  }
}

/**
 * 在事件流里定位一条已闭合轮次的区间。
 *
 * 轮次由 `turn/start` 与 `turn/end` 括起来，且必须以 `turn/end` 收尾才算「已闭合」——
 * 没闭合的轮次还在写入，删它等于删一个正在变的东西。
 *
 * @param {ReadonlyArray<{ type: string, seq: number, data?: { turn?: number } }>} events - 会话事件流，按 seq 升序。
 * @param {number} turn - 轮次号。
 * @returns {{ start: number, end: number } | undefined} 括起的 seq 区间；未闭合或缺失时 undefined。
 */
export function turnBracket(events, turn) {
  let start
  let end
  for (const event of events) {
    if (event.data?.turn !== turn) continue
    if (event.type === 'turn/start') start = event.seq
    else if (event.type === 'turn/end' && start !== undefined) {
      end = event.seq
      break
    }
  }
  return start === undefined || end === undefined ? undefined : { start, end }
}

/**
 * 会话 id 在磁盘上的两种拼写。
 *
 * DSH 的 store 自己铸造的 id 形如 `session-<n>`，而外部传入的常是裸 UUID；
 * `$DSH_HOME/sessions/<slug>/` 下两种目录名并存，只认一种就删不干净。
 *
 * @param {string} sessionId - 会话 id。
 * @returns {string[]} 该 id 的全部候选拼写（去重，原样在前）。
 */
export function sessionDirNames(sessionId) {
  const id = String(sessionId ?? '').trim()
  if (id === '') return []
  const names = [id]
  if (id.startsWith('session-')) names.push(id.slice('session-'.length))
  else names.push(`session-${id}`)
  return [...new Set(names)]
}

/**
 * 会话 id 的形状校验。
 *
 * 刻意收得宽：store 会铸造 `session-<n>` 形式，硬要求 UUID 会把这类会话挡在门外
 * （只认 UUID 的实现就是这么漏掉它们的）。这里只挡明显不是 id 的输入（路径分隔符、空白、超长）。
 *
 * @param {unknown} value - 待校验的值。
 * @returns {string} 规范化后的 id（已 trim）。
 * @throws {ControlError} 形状非法时抛 INVALID_REQUEST。
 */
export function assertSessionId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (id === '') {
    throw new ControlError(ERROR_CODES.invalidRequest, '缺少 sessionId')
  }
  if (id.length > 200) {
    throw new ControlError(ERROR_CODES.invalidRequest, 'sessionId 过长')
  }
  // 只允许 id 该有的字符：路径分隔符、空白、`..` 一律拒绝，避免拼出目录穿越。
  if (!/^[A-Za-z0-9._:-]+$/.test(id) || id.includes('..')) {
    throw new ControlError(ERROR_CODES.invalidRequest, `sessionId 形状非法：${id}`)
  }
  return id
}

/**
 * 消息 id 的形状校验。
 *
 * @param {unknown} value - 待校验的值。
 * @returns {string} 规范化后的消息 id。
 * @throws {ControlError} 形状非法时抛 INVALID_REQUEST。
 */
export function assertMessageId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (id === '') {
    throw new ControlError(ERROR_CODES.invalidRequest, '缺少 assistantMessageId')
  }
  if (id.length > 200) {
    throw new ControlError(ERROR_CODES.invalidRequest, 'assistantMessageId 过长')
  }
  if (!/^[A-Za-z0-9._:@-]+$/.test(id)) {
    throw new ControlError(ERROR_CODES.invalidRequest, `assistantMessageId 形状非法：${id}`)
  }
  return id
}

/**
 * 把任意抛出物收敛成 ControlError。
 *
 * 没有错误码的异常一律归 `DELETE_FAILED` 并保留原始信息——绝不吞掉原因，
 * 也绝不改写成「任务正在运行」。
 *
 * @param {unknown} error - 捕获到的异常。
 * @param {string} fallbackMessage - 原始信息为空时的兜底说明。
 * @returns {ControlError} 带码的失败。
 */
export function toControlError(error, fallbackMessage) {
  if (error instanceof ControlError) return error
  const message = error instanceof Error && error.message
    ? error.message
    : (typeof error === 'string' && error ? error : fallbackMessage)
  return new ControlError(ERROR_CODES.deleteFailed, message)
}
