/**
 * 游戏整体仿真测试：node test/game.test.js
 */
const { Game, ACTIONS } = require('../src/game');
const config = require('../src/config');
const { NewsSystem, TEMPLATES, STOCK_TEMPLATES, ANNOUNCE_TEMPLATES } = require('../src/news');

// 涨跌停是**日频机制**（区间以昨收为基准，价格一天最多走 ±10%）。本文件验的是撮合 /
// 风控 / 快照 / 消息本身，用例里按盘口 ±0.05 打价是常态，开着涨跌停会把它们拦在门外。
// 涨跌停、集合竞价与日终结算由 test/day.test.js 专门覆盖（那边用真实配置）。
config.priceLimit.enabled = false;

// ---- 多股票测试辅助：测试聚焦「大米集团」(config.stocks[0]) ----
// P(g)/N(g)：取某局里大米集团的市场与做市引擎（多股票后 Game 持的是 Map）
const STOCK = config.stocks[0];
const ALL_IDS = config.stocks.map((s) => s.id);
const P = (g) => g.markets.get(STOCK.id);
const N = (g) => g.npcs.get(STOCK.id);

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

// 交易日时钟：把这一局的时钟锚到「上午连续竞价」段内（一天：竞价 0~30s、上午 30~260s…）。
// 本文件的用例验的是撮合 / 风控 / 快照 / 消息，不需要真等 30 秒集合竞价走完才有成交；
// 集合竞价的集中撮合、日终结算与涨跌停由 test/day.test.js 专门覆盖。
g.day.reanchor(Date.now() - 120000);

// 手动初始化（不启动 setInterval）：与 Game.start 的新局路径一致，**每只股票各建一套 NPC 池**，
// 否则其余 9 只没有账户、股东榜为空，跨股票断言就失去意义
for (const s of config.stocks) {
  g.npcs.get(s.id).init(g.startedAt);
  g.markets.get(s.id).priceHistory.push({ t: g.startedAt, price: g.markets.get(s.id).lastPrice });
}
g.index.update(g.markets, g.startedAt);
for (const s of config.stocks) g.npcs.get(s.id).step(g.startedAt);

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
  const snap = P(g).snapshot();
  console.log(`  (last=${snap.last}, high=${snap.high}, low=${snap.low}, trades=${snap.trades.length}, news=${newsCount})`);
  assert(snap.depth.bids.length > 0, '盘口存在买盘');
  assert(snap.depth.asks.length > 0, '盘口存在卖盘');
  assert(snap.trades.length > 5, `有成交流水 (${snap.trades.length} 笔)`);
  assert(newsCount >= 1, `仿真期间产生随机消息 (${newsCount} 条)`);
  assert(P(g).priceHistory.length >= 200, '分时序列按 tick 记录');
  assert(snap.last > 0 && Number.isFinite(snap.last), '最新价有效');
}

