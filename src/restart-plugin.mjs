/**
 * `agent-control-restart` 行：只装「热重启与关闭实例」组件。
 *
 * 这一份包含三条路由（`GET /restart/status`、`POST /restart`、`POST /shutdown`）、模型工具
 * `restart_harness`，以及新进程启动后的「续作投递」。它与 session / turn 行一样可以单独存在，
 * 与主入口共用 `./host-wiring.mjs` 里那一份接线实现。
 *
 * ⚠️ `GET /restart/status` 同时是辅助进程的就绪探针与客户端判断这个组件在不在的探针，所以它
 * 不做可信校验（只读、不改变状态，见 AGENTS.md 3.5）。
 */
import { FEATURES } from './shared.mjs'
import { applyRestartFeature, featureDisabled } from './host-wiring.mjs'

/** loader 里这一行的模块名（与 `cordis.patch.yml` 那一行的 `name:` 一致）。 */
export const name = FEATURES.restart.plugin

/** 只有 `webServer` 是硬的：没有它就等于没法把能力给到界面。 */
export const hostInject = ['webServer']

/** 兼容 cordis 的约定名（插件工厂按 `inject` 读取）。 */
export const inject = hostInject

/**
 * 插件入口。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {{ enabled?: unknown, approval?: unknown }} [config] - 这一行的 `config:`。`enabled: false`
 *   时整个组件下线（不注册路由、不注册工具、不安排续作投递）；`approval` 只在主入口那一行
 *   （`agent-control`）上配置，这一行通常没有 `config`。
 * @param {{ schedule?: (fn: () => void) => void, spawn?: Function, appExit?: Function, deferExit?: (fn: () => void) => void, dshHome?: string }} [host] -
 *   副作用注入（离线测试用；生产路径上是 `undefined`，重启用真实实现）。
 * @returns {void}
 */
export function apply(ctx, config, host) {
  if (featureDisabled(config)) return
  // 这一行自己的 `config`（通常只有 `approval`）；没写时由主行的配置兜底（见 host-wiring 的
  // `coreRowConfig`）——旧配置写在主行上，拆行之后不能静默失效。
  applyRestartFeature(ctx, { ...host, config })
}
