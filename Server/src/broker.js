/**
 * 券商（出身门派）——**纯函数层**。
 *
 * 这一层不持有任何状态，只回答四类问题：
 *   ① 某账户此刻的**有效配置**是多少（两级兜底：broker 覆盖 → 全局默认）；
 *   ② 声誉星级 / 每周之星 / 拥挤税 怎么算；
 *   ③ 转户能不能办、要花多少；
 *   ④ NPC 的券商怎么按账户名确定性派生（不落盘）。
 *
 * 之所以抽成纯函数：拥挤税与星级是平衡的命门，必须能离线调参、可复现、可写单测
 * （Doc/券商方案.md §9 D3）。market / npc / auto / game 只读这里的结果，不各自算一遍。
 *
 * **方向规则（本文件最重要的一条）**：
 * 特权按声誉星级「1/4 递进」，代价立刻全量生效。判断标准是**这个值相对全局基准是好是坏**——
 * 好（钟信的 40% 自备比例）慢慢解锁；坏（滑泰的 60% 自备比例）第一天就照单全收。
 * 不做这个方向判断的话，滑泰玩家会「越升级借钱越少」，逻辑反了。
 */
const config = require('./config');

function cfgRoot() {
  return config.brokers || {};
}

function list() {
  const root = cfgRoot();
  return Object.values((root && root.list) || {});
}

function keys() {
  return Object.keys((cfgRoot().list) || {});
}

function get(key) {
  const root = cfgRoot();
  return (root && root.list && root.list[key]) || null;
}

function has(key) {
  return !!get(key);
}

// ------------------------------------------------------------------
// 确定性哈希（NPC 券商归属 / L0 内幕身份共用）
// ------------------------------------------------------------------

/** murmur3 的 32 位雪崩收尾：FNV-1a 单独用在这些高度相似的账户名上会塌成尖峰 */
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 确定性哈希 → [0,1)。同一个字符串永远得到同一个数。
 *
 * **收尾那一趟 fmix32 不能省**：账户名形如 `大米·机构1`…`大米·散户220`，彼此只差
 * 末尾几个数字。裸 FNV-1a 在这类输入上分布会塌成尖峰（实测均值 0.35、十分位
 * 77/70/26/3/19/45/32/30/2/12，卡方远超临界值），加权轮盘会因此严重偏向某几家券商。
 * 加上雪崩收尾后卡方 5.9（df=9），与均匀分布无异。
 */
function hashUnit(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return fmix32(h) / 4294967296;
}

function weightedPickIndex(weights, u) {
  let total = 0;
  for (const w of weights) total += w;
  if (!(total > 0)) return 0;
  let x = u * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x < 0) return i;
  }
  return weights.length - 1;
}

// ------------------------------------------------------------------
// 拥挤税
// ------------------------------------------------------------------

/** 拥挤度落在哪个档（从上往下取第一个命中），纯读配置、无状态 */
function crowdTier(crowd) {
  const tiers = cfgRoot().crowdTiers || [];
  for (const t of tiers) {
    if (crowd >= t.min) return t;
  }
  return tiers[tiers.length - 1] || { key: 'normal', label: '中性', min: 0, feeMul: 1, lendMul: 1 };
}

/** 某券商的拥挤度信息（值取自配置的固有属性，不掺真实账号占比，§9 D3） */
function crowdInfo(key) {
  const b = get(key);
  const crowd = b ? Number(b.crowd) || 0 : 0;
  const tier = crowdTier(crowd);
  return {
    value: crowd,
    pct: Math.round(crowd * 100),
    tier: tier.key,
    label: tier.label,
    feeMul: tier.feeMul,
    lendMul: tier.lendMul,
    freeCoupons: tier.freeCoupons || 0,
  };
}

// ------------------------------------------------------------------
// 每周之星（§5.5 / §9 D7）
// ------------------------------------------------------------------

/**
 * 按交易日号轮转：一周一家、一周不重复。
 * `day < 1`（没有交易日时钟的孤立测试路径）时不启用——否则老用例的费率会被
 * 每周之星的减半悄悄改掉（§9 D6 保留全局基准值）。
 */
