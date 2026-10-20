/**
 * 分时图弹幕测试：node test/danmaku.test.js
 *
 * 覆盖两类东西：
 * ① 单元（stub game）—— 文案池、组合、频率漏斗、playerB 的三个触发点、玩家发言校验；
 * ② 集成（真 Game）—— `Market.execute → onPlayerAction → step → stateFor.danmaku`
 *    整条链路真的通，且下发的 item 键集合严格等于白名单（红线①「不剧透」）。
 */
const config = require('../src/config');
const { DanmakuSystem } = require('../src/danmaku');
const textLib = require('../src/danmaku-text');
const { Game, ACTIONS } = require('../src/game');

config.npc.llm.enabled = false;
config.danmaku.enabled = true;
// 交易日时钟会让「收盘后 / 夜间」的做市引擎不报价（测试跑在什么时刻都不该影响结果），
// 集成用例需要连续竞价，所以整套关掉——弹幕逻辑本身与阶段无关
config.day.enabled = false;
config.danmaku.snapshotMs = 60000; // 测试里放宽下发窗口，避免跨毫秒抖动
const STOCK = config.stocks[0];

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
function section(t) {
  console.log('\n' + t);
}

// ---------------- stub 环境 ----------------
const S1 = { id: 'S1', floatShares: 1e9, initPrice: 10 };
const mkMarket = { lastPrice: 10 };
// NpcManager.npcs 的元素是 { acc, type, ... }（不是 acc 本身），stub 必须同构，
// 否则 _scanPnl 取 n.acc 会拿到 undefined，_speak 静默返回 null
const mgr = { npcs: [], pnlOf: (x) => (x && x.acc && x.acc._pnl != null ? x.acc._pnl : null) };
const stubGame = {
  stocks: [S1],
  stocksById: new Map([[S1.id, S1]]),
  markets: new Map([[S1.id, mkMarket]]),
  npcs: new Map([[S1.id, mgr]]),
};

function mkAcc(name, role, isNPC) {
  return { name, role, nick: name, isNPC: isNPC !== false, _pnl: 0 };
}

/** 每个 playerB 用例用独立实例，互相不污染冷却与配额 */
function freshDm(opts = {}) {
  // playerB 要「场里有人」才说得出来：`_pickSpeaker` 现在会跳过还在单账户冷却里的人，
  // 池子空了就宁可不说（真实环境每只票有 316 个投资者，不会空）
  mgr.npcs = ['hot', 'big', 'mid', 'small', 'inst'].map((t) => ({ acc: mkAcc('stub-' + t, t, true), type: t }));
  const dm = new DanmakuSystem(stubGame);
  dm.cfg.speakChance = 0; // 关掉情绪闲聊，断言里只留玩家反应
  if (opts.floatMvPct != null) dm.cfg.playerB.floatMvPct = opts.floatMvPct;
  return dm;
}

const FLOAT_MV = S1.floatShares * mkMarket.lastPrice; // 1e10
const BIG = FLOAT_MV * config.danmaku.playerB.floatMvPct; // 500 万

// ---------------- ① 文案池 ----------------

section('[1] 文案池完整性');
{
  const types = ['small', 'mid', 'big', 'hot', 'inst'];
  let ok = true;
  for (const t of types) {
    for (const s of ['deepLoss', 'win', 'liquidation', 'idle']) {
      const pool = textLib.POOLS[t] && textLib.POOLS[t][s];
      if (!pool || pool.length < 8) {
        ok = false;
        console.log(`    缺池：${t}.${s}`);
      }
    }
  }
  assert(ok, '5 类投资者 × 4 情境各有 ≥ 8 条主句');
  assert(textLib.POOLS.mm && textLib.POOLS.mm.idle.length >= 8, '自营只有 idle 池（不评论方向）');
  const pb = textLib.POOLS.playerB;
  assert(
    pb && pb.bigBuy.length >= 8 && pb.cutLoss.length >= 8 && pb.liquidation.length >= 8,
    'playerB 三个情境各有 ≥ 8 条'
  );
  // 不点名是协议级约束，文案里也不许出现变量名之外的占位
  const flat = JSON.stringify(textLib.POOLS);
  assert(!/\{nick\}|\{name\}|\{account\}/.test(flat), '文案里没有任何昵称类变量槽');
  assert(!/傻逼|妈的|操你/.test(flat), '文案池零脏字（阴阳怪气代替脏话）');
}

