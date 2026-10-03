/**
 * 轮次删除：从**模型可见面**上遮掉一轮已结束的对话。
 *
 * 不重写日志、不截断文件。DSH 的会话日志是 append-only 的事件流；删除一轮的做法是追加一笔
 * **与内核手动压缩同形的事务**，用 surface 的区间替换让那一轮不再进入模型上下文：
 *
 *   compaction/start   { compactionId, turn: null }                    ← 独立事务（轮次之间）
 *   compaction/summary { compactionId, summary, shadowedRange, shadowedSeqs, shadowedTokenCount,
 *                        provider: 'dsh-agent-control', model: 'turn-delete' }
 *   user/message       替换该轮区间；source = { kind: 'compact-checkpoint', compactionId }；
 *                      内容是一句「这里有一轮对话被用户删除了」的提示
 *   compaction/end     { compactionId, turn: null }
 *
 * 这正是 `dsh-compaction-basic` 的手动压缩（`compactNow` / owner = null）写下的四件套，只是摘要
 * 不由模型生成，而是固定的删除提示。被删内容仍然完整留在日志与附件存储里——**这不是安全删除**。
 *
 * ## 为什么不再用「空的 system/message 替换」（坑 ⑪）
 *
 * 格式 v4 的**加载**校验要求 system/message 落在打开的轮次与步骤里，而被删的轮次已经结束。
 * 运行中的内核 append 不查这条，于是旧墓碑当下一切正常、重启后整个会话打不开。压缩事务是
 * 格式本身为「在轮次之间改写可见面」准备的唯一通道：独立压缩（`turn: null`）只要求当时没有
 * 打开的轮次、没有进行中的压缩。已用真实的 v4 加载校验器（`restoreReleasedV4Artifact` +
 * `assertReleasedV4Relationships`）对真实会话日志验证过：旧墓碑必然失败，压缩事务通过。
 *
 * 本文件不 import cordis，也不 import 任何 @deepseek-ai/* 包。
 */
import { randomUUID } from 'node:crypto'

import { ERROR_CODES, ControlError, turnBracket } from './shared.mjs'

/** 删除事务在 compaction/summary 上的自有标记，供识别与诊断。 */
export const DELETION_PROVIDER = 'dsh-agent-control'
export const DELETION_MODEL = 'turn-delete'

/** 替换进可见面的那句提示：模型看到的就是它（代替被删的整轮）。 */
export const DELETION_NOTICE = '[此处原有一轮对话，已被用户删除；其内容不再提供。]'

/** 旧版本（v1.0.0）墓碑的 source.kind。只用于**识别**老日志，不再写入。 */
const LEGACY_TOMBSTONE_KIND = 'system-prompt'

/**
 * 一条事件是不是 v1.0.0 写下的旧墓碑（空的 system/message 替换）。
 *
 * 不再写入这种墓碑（坑 ⑪），但老日志里可能还有，识别它才能让 `/turns` 与「已删过」判断照旧成立。
 *
 * @param {any} event - 会话事件。
 * @returns {boolean} 是否为旧墓碑。
 */
export function isTurnDeleteEvent(event) {
  if (event?.type !== 'system/message') return false
  const op = event.surfaceOp
  if (op === null || typeof op !== 'object' || op.op !== 'replace') return false
  const content = event.data?.message?.content
  if (!Array.isArray(content) || content.length !== 0) return false
  return event.data?.message?.source?.kind === LEGACY_TOMBSTONE_KIND
}

/**
 * 一条事件是不是本插件写的删除事务的摘要（`compaction/summary` + 自有标记）。
 *
 * @param {any} event - 会话事件。
 * @returns {boolean} 是否为删除摘要。
 */
export function isTurnDeletionSummary(event) {
  return event?.type === 'compaction/summary'
    && event.data?.provider === DELETION_PROVIDER
    && event.data?.model === DELETION_MODEL
}

/**
 * 会话里已被删除的轮次（新旧两种形状都认），按出现顺序去重。
 *
 * 删除摘要本身不带轮次号（不往内核的事件里塞未登记的字段），轮次号从它遮蔽的节点反推：
 * 节点（或其来源）里第一个带 `data.turn` 的 assistant/tool 事件。
 *
 * @param {ReadonlyArray<any>} events - 事件流（下标即 seq）。
 * @returns {number[]} 轮次号。
 */
