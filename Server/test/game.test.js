/**
 * 游戏整体仿真测试：node test/game.test.js
 */
const { Game, ACTIONS } = require('../src/game');
const config = require('../src/config');

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
const stock = g.stock;

// 手动初始化（不启动 setInterval）
g.npc.init(g.startedAt);
g.market.priceHistory.push({ t: g.startedAt, price: g.market.lastPrice });
g.npc.step(g.startedAt);

console.log('\n[1] 仿真 200 tick：市场活跃度');
{
  g.news.nextAt = 0; // 强制尽早出消息
  let newsCount = 0;
  for (let i = 0; i < 200; i++) {
    const before = g.news.tape.length;
    g.tick();
    if (g.news.tape.length > before) newsCount += 1;
    // 模拟时间流逝（让冷却/锁仓逻辑可用）
    // tick 内部使用 Date.now，这里真实执行即可
  }
  const snap = g.market.snapshot();
  console.log(`  (last=${snap.last}, high=${snap.high}, low=${snap.low}, trades=${snap.trades.length}, news=${newsCount})`);
  assert(snap.depth.bids.length > 0, '盘口存在买盘');
  assert(snap.depth.asks.length > 0, '盘口存在卖盘');
  assert(snap.trades.length > 5, `有成交流水 (${snap.trades.length} 笔)`);
  assert(newsCount >= 1, `仿真期间产生随机消息 (${newsCount} 条)`);
  assert(g.market.priceHistory.length >= 200, '分时序列按 tick 记录');
  assert(snap.last > 0 && Number.isFinite(snap.last), '最新价有效');
}

console.log('\n[2] 盘口深度合理（五档不为空、买一<卖一）');
{
  const snap = g.market.snapshot();
  const bid1 = snap.depth.bids[0];
  const ask1 = snap.depth.asks[0];
  assert(bid1 && ask1 && bid1.price < ask1.price, `买一(${bid1 && bid1.price}) < 卖一(${ask1 && ask1.price})`);
  assert(bid1.qty > 0 && ask1.qty > 0, '盘口数量为正');
}

console.log('\n[3] 玩家登录并从盘口买入');
let token = '';
{
  const lr = g.login('测试玩家');
  assert(lr.ok && !!lr.token, '登录成功并签发会话令牌');
  token = lr.token;
  const lr2 = g.login('bad name!!'); // 非法字符
  assert(!lr2.ok, '非法账号被拒');
  const lr3 = g.login('测试玩家'); // 同名再登
  assert(lr3.ok && lr3.name === '测试玩家', '同名再登直接进入');
  assert(g.accountFor(lr3.token) === g.accountFor(token), '同名两次登录指向同一账户');
  assert(g.sessions.size <= 5, `同账户令牌数受上限约束 (${g.sessions.size})`);

  const snap = g.market.snapshot();
  const ask1 = snap.depth.asks[0];
  const now = Date.now();
  const r = g.market.place(g.store.get('测试玩家'), {
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: ask1.price + 0.05, // 确保吃到卖一
    now,
  });
  assert(r.ok, '玩家买入下单成功');
  const acc = g.store.get('测试玩家');
  assert(acc.longQty('600001') >= 100, `玩家持有多头 ${acc.longQty('600001')} 股`);
  assert(acc.cash < config.account.initialCash, '资金已扣减');

  // 冷却：立刻再下一单应被拒
  const r2 = g.market.place(acc, { action: ACTIONS.BUY_OPEN, qty: 100, price: 1, now: now + 10 });
  assert(!r2.ok && /频繁/.test(r2.error), '冷却限制生效');
}

console.log('\n[4] 玩家挂单进入订单簿并与 NPC 成交');
{
  const acc = g.store.get('测试玩家');
  const snap = g.market.snapshot();
  const bid1 = snap.depth.bids[0];
  // 挂一个高于买一的买单，等 NPC 卖单来吃（或直接与现有卖盘交叉）
  const ask1 = snap.depth.asks[0];
  const now = Date.now() + 5000;
  const r = g.market.place(acc, {
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: ask1.price, // 恰好吃到卖一
    now,
  });
  assert(r.ok, '交叉买单成交或挂单成功');
  // 仿真若干 tick 让 NPC 与玩家订单互动
  for (let i = 0; i < 30; i++) g.tick();
  assert(g.market.snapshot().trades.length > 0, '市场持续有成交');
}

