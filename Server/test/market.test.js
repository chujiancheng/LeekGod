/**
 * 撮合引擎冒烟测试：node test/market.test.js
 * 本文件覆盖融券开空/保证金/强平链路，需临时打开 allowNakedShort；
 * 生产默认禁止裸空，见 game.test.js 的拦截断言。
 */
const config = require('../src/config');

// ---- 多股票测试辅助 ----
// 本文件直接构造单个 Market（不经 Game），只用到「第一只股票」这个常量
const STOCK = config.stocks[0];
config.margin.allowNakedShort = true;

const { Market, ACTIONS } = require('../src/market');
const { DayCycle } = require('../src/daycycle');
const { Account } = require('../src/store');
const broker = require('../src/broker');

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

/**
 * 额外垫单账户。同股多空互斥之后一个账户在同一只股票上只能站一边，
 * 所以一个用例里既要买盘又要卖盘时必须换账户垫——这里是标准做法。
 */
function pad(name) {
  const acc = new Account(name, true);
  acc.cash = 100000000;
  return acc;
}

/** 某家券商的**有效通道参数**（不带星级/每周之星的干扰：day=0、账户无成交记录） */
function brokerCfgOf(key) {
  const acc = new Account('cfg', false, 'player');
  acc.broker = key;
  return broker.forAccount(acc, { day: 0 });
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
console.log('\n[3] T+ 锁仓（买入后 10 秒不可卖）');
{
  const { m, A, N } = fresh();
  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 300, price: 20.0, now: 0, noCooldown: true });
  const t0 = 1000000;
  m.place(A, { action: ACTIONS.BUY_OPEN, qty: 300, price: 20.0, now: t0 });
  const r1 = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: 300, price: 20.2, now: t0 + 5000 });
  assert(!r1.ok && /锁仓/.test(r1.error), '5 秒后卖出被拒（锁仓中）');
  const r2 = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: 300, price: 20.2, now: t0 + 10001 });
  // 卖单价 20.2 高于买一可能无对手，先看是否通过锁仓校验
  assert(r2.ok, '10 秒后卖出通过锁仓校验');
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
  // 开空预检按保证金率卡权益（名义 ≤ 2 倍权益），本节只验证保证金与盈亏记账，先给足权益
  A.cash = 300000;
  const cash0 = A.cash;
  // 玩家开空 1 万股 @20（对手买单）
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 10000, price: 20.0, now: 0, noCooldown: true });
  const r = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 10000, price: 20.0, now: 0 });
  assert(r.ok && r.order.filled === 10000, '开空 1 万股成交');
  assert(A.shortQty('600001') === 10000, '空头持仓 1 万股');
  const expectMargin = 10000 * 20 * 0.5;
  assert(Math.abs(A.shortMargin - expectMargin) < 0.01, `保证金 ${expectMargin} 冻结正确`);
  const eq = A.equity(() => 20);
  const expectEq = cash0 - 10000 * 20 * 0.0001;
  assert(Math.abs(eq - expectEq) < 1, `开空后权益≈期初−手续费 (eq=${eq.toFixed(2)})`);
}

// ---- 6. 爆仓强平 ----
console.log('\n[6] 价格暴涨触发爆仓强平');
{
  const { m, A } = fresh();
  // 本节只验证爆仓机制，需要够大的本金撑起 10 万股空头（保证金 100 万，
  // 且开空预检要求权益 ≥ 50% 名义 = 100 万），所以本金独立于 config.account.initialCash
  // 显式给足；维持保证金线随之落在 ~23.85
  A.cash = 1100000;
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
  console.log(`  (强平后: 空头=${A.shortQty('600001')}, 现金=${A.cash.toFixed(2)}, 权益=${A.equity(() => m.lastPrice).toFixed(2)})`);
  assert(A.shortQty('600001') < 100000, '爆仓后空头持仓被强平减少');
  const eq = A.equity(() => m.lastPrice);
  const mv = A.shortMV('600001', m.lastPrice);
  assert(mv === 0 || eq >= 0.3 * mv - 1, '强平后权益满足维持保证金要求');
}

// ---- 7. 平空盈亏 ----
console.log('\n[7] 平空实现盈亏');
{
  const { m, A, N } = fresh();
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20.0, now: 1000, noCooldown: true });
  m.place(A, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20.0, now: 1000 });
  // 价格跌到 19：换一个还没建过仓的垫单账户挂卖单，玩家买入平空
  // （N 这时已持多头，再卖开会被同股多空互斥拦掉）
  m.place(pad('垫单2'), { action: ACTIONS.SELL_OPEN, qty: 1000, price: 19.0, now: 2000, noCooldown: true });
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

// ---- 9. 涨跌停 ----
console.log('\n[9] 涨跌停（相对昨收 ±30%，依赖交易日时钟）');
{
  const { m, A } = fresh();
  // 涨跌停是**日频机制**：区间以「昨收」为基准，而昨收由每个交易日的收盘结算滚动而来，
  // 所以这里必须挂上交易日时钟——孤立 Market（无 dayCycle）没有昨收口径，band() 直接返回 null。
  // 一天里：竞价 0~30s、上午 30~260s、午休 260~300s、下午 300~560s、收盘竞价 560~580s、夜间 580~620s。
  // 取 now = 120000ms 落在「上午连续竞价」段内（可撮合、非竞价锁定期）。
  const { DayCycle } = require('../src/daycycle');
  m.dayCycle = new DayCycle(config.day, 0);
  const now = 120000;
  const band = m.band();
  assert(band.up === 26 && band.down === 14, `昨收 20 → 涨跌停 14 ~ 26（${band.down} ~ ${band.up}）`);
  const r1 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 27.0, now });
  assert(!r1.ok && /涨跌停/.test(r1.error), '超过涨停价被拒');
  const r2 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 19.0, now: now + 100 });
  assert(r2.ok, '区间内价格可下单');
  config.priceLimit.enabled = false;
  const r3 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 27.0, now: now + 5000 });
  assert(r3.ok, '关掉涨跌停后 27 元放行（开关生效）');
  config.priceLimit.enabled = true;
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
  // N 前面卖出开空留下了 1000 股空头，这里改用买入平空做对手（再买开会撞互斥规则）
  const r = m.place(N, { action: ACTIONS.BUY_CLOSE, qty: 1000, price: 30, now: t + 1000, noCooldown: true });
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

