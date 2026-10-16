/**
 * 交易日机制测试：node test/day.test.js
 *
 * 覆盖「天」引入后的四块新机制：
 *   ① 交易日时钟 DayCycle —— 纯函数式阶段定位、游戏内时刻映射、竞价撤单锁
 *   ② 集合竞价 —— 只入簿不成交、最大成交量原则定虚拟成交价、阶段结束集中撮合
 *   ③ 时段门控 —— 休市不下单、竞价不撤单、竞价不风控强平
 *   ④ 日终结算 —— 昨收滚动、当日高低量额归零、委托当日作废
 *
 * 本文件用**真实配置**（涨跌停开着、竞价段的真实毫秒数），
 * 与 game.test.js / market.test.js 里「关掉涨跌停 + 锚到上午段」的简化口径互补。
 */
const config = require('../src/config');
// 集合竞价用例需要卖方自由挂单（不依赖融券池里恰好有人挂借出）
config.margin.allowNakedShort = true;

const { DayCycle, formatGameClock } = require('../src/daycycle');
const { Market, ACTIONS } = require('../src/market');
const { Account } = require('../src/store');
const { Game } = require('../src/game');

const STOCK = config.stocks[0];
const ID = STOCK.id;

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

// 一天的各段偏移，写在这里当"标尺"用：竞价 0~30s 上午 30~260s 午休 260~300s
// 下午 300~560s 收盘竞价 560~580s 夜间 580~620s
const P = {
  auction: 0,
  morning: 30000,
  lunch: 260000,
  afternoon: 300000,
  closeAuction: 560000,
  night: 580000,
  dayMs: 620000,
};

/** 造一个挂上交易日时钟的市场 + 几个荷包鼓鼓的账户（买卖两侧要不同账户，同股多空互斥） */
function fresh() {
  const m = new Market(STOCK);
  m.dayCycle = new DayCycle(config.day, 0);
  const mk = (name) => {
    const a = new Account(name, true);
    a.cash = 100000000;
    return a;
  };
  return { m, B1: mk('买方甲'), B2: mk('买方乙'), S1: mk('卖方甲'), S2: mk('卖方乙'), C: mk('路人') };
}

// ============================================================
console.log('\n[1] DayCycle：阶段定位是纯函数，边界不重不漏');
{
  const dc = new DayCycle(config.day, 0);
  assert(dc.ok, '时钟已启用');
  assert(dc.dayMs === P.dayMs, `一天 ${dc.dayMs}ms（6 段合计，与标尺一致）`);
  assert(dc.phases.length === 6, `共 6 个阶段（实际 ${dc.phases.length}）`);

  const at = (t, key, left = null) => {
    const s = dc.locate(t);
    const okKey = s.phase.key === key;
    const okLeft = left === null || s.leftMs === left;
    assert(okKey && okLeft, `t=${t} → ${key}${left === null ? '' : ` 剩 ${left}ms`}（实际 ${s.phase.key} 剩 ${s.leftMs}ms）`);
  };
  at(0, 'auction', P.auction === 0 ? 30000 : null);
  at(29999, 'auction', 1); // 边界前一毫秒仍属竞价
  at(30000, 'morning', 230000); // 边界这一毫秒翻段
  at(259999, 'morning', 1);
  at(260000, 'lunch', 40000);
  at(299999, 'lunch', 1);
  at(300000, 'afternoon', 260000);
  at(559999, 'afternoon', 1);
  at(560000, 'closeAuction', 20000);
  at(579999, 'closeAuction', 1);
  at(580000, 'night', 40000);
  at(619999, 'night', 1);

  const d2 = dc.locate(P.dayMs);
  assert(d2.day === 2 && d2.phase.key === 'auction', `跨到第 2 天并回到开盘竞价（day=${d2.day} ${d2.phase.key}）`);
  assert(dc.locate(P.dayMs * 3 + P.afternoon).day === 4, '第 4 天的下午段定位正确');
  assert(dc.locate(-1).day === 1, '时钟锚点之前的时刻夹到第 1 天（不出现第 0 天/负偏移）');
}

