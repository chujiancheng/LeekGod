/**
 * 修仙境界（头衔）测试：node test/realm.test.js
 *
 * 覆盖 Doc/头衔方案.md §12 的守门清单：
 *   ① 阶梯完整性（升序 / i 连续 / group 存在 / egg 指向真实彩蛋）
 *   ② idxOf 边界（±1 分钱）            ③ 开户即二层、老档静默落位（不播事件）
 *   ④ 升境与连跳只播一条                ⑤ 跌境 3% 缓冲 + 单日最多降 3 档
 *   ⑥ 凡骨 / 负资产                     ⑦ 反复破境不幂等（境界不进 fired）
 *   ⑧ 历史最高境界由 peakEquity 反推     ⑨ Game 集成：口径一致 / NPC 不参与 / 同日只判一次
 *   ⑩ 落盘往返与老档兼容                ⑪ 与 A 族彩蛋「合并播报」
 *
 * 与其它服务端测试同口径：关掉涨跌停（用例按盘口打价是常态）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
config.priceLimit.enabled = false;

const realm = require('../src/realm');
const milestones = require('../src/milestones');
const { Account } = require('../src/store');
const { Game } = require('../src/game');

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
  Object.assign({ equity, day, now: 1700000000000 + day * 1000 }, extra);
const state = () => milestones.emptyState();

// ============================================================
console.log('\n[1] 阶梯完整性：配置错了应该在启动时就炸，而不是让玩家看到第 39 名开外');
{
  assert(realm.TOTAL === 38, `共 38 个可判定档位（${realm.TOTAL}）`);
  assert(realm.LADDER[0].i === 1 && realm.LADDER[realm.TOTAL - 1].i === 38, '档位序号 1..38 连续');
  let mono = true;
  for (let k = 1; k < realm.TOTAL; k += 1) {
    if (!(realm.LADDER[k].equity > realm.LADDER[k - 1].equity)) mono = false;
  }
  assert(mono, '门槛严格升序');

  const groupKeys = new Set(config.realm.groups.map((g) => g.key));
  assert(realm.LADDER.every((t) => groupKeys.has(t.group)), '每一档的 group 都能在 groups 里找到');
  assert(config.realm.groups.length === 9, `九大境界（${config.realm.groups.length}）`);

  const eggIds = new Set((config.milestones.wealth || []).map((e) => e.id));
  const badEgg = realm.LADDER.filter((t) => t.egg && !eggIds.has(t.egg));
  assert(badEgg.length === 0, `ladder[i].egg 全部指向真实彩蛋（坏 ${badEgg.length} 个）`);

  // 开户线：startIdx 必须正好落在初始资金那一档
  assert(
    realm.idxOf(config.account.initialCash) === config.realm.startIdx,
    `初始资金 100 万正好是第 ${config.realm.startIdx} 档（炼气二层）`
  );

  // 1 亿 = 加钱终身上限 = 化神圆满：化神之上，钱买不到
  const top1e8 = realm.LADDER.find((t) => t.equity === config.account.deposit.maxLifetime);
  assert(!!top1e8 && top1e8.name === '化神圆满', `加钱上限 1 亿 = ${top1e8 && top1e8.name}`);
}

// ============================================================
console.log('\n[2] idxOf 边界：门槛上差 1 分钱也不能错档');
{
  assert(realm.idxOf(899999.99) === 0, '89.99 万 = 凡骨');
  assert(realm.idxOf(900000) === 1, '90 万 = 炼气一层');
  assert(realm.idxOf(999999.99) === 1, '99.99 万仍是炼气一层');
  assert(realm.idxOf(1000000) === 2, '100 万 = 炼气二层（开户即得）');
  assert(realm.idxOf(5000000) === 13, '500 万 = 筑基圆满');
  assert(realm.idxOf(4999999.99) === 12, '499.99 万还是筑基后期');
  assert(realm.idxOf(9000000000) === 38, '90 亿 = 渡劫');
  assert(realm.idxOf(90000000000) === 38, '再高也夹在渡劫（不越界）');
  assert(realm.idxOf(-500) === 0 && realm.idxOf(NaN) === 0, '负资产 / 非法值一律凡骨');
}

// ============================================================
console.log('\n[3] 开户即二层 + 老档静默落位（不播"你已突破"）');
{
  const s = state();
  assert(s.realmIdx === null, '新状态没有 realmIdx（null = 从没判过）');
  const r1 = realm.evaluateClose(s, CTX(1000000, 1));
  assert(r1.events.length === 0 && r1.quietIds.length === 0, '首次结算不播事件');
  assert(s.realmIdx === 2 && s.realmDay === 1, `静默落位到炼气二层（idx=${s.realmIdx}, day=${s.realmDay}）`);

  // 老档：JSON 里没有 realmIdx
  // 注意：`parse` 收的是**已 JSON.parse 过的对象**（persist 在写库前先解一次）
  const old = milestones.parse({ seq: 3, fired: ['A01'], peakEquity: 1200000 });
  assert(old.realmIdx === null, '老档 parse 后 realmIdx 仍是 null（不瞎猜）');
  realm.evaluateClose(old, CTX(1200000, 7));
  assert(old.realmIdx === 3, `老档按当前权益静默落位（${realm.tierOf(old.realmIdx).name}）`);
  assert(old.seq === 3, '静默落位不占 seq（玩家不会收到一条历史破境）');
}

// ============================================================
console.log('\n[4] 升境：跨档只播一条，文案取最高那档');
{
  const s = state();
  realm.evaluateClose(s, CTX(1000000, 1));
  const up = realm.evaluateClose(s, CTX(2000000, 2));
  assert(s.realmIdx === 8, `200 万 → 炼气八层（idx=${s.realmIdx}）`);
  assert(up.events.length === 1, '只播一条事件');
  const ev = up.events[0];
  assert(ev.kind === 'realm' && ev.dir === 'up', '事件归类为 realm / up');
  assert(ev.title === '破境 · 炼气八层', `标题带目标境界（${ev.title}）`);
  assert(ev.text && ev.mascot === 'smug', '带台词与猫表情（有立绘时前端会换装）');
  assert(ev.seq === 1, '境界事件占一个 seq（与彩蛋共用事件流）');

  // 连跳：一天从 200 万到 1000 万，中间 5 档不各播一条
  const s2 = state();
  realm.evaluateClose(s2, CTX(2000000, 1));
  const jump = realm.evaluateClose(s2, CTX(10000000, 2));
  assert(s2.realmIdx === 16 && jump.events.length === 1, `连跳 8 档只播 1 条（落到 ${realm.tierOf(16).name}）`);
  assert(jump.events[0].realm.from === 8 && jump.events[0].realm.to === 16, '事件里带 from/to 档位（前端可做"连跳"演出）');

  // 跨大境界升境抬到 L3（横幅更醒目），渡劫是 L4
  const s3 = state();
  realm.evaluateClose(s3, CTX(2250000, 1));
  const cross = realm.evaluateClose(s3, CTX(2600000, 2));
  assert(cross.events[0].level === 'L3', `跨大境界升境用 L3 横幅（${cross.events[0].title}）`);
  const s4 = state();
  realm.evaluateClose(s4, CTX(6500000000, 1));
  const final = realm.evaluateClose(s4, CTX(9000000000, 2));
  assert(final.events[0].level === 'L4' && final.events[0].rarity === 'legend', '登顶渡劫是 L4 / 传说');
}

// ============================================================
console.log('\n[5] 跌境：3% 缓冲 + 单日最多降 3 档');
{
  const s = state();
  realm.evaluateClose(s, CTX(5000000, 1));
  assert(s.realmIdx === 13, '锚在筑基圆满');

  const soft = realm.evaluateClose(s, CTX(4900000, 2));
  assert(soft.events.length === 0 && s.realmIdx === 13, '跌 2% 不跌境（缓冲带里）');
  const hard = realm.evaluateClose(s, CTX(4840000, 3));
  assert(hard.events.length === 1 && s.realmIdx === 12, `跌 3.2% 才跌境，落到 ${realm.tierOf(12).name}`);
  assert(hard.events[0].dir === 'down' && hard.events[0].level === 'L1', '跌境是 L1（toast，不占横幅）');

  // 崩盘：从结丹圆满一天掉到炼气，单日最多降 3 档，次日继续
  const c = state();
  realm.evaluateClose(c, CTX(13000000, 1));
  const d1 = realm.evaluateClose(c, CTX(2000000, 2));
  assert(c.realmIdx === 14 && d1.events[0].realm.from === 17, `1300 万崩到 200 万：一天只降 3 档（${c.realmIdx}）`);
  const d2 = realm.evaluateClose(c, CTX(2000000, 3));
  assert(c.realmIdx === 11, `次日继续降（${realm.tierOf(c.realmIdx).name}）`);
  assert(d2.events[0].text.indexOf('一日跌') === 0, `连续跌境用"一日跌 N 境"文案（${d2.events[0].text.slice(0, 12)}…）`);

  // 跌到凡骨：文案换「道基已碎」（权益留在 10 万以上，才走毒舌档；跌破软着陆线会自动转 gentle）
  const m = state();
  realm.evaluateClose(m, CTX(2300000, 1));
  for (let day = 2; day < 8; day += 1) realm.evaluateClose(m, CTX(200000, day));
  assert(m.realmIdx === 0, `一路跌到凡骨（idx=${m.realmIdx}）`);
  const last = m.events[m.events.length - 1];
  assert(last.title === '道基已碎' && last.text.indexOf('道基已碎') >= 0, `凡骨文案（${last.text.slice(0, 14)}…）`);

  // 软着陆：权益跌破 10 万后跌境文案强制 gentle（与彩蛋同一条规则）
  const gt = state();
  realm.evaluateClose(gt, CTX(2300000, 1));
  for (let day = 2; day < 8; day += 1) realm.evaluateClose(gt, CTX(5000, day));
  const gLast = gt.events[gt.events.length - 1];
  assert(gLast.text.indexOf('嘲讽') < 0 && gLast.text.indexOf('重新长出来') >= 0, `跌破 10 万自动转 gentle（${gLast.text.slice(0, 12)}…）`);

  // 负资产（倒欠券商）也是凡骨
  const n = state();
  realm.evaluateClose(n, CTX(1000000, 1));
  for (let day = 2; day < 6; day += 1) realm.evaluateClose(n, CTX(-50000, day));
  assert(n.realmIdx === 0, '负资产 = 凡骨（不会出现负的档位）');
}

// ============================================================
console.log('\n[6] 反复破境不幂等：境界事件绝不进 fired（跌境后升回来要能再播）');
{
  const s = state();
  realm.evaluateClose(s, CTX(1000000, 1));
  const a = realm.evaluateClose(s, CTX(5000000, 2));
  const b = realm.evaluateClose(s, CTX(4840000, 3));
  const c = realm.evaluateClose(s, CTX(5000000, 4));
  assert(a.events.length === 1 && b.events.length === 1 && c.events.length === 1, '升 → 跌 → 再升，三次都播');
  assert(c.events[0].dir === 'up' && c.events[0].realm.to === 13, '第二次破境仍是筑基圆满');
  assert(s.fired.length === 0, 'fired 里一条境界都没有（幂等键只属于彩蛋）');
  assert(s.titles.length === 0, 'titles 也不被境界污染（称号只来自彩蛋）');
  assert(s.seq === 3, `seq 单调到 3（${s.seq}）`);

  // 同日重复结算：同一个收盘日只判一次
  const again = realm.evaluateClose(s, CTX(9000000, 4));
  assert(again.events.length === 0 && s.realmIdx === 13, '同一交易日重复结算不再判（realmDay 守卫）');
}

// ============================================================
console.log('\n[7] 历史最高境界：复用 peakEquity 反推，不新增字段');
{
  const s = state();
  milestones.initPeak(s, 1000000);
  realm.evaluateClose(s, CTX(1000000, 1));
  realm.evaluateClose(s, CTX(13000000, 2));
  const peak = realm.view(s, { equity: 13000000 });
  assert(peak.idx === 17 && peak.peak.idx === 17, '峰值时当前 = 历史最高');

  // 跌回 200 万：当前境界跌了，历史最高仍在（名号不跌）
  realm.evaluateClose(s, CTX(2000000, 3));
  const down = realm.view(s, { equity: 2000000 });
  assert(down.idx === 14, `当前境界降到 ${down.name}`);
  assert(down.peak.idx === 17 && down.peak.name === '结丹圆满', `历史最高仍是 ${down.peak.name}（名号不跌）`);
  assert(s.peakEquity === 13000000, 'peakEquity 单调不减（境界没有自己的峰值字段）');

  // 下发给客户端的形状（当前 14 = 结丹初期，被单日降幅上限卡住）
  assert(down.honor === '金丹真人' && down.group === 'jindan', '带尊号与大境界 key（配色用）');
  assert(down.next && down.next.equity === 8200000 && down.next.need === 6200000, '带下一档门槛与差额');
  assert(down.pct >= 0 && down.pct <= 1, `段内进度夹在 0~1（${down.pct}）`);
  assert(down.total === 38 && down.changedDay === 3, '带总档位与最近变更日');

  // 盘中越过下一档 → 只给 pending，不改 idx
  const pending = realm.view(s, { equity: 8300000 });
  assert(pending.idx === 14 && pending.pending === true, '盘中越过门槛只标 pending，境界等收盘确认');
  const drop = realm.view(s, { equity: 14100000 });
  assert(drop.dropping === false, '正常区间 dropping=false');
  const breaching = realm.view(s, { equity: 6300000 });
  assert(breaching.dropping === true, '跌破本档门槛 3% 时标 dropping（盘中只换色，不判）');
}

// ============================================================
console.log('\n[8] Game 集成：收盘判定、口径一致、NPC 不参与、合并播报');
let token = '';
const g = new Game();
{
  g.day.reanchor(Date.now() - 590000); // 锚进第 1 天夜间 → 收盘结算会做掉第 1 天
  const lr = g.onboard('realmTester', 'realmTester', 'zhaoshang');
  assert(lr.ok && !!lr.token, '登录成功');
  token = lr.token;
  const acc = g.store.get('realmTester');
  assert(acc.milestones.realmIdx === null, '开户那一刻还没判过境界（等第一次收盘）');

  const npc = new Account('大米·机构1', true, 'inst');
  npc.cash = 10000000;
  g.store.put(npc);
  assert(npc.milestones === null, 'NPC 账户没有境界状态（一律不判）');

  // 第 1 天收盘：100 万 → 静默落位炼气二层（新号不该收到"你已突破"）
  g.ensureDaySettled(Date.now());
  assert(acc.milestones.realmIdx === 2, '首日结算静默落到炼气二层');
  assert(acc.milestones.events.length === 0, '静默落位不产生任何事件');

  // 第 2 天：权益 200 万 → 炼气八层，同一天命中 A01/A02/A03
  acc.cash = r2(acc.cash + 1000000);
  g.day.reanchor(Date.now() - (620000 + 590000));
  g.ensureDaySettled(Date.now());
  assert(acc.milestones.realmIdx === 8, `收盘权益 200 万 → 炼气八层（idx=${acc.milestones.realmIdx}）`);
  assert(acc.milestones.fired.join(',') === 'A01,A02,A03', '三档彩蛋全部记为 fired（成就一个不丢）');
  assert(
    acc.milestones.titles.map((t) => t.title).join(',') === '保本出关,五十个点,翻倍人生',
    '称号照记（A03「翻倍人生」不因合并播报而消失）'
  );

  // 合并播报：A03 的门槛与炼气八层对齐 → A03 被压掉，只剩 A01/A02 + 破境
  const kinds = acc.milestones.events.map((e) => (e.kind === 'realm' ? e.title : e.id));
  // 境界先判，所以它排在队列最前；对齐的 A03 被压掉，A01/A02 照常
  assert(kinds.join('|') === '破境 · 炼气八层|A01|A02', `同日只发一条境界横幅，对齐的 A03 被压掉（${kinds.join('|')}）`);

  // 同日重复结算：不再判一次（settleDay 的收盘段与夜间段都会走到这里）
  const seqBefore = acc.milestones.seq;
  g.evaluateMilestones(Date.now(), 2);
  assert(acc.milestones.seq === seqBefore, '同一交易日不会重复播破境');

  // 下发：account.realm 与判定同源
  const st = g.stateFor(token);
  assert(st.account.realm && st.account.realm.idx === 8, 'stateFor 下发 account.realm');
  assert(st.account.realm.equity === st.account.equity, '境界与账户用的是同一个 equity');
  assert(st.account.realm.peak.idx === 8, '历史最高由 peakEquity 反推');
  assert(st.account.realm.next.name === '炼气九层', `下一档炼气九层（${st.account.realm.next.name}）`);

  // rules：首屏带全表，增量帧（lite）不带
  assert(st.rules.realm.enabled === true, 'rules.realm.enabled 下发');
  assert(st.rules.realm.ladder.length === 38, `首屏带 38 档整表（${st.rules.realm.ladder.length}）`);
  assert(st.rules.realm.groups.length === 9 && st.rules.realm.mortal.name === '凡骨', '带大境界表与凡骨伪 group');
  assert(
    st.rules.realm.demoteBuffer === config.realm.demoteBuffer && st.rules.realm.depositCapTier === '化神圆满',
    '首屏带跌境参数与加钱上限档位（规则页说明文字用，前端不许写死）'
  );
  const lite = g.stateFor(token, { lite: true });
  assert(lite.rules.realm.ladder === undefined, 'lite 帧不带整表（每 tick 省 2.5KB）');
  assert(lite.rules.realm.demoteBuffer === undefined, 'lite 帧也不带规则页说明字段');
  assert(lite.account.realm.idx === 8, 'lite 帧的账户境界照常下发');

  // 排行榜：境界只作附加列，不参与排序
  const board = g.leaderboard();
  const row = board.find((p) => p.account === 'realmTester');
  assert(!!row && row.realm.idx === 8 && row.realm.honor === '炼气士', '排行榜带境界附加列');
  assert(board.every((p, i) => i === 0 || board[i - 1].equity >= p.equity), '排序键仍然是权益（境界不参与排序）');
  assert(!board.some((p) => p.account === '大米·机构1'), 'NPC 不进排行榜');
}

// ============================================================
console.log('\n[9] 落盘往返：realmIdx / realmDay 进存档，老档缺字段不报错');
{
  const s = state();
  realm.evaluateClose(s, CTX(1000000, 1));
  realm.evaluateClose(s, CTX(2000000, 2));
  const json = JSON.parse(milestones.serialize(s));
  assert(json.realmIdx === 8 && json.realmDay === 2, `落盘带境界（idx=${json.realmIdx}, day=${json.realmDay}）`);

  const back = milestones.parse(json);
  assert(back.realmIdx === 8 && back.realmDay === 2, '读回来一致');
  const v = realm.view(back, { equity: 2000000 });
  assert(v.idx === 8 && v.name === '炼气八层', '重启后徽标不退回炼气二层');

  const legacy = milestones.parse({ seq: 1, fired: [], peakEquity: 1000000 });
  assert(legacy.realmIdx === null, '没有字段的老档 → null（不误判成凡骨）');
  assert(milestones.serialize(legacy).indexOf('"realmIdx":null') > 0, 'null 原样写回，不会被写成 0');
}

// ============================================================
console.log('\n[10] 服务端不该在 require 期外做全账户扫描（只判玩家）');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'realm.js'), 'utf8');
  assert(src.indexOf('store') < 0 && src.indexOf('market') < 0, 'realm.js 是纯函数层（不 require store / market）');
  assert(src.indexOf('console.') < 0, '日志走 logger，不直接 console');

  const g2 = new Game();
  g2.day.reanchor(Date.now() - 590000);
  g2.onboard('realmTester2', 'realmTester2', 'zhaoshang');
  let touched = 0;
  const origTouch = g2.persist ? g2.persist.touch : null;
  if (g2.persist) {
    g2.persist.touch = (a) => {
      touched += 1;
      return origTouch.call(g2.persist, a);
    };
  }
  g2.ensureDaySettled(Date.now());
  assert(g2.store.get('realmTester2').milestones.realmIdx === 2, '新号首日结算静默落到炼气二层');
  if (g2.persist) assert(touched >= 1, '判定后标脏落盘（重启不会退回旧境界）');
}

// ============================================================
console.log('\n[11] 文案与下发细节：不许出现"60 万 元"、不许让倒欠的人听"本金还能长出来"');
{
  // 凡骨（savage）：fmtMoney 自带单位，模板里再写"元"会读成"还剩 60 万 元"
  const s = state();
  realm.evaluateClose(s, CTX(1500000, 1));
  let ev = null;
  for (let day = 2; day < 14; day += 1) {
    const r = realm.evaluateClose(s, CTX(600000, day));
    if (r.events.length) ev = r.events[0];
  }
  assert(s.realmIdx === 0 && ev && ev.title === '道基已碎', `跌回凡骨（idx=${s.realmIdx}）`);
  assert(ev.text.indexOf('60 万') >= 0 && !/万\s*元/.test(ev.text), `凡骨文案单位不重复（${ev.text}）`);

  // 倒欠券商：负号必须被 abs 掉，且这条**不能被 gentle 软着陆挡掉**
  const n = state();
  realm.evaluateClose(n, CTX(1500000, 1));
  for (let day = 2; day < 14; day += 1) {
    const r = realm.evaluateClose(n, CTX(-50000, day));
    if (r.events.length) ev = r.events[0];
  }
  assert(n.realmIdx === 0, '负权益 = 凡骨');
  assert(ev.text.indexOf('倒欠券商 5 万') >= 0 && ev.text.indexOf('-5 万') < 0, `倒欠文案用绝对值（${ev.text}）`);

  // 跌破软着陆线但没倒欠：仍走 gentle，不嘲讽
  const g = state();
  realm.evaluateClose(g, CTX(1500000, 1));
  for (let day = 2; day < 14; day += 1) {
    const r = realm.evaluateClose(g, CTX(2950, day));
    if (r.events.length) ev = r.events[0];
  }
  assert(ev.text.indexOf('本金还有机会') >= 0, '只剩几千块时走 gentle 软着陆');

  // 事件带大境界 key（横幅左边线配色）与方向
  const up = state();
  realm.evaluateClose(up, CTX(1000000, 1));
  const evUp = realm.evaluateClose(up, CTX(5000000, 2)).events[0];
  assert(evUp.realmGroup === 'zhuji' && evUp.dir === 'up', `破境事件带 realmGroup（${evUp.realmGroup}）`);
  assert(evUp.realm && evUp.realm.from === 2 && evUp.realm.to === 13, `event.realm 带 from/to 档位（${JSON.stringify(evUp.realm)}）`);
  // 透传：`emitTransient` 收的是 realm 内部事件（带 fromIdx/toIdx），
  // 别拿已经下发过的 event 再喂一遍——那份只有 realm:{from,to}，字段名不同
  const wire = milestones.emitTransient(
    up,
    { id: 'Rt', kind: 'realm', dir: 'up', realmGroup: 'zhuji', fromIdx: 2, toIdx: 13, title: '破境 · 测试', text: 'x' },
    CTX(5000000, 2)
  );
  assert(wire.realmGroup === 'zhuji' && wire.realm.to === 13, '内部事件字段透传到下发结构（客户端据此写 --rtone）');

  // 规则面板整表：说明文字要用的三个数必须下发，前端不许写死
  const tbl = realm.ladderForClient();
  assert(tbl.demoteBuffer === config.realm.demoteBuffer, `下发跌境缓冲（${tbl.demoteBuffer}）`);
  assert(tbl.demoteMaxPerDay === config.realm.demoteMaxPerDay, `下发单日降幅上限（${tbl.demoteMaxPerDay}）`);
  assert(tbl.depositCap === config.account.deposit.maxLifetime, `下发加钱上限（${tbl.depositCap}）`);
  assert(tbl.depositCapTier === '化神圆满', `上限对应档位（${tbl.depositCapTier}）`);
  assert(tbl.ladder.length === realm.TOTAL && !('egg' in tbl.ladder[0]), '整表不带 egg 字段（那是服务端内部对齐用）');

  // 主页卡的峰值权益：不能逼前端去翻彩蛋段（彩蛋关了那个字段就不下发）
  const pv = realm.view(up, { equity: 3000000 });
  assert(Number.isFinite(pv.peakEquity) && pv.peakEquity === 5000000, `view 带 peakEquity（${pv.peakEquity}）`);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
