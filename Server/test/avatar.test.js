/**
 * 头像（脸面）测试：node test/avatar.test.js
 *
 * 覆盖 Doc/头像方案.md §11 的服务端清单：
 *   ① 目录校验（key 唯一/格式/分组非空/broker·realm·egg 的 value 都能查到）
 *   ② 启动校验（配错 → require 抛错，不是运行时裂图）
 *   ③ 默认派生：同账号稳定、1000 个账号不塌桶
 *   ④ `ava:` 前缀确实生效（与券商标签无相关性）
 *   ⑤ 解锁：base 恒真 / broker 看 broker_seen（转户后仍在）/ realm 看 peakEquity（跌境后仍在）/ egg 看 fired
 *   ⑥ POST 三态：未知 key 400 / 未解锁 403（带 unlock 文案）/ 相同值不写库
 *   ⑦ NPC：派生稳定、写库 NULL、不 touch
 *   ⑧ 关掉彩蛋 / 境界 → 对应组整组不下发
 *   ⑨ 老档（avatar=NULL）序列化正常、players[].ava 非空
 *   ⑩ rules.avatars 只在首帧出现，lite 帧只有 {enabled}
 *
 * 与其它服务端测试同口径：关掉涨跌停（用例按盘口打价是常态）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
config.priceLimit.enabled = false;

const avatar = require('../src/avatar');
const realm = require('../src/realm');
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

const tmpFile = (tag) => path.join(os.tmpdir(), `gushen-avatar-${tag}-${process.pid}.db`);
const rmDb = (f) => {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true });
};

// ============================================================
console.log('\n[1] 目录校验：配错了应该在启动时就炸，而不是让玩家看到一张 404 的脸');
{
  const keys = avatar.CATALOG.map((r) => r.key);
  assert(keys.length === 12, `当前目录 12 张（基础组；门派/境界/彩蛋等素材，实际 ${keys.length}）`);
  assert(new Set(keys).size === keys.length, 'key 唯一');
  assert(keys.every((k) => avatar.KEY_RE.test(k)), 'key 全部符合 ^[a-z][a-z0-9-]{1,15}$');
  assert(avatar.BASE.length === 12, `基础组 12 张（实际 ${avatar.BASE.length}）`);
  const groups = new Set(avatar.CATALOG.map((r) => r.group));
  assert(groups.size === 1 && groups.has('base'), '当前只有 base 一组（其余组等素材）');
  // 每张图都得真有文件：漏图是线上 404 裂图的老坑，require 时校验 + 这里再挡一道
  const imgDir = path.join(__dirname, '..', '..', 'Client', 'img');
  const missing = [];
  for (const k of keys) {
    for (const s of ['96', '192']) {
      if (!fs.existsSync(path.join(imgDir, `avatar-${k}-${s}.png`))) missing.push(`avatar-${k}-${s}.png`);
    }
  }
  assert(missing.length === 0, `12 张 × 两档图都在 Client/img（缺：${missing.join(',') || '无'}）`);
}

// ============================================================
console.log('\n[2] 启动校验：故意配错 → require 抛错（而不是运行时静默裂图）');
{
  // 用一个独立进程跑：改配置 + delete require.cache 会把本进程的 config 弄脏
  const { execFileSync } = require('child_process');
  const probe = `
    const config = require('./src/config');
    config.avatar.catalog.push({ key: 'egg-nope', group: 'egg', value: 'Z99', name: '不存在的彩蛋' });
    config.avatar.groups.push({ id: 'egg', label: '彩蛋', hint: '' });
    try { require('./src/avatar'); console.log('NO_THROW'); }
    catch (e) { console.log('THROW:' + e.message); }
  `;
  let out = '';
  try {
    out = execFileSync(process.execPath, ['-e', probe], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  assert(/THROW:.*Z99/.test(out), `指向不存在的彩蛋 id 时 require 直接抛错（${out.trim().slice(0, 60)}）`);

  const dup = `
    const config = require('./src/config');
    config.avatar.catalog.push({ key: 'bull', group: 'base', name: '重复' });
    try { require('./src/avatar'); console.log('NO_THROW'); }
    catch (e) { console.log('THROW:' + e.message); }
  `;
  let out2 = '';
  try {
    out2 = execFileSync(process.execPath, ['-e', dup], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  } catch (e) {
    out2 = String(e.stdout || '') + String(e.stderr || '');
  }
  assert(/THROW:.*重复/.test(out2), 'key 重复时 require 直接抛错');

  // 配了 key 却没图（最典型的新增人脸失误）→ 启动就红，而不是上线后 404 裂图
  const noImg = `
    const config = require('./src/config');
    config.avatar.catalog.push({ key: 'ghost', group: 'base', name: '没画的脸' });
    try { require('./src/avatar'); console.log('NO_THROW'); }
    catch (e) { console.log('THROW:' + e.message.replace(/\\n/g, ' ')); }
  `;
  let out3 = '';
  try {
    out3 = execFileSync(process.execPath, ['-e', noImg], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  } catch (e) {
    out3 = String(e.stdout || '') + String(e.stderr || '');
  }
  assert(/THROW:.*缺图/.test(out3), 'catalog 里有 key 却没有 -96/-192 两档图 → require 抛错（防裂图）');
}

// ============================================================
console.log('\n[3] 默认派生：同账号永远同一张，1000 个账号不塌桶');
{
  const first = avatar.derive('user001');
  assert(first === avatar.derive('user001'), `同账号两次派生一致（${first}）`);
  const buckets = new Map();
  for (let i = 0; i < 1000; i += 1) {
    const k = avatar.derive('npc-' + String(i).padStart(4, '0'));
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  const min = Math.min(...avatar.BASE.map((r) => buckets.get(r.key) || 0));
  const max = Math.max(...avatar.BASE.map((r) => buckets.get(r.key) || 0));
  // 12 桶、1000 次，均匀期望 83；允许 3%~14% 的宽区间，但要挡住"相邻账号塌进一个桶"
  assert(min >= 30 && max <= 140, `1000 个 NPC 账号的分布不塌桶（min ${min} / max ${max}）`);
  assert(buckets.size >= 10, `至少落进 10 个不同桶（实际 ${buckets.size}）`);
}

// ============================================================
console.log('\n[4] `ava:` 前缀生效：默认脸与券商标签不能系统性绑在一起');
{
  // 券商标签是 hash('broker:'+账号) 加权轮盘派生的（broker.allocateNpcBrokers）。
  // 如果默认脸直接吃 hash(账号)，两者会呈现相关性——榜上一眼看出规律。
  // 这里用同一族哈希把账号分成 6 个"门派桶"，看每张脸是不是均匀铺在 6 个桶上
  const identity = require('../src/identity');
  const perFace = new Map();
  for (let i = 0; i < 600; i += 1) {
    const name = 'probe' + i;
    const face = avatar.derive(name);
    const bkBucket = Math.floor(identity.hash('broker:' + name) * 6);
    if (!perFace.has(face)) perFace.set(face, new Set());
    perFace.get(face).add(bkBucket);
  }
  const avg = [...perFace.values()].reduce((a, s) => a + s.size, 0) / perFace.size;
  assert(avg >= 4.5, `每张派生脸都铺到多个"门派桶"上（平均 ${avg.toFixed(1)}/6）——脸与门派解耦`);
}

// ============================================================
console.log('\n[5] broker_seen 的记账语义：只增不减、去重、老档兜底（转户不收回的依据）');
{
  const acc = new Account('seenTester', false, 'player');
  acc.broker = 'zhongxin';
  acc.brokerSeen = [];
  assert(avatar.brokerSeenOf(acc).includes('zhongxin'),
    '老档（broker_seen 为空）当前券商兜底进列——门派脸不会因为升级当天没记录就锁死');
  assert(avatar.markBrokerSeen(acc, 'zhongxin') === true, '第一次记入返回 true');
  assert(avatar.markBrokerSeen(acc, 'zhongxin') === false, '重复记同一家返回 false（不重复入列）');
  avatar.markBrokerSeen(acc, 'huatai');
  acc.broker = 'huatai';
  const seen = avatar.brokerSeenOf(acc);
  assert(seen.includes('zhongxin') && seen.includes('huatai'), '转户后新旧两家都在（只增不减）');
  assert(seen.length === 2, `去重后恰好 2 家（实际 ${seen.join(',')}）`);
}

// ============================================================
console.log('\n[6] 三源解锁（broker / realm / egg）：素材未落地，用临时目录在独立进程验内核');
{
  // 这三组 P0 还没素材，正式目录里没有行；直接把行塞进 BY_KEY 走不通（模块内私有），
  // 所以用「临时改配置 + 独立进程」验，避免污染本进程的 config
  const { execFileSync } = require('child_process');
  // 占位素材：把 bull 的两档图复制成 probe-* 的名字（跑完就删）。
  // require 时的「图必须存在」校验会拦路，而本测试要验的是**判定**不是素材
  const imgDir = path.join(__dirname, '..', '..', 'Client', 'img');
  const placeholders = [
    'probe-zhongxin', 'probe-huatai', 'probe-lianqi', 'probe-jindan', 'probe-a07',
  ];
  for (const k of placeholders) {
    for (const s of ['96', '192']) {
      fs.copyFileSync(path.join(imgDir, `avatar-bull-${s}.png`), path.join(imgDir, `avatar-${k}-${s}.png`));
    }
  }
  const realProbe = `
    const config = require('./src/config');
    config.avatar.groups.push({ id: 'broker', label: '门派', hint: '' });
    config.avatar.groups.push({ id: 'realm', label: '境界', hint: '' });
    config.avatar.groups.push({ id: 'egg', label: '彩蛋', hint: '' });
    config.avatar.catalog.push({ key: 'probe-zhongxin', group: 'broker', value: 'zhongxin', name: '钟信门面' });
    config.avatar.catalog.push({ key: 'probe-huatai', group: 'broker', value: 'huatai', name: '滑泰快枪手' });
    config.avatar.catalog.push({ key: 'probe-lianqi', group: 'realm', value: 'lianqi', name: '炼气·青衫' });
    config.avatar.catalog.push({ key: 'probe-jindan', group: 'realm', value: 'jindan', name: '结丹·金丹' });
    config.avatar.catalog.push({ key: 'probe-a07', group: 'egg', value: 'A07', name: '千万身家' });
    const avatar = require('./src/avatar');
    const { Account } = require('./src/store');
    const out = [];
    const acc = new Account('probeTester', false, 'player');
    acc.broker = 'zhongxin'; acc.brokerSeen = ['zhongxin'];
    let st = avatar.stateOf(acc);
    out.push('own_broker=' + st.unlocked.includes('probe-zhongxin'));
    out.push('other_broker=' + st.unlocked.includes('probe-huatai'));
    // 未解锁时的 403 + 条件文案（正式目录里没有锁着的组，只能在临时目录测）
    const denied = avatar.set(acc, 'probe-huatai');
    out.push('deny403=' + (denied.status === 403) + '_' + (denied.unlock && /滑泰/.test(denied.unlock.text)));
    avatar.markBrokerSeen(acc, 'huatai'); acc.broker = 'huatai';
    st = avatar.stateOf(acc);
    out.push('transfer_keep=' + (st.unlocked.includes('probe-zhongxin') && st.unlocked.includes('probe-huatai')));
    // 历史最高到过结丹（800 万落在结丹期），当前已跌回炼气
    acc.milestones.peakEquity = 8000000;
    acc.milestones.realmIdx = 1;
    st = avatar.stateOf(acc);
    out.push('peak_jindan=' + st.unlocked.includes('probe-jindan'));
    out.push('peak_lianqi=' + st.unlocked.includes('probe-lianqi'));
    const low = new Account('lowTester', false, 'player');
    low.milestones.peakEquity = 900000;
    out.push('low_jindan=' + avatar.stateOf(low).unlocked.includes('probe-jindan'));
    acc.milestones.fired = ['A07'];
    out.push('egg_a07=' + avatar.stateOf(acc).unlocked.includes('probe-a07'));
    const noEgg = new Account('noEgg', false, 'player');
    out.push('egg_none=' + avatar.stateOf(noEgg).unlocked.includes('probe-a07'));
    config.milestones.enabled = false;
    out.push('egg_group_off=' + !avatar.catalogForClient().groups.some((g) => g.id === 'egg'));
    config.milestones.enabled = true;
    config.realm.enabled = false;
    out.push('realm_group_off=' + !avatar.catalogForClient().groups.some((g) => g.id === 'realm'));
    console.log(out.join(' '));
  `;
  let out = '';
  try {
    out = execFileSync(process.execPath, ['-e', realProbe], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  } finally {
    // 占位图必须清掉：留着它们，正式目录以后加同名 key 时会"看起来有图"
    for (const k of placeholders) {
      for (const s of ['96', '192']) fs.rmSync(path.join(imgDir, `avatar-${k}-${s}.png`), { force: true });
    }
  }
  const get = (k) => (new RegExp(k + '=(\\w+)').exec(out) || [])[1];
  assert(get('own_broker') === 'true', '当前券商的门派脸解锁');
  assert(get('other_broker') === 'false', '没待过的券商门派脸仍锁着');
  assert(/^true_true$/.test(get('deny403') || ''), '拿未解锁的脸换 → 403，且文案是「转户到滑泰证券后解锁」');
  assert(get('transfer_keep') === 'true', '转户后新旧门派的脸都在（转户不收回）');
  assert(get('peak_jindan') === 'true', '历史最高到过结丹 → 境界组「结丹·金丹」解锁（跌境不收回）');
  assert(get('peak_lianqi') === 'true', '低一档的境界脸同时解锁（段位是包含关系）');
  assert(get('low_jindan') === 'false', '没到过结丹的人拿不到结丹脸');
  assert(get('egg_a07') === 'true', 'fired 命中 A07 → 彩蛋脸解锁');
  assert(get('egg_none') === 'false', '没触发过彩蛋拿不到彩蛋脸');
  assert(get('egg_group_off') === 'true', '关掉彩蛋 → 彩蛋组整组不下发');
  assert(get('realm_group_off') === 'true', '关掉境界 → 境界组整组不下发');
}

// ============================================================
console.log('\n[7] POST /api/avatar 的内核三态：未知 key / 未解锁 / 相同值不写库 + NPC 一律派生');
{
  const acc = new Account('postTester', false, 'player');
  acc.nick = 'postTester';
  acc.broker = 'zhaoshang';
  acc.brokerSeen = ['zhaoshang'];
  let r = avatar.set(acc, 'no-such-face');
  assert(!r.ok && r.status === 400 && r.error === '没有这张脸', '未知 key → 400「没有这张脸」');
  r = avatar.set(acc, '');
  assert(!r.ok && r.status === 400 && /不合法/.test(r.error), '空 key → 400「头像参数不合法」');
  r = avatar.set(acc, 123);
  assert(!r.ok && r.status === 400, '非字符串 key → 400');
  // 403（未解锁）需要"有锁的组"才能测：正式目录当前只有基础组（恒解锁），
  // 所以这一条放在 [6] 的临时目录里验（probe-huatai 在转户前 → 403）
  r = avatar.set(acc, 'bear');
  assert(r.ok && acc.avatar === 'bear' && r.avatar && r.avatar.chosen === true, '正常换脸写进 acc.avatar 且 chosen=true');
  const before = acc.avatar;
  r = avatar.set(acc, 'bear');
  assert(r.ok && r.unchanged === true && acc.avatar === before, '与当前相同 → 200 直接回（unchanged）');
  assert(!r.ok === false && r.avatar.key === 'bear', '相同值的响应里仍带回当前脸');

  // NPC：只走派生，读列写列都不许发生
  const npc = new Account('npc-0001', true, 'small');
  const a1 = avatar.of(npc);
  const a2 = avatar.of(npc);
  assert(a1.key === a2.key && a1.npc === true, 'NPC 派生脸稳定（同账号永远同一张）');
  assert(npc.avatar === null, 'NPC 不读列：of() 不把派生结果写回 acc.avatar');
  assert(avatar.derive('npc-0002') !== null, '相邻 NPC 账号也能拿到脸（不许塌成空）');
}

// ============================================================
console.log('\n[8] Game 集成：下发点全覆盖（account.avatar / players[].ava / holders / rules.avatars）');
const g = new Game();
{
  const lr = g.onboard('avaTester', '老王', 'zhongxin');
  assert(lr.ok && !!lr.token, '开户成功');
  const token = lr.token;
  const acc = g.store.get('avaTester');
  assert(Array.isArray(acc.brokerSeen) && acc.brokerSeen.includes('zhongxin'),
    '开户即记入 broker_seen（门派脸立刻解锁，不用等第一次转户）');

  // 老档：avatar 为 NULL 也要有脸（榜单不能出现空头像位）
  assert(acc.avatar === null, '新号没选过脸（avatar = NULL）');
  let st = g.stateFor(token);
  assert(st.account.avatar && !!st.account.avatar.key, `account.avatar 非空（${st.account.avatar && st.account.avatar.key}）`);
  assert(st.account.avatar.chosen === false, 'chosen=false（从没主动选过）');
  assert(Array.isArray(st.account.avatar.unlocked) && st.account.avatar.unlocked.length === 12,
    `unlocked 12 张（基础组全开；门派/境界/彩蛋要解锁，实际 ${st.account.avatar.unlocked.length}）`);
  assert(st.rules.avatar && st.rules.avatar.enabled && Array.isArray(st.rules.avatar.groups),
    'rules.avatar 首帧带整组目录');
  assert(st.rules.avatar.groups.length === 1 && st.rules.avatar.groups[0].rows.length === 12,
    '目录按组下发：base 12 行');
  assert(st.rules.avatar.groups[0].rows[0].unlock.text === '', '基础组的 unlock.text 为空（恒解锁）');
  assert(st.rules.avatar.groups[0].rows.every((r) => !r.unlock.value), '基础组不带 value（没有解锁条件）');

  // lite 帧只留 enabled：38 档境界表与 18 行头像目录都不该每 700ms 发一遍
  const lite = g.stateFor(token, { lite: true });
  assert(lite.rules.avatar && lite.rules.avatar.enabled === true && !lite.rules.avatar.groups,
    'lite 帧的 rules.avatar 只有 {enabled}（目录不重复下发）');
  assert(lite.account.avatar && lite.account.avatar.key, 'lite 帧仍带 account.avatar（顶栏每帧要用）');

  // 排行榜
  assert((st.players || []).every((p) => typeof p.ava === 'string' && p.ava.length > 0),
    'players[].ava 全部非空（包括 NPC）');

  // 股东榜：NPC 与玩家都要有脸。这里不跑完整 tick（会建 3160 个 NPC），
  // 手工给玩家挂一笔多头，再刷一次榜单缓存——computeTopHolders 只认 longQty
  acc.longPos(config.stocks[0].id).lots.push({ qty: 100000, price: 10, ts: Date.now() });
  g.refreshStats();
  const rows = g.topHolders(config.stocks[0].id);
  assert(rows.length > 0 && rows.every((r) => typeof r.ava === 'string' && r.ava.length > 0),
    `股东榜 ${rows.length} 行全部带头像 key`);
  assert(g.holdersFor(token, config.stocks[0].id).rows.every((r) => typeof r.ava === 'string'),
    '/api/holders 的 rows 同样带 ava（从 topHolders 直传）');

  // 换脸：写库 + 下一帧生效
  const r = g.setAvatarFor(token, 'bear');
  assert(r.ok && acc.avatar === 'bear', 'setAvatarFor 写入 acc.avatar');
  const st2 = g.stateFor(token);
  assert(st2.account.avatar.key === 'bear' && st2.account.avatar.chosen === true, '下一帧 account.avatar 变成 bear 且 chosen=true');
  // 榜单缓存每 tick 由 game.tick 的 refreshStats 重建（生产里 ≤700ms 就跟上）；
  // 测试里不跑 tick，手动刷一次同一入口
  g.refreshStats();
  const row = (g.stateFor(token).players || []).find((p) => p.account === 'avaTester');
  assert(row && row.ava === 'bear', '排行榜里的 ava 同步变成 bear');

  // 未解锁 / 未知 / 无令牌
  const r403 = g.setAvatarFor(token, 'broker-huatai');
  assert(!r403.ok && r403.status === 400, '目录里没有的 key → 400（门派组未上线，不撒谎说"未解锁"）');
  const r403b = g.setAvatarFor(token, 'no-such');
  assert(!r403b.ok && r403b.status === 400, '未知 key → 400');
  const r401 = g.setAvatarFor('bogus-token', 'bear');
  assert(!r401.ok && r401.status === 401, '没有令牌 → 401');

  // 转户：门派脸只增不减
  g.transferBroker(acc, 'huatai', Date.now());
  assert(acc.brokerSeen.includes('zhongxin') && acc.brokerSeen.includes('huatai'),
    '转户后 broker_seen 两家都在（转户不收回旧门派脸）');
}

// ============================================================
console.log('\n[9] 落盘往返：avatar / broker_seen 重启后还在，NPC 写 NULL');
{
  const FILE = tmpFile('round');
  rmDb(FILE);
  const ALL_IDS = config.stocks.map((s) => s.id);
  const p1 = new Persister(FILE);
  assert(p1.loadAll(ALL_IDS).resumed === false, '空存档判定为新开一局');
  const g1 = new Game({ persist: p1 });
  g1.start();
  g1.stop(); // 测试里手动 tick，不挂 setInterval
  const lr = g1.onboard('roundTester', '往返测试', 'tianfeng');
  assert(lr.ok, '开户成功');
  const acc = g1.store.get('roundTester');
  assert(g1.setAvatarFor(lr.token, 'quant').ok, '换脸成功');
  g1.transferBroker(acc, 'dongfeng', Date.now());
  const npc = new Account('npc-9999', true, 'small');
  g1.store.put(npc);
  npc.cash = 123; // 标脏，确保它也被写一遍
  p1.touch(npc);
  g1.tick(); // 落盘的唯一入口：commit 会把 dirty 里的账户写掉
  const rowT = p1.db.prepare("SELECT avatar, broker_seen FROM accounts WHERE name = 'roundTester'").get();
  assert(rowT && rowT.avatar === 'quant', `库里写下了 avatar（${rowT && rowT.avatar}）`);
  assert(rowT && /tianfeng/.test(rowT.broker_seen) && /dongfeng/.test(rowT.broker_seen),
    `库里写下了 broker_seen（${rowT && rowT.broker_seen}）`);
  const rowN = p1.db.prepare("SELECT avatar, broker_seen FROM accounts WHERE name = 'npc-9999'").get();
  assert(rowN && rowN.avatar === null, 'NPC 的 avatar 落盘为 NULL（不逐 tick 标脏）');
  assert(rowN && rowN.broker_seen === null, 'NPC 的 broker_seen 落盘为 NULL');
  p1.db.close();

  // 重开一局：读回来还是同一张脸、同一串门派
  const p2 = new Persister(FILE);
  const snap = p2.loadAll(ALL_IDS);
  const back = snap.accounts.find((r) => r.name === 'roundTester');
  assert(!!back && back.avatar === 'quant', '重启后读回的 avatar 还是 quant');
  assert(!!back && /tianfeng/.test(back.broker_seen) && /dongfeng/.test(back.broker_seen),
    '重启后 broker_seen 两家都在');
  p2.db.close();

  // 再走一遍 Game：applySnapshot 要把两列读进内存
  const p3 = new Persister(FILE);
  const g3b = new Game({ persist: p3 });
  g3b.start();
  g3b.stop();
  const acc3 = g3b.store.get('roundTester');
  assert(acc3.avatar === 'quant', 'Game 重启后 acc.avatar 恢复');
  assert(acc3.brokerSeen.includes('dongfeng'), 'Game 重启后 brokerSeen 恢复');
  assert(avatar.of(acc3).key === 'quant', '重启后 of() 仍返回选中的那张');
  p3.db.close();
  rmDb(FILE);
}

// ============================================================
console.log('\n[10] 老档兼容：accounts 没有 avatar 列（v10 存档）也能起来，且有脸');
{
  const { openDatabase } = require('../src/db');
  const Database = require('better-sqlite3');
  const FILE = tmpFile('legacy');
  rmDb(FILE);
  // 造一个 v10 结构：accounts 无 avatar / broker_seen，meta 写 10
  const raw = new Database(FILE);
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE accounts (
      name TEXT PRIMARY KEY, is_npc INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL,
      nick TEXT, home_stock TEXT, cash REAL NOT NULL, order_frozen REAL NOT NULL DEFAULT 0,
      short_margin REAL NOT NULL DEFAULT 0, realized_pnl REAL NOT NULL DEFAULT 0,
      initial_long INTEGER NOT NULL DEFAULT 0, last_order_at INTEGER, created_at INTEGER NOT NULL,
      deposited REAL NOT NULL DEFAULT 0, broker TEXT, broker_changed_at INTEGER,
      broker_since_day INTEGER, broker_stats TEXT, free_reselect_used INTEGER NOT NULL DEFAULT 0,
      coupon_used_day INTEGER, free_interest_day INTEGER, milestones TEXT
    );
  `);
  raw.prepare("INSERT INTO accounts (name, is_npc, role, nick, cash, created_at, broker) VALUES (?, 0, 'player', ?, 1000000, ?, ?)")
    .run('legacyUser', '老档', Date.now(), 'zhongxin');
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '10')").run();
  // 有 round_started_at 才算「续跑老局」：没有它 Persister 会判定为新开一局、把账户行丢掉
  raw.prepare("INSERT INTO meta (key, value) VALUES ('round_started_at', ?)").run(String(Date.now() - 300000));
  raw.close();

  const db = openDatabase(FILE);
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
  assert(cols.includes('avatar') && cols.includes('broker_seen'), 'v10 老档原地升到 v11，补出两列');
  const row = db.prepare("SELECT avatar, broker_seen FROM accounts WHERE name = 'legacyUser'").get();
  assert(row.avatar === null && row.broker_seen === null, '老档两列为 NULL（不是空串 / 默认脸）');
  // 续跑判据里还有一条「至少一只股票有行情断点」（persist.loadAll 的 resumed）：
  // 补一行 market_state，否则会被当成"新开一局"，账户行直接被丢弃
  db.prepare(`INSERT INTO market_state
    (stock_id, last_price, prev_close, open, high, low, volume, turnover, short_interest, order_seq, trade_seq, updated_at)
    VALUES (?, 10, 10, 10, 10, 10, 0, 0, 0, 0, 0, ?)`).run(config.stocks[0].id, Date.now());
  db.close();

  const p = new Persister(FILE);
  const g3 = new Game({ persist: p });
  g3.start(); // applySnapshot 在 start 里跑：这里验的正是「老档读回来会不会崩」
  g3.stop();
  const legacy = g3.store.get('legacyUser');
  assert(!!legacy, '老档账户被加载');
  assert(legacy.avatar === null, 'avatar 读到 null');
  const face = avatar.of(legacy);
  assert(face && !!face.key && face.chosen === false, `avatar=NULL 的老档照样有脸（${face && face.key}）`);
  assert(avatar.brokerSeenOf(legacy).includes('zhongxin'), 'broker_seen=NULL 时当前券商兜底进列');
  p.db.close();
  rmDb(FILE);
}

// ============================================================
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
