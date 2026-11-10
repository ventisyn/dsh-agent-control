# VERIFY — 0.2.2-rc.1-v1.6.0

> 本版把「每轮花费」从「只认自家 provider 的精确价目」扩展为**跨 provider 的模型级价目**：
> OpenRouter 这类聚合 provider 的路由（`openrouter` + `anthropic/claude-opus-5.5`）现在也能算出金额。

## 1. 问题

旧实现只用 `provider/model` 精确键查表。OpenRouter 的路由是 provider=`openrouter`、
model=`anthropic/claude-opus-5.5`，两者都不在内置表里，于是只能显示「—」。

## 2. 轮子调研

- `hugoyee75-cmyk/dsh-token-metrics`、`J-Chien/dsh-meter`、`TwotwoPiggy/dsh-balance`、
  `chenzhiyong1994/dsh-cost-guard`、`Cottins-Vanilla/dsh-session-usage`：都是「token 用量 × 价目表」的路线，
  差别在价目表的数据源与覆盖方式。
- `mrdevlorx/dsh-model-garden`：用 **models.dev** 的模型目录（含价格）做选择器。
- `ccusage`：内置模型价目表 + 本地用量解析。
- 价格数据源：[`BerriAI/litellm` 的 `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm)
  （公开、覆盖广、每个模型带 input / output / cache 读写的每 token 美元价）。

本版选择**内置一份精选的模型级价目表**（不引入网络依赖），匹配时做模型名归一化；
自定义价目表仍然优先，未知模型继续显示「—」并给出 token 用量。

## 3. 改动

| 位置 | 改动 |
| --- | --- |
| `client.js` | 新增 `BUILTIN_MODEL_PRICING`（约 40 个主流模型，美元/百万 token）与 `normalizeModelId()`（去 provider 前缀、点号换横线、去日期与 `-latest` 后缀）；新增 `lookupModelEntry()`：`provider/model` 精确 → 归一化模型名精确 → 模型名前缀匹配；结果带 `pricingKey` 与 `matched`。 |
| `client.js`（文案） | 设置页「每轮花费」说明、价目表说明与示例；未知模型的 tooltip 追加 token 用量与「填价格」提示；命中非精确价目时 tooltip 标注「按「<key>」的公开价估算」。 |
| `test/client.test.mjs` | 新增 2 项（openrouter 归一化命中、日期 / `-latest` / 前缀匹配），并更新「自定义价目表」用例：恢复内置表后按模型级价目算出金额而不是「—」。 |
| 文档 | `AGENTS.md` 3.12、`README.md` 的价目表段、`docs/CONTRACT.md` 与测试数同步。 |

## 4. 数据与价格

- 模型级价格取自 litellm 的公开目录（2026-11 抓取），取各厂商**官方直连价**。
- 聚合 provider（OpenRouter 等）可能在官方价上加价，所以金额仍是**估算**，tooltip 里会标出命中的价目键。
- 设置页仍可用 JSON 覆盖：键可以是 `provider/model`，也可以是归一化后的模型名。

## 5. 离线测试

`client` 90、`host` 83、`features` 18、`locale` 5、`session-delete` 40、`turn-delete` 25、
`restart` 54、`restart-helper` 22，合计 **337 项全部通过**（逐文件直跑）。

用真实用量核对（来自一个 OpenRouter 会话的一轮）：

| 桶 | token | 单价（$ / 百万） | 金额 |
| --- | --- | --- | --- |
| 未命中缓存输入 | 2 | 4 | $0.000008 |
| 缓存读 | 85410 | 0.2 | $0.017082 |
| 缓存写 | 1717 | 5 | $0.008585 |
| 输出 | 266 | 20 | $0.005320 |
| 合计 | | | **$0.030995 → $0.0310** |

命中键为 `claude-opus-5-5`（`anthropic/claude-opus-5.5` 归一化而来）。

## 6. 仍未验证

- **页面上的实际徽章**：本版用真实会话的用量数据做离线核对，没有在升级后的页面上看徽章渲染。
- **OpenRouter 的实际计费价**：内置的是官方直连价，聚合 provider 的加价未核对。
- **其它聚合 provider 的模型命名**：只用 OpenRouter 的 `provider/model` 形态验证过，
  其它厂商的别名映射没有逐一核对。
- 更多模型覆盖：只内置了约 40 个常见模型；未收录的模型仍显示「—」。
