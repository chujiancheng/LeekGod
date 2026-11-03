/**
 * 换手率调参探针（**手动运行，不在 npm test 里**）
 *
 *   node test/turnover-probe.js [天数] [只数]
 *
 * 环境变量临时覆盖（调参用，不改配置就能扫参数）：
 *   AGG=0.5   → 所有类型的 aggressiveRate 乘这个系数（0 = 只留被动报价）
 *   QTY / REQ → 单笔主动量 / 报价量缩放；PF=0 关浮盈亏、CROSS=0 关跨股
 *
 * 为什么单独写一个：day-probe.js 跑 10 只 × 5 天要几分钟，调参要的是「快跑一轮、
 * 改一个旋钮、再看一眼」。这里只跑 1~2 只股票（把 config.stocks 截断后再 new Game），
 * 一天约十几秒，够用来把「日换手率」从 90% 压到目标 5%。
 *
 * 输出：日换手率、成交笔数、平均单笔股数，以及**按发起方类型**拆的成交量占比，
 * 好判断该调「谁的频率」还是「谁的块头」。
 */
const path = require('path');
const SERVER = path.join(__dirname, '..', 'src');
const config = require(path.join(SERVER, 'config.js'));

const DAYS = Number(process.argv[2] || 1);
const KEEP = Number(process.argv[3] || 1);
config.stocks = config.stocks.slice(0, KEEP);
// 临时旋钮覆盖（调参用）：AGG=0.5 把所有类型的 aggressiveRate 乘这个系数
if (process.env.AGG) {
  const k = Number(process.env.AGG);
  for (const t of Object.values(config.npc.types)) if (t.aggressiveRate) t.aggressiveRate *= k;
}
if (process.env.QTY) {
  const k = Number(process.env.QTY);
  for (const t of Object.values(config.npc.types)) {
    if (t.aggressiveQty) t.aggressiveQty = t.aggressiveQty.map((v) => Math.round(v * k));
  }
}
if (process.env.PF === '0') config.npc.pnlFeel.enabled = false;
if (process.env.CROSS === '0') config.npc.cross.enabled = false;
if (process.env.REQ) {
  const k = Number(process.env.REQ);
  for (const t of Object.values(config.npc.types)) {
    if (t.requoteQty) t.requoteQty = t.requoteQty.map((v) => Math.round(v * k));
  }
}
if (process.env.MMQTY) {
  const k = Number(process.env.MMQTY);
  const mk = config.npc.maker;
  for (const key of ['quoteQty', 'bidQty', 'askQty', 'lotQty']) {
    if (Array.isArray(mk[key])) mk[key] = mk[key].map((v) => Math.round(v * k));
  }
}
config.persistence.enabled = false;

const { Game } = require(path.join(SERVER, 'game.js'));
const { Market } = require(path.join(SERVER, 'market.js'));

const TICK_MS = config.tickIntervalMs;
const DAY_MS = config.day.phases.reduce((a, p) => a + p.ms, 0);

// 受控时钟
let clock = 1800000000000;
Date.now = () => clock;

// 按发起方（主动方账户）拆成交量：place() 里成交时记一笔
const bySide = new Map();
const origTrade = Market.prototype.trade || null;
function note(key, qty) {
  bySide.set(key, (bySide.get(key) || 0) + qty);
}

// 按「发起方 × 挂单方」拆成交量：execute(taker, maker, ...) 是唯一成交口
const pairVol = new Map();
const kindOf = (acc) => {
  if (!acc) return '?';
  if (acc.role) return acc.role; // 'mm' = 券商自营
  if (acc.isNPC) return acc.type || acc.npcType || 'npc';
  return 'player';
};
const origExec = Market.prototype.execute;
Market.prototype.execute = function (taker, maker, price, qty, ...rest) {
  const k = kindOf(taker.account) + '→' + kindOf(maker.account);
  pairVol.set(k, (pairVol.get(k) || 0) + qty);
  return origExec.call(this, taker, maker, price, qty, ...rest);
};

const origPlace = Market.prototype.place;
Market.prototype.place = function (acc, opts) {
  const before = this.trades.length;
  const r = origPlace.call(this, acc, opts);
  if (r && r.ok && this.trades.length > before) {
    const kind = acc && acc.isNPC ? (acc.npcType || acc.type || 'npc') : 'player';
    let q = 0;
    for (let i = before; i < this.trades.length; i++) q += this.trades[i].qty;
    if (q > 0) note(kind, q);
  }
  return r;
};

const stats = [];
for (let s = 0; s < 1; s++) {
  clock = 1800000000000 + s * 1000000000;
  const g = new Game();
  g.start();
  const st = config.stocks[0];
  const m = g.markets.get(st.id);

  // 日终结算会把当日成交量清零，所以在结算那一刻把终值抓下来
  const dayVols = [];
  const origSettle = g.settleDay.bind(g);
  g.settleDay = function (now, opts) {
    const v = m.volume;
    if (v > 0) dayVols.push({ vol: v, turnover: m.turnover });
    return origSettle(now, opts);
  };
  const ticks = Math.ceil((DAYS * DAY_MS) / TICK_MS);
  let tradeCount0 = 0;
  let notional = 0;
  const volByPhase = new Map();
  let lastVol = 0;
  let lastTurnover = 0;
  for (let i = 0; i < ticks; i++) {
    clock += TICK_MS;
    g.tick();
    const d = g.day.locate(clock);
    if (d && d.phase) {
      const dv = m.volume >= lastVol ? m.volume - lastVol : m.volume;
      volByPhase.set(d.phase.key, (volByPhase.get(d.phase.key) || 0) + dv);
    }
    lastVol = m.volume;
    if (m.trades.length > 0) tradeCount0 += 0; // 逐笔被裁剪，改用累计计数
  }
  const sum = dayVols.reduce((a, b) => ({ vol: a.vol + b.vol, turnover: a.turnover + b.turnover }), { vol: 0, turnover: 0 });
  const turn = (sum.vol / st.floatShares) * 100 / Math.max(1, dayVols.length);
  stats.push({ turn, vol: sum.vol, notional: sum.turnover, volByPhase });
  console.log(`已结算 ${dayVols.length} 天 · 逐日换手: ${dayVols.map((d) => ((d.vol / st.floatShares) * 100).toFixed(1) + '%').join(' ')}`);
  console.log(
    `换手 ${turn.toFixed(2)}%/天 | 成交 ${(sum.vol / 1e4).toFixed(0)} 万股 | 额 ${(sum.turnover / 1e8).toFixed(2)} 亿`
  );
  const parts = [...volByPhase.entries()]
    .map(([k, v]) => `${k} ${((v / Math.max(1, sum.vol)) * 100).toFixed(1)}%`)
    .join(' | ');
  console.log('阶段分布:', parts);
  const sides = [...bySide.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${((v / Math.max(1, sum.vol)) * 100).toFixed(1)}%`);
  console.log('按发起方:', sides.join(' | ') || '(n/a)');
  const pairs = [...pairVol.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k} ${((v / Math.max(1, sum.vol)) * 100).toFixed(1)}%`);
  console.log('成交对:', pairs.join(' | '));
  g.stop();
}
