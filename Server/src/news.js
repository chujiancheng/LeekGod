/**
 * 随机消息系统：利多 / 利空，影响 NPC 情绪与公允价值
 */
const config = require('./config');

// 文案按 scope 分池：先定 scope 再取该池文案，避免「机构」scope 播宏观政策这类语义错配。
// 全体 = 政策 / 宏观 / 大盘；机构 = 研报 / 调研 / 大宗 / 席位；散户 = 股吧 / 小道 / 情绪。
const TEMPLATES = {
  全体: {
    positive: [
      '央行降准降息，市场流动性充裕',
      '宏观经济数据超预期回暖',
      '重磅产业扶持政策落地，行业景气度抬升',
      '北向资金单日净买入创阶段新高',
      '监管层表态呵护市场，释放积极信号',
      '大盘放量突破关键点位，做多情绪升温',
      '社保与险资提高权益配置比例',
      '减税降费新政出台，盈利预期改善',
      '股指期货升水扩大，机构看多后市',
      '国常会部署稳增长措施，基建消费双轮驱动',
      '隔夜外围市场普涨，风险偏好修复',
      '央行公开市场净投放放量，资金面转松',
    ],
    negative: [
      '外围市场隔夜大跌，风险偏好回落',
      '监管部门下发问询函，市场关注度升温',
      '宏观数据不及预期，复苏动能减弱',
      '资金面收紧，短端利率快速抬升',
      '量能背离，指数跌破关键支撑位',
      '北向资金大幅净流出，外资持续减持',
      '大宗商品价格暴涨，通胀担忧升温',
      '行业增速数据不及预期，景气度回落',
      '新股扩容节奏加快，市场资金面承压',
      '信贷数据弱于预期，宽信用传导受阻',
      '海外央行超预期加息，风险资产承压',
      '成交量持续萎缩，观望情绪浓厚',
    ],
  },
  机构: {
    positive: [
      '头部券商上调评级至买入，目标价大幅上修',
      '机构密集调研，关注度显著提升',
      '社保与公募现身股东名单，长线资金进驻',
      '大宗交易溢价成交，承接方为知名私募',
      '龙虎榜机构专用席位净买入居前',
      '获纳入重要指数样本，被动资金将流入',
      '卖方研报一致上修明年盈利预测',
      '定增获机构全额认购，锁价发行落地',
      '主要股东终止减持计划并承诺不减持',
      '调研纪要显示产能利用率超预期',
      '基金重仓名单新增该标的',
      '产业资本增持，释放估值底部信号',
    ],
    negative: [
      '机构专用席位现身龙虎榜卖方，抛压明显',
      '大宗交易折价成交，接盘方为游资席位',
      '卖方研报集体下调盈利预测与目标价',
      '基金减仓报告出炉，重仓比例下降',
      '大股东披露减持计划，规模较大',
      '机构调研后普遍表示谨慎，未见加仓',
      '定增破发，参与机构浮亏',
      '机构专用席位连续多日净卖出',
      '限售股解禁在即，机构持仓面临松动',
      '评级被下调至中性，估值溢价难以维持',
      '长线资金撤离，机构股东席位减少',
      '股权质押比例偏高，机构下调风险评级',
    ],
  },
  散户: {
    positive: [
      '股吧人气飙升，讨论量冲上榜首',
      '传公司订单饱满，产线加班赶工',
      '有消息称大资金正在悄悄吸筹',
      '社区热议该股将迎来主升浪',
      '传闻新产品即将放量，渠道铺货超预期',
      '各路大V集体看多，跟风盘涌入',
      '群里有「内部人士」称月底有重大利好',
      '短线资金抱团迹象明显，跟风买盘活跃',
      '传闻公司将公布高送转方案',
      '打板资金连续上榜，情绪面高涨',
      '有股友晒出满仓截图，引发跟买',
      '小道消息称下季度业绩大幅超预期',
    ],
    negative: [
      '股吧情绪转差，恐慌言论刷屏',
      '有传言称公司财务数据存在瑕疵',
      '社区热议高位放量滞涨，见顶信号明显',
      '群内流传利空传闻，抛压加重',
      '有股友称已清仓离场，引发跟卖',
      '短线资金撤退，跟风盘出现踩踏',
      '传闻核心人员离职，经营存变数',
      '大V提示风险，散户信心动摇',
      '有消息称大股东私下在找接盘方',
      '股吧连续出现看空贴，情绪面恶化',
      '小道消息称监管处罚即将落地',
      '打板资金获利了结，接力盘断档',
    ],
  },
};

const SCOPES = ['机构', '散户', '全体'];

// 各 scope 消息对公允价值的直接定价权重（与 sentiment 的 scope 语义对齐）
const SCOPE_FV_WEIGHT = { 全体: 1, 机构: 0.5, 散户: 0.5 };

// 最近这么多条消息里用过的文案不再重复抽取，避免短时间内刷同一条
const REPEAT_GUARD = 12;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

class NewsSystem {
  /**
   * @param {Array<{id:string,name:string,alias:string}>} stocks 本局全部股票
   */
  constructor(stocks = []) {
    this.stocks = stocks;
    this.tape = [];
    this.seq = 0;
    this.nextAt = Date.now() + this.randInterval();
    this.active = []; // [{dir, scope, power, until, stockId}]
  }

