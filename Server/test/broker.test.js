/**
 * 券商系统测试：node test/broker.test.js
 *
 * 覆盖 Doc/券商方案.md 与 Doc/消息分层方案.md 里**必须守住口径**的那几条：
 *   ① 两级兜底 —— broker 覆盖 → 全局默认；没有券商的账户逐位等于基准
 *   ② 特权的方向规则 —— 好于基准才按星级递进，差于基准立刻全量
 *   ③ 拥挤税档位、声誉星级曲线、每周之星轮转、转户规则、昵称规则
 *   ④ NPC 券商归属的确定性与下限兜底（席位系统的前置条件）
 *   ⑤ 消息分层的可见性（含「刷新之前的老调用行为不变」这条回归红线）
 *
 * 这一层是纯函数，所以直接调 broker.js，不建 Game。
 */
const config = require('../src/config');

const broker = require('../src/broker');
const { NewsSystem } = require('../src/news');
const { Account } = require('../src/store');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log('  \u2713 ' + msg);
  } else {
    failed += 1;
    console.log('  \u2717 ' + msg);
  }
}

/** 造一个玩家账户：broker + 该券商的进度 */
function buyer(key, vol, profit, liq) {
  const acc = new Account('tester', false, 'player');
  acc.broker = key;
  acc.realizedPnL = profit || 0;
  acc.brokerStats = {
    [key]: { volume: vol || 0, profitBase: 0, liquidations: liq || 0, orders: 0, cancels: 0 },
  };
  return acc;
}

const DAY = 100; // 100 → 第 14 周，当周之星是招伤（刻意选一个非钟信的日子）

console.log('\n[1] 券商表：六家齐、结构支持 N 家');
{
  const keys = broker.keys();
  assert(keys.length === 6, `六家券商（${keys.length}）`);
  assert(
    keys.join(',') === 'zhongxin,huatai,zhaoshang,tianfeng,haitong,dongfeng',
    'key 顺序稳定（前端卡片墙顺序就吃它）'
  );
  assert(broker.list().every((b) => b.name && b.abbr && b.slogan), '每家都有名称/简称/口号');
  // 每个维度只有一个第一：强项维度互不重叠
  const feeLow = keys.reduce((a, k) => (broker.get(k).overrides.feeRate < broker.get(a).overrides.feeRate ? k : a), keys[0]);
  const levHigh = keys.reduce((a, k) => (broker.get(k).overrides.financeRatio < broker.get(a).overrides.financeRatio ? k : a), keys[0]);
  const coolLow = keys.reduce((a, k) => (broker.get(k).overrides.cooldownMs < broker.get(a).overrides.cooldownMs ? k : a), keys[0]);
  assert(feeLow === 'haitong', `费率第一是嗨通（${feeLow}）`);
  assert(levHigh === 'tianfeng', `额度第一是天疯（${levHigh}）`);
  assert(coolLow === 'huatai', `通道第一是滑泰（${coolLow}）`);
  // 支配性检查（§8 清单第 1 条）：逐对确认不存在「A 在所有维度都 ≥ B」。
  // **维度必须包含非数值的代价**（禁买名单、零缓冲强平）——只比数字的话天疯会把
  // 钟信按在地上摩擦，而天疯的代价恰恰只体现在这两项上。
  const dims = [
    { key: 'feeRate', lower: true },
    { key: 'cooldownMs', lower: true },
    { key: 'lockMs', lower: true },
    { key: 'financeRatio', lower: true },
    { key: 'maintenance', lower: true },
    { key: 'lendCapacityMul', lower: false },
    { key: 'autoMax', lower: false },
    { key: 'liquidationBuffer', lower: false },
    { key: 'forbidCount', lower: true },
  ];
  const vals = {};
  for (const k of keys) {
    const bk = broker.forAccount(buyer(k, 3e8, 2e6), { day: DAY });
    vals[k] = Object.assign({}, bk, {
      forbidCount: ((bk.features && bk.features.forbidStocks) || []).length,
    });
  }
  const domPairs = [];
  for (const a of keys) {
    for (const b of keys) {
      if (a === b) continue;
      const better = dims.every((d) => {
        const va = vals[a][d.key];
        const vb = vals[b][d.key];
        return d.lower ? va <= vb + 1e-12 : va >= vb - 1e-12;
      });
      if (better) domPairs.push(`${a}>=${b}`);
    }
  }
  assert(domPairs.length === 0, `无支配选项：不存在 A 在所有维度都 ≥ B（命中 ${domPairs.join(',') || '无'}）`);
  assert(broker.get('tianfeng').features.forbidStocks.length === 2, '天疯禁买两只小票');
  assert(broker.get('tianfeng').features.zeroBufferLiquidation === true, '天疯零缓冲强平（这正是它相对钟信的代价）');
}

