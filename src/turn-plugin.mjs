/**
 * `agent-control-turn` 行：只装「轮次」组件（列已删轮次 + 删一轮 + 只读探针）。
 *
 * 与 session 行一样：可以单独存在，与主入口共用 `./host-wiring.mjs` 里那一份接线实现。
 */
import { FEATURES } from './shared.mjs'
import { applyTurnFeature, featureDisabled } from './host-wiring.mjs'

/** loader 里这一行的模块名（与 `cordis.patch.yml` 那一行的 `name:` 一致）。 */
export const name = FEATURES.turn.plugin

/** 只有 `webServer` 是硬的：没有它就等于没法把能力给到界面。 */
export const hostInject = ['webServer']

/** 兼容 cordis 的约定名（插件工厂按 `inject` 读取）。 */
export const inject = hostInject

/**
 * 插件入口。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {{ enabled?: unknown }} [config] - 这一行的 `config:`；只有明确的 `false` 才算关掉。
 * @param {any} [host] - 副作用注入（当前这一组没有可注入的副作用，保留参数以保持一致）。
 * @returns {void}
 */
export function apply(ctx, config, host) {
  if (featureDisabled(config)) return
  applyTurnFeature(ctx, host)
}
