/**
 * 撮合引擎冒烟测试：node test/market.test.js
 * 本文件覆盖融券开空/保证金/强平链路，需临时打开 allowNakedShort；
 * 生产默认禁止裸空，见 game.test.js 的拦截断言。
 */
const config = require('../src/config');
config.margin.allowNakedShort = true;

const { Market, ACTIONS } = require('../src/market');
const { Account } = require('../src/store');

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

const stock = config.stocks[0];

function fresh() {
  const m = new Market(stock);
  const A = new Account('玩家A');
  const N = new Account('NPC1', true);
  // 测试里的对手盘只负责垫单，本金给足，免得玩家初始资金一调就挂不上大额委托
  N.cash = 100000000;
  return { m, A, N };
}

// ---- 1. 限价撮合 ----
console.log('\n[1] 限价撮合与资金结算');
{
  const { m, A, N } = fresh();
  // NPC 先挂卖单 20.10 x 1000
  const r1 = m.place(N, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20.1, now: 0, noCooldown: true });
  assert(r1.ok, 'NPC 挂卖单成功');
  // 玩家主动买入吃掉
  const r2 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 500, price: 20.1, now: 0 });
  assert(r2.ok && r2.order.filled === 500, '玩家买入 500 股部分成交');
  const expectCash = config.account.initialCash - 500 * 20.1 - 500 * 20.1 * 0.0001;
  assert(Math.abs(A.cash - expectCash) < 0.01, `资金扣减正确 (cash=${A.cash.toFixed(2)})`);
  assert(A.longQty('600001') === 500, '多头持仓 500 股');
  assert(A.orders.size === 0, '完全成交后无挂单');
}

// ---- 2. 剩余挂单与撤单 ----
console.log('\n[2] 剩余挂单与撤单释放冻结');
{
  const { m, A, N } = fresh();
  const r1 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 19.9, now: 0 });
  assert(r1.ok && r1.order.status === 'live', '低于卖价的买单挂入订单簿');
  const frozenAfter = A.orderFrozen;
  assert(frozenAfter > 0, '买入资金已冻结');
  assert(A.cash < config.account.initialCash, '可用资金已扣减');
  const rc = m.cancel(A, r1.order.id, 1);
  assert(rc.ok, '撤单成功');
  assert(Math.abs(A.cash - config.account.initialCash) < 0.01, '撤单后资金全额释放');
  assert(A.orderFrozen === 0, '冻结归零');
}

// ---- 3. T+ 锁仓 ----
console.log('\n[3] T+ 锁仓（买入后 5 分钟不可卖）');
{
  const { m, A, N } = fresh();
  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 300, price: 20.0, now: 0, noCooldown: true });
  const t0 = 1000000;
  m.place(A, { action: ACTIONS.BUY_OPEN, qty: 300, price: 20.0, now: t0 });
  const r1 = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: 300, price: 20.2, now: t0 + 60000 });
  assert(!r1.ok && /锁仓/.test(r1.error), '1 分钟后卖出被拒（锁仓中）');
  const r2 = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: 300, price: 20.2, now: t0 + 5 * 60 * 1000 + 1 });
  // 卖单价 20.2 高于买一可能无对手，先看是否通过锁仓校验
  assert(r2.ok, '5 分钟后卖出通过锁仓校验');
}

// ---- 4. 下单冷却 ----
console.log('\n[4] 下单冷却 2 秒');
{
  const { m, A } = fresh();
  const r1 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 19.5, now: 100000 });
  assert(r1.ok, '第一次下单成功');
  const r2 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 19.5, now: 101000 });
  assert(!r2.ok && /频繁/.test(r2.error), '1 秒内第二次下单被拒');
  const r3 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 19.5, now: 100000 + 2001 });
  assert(r3.ok, '冷却结束后下单成功');
}

