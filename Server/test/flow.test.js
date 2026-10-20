/**
 * 资金流向（内外盘 / 净流入）与日线测试：node test/flow.test.js
 *
 * 覆盖 2026-10-16 新增的两块「盘面指标」：
 *   ① 内外盘与资金净流入 —— 外盘=主动买、内盘=主动卖、净流入=外盘额−内盘额，
 *      且「外盘 + 内盘 == 当日成交量」这条账实一致不变量
 *   ② 日线（K 线）—— 日终结算定格一根、当日累计清零、补结算不误记、
 *      指数日线 = 成分股合计、落盘往返、dailyFor 下发口径
 *
 * 与其它文件同口径：关掉涨跌停（用例按 0.9/1.1 倍打价是常态）、需要开空时临时放开裸空。
 * 日线的「属于哪一天」判据依赖真实交易日时钟，所以第 3 节用真实 config.day。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
config.margin.allowNakedShort = true;
config.priceLimit.enabled = false;

const { Market, ACTIONS } = require('../src/market');
const { Account } = require('../src/store');
const { DayCycle } = require('../src/daycycle');
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

const STOCK = config.stocks[0];
const ID = STOCK.id;
const INDEX_ID = config.index.code;
const ALL_IDS = [...config.stocks.map((s) => s.id), INDEX_ID];
const P = (g) => g.markets.get(ID);
const r2 = (v) => Math.round(v * 100) / 100;
const near = (a, b, eps = 0.02) => Math.abs(a - b) < eps;

/** 孤立市场 + 两个荷包鼓鼓的账户（买卖两侧必须不同账户：同股多空互斥） */
function fresh(dayCycle) {
  const m = new Market(STOCK);
  if (dayCycle) m.dayCycle = dayCycle;
  const A = new Account('玩家A');
  const N = new Account('对手盘', true);
  N.cash = 100000000;
  return { m, A, N };
}

// ============================================================
console.log('\n[1] 内外盘：主动买记外盘、主动卖记内盘，账实一致');
{
  const { m, A, N } = fresh();
  // 对手先挂卖 20.10 × 1000，玩家主动买 600 → 外盘
  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20.1, now: 0, noCooldown: true });
  const rb = m.place(A, { action: ACTIONS.BUY_OPEN, qty: 600, price: 20.1, now: 0 });
  assert(rb.ok && rb.order.filled === 600, `主动买成交 600 股（${rb.order ? rb.order.filled : rb.error}）`);
  // 玩家挂买 19.90 × 400，对手主动砸下来 → 内盘
  m.place(A, { action: ACTIONS.BUY_OPEN, qty: 400, price: 19.9, now: 5000 });
  const rs = m.place(N, { action: ACTIONS.SELL_OPEN, qty: 400, price: 19.9, now: 5000, noCooldown: true });
  assert(rs.ok && rs.order.filled === 400, `主动卖成交 400 股（${rs.order ? rs.order.filled : rs.error}）`);

  const f = m.snapshot().flow;
  assert(f.outerVol === 600 && f.innerVol === 400, `外盘 600 股 / 内盘 400 股（${f.outerVol}/${f.innerVol}）`);
  assert(near(f.outerAmt, 600 * 20.1), `外盘额 = 主动买成交额（${f.outerAmt}）`);
  assert(near(f.innerAmt, 400 * 19.9), `内盘额 = 主动卖成交额（${f.innerAmt}）`);
  assert(near(f.net, 600 * 20.1 - 400 * 19.9), `净流入 = 外盘额 − 内盘额（${f.net}）`);
  // 账实一致：内外盘成交量必须等于当日成交量，否则盘口资金与成交量对不上
  assert(f.outerVol + f.innerVol === m.volume, `外盘+内盘 == 当日成交量（${f.outerVol + f.innerVol} / ${m.volume}）`);
  assert(near(f.outerAmt + f.innerAmt, m.turnover), `外盘额+内盘额 == 当日成交额（${f.outerAmt + f.innerAmt} / ${m.turnover}）`);
  const expectPct = ((600 * 20.1) / (600 * 20.1 + 400 * 19.9)) * 100;
  assert(near(f.outerPct, expectPct, 0.01), `外盘占比 ${f.outerPct}%（应为 ${expectPct.toFixed(2)}%）`);
  // 竞价撮合也是成交，同样按「虚拟价相对最新价」判主动方——这里只验它确实被计入
  assert(m.trades.length === 2, `逐笔成交 2 笔（${m.trades.length}）`);
}

