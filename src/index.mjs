/**
 * dsh-agent-control — host 端插件入口（core 行）。
 *
 * 「一行一个组件」：插件列表里本插件下有四行——这一行（core）+ 三个组件行
 * （`agent-control-session` / `agent-control-turn` / `agent-control-restart`，见
 * `cordis.patch.yml`）。这一行负责：
 *
 *   1. **客户端 bundle 的交付**（`dsh.client.platform = web` + `exports["./client"]` 是声明层；
 *      这一行保证插件装进来时界面入口就位）；
 *   2. **启动清理** `pruneOrphanArchives()`：删会话时留下的那条归档标记在实例重启后成了孤儿，
 *      这里把它收干净；
 *   3. **「按行构建各功能」的接线**：三个组件的接线都只有一份实现（`./host-wiring.mjs`），
 *      这一行在**那个组件没有自己那一行**时用它把组件装上——旧 profile 只有一行 `agent-control`
 *      时行为与以前完全一致（全部功能启用）；而某个组件行存在（哪怕被关掉）时由那一行说了算，
 *      否则插件列表里的开关不起作用（关掉的行 loader 根本不会 apply，见 `host-wiring.mjs` 的
 *      `hasOwnRow`）。子插件行调用的也是同一份接线，所以不存在两份会漂移的注册代码。
 *
 * 业务逻辑在 `./session-delete.mjs` / `./turn-delete.mjs` / `./restart*.mjs`（纯逻辑，可离线单测）；
 * 路由与错误映射在 `./host-wiring.mjs`（三个组件各一份）。**host 端不 import 任何
 * `@deepseek-ai/*`**：顶层 import 解析失败会让整个插件消失（AGENTS.md 3.7，细则见 docs/CONTRACT.md 第 3 节）。
 */
import { PLUGIN_NAME, sessionDirNames } from './shared.mjs'
import { listSessions } from './session-delete.mjs'
import {
  applyRestartFeature,
  applySessionFeature,
  applyTurnFeature,
  hasOwnRow,
  provideCoreService,
  rememberCoreRowConfig,
  sessionsRoot,
} from './host-wiring.mjs'

/** 插件名（cordis 行 id / loader id 都用它）。 */
export const name = PLUGIN_NAME

/**
 * 依赖声明。
 *
 * 只有 `webServer` 是硬的：没有它就等于没法把能力给到界面。其余服务按可用性探测，
 * 缺失时对应那一段能力降级为「未执行」并如实回报，而不是让整个插件起不来
 * （terminal-only profile 里本来就没有 workspaceRegistry）。
 *
 * 名字不叫 `inject`：客户端 bundle 也导出 `inject`，同名容易在排查时张冠李戴。
 */
export const hostInject = ['webServer']

/** 兼容 cordis 的约定名（插件工厂按 `inject` 读取）。 */
export const inject = hostInject

/**
 * 这一行（core）的入口：提供本体服务、把「没有自己那一行」的组件装上，然后做启动清理。
 *
 * **本体服务**（`agentControlCore`）是三个组件行 `inject` 的依赖，也是"总闸"：关掉本行，
 * 那三个 fiber 停在 pending，界面会如实显示它们未运行。
 *
 * 三个组件行的接线函数是**同一份实现**（`./host-wiring.mjs`）：
 *   - 组件有自己那一行 → 这里让开（由那一行负责；那一行被关掉时谁都不装，路由随之消失）；
 *   - 组件没有自己那一行（旧 profile / 手工删过 row）→ 这里代装，行为与以前一致。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {{ approval?: unknown }} [config] - 插件行的 `config:`（cordis 把 `cordis.patch.yml` 里那一行
 *   的 `config:` 作为第二个参数传进来）。只认 `approval: 'ask' | 'auto'`，未知值一律回退 `ask`
 *   （host 不 import schemastery，手工校验，见 restart-tool.mjs 的 `resolveApprovalMode`）。
 * @param {{ now?: () => number, schedule?: (fn: () => void) => void, spawn?: Function, appExit?: Function, deferExit?: (fn: () => void) => void, dshHome?: string, stopTimeoutMs?: number }} [host] -
 *   **副作用实现**，供离线测试注入。cordis 只传前两个参数，所以生产路径上这里是 `undefined`，
 *   重启用的是真实实现（`setTimeout` / `child_process.spawn` / `ctx.appExit`），关闭用的是
 *   1 秒的延迟 `setTimeout`。测试必须注入，否则会真的派生辅助进程并退出测试进程。
 * @returns {void}
 */
