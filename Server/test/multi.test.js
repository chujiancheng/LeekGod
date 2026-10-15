/**
 * 多股票与大盘指数专项测试：node test/multi.test.js
 *
 * 覆盖单股时代不存在的东西：10 只股票各自独立的市场/融券池/做市资金、
 * 跨股票的组合保证金口径、按股票记账的利息，以及大盘指数的合成与不可交易。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, ACTIONS } = require('../src/game');
const { Persister } = require('../src/persist');
const config = require('../src/config');

const STOCK_A = config.stocks[0];
const STOCK_B = config.stocks[1];
const ALL_IDS = config.stocks.map((s) => s.id);
// 指数也用同一套 market_state/prices 落盘，读取时同样要把它列进标的清单
const ALL_MARKET_IDS = [...ALL_IDS, config.index.code];

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + msg);
  } else {
    failed += 1;
    console.log('  ✗ ' + msg);
  }
}

/** 起一局纯内存游戏（不启 setInterval），并跑几步让盘口铺开 */
function fresh(ticks = 12) {
  const g = new Game();
  const now = Date.now();
  for (const s of config.stocks) {
    g.npcs.get(s.id).init(now);
    g.markets.get(s.id).priceHistory.push({ t: now, price: g.markets.get(s.id).lastPrice, vol: 0 });
  }
  g.index.update(g.markets, now);
  for (const s of config.stocks) g.npcs.get(s.id).step(now);
  for (let i = 0; i < ticks; i++) g.tick();
  return g;
}

const mkt = (g, s) => g.markets.get(s.id);
const npc = (g, s) => g.npcs.get(s.id);

console.log('\n[1] 十只股票 + 大盘指数就位，每只自成一套市场');
{
  const g = fresh();
  assert(g.stocks.length === 10, `本局 ${g.stocks.length} 只股票`);
  assert(g.markets.size === 11, 'markets 含 10 只股票 + 1 个指数');
  assert(g.npcs.size === 10, '每只股票各一套做市引擎');
  const totalNpc = [...g.npcs.values()].reduce((a, n) => a + n.npcs.length, 0);
  const perStock = Object.values(config.npc.types).reduce((s, t) => s + t.count, 0);
  assert(totalNpc === perStock * 10, `NPC 账户 ${totalNpc} 个（每股 ${perStock}）`);

  // NPC 账户名带股票简称前缀，10 只股票互不覆盖
  const names = new Set();
  let dup = 0;
  for (const n of g.npcs.values()) for (const x of n.npcs) {
    if (names.has(x.acc.name)) dup += 1;
    names.add(x.acc.name);
  }
  assert(dup === 0 && names.size === totalNpc, 'NPC 账户名全局唯一');

  // 每只股票的 NPC 只持有自己那只股票
  const bad = [...g.npcs.values()].find(
    (n) => n.npcs.some((x) => x.acc.longs.size > 1 || !x.acc.longs.has(n.stock.id))
  );
  assert(!bad, '每个 NPC 账户只在自己股票的池子里持仓');

  // 流通盘守恒：每只股票的多头总量 = 该股流通盘（开服无空头）
  for (const s of config.stocks) {
    let q = 0;
    for (const acc of g.store.all()) q += acc.longQty(s.id);
    assert(q === s.floatShares, `${s.name} 持仓合计 = 流通盘 ${s.floatShares}`);
  }
}

console.log('\n[2] 大盘指数：基点 1000，按流通市值加权合成');
{
  const g = fresh(0);
  // 把各股价格复位到开盘价再合成，得到确定性的基点基线
  // （fresh 里的首轮 NPC 报价可能已经成交过，价格未必还在开盘价上）
  for (const s of config.stocks) mkt(g, s).lastPrice = s.initPrice;
  g.index.update(g.markets, Date.now());
  assert(g.index.lastPrice === config.index.base, `开盘点位 = 基点 ${g.index.lastPrice}`);
  assert(g.index.stockId === config.index.code, `指数代码 ${g.index.stockId}`);

  // 权重合计 100%，且与流通市值占比一致
  const sum = g.index.components.reduce((a, c) => a + c.weight, 0);
  assert(Math.abs(sum - 100) < 0.05, `成分权重合计 ${sum.toFixed(2)}%`);
  const capAll = config.stocks.reduce((a, s) => a + s.floatShares * s.initPrice, 0);
  const c0 = g.index.components.find((c) => c.stockId === STOCK_A.id);
  assert(
    Math.abs(c0.weight - (STOCK_A.floatShares * STOCK_A.initPrice / capAll) * 100) < 0.01,
    `${STOCK_A.name} 权重 = 其流通市值占比 ${c0.weight}%`
  );

  // 手算一次：只把 B 的价格翻倍，其余不动，指数应等于 1000×(市值总和/开服市值)
  const before = g.index.lastPrice;
  mkt(g, STOCK_B).lastPrice = STOCK_B.initPrice * 2;
  g.index.update(g.markets, Date.now());
  const capNow = config.stocks.reduce(
    (a, s) => a + s.floatShares * mkt(g, s).lastPrice,
    0
  );
  const expect = Math.round((1000 * capNow) / capAll * 100) / 100;
  assert(g.index.lastPrice === expect, `成分涨跌按市值加权传导（${g.index.lastPrice} = ${expect}）`);
  assert(g.index.lastPrice > before, '成分股上涨带动指数上行');

  // 反过来：把它打回原价，指数应回到基点
  mkt(g, STOCK_B).lastPrice = STOCK_B.initPrice;
  g.index.update(g.markets, Date.now());
  assert(g.index.lastPrice === config.index.base, '价格回落复位，指数回到基点');

  // 指数分时跟着记点
  const h = g.index.priceHistory;
  assert(h.length > 0 && h[h.length - 1].price === g.index.lastPrice, '指数维护自己的分时序列');
}

