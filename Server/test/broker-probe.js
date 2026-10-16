/**
 * 券商平衡校验探针：node test/broker-probe.js
 *
 * 手动跑，不进 `npm test`（与 day-probe / npc-probe 同规格）。它把 Doc/券商方案.md §8
 * 的六条校验清单**算成数**，而不是停留在感觉上：
 *
 *   ① 支配性检查（逐对比较，含非数值代价）
 *   ② 等价换算：费率差折成「日均 N 笔的成本」、额度差折成「可承载收益」
 *   ③ 短线玩家：滑泰（快）vs 嗨通（便宜）的胜负线在哪一笔数上
 *   ④ 大资金：额度何时成为瓶颈、费率何时主导
 *   ⑤ 赌徒：天疯满杠杆的强平阈值 vs 日波动的距离（多大概率爆仓）
 *   ⑥ 拥挤税不失控：最坏情况下各家的有效数值区间
 *
 * **改 config.brokers 里任何数值都应该重跑一遍**——它跑得很快，纯算术，无随机。
 */
const config = require('../src/config');
const broker = require('../src/broker');
const { Account } = require('../src/store');

const DAY = 100; // 避开钟信当周之星，看裸数值
const keys = broker.keys();

/** 满星账户（特权给满，看这套数值的"上限"形态） */
function full(key, opts = {}) {
  const acc = new Account('t', false, 'player');
  acc.broker = key;
  acc.realizedPnL = 2e6;
  acc.brokerStats = { [key]: { volume: 3e8, profitBase: 0, liquidations: 0, orders: 0, cancels: 0 } };
  if (opts.star === 1) acc.brokerStats[key] = { volume: 0, profitBase: 0, liquidations: 0, orders: 0, cancels: 0 };
  return broker.forAccount(acc, { day: opts.day == null ? DAY : opts.day });
}

function pad(s, n, right) {
  s = String(s);
  const gap = Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0));
  return right ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

const W = (s, n) => pad(s, n);

console.log('\n================ 券商平衡校验（Doc/券商方案.md §8） ================\n');

// ---------- ① 支配性检查 ----------
console.log('① 支配性检查：逐对确认不存在「A 在所有维度都 ≥ B」');
const dims = [
  ['费率', 'feeRate', true],
  ['冷却', 'cooldownMs', true],
  ['锁仓', 'lockMs', true],
  ['自备比例', 'financeRatio', true],
  ['维持率', 'maintenance', true],
  ['券源系数', 'lendCapacityMul', false],
  ['策略条数', 'autoMax', false],
  ['强平缓冲', 'liquidationBuffer', false],
  ['禁买只数', 'forbidCount', true],
];
const V = {};
for (const k of keys) {
  const bk = full(k);
  V[k] = Object.assign({}, bk, { forbidCount: ((bk.features && bk.features.forbidStocks) || []).length });
}
const dom = [];
for (const a of keys) {
  for (const b of keys) {
    if (a === b) continue;
    if (dims.every(([, f, lower]) => (lower ? V[a][f] <= V[b][f] + 1e-12 : V[a][f] >= V[b][f] - 1e-12))) {
      dom.push(`${a} ≥ ${b}`);
    }
  }
}
console.log(`   命中支配对：${dom.length ? dom.join('、') : '无 ✓'}`);
// 只比数值（不含禁买/缓冲）时谁被压住——这是最容易漏掉的一类失衡
const numDims = dims.filter(([, f]) => f !== 'forbidCount' && f !== 'liquidationBuffer');
const domNum = [];
for (const a of keys) {
  for (const b of keys) {
    if (a === b) continue;
    if (numDims.every(([, f, lower]) => (lower ? V[a][f] <= V[b][f] + 1e-12 : V[a][f] >= V[b][f] - 1e-12))) {
      domNum.push(`${a} ≥ ${b}`);
    }
  }
}
console.log(`   （只比纯数值维度时：${domNum.length ? domNum.join('、') : '无'}）`);