// ---- 14. 强平会先撤掉在途委托 ----
console.log('\n[14] 强平前先撤掉在途委托（不留幽灵单）');
{
  const { m, A, N } = fresh();
  const t = 6 * 60 * 1000;
  // 开空预检按保证金率卡权益（10 万股名义 20 万需权益 ≥ 10 万），先给足权益
  A.cash = 300000;
  // A 借 N 的买单开空 1 万股（同股多空互斥下 A 只能站空头一侧）
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 10000, price: 20, now: 0, noCooldown: true });
  const short = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 10000, price: 20, now: 0 });
  assert(short.ok && A.shortQty(stock.id) === 10000, 'A 开空 1 万股');

  // 再挂一张在途委托（加空），强平必须连它一起撤掉
  const o = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 29, now: t });
  assert(o.ok && o.order.status === 'live', '加空单挂在簿上');
  assert(A.orders.size === 1, 'A 有 1 张在挂委托');

  // 制造爆仓（模拟巨亏：现金被击穿）
  A.cash = -500000;
  const liquidated = m.maybeLiquidate(A, t + 1000);
  assert(liquidated, '触发强平');
  assert(A.orders.size === 0, `强平后 A 无遗留挂单 (剩 ${A.orders.size})`);
  assert(!m.book.orders.has(o.order.id), '该挂单已从订单簿移除');
  assert(A.shortQty(stock.id) === 0, '强平已平掉全部空头');
}

// ---- 15. 权益恒等式 ----
console.log('\n[15] 权益恒等式：总权益 = 初始资金 + 已实现盈亏 + 浮动盈亏');
{
  const { m, A, N } = fresh();
  const sideCost = (acc, map) => {
    const p = map.get(stock.id);
    return p ? p.lots.reduce((s, l) => s + l.qty * l.price, 0) : 0;
  };
  const identity = (acc) => {
    const last = m.lastPrice;
    const floatPnl = acc.longValue(stock.id, last) - sideCost(acc, acc.longs)
      + sideCost(acc, acc.shorts) - acc.shortMV(stock.id, last);
    return { eq: acc.equity(() => last), expect: config.account.initialCash + acc.realizedPnL + floatPnl };
  };

  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20, now: 0, noCooldown: true });
  m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20, now: 0 });
  assert(Math.abs(A.realizedPnL + 2) < 0.01, `开多手续费计入已实现盈亏 (${A.realizedPnL.toFixed(2)})`);
  let r = identity(A);
  assert(Math.abs(r.eq - r.expect) < 0.01, `开多后恒等 (eq=${r.eq.toFixed(2)} expect=${r.expect.toFixed(2)})`);

  // 开空/平空换一个只做空的账户：同股多空互斥下 A 已持多头，不能再卖开
  const S = pad('空头S');
  S.cash = config.account.initialCash; // 恒等式按初始资金口径，垫单账户的巨额本金不适用
  m.place(pad('垫单3'), { action: ACTIONS.BUY_OPEN, qty: 2000, price: 20, now: 0, noCooldown: true });
  m.place(S, { action: ACTIONS.SELL_OPEN, qty: 2000, price: 20, now: 0 });
  r = identity(S);
  assert(Math.abs(r.eq - r.expect) < 0.01, `开空后恒等 (eq=${r.eq.toFixed(2)} expect=${r.expect.toFixed(2)})`);

  m.place(pad('垫单4'), { action: ACTIONS.SELL_OPEN, qty: 2000, price: 21, now: 0, noCooldown: true });
  const rc = m.place(S, { action: ACTIONS.BUY_CLOSE, qty: 2000, price: 21, now: 3001 });
  assert(rc.ok && rc.order.filled === 2000, '买入平空成交');
  r = identity(S);
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
  // A 开空 1 万股（用 N 的买单成交），再把现金压到维持保证金线之上一点。
  // 开空前先给足权益以过保证金率预检，成交后再把现金手动压到 141000
  A.cash = 300000;
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
  // 做空利息：盘中逐 tick 按持仓时长**累计**（不动现金），收盘日终结算时一次性实扣
  // 时钟在成交之后再挂：带着时钟在集合竞价段下单不会连续撮合（本用例要的是立即成交）
  m.dayCycle = new DayCycle({ enabled: true, phases: config.day.phases }, 0);
  const tickMs = config.tickIntervalMs;
  const ticks = Math.round(m.dayMs / tickMs); // 一个游戏日容得下多少 tick
  const cashBefore = A.cash;
  for (let i = 1; i <= ticks; i += 1) m.accrueLendingInterest(3000 + i * tickMs);
  assert(A.cash === cashBefore, `盘中只累计、不扣现金 (cash=${A.cash.toFixed(2)})`);
  const pending = A.ledgerOf(STOCK.id).lendInterestAccrued;
  const oneDay = A.shortQty('600001') * m.lastPrice * m.lendDailyRate();
  assert(
    Math.abs(pending - oneDay) / oneDay < 0.01,
    `持满一天的累计额 ≈ 空头市值 × 日利率: ${pending.toFixed(2)} ≈ ${oneDay.toFixed(2)}`
  );
  m.settleLendingInterest(0, { day: 1 });
  assert(
    Math.abs(cashBefore - A.cash - pending) < 0.01,
    `收盘实扣 = 当日累计 (扣 ${(cashBefore - A.cash).toFixed(2)} / 累计 ${pending.toFixed(2)})`
  );
  assert(A.ledgerOf(STOCK.id).lendInterestAccrued === 0, '结算后当日累计清零');
  const cashAfter1 = A.cash;
  m.settleLendingInterest(0, { day: 1 });
  assert(A.cash === cashAfter1, '同一个交易日不会重复收息');
  for (let i = 1; i <= ticks; i += 1) m.accrueLendingInterest(1e6 + i * tickMs);
  const cashAfter2 = A.cash;
  assert(m.settleLendingInterest(0, { day: 2 }) === 2, '下一个交易日收盘再结一次（累计 → 实扣）');
  assert(A.cash < cashAfter2, '第二天的利息照收');
  assert(m.settleLendingInterest(0, { day: 1 }) === -1, '回退到已结算的日子不收（重启补结算安全）');

  // 回归：计息基数按**持仓时长**积分，不再只看收盘那一刻的仓位。
  // 这两个用例在「收盘采样」的旧实现下会双向失败：① 收 0 元、② 收满一天。
  const plant = (tag) => {
    const mm = new Market(stock);
    const LL = new Account('回归出借' + tag);
    const AA = new Account('回归空头' + tag);
    const NN = new Account('回归NPC' + tag, true);
    NN.cash = 1e8;
    mm.accountsProvider = () => [LL, AA, NN];
    LL.longPos('600001').lots.push({ qty: 1000, price: 20, ts: -1e9, reserved: 0 });
    mm.lendShares(LL, 1000, 0);
    mm.place(AA, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20, now: 0, noCooldown: true });
    mm.place(NN, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20, now: 2000, noCooldown: true });
    // 成交之后再挂时钟：没有时钟就没有「日终结算」这个时点（会退化成逐 tick 实扣），
    // 而带着时钟在集合竞价段下单又不会连续撮合
    mm.dayCycle = new DayCycle({ enabled: true, phases: config.day.phases }, 0);
    return { mm, AA };
  };
  {
    // ① 全天持有、收盘前把空头平掉 → 已经累计的息照样要付
    const { mm, AA } = plant('A');
    const full = AA.shortQty('600001') * mm.lastPrice * mm.lendDailyRate();
    const c0 = AA.cash;
    for (let i = 1; i <= ticks; i += 1) mm.accrueLendingInterest(3000 + i * tickMs);
    AA.shorts.clear(); // 收盘前平光：收盘那一刻仓位为 0
    mm.settleLendingInterest(0, { day: 1 });
    assert(
      Math.abs(c0 - AA.cash - full) < oneDay * 0.01,
      `收盘前平空也要付已持仓那段的息 (扣 ${(c0 - AA.cash).toFixed(2)} ≈ ${full.toFixed(2)})`
    );

    // ② 收盘前 1 秒才开空 → 只付 1 个 tick，不是收满一天
    const { mm: mm2, AA: AA2 } = plant('B');
    const c1 = AA2.cash;
    mm2.accrueLendingInterest(3000 + tickMs); // 只跑一个 tick
    mm2.settleLendingInterest(0, { day: 1 });
    const charged = c1 - AA2.cash;
    assert(
      charged > 0 && charged < full * 0.01,
      `收盘前才开空只付已持仓那一小段 (扣 ${charged.toFixed(4)} ≪ 一天 ${full.toFixed(2)})`
    );
  }
  config.margin.allowNakedShort = true; // 还原本文件默认
}

