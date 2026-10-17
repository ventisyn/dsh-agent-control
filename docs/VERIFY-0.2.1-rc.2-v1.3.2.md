# VERIFY — 0.2.1-rc.2-v1.3.2

> 这一版把 v1.3.1 的代码接到 0.2.1-rc.2 版本线上，功能与 v1.3.1 相同，只换版本号与验证记录。

## 1. 改了什么

| 位置 | 改动 |
| --- | --- |
| package.json | `version` 从 `0.2.1-alpha.2-v1.3.1` 提到 `0.2.1-rc.2-v1.3.2` |
| 代码 | 与 v1.3.1 相同（组件行依赖主行提供的本体服务、四行 locale、AGENTS 拆分） |

## 2. 怎么测的

**离线**：八个测试文件逐个直跑，314 项全过（`restart` 54、`restart-helper` 22、`host` 81、`client` 71、`features` 16、`locale` 5、`turn-delete` 25、`session-delete` 40）。

**真机（0.2.1-rc.2）**：把 `0.2.1-alpha.2-v1.3.1` 装进该实例的 profile 并热重启：

| 观察 | 结果 |
| --- | --- |
| `GET /restart/status` 报的插件版本 | `0.2.1-alpha.2-v1.3.1`（加载的是新装的包） |
| 热重启 | `last.ok = true`、`resume = delivered`、耗时约 12 秒，`bootId` / `pid` 都变了 |
| 三条探针 | `session` / `turn` / `restart` 全部 `200 {ok:true,enabled:true}` |
| `GET /sessions` | 200，92 条；当前会话 `live:true, running:true` 标注正确 |
| 两级开关的服务依赖 | 三个组件行成功 `inject` 主行提供的本体服务（否则会停在 pending、探针不会 200） |

也就是说，v1.3.1 的代码在 rc.2 上能加载、能注册路由、能完成一次带续作的热重启。

## 3. 仍然未验证

1. rc.2 上的真实删除会话 / 删除轮次、关闭实例（本轮只做只读探针与热重启）。
2. 在界面上关掉主行，确认三个组件行变成「等待依赖」、四条探针 401（alpha.2 上有记录，rc.2 未复跑）。
3. `DELETE_FAILED` 的真实渲染。

## 4. 隐私检查

隐私检查：已过（0 处待办）。
