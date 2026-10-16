/**
 * 持久化往返测试：node test/persist.test.js
 * 覆盖：新开局判定 / 账户与持仓恢复 / 活动委托回填 / 成交流水恢复 / 行情断点续跑 / 令牌免登录
 * 以及最要紧的一条——重启前后总权益与流通盘守恒（不能凭空多钱或少股）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game } = require('../src/game');
const { Persister } = require('../src/persist');
const { ACTIONS } = require('../src/market');
const config = require('../src/config');

// ---- 多股票测试辅助：测试聚焦「大米集团」(config.stocks[0]) ----
// P(g)/N(g)：取某局里大米集团的市场与做市引擎（多股票后 Game 持的是 Map）
const STOCK = config.stocks[0];
const ALL_IDS = config.stocks.map((s) => s.id);
const P = (g) => g.markets.get(STOCK.id);
const N = (g) => g.npcs.get(STOCK.id);
// 本文件要验证开空后的空头批次/保证金落盘，临时放开裸空（生产默认禁止）
config.margin.allowNakedShort = true;
// 涨跌停是日频机制（区间以昨收为基准，一天最多 ±10%）。本文件验的是存档往返，
// 用例里按 0.9 / 1.1 倍打价是常态，开着涨跌停会被拦在门外。
// 涨跌停、集合竞价与日终结算由 test/day.test.js 专门覆盖（那边用真实配置）。
config.priceLimit.enabled = false;

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

const FILE = path.join(os.tmpdir(), `gushen-persist-test-${process.pid}.db`);
function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(FILE + suffix, { force: true });
    } catch (e) {
      /* 忽略清理失败 */
    }
  }
}
cleanup();

const totalLongQty = (game) =>
  game.store.all().reduce((s, a) => s + a.longQty(STOCK.id), 0);
// 流通盘净额 = 多头总量 - 未平空头。开空产生的虚拟流通增量由 shortInterest 记账，
// 所以它才是"没凭空多出股票"的判据（强平走 SYSTEM 兜底时会有偏差，故只比较重启前后）
const floatDelta = (game) => totalLongQty(game) - P(game).shortInterest;
const lotQtyOf = (lots, side, stockId = STOCK.id) =>
  lots.reduce((s, l) => (l.side === side && l.stock_id === stockId ? s + l.qty : s), 0);

// ---------------------------------------------------------------- 第一局
console.log('\n[1] 全新存档被判定为新开一局');
const p1 = new Persister(FILE);
assert(p1.loadAll(ALL_IDS).resumed === false, '空存档 resumed=false');

const g1 = new Game({ persist: p1 });
g1.start();
g1.day.reanchor(Date.now() - 120000);
g1.stop(); // 测试里手动 tick，不要 setInterval

console.log('\n[2] 玩家下单产生持仓 / 空头 / 活动委托');
const login = g1.login('测试玩家');
assert(login.ok, '玩家登录成功');
const acc1 = g1.store.get('测试玩家');
assert(!!acc1, '账户已创建');

// 加钱必须随账户落盘：漏标脏就会在重启后凭空消失
// （加钱开关当前临时关闭，本节直接调 game.deposit，先临时打开）
const depositEnabledBefore = config.account.deposit.enabled;
config.account.deposit.enabled = true;
const dep1 = g1.deposit(login.token, 66666);
config.account.deposit.enabled = depositEnabledBefore;
assert(dep1.ok && acc1.deposited === 66666, `加钱已记账（累计 ${acc1.deposited}）`);

for (let i = 0; i < 5; i++) g1.tick();

// 高价买单：吃 NPC 卖盘成交（noCooldown 跳过 2 秒下单冷却；报价故意远高于盘口，保证必成交）
const buyPrice = P(g1).roundPrice(P(g1).lastPrice * 1.2);
const r1 = P(g1).place(acc1, { action: ACTIONS.BUY_OPEN, qty: 1000, price: buyPrice, now: Date.now(), noCooldown: true });
assert(r1.ok, `可成交买单被接受${r1.ok ? '' : ': ' + r1.error}`);
const filledId = r1.ok ? r1.order.id : '';
for (let i = 0; i < 5; i++) g1.tick();
assert(acc1.longQty(STOCK.id) > 0, `成交后持有多头 ${acc1.longQty(STOCK.id)} 股`);
// 下单即成交：这单从没进过内存挂单表，正是最容易被委托落盘漏掉的一类
assert(!acc1.orders.has(filledId), '即时成交的委托已不在挂单表里');

