/**
 * `agent-control-notify` 行：只装「任务完成提醒」这一个浏览器端功能（说完一轮时响一声提示音）。
 *
 * **host 端只有一条只读探针**：音效与音量都用 Web Audio 在浏览器里现场合成，这一行不注册 POST 路由、
 * 也不注册模型工具。探针的作用只是让客户端在挂载时判断这一行开没开——关掉这一行时路由不存在，
 * 界面于是不订阅完成事件（与另外几个组件同一套机制）。
 *
 * 与 `agent-control-cost` 行是**两个独立开关**：只想要铃声、不想要花费显示（或反过来）时，
 * 关掉另一行即可。两行共用 `./host-wiring.mjs` 里那一份接线实现。
 *
 * 这一行同样声明 `inject` 本体服务，所以「主行总闸」对它有效：主行被关掉时它停在 pending。
 */
import { CORE_SERVICE, FEATURES } from './shared.mjs'
import { applyNotifyFeature, featureDisabled } from './host-wiring.mjs'

/** loader 里这一行的模块名（与 `cordis.patch.yml` 那一行的 `name:` 一致）。 */
export const name = FEATURES.notify.plugin

/**
 * 依赖：`webServer` 用于注册路由，`${CORE_SERVICE}` 是**主行提供的本体服务**。
 *
 * 后者的语义是「本体不在，组件就不装配」：主行被关掉时这个服务不存在，cordis 不会调用
 * 本行的 `apply`，fiber 停在 pending——宿主自己的 inventory 会把它报成未运行，界面不撒谎。
 */
export const hostInject = ['webServer', CORE_SERVICE]

/** 兼容 cordis 的约定名（插件工厂按 `inject` 读取）。 */
export const inject = hostInject

/**
 * 插件入口。
 *
 * @param {any} ctx - cordis 上下文。
 * @param {{ enabled?: unknown }} [config] - 这一行的 `config:`；只有明确的 `false` 才算关掉。
 * @param {any} [host] - 副作用注入（这一组没有可注入的副作用，保留参数以保持一致）。
 * @returns {void}
 */
export function apply(ctx, config, host) {
  if (featureDisabled(config)) return
  applyNotifyFeature(ctx, host)
}
