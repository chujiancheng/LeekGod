/**
 * 交易日尺度探针（**手动运行，不在 npm test 里**）：
 *
 *   node test/day-probe.js [局数] [天数] [on|off|both]
 *
 * 纯内存 `new Game()`，不注入 persist，**不碰正式存档**。
 * 受控时钟：把 Date.now 换成每 tick 前进 tickIntervalMs 的假时钟。
 *
 * 存在的理由：引入「天」之后，**「一天的涨跌幅」成了一个一等的调参轴**。
 * `config.npc.trend` 的幅度参数是按「连续无边的时间轴」标的，而一天只有 620 秒
 * = 886 tick、约 3.4 个趋势段；不把这套参数与"一天"对齐，`priceLimit` 的 ±pct
 * 就会从"熔断器"变成"日内主约束"，价格大面积贴在涨跌停上，市场等于半瘫。
 *
 * 所以要盯的硬指标有两个（和 npc-probe.js 的"买盘空档率 / 强平次数"同级）：
 *   ① **日收益分布**（中位 / p90 / p99）——决定 ±pct 的涨跌停会绑住多少交易日
 *   ② **贴板采样占比 + 最长连板天数**——绑住之后市场是什么观感（贴板自维持就是灾难）
 * `on`/`off` 两跑就是天然对照组：off 给出"原始日波动"，用来定 pct；on 给出实际观感。
 */
const path = require('path');
const SERVER = path.join(__dirname, '..', 'src');
const config = require(path.join(SERVER, 'config.js'));
const { Game } = require(path.join(SERVER, 'game.js'));
const { Market } = require(path.join(SERVER, 'market.js'));

const SEEDS = Number(process.argv[2] || 2);
const DAYS = Number(process.argv[3] || 5);
const WHICH = process.argv[4] || 'both'; // on | off | both

const TICK_MS = config.tickIntervalMs || 700;
const DAY_MS = (config.day.phases || []).reduce((a, p) => a + p.ms, 0) || 620000;

// ── 受控时钟 ──
let clock = 1800000000000;
Date.now = () => clock;

// ── 强平计数（换波动率最容易把连环爆仓一起放大，必须一起盯）──
let liqCount = 0;
for (const fn of ['forceSellLong', 'forceCoverShort']) {
  const orig = Market.prototype[fn];
  Market.prototype[fn] = function (acc, ...rest) {
    liqCount += 1;
    return orig.call(this, acc, ...rest);
  };
}

// ── 集合竞价成交量（按 open / close 分开）──
// 竞价的集中撮合跑在 `Game.onPhaseChange` 里，收盘竞价那次紧接着就被日终结算
// 把 `market.volume` 清零——按 tick 采样永远看不到它（会恒为 0）。直接量 runAuction 的成交股数。
// 竞价种类由 `onPhaseChange` 的 `prev.phase.auction` 给出，比按阶段 key 硬编码稳。
const auctionVol = { open: 0, close: 0 };
let pendingAuction = null;
const origPhase = Game.prototype.onPhaseChange;
Game.prototype.onPhaseChange = function (prev, next, now) {
  pendingAuction = prev && prev.phase && prev.phase.auction ? prev.phase.auction : null;
  try {
    return origPhase.call(this, prev, next, now);
  } finally {
    pendingAuction = null;
  }
};
const origAuction = Market.prototype.runAuction;
Market.prototype.runAuction = function (now, ...rest) {
  const r = origAuction.call(this, now, ...rest);
  if (pendingAuction && r && r.qty > 0) auctionVol[pendingAuction] += r.qty;
  return r;
};

function quantile(arr, q) {
  if (!arr.length) return NaN;
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)));
  return a[i];
}
const pct = (x) => (Number.isNaN(x) ? '--' : x.toFixed(2) + '%');