console.log('\n[3] 指数不可交易：下单/挂借都被拒，但可以看分时');
{
  const g = fresh();
  const lr = g.login('指数玩家');
  const tk = lr.token;
  const r = g.placeOrder(tk, {
    stockId: config.index.code,
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: config.index.base,
  });
  assert(!r.ok && /指数/.test(r.error), `指数下单被拒（${r.error}）`);
  const r2 = g.lend(tk, 100, config.index.code);
  assert(!r2.ok && /未知股票/.test(r2.error), `指数挂借被拒（${r2.error}）`);
  const h = g.historyFor(config.index.code);
  assert(h.ok && Array.isArray(h.priceHistory), '指数分时可读（客户端要画它的走势）');
  assert(!g.resolveStockId(config.index.code), '交易口径不认指数');
  assert(g.resolveMarketId(config.index.code) === config.index.code, '只读口径认指数');
}

console.log('\n[4] 委托按股票路由：互不串簿、互不串号');
{
  const g = fresh();
  const tk = g.login('路由玩家').token;
  const acc = g.store.get('路由玩家');
  const a = mkt(g, STOCK_A);
  const b = mkt(g, STOCK_B);
  const bidsABefore = a.book.bids.length;
  const bidsBBefore = b.book.bids.length;

  // 在 B 上挂一张远低于市价的买单（不成交）
  const price = b.roundPrice(b.lastPrice * 0.9);
  const r = g.placeOrder(tk, { stockId: STOCK_B.id, action: ACTIONS.BUY_OPEN, qty: 100, price });
  assert(r.ok, 'B 股买单成功');
  assert(a.book.bids.length === bidsABefore, 'A 股买盘未受影响（不串簿）');
  assert(b.book.bids.length === bidsBBefore + 1 || !!b.book.orders.get(r.order.id), 'B 股买盘出现该委托');
  assert(r.order.id.startsWith(STOCK_B.id), `委托号带股票前缀（${r.order.id}）`);
  assert(acc.orders.get(r.order.id).stockId === STOCK_B.id, '账户挂单表记录所属股票');

  // 撤单按委托自身所属股票路由
  const rc = g.cancelOrder(tk, r.order.id);
  assert(rc.ok, '撤单按委托所属股票路由成功');
  assert(!acc.orders.has(r.order.id), '撤单后从账户挂单表移除');

  // A 股同号段不冲突：两边的委托号各自递增但带前缀，互不覆盖
  acc.lastOrderAt = null;
  const ra = g.placeOrder(tk, {
    stockId: STOCK_A.id,
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: a.roundPrice(a.lastPrice * 0.9),
  });
  assert(ra.ok && ra.order.id !== r.order.id, '两只股票可同时持有同序号的委托（前缀区分）');
}

