/**
 * NPC 行为 A/B 无头仿真探针（**手动运行，不在 npm test 里**）：
 *
 *   node test/npc-probe.js [局数] [tick数] [new|base|nopnl|noforce|noimpact]
 *
 * 纯内存 `new Game()`，不注入 persist，**不碰正式存档**。
 * 受控时钟：把 Date.now 换成每 tick 前进 tickIntervalMs 的假时钟——不这么做的话，
 * 消息/锁仓按真实秒衰减，在快跑循环里几乎不触发，测出来的波动会严重偏低。
 *
 * base 档把本次新增的东西（意图/力量天平/浮盈亏/盘口感知）全部关掉，等价改动前，
 * 用来对照。**调这类"给 NPC 加情绪或资金推力"的参数时，要同时盯两个硬指标**：
 *   ① 买盘空档率（盘口一侧有没有承接力，玩家能不能卖出）
 *   ② 强平次数（会不会被趋势放大成连环爆仓）
 * 只看价格涨跌幅会被"看着很刺激、其实市场已经坏了"骗过去。
 */
const path = require('path');
const SERVER = path.join(__dirname, '..', 'src');
const config = require(path.join(SERVER, 'config.js'));
const { Game } = require(path.join(SERVER, 'game.js'));
const { Market } = require(path.join(SERVER, 'market.js'));

const SEEDS = Number(process.argv[2] || 4);
const TICKS = Number(process.argv[3] || 3000);
const MODE = process.argv[4] || 'new'; // new | base | nopnl | noforce | noimpact

// ── 受控时钟 ──
const realNow = Date.now;
let clock = 1790000000000;
Date.now = () => clock;

// ── 强平计数（按角色归因）──
let liqCount = 0;
const liqByRole = {};
for (const fn of ['forceSellLong', 'forceCoverShort']) {
  const orig = Market.prototype[fn];
  Market.prototype[fn] = function (acc, ...rest) {
    liqCount += 1;
    const role = (acc && (acc.role || (acc.isNPC ? 'npc' : 'player'))) || '?';
    liqByRole[role] = (liqByRole[role] || 0) + 1;
    return orig.call(this, acc, ...rest);
  };
}

// ── A/B 开关 ──
const KNOBS = {
  intent: config.npc.intent,
  force: config.npc.force,
  pnlFeel: config.npc.pnlFeel,
};
function setMode(mode) {
  const on = mode !== 'base';
  KNOBS.intent.enabled = on;
  KNOBS.intent.depthAware = on;
  KNOBS.force.enabled = on;
  KNOBS.pnlFeel.enabled = on;
  if (mode === 'nopnl') KNOBS.pnlFeel.enabled = false;
  if (mode === 'noforce') KNOBS.force.enabled = false;
  if (mode === 'noimpact') KNOBS.intent.depthAware = false;
}

// ── 埋点 ──
const intentStats = {
  squeeze: { n: 0, ticks: 0, ret: [], instDelta: [] },
  accumulate: { n: 0, ticks: 0, ret: [], instDelta: [] },
  distribute: { n: 0, ticks: 0, ret: [], instDelta: [] },
};
const shortIntents = { squeeze: 0, accumulate: 0, distribute: 0 };
const minDur = { squeeze: 1e9, accumulate: 1e9, distribute: 1e9 };
const lureRet = { squeeze: [], accumulate: [], distribute: [] };
const mainRet = { squeeze: [], accumulate: [], distribute: [] };
let forceTicks = { up: 0, flat: 0, down: 0 };
let forceSum = 0;
let forceAbsSum = 0;
let forceSamples = 0;
let forceMin = 9;
let forceMax = -9;
let emptyBid = 0;
let emptyAsk = 0;
let bookSamples = 0;

function countDualSide(g) {
  let bad = 0;
  for (const acc of g.store.all()) {
    for (const sid of acc.longs.keys()) {
      if (acc.longQty(sid) > 0 && acc.shortQty(sid) > 0) bad += 1;
    }
  }
  return bad;
}

