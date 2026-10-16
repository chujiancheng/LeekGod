/**
 * 大盘指数：把全部股票的现价按流通市值加权合成一个点位，纯展示、不可交易。
 *
 *   点位 = base × Σ(流通股ᵢ × 现价ᵢ) / Σ(流通股ᵢ × 开盘价ᵢ)
 *
 * 分母是开服时的总流通市值（恒定），所以指数就是一个「总市值相对开服涨了多少」的
 * 百分比刻度，涨跌天然由成分股加权得出，不需要任何再平衡。
 *
 * 落盘接口刻意与 Market 对齐（stockId/lastPrice/priceHistory/haltUntil…），
 * 于是 Persister 可以拿它当第 11 个「市场」一起写，不必为指数单开一套表。
 */
const config = require('./config');
const { r2 } = require('./store');

class IndexFeed {
  /**
   * @param {Array<{id:string,name:string,floatShares:number,initPrice:number}>} stocks
   */
  constructor(stocks) {
    const cfg = config.index;
    this.stockId = cfg.code;
    this.stock = { id: cfg.code, name: cfg.name, lotSize: 100, initPrice: cfg.base, floatShares: 0 };
    this.stocks = stocks;
    // 开服总流通市值：分母恒定，指数的涨跌幅全部来自分子
    this.baseCap = stocks.reduce((a, s) => a + s.floatShares * s.initPrice, 0);
    this.base = cfg.base;

    this.lastPrice = cfg.base;
    this.prevClose = cfg.base; // 本局「昨收」恒为基点（一轮即一次连续交易）
    this.open = cfg.base;
    this.high = cfg.base;
    this.low = cfg.base;
    // 成交量/成交额取成分股合计，纯展示（客户端指数卡不画量，但结构上与 Market 对齐）
    this.volume = 0;
    this.turnover = 0;
    this.shortInterest = 0;
    this.orderSeq = 0;
    this.trades = []; // 指数无逐笔，保持空数组以对齐 Market 接口
    this.priceHistory = [];
    this.haltUntil = 0;
    this.haltReason = '';
    this.components = []; // 最近一次合成的成分明细（客户端展示权重与贡献）
  }

  /**
   * 每 tick 用各股最新价重算点位。
   * @param {Map<string, import('./market').Market>} markets
   * @param {number} now
   */
  update(markets, now) {
    let cap = 0;
    let volume = 0;
    let turnover = 0;
    let shortInterest = 0;
    this.components = [];
    const rows = [];
    for (const s of this.stocks) {
      const m = markets.get(s.id);
      if (!m) continue;
      const price = m.lastPrice;
      const mv = s.floatShares * price;
      cap += mv;
      volume += m.volume;
      turnover += m.turnover;
      shortInterest += m.shortInterest;
      rows.push({ stock: s, m, price, mv });
    }
    // 权重按**当前**总市值算（合计 100%），指数涨了权重合计就还是 100%——
    // 若按开服市值做分母，指数涨 4% 时权重合计会显示成 104%，读起来不像权重
    for (const r of rows) {
      this.components.push({
        stockId: r.stock.id,
        name: r.stock.name,
        last: r.price,
        changePct: r.m.prevClose ? r2(((r.price - r.m.prevClose) / r.m.prevClose) * 100) : 0,
        weight: cap > 0 ? r2((r.mv / cap) * 100) : 0,
      });
    }
    this.volume = volume;
    this.turnover = turnover;
    this.shortInterest = shortInterest;

    const v = this.roundPrice((this.base * cap) / this.baseCap);
    this.lastPrice = v;
    if (v > this.high) this.high = v;
    if (v < this.low) this.low = v;

    const h = this.priceHistory;
    h.push({ t: now, price: v, vol: 0 });
    if (h.length > config.market.priceHistorySize) h.splice(0, h.length - config.market.priceHistorySize);
  }

  /** 指数点位保留两位小数（与个股的「分」同精度） */
  roundPrice(p) {
    return Math.round(p * 100) / 100;
  }

  /**
   * 日终结算：收盘点位定格为新「昨收」，今开/最高/最低归零到收盘点位，
   * 成交量额清零。指数的涨跌幅因此从「相对开服基点」变成「相对昨日收盘」——
   * 这正是引入「天」之后玩家想看的东西。
   */
  settleDay() {
    this.prevClose = this.lastPrice;
    this.open = this.lastPrice;
    this.high = this.lastPrice;
    this.low = this.lastPrice;
    this.volume = 0;
    this.turnover = 0;
  }

  /** 与 Market.snapshot 同构的行情快照，客户端可像处理股票一样处理指数 */
  snapshot() {
    const change = r2(this.lastPrice - this.prevClose);
    const changePct = this.prevClose ? r2((change / this.prevClose) * 100) : 0;
    return {
      stockId: this.stockId,
      name: this.stock.name,
      isIndex: true,
      last: this.lastPrice,
      prevClose: this.prevClose,
      open: this.open,
      high: this.high,
      low: this.low,
      change,
      changePct,
      volume: this.volume,
      turnover: this.turnover,
      depth: { bids: [], asks: [] },
      trades: [],
      band: null,
      lending: null,
      components: this.components,
    };
  }

  /** 重启恢复：从存档的断点与分时重建 */
  applyState(state, prices) {
    if (state) {
      this.lastPrice = state.last_price;
      this.prevClose = state.prev_close;
      this.open = state.open;
      this.high = state.high;
      this.low = state.low;
    }
    if (prices && prices.length) {
      this.priceHistory = prices.map((p) => ({ t: p.t, price: p.price, vol: p.vol }));
    }
  }
}

module.exports = { IndexFeed };