section('[2] 长度与变量槽');
{
  const maxLen = config.danmaku.player.maxLen;
  let longest = 0;
  let over = null;
  for (const [t, scenes] of Object.entries(textLib.POOLS)) {
    for (const [s, pool] of Object.entries(scenes)) {
      for (const line of pool) {
        const body = line.replace(/\{pct\}/g, '99');
        if ([...body].length > longest) longest = [...body].length;
        if ([...body].length > maxLen && !over) over = `${t}.${s}: ${body}`;
      }
    }
  }
  assert(!over, `每条主句（含变量填满）≤ ${maxLen} 字，最长 ${longest} 字`);
  const got = textLib.pickText('small', 'deepLoss', { pct: 23 });
  assert(got && !got.includes('{'), '正常填值后不残留占位符');
  // 变量缺失时必须换一条，绝不能把 {pct} 发到屏幕上
  let bad = 0;
  for (let i = 0; i < 60; i += 1) {
    const s = textLib.pickText('small', 'deepLoss', null);
    if (s && s.includes('{')) bad += 1;
  }
  assert(bad === 0, '变量缺失时不会下发未替换的占位符');
}

section('[3] 组合式文案的多样性');
{
  const seen = new Set();
  for (let i = 0; i < 600; i += 1) {
    const s = textLib.pickText('small', 'deepLoss', { pct: 10 + (i % 20) });
    if (s) seen.add(s);
  }
  assert(seen.size >= 40, `600 次采样得到 ${seen.size} 种表面变体（≥ 40）`);
  // 机构不加语气前缀：「唉，这个位置不接。」不是机构说话的样子
  let prefixInInst = 0;
  for (let i = 0; i < 200; i += 1) {
    const s = textLib.pickText('inst', 'idle', null);
    if (s && /^(唉|真行|不是|我服了|……|讲真)/.test(s)) prefixInInst += 1;
  }
  assert(prefixInInst === 0, '机构/自营不加语气前缀');
}

// ---------------- ② playerB 三个触发点 ----------------

section('[4] 玩家小额买入不触发');
{
  const dm = freshDm();
  const p = mkAcc('p1', 'player', false);
  dm.onPlayerAction(p, 'buy', S1.id, 100000, 10000, 1000, null); // 10 万 < 500 万
  dm.step(3000);
  assert(dm.items.length === 0, '10 万的买入不产生弹幕');
}

section('[5] 拆单只出一条（聚合窗口）');
{
  const dm = freshDm();
  const p = mkAcc('p2', 'player', false);
  // 500 万拆成 12 笔：不聚合的话会发 12 条
  for (let i = 0; i < 12; i += 1) dm.onPlayerAction(p, 'buy', S1.id, BIG / 10, 1000, 1000 + i * 100, null);
  dm.step(5000);
  const pb = dm.items.filter((x) => x.flag === 'playerB');
  assert(pb.length === 1, `12 笔拆单只出 1 条（实际 ${pb.length}）`);
  assert(pb[0] && pb[0].text.length > 0, '文案非空');
}

section('[6] 同一玩家 5 分钟内只被评论一次');
{
  const dm = freshDm();
  const p = mkAcc('p3', 'player', false);
  dm.onPlayerAction(p, 'buy', S1.id, BIG * 2, 1000, 1000, null);
  dm.step(3000);
  // 过了 30 秒的聚合静默期，但还在 5 分钟评论冷却内
  dm.onPlayerAction(p, 'buy', S1.id, BIG * 2, 1000, 40000, null);
  dm.step(42000);
  const pb = dm.items.filter((x) => x.flag === 'playerB');
  assert(pb.length === 1, '5 分钟内第二次大额买入不再被评论');
}