console.log('\n   各维度第一名（应当互不重叠）：');
const firsts = {};
for (const [label, field, lower] of numDims) {
  const vals = keys.map((k) => V[k][field]);
  const bestVal = lower ? Math.min(...vals) : Math.max(...vals);
  const winners = keys.filter((k) => Math.abs(V[k][field] - bestVal) < 1e-12);
  firsts[field] = winners;
  console.log(`     ${W(label, 10)} ${W(winners.join(' / '), 24)}${winners.length > 1 ? '⚠ 并列第一（维度没拉开）' : ''}`);
}
const dupFirst = {};
for (const [, field] of numDims) {
  if (firsts[field].length !== 1) continue;
  const b = firsts[field][0];
  dupFirst[b] = (dupFirst[b] || []).concat(numDims.find(([, f]) => f === field)[0]);
}
for (const k of Object.keys(dupFirst)) {
  if (dupFirst[k].length > 1) {
    console.log(`     ⚠ ${k} 一家独占 ${dupFirst[k].length} 个第一：${dupFirst[k].join(' / ')}（应确认这些是不是同一个维度的多个侧面）`);
  }
}

// ---------- 数值总表 ----------
console.log('\n   满星有效数值表：');
console.log(
  '   ' + W('券商', 10) + W('佣金(万)', 10, true) + W('冷却', 7, true) + W('锁仓', 7, true) +
  W('杠杆', 7, true) + W('维持率', 8, true) + W('券源', 7, true) + W('策略', 6, true) + W('拥挤档', 8) + W('禁买', 6, true)
);
for (const k of keys) {
  const b = V[k];
  console.log(
    '   ' + W(k, 10) +
    W((b.feeRate * 10000).toFixed(2), 10, true) +
    W((b.cooldownMs / 1000).toFixed(1) + 's', 7, true) +
    W((b.lockMs / 1000).toFixed(0) + 's', 7, true) +
    W(broker.leverageOf(b.financeRatio) + 'x', 7, true) +
    W(Math.round(b.maintenance * 100) + '%', 8, true) +
    W(Math.round(b.lendCapacityMul * 100) + '%', 7, true) +
    W(b.autoMax, 6, true) +
    W(b.crowd.label, 8) +
    W(b.forbidCount, 6, true)
  );
}

// ---------- ②③ 短线玩家：滑泰 vs 嗨通 ----------
console.log('\n② 等价换算：费率差折成「日均 N 笔的成本」');
const CAP = 1_000_000; // 100 万本金
const NOTIONAL = 200_000; // 单笔平均投入 20 万（2 成仓）
for (const k of keys) {
  const b = V[k];
  const perDay = (n) => n * NOTIONAL * b.feeRate;
  console.log(
    `   ${W(k, 10)} 单笔手续费 ${W((NOTIONAL * b.feeRate).toFixed(2) + '元', 10)}` +
    ` 10 笔/日 ${W(perDay(10).toFixed(0) + '元', 9)}  50 笔/日 ${W(perDay(50).toFixed(0) + '元', 9)}` +
    `  折算年化(250 日) ${W(((perDay(50) * 250) / CAP * 100).toFixed(1) + '%', 7)}`
  );
}

