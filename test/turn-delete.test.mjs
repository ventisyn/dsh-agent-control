/**
 * 轮次删除的离线测试。
 *
 * 覆盖的是真正容易算错的东西：区间代数（连续性、来源闭包、系统提示保护）、删除事务的形状
 * （与内核手动压缩同形的四件套）、失败即拒绝（未闭合、正在进行、正在压缩、已压缩、消息不存在）、
 * 幂等、落盘确认，以及事务中途失败时放掉压缩锁。
 *
 * 假内核复刻了内核在 append 时的校验（surface 区间、压缩事务不变量）与格式 v4 **加载时**的
 * 轮次/步骤规则（坑 ⑪），所以「写出一个当下合法、重启后打不开的日志」在这里就会失败。
 * 它仍然不是真内核：真机验证见 AGENTS.md 第 9 节与 `test/v4-load-check.mjs`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { ERROR_CODES } from '../src/shared.mjs'
import {
  DELETION_MODEL,
  DELETION_NOTICE,
  DELETION_PROVIDER,
  appendTurnDeletion,
  deleteTurn,
  deletedTurns,
  isTurnDeleteEvent,
  isTurnDeletionSummary,
  locateTurn,
  openCompaction,
  openTurnAndStep,
  planTurnRemoval,
  roughTokenEstimate,
} from '../src/turn-delete.mjs'
import { fakeSession, foldNodes, threeTurnSession, visibleTexts } from './fake-session.mjs'

const ALL_TEXTS = ['prompt', 'ask user-1', 'reply msg-1', 'ask user-2', 'reply msg-2', 'ask user-3', 'reply msg-3']

/** 往日志里直接塞一条 v1.0.0 写过的旧墓碑（只用来驱动「认得旧形状」的分支）。 */
function pushLegacyTombstone(session, turn) {
  const { userSeq, assistantSeq } = turn
  return session.push({
    type: 'system/message',
    seq: session.seq,
    time: 0,
    data: { turn: turn.turn, step: 0, message: { id: 'legacy-tombstone', role: 'system', content: [], source: { kind: 'system-prompt', provider: 'dsh-agent-control', model: 'turn-tombstone' } } },
    surfaceOp: { op: 'replace', startSeq: userSeq, endSeq: assistantSeq },
    sourceEventSeqs: [userSeq, assistantSeq],
  })
}

const ok = async () => true

test('★ 删中间一轮：该轮在可见面上换成一句删除提示，前后轮次完好', async () => {
  const { session, turns } = threeTurnSession()
  const before = session.snapshotEvents().length

  const result = await deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: ok })

  assert.equal(result.turn, 2)
  assert.equal(result.alreadyDeleted, false)
  const events = session.snapshotEvents()
  assert.deepEqual(visibleTexts(events), ['prompt', 'ask user-1', 'reply msg-1', DELETION_NOTICE, 'ask user-3', 'reply msg-3'])
  assert.equal(events.length, before + 4, '恰好四个事件')
  // 被删那一轮的事件仍在日志里（append-only），只是不再进入可见面。
  assert.ok(events.some((event) => event.data?.message?.id === turns[1].assistantId))
})

test('★ 删除事务与内核手动压缩同形：start / summary / checkpoint 替换 / end（坑 ⑪）', async () => {
  const { session, turns } = threeTurnSession()
  const before = session.snapshotEvents().length
  await deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: ok })
  const [start, summary, replacement, end] = session.snapshotEvents().slice(before)

  assert.equal(start.type, 'compaction/start')
  assert.equal(start.data.turn, null, '独立事务：落在轮次之间')
  const id = start.data.compactionId
  assert.equal(typeof id, 'string')

  assert.equal(summary.type, 'compaction/summary')
  assert.equal(summary.data.compactionId, id)
  assert.equal(summary.data.provider, DELETION_PROVIDER)
  assert.equal(summary.data.model, DELETION_MODEL)
  assert.deepEqual(summary.data.shadowedSeqs, [turns[1].userSeq, turns[1].assistantSeq])
  assert.deepEqual(summary.data.shadowedRange, { start: turns[1].userSeq, end: turns[1].assistantSeq })
  assert.ok(Number.isSafeInteger(summary.data.shadowedTokenCount))
  assert.equal(summary.surfaceOp, undefined, 'summary 是纯日志事件，不进可见面')

  assert.equal(replacement.type, 'user/message')
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: turns[1].userSeq, endSeq: turns[1].assistantSeq })
  assert.deepEqual(replacement.sourceEventSeqs, [start.seq, summary.seq, turns[1].userSeq, turns[1].assistantSeq])
  assert.deepEqual(replacement.data.source, { kind: 'compact-checkpoint', compactionId: id })
  assert.equal(typeof replacement.data.id, 'string')
  assert.equal(replacement.data.role, 'user')

  assert.equal(end.type, 'compaction/end')
  assert.deepEqual(end.data, { compactionId: id, turn: null })

  assert.equal(session.snapshotEvents().some((event) => event.type === 'system/message' && event.seq >= before), false, '★ 不再写 system/message 墓碑')
  assert.ok(isTurnDeletionSummary(summary))
})

