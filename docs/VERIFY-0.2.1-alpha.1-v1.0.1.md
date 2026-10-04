# VERIFY — 0.2.1-alpha.1-v1.0.1

本文件记录 `dsh-agent-control@0.2.1-alpha.1-v1.0.1` 在真实 profile 上的实测结论。
**只写实测到的**；没测的一律列在最后「未验证」一节，不要当成通过。

实测环境：DSH `0.2.1-alpha.1`，本机 profile。
本轮改的是**客户端**——两个删除入口的槽位与样式；host 端与 `0.2.0-rc.2-v1.0.0` 逐字相同。
离线侧：`node --check` 全部通过，四个测试文件逐个直接跑 **84 项全绿**（28 + 23 + 25 + 8）。

> ⚠️ 受限沙箱里 `npm test` 会假失败：`node --test` 默认要为每个文件 spawn 子进程并走管道，
> 报 `Error: spawn EPERM`，四个文件全 ✖，看起来像测试坏了。那是沙箱边界不是测试失败——
> 逐个直接跑 `node test/<文件>.test.mjs` 同样 84 项全绿。

---

## 1. 会话「…」菜单里的删除项 ✅

| 项 | 之前 | 现在（实测） |
| --- | --- | --- |
| 位置 | `order: 40`，排在原生项**之前** | `order: 500`。原生项是 100 置顶 / 200 重命名 / 300 分叉 / 400 归档，所以删除排在**最后** ✅ |
| 大小 | 手写的按钮：内边距 `6px 10px`、**没有最小高度**，比其它项小 | 改用 DSH 自带的菜单行组件 `MenuItemButton`：高度、字号、图标大小、悬停底色都与其它四项一致 ✅ |
| 危险样式 | 只有红色文字 | 红色字与图标、悬停时的红色底都由 `danger` 给出；另外在它上方加了一条**分组细线**，与普通操作隔开 ✅ |

判据：拿同一列里另外四项（置顶 / 重命名 / 分叉 / 归档）当对照——行高、图标尺寸与悬停底色看不出差别，
删除项在最下，且与归档之间有一条细线。

## 2. 回复操作条的垃圾桶按钮 ✅

按 DSH 设计风格逐条核对，不符合的都改了：

| 项 | 之前 | 现在（实测） |
| --- | --- | --- |
| 形状 | 28px 的**圆形**按钮 | 圆角改用 `--dsw-radius-sm`，与同一条操作栏里的「复制 / 分叉」同款 ✅ |
| 图标 | 16px | 17px（该操作栏的原生尺寸） ✅ |
| 悬停 | 没有悬停变色 | 悬停换 `--dsw-alias-interactive-bg-hover` 底色 ✅ |
| 提示 | 浏览器自带的 `title` | DSH 自带的气泡 `Tooltip`，弹在按钮**下方**，与复制按钮的提示一致 ✅ |
| 任务运行中禁用 | 自带透明度 | `data-unavailable`（透明度 0.4），与原生同 ✅ |

- 悬停 / 聚焦 / 禁用都是**伪类**，内联样式写不了，所以插件注入了一小段 CSS，**选择器带本插件前缀**。
- **兜底**：`MenuItemButton` 与 `Tooltip` 取不到时会退回自带的样式；兜底样式的度量也改成与 DSH 菜单一致，
  并统一用 `--dsw-*` 变量，**没有写死色值**。
- **没改的**：确认弹窗本来就用 DSH 自带的 `RiskConfirmation`，而且要先勾选才能确认，保持原样。

## 3. 离线侧 ✅

`test/client.test.mjs`：补上新用到的两个原生组件（`MenuItemButton` / `Tooltip`），并新增两项断言——
① 删除项用的是**危险样式的原生行**；② 它**排在归档（400）之后**。测试总数 83 → **84 项**。
`AGENTS.md` 的槽位表（order 与两条说明）与测试计数同步更新。

## 4. 可复核的静态依据

这几条是**对着安装包逐个核对**出来的（不是按记忆写的），决定「用的东西真的存在」：

| 断言 | 核对处 |
| --- | --- |
| `MenuItemButton` 存在，且支持 `danger` / `separatorBefore` / `onSelect` / `icon` / `children` | `@deepseek-ai/dsh-client-ui-primitives` 的 `lib/types/Menu.d.ts` |
| `Tooltip` 支持 `label` 与 `side: 'bottom'` | 同包的 `lib/types/Tooltip.d.ts` |
| 原生菜单顺序确实是 100 / 200 / 300 / 400 | `@deepseek-ai/dsh-client-ui-workspace` 的 README 与 `lib/client.js` |
| 操作栏原生度量：`28px + var(--dsh-content-font-delta)`、内边距 6、`--dsw-radius-sm`、tertiary 色、悬停换 `interactive-bg-hover` + `label-secondary` | `@deepseek-ai/dsh-client-ui-chat` 的 `lib/client.js`（源文件 `MessageIconActions.module.css`） |
| 图标 17px 对应的是 `clock: "end"` 变体（默认 15px），而 `conversation.chat.assistant-actions` 那一处就是 `clock: "end"` | 同上 |
| 注入样式表里用到的每个设计 token 都真实存在 | 原生组件各自的 `*.module.css` |

## 5. 未验证（不要当成通过）

- 承接上一份记录里仍未收口的项：**`DELETE_FAILED` 从真实失败渲染**
  （`VERIFY-0.2.0-rc.2-v1.0.0.md` 第 11.7 节）、**超时上限触发**（`AGENT_BUSY`）、**请求体上限 64 KiB**、
  **删除轮次对附件无效**的真机样本。
- **本轮没有重跑删除链路**：host 端代码与 `0.2.0-rc.2-v1.0.0` 相同，所以第 9 节那些
  「删一轮 / 删会话 / 重启后再打开会话」的结论仍然只有 v1.0.0 那一轮的证据
  （`VERIFY-0.2.0-rc.2-v1.0.0.md` 第 8、11、12 节），**本轮未复验**。
- **兜底路径没有在真机上模拟**：把 `MenuItemButton` / `Tooltip` 拿掉之后界面到底长什么样，
  只有离线测试覆盖，没在活页面上试过。
- ⚠️ **换 harness 后 host 端契约未重核**：本版本的 harness 前缀是 `0.2.1-alpha.1`，而
  `ctx.sessions` / `session.append` / `runMaintenance` / `storageDomain` 这些签名是在 `0.2.0-rc.2` 上核对的
  （AGENTS.md 第 4 节要求换版本时用 `cordis_inspect_query` 逐个重核）。本轮只核对了**客户端**用到的原语。