  randInterval() {
    const { minIntervalMs, maxIntervalMs } = config.news;
    return minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs));
  }

  /** 从 scope 专属池取文案，池内近 REPEAT_GUARD 条用过的先排除；全用过则退回纯随机 */
  pickText(scope, dir) {
    const pool = TEMPLATES[scope][dir > 0 ? 'positive' : 'negative'];
    const recent = new Set(this.tape.slice(0, REPEAT_GUARD).map((n) => n.text));
    const fresh = pool.filter((text) => !recent.has(text));
    return pick(fresh.length ? fresh : pool);
  }

  /**
   * 每 tick 调用，按计划产出消息
   *
   * 多股票下消息分两种：
   * - **大盘消息**（scope=全体，政策/宏观）：作用于全部股票，指数因此有系统性涨跌
   * - **个股消息**（scope=机构/散户）：挂到随机一只股票上，文案前缀【简称】，
   *   只影响那一只的情绪与公允价
   * 这只是语义归属，不影响 power/until/衰减等既有机制。
   *
   * @param {number} now
   * @param {number} [dirBias] 概率偏移：p(利好) = 0.5 + dirBias。
   *   调用方传 regime × regimeBias（如 0.2 → 牛市 70% 利好）
   */
  maybeEmit(now, dirBias = 0) {
    if (now < this.nextAt) return null;
    this.nextAt = now + this.randInterval();

    const pPositive = Math.max(0, Math.min(1, 0.5 + dirBias));
    const dir = Math.random() < pPositive ? 1 : -1;
    const scope = pick(SCOPES);
    const power = 0.3 + Math.random() * 0.5;
    // 全体 = 大盘消息（不带股票）；机构/散户 = 个股消息，随机挂一只
    const stock = scope === '全体' || !this.stocks.length ? null : pick(this.stocks);
    const text = stock ? `【${stock.alias}】${this.pickText(scope, dir)}` : this.pickText(scope, dir);
    this.seq += 1;
    const news = {
      id: 'N' + this.seq,
      t: now,
      dir, // 1 利好 / -1 利空
      type: dir > 0 ? '利好' : '利空',
      scope,
      power,
      stockId: stock ? stock.id : null,
      stockName: stock ? stock.name : null,
      text,
      until: now + config.news.durationMs,
    };
    this.tape.unshift(news);
    if (this.tape.length > config.news.tapeSize) this.tape.length = config.news.tapeSize;
    this.active.push(news);
    this.active = this.active.filter((n) => n.until > now);
    return news;
  }

  /**
   * 该消息是否作用于某只股票：大盘消息作用于全部，个股消息只作用于它自己
   * @param {*} n 消息（this.active 里的元素）
   * @param {string|null} stockId 目标股票；null 表示不限股票（只算大盘消息）
   */
  static applies(n, stockId) {
    if (!n.stockId) return true; // 大盘消息
    if (!stockId) return false;
    return n.stockId === stockId;
  }

  /** 某群体在某只股票上的当前情绪叠加 [-1, 1] */
  sentiment(scope, now, stockId = null) {
    let s = 0;
    for (const n of this.active) {
      if (n.until <= now) continue;
      if (n.scope !== '全体' && n.scope !== scope) continue;
      if (!NewsSystem.applies(n, stockId)) continue;
      // 影响随时间线性衰减
      const remain = (n.until - now) / config.news.durationMs;
      s += n.dir * n.power * remain;
    }
    return Math.max(-1, Math.min(1, s));
  }

  /**
   * 按 scope 分解某只股票的当前情绪。机构做「公开消息对倒」时需要看见散户盘情绪，
   * 而不是只看自己 scope——利好出货、利空吸筹的前提是知道散户在追什么。
   * @returns {{ all: number, inst: number, retail: number }}
   */
  sentimentByScope(now, stockId = null) {
    let all = 0;
    let inst = 0;
    let retail = 0;
    for (const n of this.active) {
      if (n.until <= now) continue;
      if (!NewsSystem.applies(n, stockId)) continue;
      const remain = (n.until - now) / config.news.durationMs;
      const c = n.dir * n.power * remain;
      if (n.scope === '全体') all += c;
      else if (n.scope === '机构') inst += c;
      else retail += c;
    }
    const clamp = (x) => Math.max(-1, Math.min(1, x));
    return { all: clamp(all), inst: clamp(inst), retail: clamp(retail) };
  }

  /**
   * 消息对某只股票公允价值的每 tick 相对推力（调用方按 fv *= 1 + 推力 消费）。
   * scope 与 sentiment() 保持同一语义：「全体」消息全额直接定价，
   * 只覆盖单一群体的消息只按其群体打折定价。
   */
  fvDrift(now, stockId = null) {
    let d = 0;
    for (const n of this.active) {
      if (n.until <= now) continue;
      if (!NewsSystem.applies(n, stockId)) continue;
      const remain = (n.until - now) / config.news.durationMs;
      d += n.dir * n.power * remain * config.news.fvDriftCoef * (SCOPE_FV_WEIGHT[n.scope] ?? 0.5);
    }
    return d;
  }

  tapeSnapshot(limit = 50) {
    return this.tape.slice(0, limit);
  }
}

module.exports = { NewsSystem };
