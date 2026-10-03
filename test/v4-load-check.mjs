/**
 * 用**真实的** DSH 会话格式 v4 加载校验器检查一个会话日志——以及「删掉其中某一轮」之后的日志。
 *
 * 为什么要有它（坑 ⑪）：运行中的内核 append 不跑加载校验，假内核又只是复刻。v1.0.0 的墓碑就是
 * 「append 通过、假内核通过、重启后整个会话打不开」。这个脚本直接调 DSH 安装目录里的
 * `restoreReleasedV4Artifact` + `assertReleasedV4Relationships`（会话加载时跑的就是它们），
 * 在**内存里**模拟删除，回答「这样写，重启后还打得开吗」。
 *
 *   node test/v4-load-check.mjs <DSH 的 node_modules/.pnpm 目录> <会话 id | 日志路径>
 *
 * 输出三类结果：原日志本身、旧写法（system/message 墓碑，应当 FAIL——证明校验器确实生效）、
 * 每一轮按当前写法删除后的日志（应当 OK，或者被规划阶段明确拒绝）。
 *
 * 只读：不写会话目录、不碰 profile。会 import DSH 安装目录里的包，所以只适合在装了 DSH 的机器上跑，
 * 不进 `npm test`。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeSessionLog, parseEvents, resolveSessionLog } from './log-inspect.mjs'
import { foldNodes } from './fake-session.mjs'
import { appendTurnDeletion, prepareTurnDeletion, roughTokenEstimate } from '../src/turn-delete.mjs'

/** 在 pnpm 目录里找某个 @deepseek-ai 包的入口。 */
function findPackage(pnpmDir, name) {
  // pnpm 会把过长的目录名截断加哈希（如 `@deepseek-ai+dsh-session-fo_070c…`），所以不按名字前缀猜，
  // 而是逐个看里面是否真有这个包。
  for (const entry of readdirSync(pnpmDir)) {
    if (!entry.startsWith('@deepseek-ai+')) continue
    const main = path.join(pnpmDir, entry, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')
    if (existsSync(main)) return pathToFileURL(main).href
  }
  throw new Error(`在 ${pnpmDir} 里找不到 @deepseek-ai/${name}`)
}

/** 跑一次真实加载校验；通过返回 'OK'，否则返回失败原因。 */
function makeChecker(v4, known, header) {
  return (events) => {
    // fork 出来的会话（isSeeded）带着父会话的前缀：前缀长度就是最后一个 inherited 的 end-seed 的位置。
    const cut = header.isSeeded === true
      ? Math.max(0, events.findLastIndex((event) => event.type === 'session/end-seed' && event.data?.inherited === true))
      : 0
    const artifact = { header, events, inheritedEventCount: cut }
    try {
      v4.restoreReleasedV4Artifact(artifact, known)
      v4.assertReleasedV4Relationships(artifact, known)
      return 'OK'
    } catch (error) {
      return `FAIL ${String(error?.message ?? error).slice(0, 200)}`
    }
  }
}

/** 在内存里模拟一次 append（seq = 日志长度，与内核契约一致）。 */
function simulatedAppend(events) {
  return (type, data, intent) => {
    const event = { type, seq: events.length, time: Date.now(), data, ...(intent ?? {}) }
    events.push(event)
    return event
  }
}

/**
 * 检查一个会话日志（以及在内存里逐轮模拟删除后的日志）。
 *
 * @param {string} pnpmDir - DSH 安装目录下的 `node_modules/.pnpm`。
 * @param {string} target - 会话 id 或日志路径。
 * @returns {Promise<{ log: string, events: number, original: string, legacyTombstone: string | null, turns: Record<string, string> }>} 报告。
 */
export async function checkSessionLog(pnpmDir, target) {
  const v4 = await import(findPackage(pnpmDir, 'dsh-session-format-v3-to-v4'))
  const { KNOWN_SESSION_EVENT_TYPES: known } = await import(findPackage(pnpmDir, 'dsh-session'))

  const logPath = resolveSessionLog(target)
  const rows = parseEvents(decodeSessionLog(readFileSync(logPath)).text).events
  const headerRow = rows.find((row) => row.type === 'session' && typeof row.seq !== 'number')
  if (headerRow === undefined) throw new Error('日志里没有会话头')
  const { type: _type, ...header } = headerRow
  const base = rows.filter((row) => typeof row.seq === 'number')
  const check = makeChecker(v4, known, header)

  const report = { log: logPath, events: base.length, original: check(base), legacyTombstone: null, turns: {} }
  const assistants = base.filter((event) => event.type === 'assistant/message' && event.surfaceOp === 'append')
  for (const turn of [...new Set(assistants.map((event) => event.data?.turn))]) {
    const target = assistants.filter((event) => event.data?.turn === turn).at(-1)
    let located
    try {
      located = prepareTurnDeletion({ events: base, nodes: foldNodes(base), assistantMessageId: target.data.message.id })
    } catch (error) {
      report.turns[turn] = `规划拒绝 ${error.code ?? ''} ${error.message}`
      continue
    }
    const events = [...base]
    try {
      appendTurnDeletion({ append: simulatedAppend(events), plan: located.plan, shadowedTokenCount: roughTokenEstimate(base, located.plan.sourceSeqs) })
      report.turns[turn] = `${check(events)}（遮蔽 ${located.plan.sourceSeqs.length} 个节点）`
    } catch (error) {
      report.turns[turn] = `写入拒绝 ${error.message}`
    }
    if (report.legacyTombstone === null && typeof target.data?.step === 'number') {
      // 对照组：v1.0.0 的写法在同一轮上必须 FAIL，否则说明校验器没真正跑起来。
      const legacy = [...base, {
        type: 'system/message',
        seq: base.length,
        time: 0,
        data: { turn, step: target.data.step, message: { id: 'legacy', role: 'system', content: [], source: { kind: 'system-prompt' } } },
        surfaceOp: { op: 'replace', startSeq: located.plan.startSeq, endSeq: located.plan.endSeq },
        sourceEventSeqs: located.plan.sourceSeqs,
      }]
      report.legacyTombstone = check(legacy)
    }
  }
  return report
}

async function main(argv) {
  const [pnpmDir, target] = argv.filter((arg) => !arg.startsWith('--'))
  if (!pnpmDir || !target) {
    console.error('用法: node test/v4-load-check.mjs <DSH 的 node_modules/.pnpm 目录> <会话 id | 日志路径>')
    process.exit(2)
  }
  const report = await checkSessionLog(pnpmDir, target)
  console.log(JSON.stringify(report, null, 2))
  const bad = report.original !== 'OK' || Object.values(report.turns).some((value) => value.startsWith('FAIL') || value.startsWith('写入拒绝'))
  process.exit(bad ? 1 : 0)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`检查失败: ${error.message}`)
    process.exit(1)
  })
}