console.log('\n[5] 组合保证金：权益跨股票汇总，敞口也按账户合计');
{
  const g = fresh();
  const tk = g.login('组合玩家').token;
  const acc = g.store.get('组合玩家');
  const a = mkt(g, STOCK_A);
  const b = mkt(g, STOCK_B);

  // A 股买开：一路扫到第 5 档，保证有量成交（盘口深度随 NPC 报价波动，不能假设吃满 1000 股）
  const askDepth = a.snapshot().depth.asks;
  const buyA = g.placeOrder(tk, {
    stockId: STOCK_A.id,
    action: ACTIONS.BUY_OPEN,
    qty: 1000,
    price: a.roundPrice((askDepth[askDepth.length - 1] || askDepth[0]).price * 1.005),
  });
  assert(buyA.ok && buyA.order.filled > 0, `A 股买开成交 ${buyA.order.filled} 股`);

  // B 股开空（吃买一，立即成交）——注意冷却，手工把 lastOrderAt 往前拨
  const bidDepth = b.snapshot().depth.bids;
  acc.lastOrderAt = null;
  const shortB = g.placeOrder(tk, {
    stockId: STOCK_B.id,
    action: ACTIONS.SELL_OPEN,
    qty: 1000,
    price: b.roundPrice((bidDepth[bidDepth.length - 1] || bidDepth[0]).price * 0.995),
  });
  assert(shortB.ok && shortB.order.filled > 0, `B 股开空成交 ${shortB.order.filled} 股`);

  const st = g.stateFor(tk);
  assert(st.account.positions.length === 2, '两条持仓切片（两只股票各一）');
  const eqSum =
    st.account.cash +
    st.account.orderFrozen +
    st.account.shortMargin +
    st.account.longValue -
    st.account.shortValue -
    st.account.financeDebt;
  assert(Math.abs(eqSum - st.account.equity) < 0.02, `组合权益自洽（${st.account.equity}）`);
  assert(
    st.account.shortMargin === st.account.positions.reduce((x, p) => x + p.short.margin, 0),
    '空头保证金 = 各股切片之和'
  );
  const own = g.equityOf(acc);
  assert(Math.abs(own - st.account.equity) < 0.02, 'Game.equityOf 与快照口径一致');

  // 单股切片里的强平价必须把其它股票的持仓算进去（否则显示与真实触发点分叉）
  const posB = st.account.positions.find((p) => p.stockId === STOCK_B.id);
  const m = config.margin.maintenance;
  // 与 serializePosition 同一口径：K 里并入「其它股票的净持仓值」（多头市值 − 各自的融资负债 − 空头市值），
  // 维持线那一侧并入「其它股票的敞口」
  let otherNet = 0;
  let otherShortMV = 0;
  for (const [oid] of acc.shorts) {
    if (oid === STOCK_B.id) continue;
    otherShortMV += acc.shortQty(oid) * g.markets.get(oid).lastPrice;
    otherNet -= acc.shortQty(oid) * g.markets.get(oid).lastPrice;
  }
  for (const [oid] of acc.longs) {
    if (oid === STOCK_B.id) continue;
    const mm = g.markets.get(oid);
    otherNet += acc.longQty(oid) * mm.lastPrice - acc.financeDebt(oid);
  }
  const K =
    acc.cash + acc.orderFrozen + acc.shortMargin -
    acc.financeDebt(STOCK_B.id) - acc.totalLendInterestDebt() + otherNet;
  const denom = (1 + m) * acc.shortQty(STOCK_B.id) - acc.longQty(STOCK_B.id);
  const expectLiq = Math.round(((K - m * otherShortMV) / denom) * 100) / 100;
  assert(
    posB.liquidationPrice === expectLiq,
    `跨股票强平价并入其它持仓与维持线（${posB.liquidationPrice} = ${expectLiq}）`
  );
}