function weeklyPick(day) {
  const w = cfgRoot().weekly || {};
  const order = w.order || keys();
  if (!w.enabled || !(day >= 1) || !order.length) {
    return { key: null, nextKey: order[0] || null, week: -1, isStar: () => false };
  }
  const per = Math.max(1, w.daysPerWeek || 7);
  const week = Math.floor((day - 1) / per);
  const key = order[week % order.length];
  const nextKey = order[(week + 1) % order.length];
  return {
    key,
    nextKey,
    week,
    weekStartDay: week * per + 1,
    weekEndDay: (week + 1) * per,
    feeMul: w.feeMul == null ? 1 : w.feeMul,
    financeBonus: w.financeBonus || 0,
    isStar: (k) => k === key,
  };
}

// ------------------------------------------------------------------
// 声誉星级（§5.4 / §9 D7）
// ------------------------------------------------------------------

function emptyStats() {
  return { volume: 0, profitBase: 0, liquidations: 0, orders: 0, cancels: 0 };
}

/** 取账户在**某家券商**上的进度（转户后目标券商从零开始，这是清空特权进度的落点） */
function statsOf(acc, key) {
  if (!acc) return emptyStats();
  if (!acc.brokerStats) acc.brokerStats = {};
  const k = key || acc.broker;
  if (!k) return emptyStats();
  if (!acc.brokerStats[k]) acc.brokerStats[k] = emptyStats();
  return acc.brokerStats[k];
}

/**
 * 某账户在某家券商的声誉星级（1~max，默认 1 起步）。
 * 口径 = §9 D7：累计成交额 + 累计盈利（相对入会时的已实现盈亏，所以转户不带过去）+ 爆仓记录。
 */
function starOf(acc, key, cfgOverride) {
  const st = (cfgOverride || cfgRoot().star) || {};
  if (!st.enabled) return st.max || 5;
  const k = key || (acc && acc.broker);
  if (!k) return 1;
  const rec = statsOf(acc, k);
  const volume = rec.volume || 0;
  const profit = (acc ? acc.realizedPnL || 0 : 0) - (rec.profitBase || 0);
  const liquidations = rec.liquidations || 0;
  let star = 1;
  for (const lv of st.levels || []) {
    const okVol = volume >= (lv.volume || 0);
    const okPnl = profit >= (lv.profit || 0);
    const okLiq = lv.maxLiquidations == null || liquidations <= lv.maxLiquidations;
    if (okVol && okPnl && okLiq) star = Math.max(star, lv.star);
    else break; // 门槛是递进的，断一档就停
  }
  return Math.min(star, st.max || 5);
}

/** 距离下一星的进度（UI 用）：返回 null 表示已满级 */
function starProgress(acc, key) {
  const st = cfgRoot().star || {};
  if (!st.enabled) return null;
  const star = starOf(acc, key);
  const next = (st.levels || []).find((l) => l.star === star + 1);
  if (!next) return null;
  const rec = statsOf(acc, key || acc.broker);
  const profit = (acc.realizedPnL || 0) - (rec.profitBase || 0);
  return {
    star,
    next: next.star,
    volume: rec.volume || 0,
    volumeNeed: next.volume || 0,
    profit,
    profitNeed: next.profit || 0,
    noLiquidation: next.maxLiquidations === 0,
    liquidations: rec.liquidations || 0,
    cancelRate: rec.orders ? rec.cancels / rec.orders : 0,
  };
}

/** 特权强度：min(star, maxPrivilegeStar) / maxPrivilegeStar → 1★ 1/4、4★ 满额 */
function intensityOf(star, cfgOverride) {
  const st = cfgOverride || cfgRoot().star || {};
  const cap = st.maxPrivilegeStar || 4;
  return Math.min(star, cap) / cap;
}

// ------------------------------------------------------------------
// 有效配置（两级兜底）
// ------------------------------------------------------------------

function baseValues() {
  const fin = config.margin.finance || {};
  return {
    feeRate: config.trade.feeRate,
    cooldownMs: config.trade.cooldownMs,
    lockMs: config.trade.lockMs,
    marginRatio: config.margin.ratio,
    maintenance: config.margin.maintenance,
    financeRatio: fin.ratio,
    lendCapacityMul: 1,
    lendRateMul: 1,
    autoSlots: cfgRoot().baseSlots || 2,
    newsVipLeadMs: 0,
    openGift: 0,
    freeCouponPerDay: 0,
  };
}

