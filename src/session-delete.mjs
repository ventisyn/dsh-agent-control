/**
 * 会话删除：把一次删除拆成「磁盘目录」「内存 store」「工作区记账」三段，
 * 每段单独成功、单独失败、单独回报。
 *
 * 为什么不是三段合一：DSH 没有公开的「删除会话」API（见 AGENTS.md 3.1）。
 * 可用的只有 `enter(session)` 返回的 detach disposer（服务语义上的摘除）、
 * 会话目录的直接删除，以及工作区注册表上的 detach。三者由不同服务管，
 * 任何一段失败都不能让另外两段假装成功——所以本模块只汇报事实，不做总判定。
 *
 * 本文件不 import cordis，也不 import 任何 @deepseek-ai/* 包（只用 Node 内置的 fs / path / zlib）：
 * 全部外部能力由调用方注入，这样离线测试可以用假对象驱动真正的删除序列。
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
// 命名空间导入：老版本 Node 没有 zstd，具名导入会在链接期就让整个模块加载失败。
import * as zlib from 'node:zlib'

import { ERROR_CODES, ControlError, sessionDirNames } from './shared.mjs'

/** zstd 帧魔数（会话日志是多帧拼接的 zstd）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 读会话头时最多读多少字节：会话头那一帧只有几百字节。 */
const HEADER_PROBE_BYTES = 64 * 1024

/** 停 agent 的默认等待上限（毫秒）。超时后不再硬删。 */
export const DEFAULT_STOP_TIMEOUT_MS = 15000

/**
 * 在 `$DSH_HOME/sessions/<slug>/` 下找出属于某个会话的所有目录。
 *
 * `<slug>` 是工作区路径的转义形式，规则会随版本变化，所以这里**遍历**而不是推导。
 * 每个候选拼写都要查：裸 UUID 与 `session-<UUID>` 在磁盘上并存。
 *
 * @param {string} sessionsRoot - `$DSH_HOME/sessions`。
 * @param {string} sessionId - 会话 id。
 * @returns {string[]} 命中的目录绝对路径（去重、已排序，便于稳定测试）。
 */
export function findSessionDirs(sessionsRoot, sessionId) {
  const names = sessionDirNames(sessionId)
  if (names.length === 0 || !existsSync(sessionsRoot)) return []
  const found = new Set()
  let slugs
  try {
    slugs = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    for (const name of names) {
      const candidate = path.join(sessionsRoot, slug.name, name)
      if (isDirectory(candidate)) found.add(candidate)
    }
  }
  return [...found].sort()
}

/**
 * 递归强制删除给定目录（不存在则视为已删）。
 *
 * @param {string[]} dirs - 目录绝对路径。
 * @returns {string[]} 实际删除的目录。
 */
export function removeSessionDirs(dirs) {
  const removed = []
  for (const dir of dirs) {
    if (!isDirectory(dir)) continue
    rmSync(dir, { recursive: true, force: true })
    removed.push(dir)
  }
  return removed
}

/**
 * 停掉正在跑这个会话的 agent，等它真正静默。
 *
 * 等待超时**不**继续删：会话还在写的时候删目录，留下的是「目录没了但状态还在」的
 * 半删除现场，比拒绝一次操作糟得多。
 *
 * @param {{ get(id: string): unknown }} [agents] - `ctx.agents` 注册表。
 * @param {string} sessionId - 会话 id。
 * @param {number} [timeoutMs] - 等待上限。
 * @returns {Promise<{ stopped: boolean, timedOut: boolean, waited: boolean }>} 停与等的实际结果。
 * @throws {ControlError} 等待超时抛 AGENT_BUSY。
 */
export async function stopAgentIfRunning(agents, sessionId, timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  // 两种拼写都查：agent 注册表里的 id 拼写不一定与请求一致。
  const agent = findAgent(agents, sessionId)
  if (agent === undefined || agent === null) return { stopped: false, timedOut: false, waited: false }
  if (agent.status !== 'running') return { stopped: false, timedOut: false, waited: false }
  if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' })
  if (typeof agent.whenIdle !== 'function') return { stopped: true, timedOut: false, waited: false }
  const idle = await settleWithin(agent.whenIdle(), timeoutMs)
  if (!idle) {
    throw new ControlError(
      ERROR_CODES.agentBusy,
      `会话 ${sessionId} 的 agent 在 ${timeoutMs}ms 内没有停止，已放弃删除`,
    )
  }
  return { stopped: true, timedOut: false, waited: true }
}