// ---- 21. 并发开空预检计入同账户在途开空单 ----
console.log('\n[21] SELL_OPEN 预检计入在途开空名义市值');
{
  config.margin.allowNakedShort = true;
  const { m, A } = fresh();
  A.cash = 100000; // 本金写死 10 万：本节验的是"贴边开空"的边界，与 config 初始资金解耦
  const r1 = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 9000, price: 20, now: 0 });
  assert(r1.ok, '第一张贴边开空单（需保证金 9 万，权益 10 万）通过预检');
  const r2 = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 9000, price: 20, now: 3000 });
  assert(!r2.ok && /保证金不足/.test(r2.error),
    `第二张被拒（在途 9000 股也要计占用）: ${r2.error}`);
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
  m.accountsProvider = () => [L];
  L.cash = 0;
  m.lastPrice = 20;
  L.longPos(stock.id).lots.push({ qty: 1000, price: 20, ts: -1e9, reserved: 0 });

  assert(m.lendShares(L, 1000, 0).ok, '全部持仓挂借');

  // 「挂借中的多头 + 空头」在互斥规则下已经不可能由 place 建出来（卖开会撞多头持仓），
  // 只能来自旧档残留。这里直接构造该状态——本节验的是强平不碰挂借中券这条底线。
  // 现金/保证金按正常路径的口径摆：开空 1000 股卖出款 20000 − 50% 保证金 − 手续费。
  L.shorts.set(stock.id, { lots: [{ qty: 1000, price: 20, margin: 10000, reserved: 0 }] });
  L.shortMargin = 10000;
  L.cash = 9998;
  m.lendBorrowed = 1000;
  m.shortInterest = 1000;

  m.lastPrice = 80; // 空头深水：cash+保证金不足以买回 → 旧逻辑会强卖多头补现金
  const liq = m.maybeLiquidate(L, 2000);
  const events = (L.liquidations && L.liquidations[0] && L.liquidations[0].events) || [];
  assert(liq, '触发强平');
  assert(events.every((e) => e.type !== 'force_sell_long'), '没有强卖多头事件（可卖量被挂借挡掉）');
  assert(L.longQty(stock.id) === 1000, `挂借中的 1000 股多头未被强平卖出 (剩 ${L.longQty(stock.id)})`);
  assert(L.ledgerOf(stock.id).lendOffered === 1000, '挂借登记保持 1000');
  assert(L.shortQty(stock.id) < 1000 && L.shortQty(stock.id) > 0, `剩余空头 ${L.shortQty(stock.id)} 股（能负担多少平多少）`);
  assert(m.lendBorrowed === L.shortQty(stock.id), '借出量与剩余空头一致');
  config.margin.allowNakedShort = true;
}

// ---- 24. 融资买入：冻结口径 / 结算 / 撤单退款 ----
console.log('\n[24] 融资买入结算与冻结');
{
  const { m, A, N } = fresh();
  m.lastPrice = 20;
  const fin = config.margin.finance;
  assert(fin.enabled, '融资功能默认开放');
  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20.0, now: 0, noCooldown: true });
  const r = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20.0, now: 0, finance: true });
  assert(r.ok && r.order.filled === 1000, `融资买入成交${r.ok ? '' : ': ' + r.error}`);
  const cost = 1000 * 20;
  const fee = cost * config.trade.feeRate;
  const selfPay = cost * fin.ratio;
  const expectCash = config.account.initialCash - selfPay;
  assert(Math.abs(A.cash - expectCash) < 0.01, `只扣自备 ${selfPay}，手续费随负债融资 (cash=${A.cash.toFixed(2)})`);
  assert(Math.abs(A.financeDebt('600001') - (cost * (1 - fin.ratio) + fee)) < 0.01,
    `批次负债 = 借入本金 + 开仓手续费 ${cost * (1 - fin.ratio) + fee} 记账正确`);
  const expectEq = config.account.initialCash - fee;
  assert(Math.abs(A.equity(() => 20) - expectEq) < 0.01, `权益 = 初始资金 − 手续费 (eq=${A.equity(() => 20).toFixed(2)})`);
  assert(Math.abs(A.realizedPnL - -fee) < 0.01, '开仓手续费计入已实现盈亏');
  assert(r.order.finance === true, '订单携带融资标记');
  assert(Math.abs(A.financePrincipal('600001') - (cost * (1 - fin.ratio) + fee)) < 0.01,
    `批次本金 = 同样的借入口径（负债 − 本金 = 0，还没计息）`);
  assert(A.financeDebt('600001') === A.financePrincipal('600001'), '刚开仓时未还利息为 0');

  // 融资买单未成交部分撤单：按自备口径冻结、全额退回
  const r2 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 500, price: 19.9, now: 100000, finance: true });
  assert(r2.ok && r2.order.status === 'live', '低位融资买单挂入');
  const wantFrozen = Math.round(500 * 19.9 * fin.ratio * 100) / 100;
  assert(Math.abs(A.orderFrozen - wantFrozen) < 0.01, `冻结 ${wantFrozen} 为自备口径（不含手续费）`);
  m.cancel(A, r2.order.id, 100001);
  assert(A.orderFrozen === 0, '撤单后冻结归零');
  assert(Math.abs(A.cash - expectCash) < 0.01, '撤单退回的钱与冻结一致');

  // 融资未开放时拒单
  fin.enabled = false;
  const r3 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 100, price: 20, now: 200000, finance: true });
  assert(!r3.ok && /未开放/.test(r3.error), '融资关闭时拒绝融资单');
  fin.enabled = true;
}