console.log('\n[2] 日终结算：定格一根日线，当日累计清零');
{
  const { m, A, N } = fresh();
  m.place(N, { action: ACTIONS.SELL_OPEN, qty: 1000, price: 20.1, now: 0, noCooldown: true });
  m.place(A, { action: ACTIONS.BUY_OPEN, qty: 1000, price: 20.5, now: 0 });
  const before = m.snapshot();

  m.settleDay(10000, { day: 3 });
  assert(m.dailyBars.length === 1, `落下一根日线（${m.dailyBars.length} 根）`);
  const bar = m.dailyBars[0];
  assert(bar.day === 3, `日线挂在第 3 天（${bar.day}）`);
  assert(bar.open === before.open && bar.high === before.high && bar.low === before.low, `开高低原样定格（${bar.open}/${bar.high}/${bar.low}）`);
  assert(bar.close === before.last, `收盘价 = 结算前最新价（${bar.close}）`);
  assert(bar.volume === before.volume && near(bar.turnover, before.turnover), `量额 = 当日合计（${bar.volume} / ${bar.turnover}）`);
  assert(near(bar.net, before.flow.net), `日线净流入 = 当日净流入（${bar.net}）`);
  assert(bar.outerVol === before.flow.outerVol && bar.innerVol === before.flow.innerVol, '日线带内外盘量');
  assert(bar.outerAmt + bar.innerAmt > 0, `日线带内外盘额（${bar.outerAmt} + ${bar.innerAmt}）`);

  const after = m.snapshot().flow;
  assert(after.outerVol === 0 && after.innerVol === 0, '结算后当日内外盘量清零');
  assert(after.net === 0 && after.outerPct === null, '结算后净流入与占比回到「当日暂无成交」');
  assert(m.volume === 0 && m.turnover === 0, '成交量额同步归零（下一根 K 线从零开始）');

  m.settleDay(20000, { day: 3 });
  assert(m.dailyBars.length === 1, '同一天重复结算只覆盖、不追加第二根');
  m.settleDay(30000, { day: 4 });
  assert(m.dailyBars.length === 2 && m.dailyBars[1].day === 4, '下一天追加第二根');
}

console.log('\n[3] 补结算防护：分时末点不属于被结算那天时不落 K 线');
{
  const dc = new DayCycle(config.day, 0);
  const { m } = fresh(dc);
  // 末点停在第 1 天（开盘竞价里）
  m.priceHistory.push({ t: 1000, price: 20, vol: 0 });
  m.settleDay(2000, { day: 1 });
  assert(m.dailyBars.length === 1 && m.dailyBars[0].day === 1, '末点落在第 1 天 → 记下第 1 天这根');
  // 停机数天后再结算「昨天」：open/高/低/量还是停机前那天的，记下来会多出一根重复 K 线
  m.settleDay(dc.dayMs + 2000, { day: 2 });
  assert(m.dailyBars.length === 1, '末点仍停在第 1 天 → 第 2 天这根不记（补结算不伪造 K 线）');

  const m2 = fresh(dc).m;
  m2.priceHistory.push({ t: 1500, price: 20, vol: 0 });
  m2.settleDay(1800); // 不显式给 day
  assert(m2.dailyBars.length === 1 && m2.dailyBars[0].day === 1, '缺省 day 时按交易日时钟推（第 1 天）');
}