/**
 * 把会话从工作区记账里摘掉。
 *
 * 走公开的 `ctx.workspaceRegistry.list()` 与 `Workspace.detachSession()`；
 * 归档/置顶集合按 id 逐个清理。注册表不存在（terminal-only profile）时返回
 * `available: false`，调用方据此把这段标记为「未执行」，而不是「已清理」。
 *
 * ⚠️ 记账里的拼写不一定与请求一致（`session-<id>` 与 `<id>` 并存），两种都要认，
 * 并且用**记账里那一种**去解除——只认一种时记账会悄悄留下，而且不进任何 warning。
 *
 * @param {{ list(): Array<{ id: string, sessionIds: readonly string[], detachSession(id: string): Promise<void> }>, archivedSessionIds?: readonly string[], pinnedSessionIds?: readonly string[], unarchiveSession?(id: string): Promise<void>, unpinSession?(id: string): Promise<void> }} [registry] - `ctx.workspaceRegistry`。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<{ available: boolean, detached: boolean, unarchived: boolean, unpinned: boolean, failures: string[], warnings: string[] }>} 逐项结果。
 */
export async function detachFromWorkspaces(registry, sessionId) {
  const result = {
    available: false,
    detached: false,
    unarchived: false,
    unpinned: false,
    failures: [],
    warnings: [],
  }
  if (registry === undefined || registry === null || typeof registry.list !== 'function') {
    result.warnings.push('工作区注册表不可用，工作区记账未清理')
    return result
  }
  result.available = true
  const names = sessionDirNames(sessionId)
  for (const workspace of safeList(registry, result)) {
    if (!Array.isArray(workspace?.sessionIds)) continue
    for (const name of names.filter((candidate) => workspace.sessionIds.includes(candidate))) {
      try {
        await workspace.detachSession(name)
        result.detached = true
      } catch (error) {
        result.failures.push(`工作区 ${workspace.id} 的会话记账未解除：${messageOf(error)}`)
      }
    }
  }
  for (const name of names) {
    if (registry.archivedSessionIds?.includes(name) !== true) continue
    try {
      await registry.unarchiveSession(name)
      result.unarchived = true
    } catch (error) {
      result.failures.push(`归档集合未清理：${messageOf(error)}`)
    }
  }
  for (const name of names) {
    if (registry.pinnedSessionIds?.includes(name) !== true) continue
    try {
      await registry.unpinSession(name)
      result.unpinned = true
    } catch (error) {
      result.failures.push(`置顶集合未清理：${messageOf(error)}`)
    }
  }
  if (!result.detached && result.failures.length === 0) {
    result.warnings.push('工作区记账里没有找到这个会话，记账没有变动')
  }
  return result
}