// 低价买盘：远低于盘口，不会成交，留在订单簿里验证活动委托能否回填
const restPrice = P(g1).roundPrice(P(g1).lastPrice * 0.9);
const r2res = P(g1).place(acc1, { action: ACTIONS.BUY_OPEN, qty: 1000, price: restPrice, now: Date.now(), noCooldown: true });
assert(r2res.ok, `远离盘口的买单被接受${r2res.ok ? '' : ': ' + r2res.error}`);
const restingId = r2res.ok ? r2res.order.id : '';

// 开空：换一个只做空的玩家账户成交（测试玩家已持多头，再卖开会撞同股多空互斥）
const loginS = g1.login('空头玩家');
assert(loginS.ok, '第二个玩家登录成功');
const accS = g1.store.get('空头玩家');
const sellPrice = P(g1).roundPrice(P(g1).lastPrice * 0.8);
const r3 = P(g1).place(accS, { action: ACTIONS.SELL_OPEN, qty: 1000, price: sellPrice, now: Date.now(), noCooldown: true });
assert(r3.ok, `开空委托被接受${r3.ok ? '' : ': ' + r3.error}`);
for (let i = 0; i < 5; i++) g1.tick();
assert(accS.shortQty(STOCK.id) > 0, `成交后持有空头 ${accS.shortQty(STOCK.id)} 股`);
assert(acc1.orders.has(restingId), '活动委托仍在账户挂单表里');

// 融资负债随多头批次落盘：手动挂负债并标脏，重启后必须原样恢复
acc1.longPos(STOCK.id).lots[0].debt = 1234.56;
acc1.longPos(STOCK.id).lots[0].principal = 1000.0;
// 利息累计也是持久化事实（展示"已计息/已付息"用），同样靠这次标脏落盘
acc1.ledgerOf(STOCK.id).financeInterestAccrued = 66.6;
acc1.ledgerOf(STOCK.id).lendInterestPaid = 88.8;
p1.touch(acc1);
g1.tick();
assert(acc1.financeDebt(STOCK.id) > 0, `注入融资负债 ${acc1.financeDebt(STOCK.id)}`);

const before = {
  startedAt: g1.startedAt,
  lastPrice: P(g1).lastPrice,
  prevClose: P(g1).prevClose,
  high: P(g1).high,
  low: P(g1).low,
  volume: P(g1).volume,
  turnover: P(g1).turnover,
  shortInterest: P(g1).shortInterest,
  cash: acc1.cash,
  orderFrozen: acc1.orderFrozen,
  shortMargin: acc1.shortMargin,
  realizedPnL: acc1.realizedPnL,
  deposited: acc1.deposited,
  shortAcc: { cash: accS.cash, orderFrozen: accS.orderFrozen, shortMargin: accS.shortMargin, realizedPnL: accS.realizedPnL },
  financeInterestAccrued: acc1.ledgerOf(STOCK.id).financeInterestAccrued,
  lendInterestPaid: acc1.ledgerOf(STOCK.id).lendInterestPaid,
  lendInterestDebt: acc1.ledgerOf(STOCK.id).lendInterestDebt,
  longQty: acc1.longQty(STOCK.id),
  shortQty: accS.shortQty(STOCK.id),
  lots: acc1.longPos(STOCK.id).lots.map((l) => ({ qty: l.qty, price: l.price, ts: l.ts, reserved: l.reserved, debt: l.debt || 0, principal: l.principal || 0 })),
  tradeCount: acc1.tradeHistory.length,
  pricePoints: P(g1).priceHistory.length,
  tapeCount: P(g1).trades.length,
  totalLong: totalLongQty(g1),
  floatDelta: floatDelta(g1),
  orders: [...acc1.orders.values()].map((o) => ({ id: o.id, price: o.price, qty: o.qty, filled: o.filled, frozen: o.frozen })),
};
assert(before.tradeCount > 0, `产生了 ${before.tradeCount} 条内存成交记录`);
assert(before.floatDelta > 0, `流通盘净额 ${before.floatDelta} 股（多头总量 − 未平空头）`);

p1.close();

// ---------------------------------------------------------------- 第二局
console.log('\n[3] 重启后判定为续跑并恢复账户');
const p2 = new Persister(FILE);
// 先做一次纯读取校验行情断点：start() 会跑一次 NPC 报价步进，可能产生新成交，
// 那之后的价格/成交量已经不属于"重启前"了
const snap2 = p2.loadAll(ALL_IDS);
assert(snap2.resumed === true, '存档被判定为可续跑');
assert(snap2.startedAt === before.startedAt, '开局时间延续（未开新局）');

