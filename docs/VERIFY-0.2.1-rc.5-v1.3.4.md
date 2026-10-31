# VERIFY — 0.2.1-rc.5-v1.3.4

> 这一版把插件接到 harness `0.2.1-rc.5` 版本线上。插件代码与 v1.3.3 完全相同，只改版本号；适配结论是**不需要改代码**。

## 1. 改了什么

| 位置 | 改动 |
| --- | --- |
| package.json | `version` 从 `0.2.1-rc.2-v1.3.3` 提到 `0.2.1-rc.5-v1.3.4` |
| 分支 | 新开 `0.2.1-rc.5-v1.3.4/dev`，验收后改名发布 |
| 代码 | 无变更（`src/` 与 `client.js` 与 v1.3.3 相同） |

## 2. 公开 API 侦察（rc.2 → rc.5）

对两版全部 `@deepseek-ai/dsh-*` 包做文件级哈希对比（排除 README / LICENSE / package.json），再对差异文件逐行 diff：

- 插件依赖的 host 服务包——`dsh-session`、`dsh-agent`、`dsh-host-webserver`、`dsh-plugin-manager`、`dsh-storage-domain`、`dsh-user-approval`、`dsh-jobs`、`dsh-workspace`、`dsh-host-plugin-inventory`、`dsh-tools`——**代码逐字节相同**，只有 package.json 里的版本号不同。
- 有实质差异的 23 个包集中在 LLM/账户目录、MCP、客户端 UI 渲染与前端产物。
- 插件注册的 5 个槽位在 rc.5 仍然存在、owner props 未变：`sidebar.workspaces.session.menu.item`、`conversation.chat.assistant-actions`、`conversation.chat.turnTail`、`shell.overlay`、`settings.section`。rc.5 只新增了 3 个槽位，没有删除或改型。
- `dsh-client-modules`（`window.__ModuleLoader__`）的唯一差异是内嵌 commit 字符串；`dsh-cordis-client-runner` 的非注释差异全部是内嵌的服务/槽位目录文档，机制代码未动。
- rc.5 新增包 `@deepseek-ai/dsh-client-ui-entry-customization`（插件条目钉选与 More 菜单），与插件的删除按钮不在同一批槽位。

## 3. 怎么测的

**离线**：代码与 v1.3.3 相同，八个测试文件 314 项已在该版本上全过；本版没有重复跑。

**真机（隔离实例）**：在一个独立 `DSH_HOME` 的临时实例上跑完整破坏性验证，不碰真实数据。插件以本地副本挂进该实例的 profile。

| 验证项 | 结果 |
| --- | --- |
| 插件加载 | `/restart/status` 报 `0.2.1-rc.5-v1.3.4`，三条组件探针 200 |
| 客户端 bundle | 槽位按钮正常渲染，确认弹窗是原生 `RiskConfirmation` |
| 删中间一轮 | 界面出现「上下文已压缩」，前后轮次完好 |
| 删除事务合法性 | 1 笔事务，`事务检查：✅ 完整，落在轮次之间` |
| 被删内容仍在磁盘 | `log-inspect` 还原出被遮蔽的用户消息与回复 |
| `GET /turns` | 删中间轮后 `[2]`；再删最后一轮后 `[2,3]` |
| 重复删同一轮 | `200 {"alreadyDeleted": true}`（幂等，不是报错） |
| 删最后一轮后追加新消息 | 正常追加，新轮次出现 |
| 删整个活会话 | `wasLive: true`、`detached: true`，会话目录与投影缓存零残留 |
| 界面就地刷新 | 侧栏会话消失，主区回到空白 |
| 重启后持久性 | 重启实例后重新打开会话：`GET /turns` 仍为 `[2]`，被删轮次不出现，会话能正常加载 |
| 关闭实例 | `POST /shutdown` → 202，进程正常退出 |

## 4. 仍然未验证

1. 失败路径 `DELETE_FAILED` 的真实渲染（需要人为制造内部错误）。
2. 幽灵会话（只存在于工作区记账、磁盘无目录）的清理。
3. 派生过子代理的会话删除（子代理目录与缓存一起消失）。
4. 裸 UUID 拼写（`<uuid>` 而不是 `session-<uuid>`）的会话删除。
5. 界面上的主行 / 组件行开关（关掉后组件行停在 pending、探针 401）。

## 5. 隐私检查

隐私检查：已过（0 处待办）。
