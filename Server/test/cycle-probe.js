/**
 * 行情周期层长程探针（**手动运行，不在 npm test 里**）：
 *
 *   node test/cycle-probe.js [局数] [天数]
 *
 * 纯内存 `new Game()`，不注入 persist，**不碰正式存档**。受控时钟。
 * 目的是核对 config.npc.cycle 是否真的走出周月级牛熊，而不是「看起来有趋势」：
 *   ① 半年（111 游戏日）内每只股票是否出现 ≥+50% 单边行情、≥−30% 回撤
 *   ② 半年净涨跌分布
 *   ③ VR20（20 日方差比，随机游走 ≈1，均值回归 ≪1）
 *   ④ 日收益自相关（可预测性）
 *   ⑤ 日收益 std / 开盘跳空 std（回归日内手感）
 */
const path = require('path');
const SERVER = path.join(__dirname, '..', 'src');
const config = require(path.join(SERVER, 'config.js'));
const { Game } = require(path.join(SERVER, 'game.js'));
const { Market } = require(path.join(SERVER, 'market.js'));

const SEEDS = Number(process.argv[2] || 3);
const DAYS = Number(process.argv[3] || 111);

const TICK_MS = config.tickIntervalMs || 700;
const DAY_MS = (config.day.phases || []).reduce((a, p) => a + p.ms, 0) || 620000;

let clock = 1800000000000;
Date.now = () => clock;

let liqCount = 0;
for (const fn of ['forceSellLong', 'forceCoverShort']) {
  const orig = Market.prototype[fn];
  Market.prototype[fn] = function (acc, ...rest) {
    liqCount += 1;
    return orig.call(this, acc, ...rest);
  };
}

function quantile(arr, q) {
  if (!arr.length) return NaN;
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)));
  return a[i];
}
const pct = (x) => (Number.isNaN(x) ? '--' : (x * 100).toFixed(2) + '%');
const pct1 = (x) => (Number.isNaN(x) ? '--' : (x * 100).toFixed(1) + '%');

function acf1(xs) {
  if (xs.length < 3) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    den += (xs[i] - m) ** 2;
    if (i > 0) num += (xs[i] - m) * (xs[i - 1] - m);
  }
  return den === 0 ? NaN : num / den;
}

/** VR(k)：k 日收益方差 / (k × 1 日收益方差)。随机游走 ≈1，均值回归 <1，趋势 >1 */
function varianceRatio(rets, k) {
  const r1 = rets;
  if (r1.length < k + 5) return NaN;
  const v1 = r1.reduce((a, b) => a + b * b, 0) / r1.length; // 均值已近 0
  const rk = [];
  for (let i = k; i < r1.length; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += r1[i - j];
    rk.push(s);
  }
  const vk = rk.reduce((a, b) => a + b * b, 0) / rk.length;
  return vk / (k * v1);
}

const hits50 = 0;
const hit50 = [];
const hit30 = [];
const netChange = [];
const vr20s = [];
const acfs = [];
const dailyRets = [];
const gaps = [];
let pinned = 0;
let samples = 0;

for (let s = 0; s < SEEDS; s++) {
  clock = 1800000000000 + s * 1000000000;
  const g = new Game();
  g.start();

  // 每股：按交易日收盘价序列 + 当日跳空
  const series = new Map(); // stockId -> [open, close...]
  for (const st of config.stocks) series.set(st.id, []);

  let inDay = -1;
  const origSettle = g.settleDay.bind(g);
  g.settleDay = function (now, opts) {
    const dayKey = g.day.ok ? g.day.locate(now).day : 0;
    if (dayKey !== inDay && dayKey > 0) {
      inDay = dayKey;
      for (const st of config.stocks) {
        const m = g.markets.get(st.id);
        const arr = series.get(st.id);
        if (m.prevClose > 0 && m.open > 0 && m.lastPrice > 0) {
          gaps.push((m.open - m.prevClose) / m.prevClose);
          arr.push(m.lastPrice);
        }
        // 贴板采样（连续竞价才贴得住）
        const b = m.band();
        if (b && (m.lastPrice >= b.up - 1e-9 || m.lastPrice <= b.down + 1e-9)) pinned += 1;
        samples += 1;
      }
    }
    return origSettle(now, opts);
  };

  const ticks = Math.ceil((DAYS * DAY_MS) / TICK_MS);
  const t0 = Date.now; // 真实墙钟（Date.now 已被换成假时钟）
  const realNow = () => Number(process.hrtime.bigint() / 1000000n);
  const wall0 = realNow();
  for (let i = 0; i < ticks; i++) {
    clock += TICK_MS;
    g.tick();
    if (i > 0 && i % (886 * 10) === 0) {
      console.log(`  [seed ${s}] ${Math.floor(i / 886)} / ${DAYS} 天 · 墙钟 ${((realNow() - wall0) / 1000).toFixed(0)}s`);
    }
  }
  g.stop?.();
  console.log(`  [seed ${s}] 完成 ${DAYS} 天 · 墙钟 ${((realNow() - wall0) / 1000).toFixed(0)}s`);

  for (const st of config.stocks) {
    const px = series.get(st.id);
    if (px.length < 10) continue;
    // 单边行情：最大峰谷（相对同一序列）
    let peak = px[0];
    let maxUp = 0; // max(peak/trough-1)
    let maxDd = 0; // max(1-trough/peak)
    peak = px[0];
    for (const p of px) {
      if (p > peak) peak = p;
      if (peak > 0) maxDd = Math.max(maxDd, 1 - p / peak);
    }
    let trough = px[0];
    for (const p of px) {
      if (p < trough) trough = p;
      if (trough > 0) maxUp = Math.max(maxUp, p / trough - 1);
    }
    if (maxUp >= 0.5) hit50.push({ seed: s, stock: st.id, maxUp });
    if (maxDd >= 0.3) hit30.push({ seed: s, stock: st.id, maxDd });
    netChange.push(px[px.length - 1] / px[0] - 1);

    const rets = [];
    for (let i = 1; i < px.length; i++) rets.push(Math.log(px[i] / px[i - 1]));
    dailyRets.push(...rets);
    const vr = varianceRatio(rets, 20);
    if (!Number.isNaN(vr)) vr20s.push(vr);
    const ac = acf1(rets);
    if (!Number.isNaN(ac)) acfs.push(ac);
  }
}

