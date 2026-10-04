/**
 * dsh-agent-control — 浏览器端 bundle。
 *
 * 经 `window.__ModuleLoader__.load({ id: 'dsh-agent-control', factory })` 注册；
 * 不用 JSX、不 import CSS，样式只用 DSH 设计 token（`--dsw-*`）。
 *
 * 界面只做两件事：把破坏性操作摆到用户够得着的地方，以及在真正执行前问清楚。
 * 校验与失败语义都在 host 端（`src/`）；这里不替 host 做判断，也不假装成功——
 * 失败一律把 host 返回的原因原样显示出来。
 *
 * 常量必须与 `src/shared.mjs` 保持一致（浏览器 bundle 与 host 模块不共享模块图）。
 */
;(function bootstrap() {
  const PLUGIN_ID = 'dsh-agent-control'
  const API = {
    sessions: '/api/agent-control/sessions',
    sessionDelete: '/api/agent-control/session/delete',
    turns: '/api/agent-control/turns',
    turnDelete: '/api/agent-control/turn/delete',
  }
  const LOCALE_NS = 'agent-control'
  /** 自定义事件：按钮只派发目标，弹窗统一监听。 */
  const REQUEST_EVENT = 'dsh-agent-control:request-delete'
  /**
   * 自定义事件：某会话的「已删轮次」变了。
   *
   * ⚠️ 必须有这个广播。踩过的坑：删除成功后只清了 `deletedTurnsCache`，
   * 但没有**任何东西会再去读它**——标记组件的 `useEffect` 依赖是 `[turn, sessionId]`，
   * 删除发生在这两个值之外，所以它既不重跑，也没人通知它。
   * 结果是「服务端删掉了、界面还显示着，刷新页面才对」。
   */
  const TURNS_CHANGED_EVENT = 'dsh-agent-control:turns-changed'

  /**
   * 删除一轮时，该轮各行**收起折叠**的时长。
   *
   * 时序是：先量出像素高度 → 下一帧开始过渡 → 过渡结束才 `display: none`。
   * 期间立刻带上 `hidden` 的语义（`aria-hidden`），只是视觉收尾延后。
   */
  const TURN_FADE_MS = 240

  /**
   * 一轮里多行之间的收起间隔。
   *
   * 三行（问题 / 回复 / 操作条）同时收起会缩成一团；各延后这么多毫秒，看起来才是
   * 「自上而下卷起来」。
   */
  const TURN_FADE_STAGGER_MS = 50

  const ENTRY = {
    sessionMenu: 'agent-control-session-menu',
    turnButton: 'agent-control-turn-delete',
    turnMarker: 'agent-control-turn-marker',
    dialog: 'agent-control-dialog',
  }

  /**
   * 菜单项兜底样式（仅在原生 `MenuItemButton` 拿不到时使用）。
   *
   * 度量抄自原语库 `Menu.module.css` 的 `.item` / `.danger`：最小高度 34、内边距 6×8、
   * 13px/20px 字、间距 6、圆角 `--dsw-radius-md`、危险色 `--dsw-alias-state-error-primary`。
   * 正常路径不会用到它——原生行才是「与其它按钮同尺寸」的保证。
   */
  const MENU_ITEM_FALLBACK_STYLE = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 34,
    padding: '6px 8px',
    border: 'none',
    borderRadius: 'var(--dsw-radius-md, 8px)',
    background: 'transparent',
    color: 'var(--dsw-alias-state-error-primary, #e5484d)',
    font: 'inherit',
    fontSize: 13,
    lineHeight: '20px',
    textAlign: 'left',
    cursor: 'pointer',
  }

  /**
   * 回复操作条里的图标按钮样式。
   *
   * 度量抄自 `dsh-client-ui-chat` 的 `MessageIconActions.module.css` 的 `.action`
   * （28×28、内边距 6、`--dsw-radius-sm`、tertiary 色，悬停换 `interactive-bg-hover` 与 secondary 色）。
   * 悬停与禁用态是伪类，内联样式表达不了，所以注入一段带本插件前缀的样式表，见 `ensureStyles`。
   */
  const ACTION_CLASS = 'dsh-agent-control-action'
  const STYLE_TAG_ID = 'dsh-agent-control/styles'
  const STYLE_CSS = [
    `.${ACTION_CLASS}{display:inline-flex;align-items:center;justify-content:center;flex:none;`
      + 'box-sizing:border-box;width:calc(28px + var(--dsh-content-font-delta,0px));'
      + 'height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:none;'
      + 'border-radius:var(--dsw-radius-sm);background:transparent;'
      + 'color:var(--dsw-alias-label-tertiary);cursor:pointer}',
    `.${ACTION_CLASS} svg{width:calc(17px + var(--dsh-content-font-delta,0px));`
      + 'height:calc(17px + var(--dsh-content-font-delta,0px))}',
    `.${ACTION_CLASS}:hover{background:var(--dsw-alias-interactive-bg-hover);`
      + 'color:var(--dsw-alias-label-secondary)}',
    `.${ACTION_CLASS}:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,`
      + 'var(--dsw-alias-state-business-primary));outline-offset:1px}',
    `.${ACTION_CLASS}[data-unavailable]{cursor:default;opacity:.4}`,
    `.${ACTION_CLASS}[data-unavailable]:hover{color:var(--dsw-alias-label-tertiary);background:none}`,
  ].join('')

  /** 注入一次样式表；没有 document（离线测试）或已注入时什么都不做。 */
  function ensureStyles() {
    if (typeof document === 'undefined' || document === null) return
    if (document.querySelector?.(`style[data-plugin-css="${STYLE_TAG_ID}"]`) != null) return
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = STYLE_TAG_ID
    tag.textContent = STYLE_CSS
    document.head?.appendChild(tag)
  }

  /** 原生图标拿不到时的垃圾桶（内联 SVG，不依赖任何包）。 */
  function FallbackTrashIcon(props) {
    const size = props?.size ?? 16
    return React.createElement(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
      },
      React.createElement('path', { d: 'M3 4.5h10' }),
      React.createElement('path', { d: 'M6.5 4.5V3h3v1.5' }),
      React.createElement('path', { d: 'M4.5 4.5 5.2 13h5.6l0.7-8.5' }),
      React.createElement('path', { d: 'M6.8 7v3.4M9.2 7v3.4' }),
    )
  }

  /**
   * 原生 `RiskConfirmation` 拿不到时的替代确认框。
   *
   * 保留最要紧的那条契约：**确认按钮在勾选之前不可用**。它不是原生控件的替代品
   * （没有 portal、没有焦点陷阱），但足以让破坏性操作仍然需要显式确认。
   */
  function FallbackRiskConfirmation(props) {
    if (props?.open !== true) return null
    const disabled = props.disabled === true || props.acknowledged !== true
    return React.createElement(
      'div',
      { style: FALLBACK_OVERLAY_STYLE, role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
      React.createElement(
        'div',
        { style: FALLBACK_CARD_STYLE },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, props.title),
        React.createElement(
          'div',
          { style: FALLBACK_BODY_STYLE },
          String(props.description ?? '').split('\n\n').map((line, index) => React.createElement('p', { key: index, style: { margin: '0 0 8px' } }, line)),
        ),
        React.createElement(
          'label',
          { style: FALLBACK_ACK_STYLE },
          React.createElement('input', {
            type: 'checkbox',
            checked: props.acknowledged === true,
            disabled: props.disabled === true,
            onChange: (event) => props.onAcknowledgedChange?.(event.target.checked),
          }),
          props.acknowledgeLabel,
        ),
        React.createElement(
          'div',
          { style: FALLBACK_FOOTER_STYLE },
          React.createElement('button', { type: 'button', onClick: props.onCancel, disabled: props.disabled === true, style: FALLBACK_CANCEL_STYLE }, props.cancelLabel),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: props.onConfirm,
              disabled,
              'data-agent-control-confirm': '1',
              style: disabled ? { ...FALLBACK_CONFIRM_STYLE, opacity: 0.5, cursor: 'default' } : FALLBACK_CONFIRM_STYLE,
            },
            props.confirmLabel,
          ),
        ),
      ),
    )
  }

  const FALLBACK_OVERLAY_STYLE = {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,.45)',
    zIndex: 1000,
  }
  const FALLBACK_CARD_STYLE = {
    width: 'min(520px, calc(100vw - 48px))',
    padding: 20,
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-elevated, #1f1f22)',
    color: 'var(--dsw-alias-label-primary, #f2f2f4)',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
    boxShadow: '0 12px 40px rgba(0,0,0,.35)',
  }
  const FALLBACK_BODY_STYLE = { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #c6c6cc)' }
  const FALLBACK_ACK_STYLE = { display: 'flex', gap: 8, alignItems: 'flex-start', margin: '12px 0 16px', fontSize: 13, cursor: 'pointer' }
  const FALLBACK_FOOTER_STYLE = { display: 'flex', justifyContent: 'flex-end', gap: 8 }
  const FALLBACK_CANCEL_STYLE = { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))', background: 'transparent', color: 'inherit', cursor: 'pointer' }
  const FALLBACK_CONFIRM_STYLE = { padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--dsw-alias-state-error-primary, #e5484d)', color: '#fff', cursor: 'pointer' }

  const zh = {
    'menu.deleteSession': '删除会话…',
    'button.deleteTurn': '删除这一轮',
    'button.deleteTurnBusy': '任务运行中，无法删除',
    'dialog.sessionTitle': '删除这个会话？',
    'dialog.turnTitle': '删除这一轮对话？',
    'dialog.sessionBody': '将永久删除这个会话：日志目录、投影缓存、工作区记账，以及它派生的子代理会话会一起移除，无法恢复。',
    'dialog.turnBody': '将从模型的上下文中移除这一轮（问题、回复与该轮的工具记录），原位置只留下一句「这里有一轮对话已被删除」的提示。会话本身、其它轮次与日志都保留——被删内容仍留在日志与附件里，这不是彻底清除。',
    'dialog.ackSession': '我明白这个会话会被永久删除',
    'dialog.ackTurn': '我明白这一轮会从模型上下文中移除',
    'dialog.cancel': '取消',
    'dialog.close': '关闭',
    'dialog.confirm': '删除',
    'dialog.working': '正在删除…',
    'dialog.resolving': '正在确认目标…',
    'error.SESSION_LIVE': '这个会话在本次启动后打开过，仍驻留在内存里，现在删不了——切换到别的会话并不会释放它（DSH 没有卸载会话的公开接口）。请重启 dsh web，重启后不要点开它，直接从侧栏菜单删除。',
    'error.TURN_NOT_CLOSED': '这一轮还没有结束，现在删会破坏正在写入的内容。',
    'error.TURN_COMPACTED': '这一轮已被压缩或不再连续，无法单独删除。',
    'error.AGENT_BUSY': '会话正忙（任务正在运行或正在压缩上下文），这次什么都没有改动。请等它结束后再试。',
    'error.TARGET_NOT_FOUND': '目标已经不存在了。',
    'error.INVALID_REQUEST': '请求被拒绝：参数不合法。',
    'error.DELETE_FAILED': '宿主拒绝了这次删除',
    'error.generic': '删除失败',
  }

  const en = {
    'menu.deleteSession': 'Delete session…',
    'button.deleteTurn': 'Delete this turn',
    'button.deleteTurnBusy': 'Running — cannot delete',
    'dialog.sessionTitle': 'Delete this session?',
    'dialog.turnTitle': 'Delete this turn?',
    'dialog.sessionBody': 'The session is removed for good: its log directory, projection cache, workspace accounting, and the subagent sessions it spawned all go with it. This cannot be undone.',
    'dialog.turnBody': 'This removes the turn (question, reply, and its tool records) from the model context, leaving only a short "a turn was deleted here" note in its place. The session, other turns, and the log stay — the deleted content still exists in the log and attachments, so this is not a secure erase.',
    'dialog.ackSession': 'I understand this session will be permanently deleted',
    'dialog.ackTurn': 'I understand this turn will leave the model context',
    'dialog.cancel': 'Cancel',
    'dialog.close': 'Close',
    'dialog.confirm': 'Delete',
    'dialog.working': 'Deleting…',
    'dialog.resolving': 'Resolving the target…',
    'error.SESSION_LIVE': 'This session has been opened since DSH started and is still resident in memory, so it cannot be deleted now. Switching away does not release it (DSH exposes no public way to unload a session). Restart dsh web, then delete it from the sidebar menu without opening it.',
    'error.TURN_NOT_CLOSED': 'This turn has not finished yet; deleting it would break content still being written.',
    'error.TURN_COMPACTED': 'This turn has been compacted or is no longer contiguous, so it cannot be deleted alone.',
    'error.AGENT_BUSY': 'The session is busy (a task is running or context is being compacted), so nothing was changed. Try again once it finishes.',
    'error.TARGET_NOT_FOUND': 'The target no longer exists.',
    'error.INVALID_REQUEST': 'The request was rejected: invalid arguments.',
    'error.DELETE_FAILED': 'The host refused this deletion',
    'error.generic': 'Deletion failed',
  }

  /** 运行时拿到的服务与依赖（factory 注入）。 */
  let React
  let IconTrashOutlineRegular
  let RiskConfirmation
  /** 原生菜单行 / 气泡提示；拿不到时为 undefined，组件退回自带样式。 */
  let MenuItemButton
  let Tooltip
  let localeService
  let sessionsService

  /** 每个会话已删除的轮次：`sessionId -> Promise<number[]>`，避免每个标记各拉一次。 */
  const deletedTurnsCache = new Map()

  function fallbackText(key) {
    const lang = String(navigator.languages?.[0] ?? navigator.language ?? 'zh').toLowerCase()
    const dict = lang.startsWith('en') ? en : zh
    return dict[key] ?? key
  }

  function translate(key) {
    if (localeService !== undefined) {
      const text = localeService.translate(LOCALE_NS, key)
      if (typeof text === 'string' && text !== key) return text
    }
    return fallbackText(key)
  }

  /** host 的错误码 → 能读懂的一句话；没有码就带上原始信息，不吞。 */
  function describeError(error) {
    const code = error?.code
    if (typeof code === 'string') {
      const key = `error.${code}`
      const text = translate(key)
      if (text !== key) return error?.message ? `${text}（${error.message}）` : text
    }
    return error?.message ? `${translate('error.generic')}：${error.message}` : translate('error.generic')
  }

  /** 调 host 接口；非 2xx 或 `ok !== true` 一律抛错（带 host 给的 code）。 */
  async function callHost(url, options) {
    const response = await fetch(url, options)
    let payload
    try {
      payload = await response.json()
    } catch {
      throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'DELETE_FAILED' })
    }
    if (!response.ok || payload?.ok !== true) {
      const info = payload?.error ?? {}
      throw Object.assign(new Error(info.message ?? `HTTP ${response.status}`), { code: info.code })
    }
    return payload
  }

  function requestDelete(target) {
    window.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: target }))
  }

  /**
   * 组件在本函数里创建。
   *
   * 这样模块初始化阶段**不碰任何 hooks**：`React.useState(...)` 在 IIFE 顶层求值会
   * 直接抛错，整个 bundle 加载失败（一次真实踩过的写法）。参数化之后组件依赖
   * `react` 而不是全局，也便于离线测试。
   */
  function components(react) {
    const useCallback = react.useCallback
    const useEffect = react.useEffect
    const useRef = react.useRef
    const useState = react.useState

    /** 会话行「…」菜单里的删除项。 */
    const SessionMenuDelete = (props) => {
      const t = props.t ?? translate
      const closeMenu = props.useMenuOpenState?.()?.[1]
      const onClick = useCallback(() => {
        closeMenu?.(false)
        requestDelete({
          kind: 'session',
          sessionId: props.sessionId,
          title: props.displayTitle || props.sessionId,
        })
      }, [closeMenu, props.sessionId, props.displayTitle])
      const label = t('menu.deleteSession')
      const icon = react.createElement(IconTrashOutlineRegular, { size: 14 })
      // 正常路径：原生菜单行——与置顶 / 重命名 / 分叉 / 归档同一套度量与悬停态，
      // 危险色与危险悬停底由 `danger` 给出，前面带一条分组细线（与普通操作分开）。
      if (MenuItemButton !== undefined) {
        return react.createElement(MenuItemButton, { icon, danger: true, separatorBefore: true, onSelect: onClick }, label)
      }
      return react.createElement(
        'button',
        { type: 'button', role: 'menuitem', onClick, style: MENU_ITEM_FALLBACK_STYLE },
        icon,
        label,
      )
    }

    /** 已结束的 assistant 回复旁的删除按钮（运行中禁用，host 端也会再拦一次）。 */
    const TurnDeleteAction = (props) => {
      const t = props.t ?? translate
      const running = props.useSession?.((state) => state?.running) === true
      const { messageId, sessionId } = props
      const onClick = useCallback(() => {
        if (running || messageId === undefined || sessionId === undefined) return
        requestDelete({ kind: 'turn', sessionId, assistantMessageId: String(messageId) })
      }, [running, messageId, sessionId])
      const label = running ? t('button.deleteTurnBusy') : t('button.deleteTurn')
      // 与同一操作条里的「复制 / 分叉」同款：28×28 图标按钮 + 底部气泡提示（不用浏览器自带的 title）。
      const buttonProps = {
        type: 'button',
        className: ACTION_CLASS,
        'aria-label': label,
        'aria-disabled': running ? 'true' : undefined,
        'data-unavailable': running ? 'true' : undefined,
        onClick: running ? undefined : onClick,
      }
      const icon = react.createElement(IconTrashOutlineRegular, {})
      // 气泡提示拿不到时退回浏览器自带的 title。
      if (Tooltip === undefined) return react.createElement('button', { ...buttonProps, title: label }, icon)
      return react.createElement(Tooltip, { label, side: 'bottom' }, react.createElement('button', buttonProps, icon))
    }

    /**
     * 已删除轮次的隐藏标记。
     *
     * 删除的是「模型可见面」，而界面渲染的是 append-only 日志，所以那一轮在界面上
     * 仍然会画出来。这里用一个隐藏节点把整轮的行藏掉，让界面和模型看到的一致。
     */
    const DeletedTurnMarker = (props) => {
      const turn = props.turn?.turn
      const sessionId = props.sessionId
      const ref = useRef(null)

      useEffect(() => {
        if (turn === undefined || sessionId === undefined || ref.current === null) return undefined
        let cancelled = false
        let restore = () => {}
        let observer
        /** 跨多次同步复用：已经藏起来的行，避免反复播放淡出。 */
        const hiddenRows = new Set()
        /** 这一轮当前是否处于「已删」状态。 */
        let deleted = false
        /** 已经播过淡出的行，不再重复播放。 */
        let animated = false

        /**
         * 按最新结果同步一次。
         *
         * `animate` 只在「从没删到删除」的那一次为真；后续同步（例如 MutationObserver
         * 因为新内容插入而触发）不重播动画，否则每次渲染都会闪一次。
         */
        const sync = (animate) => {
          if (cancelled || ref.current === null) return
          restore = syncTurnRows(ref.current, turn, { deleted, animate, hidden: hiddenRows }).restoreAll
          if (deleted) animated = true
          // 只要处于「已删」就要盯着列表：后续重新渲染 / 滚动出来的行同样得藏。
          // ⚠️ 早期只在「页面加载时就已删」那条路径上装观察器，于是「刚删掉」的那一轮
          // 一旦被重新渲染就又露出来了。
          if (deleted) watchRows()
          else unwatchRows()
        }

        const watchRows = () => {
          if (observer !== undefined || cancelled || ref.current === null) return
          if (typeof MutationObserver !== 'function') return
          const list = ref.current.closest?.('[data-chat-flow]') ?? globalThis.document?.body
          if (list === undefined || list === null) return
          observer = new MutationObserver(() => sync(false))
          observer.observe(list, { childList: true, subtree: true })
        }

        const unwatchRows = () => {
          observer?.disconnect()
          observer = undefined
        }

        // 删除成功后弹窗会广播这个事件；标记靠它才知道要重新判断。
        const onTurnsChanged = (event) => {
          if (event?.detail?.sessionId !== undefined && event.detail.sessionId !== sessionId) return
          // 同一次广播会送到这个会话的**每一个**标记。只让第一个收到的让缓存失效，
          // 其余复用它刚发起的那次请求——否则每个标记都清掉前一个刚填好的缓存，
          // N 轮对话一次删除就是 N 次 GET /turns。
          invalidateOnce(event, sessionId)
          resync()
        }
        window.addEventListener(TURNS_CHANGED_EVENT, onTurnsChanged)

        const resync = async () => {
          if (cancelled) return
          const turns = await loadDeletedTurns(sessionId)
          if (cancelled || ref.current === null) return
          const nextDeleted = turns.includes(turn)
          // 只有「本来没删、现在删了」才播动画。
          const shouldAnimate = nextDeleted && !deleted && !animated
          deleted = nextDeleted
          sync(shouldAnimate)
        }

        const conceal = async () => {
          const turns = await loadDeletedTurns(sessionId)
          if (cancelled || ref.current === null) return
          deleted = turns.includes(turn)
          if (!deleted) return
          // 页面加载时就已经是删除状态：直接隐藏，不播动画（否则每次进会话都在动）。
          sync(false)
        }
        conceal()

        return () => {
          cancelled = true
          window.removeEventListener(TURNS_CHANGED_EVENT, onTurnsChanged)
          unwatchRows()
          restore()
        }
      }, [turn, sessionId])

      if (turn === undefined) return null
      return react.createElement('span', {
        ref,
        'data-agent-control-deleted-turn': String(turn),
        hidden: true,
      })
    }

    /** 两类删除共用的确认弹窗；确认前必须显式勾选。 */
    const DeleteDialog = (props) => {
      const t = props.t ?? translate
      const [target, setTarget] = useState(null)
      const [acknowledged, setAcknowledged] = useState(false)
      const [busy, setBusy] = useState(false)
      const [resolving, setResolving] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        const onRequest = (event) => {
          setAcknowledged(false)
          setError(null)
          setBusy(false)
          setResolving(false)
          setTarget(event.detail ?? null)
        }
        window.addEventListener(REQUEST_EVENT, onRequest)
        return () => window.removeEventListener(REQUEST_EVENT, onRequest)
      }, [])

      const close = useCallback(() => {
        if (busy) return
        setTarget(null)
        setError(null)
      }, [busy])

      const confirm = useCallback(async () => {
        if (target === null || busy) return
        setBusy(true)
        setError(null)
        try {
          if (target.kind === 'session') {
            setResolving(true)
            await deleteSession(target)
            setResolving(false)
            refreshSessionList()
          } else {
            await callHost(API.turnDelete, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                sessionId: target.sessionId,
                assistantMessageId: target.assistantMessageId,
              }),
            })
            announceTurnsChanged(target.sessionId)
          }
          setTarget(null)
        } catch (failure) {
          // 轮次删除失败也可能已经改变了模型可见面（例如墓碑已追加、只是没落盘），
          // 让标记按服务端的真实答案重新判断一次，界面与模型才一致。
          if (target.kind !== 'session') announceTurnsChanged(target.sessionId)
          setError(describeError(failure))
        } finally {
          setBusy(false)
          setResolving(false)
        }
      }, [target, busy])

      if (target === null) return null
      const isSession = target.kind === 'session'
      const lines = [describeTarget(target)]
      lines.push(isSession ? t('dialog.sessionBody') : t('dialog.turnBody'))
      if (resolving) lines.push(t('dialog.resolving'))
      if (error !== null) lines.push(`⚠ ${error}`)

      return react.createElement(RiskConfirmation, {
        open: true,
        title: isSession ? t('dialog.sessionTitle') : t('dialog.turnTitle'),
        description: lines.join('\n\n'),
        acknowledgeLabel: isSession ? t('dialog.ackSession') : t('dialog.ackTurn'),
        cancelLabel: t('dialog.cancel'),
        closeLabel: t('dialog.close'),
        confirmLabel: busy ? t('dialog.working') : t('dialog.confirm'),
        acknowledged,
        disabled: busy,
        onAcknowledgedChange: setAcknowledged,
        onCancel: close,
        onConfirm: confirm,
      })
    }

    return { SessionMenuDelete, TurnDeleteAction, DeletedTurnMarker, DeleteDialog }
  }

  /**
   * 弹窗正文里的目标描述。
   *
   * ⚠️ 别在这里编造轮次号。按钮所在的槽位（`conversation.chat.assistant-actions`）只给到
   * 消息 id，拿不到轮次——早期版本于是渲染成 `turn ?`，既难看又像是在说「第 ? 轮」。
   * 真正的轮次号由宿主在删除后返回（界面不显示），服务端也能用 `/turns` 查。
   * 目标本来就是靠「点了哪条回复」确定的，这里只要把删的是哪一条指认清楚。
   */
  function describeTarget(target) {
    if (target.kind === 'session') {
      return target.title ? `${target.title}\n${target.sessionId}` : String(target.sessionId)
    }
    return `选中的这条回复\n${target.assistantMessageId}`
  }

  /**
   * 让某会话的轮次缓存失效，并**广播**出去——标记组件靠这个事件才会重新判断。
   * 只清缓存不广播是不够的：没有任何组件会因此重跑（见 TURNS_CHANGED_EVENT 的说明）。
   */
  function announceTurnsChanged(sessionId) {
    deletedTurnsCache.delete(sessionId)
    window.dispatchEvent(new CustomEvent(TURNS_CHANGED_EVENT, { detail: { sessionId } }))
  }

  /** 已经让缓存失效过的广播事件（同一次广播只失效一次）。 */
  const invalidatedEvents = new WeakSet()

  function invalidateOnce(event, sessionId) {
    if (event !== null && typeof event === 'object') {
      if (invalidatedEvents.has(event)) return
      invalidatedEvents.add(event)
    }
    deletedTurnsCache.delete(sessionId)
  }

  /** 会话 id 的两种拼写（裸 id 与 `session-<id>`），与 `src/shared.mjs` 的 sessionDirNames 一致。 */
  function sessionIdVariants(sessionId) {
    const id = String(sessionId ?? '')
    return id.startsWith('session-') ? [id, id.slice('session-'.length)] : [id, `session-${id}`]
  }

  /**
   * 删除会话。
   *
   * 先重新确认目标仍然存在、且不是活动会话——这样「找不到」与「还活着」都在弹窗里
   * 说清楚，而不是让用户对着一个笼统的失败猜。host 端仍会独立校验（不信任前端）。
   */
  async function deleteSession(target) {
    const listed = await callHost(API.sessions)
    // 两种拼写都认：列表里只剩磁盘目录的会话行用的是去掉前缀的 id，而侧栏给的可能带前缀。
    const variants = sessionIdVariants(target.sessionId)
    const known = (listed.sessions ?? []).find((row) => variants.includes(row.sessionId))
    if (known === undefined) {
      // message 留空：文案已经由错误码给出，不要再在括号里拼一句英文。
      throw Object.assign(new Error(''), { code: 'TARGET_NOT_FOUND' })
    }
    if (known.live === true) {
      throw Object.assign(new Error(''), { code: 'SESSION_LIVE' })
    }
    await callHost(API.sessionDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: target.sessionId }),
    })
  }

  /** 删除会话后刷新侧栏列表；服务不可用时退回整页刷新（宁可重载，也不留过时列表）。 */
  function refreshSessionList() {
    const service = sessionsService
    if (service !== undefined && typeof service.refresh === 'function') {
      try {
        service.refresh()
        return
      } catch {
        // 落到整页刷新。
      }
    }
    window.location.reload()
  }

  /**
   * 拉取（并缓存）某会话已删除的轮次；失败就当没有，界面不因此报错。
   *
   * ⚠️ 失败**不进缓存**：早期版本把 `.catch(() => [])` 的结果也缓存下来，一次临时的网络错误
   * 就让这个会话在整页刷新之前都不再隐藏任何已删轮次。
   */
  function loadDeletedTurns(sessionId) {
    const cached = deletedTurnsCache.get(sessionId)
    if (cached !== undefined) return cached
    const pending = callHost(`${API.turns}?sessionId=${encodeURIComponent(sessionId)}`)
      .then((payload) => (Array.isArray(payload.turns) ? payload.turns : []))
      .catch(() => {
        if (deletedTurnsCache.get(sessionId) === pending) deletedTurnsCache.delete(sessionId)
        return []
      })
    deletedTurnsCache.set(sessionId, pending)
    return pending
  }

  /**
   * 把某一轮的行按「当前是否已删」同步一遍。
   *
   * ## 为什么按 `data-chat-turn` 找，而不是顺着兄弟节点爬
   *
   * DOM 是别人渲染的，我们只能读它给出的属性。已核对的真实契约（`dsh-client-ui-chat`
   * 的 `ChatNodeSeat`）：
   *
   * ```js
   * "data-chat-flow-kind": routedNode.kind,  // 'user' / 'turn-process' / 'turn-tail' / …
   * "data-chat-turn": turn,                  // ← 这一行**属于哪一轮**
   * "data-turn-tail": data.turn              // 只有该轮的尾巴行有
   * ```
   *
   * `data-chat-turn` 直接回答了「这一行属于哪一轮」，所以只需要在一个容器里取
   * **所有** `[data-chat-turn="N"]`，不需要推断边界。
   *
   * ⚠️ 这里踩过一个真机 bug（用户报「删第二句，第一句也没了」）：早期实现从尾巴行
   * 往前逐个 `previousElementSibling`，用 `cursor.querySelector('[data-chat-flow-kind="turn-tail"]')`
   * 判断「是否到了上一轮」。那个判断是错的——`cursor` 往上走到容器/分组时，其后代里
   * 当然有 turn-tail，于是循环一路吃到根部，**把更早的所有轮次一起隐藏**。
   * 兄弟遍历还依赖「同一层」这个没被保证过的前提，分组渲染一变就会越界。
   *
   * **找不到任何匹配行时什么都不隐藏**：宁可界面上留着（模型那边已经看不到了），
   * 也不能冒险多藏——多藏是用户看得见的错误，少藏只是界面滞后。
   *
   * ## 为什么不是「先恢复再隐藏」
   *
   * 早先的实现每次同步都先 `restore()` 再隐藏。于是同步一来（删除成功、
   * 或 MutationObserver 触发），已经藏好的行会先**重新显示一帧**再被藏回去——
   * 用户看到的就是「删掉之后页面闪一下」。
   *
   * 现在把「恢复」和「隐藏」收在一次遍历里：**只为「已不再被删的行」恢复可见**，
   * 其余保持原状。这样没有任何一帧会露出不该露的内容。
   *
   * ## 淡出
   *
   * `animate` 为真时，新藏起来的行会先做一段淡出再真正 `display: none`，看起来是
   * 「消失」而不是「瞬间跳走」。期间**立刻**带上 `hidden` 属性（无障碍语义即时生效），
   * 只是用内联样式把视觉收尾延后——`hidden` 的 `display: none` 会被内联样式盖住，
   * 所以那一帧不会闪。
   *
   * @param {Element} marker 本轮 `turnTail` 槽位里渲染出来的隐藏标记。
   * @param {number} turn 轮次号。
   * @param {{ deleted: boolean, animate?: boolean, hidden?: Set<Element> }} options
   *   `deleted`：这一轮当前是否处于「已删」状态。
   *   `animate`：是否播放淡出（只在真正删除的那一次为真）。
   *   `hidden`：跨多次同步复用的「已经藏起来了」集合。
   * @returns {{ restoreAll: () => void }} 把这一轮恢复可见。
   */
  function syncTurnRows(marker, turn, options) {
    const hidden = options.hidden ?? new Set()
    const restoreAll = () => {
      for (const element of [...hidden]) {
        // 归属已经被别人接管（或已经清掉）就交还给对方处理。
        if (element.dataset.agentControlTurn !== String(turn)) {
          hidden.delete(element)
          continue
        }
        cancelRowFade(element)
        element.hidden = false
        delete element.dataset.agentControlTurn
        hidden.delete(element)
      }
    }

    const scope = marker?.closest?.('[data-chat-flow]') ?? null
    // 认不出容器、或者这一轮已经不该藏了：恢复我们藏过的，绝不新增隐藏。
    if (scope === null || options.deleted !== true) {
      restoreAll()
      return { restoreAll }
    }

    const newlyHidden = []
    for (const element of scope.querySelectorAll(`[data-chat-turn="${turn}"]`)) {
      // 同一行可能同时属于别的记账，别抢别人的标记。
      if (element.dataset.agentControlTurn !== undefined) {
        hidden.add(element)
        continue
      }
      if (hidden.has(element)) continue
      element.dataset.agentControlTurn = String(turn)
      hidden.add(element)
      newlyHidden.push(element)
    }
    // 整轮**一起**折叠：逐行回调会各缩各的，看起来是一团乱；交给 startCollapse 统一排程。
    if (newlyHidden.length > 0) {
      if (options.animate === true) startCollapse(newlyHidden, turn)
      else for (const element of newlyHidden) hideRow(element)
    }
    return { restoreAll }
  }

  /** 每行在折叠动画里用到的内联样式，收尾与取消时都要清干净。 */
  const COLLAPSE_STYLE_KEYS = [
    'transition', 'overflow', 'height', 'paddingTop', 'paddingBottom',
    'marginTop', 'marginBottom', 'opacity', 'transform',
  ]

  /** 正在折叠的行 → 它的收尾定时器，取消时要一并清掉。 */
  const collapsingRows = new Map()

  /** 真正隐藏一行并清掉动画状态。 */
  function hideRow(element) {
    element.hidden = true
    for (const key of COLLAPSE_STYLE_KEYS) delete element.style[key]
    collapsingRows.delete(element)
  }

  /** 取消折叠：恢复可见时立刻回到原样（含清掉定时器，避免迟到的回调又把它藏回去）。 */
  function cancelRowFade(element) {
    for (const timer of collapsingRows.get(element) ?? []) window.clearTimeout?.(timer)
    collapsingRows.delete(element)
    element.removeAttribute?.('aria-hidden')
    for (const key of COLLAPSE_STYLE_KEYS) delete element.style[key]
  }

  /**
   * 让一批行**依次折叠收起**。
   *
   * ## 为什么不能只过渡 `height`
   *
   * 一是 CSS **无法对 `height: auto` 做过渡**，必须先 `getBoundingClientRect()` 量出像素高度，
   * 从确定值过渡到 `0`；二是只压 `height` 会留下**垂直内边距与行距**，收完还是一堆空隙、
   * 要等到最后 `display: none` 才「啪」地跳掉——所以这几个一起过渡。
   *
   * ## 为什么逐行错开
   *
   * 三行（问题 / 回复 / 操作条）同时收起会缩成一团；按顺序各延后 `TURN_FADE_STAGGER_MS`，
   * 看起来才是「自上而下卷起来」。最后一行收完才真正 `display: none`。
   *
   * ## 时序（和淡出一样，顺序错了就没有动画）
   *
   * 1. 本帧：量高度、写过渡声明、让 `hidden`/`aria-hidden` 立刻生效（无障碍不延迟），
   *    但**先不动几何属性**——此时元素还可见，过渡才有起点；
   * 2. 下一帧：才写 `height: 0` 等目标值；
   * 3. 每行按自己的延迟收尾；**被恢复时（`cancelRowFade`）定时器会被清掉**，
   *    所以迟到的回调不会把行又藏回去。
   *
   * @param {Element[]} rows 要收起的行，按文档顺序（决定错开次序）。
   * @param {number} turn 轮次号，用于每一步重新核对归属。
   */
  function startCollapse(rows, turn) {
    const usable = rows.filter((element) => element.dataset.agentControlTurn === String(turn))
    if (usable.length === 0) return
    const animated = !prefersReducedMotion()
      && typeof window.requestAnimationFrame === 'function'
      && typeof window.getComputedStyle === 'function'
      && typeof usable[0].getBoundingClientRect === 'function'

    if (!animated) {
      for (const element of usable) hideRow(element)
      return
    }

    // 只处理还没在折叠的行；已经在折叠的保持原样。
    const fresh = usable.filter((element) => !collapsingRows.has(element))
    if (fresh.length === 0) return

    const measured = []
    // 只遍历 fresh：对正在折叠的行再走一遍会把它的定时器记录覆盖成空，取消时就清不掉。
    for (const [index, element] of fresh.entries()) {
      const delay = index * TURN_FADE_STAGGER_MS
      const total = delay + TURN_FADE_MS
      const box = element.getBoundingClientRect()
      const computed = window.getComputedStyle(element)
      const height = box.height
      if (!(height > 0)) {
        // 没有布局（例如已经被隐藏）就没什么可收的，直接落定。
        hideRow(element)
        continue
      }
      // 第 1 步：过渡声明 + 无障碍语义，几何属性留到下一帧。
      element.style.overflow = 'hidden'
      element.style.transition = [
        `height ${TURN_FADE_MS}ms ease`,
        `opacity ${TURN_FADE_MS}ms ease`,
        `padding-top ${TURN_FADE_MS}ms ease`,
        `padding-bottom ${TURN_FADE_MS}ms ease`,
        `margin-top ${TURN_FADE_MS}ms ease`,
        `margin-bottom ${TURN_FADE_MS}ms ease`,
      ].join(', ')
      element.setAttribute?.('aria-hidden', 'true')
      measured.push({ element, delay, total, height, computed })
      collapsingRows.set(element, [])
    }
    if (measured.length === 0) return

    window.requestAnimationFrame(() => {
      for (const item of measured) {
        const { element, delay, total, height, computed } = item
        if (element.dataset.agentControlTurn !== String(turn)) continue
        // 第 2 步：写目标值，过渡由此触发。
        element.style.height = `${height}px`
        element.style.opacity = computed.opacity
        element.style.marginTop = computed.marginTop
        element.style.marginBottom = computed.marginBottom
        element.style.paddingTop = computed.paddingTop
        element.style.paddingBottom = computed.paddingBottom
        // 下一帧（过渡起点确立后）再压到 0。
        window.requestAnimationFrame(() => {
          if (!collapsingRows.has(element)) return
          if (element.dataset.agentControlTurn !== String(turn)) return
          element.style.height = '0px'
          element.style.opacity = '0'
          element.style.marginTop = '0px'
          element.style.marginBottom = '0px'
          element.style.paddingTop = '0px'
          element.style.paddingBottom = '0px'
        })
        const timer = window.setTimeout(() => {
          if (!collapsingRows.has(element)) return
          if (element.dataset.agentControlTurn !== String(turn)) return
          hideRow(element)
        }, total)
        collapsingRows.set(element, (collapsingRows.get(element) ?? []).concat(timer))
      }
    })
  }

  /** 尊重系统的「减少动态效果」设置。 */
  function prefersReducedMotion() {
    try {
      return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    } catch {
      return false
    }
  }

  function apply(ctx) {
    adoptLocale(ctx)
    sessionsService = ctx.get('sessions')
    if (sessionsService === undefined) {
      ctx.inject(['sessions'], (sub) => {
        sessionsService = sub.sessions
      })
    }

    const ui = components(React)

    ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
      name: 'sidebar.workspaces.session.menu.item',
      id: ENTRY.sessionMenu,
      // 原生项是 100 置顶 / 200 重命名 / 300 分叉 / 400 归档；破坏性操作排在最后。
      order: 500,
    }, ui.SessionMenuDelete))

    ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
      name: 'conversation.chat.assistant-actions',
      id: ENTRY.turnButton,
      order: 90,
      inject: (sessionId) => ({ sessionId }),
    }, ui.TurnDeleteAction))

    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      id: ENTRY.turnMarker,
      order: 90,
      inject: (sessionId) => ({ sessionId }),
    }, ui.DeletedTurnMarker))

    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: ENTRY.dialog,
      order: 100,
    }, ui.DeleteDialog))
  }

  /** 接入 locale 服务并注册词典；失败就退回内置文案，功能不受影响。 */
  function adoptLocale(ctx) {
    const register = (service) => {
      if (service === undefined) return
      localeService = service
      try {
        ctx.effect(() => service.register(LOCALE_NS, { zh, en }), `${PLUGIN_ID}: dictionaries`)
      } catch {
        // 命名空间已注册：用现有的就好。
      }
    }
    const existing = ctx.get('locale')
    if (existing !== undefined) {
      register(existing)
      return
    }
    ctx.inject(['locale'], (sub) => register(sub.locale))
  }

  window.__ModuleLoader__.load({
    id: PLUGIN_ID,
    factory: (require) => {
      React = require('react')
      // 原生原语拿不到时**不能**让整个 bundle 挂掉：那样界面上只会「什么都不出现」，
      // 这属于典型的静默失败（界面上什么都不出现、也没有报错）。改成退回本文件自带的替代品——
      // 功能（确认勾选 + 明确文案）由 host 端与这里的兜底共同保证，
      // 丢掉的只是外观与原生控件。
      let primitives
      try {
        primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        primitives = undefined
      }
      IconTrashOutlineRegular = typeof primitives?.IconTrashOutlineRegular === 'function'
        ? primitives.IconTrashOutlineRegular
        : FallbackTrashIcon
      RiskConfirmation = typeof primitives?.RiskConfirmation === 'function'
        ? primitives.RiskConfirmation
        : FallbackRiskConfirmation
      MenuItemButton = typeof primitives?.MenuItemButton === 'function' ? primitives.MenuItemButton : undefined
      Tooltip = typeof primitives?.Tooltip === 'function' ? primitives.Tooltip : undefined
      ensureStyles()
      return { apply, inject: ['slots'] }
    },
  })

  // 排障用抓手：出问题时可以在浏览器控制台确认「注册成功了吗、用的是原生原语还是兜底」。
  window.__dshAgentControl = {
    id: PLUGIN_ID,
    apply,
    fallbacks: { FallbackTrashIcon, FallbackRiskConfirmation },
    syncTurnRows,
    usingNativePrimitives: () => RiskConfirmation === undefined
      ? null
      : RiskConfirmation !== FallbackRiskConfirmation,
  }
})()