test('系统提示节点不会被遮蔽', async () => {
  const { session, turns } = threeTurnSession()
  await deleteTurn({ session, assistantMessageId: turns[0].assistantId, flush: ok })
  const nodes = foldNodes(session.snapshotEvents())
  assert.equal(nodes[0], 0, 'system 节点仍是可见面的第一个节点')
  assert.equal(visibleTexts(session.snapshotEvents())[0], 'prompt')
})

test('删最后一轮后仍能开始新的一轮', async () => {
  const { session, turns } = threeTurnSession()
  await deleteTurn({ session, assistantMessageId: turns[2].assistantId, flush: ok })
  assert.doesNotThrow(() => {
    session.append('turn/start', { turn: 4 })
    session.append('user/message', { id: 'next', role: 'user', content: [{ type: 'text', text: 'after' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  }, '压缩锁必须已释放，否则新一轮的 turn/start 会被拒绝')
  assert.ok(visibleTexts(session.snapshotEvents()).includes('after'))
})

test('相邻两轮可以先后删除', async () => {
  const { session, turns } = threeTurnSession()
  await deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: ok })
  await deleteTurn({ session, assistantMessageId: turns[2].assistantId, flush: ok })
  assert.deepEqual(visibleTexts(session.snapshotEvents()), ['prompt', 'ask user-1', 'reply msg-1', DELETION_NOTICE, DELETION_NOTICE])
  assert.deepEqual(deletedTurns(session.snapshotEvents()), [2, 3])
})

test('重复删除同一轮是幂等的：不再写第二笔事务，并且再落盘一次', async () => {
  const { session, turns } = threeTurnSession()
  const first = await deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: ok })
  const length = session.snapshotEvents().length
  let flushed = 0
  const second = await deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: async () => { flushed += 1; return true } })

  assert.equal(second.alreadyDeleted, true)
  assert.equal(session.snapshotEvents().length, length, '不重复写')
  assert.equal(flushed, 1, '「已删过」也要再落盘一次')
  assert.ok(Number.isSafeInteger(second.seq) && Number.isSafeInteger(first.seq))
})

test('deletedTurns 新旧两种删除记录都认，轮次号从被遮蔽的节点反推', async () => {
  const { session, turns } = threeTurnSession()
  const legacy = pushLegacyTombstone(session, turns[0])
  await deleteTurn({ session, assistantMessageId: turns[2].assistantId, flush: ok })
  assert.deepEqual(deletedTurns(session.snapshotEvents()), [1, 3])
  assert.ok(isTurnDeleteEvent(legacy))

  // 旧墓碑覆盖的那一轮也算「已删过」，不再写新事务。
  const length = session.snapshotEvents().length
  const again = await deleteTurn({ session, assistantMessageId: turns[0].assistantId, flush: ok })
  assert.equal(again.alreadyDeleted, true)
  assert.equal(session.snapshotEvents().length, length)
})