console.log('\n[4] 大盘指数：资金流与日线 = 成分股合计');
{
  const g = new Game();
  g.start();
  g.day.reanchor(Date.now() - 120000); // 锚进上午连续竞价
  for (let i = 0; i < 3; i++) g.tick();
  const stocks = g.stocks.map((s) => g.markets.get(s.id));
  const sum = (fn) => stocks.reduce((s, m) => s + fn(m), 0);

  assert(g.index.volume === sum((m) => m.volume), `指数成交量 = 各股合计（${g.index.volume}）`);
  assert(g.index.outerVol === sum((m) => m.outerVol) && g.index.innerVol === sum((m) => m.innerVol), '指数内外盘 = 各股合计');
  assert(g.index.outerVol + g.index.innerVol === g.index.volume, '指数也满足「外盘+内盘 == 成交量」');
  const inst = g.index.snapshot().flow;
  assert(inst.outerVol + inst.innerVol > 0, `指数当日有成交（${inst.outerVol + inst.innerVol} 股）`);

  const st = g.day.locate(Date.now());
  // 结算发生在「收盘竞价 → 夜间」的那一刻：把时钟与分时末点都放在第 1 天夜间再结
  const nightAt = g.day.startAt + (st.day - 1) * g.day.dayMs + 590000;
  for (const m of g.markets.values()) m.priceHistory.push({ t: nightAt, price: m.lastPrice, vol: m.volume });
  g.settleDay(nightAt, { meta: false });
  assert(g.index.dailyBars.length === 1 && g.index.dailyBars[0].day === st.day, '指数也定格一根日线');
  const ib = g.index.dailyBars[0];
  const sb = (k) => stocks.reduce((s, m) => s + (m.dailyBars[0] ? m.dailyBars[0][k] : 0), 0);
  assert(stocks.every((m) => m.dailyBars.length === 1), '每只股票各定格一根日线');
  assert(ib.volume > 0 && ib.volume === sb('volume'), `指数日线量 = 各股日线量之和，且不是 0（${ib.volume}）`);
  assert(near(ib.turnover, sb('turnover'), 1), `指数日线额 = 各股之和（${ib.turnover} / ${sb('turnover')}）`);
  assert(near(ib.net, sb('net'), 1), `指数日线净流入 = 各股之和（${ib.net} / ${sb('net')}）`);
  assert(ib.outerAmt + ib.innerAmt > 0, '指数日线带内外盘额（成分股清零前先重算）');
  // 结算后指数当日累计随成分股一起清零
  assert(g.index.outerVol === 0 && g.index.innerVol === 0, '结算后指数当日内外盘清零');
  assert(g.index.volume === 0, '结算后指数成交量清零');
  g.stop();
}

console.log('\n[5] 落盘往返：当日内外盘与已收盘日线都能续上');
{
  const FILE = path.join(os.tmpdir(), `gushen-flow-test-${process.pid}.db`);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE + s, { force: true });

  const p1 = new Persister(FILE);
  const g1 = new Game({ persist: p1 });
  g1.start();
  g1.day.reanchor(Date.now() - 120000);
  for (let i = 0; i < 3; i++) g1.tick();
  const before = {
    outerVol: P(g1).outerVol,
    innerVol: P(g1).innerVol,
    outerAmt: P(g1).outerAmt,
    innerAmt: P(g1).innerAmt,
    idxOuter: g1.index.outerVol,
  };
  assert(before.outerVol + before.innerVol > 0, `重启前当日有内外盘累计（${before.outerVol}/${before.innerVol}）`);
  const st = g1.day.locate(Date.now());
  const nightAt = g1.day.startAt + (st.day - 1) * g1.day.dayMs + 590000;
  for (const m of g1.markets.values()) m.priceHistory.push({ t: nightAt, price: m.lastPrice, vol: m.volume });
  g1.settleDay(nightAt, { meta: true });
  const barBefore = JSON.parse(JSON.stringify(P(g1).dailyBars));
  const idxBarBefore = JSON.parse(JSON.stringify(g1.index.dailyBars));
  // 结算发生在 tick 之间，手动补一次落盘（日线与行情同在一个事务里写）
  g1.persist.commit({ now: Date.now(), markets: [...g1.markets.values()], allAccounts: g1.store.all() });
  g1.stop();
  p1.close();

  const p2 = new Persister(FILE);
  const g2 = new Game({ persist: p2 });
  g2.start();
  assert(JSON.stringify(P(g2).dailyBars) === JSON.stringify(barBefore), `个股日线原样恢复（${P(g2).dailyBars.length} 根）`);
  assert(JSON.stringify(g2.index.dailyBars) === JSON.stringify(idxBarBefore), '指数日线原样恢复');
  assert(P(g2).dailyBars[0].volume === barBefore[0].volume && P(g2).dailyBars[0].net === barBefore[0].net, '日线量额与净流入逐字段一致');
  // 当日累计在结算时已清零，重启后仍是 0（不能把上一整天的内外盘又捞回来）
  assert(P(g2).outerVol === 0 && P(g2).innerVol === 0, '结算后的当日累计重启后仍为 0');
  assert(g2.index.outerVol === 0, '指数当日累计重启后仍为 0');

  g2.stop();
  p2.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE + s, { force: true });
}