// ============================================================
console.log('\n[2] DayCycle：游戏内时刻映射（顶栏显示的 09:15 / 11:30 就是这么来的）');
{
  const dc = new DayCycle(config.day, 0);
  const clock = (t) => formatGameClock(dc.locate(t).gameClockMs);
  assert(clock(0) === '09:15:00', `开盘竞价起点 ${clock(0)}`);
  assert(clock(15000) === '09:20:00', `开盘竞价中点 ${clock(15000)}（可撤单硬线）`);
  assert(clock(30000) === '09:30:00', `上午开盘 ${clock(30000)}`);
  assert(clock(260000) === '11:30:00', `上午收盘 ${clock(260000)}`);
  assert(clock(300000) === '13:00:00', `下午开盘 ${clock(300000)}`);
  assert(clock(560000) === '14:57:00', `收盘竞价 ${clock(560000)}`);
  assert(clock(580000) === '15:00:00', `收盘 ${clock(580000)}`);
  assert(clock(600000) === '00:07:30', `夜间中点跨日回卷 ${clock(600000)}`);
  assert(clock(619999).startsWith('09:14'), `夜间末尾回卷到次日开盘前 ${clock(619999)}`);
  // 夜间 40 秒要映射 15:00→次日 09:15 的 18 小时 15 分，所以游戏内一夜等于真实一夜
  assert(dc.locate(P.night).phase.gameMs === 1095 * 60000, '夜间阶段映射跨度 1095 分钟（15:00→次日 09:15）');
}

// ============================================================
console.log('\n[3] DayCycle：可交易 / 竞价 / 撤单锁判据');
{
  const dc = new DayCycle(config.day, 0);
  assert(dc.canTrade(0) === true, '开盘竞价可下单（只是不连续撮合）');
  assert(dc.canTrade(P.morning) === true, '上午连续竞价可下单');
  assert(dc.canTrade(P.lunch) === false, '午间休市不可下单');
  assert(dc.canTrade(P.afternoon) === true, '下午连续竞价可下单');
  assert(dc.canTrade(P.closeAuction) === true, '收盘竞价可下单');
  assert(dc.canTrade(P.night) === false, '夜间休市结算不可下单');

  assert(dc.auction(0) === 'open', '开盘集合竞价标识为 open');
  assert(dc.auction(P.morning) === null, '连续竞价无竞价标识');
  assert(dc.auction(P.closeAuction) === 'close', '收盘集合竞价标识为 close');

  // cancelLockMs = 10s：前 20 秒可撤，最后 10 秒锁死（复刻真实市场 09:20 那条硬线）
  assert(dc.auctionLocked(0) === false, '竞价刚开始可撤单');
  assert(dc.auctionLocked(19999) === false, '竞价第 19999ms 仍可撤单');
  assert(dc.auctionLocked(20000) === true, '竞价进入最后 10 秒，撤单被锁');
  assert(dc.auctionLocked(29999) === true, '竞价最后一毫秒仍是锁定的');
  assert(dc.auctionLocked(P.morning) === false, '连续竞价不锁撤单');
  assert(dc.auctionLocked(P.closeAuction + 10000) === true, '收盘竞价同样有 10 秒撤单锁');
}

// ============================================================
console.log('\n[4] DayCycle：下发给客户端的 day 段');
{
  const dc = new DayCycle(config.day, 0);
  const s = dc.snapshot(5000);
  assert(s.enabled === true && s.day === 1 && s.phase === 'auction', '快照带天号与阶段');
  assert(s.trading === true && s.auction === 'open' && s.locked === false, '竞价段可交易、未锁定');
  assert(s.phaseLeftMs === 25000 && s.phaseMs === 30000, `阶段倒计时 ${s.phaseLeftMs}/${s.phaseMs}`);
  assert(s.unlockLeftMs === 15000, `距撤单锁定还有 ${s.unlockLeftMs}ms`);
  assert(s.phaseEndsAt === 30000 && s.dayEndsAt === P.dayMs, '阶段/当日截止时刻正确');

  const s2 = dc.snapshot(25000);
  assert(s2.locked === true && s2.unlockLeftMs === 0, '进入锁定窗口后 unlockLeftMs 归零');

  const s3 = dc.snapshot(P.lunch + 1000);
  assert(s3.trading === false && s3.auction === null && s3.unlockLeftMs === null, '午休段不可交易且无竞价字段');

  // 没配阶段时退化为「没有天」的旧行为，而不是拒绝一切下单
  const off = new DayCycle({ enabled: false, phases: [] }, 0);
  assert(off.ok === false && off.locate(0) === null, '未配置阶段时时钟失效');
  assert(off.canTrade(0) === true && off.auction(0) === null && off.auctionLocked(0) === false, '时钟失效时退化为永远可交易、无竞价');
  assert(off.snapshot(0).enabled === false && off.snapshot(0).trading === true, '失效时钟下发的段是"永远可交易"');
}