section('[7] 清仓割肉');
{
  const dm = freshDm();
  const p = mkAcc('p4', 'player', false);
  // 均价 12、成交价 9、清空、累计 30 万 → 割肉
  dm.onPlayerAction(p, 'sell', S1.id, 300000, 33333, 1000, { avg: 12, qtyBefore: 33333, posAfter: 0 });
  dm.step(3000);
  const pb = dm.items.filter((x) => x.flag === 'playerB');
  assert(pb.length === 1, '亏损清仓触发「有人割在地板上」');

  const dm2 = freshDm();
  const p2 = mkAcc('p5', 'player', false);
  // 盈利清仓（成交价 15 > 均价 12）：不该说「割在地板上」
  dm2.onPlayerAction(p2, 'sell', S1.id, 300000, 20000, 1000, { avg: 12, qtyBefore: 20000, posAfter: 0 });
  dm2.step(3000);
  assert(dm2.items.length === 0, '盈利清仓不触发割肉话术');

  const dm3 = freshDm();
  const p3 = mkAcc('p6', 'player', false);
  // 只卖了一半（posAfter > 0）：不算清仓
  dm3.onPlayerAction(p3, 'sell', S1.id, 300000, 20000, 1000, { avg: 12, qtyBefore: 40000, posAfter: 20000 });
  dm3.step(3000);
  assert(dm3.items.length === 0, '未清仓不触发');
}

section('[8] 玩家被强平');
{
  const dm = freshDm();
  const p = mkAcc('p7', 'player', false);
  dm.onLiquidate(p, S1.id, 1000);
  dm.step(3000);
  const pb = dm.items.filter((x) => x.flag === 'playerB');
  assert(pb.length === 1, '玩家强平触发「刚刚有人被抬走了」');
  dm.onLiquidate(p, S1.id, 5000);
  dm.step(7000);
  assert(dm.items.filter((x) => x.flag === 'playerB').length === 1, '2 分钟内不重复播报同一次爆仓');
}

section('[9] NPC 成交不触发 playerB');
{
  const dm = freshDm();
  const n = mkAcc('npc-1', 'hot', true);
  dm.onPlayerAction(n, 'buy', S1.id, BIG * 10, 1000, 1000, null);
  dm.step(3000);
  assert(dm.items.length === 0, 'NPC 之间的大额成交不产生「有大哥进场了」');
}

// ---------------- ③ 频率漏斗 ----------------

section('[10] 单股配额与全服节奏');
{
  const dm = freshDm();
  dm.cfg.speakChance = 1;
  dm.noteWatch(S1.id, 0);
  // 40 位不同的人：单账户 10 分钟只能说 1 条，只放一个人只能测出 1 条（那不是配额）
  mgr.npcs = [];
  for (let i = 0; i < 40; i += 1) {
    const a = mkAcc('npc-' + i, i % 3 === 0 ? 'big' : 'small', true);
    a._pnl = -0.16 - (i % 12) * 0.01;
    mgr.npcs.push({ acc: a, type: a.role });
  }
  let sent = 0;
  // 连续 10 分钟、每 200ms 给一次机会：单股 4 条/分钟 → 10 分钟最多约 40 条。
  // 每 60 秒补一次心跳，模拟客户端的 `/api/danmaku/watch`（watchTtlMs 只有 5 分钟）
  for (let t = 0; t < 600000; t += 200) {
    if (t % 60000 === 0) dm.noteWatch(S1.id, t);
    const before = dm.items.length;
    dm.step(t);
    if (dm.items.length > before) sent += 1;
  }
  // 40 人的池子是极端场景：单账户 10 分钟 1 条，本身就是 40 条的天花板，
  // 再叠上「挑人时可能撞到刚说过话的人」的随机浪费，实际落在 25~40 之间。
  // 阈值取 20（= 2 条/分钟，方案里定义的冷场线），不钉死具体条数
  assert(sent >= 20, `10 分钟内发了 ${sent} 条（冷场线 20）`);
  assert(sent <= 45, `10 分钟内不超过 45 条（单股 4 条/分钟的上限，实际 ${sent}）`);
}