console.log('\n[2] 两级兜底：覆盖 → 全局默认');
{
  const plain = new Account('nobroker', false, 'player');
  const bk = broker.forAccount(plain, { day: DAY });
  assert(bk.key === null, '没有券商的账户 key 为空');
  assert(bk.feeRate === config.trade.feeRate, `费率回落基准（${bk.feeRate}）`);
  assert(bk.cooldownMs === config.trade.cooldownMs && bk.lockMs === config.trade.lockMs, '冷却/锁仓回落基准');
  assert(bk.financeRatio === config.margin.finance.ratio, '融资自备比例回落基准');
  assert(bk.autoMax === config.auto.maxPerAccount, `策略上限回落基准（${bk.autoMax}）`);
  assert(bk.lendCapacityMul === 1 && bk.newsVipLeadMs === 0, '券源与提前量回落基准');
  assert(bk.weekly.key === null, '没有交易日号时不启用每周之星（老行为不变）');

  const ghost = new Account('ghost', false, 'player');
  ghost.broker = 'nosuchbank';
  const gb = broker.forAccount(ghost, { day: DAY });
  assert(gb.key === null && gb.feeRate === config.trade.feeRate, '配置里删掉的券商 → 回落基准（不让整局起不来）');

  // NPC 的券商只是展示标签
  const npc = new Account('大米·机构1', true, 'inst');
  npc.broker = 'tianfeng';
  const nb = broker.forAccount(npc, { day: DAY });
  assert(nb.key === null, 'NPC 不吃券商覆盖（§11.4.3 纯展示、零行为影响）');
  assert(nb.financeRatio === config.margin.finance.ratio && nb.maintenance === config.margin.maintenance, 'NPC 的参数逐位等于基准');
}

console.log('\n[3] 方向规则：特权按星级递进、代价立刻全量');
{
  // 钟信 2.5×（自备 40%），基准 50% —— 更好，所以 1★ 只给一部分
  const z1 = broker.forAccount(buyer('zhongxin'), { day: DAY });
  const z4 = broker.forAccount(buyer('zhongxin', 8e7, 5e5), { day: DAY });
  assert(Math.abs(z1.intensity - 0.25) < 1e-9, `1★ 特权强度 = 25%（${z1.intensity}）`);
  assert(z1.financeRatio > 0.4 && z1.financeRatio < 0.5, `钟信 1★ 自备比例落在基准与满额之间（${z1.financeRatio.toFixed(3)}）`);
  assert(Math.abs(z4.financeRatio - 0.4) < 1e-9, `钟信 4★ 拿到满额 40%（${z4.financeRatio}）`);
  assert(broker.leverageOf(z4.financeRatio) === 2.5, '4★ 换算成 2.5 倍');

  // 滑泰 自备 60%，比基准更差 —— 是**代价**，1★ 就照单全收
  const h1 = broker.forAccount(buyer('huatai'), { day: DAY });
  assert(Math.abs(h1.financeRatio - 0.6) < 1e-9, `滑泰 1★ 自备比例就是 60%（代价立刻生效，不因升级变好）`);
  // 招伤 提前量 3s 是特权：1★ 抬到最小生效值，4★ 满额
  const s1 = broker.forAccount(buyer('zhaoshang'), { day: DAY });
  const s2 = broker.forAccount(buyer('zhaoshang', 5e6, 0), { day: DAY });
  const s3 = broker.forAccount(buyer('zhaoshang', 2e7, 1e5), { day: DAY });
  const s4 = broker.forAccount(buyer('zhaoshang', 8e7, 5e5), { day: DAY });
  assert(s1.newsVipLeadMs === config.news.minLeadMs, `招伤 1★ 提前量抬到最小生效值 ${s1.newsVipLeadMs}ms（原始 0.75s 低于 1 个 tick 看不见）`);
  assert(s2.newsVipLeadMs === 1500 && s3.newsVipLeadMs === 2250, `星级递进 2★ ${s2.newsVipLeadMs}ms / 3★ ${s3.newsVipLeadMs}ms`);
  assert(s4.newsVipLeadMs === 3000, `4★ 满额 3000ms（${s4.newsVipLeadMs}）`);
  assert(s4.newsVipVisible === false, '4★ 还不给方向');
  const s5 = broker.forAccount(buyer('zhaoshang', 3e8, 2e6), { day: DAY });
  assert(s5.star === 5 && s5.newsVipVisible === true, '5★ 额外给「标的方向」');
  // 冷却/锁仓/强平线是服务能力与风控属性，不随星级变
  assert(z1.cooldownMs === 3000 && z4.cooldownMs === 3000, '冷却不随星级变（钟信恒 3s）');
  assert(broker.forAccount(buyer('tianfeng'), { day: DAY }).maintenance === 0.25, '天疯维持率 25% 立刻生效');
  assert(broker.forAccount(buyer('dongfeng'), { day: DAY }).maintenance === 0.33, '东风维持率 33%（风控最紧）');
  // 强平缓冲：天疯零缓冲
  assert(broker.forAccount(buyer('tianfeng'), { day: DAY }).liquidationBuffer === 0, '天疯零缓冲强平（无预警档）');
  assert(broker.forAccount(buyer('zhaoshang'), { day: DAY }).liquidationBuffer > 0, '其余券商有「预警 + 缓一档」缓冲');
}

