# VERIFY — 0.2.2-rc.5-v1.6.6

> 适配版本：harness 从 0.2.2-rc.3 升级到 0.2.2-rc.5。代码零改动，只改版本号与 engines 声明。

## 1. 变更

| 位置 | 处理 |
| --- | --- |
| `package.json` | 版本 `0.2.2-rc.3-v1.6.5` → `0.2.2-rc.5-v1.6.6`；`engines.dsh` 从 `>=0.2.2-rc.3` 提到 `>=0.2.2-rc.5`。 |

## 2. 适配结论

- 源码与 v1.6.5 相同：rc.3 → rc.5 之间，插件用到的宿主契约（sessions / agent 租约 / `webServer.register` / 六个组件行 / 审批与默认模型 API / 热重启进程环境）未发现破坏性变更。
- 迁移后的 profile 在 rc.5 上完整启动：`--dump-config` 233 条 entries、0 error/warn，本插件六行结构完整。
- 真实实例（rc.5）验证：
  - `/api/agent-control/restart/status` 200，版本报 `0.2.2-rc.3-v1.6.5`（本次发布前安装的版本）；
  - `/api/agent-control/cost/status`、`/api/agent-control/notify/status` 均 200；
  - 热重启链路实测：`restart_harness` 触发后约 10.7 秒起新进程，`last.json` `ok:true`、`resume:delivered`，新 pid 正常监听原端口；
  - 客户端插件清单包含本插件的 client 模块。
- 离线测试：341 项全绿（client 90 / features 18 / host 87 / locale 5 / restart-helper 22 / restart 54 / session-delete 40 / turn-delete 25）。

## 3. 仍然未验证

- 客户端 UI 在 rc.5 页面上的逐项点击未重跑（设置页开关、每轮花费徽章、删除流沿用 rc.3 同代码的结论）。
- 历史未验证项（`DELETE_FAILED` 真实渲染等）不受本次版本线切换影响。

## 4. 说明

- 发布前隐私检查：已过（本次仅版本号与 engines 声明 + 本文档）。
