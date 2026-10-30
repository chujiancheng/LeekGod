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
const broker = require('./broker');
const identity = require('./identity');

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

/**
 * 交易日阶段的活跃度乘子 = 阶段基准 × 段内 U 型曲线。
 *
 * 真实市场的日内量能是 U 型（开盘半小时与尾盘半小时最重、午间清淡），
 * 引入「天」之后盘面必须跟着段走，否则「天」只体现在时钟与竞价上。
 * 段内曲线是分段线性的：段首 openBurstMul 衰减到 troughMul、中段保持谷底、
 * 段尾回升到 closeRampMul——比阶跃曲线更贴近真实的"逐渐清淡 / 逐渐回暖"。
 *
 * 没有阶段信息（未接交易日时钟、或配置关掉）时恒为 1，等价于旧行为。
 * @param {{key:string, pct:number}|null} s 由 Game.tick 下发的阶段快照
 */
function phaseActivity(s) {
  const r = config.npc.rhythm;
  if (!r || !r.enabled || !s) return 1;
  const base = r.phases && r.phases[s.key] != null ? r.phases[s.key] : 1;
  let curve = 1;
  if (r.curvePhases && r.curvePhases.indexOf(s.key) >= 0 && Number.isFinite(s.pct)) {
    const ob = r.openBurstPct;
    const cb = 1 - r.closeRampPct;
    if (s.pct < ob) {
      curve = r.openBurstMul + (r.troughMul - r.openBurstMul) * (s.pct / ob);
    } else if (s.pct > cb) {
      curve = r.troughMul + (r.closeRampMul - r.troughMul) * ((s.pct - cb) / r.closeRampPct);
    } else {
      curve = r.troughMul;
    }
  }
  return Math.max(0.2, base * curve);
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
   * @param {{seqBase?:number}} [opts] seqBase = 本池第一个 NPC 的全局序号。
   *   账号与名字都由它派生（`npc-0312` / `曹俊（杭州）`），跨股票递增才不会撞；
   *   由 `Game` 按「股票顺序 × 每池人数」算出并传入。
   */
  constructor(market, news, store, opts = {}) {
    this.market = market;
    this.news = news;
    this.store = store || null;
    this.stock = market.stock;
    this.seqBase = opts.seqBase || 0;
    this.npcs = [];
    // 做市商（role='mm'）：每股票 6 家券商自营，只报价不吃单。
    // 与 npcs（316 个投资者）分开存：定价脑/力量天平/意图仍按投资者池算，
    // 盘口则由这里铺——两者别混在一起，否则 requoteQty / 情绪倾斜会互相污染
    this.makers = [];
    this.fairValue = market.stock.initPrice;
    // 基本面重心（慢速随机游走的锚）与趋势阶段状态
    this.fund = market.stock.initPrice;
    this.regime = 0; // 1 牛 / 0 震荡 / -1 熊
    this.regimeIn = 0; // 当前阶段剩余 tick
    this.trendDrift = 0; // 当前阶段每 tick 相对推力（带符号）
    // 行情周期层（config.npc.cycle）：牛/熊/震荡三态马尔可夫机，周月级慢变量，
    // 与 trend 相位的分钟级纹理正交。cycleDir 与 fund/regime 同级内幕，不下发客户端
    this.cycleDir = 0; // 1 牛 / 0 震荡 / -1 熊
    this.cycleDrift = 0; // 周期层每 tick 对数推力（带符号，已按隔夜倍数折算）
    this.cycleLeft = 0; // 当前周期状态已持续 tick（诊断用；换挡靠无记忆概率，不靠倒计时）
    this.cycleLog = 0; // 周期成分累计对数涨幅（重心里的周月级分量，随机游走）
    this._cycInit = false; // 周期层派生量（一日 tick 当量 / 隔夜折算 / 纹理衰减率）惰性缓存
    // 内生正反馈（config.npc.feedback）：恐慌/贪婪慢变量与磨底状态
    this.mood = 0; // ∈ [-1,1]：−1 恐慌/磨底，+1 贪婪/赶顶；0 时整层无操作
    this.peakPx = this.market.stock.initPrice; // 近期峰值价（算回撤，给 mood 和磨底用）
    this._grind = false; // 磨底：深度超卖且跌不动了，活跃度收手
    this._fbMul = { aggro: 1, qty: 1, spread: 1 }; // 反馈层行为乘数（与 rhythm 的 _mul 相乘）
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
    // 大模型主力脑写回的慢变量（软脑）。null = 未启用或已过期，行为与旧版等价
    this.llmPlan = null;
    // 交易日阶段快照（Game.tick 每 tick 下发；未接时钟时为 null = 旧行为）。
    // 只影响交易行为（吃单率/单笔量/重报价/点差/竞价报价缓冲），不碰公允价值
    this.session = null;
    this._sessionKey = null; // 上一次下发的阶段 key（用来识别阶段切换）
    // 本阶段是否已经完整走过一轮报价。新阶段的第一 tick 簿天然是空的（日终委托作废、
    // 竞价刚开始），此时报"买盘侧为空"是假症状——只是这一 tick 还没轮到自己挂单
    this._quotedOnce = false;
    this._mul = { aggro: 1, qty: 1, requote: 1, spread: 1 };
    this._topUpCool = 0; // 买盘空档补款的冷却（tick）
    // 全池最早能看见消息的那一级（消息分层 §4）。机构每个池都有，所以常态是 'inst'；
    // 池里恰好抽中 L0 内幕时抬到 'insider'。公允价值是**池级共享量**，所以它的消息推力
    // 按「池里知道得最早的人」走——这正是"股价先动"的来源
    this.poolViewer = null;
    // 多股票：把「基准股」（流通 1 亿股 @ 20 元）口径的做市资金与报单量折算到本股。
    // 不折算的话，同一笔钱在 43 亿的阿里上是小溪、在 20 亿的大米上是大河，
    // 各股票的盘口深度会差出一倍多。资金按流通市值缩、股数按流通股数缩。
    const cfg = config.npc;
    this.capScale = (market.stock.floatShares * market.stock.initPrice) / cfg.refMarketCap;
    this.qtyScale = market.stock.floatShares / cfg.refFloatShares;
    // 做市商每档量：按「旧池每侧总挂单量 ÷（家数 × 档数）」反推，深度守恒。
    // 拍脑袋乘 50 会让盘口厚度凭空翻几倍——盘口变厚，主动单就永远打不穿，
    // 价格会在盘口里"滑行"，趋势和波动全被吃掉
    const mcfg = cfg.maker || {};
    const makerCount = Math.max(1, mcfg.count || 6);
    const makerLevels = Math.max(1, mcfg.levels || 3);
    const oldSideQty = Object.values(cfg.types).reduce((s, t) => {
      const rq = t.requoteQty || [100, 800];
      return s + t.count * ((rq[0] + rq[1]) / 2);
    }, 0);
    this.makerQty =
      mcfg.qtyPerLevel != null
        ? mcfg.qtyPerLevel
        : (oldSideQty * (mcfg.depthMul == null ? 1 : mcfg.depthMul)) / (makerCount * makerLevels);
    // ---- 跨股（P2）运行期状态 ----
    this.game = null; // 由 Game 注入：跨股要访问其它 market / 权益
    this.watchRank = []; // 涨幅/成交额榜（Game 每 N tick 刷新一次）
    // 跨股的单股暴露与每 tick 预算都是**全市场**口径，落在 game 上（见 crossStore）。
    // 本池没有 game（单元测试单独 new）时才回落到自己的字段。
    this.crossExposure = new Map();
    this._crossBudget = 0;
    // 一个游戏日多少 tick：私人估值的日频漂移靠它错峰
    const dph = config.day && config.day.enabled ? config.day.phases : null;
    const dayMs = dph ? dph.reduce((s, p) => s + p.ms, 0) : 620000;
    this.dayTicks = Math.max(1, Math.round(dayMs / (config.tickIntervalMs || 700)));
  }

  /** 按类型取行为档案（初始化时已挂到 n.profile） */
  profileOf(n) {
    return n.profile || config.npc.types[n.type] || config.npc.types.small;
  }

  /**
   * 东风人气 buff（§3.6）：本券商客户在该股的成交量推高「论坛热度」，
   * 热度再放大**散户** NPC 的跟风强度——做多时顺风、做空时逆风（放大的是动量跟随，不是方向）。
   *
   * 热度为 0（没有东风客户交易）时恒返回 1，NPC 行为与引入券商之前逐位一致。
   */
  heatMul(typeKey) {
    const cfg = this.market.dongfengHeatCfg ? this.market.dongfengHeatCfg() : null;
    if (!cfg || !cfg.enabled || typeKey !== 'small') return 1;
    const h = this.market.dongfengHeat || 0;
    return h > 0 ? 1 + h * (cfg.retailMul || 0) : 1;
  }

  /**
   * 交易日阶段注入（`Game.tick` 每 tick 一次；时钟未启用时下发 null）。
   * @param {{key:string, pct:number, auction:string|null, converging:boolean}|null} s
   */
  setSession(s) {
    // 阶段切换时重新武装「首 tick 不算症状」的闸：日终作废（夜间）之后进入次日竞价，
    // 或竞价结束翻连续竞价时，簿本来就可能是空的，那不是买盘空档
    const key = s ? s.key : null;
    if (key !== this._sessionKey) {
      this._sessionKey = key;
      this._quotedOnce = false;
    }
    this.session = s || null;
  }

  /** 本 tick 的阶段活跃度（1 = 与"没有天"的旧行为等价） */
  activity() {
    return this.session ? phaseActivity(this.session) : 1;
  }

  /**
   * 应用大模型主力脑的策略慢变量（见 config.npc.llm）。
   * 只影响聪明钱的情绪偏置、意图启动概率与吃单力度，不直接下单、不碰公允价值。
   * @param {{bias:number, intent:string, intentChance:number, aggro:number, untilTick:number, label?:string, note?:string, scaleHot?:number}|null} plan
   */
  applyLlmPlan(plan) {
    this.llmPlan = plan || null;
  }

  /** 当前仍有效的 llm 计划（过期自动清掉） */
  liveLlmPlan() {
    const p = this.llmPlan;
    if (!p) return null;
    if (Number.isFinite(p.untilTick) && this.tickCount > p.untilTick) {
      this.llmPlan = null;
      return null;
    }
    return p;
  }

  /**
   * 把活跃度摊到四条行为通道上。分开给敏感度是因为这几件事在真实盘里的
   * 放大倍数并不一样：吃单率几乎跟着活跃度走，挂单量涨得慢一些，
   * 点差是反向的（越活跃成交越容易，做市商愿意收窄）。
   */
  updateActivityMuls() {
    const r = config.npc.rhythm || {};
    const act = this.activity();
    const g = (gain) => Math.max(0.2, 1 + (act - 1) * (gain == null ? 1 : gain));
    this._mul.aggro = g(r.aggroGain);
    this._mul.qty = g(r.qtyGain);
    this._mul.requote = g(r.requoteGain);
    this._mul.spread = g(r.spreadGain);
  }

  /**
   * 本 tick 的报价缓冲（报价中枢离最新价的硬夹）。
   * 开盘集合竞价的**试探档**放宽到 `auctionCushionOpen`：只有在这里，
   * 隔夜走远的定价锚才真的体现在竞价成交价上（= 隔夜跳空）。进入收敛档
   * （锁单前 `auctionConvergeMs`）之后回到常规 `quoteCushion`。
   *
   * ⚠️ 放大只是「允许」，不等于跳空就有那么大：真正的印刷价由收敛档这一步决定——
   * 收敛档把全体报价夹回 ±quoteCushion，并撤掉试探档留下的远价。实测（gap-probe
   * 60 样本）缓冲 8% 不收敛 std 2.90% / ≥3% 占 15%，同样 8% 但有收敛档
   * std 1.54% / ≥3% 占 6.7%——收敛档吃掉了放大效果的一半。所以
   * `auctionCushionOpen` 与 `auctionConvergeMs` 是强耦合的，改一个要连另一个一起看。
   */
  quoteCushion() {
    const cfg = config.npc;
    const s = this.session;
    if (s && s.auction === 'open' && !s.converging && cfg.auctionCushionOpen != null) {
      return cfg.auctionCushionOpen;
    }
    return cfg.quoteCushion;
  }

  /**
   * 本 tick 报价中枢里「最新价」的权重。竞价试探档压到 `auctionProbeLastWeight`：
   * 竞价里的"最新价"还是昨收（过了一夜的信息），参与者拿着新估值报价，
   * 不该贴着昨收——否则隔夜漂移被中枢稀释掉四成，跳空建不起来。
   */
  quoteLastWeight(p) {
    const cfg = config.npc;
    const s = this.session;
    if (s && s.auction === 'open' && !s.converging && cfg.auctionProbeLastWeight != null) {
      return cfg.auctionProbeLastWeight;
    }
    return p.quoteLastWeight != null ? p.quoteLastWeight : cfg.quoteLastWeight;
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

    // ---- 做市商：先定下自营库存，剩下的才分给投资者 ----
    // 顺序很重要：守恒口径是「流通盘总量不变」，做市商拿的是同一个盘子里的 4%
    const mcfg = cfg.maker || {};
    const makerOn = !!mcfg.enabled;
    const invPct = makerOn ? Math.max(0, Math.min(0.5, mcfg.initInventoryPct || 0)) : 0;
    const investorFloat = Math.floor((float * (1 - invPct)) / lot) * lot;

    // 严格守恒：五类 holdRatio 合计 = 100% 投资者盘子。
    // 各类按比例取整手后，余数补给最后一类（小散户），避免丢股。
    const holdTotals = entries.map(([, t]) => Math.floor((investorFloat * t.holdRatio) / lot) * lot);
    const holdSum = holdTotals.reduce((a, b) => a + b, 0);
    holdTotals[holdTotals.length - 1] += investorFloat - holdSum;

    const split = (total, n) => {
      const base = Math.floor(total / n / lot) * lot;
      const arr = Array(n).fill(base);
      arr[n - 1] += total - base * n;
      return arr;
    };

    let instIdx = 0;
    let seq = this.seqBase; // 全局唯一序号：账号与展示名都从它派生（见 identity.js）

    if (makerOn) this.initMakers(now, float - investorFloat);

    for (let ti = 0; ti < entries.length; ti++) {
      const [typeKey, t] = entries[ti];
      const sharesArr = split(holdTotals[ti], t.count);
      for (let i = 0; i < t.count; i++) {
        // 账号是内部键（npc-0312），展示名走 nick（曹俊（杭州））。
        // 两者分家之后名字里不再带股票前缀，所以归属改由 homeStock 记录
        const acc = new Account(identity.accountFor(seq), true, typeKey);
        acc.nick = identity.nameFor(typeKey, seq);
        acc.homeStock = this.stock.id;
        acc.cash = (t.totalCash / t.count) * capScale;
        const shares = sharesArr[i];
        acc.initialLong = shares;
        // 初始持仓的"按股票"口径：十大股东的变动列读它，跨股之后账户级的
        // single initialLong 表达不了，所以两处都写（后者仍供 npc 库存软目标用）
        acc.ledgerOf(this.stock.id).originQty = shares;
        acc.longPos(this.stock.id).lots.push({ qty: shares, price: this.stock.initPrice, ts: now - preAge, reserved: 0 });
        seq += 1;
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
        // 新局建号必须立刻标脏：初始 3160 个账户只靠 sweep 分片轮转的话，
        // 第一次 commit 只写得进 1/300，重启时读回来的名单是残的
        if (this.market.notifyChange) this.market.notifyChange(acc);
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
          // 竞价报价档位（'probe' 试探档 / 'converge' 收敛档），离开竞价清空
          aucTag: null,
          // 报价阵营：同股多空互斥下每张单只能落在一侧，空头阵营要先派发库存再翻净空
          wantShort: false,
          // 大户错峰更散，小散户随机拉长，避免同拍重报价
          requoteIn: typeKey === 'inst' ? i : Math.floor(rand(0, typeKey === 'small' ? 16 : 8)),
        });
      }
    }
    this.applyTags();
  }

  /**
   * 做市商档案。**不是**一类投资者，所以不从 `config.npc.types` 派生：
   * - 不看消息、不带方向观点（sentiment 恒 0）——自营只提供流动性
   * - 不做空（库存从流通盘里划，够铺卖盘）
   * - 挂单量由 `requoteMaker` 按档位直接算，不走 requoteQty
   */
  makerProfile() {
    const m = config.npc.maker;
    return {
      label: '自营',
      canShort: false,
      useCamp: false,
      momentum: false,
      newsScope: '公众',
      sentimentScale: 0,
      publicNewsFade: 0.5,
      instNewsFollow: 0,
      fundWeight: 0.35, // 偏基本面一点：自营的锚不该被短端情绪带走
      quoteLastWeight: m.quoteLastWeight,
      valueHitEdge: 0.002,
      quoteTilt: 0,
      centerShift: m.centerShift,
      spread: m.spread,
      requoteQty: [0, 0],
      aggressiveQty: [0, 0],
      aggressiveRate: m.aggressiveRate || 0,
      polarOrderScale: false,
      openShortSentiment: -9,
      inventorySkew: 0, // 存货倾斜在 requoteMaker 里按库存单独算
      heatFade: 0,
    };
  }

  /**
   * 建 6 家券商自营（role='mm'）：账号 `mm-600001-1`、展示名「钟信自营」。
   * 现金与旧池同量（Σ types.totalCash × capScale）、库存从流通盘划来的 invQty。
   * 家数取 `min(config.npc.maker.count, 券商数)`——每家券商自营只出现一次，
   * 玩家在盘口看到的是六家不同的自营席位。
   */
  initMakers(now, invQty) {
    const cfg = config.npc;
    const mcfg = cfg.maker;
    const lot = this.stock.lotSize;
    const preAge = config.trade.lockMs + 60000;
    const brokers = broker.describeAll() || [];
    const count = Math.max(1, Math.min(mcfg.count || 6, brokers.length || mcfg.count || 6));
    const totalCash = Object.values(cfg.types).reduce((s, t) => s + t.totalCash, 0);
    const perCash = r2((totalCash * this.capScale) / count);
    const perInv = Math.floor(invQty / count / lot) * lot;

    for (let i = 0; i < count; i++) {
      const bk = brokers[i] || { key: `mm${i + 1}`, abbr: `自营${i + 1}`, name: `自营${i + 1}` };
      const acc = new Account(`mm-${this.stock.id}-${i + 1}`, true, 'mm');
      // public=false 时统一叫「机构专用」：不暴露是哪家券商在做市
      acc.nick = mcfg.public === false ? '机构专用' : identity.makerNick(bk.abbr || bk.name);
      acc.homeStock = this.stock.id;
      acc.cash = perCash;
      // 最后一个吃掉取整余数，保证 6 家库存合计 = invQty
      const qty = i === count - 1 ? invQty - perInv * (count - 1) : perInv;
      acc.initialLong = qty;
      acc.ledgerOf(this.stock.id).originQty = qty;
      if (qty > 0) {
        acc
          .longPos(this.stock.id)
          .lots.push({ qty, price: this.stock.initPrice, ts: now - preAge, reserved: 0 });
      }
      if (this.store) this.store.put(acc);
      if (this.market.notifyChange) this.market.notifyChange(acc);
      const h = identity.hash(`mm:${this.stock.id}:${i}`);
      this.makers.push({
        acc,
        type: 'mm',
        profile: this.makerProfile(),
        initialLong: qty,
        initialCash: acc.cash,
        camp: 0,
        ownBias: 0,
        ownResting: [],
        aucTag: null,
        wantShort: false,
        requoteIn: i, // 错峰：6 家不挤在同一 tick 重挂
        brokerKey: bk.key,
        // 每家的个性：点差/档距/耐心略有差异，否则 6 家报价完全重合，盘口像一堵墙
        aggBias: 0.85 + h * 0.3,
        spreadBias: 0.85 + identity.hash(`mm-s:${this.stock.id}:${i}`) * 0.4,
        lastQuotePx: 0,
      });
    }
  }

  /**
   * 从存档恢复做市商（role='mm'）：账户/持仓/现金已由 applySnapshot 建好，
   * 这里只补运行期字段。券商按账号序号回填（`mm-600001-1` → 第 1 家券商），
   * 所以第几家自营永远是同一家——玩家看到的席位不会因为重启而换人。
   */
  restoreMakers(rows) {
    const cfg = config.npc.maker;
    const brokers = broker.describeAll() || [];
    const count = Math.max(1, Math.min(cfg.count || 6, brokers.length || 6));
    const sorted = rows.slice().sort((a, b) => a.name.localeCompare(b.name));
    sorted.forEach((row, i) => {
      const idx = Math.min(i, count - 1);
      const h = identity.hash(`mm:${this.stock.id}:${idx}`);
      this.makers.push({
        acc: this.store.get(row.name),
        type: 'mm',
        profile: this.makerProfile(),
        initialLong: row.initial_long,
        initialCash: 0,
        camp: 0,
        ownBias: 0,
        ownResting: [],
        aucTag: null,
        wantShort: false,
        requoteIn: idx,
        brokerKey: (brokers[idx] || {}).key || null,
        aggBias: 0.85 + h * 0.3,
        spreadBias: 0.85 + identity.hash(`mm-s:${this.stock.id}:${idx}`) * 0.4,
        lastQuotePx: 0,
      });
    });
  }

  /**
   * 投资者还能挂多少限价单（1 = 旧行为，0 = 只吃单不挂单）。
   *
   * P1 之后盘口由 6 家做市商提供，投资者不再人人双边报价——只有大户/中户
   * 会在自己估值附近挂小额限价（方案 §4.4）。这个比例同时作用在挂单量上：
   * 做市商关掉时恒为 1，行为逐位退回改动前。
   */
  quoteScaleOf(n) {
    const m = config.npc.maker;
    if (!m || !m.enabled) return 1;
    if (n.type === 'big') return 0.35;
    if (n.type === 'mid') return 0.25;
    return 0;
  }

  /**
   * 做市商是否该重报价。
   * 与投资者的 `shouldRequote` 同源但更简单：自营没有情绪、没有阵营，
   * 只有"价格动了没有"和"手上还有没有活单"两个理由。
   */
  shouldRequoteMaker(m, now) {
    if (this.market.auctionKind && this.market.auctionKind(now)) {
      // 竞价里只补一次：每 tick 撤光重挂会搅散委托簿，虚拟成交价永远在抖
      const tag = this.session && this.session.converging ? 'converge' : 'probe';
      if (m.aucTag !== tag) {
        m.aucTag = tag;
        return true;
      }
      return m.ownResting.length === 0;
    }
    m.aucTag = null;
    if (!m.ownResting.length) return true;
    // 买盘侧空着、自己又挂得出买单 → 立刻补，不等随机门。与投资者版 shouldRequote
    // 的旁路同源：崩盘日卖压把做市商的买单吃光后，手上还挂着卖单（ownResting 非空）
    // 就要等 requoteRate 的随机门，平均 2~4 tick 才补回买盘——6 家轮流卡门，
    // 买侧五档就整段空给玩家看（2026-10-30 腾迅控股实测：全天「买盘深度不足」抢救
    // 2.5 万次、深度在 0~39 手横跳，玩家截屏里五档只剩卖盘 +「暂无买盘」）。
    // 买侧全空时自己不可能还有活买单（活买单必然在簿上），所以不用再查 ownResting；
    // 容量顶满（longCapMult 封顶）的做市商挂不出买单，跳过它，免得白撤白挂一轮空转。
    // ⚠️ 放行后 requoteMaker 是双边撤挂，卖单会跟着一起重挂——有意为之（双边同时
    // 重挂价差更整齐），同投资者版的处理。
    if (
      this.market.book.bids.length === 0 &&
      m.acc.cash >= this.market.lastPrice * this.stock.lotSize &&
      this.longCapacity(m) >= this.stock.lotSize
    ) {
      return true;
    }
    // 价格动了就跟：不做无意义的撤挂（6 家 × 6 单，每 tick 全撤也是笔开销）
    const drift = m.lastQuotePx > 0 ? Math.abs(this.market.lastPrice / m.lastQuotePx - 1) : 1;
    if (drift > 0.0008) return true;
    if (m.requoteIn > 0) {
      m.requoteIn -= 1;
      return false;
    }
    const cfg = config.npc.maker;
    if (Math.random() < (cfg.requoteRate != null ? cfg.requoteRate : 0.5)) {
      m.requoteIn = Math.floor(rand(1, 3));
      return true;
    }
    return false;
  }

  /**
   * 做市商报价：双边各 `levels` 档，档位按 step 向外拉开。
   *
   * 与投资者报价的三处关键差别：
   * ① **不带情绪**（自营没有方向观点），中枢只由「最新价 + 基本面锚」决定；
   * ② **库存倾斜**：库存高于目标 → 中枢整体下移（急着出货）、低于目标 → 上移（急着收货）。
   *    这就是存货模型的核心：做市商靠价差赚钱，不靠赌方向，库存偏离用价格纠正；
   * ③ 单笔量大一个量级（接管原来 316 个人的深度），但只有 6 家、每家 3 档，
   *    盘口从"密密麻麻的小单"变成"几家自营的大单"。
   */
  requoteMaker(m, now) {
    const cfg = config.npc.maker;
    const lot = this.stock.lotSize;
    const sid = this.stock.id;
    // 撤旧单（做市商现金充足，不存在"撤了挂不回来"的问题，可以全撤）
    for (const o of m.ownResting) {
      if (o.status === 'live') this.market.cancel(m.acc, o.id, now, { internal: true });
    }
    m.ownResting = m.ownResting.filter((o) => o.status === 'live');

    const p = m.profile;
    const lastPx = this.market.lastPrice;
    const qlw = this.quoteLastWeight(p);
    const base = qlw * lastPx + (1 - qlw) * this.valueOf(p);
    // 库存倾斜：dev > 0 = 库存超目标 → 中枢下移
    const target = Math.max(lot, m.initialLong * (cfg.inventoryTargetPct != null ? cfg.inventoryTargetPct : 0.5));
    const q = m.acc.longQty(sid);
    const dev = Math.max(-2, Math.min(2, (q - target) / target));
    let center = base * (1 - dev * (cfg.inventorySkew || 0) * 0.004 * (m.aggBias || 1));
    // ---- 库存告急（P0-3）----
    // 自营不做空，库存就是卖盘的全部来源。卖光之后整侧卖盘消失，玩家一手都买不进
    //（实测某只票连续空 60 tick ≈ 42 秒，腾迅/梅团/网艺的库存都到过 0%）。
    // 缺货时做市商的正常反应是**抬价收货**，而不是按原价把最后的货卖光：
    //   scarce = 0（库存 ≥ 底仓）→ 不变；scarce = 1（一点货都不剩）→ 中枢上移 scarceShift
    const reserve = m.initialLong * (cfg.minInventoryPct != null ? cfg.minInventoryPct : 0.35);
    const scarce = reserve > 0 ? Math.max(0, Math.min(1, 1 - q / reserve)) : 0;
    if (scarce > 0) {
      center *= 1 + scarce * (cfg.scarceShift != null ? cfg.scarceShift : 0.012) * (m.aggBias || 1);
    }
    const cush = this.quoteCushion();
    center = Math.min(lastPx * (1 + cush), Math.max(lastPx * (1 - cush), center));

    const sr = p.spread || [0.0004, 0.0012];
    const spread = Math.max(0.02, base * rand(sr[0], sr[1]) * (m.spreadBias || 1) * this._mul.spread);
    const step = (cfg.step || 0.0012) * (m.aggBias || 1);
    const levels = Math.max(1, cfg.levels || 3);
    const levelQty = (i) =>
      roundLot(this.makerQty * this.qtyScale * (1 - 0.22 * i) * this._mul.qty, lot);
    // 缺货时买盘放大：抬价之后还得真把量摆出来，才收得回货
    const bidMul = 1 + scarce * Math.max(0, (cfg.scarceBidMul != null ? cfg.scarceBidMul : 2) - 1);

    let placed = false;
    for (let i = 0; i < levels; i++) {
      const off = step * i;
      const bidPx = this.market.clampPrice(center * (1 - off) - spread / 2);
      const askPx = this.market.clampPrice(center * (1 + off) + spread / 2);
      const want = levelQty(i);

      // 买盘：受现金与库存上限约束（自营也有一条"别把整只票买下来"的线）
      if (bidPx > 0.01) {
        let bq = Math.min(want * bidMul, this.cashCapacity(m, bidPx), this.longCapacity(m));
        bq = Math.floor(bq / lot) * lot;
        if (bq >= lot) {
          const r = this.market.place(m.acc, this.buyOpenOpts(m, bq, bidPx, now));
          if (r.ok) {
            m.ownResting.push(r.order);
            placed = true;
          }
        }
      }
      // 卖盘：自营库存卖出（不做空），**留底仓**。
      // 底仓（minInventoryPct × 初始库存）之上的部分才按档位挂；库存低于底仓时只报一手，
      // 保证"还有货就有卖盘"——最差是卖盘极薄，而不是整侧归零、玩家完全买不进。
      // 只约束报价量，不冻结货：真要卖还是卖得掉的（有买家吃单时照常成交）。
      const sellable = m.acc.freeSellableLong(sid, now);
      const avail = sellable - reserve;
      const sellCap = avail >= lot ? avail : sellable >= lot ? lot : 0;
      if (sellCap >= lot) {
        let sq = Math.min(want, sellCap);
        sq = Math.floor(sq / lot) * lot;
        if (sq >= lot) {
          const r = this.market.place(m.acc, {
            action: ACTIONS.SELL_CLOSE,
            qty: sq,
            price: askPx,
            now,
            noCooldown: true,
          });
          if (r.ok) {
            m.ownResting.push(r.order);
            placed = true;
          }
        }
      }
    }
    if (placed) m.lastQuotePx = lastPx;
  }

  /**
   * 投资者的私人估值（P2）：**每股一个**，不由池级 fairValue 派生。
   *
   * 真实投资者看不到"上帝视角的公允价值"，每个人心里有自己的价：
   * 发行价 × (1 ± valueBias)，之后每天向「自己的成本 + 市场价」的均值靠拢。
   * 偏置由 (账户名, 股票) 哈希确定性生成 → 重启后还是同一个人、同一个看法。
   */
  privateValue(n, sid, market) {
    if (!n.pv) n.pv = new Map();
    let v = n.pv.get(sid);
    if (v == null) {
      const cfg = config.npc.cross;
      const h = identity.hash(`pv:${n.acc.name}:${sid}`);
      // ⚠️ 锚必须是**当前市价**，不是发行价：游戏里的价格能走出几倍行情，
      // 用发行价当锚会让所有人一致认为"太贵了"，于是只卖不买（实测 200 tick
      // 跨股成交 0 笔）。以市价为锚、个人偏置 ±8% 产生分歧，日均向成本/市价靠拢，
      // 均值回归力来自"很多人的偏见平均"，不需要上帝视角
      v = market.lastPrice * (1 + (h * 2 - 1) * (cfg.valueBias || 0.08));
      n.pv.set(sid, v);
    }
    return v;
  }

  /** 该账户在某只股票上的持仓均价；没持仓返回 0 */
  avgCost(n, sid) {
    const pos = n.acc.longs.get(sid);
    if (!pos || !pos.lots.length) return 0;
    let q = 0;
    let cost = 0;
    for (const l of pos.lots) {
      q += l.qty;
      cost += l.qty * l.price;
    }
    return q > 0 ? cost / q : 0;
  }

  /**
   * 私人估值每日向「成本与市价的均值」靠拢——投资者的看法会被自己的持仓和行情拉回去。
   * 没有这一步，早期随机偏置会永久固化：看错的人一辈子看错，价格失去均值回归力。
   */
  driftPrivateValues() {
    const cfg = config.npc.cross;
    if (!cfg || !cfg.enabled || !this.game) return;
    const alpha = cfg.valueDrift != null ? cfg.valueDrift : 0.3;
    for (const n of this.npcs) {
      if (!n.pv) continue;
      for (const [sid, v] of n.pv) {
        const mk = this.game.markets.get(sid);
        if (!mk) continue;
        const cost = this.avgCost(n, sid);
        const target = cost > 0 ? (cost + mk.lastPrice) / 2 : mk.lastPrice;
        n.pv.set(sid, v + (target - v) * alpha);
      }
    }
  }

  /**
   * 该账户这一轮看哪几只外股：「已有持仓」+「涨幅榜前列」。
   *
   * 方案 §4.2 的表里写的是「持仓 + 涨幅前 N」，两个来源缺一不可：
   *   - 只给涨幅榜 → 买进来的票一旦掉出榜就再也看不见，永远卖不掉（尸体仓位）；
   *   - 只给持仓   → 永远发现不了新票，跨股市场是一潭死水。
   * 所以先按 `watchHold` 给持仓留名额，剩下的从 `watchRank` 补齐。
   */
  crossCandidates(n) {
    const cfg = config.npc.cross;
    const w = Math.max(1, (cfg.watch && cfg.watch[n.type]) || 2);
    const holdQuota = Math.min(w, (cfg.watchHold && cfg.watchHold[n.type]) || 1);
    const out = [];
    for (const [sid] of n.acc.longs) {
      if (out.length >= holdQuota) break;
      if (sid === this.stock.id) continue;
      if (!this.game || !this.game.markets.has(sid)) continue;
      out.push(sid);
    }
    for (const r of this.watchRank || []) {
      if (out.length >= w) break;
      if (r.stockId === this.stock.id || out.includes(r.stockId)) continue;
      out.push(r.stockId);
    }
    return out;
  }

  /**
   * 跨股闸门（预算 + 单股暴露）的存放处：有 game 就挂 game，独立跑测试才回落到本池。
   *
   * ⚠️ 必须全市场共享。这两条闸门最初写成了池级字段，316 个池各算各的：
   * 「每 tick 3 笔」变成全市场 948 笔、单股 8% 流通盘变成 316×8% —— 闸门形同虚设。
   * 方案 §5 的反羊群本意是「同一批钱不能把一只票推上天」，那是市场级的口径。
   */
  crossStore() {
    if (!this.game) return this;
    if (!this.game.crossExposure) this.game.crossExposure = new Map();
    if (this.game.crossBudget == null) this.game.crossBudget = 0;
    return this.game;
  }

  crossUsed(sid) {
    return this.crossStore().crossExposure.get(sid) || 0;
  }

  addCrossUsed(sid, delta) {
    const st = this.crossStore();
    st.crossExposure.set(sid, Math.max(0, (st.crossExposure.get(sid) || 0) + delta));
  }

  /** 跨股成交计数（只给 probe 看占比用，不参与任何决策） */
  noteCrossFill(qty) {
    const st = this.crossStore();
    st.crossFillCount = (st.crossFillCount || 0) + 1;
    st.crossFillQty = (st.crossFillQty || 0) + qty;
  }

  crossBudget() {
    return this.crossStore().crossBudget || 0;
  }

  spendCrossBudget() {
    this.crossStore().crossBudget -= 1;
  }

  /**
   * 跨股一笔（P2）：按「私人估值 + 动量 + 消息」给外股打分，做一个仓位调整。
   *
   * 三条硬约束（方案 §5）：
   * ① 单只外股市值 ≤ 自有权益 maxSinglePct、外股合计 ≤ maxForeignPct；
   * ② 池级单股暴露 ≤ 该股流通市值 maxStockExposurePct（反羊群：10 只票不能被同一批钱推成同涨同跌）；
   * ③ 外股只吃对手价、不挂长期单（不污染别股的盘口判断）。
   */
  maybeCrossStock(n, now, inAuction = null) {
    const cfg = config.npc.cross;
    if (!cfg || !cfg.enabled || !this.game) return;
    // 竞价段一律不做跨股：跨股的本质是"看到外股便宜就立刻吃对手价"，
    // 而竞价段只累积不撮合——此刻下单必然吃不到，只会留下一张长期挂单。
    // 竞价状态由 step 统一算好传进来（默认自己算，方便单独调用）
    const auc =
      inAuction == null ? (this.market.auctionKind ? !!this.market.auctionKind(now) : false) : inAuction;
    if (auc) return;
    const rate = (cfg.rate && cfg.rate[n.type]) || 0;
    if (rate <= 0 || Math.random() >= rate * this.activity()) return;
    if ((n.crossCool || 0) > 0) {
      n.crossCool -= 1;
      return;
    }
    if (this.crossBudget() <= 0) return;
    const cands = this.crossCandidates(n);
    if (!cands.length) return;
    const sid = cands[Math.floor(Math.random() * cands.length)];
    const market = this.game.markets.get(sid);
    if (!market || !market.lastPrice) return;

    const price = market.lastPrice;
    const pv = this.privateValue(n, sid, market);
    const valueScore = Math.max(-0.3, Math.min(0.3, pv / price - 1));
    // 动量：该股最近 momentumTicks 的涨跌幅（从它自己的分时取，跨股也看得到）
    let mom = 0;
    const h = market.priceHistory;
    const mt = config.npc.momentumTicks;
    if (h && h.length > mt) {
      const ref = h[h.length - 1 - mt].price;
      if (ref > 0) mom = Math.max(-0.3, Math.min(0.3, price / ref - 1));
    }
    const newsS =
      this.news && this.news.sentiment ? this.news.sentiment('散户', now, sid, null) : 0;
    const wv = (cfg.wValue && cfg.wValue[n.type]) || 0.5;
    const wm = (cfg.wMom && cfg.wMom[n.type]) || 0.5;
    const wn = (cfg.wNews && cfg.wNews[n.type]) || 0.5;
    // 打分 = 预期收益（1 = 100%）：价值偏离 + 动量 + 消息冲击 + 小噪声
    const score = wv * valueScore + wm * mom + wn * newsS * 0.02 + gauss() * 0.008;

    const action =
      score > cfg.buyEdge ? 'buy' : score < -(cfg.sellEdge || 0.03) ? 'sell' : null;
    if (!action) return;

    const equity = this.game.equityOf(n.acc);
    if (!(equity > 0)) return;
    const lot = market.stock.lotSize;
    const curQty = n.acc.longQty(sid);
    const curMV = curQty * price;

    if (action === 'buy') {
      // 目标权重：分数越高越想买，上限 maxSinglePct
      const targetW = Math.min(
        cfg.maxSinglePct || 0.3,
        ((score - cfg.buyEdge) / Math.max(0.02, cfg.buyEdge)) * 0.12
      );
      let addMV = targetW * equity - curMV;
      // 外股合计上限
      const foreignMV = this.foreignMV(n, sid);
      addMV = Math.min(addMV, (cfg.maxForeignPct || 0.6) * equity - foreignMV);
      // 全市场单股暴露上限（反羊群）
      const capMV = market.stock.floatShares * price * (cfg.maxStockExposurePct || 0.08);
      const usedMV = this.crossUsed(sid) * price;
      addMV = Math.min(addMV, capMV - usedMV);
      if (addMV <= 0) return;

      const rq = (cfg.qtyPct && cfg.qtyPct[n.type]) || [0.00005, 0.0002];
      const maxByType = market.stock.floatShares * rand(rq[0], rq[1]);
      let qty = Math.min(addMV / price, maxByType, n.acc.cash / (price * (1 + config.trade.feeRate)));
      qty = Math.floor(qty / lot) * lot;
      if (qty < lot) return;
      // 外股只吃对手价
      const asks = market.book.asks;
      if (!asks.length) return;
      const ask = asks[0];
      qty = Math.min(qty, Math.max(lot, Math.ceil((ask.qty - ask.filled) * 0.5)));
      qty = Math.floor(qty / lot) * lot;
      if (qty < lot) return;
      const r = market.place(n.acc, {
        action: ACTIONS.BUY_OPEN,
        qty,
        price: market.clampPrice(ask.price + 0.01),
        now,
        noCooldown: true,
      });
      const filled = this.settleCross(n, market, r, now);
      if (filled > 0) {
        this.spendCrossBudget();
        n.crossCool = (cfg.cooldownTicks && cfg.cooldownTicks[n.type]) || 5;
        this.addCrossUsed(sid, filled);
        this.noteCrossFill(filled);
      }
      return;
    }

    // 卖出：只卖已有持仓（投资者不做裸空）
    if (curQty < lot) return;
    const frac = score < -0.12 ? 1 : 0.5; // 极度便宜才清仓，否则减半
    const rq = (cfg.qtyPct && cfg.qtyPct[n.type]) || [0.00005, 0.0002];
    const maxByType = market.stock.floatShares * rand(rq[0], rq[1]);
    let qty = Math.min(curQty * frac, maxByType);
    qty = Math.min(qty, n.acc.freeSellableLong(sid, now));
    const bids = market.book.bids;
    if (!bids.length) return;
    const bid = bids[0];
    qty = Math.min(qty, Math.max(lot, Math.ceil((bid.qty - bid.filled) * 0.5)));
    qty = Math.floor(qty / lot) * lot;
    if (qty < lot) return;
    const r = market.place(n.acc, {
      action: ACTIONS.SELL_CLOSE,
      qty,
      price: market.clampPrice(bid.price - 0.01),
      now,
      noCooldown: true,
    });
    const filled = this.settleCross(n, market, r, now);
    if (filled > 0) {
      this.spendCrossBudget();
      n.crossCool = (cfg.cooldownTicks && cfg.cooldownTicks[n.type]) || 5;
      this.addCrossUsed(sid, -filled);
      this.noteCrossFill(filled);
    }
  }

  /**
   * 跨股委托收尾：**外股不留挂单**，吃不到的残留当场撤掉，返回实际成交量。
   *
   * 这是"无主委托"的根因：`maybeCrossStock` 挂的是**别人家**的簿，而所有清理路径
   * （requote / gcResting / 日终撤单）都只撤自己 market 上的单，不登记就没有 ownership，
   * 谁也撤不掉（实测 `day.test.js` 抓到的 167 张无主委托里 144 张是跨股单）。
   * 不去维护跨池登记表（所有权太脏、还要处理对方 pool 生命周期），而是**根本不留下挂单**：
   * 成交完剩下的部分当场撤掉，函数返回时那本簿上干干净净。
   */
  settleCross(n, market, r, now) {
    if (!r || !r.ok || !r.order) return 0;
    const filled = r.order.filled || 0;
    if (r.order.qty - filled > 0) {
      market.cancel(n.acc, r.order.id, now, { internal: true });
    }
    return filled;
  }

  /**
   * 该账户的「外股」持仓市值合计（不含 homeStock）。
   *
   * ⚠️ 本股必须排除：机构在自己票上有 330 万股（约 6600 万），把它算进"外股仓位"
   * 会让 `maxForeignPct × 权益 − 本股市值` 永远是负数，跨股一笔都做不成
   *（实测 addMV = −2900 万，全部在买入分支被拦下）。
   */
  foreignMV(n, sid) {
    let mv = 0;
    for (const [k, pos] of n.acc.longs) {
      if (k === n.acc.homeStock) continue;
      const mk = this.game ? this.game.markets.get(k) : null;
      if (!mk) continue;
      let q = 0;
      for (const l of pos.lots) q += l.qty;
      mv += q * mk.lastPrice;
    }
    return mv;
  }

  /**
   * 给全池补上两张**派生标签**（都在 `init` 之后调用一次，也可以在恢复存档后单独调）：
   *
   * ① **券商**（席位系统的数据源，§11.4）：由账户名确定性哈希派生 → 不落盘、不占存档
   *    版本号、不触发逐 tick 标脏；重启后按同一套账户名重算即得同一张分配表。
   * ② **消息情报等级**（消息分层 §4）：机构 = L1（`inst`），机构里再按哈希抽
   *    `config.news.insiderFrac` 的一小撮当 L0 内幕（`insider`），其余 = 公众。
   *
   * ⚠️ 两者都**只读**：券商不改变 NPC 的任何交易行为（§11.4.3「纯展示、零行为影响」），
   * 情报等级只决定"什么时候读得到消息"，不碰公允价值与噪声公式。
   */
  applyTags() {
    const entries = this.npcs.map((n) => ({ name: n.acc.name, role: n.type }));
    const map = broker.allocateNpcBrokers(entries);
    const insiderFrac = (config.news && config.news.insiderFrac) || 0;
    // L0 内幕：从本池机构里按哈希取前 k 个（k = round(机构数 × insiderFrac)，至少 1）。
    // 用「取前 k 名」而不是「哈希 < frac」是为了**每股恰好 1 个**（§4「10 股共 10 个」）——
    // 后者会让某些股票抽不到内幕，那几个池的公允价值就会晚 2 秒才动，
    // 十只股票的提前量参差不齐。
    const inst = this.npcs.filter((n) => n.type === 'inst');
    const k = insiderFrac > 0 ? Math.max(1, Math.round(inst.length * insiderFrac)) : 0;
    const insiders = new Set(
      inst
        .map((n) => ({ name: n.acc.name, h: broker.hashUnit('insider:' + n.acc.name) }))
        .sort((a, b) => a.h - b.h || (a.name < b.name ? -1 : 1))
        .slice(0, k)
        .map((r) => r.name)
    );
    let best = null;
    for (const n of this.npcs) {
      const name = n.acc.name;
      n.broker = map.get(name) || null;
      // 缓存在内存账户对象上（不落盘）：下单/成交时读一次即可
      n.acc.broker = n.broker;
      n.newsTier = insiders.has(name) ? 'insider' : n.type === 'inst' ? 'inst' : 'public';
      n.newsViewer = n.newsTier === 'public' ? null : { tier: n.newsTier };
      if (n.newsTier === 'insider' || (n.newsTier === 'inst' && !best)) best = n.newsViewer;
    }
    this.poolViewer = best;
    // 做市商的席位是固定的（第 i 家自营就是第 i 家券商），不参与上面的随机分配；
    // 它们也不吃消息——自营只做流动性，给它情报等级会变成"用内幕做市"
    for (const m of this.makers) {
      m.broker = m.brokerKey;
      m.acc.broker = m.brokerKey;
      m.newsTier = 'public';
      m.newsViewer = null;
    }
  }

  /** 每 tick 推进市场模拟 */
  step(now) {
    this.tickCount += 1;
    this.priceTrail.push(this.market.lastPrice);
    if (this.priceTrail.length > config.npc.momentumTicks + 10) {
      this.priceTrail.shift();
    }
    this.updateActivityMuls();
    this.updateFairValue(now);
    // 反馈层行为乘数叠在节奏乘数上（rhythm 管时段，feedback 管恐慌/贪婪/磨底）
    this._mul.aggro *= this._fbMul.aggro;
    this._mul.qty *= this._fbMul.qty;
    this._mul.spread *= this._fbMul.spread;
    this.recycleLiquidity(now);
    this.updateForce(now);
    this.updateMoodPolar();
    this.updateIntent();
    // 私人估值的日频漂移（错峰到每天第一 tick，一次算完全部账户 × 关注股）
    if (this.tickCount % this.dayTicks === 0) this.driftPrivateValues();

    // ---- 做市商先铺盘口 ----
    // 顺序有意：先让 6 家自营把双边挂上，投资者的限价/吃单才有对手盘。
    // 做市商不做主动吃单（aggressiveRate=0），只报价 + 被动成交
    //
    // 集合竞价段：**不做主动吃单**。
    // 竞价只累积、不撮合，主动单在这里没有"立刻成交"的语义——价格钉在「对手价 ∓1 分」，
    // 而对手价本身还是试探档逐步外扩出来的虚拟价，于是每笔主动单都在把报价再往外推一分，
    // 收敛档又因为"本 tick 先撤后挂、挂完不再撤"而留下这批远价，竞价成交价被拖出 ±3%
    //（实测收敛档后仍有 459 张超 ±quoteCushion 的委托）。竞价深度交给 requote 的双边报价。
    // 竞价状态整个 tick 只算一次，往下传（见 gcResting）
    const inAuction = this.market.auctionKind ? !!this.market.auctionKind(now) : false;
    for (const m of this.makers) {
      this.gcResting(m, now, inAuction);
      if (this.shouldRequoteMaker(m, now)) this.requoteMaker(m, now);
    }

    for (const n of this.npcs) {
      this.gcResting(n, now, inAuction);
      this.updateBias(n, now);
      this.updateSide(n);
      this.syncLend(n);
      // 投资者不再人人双边报价：盘口改由做市商提供，只有大户/中户留小额限价单
      //（见 quoteScaleOf）。其余类型只主动吃单——这才是真实市场的样子
      if (this.quoteScaleOf(n) > 0 && this.shouldRequote(n, now)) this.requote(n, now);
      // 分歧度越高机构主动吃单越频繁，多空大战放量；其余类型用各自 aggressiveRate。
      // 再乘日内节奏：开盘/尾盘段吃单更密、午间更稀
      const p = this.profileOf(n);
      const plan = this.liveLlmPlan();
      const llmAggro = plan && p.canShort ? plan.aggro || 1 : 1;
      const rate =
        p.aggressiveRate *
        (p.polarOrderScale ? 1 + this.polar * 0.8 : 1) *
        this._mul.aggro *
        llmAggro;
      if (!inAuction && Math.random() < rate) this.tryAggressive(n, now);
      // 跨股（P2）：看外股、按私人估值下单。放在本股行为之后，
      // 保证"先照顾自己的仓位"——真实投资者也是先看持仓再看机会
      this.maybeCrossStock(n, now, inAuction);
    }
    // 本阶段已经完整走过一轮报价：此后买盘侧还是空的，就是真的空档（见 recycleLiquidity）
    this._quotedOnce = true;
  }

  /**
   * 休市（午休 / 夜间）推进：只走趋势、消息与公允价值，**不报价、不撮合**。
   *
   * 这是「隔夜跳空」的来源：价格在休市期间冻在收盘价上，而定价锚继续迁移。
   * 次日开盘集合竞价第一次集中撮合时，NPC 拿着已经走远的锚报价，
   * 开盘价自然对昨收出现缺口。没有这一步，「天」就只是多了个时钟而已。
   */
  stepFairValue(now) {
    this.tickCount += 1;
    this.priceTrail.push(this.market.lastPrice);
    if (this.priceTrail.length > config.npc.momentumTicks + 10) {
      this.priceTrail.shift();
    }
    this.updateFairValue(now);
  }

  updateFairValue(now) {
    const cfg = config.npc;
    const init = this.stock.initPrice;
    const last = this.market.lastPrice;

    this.updateTrend();
    this.updateCycle();
    this.updateFeedback(); // 恐慌/贪婪慢变量（step 与 stepFairValue 两条路径共用）

    // 夜间（40 秒休市代表现实的一整夜）推力按 overnightDriftMul 放大。
    // **重心与短端公允一起放大**——只推短端的话，机构的定价锚（fundWeight 0.7）一夜不动，
    // 而机构是竞价簿里单量最大的一侧，最大成交量原则算出的开盘价会被这批"没改口"的
    // 报价拉回昨收，跳空幅度衰减掉一半以上（见 config.npc.fundOvernightFollow）
    const overnight = this.market.isNight && this.market.isNight(now);
    const trendMul = overnight ? cfg.overnightDriftMul || 1 : 1;
    const fundMul = overnight && cfg.fundOvernightFollow ? trendMul : 1;

    // 重心跟随趋势慢一拍迁移（大级别的底），再以超长期保险丝回归发行价。
    // 回归用对数空间（乘性距离对称）：涨十倍和跌到十分之一受同等强度的拉回，
    // 不会像线性回归那样把深跌底部额外托住。
    // 2026-10-18：fundAnchor 从 0.0008（半衰期 1 个游戏日，牛熊杀手）降到 2e-5 的
    // 超长期保险丝，周月级方向改由 cycle 层承载（见下面的周期成分记账）
    this.fund *= 1 + this.trendDrift * fundMul * cfg.fundTrendFollow;
    this.fund *= 1 + Math.log(init / this.fund) * cfg.fundAnchor;
    this.fund *= 1 + gauss() * cfg.fundNoiseRel;
    const cyc = config.npc.cycle;
    if (cyc && cyc.enabled && this._cycInit) {
      // 周期成分单独记账（随机游走），重心以纹理衰减率回归它：
      // - 周期推力不直接乘在 fund 上，而是进 cycleLog → fundCycle，fund 以
      //   ~10 个游戏日半衰期跟上（价格本身通过 fv 的直接推力立即感知周期）
      // - **保险丝必须作用在 cycleLog 上**：fund 每 tick 被重建成
      //   fundCycle × exp(tex)，作用在 fund 上的回归会被重建覆盖掉。
      //   cycleLog *= (1−fundAnchor) 与旧版 fund 锚同数学：给周期游走一个
      //   与漂移速度相关的软边界（牛顶 ≈ e^(日漂移/0.0177) ≈ 2~4×，熊底 ≈ 0.5×），
      //   蒙特卡洛标定时的行为与此一致
      // - **没有纹理衰减重心也会随机游走**：3 分钟相位漂移在重心上无衰减累积，
      //   day-probe 实测把日收益 std 从 4.38% 抬到 7.25%。衰减 + textureCap
      //   把相位纹理的偏离限制在 ±cap 内
      this.cycleLog += this.cycleDrift * fundMul;
      this.cycleLog *= 1 - cfg.fundAnchor;
      const fundCycle = init * Math.exp(this.cycleLog);
      let tex = Math.log(this.fund / fundCycle);
      const cap = cyc.textureCap || 0.2;
      tex = Math.max(-cap, Math.min(cap, tex));
      this.fund = fundCycle * Math.exp(tex * (1 - this._texDecay));
    }

    let fv = this.fairValue;
    // 阶段推力：对数空间 → 乘性，越涨越猛（翻几倍 / 腰斩的来源）。
    // **只有夜间**按 overnightDriftMul 放大——游戏里的 40 秒夜间代表现实一整夜，
    // 不放大的话次日开盘价与昨收几乎贴在一起。午休同样是 closedForTrading，
    // 但只是盘中暂停，同样放大会在 13:00 制造与隔夜同量级的假跳空
    let push = (this.trendDrift + this.cycleDrift) * trendMul;
    // 内生正反馈：**跌比涨快，反弹比下跌弱**（config.npc.feedback）。
    // 方向敏感：只放大「符合 mood 的那一侧」，反侧反而收力——
    // 这样总波动不必抬高，却能压出左肥尾（恐慌极端、赶顶加速）。
    // mood=0 时逐位退回旧式 push。
    const fb = config.npc.feedback;
    const mood = fb && fb.enabled ? this.mood : 0;
    if (mood < 0) {
      const panic = -mood;
      if (push < 0) push *= 1 + panic * (fb.panicAsym || 0); // 恐慌：跌更狠
      else push *= 1 - panic * (fb.panicReboundDamp || 0.35); // 恐慌：反弹收力
    } else if (mood > 0) {
      if (push > 0) push *= 1 + mood * (fb.greedAsym || 0); // 贪婪：涨更顺
      else push *= 1 - mood * (fb.greedDipDamp || 0.2); // 贪婪：回调收力（惜售）
    }
    fv *= 1 + push;
    // 赶顶：贪婪 × 近期已涨 → 额外上推（顶部加速段）。夹紧防失控。
    if (mood > 0 && fb && fb.enabled) {
      let ret12 = 0;
      const W = 12;
      if (this.priceTrail.length > W) {
        const ref = this.priceTrail[this.priceTrail.length - 1 - W];
        if (ref > 0) ret12 = (last - ref) / ref;
      }
      if (ret12 > 0) {
        const kick = Math.min(fb.blowoffCap || 0.012, mood * ret12 * (fb.blowoffGain || 0));
        fv *= 1 + kick * trendMul;
      }
    }
    // 消息推力（乘性，只算本股 + 大盘消息）。viewer = 全池最早知道的那一级：
    // 公允价值是池级共享量，机构（L1）在公开前 4s 就把它推起来 → 「股价先动、消息后到」
    fv *= 1 + this.news.fvDrift(now, this.stock.id, this.poolViewer);
    // 噪声：恐慌时波动聚集（跌得急、反弹毛刺多）；mood=0 时倍数为 1
    let volMul = 1;
    if (mood !== 0 && fb && fb.enabled) {
      volMul =
        1 +
        Math.abs(mood) * (fb.volGain || 0) * (mood < 0 ? fb.panicVolAsym || 1 : 1);
    }
    fv *= 1 + gauss() * cfg.noiseRel * volMul; // 短期噪声（毛刺）
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
   * 行情周期层（config.npc.cycle）：牛 / 熊 / 震荡三态马尔可夫机，周月级慢变量。
   * 与 trend 相位（分钟级纹理）正交，补上真实市场「盈利/流动性周期」那一层慢变量。
   * 宪法与 trend 相位一致（见 config.npc.cycle 注释）：
   * - 换挡无记忆：每 tick 恒定小概率换挡（几何分布），已走多久推不出还要走多久，
   *   顶底无法倒计时——刻意不做「抽一次时长跑完」的日程表，那会留下可倒计时的破绽
   * - 幅度不做目标：整段周期对数涨/跌幅抽签后摊成每 tick 恒定慢推力；
   *   段内仍有 trend 纹理与噪声，K 线扭动、无法直线外推
   * - 隔夜折算：夜间推力按 overnightDriftMul 放大，一日有效推力当量 ≈
   *   一天 tick 数 × boost（boost ≈ 1.77），目标涨幅先除以它再摊，否则幅度凭空翻倍
   */
  updateCycle() {
    const cyc = config.npc.cycle;
    if (!cyc || !cyc.enabled) {
      this.cycleDrift = 0;
      return;
    }
    if (!this._cycInit) {
      const tickMs = config.tickIntervalMs || 700;
      const phases = config.day && config.day.enabled ? config.day.phases : null;
      const dayMs = phases ? phases.reduce((s, p) => s + p.ms, 0) : 620000;
      const nightMs = phases
        ? (phases.find((p) => p.key === 'night') || { ms: 0 }).ms
        : 0;
      this._dayTicks = dayMs / tickMs;
      const mul = config.npc.overnightDriftMul || 1;
      this._nightBoost =
        1 + ((nightMs / tickMs) * (mul - 1)) / this._dayTicks;
      // 每 tick 换挡概率 = 1 /（期望持续天数 × 一天 tick 数）——几何分布无记忆
      this._cycHazard =
        1 / (((cyc.minDays + cyc.maxDays) / 2) * this._dayTicks);
      // 纹理衰减率：相位漂移给重心注入的偏离按此半衰期回归周期成分
      this._texDecay =
        Math.log(2) / ((cyc.textureHalfLifeDays || 10) * this._dayTicks);
      this._cycInit = true;
    }
    if (this.cycleLeft <= 0 || Math.random() < this._cycHazard) {
      const r = Math.random();
      const dir =
        r < cyc.bearWeight ? -1 : r < cyc.bearWeight + cyc.bullWeight ? 1 : 0;
      this.cycleDir = dir;
      const target =
        dir === 0
          ? rand(cyc.flatTarget[0], cyc.flatTarget[1])
          : dir > 0
            ? rand(cyc.bullTarget[0], cyc.bullTarget[1])
            : rand(cyc.bearTarget[0], cyc.bearTarget[1]);
      // 摊到每 tick：除以（期望持续 tick × 隔夜放大当量），整段期望幅度 ≈ target
      this.cycleDrift = target / (((cyc.minDays + cyc.maxDays) / 2) * this._dayTicks * this._nightBoost);
      this.cycleLeft = 1; // 已进入一个新状态；下次换挡由 hazard 概率决定
    }
    this.cycleLeft += 1;
  }

  /**
   * 内生正反馈（config.npc.feedback）：维护 mood（恐慌/贪婪）与磨底标志。
   * - mood 目标由近期收益（**跌比涨冲击大**）、距峰值回撤、周期方向先验合成
   * - 磨底 = 回撤够深 + 近期跌不动了 → 活跃度收手，反弹无力
   * - mood=0 且非磨底时，本层不改任何定价/行为（可被单测安全隔离）
   */
  updateFeedback() {
    const fb = config.npc.feedback;
    if (!fb || !fb.enabled) {
      this.mood = 0;
      this._grind = false;
      this._fbMul.aggro = 1;
      this._fbMul.qty = 1;
      this._fbMul.spread = 1;
      return;
    }
    const last = this.market.lastPrice;
    if (last > this.peakPx) this.peakPx = last;
    const dd = this.peakPx > 0 ? last / this.peakPx - 1 : 0; // ≤ 0

    // 近期收益（短窗，与 momentum 错开用更短的 12 tick，抓「恐慌速度」）
    let ret = 0;
    const W = 12;
    if (this.priceTrail.length > W) {
      const ref = this.priceTrail[this.priceTrail.length - 1 - W];
      if (ref > 0) ret = (last - ref) / ref;
    }

    // 目标 mood：不对称——跌的冲击大于涨
    let target = 0;
    if (ret < 0) target += ret * fb.panicGain;
    else target += ret * fb.greedGain;
    target += dd * fb.ddGain;
    target += this.cycleDir * (fb.cyclePrior || 0);
    target = Math.max(-1, Math.min(1, target));

    const hl = Math.max(1, fb.halfLifeTicks || 320);
    const alpha = 1 - Math.pow(0.5, 1 / hl);
    this.mood += (target - this.mood) * alpha;
    this.mood = Math.max(-1, Math.min(1, this.mood));

    // 磨底：够痛 + 跌不动了
    this._grind =
      dd <= (fb.grindDrawdown ?? -0.22) &&
      Math.abs(ret) < (fb.grindQuietRet ?? 0.02) &&
      this.mood <= 0;

    // 行为乘数：贪婪加力、恐慌更凶；磨底整体收手
    const greed = Math.max(0, this.mood);
    const panic = Math.max(0, -this.mood);
    let aggro = 1 + greed * (fb.greedAggro || 0) + panic * (fb.panicAggro || 0);
    let qty = 1 + greed * (fb.greedAggro || 0) * 0.7 + panic * (fb.panicAggro || 0) * 0.5;
    let spread = 1 + panic * 0.25; // 恐慌时点差略放宽（流动性变贵）
    if (this._grind) {
      aggro *= fb.grindAggroMul ?? 0.55;
      qty *= fb.grindQtyMul ?? 0.65;
      spread *= fb.grindSpreadMul ?? 1.55;
    }
    this._fbMul.aggro = aggro;
    this._fbMul.qty = qty;
    this._fbMul.spread = spread;

    // 恐慌深时强平兜底滑点加大（踩踏自我强化）；由 market 消费
    if (this.market) {
      this.market.fbPanicSlip = 1 + panic * (fb.panicSlipMul || 0);
    }
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
    // 主力脑意图提示：仅提高「启动某种已存在意图」的概率，不发明新战术、
    // 不绕过 duration/cooldown/entry 门槛——最终仍经 beginIntent 的合法检查
    const plan = this.liveLlmPlan();
    if (plan && plan.intent && plan.intent !== 'none' && plan.intentChance > 0) {
      if (this.intentCool[plan.intent] <= 0 && Math.random() < plan.intentChance) {
        this.beginIntent(plan.intent);
      }
    }
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
      // 机构专属消息仍小幅同向（知情盘）。
      // viewer 传**本账户自己的等级**：拿到提前量之后，这条「对倒」升级成
      // 「利好正式公开前先抢筹拉高 → 公开时散户跟风 → 机构反手出货」，
      // 即教科书式的「利好出尽是利空」，与既有机制同源、不打架
      const sb = this.news.sentimentByScope(now, this.stock.id, n.newsViewer);
      const publicS = Math.max(-1, Math.min(1, sb.all + sb.retail));
      s -= publicS * p.publicNewsFade;
      s += sb.inst * (p.instNewsFollow != null ? p.instNewsFollow : 0.35);
    } else {
      const scope = p.newsScope || (n.type === 'inst' ? '机构' : '散户');
      s = this.news.sentiment(scope, now, this.stock.id, n.newsViewer);
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
        const gain = config.npc.momentumGain * (p.momentumGainMul || 1) * this.heatMul(n.type);
        s += Math.max(-cl, Math.min(cl, mom * gain));
      }
    }

    // 战术意图（跨 tick 的计划）——放在最末，意图的意志压过当 tick 的噪声
    s += this.intentBias(n);

    // 大模型主力脑：只倾斜聪明钱（机构/游资），被动持有者不跟主力叙事
    if (p.canShort) {
      const plan = this.liveLlmPlan();
      if (plan && plan.bias) {
        const scale = n.type === 'hot' ? plan.scaleHot != null ? plan.scaleHot : 0.55 : 1;
        s += plan.bias * scale;
      }
    }

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

  /**
   * 清掉已完结的挂单引用，并回收**主动单的残单**。
   *
   * 主动单（tryAggressive）的价格钉在「对手价 ∓1 分」，`impactCap` 只保证大部分能吃到，
   * 超出的量必然留在盘口——那本身就是一张并不想要的挂单。旧实现里它靠 requote 的
   * 「先撤后挂」顺手清掉；P1 把 inst/hot/small 的报价关掉（`quoteScaleOf === 0`）之后
   * 这条清理路径就没了，于是竞价段（只入簿不撮合）挂出来的每一笔主动单都变成永久残单：
   * 实测「低于现价 2.4% 的买单」恒为 753 张、一整天不动，**冻结投资者现金 26%~30%**。
   *
   * 所以给主动单打 `aggroTtl`，在这里按 tick 老化。两处刻意的设计：
   * ① **竞价段不递减**——竞价要的是委托累积（见 `shouldRequote` 的注释），
   *    在竞价里逐 tick 撤单会把虚拟成交价搅散；竞价结束进入连续竞价后才开始老化，
   *    陈旧单 2 tick 内清干净；
   * ② 撤不掉（竞价锁单窗口）时**保留引用**而不是丢弃，等锁单解除后下一 tick 再撤——
   *    丢掉引用才是真的撤不掉了（就是"无主委托"的成因）。
   */
  gcResting(n, now = Date.now(), inAuction = null) {
    // 竞价状态由调用方算一次传进来：`step` 每个 tick 要过 322 个账户，
    // 每人算一次 `dayCycle.auction()` 是白扔掉的开销（实测均值从 16ms 涨到 28ms）
    const auction =
      inAuction == null ? (this.market.auctionKind ? !!this.market.auctionKind(now) : false) : inAuction;
    const keep = [];
    for (const o of n.ownResting) {
      if (o.status !== 'live') continue;
      if (o.aggroTtl != null) {
        if (o.aggroTtl <= 0 && !auction) {
          const r = this.market.cancel(n.acc, o.id, now, { internal: true });
          if (r && r.ok) continue;
        } else if (o.aggroTtl > 0) {
          o.aggroTtl -= 1;
        }
      }
      keep.push(o);
    }
    n.ownResting = keep;
  }

  /**
   * 把主动单登记进 ownResting，并打上 TTL（见 `gcResting`）。
   * 只用于 tryAggressive —— 报价单（requote/requoteMaker）有自己的撤挂节奏，
   * 不该被 TTL 提前撤掉。
   */
  trackAggro(n, order) {
    if (!order) return;
    const ttl = config.npc.aggroTtlTicks;
    if (ttl > 0) order.aggroTtl = ttl;
    n.ownResting.push(order);
  }

  /**
   * 流动性回收：做市池的"活水"。两条判据，触发的东西完全不同——
   *
   * ① **全池现金低于地板**（原有）：空头保证金会把池子吸干（开空时现金的一半进保证金），
   *    钱归零后没人买得动 → 双向死锁。按人头平均回补一小段，只补到地板不注水。
   *
   * ② **买盘侧空了**（2026-10-16 加）：这才是真正的失败态——玩家挂卖单没人接、
   *    砸盘直接穿档。**根因不是池子没钱，是钱的位置**：实测买盘空那一刻全池现金
   *    仍占流通市值 18.75%（有买盘时 18.92%，几乎一样），但拿得出一个手数现金的
   *    账户只剩 **19.9/316**——一天下来散户/中户都把现金换成了股票，钱集中在机构手里，
   *    买盘侧实际只剩十几个聪明钱账户，它们一转空头阵营买盘就整侧空掉。
   *    所以**按症状补**：只在买盘真的空了的时候，给最穷的几个账户补到
   *    `liquidityTopUpLots` 手，补一次歇 `liquidityTopUpCooldown` tick。
   *
   * ⚠️ 冷却与"每次只补几个人头"是必需的，不是保守：补进去的钱会被立刻挂成买盘
   * （可用现金随即归零），按"人头不足"当判据的话**每 tick 都会触发**——
   * 正式服实测 3 秒内连记 4 条日志，等于逐 tick 无限注水，还会把账户反复标脏。
   */
  recycleLiquidity(now = Date.now()) {
    const cfg = config.npc;
    if (!this.npcs.length && !this.makers.length) return;
    // 做市商上线后，钱的"活水"只补给自营：投资者是真实投资者，不该被系统注资
    const pool = this.makers.length ? this.makers : this.npcs;
    if (this._topUpCool > 0) this._topUpCool -= 1;
    const lot = this.stock.lotSize;
    const need = (this.market.lastPrice || 1) * lot; // 挂一手需要的现金
    let cash = 0;
    for (const n of pool) cash += n.acc.cash;
    const floor = (cfg.liquidityFloor || 0) * this.capScale;
    const dry = !!cfg.liquidityFloor && cash < floor;
    // 集合竞价里簿是"只累积不撮合"的、开盘那一 tick 本来就空，不算症状；
    // 同理本阶段第一 tick（`_quotedOnce` 还没置）也还没轮到自己挂单——
    // init() 不挂单，首个 step 里 recycleLiquidity 跑在报价循环**之前**，
    // 缺这道闸的话每次开服/换阶段都会给 10 只股票各记一条假的"买盘侧为空"
    const auction = this.market.auctionKind ? this.market.auctionKind(now) : null;
    // 判据从"整侧空"改成"深度不够"：`bids.length === 0` 只有归零才动作，是事后抢救，
    // 玩家在看盘时早就看到五档全空了。改成按深度，能在空档形成之前就把钱补进去。
    // 未配置 liquidityBidDepthLots 时退回原判据（探针 A/B 用）。
    const minBid = cfg.liquidityBidDepthLots != null ? cfg.liquidityBidDepthLots * lot : 0;
    const bidDepth = minBid > 0 ? this.sideDepth('bid') : 0;
    const thinBid =
      minBid > 0 ? bidDepth < minBid : this.market.book.bids.length === 0;
    const noBid = !auction && this._quotedOnce && thinBid;
    if (!dry && (!noBid || this._topUpCool > 0)) {
      this._dryLogged = false;
      return;
    }
    if (!this._dryLogged) {
      this._dryLogged = true;
      logger.info(
        `[我是股神] ${this.stock.name} NPC 池流动性不足（` +
          (dry
            ? `全池现金 ${r2(cash)} < 地板 ${r2(floor)}`
            : `买盘深度 ${Math.round(bidDepth / lot)} 手 < 目标 ${Math.round(minBid / lot)} 手`) +
          `），开始回补`
      );
    }
    if (dry) {
      const per = ((floor - cash) * cfg.liquidityRefill) / pool.length;
      for (const n of pool) n.acc.cash = r2(n.acc.cash + per);
      // 现金变化影响挂单冻结口径，存档器需要知道这些账户变了
      for (const n of pool) this.market.notifyChange(n.acc);
      return;
    }
    // 买盘空了：只给最穷的几个人头补到目标，然后歇一会儿
    const baseLots = cfg.liquidityTopUpLots != null ? cfg.liquidityTopUpLots : 8;
    const heads = Math.min(pool.length, cfg.liquidityTopUpHeads != null ? cfg.liquidityTopUpHeads : 2);
    const cd = cfg.liquidityTopUpCooldown != null ? cfg.liquidityTopUpCooldown : 12;
    if (heads <= 0) return; // 配 0 = 关掉这条（探针 A/B 用）
    // 补款目标按**缺口摊到本轮人头**，单人封顶 40 手：
    // 固定 8 手的旧口径下，一轮注入 ≈ 8 手 × 2 人，挂在五档里只够填一档的一半，
    // 深度永远低于 thinBookFloor，主动卖单全被拦 → 买盘不消耗也不增长，盘面长时间冻住。
    // 按缺口摊之后一轮就能把深度垫到目标；封顶与冷却保证不会逐 tick 无限注水。
    const gapLots = minBid > 0 ? Math.max(0, Math.ceil((minBid - bidDepth) / lot)) : 0;
    const perLots = Math.min(40, Math.max(baseLots, Math.ceil(gapLots / heads)));
    const target = need * perLots;
    // 只补**还有买入空间**的账户：钱给了已经打满 longCapMult 的账户也进不了买盘，
    // 只会变成闲钱把池子现金越垫越高（进而抬高力量天平的"弹药"票）。
    // 这条同时给机制设了一个自然上界——全池买入空间被填满后它就不再注水
    const poor = pool
      .filter((n) => n.acc.cash < target && this.longCapacity(n) >= lot)
      .sort((a, b) => a.acc.cash - b.acc.cash);
    if (!poor.length) {
      this._topUpCool = cd;
      return;
    }
    const k = Math.min(poor.length, heads);
    for (let i = 0; i < k; i++) {
      poor[i].acc.cash = r2(target);
      this.market.notifyChange(poor[i].acc);
    }
    this._topUpCool = cd;
  }

  shouldRequote(n, now) {
    // 集合竞价：只在手上完全没有挂单时补一次盘口，之后保持不动。
    // 跟着 tick 一直撤单-重挂会把竞价簿搅散——竞价要的是"委托累积起来"，
    // 每 tick 撤光重挂的话虚拟成交价永远在抖，也凑不出真实的集中成交量。
    // 例外是**试探档 → 收敛档**这一次切换（锁单前 auctionConvergeMs）：
    // 真实市场 09:20 前会有一波撤掉试探远价的动作，报价在这里必须重新落一次
    if (this.market.auctionKind && this.market.auctionKind(now)) {
      const tag = this.session && this.session.converging ? 'converge' : 'probe';
      if (n.aucTag !== tag) {
        n.aucTag = tag;
        return true;
      }
      return n.ownResting.length === 0;
    }
    n.aucTag = null;
    if (n.ownResting.length === 0) return true;
    // 买盘侧空着、而自己有现金却没有活买单 → 立刻补，不等随机门。
    // 这是买盘空档的主要来源：自己的买单被卖方吃光之后，手上还剩一张卖单
    // （ownResting 非空）就要等 25%/tick 的随机门，平均 4~5 tick 才补回买盘——
    // 实测买盘空档那一刻，"有资格挂买盘"的账户全部卡在这里（手上只有卖单在挂）。
    // ⚠️ 判据只看**买侧**（bids 空 + 有现金 + 没有活买单），从不看卖侧；而 requote
    // 是双边撤挂，所以这里一旦放行，手上那张卖单也会被一起撤掉重挂。这是有意的
    // （双边同时重挂价差更整齐），但别理解成"卖侧不空就不补"——卖侧空不空跟这个分支无关
    if (
      this.market.book.bids.length === 0 &&
      n.acc.cash >= this.market.lastPrice * this.stock.lotSize &&
      !n.ownResting.some(
        (o) => o.status === 'live' && (o.action === ACTIONS.BUY_OPEN || o.action === ACTIONS.BUY_CLOSE)
      )
    ) {
      return true;
    }
    if (n.requoteIn > 0) {
      n.requoteIn -= 1;
      return false;
    }
    // 随机 + 目标价偏离触发重报价（活跃时段重报更勤，盘口跟得更紧）
    if (Math.random() < 0.25 * this._mul.requote) {
      n.requoteIn = Math.floor(rand(config.npc.minRequoteTicks, config.npc.minRequoteTicks + 5));
      return true;
    }
    return false;
  }

  /** 撤旧挂单并按公允价值+情绪挂双边报价 */
  requote(n, now) {
    // 买盘供给保护：**本账户此刻挂不出新买单时，保留它原来那张买单**。
    // requote 是先撤后挂；撤掉之后挂不回来，等于把盘口最后一张买单抹掉。
    // 实测买盘空档那一刻：99.7% 的账户手上挂着卖单、**0% 挂着买单** —— 而当时
    // 91.8% 的账户是"现金不够一手"（不是空头阵营、不是额度满）。
    // 也就是说买盘不是被主动单吃光的（thinBookFloor + maxTake 已经保证至少留一档），
    // 而是被自己的撤单动作抹掉的：一张买单在随机 requote 时被撤，随即因没钱挂不回去，
    // 盘口就永久少一张。316 个账户轮流这么干，五档自然被啃到全空。
    const canBid = n.acc.cash >= this.market.lastPrice * this.stock.lotSize;
    for (const o of n.ownResting) {
      if (o.status !== 'live') continue;
      const isBid = o.action === ACTIONS.BUY_OPEN || o.action === ACTIONS.BUY_CLOSE;
      if (isBid && !canBid) continue;
      this.market.cancel(n.acc, o.id, now, { internal: true });
    }
    n.ownResting = n.ownResting.filter((o) => o.status === 'live');
    // 只吃单的类型（做市商上线后是 inst/hot/small）：撤完旧单就结束，
    // 不再往盘口上挂自己的量——盘口由 6 家自营铺
    const qs = this.quoteScaleOf(n);
    if (qs <= 0) return;
    // 上面保留下来的买单还在簿上，本 tick 不再重复挂一张（同一账户两张买单会虚增深度）
    const keptBid = n.ownResting.some(
      (o) => o.status === 'live' && (o.action === ACTIONS.BUY_OPEN || o.action === ACTIONS.BUY_CLOSE)
    );

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
    const qlw = this.quoteLastWeight(p);
    const base = qlw * lastPx + (1 - qlw) * fv;
    // 情绪直接平移报价中枢，再硬夹到最新价 ±quoteCushion（小于价格笼子 5%）：
    // 公允价值无论滑多远，盘口都留在可成交区间，成交不会被笼子切断
    let center = base * (1 + sentiment * (p.centerShift != null ? p.centerShift : 0.006));
    // 战术意图的额外压价（压盘吸筹：把报价中枢按下去，反弹一上来就被自己的卖单压住）
    const ie = this.intentEffects(n);
    if (ie && ie.pressDown) center *= 1 - ie.pressDown;
    const cush = this.quoteCushion();
    center = Math.min(lastPx * (1 + cush), Math.max(lastPx * (1 - cush), center));
    // 点差按价格比例缩放（价位高点差大、价位低点差小），下限 0.02 防止取整后买一=卖一；
    // 再乘日内节奏：活跃段（开盘/尾盘）点差收窄，清淡段放宽
    const spreadRange = p.spread || [0.001, 0.003];
    const spread = Math.max(
      0.02,
      base * rand(spreadRange[0], spreadRange[1]) * this._mul.spread
    );
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
    if (!keptBid && (!wantShort || shortQty > 0) && bidPx > 0.01) {
      let qty = roundLot(
        rand(rq[0], rq[1]) * this.qtyScale * qs * reScale * (1 + tilt) * (ie ? ie.bidBoost : 1) * this._mul.qty,
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
      rand(rq[0], rq[1]) * this.qtyScale * qs * (1 - tilt) * (ie ? ie.askBoost : 1) * this._mul.qty,
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
            rand(aq[0], aq[1]) * this.qtyScale * moodScale * (ie ? ie.aggroBoost : 1) * this._mul.qty,
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
            // 残单必须登记：impactCap 只保证"大部分成交"，超出最优档承接力的那部分会留在盘口。
            // 不登记它就不在 ownResting 里，任何路径都撤不掉 → 竞价段（只入簿不撮合）每一笔
            // 主动单都变成永久残单，而且**下一笔主动单会拿这笔远价当对手价再往外定一分**
            //（试探档 ±8% 就是这么被滚出去的）。登记后由 gcResting 按 aggroTtl 回收
            const r = isCover
              ? this.market.place(n.acc, { action: ACTIONS.BUY_CLOSE, qty, price, now, noCooldown: true })
              : this.market.place(n.acc, this.buyOpenOpts(n, qty, price, now));
            if (r && r.ok) this.trackAggro(n, r.order);
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
        // 给买盘留一口：impactCap 允许吃到最优档的 aggroDepthMult(3) 倍 ——
        // 买一剩 5000 股时一笔卖单可砸 15000 股，买一到买五被一笔扫光是常态。
        // **这才是"五档买盘突然全空"的机械原因**：旧口径只在买一 < 3000 股时才拦，
        // 剩 3001 股时照样整侧扫穿；而扫穿后买盘补不回来（挂买的条件比挂卖严得多），
        // 盘面就冻在那里——没人买、没人卖、价格不动，正好是玩家看到的"诡异"。
        // 改成"砸完必须留 floor 股"，厚买盘时 maxTake 巨大，行为与原来一致。
        const keep = Math.min(floor, bidRemain);
        const maxTake = Math.max(0, bidRemain - keep);
        const sized = (cap) =>
          Math.floor(Math.min(cap, this.impactCap(bid), maxTake) / lot) * lot;
        if (maxTake < lot) return;
        if (sellable >= 100) {
          let qty = roundLot(
            rand(aq[0], aq[1]) * this.qtyScale * moodScale * (ie ? ie.aggroBoost : 1) * this._mul.qty,
            lot
          );
          qty = sized(Math.min(qty, sellable));
          if (qty >= lot) {
            const r = this.market.place(n.acc, {
              action: ACTIONS.SELL_CLOSE,
              qty,
              price: this.market.clampPrice(bid.price - 0.01),
              now,
              noCooldown: true,
            });
            if (r && r.ok) this.trackAggro(n, r.order);
          }
        } else if (canShort && !n.acc.sideLock(this.stock.id).long) {
          // 开空同样要求多头端是空的（一手都不剩、也没有在途买开/买平之外的多头占用）
          let qty = roundLot(
            rand(aq[0], aq[1]) * this.qtyScale * moodScale * (ie ? ie.aggroBoost : 1) * this._mul.qty,
            lot
          );
          qty = sized(qty);
          if (qty >= lot) {
            const r = this.market.place(n.acc, {
              action: ACTIONS.SELL_OPEN,
              qty,
              price: this.market.clampPrice(bid.price - 0.01),
              now,
              noCooldown: true,
            });
            if (r && r.ok) this.trackAggro(n, r.order);
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