// ============================================================
console.log('\n[5] 集合竞价：只入簿不成交，允许买卖价交叉');
{
  const { m, B1, S1 } = fresh();
  assert(m.auctionQuote() === null, '空簿没有虚拟成交价');

  const rb = m.place(B1, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20.5, now: 1000 });
  assert(rb.ok && rb.order.filled === 0, '竞价阶段买单被接受但零成交');
  const oneSide = m.auctionQuote();
  assert(oneSide === null, '只有单边挂单时仍无虚拟成交价（薄盘开不出价）');

  const rs = m.place(S1, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 19.5, now: 1000, noCooldown: true });
  assert(rs.ok && rs.order.filled === 0, '竞价阶段卖单同样零成交');
  assert(m.lastPrice === 20 && m.trades.length === 0, '竞价期间最新价不动、无成交流水');
  assert(B1.longQty(ID) === 0 && S1.shortQty(ID) === 0, '竞价期间双方都不建仓');

  const snap = m.auctionSnapshot(1000);
  assert(snap && snap.kind === 'open', '竞价快照标识为开盘竞价');
  assert(snap.price === 19.5 && snap.volume === 1000, `虚拟成交价 ${snap.price} × ${snap.volume}`);
  assert(m.auctionSnapshot(P.morning) === null, '进入连续竞价后不再下发虚拟成交价');
}

// ============================================================
console.log('\n[6] 集合竞价：最大成交量原则 + 阶段结束按统一价集中撮合');
{
  const { m, B1, S1, S2 } = fresh();
  // 买方只有 1000 股愿意出 21.0；卖方 400 股挂 19.0、900 股挂 21.0
  // 候选价（两侧价位并集）19.0 与 21.0 上可成交量分别为 400 与 1000 → 唯一最优价 21.0
  m.place(B1, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 21.0, now: 1000 });
  m.place(S1, { action: ACTIONS.SELL_OPEN, qty: 400, price: 19.0, now: 1000, noCooldown: true });
  m.place(S2, { action: ACTIONS.SELL_OPEN, qty: 900, price: 21.0, now: 1000, noCooldown: true });
  const q = m.auctionQuote();
  assert(q.price === 21.0 && q.volume === 1000, `最大成交量价 ${q.price}，可成交 ${q.volume} 股`);

  const r = m.runAuction(P.auction + 30001);
  assert(r.price === 21.0 && r.qty === 1000, `集中撮合成交 ${r.qty} 股 @ ${r.price}`);
  assert(m.lastPrice === 21.0, '最新价定格为虚拟成交价');
  assert(m.open === 21.0 && m.high === 21.0 && m.low === 21.0, '今开/最高/最低由竞价成交价填出');
  assert(m.volume === 1000, `当日成交量 ${m.volume}`);
  // 交易所口径：所有成交统一按虚拟成交价，挂 19.0 的卖方也按 21.0 成交
  assert(
    m.trades.length === 2 && m.trades.every((t) => t.price === 21.0) && m.trades.reduce((a, t) => a + t.qty, 0) === 1000,
    `两笔流水合计 1000 股，成交价全部为 21.0（实际 ${m.trades.map((t) => `${t.price}x${t.qty}`).join(' ')}）`
  );
  assert(B1.longQty(ID) === 1000, `买方建仓 ${B1.longQty(ID)} 股`);
  assert(S1.shortQty(ID) === 400 && S2.shortQty(ID) === 600, `卖方分到 ${S1.shortQty(ID)} / ${S2.shortQty(ID)} 股（价格优先、时间优先）`);
  const gap = ((m.lastPrice - m.prevClose) / m.prevClose) * 100;
  assert(Math.abs(gap - 5) < 1e-9, `对昨收 ${m.prevClose} 跳空 +${gap.toFixed(2)}%`);
}

// ============================================================
console.log('\n[7] 集合竞价：竞价位沿用涨跌停，但不受价格笼子约束');
{
  const { m, B1, S1 } = fresh();
  assert(m.band().up === 22 && m.band().down === 18, '昨收 20 → 涨跌停 18 ~ 22');

  const over = m.place(B1, { action: ACTIONS.BUY_OPEN, qty: 100, price: 23.0, now: 1000 });
  assert(!over.ok && /涨跌停/.test(over.error), '竞价阶段照样被涨停价拦住');
  const edge = m.place(B1, { action: ACTIONS.BUY_OPEN, qty: 100, price: 22.0, now: 1000 });
  assert(edge.ok, '正好挂在涨停价上放行');

  // 竞价相对昨收可以有 ±10% 跳空：笼子只认「上一笔成交价 ±5%」，
  // 照笼子判会把所有跳空单都判成脱笼——所以竞价撮合必须绕开笼子
  m.place(S1, { action: ACTIONS.SELL_OPEN, qty: 100, price: 21.9, now: 1000, noCooldown: true });
  const r = m.runAuction(P.auction + 30001);
  assert(r.price === 21.9 && m.lastPrice === 21.9, `跳空 9.5% 能正常开出盘（成交价 ${r.price}，未按笼子撤单）`);
}