console.log('\n[6] dailyFor：升序、条数上限、指数可用、未知标的被拒');
{
  const g = new Game();
  g.start();
  g.day.reanchor(Date.now() - 120000);
  g.tick();
  // 连造 5 个交易日：每天先把分时末点挪进当天的夜间，再让时钟跨到次日结算
  // （真实流程就是「收盘竞价 → 夜间」那一刻结算，末点属于被结算的那一天）
  for (let d = 1; d <= 5; d++) {
    const base = g.day.startAt + (d - 1) * g.day.dayMs;
    for (const m of g.markets.values()) m.priceHistory.push({ t: base + 590000, price: m.lastPrice, vol: m.volume });
    g.settleDay(base + g.day.dayMs + 1000, { day: d });
  }
  const r = g.dailyFor(ID);
  assert(r.ok && r.bars.length === 5, `返回 5 根日线（${r.bars.length}）`);
  assert(r.bars.every((b, i, a) => i === 0 || b.day > a[i - 1].day), '按交易日升序返回');
  const lim = g.dailyFor(ID, 2);
  assert(lim.bars.length === 2 && lim.bars[1].day === 5, `limit 取最近 N 根（末根第 ${lim.bars[1].day} 天）`);
  assert(lim.bars.map((b) => b.day).join(',') === '4,5', `limit 取的是最后两根（${lim.bars.map((b) => b.day).join(',')}）`);
  assert(g.dailyFor(INDEX_ID).bars.length === 5, '指数也能取日线');
  assert(g.dailyFor('000000').ok === false, '未知标的被拒');
  assert(g.dailyFor(ID).today === g.day.locate(Date.now()).day, `today 下发当前交易日号（${g.dailyFor(ID).today}）`);
  assert(g.dailyFor(ID, 9999).bars.length === 5, 'limit 超上限时按实际根数返回');
  g.stop();
}