// ---- 5. 开空与保证金 ----
console.log('\n[5] 开空保证金与盈亏');
{
  const { m, A, N } = fresh();
  // 玩家开空 1 万股 @20（对手买单）
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 10000, price: 20.0, now: 0, noCooldown: true });
  const r = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 10000, price: 20.0, now: 0 });
  assert(r.ok && r.order.filled === 10000, '开空 1 万股成交');
  assert(A.shortQty('600001') === 10000, '空头持仓 1 万股');
  const expectMargin = 10000 * 20 * 0.5;
  assert(Math.abs(A.shortMargin - expectMargin) < 0.01, `保证金 ${expectMargin} 冻结正确`);
  const eq = A.equity('600001', 20);
  const expectEq = config.account.initialCash - 10000 * 20 * 0.0001;
  assert(Math.abs(eq - expectEq) < 1, `开空后权益≈初始资金−手续费 (eq=${eq.toFixed(2)})`);
}

// ---- 6. 爆仓强平 ----
console.log('\n[6] 价格暴涨触发爆仓强平');
{
  const { m, A } = fresh();
  // 本节只验证爆仓机制，需要够大的本金撑起 10 万股空头（保证金 100 万），
  // 所以本金独立于 config.account.initialCash 显式给足；维持保证金线随之落在 ~23.08
  A.cash = 1000000;
  const N = new Account('接盘N', true);
  N.cash = 100000000; // 接盘方需要足够现金
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 100000, price: 20.0, now: 0, noCooldown: true });
  const r0 = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 100000, price: 20.0, now: 0 });
  assert(r0.ok && r0.order.filled === 100000, '大额开空成交');
  assert(Math.abs(A.shortMargin - 1000000) < 1, '保证金冻结 100 万');

  // 两个 NPC 互相撮合把价格一步步拉到 26（超过维持保证金线 ~23.08）
  const P1 = new Account('拉抬1', true);
  const P2 = new Account('拉抬2', true);
  // 要连着吃 12 档，两边的本金都按测试规模给足
  P1.cash = 100000000;
  P2.cash = 100000000;
  for (let p = 20.5; p <= 26; p += 0.5) {
    m.place(P2, { action: ACTIONS.SELL_OPEN, qty: 1000, price: p, now: 100 + p, noCooldown: true });
    m.place(P1, { action: ACTIONS.BUY_OPEN, qty: 1000, price: p, now: 100 + p, noCooldown: true });
  }
  console.log(`  (最新价=${m.lastPrice}, 玩家空头=${A.shortQty('600001')}, 现金=${A.cash.toFixed(2)})`);
  assert(m.lastPrice >= 26, '价格被拉升到 26');
  // 实盘中由 tick 循环兜底检查所有账户，这里手动触发
  m.maybeLiquidate(A, Date.now());
  console.log(`  (强平后: 空头=${A.shortQty('600001')}, 现金=${A.cash.toFixed(2)}, 权益=${A.equity('600001', m.lastPrice).toFixed(2)})`);
  assert(A.shortQty('600001') < 100000, '爆仓后空头持仓被强平减少');
  const eq = A.equity('600001', m.lastPrice);
  const mv = A.shortMV('600001', m.lastPrice);
  assert(mv === 0 || eq >= 0.3 * mv - 1, '强平后权益满足维持保证金要求');
}

// ---- 7. 平空盈亏 ----
console.log('\n[7] 平空实现盈亏');
{
  const { m, A, N } = fresh();
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20.0, now: 1000, noCooldown: true });
  m.place(A, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20.0, now: 1000 });
  // 价格跌到 19：NPC 挂卖单，玩家买入平空
  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 19.0, now: 2000, noCooldown: true });
  const r = m.place(A, { action: ACTIONS.BUY_CLOSE, qty: 1000, price: 19.0, now: 3001 });
  assert(r.ok && r.order.filled === 1000, '买入平空成交');
  assert(A.shortQty('600001') === 0, '空头持仓归零');
  // 盈亏 = (20-19)*1000 = 1000，扣手续费（开+平）
  const fee = 20 * 1000 * 0.0001 + 19 * 1000 * 0.0001;
  const expectPnl = 1000 - fee;
  assert(Math.abs(A.realizedPnL - expectPnl) < 0.5, `已实现盈亏≈${expectPnl.toFixed(2)} (actual=${A.realizedPnL.toFixed(2)})`);
}

