# VERIFY — 0.2.2-rc.1-v1.3.7

> 本版**只改文档**（插件代码与 v1.3.6 完全相同），把 v1.3.6 记录里「仍然未验证」的项补测完，
> 结论落在这里。验证在**隔离实例**（独立 `DSH_HOME`、独立端口、不碰真实数据）上进行；
> 被测插件是该版本线已发布的 GitHub 包（以 junction 复用真实 profile 的依赖树）。

## 1. 改了什么

| 位置 | 改动 |
| --- | --- |
| package.json | `version` 从 `0.2.2-rc.1-v1.3.6` 提到 `0.2.2-rc.1-v1.3.7` |
| 代码 | 无变更（`src/`、`client.js`、`cordis.patch.yml` 与 v1.3.6 相同） |
| 文档 | 新增本文件；v1.3.6 的记录保持原样（已发布版本的文件不改） |

## 2. 补测结果

### 2.1 `DELETE_FAILED` 的真实渲染 ✅

做法：独占打开（`FileShare.None`）测试会话的日志文件，再在界面上走完整删除流程（会话行菜单 → 删除会话… →
勾选确认 → 删除）。

- 弹窗保留，显示「⚠ 宿主拒绝了这次删除（EPERM, Permission denied: …）」并附原始路径错误；
- **没有**显示成「任务正在运行」（证明内部故障确实归到 `DELETE_FAILED`，不是 `AGENT_BUSY`）；
- 失败后会话仍在、记账未被破坏，重试（释放锁后）可正常删除。

### 2.2 幽灵会话清理 ✅

做法：重启实例（会话变为 detached）→ 把该会话的磁盘目录整体移走（模拟目录已不存在）→ 查询 → 删除。

- `GET /sessions` 仍列出该会话（`live: false`、`removable: true`，工作区标题与 cwd 来自记账）；
- `POST /session/delete` 返回 `ghost: true`、`dirs: []`、`removed: []`、`detached: true`，
  `projectionCache.removed` 含该会话，并带 warning「磁盘上已经没有这个会话的目录，只清理了工作区记账与投影缓存」；
- 删除后 `/sessions` 不再列出它，工作区记账里的 sessionIds 已移除。

### 2.3 裸 UUID 拼写 ✅

做法：把一个真实会话的磁盘目录改名为**裸 UUID**（不带 `session-` 前缀），请求仍用带前缀的会话 id 删除。

- 响应 `dirs` / `removed` 指向裸 UUID 目录，删除成功；
- 顺带发现：0.2.2 的会话持久化层对「目录名与日志头 id 拼写不一致」会报 `corrupt session log`，
  并让 workspace 服务启动失败——这是宿主侧的校验，不影响插件按两种拼写找到并删除目录；
  真实场景里目录与日志头是配套的，这个构造只用于测试。

### 2.4 派生过子代理的会话删除 ✅

做法：构造一个 `origin: subagent`、`parentSession` 指向父会话的子代理会话目录，删除父会话。

- `descendants` 列出子代理会话 id；
- `removed` 同时包含父目录与子代理目录（父目录为裸 UUID 拼写时也正确）；
- 投影缓存按会话 id 清理。

### 2.5 组件行开关 ✅

在插件详情的「包含的组件」里逐个开关，开关写入 profile 的 `cordis.patch.yml`（`- id: <entryId>` + `disabled: true`），
重启后生效：

| 操作 | 重启后的结果 |
| --- | --- |
| 关 `agent-control-session` | `/session/status`、`/sessions` → 401（落到宿主 fallback）；`/turn/status`、`/restart/status` → 200 正常 |
| 再关主行 `agent-control` | 启动日志：`agent-control-turn`、`agent-control-restart` 等 **pending (waiting for service: agentControlCore)**；四条路由全部 401 |
| 恢复两行 | 三条组件探针回到 200，版本号正常 |

与 AGENTS.md 3.10 的两级开关语义一致：被禁用的行不执行 `apply`，组件行因服务缺失停在 pending，路由零注册。

### 2.6 侧栏 context-menu 下删除项的位置 ✅

人眼核对（界面）：会话「…」菜单项顺序为「置顶会话 / 重命名 / 分叉会话 / 复制 Session ID / 在文件夹显示 /
**删除会话…** / 归档会话 Ctrl+Alt+A」。删除项存在且可点击，位置在「归档会话」之前（legacy 区段内），
与 0.2.2 新增 context-menu 适配器的预期一致。

### 2.7 `engines.dsh` 兼容性判定与豁免流程 △

用 0.2.2 自带的 `dsh-app-boot` 导出函数（CLI 与插件管理器共用的同一实现）验证：

- 构造 `engines.dsh: ">=99.0.0"` 的不兼容包：`evaluatePluginCompatibility` 返回
  `requirements: { "engines.dsh": ">=99.0.0" }`、`exempted: false`，警告文案给出 `dsh plugin allow-version` 指引；
- `setProfileVersionExemption(profile, "dsh-agent-control@<ver>", "0.2.2-rc.1", true, true)` 写入
  `compatibility.json`，再判定时 `exempted: true`；
- 撤销豁免后 `compatibility.json` 清空、判定回到未豁免。

**CLI 安装层的拦截（`dsh plugin add` 报 incompatible 并拒绝安装）未验证**：该命令需要 pnpm store 的写权限，
本会话的放宽权限审批两次未返回，测试没有执行；底层判定、警告文案与豁免写盘均已验证。

## 3. 仍然未验证

1. CLI 安装层：`dsh plugin add` 对不兼容插件的实际拦截与 `allow-version` 后的安装成功。
2. 组件开关点击后**客户端入口**的消失（HTTP 401 与 pending 已证，但没有截图确认界面上的删除项/垃圾桶消失）。
3. 被禁用组件的客户端 bundle 是否会被宿主拒绝组合（本次未看浏览器控制台）。
4. `DELETE_FAILED` 在真实（非构造）内部故障下的行为——本次用文件锁制造失败，错误码与渲染已验证。

## 4. 隐私检查

已过（0 处待办）。