console.log('\n[5b] 强平价必须真的骑在维持线上（否则显示与强平脱钩）');
{
  const g = fresh();
  const mA = mkt(g, STOCK_A);
  const mB = mkt(g, STOCK_B);
  // 把价格钉在开盘价，排除 NPC 撮合的噪声
  mA.lastPrice = STOCK_A.initPrice;
  mB.lastPrice = STOCK_B.initPrice;
  const m = config.margin.maintenance;
  const priceOf = (s) => g.priceOf(s);

  // 按开盘价开空：卖出所得入账、扣一半保证金
  const mkShort = (acc, stock, qty) => {
    const proceeds = stock.initPrice * qty;
    const margin = proceeds * config.margin.ratio;
    acc.cash = Math.round((acc.cash + proceeds - margin) * 100) / 100;
    acc.shortMargin = Math.round((acc.shortMargin + margin) * 100) / 100;
    acc.shortPos(stock.id).lots.push({ qty, price: stock.initPrice, margin, reserved: 0 });
  };

  // 空头侧：A、B 各一笔空头 → B 的强平价要同时并进 A 的敞口
  const sh = g.store.createOrGet('强平价玩家');
  mkShort(sh, STOCK_A, 1000);
  mkShort(sh, STOCK_B, 1000);
  const posB = g.stateFor(g.login('强平价玩家').token).account.positions.find((p) => p.stockId === STOCK_B.id);
  const at = (p) => {
    mB.lastPrice = p;
    return { eq: g.equityOf(sh), need: m * sh.totalShortMV(priceOf) };
  };
  const P = posB.liquidationPrice;
  assert(P > 0, `空头强平价非空（${P}）`);
  const hit = at(P);
  // 强平价取整到「分」，容许半档价格分辨率带来的偏差（denom × 0.005）
  const tol = ((1 + m) * sh.shortQty(STOCK_B.id)) * 0.005 + 0.05;
  assert(Math.abs(hit.eq - hit.need) < tol, `恰好骑在维持线上（equity ${hit.eq.toFixed(2)} vs 维持线 ${hit.need.toFixed(2)}）`);
  const above = at(P * 1.01);
  const below = at(P * 0.99);
  assert(above.eq < above.need, '高于显示价即触发强平');
  assert(below.eq > below.need, '低于显示价不触发强平');

  // 多头（融资）侧：B 带融资负债 + A 有多头 → 同理
  const lg = g.store.createOrGet('融资强平价玩家');
  lg.cash = 100000;
  lg.longPos(STOCK_A.id).lots.push({ qty: 1000, price: STOCK_A.initPrice, ts: 0, reserved: 0, debt: 0, principal: 0 });
  lg.longPos(STOCK_B.id).lots.push({ qty: 2000, price: STOCK_B.initPrice, ts: 0, reserved: 0, debt: 1000000, principal: 1000000 });
  const posB2 = g.stateFor(g.login('融资强平价玩家').token).account.positions.find((p) => p.stockId === STOCK_B.id);
  const PL = posB2.liquidationPriceLong;
  assert(PL > 0, `多头强平价非空（${PL}）`);
  mB.lastPrice = PL;
  const hitL = { eq: g.equityOf(lg), need: m * lg.totalLongValue(priceOf) };
  const tolL = ((1 - m) * lg.longQty(STOCK_B.id)) * 0.005 + 0.05;
  assert(Math.abs(hitL.eq - hitL.need) < tolL, `多头侧也骑在维持线上（equity ${hitL.eq.toFixed(2)} vs 维持线 ${hitL.need.toFixed(2)}）`);
  mB.lastPrice = STOCK_B.initPrice;
}

console.log('\n[6] 融券池按股票隔离：挂借、借出、取息都不串池');
{
  const g = fresh();
  const tk = g.login('融券玩家').token;
  const acc = g.store.get('融券玩家');
  const a = mkt(g, STOCK_A);
  const b = mkt(g, STOCK_B);

  const aTotal0 = a.lendTotal;
  const bTotal0 = b.lendTotal;

  // 先在 A 股建仓，再把持仓挂借（挂借量按实际成交到的股数走：盘口深度会波动）
  const askDepth = a.snapshot().depth.asks;
  acc.lastOrderAt = null;
  const buy = g.placeOrder(tk, {
    stockId: STOCK_A.id,
    action: ACTIONS.BUY_OPEN,
    qty: 1000,
    price: a.roundPrice((askDepth[askDepth.length - 1] || askDepth[0]).price * 1.005),
  });
  assert(buy.ok && buy.order.filled > 0, `A 股建仓成功（${buy.order.filled} 股）`);
  const held = Math.floor(acc.longQty(STOCK_A.id) / 100) * 100;
  assert(held > 0, `A 股持仓 ${held} 股`);
  // 锁仓未过不能卖，但挂借只看「可卖」——把批次时间往前拨
  for (const lot of acc.longs.get(STOCK_A.id).lots) lot.ts = Date.now() - 60000;
  const lend = g.lend(tk, held, STOCK_A.id);
  assert(lend.ok, `A 股挂借成功（${lend.error || 'ok'}）`);
  assert(a.lendTotal === aTotal0 + held, `A 股池子增加 ${held}`);
  assert(b.lendTotal === bTotal0, 'B 股池子纹丝不动');
  assert(acc.ledgerOf(STOCK_A.id).lendOffered === held, '挂借记在 A 股的明细上');
  assert(!acc.ledger.get(STOCK_B.id), 'B 股没有产生挂借明细');

  // 撤借也按股票走（撤回一半）
  const back = Math.floor(held / 2 / 100) * 100;
  acc.lastOrderAt = null;
  const un = g.unlend(tk, back, STOCK_A.id);
  assert(un.ok && acc.ledgerOf(STOCK_A.id).lendOffered === held - back, `A 股撤借 ${back} 股`);
  assert(a.lendTotal === aTotal0 + held - back, 'A 股池子同步减少');

  // 在 B 股借券开空，A 股的可借量不受影响
  const bAvail0 = b.lendAvailable();
  const aAvail0 = a.lendAvailable();
  const bidDepth = b.snapshot().depth.bids;
  acc.lastOrderAt = null;
  const bad = g.placeOrder(tk, {
    stockId: STOCK_B.id,
    action: ACTIONS.SELL_OPEN,
    qty: 500,
    price: b.roundPrice((bidDepth[bidDepth.length - 1] || bidDepth[0]).price * 0.995),
  });
  assert(bad.ok && bad.order.filled > 0, `B 股借券开空成交 ${bad.order.filled} 股`);
  assert(a.lendAvailable() === aAvail0, 'A 股可借量不受 B 股开空影响');
  assert(b.lendAvailable() < bAvail0, 'B 股可借量随自家借出减少');
}