const g2 = new Game({ persist: p2 });
g2.start();
g2.day.reanchor(Date.now() - 120000);
g2.stop();

const acc2 = g2.store.get('测试玩家');
const accS2 = g2.store.get('空头玩家');
assert(!!acc2, '玩家账户被恢复');
assert(!!accS2, '做空玩家账户被恢复');
assert(!!g2.store.get(`${STOCK.alias}·机构1`) && !!g2.store.get(`${STOCK.alias}·散户220`), 'NPC 账户被恢复');
const expectSlots = Object.values(config.npc.types).reduce((s, t) => s + t.count, 0);
assert(N(g2).npcs.length === expectSlots, `NPC 报价对象重建 ${N(g2).npcs.length} / 期望 ${expectSlots}`);

assert(acc2.cash === before.cash, `现金一致 ${acc2.cash}`);
assert(acc2.orderFrozen === before.orderFrozen, `挂单冻结一致 ${acc2.orderFrozen}`);
assert(acc2.shortMargin === before.shortMargin, `空头保证金一致 ${acc2.shortMargin}`);
assert(accS2.cash === before.shortAcc.cash, `做空账户现金一致 ${accS2.cash}`);
assert(accS2.shortMargin === before.shortAcc.shortMargin, `做空账户保证金一致 ${accS2.shortMargin}`);
assert(accS2.realizedPnL === before.shortAcc.realizedPnL, `做空账户已实现盈亏一致 ${accS2.realizedPnL}`);
assert(acc2.realizedPnL === before.realizedPnL, `已实现盈亏一致 ${acc2.realizedPnL}`);
assert(acc2.deposited === before.deposited, `终身累计加钱一致 ${acc2.deposited}`);
assert(acc2.initialLong === acc1.initialLong, '初始持股标记一致');
assert(acc2.ledgerOf(STOCK.id).financeInterestAccrued === before.financeInterestAccrued, `融资已计息一致 ${acc2.ledgerOf(STOCK.id).financeInterestAccrued}`);
assert(acc2.ledgerOf(STOCK.id).lendInterestPaid === before.lendInterestPaid, `做空已付息一致 ${acc2.ledgerOf(STOCK.id).lendInterestPaid}`);
assert(acc2.ledgerOf(STOCK.id).lendInterestDebt === before.lendInterestDebt, `做空欠息一致 ${acc2.ledgerOf(STOCK.id).lendInterestDebt}`);

console.log('\n[4] 持仓批次（含锁仓时间与预留）完整恢复');
assert(acc2.longQty(STOCK.id) === before.longQty, `多头数量一致 ${acc2.longQty(STOCK.id)}`);
assert(accS2.shortQty(STOCK.id) === before.shortQty, `空头数量一致 ${accS2.shortQty(STOCK.id)}`);
const lots2 = acc2.longPos(STOCK.id).lots.map((l) => ({ qty: l.qty, price: l.price, ts: l.ts, reserved: l.reserved, debt: l.debt || 0, principal: l.principal || 0 }));
assert(JSON.stringify(lots2) === JSON.stringify(before.lots), `多头批次逐笔一致（${lots2.length} 批，含 ts/reserved/debt/principal）`);
assert(lots2.some((l) => l.debt === 1234.56 && l.principal === 1000), '融资负债与本金（1234.56 / 1000）原样恢复');
assert(lots2.some((l) => l.debt === 1234.56), '融资负债 1234.56 原样恢复');
assert(accS2.shortPos(STOCK.id).lots.every((l) => l.margin > 0), '空头批次带保证金');

console.log('\n[5] 活动委托回填订单簿');
assert(acc2.orders.has(restingId), '未成交委托回到账户挂单表');
assert(!!P(g2).book.orders.get(restingId), '未成交委托回到订单簿');
const restored = acc2.orders.get(restingId);
const orig = before.orders.find((o) => o.id === restingId);
assert(restored && restored.frozen === orig.frozen, `委托冻结金额一致 ${restored.frozen}`);
assert(P(g2).orderSeq >= P(g1).orderSeq, `订单号不回退（${P(g2).orderSeq}）`);
// 挂单价 last*0.9，五档会被 300+ NPC 近价报价占满；直接扫全簿价位，不依赖五档快照
const bidPrices = P(g2).book.bids.map((lvl) => lvl.price);
assert(bidPrices.includes(restPrice), `恢复的买单价位出现在买盘全簿（${restPrice}）`);