console.log('\n③ 短线玩家：滑泰（快）vs 嗨通（便宜）——胜负取决于日均笔数与反应速度');
{
  const fast = V.huatai;
  const cheap = V.haitong;
  const feeGap = fast.feeRate - cheap.feeRate; // 滑泰每笔更贵
  const DAY_SEC = 570; // 一天可交易秒数（连续竞价 + 两段竞价，620s 里扣掉休市）
  const edge = 0.001; // 单笔边际优势假设 0.1%（日内高手的量级）
  // 玩家想以「每 t 秒一笔」的节奏下单；冷却 c 会把节奏压到 max(t, c)
  const realized = (t, c) => DAY_SEC / Math.max(t, c);
  console.log(`   假设：单笔边际优势 ${(edge * 100).toFixed(2)}%，单笔投入 ${NOTIONAL / 10000} 万，一天可交易 ${DAY_SEC} 秒`);
  console.log(`   ${W('反应节奏', 10)}${W('滑泰笔数', 10, true)}${W('嗨通笔数', 10, true)}${W('多做的量', 10, true)}${W('多赚', 10, true)}${W('多付手续费', 12, true)}${W('滑泰净胜', 12, true)}`);
  for (const t of [0.5, 1, 2, 3, 5, 10, 30]) {
    const nf = realized(t, fast.cooldownMs / 1000);
    const nc = realized(t, cheap.cooldownMs / 1000);
    const extra = nf - nc;
    const gain = extra * NOTIONAL * edge;
    const cost = (nf * NOTIONAL * fast.feeRate) - (nc * NOTIONAL * cheap.feeRate);
    console.log(
      `   ${W('每 ' + t + 's', 10)}${W(nf.toFixed(0), 10, true)}${W(nc.toFixed(0), 10, true)}` +
      `${W(extra.toFixed(0), 10, true)}${W(gain.toFixed(0) + '元', 10, true)}${W(cost.toFixed(0) + '元', 12, true)}` +
      `${W((gain - cost).toFixed(0) + '元', 12, true)}`
    );
  }
  // 反转的临界节奏：t 大到冷却完全不 binding 时，嗨通的费率优势全归自己
  const breakevenT = (fast.cooldownMs) / 1000;
  const needExtra = (NOTIONAL * feeGap) / (NOTIONAL * edge);
  console.log(
    `   ⇒ 结论：滑泰的通道优势**只在「反应节奏快于它的冷却（<${breakevenT}s）」时才存在**——` +
    `一旦下不到那个节奏，两家的实际笔数完全相同，滑泰每笔还贵 ${(feeGap * 10000).toFixed(2)} 万，纯亏。`
  );
  console.log(
    `   ⇒ 但费差本身很薄：补回它只需要多做 ${needExtra.toFixed(2)} 笔/日（单笔边际优势 0.1% 时）。` +
    `所以真正的分水岭是**反应速度**而不是"费率高不高"：快下单/挂自动化 → 滑泰；手动低频 → 嗨通。`
  );
}

// ---------- ④ 大资金 vs 小资金 ----------
console.log('\n④ 额度差折成「可承载收益」：多大资金开始额度主导');
{
  const edge = 0.01; // 单次机会吃 1% 收益
  const ref = V.zhongxin;
  const cheap = V.haitong;
  const dL = broker.leverageOf(ref.financeRatio) - broker.leverageOf(cheap.financeRatio);
  const feeGap = ref.feeRate - cheap.feeRate;
  console.log(`   钟信 vs 嗨通：杠杆差 ${dL.toFixed(2)}x，每笔费率差 ${(feeGap * 10000).toFixed(2)} 万`);
  console.log(`   一次满仓机会多承载的收益 = 本金 × ${dL.toFixed(2)} × ${(edge * 100).toFixed(1)}%`);
  console.log(`   日成本 = 笔数 × 本金 × ${(feeGap * 10000).toFixed(2)}万`);
  console.log(`   ⇒ 两者都随本金等比放大，**所以"资金大就该选钟信"不成立**；真正的分水岭是笔数：`);
  const nBreak = (dL * edge) / feeGap;
  console.log(`     笔数 < ${nBreak.toFixed(1)} 笔/日 → 钟信的额度优势占上风`);
  console.log(`     笔数 > ${nBreak.toFixed(1)} 笔/日 → 嗨通的费率优势占上风`);
  for (const C of [500_000, 1e6, 3e6, 1e7]) {
    const cheapDay = 20 * C * cheap.feeRate;
    const zxDay = 20 * C * ref.feeRate;
    console.log(`     本金 ${W((C / 10000) + '万', 8)} 20 笔/日：嗨通手续费 ${W(cheapDay.toFixed(0) + '元', 9)} 钟信 ${W(zxDay.toFixed(0) + '元', 9)}（差 ${(zxDay - cheapDay).toFixed(0)} 元）`);
  }
}