console.log('\n[2] 盘口深度合理（五档不为空、买一<卖一）');
{
  const snap = P(g).snapshot();
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

  const snap = P(g).snapshot();
  const ask1 = snap.depth.asks[0];
  const now = Date.now();
  const r = P(g).place(g.store.get('测试玩家'), {
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
  const r2 = P(g).place(acc, { action: ACTIONS.BUY_OPEN, qty: 100, price: 1, now: now + 10 });
  assert(!r2.ok && /频繁/.test(r2.error), '冷却限制生效');
}

console.log('\n[4] 玩家挂单进入订单簿并与 NPC 成交');
{
  const acc = g.store.get('测试玩家');
  const snap = P(g).snapshot();
  const bid1 = snap.depth.bids[0];
  // 挂一个高于买一的买单，等 NPC 卖单来吃（或直接与现有卖盘交叉）
  const ask1 = snap.depth.asks[0];
  const now = Date.now() + 5000;
  const r = P(g).place(acc, {
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: ask1.price, // 恰好吃到卖一
    now,
  });
  assert(r.ok, '交叉买单成交或挂单成功');
  // 仿真若干 tick 让 NPC 与玩家订单互动
  for (let i = 0; i < 30; i++) g.tick();
  assert(P(g).snapshot().trades.length > 0, '市场持续有成交');
}

console.log('\n[5] 状态快照结构完整');
{
  const st = g.stateFor(token);
  assert(st.account && st.account.name === '测试玩家', '包含玩家账户');
  assert(Array.isArray(st.markets) && st.markets.length === config.stocks.length, `包含全部 ${config.stocks.length} 只股票行情`);
  assert(st.markets.every((m) => m.depth && m.trades && m.name), '每只股票都带盘口与逐笔');
  assert(st.index && st.index.stockId === config.index.code, '包含大盘指数');
  assert(st.index.components.length === config.stocks.length, '指数带全部成分股');
  assert(
    Math.abs(st.index.components.reduce((a, c) => a + c.weight, 0) - 100) < 0.05,
    '成分权重合计 100%'
  );
  assert(st.market.depth && st.market.trades, '包含盘口与逐笔（兼容字段 market）');
  assert(Array.isArray(st.news) && st.news.length >= 1, '包含消息列表');
  assert(st.rules && st.rules.feeRate === 0.0001, '包含规则配置');
  assert(Array.isArray(st.rules.stocks) && st.rules.stocks.length === config.stocks.length, '规则里带股票清单');
  assert(Array.isArray(st.players) && st.players.some((p) => p.name === '测试玩家'), '包含玩家排行');
  assert(typeof st.cooldownLeft === 'number', '包含冷却剩余时间');
  assert(Array.isArray(st.account.positions), '持仓按股票切片下发');
  assert(
    st.account.positions.every((p) => p.stockId && p.long && p.short && p.lending),
    '每个持仓切片带 stockId/多空/融券视角'
  );
  assert(st.account.longValue >= 0 && typeof st.account.shortValue === 'number', '账户级持仓市值汇总下发');
  const st2 = g.stateFor('bogus-token');
  assert(st2.account === null, '无效令牌返回 account=null');
}

console.log('\n[6] 撤单 API');
{
  const acc = g.store.get('测试玩家');
  const snap = P(g).snapshot();
  const now = Date.now() + 20000;
  const r = P(g).place(acc, {
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
  const sum = N(g).summary();
  console.log(`  (NPC 持股=${sum.long}, NPC 现金=${sum.cash})`);
  assert(sum.long > stock.floatShares * 0.3, 'NPC 仍持有大量股票（未被抽干）');
  assert(sum.cash > 0, 'NPC 现金为正');
  const totalSlots = N(g).npcs.length;
  const expectSlots = Object.values(config.npc.types).reduce((s, t) => s + t.count, 0);
  assert(totalSlots === expectSlots, `NPC 数量正确 (${totalSlots} / 期望 ${expectSlots})`);

  // 融券池：NPC 已自动挂借形成基础券源
  const pool = P(g).lendingSnapshot();
  assert(pool.enabled, '融券池已启用');
  assert(pool.total > 0, `NPC 自动出借形成基础券源（${pool.total} 股）`);
  assert(pool.available > 0, `可借券源 > 0（${pool.available}）`);
  assert(config.margin.allowNakedShort === false, 'allowNakedShort 默认关闭（开空走借券）');

  // 清空可借额度，验证无券源时 SELL_OPEN 被拒
  const savedLend = {
    total: P(g).lendTotal,
    borrowed: P(g).lendBorrowed,
    reserved: P(g).lendReserved,
  };
  P(g).lendTotal = 0;
  P(g).lendBorrowed = 0;
  P(g).lendReserved = 0;
  const banLogin = g.login('裸空验收');
  const banAcc = g.store.get(banLogin.name);
  const { ACTIONS: MA } = require('../src/market');
  const ban = P(g).place(banAcc, {
    action: MA.SELL_OPEN,
    qty: 100,
    price: P(g).lastPrice,
    now: Date.now(),
    noCooldown: true,
  });
  assert(!ban.ok && /券源|融券/.test(ban.error), `无券源时开空被拒（${ban.ok ? '意外放行' : ban.error}）`);

  // 恢复池子后可借券源开空（保证金预检可能另拒，但不能是券源不足）
  P(g).lendTotal = savedLend.total;
  P(g).lendBorrowed = savedLend.borrowed;
  P(g).lendReserved = savedLend.reserved;
  const open = P(g).place(banAcc, {
    action: MA.SELL_OPEN,
    qty: 100,
    price: P(g).lastPrice,
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
  const holders = g.topHolders(STOCK.id);
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
  const sum = g.holdersSummary(STOCK.id);
  assert(sum.longTotal >= sum.float * 0.3, `持股合计合理 (${sum.longTotal})`);
  // 每只股票各有自己的股东榜（账户名前缀区分，互不混入）
  const holders2 = g.topHolders(config.stocks[1].id);
  assert(holders2.length === 10, '第二只股票也有独立的前十大');
  const names1 = new Set(holders.map((h) => h.name));
  assert(
    holders2.every((h) => !names1.has(h.name) || h.role === 'player'),
    '不同股票的 NPC 股东不重叠'
  );
  // 股东榜改为按需拉取：/api/holders 对应的 holdersFor 带两层变动
  const st = g.holdersFor(token, STOCK.id);
  assert(st.ok && st.rows.length === 10, 'holdersFor 返回前十大');
  assert(st.rows[0].pct > 0, '占比字段有效');
  assert(st.holderSnapshot === null || typeof st.holderSnapshot.t === 'number', '带基线时刻');
}

console.log('\n[10] 停牌期间行情与风控冻结');
{
  g.halt(5, '系统维护');
  assert(P(g).isHalted(), '停牌生效');
  assert(g.stateFor(token).halt.halted === true, '状态快照带停牌标记');

  const priceBefore = P(g).lastPrice;
  const volBefore = P(g).volume;
  const ticksBefore = g.tickCount;
  for (let i = 0; i < 30; i++) g.tick();
  assert(g.tickCount === ticksBefore + 30, '主循环仍在推进（只冻结行情）');
  assert(P(g).lastPrice === priceBefore, `停牌期间价格不动 (${priceBefore})`);
  assert(P(g).volume === volBefore, '停牌期间无成交（成交量不变）');

  const acc = g.store.get('测试玩家');
  const r = P(g).place(acc, {
    action: ACTIONS.BUY_OPEN,
    qty: 100,
    price: priceBefore,
    now: Date.now() + 120000,
  });
  assert(!r.ok && /停牌/.test(r.error), `停牌期间下单被拒 (${r.error})`);

  g.resume();
  assert(!P(g).isHalted(), '手动复牌');
  assert(g.stateFor(token).halt.halted === false, '复牌后快照标记清除');
  for (let i = 0; i < 30; i++) g.tick();
  assert(g.tickCount === ticksBefore + 60, '复牌后主循环正常');
}

console.log('\n[11] 加钱：终身上限可配置');
{
  const dep = config.account.deposit;
  assert(dep.maxLifetime === 100000000, `终身上限默认 1 亿（可配置，当前 ${dep.maxLifetime}）`);

  // 线上开关当前是关的（暂时屏蔽加钱按钮），本节验证加钱逻辑本身，测完还原
  const enabledBefore = dep.enabled;
  assert(!enabledBefore, '加钱开关默认关闭（当前临时屏蔽）');
  assert(!g.deposit(token, 5000).ok, '开关关闭时加钱被拒');
  assert(g.stateFor(token).rules.deposit.enabled === false, '快照下发开关关闭，前端据此隐藏按钮');
  dep.enabled = true;

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
  assert(st.rules.deposit.enabled === true, '开关打开时快照同步下发');
  dep.enabled = enabledBefore;
}

console.log('\n[12] 机构聪明钱：公开消息对倒（利好出货 / 利空吸筹）');
{
  const now = Date.now();
  const inst = N(g).npcs.find((x) => x.type === 'inst');
  assert(!!inst, '找到机构 NPC');
  const p = N(g).profileOf(inst);
  assert(p.publicNewsFade != null, '机构启用公开消息对倒');
  assert(p.fundWeight != null, '机构定价锚以基本面为主');
  assert(p.inventorySkew != null && p.heatFade != null, '机构带库存/过热回归');

  // 消息系统能按 scope 分解，机构才看得见散户盘
  g.news.active = [
    { id: 'TX1', dir: 1, scope: '散户', power: 0.8, until: now + 60000 },
    { id: 'TX2', dir: 1, scope: '全体', power: 0.5, until: now + 60000 },
    { id: 'TX3', dir: -1, scope: '机构', power: 0.4, until: now + 60000 },
  ];
  const sb = g.news.sentimentByScope(now);
  assert(sb.retail > 0 && sb.all > 0, `散户盘/全体情绪为正 (retail=${sb.retail.toFixed(2)}, all=${sb.all.toFixed(2)})`);
  assert(sb.inst < 0, `机构专属情绪为负 (inst=${sb.inst.toFixed(2)})`);

  // 屏蔽阵营/库存/过热/力量天平/战术意图/浮盈亏噪声，单独看消息对倒方向
  const savedMood = N(g).instMood;
  const savedPolar = N(g).polar;
  const savedHeat = p.heatFade;
  const savedInv = p.inventorySkew;
  const savedForce = N(g).force;
  const savedIntent = N(g).intent.mode;
  const savedPnlFeel = config.npc.pnlFeel.enabled;
  N(g).instMood = 0;
  N(g).polar = 0;
  N(g).force = 0;
  N(g).intent.mode = 'none';
  config.npc.pnlFeel.enabled = false;
  p.heatFade = 0;
  p.inventorySkew = 0;

  inst.ownBias = 0;
  N(g).updateBias(inst, now);
  assert(inst.sentiment < 0, `公开利好 → 机构情绪偏空/出货 (${inst.sentiment.toFixed(3)})`);

  g.news.active = [
    { id: 'TX4', dir: -1, scope: '散户', power: 0.8, until: now + 60000 },
    { id: 'TX5', dir: -1, scope: '全体', power: 0.5, until: now + 60000 },
  ];
  inst.ownBias = 0;
  N(g).updateBias(inst, now);
  assert(inst.sentiment > 0, `公开利空 → 机构情绪偏多/吸筹 (${inst.sentiment.toFixed(3)})`);

  // 散户仍跟消息同向（追涨杀跌）
  const small = N(g).npcs.find((x) => x.type === 'small');
  const ps = N(g).profileOf(small);
  assert(ps.publicNewsFade == null, '散户不走对倒路径');
  const savedMom = ps.momentum;
  ps.momentum = false;
  g.news.active = [{ id: 'TX6', dir: 1, scope: '散户', power: 0.8, until: now + 60000 }];
  small.ownBias = 0;
  N(g).updateBias(small, now);
  assert(small.sentiment > 0, `公开利好 → 散户情绪偏多/追涨 (${small.sentiment.toFixed(3)})`);
  ps.momentum = savedMom;

  // 机构定价锚：不跟消息推高的公允，贴基本面重心
  const savedFv = N(g).fairValue;
  const savedFund = N(g).fund;
  N(g).fairValue = P(g).lastPrice * 1.5;
  N(g).fund = P(g).lastPrice;
  const anchor = N(g).valueOf(p);
  assert(anchor < N(g).fairValue, `机构锚 < 消息推高的公允 (${anchor.toFixed(2)} < ${N(g).fairValue.toFixed(2)})`);
  assert(Math.abs(anchor - N(g).fund) < Math.abs(anchor - N(g).fairValue), '机构锚更接近基本面重心');
  const retailV = N(g).valueOf(ps);
  assert(retailV === N(g).fairValue, '散户定价仍直接用短端公允');
  N(g).fairValue = savedFv;
  N(g).fund = savedFund;

  g.news.active = [];
  N(g).instMood = savedMood;
  N(g).polar = savedPolar;
  N(g).force = savedForce;
  N(g).intent.mode = savedIntent;
  config.npc.pnlFeel.enabled = savedPnlFeel;
  p.heatFade = savedHeat;
  p.inventorySkew = savedInv;
}

console.log('\n[13] 前十大股东：操作快照与「较上次操作」变动');
{
  const lr = g.login('股东测试');
  assert(lr.ok, '登录成功');
  const tk = lr.token;

  const base = g.lastHolderSnapshot('股东测试', STOCK.id);
  assert(!!base && base.action === 'login', '登录即留一份基线快照');
  assert(base.rows.length === 30, `单份快照保留 30 名股东 (实际 ${base.rows.length})`);
  assert(JSON.stringify(base).indexOf('byName') === -1, '内部索引不进序列化结果');
  // 登录时给每只股票各记一份基线，切到任意股票都有可比对的基线
  assert(
    config.stocks.every((s) => !!g.lastHolderSnapshot('股东测试', s.id)),
    '每只股票都有独立基线快照'
  );

  const st0 = g.holdersFor(tk, STOCK.id);
  assert(!!st0.holderSnapshot && st0.holderSnapshot.count === 1, '股东接口带基线时刻与快照数');
  assert(st0.holderSnapshot.limit === 30, '快照上限随下发（客户端显示用）');
  assert(st0.rows.every((h) => h.prevPct != null && h.prevQty != null), '基线内的前十名都能对上前值');
  assert(st0.rows.every((h) => h.dQty === 0 && h.dPct === 0), '刚登录时与基线零变动');
  assert(g.holdersFor('bogus-token', STOCK.id).holderSnapshot === null, '未登录时不下发快照基线');

  // 开服变动要给出占比口径，不能只有股数
  const float = STOCK.floatShares;
  assert(
    st0.rows.every((h) => Math.abs(h.changePct - (h.change / float) * 100) < 0.02),
    'changePct 与 change 自洽（百分点）'
  );

  // 下单会记一份新快照；此后 NPC 继续交易，变动就体现在「较上次操作」上
  const beforeCount = g.holderHistoryFor(tk, STOCK.id).snapshots.length;
  const or = g.placeOrder(tk, { action: ACTIONS.BUY_OPEN, qty: 100, price: P(g).lastPrice, stockId: STOCK.id });
  assert(or.ok, `下单成功 (${or.error || 'ok'})`);
  const hist = g.holderHistoryFor(tk, STOCK.id);
  assert(hist.ok && hist.snapshots.length === beforeCount + 1, `下单追加一次快照 (${hist.snapshots.length})`);
  assert(hist.snapshots[hist.snapshots.length - 1].action === 'order', '新快照标记为下单');
  // 快照按股票分账：下的是大米集团的单，不该动到别只股票的基线
  assert(
    g.holderHistoryFor(tk, config.stocks[1].id).snapshots.length === 1,
    '其它股票的基线未被这次下单污染'
  );

  for (let i = 0; i < 60; i++) g.tick();
  const st1 = g.holdersFor(tk, STOCK.id);
  // 「较上次操作」要能反映基线之后的变化。用「随机 NPC 成交有没有让前十大变动」来断言会**偶发假红**
  // （这 60 tick 里前十大正好净变动为 0 就会命中，实测约 1/10），所以直接给榜首补一笔批次
  // 模拟他继续交易，再把两次快照对着比——变动的来源与机制无关，只关心基线有没有跟着动
  const topRow = st1.rows[0];
  const topAcc = g.store.get(topRow.name);
  topAcc.longPos(STOCK.id).lots.push({ qty: 100, price: STOCK.initPrice, ts: 0, reserved: 0, debt: 0, principal: 0 });
  g.refreshStats();
  const st2 = g.holdersFor(tk, STOCK.id);
  const moved = st2.rows.find((h) => h.name === topRow.name);
  assert(moved && moved.qty === topRow.qty + 100, `榜首持股随成交变化（${topRow.qty} → ${moved && moved.qty}）`);
  assert(moved && moved.prevQty === topRow.prevQty, '基线取的是上次操作时的快照，不随行情重算');
  assert(moved && moved.dQty === topRow.dQty + 100, `「较上次操作」体现出这笔变动（${moved && moved.dQty} 股）`);
  assert(
    st1.rows.every((h) => h.dQty === null || h.qty - h.prevQty === h.dQty),
    'dQty 与 qty−prevQty 自洽'
  );
  assert(
    st1.rows.every(
      (h) => h.dQty === null || Math.abs(h.dPct - (h.pct - h.prevPct)) < 0.02
    ),
    'dPct 与 pct−prevPct 自洽'
  );

  // 环形缓冲：超出上限只留最近 N 次
  const acc = g.store.get('股东测试');
  for (let i = 0; i < 40; i++) g.snapshotHolders(acc, 'order', STOCK.id);
  assert(g.holderHistoryFor(tk, STOCK.id).snapshots.length === 30, '快照环形缓冲封顶 30');
  assert(!g.holderHistoryFor('bogus-token', STOCK.id).ok, '无有效令牌不返回股东历史');
}

console.log('\n[15] 个股消息文案：每只股票走自己的专属池');
{
  // 十只股票各按「原型公司」（大米集团←小米、腾迅←腾讯、阿狸←阿里…）的真实业务写了专属文案池。
  // 这里守住两件事：池子齐全、个股消息真的落到该股自己的池子里——股票改名忘了同步
  // STOCK_TEMPLATES 时会静默回退通用池，playtest 很难发现，所以在这条测试里红掉。
  const scopes = ['机构', '散户'];
  assert(
    config.stocks.every((s) => STOCK_TEMPLATES[s.name]),
    `十只股票都有专属文案池 (${config.stocks.filter((s) => STOCK_TEMPLATES[s.name]).length}/${config.stocks.length})`
  );

  const thin = [];
  const dup = [];
  for (const s of config.stocks) {
    for (const scope of scopes) {
      for (const key of ['positive', 'negative']) {
        const pool = (STOCK_TEMPLATES[s.name] || {})[scope] ? STOCK_TEMPLATES[s.name][scope][key] : null;
        const tag = `${s.alias}·${scope}·${key === 'positive' ? '利好' : '利空'}`;
        if (!pool || pool.length < 8) thin.push(tag);
        else if (pool.length !== new Set(pool).size) dup.push(tag);
      }
    }
  }
  assert(thin.length === 0, `每只股票四个池各 ≥8 条（不足：${thin.join('、') || '无'}）`);
  assert(dup.length === 0, `池内无重复文案（重复：${dup.join('、') || '无'}）`);

  // 抽取结果必须落在该股池内（不是通用池），且 320 条文案全局唯一
  const sys = new NewsSystem(config.stocks);
  const allTexts = [];
  let leaked = 0;
  let shortPools = 0;
  for (const s of config.stocks) {
    for (const scope of scopes) {
      for (const key of ['positive', 'negative']) {
        const pool = STOCK_TEMPLATES[s.name][scope][key];
        const got = new Set();
        for (let i = 0; i < 300; i++) got.add(sys.pickText(scope, key === 'positive' ? 1 : -1, s));
        if (got.size !== pool.length) shortPools += 1;
        for (const t of got) if (!pool.includes(t)) leaked += 1;
        allTexts.push(...pool);
      }
    }
  }
  assert(leaked === 0, `抽样文案全部出自本股专属池（越池 ${leaked} 条）`);
  assert(shortPools === 0, `每池 300 次抽样能抽全（抽不满的池：${shortPools} 个）`);
  assert(allTexts.length === 320, `个股文案共 ${allTexts.length} 条`);
  assert(
    new Set(allTexts).size === allTexts.length,
    `320 条个股文案全局唯一（重复 ${allTexts.length - new Set(allTexts).size} 条）`
  );

  // 端到端：强制产出消息，检查【简称】前缀与文案归属
  const sys2 = new NewsSystem(config.stocks);
  const stockNews = [];
  const macroNews = [];
  for (let i = 0; i < 400; i++) {
    sys2.nextAt = 0;
    const n = sys2.maybeEmit(1000000 + i * 1000, 0);
    if (!n) continue;
    if (n.stockId) stockNews.push(n);
    else macroNews.push(n);
  }
  const byId = new Map(config.stocks.map((s) => [s.id, s]));
  assert(stockNews.length > 100, `强制产出个股消息 (${stockNews.length} 条)`);
  assert(macroNews.length > 50, `强制产出大盘消息 (${macroNews.length} 条)`);
  assert(
    stockNews.every((n) => n.text.startsWith(`【${byId.get(n.stockId).alias}】`)),
    '个股消息带【简称】前缀'
  );
  assert(
    stockNews.every((n) => {
      const s = byId.get(n.stockId);
      const key = n.dir > 0 ? 'positive' : 'negative';
      return STOCK_TEMPLATES[s.name][n.scope][key].includes(n.text.replace(`【${s.alias}】`, ''));
    }),
    '个股消息正文出自所属股票的专属池'
  );
  assert(
    new Set(stockNews.map((n) => n.stockId)).size === config.stocks.length,
    `十只股票都被分配到过个股消息（${new Set(stockNews.map((n) => n.stockId)).size}/${config.stocks.length}）`
  );

  // 大盘消息（scope=全体，恒生科技指数口径）不带股票，作用于全部十只
  assert(macroNews.every((n) => !n.text.includes('【')), '大盘消息不带【简称】前缀');
  assert(
    macroNews.every((n) => config.stocks.every((s) => NewsSystem.applies(n, s.id))),
    '大盘消息作用于全部十只股票'
  );
  assert(
    macroNews.every((n) => TEMPLATES['全体'][n.dir > 0 ? 'positive' : 'negative'].includes(n.text)),
    '大盘消息正文出自「全体」池'
  );
  assert(
    TEMPLATES['全体'].positive.length >= 20 && TEMPLATES['全体'].negative.length >= 20,
    `大盘池已按恒生科技指数口径扩充 (利好 ${TEMPLATES['全体'].positive.length} / 利空 ${TEMPLATES['全体'].negative.length})`
  );
  assert(
    new Set(TEMPLATES['全体'].positive).size === TEMPLATES['全体'].positive.length &&
      new Set(TEMPLATES['全体'].negative).size === TEMPLATES['全体'].negative.length,
    '大盘池内无重复文案'
  );
}

console.log('\n[16] 消息按「天」分段：节奏 / scope 权重 / 盘后公告池 / 作用期下限');
{
  const phaseLen = Object.fromEntries(config.day.phases.map((p) => [p.key, p.ms]));
  const rules = config.news.phaseRules;
  const NOW = 10000000;

  // ① 阶段规则与阶段长度自洽：段内保底有消息、收盘竞价刻意不发
  assert(!!(rules && rules.auction && rules.lunch && rules.night), '盘前/午休/盘后各有阶段规则');
  assert(rules.auction.maxIntervalMs < phaseLen.auction, '盘前节奏上限 < 竞价段长（30s 内必出，隔夜重磅落地）');
  assert(rules.night.maxIntervalMs < phaseLen.night, '盘后节奏上限 < 夜间段长（40s 内必出，盘后公告保底）');
  assert(rules.lunch.minIntervalMs < phaseLen.lunch, '午休节奏下限 < 午休段长（40s 内保底一条午间公告）');
  assert(!rules.closeAuction, '收盘竞价不配规则（尾盘不发消息，张力交给竞价机制）');
  assert(config.news.minIntervalMs >= phaseLen.closeAuction, `全局节奏下限(${config.news.minIntervalMs}ms) ≥ 收盘竞价段长(${phaseLen.closeAuction}ms)（重排队后段内恒无新消息）`);

  // ② 换阶段重新排队：上一段排出的远期倒计时不能整段吞掉新阶段
  const sys = new NewsSystem(config.stocks);
  sys.nextAtPhase = 'afternoon';
  sys.nextAt = NOW + 500000; // 假设下午末尾排出了一条 500s 后的倒计时
  const r = sys.maybeEmit(NOW, 0, { phaseKey: 'night' });
  assert(r === null, '换阶段当帧不产出（按盘后节奏重排队）');
  const gap = sys.nextAt - NOW;
  assert(gap >= rules.night.minIntervalMs && gap <= rules.night.maxIntervalMs, `重排后的间隔落在盘后窗口（${gap}ms ∈ [${rules.night.minIntervalMs}, ${rules.night.maxIntervalMs}]）`);
  assert(gap < phaseLen.night, `重排后首个候选落在夜间段内（${gap}ms < ${phaseLen.night}ms）`);

  // ③ 首次调用只登记阶段、不重排（构造时已排过队）；不传阶段则与旧版完全一致
  const sys2 = new NewsSystem(config.stocks);
  sys2.nextAt = 0;
  const r2 = sys2.maybeEmit(NOW, 0, { phaseKey: 'morning' });
  assert(!!r2 && r2.session === '盘中', '首次调用不重排、立即产出（session=盘中）');
  const sys3 = new NewsSystem(config.stocks);
  sys3.nextAt = 0;
  const r3 = sys3.maybeEmit(NOW, 0);
  assert(!!r3 && r3.session === null, '不传阶段（时钟关闭）session 为空，行为与旧版一致');
  const sys3b = new NewsSystem(config.stocks);
  sys3b.nextAt = 0;
  assert(sys3b.maybeEmit(NOW, 0, { phaseKey: 'auction' }).session === '盘前', '开盘竞价 → session=盘前');

  // ④ scope 权重：盘前偏全体（隔夜宏观）、盘后偏机构（公告）、盘中均匀
  const sampleScopes = (phaseKey, n) => {
    const s = new NewsSystem(config.stocks);
    const cnt = { 机构: 0, 散户: 0, 全体: 0 };
    for (let i = 0; i < n; i++) {
      s.nextAt = 0;
      const m = s.maybeEmit(NOW + i, 0, { phaseKey });
      if (m) cnt[m.scope] += 1;
    }
    return cnt;
  };
  const share = (c, k) => (c['机构'] + c['散户'] + c['全体'] ? c[k] / (c['机构'] + c['散户'] + c['全体']) : 0);
  const nPre = sampleScopes('auction', 600);
  assert(share(nPre, '全体') > 0.5 && share(nPre, '全体') < 0.7, `盘前「全体」占比 ${share(nPre, '全体').toFixed(2)} ∈ (0.5, 0.7)（隔夜宏观为主）`);
  const nPost = sampleScopes('night', 600);
  assert(share(nPost, '机构') > 0.4 && share(nPost, '机构') < 0.6, `盘后「机构」占比 ${share(nPost, '机构').toFixed(2)} ∈ (0.4, 0.6)（公告偏机构）`);
  const nMid = sampleScopes(null, 900);
  assert(
    ['机构', '散户', '全体'].every((k) => share(nMid, k) > 0.26 && share(nMid, k) < 0.41),
    `盘中/无时钟均匀抽（机构 ${share(nMid, '机构').toFixed(2)} / 散户 ${share(nMid, '散户').toFixed(2)} / 全体 ${share(nMid, '全体').toFixed(2)}）`
  );

  // ⑤ 盘后个股消息走「盘后公告」池（带【简称】前缀），大盘消息仍走「全体」池
  const sys4 = new NewsSystem(config.stocks);
  const bad = [];
  const byId = new Map(config.stocks.map((s) => [s.id, s]));
  let stockN = 0;
  let macroN = 0;
  for (let i = 0; i < 400; i++) {
    sys4.nextAt = 0;
    const m = sys4.maybeEmit(NOW + i * 1000, 0, { phaseKey: 'night' });
    if (!m) continue;
    if (m.session !== '盘后') bad.push(`session=${m.session}`);
    if (m.stockId) {
      stockN += 1;
      const s = byId.get(m.stockId);
      const key = m.dir > 0 ? 'positive' : 'negative';
      if (!m.text.startsWith(`【${s.alias}】`)) bad.push(`缺前缀: ${m.text}`);
      if (!ANNOUNCE_TEMPLATES[key].includes(m.text.replace(`【${s.alias}】`, ''))) bad.push(`不在公告池: ${m.text}`);
    } else {
      macroN += 1;
      if (!TEMPLATES['全体'][m.dir > 0 ? 'positive' : 'negative'].includes(m.text)) bad.push(`盘后大盘消息不在全体池: ${m.text}`);
      if (m.text.includes('【')) bad.push(`大盘消息带了前缀: ${m.text}`);
    }
  }
  assert(bad.length === 0, `盘后消息文案归属正确（违规 ${bad.length} 条${bad.length ? '：' + bad.slice(0, 3).join('；') : ''}）`);
  assert(stockN > 100 && macroN > 50, `盘后个股/大盘消息都有产出（个股 ${stockN} / 大盘 ${macroN}）`);

  // ⑥ 公告池质量：12+12、池内无重复、与既有全部文案池零重叠
  const ann = [...ANNOUNCE_TEMPLATES.positive, ...ANNOUNCE_TEMPLATES.negative];
  assert(ANNOUNCE_TEMPLATES.positive.length === 12 && ANNOUNCE_TEMPLATES.negative.length === 12, `公告池 12+12（实际 ${ANNOUNCE_TEMPLATES.positive.length}+${ANNOUNCE_TEMPLATES.negative.length}）`);
  assert(new Set(ann).size === ann.length, '公告池内无重复');
  const others = [];
  for (const scope of ['全体', '机构', '散户']) {
    others.push(...TEMPLATES[scope].positive, ...TEMPLATES[scope].negative);
  }
  for (const s of config.stocks) {
    for (const scope of ['机构', '散户']) {
      others.push(...STOCK_TEMPLATES[s.name][scope].positive, ...STOCK_TEMPLATES[s.name][scope].negative);
    }
  }
  const othersSet = new Set(others);
  const leaked = ann.filter((t) => othersSet.has(t));
  assert(leaked.length === 0, `公告池与既有文案池零重叠（${others.length} 条既有文案，越池 ${leaked.length} 条${leaked.length ? '：' + leaked.slice(0, 3).join('；') : ''}）`);

  // ⑦ untilFloor：盘后消息作用期抬到次日开盘竞价结束，其余照旧 60s
  const sys5 = new NewsSystem(config.stocks);
  const floor = NOW + 68000;
  sys5.nextAt = 0;
  assert(sys5.maybeEmit(NOW, 0, { phaseKey: 'night', untilFloor: floor }).until === floor, 'untilFloor 生效：作用期被抬到竞价结束');
  sys5.nextAt = 0;
  assert(sys5.maybeEmit(NOW, 0, { phaseKey: 'night', untilFloor: NOW + 1000 }).until === NOW + config.news.durationMs, 'untilFloor 早于自然过期时按 60s 走');
  const sys6 = new NewsSystem(config.stocks); // 换阶段会重排 nextAt（覆盖 nextAt=0），所以另起一个实例
  sys6.nextAt = 0;
  assert(sys6.maybeEmit(NOW, 0, { phaseKey: 'auction' }).until === NOW + config.news.durationMs, '盘前不传 floor 时作用期仍是 60s');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