// ============================================================
console.log('\n[8] 集合竞价：撤单锁与残留委托');
{
  const { m, B1, S1 } = fresh();
  const rb = m.place(B1, { action: ACTIONS.BUY_OPEN, qty: 500, price: 20.5, now: 1000 });
  const okCancel = m.cancel(B1, rb.order.id, 5000);
  assert(okCancel.ok, '竞价前 20 秒可以撤单');
  assert(B1.orders.size === 0 && Math.abs(B1.cash - 100000000) < 0.01, '撤单后资金全额释放');

  const rb2 = m.place(B1, { action: ACTIONS.BUY_OPEN, qty: 500, price: 20.5, now: 6000 });
  const locked = m.cancel(B1, rb2.order.id, 25000);
  assert(!locked.ok && /锁定/.test(locked.error), '竞价最后 10 秒撤单被拒');
  assert(B1.orders.size === 1, '被拒后委托仍在簿');

  // 卖盘多于买盘时，吃不完的部分留在簿里承接随后的连续竞价
  m.place(S1, { action: ACTIONS.SELL_OPEN, qty: 1500, price: 19.5, now: 6000, noCooldown: true });
  const r = m.runAuction(P.auction + 30001);
  assert(r.qty === 500, `买方 500 股全部成交（实际 ${r.qty}）`);
  const snap = m.snapshot();
  const restAsk = snap.depth.asks.find((d) => d.price === 19.5);
  assert(restAsk && restAsk.qty === 1000, `竞价残单 1000 股留在簿里（盘口 ${restAsk && restAsk.qty}）`);

  // 竞价里买卖价允许交叉，撮合收尾必须扫平，否则进入连续竞价时簿是交叉的
  const bids = m.book.bids[0];
  const asks = m.book.asks[0];
  assert(!bids || !asks || bids.price < asks.price, '集中撮合后订单簿不再交叉');
}

// ============================================================
console.log('\n[9] 竞价期间冻结风控强平');
{
  const { m, B1, S1 } = fresh();
  // 造一个必被强平的账户：满仓空头 + 现金清零（权益为负，远低于维持线×敞口）
  m.place(B1, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20.0, now: 1000 });
  m.place(S1, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20.0, now: 1000, noCooldown: true });
  m.runAuction(P.auction + 30001);
  S1.cash = 0;
  const shortMV = S1.totalShortMV(() => m.lastPrice);
  assert(shortMV > 0 && m.equityOf(S1) < config.margin.maintenance * shortMV, `账户已跌破维持线（空头市值 ${shortMV}，权益 ${m.equityOf(S1)}）`);

  assert(m.maybeLiquidate(S1, 1000) === false, '竞价阶段不强平（那时簿里买卖价允许交叉，会被拉飞）');
  assert(S1.shortQty(ID) === 1000, '空头持仓未被强平消耗');

  // 阶段切换那一 tick：phase 已翻到「上午」，continuousNow() 会误判成可强平，
  // 但此刻竞价撮合正在跑，故必须靠 _auctionRunning 兜住
  m._auctionRunning = true;
  assert(m.maybeLiquidate(S1, P.morning) === false, '竞价撮合进行中即便已进入连续竞价也不强平');
  m._auctionRunning = false;
  assert(m.maybeLiquidate(S1, P.morning) === true, '真正进入连续竞价后强平恢复正常');
  assert(S1.shortQty(ID) === 0, '强平已把空头清掉');
}

// ============================================================
console.log('\n[10] 时段门控：休市暂停下单，竞价只入簿');
{
  const { m, C } = fresh();
  const lunch = m.place(C, { action: ACTIONS.BUY_OPEN, qty: 100, price: 20, now: P.lunch + 1000 });
  assert(!lunch.ok && /午间休市/.test(lunch.error), `午休下单被拒（${lunch.error}）`);
  const night = m.place(C, { action: ACTIONS.BUY_OPEN, qty: 100, price: 20, now: P.night + 1000 });
  assert(!night.ok && /休市结算/.test(night.error), `夜间下单被拒（${night.error}）`);
  const aft = m.place(C, { action: ACTIONS.BUY_OPEN, qty: 100, price: 20, now: P.afternoon + 1000 });
  assert(aft.ok, '下午连续竞价放行');

  assert(m.tradingNow(P.lunch) === false && m.closedForTrading(P.lunch) === true, '午休：不可交易 / 已休市');
  assert(m.continuousNow(P.auction) === false && m.continuousNow(P.morning) === true, '竞价非连续撮合段，上午是连续竞价');
  assert(m.closedForTrading(P.auction) === false, '集合竞价不算休市（公允价值按盘中口径迁移）');

  // 未挂时钟的孤立 Market 全部门控退化为旧行为
  const bare = new Market(STOCK);
  assert(bare.band() === null, '无交易日时钟时没有昨收口径，涨跌停区间为 null（否则会死锁）');
  assert(bare.tradingNow(0) === true && bare.continuousNow(0) === true && bare.closedForTrading(0) === false, '无时钟时永远可交易');
}

