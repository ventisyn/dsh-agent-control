#!/usr/bin/env node
/**
 * 会话日志诊断器 —— 回答「磁盘上到底存着什么，模型实际看得见什么」。
 *
 * 用途（AGENTS.md 第 9 节自检清单第 3、6 步的取证工具）：
 *   - 核对某次删除是否真的落下了墓碑，以及墓碑遮蔽的区间对不对
 *   - 独立复刻一次 surface 代数，与「模型可见面」对照（不依赖宿主进程）
 *   - 证明轮次删除**不是**安全删除：被删内容仍在日志里
 *
 * ⚠️ 本文件是**只读**工具：只解压、只解析、只打印，不写任何文件、不碰 profile。
 *
 * ⚠️ 会话日志是**多帧拼接**的 zstd（`28 b5 2f fd` 魔数反复出现）。
 *    `zlib.zstdDecompressSync()` 默认**只解第一帧**，而第一帧只是 253 字节的会话头 ——
 *    直接用它只会得到「这个会话只有 1 行」，看起来像日志空了一样。
 *    本文件因此按魔数手动切帧，逐帧解压再拼接。
 *    想让 Node 自己吃多帧，得用 `createZstdDecompress()` 并把**整块 buffer 一次 `end()`**
 *    （分多次 write 也只会解第一帧）—— 不要写成「流式写入」，那是个陷阱。
 *
 * 用法：
 *   node test/log-inspect.mjs <会话 id | session.v4.jsonl.zstd 的路径> [--json]
 *
 * 会话 id 靠遍历 `$DSH_HOME/sessions/*​/<id>/` 现查（与插件同样的做法，不推导 slug 规则）。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const LOG_BASENAME = 'session.v4.jsonl.zstd';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** v1.0.0 旧墓碑的识别特征（只用于识别老日志；这种墓碑会让会话重启后打不开，见坑 ⑪） */
const TOMBSTONE_PROVIDER = 'dsh-agent-control';
const TOMBSTONE_MODEL = 'turn-tombstone';
/** 现行删除事务的识别特征：写在 compaction/summary 上（src/turn-delete.mjs 的 DELETION_*） */
const DELETION_PROVIDER = 'dsh-agent-control';
const DELETION_MODEL = 'turn-delete';

// ---------------------------------------------------------------- 解压与解析

/** 按 zstd 魔数切帧，逐帧解压后拼接。见文件头注释：单帧解压会只拿到会话头。 */
export function decodeSessionLog(buf) {
  const offsets = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i);
  }
  if (offsets.length === 0) throw new Error('不是 zstd 流：找不到帧魔数 28 b5 2f fd');

  let text = '';
  let failedFrames = 0;
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      text += zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8');
    } catch {
      // 压缩块损坏、或魔数只是恰好出现在压缩数据里 —— 单个坏帧不该让整次诊断失败
      failedFrames++;
    }
  }
  return { text, frameCount: offsets.length, failedFrames };
}

/** 解析 JSONL；坏行单独计数，不让整次诊断失败（日志正在被追加时可能截断） */
export function parseEvents(text) {
  const events = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      badLines++;
    }
  }
  return { events, badLines };
}

export function isTombstone(event) {
  const source = event?.data?.message?.source;
  return source?.provider === TOMBSTONE_PROVIDER && source?.model === TOMBSTONE_MODEL;
}

/** 本插件写的删除事务的摘要事件 */
export function isDeletionSummary(event) {
  return event?.type === 'compaction/summary'
    && event.data?.provider === DELETION_PROVIDER && event.data?.model === DELETION_MODEL;
}

/**
 * 核对一笔删除事务是否完整、是否落在轮次之间（格式 v4 加载时独立压缩的前提）：
 * 同 id 的 compaction/start 在前且 turn 为 null、摘要之后紧跟 compact-checkpoint 替换、
 * 之后有不带 error 的 compaction/end。
 */
export function checkDeletion(summary, events, openTurnAt) {
  const id = summary.data?.compactionId;
  const issues = [];
  const start = events.find((e) => e.type === 'compaction/start' && e.data?.compactionId === id && e.seq < summary.seq);
  if (!start) issues.push('缺少同 id 的 compaction/start');
  else {
    if (start.data?.turn !== null) issues.push(`compaction/start 的 turn 应为 null，实际 ${JSON.stringify(start.data?.turn)}`);
    if (openTurnAt.get(start.seq) !== null) issues.push(`写入时第 ${openTurnAt.get(start.seq)} 轮正在进行（独立压缩只能落在轮次之间）`);
  }
  const replacement = events[summary.seq + 1];
  if (replacement?.type !== 'user/message' || replacement.data?.source?.kind !== 'compact-checkpoint' || replacement.data?.source?.compactionId !== id) {
    issues.push('摘要之后没有紧跟同 id 的 compact-checkpoint 替换');
  }
  const end = events.find((e) => e.type === 'compaction/end' && e.data?.compactionId === id && e.seq > summary.seq);
  if (!end) issues.push('缺少 compaction/end（压缩锁没有释放）');
  else if (end.data?.error !== undefined) issues.push(`compaction/end 带 error：${end.data.error}`);
  return { ok: issues.length === 0, issues };
}

