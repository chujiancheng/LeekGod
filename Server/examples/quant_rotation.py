"""
多股票动量轮动策略（开放接口 v1）

和 quant_ma.py / quant_template.py 的区别：那两个只管一只票，这个会**选股**。

思路：
  ① 每 tick 记录全部 10 只股票的最新价（1 个读请求拿全市场，不逐票拉）；
  ② 每只票打分 = 短窗涨速 + 当日涨幅 + 主动买占比，只用站上短均线、离涨跌停还有空间的票；
  ③ 只买分数最高、且分数过门槛的 TOP_N 只，等权分配仓位预算；
  ④ 持仓股分数转弱（< EXIT_SCORE）、掉出榜单、或触发固定止损就卖掉换股；
  ⑤ 先卖后买。账户级冷却 2 秒 → 一次完整轮换要跨好几个 tick，这是正常节奏，不是卡住。

用法：把下面「直接改这里」那三行填上，然后

    python examples/quant_rotation.py

不想改代码时，环境变量 GUSHEN_API_KEY / GUSHEN_BASE / DRY_RUN 仍然优先
（换了机器或换 Key 的时候用环境变量，不用动代码）。

可调参数（走环境变量，默认值适合 620 秒一局的节奏）：

    TOP_N            2        同时持有几只
    POSITION_PCT     0.6      总仓位占权益比例
    LOOKBACK         40       动量回看多少个 tick（40 × 0.7s ≈ 28 秒）
    ENTRY_SCORE      0.05     新开仓的最低分（score 单位 ≈ 短窗涨速百分点）
    EXIT_SCORE       -0.05    持仓分数低于此值就卖
    REPLACE_BONUS    0.04     持仓股的排名加成（防止在噪音里被反复换掉）
    STOP_LOSS        0.02     相对成本价止损比例，0 表示关闭
    MIN_GAP_PCT      0.15     补仓差额小于槽位预算这个比例就不动（一次冷却很贵）
    STOP_OUT_SEC     60       止损出局后多少秒内不再买回同一只票
    ORDER_TTL_SEC    25       挂单多久没成交就撤掉重挂
    NO_OPEN_LEFT_SEC 45       收盘前这么多秒不再开新仓
    ACCOUNT_EVERY_SEC 4       账户快照刷新间隔（省读配额）
    MA_TICKS         20       趋势确认用的短均线长度（tick 数）
    GUSHEN_STOCKS    空       只做指定的票，逗号分隔，如 600001,600002
    GUSHEN_FILL_LOG  空       给了路径就把自己的成交逐笔追加成 CSV

所有冷却、锁仓、费率、涨跌停、整手都从 /open/v1/meta 读，不写死。默认 DRY_RUN，
主循环只打印决策；确认信号合理后再设 DRY_RUN=0。这是模拟盘示例，不是盈利承诺。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import deque


# ============================================================
# 直接改这里（不想用环境变量就填这三行）
# ============================================================
API_KEY = "gs_96e894f7_LLO0VTQ7-gaLnqO4_H7QJNEDwDdFKofK"                              # 填 gs_ 开头的那串，例：gs_3f2a9c1e_Bt8xQ2...
BASE_URL = "http://127.0.0.1:3000"         # 你打开游戏用的地址，带不带结尾 / 都行
DRY_RUN_DEFAULT = False                     # True=只打印不下单；False=真下单

# 注意：Key 写进代码后别把这个文件连同真 Key 一起提交到 git / 发到群里。

# ============================================================
# 配置
# ============================================================
BASE = (os.environ.get("GUSHEN_BASE") or BASE_URL).rstrip("/")
KEY = (os.environ.get("GUSHEN_API_KEY") or API_KEY).strip()
_env_dry = os.environ.get("DRY_RUN", "").strip()
DRY_RUN = (_env_dry != "0") if _env_dry else bool(DRY_RUN_DEFAULT)


def _int(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return int(default)


def _float(name, default):
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return float(default)


POLL_SEC = 0.7                      # 与撮合 tick 同频，更密没有意义

TOP_N = max(1, _int("TOP_N", 2))
POSITION_PCT = _float("POSITION_PCT", 0.6)
LOOKBACK = max(2, _int("LOOKBACK", 40))
ENTRY_SCORE = _float("ENTRY_SCORE", 0.05)
EXIT_SCORE = _float("EXIT_SCORE", -0.05)
REPLACE_BONUS = _float("REPLACE_BONUS", 0.04)
STOP_LOSS = _float("STOP_LOSS", 0.02)
MIN_GAP_PCT = _float("MIN_GAP_PCT", 0.15)     # 补仓差额小于槽位预算这个比例就不动（省冷却）
STOP_OUT_SEC = _float("STOP_OUT_SEC", 60)     # 止损出局后多少秒内不再买回同一只票
ORDER_TTL_SEC = _float("ORDER_TTL_SEC", 25)
NO_OPEN_LEFT_SEC = _float("NO_OPEN_LEFT_SEC", 45)
ACCOUNT_EVERY_SEC = max(0.7, _float("ACCOUNT_EVERY_SEC", 4))
MA_TICKS = max(2, _int("MA_TICKS", 20))

# 打分权重：三项最后都折算成"百分点"，score 可以直观理解成"综合涨速"
W_ROC = _float("W_ROC", 1.0)        # 短窗涨速
W_DAY = _float("W_DAY", 0.25)       # 当日涨幅
W_FLOW = _float("W_FLOW", 0.1)      # 主动买占比偏离 50% 的程度

STOCKS_ENV = os.environ.get("GUSHEN_STOCKS", "").strip()
FILL_LOG = os.environ.get("GUSHEN_FILL_LOG", "").strip()

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
        """网络错误 / 5xx / 429 指数退避重试；4xx 业务错误直接返回（带 _status）。

        下单的重试是安全的：body 里的 clientOrderId 不变，服务端 10 分钟内同 id 只成交一次。
        """
        last = None
        for attempt in range(MAX_RETRY + 1):
            try:
                status, data = self._once(method, path, body)
            except Exception as e:                    # 超时 / 连接被重置
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
    def ping(self):
        return self.call("GET", "/open/v1/ping")

    def meta(self):
        return self.call("GET", "/open/v1/meta")

    def markets(self, depth=1, trades=0):
        return self.call("GET", "/open/v1/markets?depth=%d&trades=%d" % (depth, trades))

    def minute(self, stock):
        return self.call("GET", "/open/v1/markets/%s/minute" % stock)

    def account(self):
        return self.call("GET", "/open/v1/account")

    def fills(self, since):
        return self.call("GET", "/open/v1/fills?since=%d&limit=100" % since)

    def place(self, stock, action, qty, price, client_order_id):
        body = {
            "stockId": stock,
            "action": action,
            "qty": int(qty),
            "price": round(float(price), 2),
            "clientOrderId": client_order_id,
        }
        return self.call("POST", "/open/v1/orders", body)

    def cancel(self, order_id):
        return self.call("DELETE", "/open/v1/orders/%s" % order_id)


# ============================================================
# 信号：打分与选股（纯函数，方便你单独替换）
# ============================================================
def ma(values, n):
    if len(values) < n:
        return None
    return sum(list(values)[-n:]) / float(n)


def score_stock(prices, row):
    """一只票的动量分；历史不够返回 None。

    prices 是这个 tick 之前（含本 tick）的最新价序列。回看窗口跨越了收盘价也没关系，
    因为收盘后行情不再更新，序列里不会混进上一交易日的点。
    """
    if len(prices) < LOOKBACK + 1:
        return None
    last = prices[-1]
    ref = prices[-1 - LOOKBACK]
    if last <= 0 or ref <= 0:
        return None
    roc = (last / ref - 1.0) * 100.0                  # 短窗涨速（百分点）
    day = float(row.get("changePct") or 0.0)          # 当日涨幅（百分点）
    outer = (row.get("flow") or {}).get("outerPct")   # 外盘（主动买）占比
    flow = (float(outer) - 50.0) / 10.0 if outer is not None else 0.0
    return W_ROC * roc + W_DAY * day + W_FLOW * flow


def buyable(row, prices):
    """能不能买：返回 (bool, 原因)。这里只放硬性过滤，评分留给 score_stock。"""
    if not row or float(row.get("last") or 0) <= 0:
        return False, "无行情"
    if int(row.get("volume") or 0) <= 0:
        return False, "今日无成交"
    band = row.get("band")
    if band:
        # 贴着涨停买不到、贴着跌停是接刀，都跳过
        if row["last"] >= band["up"] * 0.995:
            return False, "接近涨停"
        if row["last"] <= band["down"] * 1.005:
            return False, "接近跌停"
    if not ((row.get("depth") or {}).get("asks") or []):
        return False, "无卖盘"
    m = ma(prices, MA_TICKS)
    if m is None:
        return False, "均线预热"
    if row["last"] < m:
        return False, "在短均线下方"
    return True, ""


def select_targets(scored, holding_ids):
    """在打分结果里挑 TOP_N 只作为目标持仓。

    scored: {stockId: score}（已过 buyable 与最低分门槛）
    holding_ids: 当前持有的票，排名时加 REPLACE_BONUS（换手阻尼）。
    """
    cands = []
    for sid, score in scored.items():
        if score < EXIT_SCORE:            # 分数已经转弱，不参与目标（会被卖出）
            continue
        bonus = REPLACE_BONUS if sid in holding_ids else 0.0
        cands.append((score + bonus, score, sid))
    cands.sort(key=lambda x: (-x[0], x[2]))

    target = {}
    for eff, raw, sid in cands:
        if len(target) >= TOP_N:
            break
        if sid in holding_ids or raw >= ENTRY_SCORE:
            target[sid] = raw
    return target


# ============================================================
# 引擎
# ============================================================
class Engine:
    def __init__(self, cli):
        self.cli = cli
        self.meta = None
        self.rules = {}
        self.lots = {}                   # stockId -> lotSize
        self.books = {}                  # stockId -> deque(最新价)
        self.stock_names = {}
        self.last_seq = -1
        self.cursor = 0
        self.account = None
        self.account_at = 0.0
        self.cooldown_until = 0.0
        self.day = {}
        self.server_time = 0
        self.target = {}
        self.fills_total = 0
        self.trades_sent = 0
        self.pause_log = {}              # 抑制同一原因的重复日志
        self.banned = {}                 # stockId -> 止损禁入截止时间戳

        # DRY_RUN 用的虚拟账户（以真实可用现金为起点）
        self.dry_cash = 0.0
        self.dry_books = {}              # stockId -> {"lots": deque, "cost": float}
        self.dry_realized = 0.0
        self.equity0 = None

    # ---------------- 启动对账 ----------------
    def reconcile(self):
        ping = self.cli.ping()
        if not ping.get("ok"):
            raise ApiError("鉴权失败：%s" % ping.get("error"))
        if "trade" not in (ping.get("scopes") or "") and not DRY_RUN:
            raise ApiError("这把 Key 没有 trade 权限，只能看盘。重新生成一把 read,trade 的。")

        meta = self.cli.meta()
        if not meta.get("ok"):
            raise ApiError("GET /meta 失败：%s" % meta.get("error"))
        self.meta = meta
        self.rules = meta["rules"]
        self.day = meta.get("day") or {}

        wanted = set(s for s in STOCKS_ENV.split(",") if s.strip())
        for s in meta["stocks"]:
            if wanted and s["id"] not in wanted:
                continue
            self.lots[s["id"]] = int(s["lotSize"])
            self.stock_names[s["id"]] = s["name"]
        if not self.lots:
            raise ApiError("没有可交易的标的（GUSHEN_STOCKS 写错了？）")

        # 用分时序列给行情序列做种子，避免冷启动等 40 个 tick 才算得出分
        day_start = (self.day or {}).get("dayStartAt")
        for sid in self.lots:
            hist = self.cli.minute(sid)
            book = self.books.setdefault(sid, deque(maxlen=max(LOOKBACK * 3, MA_TICKS * 4, 200)))
            if not hist.get("ok"):
                continue
            for p in hist.get("priceHistory", []):
                if day_start and p.get("t", 0) < day_start:
                    continue          # 别把上一交易日的点混进当日动量
                book.append(float(p["price"]))

        # 账户是权威状态
        self._refresh_account(force=True)

        # DRY_RUN 以当前可用现金为模拟起点（不叠加真实持仓，否则权益口径会混）
        if DRY_RUN:
            self.dry_cash = float(self.account.get("cash") or 0.0)
        self.equity0 = self._equity()

        # 成交游标从"现在"开始，不重放旧成交；进程重启靠 /account 对账
        f = self.cli.fills(0)
        if f.get("ok"):
            self.cursor = f.get("nextSince", 0)

        log("已连接 %s（Key %s，权限 %s）" % (ping.get("account"), ping.get("keyId"), ping.get("scopes")))
        log("规则：冷却 %dms / 锁仓 %dms / 费率 %.5f / 涨跌停 %s%% / 一手 %s 股" % (
            self.rules["cooldownMs"], self.rules["lockMs"], self.rules["feeRate"],
            (self.rules.get("priceLimit") or {}).get("pct"),
            "/".join(str(v) for v in sorted(set(self.lots.values())))))
        log("策略：TOP_N=%d 仓位 %.0f%% 回看 %d tick 入场 %.3f 出场 %.3f 止损 %.1f%%" % (
            TOP_N, POSITION_PCT * 100, LOOKBACK, ENTRY_SCORE, EXIT_SCORE, STOP_LOSS * 100))
        log("标的：%s" % "、".join("%s %s" % (k, v) for k, v in sorted(self.stock_names.items())))
        log("模式：%s" % ("DRY_RUN（只打印，不下单）" if DRY_RUN else "实盘下单"))

    def _refresh_account(self, force=False):
        now = time.time()
        if not force and now - self.account_at < ACCOUNT_EVERY_SEC:
            return
        a = self.cli.account()
        if a.get("ok"):
            self.account = a
            self.account_at = now
            self.cooldown_until = max(self.cooldown_until, now + (a.get("cooldownLeftMs") or 0) / 1000.0)
        elif a.get("_status") in (401, 403):
            raise ApiError("鉴权失败：%s" % a.get("error"))
        elif a.get("_status") == 503:
            raise ApiError("开放接口未启用：%s" % a.get("error"))

    # ---------------- 状态视图 ----------------
    def _equity(self):
        if DRY_RUN:
            value = 0.0
            for sid, b in self.dry_books.items():
                qty = sum(l["qty"] for l in b["lots"])
                px = self.books[sid][-1] if self.books.get(sid) else 0
                value += qty * px
            return self.dry_cash + value
        return float((self.account or {}).get("equity") or 0.0)

    def _cash(self):
        return self.dry_cash if DRY_RUN else float((self.account or {}).get("cash") or 0.0)

    def holdings(self):
        """{stockId: {qty, sellable, cost, short}}，cost 是平均成本价。"""
        if DRY_RUN:
            now = time.time() * 1000
            out = {}
            for sid, b in self.dry_books.items():
                qty = sum(l["qty"] for l in b["lots"])
                if qty <= 0:
                    continue
                sellable = sum(l["qty"] for l in b["lots"]
                               if now - l["ts"] >= self.rules["lockMs"])
                out[sid] = {"qty": qty, "sellable": sellable,
                            "cost": b["cost"] / qty if qty else 0.0, "short": 0}
            return out

        out = {}
        for p in (self.account or {}).get("positions", []):
            long_, short_ = p.get("long") or {}, p.get("short") or {}
            qty = int(long_.get("qty") or 0)
            sqty = int(short_.get("qty") or 0)
            if qty <= 0 and sqty <= 0:
                continue
            out[p["stockId"]] = {
                "qty": qty,
                "sellable": int(long_.get("sellable") or 0),
                "cost": (float(long_.get("cost") or 0.0) / qty) if qty else 0.0,
                "short": sqty,
            }
        return out

    def pending(self):
        """在途委托数量 {stockId: {buy, sell}}；算"预期仓位"时必须带上，否则会重复下单。"""
        if DRY_RUN:
            return {}
        out = {}
        for o in (self.account or {}).get("orders", []):
            if o.get("status") != "live":
                continue
            remain = max(0, int(o.get("qty") or 0) - int(o.get("filled") or 0))
            if remain <= 0:
                continue
            d = out.setdefault(o["stockId"], {"buy": 0, "sell": 0})
            if o.get("action") == "buy_open":
                d["buy"] += remain
            elif o.get("action") == "sell_close":
                d["sell"] += remain
        return out

    def _day_left_sec(self):
        d = self.day or {}
        if d.get("enabled") is False:
            return None
        end, now = d.get("dayEndsAt"), self.server_time
        if not end or not now:
            return None
        return (end - now) / 1000.0

    def _once(self, key, msg):
        """同一类提示 15 秒内只说一次，免得刷屏。"""
        now = time.time()
        if now - self.pause_log.get(key, 0) < 15:
            return
        self.pause_log[key] = now
        log(msg)

    # ---------------- 成交 ----------------
    def _drain_fills(self):
        if DRY_RUN:
            return
        f = self.cli.fills(self.cursor)
        if not f.get("ok"):
            return
        got = False
        for item in f.get("fills", []):
            if item["seq"] <= self.cursor:
                continue
            self._on_fill(item)
            got = True
        # 全部处理完再推进游标：中途崩溃最多重放，不会漏单
        self.cursor = f.get("nextSince", self.cursor)
        if got:
            self.account_at = 0.0          # 持仓变了，下一轮强制刷新账户

    def _on_fill(self, f):
        self.fills_total += 1
        log("成交 %s %s %d@%.2f（委托 %s，主动方 %s）" % (
            f["stockId"], f["action"], f["qty"], f["price"], f["orderId"], f.get("side")))
        if FILL_LOG:
            new = not os.path.exists(FILL_LOG)
            try:
                with open(FILL_LOG, "a", encoding="utf-8", newline="") as fh:
                    import csv
                    w = csv.writer(fh)
                    if new:
                        w.writerow(["seq", "t", "stockId", "action", "price", "qty", "orderId"])
                    w.writerow([f["seq"], f["t"], f["stockId"], f["action"],
                                f["price"], f["qty"], f["orderId"]])
            except OSError as e:
                log("写成交日志失败：%s" % e)

    # ---- 撤单辅助 ----
    def _live_orders(self, sid=None, action=None):
        for o in (self.account or {}).get("orders", []):
            if o.get("status") != "live":
                continue
            if sid and o.get("stockId") != sid:
                continue
            if action and o.get("action") != action:
                continue
            yield o

    def _cancel_order(self, o, why):
        res = self.cli.cancel(o["id"])
        self.trades_sent += 1
        remain = max(0, int(o.get("qty") or 0) - int(o.get("filled") or 0))
        if res.get("ok"):
            log("撤单 %s（%s，%d 股未成交）" % (o["id"], why, remain))
        else:
            log("撤单 %s 失败：%s" % (o["id"], res.get("error")))
        self.account_at = 0.0
        return bool(res.get("ok"))

    # ---------------- 撤掉过期/多余的挂单 ----------------
    def _cancel_stale(self):
        if DRY_RUN or not self.account or (self.day or {}).get("locked"):
            return False
        target = set(self.target)
        now_ms = time.time() * 1000
        for o in self._live_orders(action=None):
            if o.get("action") not in ("buy_open", "sell_close"):
                continue
            age = (now_ms - (o.get("ts") or 0)) / 1000.0
            stale = age >= ORDER_TTL_SEC
            # 买入单：票已经不在目标里，就别让它继续挂着
            orphan = o["action"] == "buy_open" and o["stockId"] not in target
            if not (stale or orphan):
                continue
            self._cancel_order(o, "票已出榜" if orphan else "%ds 未成交" % age)
            return True                    # 一个 tick 只发一个交易请求
        return False

    # ---------------- 下单 ----------------
    def _price(self, row, side):
        """贴对手价：买用卖一，卖用买一；再夹进涨跌停，避免行情抖动被判越界。"""
        depth = row.get("depth") or {}
        levels = depth.get("asks" if side == "buy" else "bids") or []
        px = float(levels[0]["price"]) if levels else float(row["last"])
        band = row.get("band")
        if band:
            px = min(float(band["up"]), max(float(band["down"]), px))
        return round(px, 2)

    def _place(self, sid, action, qty, price):
        cid = "rot-%s-%s-%d-%d" % (action, sid, int(time.time() * 1000), self.last_seq)
        if DRY_RUN:
            self._dry_fill(sid, action, qty, price)
            self.cooldown_until = time.time() + self.rules["cooldownMs"] / 1000.0
            self.trades_sent += 1
            log("[DRY] %s %s %d@%.2f  现金 %.0f 权益 %.0f" % (
                action, sid, qty, price, self.dry_cash, self._equity()))
            return True

        res = self.cli.place(sid, action, qty, price, cid)
        self.trades_sent += 1
        if res.get("ok"):
            wait = res.get("cooldownLeftMs") or self.rules["cooldownMs"]
            self.cooldown_until = time.time() + float(wait) / 1000.0
            log("下单 %s %s %d@%.2f → %s（%s），冷却 %.0fms" % (
                action, sid, qty, price, res["order"]["id"], res["order"]["status"], float(wait)))
            self.account_at = 0.0
            return True

        log("被拒 %s %s %d@%.2f：%s" % (action, sid, qty, price, res.get("error")))
        detail = res.get("detail") or {}
        if detail.get("cooldownMs"):
            self.cooldown_until = time.time() + float(detail["cooldownMs"]) / 1000.0
        elif "频繁" in str(res.get("error", "")):
            self.cooldown_until = time.time() + self.rules["cooldownMs"] / 1000.0
        if res.get("_status") in (401, 403):
            raise ApiError("鉴权/权限错误：%s" % res.get("error"))
        if res.get("_status") == 400 and res.get("code") == "bad_request":
            raise ApiError("请求格式错误，检查代码：%s" % res.get("error"))
        return False

    def _dry_fill(self, sid, action, qty, price):
        """DRY_RUN 的虚拟成交：假设限价单立刻按委托价成交，含手续费。"""
        book = self.dry_books.setdefault(sid, {"lots": deque(), "cost": 0.0})
        fee = price * qty * self.rules["feeRate"]
        if action == "buy_open":
            self.dry_cash -= price * qty + fee
            book["lots"].append({"ts": time.time() * 1000, "qty": qty, "price": price})
            book["cost"] += price * qty
            return
        self.dry_cash += price * qty - fee
        left = qty
        cost_out = 0.0
        while left > 0 and book["lots"]:
            lot0 = book["lots"][0]
            take = min(left, lot0["qty"])
            lot0["qty"] -= take
            cost_out += take * lot0["price"]
            left -= take
            if lot0["qty"] == 0:
                book["lots"].popleft()
        book["cost"] -= cost_out
        self.dry_realized += price * qty - cost_out - fee

    # ---------------- 决策 ----------------
    def _scan(self, markets):
        self.target = {}
        scored = {}
        rows = {}
        for row in markets:
            sid = row["stockId"]
            if sid not in self.lots:
                continue
            rows[sid] = row
            book = self.books.setdefault(sid, deque(maxlen=max(LOOKBACK * 3, MA_TICKS * 4, 200)))
            last = float(row.get("last") or 0)
            if last > 0:
                book.append(last)
            score = score_stock(book, row)
            if score is None:
                self._once("warm-%s" % sid, "%s 行情预热中（%d/%d 个点）" % (
                    sid, len(book), LOOKBACK + 1))
                continue
            ok, why = buyable(row, book)
            if not ok:
                self._once("skip-%s-%s" % (sid, why), "%s 跳过：%s（分 %.3f）" % (sid, why, score))
                continue
            scored[sid] = score
        return rows, scored

    def _rebalance(self, rows, scored):
        if time.time() < self.cooldown_until:
            return
        if not (self.day or {}).get("trading", True):
            self._once("halt", "当前阶段不下单（%s）" % (self.day or {}).get("label", "休市"))
            return

        hold = self.holdings()
        pend = self.pending()
        left = self._day_left_sec()
        allow_open = left is None or left > NO_OPEN_LEFT_SEC

        # ---- 先卖：止损 / 掉出目标 ----
        for sid in sorted(hold):
            h = hold[sid]
            p = pend.get(sid, {})
            projected = h["qty"] + p.get("buy", 0) - p.get("sell", 0)
            if projected <= 0:
                continue
            row = rows.get(sid)
            score = scored.get(sid)

            reason = None
            is_stop = False
            if STOP_LOSS > 0 and h["cost"] > 0 and row and row["last"] <= h["cost"] * (1 - STOP_LOSS):
                reason = "止损（成本 %.2f → 现价 %.2f）" % (h["cost"], row["last"])
                is_stop = True
            elif score is not None and (score < EXIT_SCORE or sid not in self.target):
                # score 为 None 说明这只票被买入过滤器挡掉了（例如已封涨停、均线预热），
                # 那种情况只由止损管，不按排名卖
                reason = "换股" if score < EXIT_SCORE else "掉出榜单"

            if not reason:
                continue
            # 这张票还有在途买单时不要发卖单，两张单会互相打架（自成交会被系统撤单）
            if p.get("buy", 0) > 0:
                if (self.day or {}).get("locked"):
                    continue
                for o in self._live_orders(sid, "buy_open"):
                    self._cancel_order(o, "卖出前撤掉在途买单")
                    return
                continue
            qty = min(projected, h["sellable"])
            if qty <= 0:
                self._once("lock-%s" % sid, "%s 想卖但暂时不可卖（锁仓/在途占用），等解锁" % sid)
                continue
            if not row:
                continue
            if self._place(sid, "sell_close", qty, self._price(row, "sell")) and is_stop:
                # 止损出局后禁入一段时间，否则下一 tick 又会原价买回来（白交两趟手续费）
                self.banned[sid] = time.time() + STOP_OUT_SEC
                log("%s 止损出局，%.0f 秒内不再买回" % (sid, STOP_OUT_SEC))
            return

        # ---- 再买：目标里还没买够的 ----
        if not allow_open:
            self._once("late", "距收盘不足 %.0f 秒，停止开新仓" % NO_OPEN_LEFT_SEC)
            return
        if self.day.get("locked"):
            return

        budget = self._equity() * POSITION_PCT / TOP_N
        for sid in sorted(self.target, key=lambda s: -self.target[s]):
            row = rows.get(sid)
            if not row:
                continue
            h = hold.get(sid, {})
            if h.get("short", 0) > 0:              # 同股多空互斥：有空头就不能开多
                continue
            if self.banned.get(sid, 0) > time.time():
                self._once("ban-%s" % sid, "%s 止损禁入期内，本轮跳过" % sid)
                continue
            lot = self.lots[sid]
            px = self._price(row, "buy")
            if px <= 0:
                continue
            win = int(budget // (px * lot)) * lot
            if win <= 0:
                self._once("tiny-%s" % sid, "%s 预算 %.0f 元不足一手（%.2f×%d）" % (
                    sid, budget, px, lot))
                continue
            p = pend.get(sid, {})
            if p.get("sell", 0) > 0:               # 卖单还在途，别急着买回来
                continue
            projected = h.get("qty", 0) + p.get("buy", 0)
            gap = win - projected
            if gap < lot:
                continue
            # 只是价格抖动带来的零头（不足槽位预算的一小块）就别浪费一次冷却
            if projected > 0 and gap * px < budget * MIN_GAP_PCT:
                continue
            qty = int(gap // lot) * lot

            # 现金预检（含手续费）；不够就按能买的整手数缩
            cash = self._cash()
            need = px * qty * (1 + self.rules["feeRate"])
            if need > cash:
                qty = int((cash / (px * (1 + self.rules["feeRate"]))) // lot) * lot
            if qty < lot:
                self._once("cash-%s" % sid, "%s 现金不足（可用 %.0f，需 %.0f）" % (sid, cash, need))
                continue
            self._place(sid, "buy_open", qty, px)
            return

    def step(self):
        mk = self.cli.markets(depth=1, trades=0)
        if not mk.get("ok"):
            return
        if mk.get("seq") == self.last_seq:      # 没有新 tick，什么都不用做
            return
        self.last_seq = mk.get("seq")
        self.day = mk.get("day") or self.day
        self.server_time = mk.get("serverTime") or 0

        rows, scored = self._scan(mk.get("markets") or [])

        # 先结算成交、再刷账户、最后决策：本地状态尽量新
        self._drain_fills()
        self._refresh_account()
        if not self.account and not DRY_RUN:
            return

        hold_ids = set(self.holdings())
        self.target = select_targets(scored, hold_ids)

        head = "  ".join("%s=%.3f%s" % (sid, sc, "*" if sid in self.target else "")
                         for sid, sc in sorted(scored.items(), key=lambda kv: -kv[1]))
        self._once("scan", "打分：%s" % (head or "（全部不满足买入条件）"))

        if self._cancel_stale():
            return
        self._rebalance(rows, scored)

    def run(self):
        self.reconcile()
        log("主循环开始（Ctrl+C 退出）")
        last_phase = None
        try:
            while True:
                try:
                    self.step()
                except ApiError:
                    raise
                except Exception as e:
                    log("主循环异常：%s" % e)
                    time.sleep(2)
                phase = (self.day or {}).get("label")
                if phase and phase != last_phase:
                    last_phase = phase
                    log("阶段：%s（trading=%s）" % (phase, (self.day or {}).get("trading")))
                time.sleep(POLL_SEC)
        except KeyboardInterrupt:
            self.report()

    def report(self):
        eq = self._equity()
        base = self.equity0 if self.equity0 else eq
        log("已停止。起始权益 %.0f → 当前权益 %.0f（%+.2f%%），成交 %d 笔，交易请求 %d 次" % (
            base, eq, ((eq / base - 1) * 100 if base else 0), self.fills_total, self.trades_sent))
        if DRY_RUN:
            log("DRY_RUN 虚拟已实现盈亏 %+.0f 元，虚拟现金 %.0f" % (self.dry_realized, self.dry_cash))
            for sid, b in sorted(self.dry_books.items()):
                qty = sum(l["qty"] for l in b["lots"])
                if qty:
                    log("  持有 %s %d 股，成本 %.2f" % (sid, qty, b["cost"] / qty))


def main():
    if not KEY:
        print("没拿到 Key：把本文件顶部的 API_KEY 填成 gs_ 开头的那串")
        print("（Key 在游戏主页「开放接口」按钮 / 服务器地址/portal.html 里自己生成）")
        return 2
    if not KEY.startswith("gs_"):
        print("Key 格式不对：应该以 gs_ 开头（少了前缀或复制不全）")
        return 2
    try:
        Engine(Client(BASE, KEY)).run()
    except ApiError as e:
        log("中止：%s" % e)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
