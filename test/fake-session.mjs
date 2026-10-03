/**
 * 离线测试用的「假内核」。
 *
 * 它刻意复刻 `@deepseek-ai/dsh-session` 在 append 时真正会做的校验（见 AGENTS.md 3.3），
 * 因为这些校验正是最容易踩雷的地方：区间字段名、区间必须是更早的事件、
 * 区间必须整段是当前 surface 节点、引用必须覆盖区间内每一个节点。
 *
 * 复刻的目的是**在离线测试里就能抓住**算错的区间，而不是等到真实会话上才发现。
 * 它不是内核的替代品：真正的验收仍然要按 AGENTS.md 第 9 节在真实会话上实测。
 */

/** 与 `@deepseek-ai/dsh-session` 的 `SystemMessage` 同形（空内容系统消息）。 */
export function systemMessage() {
  return {
    role: 'system',
    content: [],
    source: { kind: 'system-prompt', provider: 'dsh-agent-control', model: 'turn-tombstone' },
  }
}

/** 一条 assistant 消息（只需要 id 能被 `locateTurn` 认出来）。 */
export function assistantMessage(id) {
  return { id, role: 'assistant', content: [{ type: 'text', text: `reply ${id}` }], source: { kind: 'model', provider: 'p', model: 'm' } }
}

/** 一条 user 消息。 */
export function userMessage(id) {
  return { id, role: 'user', content: [{ type: 'text', text: `ask ${id}` }], source: { kind: 'user' } }
}

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** 格式 v4 里必须落在「打开的轮次与步骤」内的事件类型（`Relationships` 的 STEP_EVENT_TYPES）。 */
const STEP_EVENT_TYPES = new Set(['system/message', 'developer/message', 'assistant/attempt'])

/**
 * 复刻格式 v4 **加载时**的轮次/步骤配对规则（`dsh-session-format-v3-to-v4` 的 `requireStep`）。
 *
 * ⚠️ 真内核在**运行时 append** 里不查这条，只在会话**下次加载**时查——这正是坑 ⑪：墓碑当场写进去，
 * 重启后整个会话打不开。假内核在 append 时就查，让这类问题在离线阶段就失败。
 *
 * @param {any[]} events - 已提交的事件。
 * @param {any} event - 待提交的事件。
 * @throws {Error} 与内核加载校验相同的报错。
 */
function validateStepRelationship(events, event) {
  if (!STEP_EVENT_TYPES.has(event.type)) return
  let turn = null
  let step = null
  for (const prior of events) {
    if (prior.type === 'turn/start') { turn = prior.data?.turn ?? null; step = null }
    else if (prior.type === 'turn/end') { turn = null; step = null }
    else if (prior.type === 'step/start') step = prior.data?.step ?? null
    else if (prior.type === 'step/end') step = null
  }
  if (turn === null || step === null || event.data?.turn !== turn || event.data?.step !== step) {
    throw new Error(`SessionFormatError: ${event.type} does not match an open turn and step`)
  }
}

/**
 * 复刻内核的 surface 校验（`isReplaceOp` + `assertSourceEventReferences` + `replacementRange`）。
 *
 * @param {any[]} events - 已提交的事件。
 * @param {any} event - 待提交的事件。
 * @returns {number[]} 被遮蔽的 surface 节点 seq。
 * @throws {Error} 违反任一内核规则时抛出（消息与内核一致）。
 */
function validateSurface(events, event) {
  if (!SURFACE_TYPES.has(event.type)) {
    if (event.surfaceOp !== undefined) throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`)
    if (event.sourceEventSeqs !== undefined) throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`)
    return []
  }
  const op = event.surfaceOp
  if (op === undefined) throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`)
  if (op === 'append') {
    if (event.type === 'assistant/message' && event.sourceEventSeqs !== undefined) {
      throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs')
    }
    return []
  }
  const keys = Object.keys(op)
  const isReplace = keys.length === 3 && op.op === 'replace'
    && Number.isSafeInteger(op.startSeq) && op.startSeq >= 0
    && Number.isSafeInteger(op.endSeq) && op.endSeq >= 0
  if (!isReplace) throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`)

  const raw = event.sourceEventSeqs
  const sources = new Set()
  if (raw !== undefined) {
    if (!Array.isArray(raw)) throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`)
    if (raw.length === 0) throw new Error('sourceEventSeqs must not be empty')
    for (const source of raw) {
      if (!Number.isSafeInteger(source) || source < 0) {
        throw new Error(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`)
      }
      sources.add(source)
      if (source >= event.seq) {
        throw new Error(`sourceEventSeqs must reference earlier events: ${source} >= current seq ${event.seq}`)
      }
    }
    if (sources.size !== raw.length) throw new Error('sourceEventSeqs must not contain duplicates')
  }
  if (op.startSeq >= event.seq || op.endSeq >= event.seq) {
    throw new Error(`surface replace at seq ${event.seq}: startSeq and endSeq must reference earlier events`)
  }

  const nodes = foldNodes(events)
  const startIdx = nodes.indexOf(op.startSeq)
  if (startIdx === -1) throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`)
  const endIdx = nodes.indexOf(op.endSeq)
  if (endIdx === -1) throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(`surface replace: start seq ${op.startSeq} (index ${startIdx}) is after end seq ${op.endSeq} (index ${endIdx})`)
  }
  const shadowed = nodes.slice(startIdx, endIdx + 1)
  const missing = shadowed.filter((seq) => !sources.has(seq))
  if (missing.length > 0) {
    throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`)
  }
  return shadowed
}