export function apply(ctx, config, host) {
  // 主行的配置要在装配组件**之前**记下：热重启那一行的 apply 会回退读它（拆行之后旧配置仍写在主行）。
  rememberCoreRowConfig(config)
  // 本体服务：三个组件行 `inject` 它，所以这一行是总闸——关掉本行，组件行拿不到服务、停在 pending，
  // 一个路由都不会注册（见 host-wiring.mjs 的 provideCoreService）。
  void provideCoreService(ctx)
  if (!hasOwnRow(ctx, 'session')) applySessionFeature(ctx, host)
  if (!hasOwnRow(ctx, 'turn')) applyTurnFeature(ctx, host)
  // 重启的接线要用插件行的 `config`（审批策略由它决定），所以把 config 一起交给它。
  // `fallbackConfig`：热重启那一行的 `approval` 没写时回退到主行的配置——用户升级前那份配置
  // 就写在主行上，拆行之后不能静默失效（见 restart-tool.mjs 的 resolveApprovalMode）。
  if (!hasOwnRow(ctx, 'restart')) {
    applyRestartFeature(ctx, host === undefined ? { config } : { ...host, config })
  }
  // 启动清理：删会话时留下的那条归档标记（用来把侧栏那行藏起来的）在实例重启后就成了一条孤儿——
  // 会话本身已经不在了。删标记是幂等的，服务还没就绪就先跳过、等服务出现再补一次。
  void pruneOrphanArchives(ctx).catch(() => {})
  ctx.inject?.(['workspaceRegistry'], () => { void pruneOrphanArchives(ctx).catch(() => {}) })
}

/** 会话日志根目录（与 host-wiring 共用同一份实现；这一行历史上从这里导出过，保留以免外部引用断掉）。 */
export { sessionsRoot }

/**
 * 清掉指向「已经不存在的会话」的归档标记，返回清掉的条数。
 *
 * 为什么会有这种孤儿：删除路由会把「本次启动后打开过」的目标先归档（`archiveForHiding`），借宿主的
 * 「从列表里藏起来」把内存里那条摘不掉的记录从侧栏压住。实例一重启，那条内存记录不复存在，标记就只剩
 * 一个指向已删会话的 id——留它没用，还让工作区记账里多一条查不到的记录，于是在启动时收干净。
 *
 * 判据刻意保守：**只有活着的、或磁盘上确实还有目录的**才算存在；拿不准就不动（宁留标记，不误删记账）。
 * 单个 id 清理失败只记日志，绝不影响插件加载。
 *
 * @param {any} ctx - cordis 上下文。
 * @returns {Promise<number>} 清掉的标记条数。
 */
export async function pruneOrphanArchives(ctx) {
  const registry = safeCall(() => ctx.get?.('workspaceRegistry'))
  const archived = registry?.archivedSessionIds
  if (!Array.isArray(archived) || archived.length === 0) return 0
  const live = safeCall(() => ctx.get?.('sessions')?.list()) ?? []
  const rows = safeCall(() => listSessions({
    sessionsRoot: sessionsRoot(),
    workspaceRegistry: registry,
    liveSessionIds: [...live].map((session) => session?.id).filter((id) => typeof id === 'string'),
  })) ?? []
  const known = new Set(rows.flatMap((row) => sessionDirNames(row?.sessionId ?? '')))
  // 内存里活着的也算「存在」：`listSessions` 把「活的 + 记账里的」并成一行，光活着、记账里没有的会话
  // 不一定出现在结果里——而那正是本功能最常见的形态（删的就是刚打开过的那个）。
  for (const session of live) {
    if (typeof session?.id === 'string') for (const name of sessionDirNames(session.id)) known.add(name)
  }
  let pruned = 0
  for (const id of archived) {
    if (sessionDirNames(id).some((name) => known.has(name))) continue
    try {
      await registry.unarchiveSession(id)
      pruned += 1
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN_NAME}: 清理归档标记失败（${id}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return pruned
}

/** 调一个可能不存在的服务方法，失败一律当作「拿不到」。 */
function safeCall(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}
