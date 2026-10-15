/**
 * 随机消息系统：利多 / 利空，影响 NPC 情绪与公允价值
 */
const config = require('./config');

const TEMPLATES = {
  positive: [
    '央行降准降息，市场流动性充裕',
    '行业扶持政策超预期出台',
    '公司中标大额订单，金额创历史新高',
    '业绩预告超预期，净利润大增',
    '获知名机构调研，外资持续增持',
    '公司发布回购股份计划',
    '新产品线获批，有望打开成长空间',
    '宏观经济数据超预期回暖',
  ],
  negative: [
    '监管部门下发问询函',
    '行业增速数据不及预期',
    '大股东披露减持计划',
    '业绩预告不及预期，利润下滑',
    '外围市场隔夜大跌',
    '突发负面传闻持续发酵',
    '原材料价格暴涨挤压利润',
    '市场风险偏好明显回落',
  ],
};

const SCOPES = ['机构', '散户', '全体'];

// 各 scope 消息对公允价值的直接定价权重（与 sentiment 的 scope 语义对齐）
const SCOPE_FV_WEIGHT = { 全体: 1, 机构: 0.5, 散户: 0.5 };

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

class NewsSystem {
  constructor() {
    this.tape = [];
    this.seq = 0;
    this.nextAt = Date.now() + this.randInterval();
    this.active = []; // [{dir, scope, power, until}]
  }

  randInterval() {
    const { minIntervalMs, maxIntervalMs } = config.news;
    return minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs));
  }

  /**
   * 每 tick 调用，按计划产出消息
   * @param {number} now
   * @param {number} [dirBias] 方向偏向 [-1,1]：p(利好) = 0.5 + dirBias/2，由调用方按牛熊阶段传入
   */
  maybeEmit(now, dirBias = 0) {
    if (now < this.nextAt) return null;
    this.nextAt = now + this.randInterval();

    const pPositive = Math.max(0, Math.min(1, 0.5 + dirBias / 2));
    const dir = Math.random() < pPositive ? 1 : -1;
    const scope = pick(SCOPES);
    const power = 0.3 + Math.random() * 0.5;
    this.seq += 1;
    const news = {
      id: 'N' + this.seq,
      t: now,
      dir, // 1 利好 / -1 利空
      type: dir > 0 ? '利好' : '利空',
      scope,
      power,
      text: pick(dir > 0 ? TEMPLATES.positive : TEMPLATES.negative),
      until: now + config.news.durationMs,
    };
    this.tape.unshift(news);
    if (this.tape.length > config.news.tapeSize) this.tape.length = config.news.tapeSize;
    this.active.push(news);
    this.active = this.active.filter((n) => n.until > now);
    return news;
  }

  /** 某群体当前情绪叠加 [-1, 1] */
  sentiment(scope, now) {
    let s = 0;
    for (const n of this.active) {
      if (n.until <= now) continue;
      if (n.scope !== '全体' && n.scope !== scope) continue;
      // 影响随时间线性衰减
      const remain = (n.until - now) / config.news.durationMs;
      s += n.dir * n.power * remain;
    }
    return Math.max(-1, Math.min(1, s));
  }

  /**
   * 消息对公允价值的每 tick 相对推力（调用方按 fv *= 1 + 推力 消费）。
   * scope 与 sentiment() 保持同一语义：「全体」消息全额直接定价，
   * 只覆盖单一群体的消息只按其群体打折定价。
   */
  fvDrift(now) {
    let d = 0;
    for (const n of this.active) {
      if (n.until <= now) continue;
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