/**
 * 复刻内核的 surface 代数：`append` 进面，`replace` 把区间移出面。
 * 这是**独立重算**，不是读内核的结果 —— 两者不一致就说明我们对契约的理解错了。
 */
export function computeSurface(events) {
  // 按**位置**折叠，与内核一致：replace 把 startSeq..endSeq 这段**节点**（不是数值区间）换成替换事件自己。
  // 早期版本按数值区间删 seq，会把区间里的非 surface 事件也算成「被遮蔽」，还漏掉替换节点本身。
  let nodes = [];
  const replacements = [];
  const malformed = [];
  for (const event of events) {
    const op = event.surfaceOp;
    if (op === 'append') {
      nodes.push(event.seq);
    } else if (op && typeof op === 'object' && op.op === 'replace') {
      const from = nodes.indexOf(op.startSeq);
      const to = nodes.indexOf(op.endSeq);
      if (typeof op.startSeq !== 'number' || typeof op.endSeq !== 'number' || from < 0 || to < from) {
        malformed.push({ seq: event.seq, op });
        continue;
      }
      const shadowed = nodes.slice(from, to + 1);
      nodes = [...nodes.slice(0, from), event.seq, ...nodes.slice(to + 1)];
      replacements.push({ tombstoneSeq: event.seq, turn: event.data?.turn, startSeq: op.startSeq, endSeq: op.endSeq, shadowed });
    }
  }
  return { visible: new Set(nodes), replacements, malformed };
}