// ============================================================
console.log('\n[11] 日终结算：昨收滚动、当日高低量额归零、委托当日作废');
{
  const { m, B1, S1, C } = fresh();
  m.place(B1, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 21.0, now: 1000 });
  m.place(S1, { action: ACTIONS.SELL_OPEN, qty: 400, price: 19.0, now: 1000, noCooldown: true });
  m.place(S1, { action: ACTIONS.SELL_OPEN, qty: 900, price: 21.0, now: 1000, noCooldown: true });
  m.runAuction(P.auction + 30001);
  assert(m.lastPrice === 21.0 && m.volume === 1000, `收盘前最新价 ${m.lastPrice}，成交量 ${m.volume}`);

  // 下午挂一笔不会成交的买单（远低于盘口），用来验证"当日作废"
  const rest = m.place(C, { action: ACTIONS.BUY_OPEN, qty: 100, price: 20.0, now: P.afternoon + 1000 });
  assert(rest.ok && rest.order.status === 'live', '该买单挂在簿上等收盘');
  assert(C.orderFrozen > 0 && C.cash < 100000000, '挂单资金已冻结');

  const st = m.settleDay(P.closeAuction + 20001, { cancelOrders: true });
  assert(st.prevClose === 21.0, `昨收滚动到收盘价 ${st.prevClose}`);
  assert(m.open === 21.0 && m.high === 21.0 && m.low === 21.0, '今开/最高/最低重置到收盘价');
  assert(m.volume === 0 && m.turnover === 0, '当日成交量/额归零');
  assert(m.dayTradeCount === 0, '「本日已成交」计数归零（次日首笔重新决定今开）');
  assert(st.canceled >= 1, `${st.canceled} 笔未成交委托当日作废`);
  assert(C.orders.size === 0 && C.orderFrozen === 0, '委托作废后账户挂单表与冻结归零');
  assert(Math.abs(C.cash - 100000000) < 0.01, '冻结资金全额退回');
  const band = m.band();
  assert(band.up === 23.1 && band.down === 18.9, `涨跌停区间随新昨收滚动到 ${band.down} ~ ${band.up}`);
}

// ============================================================
console.log('\n[12] 次日开盘竞价：隔夜跳空');
{
  const { m, B1, S1, C } = fresh();
  m.place(B1, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 21.0, now: 1000 });
  m.place(S1, { action: ACTIONS.SELL_OPEN, qty: 400, price: 19.0, now: 1000, noCooldown: true });
  m.place(S1, { action: ACTIONS.SELL_OPEN, qty: 900, price: 21.0, now: 1000, noCooldown: true });
  m.runAuction(P.auction + 30001);
  m.settleDay(P.closeAuction + 20001, { cancelOrders: true });
  assert(m.prevClose === 21.0, `第 1 天收盘 ${m.prevClose}`);

  // 第 2 天开盘竞价（区间 P.dayMs ~ P.dayMs+30s）
  const d2 = P.dayMs + 1000;
  const rd = m.place(B1, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 22.9, now: d2 });
  assert(rd.ok, `次日竞价买单挂入（涨停已放宽到 23.1）`);
  m.place(C, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 21.5, now: d2, noCooldown: true });
  const r = m.runAuction(P.dayMs + P.auction + 30001);
  assert(r.price === 21.5 && r.qty === 1000, `次日开盘成交价 ${r.price} × ${r.qty}`);
  assert(m.open === 21.5 && m.prevClose === 21.0, `今开 ${m.open} 高于昨收 ${m.prevClose}，跳空成立`);
  assert(m.volume === 1000, '次日的成交量从 0 重新累计（不与前一天串号）');
}

