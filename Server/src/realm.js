/**
 * 修仙境界（头衔）判定内核 —— 见 Doc/头衔方案.md
 *
 * 定位：**观测层的第二块屏幕**。彩蛋回答"你刚做成了什么"（瞬时事件），
 * 境界回答"你现在是谁"（持续身份）。零数值特权，绝不回写任何交易状态。
 *
 * 四条口径（方案 §4）：
 * ① 门槛一律按**收盘权益**判定，由 `Game.evaluateMilestones`（收盘结算，含跨天兜底
 *    `ensureDaySettled`）调用，与彩蛋**同一个 equity 变量**——两边各算一遍必然差几毛；
 * ② 升境/跌境都**不进 `fired`**：跌境后重新破境是正常玩法，同一个 id 必须能再播。
 *    事件只借 milestones 的 `seq` 与滚动队列（`emitTransient`），客户端零改动；
 * ③ 历史最高境界**不新增字段**：用彩蛋已有的 `peakEquity`（单调不减的收盘峰值）反推；
 * ④ 跌境有 3% 缓冲 + 单日最多降 3 档（方案 §4.3），否则门槛横盘会天天来回播。
 *
 * 状态（挂在 Account.milestones 上，与彩蛋共用同一个 JSON 列，**零 schema 变更**）：
 *   { realmIdx, realmDay }
 * `realmIdx === null` 表示从没判过（新号 / 老档）——首次结算时**静默落位**，不播事件。
 */
const config = require('./config');
const milestones = require('./milestones');

/** 凡骨：低于第一档（90 万）的唯一状态。不是"第 0 档"，是"还没入道" */
const MORTAL = { key: 'mortal', name: '凡骨', honor: '凡骨', tone: 'mortal' };

const CFG = config.realm || {};
const GROUPS = Array.isArray(CFG.groups) ? CFG.groups : [];
const GROUP_BY_KEY = new Map(GROUPS.map((g) => [g.key, g]));

/** 稀有度：按大境界定档，破境横幅的配色与队列排序都吃它 */
const RARITY_OF_GROUP = {
  lianqi: 'common',
  zhuji: 'common',
  jindan: 'rare',
  yuanying: 'epic',
  huashen: 'legend',
  lianxu: 'legend',
  heti: 'legend',
  dacheng: 'legend',
  dujie: 'legend',
};

/**
 * 阶梯（1-based：`ladder[0]` 是第 1 档"炼气一层"）。
 * require 时校验一次：配错了应该在启动时直接炸，而不是让玩家看到 39 名开外的境界。
 */
const LADDER = (Array.isArray(CFG.ladder) ? CFG.ladder : []).map((t, k) => ({ ...t, i: k + 1 }));
(function validate() {
  if (!LADDER.length) return;
  LADDER.forEach((t, k) => {
    if (!GROUP_BY_KEY.has(t.group)) {
      throw new Error(`config.realm.ladder[${k}] 的 group「${t.group}」不在 config.realm.groups 里`);
    }
    if (!(t.equity > 0)) throw new Error(`config.realm.ladder[${k}] 缺少合法的 equity`);
    if (k > 0 && !(t.equity > LADDER[k - 1].equity)) {
      throw new Error(`config.realm.ladder 必须严格升序（第 ${k + 1} 档 ${t.equity} 不大于上一档）`);
    }
  });
  if (CFG.startIdx != null && !(CFG.startIdx >= 0 && CFG.startIdx <= LADDER.length)) {
    throw new Error(`config.realm.startIdx ${CFG.startIdx} 越界`);
  }
  // `RARITY_OF_GROUP` 是 group key 的第二处引用：新增大境界却忘了定稀有度，
  // 破境横幅会静默退化成 common（灰边），很难在真机上发现——配错就炸
  const noRarity = GROUPS.filter((g) => !RARITY_OF_GROUP[g.key]).map((g) => g.key);
  if (noRarity.length) throw new Error(`config.realm.groups 缺少稀有度定义：${noRarity.join(', ')}`);
})();

const TOTAL = LADDER.length;
const r4 = (v) => Math.round(v * 10000) / 10000;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 钱数的人话：亿 / 万 / 元（服务端文案用，前端有自己的 fmtAmount） */
function fmtMoney(v) {
  const n = Math.abs(v || 0);
  const sign = v < 0 ? '-' : '';
  if (n >= 1e8) return sign + trimZero((n / 1e8).toFixed(2)) + ' 亿';
  if (n >= 1e4) return sign + trimZero((n / 1e4).toFixed(2)) + ' 万';
  return sign + Math.round(n) + ' 元';
}
const trimZero = (s) => s.replace(/\.?0+$/, '');

