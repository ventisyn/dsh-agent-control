/**
 * 浏览器端 bundle 的离线测试。
 *
 * 目的不是渲染像素，而是抓住三类**上线后很难发现**的失败：
 *  1. factory 里 `require(...)` 解构出来的导出名不存在（真发生过：一个图标名不对，
 *     报错被槽位错误边界吞掉，界面上只是「什么都不出现」）；
 *  2. 组件在模块初始化阶段求值 hooks（`React.useState(...)` 写在 IIFE 顶层），
 *     整个 bundle 直接加载失败；
 *  3. 槽位注册形状不对（list 槽位缺 `id`），注册静默无效。
 *
 * 这里**真的执行 client.js**：桩掉 `window` 与 `MutationObserver`，`react` 用一个
 * 会记账的替身——每个组件都被实际调用一次，所以「组件里引用了不存在的东西」
 * 会当场抛出来。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

/** 记录 primitives 被解构了哪些导出，用来断言图标名确实存在。 */
const primitivesAccess = []
const requireCalls = []
/** 组件渲染期间记录的 hook 调用。 */
const hookCalls = []
/** 最近一次 useEffect 返回的清理函数。 */
let lastCleanup
/** 渲染期间派发的删除请求。 */
const dispatched = []
/** 派发过的事件类型（`dispatched` 只记 detail，重启事件没有 detail）。 */
const dispatchedTypes = []

const loaded = { id: undefined, apply: undefined, inject: undefined }

/**
 * 取 bundle 暴露的 `syncTurnRows`。
 *
 * 必须在 `load()` **之后**才读：bundle 是先调用 `window.__ModuleLoader__.load(...)`，
 * 再把自己的排障抓手挂到 window 上的，所以 `load()` 内部读不到。
 */
function syncTurnRows() {
  const expose = globalThis.window.__dshAgentControl
  assert.ok(expose, 'bundle 必须暴露排障抓手 window.__dshAgentControl')
  assert.equal(typeof expose.syncTurnRows, 'function', '抓手要提供 syncTurnRows 供排障与测试使用')
  return expose.syncTurnRows
}

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded.id = spec.id
      const exports = spec.factory(makeRequire())
      loaded.apply = exports.apply
      loaded.inject = exports.inject
    },
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent(event) {
    dispatched.push(event.detail)
    dispatchedTypes.push(event.type)
  },
  location: { reload() {} },
}

Object.defineProperty(globalThis, 'navigator', {
  value: { languages: ['zh-CN'], language: 'zh-CN' },
  configurable: true,
  writable: true,
})

globalThis.MutationObserver = class {
  observe() {}

  disconnect() {}
}
globalThis.CustomEvent = class {
  constructor(type, init) {
    this.type = type
    this.detail = init?.detail
  }
}
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, sessions: [], turns: [] }),
})

/** 记录每次 fetch 的 URL 与请求体，供「广播」「失效」这类测试断言。 */
const fetchLog = []

/** 记录 useRef 造出来的 ref 对象，测试可以往里塞假 DOM 节点。 */
const refRegistry = {
  created: [],
  /**
   * 在 `useRef` 返回**之前**调用的钩子。
   *
   * 组件里的隐藏逻辑是 `useEffect` 里读 `ref.current`，而 `useEffect` 紧接着 `useRef` 执行；
   * 等组件函数返回后再塞值就晚了（那次 effect 已经提前 return）。所以窗口就在这一刻。
   */
  onNext: null,
}

/** 把微任务队列跑干净——bundle 里的隐藏逻辑是异步的。 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 按组件函数记忆 useState 的值。
 *
 * 不这么做的话 `setTarget(...)` 是个空操作，弹窗永远停在「没有目标」，
 * 「确认删除 → 广播」这条真实路径就根本测不到。
 */
const stateSlots = new Map()
const STATE_SETTER = Symbol('fake-state-setter')

/** 记账用的 React 替身：只实现组件真正用到的那部分。 */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useCallback(fn, deps) {
    hookCalls.push('useCallback')
    return fn
  },
  useEffect(effect, deps) {
    hookCalls.push('useEffect')
    lastCleanup = effect()
    return lastCleanup
  },
  useMemo(fn, deps) {
    hookCalls.push('useMemo')
    return fn()
  },
  useRef(initial) {
    hookCalls.push('useRef')
    const ref = { current: initial }
    refRegistry.created.push(ref)
    if (typeof refRegistry.onNext === 'function') refRegistry.onNext(ref)
    return ref
  },
  useState(initial) {
    hookCalls.push('useState')
    // 按「组件函数 + **本次渲染内的**序号」记住值。
    // 序号必须每次渲染归零：用 slots.length 当索引的话，每次渲染都会新开一个槽，
    // setState 永远改不到「下一次渲染读的那个槽」，状态就永远不生效。
    const slots = stateSlots.get(currentComponent) ?? []
    const index = hookIndex
    hookIndex += 1
    // ⚠️ 判断「这个槽还没建过」必须用**下标是否越界**，不能用 `=== undefined`：
    // `useState()` 不传初始值时值本来就是 undefined，用后者会把已存在的槽反复重置，
    // setState 的效果下一轮渲染就被抹掉（这个坑真实踩过，排查花了不少时间）。
    if (index >= slots.length) {
      slots.push({ value: typeof initial === 'function' ? initial() : initial })
    }
    stateSlots.set(currentComponent, slots)
    // 真正写回状态槽（只有 flushUpdates 会调用它）。
    const commit = (next) => {
      slots[index].value = typeof next === 'function' ? next(slots[index].value) : next
    }
    const setter = (next) => {
      // 只挂起，不立刻写：同一批里对同一个槽的多次更新，只有最后一次生效。
      pendingUpdates.set(setter, { commit, next })
    }
    setter[STATE_SETTER] = true
    // 关键：在这里就登记 setter。
    // 组件返回 null（弹窗没有目标时就是这样）的话，setter 根本不在返回的树里，
    // 「从树里收集 setter」会一个都收不到。
    currentSetters.push(setter)
    return [slots[index].value, setter]
  },
}

const primitivesStub = {
  get IconTrashOutlineRegular() {
    // 记账一次即可：这个 getter 会被反复读取，重复记录会让断言变成「读了几次」而不是「用了什么」。
    if (!primitivesAccess.includes('IconTrashOutlineRegular')) primitivesAccess.push('IconTrashOutlineRegular')
    return function IconTrashOutlineRegular(props) {
      return { type: 'icon-trash', props }
    }
  },
  get MenuItemButton() {
    if (!primitivesAccess.includes('MenuItemButton')) primitivesAccess.push('MenuItemButton')
    return function MenuItemButton(props) {
      return { type: 'menu-item-button', props }
    }
  },
  get Tooltip() {
    if (!primitivesAccess.includes('Tooltip')) primitivesAccess.push('Tooltip')
    return function Tooltip(props) {
      return { type: 'tooltip', props }
    }
  },
  get RiskConfirmation() {
    if (!primitivesAccess.includes('RiskConfirmation')) primitivesAccess.push('RiskConfirmation')
    return function RiskConfirmation(props) {
      return { type: 'risk-confirmation', props }
    }
  },
  get Button() {
    if (!primitivesAccess.includes('Button')) primitivesAccess.push('Button')
    return function Button(props) {
      return { type: 'button-primitive', props }
    }
  },
  get IconRefreshOutlineRegular() {
    if (!primitivesAccess.includes('IconRefreshOutlineRegular')) primitivesAccess.push('IconRefreshOutlineRegular')
    return function IconRefreshOutlineRegular(props) {
      return { type: 'icon-refresh', props }
    }
  },
}

/** 记录注册进来的槽位条目。 */
const registrations = []
/** ctx.inject（服务延迟注入）声明的名字。 */
const serviceInjections = []
/** ctx.slots.inject（槽位延迟注入）声明的名字。 */
const slotInjections = []
/** 当前正在渲染的组件函数——假 React 靠它区分不同组件各自的 state。 */
let currentComponent = null
/** 本次渲染内已用掉的 useState 槽位数（每次渲染归零）。 */
let hookIndex = 0
/** 本次渲染创建的 setter（在 `useState` 里登记，不依赖返回的树）。 */
let currentSetters = []
/**
 * 待应用的更新队列，按 setter 去重，只保留**最后一次**的值。
 *
 * ⚠️ 这是这块测试替身最容易写错的地方。真实 React 里「事件 → setState → 重渲染」，
 * 组件每次渲染都会生成新的处理函数闭包，**旧闭包里的 setState 会读到它那一轮的快照**。
 * 早先的实现把所有 setter 无条件重放一遍，于是上一轮 `close()` 里的 `setTarget(null)`
 * 会把刚设好的目标又抹掉——测试里看到的现象是「弹窗拿到目标后又变回空」。
 * 按「最后一次写入生效」合并，才和真实行为一致。
 */
const pendingUpdates = new Map()

/** 把待应用的更新写回状态槽（模拟 React 提交一次渲染）。 */
function flushUpdates() {
  // 先用快照再清空：`commit` 不会重新入队，但保持这个习惯避免嵌套修改。
  const queued = [...pendingUpdates.values()]
  pendingUpdates.clear()
  for (const { commit, next } of queued) commit(next)
}

/** 渲染一个组件（假渲染：直接调用函数）。 */
function renderComponent(component, props) {
  currentComponent = component
  hookIndex = 0
  currentSetters = []
  try {
    return component(props)
  } finally {
    currentComponent = null
  }
}

/**
 * 反复渲染并把产生的 setter 作用一遍，直到连续两轮结果一致。
 *
 * 真实渲染里 `setState` 会触发重渲染，假 React 不会。这样处理后，测试才能看到
 * 「事件处理里 setState 之后」的界面——例如弹窗从「没有目标」变成「有确认按钮」。
 */
function renderUntilStable(component, props, maxRounds = 6) {
  flushUpdates()
  let tree = renderComponent(component, props)
  for (let round = 0; round < maxRounds; round += 1) {
    if (pendingUpdates.size === 0) return tree
    flushUpdates()
    const next = renderComponent(component, props)
    if (sameTree(next, tree)) return next
    tree = next
  }
  return tree
}

/**
 * 比较两棵假元素树是否「实质相同」。
 *
 * 不能用 `JSON.stringify`：函数值会被丢掉，于是「目标变了」这种差异看不见。
 */