section('[10b] 没人看就不生成');
{
  const dm = freshDm();
  dm.cfg.speakChance = 1;
  // 一个 watcher 都没有：不该拿全市场随机兜底，那会把配额摊到没人看的股票上
  for (let t = 0; t < 120000; t += 200) dm.step(t);
  assert(dm.items.length === 0, '零 watcher 时一条都不生成（实际 ' + dm.items.length + '）');

  // 打点后 5 分钟内生成；TTL 过期且没有心跳 → 停止（这就是客户端要 60 秒心跳的原因）
  const dm2 = freshDm();
  dm2.cfg.speakChance = 1;
  mgr.npcs = [];
  for (let i = 0; i < 40; i += 1) {
    const a = mkAcc('npc-x' + i, 'small', true);
    a._pnl = -0.2;
    mgr.npcs.push({ acc: a, type: 'small' });
  }
  dm2.noteWatch(S1.id, 0);
  for (let t = 0; t < 300000; t += 200) dm2.step(t);
  // 用 seq（累计条数）而不是 items.length：items 只保留最近 60 秒，长度会稳定在配额附近
  const seqBefore = dm2.seq;
  assert(seqBefore > 0, '打点后 5 分钟内正常生成（' + seqBefore + ' 条）');
  for (let t = 300001; t < 480000; t += 200) dm2.step(t);
  assert(dm2.seq === seqBefore, '心跳过期后不再生成新弹幕');
}

section('[10c] 说话人冷却、全服闸门与停牌');
{
  // playerB 的说话人也要守单账户 10 分钟：全员刚说过话时宁可不说，不能硬塞给同一个人
  const dm = freshDm();
  const p = mkAcc('p9', 'player', false);
  for (const n of mgr.npcs) dm.accLast.set(n.acc.name, 1000);
  dm.onPlayerAction(p, 'buy', S1.id, BIG * 2, 1000, 1000, null);
  dm.step(3000);
  assert(dm.items.filter((x) => x.flag === 'playerB').length === 0, '说话人全在冷却中时不硬塞');

  // 同一 tick 到期的两条反应不能一起放出去（全服 1.5 秒一条）
  const dm2 = freshDm();
  const a = mkAcc('pA', 'player', false);
  const b = mkAcc('pB', 'player', false);
  dm2.onLiquidate(a, S1.id, 1000);
  dm2.onLiquidate(b, S1.id, 1000);
  dm2.step(3000);
  assert(dm2.items.filter((x) => x.flag === 'playerB').length === 1, '同一 tick 只放一条');
  dm2.step(4600);
  assert(dm2.items.filter((x) => x.flag === 'playerB').length === 2, '下个节奏点补上第二条');

  // 停牌：tick 传 halted 时一条都不生成（没有成交也没有事件，说什么都是假的）
  const dm3 = freshDm();
  dm3.cfg.speakChance = 1;
  dm3.noteWatch(S1.id, 0);
  for (let t = 0; t < 60000; t += 200) dm3.step(t, { halted: true, phase: 'morning' });
  assert(dm3.items.length === 0, '停牌期间不生成（实际 ' + dm3.items.length + '）');
}

// ---------------- ④ 玩家主动发弹幕 ----------------

section('[11] 玩家发言校验');
{
  const dm = freshDm();
  const p = mkAcc('p8', 'player', false);
  const r1 = dm.postPlayer(p, S1.id, '这票我熟', 1000);
  assert(r1.ok, '正常内容可以发');
  const r2 = dm.postPlayer(p, S1.id, '再说一句', 2000);
  assert(!r2.ok, '5 秒内连发被拒');
  const r3 = dm.postPlayer(p, S1.id, 'x'.repeat(30), 9000);
  assert(!r3.ok, '超过 24 字被拒');
  const r4 = dm.postPlayer(p, S1.id, '加群带你飞', 20000);
  assert(!r4.ok, '导流/敏感词被拒');
  const r5 = dm.postPlayer(p, 'S9', '看看', 30000);
  assert(!r5.ok, '未知标的被拒');
  const r6 = dm.postPlayer(p, S1.id, '   ', 40000);
  assert(!r6.ok, '空白内容被拒');
  assert(dm.items.filter((x) => x.kind === 'player').length === 1, '只有第一条成功入列');
}

section('[11b] 玩家弹幕内容闸门');
{
  const dm = freshDm();
  const p = mkAcc('pC', 'player', false);
  assert(dm.postPlayer(p, S1.id, '这票我熟', 1000).ok, '第一条通过');
  // 过了 5 秒冷却，但还在同文 60 秒窗口里
  assert(!dm.postPlayer(p, S1.id, '这票我熟', 8000).ok, '60 秒内重发同一句被拒');
  assert(!dm.postPlayer(p, S1.id, '看看 http://x.cn', 20000).ok, 'URL 被拒');
  assert(!dm.postPlayer(p, S1.id, '!!!!!!', 30000).ok, '纯符号被拒');
  assert(!dm.postPlayer(p, S1.id, '啊啊啊啊啊啊啊', 40000).ok, '连续重复字符被拒');
  assert(dm.postPlayer(p, S1.id, '换个说法', 50000).ok, '正常内容仍可发');
}

