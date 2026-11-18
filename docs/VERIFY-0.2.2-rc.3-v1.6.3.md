# VERIFY — 0.2.2-rc.3-v1.6.3

> 修复版本：0.2.2-rc.3 上模型工具 `restart_harness` 被错误拒绝（`RESTART_UNSUPPORTED`）。

## 1. 问题

0.2.2-rc.3 的 `agents` 服务（`AgentRegistry`）不再暴露 `roots()`。工具入口原本只用它判断
「调用者是不是主会话」，拿不到就按安全策略拒绝，于是 `restart_harness` 在 rc.3 上不可用
（HTTP 设置页的「重启 DSH」入口不受影响）。

## 2. 修复

`isRootCaller()`：先试 `agents.roots()`（旧宿主仍走原路径）；拿不到时退回**会话 header 的持久 lineage**——
`origin === 'subagent'` 或 `delegationDepth > 0` 判为子代理，其余视为顶层。两路都拿不到仍返回
`RESTART_UNSUPPORTED`（绝不把「判断不了」当成「是主会话」）。

## 3. 实测

| 项 | 结果 |
| --- | --- |
| `host` 离线测试 | 87 项全过（新增 4 项：rc.3 顶层放行、`origin=subagent` 拒绝、仅 `delegationDepth` 拒绝、两路都拿不到 ⇒ `RESTART_UNSUPPORTED`） |
| 全量离线测试 | **341 项全部通过** |
| 临时实例（独立 DSH_HOME + link 安装） | 插件加载正常、无工具注册失败日志；`GET /restart/status` 200 |
| 修复前基线 | 同一宿主上调用工具返回 `RESTART_UNSUPPORTED`（宿主没有提供 agents.roots()） |

## 4. 仍然未验证

- 修复后的工具**真实触发一次热重启**（辅助进程 + 新进程 + 续作投递）：临时实例只验证到工具注册与状态接口；
  真实重启需要主会话发起，留待本实例重启后人工验证。
- rc.3 上真实子代理会话的 header 是否都带 `delegationDepth`：按 `dsh-session` 的类型与写入路径判定为是，
  但本轮没有跑一次真实子代理调用去核对。

## 5. 说明

- 隐私检查：已过。
- HTTP 入口（设置页「重启 DSH」按钮）行为不变：它不经过根会话检查。