function sameTree(left, right) {
  if (left === right) return true
  if (left === null || right === null || left === undefined || right === undefined) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false
  if (left.type !== right.type) return false
  const leftKeys = Object.keys(left.props ?? {})
  const rightKeys = Object.keys(right.props ?? {})
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (typeof left.props[key] === 'function' || typeof right.props[key] === 'function') {
      if (typeof left.props[key] !== typeof right.props[key]) return false
      continue
    }
    if (JSON.stringify(left.props[key]) !== JSON.stringify(right.props[key])) return false
  }
  const leftChildren = Array.isArray(left.children) ? left.children : []
  const rightChildren = Array.isArray(right.children) ? right.children : []
  if (leftChildren.length !== rightChildren.length) return false
  return leftChildren.every((child, index) => sameTree(child, rightChildren[index]))
}

function makeRequire() {
  return (specifier) => {
    requireCalls.push(specifier)
    if (specifier === 'react') return fakeReact
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    throw new Error(`client.js 请求了未声明的模块：${specifier}`)
  }
}

// 记账 fetch：bundle 通过它读会话列表与已删轮次。
globalThis.fetch = async (url, init) => {
  fetchLog.push({ url: String(url), body: init?.body })
  return { ok: true, status: 200, json: async () => ({ ok: true, sessions: [], turns: [] }) }
}

await import(pathToFileURL(path.join(process.cwd(), 'client.js')).href)

test('bundle 用插件 id 注册，并导出 apply / inject', () => {
  assert.equal(loaded.id, 'dsh-agent-control')
  assert.equal(typeof loaded.apply, 'function')
  assert.deepEqual(loaded.inject, ['slots'])
})

test('factory 只 require 声明过的模块，且用到的导出名都取到了', () => {
  assert.deepEqual(requireCalls, ['react', '@deepseek-ai/dsh-client-ui-primitives'])
  assert.deepEqual(primitivesAccess.sort(), [
    'Button',
    'IconRefreshOutlineRegular',
    'IconTrashOutlineRegular',
    'MenuItemButton',
    'RiskConfirmation',
    'Tooltip',
  ])
})

test('apply 注册五个槽位，且每个 list 槽位都带 id', () => {
  loaded.apply(makeContext())

  assert.deepEqual(slotInjections.sort(), [
    'conversation.chat.assistant-actions',
    'conversation.chat.turnTail',
    'settings.section',
    'shell.overlay',
    'sidebar.workspaces.session.menu.item',
  ])
  assert.deepEqual(serviceInjections.sort(), ['locale', 'sessions'], '服务注入走 ctx.inject')

  assert.equal(registrations.length, 5)
  for (const entry of registrations) {
    assert.equal(entry.options.name, entry.name, 'register 的 name 必须与 inject 的槽位一致')
    assert.equal(typeof entry.options.id, 'string', `${entry.name} 是 list 槽位，必须有 id`)
    assert.ok(entry.options.id.length > 0)
    assert.equal(typeof entry.component, 'function')
  }
  // 链式槽位才用 select；我们一个都不注册，避免注册形状错误。
  assert.equal(registrations.some((entry) => 'select' in entry.options), false)
})

test('两个轮次相关槽位都把 sessionId 注入给组件', () => {
  loaded.apply(makeContext())

  for (const name of ['conversation.chat.assistant-actions', 'conversation.chat.turnTail']) {
    const entry = registrations.find((item) => item.name === name)
    assert.equal(typeof entry.options.inject, 'function', `${name} 需要注入 sessionId`)
    assert.deepEqual(entry.options.inject('session-123'), { sessionId: 'session-123' })
  }
})

test('槽位条目 id 唯一且带插件前缀', () => {
  loaded.apply(makeContext())
  const ids = registrations.map((entry) => entry.options.id)
  assert.equal(new Set(ids).size, ids.length, '条目 id 必须唯一')
  for (const id of ids) assert.match(id, /^agent-control-/, '条目 id 统一带插件前缀，便于排查冲突')
})

test('原生原语不可用时有兜底，且兜底仍要求显式勾选', () => {
  const exposes = globalThis.window.__dshAgentControl
  assert.ok(exposes, 'bundle 必须暴露排障抓手 window.__dshAgentControl')
  assert.equal(exposes.id, 'dsh-agent-control')

  const { FallbackTrashIcon, FallbackRiskConfirmation } = exposes.fallbacks
  assert.equal(typeof FallbackTrashIcon, 'function')
  assert.equal(typeof FallbackRiskConfirmation, 'function')

  // 图标：画出一个内联 svg，不依赖任何包。
  const icon = FallbackTrashIcon({ size: 16 })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 16)

  // 关闭时不渲染。
  assert.equal(FallbackRiskConfirmation({ open: false }), null)

  // 打开但未勾选：确认按钮必须禁用——这是这个兜底存在的唯一理由。
  const dialog = FallbackRiskConfirmation({
    open: true,
    title: '标题',
    description: '第一段\n\n第二段',
    acknowledgeLabel: '我明白',
    cancelLabel: '取消',
    confirmLabel: '删除',
    acknowledged: false,
    onAcknowledgedChange: () => {},
    onCancel: () => {},
    onConfirm: () => {},
  })
  const confirmButton = findElement(dialog, (element) => element.props?.['data-agent-control-confirm'] === '1')
  assert.ok(confirmButton, '兜底弹窗必须有一个确认按钮')
  assert.equal(confirmButton.props.disabled, true, '未勾选时确认按钮必须禁用')
  assert.deepEqual(confirmButton.children, ['删除'])

  // 勾选后可用。
  const ready = FallbackRiskConfirmation({
    open: true,
    title: '标题',
    description: '正文',
    acknowledgeLabel: '我明白',
    cancelLabel: '取消',
    confirmLabel: '删除',
    acknowledged: true,
    onAcknowledgedChange: () => {},
    onCancel: () => {},
    onConfirm: () => {},
  })
  const readyConfirm = findElement(ready, (element) => element.props?.['data-agent-control-confirm'] === '1')
  assert.equal(readyConfirm.props.disabled, false, '勾选后确认按钮应当可用')
})