// ---- 8. 资金不足拒绝 ----
console.log('\n[8] 资金不足拒绝买入');
{
  const { m, A } = fresh();
  A.cash = 100;
  const r = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100000, price: 20.0, now: 0 });
  assert(!r.ok && /资金/.test(r.error), '资金不足被拒');
}

// ---- 9. 涨跌停开关 ----
console.log('\n[9] 涨跌停（开启时限制价格）');
{
  const { m, A } = fresh();
  config.priceLimit.enabled = true;
  const r1 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 25.0, now: 0 });
  assert(!r1.ok && /涨跌停/.test(r1.error), '超过涨停价被拒');
  const r2 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 19.0, now: 100 });
  assert(r2.ok, '区间内价格可下单');
  config.priceLimit.enabled = false;
}

// ---- 10. 部分成交不得越量 ----
console.log('\n[10] 对手单部分成交后再吃单不得越量');
{
  const { m, A, N } = fresh();
  const B = new Account('玩家B');
  // N 挂卖 1000，A 先吃 400
  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20.0, now: 1000, noCooldown: true });
  const r1 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 400, price: 20.0, now: 1000 });
  assert(r1.ok && r1.order.filled === 400, '第一笔部分成交 400');
  // B 想吃 800，但卖单只剩 600
  const r2 = m.place(B, { action: ACTIONS.BUY_OPEN, qty: 800, price: 20.0, now: 1000 });
  assert(r2.ok, '第二笔下单成功');
  assert(r2.order.filled === 600, `第二笔只成交剩余 600 (实际 ${r2.order.filled})`);
  assert(A.longQty('600001') === 400 && B.longQty('600001') === 600, '双方持仓 400 + 600');
  assert(N.shortQty('600001') === 1000, `卖方空头合计 1000 (实际 ${N.shortQty('600001')})`);
  // 盘口按剩余量显示
  const r3 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 19.5, now: 3001 });
  assert(r3.ok, '挂单进入订单簿');
  const snap = m.snapshot();
  const bid = snap.depth.bids.find((d) => d.price === 19.5);
  assert(bid && bid.qty === 100, `挂单剩余量正确显示 (盘口 ${bid && bid.qty})`);
  const bid20 = snap.depth.bids.find((d) => d.price === 20.0);
  assert(bid20 && bid20.qty === 200, `部分成交后剩余量 200 (盘口 ${bid20 && bid20.qty})`);
}

// ---- 11. 持仓被强平消耗后，残留挂单不得凭空成交 ----
console.log('\n[11] 持仓被消耗后的残留挂单不得凭空产生现金');
{
  const { m, A, N } = fresh();
  const t = 6 * 60 * 1000;
  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20, now: 0, noCooldown: true });
  m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20, now: 0 });
  const o = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: 1000, price: 30, now: t });
  assert(o.ok && o.order.status === 'live', '挂出卖平多单（预留 1000 股）');
  assert(A.sellableLong('600001', t) === 0, '全部持仓已被该挂单预留');

  // 模拟持仓被强平夺走：只剩挂单，持仓归零
  A.consumeLong('600001', 1000);
  assert(A.longQty('600001') === 0, '持仓已归零（挂单成为残留单）');

  const cashBefore = A.cash;
  const r = m.place(N, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 30, now: t + 1000, noCooldown: true });
  const delta = A.cash - cashBefore;
  assert(Math.abs(A.cash - cashBefore) < 10, `未凭空产生卖出款 (Δ=${delta.toFixed(2)}，仅退回手续费预估)`);
  assert(!m.book.orders.has(o.order.id), '残留挂单已从订单簿清理');
  assert(A.longQty('600001') === 0, '持仓未增加');
  assert(r.ok, '对手买单本身正常受理');
}