const abs = dailyRets.map((x) => Math.abs(Math.exp(x) - 1));
const dmean = dailyRets.reduce((a, b) => a + b, 0) / Math.max(1, dailyRets.length);
const dsd = Math.sqrt(
  dailyRets.reduce((a, b) => a + (b - dmean) ** 2, 0) / Math.max(1, dailyRets.length - 1)
);

const totalStocks = SEEDS * config.stocks.length;
console.log(`\n=== 周期层长程探针：${SEEDS} 局 × ${DAYS} 游戏日 × ${config.stocks.length} 股 ===`);
console.log(
  `出现 ≥+50% 单边行情: ${hit50.length}/${totalStocks} 股` +
    `（目标：半年内大多数标的会出现）`
);
console.log(
  `出现 ≥−30% 回撤: ${hit30.length}/${totalStocks} 股`
);
console.log(
  `半年净涨跌: 中位 ${pct1(quantile(netChange, 0.5))} | ` +
    `p25 ${pct1(quantile(netChange, 0.25))} | p75 ${pct1(quantile(netChange, 0.75))} | ` +
    `≥+50% 的股 ${netChange.filter((x) => x >= 0.5).length}/${netChange.length}`
);
console.log(
  `VR20（20 日方差比，随机游走≈1）: 中位 ${quantile(vr20s, 0.5)?.toFixed?.(2) ?? quantile(vr20s, 0.5)} | ` +
    `p25 ${quantile(vr20s, 0.25)?.toFixed?.(2)} | p75 ${quantile(vr20s, 0.75)?.toFixed?.(2)}`
);
console.log(`日收益自相关 acf1: 中位 ${quantile(acfs, 0.5)?.toFixed?.(3)}`);
console.log(
  `|日收益| 中位 ${pct1(quantile(abs, 0.5))} | p90 ${pct1(quantile(abs, 0.9))} | std ${pct(dsd)}`
);
if (gaps.length) {
  const gm = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const gsd = Math.sqrt(gaps.reduce((a, b) => a + (b - gm) ** 2, 0) / (gaps.length - 1));
  console.log(`开盘跳空 std ${pct(gsd)} | 中位 |跳空| ${pct1(quantile(gaps.map(Math.abs), 0.5))}`);
}
console.log(`贴板采样（收盘价贴涨跌停）: ${samples ? ((pinned / samples) * 100).toFixed(1) : 0}%`);
console.log(`强平调用次数: ${liqCount}`);
console.log(`（每股最大单边涨幅样本）${hit50.slice(0, 5).map((h) => h.stock + ':' + pct1(h.maxUp)).join(' ') || '—'}`);

// 内生正反馈质感：涨跌不对称（恐慌应比贪婪猛）
{
  const gains = [];
  const losses = [];
  for (const x of dailyRets) {
    const r = Math.exp(x) - 1;
    if (r > 0) gains.push(r);
    else losses.push(-r);
  }
  const q = quantile;
  console.log('\n--- 质感（不对称）---');
  if (gains.length && losses.length) {
    console.log(
      `单日涨幅 p90 ${pct1(q(gains, 0.9))} / 最大 ${pct1(q(gains, 1))} | ` +
        `单日跌幅 p90 ${pct1(q(losses, 0.9))} / 最大 ${pct1(q(losses, 1))}`
    );
    console.log(
      `|跌|/|涨| 均值比 ${(
        losses.reduce((a, b) => a + b, 0) / losses.length /
        (gains.reduce((a, b) => a + b, 0) / gains.length)
      ).toFixed(2)}（>1 表示跌得更狠）`
    );
    const mean = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
    const sd = Math.sqrt(dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyRets.length);
    const skew =
      sd > 0
        ? dailyRets.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / dailyRets.length
        : 0;
    console.log(`日收益偏度 ${skew.toFixed(2)}（负 = 左肥尾 = 恐慌更极端）`);
  }
  // 磨底：深回撤后的日均振幅是否收窄
  if (vr20s.length) console.log(`VR20 中位再报 ${quantile(vr20s, 0.5)?.toFixed?.(2)}`);
}

// Game 的定时器/句柄可能拖住进程；探针跑完直接退
process.exit(0);