// ---- 25. 融资利息：压力利率与复利摊入 ----
console.log('\n[25] 融资利息按 tick 摊入负债');
{
  const { m, A, N } = fresh();
  m.lastPrice = 20;
  const fin = config.margin.finance;
  A.cash = 0;
  A.longPos('600001').lots.push({ qty: 100000, price: 20, ts: 0, reserved: 0, debt: 5000000, principal: 5000000 });
  N.cash = 0; // 全市场现金耗尽 → 压力利率打满
  m.accountsProvider = () => [A, N];
  const rateHot = m.financeMinuteRate();
  assert(rateHot === fin.maxMinuteRate, `现金耗尽时利率打满封顶 (${rateHot}/分钟)`);

  N.cash = 1e10; // 现金充裕 → 回落到基础利率附近
  const rate = m.financeMinuteRate();
  assert(rate >= fin.baseMinuteRate && rate < rateHot, `现金充裕时利率回落 (${rate})`);

  const tickRate = rate * (config.tickIntervalMs / 60000);
  const expectAdd = Math.round(5000000 * tickRate * 100) / 100;
  const realizedBefore = A.realizedPnL;
  const eqBefore = A.equity(() => 20);
  m.accrueFinanceInterest(0);
  const debtAfter = A.financeDebt('600001');
  assert(Math.abs(debtAfter - 5000000 - expectAdd) <= 0.011, `负债复利摊入 ${expectAdd} (debt=${debtAfter.toFixed(2)})`);
  assert(Math.abs(realizedBefore - A.realizedPnL - expectAdd) <= 0.011, '利息同步扣减已实现盈亏');
  assert(Math.abs(eqBefore - A.equity(() => 20) - expectAdd) <= 0.02, '权益与账本同步下移');
  assert(Math.abs(A.ledgerOf(STOCK.id).financeInterestAccrued - expectAdd) <= 0.011, `累计已计利息随摊入累加 (${A.ledgerOf(STOCK.id).financeInterestAccrued.toFixed(2)})`);
  // 本金固定、只有负债上浮：debt − principal 才是这批的已计利息
  assert(A.financePrincipal('600001') === 5000000, '摊息不动本金');
  assert(Math.abs(debtAfter - A.financePrincipal('600001') - expectAdd) <= 0.011, '未还利息 = 负债 − 本金');

  // 无负债账户不受影响
  const B = new Account('无债B');
  B.cash = 1000;
  m.accountsProvider = () => [A, B, N];
  const debtBBefore = B.financeDebt('600001');
  const cashBBefore = B.cash;
  m.accrueFinanceInterest(1);
  assert(B.financeDebt('600001') === debtBBefore && B.cash === cashBBefore, '无负债账户不被计息');

  // 关闭融资 → 利率为 0 且不摊息
  fin.enabled = false;
  assert(m.financeMinuteRate() === 0, '融资关闭时利率为 0');
  fin.enabled = true;
}

// ---- 26. 平仓偿还负债与深跌破位拦截 ----
console.log('\n[26] 卖平融资仓位：还债、盈亏与预检');
{
  const { m, A, N } = fresh();
  m.lastPrice = 22;
  // 手工构造负债大于卖出款的深跌破位（负债 25000 > 卖出款 22000）
  A.cash = 3000;
  A.longPos('600001').lots.push({ qty: 1000, price: 20, ts: -1e9, reserved: 0, debt: 25000 });
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 22, now: 0, noCooldown: true });

  // 3000 + 22000 = 25000 < 25000 + fee → 卖出款盖不住还债与手续费，拒卖
  const rr = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: 1000, price: 22, now: 10000 });
  assert(!rr.ok && /融资负债/.test(rr.error), `现金补不出差额时拒卖：${rr.error}`);

  A.cash = 5000; // 5000 + 22000 ≥ 25000 + fee → 放行
  const r = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: 1000, price: 22, now: 20000 });
  assert(r.ok && r.order.filled === 1000, `补足现金后卖出成交${r.ok ? '' : ': ' + r.error}`);
  assert(A.financeDebt('600001') === 0, '批次负债已清零');
  assert(A.longQty('600001') === 0, '多头已清仓');
  const fee = Math.round(1000 * 22 * config.trade.feeRate * 100) / 100;
  const expectCash = 5000 + 22000 - 25000 - fee;
  assert(Math.abs(A.cash - expectCash) < 0.01, `现金 = 期初 + 卖出款 − 还债 − 手续费 (${A.cash.toFixed(2)})`);
  const expectRz = 22000 - 20000 - fee; // 差价按开仓成本 20000 算，负债超成本的部分是历史利息、已在摊入时计过账
  assert(Math.abs(A.realizedPnL - expectRz) < 0.01, `已实现盈亏 = 差价 − 手续费 (${A.realizedPnL.toFixed(2)})`);
}

// ---- 27. 融资下单预检：权益与自备资金 ----
console.log('\n[27] 融资开多预检');
{
  const { m, A } = fresh();
  m.lastPrice = 15;
  A.cash = 5000;
  A.longPos('600001').lots.push({ qty: 1000, price: 20, ts: 0, reserved: 0, debt: 19000 });
  // 权益 = 5000 + 15000 − 19000 = 1000 < 0.3 × (15000 + 20000)
  const r1 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 15, now: 0, finance: true });
  assert(!r1.ok && /保证金不足/.test(r1.error), `权益不足拒融资开多：${r1.error}`);

  // 权益够（负债降到 12000 → eq=10000 ≥ 0.3×30000=9000）但自备 7500 > 现金 7000
  A.cash = 7000;
  A.longPos('600001').lots[0].debt = 12000;
  const r2 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 15, now: 10000, finance: true });
  assert(!r2.ok && /资金不足/.test(r2.error), `自备不足拒单：${r2.error}`);

  // 权益与现金都够 → 放行（自备 7500 < 8000）
  A.cash = 8000;
  const r3 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 15, now: 20000, finance: true });
  assert(r3.ok, `条件满足后放行${r3.ok ? '' : ': ' + r3.error}`);
}

// ---- 28. 融资强平：下跌触发、部分强卖恢复维持线；全款多头不触发 ----
console.log('\n[28] 融资多头强平');
{
  const { m, A, N } = fresh();
  m.lastPrice = 14;
  A.cash = 0;
  A.longPos('600001').lots.push({ qty: 1000, price: 20, ts: 0, reserved: 0, debt: 10000 });
  m.accountsProvider = () => [A, N];
  // 权益 = 0 + 14000 − 10000 = 4000 < 0.3 × 14000 = 4200 → 触发
  const liq = m.maybeLiquidate(A, 1000);
  assert(liq, '跌破维持线触发融资强平');
  const events = (A.liquidations && A.liquidations[0] && A.liquidations[0].events) || [];
  assert(events.length > 0 && events.every((e) => e.type === 'force_sell_long' && e.reason === 'finance'), '强平事件为融资强卖多头');
  assert(A.financeDebt('600001') < 10000, `负债已部分偿还 (剩 ${A.financeDebt('600001').toFixed(2)})`);
  const eq = A.equity(() => 14);
  const mv = A.longValue('600001', 14);
  assert(eq >= config.margin.maintenance * mv, `强平后恢复维持线 (权益 ${eq.toFixed(2)} ≥ ${(config.margin.maintenance * mv).toFixed(2)})`);
  assert(A.cash > 0, `回款偿债后现金为正 (${A.cash.toFixed(2)})`);
  // 维持线恢复后不再重复强平
  assert(!m.maybeLiquidate(A, 1001), '恢复后不再触发');

  // 全款多头：权益 ≥ 多头市值 ≥ 维持线，深跌也不强平
  const { m: m2, A: A2, N: N2 } = fresh();
  m2.lastPrice = 1;
  A2.cash = 0;
  A2.longPos('600001').lots.push({ qty: 1000, price: 20, ts: 0, reserved: 0, debt: 0 });
  m2.accountsProvider = () => [A2, N2];
  assert(!m2.maybeLiquidate(A2, 1), '全款多头跌到 1 元也不强平');
}

