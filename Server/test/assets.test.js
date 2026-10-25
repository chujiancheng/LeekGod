/**
 * 每日收盘资产快照测试：node test/assets.test.js
 *
 * 覆盖主页「资产轨迹」卡的服务端链路（2026-10-25 起）：
 *   ① 收盘定格 —— settleDay 给每个玩家写一行 daily_assets（NPC 不进表），
 *      字段与 equityOf 同口径；收盘与夜间两次 settleDay / 重复结算靠
 *      _assetsWrittenDay 去重，不会把改过的值重新覆盖进去
 *   ② 轨迹查询 —— loadAssetHistory 新→旧、limit
 *   ③ /api/account/assets（assetHistoryFor）—— 未登录 401、盘中给当日实时点
 *      （live）、夜间已定格不再给（避免图上冒出两个同日点）
 *   ④ 崩溃漏结兜底 —— rollTurnoverDay 先补写再翻页
 *   ⑤ 构成项恒等式 —— cash + order_frozen + long_value + short_margin − short_mv
 *      − debt − lend_debt = equity（空头玩家也要成立，否则「资产构成条」拼不回总量）
 *   ⑥ 续跑恢复 —— `_assetsWrittenDay` 从库里 MAX(day) 恢复，重启后跨日翻页不会
 *      拿次日盘初值覆盖已定格的收盘；资产定格判据不看 `_turnoverDay`（白天没成交
 *      就崩的那次，meta 落后一天也不该让轨迹缺一格）
 *   ⑦ 新局清表 —— startRound 清空 daily_assets
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
config.margin.allowNakedShort = true;
config.priceLimit.enabled = false;

const { Account } = require('../src/store');
const { Game } = require('../src/game');
const { Persister } = require('../src/persist');

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
const near = (a, b, eps = 0.02) => Math.abs(a - b) < eps;

const ID = config.stocks[0].id;
const FILE = path.join(os.tmpdir(), `gushen-assets-test-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE + s, { force: true });

const persist = new Persister(FILE);
const g = new Game({ persist });
g.start();
g.day.reanchor(Date.now() - 120000); // 锚进第 1 天上午连续竞价
for (let i = 0; i < 3; i++) g.tick();

// 两个玩家 + 一个 NPC。玩家不带持仓先落一天，第二轮回再加仓位验 equity 口径
const A = g.store.createOrGet('trader1');
A.nick = '甲';
A.cash = 500000;
const B = g.store.createOrGet('trader2');
B.nick = '乙';
B.cash = 800000;
// C 做空：验证空头市值 / 空头保证金两个构成项也被记住（只存 shortMargin 会让
// 「构成项拼回 equity」的恒等式对空头玩家不成立）
const C = g.store.createOrGet('trader3');
C.nick = '丙';
C.cash = 300000;
const N = new Account('npc-t9', true);
N.cash = 100000000;
g.store.put(N);

const dayMs = g.day.dayMs;
const night1 = g.day.startAt + 590000; // 第 1 天夜间
const st1 = g.day.locate(night1);
assert(st1.phase.key === 'night' && st1.day === 1, `night1 落在第 1 天夜间（${st1.day}/${st1.phase.key}）`);

// 给 A 买 500 股（对手是 NPC），让「现金 + 持仓市值」两种构成都出现
const m = g.markets.get(ID);
const rp = m.place(N, { action: 'sell_open', qty: 1000, price: 20, now: Date.now(), noCooldown: true });
assert(rp.ok, `NPC 挂出对手卖单（${rp.ok}）`);
const rb = m.place(A, { action: 'buy_open', qty: 500, price: 20, now: Date.now(), noCooldown: true });
assert(rb.ok && rb.order.filled === 500, `A 买入成交 500 股（${rb.ok ? rb.order.filled : rb.error}）`);
// C 融券开空 200 股（吃做市商买盘）：保证金 + 空头市值 + 融券欠息都该进快照。
// 不能用「自己挂买单再自己卖」的路子——同账户反手会被自成交闸门挡掉
const rs = m.place(C, {
  action: 'sell_open',
  qty: 200,
  price: r2(g.priceOf(ID) * 0.99),
  now: Date.now(),
  noCooldown: true,
});
assert(rs.ok && rs.order.filled === 200, `C 开空成交 200 股（${rs.ok ? rs.order.filled : rs.error}）`);

const expectA = {
  cash: r2(A.cash),
  longValue: r2(A.totalLongValue((sid) => g.priceOf(sid))),
  equity: r2(g.equityOf(A)),
};
assert(expectA.longValue > 0, `A 有持仓市值（${expectA.longValue}）`);
const expectC = r2(g.equityOf(C));
// 构成项恒等式：cash + 冻结 + 多头市值 + 空头保证金 − 空头市值 − 融资负债 − 融券欠息 = 权益
const partsSum = (r) =>
  r.cash + r.orderFrozen + r.longValue + r.shortMargin - r.shortMv - r.debt - r.lendDebt;

g.settleDay(night1, { meta: true });

console.log('\n[1] 收盘定格：每个玩家一行，NPC 不进表');
{
  const rows = persist.loadAssetHistory('trader1', 10);
  assert(rows.length === 1, `trader1 落了 1 行（${rows.length}）`);
  const row = rows[0];
  assert(row.day === 1, `挂在第 1 天（${row.day}）`);
  assert(near(row.equity, expectA.equity), `权益与 equityOf 同口径（${row.equity} / ${expectA.equity}）`);
  assert(near(row.longValue, expectA.longValue), `持仓市值同口径（${row.longValue} / ${expectA.longValue}）`);
  assert(near(row.cash, expectA.cash), `现金同口径（${row.cash} / ${expectA.cash}）`);
  const b = persist.loadAssetHistory('trader2', 10);
  assert(b.length === 1 && b[0].day === 1 && near(b[0].equity, 800000), `trader2 也落一行（${b[0].equity}）`);
  const c = persist.loadAssetHistory('trader3', 10);
  assert(c.length === 1 && near(c[0].equity, expectC), `trader3 也落一行（${c[0].equity} / ${expectC}）`);
  assert(c[0].shortMargin > 0 && c[0].shortMv > 0,
    `空头玩家的保证金与空头市值都被记住（margin ${c[0].shortMargin} / mv ${c[0].shortMv}）`);
  assert(near(partsSum(c[0]), c[0].equity, 0.05),
    `构成项能拼回权益（${r2(partsSum(c[0]))} / ${c[0].equity}）`);
  assert(near(partsSum(row), row.equity, 0.05), `多头玩家构成项也对得上（${r2(partsSum(row))}）`);
  const npcRows = persist.db.prepare('SELECT COUNT(*) AS n FROM daily_assets WHERE account = ?').get('npc-t9');
  assert(npcRows.n === 0, 'NPC 账户不进资产快照表');
  const total = persist.db.prepare('SELECT COUNT(*) AS n FROM daily_assets').get().n;
  assert(total === 3, `全天只有玩家 3 行（${total}）`);
}

console.log('\n[2] 去重：重复结算不会把改过的值重新覆盖进去');
{
  A.cash = 999999; // 结算后动现金（相当于次日的正常交易），再触发同一天的重复结算
  g.settleDay(night1 + 1000, { meta: true }); // 仍在第 1 天夜间
  const row = persist.loadAssetHistory('trader1', 10)[0];
  assert(near(row.equity, expectA.equity), `第 1 天的定格值原样保留（${row.equity}）`);
  const total = persist.db.prepare('SELECT COUNT(*) AS n FROM daily_assets').get().n;
  assert(total === 3, `仍只有 3 行（${total}）`);
}

console.log('\n[3] 轨迹查询：新→旧、limit');
{
  // 快进到第 2/3 天夜间补结算（_turnoverDay 生产上由 tick 的 rollTurnoverDay 维护，
  // 这里手动推到对应天，与「该天夜间定格」的真实时序一致）
  for (let d = 2; d <= 3; d++) {
    const nightAt = g.day.startAt + (d - 1) * dayMs + 590000;
    assert(g.day.locate(nightAt).phase.key === 'night' && g.day.locate(nightAt).day === d,
      `第 ${d} 天夜间时刻定位正确`);
    g._turnoverDay = d;
    g.settleDay(nightAt, { meta: true });
  }
  const rows = persist.loadAssetHistory('trader1', 10);
  assert(rows.length === 3, `trader1 有 3 行（${rows.length}）`);
  assert(rows[0].day === 3 && rows[2].day === 1, '按交易日新→旧返回');
  const lim = persist.loadAssetHistory('trader1', 2);
  assert(lim.length === 2 && lim[0].day === 3 && lim[1].day === 2, 'limit 取最近 N 天');
}

console.log('\n[4] /api/account/assets：鉴权、盘中实时点、夜间不重复给');
{
  assert(g.assetHistoryFor('', 60).ok === false, '未登录被拒');
  g.sessions.set('tok-a', 'trader1');
  const r = g.assetHistoryFor('tok-a', 60);
  assert(r.ok && r.rows.length === 3, `已登录拿到 3 个收盘点（${r.rows.length}）`);

  // 模拟「昨天已收盘、今天盘中」：墙钟锚到第 4 天上午（reanchor 的参数是本轮开盘时刻，
  // elapsed = now − startAt，所以要往前倒推 3 整天再走 120s）→ 当日实时点必须有
  g.day.reanchor(Date.now() - 3 * dayMs - 120000);
  const st4 = g.day.locate(Date.now());
  assert(st4.phase.key === 'morning' && st4.day === 4, `墙钟落在第 4 天上午（${st4.day}/${st4.phase.key}）`);
  const rDay = g.assetHistoryFor('tok-a', 60);
  assert(rDay.ok && rDay.live && rDay.live.day === 4 && rDay.live.live === true,
    `盘中给当日实时点（day=${rDay.live && rDay.live.day}）`);
  assert(near(rDay.live.equity, r2(g.equityOf(A))), '实时点权益也是 equityOf 口径');
  assert(!rDay.rows.some((row) => row.day === rDay.live.day), '实时点不与已收盘行同天（不会双点）');

  // 夜间且当日已定格 → 不给 live（那一行刚写进 rows，重复给就是同一天两个点）
  g.day.reanchor(Date.now() - 4 * dayMs - 590000);
  assert(g.day.locate(Date.now()).phase.key === 'night', '墙钟落在第 5 天夜间');
  g._turnoverDay = 5;
  g.settleDay(Date.now(), { meta: true }); // 第 5 天的正式夜间定格
  const rNight = g.assetHistoryFor('tok-a', 60);
  assert(rNight.ok && rNight.live === null, '夜间已定格不再给实时点');
  assert(rNight.rows[0].day === 5, `最新收盘行就是当晚定格的第 5 天（${rNight.rows[0].day}）`);
}

console.log('\n[5] 夜间重启：内存水位线丢了也不给同日第二个点');
{
  // `_assetsWrittenDay` 是内存值、不落盘，重启后回到 -1；而当晚那行还在库里。
  // 判据必须以 rows 为准，否则夜里会同时回「第 5 天收盘行」和「第 5 天 live」（实测过）
  g._assetsWrittenDay = -1;
  const r = g.assetHistoryFor('tok-a', 60);
  assert(r.live === null, '水位线丢失后仍不给 live（以库里的行判重）');
  assert(r.rows[0].day === 5, `最新行仍是第 5 天（${r.rows[0].day}）`);
}

console.log('\n[6] 崩溃漏结兜底');
{
  // 模拟第 7 天收盘后崩溃、第 8 天才翻页：rollTurnoverDay 要先补写第 7 天
  g._turnoverDay = 7;
  g._assetsWrittenDay = -1;
  g.rollTurnoverDay({ day: 8 });
  const rows = persist.loadAssetHistory('trader1', 10);
  assert(rows.some((r) => r.day === 7), '漏结的第 7 天被翻页兜底补写');
  assert(g._assetsWrittenDay === 7, `水位线推到 7（${g._assetsWrittenDay}）`);
}

console.log('\n[7] 续跑恢复：水位线以库为准，重启后不会拿次日盘初值覆盖已定格的收盘');
{
  g.stop();
  // `_assetsWrittenDay` 不落 meta——库里那个 MAX(day) 就是答案。不恢复的话夜里重启会
  // 退回 -1，第二次开盘的跨日翻页就会认为「昨天没定格」，把昨天那份收盘快照整批覆盖掉
  const g2 = new Game({ persist });
  g2.start();
  g2.stop();
  assert(g2._assetsWrittenDay === persist.maxAssetDay(),
    `续跑后水位线对齐库里 MAX(day)（${g2._assetsWrittenDay} / ${persist.maxAssetDay()}）`);
  assert(g2._assetsWrittenDay === 7, `水位线恢复成 7（${g2._assetsWrittenDay}）`);

  const day7 = persist.loadAssetHistory('trader1', 20).find((r) => r.day === 7);
  assert(day7, '第 7 天那行在库里');
  // 续跑后的账户对象（测试里没跑 tick，存档里还没有 trader1 这行，直接按名字取或建）
  const A2 = g2.store.createOrGet('trader1');
  A2.cash = 900000; // 相当于次日盘初动了一下钱
  g2._turnoverDay = 7;
  g2.rollTurnoverDay({ day: 8 });
  const after = persist.loadAssetHistory('trader1', 20).find((r) => r.day === 7);
  assert(near(after.equity, day7.equity),
    `第 7 天的收盘值原样保留（${after.equity} / ${day7.equity}）`);

  console.log('\n[8] 白天一笔没成交就崩：资产判据不跟着 _turnoverDay 一起失效');
  // 这种情况下 meta 的 turnover_live 还停在前天，_turnoverDay 落后于真实交易日；
  // 成交统计只能跟着落后（它写的是内存累计），但资产快照读的是账户实时值，
  // 拿 `completedDay === _turnoverDay` 当判据只会让那一天在轨迹上永久缺一格
  g2.day.reanchor(Date.now() - 7 * dayMs - 590000); // 第 8 天夜间
  const st = g2.day.locate(Date.now());
  assert(st.day === 8 && st.phase.key === 'night', `墙钟落在第 8 天夜间（${st.day}/${st.phase.key}）`);
  g2._turnoverDay = 6;
  g2._assetsWrittenDay = 7;
  g2._daySettled = 7;
  g2.settleDay(Date.now(), { meta: true });
  const rows = persist.loadAssetHistory('trader1', 20);
  assert(rows.some((r) => r.day === 8), `第 8 天照样定格（${rows[0] && rows[0].day}）`);

  console.log('\n[9] 新局清表');
  persist.startRound(Date.now());
  const total = persist.db.prepare('SELECT COUNT(*) AS n FROM daily_assets').get().n;
  assert(total === 0, `新开局清空资产快照（${total}）`);
  assert(persist.maxAssetDay() === 0, `清表后 MAX(day) 归零（${persist.maxAssetDay()}）`);
}

g.stop();
persist.close();
for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE + s, { force: true });

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