/** 档位对象：0 = 凡骨，1..N = 阶梯（越界一律夹住，配置缩表也不会让老档崩掉） */
function tierOf(idx) {
  if (!(idx > 0)) return MORTAL;
  const t = LADDER[Math.min(idx, TOTAL) - 1];
  return t || MORTAL;
}

/** 大境界元数据（凡骨有自己的伪 group） */
function groupOf(key) {
  if (key === MORTAL.key) return MORTAL;
  return GROUP_BY_KEY.get(key) || { key: key || 'mortal', name: '', honor: '', tone: 'mortal' };
}

/**
 * 权益 → 档位序号（二分）。返回 0..TOTAL；0 = 凡骨。
 * **唯一换算入口**：判定、下发、排行榜都走它，不许任何地方再写一条 if-else 链。
 */
function idxOf(equity) {
  if (!Number.isFinite(equity)) return 0;
  let lo = 0;
  let hi = TOTAL;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (LADDER[mid].equity <= equity) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 下一档的门槛（没有下一档返回 null） */
function nextTier(idx) {
  return idx < TOTAL ? LADDER[idx] : null;
}

/**
 * 首次落位（新号 / 老档）：按当前权益静默设定，**不播事件**。
 * 与彩蛋 `initPeak` 同一条思路——老玩家不该一进来就被"你已突破到结丹"糊脸。
 */
function initState(state, equity, day) {
  if (!state) return null;
  if (state.realmIdx == null || !(state.realmIdx >= 0)) {
    state.realmIdx = idxOf(equity);
    if (day > 0) state.realmDay = day;
  }
  return state.realmIdx;
}

/** 当前已确认境界（未初始化时按实时权益临时算，不写回） */
function currentIdx(state, equity) {
  if (state && state.realmIdx != null && state.realmIdx >= 0) return state.realmIdx;
  return idxOf(equity);
}

/**
 * 下发给客户端的 `account.realm`（方案 §5.1）。
 * 徽标显示的永远是**已确认境界**；盘中越过下一档只用 `pending` 提示，
 * 真正的破境动画在收盘那一刻发生（否则门槛上横盘会闪上百次）。
 */
function view(state, opts = {}) {
  const equity = Number.isFinite(opts.equity) ? opts.equity : 0;
  // 夹住：配置缩表后老档里的 realmIdx 可能越界，显示层不能因此崩
  const idx = Math.min(currentIdx(state, equity), TOTAL);
  const t = tierOf(idx);
  const g = groupOf(t.group);
  const next = idx < TOTAL ? LADDER[idx] : null;
  const from = idx > 0 ? tierOf(idx).equity : 0;
  const span = next ? Math.max(1, next.equity - from) : 1;
  const peakEq = state && Number.isFinite(state.peakEquity) ? state.peakEquity : equity;
  const peakIdx = idxOf(peakEq);
  const buffer = Number.isFinite(CFG.demoteBuffer) ? CFG.demoteBuffer : 0.03;
  return {
    idx,
    name: t.name,
    short: t.short || '',
    honor: g.honor,
    group: t.group,
    equity,
    total: TOTAL,
    peak: { idx: peakIdx, name: tierOf(peakIdx).name },
    // 峰值权益单列一份：主页卡要用，别让它去翻 `account.events.peakEquity`——
    // 彩蛋关掉时那个字段根本不下发，卡片会退化成显示当前权益
    peakEquity: Math.round(peakEq * 100) / 100,
    next: next
      ? {
          idx: next.i,
          name: next.name,
          equity: next.equity,
          need: Math.max(0, r4(next.equity - equity)),
          pct: r4(clamp01((equity - from) / span)),
        }
      : null,
    pct: next ? r4(clamp01((equity - from) / span)) : 1,
    // 盘中已越过下一档门槛，等收盘结算确认
    pending: !!(next && equity >= next.equity),
    // 已经踩进跌境缓冲带（收盘若还在这儿就会掉境）——徽标只换个颜色，不判
    dropping: idx > 0 && equity < t.equity * (1 - buffer),
    changedDay: state && state.realmDay != null ? state.realmDay : null,
  };
}

/** 排行榜/股东榜用的精简版（不带进度，字段越小越好） */
function brief(state, equity) {
  if (!state) return null;
  const idx = currentIdx(state, equity);
  const t = tierOf(idx);
  return { idx, name: t.name, short: t.short || '', group: t.group, honor: groupOf(t.group).honor };
}

/** 规则面板要的整表（只在首屏 /api/state 下发，增量帧不带） */
function ladderForClient() {
  const dep = (config.account && config.account.deposit) || {};
  const cap = Number.isFinite(dep.maxLifetime) ? dep.maxLifetime : null;
  return {
    mortal: MORTAL,
    groups: GROUPS,
    ladder: LADDER.map((t) => ({ i: t.i, group: t.group, name: t.name, short: t.short, equity: t.equity })),
    // 这三条给规则面板的说明文字用：**前端不许再写死 3% / 3 档 / 1 亿**，
    // 改配置时说明页要跟着变（与"交易日六段表走服务端下发"同一条规矩）
    demoteBuffer: Number.isFinite(CFG.demoteBuffer) ? CFG.demoteBuffer : 0.03,
    demoteMaxPerDay: Number.isFinite(CFG.demoteMaxPerDay) ? CFG.demoteMaxPerDay : 3,
    depositCap: cap,
    depositCapTier: cap == null ? null : tierOf(idxOf(cap)).name,
  };
}

function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

/**
 * 文案基调：与彩蛋共用 `milestones.tone`，并沿用同一条软着陆规则
 * （权益跌破 `gentleBelowEquity` 后，跌境类强制 gentle——亏到只剩一成的人不需要嘲讽）。
 */
function toneFor(dir, equity) {
  const m = config.milestones || {};
  const tone = m.tone || 'savage';
  const soft = m.gentleBelowEquity || 0;
  if (dir === 'down' && soft > 0 && Number.isFinite(equity) && equity < soft) return 'gentle';
  return tone === 'gentle' || tone === 'deadpan' ? tone : 'savage';
}

/** 破境 / 跌境的一条事件（结构对齐彩蛋事件，客户端同一套队列与横幅） */
function makeEvent(dir, prevIdx, nextIdx, equity, day) {
  const to = tierOf(nextIdx);
  const from = tierOf(prevIdx);
  const crossedGroup = to.group !== from.group;
  const tone = toneFor(dir, equity);
  const t = CFG.text || {};
  let title;
  let text;
  let level;
  let mascot;

  if (dir === 'up') {
    title = `破境 · ${to.name}`;
    level = nextIdx === TOTAL ? 'L4' : crossedGroup ? 'L3' : 'L2';
    mascot = nextIdx === TOTAL ? 'vest' : 'smug';
    if (tone === 'deadpan') text = `收盘权益 ≥ ${fmtMoney(to.equity)}（${to.name}）。`;
    else if (tone === 'gentle' || !(t.up && t.up[nextIdx])) {
      text =
        tone === 'gentle'
          ? `已到${to.name}。稳住节奏，比冲得更快重要。`
          : `破境：${to.name}（${groupOf(to.group).honor}），收盘权益 ${fmtMoney(equity)}。`;
    } else {
      text = t.up[nextIdx];
    }
  } else {
    const jumped = prevIdx - nextIdx;
    title = nextIdx === 0 ? '道基已碎' : `跌境 · ${to.name}`;
    level = nextIdx === 0 ? 'L2' : 'L1';
    mascot = 'chill';
    // `equity` 已带单位（万 / 亿 / 元），文案里**不许再写"元"**，否则会读成"还剩 60 万 元"。
    // `debt` 是绝对值：`fmtMoney(-5 万)` 会带负号，直接填进"倒欠券商 {debt}"会成"倒欠 -5 万"
    const vars = { from: from.name, to: to.name, n: jumped, equity: fmtMoney(equity), debt: fmtMoney(Math.abs(equity)) };
    if (tone === 'deadpan') {
      text = `收盘权益低于 ${fmtMoney(from.equity)}（跌至${to.name}）。`;
    } else if (nextIdx === 0 && equity < 0 && t.mortalDebt) {
      // 倒欠券商的人不能听"本金还有机会重新长出来"——那是假话。先说清楚欠了多少，
      // 再谈机会。这一条**优先于 gentle**，否则永远被软着陆挡在前面（负权益必然 < 软着陆线）
      text = fill(t.mortalDebt, vars);
    } else if (tone === 'gentle') {
      text = nextIdx === 0 ? '道基碎了，本金还有机会重新长出来。' : `回到${to.name}了。先降杠杆，活下来最重要。`;
    } else if (nextIdx === 0) {
      text = fill((t.down && t.down.mortal) || '道基已碎。', vars);
    } else {
      text = fill(jumped > 1 ? (t.down && t.down.many) || '一日跌{n}境。' : (t.down && t.down.one) || '跌境了：{from} → {to}。', vars);
    }
  }

  return {
    // id 不是幂等键（境界不进 fired），只用于日志与调试。方向 + 目标档位即可读
    id: `R${dir === 'up' ? '+' : '-'}${nextIdx}`,
    dir,
    title,
    text,
    level,
    kind: 'realm',
    rarity: dir === 'up' ? RARITY_OF_GROUP[to.group] || 'common' : nextIdx === 0 ? 'rare' : 'common',
    mascot,
    // 横幅左边线按大境界上色（客户端用 CSSOM 写 `--rtone`）
    realmGroup: to.group,
    fromIdx: prevIdx,
    toIdx: nextIdx,
  };
}

/**
 * 收盘评估：由 `Game.evaluateMilestones` 对每个**玩家**账户调一次（NPC 一个都不判）。
 *
 * @param {object} state Account.milestones（原地更新）
 * @param {{equity:number, day:number, now:number}} ctx
 * @returns {{events:object[], quietIds:string[]}}
 *   `quietIds` = 今天要走"合并播报"的彩蛋 id（门槛与本次破境档位对齐的那几个）——
 *   调用方把它传给 `milestones.evaluateClose`，彩蛋照记 fired 与称号，只是不再单独发横幅。
 */
function evaluateClose(state, ctx = {}) {
  const empty = { events: [], quietIds: [] };
  if (!CFG.enabled || !state) return empty;
  const equity = ctx.equity;
  if (!Number.isFinite(equity)) return empty;
  const day = ctx.day || 0;

  // 水位线：历史最高境界由 `peakEquity` 反推（不新增字段）。这里顺手也抬一次——
  // 彩蛋关掉时 `milestones.evaluateClose` 不会跑，peak 就永远停在开户那一刻，
  // 「历史最高」会退化成当前境界。同一个包络表达式，两处写同一个数不会打架
  if (!Number.isFinite(state.peakEquity) || equity > state.peakEquity) state.peakEquity = equity;

  // 首次落位（新号开户 / 老档升级）：静默，不播事件
  if (state.realmIdx == null || !(state.realmIdx >= 0)) {
    initState(state, equity, day);
    return empty;
  }

  // 同一个收盘日只判一次：`settleDay` 的收盘段与夜间段都会走到这里，
  // 两段之间价格是冻结的，但**别指望它永远冻结**——判两次就可能把同一档破境播两遍
  if (day > 0 && state.realmDay === day) return empty;

  const prev = Math.min(state.realmIdx, TOTAL);
  const target = idxOf(equity);
  if (target === prev) return empty;

  let next = target;
  if (target < prev) {
    // 跌境缓冲：没跌破门槛 3% 就当没发生（门槛上横盘不播）
    const line = tierOf(prev).equity * (1 - (Number.isFinite(CFG.demoteBuffer) ? CFG.demoteBuffer : 0.03));
    if (equity >= line) return empty;
    // 单日降幅上限：一路跌境是连续剧，一次性跳 12 级像 bug
    const cap = Number.isFinite(CFG.demoteMaxPerDay) ? CFG.demoteMaxPerDay : 3;
    next = Math.max(target, prev - cap);
  }

  state.realmIdx = next;
  if (day > 0) state.realmDay = day;

  const ev = makeEvent(next > prev ? 'up' : 'down', prev, next, equity, day);
  const event = milestones.emitTransient(state, ev, ctx);

  // 合并播报：本次升到的档位若挂着彩蛋 id，压掉彩蛋那条独立事件
  const quietIds = next > prev && LADDER[next - 1] && LADDER[next - 1].egg ? [LADDER[next - 1].egg] : [];
  return { events: event ? [event] : [], quietIds };
}

module.exports = {
  MORTAL,
  LADDER,
  TOTAL,
  idxOf,
  tierOf,
  groupOf,
  initState,
  currentIdx,
  view,
  brief,
  ladderForClient,
  evaluateClose,
  fmtMoney,
};