console.log('\n[6] 行情断点续跑（直接校验存档内容）');
const m2 = snap2.markets.get(STOCK.id).state;
assert(m2.last_price === before.lastPrice, `最新价延续 ${m2.last_price}`);
assert(m2.prev_close === before.prevClose, '昨收参考价延续（涨跌停区间因此不乱）');
assert(m2.high === before.high && m2.low === before.low, '最高/最低价延续');
assert(m2.volume === before.volume, `成交量延续 ${m2.volume}`);
assert(m2.turnover === before.turnover, `成交额延续 ${m2.turnover}`);
assert(m2.short_interest === before.shortInterest, `空头存量延续 ${m2.short_interest}`);
assert(m2.order_seq >= P(g1).orderSeq, `订单号不回退 ${m2.order_seq}`);
// 测试里连续 tick 会落在同一毫秒，而 prices 以 t 为主键（生产 1 秒一 tick 不会撞），
// 所以这里校验序列内容而不是点数
assert(snap2.markets.get(STOCK.id).prices.length > 0, `分时序列恢复 ${snap2.markets.get(STOCK.id).prices.length} 个点`);
const lastPoint = snap2.markets.get(STOCK.id).prices[snap2.markets.get(STOCK.id).prices.length - 1];
assert(lastPoint.price === before.lastPrice, `分时序列末点等于重启前最新价 ${lastPoint.price}`);
assert(snap2.markets.get(STOCK.id).prices.every((p, i, arr) => i === 0 || p.t >= arr[i - 1].t), '分时序列按时间升序');
assert(snap2.markets.get(STOCK.id).tape.length === before.tapeCount, `逐笔成交恢复 ${snap2.markets.get(STOCK.id).tape.length} 条`);
// loadAll 返回的是库里的原始行（game.applySnapshot 才映射成 {seq,...}）
assert(snap2.markets.get(STOCK.id).tape[0].trade_seq >= 1 && snap2.markets.get(STOCK.id).tape[0].t > 0, `逐笔记录带序号与时间 seq=${snap2.markets.get(STOCK.id).tape[0].trade_seq}`);

console.log('\n[7] 令牌与会话（重启不用重新登录）');
assert(!!g2.accountFor(login.token), '原会话令牌可直接使用');
assert(g2.accountFor(login.token).name === '测试玩家', '令牌绑定到正确账户');

console.log('\n[8] 成交与委托记录回填');
assert(acc2.tradeHistory.length > 0, `成交记录恢复 ${acc2.tradeHistory.length} 条`);
assert(acc2.orderHistory.some((o) => o.id === restingId), '委托记录含未成交委托');
const done2 = acc2.orderHistory.find((o) => o.id === filledId);
assert(!!done2, '委托记录含即时成交的那一单');
assert(done2 && done2.status === 'filled' && done2.filled === 1000, '即时成交的终态被正确恢复（filled）');
assert(
  acc2.orderHistory.every((o) => o.id && o.action && o.status),
  '委托记录字段完整（id/action/status）'
);

console.log('\n[9] 账实守恒：重启不产生也不吞掉任何资金和股票');
const accRows = new Map(
  p2.db.prepare('SELECT name, cash, order_frozen FROM accounts').all().map((r) => [r.name, r])
);
const pRow = accRows.get('测试玩家');
assert(!!pRow && Math.abs(pRow.cash - acc1.cash) < 1e-9, `玩家现金原样落盘 ${pRow && pRow.cash}`);
assert(!!pRow && pRow.order_frozen === acc1.orderFrozen, `玩家挂单冻结原样落盘 ${pRow && pRow.order_frozen}`);
const depRow = p2.db.prepare("SELECT deposited FROM accounts WHERE name = '测试玩家'").get();
assert(!!depRow && depRow.deposited === before.deposited, `累计加钱原样落盘 ${depRow && depRow.deposited}`);

