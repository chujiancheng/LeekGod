"""
开放接口策略骨架（只依赖标准库）

和 quant_ma.py 的区别：这个文件不是"演示一个信号"，而是把**能长期跑**的骨架搭好：

  ① Client       统一处理鉴权、429 退避、网络重试、JSON 解析
  ② reconcile    启动时用服务端状态覆盖本地，不假设自己的记录是对的
  ③ 目标仓位     先算"应该持多少"，再补差额；重复信号不会重复下单，部分成交会自动补齐
  ④ 在途委托     把未成交的 buy_open / sell_close 也算进"预期仓位"，避免每 tick 重复下单
  ⑤ 成交游标     只拉增量，处理完再持久化 cursor
  ⑥ 风控         时段、冷却、整手、可卖量、涨跌停、同股方向
  ⑦ DRY_RUN      默认只打印不下单，确认信号合理后再打开

用法：
    set GUSHEN_API_KEY=gs_xxxxxxxx_yyyyyyyyyyyyyyyy
    set GUSHEN_BASE=http://127.0.0.1:3000        （可选）
    set GUSHEN_STOCK=600001                       （可选）
    set DRY_RUN=1                                 （1=只打印，0=真下单）
    python examples/quant_template.py

你只需要改 `compute_target_qty()` 这一个函数。其余部分可以原样保留。

注意：这是**模板**，不是盈利策略。双均线在这里只是占位，别直接拿去实盘（这本来就
是模拟盘）。真正要改的是信号、仓位比例和止损。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import deque

# ============================================================
# 配置
# ============================================================
BASE = os.environ.get("GUSHEN_BASE", "http://127.0.0.1:3000").rstrip("/")
KEY = os.environ.get("GUSHEN_API_KEY", "").strip()
STOCK = os.environ.get("GUSHEN_STOCK", "600001").strip()
DRY_RUN = os.environ.get("DRY_RUN", "1") != "0"

POLL_SEC = 0.7          # 与 tick 同频；更密没有意义
ACCOUNT_EVERY_SEC = 5   # 账户快照的刷新间隔（不要每 tick 都拉，省读配额）
POSITION_PCT = 0.5      # 目标仓位占权益的比例（0.5 = 半仓）
FAST, SLOW = 5, 20      # 均线窗口（按 tick 点）
MAX_RETRY = 3


def log(*args):
    print(time.strftime("[%H:%M:%S]"), *args, flush=True)


class ApiError(Exception):
    pass


# ============================================================
# HTTP 客户端
# ============================================================
class Client:
    def __init__(self, base, key):
        self.base = base
        self.key = key

    def _once(self, method, path, body=None, timeout=10):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"X-API-Key": self.key}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, {"ok": False, "error": "HTTP %s: %s" % (e.code, raw[:200])}

    def call(self, method, path, body=None):
        """
        返回 dict。网络错误 / 429 会重试；4xx 业务错误直接返回（带 _status）。

        重试是安全的：下单带 clientOrderId，服务端 10 分钟内同 id 只成交一次。
        """
        last = None
        for attempt in range(MAX_RETRY + 1):
            try:
                status, data = self._once(method, path, body)
            except Exception as e:            # URLError / timeout / 连接被重置
                last = {"ok": False, "error": "网络错误: %s" % e, "_status": 0}
                if attempt < MAX_RETRY:
                    wait = min(8.0, (2 ** attempt) + 0.2)
                    log("网络错误，%.1fs 后重试（%d/%d）：%s" % (wait, attempt + 1, MAX_RETRY, e))
                    time.sleep(wait)
                    continue
                return last

            data["_status"] = status
            if status == 429:
                wait = min(30.0, (2 ** attempt) + 0.2)
                log("被限流（429），%.1fs 后重试（%d/%d）" % (wait, attempt + 1, MAX_RETRY))
                time.sleep(wait)
                last = data
                continue
            if status >= 500 and status != 503:
                if attempt < MAX_RETRY:
                    wait = min(8.0, (2 ** attempt) + 0.2)
                    log("服务端 %d，%.1fs 后重试" % (status, wait))
                    time.sleep(wait)
                    last = data
                    continue
            return data
        return last or {"ok": False, "error": "重试次数用尽", "_status": 0}

    # ---- 便捷方法 ----
    def meta(self):
        return self.call("GET", "/open/v1/meta")

    def markets(self, depth=1, trades=0):
        return self.call("GET", "/open/v1/markets?depth=%d&trades=%d" % (depth, trades))

    def account(self):
        return self.call("GET", "/open/v1/account")

    def orders(self, status="live"):
        return self.call("GET", "/open/v1/orders?status=%s" % status)

    def fills(self, since):
        return self.call("GET", "/open/v1/fills?since=%d&limit=100" % since)

    def minute(self, stock):
        return self.call("GET", "/open/v1/markets/%s/minute" % stock)

    def place(self, stock, action, qty, price, client_order_id, finance=False):
        body = {
            "stockId": stock,
            "action": action,
            "qty": qty,
            "price": round(float(price), 2),
            "clientOrderId": client_order_id,
        }
        if finance:
            body["finance"] = True
        return self.call("POST", "/open/v1/orders", body)

    def cancel(self, order_id):
        return self.call("DELETE", "/open/v1/orders/%s" % order_id)


# ============================================================
# 策略：你只需要改这里
# ============================================================
def compute_target_qty(prices, equity, last, lot):
    """
    返回目标持股数（0 表示空仓）。

    输入：
      prices  最近若干个 tick 的最新价（deque，新的在右）
      equity  账户总权益
      last    最新价
      lot     一手股数

    当前实现：MA5 上穿 MA20 满目标仓位，下穿清仓。
    这只是占位示例——换成你自己的模型即可。
    """
    if len(prices) < SLOW:
        return 0
    vals = list(prices)
    fast = sum(vals[-FAST:]) / FAST
    slow = sum(vals[-SLOW:]) / SLOW
    if fast <= slow or last <= 0:
        return 0
    budget = equity * POSITION_PCT
    lots = int(budget // (last * lot))
    return max(0, lots) * lot


# ============================================================
# 引擎
# ============================================================
class Engine:
    def __init__(self, cli, stock):
        self.cli = cli
        self.stock = stock
        self.meta = None
        self.lot = 100
        self.rules = {}
        self.prices = deque(maxlen=max(SLOW * 3, 200))
        self.last_seq = -1
        self.cursor = 0
        self.account = None
        self.account_at = 0.0
        self.cooldown_until = 0.0
        self.pending_cid = None      # 上一笔下单的幂等键（仅用于日志）
        self.fills_total = 0
        self.dry_position = 0        # DRY_RUN 下的虚拟持仓，避免每 tick 重复打印同一笔

    # ---- 启动对账 ----
    def reconcile(self):
        meta = self.cli.meta()
        if not meta.get("ok"):
            raise ApiError("GET /meta 失败：%s" % meta.get("error"))
        self.meta = meta
        self.rules = meta["rules"]
        stocks = {s["id"]: s for s in meta["stocks"]}
        if self.stock not in stocks:
            raise ApiError("标的 %s 不在 meta.stocks 里，可选：%s" % (self.stock, ", ".join(stocks)))
        self.lot = stocks[self.stock]["lotSize"]

        # 分时序列做种子，避免冷启动时均线算不出来
        hist = self.cli.minute(self.stock)
        if hist.get("ok"):
            for p in hist["priceHistory"][-200:]:
                self.prices.append(p["price"])

        # 账户是权威状态：现金、持仓、在途委托都以它为准
        self._refresh_account(force=True)

        # 成交游标从"当前最新"开始，不重放历史成交
        f = self.cli.fills(0)
        if f.get("ok"):
            self.cursor = f.get("nextSince", 0)
        # 游标与账户快照之间可能有极短的竞态，再拉一次账户，确保起点一致
        self._refresh_account(force=True)

        ping = self.cli.call("GET", "/open/v1/ping")
        log("已连接 %s（Key %s），标的 %s（%s），一手 %d 股" % (
            ping.get("account", "?"), ping.get("keyId", "?"),
            self.stock, stocks[self.stock]["name"], self.lot))
        log("规则：冷却 %dms / 锁仓 %dms / 费率 %.5f / 涨跌停 %s%%" % (
            self.rules["cooldownMs"], self.rules["lockMs"], self.rules["feeRate"],
            self.rules["priceLimit"].get("pct")))
        log("DRY_RUN=%s，仓位比例 %.0f%%，成交游标 %d" % (
            "开" if DRY_RUN else "关", POSITION_PCT * 100, self.cursor))

    def _refresh_account(self, force=False):
        now = time.time()
        if not force and now - self.account_at < ACCOUNT_EVERY_SEC:
            return
        a = self.cli.account()
        if a.get("ok"):
            self.account = a
            self.account_at = now
            self.cooldown_until = now + (a.get("cooldownLeftMs", 0) / 1000.0)
        elif a.get("_status") in (401, 403):
            raise ApiError("鉴权失败：%s" % a.get("error"))

    def _position(self):
        if not self.account:
            return 0, 0, 0
        for p in self.account.get("positions", []):
            if p["stockId"] == self.stock:
                return p["long"]["qty"], p["long"]["sellable"], p["short"]["qty"]
        return 0, 0, 0

    def _pending(self):
        """在途开仓/平仓数量：算"预期仓位"时必须带上，否则会重复下单。"""
        buy = sell = 0
        for o in (self.account or {}).get("orders", []):
            if o["stockId"] != self.stock or o["status"] != "live":
                continue
            remain = max(0, o["qty"] - o["filled"])
            if o["action"] == "buy_open":
                buy += remain
            elif o["action"] == "sell_close":
                sell += remain
        return buy, sell

    def _on_fill(self, f):
        self.fills_total += 1
        log("成交 #%d %s %s %d@%.2f（委托 %s）" % (
            f["seq"], f["stockId"], f["action"], f["qty"], f["price"], f["orderId"]))
        # 成交后账户状态变了，标记为需要刷新（一次拉多笔，不逐笔打接口）
        self.account_at = 0.0

    def _drain_fills(self):
        f = self.cli.fills(self.cursor)
        if not f.get("ok"):
            return
        got = False
        for item in f.get("fills", []):
            # 防御：服务端偶尔可能在游标边界重复给同一笔
            if item["seq"] > self.cursor:
                self._on_fill(item)
                got = True
        # 全部处理完再推进游标：中途崩溃最多重放，不会漏单
        self.cursor = f.get("nextSince", self.cursor)
        if got:
            self._refresh_account(force=True)

    def _pick_price(self, row, side):
        """贴对手价：买用卖一，卖用买一；盘口空就退回最新价。"""
        depth = row.get("depth") or {}
        levels = depth.get("asks" if side == "buy" else "bids") or []
        px = levels[0]["price"] if levels else row["last"]
        # 夹到涨跌停内，避免因为行情抖动被判越界
        band = row.get("band")
        if band:
            px = min(band["up"], max(band["down"], px))
        return round(px, 2)

    def _target_qty(self):
        equity = (self.account or {}).get("equity", 0)
        last = self.prices[-1] if self.prices else 0
        return compute_target_qty(self.prices, equity, last, self.lot)

    def _maybe_trade(self, row):
        if not row:
            return
        long_qty, sellable, short_qty = self._position()
        pending_buy, pending_sell = self._pending()
        projected = long_qty + pending_buy - pending_sell + self.dry_position
        target = self._target_qty()
        gap = target - projected

        # 同股多空互斥：有空头时不要开多
        if short_qty > 0 and gap > 0:
            return

        # 冷却中：等到期，不发请求
        now = time.time()
        if now < self.cooldown_until:
            return

        if gap >= self.lot:
            qty = int(gap // self.lot) * self.lot
            price = self._pick_price(row, "buy")
            # 现金预检（含手续费），融资不在这个模板里
            cash = (self.account or {}).get("cash", 0)
            need = price * qty * (1 + self.rules["feeRate"])
            if need > cash:
                qty = int((cash / (price * (1 + self.rules["feeRate"]))) // self.lot) * self.lot
            if qty >= self.lot:
                self._send("buy_open", qty, price, row["stockId"])

        elif gap <= -1:
            # 平多：数量可以不是整手，但绝不超过 sellable
            qty = int(min(-gap, sellable))
            if qty > 0:
                self._send("sell_close", qty, self._pick_price(row, "sell"), row["stockId"])

    def _send(self, action, qty, price, stock):
        cid = "tpl-%s-%d-%d" % (action, int(time.time() * 1000), self.last_seq)
        self.pending_cid = cid
        if DRY_RUN:
            self.dry_position += qty if action == "buy_open" else -qty
            self.cooldown_until = time.time() + self.rules["cooldownMs"] / 1000.0
            log("[DRY] %s %s %d@%.2f  cid=%s（虚拟持仓 %d）" % (
                action, stock, qty, price, cid, self.dry_position))
            return
        res = self.cli.place(stock, action, qty, price, cid)
        if res.get("ok"):
            order = res["order"]
            wait = res.get("cooldownLeftMs", self.rules["cooldownMs"])
            self.cooldown_until = time.time() + wait / 1000.0
            log("下单 %s %d@%.2f → %s（%s），冷却 %.0fms" % (
                action, qty, price, order["id"], order["status"], wait))
            self.account_at = 0.0
        else:
            log("被拒 %s %d@%.2f：%s" % (action, qty, price, res.get("error")))
            # 冷却类拒绝可以按服务端给的剩余时间等待；其他错误改参数再试
            detail = res.get("detail") or {}
            if detail.get("cooldownMs"):
                self.cooldown_until = time.time() + detail["cooldownMs"] / 1000.0
            elif "频繁" in str(res.get("error", "")):
                self.cooldown_until = time.time() + self.rules["cooldownMs"] / 1000.0

    def step(self):
        mk = self.cli.markets(depth=1, trades=0)
        if not mk.get("ok"):
            return
        if mk["seq"] == self.last_seq:
            return
        self.last_seq = mk["seq"]

        row = next((m for m in mk["markets"] if m["stockId"] == self.stock), None)
        if not row:
            return
        self.prices.append(row["last"])

        # 先处理成交，再决策：本地持仓尽量新
        self._drain_fills()
        self._refresh_account()

        if not mk["day"].get("trading"):
            return
        self._maybe_trade(row)

    def run(self):
        self.reconcile()
        log("开始主循环（Ctrl+C 退出）")
        while True:
            try:
                self.step()
                time.sleep(POLL_SEC)
            except KeyboardInterrupt:
                raise
            except ApiError:
                raise
            except Exception as e:
                log("主循环异常：%s" % e)
                time.sleep(2)


def main():
    if not KEY:
        print("请先设置 GUSHEN_API_KEY：")
        print("    python openkey.py issue <账号> --label 'template'")
        return 2
    try:
        Engine(Client(BASE, KEY), STOCK).run()
    except KeyboardInterrupt:
        log("已停止")
    except ApiError as e:
        log("启动失败：%s" % e)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