/** 在假 React 元素树里找第一个满足条件的元素（避免在测试里写下标，那是脆的）。 */
function findElement(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) {
    const found = findElement(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

test('每个组件都能被构造出来（不依赖模块初始化阶段的 hooks）', () => {
  loaded.apply(makeContext())

  const props = {
    sessionId: 'session-1',
    displayTitle: '示例会话',
    messageId: 'msg-1',
    turn: { turn: 2 },
    useMenuOpenState: () => [true, () => {}],
    useSession: () => false,
  }

  for (const entry of registrations) {
    hookCalls.length = 0
    const tree = entry.component({ ...props, ...(entry.options.inject?.(props.sessionId) ?? {}) })
    // 弹窗没有激活的目标时返回 null，这是正常的；其余必须画出东西。
    if (entry.name === 'shell.overlay') {
      assert.equal(tree, null, '没有目标时弹窗不该渲染')
      continue
    }
    assert.notEqual(tree, null, `${entry.name} 应当渲染出内容`)
    assert.ok(hookCalls.length > 0, `${entry.name} 应当调用 hooks`)
  }
})

test('弹窗监听删除请求事件，且在还没有目标时不渲染', () => {
  const context = makeContext()
  loaded.apply(context)

  // 监听必须在渲染之前装好，组件挂载时才收得到。
  const listeners = []
  globalThis.window.addEventListener = (type, handler) => listeners.push({ type, handler })
  globalThis.window.removeEventListener = () => {}

  const dialog = registrations.find((entry) => entry.name === 'shell.overlay')
  lastCleanup = undefined
  // 必须经由 renderComponent：假 React 靠它记录「现在在渲染谁」，
  // 直接 `dialog.component({})` 会让 useState 找不到状态槽。
  const tree = renderComponent(dialog.component, {})

  assert.equal(tree, null, '没有目标时弹窗不该渲染')
  assert.ok(listeners.length > 0, '弹窗必须监听删除请求事件')
  assert.equal(typeof lastCleanup, 'function', '监听必须在卸载时清理掉')
})

test('会话菜单项点击会派发删除请求，带上 sessionId 与标题', () => {
  loaded.apply(makeContext())

  dispatched.length = 0
  const entry = registrations.find((item) => item.name === 'sidebar.workspaces.session.menu.item')
  const tree = entry.component({
    sessionId: 'session-7',
    displayTitle: '要被删掉的会话',
    useMenuOpenState: () => [true, () => {}],
  })

  // 原生菜单行（MenuItemButton）：与其它会话操作同尺寸，激活回调是 onSelect。
  assert.equal(tree.type.name, 'MenuItemButton', '必须用原生菜单行，才能与其它菜单项同尺寸')
  assert.equal(tree.props.danger, true, '破坏性操作要用危险色')
  assert.equal(tree.props.separatorBefore, true, '与普通操作之间要有分组细线')
  assert.equal(typeof tree.props.onSelect, 'function')
  tree.props.onSelect()

  assert.deepEqual(dispatched.at(-1), {
    kind: 'session',
    sessionId: 'session-7',
    title: '要被删掉的会话',
  })
})

test('删除项排在原生归档项（order 400）之后', () => {
  loaded.apply(makeContext())
  const entry = registrations.find((item) => item.name === 'sidebar.workspaces.session.menu.item')
  assert.ok(entry.options.order > 400, '原生项是 100 置顶 / 200 重命名 / 300 分叉 / 400 归档')
})

test('运行中的 assistant 按钮禁用且不派发请求', () => {
  loaded.apply(makeContext())

  dispatched.length = 0
  const entry = registrations.find((item) => item.name === 'conversation.chat.assistant-actions')

  // `useSession` 是**选择器**式 hook：组件会传一个 `(state) => ...` 进来。
  // 假实现必须把 selector 作用在假状态上，否则「运行中」这个分支永远测不到。
  const sessionWith = (running) => (selector) => selector({ running })

  const running = entry.component({ sessionId: 'session-9', messageId: 'msg-9', useSession: sessionWith(true) })
  // 这个按钮用 `aria-disabled` + 去掉 onClick 表达禁用（原生 button 的 disabled 会丢焦点行为）。
  const runningButton = findElement(running, (element) => element.props?.['aria-disabled'] === 'true')
  assert.ok(runningButton, '会话运行中时按钮应当标成 aria-disabled')
  assert.equal(runningButton.props.onClick, undefined, '禁用状态下不能挂点击处理')
  assert.equal(dispatched.length, 0, '禁用状态下不能派发删除请求')

  const idle = entry.component({ sessionId: 'session-9', messageId: 'msg-9', useSession: sessionWith(false) })
  const idleButton = findElement(idle, (element) => typeof element.props?.onClick === 'function')
  assert.ok(idleButton)
  idleButton.props.onClick()
  assert.deepEqual(dispatched.at(-1), {
    kind: 'turn',
    sessionId: 'session-9',
    assistantMessageId: 'msg-9',
  })
})

/**
 * 最近一次注入给 bundle 的假 sessions 服务。
 *
 * 「删除会话后是就地刷新还是整页重载」只能靠观察这个对象才知道：
 * 就地刷新 = 它的 `refresh()` 被调用，整页重载 = `window.location.reload()` 被调用。
 */
let lastSessionsService

/** 造一个只实现 client.js 真正用到的那几个成员的假 ctx。 */
function makeContext() {
  registrations.length = 0
  serviceInjections.length = 0
  slotInjections.length = 0
  stateSlots.clear()
  lastSessionsService = { refresh: () => { lastSessionsService.refreshed += 1 } }
  lastSessionsService.refreshed = 0
  return {
    get: () => undefined,
    inject(names, callback) {
      serviceInjections.push(...names)
      callback({
        locale: { register: () => () => {}, translate: (_ns, key) => key },
        sessions: lastSessionsService,
      })
    },
    effect: (fn) => {
      fn()
    },
    slots: {
      inject(name, callback) {
        slotInjections.push(name)
        callback()
      },
      register(options, component) {
        registrations.push({ name: options.name, options, component })
        return () => {}
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 假 DOM：用于验证「隐藏已删轮次」的归属判定
// ---------------------------------------------------------------------------

/** 极简的 CSS 选择器匹配，只支持测试里用到的那种属性选择器。 */
function matchesSelector(node, selector) {
  const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector)
  if (attribute === null) return false
  const [, name, expected] = attribute
  const actual = node.attrs[name]
  if (actual === undefined) return false
  return expected === undefined || actual === expected
}

/** 造一个假元素；`querySelector(All)` 会走整棵子树，和真实 DOM 一致。 */
function makeElement(tag, attrs = {}) {
  const node = {
    tag,
    attrs: { ...attrs },
    children: [],
    parent: null,
    hidden: false,
    dataset: {},
    /** 假的行内样式表：淡出会往这里写 opacity / transition / transform。 */
    style: {},
    /** 假的属性表：淡出会写 aria-hidden。 */
    attrs: { ...attrs },
    setAttribute(name, value) {
      node.attrs[name] = value
    },
    removeAttribute(name) {
      delete node.attrs[name]
    },
    append(child) {
      child.parent = node
      node.children.push(child)
      return child
    },
    descendants() {
      const all = []
      for (const child of node.children) all.push(child, ...child.descendants())
      return all
    },
    matches(selector) {
      return matchesSelector(node, selector)
    },
    closest(selector) {
      let current = node
      while (current !== null) {
        if (matchesSelector(current, selector)) return current
        current = current.parent
      }
      return null
    },
    querySelector(selector) {
      return node.descendants().find((element) => matchesSelector(element, selector)) ?? null
    },
    querySelectorAll(selector) {
      return node.descendants().filter((element) => matchesSelector(element, selector))
    },
    get previousElementSibling() {
      if (node.parent === null) return null
      const siblings = node.parent.children
      const index = siblings.indexOf(node)
      return index > 0 ? siblings[index - 1] : null
    },
  }
  return node
}

/**
 * 造一个三轮会话的假列表，**按已核对的真实 DOM 契约**（`dsh-client-ui-chat` 的 `ChatNodeSeat`）：
 * 每个节点行都在一个 `[data-chat-flow]` 容器里，各自带 `data-chat-turn`（属于哪一轮）
 * 与 `data-chat-flow-kind`；只有该轮的尾巴行带 `data-turn-tail`。
 */
function makeTurnList() {
  const scope = makeElement('div', { 'data-chat-flow': '' })
  const turns = []
  for (const turn of [1, 2, 3]) {
    const question = scope.append(makeElement('div', {
      'data-chat-flow-kind': 'user',
      'data-chat-turn': String(turn),
      class: 'question',
    }))
    const answer = scope.append(makeElement('div', {
      'data-chat-flow-kind': 'turn-process',
      'data-chat-turn': String(turn),
      class: 'answer',
    }))
    const tail = scope.append(makeElement('div', {
      'data-chat-flow-kind': 'turn-tail',
      'data-chat-turn': String(turn),
      'data-turn-tail': String(turn),
      class: 'tail',
    }))
    const marker = tail.append(makeElement('span', { 'data-agent-control-deleted-turn': String(turn) }))
    turns.push({ turn, scope, question, answer, tail, marker })
  }
  return { scope, turns }
}

test('隐藏已删轮次：只隐藏该轮，更早的轮次必须完好（真机踩过的 bug）', () => {
  // 真机现象：只删了第二句，第一句也从界面上消失了。
  // 早期实现顺着兄弟节点往前爬，用「后代里有没有 turn-tail」判断是否到了上一轮——
  // 但爬到容器时容器后代里当然有，于是把更早的轮次一起隐藏了。
  const { scope, turns } = makeTurnList()
  const [first, second, third] = turns

  const { restoreAll } = syncTurnRows()(second.marker, second.turn, { deleted: true })

  assert.equal(second.question.hidden, true, '目标轮次的问题行应当被隐藏')
  assert.equal(second.answer.hidden, true, '目标轮次的回复行应当被隐藏')
  assert.equal(second.tail.hidden, true, '目标轮次的尾巴行应当被隐藏')
  assert.equal(first.question.hidden, false, '★ 更早轮次的问题行绝不能被隐藏')
  assert.equal(first.answer.hidden, false, '★ 更早轮次的回复行绝不能被隐藏')
  assert.equal(first.tail.hidden, false, '★ 更早轮次的尾巴行绝不能被隐藏')
  assert.equal(third.question.hidden, false, '更晚的轮次不受影响')
  assert.equal(third.answer.hidden, false, '更晚的轮次不受影响')
  assert.equal(third.tail.hidden, false, '更晚的轮次不受影响')
  assert.notEqual(scope.hidden, true, '容器本身绝不能被隐藏')

  restoreAll()
  assert.equal(second.question.hidden, false, '恢复后目标轮次应当重新可见')
  assert.equal(second.tail.hidden, false, '恢复后目标轮次的尾巴行也应当可见')
  assert.equal(second.question.dataset.agentControlTurn, undefined, '恢复后要清掉记账标记')
})

test('重复同步不会重新显示已藏的行（真机踩过的「闪一下」）', () => {
  // 早先每次同步都先 restore() 再隐藏，于是已经藏好的行会先露一帧再被藏回去。
  // 现在恢复与隐藏收在一次遍历里，重复同步对已藏的行必须是「无动作」。
  const { turns } = makeTurnList()
  const [, second] = turns
  const hidden = new Set()
  const sync = syncTurnRows()

  sync(second.marker, second.turn, { deleted: true, hidden })
  assert.equal(second.question.hidden, true)

  // 模拟 MutationObserver 因为新内容插入而反复触发。
  for (let i = 0; i < 5; i += 1) {
    sync(second.marker, second.turn, { deleted: true, hidden })
    assert.equal(second.question.hidden, true, '★ 重复同步期间不能被重新显示')
  }

  // 只有明确不再「已删」时才恢复。
  sync(second.marker, second.turn, { deleted: false, hidden })
  assert.equal(second.question.hidden, false, '不再已删时应当恢复可见')
})

/**
 * 接管动画相关的浏览器 API，方便逐帧、逐定时器地断言。
 *
 * 折叠动画严格分两帧：先量高度写过渡，再写目标值。测试必须能停在这两步之间，
 * 否则「没有动画、直接消失」这类时序错误会被掩盖过去。
 */
function stubAnimationApis() {
  const originals = {
    getComputedStyle: globalThis.window.getComputedStyle,
    requestAnimationFrame: globalThis.window.requestAnimationFrame,
    setTimeout: globalThis.window.setTimeout,
    clearTimeout: globalThis.window.clearTimeout,
  }
  const frames = []
  const timers = []
  globalThis.window.getComputedStyle = () => ({
    display: 'block',
    opacity: '1',
    marginTop: '8px',
    marginBottom: '8px',
    paddingTop: '4px',
    paddingBottom: '4px',
  })
  globalThis.window.requestAnimationFrame = (callback) => {
    frames.push(callback)
    return frames.length
  }
  globalThis.window.setTimeout = (callback, delay) => {
    timers.push({ callback, delay })
    return timers.length
  }
  globalThis.window.clearTimeout = () => {}

  return {
    frames,
    timers,
    /** 取出并清空当前排队的帧回调（新产生的会留到下一轮）。 */
    takeFrames() {
      return frames.splice(0, frames.length)
    },
    /** 跑完接下来 count 轮帧（每轮可能又安排新的帧）。 */
    runFrames(count = 1) {
      for (let round = 0; round < count; round += 1) {
        for (const frame of frames.splice(0, frames.length)) frame()
      }
    },
    runTimers() {
      for (const timer of timers.splice(0, timers.length)) timer.callback()
    },
    restore() {
      for (const [key, value] of Object.entries(originals)) globalThis.window[key] = value
    },
  }
}

test('删除时收起折叠：量高度 → 下一帧过渡 → 收尾才 display:none', () => {
  const { turns } = makeTurnList()
  const [, second] = turns
  // 假的行没有真实布局，给个固定高度让折叠有确定起点。
  second.question.getBoundingClientRect = () => ({ height: 80 })
  second.answer.getBoundingClientRect = () => ({ height: 40 })
  second.tail.getBoundingClientRect = () => ({ height: 20 })

  const api = stubAnimationApis()
  try {
    syncTurnRows()(second.marker, second.turn, { deleted: true, animate: true })

    // 第 1 帧之前：只写过渡声明与无障碍语义，几何属性一个字都不能动。
    assert.equal(second.question.attrs['aria-hidden'], 'true', '无障碍语义要立刻生效')
    assert.equal(second.question.style.overflow, 'hidden', '折叠期间要裁掉溢出')
    assert.match(second.question.style.transition, /height/, '要声明 height 过渡')
    assert.match(second.question.style.transition, /margin-top/, '行距也要一起收，否则会留下空隙')
    assert.equal(second.question.style.height, undefined, '★ 第一帧不能写 height，否则没有过渡')
    assert.equal(second.question.hidden, false, '折叠期间元素必须参与布局')
    // 整组只排**一个**帧：所有行在同一个起点开始，错开交给各自的定时器。
    assert.equal(api.frames.length, 1, '整组共用一个起始帧')

    // 第 2 帧：写当前值作为过渡起点（height 用刚量到的像素）。
    api.runFrames(1)
    assert.equal(second.question.style.height, '80px', '起点是量出来的像素高度')
    assert.equal(second.answer.style.height, '40px')
    assert.equal(second.tail.style.height, '20px')
    assert.equal(second.question.style.marginTop, '8px', '行距起点也是当前计算值')
    assert.equal(api.frames.length, 3, '每行各安排一次「压到 0」的帧')

    // 第 3 帧：压到 0，过渡这才真的跑起来。
    api.runFrames(1)
    assert.equal(second.question.style.height, '0px')
    assert.equal(second.answer.style.height, '0px', '其余行也要一起收到 0')
    assert.equal(second.question.style.marginTop, '0px')
    assert.equal(second.question.style.paddingTop, '0px')
    assert.equal(second.question.style.opacity, '0')

    // 三行依次错开：0ms / 50ms / 100ms，各加一个时长。
    assert.deepEqual(api.timers.map((timer) => timer.delay), [240, 290, 340], '逐行错开收起')

    api.runTimers()
    assert.equal(second.question.hidden, true, '收尾之后才 display:none')
    assert.equal(second.answer.hidden, true)
    assert.equal(second.tail.hidden, true)
    assert.equal(second.question.style.height, undefined, '收尾要清掉内联样式')
  } finally {
    api.restore()
  }
})

test('恢复可见会取消进行中的折叠', () => {
  const { turns } = makeTurnList()
  const [, second] = turns
  second.question.getBoundingClientRect = () => ({ height: 80 })
  second.answer.getBoundingClientRect = () => ({ height: 40 })
  second.tail.getBoundingClientRect = () => ({ height: 20 })

  const api = stubAnimationApis()
  try {
    const hidden = new Set()
    const sync = syncTurnRows()
    sync(second.marker, second.turn, { deleted: true, animate: true, hidden })
    api.runFrames(2)
    assert.equal(second.question.style.height, '0px', '折叠已经开始')

    // 动画还没跑完就被恢复（例如宿主把这一轮又变成未删状态）。
    sync(second.marker, second.turn, { deleted: false, hidden })
    assert.equal(second.question.hidden, false, '恢复后要立刻可见')
    assert.equal(second.question.style.height, undefined, '★ 内联几何样式要清干净，否则高度还停在 0')
    assert.equal(second.question.attrs['aria-hidden'], undefined, '无障碍属性也要撤掉')

    // 迟到的收尾回调不能再把行藏回去。
    api.runTimers()
    assert.equal(second.question.hidden, false, '★ 迟到的动画回调不能重新隐藏它')
  } finally {
    api.restore()
  }
})

test('宿主改用别的 DOM 契约、量不到高度时直接隐藏（不卡在半折叠）', () => {
  const { turns } = makeTurnList()
  const [, second] = turns
  // 没有 getBoundingClientRect → 折叠动画不可用。
  second.question.getBoundingClientRect = undefined
  second.answer.getBoundingClientRect = undefined
  second.tail.getBoundingClientRect = undefined

  const api = stubAnimationApis()
  try {
    syncTurnRows()(second.marker, second.turn, { deleted: true, animate: true })
    assert.equal(second.question.hidden, true, '仍然要隐藏')
    assert.equal(second.question.style.height, undefined, '不该留下半折叠的内联样式')
  } finally {
    api.restore()
  }
})

test('不动画时直接隐藏（页面加载时就已删的轮次不该再动一次）', () => {
  const { turns } = makeTurnList()
  const [, second] = turns
  syncTurnRows()(second.marker, second.turn, { deleted: true })
  assert.equal(second.question.hidden, true)
  assert.ok(!second.question.style.opacity, '没有动画就不该写内联样式')
})

test('系统开启「减少动态效果」时不播放动画', () => {
  const { turns } = makeTurnList()
  const [, second] = turns
  const originalMatchMedia = globalThis.window.matchMedia
  globalThis.window.matchMedia = () => ({ matches: true })
  try {
    syncTurnRows()(second.marker, second.turn, { deleted: true, animate: true })
    assert.equal(second.question.hidden, true, '仍然要隐藏')
    assert.ok(!second.question.style.opacity, '但不该写动画样式')
  } finally {
    globalThis.window.matchMedia = originalMatchMedia
  }
})

test('认不出行归属时什么都不隐藏（宁可少藏，不可多藏）', () => {
  // DOM 契约变了时，界面上留着那一轮只是「滞后」；错误地多藏会让用户以为内容丢了。
  const scope = makeElement('div', { 'data-chat-flow': '' })
  const tail = scope.append(makeElement('div', { 'data-chat-flow-kind': 'turn-tail' }))
  const marker = tail.append(makeElement('span', {}))

  const { restoreAll } = syncTurnRows()(marker, 7, { deleted: true })

  assert.equal(tail.hidden, false, '认不出归属时不能隐藏任何东西')
  assert.equal(marker.hidden, false, '认不出归属时不能隐藏任何东西')
  assert.equal(typeof restoreAll, 'function', '仍要返回可调用的恢复函数')
  restoreAll()
})

test('标记不在任何 chat-flow 容器里时安全返回', () => {
  const { restoreAll } = syncTurnRows()(makeElement('span', {}), 3, { deleted: true })
  assert.equal(typeof restoreAll, 'function')
  restoreAll()
})

// ---------------------------------------------------------------------------
// 删除成功后的广播：真机踩过的坑——服务端删掉了，界面刷新前还显示着
// ---------------------------------------------------------------------------

/** 用一个假 DOM 节点充当 ref.current，并让标记组件把它放进 useRef 里。 */
function makeRefNode() {
  const scope = makeElement('div', { 'data-chat-flow': '' })
  const row = scope.append(makeElement('div', { 'data-chat-turn': '7', 'data-chat-flow-kind': 'turn-process' }))
  const anchor = row.append(makeElement('span', { id: 'marker-anchor' }))
  return { scope, row, anchor }
}

test('删除成功后弹窗会广播 turns-changed（否则标记不会重新判断）', async () => {
  // 真机现象：删除成功后界面还显示着那一轮，刷新页面才对。
  // 根因是只清了缓存却没有广播——没有任何组件会因此重跑。
  loaded.apply(makeContext())

  // 1) 先把监听器接管过来，**再**碰任何组件。
  //    顺序很重要：测试里渲染组件必须让假 React 知道「现在在渲染谁」，
  //    直接 `entry.component(...)` 调用会把状态记到 null 这个键上，后续渲染读不到。
  const listeners = []
  const dispatchedEvents = []
  const originalAdd = globalThis.window.addEventListener
  const originalDispatch = globalThis.window.dispatchEvent
  globalThis.window.addEventListener = (type, handler) => listeners.push({ type, handler })
  globalThis.window.removeEventListener = () => {}
  globalThis.window.dispatchEvent = (event) => dispatchedEvents.push(event)

  loaded.apply(makeContext())
  const dialog = registrations.find((entry) => entry.name === 'shell.overlay')

  // 2) 挂载弹窗 → 捕捉 request-delete 监听器
  renderComponent(dialog.component, { t: (key) => key })
  const onRequest = listeners.find((item) => item.type === 'dsh-agent-control:request-delete')?.handler
  assert.equal(typeof onRequest, 'function', '弹窗必须监听 request-delete')

  // 3) 收到删除请求 → 弹窗进入「有目标」状态，再渲染出确认框
  onRequest({ detail: { kind: 'turn', sessionId: 'session-77', assistantMessageId: 'msg-77' } })
  const tree = renderUntilStable(dialog.component, { t: (key) => key })
  // 有目标时弹窗渲染的是**原生** RiskConfirmation（primitivesStub 返回的那个函数），
  // 所以元素类型是函数本身，而不是自带兜底弹窗里的 `'risk-confirmation'` 字符串。
  const confirmBox = findElement(tree, (element) => element.type?.name === 'RiskConfirmation')
  assert.ok(confirmBox, '有目标时应当渲染确认框')
  assert.equal(confirmBox.props.open, true)
  assert.equal(confirmBox.props.disabled, false, '未在提交中，确认按钮不该被禁用')

  // 4) 确认 → 打到宿主 → 必须广播
  const before = fetchLog.length
  await confirmBox.props.onConfirm()
  assert.ok(fetchLog.length > before, '确认后应当至少发一次请求')

  const broadcast = dispatchedEvents.find((event) => event.type === 'dsh-agent-control:turns-changed')
  assert.ok(broadcast, '★ 删除成功后必须广播 turns-changed')
  assert.deepEqual(broadcast.detail, { sessionId: 'session-77' })

  globalThis.window.addEventListener = originalAdd
  globalThis.window.dispatchEvent = originalDispatch
})

test('标记收到广播后重新判断，把刚删的那一轮隐藏掉', async () => {
  loaded.apply(makeContext())
  await flush()

  const { row, anchor } = makeRefNode()
  // 这个会话的「已删轮次」在广播之后才出现——模拟服务端刚写入墓碑。
  const answer = { turns: [] }
  globalThis.fetch = async (url, init) => {
    fetchLog.push({ url: String(url), body: init?.body })
    return { ok: true, status: 200, json: async () => ({ ok: true, sessions: [], turns: answer.turns }) }
  }

  const listeners = []
  const originalAdd = globalThis.window.addEventListener
  globalThis.window.addEventListener = (type, handler) => listeners.push({ type, handler })
  globalThis.window.removeEventListener = () => {}

  // 挂载前就把 ref 指向假 DOM 节点：组件在 effect 里立刻读 ref.current，
  // 挂载之后再塞值就晚了（见 refRegistry.onNext 的说明）。
  refRegistry.onNext = (ref) => {
    ref.current = anchor
  }
  try {
    const marker = registrations.find((entry) => entry.name === 'conversation.chat.turnTail')
    marker.component({ sessionId: 'session-broadcast', turn: { turn: 7 } })
    await flush()

    const onTurnsChanged = listeners.find((item) => item.type === 'dsh-agent-control:turns-changed')?.handler
    assert.equal(typeof onTurnsChanged, 'function', '标记必须监听 turns-changed')
    assert.equal(row.hidden, false, '还没删过，不该隐藏')

    // 服务端写入墓碑 → 广播到达 → 标记必须重新判断并隐藏该轮。
    answer.turns = [7]
    onTurnsChanged({ detail: { sessionId: 'session-broadcast' } })
    await flush()

    assert.equal(row.hidden, true, '★ 收到广播后必须把该轮隐藏掉（刷新前也要生效）')
  } finally {
    refRegistry.onNext = null
    globalThis.window.addEventListener = originalAdd
  }
})

// ---------------------------------------------------------------------------
// 标记的后续同步：观察器、缓存失效次数、失败不缓存
// ---------------------------------------------------------------------------

/**
 * 挂一个标记组件，返回它的 turns-changed 监听器。
 *
 * 调用前要先接管 window.addEventListener（listeners 由调用方提供）。
 */
async function mountMarker(listeners, anchor, sessionId, turn = 7) {
  loaded.apply(makeContext())
  const before = listeners.length
  refRegistry.onNext = (ref) => {
    ref.current = anchor
  }
  try {
    const marker = registrations.find((entry) => entry.name === 'conversation.chat.turnTail')
    marker.component({ sessionId, turn: { turn } })
  } finally {
    refRegistry.onNext = null
  }
  await flush()
  return listeners.slice(before).find((item) => item.type === 'dsh-agent-control:turns-changed')?.handler
}

/** 接管 addEventListener / fetch / MutationObserver，测试结束后还原。 */
function captureBrowser(t, respond) {
  const listeners = []
  const observers = []
  const turnFetches = []
  const original = {
    add: globalThis.window.addEventListener,
    remove: globalThis.window.removeEventListener,
    fetch: globalThis.fetch,
    observer: globalThis.MutationObserver,
  }
  globalThis.window.addEventListener = (type, handler) => listeners.push({ type, handler })
  globalThis.window.removeEventListener = () => {}
  globalThis.fetch = async (url, init) => {
    fetchLog.push({ url: String(url), body: init?.body })
    if (String(url).includes('/turns?')) turnFetches.push(String(url))
    return respond(String(url))
  }
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }

    observe(target) {
      this.target = target
    }

    disconnect() {
      this.disconnected = true
    }
  }
  t.after(() => {
    globalThis.window.addEventListener = original.add
    globalThis.window.removeEventListener = original.remove
    globalThis.fetch = original.fetch
    globalThis.MutationObserver = original.observer
  })
  return { listeners, observers, turnFetches }
}

const okTurns = (turns) => ({ ok: true, status: 200, json: async () => ({ ok: true, sessions: [], turns }) })

test('刚删掉的那一轮之后被重新渲染也继续隐藏（广播删除后也要装观察器）', async (t) => {
  // 早期只在「页面加载时就已删」的路径上装 MutationObserver，于是刚删掉的那一轮
  // 一旦被重新渲染（新行插进来）就又露出来了。
  const answer = { turns: [] }
  const browser = captureBrowser(t, () => okTurns(answer.turns))
  const { scope, row, anchor } = makeRefNode()

  const onTurnsChanged = await mountMarker(browser.listeners, anchor, 'session-observe')
  assert.equal(row.hidden, false)
  assert.equal(browser.observers.length, 0, '没删过时不必盯着列表')

  answer.turns = [7]
  onTurnsChanged({ detail: { sessionId: 'session-observe' } })
  await flush()
  assert.equal(row.hidden, true)
  assert.equal(browser.observers.length, 1, '★ 变成「已删」后必须开始观察列表')
  assert.equal(browser.observers[0].target, scope)

  // 宿主重新渲染出这一轮的新行 → 观察器触发 → 新行同样要藏起来。
  const rerendered = scope.append(makeElement('div', { 'data-chat-turn': '7', 'data-chat-flow-kind': 'user' }))
  browser.observers[0].callback()
  assert.equal(rerendered.hidden, true, '★ 重新渲染出来的行也要隐藏')
})

test('一次广播只让缓存失效一次：N 个标记只发一次 GET /turns', async (t) => {
  // 早期每个标记收到广播都各自清缓存，后一个清掉前一个刚填好的，N 轮就是 N 次请求。
  const browser = captureBrowser(t, () => okTurns([]))
  const handlers = []
  for (let index = 0; index < 3; index += 1) {
    handlers.push(await mountMarker(browser.listeners, makeRefNode().anchor, 'session-many'))
  }
  assert.equal(browser.turnFetches.length, 1, '挂载时共用一次请求')

  const event = { detail: { sessionId: 'session-many' } }
  for (const handler of handlers) handler(event)
  await flush()
  assert.equal(browser.turnFetches.length, 2, '★ 同一次广播只应再请求一次')

  // 下一次广播（新的事件对象）仍然会让缓存失效。
  const next = { detail: { sessionId: 'session-many' } }
  for (const handler of handlers) handler(next)
  await flush()
  assert.equal(browser.turnFetches.length, 3)
})

test('读已删轮次失败时不缓存失败结果，下一次还会重试', async (t) => {
  // 早期把 .catch(() => []) 的结果也缓存了：一次临时错误，整页刷新前都不再隐藏。
  let calls = 0
  const browser = captureBrowser(t, () => {
    calls += 1
    if (calls === 1) throw new Error('网络抖了一下')
    return okTurns([7])
  })

  const first = makeRefNode()
  await mountMarker(browser.listeners, first.anchor, 'session-flaky')
  assert.equal(first.row.hidden, false, '失败时当作没删，不报错')

  const second = makeRefNode()
  await mountMarker(browser.listeners, second.anchor, 'session-flaky')
  assert.equal(browser.turnFetches.length, 2, '★ 失败不能被缓存')
  assert.equal(second.row.hidden, true, '重试成功后应当隐藏')
})

// ---------------------------------------------------------------------------
// 发布前的两条待验证项：就地刷新 vs 整页重载、DELETE_FAILED 的界面文案
// ---------------------------------------------------------------------------

/** 会话列表接口的成功响应。 */
const okSessions = (sessions) => ({ ok: true, status: 200, json: async () => ({ ok: true, sessions }) })

/** 把 window.location 换成记账版本，返回读数与还原函数。 */
function captureReload(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis.window, 'location')
  const state = { reloads: 0 }
  Object.defineProperty(globalThis.window, 'location', {
    value: { reload: () => { state.reloads += 1 } },
    configurable: true,
    writable: true,
  })
  t.after(() => {
    if (original === undefined) delete globalThis.window.location
    else Object.defineProperty(globalThis.window, 'location', original)
  })
  return state
}

/**
 * 把弹窗挂到「确认删除某个会话」这一步，返回确认框。
 *
 * 走的是真实链路：先 GET /sessions 复核目标存在且不 live，再 POST /session/delete，
 * 所以 `respond` 只需要按 URL 分流。
 */
async function mountSessionDeleteDialog(t, respond, sessionId = 'session-77') {
  const browser = captureBrowser(t, respond)
  loaded.apply(makeContext())
  const dialog = registrations.find((entry) => entry.name === 'shell.overlay')
  renderComponent(dialog.component, { t: (key) => key })
  const onRequest = browser.listeners
    .find((item) => item.type === 'dsh-agent-control:request-delete')?.handler
  assert.equal(typeof onRequest, 'function', '弹窗必须监听 request-delete')
  onRequest({ detail: { kind: 'session', sessionId, title: '测试会话' } })
  const tree = renderUntilStable(dialog.component, { t: (key) => key })
  const confirmBox = findElement(tree, (element) => element.type?.name === 'RiskConfirmation')
  assert.ok(confirmBox, '有目标时应当渲染确认框')
  return { dialog, confirmBox }
}

test('删除会话后就地刷新列表：调用 sessions.refresh()，不做整页重载', async (t) => {
  // 真机只观察到「会话消失了」，没有证据区分就地刷新与整页重载。两者的差别是用户可见的：
  // 整页重载会丢掉滚动位置、正在看的对话与界面状态，所以「能就地刷新就必须就地刷新」。
  const reload = captureReload(t)
  const { dialog, confirmBox } = await mountSessionDeleteDialog(t, (url) => {
    if (url.includes('/session/delete')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    return okSessions([{ sessionId: 'session-77', live: false }])
  })
  assert.ok(serviceInjections.includes('sessions'), 'bundle 必须注入 sessions 服务')

  await confirmBox.props.onConfirm()
  await flush()

  assert.equal(lastSessionsService.refreshed, 1, '★ 删除成功后必须让侧栏就地刷新一次')
  assert.equal(reload.reloads, 0, '★ 能就地刷新时不该整页重载')
  const settled = findElement(renderUntilStable(dialog.component, { t: (key) => key }), (element) => element.type?.name === 'RiskConfirmation')
  assert.equal(settled, undefined, '成功后弹窗应当关闭')
})

test('列表刷新拿不到服务时退回整页重载（宁可重载，也不留过时列表）', async (t) => {
  // 服务不在、或 refresh() 抛错时只 catch 不重载，侧栏会一直显示一个已经不存在的会话。
  const reload = captureReload(t)
  const { confirmBox } = await mountSessionDeleteDialog(t, (url) => {
    if (url.includes('/session/delete')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    return okSessions([{ sessionId: 'session-77', live: false }])
  })
  // 注入之后再把服务弄坏：模拟「服务存在但刷新失败」。
  lastSessionsService.refresh = () => { throw new Error('服务挂了') }

  await confirmBox.props.onConfirm()
  await flush()

  assert.equal(reload.reloads, 1, '★ 刷新失败必须退回整页重载')
})

test('DELETE_FAILED 原样显示宿主的原因，绝不说成「任务正在运行」', async (t) => {
  // 如果把所有未知异常都归成 AGENT_BUSY，真实的兼容性失败就会被显示成
  // 「任务正在运行，请结束后再删除」——最误导的一种静默降级。这条用例把
  // 「错误码 → 文案 → 宿主原文」整条链路钉住。
  const failure = {
    ok: false,
    status: 500,
    json: async () => ({
      ok: false,
      error: {
        code: 'DELETE_FAILED',
        message: '会话 session-77 的目录没有删净，工作区记账与投影缓存已保留：C:\\tmp\\sessions\\session-77',
      },
    }),
  }
  const { dialog, confirmBox } = await mountSessionDeleteDialog(t, (url) => {
    if (url.includes('/session/delete')) return failure
    return okSessions([{ sessionId: 'session-77', live: false }])
  })

  await confirmBox.props.onConfirm()
  await flush()

  const after = renderUntilStable(dialog.component, { t: (key) => key })
  const still = findElement(after, (element) => element.type?.name === 'RiskConfirmation')
  assert.ok(still, '失败时弹窗必须保持打开')
  const description = String(still.props.description ?? '')
  assert.ok(description.includes('宿主拒绝了这次删除'), '★ 必须用 error.DELETE_FAILED 的文案')
  assert.ok(description.includes('的目录没有删净'), '★ 必须带上宿主给的原始原因，不能吞成笼统失败')
  assert.ok(!description.includes('任务正在运行'), '★ 绝不能显示成「任务正在运行」')
})

// ---------------------------------------------------------------------------
// 热重启（M4）：槽位注册形状、态机纯函数、组件构造、非阻塞横幅
// ---------------------------------------------------------------------------

/** 取 bundle 暴露的重启排障抓手（和 `syncTurnRows` 一样，必须在 `load()` 之后读）。 */
function restartApi() {
  const expose = globalThis.window.__dshAgentControl
  assert.ok(expose?.restart, 'bundle 必须暴露 window.__dshAgentControl.restart')
  return expose.restart
}

/** 成功的 host 响应。 */
const okPayload = (payload) => ({ ok: true, status: 200, json: async () => payload })

/** 按类名找元素（重启用的是注入样式表的类名，断言它们比断言下标稳）。 */
function findByClass(node, className) {
  // 按 CSS 的语义匹配单个类：兜底按钮会把「自己的类名」和传进来的类名拼在一起
  // （`dsh-agent-control-button dsh-agent-control-danger`），整体字符串比对会漏掉它。
  return findElement(node, (element) => String(element.props?.className ?? '').split(/\s+/).includes(className))
}

/** 收集假元素树里的全部文本。 */
function collectText(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (node === null || node === undefined || typeof node !== 'object') return out
  for (const child of Array.isArray(node.children) ? node.children : []) collectText(child, out)
  return out
}

/**
 * 把模块级重启状态的变化推给已挂载的组件。
 *
 * 真机里这条链路是「dispatchRestart → 广播事件 → 订阅者 setState」；假 React 不会自己
 * 跑订阅回调，所以测试要手动喂一次——顺带也钉住了事件名与「组件必须订阅」这件事。
 */
function broadcastRestartChanged(listeners) {
  const handlers = listeners
    .filter((item) => item.type === 'dsh-agent-control:restart-changed')
    .map((item) => item.handler)
  assert.ok(handlers.length > 0, '组件必须订阅 dsh-agent-control:restart-changed')
  // 真机里一次广播会送到**每一个**订阅者（设置页与浮层各一份），这里照做，
  // 否则「只喂了最后注册的那个」会让另一棵树停在旧状态，测出来的东西是假的。
  for (const handler of handlers) handler({ detail: restartApi().snapshot() })
}

test('设置页注册成 settings.section（list 槽位：id 必填、order 排在原生页之后、label 是 thunk）', () => {
  loaded.apply(makeContext())
  const entry = registrations.find((item) => item.name === 'settings.section')
  assert.ok(entry, '必须注册设置页槽位')
  assert.equal(entry.options.id, 'agent-control-restart', '槽位 id 用独立的一格，绝不顶掉原生页')
  assert.equal(entry.options.name, 'settings.section')
  // 原生页签顺序：account -10 / general 0 / models 10 / plugins 15 / agent-presets 20。
  assert.ok(entry.options.order > 20, '附加页要排在原生页之后')
  assert.equal('select' in entry.options, false, 'list 槽位不能用 select')
  assert.equal(typeof entry.options.label, 'function', 'label 用 thunk：宿主每次投影都重读，跟得上语言')
  const label = entry.options.label()
  assert.equal(typeof label, 'string')
  assert.ok(label.length > 0, '页签名不能是空串（导航上会是一行空白）')
  assert.equal(entry.options.label(), label, 'thunk 必须可以重复读取')
  assert.equal(typeof entry.component, 'function')
})

test('重启态机：idle → confirming → requested → shutting-down → starting → reconnecting → done', () => {
  const { initial, next, constants } = restartApi()
  assert.deepEqual(constants, { pollIntervalMs: 1000, timeoutMs: 120000, reconnectAfterMs: 8000 })

  let state = initial()
  assert.equal(state.phase, 'idle')

  state = next(state, { type: 'confirm' })
  assert.equal(state.phase, 'confirming')
  state = next(state, { type: 'submit' })
  assert.equal(state.phase, 'requested')
  state = next(state, { type: 'accepted', restartId: 'r-1', at: 100000 })
  assert.equal(state.phase, 'shutting-down')
  assert.equal(state.restartId, 'r-1')

  // 宿主还在应答，pending 里就是这次重启 ⇒ 仍然说「正在关闭」
  state = next(state, {
    type: 'status',
    at: 101000,
    payload: {
      ok: true,
      bootId: 'boot-old',
      pid: 100,
      pending: { restartId: 'r-1', createdAt: new Date(100000).toISOString() },
    },
  })
  assert.equal(state.phase, 'shutting-down')
  assert.equal(state.waitMs, 1000)

  // 连不上了：先 starting，久一点 reconnecting；全程没有错误
  state = next(state, { type: 'status-failed', at: 102000 })
  assert.equal(state.phase, 'starting')
  assert.equal(state.error, null, '★ 重启期间网络不通不是错误，不能渲染成红色失败')
  state = next(state, { type: 'status-failed', at: 105000 })
  assert.equal(state.phase, 'starting', '还没到分界点仍然说「正在启动」')
  assert.equal(state.failures, 2)
  state = next(state, { type: 'status-failed', at: 110000 })
  assert.equal(state.phase, 'reconnecting', '断连超过分界点改说「正在等待重新连上」')

  // 新进程回来了：bootId 变了 ⇒ done，等待时长定格
  state = next(state, {
    type: 'status',
    at: 111000,
    payload: { ok: true, bootId: 'boot-new', pid: 200, pending: null },
  })
  assert.equal(state.phase, 'done')
  assert.equal(state.bootId, 'boot-new')
  assert.equal(state.waitMs, 11000)
  assert.equal(state.error, null)
})

test('重启态机：120 秒还等不到新进程就进 failed（不无限转圈，也不假装成功）', () => {
  const { initial, next } = restartApi()
  let state = initial()
  for (const event of [
    { type: 'confirm' },
    { type: 'submit' },
    { type: 'accepted', restartId: 'r-2', at: 1000 },
  ]) {
    state = next(state, event)
  }

  state = next(state, { type: 'status-failed', at: 5000 })
  assert.equal(state.phase, 'starting', '等了 4 秒：还在启动')

  state = next(state, { type: 'status-failed', at: 121000 })
  assert.equal(state.phase, 'failed', '★ 满 120 秒必须落定成失败态')
  assert.equal(state.error?.code, 'RESTART_TIMEOUT')
  assert.equal(state.waitMs, 120000)
  // 落定之后再失败也不会乱跳（阶段已经是终态）
  assert.equal(next(state, { type: 'status-failed', at: 200000 }).phase, 'failed')
})

test('重启态机：重启进行中重复提交 / 重复点主按钮都被拒（引用相等 = 无动作、不重渲染）', () => {
  const { initial, next } = restartApi()
  let state = next(initial(), { type: 'confirm' })
  state = next(state, { type: 'submit' })
  const accepted = next(state, { type: 'accepted', restartId: 'r-3', at: 1000 })
  for (const event of [
    { type: 'submit' },
    { type: 'confirm' },
    { type: 'accepted', restartId: 'r-4', at: 2000 },
  ]) {
    assert.equal(next(accepted, event), accepted, `★ 重启进行中的 ${event.type} 必须原样返回`)
  }
  const watching = next(accepted, { type: 'status-failed', at: 3000 })
  assert.equal(next(watching, { type: 'submit' }), watching)
  assert.equal(next(watching, { type: 'cancel' }), watching, '等新进程期间不能被取消掉')
})

test('重启态机：被拒退回确认态并带上原因；取消 / 关掉提示 / 重置都回到 idle', () => {
  const { initial, next } = restartApi()
  let state = next(initial(), { type: 'confirm' })
  state = next(state, { type: 'submit' })
  state = next(state, { type: 'rejected', code: 'RESTART_BLOCKED', message: '另有 2 个会话在运行', at: 1000 })
  assert.equal(state.phase, 'confirming', '被拒不是「重启失败」：宿主还好好的，原因留在弹窗里')
  assert.equal(state.error?.code, 'RESTART_BLOCKED')
  assert.equal(state.error?.message, '另有 2 个会话在运行')

  const cancelled = next(state, { type: 'cancel' })
  assert.equal(cancelled.phase, 'idle')
  assert.equal(cancelled.error, null)

  // 连错误码都没有（请求根本没发出去）：也必须给重启自己的兜底码，不能落进删除的文案
  const noCode = next(next(next(initial(), { type: 'confirm' }), { type: 'submit' }), { type: 'rejected', at: 1 })
  assert.equal(noCode.error?.code, 'RESTART_REQUEST_FAILED')

  const failed = { ...initial(), phase: 'failed', error: { code: 'RESTART_TIMEOUT', message: '' } }
  assert.equal(next(failed, { type: 'dismiss' }).phase, 'idle', '失败提示要能关掉')
  const done = { ...initial(), phase: 'done' }
  assert.equal(next(done, { type: 'dismiss' }).phase, 'idle')
  assert.deepEqual(next(done, { type: 'reset' }), initial())
  // 认不出的事件原样返回（引用相等 ⇒ 不广播、不重渲染）
  assert.equal(next(state, { type: 'nonsense' }), state)
})

test('重启态机：第一次读到 bootId 只是「记下」；pending 一出现就跟着进重启中（模型发起的重启）', () => {
  const { initial, next } = restartApi()
  let state = next(initial(), {
    type: 'status',
    at: 1000,
    payload: { ok: true, bootId: 'boot-a', pid: 10, pending: null },
  })
  assert.equal(state.phase, 'idle', '第一次读到 bootId 不能被误判成「换了新进程」')
  assert.equal(state.bootId, 'boot-a')
  assert.equal(state.pid, 10)

  state = next(state, {
    type: 'status',
    at: 2000,
    payload: {
      ok: true,
      bootId: 'boot-a',
      pid: 10,
      pending: { restartId: 'r-9', state: 'scheduled', source: 'model', createdAt: new Date(1000).toISOString() },
    },
  })
  assert.equal(state.phase, 'shutting-down', '★ 别人的重启也要看得见（横幅靠这条）')
  assert.equal(state.restartId, 'r-9')
  assert.equal(state.acceptedAt, 1000, '用 pending.createdAt 当起点，等待秒数才不是编的')

  // 宿主万一没给 bootId：pid 变了同样能判出「换了进程」
  const legacy = next(
    { ...initial(), phase: 'reconnecting', pid: 10, acceptedAt: 1000 },
    { type: 'status', at: 3000, payload: { ok: true, pid: 11, pending: null } },
  )
  assert.equal(legacy.phase, 'done')
})

test('重启设置页：画出运行状态、阻塞项、危险态主按钮与「最近一次重启」', async (t) => {
  const browser = captureBrowser(t, () => okPayload({
    ok: true,
    version: '0.2.1-alpha.1-v1.1.0',
    bootId: 'boot1234567890',
    pid: 4242,
    startedAt: new Date(Date.now() - 125000).toISOString(),
    port: 3080,
    canRestart: true,
    blockers: { sessions: [{ sessionId: 'session-1', title: '正在跑长任务的会话', descendant: true }], jobs: 2 },
    pending: null,
    last: {
      restartId: 'r-1',
      ok: true,
      finishedAt: Date.now() - 60000,
      durationMs: 6200,
      source: 'ui',
      reason: '用户在设置页点了「重启 DSH」',
      resume: 'delivered',
    },
  }))
  restartApi().reset()
  loaded.apply(makeContext())
  const section = registrations.find((entry) => entry.name === 'settings.section')

  // 首帧：状态还没回来也必须画得出来（不能整页空白），并给一句「正在读取」
  const first = renderComponent(section.component, {})
  assert.notEqual(first, null, '拿不到状态也必须渲染')
  assert.ok(findByClass(first, 'dsh-agent-control-hint'), '没拿到状态时给一句提示')
  const main = findByClass(first, 'dsh-agent-control-danger')
  assert.ok(main, '主按钮必须画出来')
  assert.equal(main.type.name, 'Button', '用原生 Button（危险态靠 token 改写，不自造色值）')
  assert.equal(main.props.icon?.type?.name, 'IconRefreshOutlineRegular', '拿到原生图标就必须用上')
  assert.equal(main.props.disabled, false, '读不到 canRestart 时不预先禁用：让宿主裁决')

  // 挂载时那次请求会被节流跳过，这里强制拉一次并广播（模拟真机里的重渲染）
  await restartApi().poll({ force: true })
  await flush()
  broadcastRestartChanged(browser.listeners)
  const tree = renderUntilStable(section.component, {})
  const text = collectText(tree).join('\n')
  assert.ok(text.includes('0.2.1-alpha.1-v1.1.0'), '要显示版本')
  assert.ok(text.includes('4242'), '要显示进程号')
  assert.ok(text.includes('3080'), '要显示端口')
  assert.ok(text.includes('2 分 5 秒'), '要显示已运行时长')
  assert.ok(text.includes('boot1234…'), '★ bootId 只显示简写')
  assert.ok(text.includes('正在跑长任务的会话'), '★ 阻塞项要列出会话标题')
  assert.ok(text.includes('（子代理）'), '子代理会话要标出来')
  assert.ok(text.includes('后台任务：2'), '后台任务要给数量')
  assert.ok(text.includes('用户'), '最近一次重启要显示来源')
  assert.ok(text.includes('6 秒'), '要显示耗时')
  assert.ok(text.includes('已自动续上'), '要显示续作结果（三态之一）')
  assert.equal(findByClass(tree, 'dsh-agent-control-danger').props.disabled, false)
  restartApi().reset()
})

test('宿主说不能重启时：主按钮禁用，并原样显示它给出的原因', async (t) => {
  const browser = captureBrowser(t, () => okPayload({
    ok: true,
    bootId: 'boot-a',
    pid: 1,
    canRestart: false,
    unsupportedReason: '取不到启动规格：拿不到 dsh 的入口脚本',
  }))
  restartApi().reset()
  loaded.apply(makeContext())
  const section = registrations.find((entry) => entry.name === 'settings.section')
  renderComponent(section.component, {})
  await restartApi().poll({ force: true })
  await flush()
  broadcastRestartChanged(browser.listeners)
  const tree = renderUntilStable(section.component, {})
  assert.equal(findByClass(tree, 'dsh-agent-control-danger').props.disabled, true, '★ 不能重启时按钮必须禁用')
  assert.ok(
    collectText(tree).join('\n').includes('取不到启动规格：拿不到 dsh 的入口脚本'),
    '★ 必须原样显示宿主给的原因，不能自己编一句',
  )
  restartApi().reset()
})

test('主按钮只派发 request-restart，确认框由同一个 overlay 宿主渲染（不新开槽位）', async (t) => {
  const browser = captureBrowser(t, () => okPayload({ ok: true, bootId: 'boot-a', pid: 1, pending: null }))
  restartApi().reset()
  loaded.apply(makeContext())
  assert.equal(
    registrations.filter((entry) => entry.name === 'shell.overlay').length,
    1,
    '★ overlay 只能有一条注册：删除与重启共用同一个弹窗宿主',
  )
  const overlay = registrations.find((entry) => entry.name === 'shell.overlay')
  assert.equal(renderComponent(overlay.component, { t: (key) => key }), null, '闲着的时候什么都不渲染')
  const onRestartRequest = browser.listeners
    .find((item) => item.type === 'dsh-agent-control:request-restart')?.handler
  assert.equal(typeof onRestartRequest, 'function', '宿主必须监听 request-restart')

  // 设置页的主按钮：只派发意图，不改状态
  const section = registrations.find((entry) => entry.name === 'settings.section')
  const main = findByClass(renderComponent(section.component, {}), 'dsh-agent-control-danger')
  assert.ok(main, '设置页必须有危险态主按钮')
  dispatchedTypes.length = 0
  main.props.onClick()
  assert.deepEqual(dispatchedTypes, ['dsh-agent-control:request-restart'], '★ 按钮只派发重启请求')
  assert.equal(restartApi().snapshot().phase, 'idle', '派发本身不改状态')

  // 宿主收到请求 → 渲染确认框
  onRestartRequest()
  broadcastRestartChanged(browser.listeners)
  const opened = renderUntilStable(overlay.component, { t: (key) => key })
  const confirmBox = findElement(opened, (element) => element.type?.name === 'RiskConfirmation')
  assert.ok(confirmBox, '★ 确认框必须由同一个 overlay 宿主渲染')
  assert.equal(confirmBox.props.open, true)
  assert.equal(confirmBox.props.title, 'restart.dialog.title')
  const description = String(confirmBox.props.description ?? '')
  assert.ok(description.includes('restart.dialog.body'), '正文要写清会中断任务、页面会短暂不可用')
  assert.equal(confirmBox.props.disabled, false)
  assert.equal(restartApi().snapshot().phase, 'confirming')

  // 提交中：按钮显示进度并禁用（不允许重复提交），也不能取消掉
  restartApi().dispatch({ type: 'submit' })
  broadcastRestartChanged(browser.listeners)
  const submitting = renderUntilStable(overlay.component, { t: (key) => key })
  const submittingBox = findElement(submitting, (element) => element.type?.name === 'RiskConfirmation')
  assert.equal(submittingBox.props.disabled, true, '★ 提交中必须禁用确认按钮')
  assert.equal(submittingBox.props.confirmLabel, 'restart.dialog.working', '提交中要显示进度')
  submittingBox.props.onCancel()
  assert.equal(restartApi().snapshot().phase, 'requested', '★ 提交中不允许取消把阶段拉回去')
  restartApi().reset()
})

test('提交被拒：宿主的原因留在弹窗里，阶段退回确认态（绝不假装重启已经成功）', async (t) => {
  const browser = captureBrowser(t, (url) => {
    // ⚠️ `/restart/status` 也含 `/restart`，先判 status。
    if (!url.includes('/restart/status') && url.includes('/restart')) {
      return {
        ok: false,
        status: 409,
        json: async () => ({ ok: false, error: { code: 'RESTART_BLOCKED', message: '另有 2 个会话在运行' } }),
      }
    }
    return okPayload({
      ok: true,
      bootId: 'boot-a',
      pid: 1,
      canRestart: true,
      blockers: { sessions: [{ sessionId: 'session-2', title: '长任务会话' }], jobs: 0 },
      pending: null,
    })
  })
  restartApi().reset()
  loaded.apply(makeContext())
  const overlay = registrations.find((entry) => entry.name === 'shell.overlay')
  renderComponent(overlay.component, { t: (key) => key })
  await restartApi().poll({ force: true })
  await flush()

  const onRestartRequest = browser.listeners
    .find((item) => item.type === 'dsh-agent-control:request-restart')?.handler
  onRestartRequest()
  await restartApi().submit()
  await flush()

  const state = restartApi().snapshot()
  assert.equal(state.phase, 'confirming', '★ 被拒不是「重启失败」：宿主还好好的，弹窗留着')
  assert.equal(state.error?.code, 'RESTART_BLOCKED')

  broadcastRestartChanged(browser.listeners)
  const tree = renderUntilStable(overlay.component, { t: (key) => key })
  const confirmBox = findElement(tree, (element) => element.type?.name === 'RiskConfirmation')
  assert.ok(confirmBox, '被拒后弹窗必须还在')
  const description = String(confirmBox.props.description ?? '')
  assert.ok(description.includes('现在不能重启'), '★ 必须用 error.RESTART_BLOCKED 的文案（错误提示走插件自己的词表）')
  assert.ok(description.includes('另有 2 个会话在运行'), '★ 必须带上宿主给的原始原因')
  assert.ok(description.includes('长任务会话'), '弹窗里要带上阻塞项明细')
  restartApi().reset()
})

test('提交时网络就不通：说「重启请求没有发出去」，不能说成「删除失败」', async (t) => {
  const browser = captureBrowser(t, () => {
    throw new Error('Failed to fetch')
  })
  restartApi().reset()
  loaded.apply(makeContext())
  const overlay = registrations.find((entry) => entry.name === 'shell.overlay')
  // 不传 t：走插件自己的词表（中文），断言的才是用户真看到的文案。
  renderComponent(overlay.component, {})
  const onRestartRequest = browser.listeners
    .find((item) => item.type === 'dsh-agent-control:request-restart')?.handler
  assert.equal(typeof onRestartRequest, 'function', '宿主必须监听 request-restart')
  onRestartRequest()
  await restartApi().submit()
  await flush()
  const state = restartApi().snapshot()
  assert.equal(state.phase, 'confirming')
  assert.equal(state.error?.code, 'RESTART_REQUEST_FAILED', '★ 没有宿主错误码时用重启自己的兜底码')

  broadcastRestartChanged(browser.listeners)
  const tree = renderUntilStable(overlay.component, {})
  const confirmBox = findElement(tree, (element) => element.type?.name === 'RiskConfirmation')
  const description = String(confirmBox.props.description ?? '')
  assert.ok(description.includes('重启请求没有发出去'), '★ 文案必须是「重启」，不能落进删除的兜底文案')
  assert.ok(description.includes('Failed to fetch'), '原始信息不能吞掉')
  assert.ok(!description.includes('删除失败'), '★ 绝不能说成「删除失败」')
  restartApi().reset()
})

test('重启横幅：非阻塞卡片在重启期间显示，bootId 一变就收起并进 done（绝不自动刷新页面）', async (t) => {
  const reload = captureReload(t)
  const browser = captureBrowser(t, () => okPayload({ ok: true, bootId: 'boot-old', pid: 100, pending: null }))
  restartApi().reset()
  loaded.apply(makeContext())
  const overlay = registrations.find((entry) => entry.name === 'shell.overlay')
  renderComponent(overlay.component, { t: (key) => key })
  // 先让页面认下旧进程（否则第一次读到的 bootId 会被当成「就是它」）
  await restartApi().poll({ force: true })
  await flush()
  assert.equal(restartApi().snapshot().bootId, 'boot-old')

  restartApi().dispatch({ type: 'confirm' })
  restartApi().dispatch({ type: 'submit' })
  restartApi().dispatch({ type: 'accepted', restartId: 'r-1', at: Date.now() })
  restartApi().dispatch({ type: 'status-failed', at: Date.now() + 1000 })
  broadcastRestartChanged(browser.listeners)
  const running = renderUntilStable(overlay.component, { t: (key) => key })
  const banner = findByClass(running, 'dsh-agent-control-banner')
  assert.ok(banner, '★ 重启期间必须有横幅')
  assert.equal(banner.props.role, 'status')
  const card = findByClass(banner, 'dsh-agent-control-banner-card')
  assert.ok(card, '横幅是一张卡片（不是盖住整页的层）')
  assert.ok(
    collectText(card).join('\n').includes('restart.banner.wait'),
    '横幅要显示已等待秒数',
  )
  assert.equal(reload.reloads, 0, '★ 重启期间绝不自动刷新页面（SPIKE S4：页面会自己恢复）')

  // 新进程回来了：bootId 变了 ⇒ done，横幅收起
  restartApi().dispatch({
    type: 'status',
    at: Date.now() + 9000,
    payload: { ok: true, bootId: 'boot-new', pid: 200, pending: null },
  })
  assert.equal(restartApi().snapshot().phase, 'done')
  broadcastRestartChanged(browser.listeners)
  const settled = renderUntilStable(overlay.component, { t: (key) => key })
  assert.equal(findByClass(settled, 'dsh-agent-control-banner'), undefined, '★ bootId 变化后横幅必须收起')
  assert.equal(reload.reloads, 0, '★ 恢复靠页面自己重连，我们不刷它')
  restartApi().reset()
})

test('超时失败：横幅给失败态与手动刷新入口（刷新只由用户点）', async (t) => {
  const reload = captureReload(t)
  const browser = captureBrowser(t, () => {
    throw new Error('ECONNREFUSED')
  })
  restartApi().reset()
  loaded.apply(makeContext())
  const overlay = registrations.find((entry) => entry.name === 'shell.overlay')
  renderComponent(overlay.component, { t: (key) => key })
  restartApi().dispatch({ type: 'confirm' })
  restartApi().dispatch({ type: 'submit' })
  restartApi().dispatch({ type: 'accepted', restartId: 'r-5', at: 1000 })
  restartApi().dispatch({ type: 'status-failed', at: 2000 })
  assert.equal(restartApi().snapshot().phase, 'starting', '断连只是「正在启动」，不是错误')

  restartApi().dispatch({ type: 'status-failed', at: 121000 })
  assert.equal(restartApi().snapshot().phase, 'failed')
  broadcastRestartChanged(browser.listeners)
  const failed = renderUntilStable(overlay.component, { t: (key) => key })
  const card = findByClass(failed, 'dsh-agent-control-banner-card')
  assert.ok(card, '失败后横幅仍然可见（否则用户看不到失败与入口）')
  assert.ok(
    collectText(card).join('\n').includes('restart.banner.failedDetail'),
    '失败态要写清「连不上」与「怎么办」',
  )
  const refreshButton = findElement(
    failed,
    (element) => element.type?.name === 'Button' && element.children?.[0] === 'restart.refresh',
  )
  assert.ok(refreshButton, '★ 失败态必须给手动刷新入口')
  assert.equal(reload.reloads, 0, '给入口不等于自己刷新')
  refreshButton.props.onClick()
  assert.equal(reload.reloads, 1, '用户点了才刷新')
  restartApi().reset()
})

test('原生 Button / 刷新图标拿不到时有兜底，且兜底按钮仍然可点、可禁用', () => {
  const exposes = globalThis.window.__dshAgentControl
  assert.equal(exposes.usingNativeButton(), true, 'primitives 在的时候主按钮走原生 Button')
  const { FallbackButton, FallbackRefreshIcon } = exposes.fallbacks
  assert.equal(typeof FallbackButton, 'function')
  assert.equal(typeof FallbackRefreshIcon, 'function')

  const icon = FallbackRefreshIcon({ size: 16 })
  assert.equal(icon.type, 'svg', '兜底图标是内联 svg，不依赖任何包')
  assert.equal(icon.props.width, 16)

  let clicks = 0
  const button = FallbackButton({
    variant: 'primary',
    className: 'dsh-agent-control-danger',
    icon,
    onClick: () => { clicks += 1 },
    children: '重启 DSH',
  })
  assert.equal(button.type, 'button', '兜底必须是一个真正的 button，不是装作按钮的 div')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props.disabled, false)
  assert.match(button.props.className, /dsh-agent-control-button/, '兜底按钮带自己的类名（度量照抄原生）')
  assert.match(button.props.className, /dsh-agent-control-danger/, '危险态类名照旧传下去（token 改写在那里）')
  button.props.onClick()
  assert.equal(clicks, 1, '功能不能因为拿不到原生原语就丢')
  assert.equal(button.children[0], icon)
  assert.equal(button.children[1], '重启 DSH')

  const disabled = FallbackButton({ disabled: true, children: '正在重启…' })
  assert.equal(disabled.props.disabled, true, '禁用态要落到原生 disabled 上，不只是样式')
})

test('整段 bundle 在拿不到原生原语时仍然加载得起来，主按钮退回自带按钮（AGENTS 3.7）', async () => {
  // 这是「新增的每一处 require 解构」里最要紧的一条：`require` 失败不能让整个插件消失
  // （真发生过：界面上什么都不出现、也没有报错）。所以真的重新加载一次 bundle，
  // 让 primitives 直接抛错，再看注册与渲染是不是照常。
  const originalLoader = globalThis.window.__ModuleLoader__
  const originalExpose = globalThis.window.__dshAgentControl
  let fallbackApply
  globalThis.window.__ModuleLoader__ = {
    load(spec) {
      const exports = spec.factory((id) => {
        if (id === 'react') return fakeReact
        throw new Error(`拿不到模块：${id}`)
      })
      fallbackApply = exports.apply
    },
  }
  try {
    const url = `${pathToFileURL(path.join(process.cwd(), 'client.js')).href}?no-primitives`
    await import(url)
    assert.equal(typeof fallbackApply, 'function', '拿不到原生原语也必须加载得起来')

    fallbackApply(makeContext())
    const section = registrations.find((entry) => entry.name === 'settings.section')
    assert.ok(section, '设置页照常注册')
    const tree = renderComponent(section.component, {})
    assert.notEqual(tree, null, '照常渲染')
    const main = findByClass(tree, 'dsh-agent-control-danger')
    assert.ok(main, '主按钮照常画出来')
    assert.equal(main.type, 'button', '★ 退回自带 button（不是崩掉，也不是空白）')
    assert.equal(
      globalThis.window.__dshAgentControl.usingNativeButton(),
      false,
      '排障抓手要如实报告这次用的是兜底按钮',
    )
    assert.match(main.props.className, /dsh-agent-control-button/, '兜底按钮带自己的类名（度量照抄原生）')
    assert.equal(main.children[0].type?.name, 'FallbackRefreshIcon', '图标也退回自带的那个（内联 SVG）')
    assert.equal(main.children[1], '重启 DSH', '文案照旧')
  } finally {
    globalThis.window.__ModuleLoader__ = originalLoader
    globalThis.window.__dshAgentControl = originalExpose
  }
})