console.log('\n[4] 拥挤税');
{
  const d = broker.forAccount(buyer('dongfeng', 8e7, 5e5), { day: DAY });
  assert(d.crowd.tier === 'heavy' && d.crowd.pct === 68, `东风 68% 重罚档（${d.crowd.tier}）`);
  assert(Math.abs(d.feeRate - 0.0001 * 1.3) < 1e-9, `东风佣金 ×1.3 = ${(d.feeRate * 10000).toFixed(2)}万`);
  assert(Math.abs(d.lendCapacityMul - 0.9 * 0.7) < 1e-9, `东风券源 ×0.7 = ${d.lendCapacityMul.toFixed(3)}`);
  const t = broker.forAccount(buyer('tianfeng', 8e7, 5e5), { day: DAY });
  assert(t.crowd.tier === 'subsidy', '天疯 16% 补贴档');
  assert(Math.abs(t.feeRate - 0.00025 * 0.8) < 1e-9, `天疯佣金 ×0.8 = ${(t.feeRate * 10000).toFixed(2)}万`);
  assert(t.freeCouponPerDay === 1, '补贴档送每日免息券');
  const z = broker.forAccount(buyer('zhongxin', 8e7, 5e5), { day: DAY });
  assert(z.crowd.tier === 'heavy', '钟信 52% 也是重罚档');
  const h = broker.forAccount(buyer('huatai', 8e7, 5e5), { day: DAY });
  assert(h.crowd.tier === 'light', '滑泰 34% 轻罚档');
  assert(broker.crowdTier(0.99).key === 'heavy' && broker.crowdTier(0).key === 'subsidy', '档位边界取自第一个命中的 min');
}

console.log('\n[5] 声誉星级曲线（§9 D7）');
{
  assert(broker.starOf(buyer('zhongxin'), 'zhongxin') === 1, '新户 1★');
  assert(broker.starOf(buyer('zhongxin', 5e6), 'zhongxin') === 2, '成交 500 万 → 2★');
  assert(broker.starOf(buyer('zhongxin', 2e7, 1e5), 'zhongxin') === 3, '2000 万 + 盈利 10 万 → 3★');
  assert(broker.starOf(buyer('zhongxin', 2e7), 'zhongxin') === 2, '只有量没有盈利 → 卡在 2★（门槛必须同时满足）');
  assert(broker.starOf(buyer('zhongxin', 8e7, 5e5), 'zhongxin') === 4, '8000 万 + 50 万 → 4★');
  assert(broker.starOf(buyer('zhongxin', 8e7, 5e5, 1), 'zhongxin') === 3, '有爆仓记录 → 升不到 4★');
  assert(broker.starOf(buyer('zhongxin', 3e8, 2e6), 'zhongxin') === 5, '3 亿 + 200 万 → 5★');
  assert(broker.intensityOf(1) === 0.25 && broker.intensityOf(4) === 1 && broker.intensityOf(5) === 1, '强度 1★=1/4、4★=满额、5★同满额');
  // 进度只算「在这家券商赚的」：profitBase 锚在入会那一刻
  const acc = buyer('zhongxin', 5e6);
  assert(acc.realizedPnL === 0 && broker.starProgress(acc, 'zhongxin').volumeNeed === 20000000, '进度指向下一星门槛');
  // 转户后目标券商从零开始
  const moved = buyer('zhongxin', 3e8, 2e6);
  moved.broker = 'haitong';
  assert(broker.starOf(moved, 'haitong') === 1, '转户后在新券商是 1★（不带过去）');
}