// ---- 29. 融资买入可以正好买满 2 倍（手续费并入负债） ----
console.log('\n[29] 融资买入买满整 2 倍');
{
  const { m, A, N } = fresh();
  A.cash = 100000; // 本金写死 10 万：2 倍杠杆的边界与 config 初始资金解耦
  m.lastPrice = 20;
  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 10000, price: 20, now: 0, noCooldown: true });
  // 10 万现金整好买 10000 股 @20 = 名义 2 倍；手续费不再额外占用自备资金
  const r = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 10000, price: 20, now: 0, finance: true });
  assert(r.ok && r.order.filled === 10000, `满 2 倍融资买入成交${r.ok ? '' : ': ' + r.error}`);
  const cost = 10000 * 20;
  const fee = cost * config.trade.feeRate;
  assert(A.cash === 0, `自备资金刚好用尽，不因手续费挂不出单 (cash=${A.cash})`);
  assert(Math.abs(A.financeDebt('600001') - (cost * 0.5 + fee)) < 0.01,
    `借入本金 + 手续费 ${cost * 0.5 + fee} 一并计入负债`);
  assert(A.orderFrozen === 0, '成交后无残留冻结');
  const eq = A.equity(() => 20);
  assert(Math.abs(eq - (100000 - fee)) < 0.01, `权益只少了手续费 (eq=${eq.toFixed(2)})`);
  const lev = A.longValue('600001', 20) / eq;
  assert(lev > 2 && lev < 2.001, `实际杠杆 ${lev.toFixed(4)} 倍`);
}

// ---- 30. 开空敞口按保证金率封顶 2 倍 ----
console.log('\n[30] 开空敞口上限 2 倍');
{
  const { m, A, N } = fresh();
  A.cash = 100000; // 本金写死 10 万：2 倍敞口上限的边界与 config 初始资金解耦
  m.lastPrice = 20;
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 20000, price: 20, now: 0, noCooldown: true });
  const r = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 9900, price: 20, now: 0 });
  assert(r.ok && r.order.filled === 9900, `10 万权益开空 9900 股（名义 19.8 万）成交${r.ok ? '' : ': ' + r.error}`);
  const eq = A.equity(() => 20);
  const mv = A.shortMV('600001', 20);
  assert(mv / eq > 1.9 && mv / eq < 2.001, `敞口/权益 = ${(mv / eq).toFixed(4)} 倍，贴近 2 倍上限`);
  const r2 = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 100, price: 20, now: 3000 });
  assert(!r2.ok && /保证金不足/.test(r2.error), `再开一手即越限被拒：${r2.error}`);
}

// ---- 31. 做空欠息：计入权益 + 现金恢复后追缴 ----
console.log('\n[31] 做空欠息计入权益并追缴');
{
  const naked = config.margin.allowNakedShort;
  config.margin.allowNakedShort = false; // 计息只发生在借券开仓的路径上
  const { m, A, N } = fresh();
  const L = new Account('出借人');
  L.longPos('600001').lots.push({ qty: 20000, price: 10, ts: -1e9, reserved: 0 });
  const t0 = 1000000;
  assert(m.lendShares(L, 20000, t0).ok, '出借人挂借 20000 股');
  m.lastPrice = 20;
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: 20000, price: 20, now: t0, noCooldown: true });
  const r = m.place(A, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20, now: t0 });
  assert(r.ok && r.order.filled === 1000, `玩家借券开空 1000 股${r.ok ? '' : ': ' + r.error}`);
  m.accountsProvider = () => [L, A];

  // 现金与保证金都扣不动 → 利息只能挂账（没有任何实付，累计已付保持 0）
  // 累一整天再收盘：日利率按池子紧张度取（这里只借走 1000/20000 → 轻微上浮）
  // 挂真实交易日时钟：没有时钟就没有「日终结算」这个时点（会退化成逐 tick 实扣）
  m.dayCycle = new DayCycle({ enabled: true, phases: config.day.phases }, 0);
  const rate = m.lendDailyRate();
  const tickMs = config.tickIntervalMs;
  const ticks = Math.round(m.dayMs / tickMs);
  const tickRate = rate * (tickMs / m.dayMs);
  for (let i = 1; i <= ticks; i += 1) m.accrueLendingInterest(t0 + i * tickMs);
  const accrual = A.ledgerOf(STOCK.id).lendInterestAccrued;
  assert(accrual > 0, `盘中累计了 ${accrual.toFixed(2)} 元待结算利息`);
  A.cash = 0;
  A.shortMargin = 0;
  const settled = m.settleLendingInterest(t0 + 1000, { day: 1 });
  assert(settled === 1, '收盘日终结算做空利息（按天，一天一次）');
  const owed = A.ledgerOf(STOCK.id).lendInterestDebt;
  assert(owed > 0, `欠息挂账 ${owed.toFixed(2)} 元`);
  // 累计 = Σ(空头市值 × 日利率 × tick/一天) ≈ 空头市值 × 日利率（一整天的量）
  const expectOwed = A.shortQty('600001') * 20 * tickRate * ticks;
  assert(Math.abs(owed - expectOwed) < Math.max(1, expectOwed * 0.01),
    `欠息 = 按持仓时长累计的一整天的量: ${owed.toFixed(2)} ≈ ${expectOwed.toFixed(2)}`);
  assert(A.ledgerOf(STOCK.id).lendInterestPaid === 0, '扣不动时累计已付利息为 0（只挂账）');
  const mv = A.shortMV('600001', 20);
  assert(Math.abs(A.equity(() => 20) - (-mv - owed)) < 0.01,
    `权益已扣掉欠息 (eq=${A.equity(() => 20).toFixed(2)} = -${mv} - ${owed.toFixed(2)})`);

  // 现金恢复 → 追缴并全额转给出借方
  const lenderCashBefore = L.cash;
  A.cash = 500;
  const paid = m.collectLendingDebt();
  assert(Math.abs(paid - owed) < 0.01, `追缴金额 ${paid.toFixed(2)} = 挂账欠息`);
  assert(A.ledgerOf(STOCK.id).lendInterestDebt === 0, '欠息已清零');
  assert(Math.abs(A.ledgerOf(STOCK.id).lendInterestPaid - owed) < 0.01, `补缴计入累计已付利息 (${A.ledgerOf(STOCK.id).lendInterestPaid.toFixed(2)})`);
  assert(Math.abs(A.cash - (500 - owed)) < 0.01, `从现金里扣缴 (cash=${A.cash.toFixed(2)})`);
  assert(Math.abs(L.cash - lenderCashBefore - owed) < 0.01, '欠息全额补给已挂借的出借方');
  assert(Math.abs(L.ledgerOf(STOCK.id).lendInterestEarned - owed) < 0.01, '出借方累计利息同步计入');
  config.margin.allowNakedShort = naked;
}