console.log('\n[7] 融资/融券利息只按本股票计提');
{
  const g = fresh();
  const acc = g.store.createOrGet('利息玩家');
  // 两只股票各挂一笔融资负债 + 各挂一笔做空欠息
  for (const s of [STOCK_A, STOCK_B]) {
    acc.longPos(s.id).lots.push({ qty: 100000, price: s.initPrice, ts: 0, reserved: 0, debt: 5000000, principal: 5000000 });
    acc.ledgerOf(s.id).lendInterestDebt = 50;
  }
  const debtA0 = acc.financeDebt(STOCK_A.id);
  const debtB0 = acc.financeDebt(STOCK_B.id);

  // 只推进 A 市场的融资利息：B 的负债不能被动到
  mkt(g, STOCK_A).accrueFinanceInterest(Date.now());
  assert(acc.financeDebt(STOCK_A.id) > debtA0, `A 股融资负债上浮 ${acc.financeDebt(STOCK_A.id)}`);
  assert(acc.financeDebt(STOCK_B.id) === debtB0, 'B 股融资负债未被 A 市场计息');
  assert(acc.ledgerOf(STOCK_A.id).financeInterestAccrued > 0, 'A 股累计计息有记录');
  assert(!acc.ledger.get(STOCK_B.id).financeInterestAccrued, 'B 股累计计息仍为 0');

  // 组合权益把两边负债都扣掉
  const eq = g.equityOf(acc);
  const manual =
    acc.cash + acc.orderFrozen + acc.shortMargin +
    acc.longQty(STOCK_A.id) * mkt(g, STOCK_A).lastPrice +
    acc.longQty(STOCK_B.id) * mkt(g, STOCK_B).lastPrice -
    acc.financeDebt(STOCK_A.id) - acc.financeDebt(STOCK_B.id) - 100;
  assert(Math.abs(eq - manual) < 0.01, `组合权益扣净两股负债与欠息（${eq.toFixed(2)}）`);
}

console.log('\n[8] 停牌全市场一致：10 只股票一起停、一起复');
{
  const g = fresh();
  g.halt(5, '多股票停牌测试');
  assert(config.stocks.every((s) => mkt(g, s).isHalted()), '全部股票进入停牌');
  const prices = config.stocks.map((s) => mkt(g, s).lastPrice);
  const idxBefore = g.index.lastPrice;
  for (let i = 0; i < 20; i++) g.tick();
  assert(
    config.stocks.every((s, i) => mkt(g, s).lastPrice === prices[i]),
    '停牌期间所有股票价格冻结'
  );
  assert(g.index.lastPrice === idxBefore, '指数随成分股冻结走平');

  const tk = g.login('停牌玩家').token;
  const r = g.placeOrder(tk, {
    stockId: STOCK_A.id,
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: prices[0],
  });
  assert(!r.ok && /停牌/.test(r.error), '停牌期间下单被拒');

  g.resume();
  assert(config.stocks.every((s) => !mkt(g, s).isHalted()), '复牌后全部股票恢复交易');
}