/**
 * 删除一个会话，**不留残留**：拒绝活会话 → 找出子代理后代 → 停 agent → 删目录 → 清记账 → 清投影缓存。
 *
 * 一个会话在 DSH 里散落在这些地方（0.2.0-rc.2 实测）：
 *   - `$DSH_HOME/sessions/<slug>/<id>/`：会话日志目录（两种 id 拼写）；
 *   - 工作区记账：工作区的会话列表、归档集合、置顶集合；
 *   - 投影缓存 `session_projcache` 域的 `sessions` 表（磁盘上是 `storages/session_projcache/sessions/<id>.json`）；
 *   - **子代理会话**：它派生的子代理各自是一个独立会话（会话头 `origin: 'subagent'`、
 *     `parentSession` 指向它），有自己的目录与缓存。不一起删，它们就成了没人认领的孤儿。
 * 前三项随目标一起清；子代理后代递归地按同样流程清。**fork 出来的会话不是后代**——它是独立对话，不动。
 *
 * **为什么拒绝活会话**：把已进入 store 的会话摘出去，唯一公开途径是 `sessions.enter()`
 * 返回的 detach disposer，而那个 disposer 只交给创建者（agent 工厂持有，见
 * `AgentRegistry.create` 的「disposer is a CAPABILITY」）。插件拿不到它，
 * `detachEntered` 又是 private。所以对活着的会话，我们**无法**把内存里的条目摘掉——
 * 此时若还是把磁盘目录删了，就会留下「目录没了但会话仍在列表里」的半删除现场，
 * 比直接拒绝糟得多。**子代理后代里只要有一个活着，整次删除都拒绝**，一个字都不动。
 *
 * ⚠️ **切走并不会让会话下线**（0.2.0-rc.2 真机实测）：Web 端的 session controller 打开会话时
 * 持有 agent handle，之后既没有空闲回收也没有关闭入口，会话会一直驻留到 `dsh web` 退出。
 * 所以「活会话」实际等于「本次启动后打开过的会话」，唯一的出路是重启后不打开它、直接删除。
 * 提示文案必须照实说，不能再叫用户「先切走」。
 *
 * 顺序是刻意的：**没删净就绝不解除工作区记账、也不清缓存**——否则会话会以半删除状态掉进「未分组」。
 * 同理，**磁盘上根本没有目录时什么都不做**（不停 agent、不动记账），直接报 TARGET_NOT_FOUND。
 *
 * @param {object} deps - 注入的依赖（见各字段）。
 * @param {string} deps.sessionsRoot - `$DSH_HOME/sessions`。
 * @param {{ get(id: string): unknown }} [deps.agents] - `ctx.agents`。
 * @param {boolean} [deps.live] - 目标是否仍活在本进程的 store 里（旧接口，只管目标本身）。
 * @param {(sessionId: string) => boolean} [deps.isLive] - 任一会话是否活着（两种拼写由调用方处理）；
 *   提供时目标与每个子代理后代都用它判断。
 * @param {object} [deps.workspaceRegistry] - `ctx.workspaceRegistry`。
 * @param {{ delete(key: string): Promise<boolean> }} [deps.projectionCache] - 投影缓存域的 `sessions` 表。
 * @param {number} [deps.stopTimeoutMs] - 停 agent 的等待上限。
 * @returns {Promise<object>} 逐段结果：`dirs` / `removed`（含后代）、`descendants`、`detached`（等于 `workspace.detached`）、
 *   `stopped`、`workspace`、`projectionCache`、`warnings`。
 * @throws {ControlError} 目标或其后代是活会话、agent 停不下来、目标不存在、或目录删不净时抛出。
 */
export async function deleteSession(deps, sessionId) {
  const { sessionsRoot, agents, workspaceRegistry, projectionCache, stopTimeoutMs } = deps
  const isLive = typeof deps.isLive === 'function'
    ? (id) => deps.isLive(id) === true
    : (id) => id === sessionId && deps.live === true

  if (isLive(sessionId)) {
    throw new ControlError(ERROR_CODES.sessionLive, liveMessage(sessionId))
  }

  const rootDirs = findSessionDirs(sessionsRoot, sessionId)
  if (rootDirs.length === 0) {
    throw new ControlError(ERROR_CODES.targetNotFound, `找不到会话 ${sessionId}`)
  }

  // 子代理后代：在动任何东西之前算出来，并且逐个过活会话闸门。
  const lineage = findSubagentDescendants(sessionsRoot, sessionId)
  const liveDescendant = lineage.descendants.find((id) => isLive(id))
  if (liveDescendant !== undefined) {
    throw new ControlError(
      ERROR_CODES.sessionLive,
      `它派生的子代理会话 ${liveDescendant} 还驻留在内存里，整次删除已放弃、什么都没动。${liveMessage(liveDescendant)}`,
      { detail: { liveDescendant } },
    )
  }

  const targets = [sessionId, ...lineage.descendants]
  const timeout = stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  let stopped = false
  for (const id of targets) {
    const stop = await stopAgentIfRunning(agents, id, timeout)
    stopped = stopped || stop.stopped
  }

  const before = [...new Set(targets.flatMap((id) => findSessionDirs(sessionsRoot, id)))].sort()
  const removed = removeSessionDirs(before)

  // 自己的 dispose 路径可能重建目录；再删一次并确认删净。
  const leftover = targets.flatMap((id) => findSessionDirs(sessionsRoot, id))
  if (leftover.length > 0) removeSessionDirs(leftover)
  const remaining = targets.flatMap((id) => findSessionDirs(sessionsRoot, id))
  if (remaining.length > 0) {
    throw new ControlError(
      ERROR_CODES.deleteFailed,
      `会话 ${sessionId} 的目录没有删净，工作区记账与投影缓存已保留：${remaining.join('、')}`,
      { detail: { leftover: remaining } },
    )
  }

  if (!rootDirs.some((dir) => removed.includes(dir))) {
    // 查到过目录、删的时候却已经不在了（被别人抢先删掉）：同样不动记账。
    throw new ControlError(ERROR_CODES.targetNotFound, `找不到会话 ${sessionId}`)
  }

  const workspace = await detachFromWorkspaces(workspaceRegistry, sessionId)
  for (const id of lineage.descendants) {
    // 子代理通常不在任何工作区里，没找到是常态，不进 warning；真正的失败照报。
    const child = await detachFromWorkspaces(workspaceRegistry, id)
    workspace.failures.push(...child.failures)
    workspace.unarchived = workspace.unarchived || child.unarchived
    workspace.unpinned = workspace.unpinned || child.unpinned
  }

  const cache = await removeProjectionCache(projectionCache, targets)

  const warnings = [...lineage.warnings, ...cache.warnings]
  return {
    sessionId,
    dirs: before,
    removed,
    descendants: lineage.descendants,
    detached: workspace.detached,
    stopped,
    workspace,
    projectionCache: cache,
    warnings,
  }
}