// ---- 32. 融资批次本金：摊息不动、平仓按比例减少 ----
console.log('\n[32] 融资批次本金与未还利息');
{
  const { m, A } = fresh();
  m.lastPrice = 20;
  A.cash = 100000;
  // 负债 12000 里有 2000 是历史已计利息：本金 10000
  A.longPos('600001').lots.push({ qty: 1000, price: 20, ts: -1e9, reserved: 0, debt: 12000, principal: 10000 });
  m.accountsProvider = () => [A];

  const unpaidBefore = A.financeDebt('600001') - A.financePrincipal('600001');
  assert(Math.abs(unpaidBefore - 2000) < 0.01, `未还利息 = 负债 − 本金 (${unpaidBefore.toFixed(2)})`);

  for (let i = 0; i < 5; i++) m.accrueFinanceInterest(i * config.tickIntervalMs);
  assert(A.financePrincipal('600001') === 10000, '摊息不改本金');
  const debtAfter = A.financeDebt('600001');
  assert(debtAfter > 12000, `负债随利息上浮 (${debtAfter.toFixed(2)})`);

  // 平掉一半：本金、负债、未还利息同比例减半，展示口径不会被打乱
  const unpaid = debtAfter - 10000;
  const cons = A.consumeLong('600001', 500);
  assert(Math.abs(cons.debt - debtAfter / 2) < 0.01, `偿还额 = 负债的一半 (${cons.debt.toFixed(2)})`);
  assert(Math.abs(A.financePrincipal('600001') - 5000) < 0.01, `本金按比例减半 (${A.financePrincipal('600001').toFixed(2)})`);
  const unpaidAfter = A.financeDebt('600001') - A.financePrincipal('600001');
  assert(Math.abs(unpaidAfter - unpaid / 2) < 0.02, `未还利息同步减半 (${unpaidAfter.toFixed(2)})`);
}

// ---- 33. 同股多空互斥（港交所口径） ----
console.log('\n[33] 同一账户同一只股票只能持有一个方向（含在途委托）');
{
  const { m, A } = fresh();
  const lot = stock.lotSize;
  const lock = () => A.sideLock(stock.id);
  assert(!lock().long && !lock().short, '空仓时两端都未占用');

  // (1) 空仓：买开挂入（未成交，留在簿上）
  const b1 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: lot, price: 19, now: 0 });
  assert(b1.ok && b1.order.filled === 0, '空仓时买开挂入');
  // (2) 在途的买开委托也算占住多头方向——否则两张反向单先后成交就多空并存了
  assert(lock().long && !lock().short, '在途买开单已占住多头方向');
  const s1 = m.place(A, { action: ACTIONS.SELL_OPEN, qty: lot, price: 21, now: 3001, noCooldown: true });
  assert(!s1.ok && /多头/.test(s1.error), `在途买开单挡住卖开（${s1.error}）`);

  // (3) 撤单解锁 → 卖开与垫单成交，账户真正持空
  m.cancel(A, b1.order.id, 5000);
  assert(!lock().long, '撤单后多头方向解锁');
  m.place(pad('垫单甲'), { action: ACTIONS.BUY_OPEN, qty: lot, price: 21, now: 5000, noCooldown: true });
  const s2 = m.place(A, { action: ACTIONS.SELL_OPEN, qty: lot, price: 21, now: 7000, noCooldown: true });
  assert(s2.ok && s2.order.filled === lot && A.shortQty(stock.id) === lot, '撤单后卖开成交，账户持空');

  // (4) 持空时：买开被拒，买入平空照常放行
  const b2 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: lot, price: 20, now: 10000, noCooldown: true });
  assert(!b2.ok && /空头/.test(b2.error), `持空时买开被拒（${b2.error}）`);
  m.place(pad('垫单乙'), { action: ACTIONS.SELL_OPEN, qty: lot, price: 21, now: 11000, noCooldown: true });
  const c1 = m.place(A, { action: ACTIONS.BUY_CLOSE, qty: lot, price: 21, now: 13000, noCooldown: true });
  assert(c1.ok && c1.order.filled === lot && A.shortQty(stock.id) === 0, '买入平空照常放行，空头归零');

  // (5) 平空后方向重新解锁
  const b4 = m.place(A, { action: ACTIONS.BUY_OPEN, qty: lot, price: 21, now: 16000, noCooldown: true });
  assert(b4.ok, `平空后买开放行${b4.ok ? '' : ': ' + b4.error}`);
}

// ---- 34. 旧档残留的多空并存：只许平、不许再开 ----
console.log('\n[34] 旧档多空并存：只许平仓，不再新增任何一侧');
{
  const { m, A, N } = fresh();
  const lot = stock.lotSize;
  // 互斥规则之后 place 建不出这种状态，只能直接构造（模拟旧存档）
  A.longPos(stock.id).lots.push({ qty: lot, price: 19, ts: -1e9, reserved: 0 });
  A.shorts.set(stock.id, { lots: [{ qty: lot, price: 21, margin: 21000, reserved: 0 }] });
  A.shortMargin = 21000;
  const lock = A.sideLock(stock.id);
  assert(lock.long && lock.short, '两端都被占用');

  const bu = m.place(A, { action: ACTIONS.BUY_OPEN, qty: lot, price: 20, now: 0 });
  assert(!bu.ok && /空头/.test(bu.error), `加多被拒（${bu.error}）`);
  const so = m.place(A, { action: ACTIONS.SELL_OPEN, qty: lot, price: 21, now: 3001, noCooldown: true });
  assert(!so.ok && /多头/.test(so.error), `加空被拒（${so.error}）`);

  // 平仓两端都放行：无论先平哪一侧，平到只剩单方向就自然收敛
  m.place(N, { action: ACTIONS.BUY_OPEN, qty: lot, price: 21, now: 0, noCooldown: true });
  const sc = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: lot, price: 21, now: 6002, noCooldown: true });
  assert(sc.ok && sc.order.filled === lot, `卖出平多放行${sc.ok ? '' : ': ' + sc.error}`);
  assert(A.longQty(stock.id) === 0 && A.shortQty(stock.id) === lot, '平多后只剩空头（收敛到单方向）');
  assert(!A.sideLock(stock.id).long, '多头方向已释放');
  const ru = m.place(A, { action: ACTIONS.BUY_OPEN, qty: lot, price: 21, now: 9003, noCooldown: true });
  assert(!ru.ok && /空头/.test(ru.error), '仍持空时买开依旧被拒');
}