export function deletedTurns(events) {
  const turns = []
  const memo = new Map()
  for (const event of events) {
    let turn
    if (isTurnDeleteEvent(event)) turn = event.data?.turn
    else if (isTurnDeletionSummary(event)) turn = shadowedTurn(event, events, memo)
    if (typeof turn === 'number' && !turns.includes(turn)) turns.push(turn)
  }
  return turns
}

/** 删除摘要遮蔽的是哪一轮。 */
function shadowedTurn(summary, events, memo) {
  for (const seq of summary.data?.shadowedSeqs ?? []) {
    for (const origin of [seq, ...nodeOrigins(seq, events, memo)]) {
      const turn = eventTurn(events[origin])
      if (typeof turn === 'number') return turn
    }
  }
  return undefined
}

/** 找到遮蔽某一轮的删除记录（新旧两种形状）。 */
function findDeletion(events, turn) {
  const memo = new Map()
  return events.find((event) =>
    (isTurnDeleteEvent(event) && event.data?.turn === turn)
    || (isTurnDeletionSummary(event) && shadowedTurn(event, events, memo) === turn))
}

/**
 * 某个 surface 节点的来源闭包：该节点直接来自哪些 append-surface 事件。
 *
 * 压缩、工具结果剪枝之类的替换节点会 `sourceEventSeqs` 指向被它遮蔽的原始事件，
 * 所以要沿引用链传递求闭包，并处理环（理论上不该有，但坏了不能死循环）。
 *
 * @param {number} seq - 节点 seq。
 * @param {ReadonlyArray<any>} events - 事件流（下标即 seq）。
 * @param {Map<number, Set<number>>} memo - 记忆化。
 * @param {Set<number>} [visiting] - 环检测。
 * @returns {Set<number>} 原始 append-surface 事件的 seq 集合。
 */
export function nodeOrigins(seq, events, memo, visiting = new Set()) {
  const cached = memo.get(seq)
  if (cached !== undefined) return cached
  const origins = new Set()
  if (visiting.has(seq)) return origins
  visiting.add(seq)
  const event = events[seq]
  if (event !== undefined) {
    if (isAppendSurfaceEvent(event)) origins.add(seq)
    const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
    for (const source of sources) {
      for (const origin of nodeOrigins(source, events, memo, visiting)) origins.add(origin)
    }
  }
  visiting.delete(seq)
  memo.set(seq, origins)
  return origins
}

/**
 * 算出「遮掉这一轮」需要的 surface 区间。
 *
 * 返回的区间必须是**连续**的：内核的替换语义是「把 surface 上从 startSeq 到 endSeq
 * 的节点整段换掉」，区间里混进别的轮次的节点就会连带删掉别人的内容。因此这里逐节点
 * 检查其来源闭包是否完全落在本轮的原始事件集合内，任何外来来源都判 TURN_COMPACTED
 * （宁可拒绝，绝不删一半或删错范围）。
 *
 * @param {object} params - 输入。
 * @param {ReadonlyArray<any>} params.events - 事件流，按 seq 升序且连续。
 * @param {ReadonlyArray<number>} params.nodes - 当前 surface 节点 seq，按可见顺序。
 * @param {number} params.turn - 目标轮次。
 * @param {{ start: number, end: number }} params.bracket - 轮次括号。
 * @param {number} params.targetSeq - 目标 assistant 消息的 seq。
 * @returns {{ startSeq: number, endSeq: number, sourceSeqs: number[] }} 可直接用于 append 的区间与引用。
 * @throws {ControlError} 目标不可单独删除时抛 TURN_COMPACTED / TURN_NOT_CLOSED。
 */
