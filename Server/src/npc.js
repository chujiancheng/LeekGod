/**
 * NPC 系统：机构 / 游资 / 大中小散户（五类，见 config.npc.types）
 * - 共享一个公允价值（随机游走 + 消息驱动 + 向成交价弱回归）
 * - 每个 NPC 独立情绪：散户跟消息追涨杀跌，机构对倒公开消息（利好出货/利空吸筹）
 * - 被动双边报价维持盘口，情绪高涨时主动吃单；挂单深度随情绪倾斜
 */
const config = require('./config');
const { logger } = require('./logger');
const { ACTIONS } = require('./market');
const { Account, r2 } = require('./store');

function gauss() {
  // 标准正态近似
  let s = 0;
  for (let i = 0; i < 6; i++) s += Math.random();
  return (s - 3) / 1.2247;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function roundLot(q, lot) {
  return Math.max(lot, Math.round(q / lot) * lot);
}

/** 五类 NPC 总户数 */
function totalNpcCount(cfg = config.npc) {
  return Object.values(cfg.types).reduce((s, t) => s + t.count, 0);
}

/** 旧档 role=retail → 现行类型；其余原样 */
function normalizeNpcType(role, cfg = config.npc) {
  if (role === 'retail') return cfg.legacyRetailType || 'small';
  return role;
}

class NpcManager {
  /**
   * @param {import('./market').Market} market
   * @param {import('./news').NewsSystem} news
   * @param {import('./store').Store} [store]
   */
  constructor(market, news, store) {
    this.market = market;
    this.news = news;
    this.store = store || null;
    this.stock = market.stock;
    this.npcs = [];
    this.fairValue = market.stock.initPrice;
    // 基本面重心（慢速随机游走的锚）与趋势阶段状态
    this.fund = market.stock.initPrice;
    this.regime = 0; // 1 牛 / 0 震荡 / -1 熊
    this.regimeIn = 0; // 当前阶段剩余 tick
    this.trendDrift = 0; // 当前阶段每 tick 相对推力（带符号）
    this.priceTrail = []; // 最近若干 tick 的最新价，供滚动动量计算
    // 机构情绪结构：共享情绪波 + 分歧度（0=全体一致跟情绪走，1=多空阵营贴身对打）
    this.instMood = 0; // 共享慢波（一致时的集体多/空）
    this.polar = 0.2; // 当前分歧度
    this.polarTarget = 0.2; // 分歧度目标（一致/大战两态之间切换）
    this.polarIn = 0; // 当前分歧态剩余 tick
    this.force = 0; // 多空力量天平：-1 空头占优 / 0 势均力敌 / +1 多头占优
    this.tickCount = 0;
    // 战术意图（跨 tick 的"计划"）：三种模式互斥，同一时刻至多一个生效。
    // ref/shortRef 是触发时刻的价格与空头存量，用于"目的达成 / 判断失效"的保险丝判定。
    // 与 fairValue/fund/regime 一样不落盘——重启后重新观察盘面再决定
    this.intent = { mode: 'none', left: 0, age: 0, lure: 0, ref: 0, shortRef: 0, power: 1 };
    this.intentCool = { squeeze: 0, accumulate: 0, distribute: 0 };
    // 多股票：把「基准股」（流通 1 亿股 @ 20 元）口径的做市资金与报单量折算到本股。
    // 不折算的话，同一笔钱在 43 亿的阿里上是小溪、在 20 亿的大米上是大河，
    // 各股票的盘口深度会差出一倍多。资金按流通市值缩、股数按流通股数缩。
    const cfg = config.npc;
    this.capScale = (market.stock.floatShares * market.stock.initPrice) / cfg.refMarketCap;
    this.qtyScale = market.stock.floatShares / cfg.refFloatShares;
  }

  /** 按类型取行为档案（初始化时已挂到 n.profile） */
  profileOf(n) {
    return n.profile || config.npc.types[n.type] || config.npc.types.small;
  }

  /** 初始化 NPC 账户、持仓与初始报价 */
  init(now = Date.now()) {
    const cfg = config.npc;
    const float = this.stock.floatShares;
    const lot = this.stock.lotSize;
    const preAge = config.trade.lockMs + 60000; // 初始持仓视为已解锁
    const entries = Object.entries(cfg.types);

    // 多股票：每股一套独立 NPC 池。做市资金与报单量的缩放系数在构造函数里算好
    // （capScale 按流通市值、qtyScale 按流通股数），这里直接用。
    const capScale = this.capScale;
    const qtyScale = this.qtyScale;

    // 严格守恒：五类 holdRatio 合计 = 100% 流通盘。
    // 各类按比例取整手后，余数补给最后一类（小散户），避免丢股。
    const holdTotals = entries.map(([, t]) => Math.floor((float * t.holdRatio) / lot) * lot);
    const holdSum = holdTotals.reduce((a, b) => a + b, 0);
    holdTotals[holdTotals.length - 1] += float - holdSum;

    const split = (total, n) => {
      const base = Math.floor(total / n / lot) * lot;
      const arr = Array(n).fill(base);
      arr[n - 1] += total - base * n;
      return arr;
    };

    let instIdx = 0;
    for (let ti = 0; ti < entries.length; ti++) {
      const [typeKey, t] = entries[ti];
      const sharesArr = split(holdTotals[ti], t.count);
      for (let i = 0; i < t.count; i++) {
        // 账户名带股票简称前缀：10 只股票各有 316 个 NPC，不加前缀会互相覆盖
        const acc = new Account(`${this.stock.alias}·${t.label}${i + 1}`, true, typeKey);
        acc.cash = (t.totalCash / t.count) * capScale;
        const shares = sharesArr[i];
        acc.initialLong = shares;
        acc.longPos(this.stock.id).lots.push({ qty: shares, price: this.stock.initPrice, ts: now - preAge, reserved: 0 });
        // NPC 自动出借：按类型固定比例挂入融券池（开局玩家没券，池子必须有基础券源）。
        // 做空类（机构/游资）不出借：同股多空互斥下它们要靠卖光库存翻成净空，
        // 而挂借中的券卖不掉（freeSellableLong 扣掉 lendOffered），留着挂借就永远翻不了空。
        // 池子的基础券源由不做空的被动持有者（大户/中户/散户，合计 60% 流通盘）承担。
        const lendRatio = t.canShort
          ? 0
          : config.margin.lending
            ? config.margin.lending.npcLendRatio
            : 0;
        if (lendRatio > 0) {
          const lendQty = Math.floor((shares * lendRatio) / lot) * lot;
          if (lendQty >= lot) {
            acc.ledgerOf(this.stock.id).lendOffered = lendQty;
            if (this.market) this.market.lendTotal += lendQty;
          }
        }
        if (this.store) this.store.put(acc);
        this.npcs.push({
          acc,
          type: typeKey,
          profile: t,
          initialLong: shares,
          initialCash: acc.cash,
          // 机构固定阵营（多头/空头各半），分歧度高时贴身对打（多空大战）
          camp: t.useCamp ? (instIdx++ % 2 === 0 ? 1 : -1) : 0,
          ownBias: 0,
          ownResting: [],
          // 报价阵营：同股多空互斥下每张单只能落在一侧，空头阵营要先派发库存再翻净空
          wantShort: false,
          // 大户错峰更散，小散户随机拉长，避免同拍重报价
          requoteIn: typeKey === 'inst' ? i : Math.floor(rand(0, typeKey === 'small' ? 16 : 8)),
        });
      }
    }
  }

  /** 每 tick 推进市场模拟 */
  step(now) {
    this.tickCount += 1;
    this.priceTrail.push(this.market.lastPrice);
    if (this.priceTrail.length > config.npc.momentumTicks + 10) {
      this.priceTrail.shift();
    }
    this.updateFairValue(now);
    this.recycleLiquidity();
    this.updateForce(now);
    this.updateMoodPolar();
    this.updateIntent();

    for (const n of this.npcs) {
      this.gcResting(n);
      this.updateBias(n, now);
      this.updateSide(n);
      this.syncLend(n);
      const shouldRequote = this.shouldRequote(n);
      if (shouldRequote) this.requote(n, now);
      // 分歧度越高机构主动吃单越频繁，多空大战放量；其余类型用各自 aggressiveRate
      const p = this.profileOf(n);
      const rate = p.aggressiveRate * (p.polarOrderScale ? 1 + this.polar * 0.8 : 1);
      if (Math.random() < rate) this.tryAggressive(n, now);
    }
  }

  updateFairValue(now) {
    const cfg = config.npc;
    const init = this.stock.initPrice;
    const last = this.market.lastPrice;

    this.updateTrend();

    // 重心跟随趋势慢一拍迁移（大级别的底），再以约 15 分钟时间常数回归发行价。
    // 回归用对数空间（乘性距离对称）：涨十倍和跌到十分之一受同等强度的拉回，
    // 不会像线性回归那样把深跌底部额外托住
    this.fund *= 1 + this.trendDrift * cfg.fundTrendFollow;
    this.fund *= 1 + Math.log(init / this.fund) * cfg.fundAnchor;
    this.fund *= 1 + gauss() * cfg.fundNoiseRel;

    let fv = this.fairValue;
    fv *= 1 + this.trendDrift; // 阶段推力：对数空间 → 乘性，越涨越猛（翻几倍 / 腰斩的来源）
    fv *= 1 + this.news.fvDrift(now, this.stock.id); // 消息推力（乘性，只算本股 + 大盘消息）
    fv *= 1 + gauss() * cfg.noiseRel; // 短期噪声（毛刺）
    fv += (last - fv) * cfg.priceCoupling; // 向最新价回归（盘面跟随）
    fv += (this.fund - fv) * cfg.fvAnchor; // 向重心回归

    // 软边界：触轨即终止当前阶段（不再继续同向推），下一 tick 重新抽签。
    // 刻意不做“触轨必反转”的偏置——顶底本身不能变成可押注的信号
    const lo = init * cfg.rangeLow;
    const hi = init * cfg.rangeHigh;
    if (fv < lo || fv > hi) {
      fv = Math.min(hi, Math.max(lo, fv));
      this.regimeIn = 0;
    }
    this.fund = Math.min(hi, Math.max(lo, this.fund));
    this.fairValue = Math.max(0.05, this.market.clampPrice(fv));
  }

  /**
   * 抽取/推进趋势阶段：
   * - 时长指数分布（无记忆）：走了多久推不出还要走多久，拐点时刻不可预测
   * - 方向每次重新抽签（含同向连排）：顶底常是假突破后的延续或反杀
   * - 幅度三档混合：温和为主，偶尔极端段给出数倍级行情
   */
  updateTrend() {
    const t = config.npc.trend;
    if (this.regimeIn <= 0) {
      const u = Math.max(1e-9, Math.random());
      let n = Math.round(-t.phaseMeanTicks * Math.log(u)); // 指数分布
      if (n < t.phaseMinTicks) n = t.phaseMinTicks;
      if (n > t.phaseMaxTicks) n = t.phaseMaxTicks;
      this.regimeIn = n;

      if (Math.random() < t.flatWeight) {
        this.regime = 0;
        this.trendDrift = 0;
      } else {
        const dir = Math.random() < 0.5 ? 1 : -1;
        this.regime = dir;
        const r = Math.random();
        const w = t.weights;
        const band = r < w[0] ? 0 : r < w[0] + w[1] ? 1 : 2;
        this.trendDrift = dir * rand(t.bands[band][0], t.bands[band][1]);
      }
    }
    this.regimeIn -= 1;
  }

  /**
   * 多空力量天平：把盘面上"真正拿得出来打的"几样东西合成一个 [-1,1] 的慢变量。
   * 它决定了这一局现在是多头占优、空头占优，还是势均力敌——三种状态都要出现，
   * 而且必须是**算出来的**（不是随机贴标签）：情绪合力、动量、弹药、浮盈亏结构
   * 各自投票，再平滑成慢波。
   * 空头存量与券源紧张度刻意**不进这个天平**：它们恒为正，算进去会让天平结构性
   * 偏多、永远出不来"空头占优"。它们是逼空的燃料，只在挤兑条件里用。
   * 结果有三处用途：情绪同向偏置、机构分歧度（势均力敌更容易打成放量对攻）、
   * 以及三种战术意图的成立前提。
   */
  updateForce(now) {
    const cfg = config.npc.force;
    if (!cfg || !cfg.enabled) {
      this.force = 0;
      return;
    }
    const float = this.stock.floatShares;
    const last = this.market.lastPrice;
    const floatMV = float * last;
    let cash = 0;
    let profitQty = 0;
    let lossQty = 0;
    for (const n of this.npcs) {
      cash += n.acc.cash;
      const q = n.acc.longQty(this.stock.id);
      if (q <= 0) continue;
      const pnl = this.pnlOf(n);
      if (pnl == null) continue;
      if (pnl >= cfg.pnlProfitEdge) profitQty += q;
      else if (pnl <= cfg.pnlLossEdge) lossQty += q;
    }
    const cashRatio = floatMV > 0 ? cash / floatMV : 0;
    const profShare = float > 0 ? profitQty / float : 0;
    const lossShare = float > 0 ? lossQty / float : 0;
    const retail =
      this.news && this.news.sentiment ? this.news.sentiment('散户', now, this.stock.id) : 0;
    // 机构一致情绪：分歧度高时它们在对打，合力小
    const mood = this.instMood * (1 - this.polar) + retail * cfg.retailWeight;
    const mom = this.windowMomentum();
    const clamp1 = (v) => Math.max(-1, Math.min(1, v));
    const votes =
      clamp1(mood) * cfg.moodWeight +
      clamp1(mom) * cfg.momWeight +
      clamp1((cashRatio / cfg.cashFullRatio - 1) * 2) * cfg.cashWeight - // 弹药
      clamp1(profShare - lossShare) * cfg.pnlWeight; // 获利盘 vs 深套盘
    const target = clamp1(votes / cfg.norm);
    this.force += (target - this.force) * cfg.smooth;
    this.force = clamp1(this.force);
  }

  /** 最近一个动量窗口的涨跌幅（已夹到 [-1,1]）；样本不足返回 0 */
  windowMomentum() {
    const mt = config.npc.momentumTicks;
    if (this.priceTrail.length <= mt) return 0;
    const ref = this.priceTrail[this.priceTrail.length - 1 - mt];
    if (!(ref > 0)) return 0;
    const scale = config.npc.force ? config.npc.force.momScale : 5;
    const v = ((this.market.lastPrice - ref) / ref) * scale;
    return Math.max(-1, Math.min(1, v));
  }

  /** 力量天平的三态标签（日志与调试用；属于与 regime 同级的内幕，不下发客户端） */
  forceLabel() {
    const d = config.npc.force ? config.npc.force.dominant : 0.25;
    if (this.force >= d) return '多头占优';
    if (this.force <= -d) return '空头占优';
    return '多空均衡';
  }

  /**
   * 机构情绪结构推进：
   * - instMood 共享慢波：分歧度低时全体机构同向（情绪一致，趋势合力更猛）
   * - polar 分歧度在"一致（~0.15）"与"多空大战（~0.85）"两态间切换
   *   （时长无记忆，与趋势阶段同理——大战何时来/何时散无法预判）
   * - 但两态的**基础概率**受力量天平调制：势均力敌时更容易打成多空大战，
   *   一边倒时更容易全体一致（合力推一个方向）
   */
  updateMoodPolar() {
    this.instMood += gauss() * 0.02 - this.instMood * 0.01;
    this.instMood = Math.max(-1, Math.min(1, this.instMood));
    if (this.polarIn <= 0) {
      const fc = config.npc.force;
      const on = !!(fc && fc.enabled);
      const balance = on ? fc.polarBalance * (1 - Math.abs(this.force)) : 0;
      const base = on ? fc.polarBase : 0.5;
      this.polarTarget = Math.random() < base + balance ? rand(0.7, 1) : rand(0, 0.2);
      const u = Math.max(1e-9, Math.random());
      let n = Math.round(-300 * Math.log(u)); // 指数分布，均值 ~300 tick
      if (n < 80) n = 80;
      if (n > 1500) n = 1500;
      this.polarIn = n;
    }
    this.polarIn -= 1;
    this.polar += (this.polarTarget - this.polar) * 0.03;
  }

  // ---------- 战术意图（跨 tick 的计划层） ----------

  /** 本 tick 生效的意图配置；无意图返回 null */
  activeIntent() {
    return this.intent.mode === 'none' ? null : config.npc.intent[this.intent.mode];
  }

  /** 是否处于"诱"阶段（诱空砸盘 / 诱多拉抬的铺垫段） */
  inLurePhase() {
    return this.intent.mode !== 'none' && this.intent.age < this.intent.lure;
  }

  /**
   * 意图推进：观察 → （随机门）进入 → 计时/达成 → 冷却。
   * 反射式情绪每 tick 都在重算，意图是唯一有"记忆"的一层。
   */
  updateIntent() {
    const cfg = config.npc.intent;
    const it = this.intent;
    for (const k of Object.keys(this.intentCool)) {
      if (this.intentCool[k] > 0) this.intentCool[k] -= 1;
    }
    if (it.mode !== 'none') {
      it.age += 1;
      it.left -= 1;
      if (it.left <= 0 || this.intentDone()) this.endIntent();
      return;
    }
    if (!cfg || !cfg.enabled || this.tickCount < cfg.warmupTicks) return;
    const cand = this.pickIntent();
    if (cand && Math.random() < cand.p) this.beginIntent(cand.mode);
  }

  /**
   * 观察盘面决定"该做什么"。三种意图条件各自独立，命中多个时按权重随机挑一个。
   * 盘口薄的一侧就是攻击方向（卖盘薄好挤兑、买盘薄好派发），薄盘给触发概率加分。
   * @returns {{mode: string, p: number}|null}
   */
  pickIntent() {
    const cfg = config.npc.intent;
    const float = this.stock.floatShares;
    const shortRatio = float > 0 ? this.market.shortInterest / float : 0;
    const util = this.market.lendUtilization ? this.market.lendUtilization() : 0;
    // 大级别位置：基本面重心相对发行价的涨跌幅。
    // "高位/低位"必须用这个口径——价格相对重心的短端偏离被 fvAnchor 钉在 0 附近，
    // 拿它当"高了/低了"的门槛等于永不触发（实测命中率 0.00%）
    const level = this.stock.initPrice > 0 ? this.fund / this.stock.initPrice - 1 : 0;
    const cands = [];

    const sq = cfg.squeeze;
    if (
      this.intentCool.squeeze <= 0 &&
      this.regime >= 0 &&
      this.force >= sq.minForce &&
      shortRatio >= sq.minShortFloatRatio &&
      util >= sq.minLendUtilization
    ) {
      // 卖盘越薄，往上拉越省力；空头存量越大、券源越紧，逼空越有肉
      const thin = this.sideThinRatio();
      const bonus = thin < 0.6 ? 1.6 : thin < 1 ? 1.25 : 0.8;
      const fuel = Math.min(2, shortRatio / sq.minShortFloatRatio);
      cands.push({ mode: 'squeeze', p: Math.min(0.25, sq.rate * bonus * fuel) });
    }

    const ac = cfg.accumulate;
    if (this.intentCool.accumulate <= 0 && this.force <= ac.maxForce && level <= ac.maxLevel) {
      cands.push({ mode: 'accumulate', p: Math.min(0.25, ac.rate * Math.min(2, level / ac.maxLevel)) });
    }

    const di = cfg.distribute;
    if (
      this.intentCool.distribute <= 0 &&
      this.force >= di.minForce &&
      level >= di.minLevel &&
      this.windowMomentum() >= di.minMomentum
    ) {
      cands.push({ mode: 'distribute', p: Math.min(0.25, di.rate * Math.min(2, level / di.minLevel)) });
    }

    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    // 多个都该做时按概率权重掷骰子——不做"优先级固定"的确定性选择
    const total = cands.reduce((s, c) => s + c.p, 0);
    let r = Math.random() * total;
    for (const c of cands) {
      r -= c.p;
      if (r <= 0) return c;
    }
    return cands[cands.length - 1];
  }

  beginIntent(mode) {
    const c = config.npc.intent[mode];
    const it = this.intent;
    const saved = {
      mode: it.mode,
      left: it.left,
      age: it.age,
      lure: it.lure,
      ref: it.ref,
      shortRef: it.shortRef,
      power: it.power,
    };
    it.mode = mode;
    it.left = Math.round(rand(c.durationTicks[0], c.durationTicks[1]));
    it.age = 0;
    it.lure = c.lureRatio ? Math.round(it.left * c.lureRatio) : 0;
    it.power = rand(c.power[0], c.power[1]);
    it.ref = this.market.lastPrice;
    it.shortRef = this.market.shortInterest;
    // 入场就满足退出条件的意图不启动（典型：大级别位置已经越过 capLevel 还想派发）。
    // 不拦的话会出现"进入 → 下一 tick 立刻退出 → 冷静期"的空转：日志刷屏、
    // 战术实际一次都没执行。这里直接回滚并记冷却，等于"这个位置不干这活"
    if (this.intentDone()) {
      Object.assign(it, saved);
      this.intentCool[mode] = Math.round(rand(c.cooldownTicks[0], c.cooldownTicks[1]));
      return false;
    }
    logger.info(
      `[我是股神] ${this.stock.name} NPC 进入「${c.label}」意图：持续 ${it.left} tick、力度 ${r2(it.power)}`
    );
    return true;
  }

  endIntent() {
    const c = config.npc.intent[this.intent.mode];
    if (c) {
      this.intentCool[this.intent.mode] = Math.round(rand(c.cooldownTicks[0], c.cooldownTicks[1]));
      logger.info(`[我是股神] ${this.stock.name} NPC 结束「${c.label}」意图`);
    }
    this.intent.mode = 'none';
    this.intent.left = 0;
    this.intent.age = 0;
    this.intent.lure = 0;
  }

  /**
   * 目的达成或判断失效就收手——每个意图都必须能自己退出，
   * 否则一次误判会把价格推到天上去（或砸穿地板）
   */
  intentDone() {
    const c = this.activeIntent();
    if (!c) return true;
    const it = this.intent;
    const px = this.market.lastPrice;
    // 大级别位置（口径同 pickIntent 的入场门槛，否则"入场看大级别、退出看短端"
    // 会让意图刚开就立刻满足退出条件）
    const level = this.stock.initPrice > 0 ? this.fund / this.stock.initPrice - 1 : 0;
    const move = it.ref > 0 ? px / it.ref - 1 : 0;
    if (c.maxGain != null && move >= c.maxGain) return true;
    if (c.maxLoss != null && move <= -c.maxLoss) return true;
    if (c.capLevel != null && level >= c.capLevel) return true;
    if (c.exitAboveLevel != null && level >= c.exitAboveLevel) return true;
    if (c.exitBelowLevel != null && level <= c.exitBelowLevel) return true;
    if (c.endWhenShortGone && it.shortRef > 0 && this.market.shortInterest <= it.shortRef * c.shortGoneRatio) {
      return true;
    }
    return false;
  }

  /**
   * 该 NPC 是否参与当前意图（返回意图配置；不参与返回 null）。
   * 只有能做空的聪明钱（机构/游资）执行意图，且**空头阵营的账户一律不参与**：
   * 它们正往空侧走（派发库存、准备开空），让它们反手做多既违背自身判断，
   * 也会毁掉「卖光库存翻净空」这条路径（同股多空互斥下两边互斥）。
   */
  intentFor(n) {
    const c = this.activeIntent();
    if (!c) return null;
    if (!this.profileOf(n).canShort) return null;
    if (n.wantShort) return null;
    return c;
  }

  /** 意图对本 NPC 的情绪附加（铺垫段用 lureBias，主段用 bias） */
  intentBias(n) {
    const c = this.intentFor(n);
    if (!c) return 0;
    const lure = this.inLurePhase();
    const b = lure && c.lureBias != null ? c.lureBias : c.bias;
    return (b || 0) * this.intent.power;
  }

  /** 意图作用到本 NPC 身上的具体裁剪（requote / tryAggressive 共用；不参与返回 null） */
  intentEffects(n) {
    const c = this.intentFor(n);
    if (!c) return null;
    const lure = this.inLurePhase();
    return {
      // 铺垫段刻意松绑：诱多要先买、诱空要先卖，主段才收紧
      suppressOpenBuy: !!c.suppressOpenBuy && !lure,
      suppressSell: !!c.suppressSell && !lure,
      suppressAggroBuy: !!c.suppressAggroBuy && !lure,
      pressDown: (c.pressDown || 0) * (lure ? 1.5 : 1),
      bidBoost: lure ? 1 : c.bidBoost || 1,
      askBoost: c.askBoost || 1,
      aggroBoost: c.aggroBoost || 1,
    };
  }

  /** 盘口一侧在最新价 ±depthRangePct 内的挂单深度（股） */
  sideDepth(side) {
    const book = this.market.book;
    const arr = side === 'ask' ? book.asks : book.bids;
    const last = this.market.lastPrice || 1;
    const lim = last * config.npc.intent.depthRangePct;
    let d = 0;
    const max = config.npc.intent.depthMaxLevels;
    for (let i = 0; i < arr.length && i < max; i++) {
      const o = arr[i];
      if (side === 'ask' ? o.price > last + lim : o.price < last - lim) break;
      d += Math.max(0, o.qty - o.filled);
    }
    return d;
  }

  /** 卖盘深度 / 买盘深度：< 1 表示上方薄（往上拉省力），> 1 表示下方薄（容易砸） */
  sideThinRatio() {
    const bid = this.sideDepth('bid');
    const ask = this.sideDepth('ask');
    if (bid <= 0) return ask > 0 ? 0.3 : 1;
    return ask / bid;
  }

  /** 该 NPC 在本股上的浮动盈亏（相对自己的持仓成本）；没持仓返回 null */
  pnlOf(n) {
    const pos = n.acc.longs.get(this.stock.id);
    if (!pos || !pos.lots.length) return null;
    let q = 0;
    let cost = 0;
    for (const l of pos.lots) {
      q += l.qty;
      cost += l.qty * l.price;
    }
    if (q <= 0 || cost <= 0) return null;
    return this.market.lastPrice / (cost / q) - 1;
  }

  updateBias(n, now) {
    const p = this.profileOf(n);
    let s = 0;

    if (p.publicNewsFade != null) {
      // 聪明钱：看见公开消息（全体+散户盘）但对倒——利好出货、利空吸筹；
      // 机构专属消息仍小幅同向（知情盘）
      const sb = this.news.sentimentByScope(now, this.stock.id);
      const publicS = Math.max(-1, Math.min(1, sb.all + sb.retail));
      s -= publicS * p.publicNewsFade;
      s += sb.inst * (p.instNewsFollow != null ? p.instNewsFollow : 0.35);
    } else {
      const scope = p.newsScope || (n.type === 'inst' ? '机构' : '散户');
      s = this.news.sentiment(scope, now, this.stock.id);
      s *= p.sentimentScale != null ? p.sentimentScale : n.type === 'retail' ? 1.2 : 0.8;
    }

    // 机构：一致成分（共享情绪波）与分歧成分（阵营对抗）此消彼长
    if (p.useCamp) {
      s += this.instMood * (1 - this.polar) * 1.1;
      s += (n.camp || 0) * this.polar * 0.7;
    }

    // 多空力量天平：多头占优时全体偏多、空头占优时全体偏空。
    // 这是"市场合力"而非个人判断，所有人一起受它影响，行情的宏观节奏
    // （多头占优期 / 空头占优期 / 势均力敌期）就来自这里
    const fc = config.npc.force;
    if (fc && fc.enabled) s += this.force * fc.bias;

    // 过热/超跌：价格偏离基本面重心时回归（机构重，大户/游资轻度）。
    // 战术意图可以临时关掉它——挤兑空头期间"贵了就该卖"会让机构自己拆掉挤兑
    if (p.heatFade && !this.suppressHeat(n)) {
      const heat = this.fund > 0 ? this.market.lastPrice / this.fund - 1 : 0;
      s -= Math.max(-0.8, Math.min(0.8, heat)) * p.heatFade;
    }

    // 库存软目标：超配倾向派发、低配倾向收集。
    // 做空类（机构/游资）**只惩罚超配**：同股多空互斥下它们要靠卖光库存翻成净空，
    // 低配时再叠一层买回倾向，库存永远降不到 0、净空也就永远建不起来。
    // 例外：压盘吸筹期间临时放开收集侧（那是本次意图的核心动作）。
    // 被动持有者不做空，保留双向软目标：恐慌卖光后还会收集回来，盘口不会只剩单边。
    if (p.inventorySkew) {
      const target = n.initialLong || 0;
      if (target > 0) {
        const dev = (n.acc.longQty(this.stock.id) - target) / target;
        const d = p.canShort && !this.collecting(n) ? Math.max(0, dev) : dev;
        s -= Math.max(-1, Math.min(1, d)) * p.inventorySkew;
      }
    }

    // 被动持有者（大户/中户/散户）的浮盈亏行为：割肉与获利了结。
    // 他们不是"永不卖出的背景板"——机构吸筹/派发要有人在对面接，
    // 全靠一群人死拿到底的话，战术就空转了。成本用他们自己的持仓批次算，
    // 不用发行价：用发行价的话这批人要一路扛到破产才动，盘面没有换手。
    // 恐慌侧（下跌踩踏）比获利侧（温和回吐）更重
    const pf = config.npc.pnlFeel;
    if (pf && pf.enabled && !p.canShort) {
      const pnl = this.pnlOf(n);
      if (pnl != null) {
        if (pnl <= pf.panicLoss) {
          s -= pf.panicBias * Math.min(2, pnl / pf.panicLoss);
        } else if (pnl >= pf.takeProfit) {
          s -= pf.takeBias * Math.min(2, pnl / pf.takeProfit);
        }
      }
    }

    // 游资/散户追涨杀跌：最近一个窗口的涨跌幅（窗口动量）。横盘时归零，
    // 情绪重新只由消息与随机噪声主导——顶部/底部才不会出现“全员死多/死空”的钉死
    if (p.momentum && this.priceTrail.length > config.npc.momentumTicks) {
      const ref =
        this.priceTrail[this.priceTrail.length - 1 - config.npc.momentumTicks];
      if (ref > 0) {
        const mom = (this.market.lastPrice - ref) / ref;
        const cl = config.npc.momentumClamp;
        const gain = config.npc.momentumGain * (p.momentumGainMul || 1);
        s += Math.max(-cl, Math.min(cl, mom * gain));
      }
    }

    // 战术意图（跨 tick 的计划）——放在最末，意图的意志压过当 tick 的噪声
    s += this.intentBias(n);

    n.ownBias += gauss() * 0.06;
    n.ownBias *= 0.95; // 缓慢回归
    n.sentiment = Math.max(-1, Math.min(1, s + n.ownBias));
  }

  /** 该 NPC 是否处于"过热回归被临时压住"的状态（挤兑空头期间不派发） */
  suppressHeat(n) {
    const c = this.intentFor(n);
    if (!c || !c.suppressHeat) return false;
    return !this.inLurePhase();
  }

  /** 该 NPC 是否在按意图收集筹码（压盘吸筹期间放开库存软目标的收集侧） */
  collecting(n) {
    const c = this.intentFor(n);
    return !!(c && c.collect && !this.inLurePhase());
  }

  /**
   * 本 tick 的报价阵营（同股多空互斥：每张单只能落在一侧）。
   * 机构/游资在情绪够低时切到**空头阵营**：先停挂买盘、把库存往外派发，
   * 库存清干净后变成净空（卖开补卖盘、买盘只回补）；情绪回到阈值以上切回多头阵营。
   * 少了这一步就永远开不出空——只要还押着库存就进不了开空分支，而没有阵营切换
   * 也没有任何力量把库存推到 0（实测 600 tick 空头存量恒为 0）。
   * wantShort 带滞回，避免情绪贴着阈值抖动导致买卖盘反复翻面。
   * 不做空的类型（大户/中户/散户）永远是多头阵营。
   * @returns {boolean} 是否处于空头阵营
   */
  updateSide(n) {
    const p = this.profileOf(n);
    if (!p.canShort) {
      n.wantShort = false;
      return false;
    }
    const th = p.openShortSentiment != null ? p.openShortSentiment : -9;
    const s = n.sentiment || 0;
    if (!n.wantShort && s < th) n.wantShort = true;
    else if (n.wantShort && s > th + 0.08) n.wantShort = false;
    return n.wantShort;
  }

  /**
   * 做空类（机构/游资）撤清挂借：同股多空互斥下翻空的前提是库存卖到 0 股，
   * 而挂借中的券卖不掉（freeSellableLong 扣掉 lendOffered）。新局 init 就不给它们挂借，
   * 旧档里已经挂出去的在跑起来后逐步撤回——已被借走的部分受券源锁保护
   * （lendRemovableQty），只能等对方回补解锁后再撤，所以先问可撤量，
   * 不足一手就直接返回，避免每 tick 空转把账户标脏。
   */
  syncLend(n) {
    if (!this.profileOf(n).canShort) return;
    const led = n.acc.ledgerOf(this.stock.id);
    if (!led.lendOffered) return;
    const lot = this.stock.lotSize;
    const qty = Math.floor(this.market.lendRemovableQty(n.acc) / lot) * lot;
    if (qty < lot) return;
    this.market.unlendShares(n.acc, qty, Date.now());
  }

  /**
   * 定价锚：机构以基本面重心为主——消息/趋势推高的短端公允不作数，
   * 才能在散户追利好时看见「贵了」去出货、恐慌杀跌时看见「便宜了」去吸筹。
   * 其余类型直接用短端公允价值。
   */
  valueOf(p) {
    const w = p.fundWeight;
    if (w == null) return this.fairValue;
    return this.fund * w + this.fairValue * (1 - w);
  }

  gcResting(n) {
    n.ownResting = n.ownResting.filter((o) => o.status === 'live');
  }

  /**
   * 流动性回收：NPC 全池现金被空头保证金吸干（开空时现金的一半进保证金）
   * 后，盘面没人买得动 → 双向死锁。低于地板时每 tick 向地板回补一小段，
   * 只"补到地板"不无限注水；日志每个枯竭周期记一次
   */
  recycleLiquidity() {
    const cfg = config.npc;
    if (!cfg.liquidityFloor || !this.npcs.length) return;
    // 地板的绝对金额随本股流通市值等比放大：大盘股盘口深、需要的活水也多
    const floor = cfg.liquidityFloor * this.capScale;
    let cash = 0;
    for (const n of this.npcs) cash += n.acc.cash;
    if (cash >= floor) {
      this._dryLogged = false;
      return;
    }
    if (!this._dryLogged) {
      this._dryLogged = true;
      logger.info(
        `[我是股神] ${this.stock.name} NPC 池现金枯竭（${r2(cash)} < ${r2(floor)}），开始向地板回补`
      );
    }
    const need = (floor - cash) * cfg.liquidityRefill;
    const per = need / this.npcs.length;
    for (const n of this.npcs) n.acc.cash = r2(n.acc.cash + per);
    // 现金变化影响挂单冻结口径，存档器需要知道这些账户变了
    for (const n of this.npcs) this.market.notifyChange(n.acc);
  }

  shouldRequote(n) {
    if (n.ownResting.length === 0) return true;
    if (n.requoteIn > 0) {
      n.requoteIn -= 1;
      return false;
    }
    // 随机 + 目标价偏离触发重报价
    if (Math.random() < 0.25) {
      n.requoteIn = Math.floor(rand(config.npc.minRequoteTicks, config.npc.minRequoteTicks + 5));
      return true;
    }
    return false;
  }

  /** 撤旧挂单并按公允价值+情绪挂双边报价 */
  requote(n, now) {
    for (const o of n.ownResting) {
      if (o.status === 'live') this.market.cancel(n.acc, o.id, now);
    }
    n.ownResting = [];

    const p = this.profileOf(n);
    // 有券可借就能开空（不必等裸空后门）；place 里会再查 lendAvailable
    const canShort =
      !!p.canShort &&
      (!!config.margin.allowNakedShort ||
        (config.margin.lending && config.margin.lending.enabled && this.market.lendAvailable() > 0));
    const fv = this.valueOf(p);
    const sentiment = n.sentiment || 0;
    // 报价中枢 = 最新价与定价锚的混合：贴住最新价保证报价可成交（不撞价格笼子），
    // 同时保留对公允/基本面的领先量——锚领先时主动吃单会触发，价格被一段段拉过去
    const cfg = config.npc;
    const lastPx = this.market.lastPrice;
    const qlw = p.quoteLastWeight != null ? p.quoteLastWeight : cfg.quoteLastWeight;
    const base = qlw * lastPx + (1 - qlw) * fv;
    // 情绪直接平移报价中枢，再硬夹到最新价 ±quoteCushion（小于价格笼子 5%）：
    // 公允价值无论滑多远，盘口都留在可成交区间，成交不会被笼子切断
    let center = base * (1 + sentiment * (p.centerShift != null ? p.centerShift : 0.006));
    // 战术意图的额外压价（压盘吸筹：把报价中枢按下去，反弹一上来就被自己的卖单压住）
    const ie = this.intentEffects(n);
    if (ie && ie.pressDown) center *= 1 - ie.pressDown;
    const cush = cfg.quoteCushion;
    center = Math.min(lastPx * (1 + cush), Math.max(lastPx * (1 - cush), center));
    // 点差按价格比例缩放（价位高点差大、价位低点差小），下限 0.02 防止取整后买一=卖一
    const spreadRange = p.spread || [0.001, 0.003];
    const spread = Math.max(0.02, base * rand(spreadRange[0], spreadRange[1]));
    const bidPx = this.market.clampPrice(center - spread / 2);
    const askPx = this.market.clampPrice(center + spread / 2);
    const lot = this.stock.lotSize;
    const rq = p.requoteQty || [100, 800];
    // 挂单量按情绪倾斜：偏多加深买盘、偏空加深卖盘（出货/吸筹直接写在盘口）
    const tilt = Math.max(
      -0.5,
      Math.min(0.5, sentiment * (p.quoteTilt != null ? p.quoteTilt : 0.3))
    );

    // 买盘：空头阵营下一律不挂买开——挂买盘等于自己把派发出去的货接回来，
    // 库存就永远降不到 0、净空也就建不起来（实测残留挂单能把库存重新顶回 30 万股）。
    // 手上有空头时照常挂，但那一侧只能是回补（BUY_CLOSE）。
    // 全池现金常被保证金吸干，回补是买盘的主要资金来源。
    // 分歧度高时机构双边挂单也加大（多空大战的“工事”更深）
    const reScale = p.polarOrderScale ? 1 + this.polar * 0.6 : 1;
    const wantShort = n.wantShort === true;
    const shortQty = n.acc.shortQty(this.stock.id);
    // 意图裁剪：派发期不开多、挤兑期不挂卖、吸筹期加大承接买盘
    const blockOpenBuy = wantShort || !!(ie && ie.suppressOpenBuy);
    if ((!wantShort || shortQty > 0) && bidPx > 0.01) {
      let qty = roundLot(
        rand(rq[0], rq[1]) * this.qtyScale * reScale * (1 + tilt) * (ie ? ie.bidBoost : 1),
        lot
      );
      const coverable = n.acc.coverableShort(this.stock.id);
      if (coverable >= lot) {
        qty = Math.min(qty, coverable, this.closeCapacity(n, bidPx, qty));
        qty = Math.floor(qty / lot) * lot;
        if (qty >= lot) {
          const r = this.market.place(n.acc, {
            action: ACTIONS.BUY_CLOSE,
            qty,
            price: bidPx,
            now,
            noCooldown: true,
          });
          if (r.ok) n.ownResting.push(r.order);
        }
      } else if (shortQty === 0 && !blockOpenBuy && this.longCapacity(n) >= lot) {
        // 开多需要一个空头都没有：有空头（含旧档残留）在手时只能先回补，不能反手开多
        qty = Math.min(qty, this.longCapacity(n));
        qty = Math.min(qty, this.cashCapacity(n, bidPx));
        qty = Math.floor(qty / lot) * lot;
        if (qty >= lot) {
          const r = this.market.place(n.acc, this.buyOpenOpts(n, qty, bidPx, now));
          if (r.ok) n.ownResting.push(r.order);
        }
      }
    }

    // 卖盘：优先卖出持仓（扣掉已挂借融券的）；库存清零后若在空头阵营就开空补卖盘。
    // 只要还持有库存就不反手——挂借中的券卖不掉时先由 syncLend 把券撤回来，
    // 库存清干净了下一轮自然翻成净空。
    // 挤兑期间这一侧整个停掉：一边往上打一边挂卖单，等于自己给自己拆台。
    const sellable = n.acc.freeSellableLong(this.stock.id, now);
    let askQty = roundLot(
      rand(rq[0], rq[1]) * this.qtyScale * (1 - tilt) * (ie ? ie.askBoost : 1),
      lot
    );
    if (!(ie && ie.suppressSell)) {
      if (sellable >= Math.min(askQty, lot)) {
        askQty = Math.min(askQty, sellable);
        if (askQty >= 100) {
          const r = this.market.place(n.acc, {
            action: ACTIONS.SELL_CLOSE,
            qty: askQty,
            price: askPx,
            now,
            noCooldown: true,
          });
          if (r.ok) n.ownResting.push(r.order);
        }
      } else if (wantShort && n.acc.longQty(this.stock.id) === 0 && canShort && askQty >= lot) {
        // 机构/游资站空头侧时主动开空补充卖盘
        const r = this.market.place(n.acc, {
          action: ACTIONS.SELL_OPEN,
          qty: askQty,
          price: askPx,
          now,
          noCooldown: true,
        });
        if (r.ok) n.ownResting.push(r.order);
      }
    }
  }

  /**
   * 主动吃单，三条独立触发（缺一都会造成单边死锁）：
   * - 动量：情绪同向且对手价在定价锚之内
   * - 情绪：|s| 够大直接吃，不看价格（消息行情 / 杀跌的来源；机构对倒后也是出货/吸筹的来源）
   * - 价值：对手价偏离定价锚 valueHitEdge 以上（贴着估值的均值回归盘，
   *   保证锚与最新价脱节时永远有人把价格拉回来）
   */
  tryAggressive(n, now) {
    const p = this.profileOf(n);
    const canShort =
      !!p.canShort &&
      (!!config.margin.allowNakedShort ||
        (config.margin.lending && config.margin.lending.enabled && this.market.lendAvailable() > 0));
    const s = n.sentiment || 0;
    const lot = this.stock.lotSize;
    const book = this.market.book;
    const fv = this.valueOf(p);
    const edge = p.valueHitEdge != null ? p.valueHitEdge : 0.005;
    const aq = p.aggressiveQty || [100, 500];
    // 意图裁剪：吸筹/派发期不扫单、挤兑期不卖出、意图期放大单笔
    const ie = this.intentEffects(n);

    if (book.asks.length > 0) {
      const ask = book.asks[0];
      const wantBuy = (s > 0.35 && fv >= ask.price) || s > 0.65 || fv >= ask.price * (1 + edge);
      // 已有回补单在挂时不再下买：回补保证金在成交时才释放（place 不冻结），
      // 同一 tick 双重回补会超出保证金总额
      const hasCover = n.ownResting.some(
        (o) => o.status === 'live' && o.action === ACTIONS.BUY_CLOSE
      );
      const coverable = n.acc.coverableShort(this.stock.id);
      // 吸筹段刻意不抬价扫单（吸筹靠承接抛盘，靠扫单就变成追涨了）；回补空头不受限
      const blockedByIntent = !!(ie && ie.suppressAggroBuy) && coverable < lot;
      if (wantBuy && !hasCover && !blockedByIntent) {
        const isCover = coverable >= lot;
        // 同股多空互斥：有空头在手（含本 tick 刚挂出的买开）就只回补，不再开多。
        // 空头阵营里也一律不开多——那一侧正在往下派发，自己接自己砸出来的货，
        // 库存永远降不到 0、净空也就永远建不起来（实测会被自己的价值抄底买回 3 成）。
        const canOpenLong =
          isCover || (!n.wantShort && !n.acc.sideLock(this.stock.id).short);
        if (canOpenLong) {
          // 分歧度越高机构出手越重（多空大战放量），一致期回归常规规模
          const moodScale = p.polarOrderScale ? 1 + this.polar * 0.8 : 1;
          let qty = roundLot(
            rand(aq[0], aq[1]) * this.qtyScale * moodScale * (ie ? ie.aggroBoost : 1),
            lot
          );
          if (isCover) {
            qty = Math.min(qty, coverable, this.closeCapacity(n, ask.price, qty));
          } else {
            qty = Math.min(qty, this.longCapacity(n));
            qty = Math.min(qty, this.cashCapacity(n, ask.price));
          }
          // 冲击成本约束：主动单成交价钉在「卖一 + 1 分」，超出的量会变成留在盘口的残单
          qty = Math.min(qty, this.impactCap(ask));
          qty = Math.floor(qty / lot) * lot;
          if (qty >= lot) {
            const price = this.market.clampPrice(ask.price + 0.01);
            if (isCover) {
              this.market.place(n.acc, { action: ACTIONS.BUY_CLOSE, qty, price, now, noCooldown: true });
            } else {
              this.market.place(n.acc, this.buyOpenOpts(n, qty, price, now));
            }
          }
        }
      }
    }

    if (book.bids.length > 0 && !(ie && ie.suppressSell)) {
      const bid = book.bids[0];
      if (
        (s < -0.35 && fv <= bid.price) ||
        s < -0.65 ||
        fv <= bid.price * (1 - edge)
      ) {
        // 买盘太薄就不砸：砸掉最后一档承接力，盘面立刻变成"没有买盘"，
        // 之后连想跑的人都跑不掉（这是买盘空档时段的主要来源，纯负外部性）
        const floor = (config.npc.intent.thinBookFloor || 0) * this.qtyScale;
        const bidRemain = Math.max(0, bid.qty - bid.filled);
        const sellable = n.acc.freeSellableLong(this.stock.id, now);
        const moodScale = p.polarOrderScale ? 1 + this.polar * 0.8 : 1;
        const sized = (cap) =>
          Math.floor(Math.min(cap, this.impactCap(bid)) / lot) * lot;
        if (bidRemain < floor) return;
        if (sellable >= 100) {
          let qty = roundLot(
            rand(aq[0], aq[1]) * this.qtyScale * moodScale * (ie ? ie.aggroBoost : 1),
            lot
          );
          qty = sized(Math.min(qty, sellable));
          if (qty >= lot) {
            this.market.place(n.acc, {
              action: ACTIONS.SELL_CLOSE,
              qty,
              price: this.market.clampPrice(bid.price - 0.01),
              now,
              noCooldown: true,
            });
          }
        } else if (canShort && !n.acc.sideLock(this.stock.id).long) {
          // 开空同样要求多头端是空的（一手都不剩、也没有在途买开/买平之外的多头占用）
          let qty = roundLot(
            rand(aq[0], aq[1]) * this.qtyScale * moodScale * (ie ? ie.aggroBoost : 1),
            lot
          );
          qty = sized(qty);
          if (qty >= lot) {
            this.market.place(n.acc, {
              action: ACTIONS.SELL_OPEN,
              qty,
              price: this.market.clampPrice(bid.price - 0.01),
              now,
              noCooldown: true,
            });
          }
        }
      }
    }
  }

  /**
   * 冲击成本约束：单笔主动单不超过对手最优档剩余承接力的 aggroDepthMult 倍。
   * 主动单的成交价钉在「对手价 ∓1 分」，吃到最优档之外的部分会变成留在盘口的残单——
   * 那不是做市，是给自己留一张并不想要的挂单，还顺手把盘口撑出假深度
   */
  impactCap(level) {
    const cfg = config.npc.intent;
    if (!cfg || !cfg.depthAware) return Infinity;
    const remain = Math.max(0, level.qty - level.filled);
    return Math.max(this.stock.lotSize, remain * (cfg.aggroDepthMult || 5));
  }

  /** 还能买入多少股（持仓上限 + 可用资金） */
  longCapacity(n) {
    const cfg = config.npc;
    const maxLong =
      Math.floor((n.initialLong * cfg.longCapMult) / this.stock.lotSize) * this.stock.lotSize;
    return Math.max(0, maxLong - n.acc.longQty(this.stock.id));
  }

  cashCapacity(n, price) {
    const fullUnit = price * (1 + config.trade.feeRate);
    const fullCap = Math.floor(n.acc.cash / fullUnit); // 挂单冻结已从 cash 扣除
    const fin = config.margin.finance;
    if (!fin || !fin.enabled) return fullCap;
    // 全款容量 × npcFinCapMult：温和超配，只有超出全款容量的部分才实际走融资单
    const mult = fin.npcFinCapMult != null ? fin.npcFinCapMult : 1.2;
    return Math.floor(fullCap * mult);
  }

  /** 买入开多参数：现金够全款就全款；不够且融资开放时下融资单（仍受维持保证金预检约束） */
  buyOpenOpts(n, qty, price, now) {
    const fin = config.margin.finance;
    const fullNeed = price * qty * (1 + config.trade.feeRate);
    const useFinance = !!(fin && fin.enabled && n.acc.cash < fullNeed);
    return {
      action: ACTIONS.BUY_OPEN,
      qty,
      price,
      now,
      noCooldown: true,
      finance: useFinance,
    };
  }

  /**
   * 平空还能买多少股。口径必须与 place 的预检一致（FIFO 预览将释放的保证金，
   * 不是账户总保证金），并迭代收敛到同一固定点——否则按总保证金算出的量
   * 会被"平空需支付买入款"拒绝。目标量本身作为上限
   */
  closeCapacity(n, price, qty) {
    const P = price * (1 + config.trade.feeRate);
    const afford = (q) =>
      Math.min(qty, Math.floor((n.acc.cash + n.acc.previewShortMargin(this.stock.id, q)) / P));
    let cap = afford(qty);
    for (let i = 0; i < 3; i++) {
      const next = afford(cap);
      if (next >= cap) break;
      cap = next;
    }
    return cap;
  }

  /** 汇总 NPC 持仓/资金（调试与状态页用） */
  summary() {
    let long = 0;
    let cash = 0;
    for (const n of this.npcs) {
      long += n.acc.longQty(this.stock.id);
      cash += n.acc.cash;
    }
    return { long, cash: r2(cash) };
  }
}

module.exports = { NpcManager, totalNpcCount, normalizeNpcType };