// ---- 12. 委托价偏离上限 ----
console.log('\n[12] 委托价过度偏离最新价被拒');
{
  const { m, A } = fresh();
  const r1 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 100, now: 0 });
  assert(!r1.ok && /偏离/.test(r1.error), `偏离 400% 的委托被拒 (${r1.error})`);
  const r2 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 26, now: 3000 });
  assert(r2.ok, '偏离 30% 的委托正常受理');
}

// ---- 13. 系统兜底账户不累积持仓 ----
console.log('\n[13] 系统兜底账户不累积持仓（防内存泄漏）');
{
  const { m, A } = fresh();
  const probe = { id: 'p', side: 'buy', qty: 1, price: 1, account: A, action: ACTIONS.BUY_OPEN };
  const SYS = m.makeGhost(probe).account;
  for (let i = 0; i < 50; i++) {
    A.longPos('600001').lots.push({ qty: 100, price: 20, ts: 0, reserved: 0 });
    m.book.bids.length = 0; // 无买盘 -> 走系统兜底
    m.forceSellLong(A, 100, 1000 + i);
  }
  const p = SYS.longs.get('600001');
  assert(!p || p.lots.length === 0, `系统账户多头 lot 未累积 (${p ? p.lots.length : 0})`);
  assert(A.longQty('600001') === 0, '强卖确实执行完毕');
}

// ---- 14. 强平会先撤掉平仓挂单 ----
console.log('\n[14] 强平前先撤掉平仓挂单（不留幽灵单）');
{
  const { m, A, N } = fresh();
  const t = 6 * 60 * 1000;
  // A 建仓 1000 股，并开空 1 万股
  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20, now: 0, noCooldown: true });
  m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20, now: 0 });
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 10000, price: 20, now: 0, noCooldown: true });
  const short = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 10000, price: 20, now: 3000 });
  assert(short.ok && A.shortQty('600001') === 10000, 'A 开空 1 万股');

  const o = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: 1000, price: 29, now: t });
  assert(o.ok && A.sellableLong('600001', t) === 0, '卖平多挂单占满预留');
  assert(A.orders.size === 1, 'A 有 1 张在挂委托');

  // 制造爆仓（模拟巨亏：现金被击穿）
  A.cash = -500000;
  const liquidated = m.maybeLiquidate(A, t + 1000);
  assert(liquidated, '触发强平');
  assert(A.orders.size === 0, `强平后 A 无遗留挂单 (剩 ${A.orders.size})`);
  assert(!m.book.orders.has(o.order.id), '该挂单已从订单簿移除');
  assert(A.longQty('600001') === 0, '强平已卖出多头');
}

// ---- 15. 权益恒等式 ----
console.log('\n[15] 权益恒等式：总权益 = 初始资金 + 已实现盈亏 + 浮动盈亏');
{
  const { m, A, N } = fresh();
  const sumCost = (map) => {
    const p = map.get('600001');
    return p ? p.lots.reduce((s, l) => s + l.qty * l.price, 0) : 0;
  };
  const identity = () => {
    const last = m.lastPrice;
    const floatPnl = A.longValue('600001', last) - sumCost(A.longs)
      + sumCost(A.shorts) - A.shortMV('600001', last);
    return { eq: A.equity('600001', last), expect: config.account.initialCash + A.realizedPnL + floatPnl };
  };

  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20, now: 0, noCooldown: true });
  m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20, now: 0 });
  assert(Math.abs(A.realizedPnL + 2) < 0.01, `开多手续费计入已实现盈亏 (${A.realizedPnL.toFixed(2)})`);
  let r = identity();
  assert(Math.abs(r.eq - r.expect) < 0.01, `开多后恒等 (eq=${r.eq.toFixed(2)} expect=${r.expect.toFixed(2)})`);

  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 2000, price: 20, now: 0, noCooldown: true });
  m.place(A, { action: ACTIONS.SELL_OPEN, qty: 2000, price: 20, now: 3001 });
  r = identity();
  assert(Math.abs(r.eq - r.expect) < 0.01, `开空后恒等 (eq=${r.eq.toFixed(2)} expect=${r.expect.toFixed(2)})`);

  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 2000, price: 21, now: 0, noCooldown: true });
  const rc = m.place(A, { action: ACTIONS.BUY_CLOSE, qty: 2000, price: 21, now: 6002 });
  assert(rc.ok && rc.order.filled === 2000, '买入平空成交');
  r = identity();
  assert(Math.abs(r.eq - r.expect) < 0.01, `平空后恒等 (eq=${r.eq.toFixed(2)} expect=${r.expect.toFixed(2)})`);
}

