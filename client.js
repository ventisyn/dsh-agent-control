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
    // 热重启（契约见 docs/PLAN-hot-restart.md 3.2）。与 src/shared.mjs 的 PATHS 逐字一致。
    restartStatus: '/api/agent-control/restart/status',
    restart: '/api/agent-control/restart',
  }
  const LOCALE_NS = 'agent-control'
  /** 自定义事件：按钮只派发目标，弹窗统一监听。 */
  const REQUEST_EVENT = 'dsh-agent-control:request-delete'
  /**
   * 自定义事件：请求打开「重启 DSH」确认弹窗。
   *
   * 与删除请求同一个模式、**同一个 overlay 宿主**（`agent-control-dialog`）：按钮只派发意图，
   * 宿主统一监听，所以不会出现第二个弹窗宿主或第二个 overlay 槽位注册。
   * 重启真正的状态在模块级态机里（见 `nextRestartPhase`），这个事件只负责「把弹窗叫起来」。
   */
  const RESTART_REQUEST_EVENT = 'dsh-agent-control:request-restart'
  /** 自定义事件：重启流程状态变了（设置页与浮层横幅订阅同一份状态）。 */
  const RESTART_CHANGED_EVENT = 'dsh-agent-control:restart-changed'
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

  /**
   * 重启进度态机的全部阶段（见 `nextRestartPhase`）。
   *
   * 时间线：`idle → confirming → requested → shutting-down → starting → reconnecting → done | failed`。
   * `starting` 与 `reconnecting` 都只由「状态请求失败」推出——重启期间 HTTP 本来就不通，
   * 那不是错误，只是「旧进程已经没了」与「还在等新进程」的区别（分界见 `RESTART_RECONNECT_AFTER_MS`）。
   */
  const RESTART_PHASES = [
    'idle', 'confirming', 'requested', 'shutting-down', 'starting', 'reconnecting', 'done', 'failed',
  ]
  /** 已经提交出去、还没落定的阶段：这些阶段里按钮禁用、不允许重复提交。 */
  const RESTART_BUSY_PHASES = ['requested', 'shutting-down', 'starting', 'reconnecting']
  /** 需要靠轮询 `status` 往前走的阶段（`requested` 由 POST 自己驱动，不轮询）。 */
  const RESTART_WATCH_PHASES = ['shutting-down', 'starting', 'reconnecting']
  /** 轮询间隔。 */
  const RESTART_POLL_INTERVAL_MS = 1000
  /**
   * 等待新进程的上限。
   *
   * 超了就进 `failed` 并给出人工入口——**不无限转圈**（验收清单第 11 条）。
   */
  const RESTART_TIMEOUT_MS = 120000
  /**
   * 「还在启动」与「在重新连接」的分界。
   *
   * 依据是实测（SPIKE S6）：旧进程 0.7 秒内退出，新进程约 6–7 秒后开始服务，
   * 其中 4 秒左右是 DSH 自身的启动耗时。所以断连后的头几秒说「正在启动」，
   * 之后说「正在等待重新连上」才符合用户看到的东西。
   */
  const RESTART_RECONNECT_AFTER_MS = 8000
  /**
   * 落定成 `done` 之后再补问一次状态的延迟。
   *
   * 等的是辅助进程写 `last.json`：客户端读到「新 bootId」的那一刻，往往正是辅助进程
   * 用它判断就绪的那一刻，此时结果文件还没落盘。
   */
  const RESTART_DONE_REFRESH_MS = 1500

  const ENTRY = {
    sessionMenu: 'agent-control-session-menu',
    turnButton: 'agent-control-turn-delete',
    turnMarker: 'agent-control-turn-marker',
    dialog: 'agent-control-dialog',
    restartSection: 'agent-control-restart',
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
  /** 重启设置页、横幅与兜底按钮的类名（样式一律走 token，不写死颜色）。 */
  const SECTION_CLASS = 'dsh-agent-control-section'
  const HEADING_CLASS = 'dsh-agent-control-heading'
  const INTRO_CLASS = 'dsh-agent-control-intro'
  const ROW_CLASS = 'dsh-agent-control-row'
  const ROW_MAIN_CLASS = 'dsh-agent-control-row-main'
  const ROW_TITLE_CLASS = 'dsh-agent-control-row-title'
  const ROW_DESC_CLASS = 'dsh-agent-control-row-desc'
  const KV_CLASS = 'dsh-agent-control-kv'
  const KV_KEY_CLASS = 'dsh-agent-control-kv-key'
  const KV_VALUE_CLASS = 'dsh-agent-control-kv-value'
  const BLOCKER_CLASS = 'dsh-agent-control-blocker'
  const ACTIONS_CLASS = 'dsh-agent-control-actions'
  const ERROR_CLASS = 'dsh-agent-control-error'
  const HINT_CLASS = 'dsh-agent-control-hint'
  /** 危险态：就地改写原生 Button 的 primary token（见 STYLE_CSS）。 */
  const DANGER_CLASS = 'dsh-agent-control-danger'
  const FALLBACK_BUTTON_CLASS = 'dsh-agent-control-button'
  const FALLBACK_BUTTON_SM_CLASS = 'dsh-agent-control-button-sm'
  const FALLBACK_BUTTON_OUTLINE_CLASS = 'dsh-agent-control-button-outline'
  const FALLBACK_BUTTON_GHOST_CLASS = 'dsh-agent-control-button-ghost'
  const BANNER_CLASS = 'dsh-agent-control-banner'
  const BANNER_CARD_CLASS = 'dsh-agent-control-banner-card'
  const BANNER_TITLE_CLASS = 'dsh-agent-control-banner-title'
  const BANNER_DETAIL_CLASS = 'dsh-agent-control-banner-detail'
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
    // ---------------------------------------------------------------------
    // 热重启设置页。度量逐条抄自已装的原生设置页：
    //  · section/heading/intro ← ui-settings-plugins 的 PluginsSettingsSection.module.css
    //  · row/title/desc       ← ui-settings-general 的 DeveloperToolsRow.module.css
    //  · 页签内容列的左右 24px 内边距由宿主的 `.options` 给出，这里不再加水平内边距。
    // 只用 --dsw-alias-* / --dsw-radius-* / --dsw-focus-ring-* token，明暗两套主题自动成立。
    // ---------------------------------------------------------------------
    `.${SECTION_CLASS}{display:flex;flex-direction:column;gap:12px;max-width:760px;`
      + 'color:var(--dsw-alias-label-primary)}',
    // 逐字对齐原生 PluginsSettingsSection.module.css 的 .heading / .intro（连行高都不另设）。
    `.${HEADING_CLASS}{margin:0;font-size:18px;font-weight:600}`,
    `.${INTRO_CLASS}{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary)}`,
    `.${ROW_CLASS}{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;`
      + 'padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
    `.${ROW_MAIN_CLASS}{display:flex;flex-direction:column;gap:4px;min-width:0}`,
    `.${ROW_TITLE_CLASS}{font-size:14px;line-height:20px}`,
    `.${ROW_DESC_CLASS}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);`
      + 'overflow-wrap:anywhere}',
    `.${KV_CLASS}{display:grid;grid-template-columns:max-content max-content;column-gap:12px;`
      + 'row-gap:2px;flex:none;font-size:12px;line-height:18px}',
    `.${KV_KEY_CLASS}{color:var(--dsw-alias-label-tertiary)}`,
    `.${KV_VALUE_CLASS}{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;`
      + 'overflow-wrap:anywhere}',
    `.${BLOCKER_CLASS}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);`
      + 'overflow-wrap:anywhere}',
    `.${ACTIONS_CLASS}{display:flex;align-items:center;gap:8px;flex:none}`,
    `.${ERROR_CLASS}{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);`
      + 'overflow-wrap:anywhere}',
    `.${HINT_CLASS}{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}`,
    // 危险态**不自造色值**：就地改写原生 Button 的 primary token 族，做法抄自已装的
    // ui-plugin-manager（`Button` + `.dangerButton{--dsw-alias-button-primary-fill:var(--dsw-alias-state-error-primary)}`）。
    `.${DANGER_CLASS}{--dsw-alias-button-primary-fill:var(--dsw-alias-state-error-primary);`
      + '--dsw-alias-button-primary-hover:var(--dsw-alias-state-error-primary)}',
    // 拿不到原生 Button 时的兜底按钮：度量抄 Button.module.css 的 .button/.md/.sm/.primary/.outline。
    `.${FALLBACK_BUTTON_CLASS}{box-sizing:border-box;display:inline-flex;align-items:center;`
      + 'justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);'
      + 'cursor:pointer;font:inherit;font-size:14px;line-height:22px;height:36px;padding:0 14px;'
      + 'background:var(--dsw-alias-button-primary-fill);'
      + 'color:var(--dsw-alias-label-primary-foreground)}',
    `.${FALLBACK_BUTTON_CLASS}:hover:not(:disabled)`
      + '{background:var(--dsw-alias-button-primary-hover)}',
    `.${FALLBACK_BUTTON_CLASS}:disabled{cursor:not-allowed;opacity:.4}`,
    `.${FALLBACK_BUTTON_CLASS}:focus-visible{outline:var(--dsw-focus-ring-width) solid `
      + 'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
    `.${FALLBACK_BUTTON_SM_CLASS}{height:28px;font-size:12px;line-height:18px;padding:0 10px;`
      + 'border-radius:var(--dsw-radius-sm)}',
    `.${FALLBACK_BUTTON_OUTLINE_CLASS}{background:transparent;`
      + 'color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l3)}',
    `.${FALLBACK_BUTTON_OUTLINE_CLASS}:hover:not(:disabled)`
      + '{background:var(--dsw-alias-interactive-bg-hover)}',
    `.${FALLBACK_BUTTON_GHOST_CLASS}{background:transparent;color:var(--dsw-alias-label-primary)}`,
    `.${FALLBACK_BUTTON_GHOST_CLASS}:hover:not(:disabled)`
      + '{background:var(--dsw-alias-interactive-bg-hover)}',
    // 浮层横幅：`shell.overlay` 整层是 click-through，但它的 `> *` 会把指针事件还给每个条目，
    // 所以外层显式关掉、只让卡片可点——横幅绝不能挡住整页。
    `.${BANNER_CLASS}{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);`
      + 'max-width:calc(100vw - 48px);pointer-events:none}',
    `.${BANNER_CARD_CLASS}{pointer-events:auto;box-sizing:border-box;display:flex;align-items:center;`
      + 'flex-wrap:wrap;gap:8px 12px;padding:10px 14px;border:0.5px solid var(--dsw-alias-border-l3);'
      + 'border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);'
      + 'box-shadow:var(--dsw-elevation-prominent);font-size:13px;line-height:20px;'
      + 'color:var(--dsw-alias-label-primary)}',
    `.${BANNER_TITLE_CLASS}{font-weight:500}`,
    `.${BANNER_DETAIL_CLASS}{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}`,
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
   * 原生 `Button` 拿不到时的兜底按钮。
   *
   * 度量抄 `Button.module.css`（36 / 28 高、圆角 `--dsw-radius-md` / `-sm`），颜色一律走 token；
   * 它**不是**组件（没有 hooks，直接当函数调用），这样离线测试也能在元素树里找到真正的
   * `button` 节点。
   */
  function FallbackButton(props) {
    const options = props ?? {}
    const classes = [FALLBACK_BUTTON_CLASS]
    if (options.size === 'sm') classes.push(FALLBACK_BUTTON_SM_CLASS)
    if (options.variant === 'outline') classes.push(FALLBACK_BUTTON_OUTLINE_CLASS)
    else if (options.variant === 'ghost' || options.variant === 'toolbar') {
      classes.push(FALLBACK_BUTTON_GHOST_CLASS)
    }
    if (typeof options.className === 'string' && options.className !== '') classes.push(options.className)
    return React.createElement(
      'button',
      {
        type: options.type ?? 'button',
        className: classes.join(' '),
        disabled: options.disabled === true,
        onClick: options.onClick,
        title: options.title,
      },
      options.icon ?? null,
      options.children ?? null,
    )
  }

  /** 原生刷新图标拿不到时的兜底（内联 SVG，不依赖任何包）。 */
  function FallbackRefreshIcon(props) {
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
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      React.createElement('path', { d: 'M12.9 8A4.9 4.9 0 1 0 8 3.1' }),
      React.createElement('path', { d: 'M10.6 1.5 8 3.1l2 2.4' }),
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
    // --- 热重启（docs/PLAN-hot-restart.md M4）---------------------------------------------
    'restart.sectionLabel': '热重启',
    'restart.title': '热重启',
    'restart.intro': '重启 DSH 进程，让需要重启才生效的改动（例如宿主插件代码）用上。重启期间页面会短暂不可用，恢复后会自动重新连上，不需要重新登录。',
    'restart.statusTitle': '运行状态',
    'restart.statusDesc': '本次启动的进程信息',
    'restart.statusLoading': '正在读取宿主状态…',
    'restart.field.version': '版本',
    'restart.field.pid': '进程号',
    'restart.field.uptime': '已运行',
    'restart.field.port': '端口',
    'restart.field.bootId': '启动标识',
    'restart.blockersTitle': '有正在运行的会话或后台任务',
    'restart.blockersDesc': '重启会中断它们，宿主会拒绝这次重启；等它们结束后再试。',
    'restart.blockersJobs': '后台任务',
    'restart.blockersChild': '（子代理）',
    'restart.action': '重启 DSH',
    'restart.actionBusy': '正在重启…',
    'restart.actionDesc': '重启会中断正在运行的任务与后台作业；重启期间页面会短暂不可用。',
    'restart.unsupported': '宿主报告这次部署不能重启。',
    'restart.doneNote': '重启完成，页面已经重新连上。',
    'restart.failedNote': '重启没有完成：120 秒内没能重新连上宿主。请手动启动 dsh web，或刷新页面重试。',
    'restart.refresh': '刷新页面',
    'restart.lastTitle': '最近一次重启',
    'restart.lastEmpty': '这个进程启动后还没有重启过。',
    'restart.lastTime': '时间',
    'restart.lastSource': '来源',
    'restart.lastReason': '原因',
    'restart.lastDuration': '耗时',
    'restart.lastResume': '续作',
    'restart.lastResult': '结果',
    'restart.lastError': '失败原因',
    'restart.lastLogFile': '日志',
    'restart.lastOk': '成功',
    'restart.lastFailed': '失败',
    'restart.sourceModel': '模型',
    'restart.sourceUser': '用户',
    'restart.resumeDelivered': '已自动续上',
    'restart.resumeFailed': '未能自动续上',
    'restart.resumeNone': '无需续作',
    'restart.phase.confirming': '等待你确认',
    'restart.phase.requested': '正在请求重启…',
    'restart.phase.shuttingDown': 'DSH 正在关闭…',
    'restart.phase.starting': '正在启动新的进程…',
    'restart.phase.reconnecting': '正在等待 DSH 重新连上…',
    'restart.phase.done': '重启完成',
    'restart.phase.failed': '重启失败',
    'restart.banner.title': 'DSH 正在重启…',
    'restart.banner.failedTitle': 'DSH 没有重启成功',
    'restart.banner.failedDetail': '120 秒内没能重新连上宿主。请手动启动 dsh web，或刷新页面重试。',
    'restart.banner.wait': '已等待',
    'restart.banner.logHint': '日志目录：<DSH_HOME>/logs/agent-control-restart-*.log',
    'restart.dialog.title': '重启 DSH？',
    'restart.dialog.body': '重启会中断正在运行的任务与后台作业（含终端与后台任务），重启期间页面会短暂不可用；恢复后页面会自己重新连上，不需要重新登录。',
    'restart.dialog.ack': '我明白重启会中断正在运行的任务',
    'restart.dialog.confirm': '重启',
    'restart.dialog.working': '正在重启…',
    'restart.uiReason': '用户在设置页点了「重启 DSH」',
    'restart.unit.hour': '小时',
    'restart.unit.minute': '分',
    'restart.unit.second': '秒',
    'error.RESTART_BLOCKED': '现在不能重启：还有会话或后台任务在运行。等它们结束后再试。',
    'error.RESTART_IN_PROGRESS': '已经有一个重启在进行中了，请等它结束。',
    'error.RESTART_RATE_LIMITED': '重启太频繁了，请稍后再试。',
    'error.RESTART_UNSUPPORTED': '这个部署不支持重启',
    'error.RESTART_DENIED': '这次重启被拒绝了',
    'error.RESTART_TIMEOUT': '重启超时：120 秒内没能重新连上宿主',
    'error.RESTART_REQUEST_FAILED': '重启请求没有发出去',
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
    // --- Hot restart (docs/PLAN-hot-restart.md M4) ----------------------------------------
    'restart.sectionLabel': 'Hot restart',
    'restart.title': 'Hot restart',
    'restart.intro': 'Restart the DSH process so changes that need a restart (host plugin code, for example) take effect. The page is briefly unavailable during the restart and reconnects on its own afterwards — no need to sign in again.',
    'restart.statusTitle': 'Runtime',
    'restart.statusDesc': 'Process information for this boot',
    'restart.statusLoading': 'Reading host status…',
    'restart.field.version': 'Version',
    'restart.field.pid': 'PID',
    'restart.field.uptime': 'Uptime',
    'restart.field.port': 'Port',
    'restart.field.bootId': 'Boot ID',
    'restart.blockersTitle': 'Sessions or background jobs are running',
    'restart.blockersDesc': 'A restart would interrupt them, so the host refuses this one. Try again once they finish.',
    'restart.blockersJobs': 'Background jobs',
    'restart.blockersChild': ' (subagent)',
    'restart.action': 'Restart DSH',
    'restart.actionBusy': 'Restarting…',
    'restart.actionDesc': 'A restart interrupts running tasks and background jobs; the page is briefly unavailable while it happens.',
    'restart.unsupported': 'The host reports that this deployment cannot restart.',
    'restart.doneNote': 'Restart finished; the page reconnected.',
    'restart.failedNote': 'The restart did not finish: the host did not come back within 120 seconds. Start dsh web manually, or refresh the page to retry.',
    'restart.refresh': 'Refresh page',
    'restart.lastTitle': 'Last restart',
    'restart.lastEmpty': 'This process has not been restarted yet.',
    'restart.lastTime': 'Time',
    'restart.lastSource': 'Source',
    'restart.lastReason': 'Reason',
    'restart.lastDuration': 'Duration',
    'restart.lastResume': 'Resume',
    'restart.lastResult': 'Result',
    'restart.lastError': 'Failure',
    'restart.lastLogFile': 'Log',
    'restart.lastOk': 'Succeeded',
    'restart.lastFailed': 'Failed',
    'restart.sourceModel': 'Model',
    'restart.sourceUser': 'User',
    'restart.resumeDelivered': 'Resumed automatically',
    'restart.resumeFailed': 'Could not resume automatically',
    'restart.resumeNone': 'Nothing to resume',
    'restart.phase.confirming': 'Waiting for your confirmation',
    'restart.phase.requested': 'Requesting the restart…',
    'restart.phase.shuttingDown': 'DSH is shutting down…',
    'restart.phase.starting': 'Starting the new process…',
    'restart.phase.reconnecting': 'Waiting for DSH to come back…',
    'restart.phase.done': 'Restart finished',
    'restart.phase.failed': 'Restart failed',
    'restart.banner.title': 'DSH is restarting…',
    'restart.banner.failedTitle': 'DSH did not come back',
    'restart.banner.failedDetail': 'The host did not answer within 120 seconds. Start dsh web manually, or refresh the page to retry.',
    'restart.banner.wait': 'waited',
    'restart.banner.logHint': 'Log directory: <DSH_HOME>/logs/agent-control-restart-*.log',
    'restart.dialog.title': 'Restart DSH?',
    'restart.dialog.body': 'A restart interrupts running tasks and background jobs (terminals and background work). The page is briefly unavailable during the restart and reconnects on its own afterwards — no need to sign in again.',
    'restart.dialog.ack': 'I understand a restart interrupts running tasks',
    'restart.dialog.confirm': 'Restart',
    'restart.dialog.working': 'Restarting…',
    'restart.uiReason': 'User clicked "Restart DSH" in settings',
    'restart.unit.hour': 'h',
    'restart.unit.minute': 'min',
    'restart.unit.second': 's',
    'error.RESTART_BLOCKED': 'Cannot restart now: sessions or background jobs are running. Wait for them to finish.',
    'error.RESTART_IN_PROGRESS': 'A restart is already in progress; wait for it to finish.',
    'error.RESTART_RATE_LIMITED': 'Restarts are too frequent; try again later.',
    'error.RESTART_UNSUPPORTED': 'This deployment cannot restart',
    'error.RESTART_DENIED': 'This restart was refused',
    'error.RESTART_TIMEOUT': 'Restart timed out: the host did not come back within 120 seconds',
    'error.RESTART_REQUEST_FAILED': 'The restart request could not be sent',
  }

  /** 运行时拿到的服务与依赖（factory 注入）。 */
  let React
  let IconTrashOutlineRegular
  let RiskConfirmation
  /** 原生菜单行 / 气泡提示；拿不到时为 undefined，组件退回自带样式。 */
  let MenuItemButton
  let Tooltip
  /** 原生按钮与刷新图标；拿不到时退回 `FallbackButton` / `FallbackRefreshIcon`。 */
  let Button
  let IconRefreshOutlineRegular
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

  /** 让人工确认弹窗起来（按钮只派发意图，弹窗由 `shell.overlay` 里那个唯一宿主渲染）。 */
  function requestRestartDialog() {
    window.dispatchEvent(new CustomEvent(RESTART_REQUEST_EVENT))
  }

  // ---------------------------------------------------------------------------
  // 热重启：纯状态机 + 一份模块级状态
  // ---------------------------------------------------------------------------

  /** 态机初始态。 */
  function initialRestartState() {
    return {
      phase: 'idle',
      /** 页面认得的进程标识：变了就说明换成了重启后的新进程（成功信号）。 */
      bootId: null,
      /** 进程号的兜底判据：宿主万一没给 `bootId`，靠它也能看出「换了进程」。 */
      pid: null,
      /** 最近一次成功的 `/restart/status` 响应，界面靠它画运行状态与「最近一次重启」。 */
      status: null,
      /** 这次重启的 id（宿主 202 里给的，或从 `pending` 读到的）。 */
      restartId: null,
      /** 开始等新进程的时刻（毫秒）；null 表示还没提交过。 */
      acceptedAt: null,
      /** 已经等待的毫秒数（横幅上的「已等待 N 秒」）。 */
      waitMs: 0,
      /** 连续失败次数（只在诊断与测试里用，界面不显示）。 */
      failures: 0,
      /** `{ code, message }`；只有「提交被拒」「超时失败」会写它。 */
      error: null,
    }
  }

  /** 是否处于「已经提交出去、还没落定」的阶段。 */
  function isRestartBusy(phase) {
    return RESTART_BUSY_PHASES.includes(phase)
  }

  /** 是否处于「靠轮询等新进程」的阶段。 */
  function isRestartWatching(phase) {
    return RESTART_WATCH_PHASES.includes(phase)
  }

  /**
   * 从 `from` 到 `at` 的毫秒数。
   *
   * `from` 拿不到时返回 **null**（而不是 0）：调用方要能区分「刚提交」和「不知道什么时候提交的」，
   * 后者不该被当成「等了 0 秒」（AGENTS 坑 ⑨：拿不到的信息不要编）。
   */
  function elapsedSince(from, at) {
    if (typeof from !== 'number' || !Number.isFinite(from)) return null
    if (typeof at !== 'number' || !Number.isFinite(at)) return null
    return Math.max(0, at - from)
  }

  /** 把宿主给的时间说成毫秒；认不出就返回 null。 */
  function parseTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value !== '') {
      const parsed = Date.parse(value)
      return Number.isNaN(parsed) ? null : parsed
    }
    return null
  }

  /** 事件自带的时刻（测试里显式给，真机上用当前时间）。 */
  function eventTime(event) {
    return typeof event?.at === 'number' && Number.isFinite(event.at) ? event.at : Date.now()
  }

  /** 兜住任何形状不对的状态：态机宁可从头开始，也不在坏数据上做判断。 */
  function normalizeRestartState(state) {
    if (state === null || typeof state !== 'object') return initialRestartState()
    if (!RESTART_PHASES.includes(state.phase)) return initialRestartState()
    return state
  }

  /** 失败落定：进 `failed` 并给出可操作的原因（不假装成功）。 */
  function restartFailed(state, code, at) {
    return {
      ...state,
      phase: 'failed',
      waitMs: elapsedSince(state.acceptedAt, at) ?? state.waitMs,
      error: { code, message: '' },
    }
  }

  /**
   * `status` 事件：宿主回答了。
   *
   * 只有两个成功信号：`bootId`（或 `pid`）变了 ⇒ 页面已经连上重启后的新进程；
   * 宿主自报 `pending` ⇒ 有重启待办（可能是模型发起的，也可能是别的标签页），跟着进重启中。
   * 其余情况一律「保持当前阶段、刷新展示数据」——**不凭一次读到空 pending 就判失败**，
   * 失败线只有一条：`RESTART_TIMEOUT_MS`。
   */
  function restartAfterStatus(current, event) {
    const payload = event?.payload
    if (payload === null || typeof payload !== 'object') return current
    const at = eventTime(event)
    const bootId = typeof payload.bootId === 'string' && payload.bootId !== '' ? payload.bootId : current.bootId
    const pid = Number.isInteger(payload.pid) ? payload.pid : current.pid
    const next = { ...current, status: payload, bootId, pid }
    const bootChanged = current.bootId !== null && bootId !== null && bootId !== current.bootId
    const pidChanged = current.pid !== null && pid !== null && pid !== current.pid
    if (bootChanged || pidChanged) {
      return { ...next, phase: 'done', waitMs: elapsedSince(current.acceptedAt, at) ?? 0, failures: 0, error: null }
    }
    const pending = payload.pending
    if (pending !== null && typeof pending === 'object') {
      const startedAt = parseTime(pending.createdAt)
      const acceptedAt = current.acceptedAt ?? startedAt ?? at
      return {
        ...next,
        phase: 'shutting-down',
        restartId: typeof pending.restartId === 'string' ? pending.restartId : current.restartId,
        acceptedAt,
        waitMs: elapsedSince(acceptedAt, at) ?? 0,
        failures: 0,
        error: null,
      }
    }
    if (!isRestartBusy(current.phase)) return next
    const waitMs = elapsedSince(current.acceptedAt, at)
    if (waitMs !== null && waitMs >= RESTART_TIMEOUT_MS) return restartFailed(next, 'RESTART_TIMEOUT', at)
    return { ...next, waitMs: waitMs ?? current.waitMs, failures: 0 }
  }

  /**
   * `status-failed` 事件：状态请求没成功。
   *
   * 重启期间 HTTP 必然不通，**这不是错误**——正是「旧进程已经退出」的证据。
   * 头几秒说 `starting`（新进程正在启动），超过 `RESTART_RECONNECT_AFTER_MS` 说 `reconnecting`
   * （还在等它回来），满 `RESTART_TIMEOUT_MS` 才落 `failed`。
   */
  function restartAfterFailure(current, event) {
    if (!isRestartWatching(current.phase)) return current
    const at = eventTime(event)
    const waitMs = elapsedSince(current.acceptedAt, at)
    const failures = current.failures + 1
    if (waitMs !== null && waitMs >= RESTART_TIMEOUT_MS) {
      return restartFailed({ ...current, failures }, 'RESTART_TIMEOUT', at)
    }
    const phase = waitMs !== null && waitMs >= RESTART_RECONNECT_AFTER_MS ? 'reconnecting' : 'starting'
    return { ...current, phase, failures, waitMs: waitMs ?? current.waitMs, error: null }
  }

  /**
   * 重启进度的纯状态机（唯一定义「现在处于哪个阶段」的地方）。
   *
   * 输入只有两类事实：`/restart/status` 的响应（`status`）与状态请求失败（`status-failed`）；
   * 其余事件来自界面（打开 / 取消 / 提交 / 关掉失败提示）与 POST 的结果（`accepted` / `rejected`）。
   * 放在组件外面，是为了能离线把每条迁移都测一遍——真机上「重启中」只有几秒，人眼测不出死角。
   *
   * 约定：**无效事件返回原对象**（引用相等），调用方据此跳过广播与重渲染。例如重启进行中
   * 再点一次提交，阶段不会倒退——这也是「不允许重复提交」的第二道门（第一道是按钮禁用）。
   *
   * @param {object} state 当前状态（`initialRestartState()` 的形状）。
   * @param {{ type: string }} event 事件。
   * @returns {object} 下一个状态；无效事件原样返回。
   */
  function nextRestartPhase(state, event) {
    const current = normalizeRestartState(state)
    const type = event?.type
    const at = eventTime(event)
    switch (type) {
      case 'reset':
        return initialRestartState()
      case 'confirm':
        // 重启进行中再点按钮：拒绝（按钮也会禁用，这里是第二道门）。
        if (isRestartBusy(current.phase)) return current
        return { ...current, phase: 'confirming', error: null }
      case 'cancel':
        if (current.phase !== 'confirming') return current
        return { ...current, phase: 'idle', error: null }
      case 'dismiss':
        if (current.phase !== 'failed' && current.phase !== 'done') return current
        return { ...current, phase: 'idle', error: null }
      case 'submit':
        // 只有「确认中」才能提交：重复提交（在飞 / 已被接受）一律原样返回。
        if (current.phase !== 'confirming') return current
        return { ...current, phase: 'requested', restartId: null, acceptedAt: null, waitMs: 0, failures: 0, error: null }
      case 'accepted':
        if (current.phase !== 'requested') return current
        return {
          ...current,
          phase: 'shutting-down',
          restartId: typeof event?.restartId === 'string' && event.restartId !== '' ? event.restartId : null,
          acceptedAt: at,
          waitMs: 0,
          failures: 0,
          error: null,
        }
      case 'rejected':
        // 被拒不等于「重启失败」：宿主还好好的，原因要留在弹窗里，用户可以直接取消或再试。
        if (current.phase !== 'requested') return current
        return {
          ...current,
          phase: 'confirming',
          acceptedAt: null,
          waitMs: 0,
          failures: 0,
          error: {
            // 没有宿主错误码（请求根本没发出去）也要给一个**重启自己的**兜底码，
            // 否则 `describeError` 会落进 `error.generic`，把「重启没发出去」说成「删除失败」。
            code: typeof event?.code === 'string' && event.code !== '' ? event.code : 'RESTART_REQUEST_FAILED',
            message: typeof event?.message === 'string' ? event.message : '',
          },
        }
      case 'status':
        return restartAfterStatus(current, event)
      case 'status-failed':
        return restartAfterFailure(current, event)
      default:
        return current
    }
  }

  /** 把毫秒说成「2 小时 13 分」；拿不到数就说 null（不编造）。 */
  function formatDuration(ms, t = translate) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
    const total = Math.floor(ms / 1000)
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    if (hours > 0) return `${hours} ${t('restart.unit.hour')} ${minutes} ${t('restart.unit.minute')}`
    if (minutes > 0) return `${minutes} ${t('restart.unit.minute')} ${seconds} ${t('restart.unit.second')}`
    return `${seconds} ${t('restart.unit.second')}`
  }

  /** 本地时间；认不出就返回 null。 */
  function formatTime(value) {
    const ms = parseTime(value)
    if (ms === null) return null
    try {
      return new Date(ms).toLocaleString()
    } catch {
      return new Date(ms).toISOString()
    }
  }

  /** bootId 只显示前 8 位：完整值对用户没用，但「换没换」看得出来。 */
  function shortenBootId(bootId) {
    const text = String(bootId)
    return text.length > 8 ? `${text.slice(0, 8)}…` : text
  }

  /**
   * 阶段 → 一句话（横幅与设置页共用）。
   *
   * `t` 可选：设置页与横幅各自可能拿到宿主给的取词函数，不传就用插件自己的词表。
   */
  function describeRestartPhase(state, t = translate) {
    switch (state?.phase) {
      case 'confirming': return t('restart.phase.confirming')
      case 'requested': return t('restart.phase.requested')
      case 'shutting-down': return t('restart.phase.shuttingDown')
      case 'starting': return t('restart.phase.starting')
      case 'reconnecting': return t('restart.phase.reconnecting')
      case 'done': return t('restart.phase.done')
      case 'failed': return t('restart.phase.failed')
      default: return ''
    }
  }

  /** 「已等待 N 秒」；只在等新进程时有意义。 */
  function describeRestartWait(state, t = translate) {
    const seconds = Math.floor((typeof state?.waitMs === 'number' ? state.waitMs : 0) / 1000)
    return `${t('restart.banner.wait')} ${seconds} ${t('restart.unit.second')}`
  }

  /** 设置页导航里的页签名（thunk：每次投影时现读，跟着语言走）。取不到也不让导航崩。 */
  function restartSectionLabel() {
    try {
      return translate('restart.sectionLabel')
    } catch {
      return '热重启'
    }
  }

  /**
   * 状态响应里的阻塞项 → 逐行文案（会话标题 / 子代理标注 / 后台任务数）。
   *
   * 拿不到标题就显示会话 id——那是真实信息，比「未知」有用（AGENTS 坑 ⑨）。没有阻塞项返回空数组。
   */
  function describeRestartBlockers(status, t = translate) {
    const lines = []
    const sessions = Array.isArray(status?.blockers?.sessions) ? status.blockers.sessions : []
    for (const row of sessions) {
      const name = typeof row?.title === 'string' && row.title !== '' ? row.title : String(row?.sessionId ?? '')
      if (name === '') continue
      lines.push(row?.descendant === true ? `${name}${t('restart.blockersChild')}` : name)
    }
    const jobs = Number.isInteger(status?.blockers?.jobs) ? status.blockers.jobs : 0
    if (jobs > 0) lines.push(`${t('restart.blockersJobs')}：${jobs}`)
    return lines
  }

  /** 阻塞项 → 确认弹窗里的一句话；没有阻塞项返回 null。 */
  function restartBlockerSummary(status, t = translate) {
    const lines = describeRestartBlockers(status, t)
    if (lines.length === 0) return null
    return `${t('restart.blockersDesc')}（${lines.join('；')}）`
  }

  /** 重启来源：模型 / 用户；未知值原样显示（不编造，AGENTS 坑 ⑨）。 */
  function describeRestartSource(source, t = translate) {
    if (typeof source !== 'string' || source === '') return null
    if (source === 'ui' || source === 'user') return t('restart.sourceUser')
    if (source === 'model' || source === 'agent' || source === 'tool') return t('restart.sourceModel')
    return source
  }

  /** 续作三态：delivered / failed / none；未知值原样显示。 */
  function describeRestartResume(resume, t = translate) {
    if (typeof resume !== 'string' || resume === '') return null
    if (resume === 'delivered') return t('restart.resumeDelivered')
    if (resume === 'failed') return t('restart.resumeFailed')
    if (resume === 'none') return t('restart.resumeNone')
    return resume
  }

  // ---- 模块级状态与轮询（设置页与浮层读同一份，避免两处各猜各的）--------------
  let restartState = initialRestartState()
  /** 轮询定时器句柄；离线测试的 window 替身没有定时器，所以就绪判定要容错。 */
  let restartPollTimer
  let restartStatusInFlight
  let lastRestartPollAt = -Infinity
  /** 首次播种只做一次：页面一加载就去问一次宿主，模型发起的重启也能被横幅看见。 */
  let restartStatusSeeded = false

  function restartSnapshot() {
    return restartState
  }

  function broadcastRestartState(state) {
    try {
      window.dispatchEvent(new CustomEvent(RESTART_CHANGED_EVENT, { detail: state }))
    } catch {
      // 没有可用的 window（极端环境）：状态本身仍然是权威的，界面下次挂载会读到。
    }
  }

  /**
   * 态机的唯一入口。
   *
   * 顺带管两件事：进入「等新进程」时开轮询、离开时关掉；阶段变化时广播一次。
   */
  function dispatchRestart(event) {
    const previous = restartState
    const next = nextRestartPhase(previous, event)
    // 引用相等 = 无效事件（重复提交、非法迁移）：什么都不做，也就不会触发重渲染。
    if (next === previous) return previous
    restartState = next
    if (isRestartWatching(next.phase)) ensureRestartPolling()
    else stopRestartPolling()
    broadcastRestartState(next)
    if (next.phase === 'done' && previous.phase !== 'done') {
      // 刚落定时再问一次：把新进程的 pid / bootId / 「最后一次重启」刷新到界面上。
      // 延迟一点点是为了等辅助进程写下 last.json——探测到 bootId 变化的那次请求，
      // 很可能就是辅助进程自己用来判断就绪的那一次，此刻 last.json 还没落盘。
      // 只在**进入** done 的那一次问：否则一个反复翻动 bootId 的宿主会让这里空转。
      if (typeof window.setTimeout === 'function') {
        window.setTimeout(() => { void pollRestartStatus({ force: true }) }, RESTART_DONE_REFRESH_MS)
      } else {
        void pollRestartStatus({ force: true })
      }
    }
    return next
  }

  function ensureRestartPolling() {
    if (restartPollTimer !== undefined) return
    if (typeof window.setInterval !== 'function') return
    restartPollTimer = window.setInterval(() => {
      void pollRestartStatus({ force: true })
    }, RESTART_POLL_INTERVAL_MS)
  }

  function stopRestartPolling() {
    if (restartPollTimer === undefined) return
    window.clearInterval?.(restartPollTimer)
    restartPollTimer = undefined
  }

  /**
   * 拉一次重启状态并喂给态机。
   *
   * 重启期间这个请求**必然**失败（HTTP 不可达）——那正是 `starting` / `reconnecting` 的信号，
   * 所以失败只是「又试了一次」，绝不直接渲染成红色错误；真正的失败线是 120 秒超时。
   *
   * @param {{ force?: boolean }} [options] `force` 绕过节流（轮询与首次播种用）。
   */
  async function pollRestartStatus(options) {
    const force = options?.force === true
    const now = Date.now()
    // 节流 + 单飞：设置页挂载、浮层挂载、轮询定时器三处都会调它，不节流就会打出一串重复请求。
    if (!force && now - lastRestartPollAt < RESTART_POLL_INTERVAL_MS) return undefined
    if (restartStatusInFlight !== undefined) return restartStatusInFlight
    lastRestartPollAt = now
    const inFlight = (async () => {
      try {
        const payload = await callHost(API.restartStatus)
        dispatchRestart({ type: 'status', payload, at: Date.now() })
      } catch (failure) {
        dispatchRestart({ type: 'status-failed', at: Date.now(), code: failure?.code })
      }
    })()
    restartStatusInFlight = inFlight
    try {
      await inFlight
    } finally {
      if (restartStatusInFlight === inFlight) restartStatusInFlight = undefined
    }
    return undefined
  }

  /**
   * 提交重启请求（用户侧唯一入口）。
   *
   * 成功（202）⇒ 进「重启中」并开始等新进程；失败 ⇒ 把宿主给的原因留在确认弹窗里，
   * 阶段退回「确认中」——**绝不假装重启成功了**。
   */
  async function submitRestart() {
    // 第二道门：只有真的在「确认中」才发请求（按钮禁用是第一道）。
    if (restartSnapshot().phase !== 'confirming') return
    dispatchRestart({ type: 'submit' })
    try {
      const payload = await callHost(API.restart, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-agent-control': '1' },
        // 用户点按钮本身就是授权（计划 3.4），所以不带 force（强制重启属 M5，未做）。
        body: JSON.stringify({ reason: translate('restart.uiReason') }),
      })
      dispatchRestart({
        type: 'accepted',
        restartId: typeof payload?.restartId === 'string' ? payload.restartId : null,
        at: Date.now(),
      })
    } catch (failure) {
      dispatchRestart({
        type: 'rejected',
        // 没有宿主错误码（请求根本没发出去 / 网络断开）时给一个**重启自己的**兜底码：
        // 否则会落进 `error.generic`，把「重启没发出去」显示成「删除失败」。
        code: typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'RESTART_REQUEST_FAILED',
        message: failure?.message,
        at: Date.now(),
      })
    }
  }

  /** 超时失败后的手动入口：整页刷新是**用户点**的，不是我们偷偷做的（SPIKE S4 的结论）。 */
  function refreshPage() {
    try {
      window.location.reload()
    } catch {
      // 没有 location（离线替身）时什么都不做：横幅仍然给出「请手动启动」的提示。
    }
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

    /**
     * 订阅模块级的重启状态。
     *
     * 设置页与浮层横幅是两个独立的 React 树，靠广播事件同步同一份状态；
     * 首次渲染直接读快照（挂载之前发生的变化也不会漏）。
     */
    const useRestartState = () => {
      const [state, setState] = useState(restartSnapshot())
      useEffect(() => {
        const onChange = (event) => setState(event?.detail ?? restartSnapshot())
        window.addEventListener(RESTART_CHANGED_EVENT, onChange)
        return () => window.removeEventListener(RESTART_CHANGED_EVENT, onChange)
      }, [])
      return state
    }

    /**
     * 原生 `Button` 或兜底按钮。
     *
     * 兜底是**直接调用**的函数（见 `FallbackButton`），所以它在元素树里就是一个真正的
     * `button` 节点——离线测试能断言到它，功能也不会因为拿不到原生原语而丢失。
     */
    const renderButton = (props) => {
      const { icon, children, ...rest } = props
      if (Button !== undefined) return react.createElement(Button, { ...rest, icon }, children)
      return FallbackButton({ ...rest, icon, children })
    }

    /** 主按钮上的刷新图标（原生或兜底；兜底永远存在，所以不会编造图标）。 */
    const restartIcon = () => react.createElement(IconRefreshOutlineRegular, { size: 16 })

    /** 键值网格（两列）：键 tertiary、值 primary，数字用 tabular-nums 对齐（见 STYLE_CSS）。 */
    const renderKeyValues = (pairs) => react.createElement(
      'div',
      { className: KV_CLASS },
      ...pairs.flatMap(([key, value], index) => [
        react.createElement('span', { className: KV_KEY_CLASS, key: `k${index}` }, key),
        react.createElement('span', { className: KV_VALUE_CLASS, key: `v${index}` }, value),
      ]),
    )

    /**
     * 设置页「热重启」。
     *
     * 自上而下：**运行状态 → 阻塞提示 → 主按钮 → 最近一次重启**。
     * 数据只来自 `GET /restart/status`；能不能重启、有没有阻塞项都由宿主判定，
     * 这里只把宿主给的答案画出来，**拿不到的字段一律不显示**（AGENTS 坑 ⑨）。
     */
    const RestartSection = () => {
      const state = useRestartState()
      const status = state.status
      const phase = state.phase
      const busy = isRestartBusy(phase)
      const canRestart = status?.canRestart !== false
      const unsupportedReason = typeof status?.unsupportedReason === 'string' && status.unsupportedReason !== ''
        ? status.unsupportedReason
        : null
      const t = translate

      useEffect(() => {
        // 打开设置页时刷新一次：既拿到运行状态，也能发现「模型刚发起的重启」（内部有节流）。
        void pollRestartStatus()
      }, [])

      const rows = []

      // ① 运行状态（版本 / 进程号 / 已运行 / 端口 / bootId 简写）
      const runtime = []
      if (typeof status?.version === 'string' && status.version !== '') {
        runtime.push([t('restart.field.version'), status.version])
      }
      if (Number.isInteger(status?.pid)) runtime.push([t('restart.field.pid'), String(status.pid)])
      const uptimeMs = elapsedSince(parseTime(status?.startedAt), Date.now())
      if (uptimeMs !== null) runtime.push([t('restart.field.uptime'), formatDuration(uptimeMs)])
      if (Number.isInteger(status?.port)) runtime.push([t('restart.field.port'), String(status.port)])
      if (typeof status?.bootId === 'string' && status.bootId !== '') {
        runtime.push([t('restart.field.bootId'), shortenBootId(status.bootId)])
      }
      rows.push(react.createElement(
        'div',
        { className: ROW_CLASS, key: 'runtime' },
        react.createElement(
          'div',
          { className: ROW_MAIN_CLASS },
          react.createElement('div', { className: ROW_TITLE_CLASS }, t('restart.statusTitle')),
          react.createElement('div', { className: ROW_DESC_CLASS }, t('restart.statusDesc')),
        ),
        runtime.length > 0
          ? renderKeyValues(runtime)
          : (status === null ? react.createElement('div', { className: HINT_CLASS }, t('restart.statusLoading')) : null),
      ))

      // ② 阻塞提示：有几个会话 / 后台任务在忙，列出标题与数量
      const blockerLines = describeRestartBlockers(status)
      if (blockerLines.length > 0) {
        rows.push(react.createElement(
          'div',
          { className: ROW_CLASS, key: 'blockers' },
          react.createElement(
            'div',
            { className: ROW_MAIN_CLASS },
            react.createElement('div', { className: ROW_TITLE_CLASS }, t('restart.blockersTitle')),
            react.createElement('div', { className: ROW_DESC_CLASS }, t('restart.blockersDesc')),
            ...blockerLines.map((line, index) => react.createElement(
              'div',
              { className: BLOCKER_CLASS, key: `blocker-${index}` },
              `· ${line}`,
            )),
          ),
        ))
      }

      // ③ 主按钮（危险态）：重启期间禁用并显示进度，不允许重复提交
      const note = busy
        ? `${describeRestartPhase(state)} · ${describeRestartWait(state)}`
        : phase === 'done'
          ? t('restart.doneNote')
          : phase === 'failed'
            ? t('restart.failedNote')
            : unsupportedReason ?? (canRestart ? t('restart.actionDesc') : t('restart.unsupported'))
      const actions = []
      if (phase === 'failed') {
        // 超时失败的人工入口（横幅在设置面板后面看不见，这里再给一个）。
        actions.push(renderButton({
          key: 'refresh',
          variant: 'outline',
          size: 'sm',
          onClick: refreshPage,
          children: t('restart.refresh'),
        }))
      }
      actions.push(renderButton({
        key: 'restart',
        variant: 'primary',
        className: DANGER_CLASS,
        disabled: busy || !canRestart,
        onClick: requestRestartDialog,
        icon: restartIcon(),
        children: busy ? t('restart.actionBusy') : t('restart.action'),
      }))
      rows.push(react.createElement(
        'div',
        { className: ROW_CLASS, key: 'action' },
        react.createElement(
          'div',
          { className: ROW_MAIN_CLASS },
          react.createElement('div', { className: ROW_TITLE_CLASS }, t('restart.action')),
          react.createElement('div', { className: ROW_DESC_CLASS }, note),
          state.error !== null
            ? react.createElement('div', { className: ERROR_CLASS }, describeError(state.error))
            : null,
        ),
        react.createElement('div', { className: ACTIONS_CLASS }, ...actions),
      ))

      // ④ 最近一次重启：时间、来源、原因、耗时、续作结果
      const last = status?.last !== null && typeof status?.last === 'object' ? status.last : null
      const lastPairs = []
      if (last !== null) {
        const finishedAt = formatTime(last.finishedAt)
        if (finishedAt !== null) lastPairs.push([t('restart.lastTime'), finishedAt])
        const source = describeRestartSource(last.source)
        if (source !== null) lastPairs.push([t('restart.lastSource'), source])
        if (typeof last.reason === 'string' && last.reason !== '') {
          lastPairs.push([t('restart.lastReason'), last.reason])
        }
        const duration = formatDuration(typeof last.durationMs === 'number' ? last.durationMs : null)
        if (duration !== null) lastPairs.push([t('restart.lastDuration'), duration])
        // 成败只在宿主明确给了布尔值时才说：拿不到就整行不显示，不默认成「成功」（AGENTS 坑 ⑨）。
        if (typeof last.ok === 'boolean') {
          lastPairs.push([t('restart.lastResult'), last.ok ? t('restart.lastOk') : t('restart.lastFailed')])
        }
        const resume = describeRestartResume(last.resume)
        if (resume !== null) lastPairs.push([t('restart.lastResume'), resume])
        if (last.ok === false && typeof last.error === 'string' && last.error !== '') {
          lastPairs.push([t('restart.lastError'), last.error])
        }
        if (typeof last.logFile === 'string' && last.logFile !== '') {
          lastPairs.push([t('restart.lastLogFile'), last.logFile])
        }
      }
      rows.push(react.createElement(
        'div',
        { className: ROW_CLASS, key: 'last' },
        react.createElement(
          'div',
          { className: ROW_MAIN_CLASS },
          react.createElement('div', { className: ROW_TITLE_CLASS }, t('restart.lastTitle')),
          lastPairs.length === 0 ? react.createElement('div', { className: ROW_DESC_CLASS }, t('restart.lastEmpty')) : null,
        ),
        lastPairs.length > 0 ? renderKeyValues(lastPairs) : null,
      ))

      return react.createElement(
        'div',
        { className: SECTION_CLASS },
        react.createElement('h2', { className: HEADING_CLASS }, t('restart.title')),
        react.createElement('p', { className: INTRO_CLASS }, t('restart.intro')),
        ...rows,
      )
    }

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

    /**
     * `shell.overlay` 里**唯一**的弹窗宿主。
     *
     * 两类确认（删除 / 重启）走同一个事件模式、同一个宿主：按钮只派发 `…:request-*`，
     * 这里统一监听并渲染，所以永远不会出现两个弹窗同时响应，也没有第二个 overlay 槽位注册。
     * 重启期间的**非阻塞横幅**也挂在同一条注册上——它在设置面板关着时也得看得见。
     */
    const OverlayDialogs = (props) => {
      const t = props.t ?? translate
      const [target, setTarget] = useState(null)
      const [acknowledged, setAcknowledged] = useState(false)
      const [busy, setBusy] = useState(false)
      const [resolving, setResolving] = useState(false)
      const [error, setError] = useState(null)
      const [restartAcknowledged, setRestartAcknowledged] = useState(false)
      const restart = useRestartState()
      const status = restart.status

      useEffect(() => {
        const onRequest = (event) => {
          setAcknowledged(false)
          setError(null)
          setBusy(false)
          setResolving(false)
          setTarget(event.detail ?? null)
        }
        const onRestartRequest = () => {
          // 勾选状态每次重新问（与删除弹窗同一个约定）；被拒后阶段仍然停在 confirming，
          // 所以原因看得见、勾选也不用重来。
          setRestartAcknowledged(false)
          dispatchRestart({ type: 'confirm' })
        }
        window.addEventListener(REQUEST_EVENT, onRequest)
        window.addEventListener(RESTART_REQUEST_EVENT, onRestartRequest)
        // 播种一次状态：模型发起的重启不需要用户先打开设置页就能被横幅看见。
        if (!restartStatusSeeded) {
          restartStatusSeeded = true
          void pollRestartStatus({ force: true })
        }
        return () => {
          window.removeEventListener(REQUEST_EVENT, onRequest)
          window.removeEventListener(RESTART_REQUEST_EVENT, onRestartRequest)
        }
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

      /** 删除确认；确认前必须显式勾选。 */
      const renderDeleteConfirm = () => {
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

      /**
       * 重启确认。
       *
       * `requested` 阶段弹窗**不关**：POST 还在飞，按钮要显示进度并保持禁用
       * （不允许重复提交）。被拒时阶段退回 `confirming`，宿主给的原因就显示在这里。
       */
      const renderRestartConfirm = () => {
        const submitting = restart.phase === 'requested'
        if (restart.phase !== 'confirming' && !submitting) return null
        const lines = [t('restart.dialog.body')]
        const blockers = restartBlockerSummary(status, t)
        if (blockers !== null) lines.push(blockers)
        if (restart.error !== null) lines.push(`⚠ ${describeError(restart.error)}`)
        return react.createElement(RiskConfirmation, {
          open: true,
          title: t('restart.dialog.title'),
          description: lines.join('\n\n'),
          acknowledgeLabel: t('restart.dialog.ack'),
          cancelLabel: t('dialog.cancel'),
          closeLabel: t('dialog.close'),
          confirmLabel: submitting ? t('restart.dialog.working') : t('restart.dialog.confirm'),
          acknowledged: restartAcknowledged,
          disabled: submitting,
          onAcknowledgedChange: setRestartAcknowledged,
          // 提交中不允许取消（态机里也拦一次，两道门）。
          onCancel: () => { dispatchRestart({ type: 'cancel' }) },
          onConfirm: () => { void submitRestart() },
        })
      }

      /**
       * 重启进度横幅（非阻塞）。
       *
       * 重启期间与**超时失败后**显示；`bootId` 一变（`done`）立刻收起——这是计划 2.3 要求的
       * 「不打断用户正在看的内容」，所以这里**不**做整页刷新（SPIKE S4）。
       */
      const renderRestartBanner = () => {
        const failed = restart.phase === 'failed'
        if (!failed && !isRestartWatching(restart.phase)) return null
        const detail = failed
          ? t('restart.banner.failedDetail')
          : `${describeRestartPhase(restart, t)} · ${describeRestartWait(restart, t)}`
        const children = [
          react.createElement('span', { className: BANNER_TITLE_CLASS, key: 'title' },
            failed ? t('restart.banner.failedTitle') : t('restart.banner.title')),
          react.createElement('span', { className: BANNER_DETAIL_CLASS, key: 'detail' }, detail),
        ]
        if (failed) {
          // 拿得到日志文件名就显示它，拿不到就说日志目录——不编一个文件名出来（AGENTS 坑 ⑨）。
          const logFile = typeof status?.last?.logFile === 'string' && status.last.logFile !== ''
            ? status.last.logFile
            : null
          children.push(react.createElement('span', { className: ERROR_CLASS, key: 'hint' },
            logFile === null ? t('restart.banner.logHint') : `${t('restart.lastLogFile')}：${logFile}`))
          children.push(renderButton({
            key: 'refresh',
            variant: 'outline',
            size: 'sm',
            onClick: refreshPage,
            children: t('restart.refresh'),
          }))
          children.push(renderButton({
            key: 'dismiss',
            variant: 'ghost',
            size: 'sm',
            onClick: () => { dispatchRestart({ type: 'dismiss' }) },
            children: t('dialog.close'),
          }))
        }
        return react.createElement(
          'div',
          { className: BANNER_CLASS, role: 'status', 'aria-live': 'polite' },
          react.createElement('div', { className: BANNER_CARD_CLASS }, ...children),
        )
      }

      const banner = renderRestartBanner()
      const restartConfirm = renderRestartConfirm()
      const deleteConfirm = renderDeleteConfirm()
      // 什么都没有时返回 null：槽位在「没事发生」时不该往页面上放节点。
      if (banner === null && restartConfirm === null && deleteConfirm === null) return null
      return react.createElement(react.Fragment, null, banner, restartConfirm, deleteConfirm)
    }

    return { SessionMenuDelete, TurnDeleteAction, DeletedTurnMarker, RestartSection, OverlayDialogs }
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
    }, ui.OverlayDialogs))

    // 设置页「热重启」。原生页签是 account -10 / general 0 / models 10 / plugins 15 /
    // agent-presets 20；本插件是附加页，排在最后。`label` 用 thunk 跟着语言走（宿主每次
    // 投影都会重新读它，见 dsh-client-ui-slots 的 resolveSlotLabel），不需要重新注册。
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: ENTRY.restartSection,
      order: 500,
      label: () => restartSectionLabel(),
    }, ui.RestartSection))
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
      // 原生 `Button` 拿不到就退回自带按钮（度量照抄，功能不丢）；图标同理。
      Button = typeof primitives?.Button === 'function' ? primitives.Button : undefined
      IconRefreshOutlineRegular = typeof primitives?.IconRefreshOutlineRegular === 'function'
        ? primitives.IconRefreshOutlineRegular
        : FallbackRefreshIcon
      ensureStyles()
      return { apply, inject: ['slots'] }
    },
  })

  // 排障用抓手：出问题时可以在浏览器控制台确认「注册成功了吗、用的是原生原语还是兜底」；
  // `restart` 那组还能手动推进态机（离线测试也用它）。
  window.__dshAgentControl = {
    id: PLUGIN_ID,
    apply,
    fallbacks: { FallbackTrashIcon, FallbackRiskConfirmation, FallbackButton, FallbackRefreshIcon },
    syncTurnRows,
    usingNativePrimitives: () => RiskConfirmation === undefined
      ? null
      : RiskConfirmation !== FallbackRiskConfirmation,
    /** 主按钮这次用的是原生 `Button` 还是自带兜底（排障与测试都靠它）。 */
    usingNativeButton: () => Button !== undefined,
    restart: {
      phases: RESTART_PHASES,
      constants: {
        pollIntervalMs: RESTART_POLL_INTERVAL_MS,
        timeoutMs: RESTART_TIMEOUT_MS,
        reconnectAfterMs: RESTART_RECONNECT_AFTER_MS,
      },
      initial: initialRestartState,
      next: nextRestartPhase,
      snapshot: restartSnapshot,
      dispatch: dispatchRestart,
      reset: () => dispatchRestart({ type: 'reset' }),
      poll: pollRestartStatus,
      submit: submitRestart,
      describeBlockerLines: (status) => describeRestartBlockers(status),
    },
  }
})()