function run(limitOn) {
  config.priceLimit.enabled = limitOn;
  liqCount = 0;
  auctionVol.open = 0;
  auctionVol.close = 0;
  const daily = []; // 每个「股票×交易日」的日收益率 %
  const streaks = []; // 每只股票的最长连续贴板天数
  const gaps = []; // 每个「股票×交易日」的开盘跳空 %（今开 / 昨收 − 1）
  const turns = []; // 每个「股票×交易日」的换手率 %（成交量 / 流通股）
  const dayVols = []; // 每个「股票×交易日」的日成交量（股）
  const volByPhase = new Map(); // 阶段 key → 累计成交量（股）
  let pinnedSamples = 0;
  let tradingSamples = 0;

  for (let s = 0; s < SEEDS; s++) {
    clock = 1800000000000 + s * 1000000000;
    const g = new Game();
    g.start();

    // 每只股票的贴板连板计数
    const streak = new Map();
    const maxStreak = new Map();
    let inDay = ''; // 避免同一天结算多次时重复计数
    for (const st of config.stocks) {
      streak.set(st.id, 0);
      maxStreak.set(st.id, 0);
    }

    const origSettle = g.settleDay.bind(g);
    g.settleDay = function (now, opts) {
      const dayKey = g.day.ok ? g.day.locate(now).day : 0;
      if (dayKey !== inDay) {
        inDay = dayKey;
        for (const st of config.stocks) {
          const m = g.markets.get(st.id);
          if (m.prevClose > 0 && m.lastPrice > 0) {
            daily.push(((m.lastPrice - m.prevClose) / m.prevClose) * 100);
          }
          // 开盘跳空：结算这一刻 prevClose 还是昨收、open 是当天的今开
          if (m.prevClose > 0 && m.open > 0) {
            gaps.push(((m.open - m.prevClose) / m.prevClose) * 100);
          }
          // 换手率与日成交量（真实十只港股换手中位 0.98%、p90 约 1.5%）
          if (m.volume > 0) {
            turns.push((m.volume / st.floatShares) * 100);
            dayVols.push(m.volume);
          }
          // 收盘是否贴板（含恰好等于涨跌停价）
          const b = m.band();
          const pinned = !!(b && (m.lastPrice >= b.up - 1e-9 || m.lastPrice <= b.down + 1e-9));
          const n = pinned ? streak.get(st.id) + 1 : 0;
          streak.set(st.id, n);
          if (n > maxStreak.get(st.id)) maxStreak.set(st.id, n);
        }
      }
      return origSettle(now, opts);
    };

    // 日内量能：按阶段累计成交量增量（volume 在日终结算时归零，回绕时按当日残量算）
    const lastVol = new Map();
    for (const st of config.stocks) lastVol.set(st.id, 0);
    const ticks = Math.ceil((DAYS * DAY_MS) / TICK_MS);
    for (let i = 0; i < ticks; i++) {
      const aucBefore = auctionVol.open + auctionVol.close;
      clock += TICK_MS;
      g.tick();
      // 这一 tick 里被竞价集中撮合掉的量（可能刚被日终结算清零，只能靠上面那个钩子）
      const aucDelta = auctionVol.open + auctionVol.close - aucBefore;
      // 采样：只在连续竞价时段统计"是否贴板"（竞价/休市没有连续价）
      const d = g.day.ok ? g.day.locate(clock) : null;
      if (d) {
        let delta = 0;
        for (const st of config.stocks) {
          const m = g.markets.get(st.id);
          const v = m.volume || 0;
          const prev = lastVol.get(st.id);
          delta += v >= prev ? v - prev : v;
          lastVol.set(st.id, v);
        }
        delta -= aucDelta; // 竞价撮合的量单列，别重复算进连续竞价段
        if (delta > 0) volByPhase.set(d.phase.key, (volByPhase.get(d.phase.key) || 0) + delta);
      }
      if (d && d.phase.trading && !d.phase.auction) {
        for (const st of config.stocks) {
          const m = g.markets.get(st.id);
          const b = m.band();
          if (!b) continue;
          tradingSamples += 1;
          if (m.lastPrice >= b.up - 1e-9 || m.lastPrice <= b.down + 1e-9) pinnedSamples += 1;
        }
      }
    }
    for (const st of config.stocks) streaks.push(maxStreak.get(st.id));
    g.stop?.();
  }

  const abs = daily.map((x) => Math.abs(x));
  const over10 = abs.filter((v) => v > 10.001).length;
  const pinnedPct = tradingSamples ? (pinnedSamples / tradingSamples) * 100 : 0;
  const dmean = daily.reduce((a, b) => a + b, 0) / Math.max(1, daily.length);
  const dsd = Math.sqrt(
    daily.reduce((a, b) => a + (b - dmean) ** 2, 0) / Math.max(1, daily.length - 1)
  );

  console.log(`\n=== priceLimit.enabled = ${limitOn} ===`);
  console.log(
    `样本 ${daily.length} 个「股票×交易日」（${SEEDS} 局 × ${DAYS} 天 × ${config.stocks.length} 股）`
  );
  console.log(
    `|日收益|: 中位 ${pct(quantile(abs, 0.5))} | p75 ${pct(quantile(abs, 0.75))} | ` +
      `p90 ${pct(quantile(abs, 0.9))} | p99 ${pct(quantile(abs, 0.99))} | 最大 ${pct(quantile(abs, 1))}`
  );
  console.log(
    `日收益 std ${pct(dsd)}（真实十只港股近两年 3.10%；|日收益| 真实 1.67/3.01/4.65/10.40%）`
  );
  console.log(`超过 ±10% 的交易日占比: ${((over10 / Math.max(1, abs.length)) * 100).toFixed(1)}%`);
  console.log(
    `连续竞价时段「价格贴在涨跌停上」的采样占比: ${pinnedPct.toFixed(1)}%` +
      `（目标 < 5%）`
  );
  console.log(
    `最长连续贴板天数: 中位 ${quantile(streaks, 0.5)} 天 | p90 ${quantile(streaks, 0.9)} 天 | 最大 ${quantile(
      streaks,
      1
    )} 天`
  );
  console.log(`强平调用次数: ${liqCount}（${(liqCount / Math.max(1, SEEDS * DAYS)).toFixed(1)} 次/天）`);
  const sample = daily.slice(0, 10).map((x) => (x >= 0 ? '+' : '') + x.toFixed(1) + '%');
  console.log(`（前 10 个日收益样本）${sample.join(' ')}`);

  // 开盘跳空：真实十只港股近两年 5030 个「股票×交易日」的 std 1.79%、|跳空| ≥ 3% 占 7.75%
  if (gaps.length) {
    const gm = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const gsd = Math.sqrt(gaps.reduce((a, b) => a + (b - gm) ** 2, 0) / (gaps.length - 1));
    const g3 = gaps.filter((x) => Math.abs(x) >= 3).length / gaps.length;
    const g1 = gaps.filter((x) => Math.abs(x) >= 1).length / gaps.length;
    console.log(
      `开盘跳空: 中位 ${pct(quantile(gaps.map(Math.abs), 0.5))} | std ${gsd.toFixed(2)}% | ` +
        `|跳空| ≥ 1% 占 ${(g1 * 100).toFixed(1)}% | ≥ 3% 占 ${(g3 * 100).toFixed(1)}% （真实 std 1.79% / ≥3% 占 7.75%）`
    );
  }
  // 日内量能：真实港股是 U 型——两段竞价合计约一成，开盘与尾盘各自最重，午间清淡
  const totVol =
    [...volByPhase.values()].reduce((a, b) => a + b, 0) + auctionVol.open + auctionVol.close;
  if (totVol > 0) {
    const share = (k, v) => (((v != null ? v : volByPhase.get(k)) || 0) / totVol) * 100;
    console.log(
      '日内量能占比: ' +
        `开盘竞价 ${share('auction', auctionVol.open).toFixed(1)}% | ` +
        `上午 ${share('morning').toFixed(1)}% | 下午 ${share('afternoon').toFixed(1)}% | ` +
        `收盘竞价 ${share('closeAuction', auctionVol.close).toFixed(1)}%` +
        '（真实为 U 型：两段竞价合计 ~10%，开盘与尾盘的半小时最重、午间清淡）'
    );
  }
  // 换手率：游戏里 NPC 每 tick 都在成交，这个数离真实越远，"竞价占全天一成"就越不可能
  if (turns.length) {
    const stockDays = dayVols.length;
    console.log(
      `日换手率: 中位 ${pct(quantile(turns, 0.5))} | p90 ${pct(quantile(turns, 0.9))}` +
        `（真实十只港股中位 0.98%、p90 约 1.5%）` +
        `｜日均成交 ${(dayVols.reduce((a, b) => a + b, 0) / dayVols.length / 1e4).toFixed(0)} 万股` +
        `｜开盘竞价均量 ${(auctionVol.open / Math.max(1, stockDays) / 1e4).toFixed(0)} 万股` +
        `｜收盘竞价均量 ${(auctionVol.close / Math.max(1, stockDays) / 1e4).toFixed(0)} 万股`
    );
  }
  return { abs, pinnedPct, streaks, gaps, volByPhase, auctionVol, turns };
}

const t0 = Date.now();
if (WHICH !== 'on') run(false);
if (WHICH !== 'off') run(true);
console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