console.log('\n[6] 每周之星：按交易日轮转、一周一家不重复');
{
  const w = broker.weeklyPick(1);
  assert(w.key === broker.keys()[0] && w.nextKey === broker.keys()[1], `第 1 周 = ${w.key}，下周 ${w.nextKey}`);
  assert(broker.weeklyPick(7).key === w.key, '第 7 天还在同一周');
  assert(broker.weeklyPick(8).key === w.nextKey, '第 8 天轮到下一家');
  const seen = new Set();
  for (let d = 1; d <= 7 * 6; d += 7) seen.add(broker.weeklyPick(d).key);
  assert(seen.size === 6, `六周内六家各当一次之星（${[...seen].join(',')}）`);
  assert(broker.weeklyPick(43).key === w.key, '第 43 天绕回第一家（6 周一循环）');
  // 当周之星：佣金减半 + 额度 +0.5×
  const starKey = broker.weeklyPick(DAY).key;
  const acc = buyer(starKey, 3e8, 2e6);
  const bk = broker.forAccount(acc, { day: DAY });
  const plainFee = broker.get(starKey).overrides.feeRate * broker.crowdInfo(starKey).feeMul;
  assert(Math.abs(bk.feeRate - plainFee * 0.5) < 1e-9, '当周之星佣金减半');
  const notStar = broker.forAccount(buyer('haitong', 3e8, 2e6), { day: DAY });
  assert(notStar.weekly.isStar === false && Math.abs(notStar.weekly.feeMul - 1) < 1e-9, '非当周之星不加成');
  assert(bk.weekly.financeBonus === 0.5, '融资额度 +0.5×');
}

console.log('\n[7] 转户（§9 D5）');
{
  const acc = buyer('zhongxin');
  acc.brokerSinceDay = 5;
  acc.freeReselectUsed = false;
  let r = broker.canTransfer(acc, 'huatai', { day: 5, equity: 1e6 });
  assert(r.ok && r.free && r.fee === 0, '开户首日免费重选');
  r = broker.canTransfer(acc, 'zhongxin', { day: 5, equity: 1e6 });
  assert(!r.ok, '不能转给自己');
  // 用掉那一次免费重选后，同一天不能再白转一次（否则转户费形同虚设）
  acc.freeReselectUsed = true;
  r = broker.canTransfer(acc, 'huatai', { day: 5, equity: 1e6 });
  assert(!r.ok && r.needDay === 6, `同日再转被冷却拦住，要等第 ${r.needDay} 个交易日`);
  r = broker.canTransfer(acc, 'huatai', { day: 6, equity: 1e6 });
  assert(r.ok && !r.free && r.fee === 1000, `次日起可转，转户费 = 总资产 0.1%（${r.fee}）`);
  r = broker.canTransfer(acc, 'huatai', { day: 6, equity: 1e8 });
  assert(r.fee === config.brokers.transfer.feeCap, `上限 5 万（${r.fee}）`);
  // 没有交易日号（老路径）时不启用冷却，但费用照收
  r = broker.canTransfer(acc, 'huatai', { day: 0, equity: 1e6 });
  assert(r.ok && r.fee === 1000, '没有交易日时钟时只按费用约束（不误拦）');
}

console.log('\n[8] 昵称规则（新注册仅 ASCII）');
{
  assert(broker.validateNick('abc', false).ok, '3 位纯字母合法');
  assert(broker.validateNick('a-b_c9', false).ok, '连字符/下划线/数字合法');
  assert(broker.validateNick('abcdefghijklmnop', false).ok, '16 位合法');
  assert(!broker.validateNick('abcdefghijklmnopq', false).ok, '17 位被拒');
  assert(!broker.validateNick('ab', false).ok, '2 位被拒');
  assert(!broker.validateNick('1abc', false).ok, '数字开头被拒');
  assert(!broker.validateNick('新玩家', false).ok, '中文被拒');
  assert(!broker.validateNick('a b', false).ok, '空格被拒');
  assert(!broker.validateNick('a@b', false).ok, '特殊符号被拒');
  assert(broker.validateNick('张三丰', true).ok, '老档中文账号放行（存量不锁门，用户已确认会清库）');
}

