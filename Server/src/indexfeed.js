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
const flow = require('./flow');

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
    // 资金流向：指数自己没有成交，内外盘按成分股加总（在 update 里逐 tick 重算）；
    // 日线与个股同口径，收盘结算时按当日成分股合计的成交额定格一根
    flow.initFlow(this);
    this.haltUntil = 0;
    this.haltReason = '';
    this.components = []; // 最近一次合成的成分明细（客户端展示权重与贡献）
  }

  /**
   * 每 tick 用各股最新价重算点位，并把点位追加进分时序列。
   * @param {Map<string, import('./market').Market>} markets
   * @param {number} now
   */
  update(markets, now) {
    const v = this.recompute(markets);
    const h = this.priceHistory;
    h.push({ t: now, price: v, vol: 0 });
    if (h.length > config.market.priceHistorySize) h.splice(0, h.length - config.market.priceHistorySize);
  }

  /**
   * 只重算、不推分时点，返回新点位。
   *
   * 与 update 拆开是为了日终结算：指数的量额与内外盘是**成分股合计**，而成分股会在
   * 同一轮结算里被清零——必须先重算（拿到当日真实合计）再让成分股归零，
   * 否则落进日线的那根指数 K 线量额全是 0。
   */
  recompute(markets) {
    let cap = 0;
    let volume = 0;
    let turnover = 0;
    let shortInterest = 0;
    let outerVol = 0;
    let outerAmt = 0;
    let innerVol = 0;
    let innerAmt = 0;
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
      // 指数的高低量额与内外盘一样，都是成分股的合计（指数没有自己的成交）
      outerVol += m.outerVol || 0;
      outerAmt += m.outerAmt || 0;
      innerVol += m.innerVol || 0;
      innerAmt += m.innerAmt || 0;
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
    this.outerVol = outerVol;
    this.outerAmt = outerAmt;
    this.innerVol = innerVol;
    this.innerAmt = innerAmt;

    const v = this.roundPrice((this.base * cap) / this.baseCap);
    this.lastPrice = v;
    if (v > this.high) this.high = v;
    if (v < this.low) this.low = v;
    return v;
  }

  /** 指数点位保留两位小数（与个股的「分」同精度） */
  roundPrice(p) {
    return Math.round(p * 100) / 100;
  }

  /**
   * 日终结算：当日定格成一根指数日线（与个股同口径，量额是成分股合计），
   * 收盘点位定格为新「昨收」，今开/最高/最低归零到收盘点位，成交量额与内外盘清零。
   * 指数的涨跌幅因此从「相对开服基点」变成「相对昨日收盘」——这正是引入「天」之后玩家想看的东西。
   *
   * ⚠️ 调用方必须**先 `recompute(markets)` 再结算成分股**，否则这里拿到的量额是上一 tick 的
   * 合计（收盘竞价那批成交还没算进去），甚至已经被成分股清零。
   */
  settleDay(now = Date.now(), opts = {}) {
    // 与 Market.settleDayNo 同一口径：显式给的 day 优先（0 = 没有已收盘的交易日，不记日线）
    const day =
      opts.day !== undefined
        ? Number(opts.day) || 0
        : this.dayCycle && this.dayCycle.ok
          ? this.dayCycle.locate(now).day
          : 0;
    flow.recordDailyBar(this, day, now);
    this.prevClose = this.lastPrice;
    this.open = this.lastPrice;
    this.high = this.lastPrice;
    this.low = this.lastPrice;
    this.volume = 0;
    this.turnover = 0;
    flow.resetDayFlow(this);
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
      // 全部成分股加总的内外盘与净流入（指数自己没有成交）
      flow: flow.flowSnapshot(this),
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
