# VERIFY — 0.2.2-rc.3-v1.6.2

> 适配版本：在 DeepSeek Harness 0.2.2-rc.3 上验证本插件。业务代码零改动；本版唯一的代码改动是
> `package.json` 的 `engines.dsh` 下限（`>=0.2.2-rc.1` → `>=0.2.2-rc.3`）与版本号。

## 1. 适配结论

换 harness 版本线（0.2.2-rc.1 → 0.2.2-rc.3）时逐条核对 AGENTS.md 第 4 节列出的耦合面：

- host 端只用 Node 内置模块与 cordis 运行时服务（`sessions` / `agents` / `workspaceRegistry` /
  `connection.requestRejection` / `tokenMeter` / `storageDomain` / `webServer.register` / `appExit` / `logger`），
  不 import 任何 `@deepseek-ai/*` 包；
- 客户端依赖的 `@deepseek-ai/dsh-client-ui-primitives` 由 rc.3 的 web-app 继续提供；
- 五个客户端槽位与六条探针路由在 rc.3 上照常注册。

因此本版没有业务代码改动。

## 2. 验证环境

临时实例：独立 `DSH_HOME` + 独立 profile，用 `link:` 安装本地工作副本，`--no-open --port <空闲端口>`。
不触碰主实例的存储与会话。

## 3. 实测结果

| 项 | 结果 |
| --- | --- |
| `dsh --profile … --dump-config` | 组合成功，0 条 error / warn；六行结构（core + session / turn / restart / notify / cost）都在 |
| `GET /api/agent-control/session/status` | 200 `{"ok":true,"enabled":true}` |
| `GET /api/agent-control/turn/status` | 200 `{"ok":true,"enabled":true}` |
| `GET /api/agent-control/restart/status` | 200，`version` 为本版完整版本号，`canRestart: true`、`canShutdown: true` |
| `GET /api/agent-control/notify/status` | 200 `{"ok":true,"enabled":true}` |
| `GET /api/agent-control/cost/status` | 200 `{"ok":true,"enabled":true}` |
| `GET /api/agent-control/sessions` | 200（空会话列表） |
| `POST /api/agent-control/shutdown`（不带信任头） | 403 `SHUTDOWN_DENIED`（CSRF 防护有效） |
| `POST /api/agent-control/shutdown`（带 `x-dsh-agent-control: 1`） | 202，实例正常退出 |

同一 harness 上完整 profile 的其它插件（approval-gate、ego-browser、perf-boost、think-zh、computer-use）
加载时没有报错；本版没有改动与它们的交互面。

## 4. 离线测试

`client` 90、`host` 83、`features` 18、`locale` 5、`session-delete` 40、`turn-delete` 25、
`restart` 54、`restart-helper` 22，合计 **337 项全部通过**（逐文件直跑）。

## 5. 仍然未验证

- 浏览器里的客户端界面（设置页三节、每轮花费徽章、删除按钮与确认框）：临时实例只验证了 host 侧，
  客户端 UI 需要在真实实例重启后由人确认。
- 真实的热重启（辅助进程 + 新进程 + 续作投递）与「关闭实例」的界面入口：本版没有改动相关代码，
  但本轮回合未在 rc.3 上重跑完整重启链路。
- rc.3 上真实的会话删除 / 轮次删除（需要一个活动且空闲的会话）。

## 6. 说明

- 隐私检查：已过。
- 本版是 0.2.2-rc.3 版本线的首个发布；旧的 `0.2.2-rc.1-v1.6.1` 分支与 Release 保留（Z 位发布不删旧分支）。