console.log('\n[9] 存档：11 条行情断点、按股票分账的融券明细、绑股票的自动策略');
{
  const FILE = path.join(os.tmpdir(), `gushen-multi-test-${process.pid}.db`);
  const wipe = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(FILE + suffix, { force: true });
      } catch (e) {
        /* 忽略 */
      }
    }
  };
  wipe();

  const p1 = new Persister(FILE);
  const g1 = new Game({ persist: p1 });
  g1.start();
  g1.stop();

  const tk = g1.login('多股玩家').token;
  const acc1 = g1.store.get('多股玩家');
  // 在 A 股建仓并挂借，同时给 B 股留一条自动策略。
  // 成交股数按实际成交算（不假设吃满），挂借量跟着实际持仓走
  acc1.lastOrderAt = null;
  const askD = mkt(g1, STOCK_A).snapshot().depth.asks;
  const buy1 = g1.placeOrder(tk, {
    stockId: STOCK_A.id,
    action: ACTIONS.BUY_OPEN,
    qty: 500,
    price: mkt(g1, STOCK_A).roundPrice((askD[askD.length - 1] || askD[0]).price * 1.005),
  });
  assert(buy1.ok && buy1.order.filled > 0, `A 股建仓 ${buy1.order.filled} 股`);
  const held1 = Math.floor(acc1.longQty(STOCK_A.id) / 100) * 100;
  assert(held1 > 0, `A 股持仓 ${held1} 股`);
  for (const lot of acc1.longs.get(STOCK_A.id).lots) lot.ts = Date.now() - 60000;
  const lend1 = g1.lend(tk, held1, STOCK_A.id);
  assert(lend1.ok, `A 股挂借 ${held1} 股`);
  const cr = g1.createAuto(tk, {
    type: 'dca',
    stockId: STOCK_B.id,
    params: { amount: 5000, intervalMs: 60000, maxTimes: 0 },
  });
  assert(cr.ok, `在 B 股上创建自动策略（${cr.error || 'ok'}）`);
  g1.tick();

  const beforeCash = acc1.cash;
  const beforeLendA = acc1.ledgerOf(STOCK_A.id).lendOffered;
  const beforeLongA = acc1.longQty(STOCK_A.id);
  p1.close();

  const p2 = new Persister(FILE);
  const snap = p2.loadAll(ALL_MARKET_IDS);
  assert(snap.resumed === true, '存档判定为可续跑');
  assert(snap.markets.size === 11, `11 条行情断点（10 股 + 指数），实际 ${snap.markets.size}`);
  for (const id of ALL_IDS) {
    const m = snap.markets.get(id);
    assert(!!m.state && m.state.last_price > 0, `${id} 有行情断点`);
  }
  assert(snap.markets.get(config.index.code).prices.length > 0, '指数分时也落盘了');

  const g2 = new Game({ persist: p2 });
  g2.start();
  g2.stop();
  const acc2 = g2.store.get('多股玩家');
  assert(acc2.cash === beforeCash, `现金原样恢复 ${acc2.cash}`);
  assert(acc2.longQty(STOCK_A.id) === beforeLongA, 'A 股持仓原样恢复');
  assert(
    acc2.ledgerOf(STOCK_A.id).lendOffered === beforeLendA,
    `A 股挂借原样恢复 ${acc2.ledgerOf(STOCK_A.id).lendOffered}`
  );
  assert(!acc2.longs.has(STOCK_B.id), 'B 股没有凭空多出持仓');

  const autos = g2.auto.listFor('多股玩家');
  assert(autos.length === 1 && autos[0].stockId === STOCK_B.id, '自动策略连同所属股票一起恢复');
  // 每只股票的 NPC 池都重建了报价对象
  const perStock = Object.values(config.npc.types).reduce((s, t) => s + t.count, 0);
  for (const s of config.stocks) {
    assert(npc(g2, s).npcs.length === perStock, `${s.name} 的 NPC 报价对象重建 ${npc(g2, s).npcs.length}`);
  }
  // 各股融券池从各自的挂借量重建
  for (const s of config.stocks) {
    let expect = 0;
    for (const acc of g2.store.all()) {
      const led = acc.ledger.get(s.id);
      if (led) expect += led.lendOffered || 0;
    }
    assert(mkt(g2, s).lendTotal === expect, `${s.name} 融券池重建一致（${expect}）`);
  }
  p2.close();
  wipe();
}