/** SESSION_LIVE 的统一说法：切走没用，只能重启后不打开它再删。 */
function liveMessage(sessionId) {
  return `会话 ${sessionId} 在本次启动后打开过，仍驻留在内存里，无法删除：切换到别的会话不会释放它（DSH 没有卸载会话的公开接口）。请重启 dsh web，重启后不要打开它，直接删除`
}

/**
 * 从投影缓存里删掉一组会话的记录（两种 id 拼写都删）。
 *
 * 走 storage domain 的公开表接口 `KvTable.delete`：它同时更新域的内存表与磁盘文档，
 * 不会出现「文件删了、内存里还有、下次写回来」的情况。直接删 json 文件就会撞上这个。
 *
 * @param {{ delete(key: string): Promise<boolean> } | undefined} table - `session_projcache` 域的 `sessions` 表。
 * @param {string[]} sessionIds - 要清的会话。
 * @returns {Promise<{ available: boolean, removed: string[], failures: string[], warnings: string[] }>} 结果。
 */
export async function removeProjectionCache(table, sessionIds) {
  const result = { available: false, removed: [], failures: [], warnings: [] }
  if (table === undefined || table === null || typeof table.delete !== 'function') {
    result.warnings.push('投影缓存服务不可用，缓存记录没有清理（不影响使用，但磁盘上会留下缓存文件）')
    return result
  }
  result.available = true
  for (const key of [...new Set(sessionIds.flatMap((id) => sessionDirNames(id)))]) {
    try {
      if (await table.delete(key)) result.removed.push(key)
    } catch (error) {
      result.failures.push(`投影缓存 ${key} 没有清掉：${messageOf(error)}`)
    }
  }
  result.warnings.push(...result.failures)
  return result
}

/**
 * 读会话日志的会话头（第一行）。
 *
 * 会话日志是多帧拼接的 zstd，**第一帧就是会话头**（约 250 字节）。只读文件开头一小段、
 * 切出第一帧解压，不必解整个日志。读不出来（不是 zstd、Node 没有 zstd、文件坏了）就返回 undefined。
 *
 * @param {string} dir - 会话目录。
 * @returns {Record<string, unknown> | undefined} 会话头。
 */