console.log('\n[9] NPC 券商归属：确定性 + 下限兜底');
{
  const types = [['inst', 10], ['hot', 6], ['big', 20], ['mid', 60], ['small', 220]];
  const entries = [];
  for (const [t, n] of types) for (let i = 0; i < n; i++) entries.push({ name: `大米·${t}${i + 1}`, role: t });
  const m1 = broker.allocateNpcBrokers(entries);
  const m2 = broker.allocateNpcBrokers(entries);
  let same = true;
  for (const [k, v] of m1) if (m2.get(k) !== v) same = false;
  assert(same && m1.size === 316, '同一批账户名两次分配完全一致（重启靠重算，必须确定性）');
  const cnt = {};
  for (const v of m1.values()) cnt[v] = (cnt[v] || 0) + 1;
  assert(Object.keys(cnt).length === 6, `六家都分到了账户（${JSON.stringify(cnt)}）`);
  assert(Object.values(cnt).every((c) => c >= config.brokers.npc.npcFloor), `每家不低于下限 ${config.brokers.npc.npcFloor}`);
  // 类型倾向：散户明显偏东风、游资偏天疯/滑泰、机构偏钟信/嗨通/招伤。
  // **必须把十只股票合起来看**：单股机构只有 10 个账户、游资只有 6 个，
  // 这种样本量下随机波动比倾向本身还大（实测单股 5/10 会误判成"没有倾向"）
  const allEntries = [];
  for (const alias of ['大米', '腾迅', '阿狸', '梅团', '京冬', '筷手', '网艺', '中新', '小朋', '理享']) {
    for (const [t, n] of types) for (let i = 0; i < n; i++) allEntries.push({ name: `${alias}·${t}${i + 1}`, role: t });
  }
  const mAll = broker.allocateNpcBrokers(allEntries);
  const shareAll = (role, keys2) => {
    const rows = allEntries.filter((e) => e.role === role);
    return rows.filter((e) => keys2.includes(mAll.get(e.name))).length / rows.length;
  };
  assert(shareAll('small', ['dongfeng']) > 0.5, `散户明显偏东风（${(shareAll('small', ['dongfeng']) * 100).toFixed(0)}%）`);
  assert(
    shareAll('inst', ['zhongxin', 'haitong', 'zhaoshang']) > 0.6,
    `机构偏钟信/嗨通/招伤（${(shareAll('inst', ['zhongxin', 'haitong', 'zhaoshang']) * 100).toFixed(0)}%）`
  );
  assert(
    shareAll('hot', ['tianfeng', 'huatai']) > 0.5,
    `游资偏天疯/滑泰（${(shareAll('hot', ['tianfeng', 'huatai']) * 100).toFixed(0)}%）`
  );
  const base = broker.get('dongfeng').targetShare;
  assert(
    shareAll('inst', ['dongfeng']) < base,
    `机构的东风占比低于基准份额（${(shareAll('inst', ['dongfeng']) * 100).toFixed(1)}% < ${base * 100}%）`
  );
  // 十只股票逐只都要满足下限
  let floorOk = true;
  for (const alias of ['大米', '腾迅', '阿狸', '梅团', '京冬', '筷手', '网艺', '中新', '小朋', '理享']) {
    const es = [];
    for (const [t, n] of types) for (let i = 0; i < n; i++) es.push({ name: `${alias}·${t}${i + 1}`, role: t });
    const c = {};
    for (const v of broker.allocateNpcBrokers(es).values()) c[v] = (c[v] || 0) + 1;
    if (!Object.values(c).every((x) => x >= config.brokers.npc.npcFloor)) floorOk = false;
  }
  assert(floorOk, '十只股票逐只都满足每家的下限兜底');
  // 哈希质量：账户名只差末尾数字，裸 FNV 会塌成尖峰
  const hs = entries.map((e) => broker.hashUnit('broker:' + e.name));
  const mean = hs.reduce((a, c) => a + c, 0) / hs.length;
  assert(Math.abs(mean - 0.5) < 0.05, `哈希分布无偏（均值 ${mean.toFixed(3)}，裸 FNV-1a 会偏到 0.35）`);
  const dec = new Array(10).fill(0);
  for (const h of hs) dec[Math.min(9, Math.floor(h * 10))] += 1;
  const chi2 = dec.reduce((a, c) => a + ((c - hs.length / 10) ** 2) / (hs.length / 10), 0);
  assert(chi2 < 16.9, `卡方 ${chi2.toFixed(2)} < 16.9（df=9，0.05 临界值）`);
  // 关掉开关就全 null
  const off = broker.allocateNpcBrokers(entries, { enabled: false });
  assert([...off.values()].every((v) => v === null), '关掉 NPC 归属后全部为 null（不改既有行为）');
}