console.log('\n[10] 强平撤单按委托所属股票路由：不留幽灵单、券源占用不串池');
{
  const g = fresh();
  const tk = g.login('跨股强平').token;
  const acc = g.store.get('跨股强平');
  const mA = mkt(g, STOCK_A);
  const mB = mkt(g, STOCK_B);

  // A 股挂两张不会成交的远价单：买开（占冻结）、卖开（占 A 池券源）
  acc.lastOrderAt = null;
  const buyA = g.placeOrder(tk, {
    stockId: STOCK_A.id,
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: mA.roundPrice(mA.lastPrice * 0.9),
  });
  acc.lastOrderAt = null;
  const shortA = g.placeOrder(tk, {
    stockId: STOCK_A.id,
    action: ACTIONS.SELL_OPEN,
    qty: 100,
    price: mA.roundPrice(mA.lastPrice * 1.1),
  });
  assert(buyA.ok && buyA.order.filled === 0, 'A 股远价买单挂出且未成交');
  assert(shortA.ok && shortA.order.filled === 0, 'A 股远价开空单挂出且未成交');
  const aReserved0 = mA.lendReserved;
  assert(aReserved0 >= 100, `A 池券源占用已计入（${aReserved0}）`);

  // 券源占用恒等式：池子记的占用 = 本簿里活着的开空单剩余量合计
  const reservedInBook = (m) =>
    m.book.asks
      .filter((o) => o.action === ACTIONS.SELL_OPEN && o.status === 'live')
      .reduce((a, o) => a + (o.qty - o.filled), 0);
  assert(mA.lendReserved === reservedInBook(mA), '强平前 A 池占用与簿内活单自洽');

  // 在 B 股造一个巨额空头敞口 → 触发 B 市场强平，此时账户的挂单在 A 股簿上
  acc.shortPos(STOCK_B.id).lots.push({ qty: 2000000, price: STOCK_B.initPrice, margin: 0, reserved: 0 });
  mB.shortInterest += 2000000;
  assert(mB.maybeLiquidate(acc, Date.now()), 'B 市场触发强平');

  // 1) A 股的两张挂单必须真的从 A 簿里撤掉（不能只删账户挂单表、把单留在别人簿里）
  for (const id of [buyA.order.id, shortA.order.id]) {
    const inBook =
      mA.book.orders.has(id) ||
      mA.book.bids.some((o) => o.id === id) ||
      mA.book.asks.some((o) => o.id === id);
    assert(!inBook, `A 股挂单 ${id} 已从 A 订单簿移除（不留幽灵单）`);
    assert(!acc.orders.has(id), `A 股挂单 ${id} 已从账户挂单表移除`);
  }
  // 2) 撤单释放的券源记回 A 自己的池子（不能窜到触发强平的 B 池上）
  assert(mA.lendReserved === reservedInBook(mA), `A 池占用与簿内活单仍自洽（${mA.lendReserved}）`);
  assert(mA.lendReserved <= aReserved0 - 100, `A 池那 100 股占用已释放（${aReserved0} → ${mA.lendReserved}）`);
}

console.log('\n[11] 改动股票列表后沿用旧档：不再整局起不来');
{
  const FILE = path.join(os.tmpdir(), `gushen-drop-stock-${process.pid}.db`);
  const wipe = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(FILE + suffix, { force: true });
      } catch (e) {
        /* 忽略 */
      }
    }
  };
  wipe();

  const LAST = config.stocks[config.stocks.length - 1];
  const p1 = new Persister(FILE);
  const g1 = new Game({ persist: p1 });
  g1.start();
  g1.stop();
  const tk1 = g1.login('删股票玩家').token;
  const acc1 = g1.store.get('删股票玩家');
  const m1 = g1.markets.get(LAST.id);
  acc1.lastOrderAt = null;
  const buy = g1.placeOrder(tk1, {
    stockId: LAST.id,
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: m1.roundPrice(m1.lastPrice * 1.02),
  });
  assert(buy.ok && buy.order.filled > 0, `在 ${LAST.name} 建仓 ${buy.order.filled} 股`);
  g1.tick();
  p1.close();

  // 把这只股票从本局配置里摘掉，再拿同一份存档启动
  config.stocks.splice(config.stocks.length - 1, 1);
  const p2 = new Persister(FILE);
  const g2 = new Game({ persist: p2 });
  let started = true;
  try {
    g2.start();
  } catch (e) {
    started = false;
    console.log('    启动异常:', e.message);
  }
  assert(started, '带旧档启动不抛异常');
  if (started) {
    g2.stop();
    const acc2 = g2.store.get('删股票玩家');
    assert(!acc2.longs.has(LAST.id), `已下线标的的持仓不再恢复（遗留 ${acc2.longQty(LAST.id)} 股）`);
    const eq = g2.equityOf(acc2);
    assert(Number.isFinite(eq), `权益仍可计算（${eq.toFixed(2)}）`);
    let tickOk = true;
    try {
      g2.tick();
    } catch (e) {
      tickOk = false;
      console.log('    tick 异常:', e.message);
    }
    assert(tickOk, '主循环 tick 正常');
  }
  p2.close();
  config.stocks.push(LAST); // 还原配置
  wipe();
}