test('未闭合的轮次被拒绝（TURN_NOT_CLOSED），且不写入任何东西', async () => {
  const { session } = threeTurnSession()
  session.push({ type: 'turn/start', seq: session.seq, time: 0, data: { turn: 4 } })
  session.push({
    type: 'assistant/message',
    seq: session.seq,
    time: 0,
    data: { turn: 4, step: 0, message: { id: 'open', role: 'assistant', content: [{ type: 'text', text: 'partial' }], source: { kind: 'model', provider: 'p', model: 'm' } } },
    surfaceOp: 'append',
  })
  const before = session.snapshotEvents().length
  await assert.rejects(() => deleteTurn({ session, assistantMessageId: 'open', flush: ok }), (error) => error.code === ERROR_CODES.turnNotClosed)
  assert.equal(session.snapshotEvents().length, before)
})

test('别的轮次正在进行时拒绝（AGENT_BUSY）：独立压缩只能落在轮次之间', async () => {
  const { session, turns } = threeTurnSession()
  session.push({ type: 'turn/start', seq: session.seq, time: 0, data: { turn: 4 } })
  const before = session.snapshotEvents().length
  await assert.rejects(
    () => deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: ok }),
    (error) => error.code === ERROR_CODES.agentBusy && /第 4 轮正在进行/.test(error.message),
  )
  assert.equal(session.snapshotEvents().length, before)
})

test('会话正在压缩时拒绝（AGENT_BUSY），不叠第二把锁', async () => {
  const { session, turns } = threeTurnSession()
  session.push({ type: 'compaction/start', seq: session.seq, time: 0, data: { compactionId: 'other', turn: null } })
  assert.equal(openCompaction(session.snapshotEvents())?.data.compactionId, 'other')
  const before = session.snapshotEvents().length
  await assert.rejects(
    () => deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: ok }),
    (error) => error.code === ERROR_CODES.agentBusy && /正在压缩/.test(error.message),
  )
  assert.equal(session.snapshotEvents().length, before)
})

test('有 agent 时在维护租约里写；拿不到租约（同步抛错）报 AGENT_BUSY 且不写', async () => {
  const { session, turns } = threeTurnSession()
  let leased = 0
  const agent = { runMaintenance: (task) => { leased += 1; return task(new AbortController().signal) } }
  await deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: ok, agent })
  assert.equal(leased, 1)

  const other = threeTurnSession()
  const before = other.session.snapshotEvents().length
  const busy = { runMaintenance: () => { throw new Error('agent is active') } }
  await assert.rejects(
    () => deleteTurn({ session: other.session, assistantMessageId: other.turns[1].assistantId, flush: ok, agent: busy }),
    (error) => error.code === ERROR_CODES.agentBusy && /agent is active/.test(error.message),
  )
  assert.equal(other.session.snapshotEvents().length, before)
})

test('shadowedTokenCount 优先用注入的计量，拿不到时退回粗估', async () => {
  const { session, turns } = threeTurnSession()
  const before = session.snapshotEvents().length
  await deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: ok, estimateTokens: () => 42 })
  assert.equal(session.snapshotEvents()[before + 1].data.shadowedTokenCount, 42)

  const other = threeTurnSession()
  const at = other.session.snapshotEvents().length
  await deleteTurn({ session: other.session, assistantMessageId: other.turns[1].assistantId, flush: ok, estimateTokens: () => undefined })
  const seqs = [other.turns[1].userSeq, other.turns[1].assistantSeq]
  assert.equal(other.session.snapshotEvents()[at + 1].data.shadowedTokenCount, roughTokenEstimate(other.session.snapshotEvents(), seqs))
})

test('事务中途被拒绝：报 DELETE_FAILED，补写带 error 的 compaction/end 放掉锁，可见面不变', () => {
  const { session, turns } = threeTurnSession()
  const located = locateTurn({ events: session.snapshotEvents(), nodes: session.surface.nodes, assistantMessageId: turns[1].assistantId })
  const append = (type, data, intent) => {
    if (type === 'user/message') throw new Error('checkpoint rejected')
    return session.append(type, data, intent)
  }
  assert.throws(
    () => appendTurnDeletion({ append, plan: located.plan, shadowedTokenCount: 1 }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.deleteFailed)
      assert.match(error.message, /user\/message/)
      assert.match(error.message, /checkpoint rejected/)
      assert.equal(error.detail.lockReleased, true)
      return true
    },
  )
  const events = session.snapshotEvents()
  assert.equal(events.at(-1).type, 'compaction/end')
  assert.match(events.at(-1).data.error, /checkpoint rejected/)
  assert.equal(openCompaction(events), undefined, '锁已释放')
  assert.deepEqual(visibleTexts(events), ALL_TEXTS, '可见面没变')
})