// ============================================================
console.log('\n[13] Game 集成：阶段切换驱动集合竞价撮合与日终结算');
{
  const g = new Game();
  // 与 game.test.js 相同的「手动初始化」：不启动 setInterval，但把每只股票的 NPC 池建起来
  for (const s of config.stocks) {
    g.npcs.get(s.id).init(g.startedAt);
    const mk = g.markets.get(s.id);
    mk.priceHistory.push({ t: g.startedAt, price: mk.lastPrice });
  }
  g.index.update(g.markets, g.startedAt);

  const mk0 = g.markets.get(ID);
  const npc0 = g.npcs.get(ID);

  // 把时钟锚到第 1 天收盘集合竞价
  g.day.reanchor(Date.now() - P.closeAuction);
  g.tick();
  assert(g._dayState && g._dayState.phase.key === 'closeAuction', 'tick 定位到收盘集合竞价');
  assert(g._daySettled === 0, '尚未结算');

  // 跨过收盘 → 夜间：此刻应触发日终结算
  const volBefore = mk0.volume;
  g.day.reanchor(Date.now() - P.night);
  g.tick();
  assert(g._dayState.phase.key === 'night', 'tick 定位到夜间休市段');
  assert(g._daySettled === 1, `日终结算已执行（_daySettled=${g._daySettled}）`);
  assert(mk0.prevClose === mk0.lastPrice, `昨收滚动到收盘价 ${mk0.prevClose}`);
  assert(mk0.volume === 0, '全部股票当日成交量归零');

  // 休市期间价格冻结，但公允价值继续迁移（隔夜跳空的燃料）
  const frozen = mk0.lastPrice;
  const fvBefore = npc0.fairValue;
  for (let i = 0; i < 3; i++) g.tick();
  assert(mk0.lastPrice === frozen, `夜间休市价格冻结在 ${mk0.lastPrice}`);
  assert(typeof npc0.fairValue === 'number' && npc0.fairValue > 0, `夜间公允价值仍在推进（${fvBefore.toFixed(3)} → ${npc0.fairValue.toFixed(3)}）`);

  // 下发给客户端的 day 段
  const st = g.stateFor('nobody');
  assert(st.day && st.day.day === 1 && st.day.phase === 'night', `stateFor 带 day 段（第 ${st.day.day} 天 ${st.day.phase}）`);
  assert(st.day.trading === false && st.day.enabled === true, '休市段如实下发 trading=false');

  // 跨过夜间 → 第 2 天开盘竞价
  g.day.reanchor(Date.now() - P.dayMs - 5000);
  g.tick();
  assert(g._dayState.day === 2 && g._dayState.phase.key === 'auction', `第 2 天开盘竞价（day=${g._dayState.day} ${g._dayState.phase.key}）`);
  assert(volBefore === 0 || mk0.volume >= 0, '成交量口径自洽');
}

// ============================================================
console.log('\n[14] 续跑补结算：只结「已收盘」的交易日，不误结今天');
{
  const g = new Game();
  for (const s of config.stocks) {
    g.npcs.get(s.id).init(g.startedAt);
    g.markets.get(s.id).priceHistory.push({ t: g.startedAt, price: g.markets.get(s.id).lastPrice });
  }
  g.index.update(g.markets, g.startedAt);
  const mk = g.markets.get(ID);

  // ① day1 上午、从未结算：今天还没收盘，不能结
  g._daySettled = 0;
  mk.volume = 999;
  mk.lastPrice = 22.0;
  g.day.reanchor(Date.now() - P.morning - 5000);
  g.ensureDaySettled(Date.now());
  assert(g._daySettled === 0, `day1 上午不误结（_daySettled=${g._daySettled}）`);
  assert(mk.volume === 999 && mk.prevClose === 20, `day1 上午量额与昨收原样（vol=${mk.volume} prevClose=${mk.prevClose}）`);

  // ② day2 上午、昨天已结：仍不能结今天
  g._daySettled = 1;
  mk.volume = 5000;
  mk.lastPrice = 21.5;
  g.day.reanchor(Date.now() - P.dayMs - P.morning - 5000);
  g.ensureDaySettled(Date.now());
  assert(g._daySettled === 1, `day2 上午不误结（_daySettled=${g._daySettled}）`);
  assert(mk.volume === 5000 && mk.prevClose === 20, `day2 上午量额与昨收原样（vol=${mk.volume} prevClose=${mk.prevClose}）`);

  // ③ day1 夜间、从未结算：今天已收盘，该结
  g._daySettled = 0;
  mk.lastPrice = 23.0;
  g.day.reanchor(Date.now() - P.night);
  g.ensureDaySettled(Date.now());
  assert(g._daySettled === 1, `day1 夜间补结（_daySettled=${g._daySettled}）`);
  assert(mk.prevClose === 23, `昨收滚到收盘价 ${mk.prevClose}`);

  // ④ day3 上午、停机跨过两天：补结到「已收盘的第 2 天」，不能记成 3
  //    （记成 3 的话今晚 day3 的日终结算会被跳过）
  g._daySettled = 0;
  g.day.reanchor(Date.now() - P.dayMs * 2 - P.morning - 5000);
  assert(g.day.locate(Date.now()).day === 3, '已定位到第 3 天');
  g.ensureDaySettled(Date.now());
  assert(g._daySettled === 2, `补结算把进度推到已收盘的第 ${g._daySettled} 天`);
  g.ensureDaySettled(Date.now());
  assert(g._daySettled === 2, '同一天重复调用不会重复结算');

  // 时钟没配阶段时应是空操作，不能抛
  g.day = new DayCycle({ enabled: false, phases: [] }, Date.now());
  let threw = false;
  try {
    g.catchUpDay(Date.now());
  } catch (e) {
    threw = true;
  }
  assert(!threw, '时钟未启用时补结算是空操作');
}

