/**
 * 彩蛋（里程碑）测试：node test/milestones.test.js
 *
 * 覆盖 Doc/彩蛋玩法方案.md §11 的守门清单：
 *   ① 幂等（同 id 只触发一次、重启不重放）  ② 老档兼容（peakEquity 初始化为当前权益而非 0）
 *   ③ NPC 不落盘                           ④ 判定权益 == stateFor 下发的权益
 *   ⑤ 结算兜底路径也判硬门槛                ⑥ 回撤单调 + rearm
 *   ⑦ 不污染消息池                          ⑧ 判定不在逐 tick 路径上
 *   ⑨ 刷新不重播（前端，见 Client/test/client-day.test.js）
 *   ⑩ 落盘往返与版本 4 → 6 原地升级
 *
 * 与其它服务端测试同口径：关掉涨跌停（用例按盘口打价是常态）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
config.priceLimit.enabled = false;

const milestones = require('../src/milestones');
const { Account } = require('../src/store');
const { Game } = require('../src/game');
const { Persister } = require('../src/persist');
const { openDatabase, SCHEMA_VERSION } = require('../src/db');
const Database = require('better-sqlite3');

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

const r2 = (v) => Math.round(v * 100) / 100;
const CTX = (equity, day, extra = {}) =>
  Object.assign({ equity, marginUsage: 0, day, now: 1700000000000 + day * 1000 }, extra);
const ids = (evs) => evs.map((e) => e.id).join(',');
const tmpFile = (tag) => path.join(os.tmpdir(), `gushen-egg-${tag}-${process.pid}.db`);
const rmDb = (f) => {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true });
};

// ============================================================
console.log('\n[1] A 族发家线：门槛、升序、一天跨多档时只留最高的几档');
{
  const s = milestones.emptyState();
  const e1 = milestones.evaluateClose(s, CTX(1000000, 1));
  assert(e1.length === 0, '开局 100 万：一档都不触发（A01 门槛 110 万）');
  assert(s.peakEquity === 1000000, `水位线初始化成当前权益（${s.peakEquity}）`);

  const e2 = milestones.evaluateClose(s, CTX(1600000, 2));
  assert(ids(e2) === 'A01,A02', `涨到 160 万触发 A01/A02（${ids(e2)}）`);
  assert(s.peakEquity === 1600000, '水位线跟着抬到 160 万');

  // 停机多日后补结算一次跨好几档：fired 全记下，事件队列只留最高的 5 档
  const e3 = milestones.evaluateClose(s, CTX(12000000, 3));
  assert(ids(e3) === 'A03,A04,A05,A06,A07', `一次跨到 1200 万：A03~A07 五档（${ids(e3)}）`);
  assert(s.fired.length === 7, `fired 记下全部 7 档（${s.fired.length}）`);
  assert(s.events.length === config.milestones.eventQueueMax, '事件队列被 eventQueueMax 截到 5 条');
  assert(s.events[0].id === 'A03', `队列丢的是**旧**的，留下最高的那几档（首条 ${s.events[0].id}）`);
  assert(s.events.every((e) => e.seq > 0 && e.day >= 2), '每条事件都带单调 seq 与交易日号');
  assert(s.seq === 7, `seq 单调自增到 7（${s.seq}）`);
}

// ============================================================
console.log('\n[2] B1 绝对水位跌破 / B2 相对回撤阶梯（两条尺子互不干扰）');
{
  const s = milestones.emptyState();
  milestones.evaluateClose(s, CTX(1000000, 1));
  const e = milestones.evaluateClose(s, CTX(400000, 2));
  // 两条尺子同时亮：绝对水位跌破三档，同时距 100 万峰值回撤 60% 触发两档
  assert(ids(e) === 'B1-01,B1-02,B1-03,B2-01,B2-02', `跌到 40 万：两条尺子一起响（${ids(e)}）`);
  assert(s.maxDrawdown >= 0.59, `历史最大回撤被记下（${s.maxDrawdown}）`);

  // B2 阶梯：越过哪档就发哪档，**没有"整族上闸"**。持续下跌里 30% → 50% → 70% → 90%
  // 会依次点亮（每档只发一次）；早先那道"回到距峰值 10% 以内才重新武装"的闸门会把
  // 首次越过的更高档一起压掉，一段下跌只剩第一档、B2-03/B2-04 几乎不可达，已删除
  const s2 = milestones.emptyState();
  milestones.evaluateClose(s2, CTX(10000000, 1));
  const hit = milestones.evaluateClose(s2, CTX(4500000, 2));
  assert(ids(hit) === 'B2-01,B2-02', `1000 万跌到 450 万：一次越过 30%/50% 两档（${ids(hit)}）`);
  const deeper = milestones.evaluateClose(s2, CTX(2000000, 3));
  assert(ids(deeper) === 'B2-03', `继续跌到 200 万（回撤 80%）补上 B2-03（${ids(deeper)}）`);
  const deepest = milestones.evaluateClose(s2, CTX(990000, 4));
  assert(ids(deepest) === 'B2-04', `再跌到 99 万（回撤 90%）拿到传说档 B2-04（${ids(deepest)}）`);
  assert(
    ['B2-01', 'B2-02', 'B2-03', 'B2-04'].every((id) => s2.fired.includes(id)),
    '四档全部点亮（阶梯可达）'
  );
  const idle = milestones.evaluateClose(s2, CTX(9500000, 5));
  assert(ids(idle) === '', '回升到距峰值 10% 以内也不重复发（fired 是幂等键）');
  assert(s2.peakEquity === 10000000, '水位线只增不减（仍是 1000 万）');
  assert(
    JSON.parse(milestones.serialize(s2)).drawdownArmed === undefined,
    '落盘里不再有 drawdownArmed（整族闸门已删）'
  );
}

// ============================================================
console.log('\n[3] C 族：预警 C00 / 擦边 C01 / 首次强平 C02');
{
  const s = milestones.emptyState();
  milestones.evaluateClose(s, CTX(1000000, 1));
  const a = milestones.evaluateClose(s, CTX(1000000, 2, { marginUsage: 85 }));
  assert(ids(a) === 'C00', `风险度 85% 触发预警 C00（${ids(a)}）`);
  const b = milestones.evaluateClose(s, CTX(1000000, 3, { marginUsage: 96 }));
  assert(ids(b) === 'C01', `风险度 96% 未爆触发擦边 C01（${ids(b)}）`);
  const c = milestones.evaluateClose(s, CTX(1000000, 4, { marginUsage: 96 }));
  assert(ids(c) === '', '擦边档只给一次（幂等）');

  const d = milestones.onLiquidation(s, CTX(1000000, 4));
  assert(ids(d) === 'C02', `首次强平落地 C02（${ids(d)}）`);
  const e = milestones.onLiquidation(s, CTX(1000000, 4));
  assert(ids(e) === '', '第二次强平不再触发（每类彩蛋只给一次）');
  assert(d[0].kind === 'liquidation' && d[0].rarity === 'rare', 'C02 归类与稀有度正确');

  // C01 的口径是「≥95% 且**没爆**」：当天已经爆过仓的人不该再收到"擦边过关"
  const s2 = milestones.emptyState();
  milestones.evaluateClose(s2, CTX(1000000, 1));
  const liq = milestones.onLiquidation(s2, CTX(1000000, 2));
  assert(ids(liq) === 'C02' && s2.liqDay === 2, `强平记下当天（${ids(liq)} · liqDay ${s2.liqDay}）`);
  assert(milestones.parse(JSON.parse(milestones.serialize(s2))).liqDay === 2, 'liqDay 落盘往返');
  const afterLiq = milestones.evaluateClose(s2, CTX(1000000, 2, { marginUsage: 96 }));
  assert(!afterLiq.some((x) => x.id === 'C01'), `当天已爆：C01 被压下（${ids(afterLiq) || '无'}）`);

  const s3 = milestones.emptyState();
  milestones.evaluateClose(s3, CTX(1000000, 1));
  milestones.onLiquidation(s3, CTX(1000000, 2));
  const nextDay = milestones.evaluateClose(s3, CTX(1000000, 3, { marginUsage: 96 }));
  assert(nextDay.some((x) => x.id === 'C01'), `换一天（当天没爆）照常发 C01（${ids(nextDay)}）`);
}

// ============================================================
console.log('\n[4] 幂等：同一收盘日只评估一次，重启也不重放');
{
  const s = milestones.emptyState();
  const first = milestones.evaluateClose(s, CTX(3000000, 5));
  assert(first.length === 4, `第 5 天收盘触发 4 档（${ids(first)}）`);
  const twice = milestones.evaluateClose(s, CTX(3000000, 5));
  assert(twice.length === 0, '同一交易日重复评估（常规 + 补结算）不再发一次');

  const restored = milestones.parse(JSON.parse(milestones.serialize(s)));
  assert(restored.seq === s.seq, `seq 落盘往返（${restored.seq}）`);
  assert(restored.fired.length === s.fired.length, 'fired 落盘往返');
  assert(restored.peakEquity === s.peakEquity, 'peakEquity 落盘往返');
  assert(restored.titles.length === s.titles.length, 'titles 落盘往返');
  const afterRestart = milestones.evaluateClose(restored, CTX(3000000, 5));
  assert(afterRestart.length === 0, '重启后同一天的结算不重放（dayEvaluated 落盘）');
}

// ============================================================
console.log('\n[5] 老档兼容：peakEquity 取当前权益，不是 0');
{
  const s = milestones.parse(null);
  assert(s.peakEquity === null && s.fired.length === 0 && s.seq === 0, '没有存档列时是干净的新状态');
  const sum = milestones.summary(s, { equity: 5000000, initialCash: 1000000 });
  assert(sum.drawdown === 0, `还没初始化时回撤算 0 而不是 100%（${sum.drawdown}）`);
  milestones.initPeak(s, 5000000);
  assert(s.peakEquity === 5000000, '初始化取当前权益');
  const bad = milestones.parse({ peakEquity: 0, seq: 3, fired: ['A01'] });
  assert(bad.peakEquity === null, '存档里偶发的 0 会被当成"未初始化"而非"水位 0"');
  const sum2 = milestones.summary(bad, { equity: 900000, initialCash: 1000000 });
  assert(sum2.drawdown === 0, '水位 0 的脏数据不会算出"回撤 100%"');
}

// ============================================================
console.log('\n[6] 文案：三档基调齐全、默认 savage、跌破 10 万软着陆');
{
  const all = []
    .concat(config.milestones.wealth)
    .concat(config.milestones.absolute)
    .concat(config.milestones.drawdown)
    .concat(config.milestones.liquidation);
  const miss = [];
  for (const tone of ['savage', 'gentle', 'deadpan']) {
    for (const e of all) if (!milestones.TEXT[tone][e.id]) miss.push(`${tone}/${e.id}`);
  }
  assert(miss.length === 0, `全部 ${all.length} 个彩蛋的三档文案齐全${miss.length ? '：缺 ' + miss.join(' ') : ''}`);
  assert(config.milestones.tone === 'savage', '默认基调是 savage（毒舌）');

  const s = milestones.emptyState();
  const rich = milestones.evaluateClose(s, CTX(1600000, 1));
  const a02 = rich.find((x) => x.id === 'A02');
  assert(!!a02 && a02.text.includes('运气也算能力'), `默认走毒舌文案（${a02 && a02.text}）`);
  const s2 = milestones.emptyState();
  const broke = milestones.evaluateClose(s2, CTX(50000, 1));
  assert(broke.length > 0, `权益 5 万触发崩盘档（${ids(broke)}）`);
  assert(
    broke.every((e) => e.text === milestones.TEXT.gentle[e.id]),
    '权益跌破 10 万后崩盘类文案自动降级 gentle（与全局基调无关）'
  );
  assert(broke.every((e) => !e.text.includes('关灯吃面')), '软着陆后不再嘲讽');
  const liq = milestones.onLiquidation(s2, CTX(50000, 1));
  assert(liq.every((e) => e.text === milestones.TEXT.gentle[e.id]), '爆仓类同样软着陆');
  // deadpan 是配置可切换的
  const old = config.milestones.tone;
  config.milestones.tone = 'deadpan';
  const s3 = milestones.emptyState();
  const plain = milestones.evaluateClose(s3, CTX(1600000, 1));
  assert(plain[0].text === '收盘权益 ≥ 110 万。', `deadpan 基调生效（${plain[0].text}）`);
  config.milestones.tone = old;
}

// ============================================================
console.log('\n[7] 进度条与称号');
{
  const s = milestones.emptyState();
  milestones.evaluateClose(s, CTX(1600000, 1));
  const p = milestones.progressOf(s, 1800000, 1000000);
  assert(p.id === 'A03' && p.from === 1500000, `下一档是 A03，起点是上一档门槛（${p.id} from ${p.from}）`);
  assert(p.need === 200000, `还差 20 万（${p.need}）`);
  assert(Math.abs(p.pct - 0.6) < 1e-6, `进度 60%（${p.pct}）`);
  assert(p.reached === false, '未达门槛');
  const p2 = milestones.progressOf(s, 2500000, 1000000);
  assert(p2.reached === true && p2.need === 0, '越过门槛时 reached=true、need=0（等收盘确认）');
  const all = milestones.emptyState();
  milestones.evaluateClose(all, CTX(20000000000, 1));
  assert(milestones.progressOf(all, 20000000000, 1000000) === null, '十二档全亮后进度为 null');

  const t = milestones.emptyState();
  milestones.evaluateClose(t, CTX(5000000, 1)); // A05 rare
  const sum = milestones.summary(t, { equity: 5000000, initialCash: 1000000 });
  assert(sum.count === 5 && sum.title.id === 'A05', `当前称号取稀有度最高的（${sum.title.title}）`);
  const t2 = milestones.emptyState();
  milestones.evaluateClose(t2, CTX(10000000000, 1)); // 含 A12 legend
  const sum2 = milestones.summary(t2, { equity: 10000000000, initialCash: 1000000 });
  assert(sum2.title.rarity === 'legend' && sum2.title.title === '封神', `传说档优先展示（${sum2.title.title}）`);
  assert(sum2.events.length === 5 && sum2.seq === sum2.events[4].seq, 'summary 带 seq 与最近事件');
}

// ============================================================
console.log('\n[8] Game 集成：收盘结算判定、口径一致、NPC 不参与、不挂在 tick 上');
let token = '';
const g = new Game();
{
  g.day.reanchor(Date.now() - 590000); // 锚进第 1 天的夜间（580~620s）→ 收盘结算会做掉第 1 天
  const lr = g.onboard('eggTester', 'eggTester', 'zhaoshang');
  assert(lr.ok && !!lr.token, '登录成功');
  token = lr.token;
  const acc = g.store.get('eggTester');
  assert(acc.milestones && acc.milestones.peakEquity === 1000000, '登录即把水位线锚在当前权益（100 万）');
  acc.cash = r2(acc.cash + 1000000); // 让收盘权益 200 万 → A01/A02/A03

  // NPC 池：不跑 npc.init（那是 3160 个账户），手工建两个就够验「NPC 一律不参与」
  const npc = new Account('大米·机构1', true, 'inst');
  npc.cash = 10000000;
  g.store.put(npc);
  assert(npc.milestones === null, 'NPC 账户根本没有里程碑状态');

  // 第 1 天收盘结算：权益 200 万 → A01/A02/A03
  g.ensureDaySettled(Date.now());
  assert(acc.milestones.fired.join(',') === 'A01,A02,A03', `收盘权益 200 万触发三档（${acc.milestones.fired.join(',')}）`);

  // 判定不在逐 tick 路径：结算完之后跑 20 tick，一次评估都不该发生
  let evals = 0;
  const orig = g.evaluateMilestones.bind(g);
  g.evaluateMilestones = (...a) => {
    evals += 1;
    return orig(...a);
  };
  for (let i = 0; i < 20; i += 1) g.tick();
  assert(evals === 0, '20 个 tick 内零次判定（判定只挂收盘结算，不是逐 tick 全账户扫描）');
  assert(acc.milestones.fired.length === 3, '盘中不产生新彩蛋（P0 不做盘中瞬时演出）');

  // 兜底路径：时钟直接跳到第 2 天夜间（模拟休眠唤醒 / 长 GC 跨过收盘）
  g.day.reanchor(Date.now() - (620000 + 590000));
  g.ensureDaySettled(Date.now());
  assert(evals >= 1, '跨天兜底路径 ensureDaySettled 会判一次硬门槛');

  const st = g.stateFor(token);
  assert(st.account.equity === r2(g.equityOf(acc)), `下发的权益与判定用的是同一个数（${st.account.equity}）`);
  assert(st.account.events.enabled === true, 'stateFor 下发彩蛋段');
  assert(st.account.events.seq === 3, `events.seq 单调（${st.account.events.seq}）`);
  assert(st.account.events.events.length === 3, '最近事件随帧下发');
  assert(st.account.events.progress.id === 'A04', `下发下一档进度（${st.account.events.progress.id}）`);
  assert(st.account.events.titles.length === 3, '称号列表下发');
  assert(st.rules.milestones.enabled === true, 'rules 里带彩蛋开关');
  assert(st.account.events.events.every((e) => e.text && e.title && e.mascot), '事件带文案/称号/猫表情');

  // 强平上报钩子的异常隔离：这条钩子挂在 `market.maybeLiquidate` 里，而 maybeLiquidate
  // 是从 `execute`（撮合循环内）调的——彩蛋这一侧抛异常绝不能穿出去
  const origLiq = milestones.onLiquidation;
  milestones.onLiquidation = () => {
    throw new Error('boom');
  };
  let thrown = null;
  try {
    g.onLiquidate(acc, Date.now());
  } catch (e) {
    thrown = e;
  }
  milestones.onLiquidation = origLiq;
  assert(thrown === null, '彩蛋上报抛异常时被吞掉（不穿回撮合路径，只记一条 logger.error）');
}

// ============================================================
console.log('\n[9] 补结算路径：停机跨过好几天，回来也要判一次');
{
  const g2 = new Game();
  g2.day.reanchor(Date.now() - 590000);
  g2.onboard('eggJump', 'eggJump', 'zhongxin');
  const acc = g2.store.get('eggJump');
  acc.cash = r2(acc.cash + 6000000); // 700 万 → A01~A05
  g2._daySettled = 0; // 假装从没结过（模拟停机数天）
  g2.day.reanchor(Date.now() - (2 * 620000 + 500000)); // 第 3 天下午
  g2.ensureDaySettled(Date.now());
  assert(acc.milestones.fired.includes('A05'), `补结算把该发的彩蛋补上（${acc.milestones.fired.join(',')}）`);
  assert(acc.milestones.dayEvaluated >= 1, `评估日号落盘（${acc.milestones.dayEvaluated}）`);
  const again = milestones.evaluateClose(acc.milestones, CTX(acc.milestones.peakEquity, acc.milestones.dayEvaluated));
  assert(again.length === 0, '同一天再评估不会重复发');
}

// ============================================================
console.log('\n[10] 落盘：只有玩家写 milestones；重启后水位线与已发放状态续上');
{
  const FILE = tmpFile('rt');
  rmDb(FILE);
  const p = new Persister(FILE);
  const g3 = new Game({ persist: p });
  p.startRound(Date.now()); // 不写 meta 的话 loadAll 判不出「续跑」，重启取不到账户
  g3.day.reanchor(Date.now() - 590000);
  g3.onboard('eggSave', 'eggSave', 'haitong');
  const acc = g3.store.get('eggSave');
  const npc = new Account('大米·散户1', true, 'small');
  npc.cash = 5000000;
  g3.store.put(npc);
  p.touch(npc); // 让这个 NPC 账户本 tick 落盘（真实运行里 NPC 由 sweep 兜底写入）
  acc.cash = r2(acc.cash + 4000000); // 500 万 → A01~A05
  g3.ensureDaySettled(Date.now());
  p.commit({ now: Date.now(), markets: [...g3.markets.values()], allAccounts: g3.store.all() });

  const rows = p.db.prepare('SELECT name, is_npc, milestones FROM accounts').all();
  const playerRow = rows.find((r) => r.name === 'eggSave');
  const npcRow = rows.find((r) => r.is_npc === 1);
  assert(!!playerRow && !!playerRow.milestones, '玩家行写入了 milestones JSON');
  assert(JSON.parse(playerRow.milestones).peakEquity >= 4000000, `水位线落库（${JSON.parse(playerRow.milestones).peakEquity}）`);
  assert(!!npcRow && npcRow.milestones === null, 'NPC 行的 milestones 是 NULL（不逐 tick 标脏）');
  p.close();

  // 重启续上
  const p2 = new Persister(FILE);
  const g4 = new Game({ persist: p2 });
  g4.start();
  g4.stop();
  const acc2 = g4.store.get('eggSave');
  assert(acc2.milestones.fired.includes('A01') && acc2.milestones.fired.includes('A05'), '重启后已发放状态续上');
  assert(acc2.milestones.seq === 5, `seq 也续上（${acc2.milestones.seq}，重置会让客户端的 lastSeq 永远挡住新事件）`);
  assert(acc2.milestones.peakEquity >= 4000000, '水位线续上');
  assert(g4.store.all().filter((a) => a.isNPC).every((a) => a.milestones === null), '重启后 NPC 仍然没有里程碑状态');
  p2.close();
  rmDb(FILE);
}

// ============================================================
console.log('\n[11] 收盘评估必须标脏：没发事件的收盘，水位线也要落盘');
{
  const FILE = tmpFile('touch');
  rmDb(FILE);
  const p = new Persister(FILE);
  const g8 = new Game({ persist: p });
  p.startRound(Date.now());
  g8.day.reanchor(Date.now() - 590000);
  g8.onboard('eggPeak', 'eggPeak', 'zhaoshang');
  const acc = g8.store.get('eggPeak');
  acc.cash = r2(acc.cash + 50000); // 105 万：创了新高，但一档都够不着（A01 要 110 万）

  let touches = 0;
  const origTouch = p.touch.bind(p);
  p.touch = (a) => {
    touches += 1;
    return origTouch(a);
  };
  g8.ensureDaySettled(Date.now());
  assert(acc.milestones.fired.length === 0, '这个收盘一个彩蛋都没发');
  assert(acc.milestones.peakEquity === 1050000, `水位线照常抬到 105 万（${acc.milestones.peakEquity}）`);
  assert(acc.milestones.dayEvaluated >= 1, `评估日号也写上了（${acc.milestones.dayEvaluated}）`);
  // 不标脏的后果：重启后 peakEquity 退回上一次落盘的值（这里是登录时锚的 100 万），
  // 之后 `equity > peakEquity` 会把水位重新锚到更低的收盘价——真实峰值永久丢失
  assert(touches === 1, `没发事件也标了脏（touch ×${touches}）`);
  p.close();
  rmDb(FILE);
}

// ============================================================
console.log('\n[12] 老档兼容：milestones 为 NULL 的档也能起，水位线取当时权益');
{
  const FILE = tmpFile('legacy');
  rmDb(FILE);
  const p = new Persister(FILE);
  const g5 = new Game({ persist: p });
  p.startRound(Date.now());
  g5.day.reanchor(Date.now() - 590000);
  g5.onboard('eggOld', 'eggOld', 'dongfeng');
  const acc = g5.store.get('eggOld');
  acc.cash = r2(acc.cash + 2000000); // 300 万
  p.commit({ now: Date.now(), markets: [...g5.markets.values()], allAccounts: g5.store.all() });
  // 模拟版本 4 升级上来的老玩家：那一行还没有 milestones
  p.db.prepare('UPDATE accounts SET milestones = NULL WHERE name = ?').run('eggOld');
  p.close();

  const p2 = new Persister(FILE);
  const g6 = new Game({ persist: p2 });
  g6.start();
  g6.stop();
  const acc2 = g6.store.get('eggOld');
  assert(acc2.milestones !== null, 'milestones 为 NULL 的老档能正常启动');
  assert(acc2.milestones.peakEquity === r2(g6.equityOf(acc2)), `水位线取当时权益（${acc2.milestones.peakEquity}）`);
  assert(acc2.milestones.peakEquity > 0, '水位线不是 0');
  const sum = milestones.summary(acc2.milestones, { equity: r2(g6.equityOf(acc2)), initialCash: 1000000 });
  assert(sum.drawdown === 0 && sum.maxDrawdown === 0, '老玩家一进来不会看到"回撤 100%"');
  const st = g6.login('eggOld');
  assert(st.ok, '老玩家还能正常登录（登录路径不再重复初始化，但也不会覆盖水位线）');
  p2.close();
  rmDb(FILE);
}

// ============================================================
console.log('\n[13] 不污染消息池：彩蛋不进 news 列表、不参与池去重');
{
  const g7 = new Game();
  g7.day.reanchor(Date.now() - 590000);
  g7.onboard('eggNews', 'eggNews', 'huatai');
  const acc = g7.store.get('eggNews');
  acc.cash = r2(acc.cash + 9000000);
  const tapeBefore = g7.news.tape.length;
  const poolBefore = JSON.stringify(g7.news.recentByPool);
  g7.ensureDaySettled(Date.now());
  assert(acc.milestones.fired.length > 0, `确实触发了彩蛋（${acc.milestones.fired.join(',')}）`);
  assert(g7.news.tape.length === tapeBefore, '消息磁带长度没变（彩蛋走独立通道，不进 news）');
  assert(JSON.stringify(g7.news.recentByPool) === poolBefore, 'pickText 的池去重记录没被动过');
  const texts = Object.values(milestones.TEXT).flatMap((m) => Object.values(m));
  assert(
    g7.news.tape.every((n) => !texts.includes(n.text)),
    '磁带里不出现任何彩蛋文案'
  );
  const st = g7.stateFor(g7.onboard('eggNews', 'eggNews', 'huatai').token);
  assert((st.news || []).every((n) => !texts.includes(n.text)), 'stateFor 下发的消息列表里也没有彩蛋条目');
}

// ============================================================
console.log('\n[14] 存档版本 4 → 8：逐级原地升级补出 milestones / nick / lend_interest_accrued 列（以及 7 的 api_keys 表）');
{
  assert(SCHEMA_VERSION === 8, `当前版本是 8（${SCHEMA_VERSION}）`);
  const FILE = tmpFile('v4');
  rmDb(FILE);
  const db = new Database(FILE);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE accounts (
      name TEXT PRIMARY KEY, is_npc INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL,
      cash REAL NOT NULL, order_frozen REAL NOT NULL DEFAULT 0, short_margin REAL NOT NULL DEFAULT 0,
      realized_pnl REAL NOT NULL DEFAULT 0, initial_long INTEGER NOT NULL DEFAULT 0,
      last_order_at INTEGER, created_at INTEGER NOT NULL, deposited REAL NOT NULL DEFAULT 0,
      broker TEXT, broker_changed_at INTEGER, broker_since_day INTEGER, broker_stats TEXT,
      free_reselect_used INTEGER NOT NULL DEFAULT 0, coupon_used_day INTEGER, free_interest_day INTEGER
    );
    -- 版本 4 的 stock_ledger 还没有 lend_interest_accrued 列（那条要在 7 → 8 时 ALTER 补）
    CREATE TABLE stock_ledger (
      account TEXT NOT NULL, stock_id TEXT NOT NULL,
      lend_offered INTEGER NOT NULL DEFAULT 0,
      lend_interest_earned REAL NOT NULL DEFAULT 0,
      lend_interest_debt REAL NOT NULL DEFAULT 0,
      lend_interest_paid REAL NOT NULL DEFAULT 0,
      finance_interest_accrued REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (account, stock_id)
    );
  `);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run();
  db.prepare('INSERT INTO accounts (name, role, cash, created_at) VALUES (?,?,?,?)').run('老玩家', 'player', 888, 1);
  db.close();
  let err = '';
  let up = null;
  try {
    up = openDatabase(FILE);
  } catch (e) {
    err = e.message;
  }
  assert(!err && !!up, `版本 4 的档被原地升级而不是拒绝：${err}`);
  if (up) {
    const v = up.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    assert(Number(v.value) === SCHEMA_VERSION, `版本号写成 ${SCHEMA_VERSION}（${v.value}）`);
    const row = up.prepare('SELECT cash, milestones, nick FROM accounts WHERE name = ?').get('老玩家');
    assert(row.cash === 888, '原数据无损');
    assert(row.milestones === null, '新增的 milestones 列为 NULL');
    assert(row.nick === null, '新增的 nick 列为 NULL（登录时补昵称）');
    const ledCols = up.prepare('PRAGMA table_info(stock_ledger)').all().map((c) => c.name);
    assert(ledCols.includes('lend_interest_accrued'), '7 → 8 补出了 lend_interest_accrued 列');
    up.close();
  }
  rmDb(FILE);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);