// ---- 16. 停牌 ----
console.log('\n[16] 停牌：暂停下单但允许撤单');
{
  const { m, A, N } = fresh();
  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20, now: 0, noCooldown: true });
  const r0 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 20, now: 0 });
  assert(r0.ok, '停牌前可正常下单');
  const resting = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 19.5, now: 3001 });
  assert(resting.ok && resting.order.status === 'live', '停牌前挂入一张低价买单');

  const h = m.halt(5, '异常波动', 10000);
  assert(h.ok && m.isHalted(10000), '停牌生效');
  assert(m.haltInfo(10000).halted && m.haltInfo(10000).reason === '异常波动', '停牌状态可下发');
  assert(!m.isHalted(10000 + 5 * 60000), '停牌到点即视为解除');

  const r1 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 20, now: 10000 });
  assert(!r1.ok && /停牌/.test(r1.error), `停牌期间下单被拒 (${r1.error})`);
  const r2 = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 100, price: 20, now: 10000 });
  assert(!r2.ok && /停牌/.test(r2.error), '停牌期间开空同样被拒');

  // 撤单不拦：停牌期间玩家仍要能收回自己的委托
  const rc = m.cancel(A, resting.order.id, 10000);
  assert(rc.ok, '停牌期间可以撤单');

  assert(m.resume(10000).resumed && !m.isHalted(10000), '手动复牌生效');
  assert(!m.haltInfo(10000).halted, '复牌后状态清零');
  const r3 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 20, now: 20000 });
  assert(r3.ok, '复牌后恢复下单');

  assert(!m.halt(config.halt.maxMinutes + 1, '', 20000).ok, '超过上限的停牌时长被拒');
  assert(!m.halt(0, '', 20000).ok, '零时长被拒');
}

// ---- 17. 撮合中途被强平撤单的委托不得进入订单簿 ----
console.log('\n[17] 撮合中途被强平撤单的委托不得变成幽灵单');
{
  const { m, A, N } = fresh();
  const t = 6 * 60 * 1000;
  // A 开空 1 万股（用 N 的买单成交），再把现金压到维持保证金线之上一点
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 10000, price: 20.0, now: 0, noCooldown: true });
  m.place(A, { action: ACTIONS.SELL_OPEN, qty: 10000, price: 20.0, now: 1000 });
  A.longPos('600001').lots.push({ qty: 1000, price: 20, ts: 0, reserved: 0 });
  A.cash = 141000; // 权益刚好在维持线之上，成交带来的价格上移会把它推下去

  // N 只垫 400 股买盘（价格在价格笼子内）：A 的卖平多单只能部分成交，
  // 随后在撮合途中被强平撤单
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 400, price: 20.5, now: 2000, noCooldown: true });
  const o = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: 1000, price: 20.5, now: t });
  assert(o.ok && o.order.filled === 400, `卖平多单部分成交 400 (实际 ${o.ok ? o.order.filled : o.error})`);
  assert(o.order.status === 'canceled', '该委托已被强平流程撤销');
  assert(!A.orders.has(o.order.id), '账户挂单表里已无此单（玩家已撤不掉）');
  assert(!m.book.orders.has(o.order.id), '已撤销的委托不得留在订单簿里');
  const notLive = [...m.book.orders.values()].filter((x) => x.status !== 'live');
  assert(notLive.length === 0, `订单簿里没有非 live 的委托 (${notLive.length})`);

  // 即使该账户重新建仓，这张已撤销的委托也不得再被吃到
  A.longPos('600001').lots.push({ qty: 1000, price: 20.5, ts: t, reserved: 0 });
  const longBefore = A.longQty('600001');
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 600, price: 20.5, now: t + 10000, noCooldown: true });
  assert(A.longQty('600001') === longBefore, `已撤销的委托没有再被吃到 (持仓 ${longBefore} -> ${A.longQty('600001')})`);
}