// ============================================================
console.log('\n[15] tick 跨过收盘竞价：兜底结算，昨收不能锚死在几天前');
{
  const g = new Game();
  for (const s of config.stocks) {
    g.npcs.get(s.id).init(g.startedAt);
    g.markets.get(s.id).priceHistory.push({ t: g.startedAt, price: g.markets.get(s.id).lastPrice });
  }
  g.index.update(g.markets, g.startedAt);
  const mk = g.markets.get(ID);

  // 先落在 day1 上午，建立 _dayState
  g.day.reanchor(Date.now() - P.morning - 5000);
  g.tick();
  assert(g._dayState.day === 1 && g._dayState.phase.key === 'morning', 'tick1 在 day1 上午');
  assert(g._daySettled === 0, '尚未结算');
  mk.lastPrice = 23.5;
  mk.volume = 5000;

  // 休眠唤醒：一 tick 直接跳到 day2 上午（跨过了 closeAuction + night）
  g.day.reanchor(Date.now() - P.dayMs - P.morning - 5000);
  g.tick();
  assert(g._dayState.day === 2 && g._dayState.phase.key === 'morning', 'tick2 在 day2 上午');
  assert(g._daySettled === 1, `跨阶段跳跃仍补结（_daySettled=${g._daySettled}）`);
  assert(mk.prevClose === 23.5, `昨收滚到停机前最后价 ${mk.prevClose}`);
  // 补结把量额清零后，上午恢复交易会重新累计——不以 volume===0 作断言
}

// ============================================================
console.log('\n[16] 竞价收尾：自成交残单走撤单，不产生幽灵单');
{
  const { m, B1 } = fresh();
  // 同一账户买开 + 卖平（持多时两者都合法），价格交叉
  const lot = B1.longPos(ID);
  lot.lots.push({ qty: 200, price: 20, reserved: 0, ts: -60000, debt: 0, principal: 0 });
  const rb = m.place(B1, { action: ACTIONS.BUY_OPEN, qty: 100, price: 20.0, now: 1000 });
  const rs = m.place(B1, { action: ACTIONS.SELL_CLOSE, qty: 100, price: 19.0, now: 1001 });
  assert(rb.ok && rs.ok, '同账户两侧都能挂进竞价簿');
  assert(m.book.bids.length === 1 && m.book.asks.length === 1, '竞价簿里买卖各一、允许交叉');

  const q = m.auctionQuote();
  assert(q && q.price === 20 && q.volume === 100, `虚拟成交价显示 ${q && q.price} × ${q && q.volume}`);
  const r = m.runAuction(1002);
  assert(r.qty === 0, `自成交不撮合（实撮 ${r.qty} 股）`);

  const ghosts = [...B1.orders.values()].filter((o) => o.status === 'live' && !m.book.orders.has(o.id));
  assert(ghosts.length === 0, `无幽灵活单（残留 ${ghosts.length} 张）`);
  // 被撤掉的卖单要把仓位预留退回
  assert(lot.lots[0].reserved === 0, `卖单预留已释放（reserved=${lot.lots[0].reserved}）`);
  assert(m.book.bids.length === 1 && m.book.asks.length === 0, '买侧保留、卖侧已撤');
}