function run(seed) {
  // 固定伪随机序列，保证 A/B 面对同一串掷骰
  let s = seed >>> 0;
  const seq = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const realRandom = Math.random;
  Math.random = seq;

  clock = 1790000000000;
  liqCount = 0;
  setMode(MODE);
  const g = new Game();
  const now0 = clock;
  for (const st of config.stocks) g.npcs.get(st.id).init(now0);

  const open = new Map();
  for (const man of g.npcs.values()) {
    const ob = man.beginIntent.bind(man);
    const oe = man.endIntent.bind(man);
    man.beginIntent = (mode) => {
      const started = ob(mode);
      if (started) {
        let instQty = 0;
        for (const x of man.npcs) if (x.type === 'inst') instQty += x.acc.longQty(man.stock.id);
        intentStats[mode].n += 1;
        open.set(man, { mode, px: man.market.lastPrice, t: man.tickCount, instQty });
      }
      return started;
    };
    man.endIntent = () => {
      const o = open.get(man);
      if (o) {
        const dur = man.tickCount - o.t;
        if (dur < 5) shortIntents[o.mode] += 1; // 短命意图 = 空转，应为 0
        if (dur < minDur[o.mode]) minDur[o.mode] = dur;
        intentStats[o.mode].ret.push(man.market.lastPrice / o.px - 1);
        let instQty = 0;
        for (const x of man.npcs) if (x.type === 'inst') instQty += x.acc.longQty(man.stock.id);
        intentStats[o.mode].instDelta.push(
          (instQty - o.instQty) / (man.stock.floatShares * 0.32)
        );
        if (o.lurePx) mainRet[o.mode].push(man.market.lastPrice / o.lurePx - 1);
        open.delete(man);
      }
      oe();
    };
  }

  const tickMs = config.tickIntervalMs;
  let stalls = 0;
  let still = 0;
  const lastPx = new Map();
  // 空头存量峰值只能逐 tick 自己记：`shortHistory` 已改成「每个交易日收盘一点」的
  // 披露序列（融券 tab 用），探针跑几十个 tick 根本攒不出一个点
  const shortPeak = new Map();
  let slowest = 0;
  let totalMs = 0;
  const t0 = realNow();

  for (let i = 0; i < TICKS; i++) {
    clock += tickMs;
    const a = realNow();
    g.tick();
    const dur = realNow() - a;
    totalMs += dur;
    if (dur > slowest) slowest = dur;

    for (const st of config.stocks) {
      const m = g.markets.get(st.id);
      const man = g.npcs.get(st.id);
      // 盘口空档率只在**连续竞价时段**采样：引入「天」之后夜间有日终结算
      // （委托当日全部作废）与两段集合竞价（只累积不连续撮合），
      // 这些 tick 里簿本来就是空的/不撮合的，混进来会把空档率从 1% 量级抬到 15%，
      // 指标直接失去分辨力（实测：不经过滤买盘空 15.57%，改动前后一样高）
      const phase = g.day && g.day.ok ? g.day.locate(clock) : null;
      if (!phase || (phase.phase.trading && !phase.phase.auction)) {
        bookSamples += 1;
        if (m.book.bids.length === 0) emptyBid += 1;
        if (m.book.asks.length === 0) emptyAsk += 1;
      }
      if (m.shortInterest > (shortPeak.get(st.id) || 0)) shortPeak.set(st.id, m.shortInterest);
      if (lastPx.get(st.id) === m.lastPrice) {
        still += 1;
        if (still === 300) stalls += 1; // 价格连续 300 tick 不动 = 冻结
      } else {
        still = 0;
        lastPx.set(st.id, m.lastPrice);
      }
      if (man.intent.mode !== 'none') {
        intentStats[man.intent.mode].ticks += 1;
        const o = open.get(man);
        if (o && !o.lurePx && man.intent.lure > 0 && man.intent.age === man.intent.lure) {
          o.lurePx = man.market.lastPrice;
          lureRet[o.mode].push(man.market.lastPrice / o.px - 1);
        }
      }
      forceSamples += 1;
      forceSum += man.force;
      forceAbsSum += Math.abs(man.force);
      if (man.force < forceMin) forceMin = man.force;
      if (man.force > forceMax) forceMax = man.force;
      if (man.force >= 0.25) forceTicks.up += 1;
      else if (man.force <= -0.25) forceTicks.down += 1;
      else forceTicks.flat += 1;
    }
  }
  const wall = realNow() - t0;

  const ranges = [];
  for (const st of config.stocks) {
    const mk = g.markets.get(st.id);
    const px = mk.priceHistory.map((p) => p.price);
    ranges.push({
      ret: px[px.length - 1] / px[0] - 1,
      hi: Math.max(...px) / st.initPrice - 1,
      lo: Math.min(...px) / st.initPrice - 1,
      vol: mk.volume,
      shortPeak: shortPeak.get(st.id) || 0,
    });
  }
  Math.random = realRandom;
  return { wall, tickAvg: totalMs / TICKS, slowest, stalls, dual: countDualSide(g), liq: liqCount, ranges };
}

