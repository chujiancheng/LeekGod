/**
 * 彩蛋（里程碑）判定内核 —— 见 Doc/彩蛋玩法方案.md
 *
 * 定位：**观测层，不是机制层**。所有判定只读账户快照（收盘权益 / 风险度 / 强平通知），
 * 绝不回写任何交易状态。任何一个彩蛋玩法的失败，都不应该能影响一次撮合的结果。
 *
 * 三条口径（方案 §2）：
 * ① 硬门槛一律按**收盘结算权益**判定，由 `Game.settleDay`（含跨天兜底路径
 *    `ensureDaySettled`）调用 `evaluateClose`——一天一次、顺序确定、重启可复现；
 * ② 权益必须与服务端 `stateFor` 下发的是**同一个数**：调用方传进来的就是 `game.equityOf`，
 *    这里不再自己乘价格（两边各算一遍必然差几毛钱，然后玩家投诉"我明明够 500 万了"）；
 * ③ **NPC 一律不参与**（3160 个账户）——调用方只遍历 `store.players()`。
 *
 * 幂等：每个 id 只触发一次（`fired` 落盘），重启不重放；`seq` 也落盘，
 * 否则重启后从头计数，客户端存着的 lastSeq 会把它永远挡在门外。
 *
 * 状态结构（挂在 Account.milestones 上，只有玩家有）：
 *   { seq, fired[], titles[], events[], peakEquity, maxDrawdown, dayEvaluated, liqDay }
 * 其中 `events` 是**滚动窗口**（只给客户端拿去去重播放），不必落盘。
 */
const config = require('./config');

const r4 = (v) => Math.round(v * 10000) / 10000;

/** 稀有度：数值越大越稀有。事件队列与称号展示都按它排序 */
const RARITY_RANK = { common: 0, rare: 1, epic: 2, legend: 3 };
const RARITY_LABEL = { common: '普通', rare: '稀有', epic: '史诗', legend: '传说' };

/**
 * 吉祥物（股神猫）表情的 key 集合。这 4 张是**现成素材**（`gushen-mascot_assets/`），
 * 已裁掉水印并缩到 96px 放进 `Client/img/egg-cat-<key>-96.png`（由 http.js 白名单托管）。
 * 方案 §6 想配的「得意/惊恐/呆滞/哭」四表情里，惊恐与哭还没有素材，P1 补画。
 */
const MASCOT_KEYS = ['smug', 'chill', 'pro', 'vest'];

/**
 * 文案库：三档基调 × 全部彩蛋 id（方案 §6）。
 *
 * `savage`（毒舌，默认）与项目整体语气一致（谐音券商、讽刺原型公司）；
 * `gentle`（安慰）在权益跌破 `gentleBelowEquity` 后自动接管崩盘/爆仓类；
 * `deadpan`（面瘫）只报事实。
 */