// ---------------- ⑤ 红线：下发的字段白名单 ----------------

section('[12] item 字段白名单（不剧透 / 不泄露玩家身份）');
{
  const ALLOWED = new Set(['id', 't', 'stockId', 'kind', 'type', 'text', 'flag', 'from']);
  const dm = freshDm();
  const p = mkAcc('p9', 'player', false);
  dm.onPlayerAction(p, 'buy', S1.id, BIG * 2, 1000, 1000, null);
  dm.step(3000);
  const pb = dm.items.find((x) => x.flag === 'playerB');
  const keys = Object.keys(pb || {});
  assert(keys.every((k) => ALLOWED.has(k)), `playerB 的键都在白名单内：${keys.join(',')}`);
  assert(!('playerId' in (pb || {})) && !('acc' in (pb || {})), 'playerB 不带玩家标识');
  const raw = JSON.stringify(pb || {});
  assert(!raw.includes('p9'), 'playerB 的 payload 里搜不到玩家账号/昵称');
  assert(!/fairValue|force|intent|llmPlan/.test(raw), 'payload 不含任何内幕字段');
}

// ---------------- ⑥ 集成：真实撮合链路 ----------------

section('[13] 集成：execute → 弹幕 → stateFor');
{
  const g = new Game();
  // NPC 账户不是构造时就建好的（`Game.start()` 里才 init）。测试不启动定时器，
  // 手动 init 每只票，否则 npcs 为空、也拿不到对手盘
  for (const st of g.stocks) g.npcs.get(st.id).init(Date.now());
  const ob = g.onboard('dmuser', '弹幕测试', 'zhaoshang');
  assert(ob && ob.ok !== false && ob.token, '开户成功');
  const tk = ob.token;
  const buyer = g.store.get('dmuser');
  const m = g.markets.get(STOCK.id);
  const seller = g.npcs.get(STOCK.id).npcs[0].acc;
  assert(seller && seller.longQty(STOCK.id) > 0, 'NPC 池已建仓（对手盘可用）');

  // 不走 placeOrder：盘口要不要报价取决于交易日阶段（夜间/收盘竞价不报价），
  // 测试不该在一天里的某个钟点随机变红。直接调 execute，覆盖的正是我们新增的那段
  const mkOrder = (acc, side, action) => ({
    id: 'T' + Math.random().toString(36).slice(2),
    account: acc,
    side,
    action,
    stockId: STOCK.id,
    qty: 100,
    filled: 0,
    price: 0,
    frozen: 0,
    status: 'live',
  });
  g.danmaku.cfg.playerB.floatMvPct = 1e-12; // 门槛压到极低：任何成交都算「大额」
  m.execute(mkOrder(buyer, 'buy', ACTIONS.BUY_OPEN), mkOrder(seller, 'sell', ACTIONS.SELL_CLOSE), m.lastPrice, 100, Date.now(), 'buy');
  assert(g.danmaku.queue.length >= 1, 'execute 把玩家大额买入报给了弹幕系统');
  g.danmaku.step(Date.now() + 3000);

  const st = g.stateFor(tk);
  assert(st.danmaku && Array.isArray(st.danmaku.items), 'stateFor 下发 danmaku.items');
  const mine = st.danmaku.items.filter((x) => x.stockId === STOCK.id && x.flag === 'playerB');
  assert(mine.length >= 1, `玩家成交后产生了 playerB 弹幕（${mine.length} 条）`);
  assert(typeof st.danmaku.seq === 'number' && st.danmaku.seq > 0, 'seq 为正数（客户端水位依赖它）');
  // 玩家主动发言也走一遍：HTTP 层只做令牌解析，判定在 postPlayer
  const pr = g.sendDanmaku(tk, STOCK.id, '这票我熟');
  assert(pr.ok, 'sendDanmaku 端到端可用');
  const st2 = g.stateFor(tk);
  assert(st2.danmaku.items.some((x) => x.kind === 'player' && x.from === '弹幕测试'), '玩家弹幕带昵称下发');
}

// ---------------- 汇总 ----------------
console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed) process.exit(1);