console.log('\n[5] 状态快照结构完整');
{
  const st = g.stateFor(token);
  assert(st.account && st.account.name === '测试玩家', '包含玩家账户');
  assert(st.market.depth && st.market.trades, '包含盘口与逐笔');
  assert(Array.isArray(st.news) && st.news.length >= 1, '包含消息列表');
  assert(st.rules && st.rules.feeRate === 0.0001, '包含规则配置');
  assert(Array.isArray(st.players) && st.players.some((p) => p.name === '测试玩家'), '包含玩家排行');
  assert(typeof st.cooldownLeft === 'number', '包含冷却剩余时间');
  assert(st.account.long, '包含多头持仓结构');
  assert(st.account.short, '包含空头持仓结构');
  const st2 = g.stateFor('bogus-token');
  assert(st2.account === null, '无效令牌返回 account=null');
}

console.log('\n[6] 撤单 API');
{
  const acc = g.store.get('测试玩家');
  const snap = g.market.snapshot();
  const now = Date.now() + 20000;
  const r = g.market.place(acc, {
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: Math.max(0.5, snap.depth.bids.length ? snap.depth.bids[0].price - 1 : snap.last * 0.9),
    now,
  });
  assert(r.ok && r.order.status === 'live', '低挂买单入簿');
  const rc = g.cancelOrder(token, r.order.id);
  assert(rc.ok, '撤单成功');
  const rc2 = g.cancelOrder(token, r.order.id);
  assert(!rc2.ok, '重复撤单被拒');
  const rc3 = g.cancelOrder('bogus-token', r.order.id);
  assert(!rc3.ok, '无效令牌不得撤单');
}

console.log('\n[7] NPC 资金与持仓规模检查');
{
  const sum = g.npc.summary();
  console.log(`  (NPC 持股=${sum.long}, NPC 现金=${sum.cash})`);
  assert(sum.long > stock.floatShares * 0.3, 'NPC 仍持有大量股票（未被抽干）');
  assert(sum.cash > 0, 'NPC 现金为正');
  const totalSlots = g.npc.npcs.length;
  const expectSlots = Object.values(config.npc.types).reduce((s, t) => s + t.count, 0);
  assert(totalSlots === expectSlots, `NPC 数量正确 (${totalSlots} / 期望 ${expectSlots})`);

  // 融券池：NPC 已自动挂借形成基础券源
  const pool = g.market.lendingSnapshot();
  assert(pool.enabled, '融券池已启用');
  assert(pool.total > 0, `NPC 自动出借形成基础券源（${pool.total} 股）`);
  assert(pool.available > 0, `可借券源 > 0（${pool.available}）`);
  assert(config.margin.allowNakedShort === false, 'allowNakedShort 默认关闭（开空走借券）');

  // 清空可借额度，验证无券源时 SELL_OPEN 被拒
  const savedLend = {
    total: g.market.lendTotal,
    borrowed: g.market.lendBorrowed,
    reserved: g.market.lendReserved,
  };
  g.market.lendTotal = 0;
  g.market.lendBorrowed = 0;
  g.market.lendReserved = 0;
  const banLogin = g.login('裸空验收');
  const banAcc = g.store.get(banLogin.name);
  const { ACTIONS: MA } = require('../src/market');
  const ban = g.market.place(banAcc, {
    action: MA.SELL_OPEN,
    qty: 100,
    price: g.market.lastPrice,
    now: Date.now(),
    noCooldown: true,
  });
  assert(!ban.ok && /券源|融券/.test(ban.error), `无券源时开空被拒（${ban.ok ? '意外放行' : ban.error}）`);

  // 恢复池子后可借券源开空（保证金预检可能另拒，但不能是券源不足）
  g.market.lendTotal = savedLend.total;
  g.market.lendBorrowed = savedLend.borrowed;
  g.market.lendReserved = savedLend.reserved;
  const open = g.market.place(banAcc, {
    action: MA.SELL_OPEN,
    qty: 100,
    price: g.market.lastPrice,
    now: Date.now(),
    noCooldown: true,
  });
  assert(
    open.ok || !/券源/.test(open.error),
    `有券源时开空不被券源拦（${open.ok ? '已下单' : open.error}）`
  );
}

console.log('\n[8] 强平兜底扫描不抛异常');
{
  for (let i = 0; i < 50; i++) g.tick();
  assert(true, '50 tick 风控扫描正常运行');
}