const TEXT = {
  savage: {
    A01: '出关了。第一个 10% 落袋，猫给你记一笔。',
    A02: '五十个点。运气也算能力的一部分，暂且算你有。',
    A03: '翻倍了。冷静点——翻倍的人最爱说「我本来还能赚更多」。',
    A04: '三百万。这个数最危险：它让你觉得杠杆是个好东西。',
    A05: '半个千万。恭喜，你现在比 90% 的人更会吹牛了。',
    A06: '八百万。离千万只差两个跌停，刺激吧？',
    A07: '千万身家。猫提醒你：这个数在港股只够买半层楼。',
    A08: '两千万。要么继续，要么落袋——反正你两个都不会选。',
    A09: '准亿。离小目标还差一半。别停，猫在看着。',
    A10: '一个小目标，达成。从今天起你的对手只剩你自己。',
    A11: '三个小目标。这个服务器已经装不下你了。',
    A12: '十亿。你就是股神——猫跪着说的。',
    'B1-01': '亏了。关灯吃面，猫也在陪你。',
    'B1-02': '七折。你成了别人眼里的促销品。',
    'B1-03': '腰斩。建议把持仓截图留着，以后教育孩子。',
    'B1-04': '三折。这个折是你自己打的，跟别人没关系。',
    'B1-05': '回到起点了。方向反了，但这一路你走得很努力。',
    'B1-06': '一万元户。恭喜返祖，回到二十年前的荣光。',
    'B1-07': '还剩一千块。猫不知道该夸你精准还是骂你精准。',
    'B1-08': '本服第一位亲手把自己打成负资产的勇士已诞生——敬礼。',
    'B2-01': '回吐三成。赚过的钱不是你的，是市场借你玩两天的。',
    'B2-02': '回撤一半。一夜回到解放前，解放得挺快。',
    'B2-03': '蒸发七成。你证明了财富是可以凭空消失的。',
    'B2-04': '从 Billionaire 到 Beggar，你只用了几天。',
    C00: '券商风控开始注意你了。这是表扬，也是通知。',
    C01: '擦边过关。差一点就没了——去谢谢那个没成交的对手盘。',
    C02: '天台排队，前面还有 3 个。券商帮你止损了，不客气。',
  },
  gentle: {
    A01: '出了第一步，稳住节奏比什么都重要。',
    A02: '赚了 50%，很不错的开始。',
    A03: '翻倍了。别急着放大仓位，慢就是快。',
    A04: '三百万。这个阶段最该做的是控制回撤。',
    A05: '五百万。记得给自己留一点安全垫。',
    A06: '八百万。稳扎稳打，千万只是时间问题。',
    A07: '千万身家。恭喜，也请记住你是怎么走到这里的。',
    A08: '两千万。适当分散，别把身家押在一只票上。',
    A09: '五千万。已经很少有人能跟上你了。',
    A10: '一个小目标。了不起——现在保护它比赚到它更重要。',
    A11: '三个小目标。你已经不需要向任何人证明了。',
    A12: '十亿。实至名归。',
    'B1-01': '回撤是交易的一部分，先看看交易逻辑有没有变。',
    'B1-02': '亏了三成。停下来复盘，别急着翻本。',
    'B1-03': '腰斩了。仓位管理比选股更重要，这一课很贵。',
    'B1-04': '只剩下三成。把杠杆降下来，先活下去。',
    'B1-05': '回到起点了。本金还在，就还有机会。',
    'B1-06': '只剩一万元。歇一歇吧，别拿情绪下单。',
    'B1-07': '账户快要见底了。先停手，别再往里加杠杆。',
    'B1-08': '账户已经为负。券商会在事后与你联系，别慌。',
    'B2-01': '回撤三成。这是提醒，不是判决。',
    'B2-02': '回撤一半。深呼吸，先别做任何决定。',
    'B2-03': '回撤七成。活下来比赚回来更优先。',
    'B2-04': '回撤九成。先离开盘面一会儿，真的。',
    C00: '券商注意到你的风险度了，适当降一点杠杆。',
    C01: '擦边过关。刚才很危险，建议补一点保证金。',
    C02: '券商帮你止损了。别难过，重新开始就好。',
  },
  deadpan: {
    A01: '收盘权益 ≥ 110 万。',
    A02: '收盘权益 ≥ 150 万。',
    A03: '收盘权益 ≥ 200 万。',
    A04: '收盘权益 ≥ 300 万。',
    A05: '收盘权益 ≥ 500 万。',
    A06: '收盘权益 ≥ 800 万。',
    A07: '收盘权益 ≥ 1000 万。',
    A08: '收盘权益 ≥ 2000 万。',
    A09: '收盘权益 ≥ 5000 万。',
    A10: '收盘权益 ≥ 1 亿。',
    A11: '收盘权益 ≥ 3 亿。',
    A12: '收盘权益 ≥ 10 亿。',
    'B1-01': '收盘权益 ≤ 90 万。',
    'B1-02': '收盘权益 ≤ 70 万。',
    'B1-03': '收盘权益 ≤ 50 万。',
    'B1-04': '收盘权益 ≤ 30 万。',
    'B1-05': '收盘权益 ≤ 10 万。',
    'B1-06': '收盘权益 ≤ 1 万。',
    'B1-07': '收盘权益 ≤ 1000 元。',
    'B1-08': '收盘权益 ≤ 0。',
    'B2-01': '距峰值回撤 ≥ 30%。',
    'B2-02': '距峰值回撤 ≥ 50%。',
    'B2-03': '距峰值回撤 ≥ 70%。',
    'B2-04': '距峰值回撤 ≥ 90%。',
    C00: '收盘风险度 ≥ 80%。',
    C01: '收盘风险度 ≥ 95%，未强平。',
    C02: '已强制平仓。',
  },
};

