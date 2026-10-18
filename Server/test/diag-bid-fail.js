/**
 * 买盘挂单失败归因（**手动运行，不在 npm test 里**）：
 *
 *   node test/diag-bid-fail.js [局数] [tick数]
 *
 * 前一个探针（diag-bid-depth）已经证明：买盘为空时 **99.6% 的账户手上挂着卖单、
 * 0% 挂着买单**，而 100% 的账户还有买入空间。说明不是"没人想买"，是 requote()
 * 的买盘分支挂不出来。这个脚本把 `requote` 的买盘判定链逐步复算一遍（只读，不改状态），
 * 统计空档时刻每个账户卡在哪一步。
 */
const path = require('path');
const SERVER = path.join(__dirname, '..', 'src');
const config = require(path.join(SERVER, 'config.js'));
const { Game } = require(path.join(SERVER, 'game.js'));
const { ACTIONS } = require(path.join(SERVER, 'market.js'));

const SEEDS = Number(process.argv[2] || 2);
const TICKS = Number(process.argv[3] || 1500);

const realNow = Date.now;
let clock = 1790000000000;
Date.now = () => clock;

const why = {
  noCash: 0,
  wantShortNoPos: 0,
  blockOpenBuy: 0,
  noCap: 0,
  coverFail: 0,
  openFail: 0,
  wouldQuote: 0,
  hasBid: 0,
  total: 0,
};
const byType = {};
let emptySamples = 0;

function diagnose(man) {
  const m = man.market;
  const lot = man.stock.lotSize;
  const lastPx = m.lastPrice || 1;
  for (const n of man.npcs) {
    why.total += 1;
    const live = n.ownResting.filter((o) => o.status === 'live');
    if (
      live.some((o) => o.action === ACTIONS.BUY_OPEN || o.action === ACTIONS.BUY_CLOSE)
    ) {
      why.hasBid += 1;
      continue;
    }
    const p = man.profileOf(n);
    const fv = man.valueOf(p);
    const qlw = man.quoteLastWeight(p);
    const base = qlw * lastPx + (1 - qlw) * fv;
    const ie = man.intentEffects(n);
    let center = base * (1 + (n.sentiment || 0) * (p.centerShift != null ? p.centerShift : 0.006));
    if (ie && ie.pressDown) center *= 1 - ie.pressDown;
    const cush = man.quoteCushion();
    center = Math.min(lastPx * (1 + cush), Math.max(lastPx * (1 - cush), center));
    const sr = p.spread || [0.001, 0.003];
    const spread = Math.max(0.02, base * ((sr[0] + sr[1]) / 2) * man._mul.spread);
    const bidPx = m.clampPrice(center - spread / 2);
    const shortQty = n.acc.shortQty(man.stock.id);
    const wantShort = !!n.wantShort;
    const key = n.type;
    byType[key] = byType[key] || { total: 0, ok: 0 };

    if (!(!wantShort || shortQty > 0) || !(bidPx > 0.01)) {
      why.wantShortNoPos += 1;
      byType[key].total += 1;
      continue;
    }
    const coverable = n.acc.coverableShort(man.stock.id);
    if (coverable >= lot) {
      const cap = man.closeCapacity(n, bidPx, 100 * lot);
      if (cap < lot) {
        why.coverFail += 1;
        byType[key].total += 1;
        continue;
      }
      why.wouldQuote += 1;
      byType[key].ok += 1;
      byType[key].total += 1;
      continue;
    }
    const blockOpenBuy = wantShort || !!(ie && ie.suppressOpenBuy);
    if (shortQty !== 0 || blockOpenBuy) {
      why.blockOpenBuy += 1;
      byType[key].total += 1;
      continue;
    }
    if (man.longCapacity(n) < lot) {
      why.noCap += 1;
      byType[key].total += 1;
      continue;
    }
    if (man.cashCapacity(n, bidPx) < lot) {
      why.noCash += 1;
      byType[key].total += 1;
      continue;
    }
    why.wouldQuote += 1;
    byType[key].ok += 1;
    byType[key].total += 1;
  }
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
  for (let i = 0; i < TICKS; i++) {
    clock += config.tickIntervalMs;
    g.tick();
    const loc = g.day && g.day.ok ? g.day.locate(clock) : null;
    if (loc && loc.phase && loc.phase.auction) continue;
    for (const st of config.stocks) {
      const m = g.markets.get(st.id);
      if (m.book.bids.length) continue;
      emptySamples += 1;
      diagnose(g.npcs.get(st.id));
    }
  }
}

for (let k = 0; k < SEEDS; k++) run(211 + k * 3571);

const pct = (x) => `${((x / Math.max(1, why.total)) * 100).toFixed(2)}%`;
console.log(`\n=== 买盘挂单失败归因 ${SEEDS} 局 × ${TICKS} tick ===`);
console.log('  买盘为空的采样数:', emptySamples);
console.log('  账户-采样数:', why.total);
console.log('  已经挂着买单:', pct(why.hasBid));
console.log('  → 判定链本可以挂出买单:', pct(why.wouldQuote));
console.log('  卡在「空头阵营且无空头仓位」:', pct(why.wantShortNoPos));
console.log('  卡在「意图抑制开多 / 营地互斥」:', pct(why.blockOpenBuy));
console.log('  卡在「买入额度已满」:', pct(why.noCap));
console.log('  卡在「现金不够一手」:', pct(why.noCash));
console.log('  卡在「有券可回补但买不起」:', pct(why.coverFail));
console.log('\n  分类型（本可挂出买盘 / 采样）:');
for (const [k, v] of Object.entries(byType)) {
  console.log(`    ${k}: ${((v.ok / Math.max(1, v.total)) * 100).toFixed(1)}% (${v.total})`);
}
