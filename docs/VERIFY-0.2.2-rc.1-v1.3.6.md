# VERIFY — 0.2.2-rc.1-v1.3.6

> 这一版把插件接到 harness `0.2.2-rc.1` 版本线上。插件业务代码与 v1.3.5 完全相同；唯一的代码性改动是
> `package.json` 增加 `engines.dsh` 兼容声明（0.2.2 起宿主会检查它）。

## 1. 改了什么

| 位置 | 改动 |
| --- | --- |
| package.json | `version` 从 `0.2.1-rc.5-v1.3.5` 提到 `0.2.2-rc.1-v1.3.6`；`engines` 增加 `"dsh": ">=0.2.2-rc.1"` |
| 分支 | 新开 `0.2.2-rc.1-v1.3.6/dev`，验收后改名发布 |
| 代码 | 无变更（`src/` 与 `client.js` 与 v1.3.5 相同） |
| AGENTS.md | 第 6 节版本号示例更新；第 4 节补插件兼容性声明的说明 |

## 2. 公开 API 侦察（0.2.1-rc.5 → 0.2.2-rc.1）

对两版全部 `@deepseek-ai` 包做文件级 SHA-256 对比（目录名 hash 只当构建元数据），再对差异文件逐行 diff：

- **插件依赖的 host 契约没变**：`ctx.sessions.get/list`、`session.snapshotEvents`、`session.surface.nodes`、
  `append` 的 `surfaceOp` 校验、`agent.cancel/whenIdle/runMaintenance` 的租约语义、`ctx.storageDomain.get().table/.global`、
  `ctx.webServer.register({kind,path,handler})` 与 disposer、`api-session/removed` / `compaction/*` / `user/message` /
  `approval/request` / `pluginManager/setPluginEnabled` 事件、`permissionPresets.current()`、`agentDefaultModel.currentSelection()`
  —— 方法体逐字相同或仅注释变化。
- **客户端契约没变**：`window.__ModuleLoader__.load` 形状、`require` 注入、插件用到的 5 个槽位与 owner props、
  主题 token、locale 注册签名。前端 bundle 的模块表仍提供 `@deepseek-ai/dsh-client-ui-primitives`（`RiskConfirmation` 等导出都在）。
  唯一新增槽位 `settings.section.icon` 是可选、向后兼容。
- **有变化但不破坏旧插件**：
  - `dsh-session` 给 `append` 加了两条新守卫（store-owned 会话必须先 `enter`、且 `session/created` announce 完成前禁止写）。
    对正常活动会话无影响；只有「会话刚恢复、announce 未完成就收到删轮次请求」这种窄竞态会变成 `DELETE_FAILED`。
  - 侧栏会话「…」菜单改由新的 context-menu 机制承载，旧槽位 `sidebar.workspaces.session.menu.item` 通过 legacy 适配器保留，
    删除项仍会渲染（位置可能变化）。
  - `dsh-storage-domain` 新增 `deleteMany` 与 unknown-state 隔离；`dsh-host-webserver` 新增 resource 路由（`register` 不变）。
- **格式类包逐字节相同**：`dsh-session-format`、`dsh-compaction`、`dsh-agent-default-model`、`dsh-client-ui-renderer` 的客户侧——
  轮次删除写的事务仍能通过加载期校验（下面用 0.2.2 自带校验器实测复核）。
- **新增插件兼容性检查**：0.2.2 的 `dsh plugin` 会检查插件 `package.json` 的顶层 `engines.dsh`（或 `@deepseek-ai/dsh-*` peerDeps），
  不满足时要求 `dsh plugin allow-version <pkg@ver> --dsh-version <ver> --accept-risk`。本版因此显式声明 `engines.dsh`。

## 3. 怎么测的

**离线**：`node --check` 全部通过；八个测试文件逐个直跑，314 项全过
（client 71 / host 81 / features 16 / locale 5 / session-delete 40 / turn-delete 25 / restart 54 / restart-helper 22）。

**真机（主实例，harness `0.2.2-rc.1`，插件以 `link:` 指向本地工作副本）**：热重启后验证：

| 验证项 | 结果 |
| --- | --- |
| 插件加载 | `/restart/status` 报 `version: 0.2.2-rc.1-v1.3.6`，bootId 与 pid 均更新 |
| 组件探针 | `/session/status`、`/turn/status`、`/restart/status` 三条 200；`/sessions` 200 |
| 四行结构 | `--dump-config` 组合树含主行与 session / turn / restart 三个组件行 |
| 热重启 | 在 0.2.2 上可用：`last.ok: true`，耗时约 12 秒，重启后本会话自动续作 |

**真机（隔离实例，独立 `DSH_HOME` 与独立端口，插件同一份本地副本）**：

| 验证项 | 结果 |
| --- | --- |
| 界面删除入口 | 每条已结束回复旁出现「删除这一轮」；确认弹窗文案写明「不是彻底清除」，须勾选才能删 |
| 删中间一轮 | 提交后界面出现「上下文已压缩」（约 8.4K tokens）；`GET /turns` 返回 `[1]` |
| 删除事务合法性 | `log-inspect`：1 笔事务，遮蔽 6 个节点（9..21），落在轮次之间，事务检查 ✅ 完整；被删内容仍留在日志 |
| 0.2.2 自带加载校验器 | 原日志 OK；旧墓碑 FAIL（对照组）；已删轮次规划拒绝 `TURN_COMPACTED`；另一轮按当前写法删除 OK |
| 重启后持久性 | 重启该实例后重新打开会话：已删轮次仍不出现，`GET /turns` 仍为 `[1]`，会话正常加载 |
| 删活会话 | `wasLive: true`、`detached: true`；目录与投影缓存均 gone；磁盘上 `sessions/` 与投影缓存零残留，会话列表清空 |

## 4. 仍然未验证

1. `DELETE_FAILED` 失败路径的真实渲染（需要人为制造内部错误）。
2. 幽灵会话清理、裸 UUID 拼写、派生过子代理的会话删除（本轮不碰真实数据，未重跑）。
3. 组件行开关在 0.2.2 插件管理器里的行为（关主行/组件行后的 pending 与 401）。
4. 0.2.2 侧栏 context-menu 下删除项的实际位置（未用人眼确认排序位置）。
5. `engines.dsh` 声明在 0.2.2 插件管理器中的展示与拦截效果（未构造不兼容版本验证 `allow-version` 流程）。

## 5. 隐私检查

已过（0 处待办）。