/**
 * 吉祥物（股神猫）表情：现有 4 张素材按「族 + 稀有度」映射，不是按 id 特判。
 * wealth=得意（金币与上行箭头）/ crash=淡定（抱着图表卷）/ crash 传说=反思（看 K 线）
 * / liquidation=公事公办（眼镜领带，券商上门）。
 */
function mascotOf(entry) {
  if (entry.kind === 'wealth') return 'smug';
  if (entry.kind === 'liquidation') return 'pro';
  return entry.rarity === 'legend' ? 'vest' : 'chill';
}

/** 新账户的里程碑状态。`peakEquity: null` 表示还没初始化——绝不能当成 0 */
function emptyState() {
  return {
    seq: 0,
    fired: [],
    titles: [],
    events: [],
    peakEquity: null,
    maxDrawdown: 0,
    dayEvaluated: 0,
    liqDay: 0,
  };
}

/** 从存档的 JSON 列重建（坏了就当新账户，不让一条脏数据卡住登录） */
function parse(json) {
  const s = emptyState();
  if (!json || typeof json !== 'object') return s;
  if (typeof json.seq === 'number' && json.seq > 0) s.seq = Math.floor(json.seq);
  if (Array.isArray(json.fired)) s.fired = json.fired.filter((x) => typeof x === 'string');
  if (Array.isArray(json.titles)) {
    s.titles = json.titles.filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string');
  }
  if (typeof json.peakEquity === 'number' && json.peakEquity > 0) s.peakEquity = json.peakEquity;
  if (typeof json.maxDrawdown === 'number' && json.maxDrawdown > 0) s.maxDrawdown = json.maxDrawdown;
  if (typeof json.dayEvaluated === 'number' && json.dayEvaluated > 0) s.dayEvaluated = Math.floor(json.dayEvaluated);
  if (typeof json.liqDay === 'number' && json.liqDay > 0) s.liqDay = Math.floor(json.liqDay);
  return s;
}

/** 落盘用：eventQueue 是纯下发用的滚动窗口，不进存档 */
function serialize(state) {
  return JSON.stringify({
    seq: state.seq,
    fired: state.fired,
    titles: state.titles,
    peakEquity: state.peakEquity,
    maxDrawdown: state.maxDrawdown,
    dayEvaluated: state.dayEvaluated,
    liqDay: state.liqDay,
  });
}

/**
 * 老档/新号的第一次初始化：`peakEquity` 取**当前权益**。
 * 取 0 会让老玩家一进来就"回撤 100%"（方案 §4.3）。
 */
function initPeak(state, equity) {
  if (state.peakEquity == null && Number.isFinite(equity)) state.peakEquity = equity;
  return state.peakEquity;
}

/** 软着陆（§12 D2）：权益跌破门槛后，崩盘/爆仓类文案强制降级 gentle */
function toneFor(entry, equity) {
  const c = config.milestones || {};
  const tone = c.tone || 'savage';
  if (entry.kind === 'crash' || entry.kind === 'liquidation') {
    const soft = c.gentleBelowEquity || 0;
    if (soft > 0 && Number.isFinite(equity) && equity < soft) return 'gentle';
  }
  return TEXT[tone] ? tone : 'savage';
}

function textOf(entry, tone) {
  const pool = TEXT[tone] || TEXT.savage;
  return pool[entry.id] || TEXT.savage[entry.id] || `「${entry.title}」`;
}

