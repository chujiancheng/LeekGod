/**
 * 资金流向与日线：`Market`（每只股票）与 `IndexFeed`（大盘指数）共用的一套记账。
 *
 * 口径：
 * - **外盘** = 主动买成交（买家吃卖单），**内盘** = 主动卖成交（卖家吃买单）。
 *   逐笔的主动方向在 `Market.execute` 里就已经定死（见 `onTrade` 的 aggressorSide），
 *   这里只负责按日累计，不重新判断。
 * - **资金净流入 = 外盘成交额 − 内盘成交额**，与真实行情软件同口径。
 * - **日线**在每个交易日收盘结算时定格一根（`recordDailyBar`），当日的高低量额此刻还没归零，
 *   所以必须在 `settleDay` 里、清零之前调用。指数的日线同样一根，量额是成分股合计。
 *
 * 两个调用方（个股与指数）的差别只在「成交怎么发生」，记账口径必须完全一致，
 * 所以这层逻辑不写在各自的类里，而是按同一套字段操作调用方对象（鸭子类型）。
 * 调用方需具备：outerVol/outerAmt/innerVol/innerAmt（当日累计）、dailyBars（已收盘日线）、
 * open/high/low/lastPrice/volume/turnover（当日行情）、priceHistory、dayCycle、journal、stockId。
 */
const config = require('./config');
const { r2 } = require('./store');

/** 内存里保留的日线根数（一个游戏日 10 分 20 秒，260 天足够画图；库里的行同样按它截断） */
const DEFAULT_KEEP = 260;

/** 初始化（构造时调一次） */
function initFlow(o) {
  o.outerVol = 0;
  o.outerAmt = 0;
  o.innerVol = 0;
  o.innerAmt = 0;
  o.dailyBars = [];
}

/** 当日累计清零（日终结算调） */
function resetDayFlow(o) {
  o.outerVol = 0;
  o.outerAmt = 0;
  o.innerVol = 0;
  o.innerAmt = 0;
}

/** 一笔成交计入流向。side 是**主动方**方向：buy = 外盘，sell = 内盘 */
function addTrade(o, side, price, qty) {
  const amt = price * qty;
  if (side === 'buy') {
    o.outerVol += qty;
    o.outerAmt += amt;
  } else {
    o.innerVol += qty;
    o.innerAmt += amt;
  }
}

/** 当日资金流向快照（给客户端） */
function flowSnapshot(o) {
  const outerAmt = r2(o.outerAmt || 0);
  const innerAmt = r2(o.innerAmt || 0);
  const total = outerAmt + innerAmt;
  return {
    outerVol: o.outerVol || 0,
    outerAmt,
    innerVol: o.innerVol || 0,
    innerAmt,
    // 净流入：正数=主动性买盘净买入，负数=净卖出
    net: r2(outerAmt - innerAmt),
    // 外盘占比：内外盘势头的可读表达（>50% 说明主动性买盘占优）。当日还没成交时为 null
    outerPct: total > 0 ? r2((outerAmt / total) * 100) : null,
  };
}

/**
 * 把当日行情定格成一根日线（日终结算时调，必须在当日高低量额归零**之前**）。
 *
 * 只有「分时序列末点确实落在被结算的那一天」才记：补结算可能发生在停机数天之后，
 * 那时 open/high/low/volume 还是停机前那一天的，照记会让图上凭空多出一根重复的 K 线。
 * 拿不到交易日时钟时（孤立 Market，如单测直接调 settleDay）只认调用方显式给的 day。
 */
function recordDailyBar(o, day, now) {
  if (!(day >= 1)) return null;
  const h = o.priceHistory;
  const lastT = h && h.length ? h[h.length - 1].t : 0;
  if (o.dayCycle && o.dayCycle.ok && lastT) {
    if (o.dayCycle.locate(lastT).day !== day) return null;
  }
  const bar = {
    day,
    open: r2(o.open),
    high: r2(o.high),
    low: r2(o.low),
    close: r2(o.lastPrice),
    volume: o.volume,
    turnover: r2(o.turnover),
    outerVol: o.outerVol,
    outerAmt: r2(o.outerAmt),
    innerVol: o.innerVol,
    innerAmt: r2(o.innerAmt),
    net: r2(o.outerAmt - o.innerAmt),
    t: now,
  };
  const bars = o.dailyBars;
  const last = bars[bars.length - 1];
  // 同一天重复结算（补结算）覆盖，不追加第二根
  if (last && last.day === day) bars[bars.length - 1] = bar;
  else bars.push(bar);
  const keep = (config.market && config.market.dailyBarsKeep) || DEFAULT_KEEP;
  if (bars.length > keep) bars.splice(0, bars.length - keep);
  if (o.journal && typeof o.journal.barChanged === 'function') o.journal.barChanged(o.stockId, bar);
  return bar;
}

/**
 * 重启恢复：当日流向累计（market_state 的新列）与已收盘日线（daily_bars 表）。
 * 当日累计必须恢复——否则重启后「外盘 + 内盘」会小于当日成交量，盘口资金对不上账。
 */
function restoreFlow(o, row, bars) {
  if (row) {
    o.outerVol = row.outer_vol || 0;
    o.outerAmt = row.outer_amt || 0;
    o.innerVol = row.inner_vol || 0;
    o.innerAmt = row.inner_amt || 0;
  }
  if (Array.isArray(bars)) {
    o.dailyBars = bars.map((b) => ({
      day: b.day,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      turnover: b.turnover,
      outerVol: b.outer_vol || 0,
      outerAmt: b.outer_amt || 0,
      innerVol: b.inner_vol || 0,
      innerAmt: b.inner_amt || 0,
      net: r2((b.outer_amt || 0) - (b.inner_amt || 0)),
      t: b.settled_at,
    }));
  }
}

module.exports = { initFlow, resetDayFlow, addTrade, flowSnapshot, recordDailyBar, restoreFlow, DEFAULT_KEEP };