// ---- 18. 同一账户不得自成交 ----
console.log('\n[18] 同一账户的挂单不能当自己的对手盘（禁止对倒刷价）');
{
  const { m, A } = fresh();
  const t = 6 * 60 * 1000;
  A.cash = 1000000;
  A.longPos('600001').lots.push({ qty: 1000, price: 20, ts: 0, reserved: 0 });

  const bid = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 24, now: t });
  assert(bid.ok && bid.order.status === 'live', '自己的买单挂入订单簿');
  const volBefore = m.volume;
  const priceBefore = m.lastPrice;

  // 用自己的卖单去吃自己的买单：成交价 = 被动方挂单价，一旦放开就能零成本改写最新价
  const ask = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: 1000, price: 24, now: t + 3000 });
  assert(ask.ok && ask.order.filled === 0, `自成交被拦下，未成交任何股数 (filled=${ask.ok ? ask.order.filled : ask.error})`);
  assert(m.volume === volBefore, '成交量未增加');
  assert(m.lastPrice === priceBefore, `最新价未被自己改写 (${m.lastPrice})`);
  assert(A.longQty('600001') === 1000, '多头持仓未变化');
  assert(!m.book.orders.has(bid.order.id), '自己的旧买单已被撤掉');
  assert(A.orders.has(ask.order.id), '自己的卖单正常挂在簿上');

  // 兜底：订单簿里若存在"不在账户挂单表里"的残留单（老存档或历史异常路径留下的），
  // 自成交拦截也必须能把它移出订单簿，否则 match 会原地死循环
  const ghost = {
    id: 'OG', seq: 999, stockId: '600001', ownerId: A.name, account: A,
    action: ACTIONS.SELL_CLOSE, side: 'sell', price: 25, qty: 100, filled: 0, frozen: 0, ts: t, status: 'live',
  };
  m.book.add(ghost); // 只进订单簿，不进 A.orders
  const r2 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 25, now: t + 6000 });
  assert(r2.ok && r2.order.filled === 0, `残留单在场时自成交仍被拦下 (filled=${r2.ok ? r2.order.filled : r2.error})`);
  assert(!m.book.orders.has('OG'), '不在账户表里的残留单已被移出订单簿');
}