/**
 * 特权/代价的方向规则：相对基准是「好」就按星级递进，是「坏」就立刻全量。
 * @param {number} base 全局基准值
 * @param {number|null|undefined} val 券商覆盖值（null/undefined = 未覆盖）
 * @param {boolean} betterIsLower 该维度是不是「越小越好」（费率/自备比例）
 * @param {number} intensity 0~1
 */
function privilege(base, val, betterIsLower, intensity) {
  if (val == null) return base;
  const better = betterIsLower ? val < base : val > base;
  if (!better) return val;
  return base + (val - base) * intensity;
}

/**
 * 提前量的生效口径（消息分层方案 §4）：**只做下限夹取，不做 tick 对齐**。
 *
 * 设计稿原文是「向下对齐 tick 边界（700ms）+ 最小生效 2 tick」。但两者一起用会把
 * **满额 3s 砍成 2.8s**（3000 / 700 = 4.28 → 4 tick），而「满额 3s」是招伤那张招牌
 * 写死的数字，星级递进 0.75 / 1.5 / 2.25 / 3.0 也会跟着整体错位。
 * 真正要防的是「名义上有提前量、实际一个 tick 都看不见」——那条由 minLeadMs 兜住。
 */
function quantizeLead(ms) {
  const news = config.news || {};
  const minLead = news.minLeadMs == null ? 1400 : news.minLeadMs;
  if (!(ms > 0)) return 0;
  return ms < minLead ? minLead : ms;
}

function leverageOf(ratio) {
  if (!(ratio > 0)) return Infinity;
  return Math.round((1 / ratio) * 100) / 100;
}

/**
 * 某账户此刻的**全部有效参数**。这是 market / npc / auto / game 唯一该读的入口。
 *
 * 账户没有 broker（老存档、纯单测造的账户）→ 逐位回落到全局默认，行为与引入券商之前一致。
 *
 * @param {object} acc Account 实例（可空）
 * @param {{day?:number, now?:number}} [opts] day = 当前交易日号（每周之星要用）
 */