// ============================================================
console.log('\n[17] 公允迁移：只有夜间放大，午休不制造假跳空');
{
  const g = new Game();
  for (const s of config.stocks) {
    g.npcs.get(s.id).init(g.startedAt);
    g.markets.get(s.id).priceHistory.push({ t: g.startedAt, price: g.markets.get(s.id).lastPrice });
  }
  g.index.update(g.markets, g.startedAt);
  const npc0 = g.npcs.get(ID);
  const mk = g.markets.get(ID);
  // 固定锚点：now = anchor + 阶段偏移，各阶段共用同一把尺
  const anchor = Date.now() - (P.night + 1000);
  g.day.reanchor(anchor);

  const at = (phaseOffset) => {
    const now = anchor + phaseOffset;
    npc0.fairValue = 20;
    npc0.fund = 20;
    npc0.trendDrift = 0.001;
    npc0.regime = 1;
    npc0.regimeIn = 1000;
    const real = Math.random;
    Math.random = () => 0.5;
    try {
      npc0.stepFairValue(now);
    } finally {
      Math.random = real;
    }
    return { delta: npc0.fairValue - 20, closed: mk.closedForTrading(now), night: mk.isNight(now) };
  };

  const m1 = at(P.morning + 1000);
  const l1 = at(P.lunch + 1000);
  const n1 = at(P.night + 1000);
  assert(m1.closed === false && m1.night === false, '上午：可交易、非夜间');
  assert(l1.closed === true && l1.night === false, '午休：休市但不是夜间');
  assert(n1.closed === true && n1.night === true, '夜间：休市且是夜间');
  assert(Math.abs(l1.delta - m1.delta) < 1e-9, `午休步进与上午相同（${m1.delta.toFixed(6)} vs ${l1.delta.toFixed(6)}）`);
  assert(Math.abs(n1.delta - m1.delta * 3) < 1e-9, `夜间步进是上午的 3 倍（${n1.delta.toFixed(6)} vs ${(m1.delta * 3).toFixed(6)}）`);
}

// ============================================================
console.log('\n[18] 盘后消息：作用期跨夜，次日开盘竞价仍驱动情绪与公允价值');
{
  const g = new Game();
  for (const s of config.stocks) {
    g.npcs.get(s.id).init(g.startedAt);
    g.markets.get(s.id).priceHistory.push({ t: g.startedAt, price: g.markets.get(s.id).lastPrice });
  }
  g.index.update(g.markets, g.startedAt);

  // 锚进 day1 夜间（580s 起，已走 2s），强制当晚出一条盘后消息
  const anchor = Date.now() - P.night - 2000;
  g.day.reanchor(anchor);
  g.news.nextAt = 0;
  g.tick();
  assert(g._dayState.phase.key === 'night', 'tick 定位到夜间休市段');
  const n = g.lastNews;
  assert(!!n && n.session === '盘后', `夜间消息带「盘后」标签（${n && n.session}）`);

  // 作用期被抬到次日开盘竞价结束：60s 墙钟会在夜间结束前就让消息过期
  const st = g.day.locate(n.t);
  const openAuction = g.day.phases.find((p) => p.auction === 'open');
  const auctionEnd = st.dayEndsAt + openAuction.ms;
  assert(n.until === auctionEnd, `作用期 = 次日开盘竞价结束（until=${n.until}，竞价末=${auctionEnd}）`);
  assert(n.until > n.t + config.news.durationMs, `比 60s 墙钟长（自然过期 ${n.t + config.news.durationMs} < until）——否则隔夜迁移吃不到它`);

  // 次日开盘竞价中段：消息仍 active，情绪与公允推力都还在（这就是「影响次日开盘」）
  const inAuction = st.dayEndsAt + 15000;
  assert(g.news.active.some((x) => x.id === n.id && x.until > inAuction), '开盘竞价中段消息仍生效');
  const senti = g.news.sentiment(n.scope, inAuction, n.stockId);
  assert(Math.abs(senti) > 0.01, `竞价中段情绪非零（${senti.toFixed(3)}）`);
  const drift = g.news.fvDrift(inAuction, n.stockId);
  assert(Math.abs(drift) > 1e-6, `竞价中段公允推力非零（${drift.toExponential(2)}）`);
  // 竞价结束那一刻恰好过期，不拖进盘中
  assert(g.news.sentiment(n.scope, auctionEnd, n.stockId) === 0, '竞价结束即过期（不拖进盘中）');

  // 换阶段重排在 Game 层生效：下午排出的远期倒计时不会吞掉整个夜间
  g.day.reanchor(Date.now() - P.afternoon - 5000);
  g.tick();
  assert(g.news.nextAtPhase === 'afternoon', `阶段登记切到下午（${g.news.nextAtPhase}）`);
  g.news.nextAt = Date.now() + 999999;
  g.day.reanchor(Date.now() - P.night - 1000);
  g.tick();
  const gap = g.news.nextAt - Date.now();
  assert(g.news.nextAtPhase === 'night', `阶段登记切到夜间（${g.news.nextAtPhase}）`);
  assert(gap > 0 && gap <= config.news.phaseRules.night.maxIntervalMs, `夜间倒计时被拉回盘后节奏（${gap}ms ∈ (${config.news.phaseRules.night.minIntervalMs}, ${config.news.phaseRules.night.maxIntervalMs}]）`);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