// ---- 19. 价格笼子：脱离盘口的挂单不得按自己的挂单价成交 ----
console.log('\n[19] 价格笼子：单笔成交价不得脱离上一笔成交价');
{
  const { m } = fresh();
  const t0 = 6 * 60 * 1000; // 让注入的批次已过锁仓期
  const lot = { qty: 1000, price: 20, ts: 0, reserved: 0 };
  const holder = (name) => {
    const a = new Account(name);
    a.cash = 100000;
    a.longPos('600001').lots.push({ ...lot });
    return a;
  };

  // (1) 远高于盘口的买单：允许入簿，但被吃时不得按它自己的挂单价成交
  const A = holder('挂高价单');
  A.longPos('600001').lots.length = 0; // A 只挂买单，不需要持仓
  const B = holder('砸高价单');
  const farBid = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 29.5, now: t0 });
  assert(farBid.ok && farBid.order.status === 'live', `偏离 47% 的买单挂入订单簿`);
  const lastBefore = m.lastPrice;
  const volBefore = m.volume;
  const hit = m.place(B, { action: ACTIONS.SELL_CLOSE, qty: 1000, price: 29.5, now: t0 + 3000 });
  assert(hit.ok, `卖单本身正常受理${hit.ok ? '' : ': ' + hit.error}`);
  assert(m.lastPrice === lastBefore, `最新价未被一步拉走 (${lastBefore} -> ${m.lastPrice})`);
  assert(m.volume === volBefore, '没有产生脱离笼子的成交');
  assert(!m.book.orders.has(farBid.order.id), '脱离笼子的买单已被撤掉');

  // (2) 反方向：远低于盘口的卖单被买盘吃到时，同样不得按它的挂单价成交
  const C = holder('挂低价单');
  const D = holder('抄低价单');
  D.longPos('600001').lots.length = 0;
  const farAsk = m.place(C, { action: ACTIONS.SELL_CLOSE, qty: 1000, price: 17, now: t0 + 6000 });
  assert(farAsk.ok && farAsk.order.status === 'live', `偏离 -15% 的卖单挂入订单簿${farAsk.ok ? '' : ': ' + farAsk.error}`);
  const lastBefore2 = m.lastPrice;
  const volBefore2 = m.volume;
  const buy = m.place(D, { action: ACTIONS.BUY_OPEN, qty: 100, price: m.roundPrice(m.lastPrice * 1.01), now: t0 + 9000 });
  assert(buy.ok, '正常价位的买单受理成功');
  assert(D.longQty('600001') === 0, '买单没有被按脱离笼子的低价成交');
  assert(m.lastPrice === lastBefore2, `最新价未被一步砸穿 (${lastBefore2} -> ${m.lastPrice})`);
  assert(m.volume === volBefore2, '没有产生脱离笼子的成交');
}

// ---- 20. 撤借不得撤走在途开空单占用的券源 ----
console.log('\n[20] 撤借闸门计入 lendReserved（在途开空占用）');
{
  config.margin.allowNakedShort = false; // 走真实融券池路径
  config.margin.lending.enabled = true;
  const { m } = fresh();
  const L = new Account('出借人');
  const A = new Account('空头A');
  const N2 = new Account('NPC吃单', true);
  N2.cash = 1e8;
  m.accountsProvider = () => [L, A, N2];
  L.longPos('600001').lots.push({ qty: 1000, price: 20, ts: -1e9, reserved: 0 });

  assert(m.lendShares(L, 1000, 0).ok && m.lendTotal === 1000, '出借人挂借 1000 股');
  const open = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 800, price: 20, now: 0, noCooldown: true });
  assert(open.ok && m.lendReserved === 800, `开空挂单占用券源 800 (reserved=${m.lendReserved})`);
  assert(m.lendRemovableQty(L) === 200, `可撤量=200 (实际 ${m.lendRemovableQty(L)})`);

  const bad = m.unlendShares(L, 1000, 1000);
  assert(!bad.ok, `整笔撤借被拒: ${bad.error}`);
  const ok = m.unlendShares(L, 200, 1000);
  assert(ok.ok && m.lendTotal === 800, '撤走未被占用的 200 股成功');

  // 在途开空成交：池子账实相符（lendBorrowed ≤ lendTotal），空头正常付息
  const hit = m.place(N2, { action: ACTIONS.BUY_OPEN, qty: 800, price: 20, now: 2000, noCooldown: true });
  assert(hit.order.filled === 800, '开空挂单被吃掉成交');
  assert(m.lendBorrowed === 800 && m.lendTotal === 800, `池子账实相符 (borrowed=${m.lendBorrowed}, total=${m.lendTotal})`);
  const cashBefore = A.cash;
  m.accrueLendingInterest(3000);
  assert(A.cash < cashBefore, `借券方正常计息扣款 (cash ${cashBefore.toFixed(2)} -> ${A.cash.toFixed(2)})`);
  config.margin.allowNakedShort = true; // 还原本文件默认
}

