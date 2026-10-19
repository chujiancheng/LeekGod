# 我是股神 · 开放交易接口 v1 完全手册

> 读者：想在这个模拟盘上跑量化策略的玩家，以及帮玩家写代码的 AI。
> 目标：从零写出一个**不会下错单、不会漏成交、不会打爆限流**的策略。
> 本文所有字段都按服务端实际返回核对过；与本文冲突时，以服务端响应为准。
>
> 一句话定位：策略跑在**你自己的机器上**，通过 HTTP 读写这个模拟盘。服务端只提供
> 行情、账户、下单、成交四类能力，**不托管你的代码**。

> **还没有 Key？** 先看 [玩家申请APIKey.md](./玩家申请APIKey.md)：一页写清"怎么申请、
> 收到什么、怎么自检、丢了怎么办"。本文第 2 节假设你已经拿到 Key。

---

## 目录

- [0. 先看这一页](#0-先看这一页)
- [1. 心智模型（写代码前必须懂）](#1-心智模型写代码前必须懂)
- [2. 十分钟上手（照顺序做）](#2-十分钟上手照顺序做)
- [3. 鉴权](#3-鉴权)
- [4. 通用约定与错误](#4-通用约定与错误)
- [5. 端点参考](#5-端点参考)
- [6. 交易规则与数值](#6-交易规则与数值)
- [7. 委托与成交语义](#7-委托与成交语义)
- [8. 幂等、重试与对账](#8-幂等重试与对账)
- [9. 策略工程模式](#9-策略工程模式)
- [10. 拒单原因精确对照](#10-拒单原因精确对照)
- [11. 完整示例解读](#11-完整示例解读)
- [12. 给 AI 的施工说明（可直接粘贴）](#12-给-ai-的施工说明可直接粘贴)
- [13. 运维与安全](#13-运维与安全)
- [14. FAQ](#14-faq)
- [15. 附录](#15-附录)

---

## 0. 先看这一页

### 0.1 最短路径

```bash
# ① 先拿到 Key（玩家）：登录游戏 → 主页点「开放接口」→ 生成 Key
#    弹层里那串 gs_ 开头的就是凭据，只显示这一次

# ② 你的机器：设环境变量
export GUSHEN_API_KEY='gs_xxxxxxxx_yyyyyyyyyyyyyyyy'
export GUSHEN_BASE='http://<你打开游戏用的地址>:3000'

# ③ 探活
curl -H "X-API-Key: $GUSHEN_API_KEY" $GUSHEN_BASE/open/v1/ping

# ④ 跑自带示例
python Server/examples/quant_ma.py
```

### 0.2 必须记住的 8 个事实

| # | 事实 | 影响 |
|---|---|---|
| 1 | 网页登录是**免密**的，会话令牌**不能**当 API Key | 程序化凭据必须单独发 Key |
| 2 | 撮合每 **700ms** 一个 tick，不是连续竞价 | 轮询比这更密没有意义 |
| 3 | 下单冷却**按账户、跨股票共享**（基准 2 秒，券商可覆盖） | 频率上限不是 tick 决定的 |
| 4 | 买入后 **T+10 秒**（券商可覆盖）才能卖 | 卖出用 `long.sellable`，不要用 `qty` |
| 5 | 同一只股票**只能持一个方向**（含在途开仓单） | 反向下单前必须先平仓/撤单 |
| 6 | 成交价 = **被动方挂单价**，不是你的委托价 | 别拿委托价算成本 |
| 7 | 一个游戏日只有 **620 秒**，收盘时所有未成交委托**作废** | 挂单不要跨日 |
| 8 | 量化没有交易特权：冷却、费率、锁仓、限流与手动一致 | 不要设计"高频抢跑"策略 |

### 0.3 调用骨架

```
启动
 ├─ GET /open/v1/ping           → 确认 Key 有效、拿到当前 seq 与冷却
 ├─ GET /open/v1/meta           → 标的清单 + 你这个账户的有效规则
 └─ 主循环（间隔 ≥ 700ms，或订阅 /stream）
      ├─ GET /open/v1/markets    → 行情；seq 没变就跳过
      ├─ （有信号时）GET /open/v1/account  → 现金/持仓/可卖/冷却
      ├─ 风控检查（时段/方向/整手/价格/资金/券源）
      ├─ POST /open/v1/orders    → 带唯一 clientOrderId
      ├─ 按回包 cooldownLeftMs 等待
      └─ GET /open/v1/fills?since=<nextSince> → 增量成交，更新本地持仓
```

---

## 1. 心智模型（写代码前必须懂）

### 1.1 这是一个什么系统

- **模拟盘**：10 只股票（代码 `600001` ~ `600010`）+ 1 个不可交易的大盘指数（`999999`）。
- **服务端权威**：价格、盘口、成交、资金、持仓全部由服务端计算。你的本地状态只是缓存，
  任何时候都能用 `/account`、`/orders`、`/fills` 重新对齐。
- **做市引擎**：NPC 持续报价提供流动性。行情里能看到五档、逐笔、内外盘、融券池，
  但**看不到**做市引擎的内部底牌（公允价值、资金流、战术意图、LLM 计划），这是刻意设计。
- **所有玩家同一个池子**：你的委托进入的是公共订单簿，对手可能是 NPC，也可能是别的玩家。

### 1.2 三个时间概念，别混

| 名称 | 字段 | 单位 | 用途 |
|---|---|---|---|
| 服务器墙钟 | `serverTime` | 毫秒时间戳 | 记录日志、算真实耗时 |
| 行情序号 | `seq` | 整数，每 tick +1 | **判断行情有没有更新**。相同 seq = 同一帧 |
| 游戏内时钟 | `day.gameClockMs` | 自 00:00 起的毫秒 | 显示"游戏里的几点"，不要拿它做超时 |

> 正确做法：轮询 `/markets`，比较 `seq`，变了才决策。
> 错误做法：拿本地 `time.time()` 判断"过了 700ms 应该有新行情"——网络抖动、服务端 GC
> 都会让这个假设失效。

### 1.3 一个游戏日只有 620 秒

服务端把真实时间压缩成交易日：

| 阶段 `day.phase` | 时长（真实秒） | 游戏时钟 | `day.trading` | 说明 |
|---|---|---|---|---|
| `auction` 开盘集合竞价 | 30 | 09:15–09:25 | `true` | 只收单不连续撮合；**最后 10 秒不可撤单** |
| `morning` 上午连续竞价 | 230 | 09:30–11:30 | `true` | 正常撮合 |
| `lunch` 午间休市 | 40 | 11:30–13:00 | `false` | **所有下单被拒** |
| `afternoon` 下午连续竞价 | 260 | 13:00–14:57 | `true` | 正常撮合 |
| `closeAuction` 收盘集合竞价 | 20 | 14:57–15:00 | `true` | 只收单；**最后 10 秒不可撤单** |
| `night` 休市结算 | 40 | 15:00–次日 09:15 | `false` | **下单被拒**；日终结算在这里发生 |

合计 **620 秒 ≈ 10 分 20 秒**一轮。日终结算会：

1. 定格当日 K 线；
2. 把 `prevClose` 滚到当日最后成交价（次日涨跌停基准）；
3. **撤掉所有未成交委托**，退回冻结资金与仓位预留。

所以：**不要挂"等明天成交"的单**，它在收盘时会被系统撤掉。

### 1.4 一笔委托的一生

```
POST /orders
   │  ├─ 参数/规则校验失败 → HTTP 400 + code:"rejected"（不会产生委托）
   │  └─ 通过 → 创建委托，status = "live"，进入订单簿
   ▼
 live ──部分成交──> live（filled > 0，remain 仍 > 0）
   │                     │
   │                     ├─ 继续成交 → filled（全部成交）
   │                     ├─ DELETE /orders/:id → canceled
   │                     └─ 收盘结算 → canceled（系统撤单）
   ▼
 filled / canceled
```

关键点：

- **下单成功 ≠ 成交**。`POST /orders` 返回 200 只代表委托被接受。
- 可能**部分成交**：`filled` 是已成交股数，`remain = qty - filled`。
- 成交明细只能从 `/fills` 拿，委托里的 `filled` 只是数量汇总。
- 委托 `status` 只有三种值：`live` / `filled` / `canceled`。没有 `partial` 状态，
  部分成交时仍是 `live`。

### 1.5 账户的六个"钱袋"

不要只看 `cash`。账户快照里这几个字段各管一件事：

| 字段 | 含义 | 什么时候变 |
|---|---|---|
| `cash` | **可用现金**（能用来下单的钱） | 成交、冻结、费用、利息 |
| `orderFrozen` | 在途买单冻结的资金 | 挂买单时增加，成交/撤单时释放 |
| `shortMargin` | 开空保证金（被锁住，不能下单） | 开空成交时增加，平空时释放 |
| `financeDebt` | 融资负债（借入本金 + 已摊利息） | 融资买入、计息、卖出还款 |
| `equity` | **总权益**（排行榜口径） | 随时随价格变化 |
| `marginUsage` | 风险度 =（空头市值 + 融资负债 + 融券欠息）/ 权益 | 随时变化 |

`equity` 的服务端公式（与 H5 完全一致）：

```
equity = cash
       + orderFrozen
       + shortMargin
       + 多头市值
       - 空头市值
       - 融资负债
       - 融券欠息
```

> 直觉：融资买入时，你只付了自备部分，但多头市值全算进来、负债扣掉，所以权益约等于
> "自己的钱 + 浮盈 - 费用"。开空时，卖出款进了 `cash`，但保证金从 `cash` 挪到
> `shortMargin`，同时空头市值被扣掉，所以权益几乎不变（只少了手续费）。

### 1.6 四种 `action` 到底做了什么

| action | 中文 | 仓位变化 | 现金变化（成交时） | 前置条件 |
|---|---|---|---|---|
| `buy_open` | 买入开多 | 多头 +qty | `cash -= 成交额 + 手续费`（融资时只付自备部分） | 现金够、无空头、无在途开空 |
| `sell_close` | 卖出平多 | 多头 -qty | `cash += 成交额 - 手续费 - 偿还融资负债` | `long.sellable >= qty` |
| `sell_open` | 卖出开空（融券） | 空头 +qty | `cash += 成交额 - 保证金 - 手续费` | 券源够、保证金够、无多头 |
| `buy_close` | 买入平空 | 空头 -qty | `cash -= 成交额 + 手续费`，同时释放该批保证金 | `short.coverable >= qty` |

**融资买入**是 `buy_open` 的一个开关：`"finance": true`。

- 自备比例 `rules.financeRatio`（基准 0.5，即 2 倍；天疯 0.3 ≈ 3.33 倍，滑泰 0.6 ≈ 1.67 倍）。
- 冻结 = 成交市值 × 自备比例；借入部分（含手续费）记入该批次负债，按 tick 计息。
- 只对 `buy_open` 生效，其他 action 传了也会被忽略。

**注意"倍数"的两种口径**：

- 做多：`1 / financeRatio` 是理论最大杠杆（0.5 → 2 倍）。
- 做空：`marginRatio` 是保证金比例（0.5 → 最多约 2 倍权益的空头敞口）。

两者都不是"随便开"，服务端会按**账户组合**做预检（含其他股票的在途单）。

---

## 2. 十分钟上手（照顺序做）

下面每一步都给出**命令**和**你应该看到什么**。全部通过，说明链路是通的。

### 2.1 前置条件

| # | 条件 | 不满足会怎样 |
|---|---|---|
| 1 | 你在**游戏里登录着**（开放平台页要用登录态） | 页面显示「未登录」，生成按钮不出现 |
| 2 | Key 绑定的账号已**开完户**（有昵称 + 选过券商） | 页面提示"还没走完开户" |
| 3 | 知道服务器地址（就是你打开游戏的那个地址，如 `http://1.2.3.4:3000`） | 连不上或超时 |

**Key 从哪来**：在网页上自己生成，不用找管理员。

打开游戏主页 → 点按钮区「**开放接口**」，或直接访问 `服务器地址/portal.html`：

1. 「申请一把 Key」里填**备注**（例如「家用电脑-双均线」，只给自己看）；
2. 选**权限**：`read,trade`（可下单，默认）或 `read`（只看行情和账户）；
3. 点「**生成 Key**」，弹层里那串 `gs_...` 就是凭据，**只显示这一次**；
4. 「我的 Key」表格里能看 KeyID、权限、创建时间、最近使用时间，也能随时**撤销**（立即生效）。

配额：一个账号最多 **8 把有效 Key**，不会过期。完整图文步骤与常见问题见
[玩家申请APIKey.md](./玩家申请APIKey.md)。

### 2.2 确认你手里的 Key

生成成功的弹层长这样（关掉就再也看不到了）：

```
这把 Key 只显示这一次
gs_3f2a9c1e_Bt8xQ2mN7vR4kL9pS1wY6zA0cE5hJ3dF
[复制 Key]  [我已保存]
```

三件事先对清楚：

| 项目 | 说明 |
|---|---|
| **Key 格式** | `gs_` + 8 位十六进制 KeyID + `_` + 至少 20 位随机串。缺一段就是复制不全 |
| **权限** | `read` 只能看；`read,trade` 才能下单撤单。只读 Key 下单会 `403` |
| **KeyID** | 8 位十六进制，可以公开、可以出现在日志里；它不能用来下单，撤销时才用 |

> **Key 明文只出现一次**：服务端只存 `sha256(secret)`，管理员也看不到。
> 丢了不能找回，只能撤销重发（见 §3.4）。所以收到后**先存进环境变量再看别的**。

### 2.3 设置环境变量

把 `GUSHEN_BASE` 换成你**打开游戏用的那个地址**（开放平台页底部会直接拼好给你，照抄即可；下面用 `1.2.3.4:3000` 举例，本机调试才写 `127.0.0.1`）：

Linux / macOS：

```bash
export GUSHEN_API_KEY='gs_3f2a9c1e_Bt8x...'
export GUSHEN_BASE='http://1.2.3.4:3000'
```

Windows CMD：

```bat
set GUSHEN_API_KEY=gs_3f2a9c1e_Bt8x...
set GUSHEN_BASE=http://1.2.3.4:3000
```

PowerShell：

```powershell
$env:GUSHEN_API_KEY = 'gs_3f2a9c1e_Bt8x...'
$env:GUSHEN_BASE = 'http://1.2.3.4:3000'
```

> 不要把 Key 写进代码、提交到 git、或贴进群聊。便携做法见《玩家申请APIKey.md》§7。

### 2.4 探活：`/ping`

```bash
curl -s -H "X-API-Key: $GUSHEN_API_KEY" $GUSHEN_BASE/open/v1/ping
```

```json
{
  "ok": true,
  "account": "quant_a",
  "nick": "量化甲",
  "keyId": "3f2a9c1e",
  "scopes": "read,trade",
  "seq": 18422,
  "serverTime": 1792300000000,
  "cooldownLeftMs": 0
}
```

看到 `ok: true` 就说明：Key 有效、绑定的账号存在、不是 NPC。
`cooldownLeftMs > 0` 表示这个账户还在冷却中，现在下单会被拒。

### 2.5 看规则与标的：`/meta`

```bash
curl -s -H "X-API-Key: $GUSHEN_API_KEY" $GUSHEN_BASE/open/v1/meta
```

```json
{
  "ok": true,
  "version": "v1",
  "seq": 18422,
  "serverTime": 1792300000000,
  "day": {
    "enabled": true, "day": 3, "phase": "morning", "label": "上午连续竞价",
    "trading": true, "auction": null, "locked": false, "unlockLeftMs": null,
    "phaseMs": 230000, "phaseElapsedMs": 182000, "phaseLeftMs": 48000,
    "phaseEndsAt": 1792300048000,
    "dayStartAt": 1792299788000, "dayEndsAt": 1792300408000,
    "gameClockMs": 39897391, "phaseGameMs": 7200000
  },
  "stocks": [
    { "id": "600001", "name": "大米集团", "lotSize": 100 },
    { "id": "600002", "name": "腾迅控股", "lotSize": 100 }
  ],
  "index": { "stockId": "999999", "name": "大盘指数" },
  "rules": {
    "feeRate": 0.0001,
    "cooldownMs": 2000,
    "lockMs": 10000,
    "marginRatio": 0.5,
    "maintenance": 0.3,
    "financeRatio": 0.5,
    "allowNakedShort": false,
    "finance": { "enabled": true, "baseMinuteRate": 0.0001, "maxMinuteRate": 0.0004 },
    "lending": { "enabled": true, "baseDailyRate": 0.001, "maxDailyRate": 0.004 },
    "priceLimit": { "enabled": true, "pct": 30 },
    "actions": ["buy_open", "sell_close", "sell_open", "buy_close"],
    "orderTypes": ["limit"]
  },
  "tickIntervalMs": 700
}
```

**这是你启动时唯一必须调的"配置接口"**：

- 用 `stocks` 建立 `id → lotSize` 映射，不要写死 100（现在是 100，但接口是权威）。
- 用 `rules` 读冷却、费率、锁仓、涨跌停，不要照抄文档里的数字。
- `rules` 是**你这个账户**的有效值，券商会覆盖全局默认值。

### 2.6 看行情：`/markets`

```bash
curl -s -H "X-API-Key: $GUSHEN_API_KEY" \
  "$GUSHEN_BASE/open/v1/markets?depth=1&trades=0"
```

```json
{
  "ok": true,
  "seq": 18422,
  "serverTime": 1792300000000,
  "day": { "enabled": true, "day": 3, "phase": "morning", "trading": true, "...": "同 /meta" },
  "index": {
    "stockId": "999999", "name": "大盘指数", "last": 1012.35,
    "prevClose": 1008.0, "change": 4.35, "changePct": 0.43,
    "volume": 1250000, "turnover": 38000000
  },
  "markets": [
    {
      "stockId": "600001", "name": "大米集团",
      "last": 20.05, "prevClose": 20.0, "open": 20.0, "high": 20.12, "low": 19.96,
      "change": 0.05, "changePct": 0.25,
      "volume": 128400, "turnover": 2574000, "lotSize": 100,
      "band": { "up": 26.0, "down": 14.0 },
      "auction": null,
      "flow": {
        "outerVol": 72000, "outerAmt": 1443600,
        "innerVol": 56400, "innerAmt": 1130400,
        "net": 313200, "outerPct": 56.09
      },
      "lending": {
        "enabled": true, "total": 800000, "borrowed": 120000, "reserved": 0,
        "available": 680000, "utilization": 15,
        "dailyRate": 0.13, "settle": "daily", "settledDay": 12,
        "allowNakedShort": false, "shortInterest": 120000, "history": []
      },
      "depth": {
        "bids": [ { "price": 20.04, "qty": 3000, "brokers": [ { "key": "huatai", "qty": 2000, "pct": 67 } ] } ],
        "asks": [ { "price": 20.05, "qty": 2600, "brokers": [ { "key": "zhongxin", "qty": 1600, "pct": 62 } ] } ]
      },
      "trades": null
    }
  ]
}
```

### 2.7 看账户：`/account`

```bash
curl -s -H "X-API-Key: $GUSHEN_API_KEY" $GUSHEN_BASE/open/v1/account
```

```json
{
  "ok": true,
  "seq": 18422,
  "serverTime": 1792300000000,
  "cooldownLeftMs": 0,
  "marginCall": null,
  "name": "quant_a",
  "nick": "量化甲",
  "cash": 812340.5,
  "orderFrozen": 2005,
  "shortMargin": 0,
  "financeDebt": 0,
  "financePrincipal": 0,
  "financeInterest": 0,
  "equity": 1015345.5,
  "realizedPnL": 15295.5,
  "deposited": 1000000,
  "longValue": 201000,
  "shortValue": 0,
  "longPnl": 50,
  "shortPnl": 0,
  "marginUsage": 0,
  "positions": [
    {
      "stockId": "600001", "name": "大米集团", "last": 20.1,
      "long": {
        "qty": 1000, "cost": 20050, "value": 20100, "pnl": 50,
        "sellable": 900,
        "lots": [
          { "qty": 900, "price": 20.05, "ts": 1792299000000,
            "lockedUntil": 1792299010000, "debt": 0, "sellable": true },
          { "qty": 100, "price": 20.05, "ts": 1792300000000,
            "lockedUntil": 1792300010000, "debt": 0, "sellable": false }
        ]
      },
      "short": { "qty": 0, "cost": 0, "value": 0, "margin": 0, "pnl": 0,
                 "lots": [], "coverable": 0 },
      "financeDebt": 0, "financePrincipal": 0, "financeInterest": 0,
      "liquidationPrice": null, "liquidationPriceLong": null,
      "lending": { "stockId": "600001", "offered": 0, "lentOut": 0, "removable": 0,
                   "freeToLend": 0, "interestEarned": 0, "interestDebt": 0, "interestPaid": 0, "interestPending": 0 }
    }
  ],
  "orders": [
    { "id": "600001-O43", "stockId": "600001", "action": "buy_open",
      "price": 20.05, "qty": 100, "filled": 0, "remain": 100,
      "status": "live", "ts": 1792300000500 }
  ],
  "orderHistory": [],
  "trades": [
    { "id": "T9000-600001-O40-1000", "orderId": "600001-O40", "stockId": "600001",
      "action": "buy_open", "price": 20.05, "qty": 1000, "side": "buy",
      "t": 1792299000000 }
  ],
  "broker": { "key": "huatai", "name": "滑泰证券", "star": 1, "...": "券商详情" },
  "rules": { "feeRate": 0.00015, "cooldownMs": 500, "lockMs": 5000, "...": "同 /meta" }
}
```

三个容易踩的点：

1. `broker` 是**对象**（详情），不是字符串；券商 key 看 `broker.key`。
2. `positions[].long.sellable` 才是能卖的上限（扣了锁仓、挂借、在途平仓预留）。
3. `positions` 只包含有持仓、有负债或有挂借的股票，没持仓的股票不会出现。

### 2.8 下一次单

```bash
curl -s -X POST $GUSHEN_BASE/open/v1/orders \
  -H "X-API-Key: $GUSHEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "stockId": "600001",
    "action": "buy_open",
    "qty": 100,
    "price": 20.05,
    "clientOrderId": "ma-1792300000-18422"
  }'
```

成功：

```json
{
  "ok": true,
  "order": {
    "id": "600001-O42", "stockId": "600001", "action": "buy_open",
    "price": 20.05, "qty": 100, "filled": 0, "remain": 100,
    "status": "live", "ts": 1792300000500
  },
  "cooldownLeftMs": 2000,
  "seq": 18422,
  "serverTime": 1792300000500
}
```

被拒（HTTP 400）：

```json
{
  "ok": false,
  "code": "rejected",
  "error": "下单过于频繁，请 1.7 秒后再试",
  "detail": { "ok": false, "error": "下单过于频繁，请 1.7 秒后再试", "cooldownMs": 1700 }
}
```

- `order.status === "live"` 只表示挂出去了，**不代表成交**。
- `cooldownLeftMs` 是"这一单之后还剩多少冷却"，直接拿它当等待时长。
  不要用 `rules.cooldownMs` 盲等——券商可能覆盖，而且可能还有通道卡顿。

### 2.9 查成交

```bash
curl -s -H "X-API-Key: $GUSHEN_API_KEY" \
  "$GUSHEN_BASE/open/v1/fills?since=0&limit=50"
```

```json
{
  "ok": true,
  "seq": 18425,
  "serverTime": 1792300002100,
  "nextSince": 9001,
  "fills": [
    {
      "seq": 9001, "id": "T9001-600001-O42-100", "orderId": "600001-O42",
      "stockId": "600001", "action": "buy_open", "side": "sell",
      "price": 20.04, "qty": 100, "t": 1792300001200
    }
  ]
}
```

- `fills` 是**新到旧**排序。
- `side` 是**主动方**方向，不是你的方向。你这笔是 `buy_open`，但如果是挂着被卖单吃掉，
  `side` 会是 `"sell"`。判断自己的方向看 `action`。
- 把 `nextSince` 存下来，下次请求 `?since=<nextSince>`。
- **`seq` 是成交序号，不是时间戳**。它跨股票全局单调，重启后继续递增。

### 2.10 撤单

```bash
curl -s -X DELETE -H "X-API-Key: $GUSHEN_API_KEY" \
  $GUSHEN_BASE/open/v1/orders/600001-O42
```

```json
{
  "ok": true,
  "order": { "id": "600001-O42", "status": "canceled", "filled": 0, "remain": 100, "...": "" },
  "seq": 18426,
  "serverTime": 1792300003000
}
```

撤单只需要委托号，不需要 `stockId`。撤单在午休/夜间也可以做（让你能把钱收回来），
**唯一例外**是集合竞价最后 10 秒（`day.locked === true`）。

### 2.11 撤销 Key

Key 丢了、泄露了、换机器了、不想用了——回开放平台页，在「我的 Key」里点那一行的**撤销**，
确认即可，**立即生效**：内存索引同步删除，正在跑的脚本下一次请求就会收到 `401`。
已经建立的 SSE 连接不会被立刻踢掉，但重连会失败。

撤销不能撤回，但你可以马上生成一把新的。别人的 Key 不会出现在你的列表里，
也撤销不了（服务端按"不存在"处理，避免这个路由变成 KeyID 探测器）。

---

## 3. 鉴权

### 3.1 两种请求头，二选一

| 方式 | 写法 | 说明 |
|---|---|---|
| 推荐 | `X-API-Key: gs_<id>_<secret>` | 简单，SSE 也能用 |
| 兼容 | `Authorization: Bearer gs_<id>_<secret>` | 某些 HTTP 客户端只让改 Authorization |

Key 的格式：`gs_` + 8 位十六进制 id + `_` + 至少 20 位 base64url secret。

### 3.2 权限（scopes）

| scope | 能做什么 |
|---|---|
| `read` | 所有 GET（行情、账户、委托、成交、SSE） |
| `trade` | `POST /orders`、`DELETE /orders/:id` |

- **生成时**不选，默认就是 `read,trade`；只看盘就明确选 `read`。
- 只读 Key 调下单会得到 `403` + `该 Key 没有 trade 权限`。
- `GET /orders` 属于读接口，只需要 `read`。
- 权限在生成时定死，**改权限 = 撤销重发**，没有"改一下"的接口。

### 3.3 来源白名单（可选，需运维签发）

网页生成只让你填备注和权限，**不绑来源 IP**——家用宽带 IP 会变，绑了反而天天 `403`。

确实需要锁定来源（例如跑在云服务器上）时，找运维用命令行签发：

```bash
cd Server
python openkey.py issue quant_a --label "云主机" --ip 1.2.3.4 --scopes read,trade
```

| 写法 | 含义 |
|---|---|
| `1.2.3.4` | 只允许这一个 IP |
| `192.168.1.`（以点结尾） | 匹配整个 `192.168.1.x` 网段 |
| `1.2.3.4,5.6.7.8` | 允许多个 |
| 不填 | 不限来源（家用宽带推荐） |

- 精确匹配：`1.2.3.4` 只允许这个 IP。
- 前缀匹配：以 `.` 结尾的按前缀比对。
- 不在白名单：`403` + `该 Key 只允许从 192.168.1. 调用`。

> **家庭宽带 IP 会变**，填了白名单很可能过几天就用不了。除非你在云服务器上跑，否则建议不填。
> 如果服务前面有反向代理，服务端看到的是代理的 IP，白名单要按代理出口配。

### 3.4 Key 的生命周期与上限

- 单账号最多 **8 把有效 Key**（`config.open.maxKeysPerAccount`）。到上限先撤销不用的。
- **不会自动过期**，只有撤销才失效；撤销后不可恢复，回页面重新生成一把即可。
- 生成/撤销都是即时生效，但撤销**不会回滚已经成交的单**。
- `lastUsedAt` 约每 60 秒回写一次，精度到分钟：你没在跑策略却有调用记录，说明泄露了。
- 服务重启、游戏更新、改昵称、换券商，都**不影响**已发的 Key（存在数据库里）。

### 3.5 为什么不用账号密码 / 会话令牌

网页登录 `POST /api/login` 是**免密**的：只要知道账号名就能登录。如果开放接口沿用那套令牌，
任何知道别人账号名的人都能替他下单。所以这里另立 API Key：

- 随机 secret，库里只存 sha256，明文只在签发时出现一次；
- 可单独撤销、单独只读、单独绑 IP；
- **两条链路互不认对方的凭据**：会话令牌打不开 `/open`，Key 也打不开 `/api`。

---

## 4. 通用约定与错误

### 4.1 基本约定

| 项 | 约定 |
|---|---|
| 协议 | HTTP/1.1，请求/响应均 `application/json; charset=utf-8` |
| 时间 | 所有时间戳都是**毫秒**（`serverTime`、`ts`、`t`、`lockedUntil`） |
| 金额 | 人民币元，保留两位小数 |
| 数量 | **股**，整数；开仓必须是 `lotSize` 的整数倍 |
| 价格 | 元，两位小数；服务端会四舍五入到两位 |
| 布尔 | JSON 的 `true` / `false`，不用 `"1"` / `"0"` |
| 空值 | `null`（例如没有持仓时的 `liquidationPrice`） |
| 跨域 | 已开 CORS：`Access-Control-Allow-Origin: *`，浏览器里也能直接 fetch |
| 缓存 | 所有响应带 `Cache-Control: no-store` |

### 4.2 响应外壳

成功：

```json
{ "ok": true, "...": "各接口自己的字段" }
```

失败：

```json
{ "ok": false, "error": "人话原因", "code": "机器可判断的错误码" }
```

交易规则拒绝会多一个 `detail`，内容是服务端的原始回包：

```json
{ "ok": false, "code": "rejected", "error": "可用资金不足",
  "detail": { "ok": false, "error": "可用资金不足" } }
```

### 4.3 HTTP 状态码与 `code`

| HTTP | `code` | 含义 | 你该怎么办 |
|---|---|---|---|
| 200 | — | 成功 | — |
| 204 | — | CORS 预检（`OPTIONS`） | 浏览器自动处理 |
| 400 | `bad_request` | 请求格式错：JSON 坏了、`clientOrderId` 非法、缺 `stockId` | 修代码，别重试 |
| 400 | `rejected` | 交易规则拒绝 | 看 `error`，按 §10 处理 |
| 401 | `unauthorized` | Key 缺失/格式错/无效/已撤销/绑定账号不存在 | 停止重试，检查 Key |
| 403 | `forbidden` | 没有 scope，或来源 IP 不在白名单 | 检查权限/网络出口 |
| 404 | `not_found` | 路径不存在，或方法不对 | 看 `GET /open/v1` 的目录 |
| 413 | `bad_request` | 请求体超过 64KB | 别往请求里塞大对象 |
| 429 | `rate_limited` | 超请求配额，或单 Key 的 SSE 连接数超限 | 退避，见 §4.5 |
| 503 | `disabled` | 开放接口被关闭（`config.open.enabled=false`） | 找运维 |
| 503 | `unavailable` | 全服 SSE 连接数满 | 稍后重连，或改用轮询 |

> 方法不匹配（例如 `POST /open/v1/markets`）会走 404，而不是 405。

### 4.4 限流

| 维度 | 默认 | 计数方式 | 配置项 |
|---|---|---|---|
| 读接口 | **240 次/分钟/Key** | 滑动窗口，每个 GET 算 1 次 | `config.open.rateLimit.read` |
| 交易接口 | **60 次/分钟/Key** | `POST /orders`、`DELETE /orders/:id` | `config.open.rateLimit.trade` |
| IP 兜底 | **1200 次/分钟/IP** | 鉴权**之前**就计数，假 Key 也挡 | `config.open.rateLimit.ip` |
| SSE | 2 条/Key，100 条全服 | 建立连接算 1 次读请求 | `config.open.maxStreams*` |

超限响应：

```json
{ "ok": false, "error": "请求过于频繁，请降低轮询频率或加长间隔", "code": "rate_limited" }
```

**配额只影响请求频率，不影响交易规则。** 下单冷却、费率、锁仓对所有玩家一视同仁，
量化不会因为"是程序"而获得更快的通道或更低的费用。

### 4.5 429 的正确处理

```python
import time, random

def backoff(attempt):
    # 1s, 2s, 4s ... 封顶 30s，加一点抖动避免所有策略同时重试
    return min(30.0, (2 ** attempt) + random.random())
```

- 连续 429 时，先降低轮询频率（例如从 700ms 调到 2s），再考虑退避。
- 不要用固定 `sleep(0.1)` 疯狂重试，IP 兜底会把你整台机器挡住。
- 下单返回 429 时，**不要换一个 `clientOrderId` 重试**；用同一个 id 重试，
  服务端幂等会保证只成交一次。

### 4.6 CORS

浏览器里直接 `fetch` 也可以：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-API-Key, Authorization
Access-Control-Max-Age: 600
```

`OPTIONS` 预检不需要鉴权，也**不消耗任何配额**（连 IP 兜底都不计）。

---

## 5. 端点参考

统一前缀：`/open/v1`。下面每个接口都标注了**是否需要 Key**、**需要什么 scope**。

### 5.1 `GET /open/v1` — 能力目录

需要 `read`。人肉调接口时的第一站，返回当前版本、绑定账号和全部路径。

```json
{
  "ok": true,
  "version": "v1",
  "account": "quant_a",
  "endpoints": [
    "GET  /open/v1/health",
    "GET  /open/v1/meta",
    "GET  /open/v1/markets?depth=5&trades=30&seats=0",
    "GET  /open/v1/markets/:stockId/bars?limit=120",
    "GET  /open/v1/markets/:stockId/minute",
    "GET  /open/v1/markets/:stockId/holders",
    "GET  /open/v1/account",
    "GET  /open/v1/orders?status=live|all&since=",
    "GET  /open/v1/fills?since=&limit=50",
    "POST /open/v1/orders",
    "DELETE /open/v1/orders/:orderId",
    "GET  /open/v1/stream?depth=1&trades=0"
  ]
}
```

### 5.2 `GET /open/v1/health` — 存活探针

**唯一免鉴权**的端点。只返回版本与服务器时间，不碰任何账户数据。

```json
{ "ok": true, "version": "v1", "serverTime": 1792300000000 }
```

用途：监控、负载均衡健康检查、确认"服务是不是还活着"。
它仍然受 IP 兜底限流（1200 次/分钟/IP）。

### 5.3 `GET /open/v1/ping` — 鉴权自检

需要 `read`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `account` | string | 绑定的账号 |
| `nick` | string | 昵称（没有昵称时回落为账号） |
| `keyId` | string | 当前 Key 的 8 位 id |
| `scopes` | string | `"read"` / `"read,trade"` |
| `seq` | int | 当前 tick 序号 |
| `serverTime` | int | 服务器墙钟（毫秒） |
| `cooldownLeftMs` | int | 当前账户下单冷却剩余毫秒，0 表示可以下单 |

用途：脚本启动时确认 Key 有效、确认账号没搞错、拿到初始冷却。

### 5.4 `GET /open/v1/meta` — 标的全集与有效规则

需要 `read`。启动时调一次，把结果缓存起来。

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | string | `"v1"` |
| `seq` | int | 当前 tick 序号 |
| `serverTime` | int | 毫秒 |
| `day` | object | 交易日时钟，见 §5.4.1 |
| `stocks` | array | `[{id, name, lotSize}]`，**不含**指数 |
| `index` | object | `{stockId:"999999", name:"大盘指数"}` |
| `rules` | object | 本账户有效规则，见 §5.4.2 |
| `tickIntervalMs` | int | 撮合间隔，当前 700 |

#### 5.4.1 `day` 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `enabled` | bool | 是否启用了交易日时钟 |
| `day` | int | 第几个交易日（从 1 开始） |
| `phase` | string | `auction` / `morning` / `lunch` / `afternoon` / `closeAuction` / `night` |
| `label` | string | 中文阶段名，例如 `"上午连续竞价"` |
| `trading` | bool | **是否接受下单**。`false` 时 `POST /orders` 必拒 |
| `auction` | string/null | 当前是否集合竞价：`"open"` / `"close"` / `null` |
| `locked` | bool | 是否处于"不可撤单"窗口（竞价最后 10 秒） |
| `unlockLeftMs` | int/null | 距离进入不可撤单窗口还有多少毫秒；非竞价阶段为 `null` |
| `phaseMs` | int | 当前阶段总时长 |
| `phaseElapsedMs` | int | 当前阶段已过去多久 |
| `phaseLeftMs` | int | 当前阶段还剩多久 |
| `phaseEndsAt` | int | 当前阶段的服务器结束时刻（毫秒时间戳） |
| `dayStartAt` | int | 本交易日的开始时刻（开盘竞价开始） |
| `dayEndsAt` | int | 本交易日的结束时刻 |
| `gameClockMs` | int | 游戏内时钟（自 00:00 起的毫秒） |
| `phaseGameMs` | int | 当前阶段对应的"游戏内时长" |

当 `enabled === false` 时，`day` 只有 `{enabled:false, trading:true}` 两个字段，
其余字段不存在。策略要做空值兜底。

#### 5.4.2 `rules` 字段

| 字段 | 类型 | 单位 | 说明 |
|---|---|---|---|
| `feeRate` | number | 小数 | 手续费率，`0.0001` = 万分之一 = 0.01% |
| `cooldownMs` | int | 毫秒 | 两次下单的最小间隔（账户级、跨股票） |
| `lockMs` | int | 毫秒 | 买入后锁仓时长（T+） |
| `marginRatio` | number | 小数 | 开空保证金比例，`0.5` = 50% |
| `maintenance` | number | 小数 | 维持保证金率，跌破即强平 |
| `financeRatio` | number | 小数 | 融资买入的自备比例，`0.5` = 2 倍上限 |
| `allowNakedShort` | bool | — | 是否允许无券开空；v1 默认 `false` |
| `finance.enabled` | bool | — | 融资买入是否开放 |
| `finance.baseMinuteRate` | number | 小数/分钟 | 基础融资利率，`0.0001` = 0.01%/分钟 |
| `finance.maxMinuteRate` | number | 小数/分钟 | 融资利率上限 |
| `lending.enabled` | bool | — | 融券池是否开放 |
| `lending.baseDailyRate` | number | 小数/**日** | 基础融券（做空）日利率，`0.001` = 0.1%/日 |
| `lending.maxDailyRate` | number | 小数/**日** | 做空日利率上限。做空利息**每个游戏日结算一次**，收盘日终结算时扣 |
| `priceLimit.enabled` | bool | — | 是否启用涨跌停 |
| `priceLimit.pct` | number | **百分数** | `30` 表示 ±30%（不是 0.3） |
| `actions` | array | — | 支持的四种 action |
| `orderTypes` | array | — | 只有 `["limit"]`，不支持市价单 |

> 这些值是**券商覆盖 + 拥挤税 + 星级/每周之星**之后的有效值。不要拿本文的基准表硬编码。

### 5.5 `GET /open/v1/markets` — 全市场行情

需要 `read`。

| 查询参数 | 默认 | 取值 | 说明 |
|---|---|---|---|
| `depth` | 5 | 0–5 | 盘口档数；0 表示不要盘口 |
| `trades` | 30 | 0–30 | 逐笔条数；0 表示不要逐笔 |
| `seats` | 0 | 0/1 | `1` 才返回券商席位榜（体积大） |

响应：

```json
{
  "ok": true,
  "seq": 18422,
  "serverTime": 1792300000000,
  "day": { "...": "同 /meta" },
  "index": { "stockId": "999999", "name": "大盘指数", "last": 1012.35,
             "prevClose": 1008.0, "change": 4.35, "changePct": 0.43,
             "volume": 1250000, "turnover": 38000000 },
  "markets": [ { "...": "见下表" } ]
}
```

#### 5.5.1 `markets[]` 字段

| 字段 | 类型 | 单位 | 说明 |
|---|---|---|---|
| `stockId` | string | — | 股票代码 |
| `name` | string | — | 名称 |
| `last` | number | 元 | 最新成交价 |
| `prevClose` | number | 元 | 昨收（涨跌停基准） |
| `open` | number | 元 | 今开 |
| `high` | number | 元 | 今日最高 |
| `low` | number | 元 | 今日最低 |
| `change` | number | 元 | `last - prevClose` |
| `changePct` | number | **百分数** | `0.25` 表示 +0.25% |
| `volume` | int | 股 | 当日累计成交量 |
| `turnover` | number | 元 | 当日累计成交额 |
| `lotSize` | int | 股 | 一手股数 |
| `band` | object/null | 元 | `{up, down}` 涨跌停价；无交易日时钟或关闭涨跌停时为 `null` |
| `auction` | object/null | — | 集合竞价快照，见下 |
| `flow` | object | — | 当日内外盘，见下 |
| `lending` | object | — | 融券池，见下 |
| `depth` | object/null | — | `{bids, asks}`；`depth=0` 时为 `null` |
| `trades` | array/null | — | 逐笔，新到旧；`trades=0` 时为 `null` |
| `seats` | object | — | 仅 `seats=1` 时出现 |

**`auction`（集合竞价）**

```json
{ "kind": "open", "price": 20.02, "volume": 3400, "locked": false }
```

| 字段 | 说明 |
|---|---|
| `kind` | `"open"` 开盘竞价 / `"close"` 收盘竞价 |
| `price` | 虚拟参考价（最大成交量价）；`null` 表示盘口还没交叉 |
| `volume` | 该参考价下可成交股数 |
| `locked` | 是否已进入不可撤单窗口 |

非竞价阶段为 `null`。

**`flow`（当日内外盘）**

```json
{ "outerVol": 72000, "outerAmt": 1443600,
  "innerVol": 56400, "innerAmt": 1130400,
  "net": 313200, "outerPct": 56.09 }
```

| 字段 | 说明 |
|---|---|
| `outerVol` / `outerAmt` | 外盘（主动买）股数 / 金额 |
| `innerVol` / `innerAmt` | 内盘（主动卖）股数 / 金额 |
| `net` | 净流入 = 外盘额 − 内盘额 |
| `outerPct` | 外盘额占比（百分数）；当日无成交时为 `null` |

**`lending`（融券池）**

```json
{ "enabled": true, "total": 800000, "borrowed": 120000, "reserved": 0,
  "available": 680000, "utilization": 15,
  "dailyRate": 0.13, "settle": "daily", "settledDay": 12,
  "allowNakedShort": false, "shortInterest": 120000, "history": [] }
```

| 字段 | 说明 |
|---|---|
| `enabled` | 融券池是否开放 |
| `total` | 总挂借股数 |
| `borrowed` | 已借出（已开空）股数 |
| `reserved` | 已下单未成交占用的券源 |
| `available` | 可借股数 = `total - borrowed - reserved` |
| `utilization` | 利用率（百分数） |
| `dailyRate` | 当前**日息**（**百分数**，`0.13` 表示 0.13%/日），随利用率上升、封顶 `maxDailyRate` |
| `settle` | 计息口径，恒为 `"daily"`：每个游戏日结算一次 |
| `settledDay` | 已结算到第几个交易日（`-1` = 还没结过任何一天；收盘结算时它的值恒 ≥ 1） |
| `allowNakedShort` | 是否允许无券开空 |
| `shortInterest` | 未平空头总量 |
| `history` | 空头仓位采样 `[{t, qty}]`，约 5 分钟一点 |

> 注意：某些券商的可借上限会按 `lendCapacityMul` 打折（例如招伤只有池子的 60%）。
> `lending.available` 是**池子口径**；实际能借多少，以 `sell_open` 被拒时返回的
> "当前可借 N 股"为准。

**`depth`（盘口）**

```json
{
  "bids": [ { "price": 20.04, "qty": 3000,
              "brokers": [ { "key": "huatai", "qty": 2000, "pct": 67 } ] } ],
  "asks": [ { "price": 20.05, "qty": 2600,
              "brokers": [ { "key": "zhongxin", "qty": 1600, "pct": 62 } ] } ]
}
```

- `bids` 从高到低，`asks` 从低到高；`price=0` 的档位不会出现。
- `qty` 是**该价位剩余股数**（已扣掉已成交部分）。
- `brokers` 只有开启席位功能时才有，显示该档位占比最高的前 2 家券商。

**`trades`（逐笔）**

```json
[ { "seq": 816, "t": 1792300001200, "price": 20.04, "qty": 100,
    "side": "buy", "buyBroker": "huatai", "sellBroker": "zhongxin" } ]
```

| 字段 | 说明 |
|---|---|
| `seq` | 该股票逐笔磁带的序号（用于排序），**不是** `/fills` 的成交游标 |
| `t` | 成交时间（毫秒） |
| `price` / `qty` | 成交价 / 股数 |
| `side` | 主动方：`buy` 主动买 / `sell` 主动卖 |
| `buyBroker` / `sellBroker` | 买方/卖方券商 key，可能为 `null` |

#### 5.5.2 `index` 字段

| 字段 | 说明 |
|---|---|
| `stockId` | 固定 `999999` |
| `name` | `大盘指数` |
| `last` / `prevClose` / `change` / `changePct` | 点位与涨跌 |
| `volume` / `turnover` | 成分股合计成交量/额 |

指数**不可交易**，下单会返回 `指数不可交易，仅供观察大盘`。

### 5.6 `GET /open/v1/markets/:stockId/bars` — 已收盘日线

需要 `read`。支持个股与指数（`999999`）。

| 查询参数 | 默认 | 取值 |
|---|---|---|
| `limit` | 120 | 1–260 |

```json
{
  "ok": true,
  "stockId": "600001",
  "today": 3,
  "bars": [
    { "day": 1, "open": 20.0, "high": 20.8, "low": 19.8, "close": 20.5,
      "volume": 820000, "turnover": 16700000,
      "outerVol": 460000, "outerAmt": 9400000,
      "innerVol": 360000, "innerAmt": 7300000,
      "net": 2100000, "t": 1792200000000 }
  ]
}
```

- `bars` 按时间**升序**（旧 → 新）。
- **只含已收盘的交易日**。今天那根要等收盘结算才出现；当日 K 线请自己拿实时行情拼。
- `today` 是当前交易日序号，用来判断最后一根是不是昨天。
- `day` 是游戏内的第几个交易日，不是日历日期。
- 未知标的返回 `400` + `{ "ok": false, "error": "未知标的" }`（注意这个接口**没有** `code` 字段）。

### 5.7 `GET /open/v1/markets/:stockId/minute` — 分时序列

需要 `read`。支持个股与指数。

```json
{
  "ok": true,
  "stockId": "600001",
  "priceHistory": [
    { "t": 1792299480000, "price": 20.0, "vol": 0 },
    { "t": 1792299480700, "price": 20.01, "vol": 1200 }
  ]
}
```

- 每个 tick 一个点，最多约 **10300 点（约 2 小时）**，跨天连续。
- 个股的 `vol` 是**当日累计成交量**，不是本 tick 增量；要增量自己前后相减。
- 指数的 `vol` 恒为 0。
- 返回全量，没有分页；点数多时注意带宽。
- 未知标的返回 `400` + `{ "ok": false, "error": "未知标的" }`（同样没有 `code`）。

### 5.8 `GET /open/v1/markets/:stockId/holders` — 筹码概览

需要 `read`。

> 路径名沿用 H5 的 `holders`，但**不返回前十大股东名单**，只返回三个汇总数。

```json
{
  "ok": true,
  "stockId": "600001",
  "longTotal": 6200000,
  "float": 100000000,
  "shortInterest": 120000
}
```

| 字段 | 说明 |
|---|---|
| `longTotal` | 全服账户的多头持仓合计（股，不含系统账户） |
| `float` | 流通盘（股） |
| `shortInterest` | 未平空头总量（股） |

未知股票返回 `400` + `未知股票`。

### 5.9 `GET /open/v1/account` — 账户快照

需要 `read`。策略每次决策前读一次即可，不要每 tick 都读（浪费读配额）。

顶层字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | bool | — |
| `seq` | int | 当前 tick |
| `serverTime` | int | 毫秒 |
| `cooldownLeftMs` | int | 账户下单冷却剩余 |
| `name` | string | 账号（登录名） |
| `nick` | string | 昵称 |
| `cash` | number | 可用现金 |
| `orderFrozen` | number | 在途买单冻结 |
| `shortMargin` | number | 开空保证金 |
| `financeDebt` | number | 融资负债合计（本金 + 已摊利息） |
| `financePrincipal` | number | 融资负债中的未还本金 |
| `financeInterest` | number | 累计已计融资利息（展示口径） |
| `equity` | number | 总权益 |
| `realizedPnL` | number | 累计已实现盈亏 |
| `deposited` | number | 终身累计入金 |
| `longValue` / `shortValue` | number | 全部持仓多头/空头市值 |
| `longPnl` / `shortPnl` | number | 多头/空头浮动盈亏合计 |
| `marginUsage` | number | 风险度（百分数，见下） |
| `positions` | array | 持仓明细 |
| `orders` | array | 当前在途委托（同 `/orders?status=live`） |
| `orderHistory` | array | 最近 50 条已完结委托 |
| `trades` | array | 最近 50 笔成交（不带 `seq`，增量请用 `/fills`） |
| `broker` | **object** | 券商详情，key 在 `broker.key` |
| `marginCall` | object/null | 追保预警，见下 |
| `rules` | object | 同 `/meta` |
| `auto` / `events` / `liquidations` | — | H5 同源字段，策略可忽略 |

`marginUsage` 的公式：

```
marginUsage = (空头市值 + 融资负债 + 融券欠息) / equity × 100
```

- `0` 表示没有杠杆。
- 接近 `maintenance × 100` 时很危险。
- 到 `100` 附近意味着权益已经接近负债，随时可能强平。

> 实现细节：`riskDebt`（融资负债 + 融券欠息）为 0 时，服务端直接返回 `0`，
> 即使你持有空头。判断空头风险请结合 `positions[].liquidationPrice` 与 `rules.maintenance`，
> 不要只看 `marginUsage`。

`marginCall`（追保预警）：

```json
{
  "broker": "zhongxin", "name": "钟信证券",
  "maintenance": 0.3, "trigger": 0.25,
  "exposure": 20000, "need": 800, "left": 1200, "side": "long"
}
```

| 字段 | 说明 |
|---|---|
| `maintenance` | 维持率 |
| `trigger` | 实际强平触发线（维持率 − 券商缓冲） |
| `exposure` | 触发预警的敞口（多头或空头市值） |
| `need` | 需要补充多少权益才能回到维持线上 |
| `left` | 距离强平还有多少权益空间 |
| `side` | `long`（融资多头）/ `short`（空头） |

`null` 表示没有预警。

#### 5.9.1 `positions[]` 字段

```json
{
  "stockId": "600001",
  "name": "大米集团",
  "last": 20.1,
  "long": {
    "qty": 1000,
    "cost": 20050,
    "value": 20100,
    "pnl": 50,
    "sellable": 900,
    "lots": [
      { "qty": 100, "price": 20.05, "ts": 1792299000000,
        "lockedUntil": 1792299010000, "debt": 0, "sellable": true }
    ]
  },
  "short": {
    "qty": 0, "cost": 0, "value": 0, "margin": 0, "pnl": 0,
    "coverable": 0, "lots": []
  },
  "financeDebt": 0,
  "financePrincipal": 0,
  "financeInterest": 0,
  "liquidationPrice": null,
  "liquidationPriceLong": null,
  "lending": { "stockId": "600001", "offered": 0, "lentOut": 0, "removable": 0,
               "freeToLend": 0, "interestEarned": 0, "interestDebt": 0, "interestPaid": 0, "interestPending": 0 }
}
```

| 字段 | 说明 |
|---|---|
| `long.qty` | 多头总股数 |
| `long.cost` | 多头总成本（成交价合计，不含费用） |
| `long.value` | 按最新价计算的多头市值 |
| `long.pnl` | `value - cost` |
| `long.sellable` | **现在能卖的上限**（已过锁仓、未被在途平仓占用、未挂借） |
| `long.lots[]` | 分批明细，FIFO 卖出 |
| `long.lots[].lockedUntil` | 这一批的解锁时刻（毫秒） |
| `long.lots[].debt` | 这一批的融资负债（全款买入为 0） |
| `long.lots[].sellable` | 这一批现在能不能卖 |
| `short.qty` | 空头总股数 |
| `short.coverable` | **现在能平的上限**（未被在途平仓占用） |
| `short.lots[].margin` | 这一批占用的保证金 |
| `financeDebt` | 该股融资负债 |
| `liquidationPrice` | 空头强平价；没有空头或不会强平时为 `null` |
| `liquidationPriceLong` | 融资多头强平价；全款多头为 `null` |
| `lending` | 该股的挂借情况 |

`positions[].lending` 的字段：

| 字段 | 说明 |
|---|---|
| `offered` | 你在这只股票上挂出的可借股数 |
| `lentOut` | 其中已经借出去的数量 |
| `removable` | 现在能撤借的数量（扣掉在途开空占用） |
| `freeToLend` | 现在还能新挂借的数量（按整手向下取整） |
| `interestEarned` | 累计已收利息 |
| `interestDebt` | 应收未收（借券方现金不足时挂账） |
| `interestPaid` | 累计已付利息（你作为空头借券时） |
| `interestPending` | **今日已累计、还没到收盘结算**的做空利息（收盘那次结算一次性从现金扣） |

> **卖出/平仓永远用 `sellable` / `coverable`，不要用 `qty`。** 用 `qty` 会在锁仓期、
> 有在途平仓单、或已挂借时被拒。

### 5.10 `GET /open/v1/orders` — 委托查询

需要 `read`。

| 查询参数 | 默认 | 说明 |
|---|---|---|
| `status` | `live` | `live` 只看在途；`all` 在途 + 已完结 |
| `since` | 0 | 只要 `ts >= since` 的（毫秒时间戳） |
| `limit` | 100 | 1–200 |

```json
{
  "ok": true,
  "seq": 18425,
  "serverTime": 1792300002100,
  "orders": [
    { "id": "600001-O42", "stockId": "600001", "action": "buy_open",
      "price": 20.05, "qty": 100, "filled": 100, "remain": 0,
      "status": "filled", "ts": 1792300000500 }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 委托号，格式 `<stockId>-O<序号>` |
| `stockId` | 股票代码 |
| `action` | 四种 action 之一 |
| `price` | 委托价 |
| `qty` | 委托总股数 |
| `filled` | 已成交股数 |
| `remain` | 未成交股数 = `qty - filled` |
| `status` | `live` / `filled` / `canceled` |
| `ts` | 委托创建时间（毫秒） |

排序：按 `ts` 倒序（新的在前）。`status=all` 时在途与已完结混在一起，按 `orderId` 去重。

**`status=all` 不是"只查当天"**：它返回内存里最近 **100 条**已完结委托（跨日保留），
加上当前在途。超过 100 条的老记录会被挤掉；需要完整历史请查服务端日志。

### 5.11 `POST /open/v1/orders` — 下单

需要 **`trade`** scope。

请求体：

```json
{
  "stockId": "600001",
  "action": "buy_open",
  "qty": 100,
  "price": 20.05,
  "finance": false,
  "clientOrderId": "ma-1792300000-18422"
}
```

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `stockId` | **是** | string | 股票代码，必须来自 `/meta` 的 `stocks[].id`。**不传会 400** |
| `action` | **是** | string | `buy_open` / `sell_close` / `sell_open` / `buy_close` |
| `qty` | **是** | number | 股数，正整数；开仓必须是 `lotSize` 整数倍 |
| `price` | **是** | number | 限价，>0；服务端四舍五入到两位小数 |
| `finance` | 否 | bool | 仅 `buy_open` 生效；`true` 走融资 |
| `clientOrderId` | **强烈建议** | string | 幂等键，1–64 位 `[A-Za-z0-9._:-]` |

`stockId` 只接受**代码**，不接受名称或简称（`"大米集团"` 会得到 `未知股票`）。

成功响应：

```json
{
  "ok": true,
  "order": {
    "id": "600001-O42", "stockId": "600001", "action": "buy_open",
    "price": 20.05, "qty": 100, "filled": 0, "remain": 100,
    "status": "live", "ts": 1792300000500
  },
  "cooldownLeftMs": 2000,
  "seq": 18422,
  "serverTime": 1792300000500
}
```

幂等回放：

```json
{
  "ok": true,
  "order": { "id": "600001-O42", "...": "" },
  "cooldownLeftMs": 0,
  "seq": 18422,
  "serverTime": 1792300009000,
  "replayed": true
}
```

被拒：

```json
{
  "ok": false,
  "code": "rejected",
  "error": "开仓数量必须为 100 股的整数倍",
  "detail": { "ok": false, "error": "开仓数量必须为 100 股的整数倍" }
}
```

**四种 action 的典型请求：**

```json
// 买入开多 100 股
{ "stockId": "600001", "action": "buy_open", "qty": 100, "price": 20.05,
  "clientOrderId": "open-1" }

// 融资买入 200 股（自备 50%）
{ "stockId": "600001", "action": "buy_open", "qty": 200, "price": 20.05,
  "finance": true, "clientOrderId": "open-fin-1" }

// 卖出平多（数量不必是整手，但必须 <= sellable）
{ "stockId": "600001", "action": "sell_close", "qty": 100, "price": 20.00,
  "clientOrderId": "close-1" }

// 卖出开空（需要券源）
{ "stockId": "600001", "action": "sell_open", "qty": 100, "price": 19.95,
  "clientOrderId": "short-1" }

// 买入平空
{ "stockId": "600001", "action": "buy_close", "qty": 100, "price": 19.90,
  "clientOrderId": "cover-1" }
```

### 5.12 `DELETE /open/v1/orders/:orderId` — 撤单

需要 **`trade`** scope。路径里只需要委托号：

```bash
curl -X DELETE -H "X-API-Key: $KEY" $BASE/open/v1/orders/600001-O42
```

成功：

```json
{
  "ok": true,
  "order": { "id": "600001-O42", "status": "canceled", "filled": 0, "remain": 100,
             "price": 20.05, "qty": 100, "action": "buy_open", "stockId": "600001",
             "ts": 1792300000500 },
  "seq": 18426,
  "serverTime": 1792300003000
}
```

失败（HTTP 400 + `rejected`）：

| `error` | 原因 |
|---|---|
| `委托不存在或已完结` | 委托号写错，或已经全部成交/撤过 |
| `委托已完结` | 委托状态不是 `live` |
| `集合竞价已锁定，不可撤单（等待开盘集中撮合）` | `day.locked === true` |

撤单会释放：

- 买单剩余冻结的现金；
- 卖单剩余占用的 `sellable` / `coverable`；
- 开空单剩余占用的券源。

撤单**不受** `day.trading` 限制（午休、夜间都能撤），这是为了让你能把钱收回来。

### 5.13 `GET /open/v1/fills` — 成交回报

需要 `read`。

| 查询参数 | 默认 | 说明 |
|---|---|---|
| `since` | 0 | **成交序号**，只返回 `seq > since` 的成交 |
| `limit` | 50 | 1–100 |

```json
{
  "ok": true,
  "seq": 18425,
  "serverTime": 1792300002100,
  "nextSince": 9002,
  "fills": [
    { "seq": 9002, "id": "T9002-600001-O42-100", "orderId": "600001-O42",
      "stockId": "600001", "action": "buy_open", "side": "sell",
      "price": 20.04, "qty": 100, "t": 1792300001200 },
    { "seq": 9001, "id": "T9001-600001-O41-200", "orderId": "600001-O41",
      "stockId": "600001", "action": "buy_open", "side": "buy",
      "price": 20.05, "qty": 200, "t": 1792300000500 }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `seq` | **全服成交序号**，跨股票单调递增；只用于比较大小 |
| `id` | 成交号，格式 `T<seq>-<orderId>-<qty>` |
| `orderId` | 对应的委托号 |
| `stockId` | 股票代码 |
| `action` | 这笔成交对应的委托动作 |
| `side` | **主动方**方向（`buy`/`sell`），不是你的方向 |
| `price` | 成交价（= 被动方挂单价） |
| `qty` | 成交股数 |
| `t` | 成交时间（毫秒） |

> `seq` 是**全服**计数器：NPC 之间、别的玩家之间的每一笔成交都会消耗序号。
> 所以你的两笔成交之间可能从 1300 跳到 8428，这不是漏单，只是中间发生了很多别人的成交。
> 判断有没有漏单：拿上次的 `nextSince` 再请求一次，返回为空就是追平了。

**游标规则：**

1. 第一次调用不传 `since`，拿全量（最多 100 条）。
2. 记下响应里的 `nextSince`。
3. 下次调用 `?since=<nextSince>`。
4. **处理完所有 fills 之后再持久化游标**；不要在循环中途更新，否则崩溃会漏单。
5. `nextSince` 只会 ≥ 传入的 `since`，不会回退。

**为什么用序号而不是时间戳：** 同一个 tick 内可能连出好几笔成交，时间戳完全相同。
用时间戳做游标会把同毫秒的成交整批漏掉。

**容量提醒：** 每个账户内存里只保留最近 **100 笔**成交。如果两轮轮询之间成交超过 100 笔
（重仓策略在剧烈行情里有可能），更老的成交会被挤掉。建议：下单后立刻拉一次；
高频策略至少每 2–3 秒拉一次。

### 5.14 `GET /open/v1/stream` — SSE 行情流

需要 `read`。查询参数与 `/markets` 相同（`depth` / `trades` / `seats`），
**在建立连接时定下**，之后不能改。

响应头：`Content-Type: text/event-stream`。

帧格式：

```
retry: 2000

event: tick
data: {"seq":18422,"t":1792300000000,"day":{...},"index":{...},"markets":[...]}

: ping

event: tick
data: {"seq":18423,...}
```

- 每个 tick 一帧 `event: tick`，内容是 `{seq, t, day, index, markets}`。
- 建连后**立即**推一帧，不用等下一个 tick。
- 每 15 秒发一行 `: ping` 注释作为心跳。
- `retry: 2000` 建议客户端断线后 2 秒重连（浏览器 `EventSource` 会自动遵守）。
- **不含账户段**。账户变化请单独调 `/account`。
- 单 Key 最多 2 条连接，全服最多 100 条。
  - 超过每 Key 上限：`429 rate_limited`。
  - 全服满：`503 unavailable`。

Python 示例：

```python
import json
import requests

with requests.get(
    f"{BASE}/open/v1/stream?depth=1&trades=0",
    headers={"X-API-Key": KEY},
    stream=True,
    timeout=(5, 60),
) as r:
    r.raise_for_status()
    for line in r.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        frame = json.loads(line[6:])
        # 同一帧可能因为重连被重复推送，用 seq 去重
        if frame["seq"] <= last_seq:
            continue
        last_seq = frame["seq"]
        on_tick(frame)
```

标准库（不依赖 requests）：

```python
import json
import urllib.request

req = urllib.request.Request(
    f"{BASE}/open/v1/stream?depth=1&trades=0",
    headers={"X-API-Key": KEY},
)
with urllib.request.urlopen(req, timeout=60) as resp:
    for raw in resp:
        line = raw.decode("utf-8").strip()
        if line.startswith("data: "):
            frame = json.loads(line[6:])
```

**断线重连：**

- 用 `seq` 判断有没有漏帧；如果重连后 `seq` 跳变很大，补一次 `/markets`。
- SSE 不保证补发断线期间的帧；它只保证"连上之后的每一帧"。
- 如果策略同时需要账户，建议：SSE 驱动决策，决策时再拉 `/account`。

---

## 6. 交易规则与数值

本节是"会直接拒单"的硬规则。所有规则与 H5 手动下单**完全一致**，没有量化特权。

### 6.1 下单冷却（账户级，跨股票共享）

- 基准 **2000ms**，从**上一张成功挂出的委托**开始计时。
- 冷却按**账户**算，不按股票、不按 Key：2 秒内下第二单，不管哪只股票都拒。
- 被拒的委托**不消耗**冷却（因为它没有真正挂出去）。
- 券商可覆盖：

| 券商 | key | 冷却 | 锁仓 | 费率（基准） | 融资自备 | 开空保证金 | 维持率 |
|---|---|---|---|---|---|---|---|
| 钟信证券 | `zhongxin` | 3000ms | 10s | 0.0003 | 0.4 | 0.4 | 0.30 |
| 滑泰证券 | `huatai` | **500ms** | **5s** | 0.00015 | 0.6 | 0.6 | 0.30 |
| 招伤证券 | `zhaoshang` | 2000ms | 10s | 0.0002 | 0.5 | 0.5 | 0.30 |
| 天疯证券 | `tianfeng` | 2000ms | **8s** | 0.00025 | **0.3** | **0.3** | **0.25** |
| 嗨通证券 | `haitong` | 2500ms | 10s | **0.00005** | 0.55 | 0.55 | 0.30 |
| 东风财富 | `dongfeng` | 1500ms | 10s | 0.0001 | 0.5 | 0.5 | **0.33** |

> 表里的费率是**基准值**。实际 `rules.feeRate` 还会被拥挤税（×0.8 ~ ×1.3）、
> 星级、每周之星（当周之星佣金减半）调整。**永远读 `/meta` 或 `/account` 的 `rules`。**
>
> 嗨通还有"偶发通道卡顿"：约 2% 的报单会额外多等一个 tick，表现为冷却比配置略长。
> 所以下单后用回包的 `cooldownLeftMs`，不要自己算。

**频率上限 = `1000 / cooldownMs` 单/秒**：

- 基准 2s → 0.5 单/秒；
- 滑泰 500ms → 2 单/秒；
- 钟信 3s → 0.33 单/秒。

这跟 tick 是 700ms 没有关系。**不要设计"每 tick 下单"的策略。**

### 6.2 整手规则

- `buy_open` / `sell_open`：`qty` 必须是 `lotSize` 的整数倍。
  当前 10 只股票都是 100 股/手。
- `sell_close` / `buy_close`：**不要求整手**，但必须 ≤ `sellable` / `coverable`。
- `qty` 必须是正整数；服务端会 `Math.floor`，传 `100.9` 会变成 `100`。
- 可卖/可平数量本身可能不是整手（例如买入 100、卖出 30 剩 70），平仓时可以卖 70。

### 6.3 买入锁仓（T+10 秒）

- 买入成交后，这一批股票在 `rules.lockMs` 内不能卖。
- 基准 10 秒，滑泰 5 秒，天疯 8 秒。
- 锁仓按**成交时间**算，不是自然日。
- `positions[].long.lots[]` 给出每一批的 `lockedUntil` 和 `sellable`。
- `positions[].long.sellable` 是汇总后的可卖上限（还扣掉了在途平仓预留和挂借）。

### 6.4 同股多空互斥

同一只股票上，一个账户只能持一个方向：

- 持有多头（或在途 `buy_open`）→ 不能 `sell_open`；
- 持有空头（或在途 `sell_open`）→ 不能 `buy_open`；
- 平仓（`sell_close` / `buy_close`）和同向加仓不受限。

判定**包含在途开仓委托**。所以想换向，必须：

1. 撤掉反向的在途开仓单；
2. 把另一侧仓位平掉；
3. 再开新方向。

### 6.5 交易时段门控

| 阶段 | 下单 | 撤单 | 撮合 |
|---|---|---|---|
| 开盘集合竞价 | 接受 | 前 20 秒可以，后 10 秒拒绝 | 阶段结束时集中撮合 |
| 上午连续竞价 | 接受 | 可以 | 连续撮合 |
| 午间休市 | **拒绝** | 可以 | 不撮合 |
| 下午连续竞价 | 接受 | 可以 | 连续撮合 |
| 收盘集合竞价 | 接受 | 前 10 秒可以，后 10 秒拒绝 | 阶段结束时集中撮合 |
| 夜间结算 | **拒绝** | 可以 | 不撮合 |

- 下单前检查 `day.trading`。
- 撤单前检查 `day.locked`（只有竞价阶段可能为 `true`）。
- 集合竞价阶段下单只入簿，不连续成交；`markets[].auction.price` 是虚拟参考价。
- 竞价最后 10 秒"想撤撤不掉、想追不敢追"，这是刻意设计。

### 6.6 涨跌停 ±30%

- 基准是 `prevClose`（上一交易日收盘价）。
- 委托价必须落在 `[band.down, band.up]` 内，否则拒单：
  `价格超出涨跌停范围（14.00 ~ 26.00）`。
- `markets[].band` 直接给上下限；`band` 为 `null` 表示当前没启用涨跌停
  （例如没有交易日时钟）。
- `rules.priceLimit.pct = 30` 表示 ±30%，是**百分数**。
- 涨跌停同时约束 NPC 的公允价值，所以极端日会出现连续涨停/跌停。

### 6.7 委托价偏离 ±50%

- `|price - last| / last > 0.5` 拒单：
  `委托价偏离最新价 52.3%，超过 50% 上限`。
- 这是"送错价格"保护，防止把 20 写成 200。
- 用过期行情算价格很容易触发，所以下单前重新读一次 `last`。

### 6.8 价格笼子 ±5%

- 单笔**成交价**相对上一笔成交价的偏离不能超过 5%。
- 成交价取被动方挂单价，所以"挂一张远离盘口的单等人来吃"不会按你的价格成交：
  当这张挂单将要成交时，如果成交价超出笼子，**这张挂单会被直接撤掉**。
- 实际影响：
  - 想成交，价格要贴近最新价（通常贴对手价即可）；
  - 不要挂 ±20% 的"钓鱼单"期待成交；
  - 极端行情里，远价挂单可能被系统撤掉，`/orders?status=all` 里会看到 `canceled`。

### 6.9 融券与券源

- `sell_open` 默认必须从该股票的融券池借券（`allowNakedShort=false`）。
- 可借量看 `markets[].lending.available`；部分券商还会打折。
- 券源不足拒单：`可借券源不足，当前可借 300 股（请先有人挂借出）`。
- 借券要付息：按 `lending.dailyRate`（百分数/**日**）计，随利用率上升，封顶 `maxDailyRate`。**每个游戏日结算一次**——收盘日终结算时一次性扣，日内不逐个 tick 摊息。
- 平空时自动还券，释放券源。
- v1 开放接口**不提供**"挂借出"（把持仓借给别人收息），那只能在网页里操作。

### 6.10 资金、保证金与杠杆

#### 买入开多（全款）

冻结 = `price × qty × (1 + feeRate)`。
成交时按实际成交价结算，多冻结的部分退回。

#### 融资买入

- 冻结 = `price × qty × financeRatio`（自备部分）。
- 借入 = `成交额 × (1 - financeRatio) + 手续费`，记入该批次 `debt`。
- 预检（组合口径）：

```
equity >= maintenance × (已有融资多头市值 + 在途开多市值 + 本单市值) + 本单手续费
```

- 利息按 tick 摊入 `debt`，同时计入 `realizedPnL`。
- 强平：`equity < maintenance × 多头市值` 时，系统强卖多头还债。
- 强平价看 `positions[].liquidationPriceLong`。

#### 卖出开空

- 保证金 = `成交额 × marginRatio`，从卖出款里扣，进入 `shortMargin`。
- 现金变化 = `+成交额 - 保证金 - 手续费`。
- 预检（组合口径）：

```
equity >= marginRatio × (已有空头市值 + 在途开空市值 + 本单市值) + 本单手续费
```

- 强平：`equity < maintenance × 空头市值` 时，系统买入平空。
- 强平价看 `positions[].liquidationPrice`。

#### 强平不受你控制

- 强平**不走你的委托**，直接吃对手盘（不足时按系统兜底价），并可能撤掉你的在途单。
- 强平后 `account.liquidations` 会有一条记录。
- 所以杠杆策略要留缓冲：`marginUsage` 不要贴着 `maintenance × 100` 跑。

### 6.11 手续费

- 费率：`rules.feeRate`，基准 `0.0001`（万分之一）。
- 买入：成交额 × 费率，从现金扣（融资买入时并入负债）。
- 卖出：成交额 × 费率，从卖出款扣。
- 开空：成交额 × 费率，从卖出款扣。
- 平空：成交额 × 费率，从现金扣。
- 费用计入 `realizedPnL`，所以：

```
equity ≈ 初始资金 + realizedPnL + 浮动盈亏
```

### 6.12 停牌

- 运维可以手动停牌（`server.py halt`）。
- 停牌期间所有下单拒：`已停牌，暂停下单`。
- 复牌后自动恢复。
- 停牌时行情仍在推（价格走平），分时图不断点。

### 6.13 禁止自成交

- 同一账户的买单不能吃自己的卖单。
- 如果新委托会遇到自己的挂单，系统会**撤掉你自己的旧挂单**，然后继续找对手盘。
- 所以不要用"自买自卖"制造成交量：只会把自己的单撤掉，还会留下 `canceled` 记录。

---

## 7. 委托与成交语义

### 7.1 委托状态

| `status` | 含义 | 还会变吗 |
|---|---|---|
| `live` | 在途（可能已部分成交） | 会 |
| `filled` | 全部成交 | 不会 |
| `canceled` | 已撤（主动撤单 / 收盘结算 / 系统撤单） | 不会 |

`filled` 字段在 `live` 状态下也可能 > 0，表示部分成交。

### 7.2 成交价

**成交价 = 被动方挂单价。**

- 你挂 20.05 买，对手挂 20.00 卖 → 你成交在 **20.00**（对你更有利）。
- 你主动吃卖一 20.05 → 成交在 **20.05**。
- 所以：`order.price` 是限价，不是成交价；成本要用 `/fills` 的 `price` 或
  `long.cost`。

### 7.3 部分成交

- 一张 1000 股的买单，可能先成交 300，剩 700 继续挂着。
- `filled=300`、`remain=700`、`status=live`。
- 想撤掉剩余：`DELETE /orders/:id`，`remain` 部分释放。
- 不要在部分成交后立刻用同样数量再下一单，否则总仓位会超过预期。

### 7.4 收盘作废

- 日终结算会撤掉所有 `live` 委托。
- 状态变 `canceled`，冻结资金/仓位/券源释放。
- 第二天不会恢复。
- 所以策略要知道"日内策略"和"隔夜策略"的区别：这个市场**没有隔夜挂单**。

### 7.5 服务器重启

- 玩家的在途委托、持仓、现金、成交历史都会从存档恢复。
- 幂等缓存**只在内存**，重启后清空。
- 重启后建议先 `GET /orders?status=all&since=<上次时间>` 对账，再恢复交易。
- 成交序号会接着存档里的最大值继续，不会回退。

### 7.6 委托号与成交号

- 委托号：`<stockId>-O<seq>`，例如 `600001-O42`。每只股票自己的序号，带股票前缀保证全局唯一。
- 成交号：`T<seq>-<orderId>-<qty>`，例如 `T9002-600001-O42-100`。
- 成交 `seq` 是**全服计数器**，跨股票单调递增，不是时间戳。

---

## 8. 幂等、重试与对账

### 8.1 为什么应该带 `clientOrderId`

网络超时、脚本重连、进程被 OOM 杀掉，都会让"已经下出去的单"被重发一次。
手动下单的代价是一单，程序化下单的代价会循环放大。

规则：

- 同一个 Key 下，同一个 `clientOrderId` 在 **10 分钟**内只成交一次。
- 重复提交**且参数一致**时返回首次结果 + `"replayed": true`，不会真的再下一单。
- 同 id **换了** `stockId` / `action` / `qty` / `price` / `finance` → **409** `idempotency_conflict`（多半是 id 生成器写错了，不要静默当作重试）。
- **只缓存成功**。冷却被拒、资金不足这类失败不缓存——冷却过去后同一个 id 能真正下出去。
- 缓存只在内存，服务重启后清空。
- 字段本身可选，但生产脚本请必带；不带时服务端不做幂等保护。

### 8.2 怎么生成 `clientOrderId`

推荐：`策略名-毫秒时间戳-决策序号`，例如：

```
ma-1792300000123-18422
grid-600001-1792300000456-7
```

不要用：

- 纯自增计数器（进程重启会归零，撞上上一轮的 id）；
- 随机数（重试时无法复用同一个 id）；
- 超过 64 位或包含非法字符（`[A-Za-z0-9._:-]` 之外）。

### 8.3 重试的正确姿势

| 情况 | 是否重试 | 怎么重试 |
|---|---|---|
| 连接超时 / 断网 | **是** | 同一个 `clientOrderId`，最多 3 次，指数退避 |
| 500 / 502 / 503 | **是** | 同上；503 `disabled` 除外（找运维） |
| 429 | **是** | 退避 1s→2s→4s…，并降低轮询频率 |
| 401 / 403 | **否** | Key 无效/无权限/白名单，重试没用 |
| 400 `rejected` | **看原因** | 冷却 → 等 `cooldownMs` 后用**同一个 id** 重试；其他规则拒绝 → 修参数 |
| 400 `bad_request` | **否** | 请求格式错，修代码 |
| 409 `idempotency_conflict` | **否** | 同 `clientOrderId` 换了下单参数；换一个新 id 或核对首次参数 |

关键：**规则拒绝（冷却、资金不足）不消耗幂等缓存**，所以可以安全地用同一个 id 重试。
但如果是"整手不对""价格越界"这种参数错误，重试多少次都一样。

### 8.4 启动对账

进程重启、断线重连、或者你不确定上一轮发生了什么时：

```
1. GET /open/v1/ping                    → 确认 Key、seq、冷却
2. GET /open/v1/account                 → 现金/持仓/在途委托
3. GET /open/v1/orders?status=all&since=<上次时间>
4. GET /open/v1/fills?since=<上次游标>
5. 用 3/4 的结果覆盖本地状态，再恢复交易
```

不要假设"本地记录就是服务端状态"。服务端才是权威。

---

## 9. 策略工程模式

### 9.1 轮询骨架（最稳，推荐入门）

```python
import json
import os
import time
import urllib.error
import urllib.request

BASE = os.environ.get("GUSHEN_BASE", "http://127.0.0.1:3000").rstrip("/")
KEY = os.environ["GUSHEN_API_KEY"]
POLL = 0.7          # 与 tick 同频
last_seq = -1
cursor = 0          # /fills 的 nextSince


def call(method, path, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"X-API-Key": KEY}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        payload = json.loads(e.read().decode())
        payload["_status"] = e.code
        return payload


def main():
    global last_seq, cursor
    meta = call("GET", "/open/v1/meta")
    lot = {s["id"]: s["lotSize"] for s in meta["stocks"]}
    rules = meta["rules"]

    while True:
        mk = call("GET", "/open/v1/markets?depth=1&trades=0")
        if not mk or not mk.get("ok"):
            time.sleep(2)
            continue
        if mk["seq"] == last_seq:          # 没有新 tick
            time.sleep(POLL)
            continue
        last_seq = mk["seq"]

        if not mk["day"].get("trading"):
            time.sleep(POLL)
            continue

        # 1) 先处理成交（增量），让本地持仓跟上
        f = call("GET", f"/open/v1/fills?since={cursor}")
        if f and f.get("ok"):
            for fill in f["fills"]:
                on_fill(fill)
            cursor = f["nextSince"]

        # 2) 再决策
        signal = strategy(mk, lot)
        if signal:
            place(signal, lot, rules)

        time.sleep(POLL)
```

### 9.2 SSE 骨架（tick 驱动）

```python
def stream_loop():
    global last_seq
    import urllib.request, json
    while True:
        try:
            req = urllib.request.Request(
                f"{BASE}/open/v1/stream?depth=1&trades=0",
                headers={"X-API-Key": KEY},
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                for raw in resp:
                    line = raw.decode().strip()
                    if not line.startswith("data: "):
                        continue
                    frame = json.loads(line[6:])
                    if frame["seq"] <= last_seq:
                        continue
                    last_seq = frame["seq"]
                    on_tick(frame)
        except Exception as e:
            log("stream 断开，2 秒后重连:", e)
            time.sleep(2)
```

SSE 的注意点：

- 不要在 `on_tick` 里做超过 700ms 的工作，否则会阻塞读流。
- 重连后用 `seq` 去重。
- SSE 不含账户，决策时再拉 `/account`。
- 如果只想跑一个简单策略，轮询更省心。

### 9.3 目标仓位模式（比"信号→下单"更稳）

不要直接根据"金叉/死叉"下单，而是先算**目标仓位**，再下单补差额：

```
目标股数 = f(信号, 权益, 价格)
当前股数 = long.qty
差额 = 目标股数 - 当前股数

差额 > 0 → buy_open（数量取整手）
差额 < 0 → sell_close（数量不超过 sellable）
差额 = 0 → 不动
```

好处：

- 重复信号不会重复下单；
- 部分成交后下一轮会自动补齐；
- 重启后只要重新算目标仓位，就能自愈。

注意：在途委托也算"预期仓位"，否则每轮都会重复下单。
简单做法：把 `orders` 里同方向的 `remain` 加进"当前仓位"再算差额。

### 9.4 下单前的检查清单

每次 `POST /orders` 之前，按顺序检查：

1. `day.trading === true`？
2. `day.locked === false`（如果要撤单）？
3. `cooldownLeftMs === 0`（或已经等够）？
4. `stockId` 在 `meta.stocks` 里？
5. `qty` 是正整数、开仓是 `lotSize` 整数倍？
6. `price` 两位小数、在 `band` 内、距 `last` 不超过 50%？
7. 方向是否与现有持仓/在途开仓冲突？
8. 买入：`cash >= price*qty*(1+feeRate)`（融资时 `*financeRatio`）？
9. 卖出：`qty <= long.sellable`？
10. 平空：`qty <= short.coverable`？
11. 开空：`qty <= lending.available`（券商可能更少）？
12. `clientOrderId` 是否是这一笔**新的、唯一的** id？

### 9.5 十个常见坑

| # | 坑 | 正确做法 |
|---|---|---|
| 1 | 用 `qty` 下 `sell_close` | 用 `long.sellable` |
| 2 | 用委托价当成本价 | 用 `/fills` 的 `price` 或 `long.cost` |
| 3 | 每 tick 下单 | 遵守 `cooldownMs`，基线上限 0.5 单/秒 |
| 4 | 金叉买入后死叉立刻卖 | 锁仓期内卖不掉，等 `sellable` |
| 5 | 持多时下 `sell_open` | 同股多空互斥，先平多 |
| 6 | 挂远价等成交 | 价格笼子 ±5%，远价单会被撤 |
| 7 | 用时间戳做成交游标 | 用 `/fills` 的 `nextSince` |
| 8 | 下单成功就认为成交 | 查 `/orders` / `/fills` |
| 9 | 429 后疯狂重试 | 指数退避 + 降频 |
| 10 | 把 Key 写进代码提交仓库 | 用环境变量 |

### 9.6 资金管理建议

- 单笔风险不超过权益的 1%–2%；
- 杠杆策略留 30% 以上的权益缓冲，不要贴着维持线；
- 开空要留券源和利息预算；
- 不要在收盘前 30 秒开新仓（来不及平，收盘作废）；
- 不要在集合竞价最后 10 秒下单（撤不掉，只能等集中撮合）。

---

## 10. 拒单原因精确对照

`detail.error` 是服务端原文。建议按**关键字**匹配，不要整句相等（数字会变）。

### 10.1 下单拒绝

| `error` 关键字 | 触发条件 | 处理 |
|---|---|---|
| `已停牌` | 全市场停牌 | 等复牌，读 `/meta` 的 `day.trading` 不够，需重试 |
| `当前.*暂停下单` | 午休 / 夜间 | 等 `day.trading` 为真 |
| `未知操作类型` | `action` 拼错 | 只用四种 action |
| `价格无效` | `price <= 0` 或非数字 | 检查参数 |
| `数量无效` | `qty <= 0` 或非数字 | 检查参数 |
| `开仓数量必须为 N 股的整数倍` | 开仓非整手 | `qty = lotSize * k` |
| `不接受本股票的新开仓` | 券商禁买名单（如天疯） | 换股票或换券商 |
| `价格超出涨跌停范围` | 超出 `band` | 夹到 `band.down ~ band.up` |
| `该股已有空头持仓` | 持空时 `buy_open` | 先 `buy_close` |
| `该股已有多头持仓` | 持多时 `sell_open` | 先 `sell_close` |
| `下单过于频繁` | 账户冷却 | 读 `detail.cooldownMs`，等待后同 id 重试 |
| `委托价偏离最新价` | 距 `last` 超 50% | 用最新价重算 |
| `融资买入未开放` | 配置关闭 | 不要用 `finance` |
| `保证金不足，无法融资买入` | 融资预检不过 | 降数量或补权益 |
| `可用资金不足` | 买入/平空现金不够 | 降数量 |
| `可用资金不足（卖出款不足以偿还融资负债）` | 卖出款不够还债 | 先补现金 |
| `可卖数量为 0` | 全部锁仓/挂借 | 等解锁或撤借 |
| `可卖数量不足，当前可卖 N 股` | 数量超过 `sellable` | 用返回的 N |
| `融券做空未开放` | 配置关闭 | 不要开空 |
| `可借券源不足，当前可借 N 股` | 券池不足 | 用返回的 N，或等别人挂借 |
| `保证金不足，无法继续开空` | 开空预检不过 | 降数量 |
| `空头持仓不足` | 平空数量超过 `coverable` | 用 `coverable` |
| `可用资金不足（平空需支付买入款）` | 平空现金不够 | 降数量 |
| `指数不可交易` | `stockId=999999` | 指数只观察 |
| `未知股票` | `stockId` 不在 `meta.stocks` | 用代码，不用名称 |
| `价格或数量无效` | 非有限数字 | 检查 JSON 类型 |
| `缺少 stockId` | 未传 `stockId` | 必填 |

### 10.2 撤单拒绝

| `error` | 处理 |
|---|---|
| `委托不存在或已完结` | 委托号错了，或已成交/已撤 |
| `委托已完结` | 刷新 `/orders` |
| `集合竞价已锁定，不可撤单（等待开盘集中撮合）` | 等 `day.locked` 变 `false` |

### 10.3 鉴权/限流错误

| `error` | HTTP | 处理 |
|---|---|---|
| `缺少 API Key（请求头 X-API-Key 或 Authorization: Bearer）` | 401 | 加请求头 |
| `API Key 格式不正确` | 401 | 检查 `gs_<id>_<secret>` |
| `API Key 无效或已撤销` | 401 | 回开放平台页重新生成（明文不存库，无法找回） |
| `该 Key 只允许从 X 调用` | 403 | 换网络，或找运维去掉 IP 白名单（§3.3） |
| `该 Key 没有 trade 权限` | 403 | 重新生成一把带 `trade` 的 |
| `该 Key 绑定的账户不存在` | 401 | 账号被删/改名，重新生成 |
| `请求过于频繁，请降低轮询频率或加长间隔` | 429 | 退避 + 降频 |
| `单个 Key 最多 2 条推送连接` | 429 | 关掉多余 SSE |
| `推送连接数已达上限` | 503 | 改用轮询 |
| `开放接口未启用（config.open.enabled = false）` | 503 | 找运维 |

### 10.4 为什么"下单成功但没成交"

这不是错误，是正常的市场行为：

- 你的限价没有碰到对手价 → 挂在簿上等；
- 盘口很薄，你的单排在后面；
- 集合竞价阶段只入簿，等阶段结束才撮合；
- 收盘了，未成交委托被作废。

排查顺序：

1. `GET /orders?status=live` 看还在不在；
2. `GET /orders?status=all` 看状态是不是 `canceled`；
3. `GET /fills?since=<cursor>` 看有没有部分成交；
4. 看 `markets[].depth` 对手价，确认你的价格能不能成交；
5. 看 `day.phase`，确认不是竞价/休市。

---

## 11. 完整示例解读

仓库里有三个示例：

| 文件 | 用途 | 依赖 |
|---|---|---|
| `Server/examples/quant_ma.py` | 双均线策略，演示轮询、冷却、幂等、整手、可卖量 | 仅标准库 |
| `Server/examples/quant_template.py` | 策略骨架，带 Client 封装、对账、风控、目标仓位 | 仅标准库 |
| `Server/examples/quant_rotation.py` | 多股票动量轮动，演示选股、换股、止损禁入、补仓阻尼 | 仅标准库 |

### 11.1 `quant_rotation.py` 的关键逻辑

另外两个示例都只做一只票。这个示例回答"怎么在 10 只票里选"：

```python
# 1) 一个读请求拿全市场（不要逐票拉：读配额 240 次/分钟，10 只票逐票轮询会打爆）
mk = cli.markets(depth=1, trades=0)

# 2) 每只票打分 = 短窗涨速 + 当日涨幅 + 主动买占比；只用站上短均线、
#    离涨跌停还有空间的票（贴着涨停买不到，贴着跌停是接刀）
score = W_ROC * roc(LOOKBACK) + W_DAY * changePct + W_FLOW * (outerPct - 50) / 10

# 3) 持仓股排名加 REPLACE_BONUS：没有这个阻尼，榜单稍微抖一下就会来回换手，
#    而每次换手要付两趟手续费 + 两轮冷却
target = top_n(scored, bonus_if_holding=REPLACE_BONUS)

# 4) 目标仓位模式：算"该持多少"再补差额，部分成交/重启都能自愈
gap = win - (long.qty + 在途买 - 在途卖)
```

三个容易踩的点，示例里都处理了：

- **补仓阻尼**（`MIN_GAP_PCT`）：按最新价重算目标股数时，价格抖一点就会算出"差 1 手"，为这 1 手付一次 2 秒冷却不划算。
- **止损禁入**（`STOP_OUT_SEC`）：止损卖掉后分数往往还很高，下一 tick 会原价买回来，白交两趟手续费。
- **买卖不打架**：同一只票有在途买单时不发卖单（先撤），有在途卖单时不发买单。§6.13 说系统会撤掉你自己的旧挂单，但那是兜底，不该依赖。

跑法：把文件顶部「直接改这里」的 `API_KEY` / `BASE_URL` / `DRY_RUN_DEFAULT` 三行填上，直接 `python Server/examples/quant_rotation.py`（环境变量 `GUSHEN_API_KEY` / `GUSHEN_BASE` / `DRY_RUN` 仍然优先，换机器时不用改代码）；`TOP_N` / `POSITION_PCT` / `LOOKBACK` / `ENTRY_SCORE` 等调参项走环境变量，文件头有全套默认值。**Key 写进代码后别再把这个文件提交到 git 或发给别人。**

### 11.2 `quant_ma.py` 的关键逻辑

```python
# 1) 用 seq 判断新 tick
mk = call("GET", "/open/v1/markets?depth=1&trades=0")
if mk["seq"] == last_seq:
    time.sleep(POLL_MS / 1000)
    continue
last_seq = mk["seq"]

# 2) 时段门控
if not mk["day"].get("trading"):
    continue

# 3) 用分时序列算指标
hist = call("GET", f"/open/v1/markets/{STOCK}/minute")
prices = [p["price"] for p in hist["priceHistory"]]
fast, slow = ma(prices, 5), ma(prices, 20)

# 4) 冷却
if now < cooldown_until:
    time.sleep((cooldown_until - now) / 1000)
    continue

# 5) 用 sellable，不是 qty
acct = call("GET", "/open/v1/account")
pos = next((p for p in acct["positions"] if p["stockId"] == STOCK), None)
sellable = pos["long"]["sellable"] if pos else 0

# 6) 贴着对手价下单
px = row["depth"]["asks"][0]["price"] if body["action"] == "buy_open" else row["depth"]["bids"][0]["price"]

# 7) 幂等键 + 冷却回包
body["clientOrderId"] = "ma-%d-%d" % (int(time.time() * 1000), mk["seq"])
res = call("POST", "/open/v1/orders", body)
cooldown_until = time.time() * 1000 + res.get("cooldownLeftMs", meta["rules"]["cooldownMs"])
```

它刻意**没有**做的事：

- 不做仓位管理（每次固定 1 手）；
- 不做止损；
- 不处理部分成交；
- 不做重启对账。

这些留给 `quant_template.py`。

### 11.3 `quant_template.py` 的结构

```
Config         环境变量：BASE / KEY / STOCK / 仓位比例
Client         HTTP 封装：鉴权、429 退避、JSON 解析
Client.get_meta() / get_markets() / get_account() / get_fills()
Client.place() 带 clientOrderId、冷却等待、拒单分类
Strategy        compute_target_qty()：你要改的唯一函数
Engine         reconcile() 启动对账
               step() 每个 tick：拉行情 → 处理成交 → 算目标 → 补差额
```

跑法：

```bash
export GUSHEN_API_KEY='gs_...'
python Server/examples/quant_template.py
```

它默认只读 + 模拟（`DRY_RUN=1`），确认信号合理后再设 `DRY_RUN=0` 真下单。

---

## 12. 给 AI 的施工说明（可直接粘贴）

下面这段可以原样贴给帮你写策略的 AI。它把"必须遵守的契约"压缩成了可执行的约束。

```text
你在为「我是股神」模拟盘写量化策略。策略跑在本地，只能通过 HTTP 调用
http://<服务器地址>:3000/open/v1/*，鉴权头 X-API-Key: gs_...（从环境变量
GUSHEN_API_KEY 读，绝不要写进代码）。

前提：玩家已经在开放平台页（`/portal.html`）自己生成过 Key，知道服务器地址。
如果环境变量是空的，先让玩家去生成，不要自己猜地址、不要尝试免登录接口。

必须遵守的契约：
1. 启动先 GET /meta，缓存 stocks（id -> lotSize）和 rules（feeRate/cooldownMs/
   lockMs/marginRatio/maintenance/financeRatio/priceLimit）。不要硬编码这些数字。
2. 主循环按 seq 去重：GET /markets 的 seq 没变就跳过。轮询间隔 >= 700ms。
   读接口限额 240 次/分钟/Key，交易接口 60 次/分钟/Key；429 要指数退避并降频。
3. 开仓 qty 必须是 lotSize 的整数倍；平多 qty <= positions[].long.sellable；
   平空 qty <= positions[].short.coverable。不要用 qty 判断可卖。
4. 下单必须带 clientOrderId（1-64 位 [A-Za-z0-9._:-]，全局唯一，重试复用同一个）。
   同一 Key 同 id 10 分钟内只成交一次；失败不缓存，所以冷却后可以同 id 重试。
5. 下单前检查：day.trading 为 true；同股方向不冲突（持多不能 sell_open，
   持空不能 buy_open，含在途开仓单）；price 在 band.up/band.down 之间且距 last
   不超过 50%；qty/价格为正。
6. 下单后用回包的 cooldownLeftMs 等待，不要按 rules.cooldownMs 盲等。
7. 成交用 GET /fills?since=<nextSince> 增量拉取；seq 是成交序号不是时间戳；
   处理完所有 fills 再持久化 nextSince。每账户只保留最近 100 笔成交，别长时间不拉。
8. 成交价 = 被动方挂单价，不等于委托价。下单成功不等于成交，必须用 /orders 和
   /fills 确认；可能部分成交（status 仍是 live，filled>0）。
9. 同一只股票只能持一个方向；换向要先撤反向开仓单、再平仓。
10. 一个游戏日 620 秒，收盘时所有未成交委托作废；没有隔夜挂单。
11. 量化没有交易特权：冷却、费率、锁仓、限流与手动完全一致。
12. 不要请求 fairValue/fund/regime/force/intent/llmPlan 这类字段——服务端不提供，
    也不要用高频报价反推。

输出要求：
- Python 3.8+，优先标准库（urllib），不要引入第三方依赖；
- 结构：Config / Client / Strategy / Engine；
- 必须有：启动对账、429 退避、冷却等待、拒单日志、优雅退出（Ctrl+C）；
- 策略逻辑单独一个函数 compute_target_qty(market, account, meta)，方便替换；
- 默认 DRY_RUN=1 只打印不下单，确认后 DRY_RUN=0。
```

### 12.1 AI 自检清单

让 AI 交代码前，逐条问：

- [ ] 有没有把 `lotSize` 写死？
- [ ] 有没有用 `qty` 而不是 `sellable` 下卖单？
- [ ] 有没有在冷却期内连续下单？
- [ ] 有没有用时间戳而不是 `seq` 去重？
- [ ] 有没有用时间戳而不是 `nextSince` 做成交游标？
- [ ] 下单失败后有没有换 `clientOrderId` 重试？
- [ ] 有没有处理 429？
- [ ] 有没有处理部分成交？
- [ ] 有没有在 `day.trading=false` 时下单？
- [ ] 有没有把 Key 打进日志/代码？

### 12.2 最小可运行代码（复制即用）

```python
"""最小策略骨架：读行情 -> 打印，不下单。"""
import json
import os
import time
import urllib.request

BASE = os.environ.get("GUSHEN_BASE", "http://127.0.0.1:3000").rstrip("/")
KEY = os.environ["GUSHEN_API_KEY"]


def call(path):
    req = urllib.request.Request(BASE + path, headers={"X-API-Key": KEY})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


meta = call("/open/v1/meta")
print("账户规则:", meta["rules"])
last = -1
while True:
    mk = call("/open/v1/markets?depth=1&trades=0")
    if mk["seq"] != last:
        last = mk["seq"]
        for m in mk["markets"]:
            print(m["stockId"], m["last"], m["changePct"], "trading=", mk["day"]["trading"])
    time.sleep(0.7)
```

---

## 13. 运维与安全

### 13.1 Key 的签发与代管（运维）

**常规路径不需要你操作。** 玩家登录游戏 → 主页「开放接口」→ 自己生成，明文只出现在他自己的浏览器里，
你连看都看不到。这一步走的是 `/api/open/keys`（会话令牌鉴权），服务端会记日志：

```
[我是股神][open] 自助签发 3f2a9c1e → quant_a（read,trade，家用电脑-双均线）
```

你只需要在三种情况介入：

| 情况 | 用什么 |
|---|---|
| 玩家要**锁定来源 IP**（网页不支持） | `openkey.py issue --ip` |
| 玩家忘了自己有哪些 Key、要你帮查 | `openkey.py list <账号>` |
| 玩家号被盗/泄露，需要你立刻掐断 | `openkey.py revoke <KeyID>`，或让玩家自己在页面点撤销 |

```bash
cd Server

# 代发（--base 填玩家能访问到的地址，不要填 127.0.0.1）
python openkey.py issue quant_a --label "双均线-600001" --scopes read,trade \
  --base http://1.2.3.4:3000 --handout

# 锁定来源（云服务器推荐；家宽别填，IP 会变）
python openkey.py issue quant_c --label "云主机" --ip 1.2.3.4 --handout --base http://1.2.3.4:3000

# 查：默认只列**有效** Key（含最近使用时间）
python openkey.py list
python openkey.py list quant_a
python openkey.py list quant_a --all    # 连已撤销的一起列，查历史

# 撤销（立即生效，不可恢复）
python openkey.py revoke 3f2a9c1e
```

`--handout` 会额外打印一段形如 `【我是股神 · 开放接口凭据】…` 的文本，直接复制进私聊即可。
不带 `--handout` 时只打印 KeyID 和 Key，适合你自己调试用。

**代发失败时的文案**（原文照抄，方便你对表）：

| 文案 | 原因 |
|---|---|
| `账户不存在（先用游戏登录一次建号）` | 账号名写错，或玩家报的是昵称 |
| `该账号还没走完开户（缺昵称或券商），先进游戏开完户` | 没选券商 / 没设昵称 |
| `单账户最多 8 把有效 Key，请先撤销不用的` | 到上限，先清理 |

**台账建议**：`--label` 写成"策略名-标的"（如 `网格-600001`），玩家说"我的网格停了"你能一眼定位。
每季度 `python openkey.py list` 扫一遍「最近使用」，超过三个月没调用的撤销掉，避免 8 把上限被占满。

**玩家侧步骤**见 [玩家申请APIKey.md](./玩家申请APIKey.md)（已改为网页自助，不含运维命令）。

### 13.2 服务端配置

`Server/src/config.js` 的 `open` 段：

```js
open: {
  enabled: true,                 // 总开关，false 时所有 /open 返回 503
  rateLimit: {
    enabled: true,
    read:  { limit: 240, windowMs: 60000 },
    trade: { limit: 60,  windowMs: 60000 },
    ip:    { limit: 1200, windowMs: 60000 },
  },
  idempotency: { ttlMs: 10 * 60 * 1000, max: 2000 },
  maxKeysPerAccount: 8,
  maxStreamsPerKey: 2,
  maxStreams: 100,
  maxTrades: 30,
  maxDepth: 5,
}
```

改完配置需要重启服务。

### 13.3 日志

- 路径：`Server/log/server.YYYY-MM-DD.log`
- 前缀：`[我是股神][open]`
- 内容：KeyID（不是 secret）、账号、动作、标的、数量、价格、委托号、结果。
- 拒单也会记：`... 被拒：<原因>`。

排查"策略到底下了什么"时，先看这个日志，再看 `/orders?status=all`。

### 13.4 Key 泄露怎么办

**玩家报"我的 Key 可能泄露了"** 时按这个顺序做，1 分钟内能止血：

1. 让玩家**自己在开放平台页点撤销**（最快，不用等你回消息）；他不在线才由你
   `python openkey.py revoke <KeyID>` —— 立即生效，下一毫秒就 `401`；
2. 玩家回页面重新生成一把，备注写「原备注-补发」；如果他要锁 IP，你代发；
3. 看 `Server/log/server.YYYY-MM-DD.log` 里该账号的 `[open]` 行，确认有没有非本人的下单；
4. 有异常成交就告诉玩家实际情况：**已成交的单不会回滚**，撤销只挡后续调用。

`lastUsedAt` 是排查泄露的主要线索：玩家说"我这两天没跑策略"，但页面上「最近使用」显示今天，
基本可以确认泄露。

### 13.5 Key 不要出现在哪里

- 不要提交到 Git；
- 不要打印在日志里（只打 `keyId`）；
- 不要写进前端页面（浏览器 F12 就能看到）；
- 不要发给别人（它等于你的账户操作权）；
- 不要发在群里、不要截图——这是实际发生最多的泄露方式。

---

## 14. FAQ

**Q：我没有 Key，去哪拿？**
A：登录游戏 → 主页点「**开放接口**」→ 填备注、选权限 → 点「生成 Key」。
弹层里的 `gs_...` 只显示这一次，复制后马上存进环境变量。
完整步骤见 [玩家申请APIKey.md](./玩家申请APIKey.md)；生成前必须已经开完户（有昵称 + 券商）。

**Q：Key 丢了能找回吗？**
A：不能。服务端只存 `sha256`，任何人都看不到明文（包括运维）。
回页面撤销那把旧的、重新生成一把即可，撤销立即生效。

**Q：能不能用市价单？**
A：不能。v1 只支持限价单。想"立刻成交"，把价格贴到对手价（买用卖一，卖用买一）。

**Q：能不能高频交易？**
A：冷却按账户算，基线上限 0.5 单/秒（滑泰 2 单/秒）。tick 是 700ms，比这更快的请求没有意义。
量化没有特殊通道。

**Q：为什么我的买单挂出去一直不成交？**
A：限价没碰到对手价，或排在队尾。看 `depth.asks[0].price`，买价至少要到卖一；
或者接受排队等。

**Q：为什么卖不掉？**
A：锁仓（T+10 秒）、在途平仓单占用、或已挂借。看 `long.sellable` / `lots[].sellable`。

**Q：为什么开空被拒？**
A：券源不足（看 `lending.available`），或保证金不足，或持有多头（同股多空互斥）。

**Q：为什么收盘后委托不见了？**
A：日终结算会撤掉所有未成交委托，这是设计行为，不是丢单。

**Q：重启服务后 Key 还在吗？**
A：在。Key 存数据库，重启后自动加载。但幂等缓存会清空。

**Q：成交回报会重复吗？**
A：用 `since=nextSince` 不会重复。若你在重连后从头拉，可能拿到旧成交，按 `seq` 去重。

**Q：能不能同时跑多个策略？**
A：可以，但同一账户共享冷却、限流和资金。建议一个账户一个策略，或者策略之间自己做协调。
单账号最多 8 把 Key。

**Q：能不能用浏览器直接调？**
A：可以，CORS 已开。但把 Key 放在浏览器里等于公开，生产策略请放服务端。

**Q：为什么 `seq` 有时跳很多？**
A：服务端每 tick +1；你两次请求之间可能过了多个 tick。`seq` 只用于判断"有没有新数据"，
不要假设它连续。

**Q：`/fills` 最多返回多少？**
A：`limit` 最大 100；账户内存里也只保留最近 100 笔。高频策略要勤拉。

**Q：能不能查别人的持仓/成交？**
A：不能。Key 绑定一个账号，所有账户类接口只返回自己的数据。

**Q：能不能改昵称、转户、加钱、挂借？**
A：v1 开放接口不提供这些。它们只在网页端有。

---

## 15. 附录

### 15.1 端点速查

| 方法 | 路径 | scope | 用途 |
|---|---|---|---|
| GET | `/open/v1` | read | 能力目录 |
| GET | `/open/v1/health` | 无 | 存活探针 |
| GET | `/open/v1/ping` | read | 鉴权自检 + 冷却 |
| GET | `/open/v1/meta` | read | 标的 + 规则 + 交易日 |
| GET | `/open/v1/markets` | read | 全市场行情 |
| GET | `/open/v1/markets/:id/bars` | read | 已收盘日线 |
| GET | `/open/v1/markets/:id/minute` | read | 分时序列 |
| GET | `/open/v1/markets/:id/holders` | read | 筹码概览 |
| GET | `/open/v1/account` | read | 账户快照 |
| GET | `/open/v1/orders` | read | 委托查询 |
| POST | `/open/v1/orders` | **trade** | 下单 |
| DELETE | `/open/v1/orders/:id` | **trade** | 撤单 |
| GET | `/open/v1/fills` | read | 成交回报 |
| GET | `/open/v1/stream` | read | SSE 行情流 |

### 15.2 字段单位速查

| 字段 | 单位 | 注意 |
|---|---|---|
| `serverTime` / `ts` / `t` / `lockedUntil` | 毫秒时间戳 | 不是秒 |
| `cash` / `equity` / `price` / `turnover` | 元 | 两位小数 |
| `qty` / `volume` / `sellable` / `coverable` | 股 | 整数 |
| `feeRate` | 小数 | 0.0001 = 0.01% |
| `changePct` / `marginUsage` / `utilization` / `outerPct` | 百分数 | 2.5 = 2.5% |
| `priceLimit.pct` | 百分数 | 30 = ±30% |
| `finance.baseMinuteRate` | 小数/分钟 | 0.0001 = 0.01%/分钟 |
| `lending.dailyRate` | 百分数/**日** | 0.1 = 0.1%/日（按游戏日结算） |
| `cooldownMs` / `lockMs` / `phaseLeftMs` | 毫秒 | — |
| `seq` | 整数 | 行情序号或成交序号，看上下文 |

### 15.3 交易规则数值（基准，实际以 `/meta` 为准）

| 项 | 值 |
|---|---|
| 撮合间隔 | 700ms |
| 一个游戏日 | 620s |
| 初始资金 | 1,000,000 元 |
| 手续费 | 万分之一（0.0001） |
| 下单冷却 | 2000ms |
| 买入锁仓 | 10000ms |
| 涨跌停 | ±30%（相对昨收） |
| 委托价偏离上限 | ±50%（相对最新价） |
| 价格笼子 | ±5%（相对上一笔成交价） |
| 开空保证金 | 50% |
| 维持保证金 | 30% |
| 融资自备 | 50%（2 倍） |
| 融资利率 | 0.01%/分钟 起，封顶 0.04%/分钟 |
| 融券利率 | 0.1%/日 起，封顶 0.4%/日（**每个游戏日结算一次**，收盘扣） |
| 单账户 Key 上限 | 8 |
| 单 Key SSE 上限 | 2 |
| 读配额 | 240 次/分钟/Key |
| 交易配额 | 60 次/分钟/Key |
| IP 兜底 | 1200 次/分钟/IP |

### 15.4 最小 curl 验收脚本

```bash
BASE=http://127.0.0.1:3000
KEY=gs_xxx_yyy

curl -s $BASE/open/v1/health
curl -s -H "X-API-Key: $KEY" $BASE/open/v1/ping
curl -s -H "X-API-Key: $KEY" $BASE/open/v1/meta
curl -s -H "X-API-Key: $KEY" "$BASE/open/v1/markets?depth=1&trades=1"
curl -s -H "X-API-Key: $KEY" $BASE/open/v1/account
curl -s -H "X-API-Key: $KEY" "$BASE/open/v1/orders?status=all"
curl -s -H "X-API-Key: $KEY" "$BASE/open/v1/fills?since=0&limit=10"
```

全部返回 `"ok": true`（或至少不是 401/403），说明链路通了。

### 15.5 版本与兼容

- 当前版本：`v1`。
- 路径带版本号；未来不兼容的改动会走 `/open/v2`，`v1` 保留一段时间。
- 新增字段是兼容的（客户端应忽略不认识的字段）。
- 字段改名/删除会提前在文档里标注。

### 15.6 变更记录

- **2026-10-18**：v1 上线。
  - 独立 API Key 鉴权、幂等下单、成交序号游标、SSE 行情流。
  - 10 只股票 + 指数、四种 action、融资/融券、涨跌停、集合竞价、价格笼子。
- **2026-10-18（文档 v1.1）**：补全所有字段与单位、精确拒单文案、交易日时间表、
  AI 施工说明与完整示例；修正 `stockId` 只接受代码、`holders` 是筹码概览、
  `broker` 是对象等易错点。
- **2026-10-18（成交序号修正）**：`/fills` 的 `seq` 从"每只股票各自编号"改为
  **全服跨股票单调**（重启后从存档最大值继续），避免多股票账户用 `since` 漏成交。
- **2026-10-19（幂等加固 + 文档上网页）**：
  - 同 `clientOrderId` 换了下单参数 → **409** `idempotency_conflict`（不再静默回放）。
  - 撤销 Key 会主动断开该 Key 的 SSE 连接。
  - 文档可在网页阅读与下载：`/docs.html?doc=player|api`，或直接 `/docs/player-apikey.md`、`/docs/openapi.md`（`?download=1` 附件）。

---

**需要更多帮助？**

- 先看 `GET /open/v1` 的端点目录；
- 再看服务端日志 `Server/log/server.*.log` 里的 `[我是股神][open]`；
- 接口行为以服务端实际响应为准，本文档随代码更新。