export function readSessionHeader(dir) {
  if (typeof zlib.zstdDecompressSync !== 'function') return undefined
  let file
  try {
    file = readdirSync(dir).find((name) => /^session\..*\.jsonl\.zstd$/.test(name))
  } catch {
    return undefined
  }
  if (file === undefined) return undefined
  let fd
  try {
    fd = openSync(path.join(dir, file), 'r')
    const chunk = Buffer.alloc(HEADER_PROBE_BYTES)
    const length = readSync(fd, chunk, 0, chunk.length, 0)
    const head = chunk.subarray(0, length)
    if (head.length < 4 || head.compare(ZSTD_MAGIC, 0, 4, 0, 4) !== 0) return undefined
    const next = head.indexOf(ZSTD_MAGIC, 4)
    const text = zlib.zstdDecompressSync(next === -1 ? head : head.subarray(0, next)).toString('utf8')
    const header = JSON.parse(text.split('\n')[0])
    return header !== null && typeof header === 'object' ? header : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * 找出某个会话派生的全部子代理会话（递归）。
 *
 * 只认会话头里 `origin === 'subagent'` 且 `parentSession` 指向它的会话；fork 是独立对话，不算。
 * `parentSession` 与目录名的拼写可能不同（实测：父会话头里是 `session-<uuid>`，子代理目录是裸 uuid），
 * 所以两边都归一后比较。
 *
 * @param {string} sessionsRoot - `$DSH_HOME/sessions`。
 * @param {string} sessionId - 根会话。
 * @returns {{ descendants: string[], warnings: string[] }} 后代 id（按目录名，广度优先）与说明。
 */
export function findSubagentDescendants(sessionsRoot, sessionId) {
  const children = new Map()
  let unreadable = 0
  for (const entry of listSessionDirs(sessionsRoot)) {
    const header = readSessionHeader(entry.dir)
    if (header === undefined) {
      unreadable += 1
      continue
    }
    if (header.origin !== 'subagent' || typeof header.parentSession !== 'string') continue
    const parent = normalizeSessionId(header.parentSession)
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(path.basename(entry.dir))
  }
  const descendants = []
  const seen = new Set([normalizeSessionId(sessionId)])
  const queue = [normalizeSessionId(sessionId)]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      const key = normalizeSessionId(child)
      if (seen.has(key)) continue
      seen.add(key)
      descendants.push(child)
      queue.push(key)
    }
  }
  const warnings = unreadable > 0
    ? [`有 ${unreadable} 个会话目录读不出会话头，没法判断它们是不是这个会话的子代理，没有动它们`]
    : []
  return { descendants, warnings }
}

/**
 * 列出可以管理的会话：活着的合并工作区记账，外加磁盘上只剩目录的残留。
 *
 * @param {object} deps - 注入的依赖。
 * @param {string} deps.sessionsRoot - `$DSH_HOME/sessions`。
 * @param {{ list(): Array<{ id: string, sessionIds: readonly string[] }> }} [deps.workspaceRegistry] - `ctx.workspaceRegistry`。
 * @param {Iterable<string>} [deps.liveSessionIds] - 内存 store 里活着的会话 id。
 * @returns {Array<{ sessionId: string, workspaceTitle: string | null, cwd: string | null, running: boolean, live: boolean, removable: boolean, reasons: string[] }>} 会话行。
 */