console.log('\n[10] 消息分层的可见性');
{
  const ns = new NewsSystem([{ id: '600001', name: '大米集团', alias: '大米' }]);
  const now = 1000000;
  // 老数据：没有 publicAt/lead 字段 → 视为立即可见（回归红线）
  const legacy = { id: 'N0', dir: 1, scope: '机构', power: 0.5, until: now + 60000, stockId: null };
  assert(NewsSystem.visibleFor(legacy, null, now) === true, '没有 publicAt 的老消息对公众立即可见（老路径行为不变）');
  // 个股消息：三段式
  ns.nextAt = 0;
  const real = ns.pickScope;
  ns.pickScope = () => '机构';
  const n = ns.maybeEmit(now, 0, { phaseKey: 'morning' });
  ns.pickScope = real;
  assert(n.lead.insider === 6000 && n.lead.inst === 4000 && n.lead.vip === 3000, `个股消息三级提前量 ${JSON.stringify(n.lead)}`);
  assert(n.publicAt === now + 6000, `publicAt = t + 最大提前量（${n.publicAt - now}ms）`);
  assert(NewsSystem.visibleFor(n, { tier: 'insider' }, now) === true, 'L0 在 t0 就可见');
  assert(NewsSystem.visibleFor(n, { tier: 'inst' }, now) === false, 'L1 在 t1 之前不可见');
  assert(NewsSystem.visibleFor(n, { tier: 'inst' }, now + 2000) === true, 'L1 从 publicAt − 4s 起可见');
  assert(NewsSystem.visibleFor(n, { tier: 'vip' }, now + 2999) === false, 'L2 在 publicAt − 3s 之前不可见');
  assert(NewsSystem.visibleFor(n, { tier: 'vip' }, now + 3000) === true, 'L2 从 publicAt − 3s 起可见');
  assert(NewsSystem.visibleFor(n, null, now + 5999) === false, '公众要等到 publicAt');
  assert(NewsSystem.visibleFor(n, null, now + 6000) === true, '公众在 publicAt 可见');
  // 大盘消息 lead 恒 0
  ns.nextAt = 0;
  ns.pickScope = () => '全体';
  const macro = ns.maybeEmit(now, 0, { phaseKey: 'morning' });
  ns.pickScope = real;
  assert(
    macro.lead.insider === 0 && macro.lead.inst === 0 && macro.lead.vip === 0 && macro.publicAt === now,
    '大盘宏观消息 lead 恒 0（诞生即可见，完全维持现状）'
  );
  // 散户 scope 打折
  ns.nextAt = 0;
  ns.pickScope = () => '散户';
  const retail = ns.maybeEmit(now, 0, { phaseKey: 'morning' });
  ns.pickScope = real;
  assert(
    retail.lead.insider === 3000 && retail.lead.inst === 2000 && retail.lead.vip === 1500,
    `散户消息按 scope 打 0.5 折（insider ${retail.lead.insider} / inst ${retail.lead.inst} / vip ${retail.lead.vip}ms）`
  );
  assert(retail.publicAt === now + 3000, '折算后的 publicAt 跟着缩到 3s');
  // tape 不外泄
  const publicTape = ns.tapeSnapshot(50, now);
  assert(!publicTape.some((x) => x.publicAt > now), '公众 tape 里没有泄露期消息');
  const vipTape = ns.tapeSnapshot(50, now + 3000, { tier: 'vip', leadMs: 3000, showDir: false });
  const early = vipTape.filter((x) => x.early);
  assert(early.length >= 1 && early.every((x) => x.masked && x.dir === 0), '未满 4★ 的情报玩家只看到「有事」、看不到方向');
  const vipSee = ns.tapeSnapshot(50, now + 3000, { tier: 'vip', leadMs: 3000, showDir: true });
  assert(vipSee.filter((x) => x.early).every((x) => !x.masked), '5★ 才给方向');
  // 不传 viewer 的三个读取口：老行为不变
  ns.active = [{ id: 'X', dir: 1, scope: '机构', power: 0.5, until: now + 60000 }];
  const s = ns.sentiment('机构', now);
  assert(s > 0, '不传 viewer 的老调用照旧拿得到情绪（回归红线）');
  const sb = ns.sentimentByScope(now);
  assert(sb.inst > 0, 'sentimentByScope 老口径不变');
  assert(ns.fvDrift(now) > 0, 'fvDrift 老口径不变');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