test('flush 返回 false 时报 DELETE_FAILED，不假装删除成功；重试会再落盘', async () => {
  const { session, turns } = threeTurnSession()
  await assert.rejects(
    () => deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: async () => false }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.deleteFailed)
      assert.match(error.message, /没有任何持久化监听器/)
      assert.equal(error.detail?.persisted, false)
      return true
    },
  )
  let flushed = 0
  const retry = await deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: async () => { flushed += 1; return true } })
  assert.equal(retry.alreadyDeleted, true)
  assert.equal(flushed, 1)
})

test('flush 抛错时报 DELETE_FAILED 并保留原因', async () => {
  const { session, turns } = threeTurnSession()
  await assert.rejects(
    () => deleteTurn({ session, assistantMessageId: turns[1].assistantId, flush: async () => { throw new Error('磁盘满了') } }),
    (error) => error.code === ERROR_CODES.deleteFailed && /磁盘满了/.test(error.message),
  )
})

test('找不到消息时拒绝', async () => {
  const { session } = threeTurnSession()
  await assert.rejects(() => deleteTurn({ session, assistantMessageId: 'does-not-exist', flush: ok }), (error) => error.code === ERROR_CODES.targetNotFound)
})

test('轮次与后来的替换共用可见节点时拒绝（不删一半）', () => {
  const { session, turns } = threeTurnSession()
  const first = turns[0]
  session.push({
    type: 'user/message',
    seq: session.seq,
    time: 0,
    data: { id: 'compacted', role: 'user', content: [{ type: 'text', text: 'merged' }], source: { kind: 'user' } },
    surfaceOp: { op: 'replace', startSeq: first.userSeq, endSeq: first.assistantSeq },
    sourceEventSeqs: [first.userSeq, first.assistantSeq],
  })
  const replacementSeq = session.seq - 1
  const nodes = session.surface.nodes
  assert.ok(nodes.includes(replacementSeq))
  assert.throws(
    () => planTurnRemoval({ events: session.snapshotEvents(), nodes, turn: 1, bracket: { start: 1, end: 4 }, targetSeq: replacementSeq }),
    (error) => error.code === ERROR_CODES.turnCompacted,
  )
})

test('目标消息不在可见面上时拒绝', () => {
  const { session, turns } = threeTurnSession()
  const nodes = session.surface.nodes.filter((seq) => seq !== turns[1].assistantSeq)
  assert.throws(
    () => planTurnRemoval({ events: session.snapshotEvents(), nodes, turn: 2, bracket: { start: turns[1].userSeq - 1, end: turns[1].assistantSeq + 1 }, targetSeq: turns[1].assistantSeq }),
    (error) => error.code === ERROR_CODES.turnCompacted,
  )
})

test('locateTurn 能定位目标并给出可用的替换区间', () => {
  const { session, turns } = threeTurnSession()
  const located = locateTurn({ events: session.snapshotEvents(), nodes: session.surface.nodes, assistantMessageId: turns[2].assistantId })
  assert.equal(located.turn, 3)
  assert.equal(located.plan.startSeq, turns[2].userSeq)
  assert.equal(located.plan.endSeq, turns[2].assistantSeq)
  assert.deepEqual(located.plan.sourceSeqs, [turns[2].userSeq, turns[2].assistantSeq])
})

