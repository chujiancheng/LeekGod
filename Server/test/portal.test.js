/**
 * 开放平台页（/portal.html）后端测试：node test/portal.test.js
 *
 * 验的是「玩家自己在网页上管 Key」这条链路的边界：
 *   ① 必须登录（会话令牌），无 token 一律 401
 *   ② 只能看/撤销自己账号的 Key（别人的 KeyID 按"不存在"回）
 *   ③ 明文只在生成时出现一次，列表里没有 secret
 *   ④ 生成出来就能用；撤销立即失效
 *   ⑤ 8 把上限、未开户拦截
 *   ⑥ 页面本身在静态白名单里（漏注册会 404）
 *   ⑦ 文档在线阅读 / 下载（白名单 /docs/*.md，?download=1 附件）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NPC_LLM = '0';

const config = require('../src/config');
config.priceLimit.enabled = false;
config.open.rateLimit.enabled = false;
config.http.rateLimit.enabled = false;
config.npc.llm.enabled = false;

const { Game } = require('../src/game');
const { createServer } = require('../src/http');
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

const tmp = path.join(os.tmpdir(), `gushen-portal-${process.pid}.db`);
const rmDb = () => {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(tmp + s, { force: true });
};
rmDb();

const persist = new Persister(tmp);
const g = new Game({ persist });
const BROKER = Object.keys(config.brokers.list)[0];

g.day.reanchor(Date.now() - 120000);
for (const s of config.stocks) {
  g.npcs.get(s.id).init(g.startedAt);
  g.markets.get(s.id).priceHistory.push({ t: g.startedAt, price: g.markets.get(s.id).lastPrice });
}
g.index.update(g.markets, g.startedAt);

const server = createServer(g);
let base = '';

const api = async (method, p, { token, body } = {}) => {
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + p, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  return { status: res.status, data };
};

/** 用某把 Key 调 /open/v1/ping */
const pingWith = async (key) => {
  const res = await fetch(`${base}/open/v1/ping`, { headers: { 'X-API-Key': key } });
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

  const A = g.onboard('portal_a', '门户甲', BROKER);
  const B = g.onboard('portal_b', '门户乙', BROKER);
  assert(A.ok && B.ok, '两个玩家建号成功');

  // ============================================================
  console.log('\n[1] 必须登录');
  let r = await api('GET', '/api/open/keys');
  assert(r.status === 401, '无 token 查列表 → 401');
  r = await api('POST', '/api/open/keys', { body: { label: 'x' } });
  assert(r.status === 401, '无 token 生成 → 401');
  r = await api('DELETE', '/api/open/keys/whatever', { body: {} });
  assert(r.status === 401, '无 token 撤销 → 401');

  // ============================================================
  console.log('\n[2] 生成与列表');
  r = await api('POST', '/api/open/keys', {
    token: A.token,
    body: { label: '家用电脑-双均线', scopes: 'read,trade' },
  });
  assert(r.status === 200 && r.data.ok, '登录后可以生成 Key');
  const KEY_A = r.data.key;
  const ID_A = r.data.id;
  assert(/^gs_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/.test(KEY_A), '返回 gs_<id>_<secret>');
  assert(r.data.account === 'portal_a', 'Key 绑到当前登录账号');
  assert(r.data.scopes === 'read,trade', '权限按选择生效');

  const row = persist.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(ID_A);
  assert(!!row && row.secret_hash.length === 64, '库里只有 64 位 sha256');
  assert(!JSON.stringify(row).includes(KEY_A.split('_')[2]), '明文 secret 不落库');

  r = await api('GET', '/api/open/keys', { token: A.token });
  assert(r.status === 200 && r.data.cap === config.open.maxKeysPerAccount, '列表返回每账号上限');
  const listed = r.data.keys.find((k) => k.id === ID_A);
  assert(!!listed && listed.label === '家用电脑-双均线', '列表能看到自己的 Key 与备注');
  assert(!JSON.stringify(r.data).includes(KEY_A.split('_')[2]), '列表不含明文 secret');
  assert(!JSON.stringify(r.data).includes('secret_hash'), '列表不含哈希字段');

  // 只读 Key
  r = await api('POST', '/api/open/keys', { token: A.token, body: { label: '只读', scopes: 'read' } });
  assert(r.status === 200 && r.data.scopes === 'read', '可以生成只读 Key');
  const KEY_READ = r.data.key;
  const order = await fetch(`${base}/open/v1/orders`, {
    method: 'POST',
    headers: { 'X-API-Key': KEY_READ, 'Content-Type': 'application/json' },
    body: JSON.stringify({ stockId: config.stocks[0].id, action: 'buy_open', qty: 100, price: 1 }),
  });
  assert(order.status === 403, '只读 Key 下单 → 403');

  // ============================================================
  console.log('\n[3] 生成出来就能用');
  let p = await pingWith(KEY_A);
  assert(p.status === 200 && p.data.account === 'portal_a', '新 Key 直接能调 /open/v1/ping');
  const sess = await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${KEY_A}` } });
  assert(sess.status === 401, 'Key 仍然打不开 /api/state（两条链路互不认）');

  // ============================================================
  console.log('\n[4] 越权：只能碰自己的 Key');
  r = await api('GET', '/api/open/keys', { token: B.token });
  assert(r.status === 200 && r.data.keys.length === 0, 'B 看不到 A 的 Key');
  r = await api('DELETE', '/api/open/keys/' + ID_A, { token: B.token, body: {} });
  assert(r.status === 404, 'B 撤销 A 的 Key → 404（不暴露 KeyID 是否存在）');
  p = await pingWith(KEY_A);
  assert(p.status === 200, 'A 的 Key 没被 B 撤销');

  // ============================================================
  console.log('\n[5] 撤销自己的 Key');
  r = await api('DELETE', '/api/open/keys/' + ID_A, { token: A.token, body: {} });
  assert(r.status === 200 && r.data.ok, 'A 撤销自己的 Key 成功');
  p = await pingWith(KEY_A);
  assert(p.status === 401, '撤销后立即 401');
  r = await api('DELETE', '/api/open/keys/' + ID_A, { token: A.token, body: {} });
  assert(r.status === 404, '重复撤销 → 404');
  r = await api('GET', '/api/open/keys', { token: A.token });
  assert(!r.data.keys.some((k) => k.id === ID_A && !k.revoked), '撤销后的 Key 不再算有效');

  // ============================================================
  console.log('\n[6] 上限与开户状态');
  const cap = config.open.maxKeysPerAccount;
  const before = g.store.get('portal_b');
  const exist = server.openApi.keys.countFor('portal_b');
  for (let i = exist; i < cap; i += 1) {
    r = await api('POST', '/api/open/keys', { token: B.token, body: { label: 'bulk-' + i } });
  }
  assert(server.openApi.keys.countFor('portal_b') === cap, `B 已占满 ${cap} 把`);
  r = await api('POST', '/api/open/keys', { token: B.token, body: { label: 'overflow' } });
  assert(r.status === 400 && /最多/.test(r.data.error), '第 9 把被拒（400 + 上限提示）');

  const C = g.onboard('portal_c', '门户丙', BROKER);
  assert(C.ok, '第三个玩家建号成功');
  const accC = g.store.get('portal_c');
  const brokerBackup = accC.broker;
  accC.broker = null; // 模拟"没选券商 = 没开完户"
  r = await api('POST', '/api/open/keys', { token: C.token, body: { label: 'nope' } });
  assert(r.status === 400 && /开户/.test(r.data.error), '未开户账号生成被拒（400 + 开户提示）');
  accC.broker = brokerBackup;
  assert(before, 'B 账号对象可读');

  // ============================================================
  console.log('\n[7] 页面本身可访问');
  let res = await fetch(base + '/portal.html');
  assert(res.status === 200 && /text\/html/.test(res.headers.get('content-type') || ''), 'GET /portal.html 返回 HTML');
  const html = await res.text();
  assert(html.includes('/portal.js') && html.includes('/portal.css'), '页面引用了自己的 js/css');
  assert(html.includes('/docs.html') && html.includes('/docs/'), '主页入口链到文档阅读页与下载');
  res = await fetch(base + '/portal.js');
  assert(res.status === 200 && /javascript/.test(res.headers.get('content-type') || ''), 'GET /portal.js 可访问');
  res = await fetch(base + '/portal.css');
  assert(res.status === 200 && /text\/css/.test(res.headers.get('content-type') || ''), 'GET /portal.css 可访问');

  // ============================================================
  console.log('\n[8] 文档在线阅读 / 下载');
  res = await fetch(base + '/docs.html');
  assert(res.status === 200 && /text\/html/.test(res.headers.get('content-type') || ''), 'GET /docs.html 返回 HTML');
  const docsHtml = await res.text();
  assert(docsHtml.includes('/docs.js') && docsHtml.includes('/docs.css'), '阅读页引用自己的 js/css');
  res = await fetch(base + '/docs.js');
  assert(res.status === 200, 'GET /docs.js 可访问');
  res = await fetch(base + '/docs.css');
  assert(res.status === 200, 'GET /docs.css 可访问');

  res = await fetch(base + '/docs/player-apikey.md');
  assert(res.status === 200 && /markdown/.test(res.headers.get('content-type') || ''), '玩家入门 .md 可在线读');
  assert(!res.headers.get('content-disposition'), '不带 download 时是阅读而不是强制下载');
  const playerMd = await res.text();
  assert(playerMd.indexOf('开放平台') >= 0 && playerMd.length > 500, '入门文档内容非空');

  res = await fetch(base + '/docs/openapi.md');
  assert(res.status === 200 && /markdown/.test(res.headers.get('content-type') || ''), 'API 手册 .md 可在线读');
  const apiMd = await res.text();
  assert(apiMd.indexOf('/open/v1') >= 0 && apiMd.length > 500, 'API 手册内容非空');

  res = await fetch(base + '/docs/player-apikey.md?download=1');
  const cd = res.headers.get('content-disposition') || '';
  assert(res.status === 200 && /attachment/.test(cd) && /gushen-apikey-guide/.test(cd), '?download=1 走附件下载');

  res = await fetch(base + '/docs/openapi.md?download=1');
  const cd2 = res.headers.get('content-disposition') || '';
  assert(res.status === 200 && /attachment/.test(cd2) && /gushen-openapi-v1/.test(cd2), 'API 手册也可下载');

  res = await fetch(base + '/docs/secret.md');
  assert(res.status === 404, '白名单外的文档路径 404');

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