console.log(`\n=== NPC 行为探针 [${MODE}] ${SEEDS} 局 × ${TICKS} tick ===`);
const agg = [];
for (let i = 0; i < SEEDS; i++) {
  const r = run(1000 + i * 7919);
  agg.push(r);
  const vols = r.ranges.map((x) => x.vol / 1e4);
  console.log(
    `  局${i + 1}: tick均 ${r.tickAvg.toFixed(1)}ms 峰值 ${r.slowest}ms | 冻结段 ${r.stalls} | 违规 ${r.dual} | 强平 ${r.liq} | ` +
      `区间幅度 ${Math.max(...r.ranges.map((x) => x.hi - x.lo)).toFixed(1)}~${Math.min(...r.ranges.map((x) => x.hi - x.lo)).toFixed(1)} | ` +
      `成交量(万股) ${Math.min(...vols).toFixed(0)}~${Math.max(...vols).toFixed(0)}`
  );
}
const sum = (f) => agg.reduce((a, r) => a + f(r), 0);
const allR = agg.flatMap((r) => r.ranges);
console.log(
  `\n  合计: tick均 ${(sum((r) => r.tickAvg) / SEEDS).toFixed(1)}ms | 冻结段 ${sum((r) => r.stalls)} | ` +
    `违规 ${sum((r) => r.dual)} | 强平 ${sum((r) => r.liq)} | 区间幅度均值 ${(
      (allR.reduce((a, x) => a + (x.hi - x.lo), 0) / allR.length) * 100
    ).toFixed(1)}% | 空头顶峰均值 ${(allR.reduce((a, x) => a + x.shortPeak, 0) / allR.length / 1e4).toFixed(0)} 万股`
);
const pct = (arr) =>
  arr.length ? `${((arr.reduce((a, b) => a + b, 0) / arr.length) * 100).toFixed(2)}% (${arr.length})` : '--';
const byMode = (f) =>
  JSON.stringify(Object.fromEntries(Object.keys(intentStats).map((k) => [k, f(k)])));
console.log(
  '  意图:',
  byMode((k) => ({
    次数: intentStats[k].n,
    占比: `${((intentStats[k].ticks / (SEEDS * TICKS * config.stocks.length)) * 100).toFixed(2)}%`,
    全程收益: pct(intentStats[k].ret),
    机构库存变化: pct(intentStats[k].instDelta),
  }))
);
console.log('  诱阶段收益:', byMode((k) => pct(lureRet[k])));
console.log('  短命意图(<5 tick):', JSON.stringify(shortIntents), '最短时长:', JSON.stringify(minDur));
const ft = forceTicks.up + forceTicks.flat + forceTicks.down;
console.log(
  `  力量天平: 多头占优 ${((forceTicks.up / ft) * 100).toFixed(1)}% / 势均力敌 ${(
    (forceTicks.flat / ft) * 100
  ).toFixed(1)}% / 空头占优 ${((forceTicks.down / ft) * 100).toFixed(1)}% | 均值 ${(forceSum / forceSamples).toFixed(
    3
  )} 区间 [${forceMin.toFixed(2)}, ${forceMax.toFixed(2)}]`
);
console.log(
  `  盘口空档率: 买盘空 ${((emptyBid / bookSamples) * 100).toFixed(3)}% / 卖盘空 ${(
    (emptyAsk / bookSamples) * 100
  ).toFixed(3)}%`
);
console.log('  强平角色归因:', JSON.stringify(liqByRole));