// ---- 21. 并发开空预检计入同账户在途开空单 ----
console.log('\n[21] SELL_OPEN 预检计入在途开空名义市值');
{
  config.margin.allowNakedShort = true;
  const { m, A } = fresh();
  const r1 = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 15000, price: 20, now: 0 });
  assert(r1.ok, '第一张贴边开空单（需维持保证金 9 万，权益 10 万）通过预检');
  const r2 = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 15000, price: 20, now: 3000 });
  assert(!r2.ok && /保证金不足/.test(r2.error),
    `第二张被拒（在途 15000 股也要计占用）: ${r2.error}`);
}

// ---- 22. 并发平空单的保证金预览不重复计入 ----
console.log('\n[22] previewShortMargin 跳过已预留批次');
{
  config.margin.allowNakedShort = true;
  const { m, A } = fresh();
  A.shorts.set('600001', {
    lots: [
      { qty: 100, price: 10, margin: 500, reserved: 0 },
      { qty: 900, price: 1, margin: 450, reserved: 0 },
    ],
  });
  A.shortMargin = 950;
  A.cash = 5860;
  m.lastPrice = 5;
  m.shortInterest = 1000;

  const p1 = A.previewShortMargin('600001', 900); // 与 place 内部同口径：预留前预览
  const r1 = m.place(A, { action: ACTIONS.BUY_CLOSE, qty: 900, price: 5, now: 0 });
  const p2 = A.previewShortMargin('600001', 100); // 第一张预留后，第二张只剩 lot1 的 100 股
  const r2 = m.place(A, { action: ACTIONS.BUY_CLOSE, qty: 100, price: 4.95, now: 3000 });
  assert(r1.ok && r2.ok, '两张并发平空单均挂入');
  assert(p1 === 900, `第一张 preview=900（lot0 全额 500 + lot1 800×0.5）: ${p1}`);
  assert(p2 === 50, `第二张 preview=50（只剩 lot1 未预留的 100 股×0.5，不再重复计入 lot0）: ${p2}`);
  assert(p1 + p2 <= A.shortMargin, `两单 preview 合计 ${p1 + p2} 不超过保证金总额 950`);
}

// ---- 23. 强平不得卖出挂借中的券 ----
console.log('\n[23] 强平卖多头豁免锁仓但不碰挂借');
{
  config.margin.allowNakedShort = false;
  config.margin.lending.enabled = true;
  const { m } = fresh();
  const L = new Account('出借人');
  const buyer = new Account('买方');
  buyer.cash = 1e8;
  m.accountsProvider = () => [L, buyer];
  L.cash = 0;
  L.longPos('600001').lots.push({ qty: 1000, price: 20, ts: -1e9, reserved: 0 });

  assert(m.lendShares(L, 1000, 0).ok, '全部持仓挂借');
  const open = m.place(L, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20, now: 0, noCooldown: true });
  assert(open.ok, '借券开空 1000 股');
  const hit = m.place(buyer, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20, now: 1000, noCooldown: true });
  assert(hit.order.filled === 1000, '开空成交');

  m.lastPrice = 80; // 空头深水：cash+保证金不足以买回 → 旧逻辑会强卖多头补现金
  const liq = m.maybeLiquidate(L, 2000);
  const events = (L.liquidations && L.liquidations[0] && L.liquidations[0].events) || [];
  assert(liq, '触发强平');
  assert(events.every((e) => e.type !== 'force_sell_long'), '没有强卖多头事件（可卖量被挂借挡掉）');
  assert(L.longQty('600001') === 1000, `挂借中的 1000 股多头未被强平卖出 (剩 ${L.longQty('600001')})`);
  assert(L.lendOffered === 1000, '挂借登记保持 1000');
  assert(L.shortQty('600001') < 1000 && L.shortQty('600001') > 0, `剩余空头 ${L.shortQty('600001')} 股（能负担多少平多少）`);
  assert(m.lendBorrowed === L.shortQty('600001'), '借出量与剩余空头一致');
  config.margin.allowNakedShort = true;
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