console.log('\n[7] 存档版本：v8 及更早一律拒启（9 的迁移缺席），v9 老档原地升到 10');
{
  assert(SCHEMA_VERSION === 10, `存档表结构版本为 10（实际 ${SCHEMA_VERSION}）`);
  const FILE = path.join(os.tmpdir(), `gushen-flow-old-${process.pid}.db`);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE + s, { force: true });
  const db = new Database(FILE);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '2')").run();
  db.close();
  let msg = '';
  try {
    openDatabase(FILE);
  } catch (e) {
    msg = e.message;
  }
  assert(/表结构版本为 2/.test(msg), `版本 2 的旧档被明确拒绝：${msg.slice(0, 40)}…`);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE + s, { force: true });

  // 版本 9 的老档**原地升级**到 10：market_state 补出 closed_day 列（NULL = 尚未结算过）。
  // v9 本身因为「NPC 改真名」没有迁移语句——它之前的 3~8 老档仍然只能拒启
  const FILE9 = path.join(os.tmpdir(), `gushen-flow-v9-${process.pid}.db`);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE9 + s, { force: true });
  const db9 = new Database(FILE9);
  db9.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE market_state (
      stock_id TEXT PRIMARY KEY, last_price REAL NOT NULL, prev_close REAL NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
      volume INTEGER NOT NULL, turnover REAL NOT NULL, short_interest INTEGER NOT NULL,
      order_seq INTEGER NOT NULL, trade_seq INTEGER NOT NULL,
      outer_vol INTEGER NOT NULL DEFAULT 0, outer_amt REAL NOT NULL DEFAULT 0,
      inner_vol INTEGER NOT NULL DEFAULT 0, inner_amt REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  db9.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '9')").run();
  db9.close();
  const db10 = openDatabase(FILE9);
  const v9cols = db10.prepare('PRAGMA table_info(market_state)').all().map((c) => c.name);
  assert(v9cols.includes('closed_day'), '版本 9 → 10 补出了 market_state.closed_day 列');
  const ver = db10.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert(Number(ver.value) === 10, `升级后版本号写成 10（实际 ${ver.value}）`);
  db10.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE9 + s, { force: true });

  // 版本 3 的老档**同样被拒**：v9（NPC 真实身份）故意没有 8 → 9 的迁移语句，
  // 所以 3~8 的任何老档都走不到"逐级升级"那条路，提示里会给出要删的具体文件。
  // 这一条留着是为了守住「拒启必须是明确报错，而不是半截迁移后的诡异状态」。
  const FILE3 = path.join(os.tmpdir(), `gushen-flow-v3-${process.pid}.db`);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE3 + s, { force: true });
  const db3 = new Database(FILE3);
  db3.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE accounts (
      name TEXT PRIMARY KEY, is_npc INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL,
      cash REAL NOT NULL, order_frozen REAL NOT NULL DEFAULT 0, short_margin REAL NOT NULL DEFAULT 0,
      realized_pnl REAL NOT NULL DEFAULT 0, initial_long INTEGER NOT NULL DEFAULT 0,
      last_order_at INTEGER, created_at INTEGER NOT NULL, deposited REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY, account TEXT NOT NULL, role TEXT NOT NULL, order_id TEXT NOT NULL,
      stock_id TEXT NOT NULL, action TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL,
      qty INTEGER NOT NULL, fee REAL NOT NULL DEFAULT 0, trade_seq INTEGER NOT NULL, t INTEGER NOT NULL
    );
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
  db3.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3')").run();
  db3.prepare(
    'INSERT INTO accounts (name, role, cash, created_at, realized_pnl) VALUES (?,?,?,?,?)'
  ).run('老玩家', 'player', 123456, 1, 0);
  db3.close();
  let upMsg = '';
  let db4 = null;
  try {
    db4 = openDatabase(FILE3);
  } catch (e) {
    upMsg = e.message;
  }
  assert(
    !!upMsg && /表结构版本为 3/.test(upMsg) && /删掉这三个文件/.test(upMsg),
    `版本 3 的旧档被明确拒绝并给出删档路径：${upMsg.slice(0, 46)}…`
  );
  if (db4) {
    const v = db4.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    assert(Number(v.value) === SCHEMA_VERSION, `升级后版本号写成 ${SCHEMA_VERSION}（实际 ${v.value}）`);
    const keyTable = db4
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'")
      .get();
    assert(!!keyTable, '版本 6 → 7 补出了 api_keys 表');
    // 版本 7 → 8：做空利息「当日已累计、还没结算」那一列要补出来（默认 0）
    const ledCols = db4.prepare('PRAGMA table_info(stock_ledger)').all().map((c) => c.name);
    assert(ledCols.includes('lend_interest_accrued'), '版本 7 → 8 补出了 lend_interest_accrued 列');
    const row = db4.prepare('SELECT * FROM accounts WHERE name = ?').get('老玩家');
    assert(row && row.cash === 123456, '升级保留了原有账户数据');
    assert(row.broker === null, '老账号的 broker 为 NULL（表示还没选过券商）');
    assert(row.milestones === null, '老账号的 milestones 为 NULL（由登录/恢复时按当前权益初始化）');
    // 昵称列升级后为 NULL = 「还没开完户」：老账号下次登录会被要求补昵称 + 选券商（§3.2）
    assert(row.nick === null, '老账号的 nick 为 NULL（登录时补填昵称）');
    db4.close();
  }
  for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE3 + s, { force: true });
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