export function planTurnRemoval({ events, nodes, turn, bracket, targetSeq }) {
  if (!nodes.includes(targetSeq)) {
    throw new ControlError(
      ERROR_CODES.turnCompacted,
      `第 ${turn} 轮已经不在可见面上，无法单独删除`,
    )
  }

  // 本轮的原始 surface 事件：落在括号内，或事件自身标着这一轮。
  // 系统提示节点（system/message）排除在外——它是会话的基础设施，不属于任何一轮。
  const originSeqs = new Set()
  for (const event of events) {
    if (event.type === 'system/message') continue
    if (!isAppendSurfaceEvent(event)) continue
    const insideBracket = event.seq > bracket.start && event.seq < bracket.end
    if (!insideBracket && eventTurn(event) !== turn) continue
    originSeqs.add(event.seq)
  }
  if (originSeqs.size === 0) {
    throw new ControlError(
      ERROR_CODES.turnCompacted,
      `第 ${turn} 轮在可见面上没有留下可删除的内容`,
    )
  }

  const memo = new Map()
  const selected = []
  const covered = new Set()
  for (const seq of nodes) {
    const origins = nodeOrigins(seq, events, memo)
    const own = [...origins].filter((origin) => originSeqs.has(origin))
    if (own.length === 0) continue
    const foreign = [...origins].filter((origin) => !originSeqs.has(origin))
    if (foreign.length > 0) {
      throw new ControlError(
        ERROR_CODES.turnCompacted,
        `第 ${turn} 轮与其它内容共用了同一个可见节点（${seq}），无法单独删除`,
      )
    }
    const event = events[seq]
    const localReplacement = event !== undefined && !originSeqs.has(seq)
      && !(event.type === 'tool/result' && eventTurn(event) === turn)
    if (localReplacement) {
      throw new ControlError(
        ERROR_CODES.turnCompacted,
        `第 ${turn} 轮包含一个非本轮产生的可见节点（${seq}），无法单独删除`,
      )
    }
    selected.push(seq)
    for (const origin of own) covered.add(origin)
  }
  if (selected.length === 0) {
    throw new ControlError(
      ERROR_CODES.turnCompacted,
      `第 ${turn} 轮在可见面上没有匹配的节点`,
    )
  }
  const uncovered = [...originSeqs].filter((origin) => !covered.has(origin))
  if (uncovered.length > 0) {
    throw new ControlError(
      ERROR_CODES.turnCompacted,
      `第 ${turn} 轮只被部分压缩（缺 ${uncovered.join('、')}），无法单独删除`,
    )
  }

  const positions = selected.map((seq) => nodes.indexOf(seq))
  const first = positions[0]
  const contiguous = positions.every((position, index) => position === first + index)
  if (!contiguous) {
    throw new ControlError(
      ERROR_CODES.turnCompacted,
      `第 ${turn} 轮在可见面上不连续，无法整段替换`,
    )
  }

  const startSeq = selected[0]
  const endSeq = selected[selected.length - 1]
  // 内核要求替换区间整段都是当前 surface 的节点，且引用覆盖区间内每一个节点。
  const shadowed = nodes.slice(first, first + selected.length)
  return { startSeq, endSeq, sourceSeqs: [...shadowed] }
}

/**
 * 从会话事件流里找出目标 assistant 消息所在轮次，并算出墓碑区间。
 *
 * @param {object} params - 输入。
 * @param {ReadonlyArray<any>} params.events - 事件流。
 * @param {ReadonlyArray<number>} params.nodes - 当前 surface 节点。
 * @param {string} params.assistantMessageId - 目标 assistant 消息 id。
 * @returns {{ turn: number, step: number, targetSeq: number, match: any }} 定位结果。
 * @throws {ControlError} 找不到消息时抛 TARGET_NOT_FOUND。
 */
export function locateTurn({ events, nodes, assistantMessageId }) {
  const target = events.find((event) =>
    event.type === 'assistant/message'
    && isAppendSurfaceEvent(event)
    && event.data?.message?.id === assistantMessageId)
  if (target === undefined) {
    throw new ControlError(
      ERROR_CODES.targetNotFound,
      `在会话里找不到消息 ${assistantMessageId}`,
    )
  }
  const turn = target.data?.turn
  const bracket = turnBracket(events, turn)
  if (bracket === undefined) {
    throw new ControlError(ERROR_CODES.turnNotClosed, `第 ${turn} 轮还没有结束，删除会破坏正在写入的内容`)
  }
  const plan = planTurnRemoval({ events, nodes, turn, bracket, targetSeq: target.seq })
  return { turn, step: target.data?.step, targetSeq: target.seq, plan, match: target }
}

/**
 * 事件流末尾当前打开的轮次与步骤。
 *
 * 复刻会话格式 v4 加载校验器（`dsh-session-format-v3-to-v4` 的 `Relationships`）里
 * `turn/start` / `turn/end` / `step/start` / `step/end` 的配对规则。
 *
 * @param {ReadonlyArray<{ type: string, data?: { turn?: number, step?: number } }>} events - 事件流。
 * @returns {{ turn: number, step: number | null } | null} 打开的轮次（与步骤）；没有打开的轮次时 null。
 */