function forAccount(acc, opts = {}) {
  const root = cfgRoot();
  const base = baseValues();
  const day = opts.day;

  const out = {
    key: null,
    entry: null,
    name: '',
    abbr: '',
    base,
    day: day == null ? null : day,
    crowd: { value: 0, pct: 0, tier: 'normal', label: '中性', feeMul: 1, lendMul: 1, freeCoupons: 0 },
    star: Math.min(3, (root.star && root.star.max) || 5),
    intensity: 1,
    weekly: { key: null, nextKey: null, isStar: false, feeMul: 1, financeBonus: 0 },
    features: {},
    freeCouponAvailable: false,
    // 平铺的有效值（下面的默认 = 全局基准）
    feeRate: base.feeRate,
    cooldownMs: base.cooldownMs,
    lockMs: base.lockMs,
    marginRatio: base.marginRatio,
    maintenance: base.maintenance,
    financeRatio: base.financeRatio,
    lendCapacityMul: 1,
    lendRateMul: 1,
    autoMax: config.auto.maxPerAccount,
    autoSlots: base.autoSlots,
    newsVipLeadMs: 0,
    newsVipVisible: false,
    openGift: 0,
  };

  if (!root.enabled || !acc || !acc.broker) return out;
  // NPC 的券商是席位展示用的**标签**，不是它的选择：§11.4.3 明确「纯展示、零行为影响」。
  // 一旦让 NPC 也吃 per-broker 的费率/额度/券源，3160 个账户的容量与报价路径会一起漂移，
  // 盘口分布莫名畸变。所以这里直接对 NPC 返回全局基准。
  if (acc.isNPC) return out;
  const entry = get(acc.broker);
  if (!entry) return out; // 配置里删掉了这家券商 → 回落基准，不让整局起不来

  const ov = entry.overrides || {};
  const crowd = crowdInfo(entry.key);
  const star = starOf(acc, entry.key);
  const intensity = intensityOf(star);
  const weekly = weeklyPick(day);
  const isStarBroker = !!weekly.isStar(entry.key);

  out.key = entry.key;
  out.entry = entry;
  out.name = entry.name;
  out.abbr = entry.abbr || entry.name;
  out.crowd = crowd;
  out.star = star;
  out.intensity = intensity;
  out.weekly = {
    key: weekly.key,
    nextKey: weekly.nextKey,
    isStar: isStarBroker,
    feeMul: isStarBroker ? weekly.feeMul : 1,
    financeBonus: isStarBroker ? weekly.financeBonus : 0,
  };

  // 费率：券商基值 × 拥挤税 × 每周之星
  out.feeRate = (ov.feeRate == null ? base.feeRate : ov.feeRate) * crowd.feeMul * out.weekly.feeMul;
  // 通道（冷却 / 锁仓）与风控（维持率）是服务能力与风险属性，不随星级变
  out.cooldownMs = ov.cooldownMs == null ? base.cooldownMs : ov.cooldownMs;
  out.lockMs = ov.lockMs == null ? base.lockMs : ov.lockMs;
  out.maintenance = ov.maintenance == null ? base.maintenance : ov.maintenance;
  // 额度类：特权按星级递进、代价立刻全量（越小的自备比例 = 越高杠杆 = 越好）
  out.marginRatio = privilege(base.marginRatio, ov.marginRatio, true, intensity);
  out.financeRatio = privilege(base.financeRatio, ov.financeRatio, true, intensity);
  if (out.weekly.financeBonus > 0 && out.financeRatio > 0) {
    // 「融资额度 +0.5×」加在**杠杆倍数**上，再换回自备比例，与设计稿口径一致
    out.financeRatio = 1 / (1 / out.financeRatio + out.weekly.financeBonus);
  }
  // 券源：容量系数（越大越好，走星级）× 拥挤税；券息倍率是固定代价，不递进
  out.lendCapacityMul =
    privilege(1, ov.lendCapacityMul, false, intensity) * crowd.lendMul;
  out.lendRateMul = ov.lendRateMul == null ? 1 : ov.lendRateMul;
  // 策略槽：设计稿按「槽位」说话，老配置只有条数上限，按比例换算保持等价
  const slots = ov.autoSlots == null ? base.autoSlots : ov.autoSlots;
  out.autoSlots = slots;
  out.autoMax = Math.max(1, Math.round(config.auto.maxPerAccount * (slots / (root.baseSlots || 2))));
  // 消息提前量：特权，按星级递进后对齐 tick
  out.newsVipLeadMs = quantizeLead(privilege(0, ov.newsVipLeadMs, false, intensity));
  // 5★ 额外给「标的方向」（同额提前量 + 提前量内可见方向）——见消息分层方案 §8.1
  out.newsVipVisible = star >= 5 && out.newsVipLeadMs > 0;

  out.openGift = ov.openGift || 0;
  out.features = entry.features || {};
  // 强平缓冲（「预警 + 缓一档」，见 market.maybeLiquidate）：破维持线后先只预警，
  // 再跌破 `maintenance − buffer` 才真强平，中间那段是留给你补保证金/等反弹的窗口。
  // 天疯的「零缓冲强平」就是把这一档拿掉——破线即全平。基准 0 表示没这条机制，
  // 无券商账户与 NPC 因此逐位维持原行为。
  out.liquidationBuffer = out.features.zeroBufferLiquidation ? 0 : ov.liquidationBuffer || 0;

  // 免息券：券商自带（招伤）或拥挤税补贴档（天疯）
  const perDay = (ov.freeCouponPerDay || 0) + (crowd.freeCoupons || 0);
  out.freeCouponPerDay = perDay;
  out.freeCouponAvailable = perDay > 0 && acc.couponUsedDay !== day;
  out.freeInterestOn = acc.freeInterestDay != null && acc.freeInterestDay === day;

  return out;
}

/** 该账户此刻是否享有利息全免（每日免息券生效中） */
function interestWaived(acc, day) {
  if (!acc || acc.freeInterestDay == null) return false;
  return day == null ? true : acc.freeInterestDay === day;
}

/**
 * 嗨通证券的「偶发通道卡顿」：约 glitchRate 比例的报单会被延迟 1 个 tick。
 * 设计稿 §9 D4 明确不做「报单延迟 tick」那套侵入撮合的改造，所以这里只落在
 * **冷却**上（多等 700ms）——效果同源、零侵入。
 */