/** 事件对象：客户端靠 `seq` 去重（`liquidations` 那种"比数组长度"会在 20 条截断后静默丢事件） */
function emit(state, entry, ctx) {
  const max = Math.max(1, (config.milestones || {}).eventQueueMax || 5);
  state.fired.push(entry.id);
  state.seq += 1;
  const ev = {
    id: entry.id,
    seq: state.seq,
    day: ctx.day || 0,
    t: ctx.now || 0,
    kind: entry.kind,
    level: entry.level,
    rarity: entry.rarity,
    title: entry.title,
    text: textOf(entry, toneFor(entry, ctx.equity)),
    mascot: mascotOf(entry),
  };
  if (entry.title) {
    state.titles.push({ id: entry.id, title: entry.title, rarity: entry.rarity, level: entry.level, day: ctx.day || 0 });
  }
  state.events.push(ev);
  // 队列超出上限丢**旧**的：一天跨多档时留下的正好是最高的那几档
  if (state.events.length > max) state.events.splice(0, state.events.length - max);
  return ev;
}

/**
 * 收盘评估：唯一判定入口，由 `Game.settleDay` 对每个**玩家**账户调一次。
 *
 * @param {object} state  Account.milestones（原地更新）
 * @param {{equity:number, marginUsage:number|null, day:number, now:number}} ctx
 * @returns {object[]} 本次新触发的事件（升序：低档在前）
 */
function evaluateClose(state, ctx) {
  const c = config.milestones || {};
  if (!c.enabled) return [];
  const day = ctx.day || 0;
  // 同一个收盘日只评估一次：常规结算与跨天补结算都会走到这里（`ensureDaySettled`），
  // `dayEvaluated` 落盘，所以重启也不会把同一天重放一遍
  if (day > 0 && state.dayEvaluated === day) return [];
  const equity = ctx.equity;
  initPeak(state, equity);
  const fired = new Set(state.fired);
  const hit = [];

  // A 族：升序取全部未触发且达标的档（停机多日后补结算可能一次跨好几档）
  for (const e of c.wealth || []) {
    if (!fired.has(e.id) && equity >= e.equity) hit.push({ ...e, kind: 'wealth' });
  }
  // B1 族：绝对水位跌破
  for (const e of c.absolute || []) {
    if (!fired.has(e.id) && equity <= e.equity) hit.push({ ...e, kind: 'crash' });
  }

  // 水位线与回撤（peakEquity 单调不减）
  if (equity > state.peakEquity) state.peakEquity = equity;
  const dd = state.peakEquity > 0 ? Math.max(0, 1 - equity / state.peakEquity) : 0;
  if (dd > state.maxDrawdown) state.maxDrawdown = dd;

  // B2 族：越过哪档就发哪档。**不做"整族上闸"**——`fired` 已经保证每个 id 只发一次，
  // 再叠一道"回到距峰值 10% 以内才重新武装"的闸门，唯一的效果是把**首次越过的更高档**
  // 一起压掉：一段持续下跌里只剩第一档能播，B2-03/B2-04 几乎不可达。
  // （2026-10-17 修正：原 `drawdownArmed` 闸门与 §2.4「fired 是幂等键」重复且有害）
  for (const e of c.drawdown || []) {
    if (!fired.has(e.id) && dd >= e.pct / 100) hit.push({ ...e, kind: 'crash' });
  }

  // C 族 · 预警 / 擦边（收盘风险度，口径与 `stateFor` 下发的是同一个数）
  const mu = ctx.marginUsage;
  for (const e of c.liquidation || []) {
    if (e.kind !== 'nearMargin') continue;
    // C01「擦边过关」的口径是「≥95% 且**没爆**」：当天已经被强平过的人不该再收到这句
    if (e.noLiquidationToday && day > 0 && state.liqDay === day) continue;
    if (Number.isFinite(mu) && mu >= e.marginUsage && !fired.has(e.id)) hit.push({ ...e, kind: 'liquidation' });
  }

  if (day > 0) state.dayEvaluated = day;
  const events = [];
  for (const e of hit) events.push(emit(state, e, ctx));
  return events;
}

