# VERIFY — 0.2.1-alpha.2-v1.3.1

> 这一版把四行结构从「平级」收紧成两级：主行提供本体服务，三个组件行依赖它；四行在插件列表里也补上了说明文字。
> 按项目所有者的决定，本版**没有做发布前真机验证**，只跑了离线测试。

## 1. 改了什么

| 位置 | 改动 |
| --- | --- |
| host | 主行 `provide` 本体服务 `agentControlCore`；三个组件行 `inject` 它；接线函数拿不到服务时整段跳过 |
| locale | 四行各自的 `meta.description`，经 `package.json` 的 `exports` / `files` 暴露 |
| docs | AGENTS.md 拆成入口 + `docs/CONTRACT.md`、`docs/PITFALLS.md`、`docs/RELEASING.md`；PITFALLS 增补主行关闭时那条 warning 的解释 |

## 2. 怎么测的

**离线**：全部源文件与测试文件 `node --check`；八个测试文件逐个直跑，314 项全过（`restart` 54、`restart-helper` 22、`host` 81、`client` 71、`features` 16、`locale` 5、`turn-delete` 25、`session-delete` 40）。

**真机**：本版**未做新的真机验证**。已有记录只有 PITFALLS §3 对「关掉主行 → 三个组件行 pending、探针 401」的界面观察（2026-10-16），本次没有重新跑。

## 3. 结论

- 离线覆盖：无服务时组件行零注册、`inject` 声明齐全、四行同时加载不重复、只有主行的旧配置仍全装。
- 主行总闸与四行描述在真实实例上的行为，本版没有重新验证。

## 4. 仍然未验证

1. 在 0.2.1-alpha.2 真机上关掉/开回主行，确认三个组件行 pending 与四条探针 401（PITFALLS 的记录没有随本版最终提交复跑）。
2. 在 0.2.1-rc.2 上的运行验证；该 harness 版本另开 `0.2.1-rc.2-v1.3.2` 版本线。
3. `DELETE_FAILED` 的真实渲染、关闭实例（沿用上一版）。

## 5. 发布前隐私检查

隐私检查：已过（0 处待办）。