export function listSessions(deps) {
  const { sessionsRoot, workspaceRegistry, liveSessionIds } = deps
  const live = new Set(liveSessionIds ?? [])
  /** 两种拼写任一活着就算活着。 */
  const isLive = (sessionId) => sessionDirNames(sessionId).some((name) => live.has(name))
  /** @type {Map<string, { sessionId: string, workspaceTitle: string | null, cwd: string | null, running: boolean, live: boolean, removable: boolean, reasons: string[] }>} */
  const rows = new Map()

  const registry = workspaceRegistry
  if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
    for (const workspace of safeList(registry, undefined)) {
      for (const sessionId of workspace?.sessionIds ?? []) {
        const known = findRow(rows, sessionId)
        if (known !== undefined) {
          // 同一个会话在记账里出现两次（不同 slug）时只保留第一行，别把标题盖成 null。
          known.workspaceTitle ??= typeof workspace.title === 'string' ? workspace.title : null
          known.cwd ??= typeof workspace.path === 'string' ? workspace.path : null
          continue
        }
        upsert(rows, {
          sessionId,
          // 这是**工作区**的名字，不是会话标题（记账里拿不到会话标题），字段名要说实话。
          workspaceTitle: typeof workspace.title === 'string' ? workspace.title : null,
          cwd: typeof workspace.path === 'string' ? workspace.path : null,
          running: false,
          live: isLive(sessionId),
          removable: true,
          reasons: [],
        })
      }
    }
  }

  for (const dir of listSessionDirs(sessionsRoot)) {
    // **必须按两种拼写都查一次**：磁盘上是 `session-<uuid>`、记账里可能是裸 `<uuid>`
    // （或反过来），直接 `rows.has(dir.sessionId)` 会把同一个会话列成两行，
    // 还会给已有标题的那一行旁边多出一个「找不到记账」的孤儿行。
    const known = findRow(rows, dir.sessionId)
    if (known !== undefined) {
      known.live = known.live || isLive(dir.sessionId)
      continue
    }
    upsert(rows, {
      sessionId: dir.sessionId,
      workspaceTitle: null,
      cwd: null,
      running: false,
      // ⚠️ dir.sessionId 已去掉 `session-` 前缀，而 store 里活着的可能是带前缀的那一种。
      live: isLive(dir.sessionId),
      removable: true,
      reasons: dir.orphan ? ['磁盘上有目录，但工作区记账里已经没有它'] : [],
    })
  }

  return [...rows.values()]
}

/** 按两种 id 拼写查同一行：裸 UUID 与 `session-<UUID>` 指的是同一个会话。 */
function findRow(rows, sessionId) {
  const direct = rows.get(sessionId)
  if (direct !== undefined) return direct
  return rows.get(sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : `session-${sessionId}`)
}

/**
 * 枚举磁盘上的会话目录（去重到会话 id 一级）。
 *
 * @param {string} sessionsRoot - `$DSH_HOME/sessions`。
 * @returns {Array<{ sessionId: string, dir: string, orphan: boolean }>} 磁盘现状。
 */
export function listSessionDirs(sessionsRoot) {
  if (!existsSync(sessionsRoot)) return []
  let slugs
  try {
    slugs = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const seen = new Set()
  const out = []
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const slugDir = path.join(sessionsRoot, slug.name)
    let entries
    try {
      entries = readdirSync(slugDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionId = normalizeSessionId(entry.name)
      if (sessionId === '' || seen.has(sessionId)) continue
      seen.add(sessionId)
      out.push({ sessionId, dir: path.join(slugDir, entry.name), orphan: true })
    }
  }
  return out
}

/** @param {Map<string, any>} rows @param {any} row */
function upsert(rows, row) {
  const existing = rows.get(row.sessionId)
  if (existing === undefined) {
    rows.set(row.sessionId, row)
    return
  }
  // 记账与磁盘两侧都见过：以记账的标题为准，保留磁盘侧的理由。
  existing.workspaceTitle ??= row.workspaceTitle
  existing.cwd ??= row.cwd
  for (const reason of row.reasons) if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
}

/** 去掉 `session-` 前缀，让两种拼写归一到同一个 id。 */
function normalizeSessionId(name) {
  return name.startsWith('session-') ? name.slice('session-'.length) : name
}

/** 按两种拼写在 agent 注册表里找 agent。 */
function findAgent(agents, sessionId) {
  if (typeof agents?.get !== 'function') return undefined
  for (const name of sessionDirNames(sessionId)) {
    const agent = agents.get(name)
    if (agent !== undefined && agent !== null) return agent
  }
  return undefined
}

/** @param {any} registry @param {any} result */
function safeList(registry, result) {
  try {
    const list = registry.list()
    return Array.isArray(list) ? list : []
  } catch (error) {
    result?.failures?.push(`枚举工作区失败：${messageOf(error)}`)
    return []
  }
}

/** @param {string} target */
function isDirectory(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error && error.message ? error.message : String(error)
}

/**
 * await 一个 promise，但在超时后放弃等待（不取消原操作）。
 *
 * @template T
 * @param {Promise<T>} promise - 待等待的 promise。
 * @param {number} timeoutMs - 等待上限。
 * @returns {Promise<boolean>} 是否在上限内结束。
 */
async function settleWithin(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false
  let timer
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        if (typeof timer?.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