/** 墓碑的形状核对 —— 每一条都对应真机踩过的坑（AGENTS.md 第 4 节 ①⑧） */
export function checkTombstoneShape(event) {
  const message = event?.data?.message ?? {};
  const op = event?.surfaceOp;
  const issues = [];
  if (typeof message.id !== 'string' || message.id.length === 0) issues.push('id 不是非空字符串（坑 ⑧：会让整轮失败）');
  if (message.role !== 'system') issues.push(`role 应为 system，实际 ${JSON.stringify(message.role)}`);
  if (!Array.isArray(message.content) || message.content.length !== 0) issues.push('content 应为空数组（非空会投影成一条真消息）');
  if (event.type !== 'system/message') issues.push(`事件类型应为 system/message，实际 ${JSON.stringify(event.type)}`);
  if (!op || typeof op !== 'object' || op.op !== 'replace') issues.push('surfaceOp 应为 { op: "replace" }');
  else {
    const keys = Object.keys(op).sort().join(',');
    if (keys !== 'endSeq,op,startSeq') issues.push(`surfaceOp 的键应为 op/startSeq/endSeq（坑 ① 的旧形状是 start/end），实际 ${keys}`);
  }
  const cite = event.sourceEventSeqs;
  if (cite !== undefined && event.type !== 'system/message') issues.push('只有 surface 事件类型能携带 sourceEventSeqs');
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------- 读日志

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 靠遍历现查会话目录：id 有两种拼写（`<id>` 与 `session-<id>`），两种都查；slug 规则不要自己推导 */
export function resolveSessionLog(target) {
  if (existsSync(target) && statSync(target).isFile()) return resolve(target);

  const id = String(target);
  if (id.includes('..') || /[\\/]/.test(id)) throw new Error(`拒绝疑似路径的会话 id：${id}`);

  const root = join(dshHome(), 'sessions');
  if (!existsSync(root)) throw new Error(`找不到会话根目录：${root}`);
  const names = id.startsWith('session-') ? [id, id.slice('session-'.length)] : [id, `session-${id}`];
  const hits = [];
  for (const slug of readdirSync(root)) {
    for (const name of names) {
      const candidate = join(root, slug, name, LOG_BASENAME);
      if (existsSync(candidate)) hits.push(candidate);
    }
  }
  if (hits.length === 0) throw new Error(`在 ${root} 下找不到会话 ${id} 的日志`);
  if (hits.length > 1) throw new Error(`会话 ${id} 在多个 slug 下都有日志，请直接给路径：\n  ${hits.join('\n  ')}`);
  return hits[0];
}

// ---------------------------------------------------------------- 报告

const fmtTime = (t) => (typeof t === 'number' ? new Date(t).toLocaleString('sv-SE') : '—');

/** 只用于**读**日志的诊断工具：预览内容是为了证明「删掉的还在」，不是为了展示 */
function previewOf(event) {
  const data = event?.data ?? {};
  let text = '';
  if (event.type === 'user/message') text = (data.content ?? []).map((c) => c.text ?? '').join(' ');
  else if (event.type === 'assistant/message') {
    text = ((data.message?.content) ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
  } else return '';
  return text.replace(/\s+/g, ' ').trim();
}

export function inspect(logPath, { preview = true } = {}) {
  const buf = readFileSync(logPath);
  const { text, frameCount, failedFrames } = decodeSessionLog(buf);
  const { events, badLines } = parseEvents(text);
  const header = events.find((e) => e.type === 'session' && typeof e.seq !== 'number');
  const seqEvents = events.filter((e) => typeof e.seq === 'number');
  const { visible, replacements, malformed } = computeSurface(seqEvents);

  // 坑 ⑪：格式 v4 加载时要求 system/message 落在打开的 turn/step 里且编号一致。
  // 运行中的内核 append 时不查这条，所以「当下正常、重启后整个会话打不开」——这里独立复算一次。
  const openAt = new Map();
  {
    let turn = null;
    let step = null;
    for (const event of seqEvents) {
      if (event.type === 'turn/start') { turn = event.data?.turn ?? null; step = null; }
      else if (event.type === 'turn/end') { turn = null; step = null; }
      else if (event.type === 'step/start') step = event.data?.step ?? null;
      else if (event.type === 'step/end') step = null;
      openAt.set(event.seq, { turn, step });
    }
  }
  const openTurnAt = new Map();
  {
    let turn = null;
    for (const event of seqEvents) {
      if (event.type === 'turn/start') turn = event.data?.turn ?? null;
      else if (event.type === 'turn/end') turn = null;
      openTurnAt.set(event.seq, turn);
    }
  }
  const deletions = seqEvents.filter(isDeletionSummary).map((event) => ({
    seq: event.seq,
    compactionId: event.data?.compactionId,
    time: event.time,
    shadowedSeqs: event.data?.shadowedSeqs,
    shadowedTokenCount: event.data?.shadowedTokenCount,
    check: checkDeletion(event, seqEvents, openTurnAt),
  }));
  const tombstones = seqEvents.filter(isTombstone).map((event) => {
    const open = openAt.get(event.seq) ?? { turn: null, step: null };
    return {
      seq: event.seq,
      turn: event.data?.turn,
      time: event.time,
      surfaceOp: event.surfaceOp,
      sourceEventSeqs: event.sourceEventSeqs,
      shape: checkTombstoneShape(event),
      loadable: open.turn !== null && open.step !== null && open.turn === event.data?.turn && open.step === event.data?.step,
      openTurn: open.turn,
      openStep: open.step,
    };
  });

  // 被遮蔽的事件仍留在日志里 —— 这是「轮次删除不是安全删除」的直接证据
  const masked = [];
  for (const r of replacements) {
    for (const seq of r.shadowed) {
      const event = seqEvents.find((e) => e.seq === seq);
      if (event === undefined) continue;
      const text2 = previewOf(event);
      masked.push({ seq, turn: r.turn, type: event.type, text: preview ? text2.slice(0, 80) : '' });
    }
  }

  const turns = new Map();
  for (const event of seqEvents) {
    const turn = event.data?.turn;
    if (typeof turn !== 'number') continue;
    if (!turns.has(turn)) turns.set(turn, []);
    turns.get(turn).push(event.seq);
  }
  const turnRows = [...turns.entries()].sort((a, b) => a[0] - b[0]).map(([turn, seqs]) => ({
    turn,
    first: Math.min(...seqs),
    last: Math.max(...seqs),
    total: seqs.length,
    visible: seqs.filter((s) => visible.has(s)).length,
  }));

  return {
    logPath,
    bytes: buf.length,
    frameCount,
    failedFrames,
    badLines,
    header: header ? { id: header.id, version: header.version, cwd: header.cwd, createdAt: header.createdAt } : null,
    counts: {
      events: seqEvents.length,
      maxSeq: seqEvents.length ? Math.max(...seqEvents.map((e) => e.seq)) : -1,
      visible: visible.size,
      tombstones: tombstones.length,
      deletions: deletions.length,
      maskedEvents: masked.length,
    },
    visibleSeqs: [...visible].sort((a, b) => a - b),
    deletions,
    tombstones,
    replacements,
    malformed,
    masked,
    turnRows,
  };
}

export function formatReport(r) {
  const L = [];
  L.push('=== 会话日志诊断 ===');
  L.push(`日志: ${r.logPath}`);
  L.push(`文件 ${r.bytes} 字节 | zstd 帧 ${r.frameCount} 个（坏帧 ${r.failedFrames}）| 解析失败行 ${r.badLines}`);
  if (r.header) {
    L.push(`会话: ${r.header.id}  version=${r.header.version}  创建 ${fmtTime(r.header.createdAt)}`);
    L.push(`工作目录: ${r.header.cwd}`);
  } else {
    L.push('⚠️ 没找到会话头（这个日志可能不是 v4 会话日志）');
  }
  L.push(`事件 ${r.counts.events} 条（seq 0..${r.counts.maxSeq}）| 表面可见 ${r.counts.visible} 条 | 删除事务 ${r.counts.deletions} 笔 | 旧墓碑 ${r.counts.tombstones} 条`);

  L.push('');
  L.push('=== 删除事务（compaction/summary，provider=dsh-agent-control / model=turn-delete）===');
  if (r.deletions.length === 0) L.push('  （无）');
  for (const d of r.deletions) {
    const seqs = d.shadowedSeqs ?? [];
    L.push(`  seq=${String(d.seq).padStart(4)}  遮蔽 ${seqs.length} 个节点（${seqs[0]}..${seqs.at(-1)}）  影子价格 ${d.shadowedTokenCount}  写入于 ${fmtTime(d.time)}`);
    L.push(`        事务检查: ${d.check.ok ? '✅ 完整，落在轮次之间' : '❌ ' + d.check.issues.join('；')}`);
  }

  L.push('');
  L.push('=== 旧墓碑（v1.0.0 写法，只认 provider=dsh-agent-control / model=turn-tombstone）===');
  if (r.tombstones.length === 0) L.push('  （无：这个会话没被本插件删过轮次）');
  for (const t of r.tombstones) {
    const op = t.surfaceOp ?? {};
    L.push(`  seq=${String(t.seq).padStart(4)}  遮蔽 turn=${t.turn}  区间 ${op.startSeq}..${op.endSeq}  写入于 ${fmtTime(t.time)}`);
    L.push(`        surfaceOp 键=[${Object.keys(op).join(',')}]  sourceEventSeqs=${JSON.stringify(t.sourceEventSeqs)}`);
    L.push(`        形状检查: ${t.shape.ok ? '✅ 合规' : '❌ ' + t.shape.issues.join('；')}`);
    L.push(t.loadable
      ? '        加载检查: ✅ 落在打开的 turn/step 里'
      : `        加载检查: ❌ 不在打开的 turn/step 里（当时 turn=${t.openTurn} step=${t.openStep}）——格式 v4 加载时会报 system/message does not match an open turn and step，整个会话打不开（坑 ⑪）`);
  }
  for (const m of r.malformed) L.push(`  ⚠️ seq=${m.seq} 的 surfaceOp 形状不认识（不是 append 也不是合规 replace）：${JSON.stringify(m.op)}`);

  L.push('');
  L.push('=== 逐轮对照（磁盘 vs 模型可见）===');
  if (r.turnRows.length === 0) L.push('  （事件里没有带 turn 的行）');
  for (const t of r.turnRows) {
    const mark = t.visible === 0 ? '已删' : t.visible === t.total ? '完好' : '部分可见';
    L.push(`  turn ${String(t.turn).padStart(2)}: 磁盘 seq ${t.first}..${t.last}（${t.total} 条）| 表面可见 ${t.visible} 条 → ${mark}`);
  }

  L.push('');
  L.push('=== 模型看不到、但**仍然存在**的内容 ===');
  if (r.masked.length === 0) L.push('  （无）');
  for (const m of r.masked) {
    L.push(`  seq=${String(m.seq).padStart(4)} turn=${m.turn} ${m.type.padEnd(17)} ${m.text || '(无文本预览)'}`);
  }

  L.push('');
  L.push('=== 结论 ===');
  L.push(`  磁盘上共 ${r.counts.events} 条事件，模型可见面上只有 ${r.counts.visible} 条。`);
  if (r.counts.tombstones > 0 || r.counts.deletions > 0) {
    L.push(`  ⚠️ 被遮蔽的 ${r.counts.maskedEvents} 条事件**完整留在日志里** —— 轮次删除是「不进上下文」，`);
    L.push('     不是安全删除。拿到这个日志文件就能还原被删内容。');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  const asJson = argv.includes('--json');
  const target = argv.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('用法: node test/log-inspect.mjs <会话 id | session.v4.jsonl.zstd 的路径> [--json]');
    console.error(`默认在 ${join(dshHome(), 'sessions')} 下按 id 现查（id 两种拼写都认）。`);
    process.exit(2);
  }
  try {
    const result = inspect(resolveSessionLog(target));
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else console.log(formatReport(result));
  } catch (error) {
    console.error(`诊断失败: ${error.message}`);
    process.exit(1);
  }
}

// 仅在被当作脚本直接运行时才走 CLI（被 import 时不执行）。
// 用 pathToFileURL 而不是手拼路径：Windows 下 argv[1] 是 `D:\…`，而 import.meta.url 里是
// `file:///D:/…`，手动比较分隔符与盘符大小写很容易「看起来对、其实永远不相等」。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2));
}