// ---- 35. 券商通道差异：锁仓时长与「偶发卡顿」都要真的落在撮合层 ----
// 这两条曾经是「配置里写了、文案里写了，撮合层却没读」：锁仓判定写死全局 10 秒
// （滑泰 5 秒只在提示文案里出现），glitchDelay 是零调用方的死函数。这条用例把
// 「per-broker 的通道参数必须由 market/store 真正消费」钉住。
console.log('\n[35] 券商通道（锁仓时长 / 偶发卡顿）落在撮合层');
{
  const lot = stock.lotSize;
  const base = 1000000;
  const m = new Market(stock);
  m.lastPrice = 20;

  // (1) 滑泰：锁仓砍半 5 秒 → 6 秒前的批次应当已可卖
  const A = new Account('滑泰玩家');
  A.broker = 'huatai';
  A.longPos(stock.id).lots.push({ qty: lot, price: 20, ts: base - 6000, reserved: 0 });
  m.place(pad('垫单甲'), { action: ACTIONS.BUY_OPEN, qty: lot, price: 20, now: base - 1, noCooldown: true });
  const s1 = m.place(A, { action: ACTIONS.SELL_CLOSE, qty: lot, price: 20, now: base });
  assert(s1.ok && s1.order.filled === lot, `滑泰 5 秒锁仓：6 秒前的批次已可卖${s1.ok ? '' : '（' + s1.error + '）'}`);

  // (2) 对照：没有券商的账户仍是全局基准 10 秒，同样 6 秒必须被拒
  const B = new Account('基准玩家');
  B.longPos(stock.id).lots.push({ qty: lot, price: 20, ts: base - 6000, reserved: 0 });
  const s2 = m.place(B, { action: ACTIONS.SELL_CLOSE, qty: lot, price: 20, now: base });
  assert(!s2.ok && /10 秒锁仓/.test(s2.error), `无券商账户 6 秒仍锁着，且文案是基准的 10 秒（${s2.error}）`);

  // (3) 滑泰自己也不能提前：4 秒仍然锁着，且文案是券商的 5 秒（不是全局 10 秒）
  const C = new Account('滑泰玩家2');
  C.broker = 'huatai';
  C.longPos(stock.id).lots.push({ qty: lot, price: 20, ts: base - 4000, reserved: 0 });
  const s3 = m.place(C, { action: ACTIONS.SELL_CLOSE, qty: lot, price: 20, now: base });
  assert(!s3.ok && /5 秒锁仓/.test(s3.error), `滑泰 4 秒仍锁着，文案 = 券商的 5 秒（${s3.error}）`);

  // (4) 天疯：锁仓 8 秒 → 6 秒被拒、9 秒放行
  const D = new Account('天疯玩家');
  D.broker = 'tianfeng';
  D.longPos(stock.id).lots.push({ qty: lot, price: 20, ts: base - 6000, reserved: 0 });
  const s4 = m.place(D, { action: ACTIONS.SELL_CLOSE, qty: lot, price: 20, now: base });
  assert(!s4.ok && /8 秒锁仓/.test(s4.error), `天疯 6 秒仍锁着（8 秒锁仓，${s4.error}）`);
  D.longPos(stock.id).lots[0].ts = base - 9000;
  const s5 = m.place(D, { action: ACTIONS.SELL_CLOSE, qty: lot, price: 20, now: base });
  assert(s5.ok, `天疯 9 秒后可卖${s5.ok ? '' : '（' + s5.error + '）'}`);

  // (5) 挂借闸门与卖出闸门同源：滑泰 5 秒过后就能挂借，基准账户 6 秒还不能
  const L1 = new Account('滑泰挂借');
  L1.broker = 'huatai';
  L1.longPos(stock.id).lots.push({ qty: lot, price: 20, ts: base - 6000, reserved: 0 });
  const l1 = m.lendShares(L1, lot, base);
  assert(l1.ok, `滑泰 6 秒后可挂借${l1.ok ? '' : '（' + l1.error + '）'}`);
  const L2 = new Account('基准挂借');
  L2.longPos(stock.id).lots.push({ qty: lot, price: 20, ts: base - 6000, reserved: 0 });
  const l2 = m.lendShares(L2, lot, base);
  assert(!l2.ok, `无券商账户 6 秒不能挂借（${l2.error}）`);

  // (6) 嗨通：偶发通道卡顿 —— 命中时这一单要多等 1 个 tick。
  // 用一个固定值的 Math.random 替身把「命中 / 不命中」两条分支都走成确定性的
  const H = new Account('嗨通玩家');
  H.broker = 'haitong';
  H.cash = 1000000;
  const origRandom = Math.random;
  const cd = brokerCfgOf('haitong').cooldownMs;
  H.lastOrderAt = base - cd - 100; // 冷却刚过 100ms：本该放行
  Math.random = () => 0.5; // 0.5 > 2% → 不卡顿
  const h1 = m.place(H, { action: ACTIONS.BUY_OPEN, qty: lot, price: 20, now: base });
  assert(h1.ok, `嗨通：未命中卡顿时冷却期满即可下单${h1.ok ? '' : '（' + h1.error + '）'}`);
  H.lastOrderAt = base - cd - 100;
  Math.random = () => 0.001; // 0.001 < 2% → 卡顿
  const h2 = m.place(H, { action: ACTIONS.BUY_OPEN, qty: lot, price: 20, now: base });
  assert(!h2.ok && /频繁/.test(h2.error), `嗨通：命中卡顿时多等 1 个 tick（${h2.error}）`);
  Math.random = () => 0.5;
  const h3 = m.place(H, { action: ACTIONS.BUY_OPEN, qty: lot, price: 20, now: base });
  assert(h3.ok, '下一次尝试（未命中）即放行——卡顿只多要 1 个 tick，不累积');
  Math.random = origRandom;

  // (7) 其他券商不吃这个卡顿（features 里没有 glitchRate）
  const Z = new Account('钟信玩家');
  Z.broker = 'zhongxin';
  Z.cash = 1000000;
  Z.lastOrderAt = base - brokerCfgOf('zhongxin').cooldownMs - 100;
  Math.random = () => 0.001;
  const z1 = m.place(Z, { action: ACTIONS.BUY_OPEN, qty: lot, price: 20, now: base });
  Math.random = origRandom;
  assert(z1.ok, `钟信 0.1% 随机数也不受影响${z1.ok ? '' : '（' + z1.error + '）'}`);
}