// ---------- ⑤ 赌徒验证：天疯的强平阈值 ----------
console.log('\n⑤ 赌徒验证：满杠杆下多大的逆向波动会爆仓');
{
  // 游戏里的判据：eq < maintenance × 敞口。设本金 C、杠杆 L（敞口 L·C），
  // 逆向波动 x 之后 eq = C − L·C·x，敞口 = L·C(1−x)
  //   C − L·C·x < m · L·C(1−x)  →  x > (1 − m·L) / (L·(1−m))
  const SIGMA = 0.0438; // day-probe 实测日收益 std 4.38%（项目知识 §3）
  console.log(`   实测日收益 std = ${(SIGMA * 100).toFixed(2)}%（day-probe），按正态近似算尾部概率`);
  for (const k of keys) {
    const b = V[k];
    const L = broker.leverageOf(b.financeRatio);
    const m = b.maintenance;
    const x = (1 - m * L) / (L * (1 - m));
    const z = x / SIGMA;
    // 单边正态尾部概率（近似，真实分布有肥尾）
    const p = 0.5 * (1 - erf(z / Math.SQRT2));
    const daysToBlow = p > 1e-9 ? 1 / p : Infinity;
    const buffer = b.liquidationBuffer > 0 ? `缓冲 ${(b.liquidationBuffer * 100).toFixed(0)}pp（先预警）` : '零缓冲（破线即全平）';
    console.log(
      `   ${W(k, 10)} 杠杆 ${W(L + 'x', 7)} 维持率 ${W(Math.round(m * 100) + '%', 5)}` +
      ` 强平阈值 ${W((x * 100).toFixed(2) + '%', 8)} (${W(z.toFixed(2) + 'σ', 6)})` +
      ` 单日爆仓概率 ${W((p * 100).toFixed(3) + '%', 8)}` +
      ` 期望 ${W(daysToBlow === Infinity ? '几乎不可能' : daysToBlow.toFixed(0) + ' 天一次', 14)}  ${buffer}`
    );
  }
  console.log('   ⇒ 天疯满杠杆只需 6~7% 的逆向波动就全平，而一天的 std 就有 4.4% ——');
  console.log('     它是**高方差**选项而非稳赚选项：满杠杆的每十几天就会被打死一次，');
  console.log('     这与设计稿「赌徒、一天翻倍也一天归零」的定位一致。');
}

// ---------- ⑥ 拥挤税不失控 ----------
console.log('\n⑥ 拥挤税不失控：最坏情况下各家的有效数值区间');
{
  console.log('   （拥挤度是配置里的**固有属性**，不随真实占比变化 → 天然有界；这里给区间供参考）');
  const fee = keys.map((k) => V[k].feeRate);
  const lend = keys.map((k) => V[k].lendCapacityMul);
  const L = keys.map((k) => broker.leverageOf(V[k].financeRatio));
  console.log(`   佣金区间 ${(Math.min(...fee) * 10000).toFixed(2)}万 ~ ${(Math.max(...fee) * 10000).toFixed(2)}万（极差 ${(Math.max(...fee) / Math.min(...fee)).toFixed(1)} 倍）`);
  console.log(`   券源区间 ${Math.round(Math.min(...lend) * 100)}% ~ ${Math.round(Math.max(...lend) * 100)}%（极差 ${(Math.max(...lend) / Math.min(...lend)).toFixed(2)} 倍）`);
  console.log(`   杠杆区间 ${Math.min(...L).toFixed(2)}x ~ ${Math.max(...L).toFixed(2)}x（极差 ${(Math.max(...L) / Math.min(...L)).toFixed(2)} 倍）`);
  const heavy = keys.filter((k) => V[k].crowd.tier === 'heavy');
  console.log(`   重罚档：${heavy.join('、')} —— 它们的天生优势被压回去，但仍在可玩区间（佣金最贵也只有最低的 ${(Math.max(...fee) / Math.min(...fee)).toFixed(1)} 倍）`);
}

console.log('\n================ 校验完成 ================\n');

/** erf 近似（Abramowitz & Stegun 7.1.26），够算尾部概率 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}