let npcBad = null;
for (const n of N(g1).npcs) {
  const row = accRows.get(n.acc.name);
  const want = n.acc.cash + n.acc.orderFrozen; // 报价单不入存档，冻结必须原额退回现金
  if (!row) {
    npcBad = `${n.acc.name} 未落盘`;
    break;
  }
  if (Math.abs(row.cash - want) > 1e-6 || row.order_frozen !== 0) {
    npcBad = `${n.acc.name} 现金 ${row.cash} ≠ ${want}（冻结 ${row.order_frozen}）`;
    break;
  }
}
assert(!npcBad, `NPC 资金守恒：报价单冻结原额退回现金（共 ${N(g1).npcs.length} 个账户）${npcBad ? ' — ' + npcBad : ''}`);
assert(
  lotQtyOf(snap2.lots, 'long') === before.totalLong,
  `持仓总量与重启前一致 ${lotQtyOf(snap2.lots, 'long')} 股`
);
const snapFloat = lotQtyOf(snap2.lots, 'long') - snap2.markets.get(STOCK.id).state.short_interest;
assert(snapFloat === before.floatDelta, `流通盘净额不变 ${snapFloat} 股（多头 − 未平空头）`);

console.log('\n[10] NPC 报价单不入存档，但持仓必须落盘');
const npcFrozenRow = p2.db.prepare('SELECT order_frozen FROM accounts WHERE name = ?').get(`${STOCK.alias}·机构1`);
assert(npcFrozenRow.order_frozen === 0, 'NPC 存档里的挂单冻结为 0（资金不会锁死在报价单上）');
const npcOrderRows = p2.db
  .prepare('SELECT COUNT(*) AS n FROM orders WHERE account IN (SELECT name FROM accounts WHERE is_npc = 1)')
  .get().n;
assert(npcOrderRows === 0, '存档里没有 NPC 报价单（重启重新报价，不留撤不掉的幽灵单）');
const npcReserved = p2.db
  .prepare("SELECT COALESCE(SUM(reserved), 0) AS n FROM lots WHERE account IN (SELECT name FROM accounts WHERE is_npc = 1)")
  .get().n;
assert(npcReserved === 0, 'NPC 批次预留已归零（不会永久锁住可卖数量）');
assert(P(g2).book.bids.length > 0 && P(g2).book.asks.length > 0, '重启后 NPC 双边报价已重建（盘口非空）');
const inst2 = g2.store.get(`${STOCK.alias}·机构1`);
assert(inst2.longQty(STOCK.id) > 0, `NPC 持仓已恢复（机构1 持 ${inst2.longQty(STOCK.id)} 股）`);

console.log('\n[11] 续跑后主循环继续推进');
const pointsBefore = P(g2).priceHistory.length;
for (let i = 0; i < 10; i++) g2.tick();
assert(g2.tickCount === 10, '续跑后 tick 正常推进');
assert(P(g2).lastPrice > 0, `最新价仍在推进 ${P(g2).lastPrice}`);
assert(P(g2).priceHistory.length > pointsBefore, `分时序列继续增长 ${P(g2).priceHistory.length} 个点`);
assert(P(g2).trades.length <= config.market.tradeTapeSize, '逐笔序列滚动正常');
assert(acc2.orders.has(restingId) || !before.orders.some((o) => o.id === restingId), '会话中的委托状态自洽');

p2.close();
cleanup();

console.log('\n[12] 停牌状态跨重启保留（不静默复牌）');
{
  const file = path.join(os.tmpdir(), `gushen-halt-test-${process.pid}.db`);
  const wipe = () => {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  };
  wipe();

  const p = new Persister(file);
  const g = new Game({ persist: p });
  g.start();
    g.day.reanchor(Date.now() - 120000);
  g.halt(30, '跨重启测试');
  const until = P(g).haltUntil;
  g.tick(); // 触发一次 commit，把停牌写进 meta
  g.stop();
  p.close();

  const p2h = new Persister(file);
  const g2h = new Game({ persist: p2h });
  g2h.start();
    g2h.day.reanchor(Date.now() - 120000);
  assert(P(g2h).isHalted(), '重启后仍在停牌');
  assert(P(g2h).haltUntil === until, `停牌截止时间原样恢复 (${P(g2h).haltUntil})`);
  assert(P(g2h).haltReason === '跨重启测试', '停牌原因原样恢复');
  assert(g2h.stateFor('').halt.halted === true, '状态快照带停牌标记');

  // 复牌也要落盘，否则重启又会变回停牌
  g2h.resume();
  g2h.tick();
  g2h.stop();
  p2h.close();

  const p3 = new Persister(file);
  const g3 = new Game({ persist: p3 });
  g3.start();
    g3.day.reanchor(Date.now() - 120000);
  assert(!P(g3).isHalted(), '复牌状态同样跨重启保留');
  g3.stop();
  p3.close();
  wipe();
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