/**
 * 复刻 `@deepseek-ai/dsh-compaction` 的压缩事务不变量（`invariant.js` 的 `validateCompactionEvent`）：
 * start / summary / checkpoint 替换 / end 的配对、独立事务（`turn: null`）只能落在轮次之间、
 * summary 的 `shadowedSeqs` 必须恰好是当前可见面上的一段、轮次边界不能穿过打开的压缩。
 *
 * @param {any[]} events - 已提交的事件。
 * @param {any} event - 待提交的事件。
 * @throws {Error} 违反任一规则时抛出。
 */
function validateCompaction(events, event) {
  let openTurn = null
  let open
  for (const prior of events) {
    if (prior.type === 'turn/start') openTurn = prior.data?.turn ?? null
    else if (prior.type === 'turn/end') openTurn = null
    else if (prior.type === 'compaction/start') open = { id: prior.data?.compactionId, turn: prior.data?.turn, summarized: false }
    else if (prior.type === 'compaction/summary' && open !== undefined) open.summarized = true
    else if (prior.type === 'compaction/end' || prior.type === 'session/end-seed') open = undefined
  }
  const owner = (turn, label) => {
    if (turn === null) {
      if (openTurn !== null) throw new Error(`${label} is standalone but turn ${openTurn} is open`)
    } else if (turn !== openTurn) throw new Error(`${label} names turn ${turn} but open turn is ${openTurn}`)
  }
  if ((event.type === 'turn/start' || event.type === 'turn/end') && open !== undefined) {
    throw new Error(`${event.type} cannot cross an open compaction`)
  }
  if (event.type === 'compaction/start') {
    if (typeof event.data?.compactionId !== 'string' || event.data.compactionId === '') throw new Error('compaction/start compactionId must be a non-empty string')
    if (open !== undefined) throw new Error('compaction/start while still compacting')
    owner(event.data.turn, 'compaction/start')
  } else if (event.type === 'compaction/summary') {
    if (open === undefined || event.data?.compactionId !== open.id) throw new Error('compaction/summary has no matching compaction/start')
    if (open.summarized) throw new Error('compaction/summary repeated within one compaction')
    owner(open.turn, 'compaction/summary')
    const { start, end } = event.data.shadowedRange ?? {}
    const seqs = event.data.shadowedSeqs ?? []
    const nodes = foldNodes(events)
    const from = nodes.indexOf(start)
    const to = nodes.indexOf(end)
    if (seqs[0] !== start || seqs.at(-1) !== end) throw new Error('compaction/summary shadowedRange must match the first and last shadowedSeqs')
    if (from < 0 || to < from || JSON.stringify(nodes.slice(from, to + 1)) !== JSON.stringify(seqs)) {
      throw new Error('compaction/summary shadowedSeqs must list every node in the current surface span')
    }
    if (!Number.isSafeInteger(event.data.shadowedTokenCount) || event.data.shadowedTokenCount < 0) throw new Error('compaction/summary shadowedTokenCount must be a non-negative safe integer')
  } else if (event.type === 'compaction/end') {
    if (open === undefined || event.data?.compactionId !== open.id) throw new Error('compaction/end has no matching compaction/start')
    if (event.data.turn !== open.turn) throw new Error('compaction/end owner does not match compaction/start owner')
    owner(open.turn, 'compaction/end')
    if (event.data.error === undefined && !open.summarized) throw new Error('successful compaction/end requires one compaction/summary')
  } else if (event.type === 'user/message' && event.surfaceOp !== 'append' && event.data?.source?.kind === 'compact-checkpoint') {
    if (open === undefined || event.data.source.compactionId !== open.id) throw new Error('compaction checkpoint has no matching compaction/start')
  }
}

