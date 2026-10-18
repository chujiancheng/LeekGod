"""
开放接口示例策略：双均线（MA5 / MA20）+ 冷却与幂等处理

用法:
    set GUSHEN_API_KEY=gs_xxxxxxxx_yyyyyyyyyyyyyyyy
    set GUSHEN_BASE=http://127.0.0.1:3000        （可选，默认就是这个）
    set GUSHEN_STOCK=600001                      （可选）
    python examples/quant_ma.py

只依赖标准库。跑之前先在游戏里确认账号已开户，并让运维发一把 read,trade 的 Key：
    python openkey.py issue <账号> --label "MA demo"

这个脚本刻意把几件事写清楚，照着改你自己的模型：
  ① 用 `seq` 判断行情有没有更新，而不是盲 sleep
  ② 下单前读 `rules.cooldownMs` 与回包的 `cooldownLeftMs`，不写死 2 秒
  ③ `qty` 用 `lotSize` 取整，卖出用 `long.sellable`（不是持仓量）
  ④ 每次下单带 `clientOrderId`，超时重发不会变成两单
  ⑤ 只在 `day.trading` 为真、且不是竞价锁定期时下单
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("GUSHEN_BASE", "http://127.0.0.1:3000").rstrip("/")
KEY = os.environ.get("GUSHEN_API_KEY", "").strip()
STOCK = os.environ.get("GUSHEN_STOCK", "600001")

FAST, SLOW = 5, 20          # 均线窗口（用分时点数，约 5 / 20 个 tick）
ORDER_LOTS = 1              # 每次下几手
POLL_MS = 700               # 轮询间隔，与 tick 同频


def call(method, path, body=None):
    """带 Key 的请求。429 与网络错误都返回 None，让主循环下一轮再试。"""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"X-API-Key": KEY}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8"))
        except Exception:
            payload = {"ok": False, "error": "HTTP %s" % e.code}
        # 429 是常态（轮询太密），静默跳过
        if e.code != 429:
            print("  ! %s %s -> %s" % (method, path, payload.get("error")))
        return payload if e.code != 429 else None
    except Exception as e:
        print("  ! 网络错误: %s" % e)
        return None


def ma(values, n):
    return sum(values[-n:]) / float(n) if len(values) >= n else None


def main():
    if not KEY:
        print("请先设置 GUSHEN_API_KEY（python openkey.py issue <账号> 拿一把）")
        return 1

    ping = call("GET", "/open/v1/ping")
    if not ping or not ping.get("ok"):
        print("鉴权失败：%s" % (ping or {}).get("error"))
        return 1
    print("已连接：账号 %s（Key %s，权限 %s）" % (ping["account"], ping["keyId"], ping["scopes"]))

    meta = call("GET", "/open/v1/meta")
    lot = next((s["lotSize"] for s in meta["stocks"] if s["id"] == STOCK), 100)
    print("标的 %s，一手 %d 股，冷却 %d ms" % (STOCK, lot, meta["rules"]["cooldownMs"]))

    last_seq = -1
    prev_fast = prev_slow = None
    pending_id = None       # 上一笔委托的幂等键，成交/失败后清空
    cooldown_until = 0.0

    while True:
        try:
            # ---- ① 只在有新 tick 时决策 ----
            mk = call("GET", "/open/v1/markets?depth=1&trades=0")
            if not mk:
                time.sleep(POLL_MS / 1000.0)
                continue
            if mk["seq"] == last_seq:
                time.sleep(POLL_MS / 1000.0)
                continue
            last_seq = mk["seq"]

            day = mk["day"]
            row = next((m for m in mk["markets"] if m["stockId"] == STOCK), None)
            if not row:
                print("标的不存在: %s" % STOCK)
                return 1

            # ---- ② 时段门控：午休/夜间不交易，竞价锁定期不撤单 ----
            if not day.get("trading"):
                time.sleep(POLL_MS / 1000.0)
                continue

            # ---- ③ 用分时序列算指标（比逐笔稳，且不受 depth 裁剪影响）----
            hist = call("GET", "/open/v1/markets/%s/minute" % STOCK)
            if not hist:
                time.sleep(POLL_MS / 1000.0)
                continue
            prices = [p["price"] for p in hist["priceHistory"]]
            fast, slow = ma(prices, FAST), ma(prices, SLOW)
            if fast is None or slow is None:
                time.sleep(POLL_MS / 1000.0)
                continue

            if prev_fast is not None and prev_slow is not None:
                golden = prev_fast <= prev_slow and fast > slow
                dead = prev_fast >= prev_slow and fast < slow
            else:
                golden = dead = False
            prev_fast, prev_slow = fast, slow

            if not (golden or dead):
                time.sleep(POLL_MS / 1000.0)
                continue

            # ---- ④ 冷却：宁可多等，也别把请求打成 400 ----
            now = time.time() * 1000
            if now < cooldown_until:
                time.sleep((cooldown_until - now) / 1000.0)
                continue

            acct = call("GET", "/open/v1/account")
            if not acct:
                time.sleep(POLL_MS / 1000.0)
                continue
            pos = next((p for p in acct["positions"] if p["stockId"] == STOCK), None)
            long_qty = pos["long"]["qty"] if pos else 0
            short_qty = pos["short"]["qty"] if pos else 0
            sellable = pos["long"]["sellable"] if pos else 0

            # ---- ⑤ 信号 → 动作（同股多空互斥：持多头时只平不开空）----
            body = None
            if golden and long_qty == 0 and short_qty == 0:
                body = {"action": "buy_open", "qty": lot * ORDER_LOTS}
            elif dead and sellable >= lot:
                body = {"action": "sell_close", "qty": (sellable // lot) * lot}
            if not body:
                time.sleep(POLL_MS / 1000.0)
                continue

            # 限价贴着对手价打：买用卖一、卖用买一；盘口空就退回最新价
            if body["action"] == "buy_open":
                px = row["depth"]["asks"][0]["price"] if row["depth"]["asks"] else row["last"]
            else:
                px = row["depth"]["bids"][0]["price"] if row["depth"]["bids"] else row["last"]
            body["stockId"] = STOCK
            body["price"] = round(px, 2)
            # 幂等键：时间戳 + seq，重启不会撞上一轮的号
            pending_id = "ma-%d-%d" % (int(time.time() * 1000), mk["seq"])
            body["clientOrderId"] = pending_id

            res = call("POST", "/open/v1/orders", body)
            if res and res.get("ok"):
                print("[%s] %s %d@%.2f → %s" % (
                    time.strftime("%H:%M:%S"), body["action"], body["qty"], body["price"], res["order"]["id"]))
                cooldown_until = time.time() * 1000 + res.get("cooldownLeftMs", meta["rules"]["cooldownMs"])
            elif res:
                # 拒单原因原样打出来：整手/方向/可卖/券源/资金…见 Doc/开放平台API.md §7
                print("[%s] 被拒: %s" % (time.strftime("%H:%M:%S"), res.get("error")))
                cooldown_until = time.time() * 1000 + meta["rules"]["cooldownMs"]

            time.sleep(POLL_MS / 1000.0)
        except KeyboardInterrupt:
            print("\n已停止")
            return 0
        except Exception as e:
            print("主循环异常: %s" % e)
            time.sleep(2)


if __name__ == "__main__":
    sys.exit(main())