/**
 * 强平落地（C02 首次被强平）：由 `Market.maybeLiquidate` 通过 `onLiquidate` 钩子上报。
 * 这是**事件驱动**的一条，不走收盘判定——爆仓可能发生在一天里的任何时刻。
 */
function onLiquidation(state, ctx) {
  const c = config.milestones || {};
  if (!c.enabled) return [];
  const day = ctx.day || 0;
  // 记下"这一天爆过仓"：C01「擦边过关」的口径是「≥95% 且没爆」，当天已爆就不该再发。
  // 第二次及以后的强平不会产生事件（每类只给一次），但这个标记每次都要更新
  if (day > 0) state.liqDay = day;
  const fired = new Set(state.fired);
  const events = [];
  initPeak(state, ctx.equity);
  for (const e of c.liquidation || []) {
    if (e.kind !== 'firstLiq' || fired.has(e.id)) continue;
    events.push(emit(state, { ...e, kind: 'liquidation' }, ctx));
  }
  return events;
}

/** 当前展示的称号：稀有度最高、同档取最新获得的那一个 */
function pickTitle(titles) {
  let best = null;
  for (const t of titles) {
    if (!best) {
      best = t;
      continue;
    }
    const a = RARITY_RANK[t.rarity] || 0;
    const b = RARITY_RANK[best.rarity] || 0;
    if (a >= b) best = t;
  }
  return best;
}

/**
 * 下一档发家线的进度（顺手送的大礼：主页可以直接画进度条，
 * 彩蛋就从"随机惊喜"变成"可追求的目标"）。
 * `reached = true` 表示已越过门槛、等收盘结算确认。
 */
function progressOf(state, equity, initialCash) {
  const fired = new Set(state.fired);
  let from = Number.isFinite(initialCash) ? initialCash : 0;
  for (const e of (config.milestones || {}).wealth || []) {
    if (fired.has(e.id)) {
      from = e.equity;
      continue;
    }
    const span = Math.max(1, e.equity - from);
    const pct = Math.max(0, Math.min(1, (equity - from) / span));
    return {
      id: e.id,
      title: e.title,
      equity: e.equity,
      from,
      need: Math.max(0, r4(e.equity - equity)),
      pct: r4(pct),
      reached: equity >= e.equity,
    };
  }
  return null; // 12 档全亮
}

/** 下发给客户端的 `account.eggs` 段 */
function summary(state, opts = {}) {
  const c = config.milestones || {};
  const equity = opts.equity;
  const peak = state.peakEquity == null ? equity : state.peakEquity;
  const dd = peak > 0 ? Math.max(0, 1 - equity / peak) : 0;
  return {
    enabled: !!c.enabled,
    seq: state.seq,
    // 最近若干条（客户端按 seq 去重播放）。**不是**"未读队列"——没有 ack 接口，
    // 靠的是客户端把 lastSeq 存进 localStorage
    events: state.events.slice(),
    count: state.titles.length,
    titles: state.titles.slice(),
    title: pickTitle(state.titles),
    peakEquity: Math.round(peak * 100) / 100,
    drawdown: r4(dd),
    maxDrawdown: r4(state.maxDrawdown),
    progress: progressOf(state, equity, opts.initialCash),
  };
}

/**
 * 风险度（%）= （空头市值 + 融资负债 + 做空欠息）/ 权益 × 100。
 * **单一落点**：`Game.serializeAccount` 下发的 `marginUsage` 与彩蛋判定读的是同一个函数，
 * 各算一遍必然差几分，然后玩家投诉"我明明 95% 了为什么没弹擦边"。
 */
function marginUsageOf(equity, shortValue, riskDebt) {
  if (!(riskDebt > 0) || !(equity > 0)) return 0;
  return Math.round(((shortValue + riskDebt) / equity) * 10000) / 100;
}

module.exports = {
  RARITY_RANK,
  RARITY_LABEL,
  MASCOT_KEYS,
  TEXT,
  emptyState,
  parse,
  serialize,
  initPeak,
  evaluateClose,
  onLiquidation,
  summary,
  progressOf,
  marginUsageOf,
  mascotOf,
};
