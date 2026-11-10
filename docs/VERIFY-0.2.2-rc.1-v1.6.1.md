# VERIFY — 0.2.2-rc.1-v1.6.1

> 回退版本：撤销 v1.7.0 对「每轮花费」呈现的改版，恢复 v1.6.0 的徽章与交互。
> 功能本身（模型级价目表、查表顺序、数据来源、探针、设置项）与 v1.6.0 完全一致。

## 1. 回退内容

| 位置 | 处理 |
| --- | --- |
| `client.js` | 撤销 v1.7.0 的徽章按钮化与明细浮层，恢复为「胶囊徽章 + 原生 `title` 明细」；同时撤销 `formatTokenCount` / `cacheHitRate` / `costDetailRows` / `costIcon` 与浮层相关样式、文案。 |
| `test/client.test.mjs` | 撤销徽章改造与新增的浮层用例，恢复为按「`data-agent-control-turn-cost` 属性 + 金额文本」断言。 |
| `AGENTS.md`、`README.md` | 撤销官方风格 UI 的描述，恢复 v1.6.0 的说明。 |
| `docs/VERIFY-0.2.2-rc.1-v1.7.0.md` | 随版本一起撤销（其结论仍可在 git 历史的 `0.2.2-rc.1-v1.7.0` 分支与 tag 中回溯）。 |

回退方式：对 v1.7.0 的两个提交做 `git revert`（保留历史，不改写已发布内容）。

## 2. 保留不变

- `BUILTIN_MODEL_PRICING`（模型级美元价目表）、`normalizeModelId`、`lookupModelEntry`（精确 → 归一化 → 前缀）与 v1.6.0 相同；
- 未知模型仍显示「—」，明细通过原生 `title` 给出（包含 token 用量与补价提示）；
- host 端、探针、组件行、设置项、`localStorage` 键都不变。

## 3. 离线测试

`client` 90、`host` 83、`features` 18、`locale` 5、`session-delete` 40、`turn-delete` 25、
`restart` 54、`restart-helper` 22，合计 **337 项全部通过**（逐文件直跑）。

## 4. 说明

- v1.7.0 的 tag 与 Release 保留，用于回溯当时的改版；本版是回退后的推荐版本。
- 重启实例 + 浏览器刷新后恢复 v1.6.0 的呈现。
