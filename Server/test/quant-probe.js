/**
 * 量化策略盈利性探针（**手动运行，不在 npm test 里**）：
 *
 *   node test/quant-probe.js [策略] [天数] [股票代码]
 *   策略：mm | mmout | take | mom | none
 *
 * 纯内存 `new Game()`，不注入 persist，**绝不碰正式存档**。
 * 受控时钟：每 tick 前进 tickIntervalMs，与真实服务同速。
 *
 * 目的：验证「玩家用程序化策略是不是必然赚钱」。
 * 每个策略都只做**一只股票、一手一手地做**，初始 100 万，不做融资、不做空。
 * 记录：期末权益、成交笔数、胜率、最大回撤、平均单笔盈亏。
 */
const path = require('path');
const SERVER = path.join(__dirname, '..', 'src');
const config = require(path.join(SERVER, 'config.js'));
const { Game } = require(path.join(SERVER, 'game.js'));

const STRAT = process.argv[2] || 'mm';
const DAYS = Number(process.argv[3] || 1);
const STOCK = process.argv[4] || '600001';
const TICK_MS = config.tickIntervalMs || 700;
const DAY_MS = (config.day.phases || []).reduce((a, p) => a + p.ms, 0) || 620000;

let clock = 1793000000000;
Date.now = () => clock;

const g = new Game();
g.start();
clearInterval(g.timer);
g.timer = null;

const acc = g.store.get('bot');
g.onboard('bot', '量化机器人', 'zhaoshang');
const a = g.store.get('bot');
const m = g.markets.get(STOCK);

const LOT = STOCK === '600001' ? 100 : 100;
const MAX_POS = STRAT === 'mm2' ? 40000 : 2000;
const QTY = STRAT === 'mm2' ? 5000 : 200;

let ema = m.lastPrice;
let fills = 0;
let roundTrips = 0;
let wins = 0;
let realized = 0;
let lastBuyPx = 0;
let peak = g.equityOf(a);
let maxDD = 0;
let ordersSent = 0;
let orderErr = {};

const cancelMine = () => {
  for (const o of [...m.book.orders.values()]) {
    if (o.account === a.name) g.cancelOrderFor(a, o.id);
  }
};

const send = (action, price, qty = QTY) => {
  ordersSent += 1;
  const r = g.placeOrderFor(a, { stockId: STOCK, action, price, qty });
  if (!r.ok) orderErr[r.error] = (orderErr[r.error] || 0) + 1;
  return r;
};

const bestBid = () => (m.book.bids.length ? m.book.bids[0].price : null);
const bestAsk = () => (m.book.asks.length ? m.book.asks[0].price : null);

let lastActionTick = -99;
let boughtTick = -99;

const step = (tick) => {
  const px = m.lastPrice;
  ema = ema * 0.98 + px * 0.02;
  const bid = bestBid();
  const ask = bestAsk();
  if (!bid || !ask) return;

  const long = a.longQty(STOCK);
  const sellable = a.freeSellableLong(STOCK, Date.now(), config.trade.lockMs);

  // 冷却 2s ≈ 3 tick：每 3 tick 才动一次，模拟真实轮询节奏
  if (tick - lastActionTick < 3) return;

  if (STRAT === 'mm2') {
    cancelMine();
    const pos = long;
    const canBuy = pos < MAX_POS;
    const canSell = sellable >= LOT;
    // 双向做市：库存高就只挂卖、低就只挂买；中间区域交替挂，绕开 2 秒下单冷却
    const preferSell = pos > MAX_POS * 0.6 || (pos > 0 && tick % 6 < 3);
    if (preferSell && canSell) {
      const p = Math.max(ask - 0.01, bid + 0.01);
      const r = send('sell_close', Number(p.toFixed(2)), Math.min(long, QTY));
      if (r.ok) lastActionTick = tick;
    } else if (canBuy) {
      const p = Math.min(bid + 0.01, ask - 0.01);
      const r = send('buy_open', Number(p.toFixed(2)), QTY);
      if (r.ok) lastActionTick = tick;
    }
  } else if (STRAT === 'mm' || STRAT === 'mmout') {
    cancelMine();
    if (long === 0) {
      const p = STRAT === 'mm' ? Math.min(bid + 0.01, ask - 0.01) : bid;
      if (p > 0) {
        const r = send('buy_open', Number(p.toFixed(2)));
        if (r.ok) lastActionTick = tick;
      }
    } else if (sellable >= LOT) {
      const p = STRAT === 'mm' ? Math.max(ask - 0.01, bid + 0.01) : ask;
      const r = send('sell_close', Number(p.toFixed(2)), Math.min(long, QTY));
      if (r.ok) lastActionTick = tick;
    }
  } else if (STRAT === 'take') {
    cancelMine();
    if (long === 0 && tick - boughtTick > 15) {
      const r = send('buy_open', ask);
      if (r.ok) { lastActionTick = tick; boughtTick = tick; }
    } else if (long > 0 && sellable >= LOT) {
      const r = send('sell_close', bid, Math.min(long, QTY));
      if (r.ok) lastActionTick = tick;
    }
  } else if (STRAT === 'mom') {
    cancelMine();
    if (long < MAX_POS && px > ema * 1.002) {
      const r = send('buy_open', Math.min(ask, Number((px * 1.003).toFixed(2))));
      if (r.ok) lastActionTick = tick;
    } else if (long > 0 && sellable >= LOT && px < ema * 0.998) {
      const r = send('sell_close', Math.max(bid, Number((px * 0.997).toFixed(2))), Math.min(long, QTY));
      if (r.ok) lastActionTick = tick;
    }
  }
};

const equity = () => g.equityOf(a);

const startEq = equity();
const ticksPerDay = Math.round(DAY_MS / TICK_MS);

for (let d = 0; d < DAYS; d++) {
  for (let i = 0; i < ticksPerDay; i++) {
    clock += TICK_MS;
    try { g.tick(); } catch (e) { /* 与主循环一致：单 tick 异常不终止 */ }
    if (STRAT !== 'none') step(g.tickCount);
    const eq = equity();
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  process.stdout.write(
    `day${d + 1} 价 ${m.lastPrice.toFixed(2)} 权益 ${equity().toFixed(0)} 持仓 ${a.longQty(STOCK)} 现金 ${a.cash.toFixed(0)}\n`
  );
}

const endEq = equity();
const trades = a.trades ? a.trades.length : 0;
console.log(JSON.stringify({
  strat: STRAT, days: DAYS, stock: STOCK,
  startEquity: Math.round(startEq), endEquity: Math.round(endEq),
  pnl: Math.round(endEq - startEq), pnlPct: +(((endEq - startEq) / startEq) * 100).toFixed(2),
  ordersSent, errors: orderErr, trades, maxDrawdownPct: +(maxDD * 100).toFixed(2),
  lastPrice: m.lastPrice,
}, null, 2));