test('位于第一轮括号内的非空系统提示不会被算进删除范围', () => {
  const session = fakeSession()
  session.push({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
  session.push({ type: 'system/message', seq: 1, time: 0, data: { turn: 1, step: 0, message: { role: 'system', content: [{ type: 'text', text: '真实系统提示' }], source: { kind: 'system-prompt' } } }, surfaceOp: 'append' })
  session.push({ type: 'user/message', seq: 2, time: 0, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'ask' }], source: { kind: 'user' } }, surfaceOp: 'append' })
  session.push({ type: 'assistant/message', seq: 3, time: 0, data: { turn: 1, step: 0, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'reply' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' })
  session.push({ type: 'turn/end', seq: 4, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
  const located = locateTurn({ events: session.snapshotEvents(), nodes: session.surface.nodes, assistantMessageId: 'a1' })
  assert.deepEqual(located.plan.sourceSeqs, [2, 3], '系统提示节点（seq 1）必须留在可见面上')
})

test('假内核按格式 v4 的加载规则拒绝落在打开步骤之外的 system/message（坑 ⑪ 的旧写法）', () => {
  const { session, turns } = threeTurnSession()
  assert.throws(() => {
    session.append('system/message', { turn: 2, step: 0, message: { id: 'x', role: 'system', content: [], source: { kind: 'system-prompt' } } }, {
      surfaceOp: { op: 'replace', startSeq: turns[1].userSeq, endSeq: turns[1].assistantSeq },
      sourceEventSeqs: [turns[1].userSeq, turns[1].assistantSeq],
    })
  }, /does not match an open turn and step/)
})

test('假内核拒绝不成对的压缩事务（离线就能抓住事务写错）', () => {
  const { session } = threeTurnSession()
  assert.throws(() => session.append('compaction/summary', { compactionId: 'nope', summary: [], shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 0, provider: 'p', model: 'm' }), /no matching compaction\/start/)
  session.append('compaction/start', { compactionId: 'c', turn: null })
  assert.throws(() => session.append('compaction/end', { compactionId: 'c', turn: null }), /requires one compaction\/summary/)
  assert.throws(() => session.append('turn/start', { turn: 4 }), /cannot cross an open compaction/)
})


// ---------------------------------------------------------------------------
// 内核压缩（/compact）之后的形状：这一组用例是按真实事务的写法构造的
// ---------------------------------------------------------------------------

/**
 * 往日志里追加一笔**内核手动压缩**（\`/compact\`）形状的事务，遮蔽给定的连续事件区间。
 *
 * 与 \`appendTurnDeletion\` 写的那笔同形，区别只在「谁写的」：这里没有插件标记，摘要内容是内核
 * 生成的，而且 \`shadowedSeqs\` 按**可见面**给出连续一段（内核的不变量就是这么校验的），
 * 被遮的区间里夹着的 \`turn/start\` / \`turn/end\` 并不进去——按「数值区间」折叠的实现
 * 恰恰会在这里算错。
 *
 * 传进来的区间必须是可见面上连续的一段；不连续就直接抛错，免得把测试样本写成内核不可能写出的形状。
 *
 * 全程走假内核的 \`append\`，所以压缩事务不变量与格式 v4 的加载规则都会被真实校验一遍。
 *
 * @param {any} session - 假会话。
 * @param {number} startSeq - 可见面上的第一个被遮节点。
 * @param {number} endSeq - 可见面上的最后一个被遮节点（含）。
 * @returns {number} 替换后的 checkpoint 节点 seq。
 */
function appendKernelCompaction(session, startSeq, endSeq) {
  const nodes = session.surface.nodes
  const first = nodes.indexOf(startSeq)
  const last = nodes.indexOf(endSeq)
  assert.ok(first >= 0 && last >= first, `压缩区间必须是可见面上连续的一段：${startSeq}..${endSeq}`)
  const shadowedSeqs = nodes.slice(first, last + 1)
  const compactionId = 'kernel-compact-1'
  session.append('compaction/start', { compactionId, turn: null })
  session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: '内核生成的摘要' }],
    // ⚠️ 内核这边用的是 { start, end }（不是 surfaceOp 上的 startSeq / endSeq）——两套名字别混。
    shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs.at(-1) },
    shadowedSeqs,
    shadowedTokenCount: 42,
  })
  session.append('user/message', {
    id: 'kernel-checkpoint',
    role: 'user',
    content: [{ type: 'text', text: '内核压缩摘要占位' }],
    source: { kind: 'compact-checkpoint', compactionId },
  }, {
    surfaceOp: { op: 'replace', startSeq: shadowedSeqs[0], endSeq: shadowedSeqs.at(-1) },
    // 真机日志里这一项是「summary 自己 + 它所遮蔽的那些节点」，内核要求不重复、且覆盖整个区间。
    sourceEventSeqs: [session.seq - 1, ...shadowedSeqs],
  })
  const replacementSeq = session.seq - 1
  session.append('compaction/end', { compactionId, turn: null })
  return replacementSeq
}

