/**
 * 开放交易接口测试：node test/openapi.test.js
 *
 * 验的是「这层壳不破坏内核」：
 *   ① Key 体系（签发 / 校验 / 撤销 / scopes / 明文不落库）
 *   ② 两条鉴权链路互不认对方凭据（会话令牌打不开 /open，Key 打不开 /api）
 *   ③ 下单与手动下单同一条路径（冷却、整手、同股多空互斥照罚）
 *   ④ 幂等：同 clientOrderId 只成交一次；**失败不缓存**（冷却过去后重试能成功）；同 cid 换参 → 409
 *   ⑤ 内幕字段不出圈（fairValue / force / intent / regime / llmPlan / cycleDir 一律不在响应里）
 *   ⑥ 成交游标是序号不是时间戳
 *   ⑦ 存档版本 8（stock_ledger 的 lend_interest_accrued 列）
 *   ⑧ 撤销 Key 会掐掉已建立的 SSE
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// 大模型主力脑只在特定阶段触发，但测试里一律关掉（不必为一次 HTTP 用例付 LLM 的钱）
process.env.NPC_LLM = '0';

const config = require('../src/config');
config.priceLimit.enabled = false;
config.open.rateLimit.enabled = false; // 用例连发请求，别被自己的限流拦住
config.npc.llm.enabled = false;

const { Game } = require('../src/game');
const { createServer } = require('../src/http');
const { Persister } = require('../src/persist');
const { SCHEMA_VERSION } = require('../src/db');

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

const tmp = path.join(os.tmpdir(), `gushen-open-${process.pid}.db`);
const rmDb = () => {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(tmp + s, { force: true });
};
rmDb();

const persist = new Persister(tmp);
const g = new Game({ persist });
const STOCK = config.stocks[0];
const BROKER = Object.keys(config.brokers.list)[0];

// 与 game.test.js 同口径：不启 setInterval，手动建 NPC 池 + 锚到连续竞价段
g.day.reanchor(Date.now() - 120000);
for (const s of config.stocks) {
  g.npcs.get(s.id).init(g.startedAt);
  g.markets.get(s.id).priceHistory.push({ t: g.startedAt, price: g.markets.get(s.id).lastPrice });
}
g.index.update(g.markets, g.startedAt);

const server = createServer(g);
let base = '';
const keys = server.openApi.keys;

const api = async (method, p, { key, body, headers } = {}) => {
  const h = Object.assign({}, headers);
  if (key) h['X-API-Key'] = key;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  return { status: res.status, data };
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // ============================================================
  console.log('\n[1] Key 体系');
  const ob = g.onboard('quant_a', '量化甲', BROKER);
  assert(ob.ok, '玩家建号成功');
  const issued = keys.issue('quant_a', { label: '网格', scopes: 'read,trade' });
  assert(issued.ok && /^gs_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/.test(issued.key), 'Key 形如 gs_<id>_<secret>');
  const KEY = issued.key;
  const row = persist.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(issued.id);
  assert(!!row && row.secret_hash.length === 64, '库里只有 64 位 sha256，不存明文');
  assert(!JSON.stringify(row).includes(issued.key.split('_')[2]), '明文 secret 没有落库');

  const readOnly = keys.issue('quant_a', { scopes: 'read' });
  assert(readOnly.ok && readOnly.scopes === 'read', '可以只发 read 权限的 Key');

  // ============================================================
  console.log('\n[2] 鉴权边界');
  let r = await api('GET', '/open/v1/ping');
  assert(r.status === 401, '不带 Key → 401');
  r = await api('GET', '/open/v1/ping', { key: 'gs_deadbeef_aaaaaaaaaaaaaaaaaaaaaaaa' });
  assert(r.status === 401, '不存在的 Key → 401');
  r = await api('GET', '/open/v1/health');
  assert(r.status === 200 && r.data.ok, 'health 免鉴权可用');

  // 会话令牌不能当 Key 用
  r = await api('GET', '/open/v1/ping', { key: ob.token });
  assert(r.status === 401, '会话令牌打不开 /open/v1');
  // Key 也不能当会话令牌用
  const sess = await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${KEY}` } });
  assert(sess.status === 401, 'API Key 打不开 /api/state（两条链路互不认）');

  r = await api('GET', '/open/v1/ping', { key: KEY });
  assert(r.status === 200 && r.data.account === 'quant_a', 'ping 返回绑定的账号');

  // scope
  r = await api('POST', '/open/v1/orders', {
    key: readOnly.key,
    body: { stockId: STOCK.id, action: 'buy_open', qty: STOCK.lotSize, price: g.priceOf(STOCK.id) },
  });
  assert(r.status === 403, 'read-only Key 下单 → 403');

  // ============================================================
  console.log('\n[3] 行情视图不含内幕');
  r = await api('GET', '/open/v1/markets', { key: KEY });
  assert(r.status === 200 && r.data.markets.length === config.stocks.length, '返回全部 10 只股票');
  const raw = JSON.stringify(r.data);
  for (const secret of ['fairValue', 'fair', 'force', 'regime', 'intent', 'llmPlan', 'fund', 'sentiment', 'cycleDir', 'cycleLog', 'cycleDrift']) {
    assert(!raw.includes(`"${secret}"`), `不含内幕字段 ${secret}`);
  }
  assert(r.data.markets[0].depth.bids.length <= config.open.maxDepth, '五档按 maxDepth 裁剪');
  const lean = await api('GET', '/open/v1/markets?depth=0&trades=0', { key: KEY });
  assert(lean.data.markets[0].depth === null && lean.data.markets[0].trades === null, 'depth=0&trades=0 可裁到最瘦');

  // ============================================================
  console.log('\n[4] 下单走同一内核');
  const acc = g.store.get('quant_a');
  const last = g.priceOf(STOCK.id);
  acc.lastOrderAt = null;
  r = await api('POST', '/open/v1/orders', {
    key: KEY,
    body: { stockId: STOCK.id, action: 'buy_open', qty: STOCK.lotSize, price: last, clientOrderId: 'grid-1' },
  });
  assert(r.status === 200 && r.data.ok, `下单成功（${r.data.order && r.data.order.id}）`);
  const firstOrderId = r.data.order && r.data.order.id;
  assert(typeof r.data.cooldownLeftMs === 'number', '回包带 cooldownLeftMs');

  // 缺 stockId 不允许静默落到第一只股票：脚本下错标的比 400 危险得多
  r = await api('POST', '/open/v1/orders', {
    key: KEY,
    body: { action: 'buy_open', qty: STOCK.lotSize, price: last, clientOrderId: 'no-stock' },
  });
  assert(r.status === 400 && r.data.code === 'bad_request' && /stockId/.test(r.data.error), '缺 stockId 直接 400');

  // 冷却照罚
  r = await api('POST', '/open/v1/orders', {
    key: KEY,
    body: { stockId: STOCK.id, action: 'buy_open', qty: STOCK.lotSize, price: last, clientOrderId: 'grid-2' },
  });
  assert(r.status === 400 && /频繁|冷却/.test(r.data.error), `冷却生效（${r.data.error}）`);

  // 整手照罚
  acc.lastOrderAt = null;
  r = await api('POST', '/open/v1/orders', {
    key: KEY,
    body: { stockId: STOCK.id, action: 'buy_open', qty: 1, price: last, clientOrderId: 'odd-1' },
  });
  assert(r.status === 400, `非整手被拒（${r.data.error}）`);

  // 指数照罚
  acc.lastOrderAt = null;
  r = await api('POST', '/open/v1/orders', {
    key: KEY,
    body: { stockId: g.index.stockId, action: 'buy_open', qty: 100, price: 1000, clientOrderId: 'idx-1' },
  });
  assert(r.status === 400 && /指数/.test(r.data.error), '指数不可交易');

  // ============================================================
  console.log('\n[5] 幂等');
  // 冷却中重发同一 cid：命中缓存，直接回放首次成功结果
  r = await api('POST', '/open/v1/orders', {
    key: KEY,
    body: { stockId: STOCK.id, action: 'buy_open', qty: STOCK.lotSize, price: last, clientOrderId: 'grid-1' },
  });
  assert(r.status === 200 && r.data.replayed === true, '同 clientOrderId 命中幂等缓存（replayed）');
  assert(r.data.order.id === firstOrderId, '回放的是同一张委托，没有重复下单');

  // 失败不入缓存：冷却过去后同一个 cid 能真正下出去
  acc.lastOrderAt = null;
  r = await api('POST', '/open/v1/orders', {
    key: KEY,
    body: { stockId: STOCK.id, action: 'buy_open', qty: STOCK.lotSize, price: last, clientOrderId: 'grid-2' },
  });
  assert(r.status === 200 && !r.data.replayed, '失败过的 cid 不被缓存，冷却后重试成功');

  // 同 cid 换参数：拒绝而不是静默回放
  r = await api('POST', '/open/v1/orders', {
    key: KEY,
    body: {
      stockId: config.stocks[1].id,
      action: 'buy_open',
      qty: STOCK.lotSize,
      price: last,
      clientOrderId: 'grid-1',
    },
  });
  assert(r.status === 409 && r.data.code === 'idempotency_conflict', '同 cid 换参数 → 409');

  // ============================================================
  console.log('\n[6] 账户与委托');
  r = await api('GET', '/open/v1/account', { key: KEY });
  assert(r.status === 200 && r.data.name === 'quant_a', 'account 返回本账户');
  assert(typeof r.data.equity === 'number' && Array.isArray(r.data.positions), '含权益与持仓');

  r = await api('GET', '/open/v1/orders?status=live', { key: KEY });
  assert(r.status === 200 && r.data.orders.length >= 1, `在途委托 ${r.data.orders.length} 张`);

  r = await api('GET', '/open/v1/orders?status=all', { key: KEY });
  assert(r.status === 200 && Array.isArray(r.data.orders), 'status=all 可用');

  // ============================================================
  console.log('\n[7] 成交游标');
  for (let i = 0; i < 40; i += 1) g.tick(); // 让盘口有机会吃到我们的单
  r = await api('GET', '/open/v1/fills', { key: KEY });
  assert(r.status === 200 && Array.isArray(r.data.fills), 'fills 可用');
  const fills = r.data.fills;
  if (fills.length) {
    assert(fills.every((f) => Number.isFinite(f.seq) && f.seq > 0), '每笔成交都带正整数 seq');
    const cursor = fills[fills.length - 1].seq;
    const next = await api('GET', `/open/v1/fills?since=${cursor}`, { key: KEY });
    assert(next.data.fills.every((f) => f.seq > cursor), 'since 只回更新的成交');
  } else {
    assert(true, '暂无成交（挂单未成交），跳过游标断言');
  }

  // ============================================================
  console.log('\n[8] 撤单与撤销 Key');
  const live = (await api('GET', '/open/v1/orders?status=live', { key: KEY })).data.orders;
  if (live.length) {
    r = await api('DELETE', `/open/v1/orders/${live[0].id}`, { key: KEY });
    assert(r.status === 200 && r.data.ok, '撤单成功');
  } else {
    assert(true, '没有在途委托，跳过');
  }

  r = await api('GET', '/open/v1', { key: KEY });
  assert(r.status === 200 && r.data.endpoints.length > 5, 'GET /open/v1 给出能力目录');
  assert(r.data.endpoints.some((e) => /\/open\/v1\/ping/.test(e)), '能力目录含 /open/v1/ping');

  assert(keys.revoke(readOnly.id).ok, '撤销 read-only Key');
  r = await api('GET', '/open/v1/ping', { key: readOnly.key });
  assert(r.status === 401, '撤销后立即失效');

  // 撤销 Key 时已建立的 SSE 必须断掉，否则市场数据会继续往外漏
  const httpMod = require('http');
  const sseKey = keys.issue('quant_a', { label: 'sse', scopes: 'read' });
  assert(sseKey.ok, '签发 SSE 测试用 Key');
  const { statusCode: sseStatus, closedBy } = await new Promise((resolve) => {
    const u = new URL(`${base}/open/v1/stream?depth=0&trades=0`);
    let code = 0;
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      resolve({ statusCode: code, closedBy: why });
    };
    const req = httpMod.get(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'X-API-Key': sseKey.key } },
      (sres) => {
        code = sres.statusCode;
        sres.on('close', () => finish('close'));
        sres.on('end', () => finish('end'));
        sres.on('error', () => finish('error'));
        setTimeout(() => {
          assert(keys.revoke(sseKey.id).ok, '撤销带 SSE 的 Key');
        }, 30);
      }
    );
    req.on('error', () => finish('error'));
    setTimeout(() => finish('timeout'), 2000);
  });
  assert(sseStatus === 200, 'SSE 建连成功');
  // destroy 掉 socket 后客户端可能是 close/end/error——只要不是一直挂着（timeout）就算掐断
  assert(closedBy === 'close' || closedBy === 'end' || closedBy === 'error', `撤销后 SSE 被服务端断开（${closedBy}）`);

  // ============================================================
  console.log('\n[9] 存档版本');
  const v = Number(persist.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value);
  // 跟着 SCHEMA_VERSION 走：13 = 每日收盘资产快照表 daily_assets（主页「资产轨迹」卡）
  assert(v === 13 && SCHEMA_VERSION === 13, `schema 版本 13（${v}）`);
  const table = persist.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'").get();
  assert(!!table, 'api_keys 表已建');

  // ============================================================
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  server.close();
  g.stop();
  persist.close();
  rmDb();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try {
    server.close();
    g.stop();
    persist.close();
  } catch (err) {}
  rmDb();
  process.exit(1);
});