console.log('\n[9] 前十大股东');
{
  const holders = g.topHolders();
  assert(Array.isArray(holders) && holders.length === 10, `返回 10 名股东 (实际 ${holders.length})`);
  assert(holders[0].qty >= holders[9].qty, '按持股数量降序');
  assert(holders.every((h) => h.name && typeof h.qty === 'number' && typeof h.pct === 'number'), '字段完整');
  assert(holders.some((h) => h.role === 'inst'), '包含机构股东');
  const npcRoles = new Set(Object.keys(config.npc.types));
  assert(
    holders.every((h) => npcRoles.has(h.role) || h.role === 'player'),
    '股东类型合法'
  );
  // 机构单户初始持仓最大（0.32/10），交易后仍应有多家机构留在前十
  const instInTop = holders.filter((h) => h.role === 'inst').length;
  assert(instInTop >= 4, `前十大中机构席位 ≥4（实际 ${instInTop}）`);
  // 流通盘守恒（玩家+NPC 空头不持股，总多头 = 流通盘 + 空头浮动量）
  const sum = g.holdersSummary();
  assert(sum.longTotal >= sum.float * 0.3, `持股合计合理 (${sum.longTotal})`);
  const st = g.stateFor(token);
  assert(Array.isArray(st.topHolders) && st.topHolders.length === 10, '状态快照包含前十大股东');
  assert(st.topHolders[0].pct > 0, '占比字段有效');
}

console.log('\n[10] 停牌期间行情与风控冻结');
{
  g.halt(5, '系统维护');
  assert(g.market.isHalted(), '停牌生效');
  assert(g.stateFor(token).halt.halted === true, '状态快照带停牌标记');

  const priceBefore = g.market.lastPrice;
  const volBefore = g.market.volume;
  const ticksBefore = g.tickCount;
  for (let i = 0; i < 30; i++) g.tick();
  assert(g.tickCount === ticksBefore + 30, '主循环仍在推进（只冻结行情）');
  assert(g.market.lastPrice === priceBefore, `停牌期间价格不动 (${priceBefore})`);
  assert(g.market.volume === volBefore, '停牌期间无成交（成交量不变）');

  const acc = g.store.get('测试玩家');
  const r = g.market.place(acc, {
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: priceBefore,
    now: Date.now() + 120000,
  });
  assert(!r.ok && /停牌/.test(r.error), `停牌期间下单被拒 (${r.error})`);

  g.resume();
  assert(!g.market.isHalted(), '手动复牌');
  assert(g.stateFor(token).halt.halted === false, '复牌后快照标记清除');
  for (let i = 0; i < 30; i++) g.tick();
  assert(g.tickCount === ticksBefore + 60, '复牌后主循环正常');
}

console.log('\n[11] 加钱：终身上限可配置');
{
  const dep = config.account.deposit;
  assert(dep.maxLifetime === 100000000, `终身上限默认 1 亿（可配置，当前 ${dep.maxLifetime}）`);

  const acc = g.store.get('测试玩家');
  const cashBefore = acc.cash;
  const d1 = g.deposit(token, 5000);
  assert(d1.ok && d1.added === 5000, '正常加钱成功');
  assert(acc.cash === cashBefore + 5000, '现金即时到账');
  assert(acc.deposited === 5000, '终身累计加钱已记账');
  assert(d1.remaining === dep.maxLifetime - 5000, '返回剩余可加额度');

  assert(!g.deposit(token, 0).ok, '金额 0 被拒');
  assert(!g.deposit(token, -100).ok, '负金额被拒');
  assert(!g.deposit('bogus-token', 1000).ok, '无效令牌被拒');
  // 不限单次额度：一次把剩余额度全加满（只留 1 元零头）
  const oneShot = g.deposit(token, dep.maxLifetime - acc.deposited - dep.minPerTime);
  assert(oneShot.ok && oneShot.remaining === dep.minPerTime, `单次大额可一次加到只剩零头（remaining=${oneShot.remaining}）`);

  // 顶到终身上限：只剩 10 元额度时，多一分都不给
  acc.deposited = dep.maxLifetime - 10;
  const cashAtCap = acc.cash;
  assert(!g.deposit(token, 11).ok, '超出剩余可加额度被拒');
  const d2 = g.deposit(token, 10);
  assert(d2.ok && d2.remaining === 0, '刚好加满终身上限');
  assert(acc.cash === cashAtCap + 10, '最后一次加钱到账');
  const d3 = g.deposit(token, 1);
  assert(!d3.ok && /上限/.test(d3.error), `到顶后再加被拒（${d3.error}）`);
  acc.deposited = 0; // 还原，不影响本局后续断言

  const st = g.stateFor(token);
  assert(st.rules.deposit && st.rules.deposit.maxLifetime === dep.maxLifetime, '规则快照下发终身上限');
  assert(typeof st.account.deposited === 'number', '账户快照包含累计加钱额');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