export function openTurnAndStep(events) {
  let turn = null
  let step = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data?.turn ?? null
      step = null
    } else if (event.type === 'turn/end') {
      turn = null
      step = null
    } else if (event.type === 'step/start') {
      step = event.data?.step ?? null
    } else if (event.type === 'step/end') {
      step = null
    }
  }
  return turn === null ? null : { turn, step }
}

/**
 * 进行中的压缩事务（最后一个没有配对 `compaction/end` 的 `compaction/start`）。
 *
 * 内核把 `compaction/start` 当作会话级的压缩锁：锁着的时候不能再开一笔压缩事务。
 * `session/end-seed` 之后的旧锁属于更早的生命周期，不算。
 *
 * @param {ReadonlyArray<any>} events - 事件流。
 * @returns {any} 打开的 `compaction/start` 事件；没有时 undefined。
 */
export function openCompaction(events) {
  let open
  for (const event of events) {
    if (event.type === 'compaction/start') open = event
    else if (event.type === 'compaction/end' || event.type === 'session/end-seed') open = undefined
  }
  return open
}

/**
 * 粗略估算一组节点的 token 数（拿不到内核的 token 计量时的退路）。
 *
 * 只用于 `compaction/summary.shadowedTokenCount` 这个「影子价格」：它让 token 计量在替换后
 * 扣掉被遮蔽的部分。估偏了只影响上下文用量的估计，不影响删除本身。
 *
 * @param {ReadonlyArray<any>} events - 事件流。
 * @param {ReadonlyArray<number>} seqs - 被遮蔽的节点。
 * @returns {number} 非负整数。
 */
export function roughTokenEstimate(events, seqs) {
  let chars = 0
  for (const seq of seqs) chars += JSON.stringify(events[seq]?.data ?? '').length
  return Math.max(0, Math.ceil(chars / 4))
}

/**
 * 按「独立手动压缩」的形状追加删除事务（四个事件，同步完成，中间不让出）。
 *
 * 失败语义照抄内核的手动压缩：`compaction/start` 一旦写入就是锁，之后任何一步失败都要补一个
 * 带 `error` 的 `compaction/end` 把锁放掉；补不上就如实报告（锁会留在日志里，内核据此判忙）。
 *
 * @param {object} params - 输入。
 * @param {(type: string, data: any, intent?: any) => any} params.append - 会话的 append。
 * @param {{ startSeq: number, endSeq: number, sourceSeqs: number[] }} params.plan - 替换区间。
 * @param {number} params.shadowedTokenCount - 被遮蔽内容的 token 估计。
 * @param {string} [params.compactionId] - 事务 id（测试注入；默认随机 UUID）。
 * @returns {{ compactionId: string, startSeq: number, summarySeq: number, replacementSeq: number, endSeq: number }} 各事件的 seq。
 * @throws {ControlError} 任一步被内核拒绝时抛 DELETE_FAILED（保留原因与是否已放锁）。
 */
export function appendTurnDeletion({ append, plan, shadowedTokenCount, compactionId = randomUUID() }) {
  const lifecycle = { compactionId, turn: null }
  let start
  try {
    start = append('compaction/start', lifecycle)
  } catch (error) {
    throw new ControlError(ERROR_CODES.deleteFailed, `写入删除事务被内核拒绝（compaction/start）：${messageOf(error)}`)
  }
  let stage = 'compaction/summary'
  try {
    const summary = append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: DELETION_NOTICE }],
      shadowedRange: { start: plan.startSeq, end: plan.endSeq },
      shadowedSeqs: [...plan.sourceSeqs],
      shadowedTokenCount: Number.isSafeInteger(shadowedTokenCount) && shadowedTokenCount >= 0 ? shadowedTokenCount : 0,
      provider: DELETION_PROVIDER,
      model: DELETION_MODEL,
    })
    stage = 'user/message'
    const replacement = append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: DELETION_NOTICE }],
      source: { kind: 'compact-checkpoint', compactionId },
    }, {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: [start.seq, summary.seq, ...plan.sourceSeqs],
    })
    stage = 'compaction/end'
    const end = append('compaction/end', lifecycle)
    return { compactionId, startSeq: start.seq, summarySeq: summary.seq, replacementSeq: replacement.seq, endSeq: end.seq }
  } catch (error) {
    let released = false
    if (stage !== 'compaction/end') {
      try {
        append('compaction/end', { ...lifecycle, error: `turn deletion failed at ${stage}: ${messageOf(error)}` })
        released = true
      } catch {
        released = false
      }
    }
    throw new ControlError(
      ERROR_CODES.deleteFailed,
      `写入删除事务被内核拒绝（${stage}）：${messageOf(error)}${released ? '；压缩锁已释放，可见面未改动' : '；压缩锁没能释放，内核会把这个会话判为「正在压缩」'}`,
      { detail: { stage, lockReleased: released } },
    )
  }
}