console.log('\n[12] NPC 批次合并：账实等价，玩家账户不受影响');
{
  const g = fresh(20);
  const A = mkt(g, STOCK_A);
  const sid = STOCK_A.id;

  // 1) 手搓一个多批次 NPC：合并前后各聚合量必须逐项相等
  const n0 = npc(g, STOCK_A).npcs[0];
  const acc = n0.acc;
  acc.longs.get(sid).lots = [
    { qty: 1000, price: 20, ts: 5000, reserved: 100, debt: 30, principal: 25 },
    { qty: 300, price: 21.5, ts: 9000, reserved: 0, debt: 7, principal: 5 },
    { qty: 700, price: 19, ts: 7000, reserved: 50, debt: 0, principal: 0 },
  ];
  acc.shorts.set(sid, {
    lots: [
      { qty: 200, price: 22, margin: 2200, reserved: 0 },
      { qty: 400, price: 18, margin: 3600, reserved: 20 },
    ],
  });
  const before = {
    qty: acc.longQty(sid),
    cost: acc.longs.get(sid).lots.reduce((a, l) => a + l.qty * l.price, 0),
    reserved: acc.longs.get(sid).lots.reduce((a, l) => a + l.reserved, 0),
    debt: acc.financeDebt(sid),
    principal: acc.financePrincipal(sid),
    shortQty: acc.shortQty(sid),
    shortCost: acc.shorts.get(sid).lots.reduce((a, l) => a + l.qty * l.price, 0),
    margin: acc.shorts.get(sid).lots.reduce((a, l) => a + l.margin, 0),
    shortReserved: acc.shorts.get(sid).lots.reduce((a, l) => a + l.reserved, 0),
  };
  acc.consolidate(sid);
  const lp = acc.longs.get(sid).lots;
  const sp = acc.shorts.get(sid).lots;
  assert(lp.length === 1 && sp.length === 1, '多头/空头各合并成一条');
  assert(acc.longQty(sid) === before.qty, `合并后多头数量不变（${before.qty}）`);
  assert(Math.abs(lp[0].qty * lp[0].price - before.cost) < 0.01, '合并后成本合计不变');
  assert(lp[0].reserved === before.reserved, `合并后已预留量不变（${before.reserved}）`);
  assert(Math.abs(acc.financeDebt(sid) - before.debt) < 0.01, '合并后融资负债不变');
  assert(Math.abs(acc.financePrincipal(sid) - before.principal) < 0.01, '合并后融资本金不变');
  assert(lp[0].ts === 5000, '锁仓时间取最早批次（口径等同原 FIFO）');
  assert(acc.shortQty(sid) === before.shortQty, `合并后空头数量不变（${before.shortQty}）`);
  assert(Math.abs(sp[0].qty * sp[0].price - before.shortCost) < 0.01, '合并后空头开仓成本不变');
  assert(Math.abs(sp[0].margin - before.margin) < 0.01, `合并后保证金合计不变（${before.margin}）`);
  assert(sp[0].reserved === before.shortReserved, '合并后空头已预留量不变');
  assert(A.lendTotal >= 0 && acc.longQty(sid) === before.qty, '合并后挂借口径不受影响');

  // 2) 跑一轮真实撮合：NPC 一律只剩一条批次，玩家账户不合并
  const g2 = fresh(20);
  let maxLots = 0;
  let worst = '';
  let npcAccounts = 0;
  for (const nm of g2.npcs.values()) {
    for (const x of nm.npcs) {
      npcAccounts += 1;
      const pos = x.acc.longs.get(nm.stock.id);
      const c = pos ? pos.lots.length : 0;
      if (c > maxLots) {
        maxLots = c;
        worst = x.acc.name;
      }
    }
  }
  assert(maxLots <= 1, `${npcAccounts} 个 NPC 账户的批次数都 ≤ 1（实际最多 ${maxLots}：${worst}）`);

  // 玩家：手搓两条批次，跑几步后必须原样保留（不被合并）
  const tk = g2.login('不合并玩家').token;
  const pl = g2.store.get('不合并玩家');
  pl.longPos(sid).lots.push({ qty: 100, price: 19, ts: 0, reserved: 0, debt: 0, principal: 0 });
  pl.longPos(sid).lots.push({ qty: 200, price: 21, ts: 0, reserved: 0, debt: 0, principal: 0 });
  for (let i = 0; i < 6; i++) g2.tick();
  assert(pl.longs.get(sid).lots.length === 2, '玩家账户的批次不被合并（已是 2 条）');
  assert(tk.length > 0 && pl.longQty(sid) === 300, '玩家持仓数量不受 NPC 合并影响');

  // 3) 合并绝不会凭空造股：多头合计不能超过「流通盘 + 玩家手搓的 300 股」
  let total = 0;
  for (const a of g2.store.all()) total += a.longQty(sid);
  const slack = STOCK_A.floatShares + 300;
  assert(total <= slack, `大米多头合计 ${total} 未超过上限 ${slack}`);
  assert(total > STOCK_A.floatShares * 0.99, `大米多头合计 ${total} 仍是流通盘量级`);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
