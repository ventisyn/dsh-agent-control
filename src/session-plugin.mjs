/**
 * `agent-control-session` 行：只装「会话」组件（列会话 + 删会话 + 幽灵清理 + 只读探针）。
 *
 * 这一行可以**单独存在**，不依赖主入口（`src/index.mjs`）：它 import 的是
 * `./host-wiring.mjs` 里那份唯一的接线实现，与主入口用的是同一份代码，不会出现两份漂移的注册。
 * 插件列表里关掉这一行 = 这个组件下线（loader 不会 apply 这一行）——所以主入口见到这一行存在时
 * 不会再代装它（见 `hasOwnRow`），否则开关不起作用。
 */
import { FEATURES } from './shared.mjs'
import { applySessionFeature, featureDisabled } from './host-wiring.mjs'

/** loader 里这一行的模块名（与 `cordis.patch.yml` 那一行的 `name:` 一致）。 */
export const name = FEATURES.session.plugin

/** 只有 `webServer` 是硬的：没有它就等于没法把能力给到界面。 */
export const hostInject = ['webServer']

/** 兼容 cordis 的约定名（插件工厂按 `inject` 读取）。 */
export const inject = hostInject

/**
 * 插件入口。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {{ enabled?: unknown }} [config] - 这一行的 `config:`。**只有明确的 `false` 才算关掉**
 *   （缺省 = 开）：写错一个词就静默关掉一个组件，比多装一个组件糟糕得多。
 * @param {{ stopTimeoutMs?: number }} [host] - 副作用注入（离线测试把停 agent 的超时压小）。
 * @returns {void}
 */
export function apply(ctx, config, host) {
  // 关掉的组件**什么都不做**：不注册路由、不订阅事件、也不抛错（关掉一个组件不该让实例起不来）。
  if (featureDisabled(config)) return
  applySessionFeature(ctx, host)
}