/**
 * 删除一轮：定位 → 算区间 → （在 agent 的维护租约里）追加删除事务 → flush。
 *
 * - 有 agent 时走 `agent.runMaintenance(task)`：与内核手动压缩一样，只在 agent 空闲时运行，
 *   并把之后到来的输入压到事务完成之后。它在 agent 忙时**同步抛错**，所以整个调用包在 try 里。
 * - 事务前再查一次：没有打开的轮次、没有进行中的压缩——独立压缩事务的前提。
 * - flush 成功才算成功；「已经删过」的重复请求也要再 flush 一次。
 *
 * @param {object} params - 输入。
 * @param {any} params.session - 会话对象（`snapshotEvents` / `surface` / `append`）。
 * @param {string} params.assistantMessageId - 目标 assistant 消息 id。
 * @param {(session: any) => Promise<unknown>} [params.flush] - 落盘等待（`ctx.sessions.flush`）。
 * @param {any} [params.agent] - 会话的 agent（`runMaintenance`）。
 * @param {(session: any, seqs: number[]) => number | undefined} [params.estimateTokens] - 被遮蔽内容的 token 估计。
 * @returns {Promise<{ turn: number, seq: number, alreadyDeleted: boolean, compactionId?: string }>} 结果；`seq` 是替换节点的 seq。
 */
export async function deleteTurn({ session, assistantMessageId, flush, agent, estimateTokens }) {
  const events = readEvents(session)
  const target = findAssistant(events, assistantMessageId)
  const turn = target.data?.turn
  const existing = findDeletion(events, turn)
  if (existing !== undefined) {
    await persistDeletion(flush, session, turn, existing.seq)
    return { turn, seq: existing.seq, alreadyDeleted: true }
  }
  // 先在租约外完整校验一遍：拒绝要尽早、且不占用 agent。
  prepare(session, assistantMessageId)

  const run = () => {
    // 租约内重读：校验与写入之间不能隔着别人的写入。
    const { plan } = prepare(session, assistantMessageId)
    if (typeof session.append !== 'function') {
      throw new ControlError(ERROR_CODES.deleteFailed, '会话不支持 append，无法写入删除事务')
    }
    const estimated = typeof estimateTokens === 'function' ? safeEstimate(() => estimateTokens(session, plan.sourceSeqs)) : undefined
    return appendTurnDeletion({
      append: session.append.bind(session),
      plan,
      shadowedTokenCount: estimated ?? roughTokenEstimate(readEvents(session), plan.sourceSeqs),
    })
  }

  let appended
  if (typeof agent?.runMaintenance === 'function') {
    let pending
    try {
      pending = agent.runMaintenance(async () => run())
    } catch (error) {
      throw new ControlError(ERROR_CODES.agentBusy, `会话的 agent 正在工作，拿不到维护租约：${messageOf(error)}`)
    }
    appended = await pending
  } else {
    appended = run()
  }
  await persistDeletion(flush, session, turn, appended.replacementSeq)
  return { turn, seq: appended.replacementSeq, alreadyDeleted: false, compactionId: appended.compactionId }
}

/** 校验并规划一次删除（不写任何东西）。 */
function prepare(session, assistantMessageId) {
  return prepareTurnDeletion({ events: readEvents(session), nodes: readNodes(session), assistantMessageId })
}

/**
 * 删除前的全部校验与区间规划（纯函数，不写任何东西）。
 *
 * 目标轮次必须已闭合；当时不能有打开的轮次（独立压缩只能落在轮次之间）、不能有进行中的压缩；
 * 该轮在可见面上必须是一段只属于它自己的连续区间。`deleteTurn` 与 `test/v4-load-check.mjs`
 * 共用这一份，保证「离线模拟」与「真删」走的是同一套规则。
 *
 * @param {object} params - 输入。
 * @param {ReadonlyArray<any>} params.events - 事件流。
 * @param {ReadonlyArray<number>} params.nodes - 当前可见面节点。
 * @param {string} params.assistantMessageId - 目标 assistant 消息 id。
 * @returns {{ turn: number, plan: { startSeq: number, endSeq: number, sourceSeqs: number[] } }} 规划结果。
 * @throws {ControlError} TARGET_NOT_FOUND / TURN_NOT_CLOSED / AGENT_BUSY / TURN_COMPACTED。
 */
