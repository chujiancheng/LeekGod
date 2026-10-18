/**
 * 买盘深度诊断（**手动运行，不在 npm test 里**）：
 *
 *   node test/diag-bid-depth.js [局数] [tick数]
 *
 * 回答一个问题：连续竞价里「买盘五档为空」到底是什么状态造成的。
 * 只采样连续竞价时段（夜间结算 / 集合竞价只累积不撮合，簿本来就空，混进来没意义），
 * 统计三组指标：
 *   ① 档位分布：买盘实际有几档可见（0 档 = 玩家看到整块 "--"）
 *   ② 空档持续长度：是 1 tick 的闪烁，还是几十秒的长时间空窗
 *   ③ 空档时刻的账户状态：现金 / 空头阵营 / 买入空间 / 手上挂着什么单
 * 纯内存 `new Game()`，不注入 persist，不碰正式存档。
 */
const path = require('path');
const SERVER = path.join(__dirname, '..', 'src');
const config = require(path.join(SERVER, 'config.js'));
const { Game } = require(path.join(SERVER, 'game.js'));
const { ACTIONS } = require(path.join(SERVER, 'market.js'));

const SEEDS = Number(process.argv[2] || 3);
const TICKS = Number(process.argv[3] || 2500);

const realNow = Date.now;
let clock = 1790000000000;
Date.now = () => clock;

const levelHist = [0, 0, 0, 0, 0, 0]; // 索引 = 买盘可见档位数（0..5）
let samples = 0;
const streakLen = []; // 每个空段的长度（tick）
const snap = {
  n: 0,
  cashEnough: 0,
  wantShort: 0,
  capOk: 0,
  holdBid: 0,
  holdAsk: 0,
  canQuoteBuy: 0,
  hasShortPos: 0,
  cashSum: 0,
  posSum: 0,
};

function sampleEmpty(man) {
  const lot = man.stock.lotSize;
  const px = man.market.lastPrice || 1;
  const oneLot = px * lot;
  let cash = 0;
  for (const n of man.npcs) {
    snap.n += 1;
    cash += n.acc.cash;
    if (n.acc.cash >= oneLot) snap.cashEnough += 1;
    if (n.wantShort) snap.wantShort += 1;
    const capOk = man.longCapacity(n) >= lot;
    if (capOk) snap.capOk += 1;
    const live = n.ownResting.filter((o) => o.status === 'live');
    const bidLive = live.some(
      (o) => o.action === ACTIONS.BUY_OPEN || o.action === ACTIONS.BUY_CLOSE
    );
    const askLive = live.some(
      (o) => o.action === ACTIONS.SELL_OPEN || o.action === ACTIONS.SELL_CLOSE
    );
    if (bidLive) snap.holdBid += 1;
    if (askLive) snap.holdAsk += 1;
    const shortQty = n.acc.shortQty(man.stock.id);
    if (shortQty > 0) snap.hasShortPos += 1;
    const canBuy =
      n.acc.cash >= oneLot && capOk && (!n.wantShort || shortQty > 0) && !bidLive;
    if (canBuy) snap.canQuoteBuy += 1;
  }
  snap.cashSum += cash;
  snap.posSum += 1;
}

function run(seed) {
  let s = seed >>> 0;
  const seq = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  Math.random = seq;
  clock = 1790000000000;
  const g = new Game();
  for (const st of config.stocks) g.npcs.get(st.id).init(clock);
  const streaks = new Map();
  for (const st of config.stocks) streaks.set(st.id, 0);

  for (let i = 0; i < TICKS; i++) {
    clock += config.tickIntervalMs;
    g.tick();
    const phase = g.day && g.day.ok ? g.day.locate(clock) : null;
    if (phase && !(phase.phase.trading && !phase.phase.auction)) continue;
    for (const st of config.stocks) {
      const m = g.markets.get(st.id);
      const man = g.npcs.get(st.id);
      samples += 1;
      const lv = Math.min(5, m.book.bids.length);
      levelHist[lv] += 1;
      if (!m.book.bids.length) {
        if (!streaks.get(st.id)) sampleEmpty(man);
        streaks.set(st.id, streaks.get(st.id) + 1);
      } else {
        const c = streaks.get(st.id);
        if (c > 0) streakLen.push(c);
        streaks.set(st.id, 0);
      }
    }
  }
  for (const [sid, c] of streaks) if (c > 0) streakLen.push(c);
}

for (let k = 0; k < SEEDS; k++) run(101 + k * 7919);

const pct = (x) => `${((x / samples) * 100).toFixed(3)}%`;
console.log(`\n=== 买盘深度诊断 ${SEEDS} 局 × ${TICKS} tick ===`);
console.log('  采样数（连续竞价）:', samples);
console.log(
  '  买盘可见档位分布:',
  levelHist
    .map((v, i) => `${i}档 ${pct(v)}`)
    .slice(0, 6)
    .join(' / ')
);
streakLen.sort((a, b) => a - b);
const pick = (q) => (streakLen.length ? streakLen[Math.floor((streakLen.length - 1) * q)] : 0);
console.log(
  `  空段数 ${streakLen.length} 段 | 长度中位 ${pick(0.5)} tick / 90分位 ${pick(0.9)} / 最长 ${
    streakLen.length ? streakLen[streakLen.length - 1] : 0
  } tick`
);
const per = (x) => `${((x / Math.max(1, snap.n)) * 100).toFixed(1)}%`;
console.log('\n  买盘为空时刻的账户状态（占账户-采样数的比例）:');
console.log('    账户采样数:', snap.n);
console.log('    现金够挂一手:', per(snap.cashEnough));
console.log('    处于空头阵营:', per(snap.wantShort));
console.log('    还有买入空间:', per(snap.capOk));
console.log('    手上有活买单:', per(snap.holdBid));
console.log('    手上有活卖单:', per(snap.holdAsk));
console.log('    持有空头仓位:', per(snap.hasShortPos));
console.log('    → 当下就能挂买:', per(snap.canQuoteBuy));
console.log('    平均每账户现金:', (snap.cashSum / Math.max(1, snap.posSum)).toFixed(0));