test('★ 内核压缩吃掉整轮后：该轮判 TURN_COMPACTED（已不在可见面上），且一个事件都不写', async () => {
  // 真机里最容易出现、却一直没构造出来的样本：用户先用 /compact 压缩过历史，再来删那一轮。
  // 内核压掉的轮次**本来就不该**可删——插件必须拒绝，而不是删掉一半或删错范围。
  const { session, turns } = threeTurnSession()
  appendKernelCompaction(session, turns[0].userSeq, turns[1].assistantSeq)

  const afterCompaction = session.snapshotEvents()
  const nodes = session.surface.nodes
  assert.ok(!nodes.includes(turns[0].assistantSeq), '前提：被压缩的那一轮已经不在可见面上')
  assert.ok(nodes.includes(turns[2].assistantSeq), '前提：最后一轮仍然可见')
  // 设计边界（别写反）：`deletedTurns` **只认本插件写的删除记录**。内核 /compact 压掉的轮次
  // 不算「已删除轮次」——它们由宿主自己的压缩呈现处理，插件不该把它们报成自己删的，
  // 否则界面会去隐藏一段宿主本来就会折叠的内容。
  assert.deepEqual(deletedTurns(afterCompaction), [], '内核压缩不是本插件的删除记录')

  const lengthBefore = afterCompaction.length
  await assert.rejects(
    () => deleteTurn({ session, assistantMessageId: turns[0].assistantId, flush: ok }),
    (error) => error.code === ERROR_CODES.turnCompacted,
    '★ 已被内核压缩掉的轮次必须判 TURN_COMPACTED',
  )
  assert.equal(session.snapshotEvents().length, lengthBefore, '★ 拒绝时不能写任何事件（不许删一半）')

  // 压缩后新的一轮仍然可以整段删除：被遮的只是被压缩掉的那些轮次。
  const result = await deleteTurn({ session, assistantMessageId: turns[2].assistantId, flush: ok })
  assert.equal(result.turn, 3)
})

test('★ 轮次只被压缩掉一半（可见面上只剩半轮）时同样拒绝，并指出缺口', () => {
  // 压缩区间恰好切在轮次中间：可见面上剩下一条「无头」的 assistant 节点。此时整段替换
  // 会连别人的内容一起吃掉，必须拒绝。现场形态与真机一致（区间里含 turn/start、turn/end）。
  const { session, turns } = threeTurnSession()
  // 只遮到第 2 轮的用户消息为止，第 2 轮的回复留在可见面上。
  appendKernelCompaction(session, turns[0].userSeq, turns[1].userSeq)

  const nodes = session.surface.nodes
  assert.ok(!nodes.includes(turns[1].userSeq), '前提：第 2 轮的问题已被遮掉')
  assert.ok(nodes.includes(turns[1].assistantSeq), '前提：第 2 轮的回复还留在可见面上')

  // 实际命中的是「与其它内容共用了同一个可见节点」这一条：checkpoint 节点里同时装着第 1 轮，
  // 想删第 2 轮就必须连它一起吃掉。插件在这里拒绝得更保守——**这正是要的行为**，
  // 所以断言只钉「拒绝 + 不删一半」，不钉具体是哪一句文案。
  assert.throws(
    () => planTurnRemoval({
      events: session.snapshotEvents(),
      nodes,
      turn: 2,
      bracket: { start: turns[1].userSeq - 1, end: turns[1].assistantSeq + 1 },
      targetSeq: turns[1].assistantSeq,
    }),
    (error) => error.code === ERROR_CODES.turnCompacted,
    '★ 半被压缩的轮次必须拒绝（不删一半）',
  )
})

test('openTurnAndStep 按 turn/step 配对算出打开的轮次与步骤', () => {
  assert.equal(openTurnAndStep([]), null)
  assert.equal(openTurnAndStep([{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1 } }]), null)
  assert.deepEqual(openTurnAndStep([{ type: 'turn/start', data: { turn: 2 } }]), { turn: 2, step: null })
  assert.deepEqual(openTurnAndStep([{ type: 'turn/start', data: { turn: 2 } }, { type: 'step/start', data: { turn: 2, step: 1 } }]), { turn: 2, step: 1 })
})
