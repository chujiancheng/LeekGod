/**
 * 自动化交易测试：node test/auto.test.js
 * 覆盖：四种策略的参数校验 / 触发执行 / 启停删除 / 存档往返
 * 时间推进一律显式传入 now（绕开真实时钟与 2 秒下单冷却的纠缠）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, ACTIONS } = require('../src/game');
const { Persister } = require('../src/persist');
const config = require('../src/config');

// ---- 多股票测试辅助：测试聚焦「大米集团」(config.stocks[0]) ----
// P(g)/N(g)：取某局里大米集团的市场与做市引擎（多股票后 Game 持的是 Map）
const STOCK = config.stocks[0];
const P = (g) => g.markets.get(STOCK.id);
const N = (g) => g.npcs.get(STOCK.id);

// 涨跌停是日频机制（区间以昨收为基准，一天最多 ±pct）。本文件验的是策略参数校验与触发，
// 用例里按盘口 1.05 倍打价是常态，开着涨跌停会被拦在门外。
// 涨跌停与集合竞价、日终结算由 test/day.test.js 专门覆盖（那边用真实配置）。
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

const g = new Game();
const stock = STOCK;
// 交易日时钟锚到「上午连续竞价」段内，免得整段用例都卡在集合竞价里没有成交
g.day.reanchor(Date.now() - 120000);
N(g).init(g.startedAt);
P(g).priceHistory.push({ t: g.startedAt, price: P(g).lastPrice, vol: 0 });
N(g).step(g.startedAt);

// 仿真若干 tick 让盘口成型
for (let i = 0; i < 30; i++) g.tick();

const lr = g.onboard('quantuser', 'quantuser', 'zhaoshang');
assert(lr.ok && !!lr.token, '玩家登录成功');
const token = lr.token;
const acc = g.store.get('quantuser');

let clock = Date.now();
const nextT = () => (clock += 3000); // 每步推进 3 秒，避开下单冷却

console.log('\n[1] 参数校验');
{
  const bad1 = g.auto.create(acc, 'nope', {}, STOCK.id);
  assert(!bad1.ok, '未知类型被拒');

  const bad2 = g.auto.create(acc, 'tps', { position: 'long' }, STOCK.id);
  assert(!bad2.ok && /至少设置一个/.test(bad2.error), '止盈止损不设任何条件被拒');

  const bad3 = g.auto.create(acc, 'grid', { stepPct: 0.01, qty: 100, maxLevels: 5 }, STOCK.id);
  assert(!bad3.ok && /间距/.test(bad3.error), '网格间距过小被拒');

  const bad4 = g.auto.create(acc, 'grid', { stepPct: 2, qty: 150, maxLevels: 5 }, STOCK.id);
  assert(!bad4.ok && /整数倍/.test(bad4.error), '网格数量非整手被拒');

  const bad5 = g.auto.create(acc, 'ma', { fast: 10, slow: 15, budgetPct: 50 }, STOCK.id);
  assert(!bad5.ok && /慢线/.test(bad5.error), '均线慢线离快线太近被拒');

  const bad6 = g.auto.create(acc, 'dca', { amount: 100, intervalMs: 1000 }, STOCK.id);
  assert(bad6.ok, '定投间隔低于下限自动夹到最小值');
  const dca = g.auto.byId.get(bad6.id);
  assert(dca.params.intervalMs >= 5000, `定投间隔被夹到 ${dca.params.intervalMs}ms`);
  g.auto.remove(acc, bad6.id);
}

console.log('\n[2] 止盈止损：触发即卖出并完成');
{
  // 先买入建仓（noCooldown 绕冷却，测试重点不在冷却）
  const ask = P(g).book.asks[0];
  const buyR = P(g).place(acc, {
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: P(g).roundPrice(ask.price * 1.05),
    now: nextT(),
    noCooldown: true,
  });
  assert(buyR.ok && acc.longQty(stock.id) >= 100, `建仓成功（持仓 ${acc.longQty(stock.id)}）`);

  // 止盈价设得极低 → 永远满足 last >= tp，立即触发
  const cr = g.auto.create(acc, 'tps', { position: 'long', tp: 0.01, sl: 0, qty: 0 }, STOCK.id);
  assert(cr.ok, '止盈止损策略创建成功');
  const t0 = g.auto.byId.get(cr.id);
  assert(t0.enabled && !t0.done, '创建后处于启用状态');

  // 绕过 T+2 分钟锁仓：把刚买的批次时间往前拨
  const pos = acc.longs.get(stock.id);
  for (const lot of pos.lots) lot.ts = Date.now() - 3 * 60 * 1000;

  const longBefore = acc.longQty(stock.id);
  g.auto.step(nextT());
  assert(t0.done && !t0.enabled, '触发后自动完成并停用');
  assert(acc.longQty(stock.id) < longBefore || acc.orders.size > 0, '已发出卖出委托或持仓已减少');
  const evt = t0.events[0];
  assert(evt && /触发/.test(evt.text), `动作日志记录触发（${evt && evt.text}）`);

  // 完成后不能重新启用
  const re = g.auto.update(acc, cr.id, { enabled: true });
  assert(!re.ok, '已完成策略不允许重新启用');

  g.auto.remove(acc, cr.id);
  assert(g.auto.byId.get(cr.id) == null, '策略删除成功');
}

console.log('\n[3] 网格：跌到格子挂买单，成交后记入格子库存');
{
  const base = P(g).lastPrice;
  const cr = g.auto.create(acc, 'grid', { base, stepPct: 5, qty: 100, maxLevels: 3 }, STOCK.id);
  assert(cr.ok, '网格策略创建成功');
  const s = g.auto.byId.get(cr.id);

  // 不动价格：不应触发
  g.auto.step(nextT());
  assert(!s.state.pendingBuyId && !s.state.pendingSellId, '价格未到格子不触发');

  // 把最新价压到第一格之下（只改内存行情，不走撮合）
  const bp1 = P(g).roundPrice(base * 0.95);
  P(g).lastPrice = P(g).roundPrice(bp1 * 0.99);
  g.auto.step(nextT());
  assert(!!s.state.pendingBuyId, `价格跌破第 1 格触发买入挂单（${s.state.pendingBuyId || '-'}）`);
  assert(s.state.pendingBuyLevel === 1, '买入挂在第 1 格');

  // 模拟这笔挂单成交。刻意不走真实撮合：盘口里 NPC 的买价会随机抢在网格单前面，
  // 让「吃单」变成掷骰子。这里直接把状态推进到撮合成功后的样子（已成交 + 出簿），
  // 网格的结算分支本来就是从委托历史里读取成交量——撮合本身由 market.test.js 覆盖。
  const gridOrder = acc.orders.get(s.state.pendingBuyId);
  if (gridOrder) {
    gridOrder.filled = gridOrder.qty;
    gridOrder.status = 'filled';
    P(g).book.remove(gridOrder);
    acc.orders.delete(gridOrder.id);
    // 同时补上撮合本该产生的多头批次（成交后才有券可卖）
    acc.longPos(stock.id).lots.push({
      qty: gridOrder.qty, price: gridOrder.price, ts: 0, reserved: 0, debt: 0, principal: 0,
    });
  }
  g.auto.step(nextT()); // 结算挂单 → 记入 buys
  assert(s.state.buys.length === 1 && s.state.buys[0].shares > 0, `网格买单成交入库（${s.state.buys[0] && s.state.buys[0].shares} 股）`);
  assert(s.state.nextLevel === 1, 'nextLevel 推进到 1');

  // 价格拉回基准之上 → 第 1 格卖出目标 = base*1.05
  P(g).lastPrice = P(g).roundPrice(base * 1.06);
  // 锁仓 2 分钟：新建仓不能立刻卖。推进时间越过锁仓窗口
  for (const lot of acc.longs.get(stock.id).lots) lot.ts = Date.now() - 3 * 60 * 1000;
  g.auto.step(nextT());
  assert(!!s.state.pendingSellId, '价格达到第 1 格卖出目标，触发卖出');

  g.auto.remove(acc, cr.id);
}

console.log('\n[4] 双均线：构造先涨后跌序列，先金叉买、再死叉卖');
{
  // 重置一条干净的价格序列：前 40 点上涨，后 40 点下跌
  const h = P(g).priceHistory;
  h.length = 0;
  const base = P(g).lastPrice;
  for (let i = 0; i < 40; i++) h.push({ t: Date.now() - (80 - i) * 700, price: base * (1 + i * 0.01), vol: 0 });
  for (let i = 0; i < 40; i++) h.push({ t: Date.now() - (40 - i) * 700, price: base * 1.39 * (1 - i * 0.02), vol: 0 });

  const cr = g.auto.create(acc, 'ma', { fast: 10, slow: 30, budgetPct: 30 }, STOCK.id);
  assert(cr.ok, '双均线策略创建成功');
  const s = g.auto.byId.get(cr.id);

  // 当前序列是下跌尾声 → 初始 side=0（空头排列），金叉需要先翻上去
  g.auto.step(nextT());
  assert(s.state.lastSide === 0, `初始判定为空头排列（lastSide=${s.state.lastSide}）`);

  // 造金叉：把序列尾部换成急涨
  for (let i = 0; i < 15; i++) h.push({ t: Date.now() + i * 700, price: base * 1.5 * (1 + i * 0.02), vol: 0 });
  while (h.length > 200) h.shift();
  P(g).lastPrice = h[h.length - 1].price;
  g.auto.step(nextT());
  assert(s.state.lastSide === 1, `翻为多头排列（lastSide=${s.state.lastSide}）`);
  // 金叉后立即尝试买入（可能因冷却等待，再给一步）
  if (s.state.pendingSignal === 1) g.auto.step(nextT());
  assert(s.state.pendingSignal == null, '金叉信号已消化（买入完成或放弃）');
  assert(
    s.events.some((e) => /金叉/.test(e.text)),
    '动作日志出现金叉记录'
  );

  g.auto.remove(acc, cr.id);
}

console.log('\n[5] 定投：按间隔买入并计数');
{
  const cr = g.auto.create(acc, 'dca', { amount: 20000, intervalMs: 60000, maxTimes: 2 }, STOCK.id);
  assert(cr.ok, '定投策略创建成功');
  const s = g.auto.byId.get(cr.id);

  g.auto.step(nextT());
  assert(s.state.doneTimes === 1, `第 1 次定投完成（doneTimes=${s.state.doneTimes}）`);
  assert(s.state.nextAt > Date.now(), 'nextAt 顺延到下一个间隔');

  // 间隔未到：不触发
  g.auto.step(nextT());
  assert(s.state.doneTimes === 1, '间隔未到不重复买入');

  // 推进到下次时间
  g.auto.step(s.state.nextAt + 1);
  assert(s.state.doneTimes === 2, `第 2 次定投完成（doneTimes=${s.state.doneTimes}）`);
  assert(s.done, '达到总次数后自动完成');

  g.auto.remove(acc, cr.id);
}

console.log('\n[6] 状态快照与数量上限');
{
  const cr1 = g.auto.create(acc, 'dca', { amount: 5000, intervalMs: 60000, maxTimes: 0 }, STOCK.id);
  const st = g.stateFor(token);
  assert(st.account.auto && st.account.auto.length >= 1, 'state.account.auto 包含策略列表');
  const row = st.account.auto.find((x) => x.id === cr1.id);
  assert(row && row.typeLabel === '定投', '序列化包含类型标签');
  assert(st.rules.auto && st.rules.auto.maxPerAccount > 0, '规则下发自动交易配置');

  // 启停
  const up = g.auto.update(acc, cr1.id, { enabled: false });
  assert(up.ok && g.auto.byId.get(cr1.id).enabled === false, '暂停成功');
  const up2 = g.auto.update(acc, cr1.id, { enabled: true });
  assert(up2.ok && g.auto.byId.get(cr1.id).enabled === true, '恢复成功');

  // HTTP 层入口
  const r = g.createAuto(token, { type: 'dca', params: { amount: 1000, intervalMs: 60000 } });
  assert(r.ok, 'game.createAuto 入口可用');
  const rBad = g.createAuto('bad-token', { type: 'dca', params: {} });
  assert(!rBad.ok && /登录/.test(rBad.error || ''), '未登录被拒');
  const rRemove = g.removeAuto(token, { id: r.id });
  assert(rRemove.ok, 'game.removeAuto 入口可用');

  g.auto.remove(acc, cr1.id);
}

console.log('\n[7] 存档往返：策略随重启恢复');
{
  const FILE = path.join(os.tmpdir(), `gushen-auto-test-${process.pid}.db`);
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(FILE + suffix, { force: true });
      } catch (e) {
        /* 忽略 */
      }
    }
  };
  cleanup();

  const p1 = new Persister(FILE);
  const g1 = new Game({ persist: p1 });
  g1.start();
  g1.stop();
  const login1 = g1.onboard('saveruser', 'saveruser', 'zhaoshang');
  const acc1 = g1.store.get('saveruser');
  const cr = g1.auto.create(acc1, 'tps', { position: 'long', tp: 999, sl: 1 }, STOCK.id);
  const cr2 = g1.auto.create(acc1, 'grid', { stepPct: 3, qty: 100, maxLevels: 5 }, STOCK.id);
  assert(cr.ok && cr2.ok, '存档局创建两条策略');
  g1.auto.update(acc1, cr2.id, { enabled: false }); // 启停状态也要随档走
  g1.tick();
  const equityBefore = acc1.equity(STOCK.id, P(g1).lastPrice);
  p1.close();

  const p2 = new Persister(FILE);
  const g2 = new Game({ persist: p2 });
  g2.start();
  g2.stop();
  const restored = g2.auto.listFor('saveruser');
  assert(restored.length === 2, `重启后恢复 2 条策略（实际 ${restored.length}）`);
  const rTps = restored.find((s) => s.type === 'tps');
  const rGrid = restored.find((s) => s.type === 'grid');
  assert(rTps && rTps.params.tp === 999 && rTps.params.sl === 1, '止盈止损参数完整恢复');
  assert(rGrid && rGrid.enabled === false, '暂停状态随档恢复');
  const acc2 = g2.store.get('saveruser');
  const equityAfter = acc2.equity(STOCK.id, P(g2).lastPrice);
  assert(Math.abs(equityAfter - equityBefore) < 0.5, `重启前后权益守恒（${equityBefore} → ${equityAfter}）`);
  p2.close();
  cleanup();
}