export function prepareTurnDeletion({ events, nodes, assistantMessageId }) {
  const target = findAssistant(events, assistantMessageId)
  const turn = target.data?.turn
  const bracket = turnBracket(events, turn)
  if (bracket === undefined) {
    throw new ControlError(ERROR_CODES.turnNotClosed, `第 ${turn} 轮还没有结束，删除会破坏正在写入的内容`)
  }
  const open = openTurnAndStep(events)
  if (open !== null) {
    throw new ControlError(ERROR_CODES.agentBusy, `第 ${open.turn} 轮正在进行，等它结束后再删`)
  }
  const compacting = openCompaction(events)
  if (compacting !== undefined) {
    throw new ControlError(ERROR_CODES.agentBusy, `会话正在压缩上下文（seq ${compacting.seq} 开始），等它结束后再删`)
  }
  const plan = planTurnRemoval({ events, nodes, turn, bracket, targetSeq: target.seq })
  return { turn, plan }
}

/** 按 id 找 assistant 消息；找不到抛 TARGET_NOT_FOUND。 */
function findAssistant(events, assistantMessageId) {
  // 日志是 append-only 的：即使这一轮已经被遮掉，它的 assistant 消息事件仍在。
  const target = events.find((event) =>
    event.type === 'assistant/message'
    && isAppendSurfaceEvent(event)
    && event.data?.message?.id === assistantMessageId)
  if (target === undefined) {
    throw new ControlError(ERROR_CODES.targetNotFound, `在会话里找不到消息 ${assistantMessageId}`)
  }
  return target
}

/**
 * 等删除事务落盘，并且**看结果**。
 *
 * `SessionStore.flush(session)` 返回「是否至少有一个持久化监听器参与」，`false` 就是没落盘：
 * 事务只在内存日志里，重启后这一轮会复活——不能算成功。重复请求会走「已删过」分支再 flush 一次。
 */
async function persistDeletion(flush, session, turn, seq) {
  if (typeof flush !== 'function') return
  let participated
  try {
    participated = await flush(session)
  } catch (error) {
    throw new ControlError(
      ERROR_CODES.deleteFailed,
      `第 ${turn} 轮的删除（seq ${seq}）已写入内存日志，但落盘失败：${messageOf(error)}。重启后这一轮可能重新出现，请重试`,
      { detail: { turn, seq, persisted: false } },
    )
  }
  if (participated === false) {
    throw new ControlError(
      ERROR_CODES.deleteFailed,
      `第 ${turn} 轮的删除（seq ${seq}）已写入内存日志，但没有任何持久化监听器参与落盘，重启后这一轮会重新出现`,
      { detail: { turn, seq, persisted: false } },
    )
  }
}

function safeEstimate(fn) {
  try {
    const value = fn()
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** `isAppendSurfaceEvent` 的内联等价物：本模块不 import harness 包，所以自己判。 */
function isAppendSurfaceEvent(event) {
  return event?.surfaceOp === 'append'
}

/** 事件自带的轮次号（只有部分事件类型有）。 */
function eventTurn(event) {
  if (event?.type === 'assistant/message' || event?.type === 'tool/result') return event.data?.turn
  return undefined
}

/** 读事件流：优先公开的 snapshotEvents，回退旧属性（老内核）。 */
function readEvents(session) {
  if (typeof session?.snapshotEvents === 'function') {
    const snapshot = session.snapshotEvents()
    if (Array.isArray(snapshot)) return snapshot
  }
  if (Array.isArray(session?.events)) return session.events
  throw new ControlError(ERROR_CODES.deleteFailed, '读不到会话事件流')
}

/** 读当前可见面节点。 */
function readNodes(session) {
  const nodes = session?.surface?.nodes
  if (Array.isArray(nodes)) return nodes
  throw new ControlError(ERROR_CODES.deleteFailed, '读不到会话的可见面')
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error && error.message ? error.message : String(error)
}