/**
 * 折叠出当前 surface 节点序列（`nodes` 的语义：可见的事件 seq，按可见顺序）。
 *
 * @param {any[]} events - 事件流。
 * @returns {number[]} 节点 seq 列表。
 */
export function foldNodes(events) {
  let nodes = []
  for (const event of events) {
    if (!SURFACE_TYPES.has(event.type)) continue
    const op = event.surfaceOp
    if (op === 'append') {
      // 空内容的系统消息是「休眠」节点：它占一个节点但不投影成消息。
      nodes = [...nodes, event.seq]
      continue
    }
    if (op !== undefined && op !== null && typeof op === 'object' && op.op === 'replace') {
      const startIdx = nodes.indexOf(op.startSeq)
      const endIdx = nodes.indexOf(op.endSeq)
      if (startIdx === -1 || endIdx === -1) continue
      nodes = [...nodes.slice(0, startIdx), event.seq, ...nodes.slice(endIdx + 1)]
    }
  }
  return nodes
}

/**
 * 造一个假会话：行为与真实 `Session` 在上述校验范围内一致。
 *
 * @param {any[]} [seed] - 初始事件（测试直接用内部构造器造，不再走校验）。
 * @returns {any} 具备 `snapshotEvents` / `surface` / `append` / `seq` 的假会话。
 */
export function fakeSession(seed = []) {
  const events = [...seed]
  const session = {
    get seq() {
      return events.length
    },
    snapshotEvents() {
      return [...events]
    },
    get surface() {
      return { nodes: foldNodes(events), replaceGeneration: 0, contentGeneration: 0 }
    },
    /** 与内核同序：先校验（会同步抛错），再入日志。 */
    append(type, data, intent) {
      const event = { type, seq: events.length, time: 0, data, ...(intent ?? {}) }
      validateSurface(events, event)
      validateStepRelationship(events, event)
      validateCompaction(events, event)
      events.push(event)
      return event
    },
    /** 测试内部用：接一段已经合法的事件，不再走校验。 */
    push(event) {
      events.push(event)
      return event
    },
  }
  return session
}

/**
 * 造一段「干净」的三轮对话事件流。
 *
 * 形状：system 提示（node 0）+ 三轮「user → assistant」，每轮有 turn/start 与 turn/end。
 * 每轮的 surface 节点连续，正是可以整段删除的情形。
 *
 * @returns {{ session: any, turns: Array<{ turn: number, userSeq: number, assistantSeq: number, assistantId: string }> }}
 */
export function threeTurnSession() {
  const session = fakeSession()
  session.push({ type: 'system/message', seq: 0, time: 0, data: { turn: 0, step: 0, message: { role: 'system', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'system-prompt' } } }, surfaceOp: 'append' })
  const turns = []
  for (let turn = 1; turn <= 3; turn += 1) {
    const assistantId = `msg-${turn}`
    session.push({ type: 'turn/start', seq: session.seq, time: 0, data: { turn } })
    const userSeq = session.seq
    session.push({ type: 'user/message', seq: session.seq, time: 0, data: { ...userMessage(`user-${turn}`), turn, step: 0 }, surfaceOp: 'append' })
    const assistantSeq = session.seq
    session.push({
      type: 'assistant/message',
      seq: session.seq,
      time: 0,
      data: { turn, step: 0, message: assistantMessage(assistantId) },
      surfaceOp: 'append',
    })
    session.push({ type: 'turn/end', seq: session.seq, time: 0, data: { turn, reason: { kind: 'completed' } } })
    turns.push({ turn, userSeq, assistantSeq, assistantId })
  }
  return { session, turns }
}

/**
 * 按内核规则把日志投影成模型可见的消息列表（只取消息内容，便于断言）。
 *
 * 空内容的 system / developer / assistant 消息不投影（休眠节点）。
 *
 * @param {any[]} events - 事件流。
 * @returns {string[]} 每条可见消息的文本。
 */
export function visibleTexts(events) {
  const nodes = foldNodes(events)
  const texts = []
  for (const seq of nodes) {
    const event = events[seq]
    if (event === undefined) continue
    const message = event.type === 'user/message' ? event.data : event.data?.message
    if (message === undefined || !Array.isArray(message.content) || message.content.length === 0) continue
    texts.push(message.content.map((block) => block.text ?? '').join(''))
  }
  return texts
}