// ---- 36. 平仓预留与在途委托恒等（撤单错位后自愈）----
// 预留只是批次上的一个数字、不带「是哪张委托占的」，而 reserve 从「最早未占的」占、
// release 从「最早已占的」退、consume 从「最早的」扣——三种遍历顺序。交错时会出现
// 「持仓还在、可平/可卖却是 0，而且没有任何在途委托可撤」（用户实测：空头 900 股可平 0，
// 买入平空被拒「空头持仓不足」）。这一节把 syncReserved 的重摊口径与 reserve 的原子性钉住。
console.log('\n[36] 平仓预留与在途委托恒等');
{
  const qty = 1000; // 10 手（lotSize 100）
  const reservedShort = (acc) =>
    (acc.shorts.get(stock.id)?.lots || []).reduce((s, l) => s + l.reserved, 0);
  const liveCloseRemain = (acc, action) =>
    [...acc.orders.values()]
      .filter((o) => o.status === 'live' && o.action === action)
      .reduce((s, o) => s + (o.qty - o.filled), 0);

  // (1) 空头：撤掉甲之后乙成交，旧实现会把乙的预留永久留在批次上
  const m = new Market(stock);
  m.lastPrice = 20;
  const A = new Account('预留空头');
  A.cash = 5000000;
  const bid36 = pad('垫买36');
  const ask36 = pad('垫卖36');
  let t = 1000000;
  const step = () => (t += 20000);

  m.place(bid36, { action: ACTIONS.BUY_OPEN, qty, price: 20, now: step(), noCooldown: true });
  const o1 = m.place(A, { action: ACTIONS.SELL_OPEN, qty, price: 20, now: step(), noCooldown: true });
  assert(o1.ok && A.shortQty(stock.id) === qty, '开空 1000 股成交，可平 1000');

  const a1 = m.place(A, { action: ACTIONS.BUY_CLOSE, qty, price: 19.2, now: step(), noCooldown: true });
  assert(a1.ok && A.coverableShort(stock.id) === 0, '平空单甲挂出后占住预留，可平归 0');

  // 同向加空：新批次没有预留，于是平空单乙只能压在新批次上
  m.place(bid36, { action: ACTIONS.BUY_OPEN, qty, price: 20.1, now: step(), noCooldown: true });
  m.place(A, { action: ACTIONS.SELL_OPEN, qty, price: 20.1, now: step(), noCooldown: true });
  const a2 = m.place(A, { action: ACTIONS.BUY_CLOSE, qty, price: 19.2, now: step(), noCooldown: true });
  assert(a2.ok && A.shortQty(stock.id) === qty * 2, '加空后共 2000 股，甲乙两张平空单同时在途');

  assert(m.cancel(A, a1.order.id, step(), { internal: true }).ok, '撤掉甲（乙仍在途）');
  assert(
    reservedShort(A) === liveCloseRemain(A, ACTIONS.BUY_CLOSE),
    `撤单后预留量 === 在途平空委托量（${reservedShort(A)} / ${liveCloseRemain(A, ACTIONS.BUY_CLOSE)}）`
  );

  // 乙成交：consume 按 FIFO 先吃最早批次（旧实现吃到的正是「没有预留」的那一批）
  const fill = m.place(ask36, { action: ACTIONS.SELL_OPEN, qty, price: 19.2, now: step(), noCooldown: true });
  assert(fill.ok && fill.order.filled === qty, '垫卖盘把乙打成成交');
  assert(A.shortQty(stock.id) === qty, '平掉 1000 股后仍持有 1000 股空头');
  assert(
    A.coverableShort(stock.id) === qty,
    `残留的 1000 股可平回到 1000（旧实现是 0，且没有在途委托可撤：${A.coverableShort(stock.id)}）`
  );
  assert(A.orders.size === 0, '没有残留的在途委托');

  // (2) 多头同构：sell_close 的预留走同一套逻辑，锁仓已过的批次才可被占用
  const m2 = new Market(stock);
  m2.lastPrice = 20;
  const B = new Account('预留多头');
  B.cash = 5000000;
  const ask2 = pad('垫卖36b');
  const bid2 = pad('垫买36c');
  let u = 2000000;
  const step2 = () => (u += 20000);
  const lockMs = config.trade.lockMs;

  m2.place(ask2, { action: ACTIONS.SELL_OPEN, qty, price: 20, now: step2(), noCooldown: true });
  m2.place(B, { action: ACTIONS.BUY_OPEN, qty, price: 20, now: step2(), noCooldown: true });
  assert(B.longQty(stock.id) === qty, '买入 1000 股多头');
  const b1 = m2.place(B, { action: ACTIONS.SELL_CLOSE, qty, price: 20.2, now: step2(), noCooldown: true });
  assert(b1.ok && B.freeSellableLong(stock.id, u, lockMs) === 0, '卖出平多甲挂出后占住预留，可卖归 0');

  m2.place(ask2, { action: ACTIONS.SELL_OPEN, qty, price: 20.1, now: step2(), noCooldown: true });
  m2.place(B, { action: ACTIONS.BUY_OPEN, qty, price: 20.1, now: step2(), noCooldown: true });
  const b2 = m2.place(B, { action: ACTIONS.SELL_CLOSE, qty, price: 20.2, now: step2(), noCooldown: true });
  assert(b2.ok && B.longQty(stock.id) === qty * 2, '加多后共 2000 股，甲乙两张平多单同时在途');

  assert(m2.cancel(B, b1.order.id, step2(), { internal: true }).ok, '撤掉平多甲');
  m2.place(bid2, { action: ACTIONS.BUY_OPEN, qty, price: 20.2, now: step2(), noCooldown: true });
  assert(B.longQty(stock.id) === qty, '平多乙成交后仍持有 1000 股多头');
  assert(
    B.freeSellableLong(stock.id, u, lockMs) === qty,
    `残留的 1000 股可卖回到 1000（旧实现是 0：${B.freeSellableLong(stock.id, u, lockMs)}）`
  );

  // (3) 预留不够必须整体回滚：半截预留没有委托号，之后再也退不掉
  const C = new Account('预留原子');
  C.shortPos(stock.id).lots.push({ qty: 500, price: 20, margin: 5000, reserved: 0 });
  assert(C.reserveShort(stock.id, 800) === false, '超出可平量的预留被拒');
  assert(C.coverableShort(stock.id) === 500, '被拒时不留半截预留（旧实现留 500）');

  // (4) 老档里的幽灵预留：没有任何在途委托，重启恢复时按委托重摊就该清掉
  const D = new Account('幽灵预留');
  D.shortPos(stock.id).lots.push({ qty: 900, price: 20, margin: 9000, reserved: 900 });
  assert(D.coverableShort(stock.id) === 0, '复现用户现场：空头 900 股、可平 0');
  D.syncReserved(stock.id, lockMs, 2000000);
  assert(D.coverableShort(stock.id) === 900, 'syncReserved 清掉幽灵预留，可平恢复 900');

  const E = new Account('幽灵预留多头');
  E.longPos(stock.id).lots.push({ qty: 900, price: 20, ts: 0, reserved: 900 });
  E.syncReserved(stock.id, lockMs, 2000000);
  assert(E.freeSellableLong(stock.id, 2000000, lockMs) === 900, '多头方向的幽灵预留同样被清掉');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