// ---- 8. 自动策略的锁仓口径按账户券商取（滑泰 5 秒 / 基准 10 秒） ----
// 自动策略走的是 market.place 同一条下单路径，锁仓闸门必须与手动下单同源：
// 早先 auto 只读全局 10 秒，滑泰玩家手动能卖、策略却要干等到 10 秒，两边打架。
console.log('\n[8] 自动策略的锁仓口径按账户券商取');
{
  const lot = stock.lotSize;
  // 时刻显式指定：批次 ts = T − 6000，则 now − ts 恰好 6000ms，
  // 落在「滑泰 5 秒已解锁」与「基准 10 秒仍锁着」之间，两侧各验一次
  const sellAt6s = (account, brokerKey) => {
    const T = nextT();
    g.day.reanchor(T - 120000); // 锚回上午连续竞价，避免长跑后漂到休市被整体冻结
    const lr = g.onboard(account, account, brokerKey);
    assert(lr.ok, `${brokerKey} 玩家 ${account} 开户成功`);
    const a = g.store.get(account);
    a.longPos(stock.id).lots.push({
      qty: lot, price: P(g).lastPrice, ts: T - 6000, reserved: 0, debt: 0, principal: 0,
    });
    const cr = g.auto.create(a, 'tps', { position: 'long', tp: 0.01, sl: 0, qty: 0 }, STOCK.id);
    assert(cr.ok, `${account} 止盈止损策略创建成功`);
    const s = g.auto.byId.get(cr.id);
    g.auto.step(T);
    return { acc: a, s };
  };

  // 滑泰：锁仓砍半 5 秒 → 6 秒后策略就能卖
  const ht = sellAt6s('autohuatai', 'huatai');
  assert(ht.s.done, '滑泰：6 秒后自动策略即卖出（锁仓 5 秒生效）');
  assert(ht.acc.orders.size > 0 || ht.acc.longQty(stock.id) < lot, '滑泰：已发出卖出委托或持仓减少');

  // 对照：钟信（10 秒锁仓）同样 6 秒，策略只能等
  const zx = sellAt6s('autozhongxin', 'zhongxin');
  assert(!zx.s.done, '钟信：6 秒仍锁着，策略未完成');
  assert(zx.s.state.waiting === true, '钟信：策略转入「等待解锁」而不是空转卖出');
  assert(zx.acc.orders.size === 0 && zx.acc.longQty(stock.id) === lot, '钟信：没有发出任何卖单，持仓原样');
  g.auto.remove(ht.acc, ht.s.id);
  g.auto.remove(zx.acc, zx.s.id);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