function glitchDelay(acc, bk) {
  const rate = bk && bk.features ? bk.features.glitchRate : 0;
  if (!rate || !acc) return 0;
  return Math.random() < rate ? config.tickIntervalMs || 700 : 0;
}

// ------------------------------------------------------------------
// 转户（§5.2 / §9 D5）
// ------------------------------------------------------------------

/**
 * 转户能不能办、要花多少。
 * @returns {{ok:boolean, free:boolean, fee:number, reason?:string, needDay?:number}}
 */
function canTransfer(acc, targetKey, opts = {}) {
  const t = cfgRoot().transfer || {};
  const day = opts.day;
  if (!cfgRoot().enabled) return { ok: false, free: false, fee: 0, reason: '券商系统未开放' };
  if (!has(targetKey)) return { ok: false, free: false, fee: 0, reason: '券商不存在' };
  if (acc && acc.broker === targetKey) return { ok: false, free: false, fee: 0, reason: '已经在这家券商了' };

  const equity = Math.max(0, opts.equity || 0);
  const fee = Math.min(equity * (t.feeRate || 0.001), t.feeCap == null ? 50000 : t.feeCap);

  // 免费重选 1 次，且**仅限开户后首个交易日内**（长期有效会变成规避拥挤税的后门）
  const sameDay = acc && day != null && day >= 1 && acc.brokerSinceDay === day;
  if (sameDay && !acc.freeReselectUsed) {
    return { ok: true, free: true, fee: 0 };
  }
  const need = (acc && acc.brokerSinceDay != null) ? acc.brokerSinceDay + (t.cooldownDays || 1) : null;
  if (need != null && day != null && day >= 1 && day < need) {
    return {
      ok: false,
      free: false,
      fee,
      reason: `转户冷却中，第 ${need} 个交易日才能再转`,
      needDay: need,
    };
  }
  return { ok: true, free: false, fee: Math.round(fee * 100) / 100 };
}

// ------------------------------------------------------------------
// 昵称规则（§11.2）
// ------------------------------------------------------------------

const NICK_RE = /^[A-Za-z][A-Za-z0-9_-]{2,15}$/;
const LEGACY_NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{1,16}$/;

/**
 * 昵称校验。规则只在**新注册**时生效——老档里已有的中文账号照常放行，
 * 否则存量玩家会直接进不来（§11.2「存量兼容」）。
 * @param {string} name
 * @param {boolean} existing 是否已存在的账号
 */
function validateNick(name, existing) {
  const s = String(name || '');
  if (!s) return { ok: false, error: '请填写昵称' };
  // 存量账号一律放行：名字是从库里查出来的，它必然是「注册那一刻合法」的。
  // 拿现在的规则去卡老账号会把带连字符、或中文的老玩家直接锁在门外。
  if (existing) return { ok: true, legacy: !NICK_RE.test(s) };
  if (!NICK_RE.test(s)) {
    return {
      ok: false,
      error: '昵称需为 3~16 位、字母开头，只允许英文字母 / 数字 / 下划线 / 连字符（不支持中文）',
    };
  }
  return { ok: true, legacy: false };
}

// ------------------------------------------------------------------
// NPC 券商归属（§11.4）
// ------------------------------------------------------------------

function tiltOf(typeKey, brokerKey) {
  const tilt = (cfgRoot().npc || {}).typeTilt || {};
  const row = tilt[typeKey];
  if (!row) return 1;
  return row[brokerKey] == null ? 1 : row[brokerKey];
}

/**
 * 给一批 NPC 账户（同属一只股票）分配券商。
 *
 * **必须确定性**：重启不落盘、靠账户名重算，所以同一批账户名必须永远得到同一张分配表。
 * 因此：① 先按账户名排序；② 逐账户用 `hash(accountName)` 做加权轮盘；
 * ③ 再跑一遍「每家保底 npcFloor 个」的挪补。全程只用账户名，不含任何随机源。
 *
 * @param {Array<{name:string, role:string}>} entries
 * @returns {Map<string, string|null>} accountName → brokerKey
 */
