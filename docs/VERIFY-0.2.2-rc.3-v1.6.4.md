# VERIFY — 0.2.2-rc.3-v1.6.4

> 文档重构版本：按 `remove-ai-tone/AGENTS.md` 的「操作手册」结构重写本仓库 AGENTS.md。
> 插件代码与 v1.6.3 相同，测试结论沿用。

## 1. 变更

| 位置 | 处理 |
| --- | --- |
| `AGENTS.md` | 380 行 / 42 KB → 335 行 / 37.5 KB。结构改为：新对话先做什么 → 项目地图 → 关键机制与契约要点（3.1–3.12 保留）→ 工作约束（红线）→ 版本与分支 → 测试与验收 → Git 提交规范 → 常用命令 → 附录（旧节号对照）。机制细节继续指向 `docs/CONTRACT.md` / `docs/PITFALLS.md` / `docs/RELEASING.md`。 |
| 活跃文档与注释里的旧节号引用 | `docs/RELEASING.md`、`docs/PLAN-hot-restart.md`、`docs/SPIKE-hot-restart.md`、`test/fake-session.mjs`、`test/turn-delete.test.mjs`、`test/log-inspect.mjs`、`README.md`、`docs/CONTRACT.md`、`docs/PITFALLS.md` 按新编号更新；历史 `docs/VERIFY-*` 与 `docs/research/` 保留原样（附录对照表可换算）。 |
| `package.json` | 版本升到 `0.2.2-rc.3-v1.6.4`。 |

## 2. 验证

- 结构：8 节 + 附录完整；所有相对链接目标存在；无转义残留。
- 代码：与 v1.6.3 逐字节相同（本次只动文档与版本号），离线 341 项全绿沿用 v1.6.3 的结论。
- 隐私检查：已过（新增内容无本机路径、实例名、端口、用户名、凭据）。

## 3. 仍然未验证

- 无代码变化，无新增未验证项。

## 4. 说明

- 隐私检查：已过。
- 旧节号对照表在 `AGENTS.md` 附录；旧 `docs/VERIFY-*` 里的节号按该表换算。