function allocateNpcBrokers(entries, opts = {}) {
  const out = new Map();
  const root = cfgRoot();
  const npcCfg = root.npc || {};
  const brokerKeys = keys();
  const enabled = opts.enabled == null ? !!npcCfg.enabled : !!opts.enabled;
  if (!root.enabled || !enabled || !brokerKeys.length) {
    for (const e of entries) out.set(e.name, null);
    return out;
  }
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const e of sorted) {
    const weights = brokerKeys.map(
      (k) => (get(k).targetShare || 0) * tiltOf(e.role, k)
    );
    out.set(e.name, brokerKeys[weightedPickIndex(weights, hashUnit('broker:' + e.name))]);
  }

  const floor = Math.max(0, npcCfg.npcFloor | 0);
  if (floor > 0 && sorted.length >= floor * brokerKeys.length) {
    const countOf = (k) => {
      let n = 0;
      for (const v of out.values()) if (v === k) n++;
      return n;
    };
    for (const k of brokerKeys) {
      let cnt = countOf(k);
      let guard = 0;
      while (cnt < floor && guard++ < brokerKeys.length * floor + 8) {
        let donor = null;
        let donorCnt = 0;
        for (const k2 of brokerKeys) {
          const c = countOf(k2);
          if (c > donorCnt) {
            donorCnt = c;
            donor = k2;
          }
        }
        if (!donor || donor === k || donorCnt <= floor) break;
        // 从 donor 里挑一个账户挪过来：取 hash 最大者，保证确定性
        let pick = null;
        let pickH = -1;
        for (const e of sorted) {
          if (out.get(e.name) !== donor) continue;
          const h = hashUnit('steal:' + k + ':' + e.name);
          if (h > pickH) {
            pickH = h;
            pick = e.name;
          }
        }
        if (!pick) break;
        out.set(pick, k);
        cnt++;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------
// 展示用元数据（下发给客户端）
// ------------------------------------------------------------------

/** 单家券商的展示信息（登录卡片墙与「我的券商」卡共用） */
function describe(key) {
  const b = get(key);
  if (!b) return null;
  const crowd = crowdInfo(key);
  return {
    key: b.key,
    name: b.name,
    abbr: b.abbr,
    persona: b.persona,
    slogan: b.slogan,
    color: b.color,
    icon: `broker-${b.key}.png`,
    scale: b.scale,
    virtualClients: b.virtualClients,
    crowd: crowd.value,
    crowdPct: crowd.pct,
    crowdTier: crowd.tier,
    crowdLabel: crowd.label,
    crowdFeeMul: crowd.feeMul,
    crowdLendMul: crowd.lendMul,
    strengths: b.strengths || [],
    costs: b.costs || [],
    suitable: b.suitable || '',
    // 数值预览（星级按满额算，让玩家开户前看到「养成之后能拿到什么」）
    preview: {
      feeRate: (b.overrides.feeRate == null ? baseValues().feeRate : b.overrides.feeRate) * crowd.feeMul,
      cooldownMs: b.overrides.cooldownMs == null ? baseValues().cooldownMs : b.overrides.cooldownMs,
      lockMs: b.overrides.lockMs == null ? baseValues().lockMs : b.overrides.lockMs,
      leverage: leverageOf(
        (b.overrides.financeRatio == null ? baseValues().financeRatio : b.overrides.financeRatio)
      ),
      financeRatio: b.overrides.financeRatio == null ? baseValues().financeRatio : b.overrides.financeRatio,
      maintenance: b.overrides.maintenance == null ? baseValues().maintenance : b.overrides.maintenance,
      lendCapacityPct: Math.round((b.overrides.lendCapacityMul == null ? 1 : b.overrides.lendCapacityMul) * crowd.lendMul * 100),
      newsLeadMs: quantizeLead(
        (b.overrides.newsVipLeadMs || 0) * intensityOf((cfgRoot().star || {}).max || 5)
      ),
      autoSlots: b.overrides.autoSlots == null ? baseValues().autoSlots : b.overrides.autoSlots,
      autoMax: Math.max(1, Math.round(config.auto.maxPerAccount * ((b.overrides.autoSlots == null ? baseValues().autoSlots : b.overrides.autoSlots) / (cfgRoot().baseSlots || 2)))),
      openGift: b.overrides.openGift || 0,
      freeCouponPerDay: (b.overrides.freeCouponPerDay || 0) + crowd.freeCoupons,
      forbidStocks: (b.features && b.features.forbidStocks) || [],
    },
  };
}

function describeAll() {
  return keys().map(describe);
}

/** 某账户的「我的特权清单」（主页卡片用）：满额值 / 当前值 / 解锁进度 */
function privilegeList(acc, opts = {}) {
  const bk = forAccount(acc, opts);
  const day = opts.day;
  const weeks = weeklyPick(day);
  const star = starOf(acc, bk.key);
  const pct = Math.round(bk.intensity * 100);
  const rows = [];
  if (!bk.entry) return { rows, star, intensity: bk.intensity };

  const full = bk.entry.overrides || {};
  const base = bk.base;
  if (full.financeRatio != null && full.financeRatio < base.financeRatio) {
    rows.push({
      key: 'finance',
      label: '融资额度',
      now: `${leverageOf(bk.financeRatio)}×`,
      full: `${leverageOf(full.financeRatio)}×`,
      pct,
    });
  }
  if (full.marginRatio != null && full.marginRatio < base.marginRatio) {
    rows.push({
      key: 'margin',
      label: '保证金比例',
      now: `${Math.round(bk.marginRatio * 100)}%`,
      full: `${Math.round(full.marginRatio * 100)}%`,
      pct,
    });
  }
  if (full.lendCapacityMul != null && full.lendCapacityMul > 1) {
    rows.push({
      key: 'lend',
      label: '融券券源',
      now: `${Math.round(bk.lendCapacityMul * 100)}%`,
      full: `${Math.round(full.lendCapacityMul * 100)}%`,
      pct,
    });
  }
  if (full.newsVipLeadMs) {
    rows.push({
      key: 'news',
      label: '消息提前量',
      now: `${(bk.newsVipLeadMs / 1000).toFixed(1)}s`,
      full: `${(full.newsVipLeadMs / 1000).toFixed(1)}s`,
      pct,
      extra: bk.newsVipVisible ? '可见方向' : '',
    });
  }
  return { rows, star, intensity: bk.intensity, weekly: bk.weekly, weeks };
}

// ------------------------------------------------------------------
// 券商榜（§5.3）：按券商聚合账户，给出「券商榜」与「组内名次」
// ------------------------------------------------------------------

/**
 * 把现有的账户排行切片按券商聚合。
 * @param {Array<{key:string, equity:number, name:string}>} rows 总榜（已按权益降序）
 */
function groupBoard(rows) {
  const root = cfgRoot();
  const boss = root.board || {};
  if (!root.enabled || !boss.enabled) return null;
  const by = new Map();
  for (const k of keys()) by.set(k, { key: k, name: get(k).name, abbr: get(k).abbr, clients: 0, equity: 0, top: null });
  for (const r of rows) {
    const k = r.broker;
    if (!k || !by.has(k)) continue;
    const g = by.get(k);
    g.clients += 1;
    g.equity += r.equity || 0;
    if (!g.top && r.name) g.top = r.name; // rows 已降序 → 第一个就是组内第一名
  }
  const list = [...by.values()].sort((a, b) => b.equity - a.equity);
  list.forEach((g, i) => {
    g.rank = i + 1;
  });
  return list.slice(0, boss.rows || 10);
}

module.exports = {
  // 基础
  list,
  keys,
  get,
  has,
  describe,
  describeAll,
  // 纯函数工具
  hashUnit,
  weightedPickIndex,
  leverageOf,
  quantizeLead,
  privilege,
  // 拥挤税
  crowdTier,
  crowdInfo,
  // 星级 / 每周之星
  emptyStats,
  statsOf,
  starOf,
  starProgress,
  intensityOf,
  weeklyPick,
  // 有效配置
  forAccount,
  baseValues,
  interestWaived,
  glitchDelay,
  privilegeList,
  // 转户 / 昵称
  canTransfer,
  validateNick,
  NICK_RE,
  LEGACY_NAME_RE,
  // NPC 归属 / 券商榜
  allocateNpcBrokers,
  groupBoard,
};
