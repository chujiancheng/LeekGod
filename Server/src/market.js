/**
 * 行情与撮合引擎：
 * - 限价订单簿（价格优先、时间优先）
 * - 多头买卖 / 空头开平（保证金模式，固定流通盘）
 * - T+锁仓、下单冷却、手续费、涨跌停（可开关）、爆仓强平
 */
const config = require('./config');
const { OrderBook } = require('./orderbook');
const { r2 } = require('./store');
const flow = require('./flow');
const broker = require('./broker');

const ACTIONS = {
  BUY_OPEN: 'buy_open', // 买入开多
  SELL_CLOSE: 'sell_close', // 卖出平多
  SELL_OPEN: 'sell_open', // 卖出开空
  BUY_CLOSE: 'buy_close', // 买入平空
};

const BUY_ACTIONS = new Set([ACTIONS.BUY_OPEN, ACTIONS.BUY_CLOSE]);
const VALID_ACTIONS = new Set(Object.values(ACTIONS));

/**
 * 全服成交序号（`/open/v1/fills` 的增量游标）。
 *
 * 早先用的是**每只股票各自的逐笔序号**（`trades[0].seq`），账户同时交易两只股票时
 * 会出事：A 股序号到 100、B 股才 50，客户端拿 100 当游标，B 股之后所有成交都被永久漏掉。
 * 所以游标必须是跨股票单调的。
 *
 * 起点由存档里 `trades.trade_seq` 的最大值 +1 决定（`Game` 构造时注入），重启后接着往上走：
 * 客户端存下的旧游标不会漏单，也不会把重启前收到的成交重新推一遍。
 */
let TRADE_SEQ = 0;
const nextTradeSeq = () => (TRADE_SEQ += 1);
/** 启动时把计数器抬到「存档里已有序号之上」，只升不降 */
function setTradeSeqBase(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v > TRADE_SEQ) TRADE_SEQ = Math.trunc(v);
}

/** 空头存量披露序列保留多少个交易日（融券 tab 的折线；一个游戏日一点） */
const SHORT_HISTORY_DAYS = 120;

class Market {
  constructor(stock) {
    this.stock = stock;
    this.stockId = stock.id;
    this.book = new OrderBook();
    this.lastPrice = stock.initPrice;
    this.prevClose = stock.initPrice; // 本局的昨收参考价
    this.open = stock.initPrice;
    this.high = stock.initPrice;
    this.low = stock.initPrice;
    this.volume = 0; // 成交量（股）
    this.turnover = 0; // 成交额
    this.trades = []; // 逐笔成交
    this.priceHistory = []; // 分时序列 [{t, price}]
    // 资金流向（当日累计：外盘=主动买 / 内盘=主动卖）与已收盘的日线，见 flow.js
    flow.initFlow(this);
    this.orderSeq = 0;
    this.shortInterest = 0; // 未平空单总量（虚拟流通增量）——**引擎内部实时口径**
    // 对外披露的空头存量（融券 tab「空头总持仓」/ 开放平台 /holders 的 shortInterest）：
    // 每个游戏日收盘日终结算时刷新一次，**日内冻结**。真实市场的融券余额就是盘后披露——
    // 实时下发等于把机构今天偷偷建空的动向直接摊给玩家。撮合、利息、券源、风控
    // 一律继续读实时的 shortInterest，披露值只喂展示层
    this.shortInterestPub = 0;
    this.shortInterestPubDay = -1; // 已披露到第几个交易日（-1 = 还没披露过）
    // 融券池：挂借总量 / 已借出 / 开单中占用。可借 = 总挂借 − 已借出 − 开单占用。
    // allowNakedShort=true 时开空不走池（lendBorrowed 仅统计借券开仓的部分）。
    this.lendTotal = 0;
    this.lendBorrowed = 0;
    this.lendReserved = 0; // SELL_OPEN 已下单未成交占用的券源
    // 做空利息已结算到第几个交易日（**-1 = 还没结过**）。做空利息按游戏日结算，
    // 每天收盘日终结算时收一次；重启后由 Game 从 meta 恢复，避免补结算时重复收息
    this.lendSettledDay = -1;
    // 一个游戏日的真实毫秒数（config.day 各阶段之和）：做空日息按它摊到每个 tick
    this.dayMs = Array.isArray(config.day && config.day.phases)
      ? config.day.phases.reduce((sum, p) => sum + (p.ms || 0), 0)
      : 0;
    // 最近一次日终结算实际收到的做空利息（0 = 这一天没有空头付息）
    this.lastLendCharge = 0;
    this.shortHistory = []; // 空头存量披露序列 [{t, day, qty}]，每个交易日收盘一点
    this.haltUntil = 0; // 停牌截止时间戳（0 = 正常交易），手动运营开关
    this.haltReason = '';
    // 交易日时钟（见 daycycle.js）。未挂载时退化为「永远处于连续交易」，
    // 等价于引入「天」之前的旧行为——单元测试里的孤立 Market 就走这条路径
    this.dayCycle = null;
    // 集合竞价正在撮合中（runAuction 内 → true）：此窗口内禁止风控强平，
    // 因为竞价簿允许买卖价交叉，强平单按交叉价撮合会被一路拉飞
    this._auctionRunning = false;
    // 本交易日是否已经成交过（第一笔成交决定「今开」，日终归零）
    this.dayTradeCount = 0;
    // 席位流水（§11.3）：当日各券商的买入/卖出成交额，日终清零。
    // 只喂展示层（席位榜/龙虎榜），**不参与任何数值计算**
    this.seatFlow = new Map();
    // 东风的「论坛热度」（§3.6 人气 buff）：当日东风客户在本股的成交额 → 0~1 的热度，
    // 再放大该股散户 NPC 的跟风强度。没有东风客户交易时恒为 0，行为与引入券商之前一致
    this.dongfengTurnover = 0;
    this.dongfengHeat = 0;
    // 由 Game 注入的持久化器；未注入时纯内存运行（测试脚本就是这样）
    this.journal = null;
    // 跨股票取价：风控要按**整个账户**算权益，就得知道账户在其它股票上的持仓值多少。
    // 未注入时退化为「只有本股有价」，等价于旧单股票口径（测试脚本走这条路径）
    this.priceOf = null;
    // 跨股票找市场：撤单必须交给委托**所属**股票的市场。未注入时退化为「只有本市场」
    this.marketOf = null;
  }

  /** 取任意股票最新价；未注入 priceOf 时只有本股有价 */
  _price(stockId) {
    if (this.priceOf) return this.priceOf(stockId);
    return stockId === this.stockId ? this.lastPrice : 0;
  }

  /** 组合口径权益（跨全部持仓股票汇总） */
  equityOf(account) {
    return account.equity((stockId) => this._price(stockId));
  }

  /** 价格四舍五入到分 */
  roundPrice(p) {
    return Math.round(p * 100) / 100;
  }

  /** 账户或委托发生变化时通知存档器（未注入 journal 时是空操作） */
  notifyChange(account, order) {
    if (!this.journal) return;
    this.journal.touch(account);
    if (order) this.journal.orderChanged(order);
    // 席位标识挂在委托对象上，让存档侧一并写进成交流水（§11.4.5）
    if (order && account) order.broker = account.broker || null;
  }

  // ---------- 券商（per-账户覆盖） ----------

  /** 当前交易日号（没有时钟时 0）：券商的星级/转户/免息券都按交易日算 */
  dayNumber(now = Date.now()) {
    const dc = this.dayCycle;
    if (!dc || !dc.ok) return 0;
    return dc.locate(now).day;
  }

  /**
   * 某账户此刻的有效券商参数。
   * 账户没有 broker（老存档、NPC、测试里裸造的账户）→ 逐位回落全局基准，
   * 行为与引入券商之前完全一致（§9 D6 两级兜底）。
   */
  brokerFor(account, now = Date.now()) {
    return broker.forAccount(account, { day: this.dayNumber(now) });
  }

  /**
   * 利息类变更通知存档器：**NPC 账户跳过**。
   *
   * 利息是每 tick 都在动的慢漂移，而每 tick 被标脏的账户几乎覆盖全部 NPC；
   * 写一个账户要把它的全部持仓批次整段删除再写回（persist.writeAccount），
   * 正式档实测每 tick 因此要重写 50 万行批次、commit 占掉 2.8 秒（tick 预算才 0.7 秒）。
   * NPC 账户本来就有 config.persistence.sweepTicks 一轮的全量轮转扫描兜底，
   * 逐 tick 重写它们纯属冗余——少写几百 tick 的利息漂移对 NPC 毫无影响。
   * 玩家账户（含欠息、出借收入）必须逐 tick 落盘，不受此影响。
   */
  notifyInterest(account) {
    if (!account || account.isNPC) return;
    this.notifyChange(account);
  }

  /**
   * 把委托交给它**自己所属**的标的市场去撤。
   *
   * 强平前必须撤掉该账户全部在途委托，而这些委托可能挂在别的股票的簿上。
   * 用本市场的 cancel 去撤会撤不到（自己的簿里没这张单，book.cancel 静默返回），
   * 但账户挂单表已被删除、状态已改 canceled、冻结已退回——那张单就留在别人的簿里
   * 变成「撤不掉、又仍会被撮合」的幽灵单；开空单占用的券源还会释放到错误的池子上。
   * 未注入 marketOf 时退化为只有本市场（单股测试路径）。
   */
  cancelAny(account, orderId, now, opts) {
    const order = account.orders.get(orderId);
    const owner = order && this.marketOf ? this.marketOf(order.stockId) : null;
    const target = owner && typeof owner.cancel === 'function' ? owner : this;
    return target.cancel(account, orderId, now, opts);
  }

  /**
   * 把某只股票的批次预留按「当前在途平仓委托」重摊一次（实现见 `Account.syncReserved`）。
   *
   * 成交、撤单、委托完结之后都要调：这批路径各自按 FIFO 动批次，而预留不带委托归属，
   * 一旦某种交错的顺序让 consume 吃到「别的单占着的批次」，预留量就会与在途委托量脱钩，
   * 表现为「持仓还在、可平/可卖却是 0，且没有任何在途委托可撤」。
   * 本股没有持仓时直接跳过（NPC 每 tick 大量成交，别为没持仓的股票做无用功）。
   */
  syncReserved(account, stockId, now) {
    if (!account || account === SYSTEM_ACCOUNT) return;
    const sid = stockId || this.stockId;
    const lp = account.longs.get(sid);
    const sp = account.shorts.get(sid);
    if (!lp && !sp) return;
    // 锁仓时长只有多头用得上：本股没有多头批次就不必去解析券商（NPC 成交极频繁）
    const lockMs = lp ? this.brokerFor(account, now).lockMs : 0;
    account.syncReserved(sid, lockMs, now);
  }

  /**
   * 涨跌停区间（关闭时返回 null）。
   *
   * 涨跌停是**日频机制**：区间以「昨收」为基准，而昨收只在每个交易日收盘结算时滚动
   * （见 settleDay）。没有交易日时钟时昨收永远是开盘价，价格会被硬夹在开盘价 ±pct 里
   * 再也出不来——那不是涨跌停，是死锁。所以没有挂载交易日时钟的孤立市场
   * （单元测试路径）一律不启用涨跌停。
   */
  band() {
    const cfg = config.priceLimit;
    if (!cfg.enabled) return null;
    if (!this.dayCycle || !this.dayCycle.ok) return null;
    const up = this.roundPrice(this.prevClose * (1 + cfg.pct));
    const down = this.roundPrice(this.prevClose * (1 - cfg.pct));
    return { up, down };
  }

  /** 把价格夹到涨跌停区间（关闭时只做取整） */
  clampPrice(p) {
    p = this.roundPrice(p);
    const b = this.band();
    if (!b) return p;
    return Math.min(b.up, Math.max(b.down, p));
  }

  inBand(price) {
    const b = this.band();
    if (!b) return true;
    return price >= b.down && price <= b.up;
  }

  /**
   * 价格笼子：单笔成交价相对上一笔成交价的偏离上限。
   * 成交价 = 被动方挂单价，若不加约束，一张脱离盘口的挂单被吃掉就能把最新价一把拉走
   * （最新价同时是强平价、权益与 NPC 公允价值的基准），而挂单本身只受 maxDeviation 约束。
   */
  inCage(price) {
    const pct = config.trade.cagePct;
    if (!pct || !this.lastPrice) return true;
    return Math.abs(price - this.lastPrice) / this.lastPrice <= pct;
  }

  // ---------- 交易日阶段（挂载 dayCycle 后生效） ----------

  /** 当前阶段是否接受下单（集合竞价也算「接受」，只是不连续撮合） */
  tradingNow(now = Date.now()) {
    const dc = this.dayCycle;
    if (!dc || !dc.ok) return true;
    return dc.canTrade(now);
  }

  /** 当前是否集合竞价阶段：'open' / 'close' / null */
  auctionKind(now = Date.now()) {
    const dc = this.dayCycle;
    if (!dc || !dc.ok) return null;
    return dc.auction(now);
  }

  /** 集合竞价是否已进入不可撤单窗口 */
  auctionLocked(now = Date.now()) {
    const dc = this.dayCycle;
    if (!dc || !dc.ok) return false;
    return dc.auctionLocked(now);
  }

  /**
   * 是否处于「连续竞价」（可切片撮合、可强平）。
   * 集合竞价与休市都返回 false——集合竞价期间风控强平必须冻结：
   * 那时候簿里允许买卖价交叉（虚拟成交价就是这么来的），强平单按它撮合会被交叉价拉飞。
   */
  continuousNow(now = Date.now()) {
    const dc = this.dayCycle;
    if (!dc || !dc.ok) return true;
    const st = dc.locate(now);
    return st.phase.trading && !st.phase.auction;
  }

  /** 休市中（午休 / 夜间）：报价与撮合冻结，但公允价值继续迁移（隔夜跳空的来源） */
  closedForTrading(now = Date.now()) {
    const dc = this.dayCycle;
    if (!dc || !dc.ok) return false;
    return !dc.canTrade(now);
  }

  /** 夜间休市（不含午休）：只有这里按 overnightDriftMul 放大公允迁移 */
  isNight(now = Date.now()) {
    const dc = this.dayCycle;
    if (!dc || !dc.ok) return false;
    return dc.locate(now).phase.key === 'night';
  }

  // ---------- 集合竞价 ----------

  /**
   * 虚拟成交价 / 虚拟开盘价：**最大成交量原则**。
   *
   * 对每个候选价 P，可成交量 = min(买价 ≥ P 的剩余量之和, 卖价 ≤ P 的剩余量之和)。
   * 取成交量最大的 P；多个 P 并列时取最接近昨收的那个（真实交易所的口径是
   * 使未成交量最小、再取中间价，这里用「最接近昨收」等价地表达"不无谓地偏离"）。
   *
   * 竞价阶段盘口允许买卖价交叉——真实行情里的「虚拟开盘价」就是这么算出来的，
   * 玩家在 09:15~09:25 看到的就是它。
   *
   * @returns {{price:number, volume:number}|null} 无可成交量时返回 null
   */
  auctionQuote() {
    const bids = this.book.bids; // 价格降序、同价早单在前
    const asks = this.book.asks; // 价格升序
    if (!bids.length || !asks.length) return null;

    // 先按价位聚合剩余量（同价多单合并），避免逐单 O(n²)
    const bl = [];
    for (const o of bids) {
      const r = o.qty - (o.filled || 0);
      if (r <= 0) continue;
      const last = bl[bl.length - 1];
      if (last && last.p === o.price) last.q += r;
      else bl.push({ p: o.price, q: r });
    }
    const al = [];
    for (const o of asks) {
      const r = o.qty - (o.filled || 0);
      if (r <= 0) continue;
      const last = al[al.length - 1];
      if (last && last.p === o.price) last.q += r;
      else al.push({ p: o.price, q: r });
    }
    if (!bl.length || !al.length) return null;

    // 候选价 = 两侧价位的并集，升序游标一次扫完
    const band = this.band();
    const ref = this.prevClose || this.lastPrice;
    let d = 0;
    for (const x of bl) d += x.q;
    let s = 0;
    let bi = bl.length - 1; // bl 降序：从最低买价开始剔除
    let aj = 0; // al 升序：从最低卖价开始累计
    let best = null;
    // 两个有序数组归并成升序候选价
    let i = bl.length - 1;
    let j = 0;
    while (i >= 0 || j < al.length) {
      const bp = i >= 0 ? bl[i].p : Infinity;
      const ap = j < al.length ? al[j].p : Infinity;
      const p = Math.min(bp, ap);
      if (i >= 0 && bp === p) i--;
      if (j < al.length && ap === p) j++;
      // 推进到 P 的可成交量口径：买价 ≥ P、卖价 ≤ P
      while (bi >= 0 && bl[bi].p < p) {
        d -= bl[bi].q;
        bi--;
      }
      while (aj < al.length && al[aj].p <= p) {
        s += al[aj].q;
        aj++;
      }
      if (band && (p < band.down || p > band.up)) continue;
      const v = Math.min(d, s);
      if (v <= 0) continue;
      if (
        !best ||
        v > best.volume ||
        (v === best.volume && Math.abs(p - ref) < Math.abs(best.price - ref))
      ) {
        best = { price: p, volume: v };
      }
    }
    return best;
  }

  /**
   * 集合竞价集中撮合（在竞价阶段结束的那一 tick 由 Game 调用一次）。
   * 按**价格优先、时间优先**在虚拟成交价上一次性成交，剩余委托留在簿里
   * 进入随后的连续竞价（真实市场就是这么承接的）。
   *
   * 价格笼子在这里**不适用**：笼子是相对上一笔成交价的 ±5%，而集合竞价的成交价
   * 相对昨收可以有涨跌停区间内的跳空——照笼子判会把所有跳空单都判成"脱笼"撤掉，
   * 跳空越大越开不出盘，恰好废掉引入「天」最想要的那个机制。
   */
  runAuction(now = Date.now()) {
    const q = this.auctionQuote();
    this._auctionRunning = true;
    try {
      if (!q) {
        // 开不出价也要收尾扫交叉：自成交残单、零剩余量残留都得清掉，
        // 否则簿会带着交叉进入连续竞价
        this.sweepCrossed(now);
        return { price: null, qty: 0 };
      }
      return this._runAuctionAt(q, now);
    } finally {
      this._auctionRunning = false;
    }
  }

  _runAuctionAt(q, now) {
    const price = q.price;
    const buys = this.book.bids.filter((o) => o.price >= price && o.qty - (o.filled || 0) > 0);
    const asks = this.book.asks.filter((o) => o.price <= price && o.qty - (o.filled || 0) > 0);
    let bi = 0;
    let ai = 0;
    let qty = 0;
    let guard = 0;
    while (bi < buys.length && ai < asks.length && guard++ < 50000) {
      const b = buys[bi];
      const a = asks[ai];
      if (b.filled >= b.qty || b.status !== 'live') {
        bi++;
        continue;
      }
      if (a.filled >= a.qty || a.status !== 'live') {
        ai++;
        continue;
      }
      // 禁止自成交：同一账户的买卖不能互为对手盘
      if (b.account === a.account) {
        ai++;
        continue;
      }
      if (!this.isSettleable(b, 1)) {
        this.dropStaleOrder(b, now);
        bi++;
        continue;
      }
      if (!this.isSettleable(a, 1)) {
        this.dropStaleOrder(a, now);
        ai++;
        continue;
      }
      const take = Math.min(b.qty - b.filled, a.qty - a.filled);
      this.execute(b, a, price, take, now, price >= this.lastPrice ? 'buy' : 'sell');
      qty += take;
    }
    // 自成交跳过可能留下少量交叉残单，收尾扫一遍，保证进入连续竞价时簿不再交叉
    this.sweepCrossed(now);
    return { price, qty };
  }

  /** 把簿里仍然交叉的顶档撮掉（价格为被动方挂单价），用于竞价收尾与异常兜底 */
  sweepCrossed(now = Date.now()) {
    let guard = 0;
    while (guard++ < 5000) {
      const b = this.book.bids[0];
      const a = this.book.asks[0];
      if (!b || !a) break;
      const br = b.qty - (b.filled || 0);
      const ar = a.qty - (a.filled || 0);
      if (br <= 0) {
        if (b.status === 'live') this.dropStaleOrder(b, now);
        else this.book.remove(b);
        continue;
      }
      if (ar <= 0) {
        if (a.status === 'live') this.dropStaleOrder(a, now);
        else this.book.remove(a);
        continue;
      }
      if (b.price < a.price) break;
      if (b.account === a.account) {
        // 自成交：不能只 book.remove——账户侧会留一张 status=live 的幽灵单，
        // 冻结资金与仓位预留一并锁死，盘口里却已经看不见。走正式撤单
        // （保留买侧、撤卖侧，与 _runAuctionAt 的 ai++ 口径一致）
        if (!this.cancel(a.account, a.id, now, { internal: true }).ok) {
          this.dropStaleOrder(a, now);
        }
        continue;
      }
      this.execute(b, a, a.price, Math.min(br, ar), now, 'buy');
    }
  }

  /**
   * 日终结算（收盘集合竞价结束 → 夜间那一步由 Game 调用一次）：
   * - **当日定格成一根日线**（K 线图的数据来源，见 flow.js）
   * - 收盘价定格为新「昨收」，涨跌幅基准随之滚动到「今日」
   * - 今开 / 最高 / 最低 / 成交量 / 成交额 / 内外盘归零，等次日开盘竞价的成交价来填「今开」
   * - **委托当日作废**：全部活动委托撤掉（真实市场收盘后未成交委托自动失效），
   *   冻结资金与仓位预留一并退回。不撤的话昨天的挂单会带着昨天的价格活到今天，
   *   玩家看到的盘口与自己的委托表都对不上。
   * @param {{cancelOrders?:boolean, day?:number}} [opts] day = 本次结算的是第几个交易日
   */
  settleDay(now = Date.now(), opts = {}) {
    const cancelOrders = opts.cancelOrders !== false;
    // 先定格当日日线：此刻今开/高低/成交量额还都是「今天」的，归零之后就再也拼不出来了
    flow.recordDailyBar(this, this.settleDayNo(now, opts), now);
    this.prevClose = this.lastPrice;
    this.open = this.lastPrice;
    this.high = this.lastPrice;
    this.low = this.lastPrice;
    this.volume = 0;
    this.turnover = 0;
    this.dayTradeCount = 0;
    // 当日内外盘随成交量额一起清零，新的一天重新累计
    flow.resetDayFlow(this);
    // 席位流水同理：席位榜是「当日」口径（龙虎榜每天重排）
    this.seatFlow.clear();
    // 人气热度也按日重置（论坛热度是当日情绪，不跨夜累积）
    this.dongfengTurnover = 0;
    this.dongfengHeat = 0;
    let canceled = 0;
    if (cancelOrders) {
      for (const o of [...this.book.orders.values()]) {
        const r = this.cancel(o.account, o.id, now, { internal: true });
        if (!r.ok) this.book.remove(o);
        else canceled += 1;
      }
    }
    return { prevClose: this.prevClose, canceled };
  }

  /**
   * 本次结算的是第几个交易日。优先用调用方显式给的 `day`——补结算发生在停机之后时，
   * 时钟推出来的「今天」并不是要结的那一天（见 Game.settleDay）；显式给 0 表示
   * 「没有已收盘的交易日」（比如白天补结算时昨天还没结束），那就**不记日线**，
   * 不能退回去拿「今天」顶替，否则会把盘中数据当成一根已收盘的 K 线。
   * 完全没给 `day` 时（孤立单测直接调 settleDay）才从交易日时钟推。
   */
  settleDayNo(now, opts = {}) {
    if (opts.day !== undefined) return Number(opts.day) || 0;
    return this.dayCycle && this.dayCycle.ok ? this.dayCycle.locate(now).day : 0;
  }

  // ---------- 停牌（手动运营开关） ----------

  /** 是否处于停牌中 */
  isHalted(now = Date.now()) {
    return this.haltUntil > now;
  }

  /**
   * 停牌。停牌期间行情推进、NPC 报价、风控强平与下单全部冻结，
   * 只保留撤单——玩家得能在停牌时收回自己的钱。
   * 重复调用按新的截止时间顺延。
   */
  halt(minutes, reason, now = Date.now()) {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) return { ok: false, error: '停牌时长无效' };
    if (mins > config.halt.maxMinutes) {
      return { ok: false, error: `停牌时长最多 ${config.halt.maxMinutes} 分钟` };
    }
    this.haltUntil = now + Math.round(mins * 60000);
    this.haltReason = String(reason || '').trim().slice(0, 60);
    return { ok: true, until: this.haltUntil, reason: this.haltReason };
  }

  /** 立即复牌 */
  resume(now = Date.now()) {
    const was = this.isHalted(now);
    this.haltUntil = 0;
    this.haltReason = '';
    return { ok: true, resumed: was };
  }

  /**
   * 停牌到点后清状态；返回是否刚刚结束，供主循环记日志。
   * 判断走 haltUntil 自然过期，所以不需要定时器。
   */
  expireHalt(now = Date.now()) {
    if (this.haltUntil && this.haltUntil <= now) {
      this.haltUntil = 0;
      this.haltReason = '';
      return true;
    }
    return false;
  }

  /** 下发给客户端的停牌状态 */
  haltInfo(now = Date.now()) {
    const halted = this.isHalted(now);
    return {
      halted,
      until: halted ? this.haltUntil : 0,
      reason: halted ? this.haltReason : '',
    };
  }

  /** 利息遍历用的账户列表；Game 注入 accountsProvider 时用真实账户，否则空（测试无池） */
  _allAccountsForInterest() {
    return this.accountsProvider ? this.accountsProvider() : [];
  }

  // ---------- 融券池 ----------

  /** 当前可借券源（股） */
  lendAvailable() {
    return Math.max(0, this.lendTotal - this.lendBorrowed - this.lendReserved);
  }

  /**
   * 某账户**实际能借到**的券源：池子可借量与「本账户券源容量」取小。
   *
   * 券源容量 = 池子总容量 × 券商券源系数（§6「融券券源 | margin.lending 容量乘券商系数」）：
   * 招伤只有 60%（再加上拥挤税 0.7 → 42%），天疯/嗨通 90%。
   * 系数 ≥ 1 时上限恒不生效（单账户借出量永远 ≤ 池子总量），
   * 所以 NPC 与无券商账户走这条路径时行为与引入券商之前逐位一致。
   */
  lendAvailableFor(account) {
    const avail = this.lendAvailable();
    if (!account) return avail;
    const bk = this.brokerFor(account);
    const mul = bk.lendCapacityMul;
    if (!(mul < 1)) return avail;
    const cap = Math.floor(this.lendTotal * mul) - account.shortQty(this.stockId);
    return Math.max(0, Math.min(avail, cap));
  }

  /** 池子紧张度 s ∈ [0,1]：已借出 / 总挂借 */
  lendUtilization() {
    return this.lendTotal > 0 ? Math.min(1, this.lendBorrowed / this.lendTotal) : 0;
  }

  /** 当前融券利率（小数**每天**）：券源越少利率越高，base × (1 + s × k)，封顶 maxDailyRate */
  lendDailyRate() {
    const cfg = config.margin.lending;
    if (!cfg || !cfg.enabled) return 0;
    const raw = cfg.baseDailyRate * (1 + this.lendUtilization() * cfg.stressK);
    return Math.min(raw, cfg.maxDailyRate);
  }

  /**
   * 某账户实际承担的日利率 = 市场利率 × 本券商券息倍率（招伤「券息上浮」1.4×）。
   * 上浮出来的那一部分是**券商的利差**，与融资利息一样从权益里蒸发（见 settleLendingInterest）。
   */
  lendDailyRateFor(account) {
    const base = this.lendDailyRate();
    if (base <= 0 || !account) return base;
    return base * (this.brokerFor(account).lendRateMul || 1);
  }

  /** 某账户在本股挂借中不可撤的量（已借出 + 在途开空占用，按池子比例分摊） */
  lendLockedQty(account) {
    const offered = account.ledgerOf(this.stockId).lendOffered || 0;
    if (offered <= 0 || this.lendTotal <= 0) return 0;
    // 只按 borrowed 算会漏掉 lendReserved：在途开空单占用的券源同样锁住，
    // 否则出借人可把已承诺的券撤走，成交后 lendBorrowed > lendTotal、借券方从此不计息
    const lockedRatio = Math.min(1, (this.lendBorrowed + this.lendReserved) / this.lendTotal);
    return Math.min(offered, Math.floor(offered * lockedRatio));
  }

  /** 某账户当前可撤回的挂借量（与 unlendShares 闸门同口径） */
  lendRemovableQty(account) {
    return Math.max(0, (account.ledgerOf(this.stockId).lendOffered || 0) - this.lendLockedQty(account));
  }

  /** 玩家/NPC 挂借：从可卖持仓中划出 qty 进入融券池 */
  lendShares(account, qty, now = Date.now()) {
    const cfg = config.margin.lending;
    if (!cfg || !cfg.enabled) return { ok: false, error: '融券功能未开放' };
    const lot = this.stock.lotSize;
    qty = Math.floor(Number(qty));
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: '数量无效' };
    if (qty % lot !== 0) return { ok: false, error: `挂借数量必须为 ${lot} 股的整数倍` };
    const free = account.freeSellableLong(this.stockId, now, this.brokerFor(account, now).lockMs);
    if (qty > free) return { ok: false, error: `可挂借不足，当前可挂借 ${free} 股` };
    const led = account.ledgerOf(this.stockId);
    led.lendOffered = (led.lendOffered || 0) + qty;
    this.lendTotal += qty;
    this.notifyChange(account);
    return { ok: true, qty, lendOffered: led.lendOffered, available: this.lendAvailable() };
  }

  /** 撤回挂借：只能撤未被借走、也未被在途开空单占用的部分 */
  unlendShares(account, qty, now = Date.now()) {
    const lot = this.stock.lotSize;
    qty = Math.floor(Number(qty));
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: '数量无效' };
    const led = account.ledgerOf(this.stockId);
    const offered = led.lendOffered || 0;
    // 被锁定的量 = 池子借出率 × 本人挂借（含在途开空占用）；剩余可撤
    const removable = this.lendRemovableQty(account);
    if (qty > removable) {
      return { ok: false, error: `可撤回不足，当前最多可撤 ${Math.floor(removable / lot) * lot} 股（被借走/开空占用部分需空头平仓后释放）` };
    }
    led.lendOffered = offered - qty;
    this.lendTotal = Math.max(0, this.lendTotal - qty);
    this.notifyChange(account);
    return { ok: true, qty, lendOffered: led.lendOffered, available: this.lendAvailable() };
  }

  /**
   * 每个 tick 累计做空利息——**只累计，不扣钱**。
   *
   * 利息按「持仓时长」积分：每 tick 记 `空头市值 × 日利率 × tickMs/一天`，攒在
   * `ledger.lendInterestAccrued` 上，收盘日终结算时一次性实扣（见 settleLendingInterest）。
   *
   * **为什么不在收盘那一刻按仓位一次性收**：那样计息基数只取决于「收盘瞬间有没有空头」，
   * 玩家在收盘竞价里平掉就整天空免、收盘前 1 秒开空却要付满一天，两头都能套利
   * （往返手续费 0.02% ≪ 日息 0.1%~0.4%，等于永不计息）。按 tick 积分后，
   * 「扛多久付多少」才真的成立，而玩家看到的仍是「收盘一次扣」。
   *
   * 只对借券开仓的部分计息：裸空模式（allowNakedShort）整段跳过，与「裸空不计息」一致。
   * day 时钟未启用时没有「日终结算」这个时点，退化为逐 tick 实扣（旧分钟息行为）。
   */
  accrueLendingInterest(now = Date.now()) {
    const cfg = config.margin.lending;
    if (!cfg || !cfg.enabled) return;
    if (config.margin.allowNakedShort) return;
    if (this.shortInterest <= 0 || this.dayMs <= 0) return;
    const rate = this.lendDailyRate();
    if (rate <= 0) return;
    const tickRate = rate * (config.tickIntervalMs / this.dayMs);
    const last = this.lastPrice;
    for (const acc of this._allAccountsForInterest()) {
      const qty = acc.shortQty(this.stockId);
      if (qty <= 0) continue;
      const led = acc.ledgerOf(this.stockId);
      // **这里绝不能 r2**：单 tick 的额对小仓位可能不到 0.005（100 股 @20、0.1%/日
      // 每 tick 只有 0.0002 元），逐次四舍五入会把尾数抹成 0，累计下来等于免息。
      // 尾数一路留着，只在 chargeLendingAccrued 真正扣款那一刻取整
      led.lendInterestAccrued = (led.lendInterestAccrued || 0) + qty * last * tickRate;
      // 玩家账户要逐 tick 落盘（NPC 在 notifyInterest 里被跳过，靠轮转扫描兜底）：
      // 不落盘的话重启只丢最后一次写库之后的那点累计，收盘扣的就不是完整一天的量
      this.notifyInterest(acc);
    }
    if (!this.dayCycle || !this.dayCycle.ok) this.chargeLendingAccrued(now, this.dayNumber(now));
  }

  /**
   * 把当日已累计的做空利息实扣下来：日终结算与「day 未启用」的逐 tick 扣款都走这里。
   *
   * 空头先扣现金再扣保证金，都不够则记欠息（计入权益的负债，等现金/保证金恢复后由
   * collectLendingDebt 追缴）；出借方按挂借份额分摊实收，只分「基准利率那一份」——
   * 券商上浮收上来的利差与融资利息一样直接从权益里蒸发，不能凭空转给出借人。
   *
   * @param {number} now 扣款时刻
   * @param {number} day 这一天是第几个交易日（免息券按它判；无时钟时为 0）
   * @returns {number} 本次实收总额（含券商上浮那一份）
   */
  chargeLendingAccrued(now = Date.now(), day = 0) {
    let collected = 0;
    let base = 0;
    for (const acc of this._allAccountsForInterest()) {
      // 用 ledger.get 而不是 ledgerOf：没有明细的账户本来就没有累计，不必给它建一条
      const led = acc.ledger.get(this.stockId);
      const accrued = led ? led.lendInterestAccrued || 0 : 0;
      if (accrued <= 0) continue;
      led.lendInterestAccrued = 0;
      // 免息券：这一档当天全免（券是用掉的那一天生效的）
      if (broker.interestWaived(acc, day)) continue;
      base += accrued;
      const owed = r2(accrued * (this.brokerFor(acc, now).lendRateMul || 1));
      if (owed <= 0) continue;
      let pay = 0;
      const fromCash = Math.min(owed, Math.max(0, acc.cash));
      if (fromCash > 0) {
        acc.cash = r2(acc.cash - fromCash);
        pay += fromCash;
      }
      let rest = owed - pay;
      if (rest > 0.005 && acc.shortMargin > 0) {
        const fromMargin = Math.min(rest, acc.shortMargin);
        acc.shortMargin = r2(acc.shortMargin - fromMargin);
        pay += fromMargin;
        rest -= fromMargin;
      }
      if (rest > 0.005) led.lendInterestDebt = r2((led.lendInterestDebt || 0) + rest);
      if (pay > 0) {
        led.lendInterestPaid = r2((led.lendInterestPaid || 0) + pay);
        collected += pay;
      }
      if (pay > 0 || rest > 0) this.notifyInterest(acc);
    }
    this.lastLendCharge = r2(collected);
    // 出借方只分基准利率那一份：券商上浮的利差直接蒸发（与融资利息同口径）
    if (collected > 0) this.payLenders(Math.min(r2(collected), r2(base)));
    return this.lastLendCharge;
  }

  /**
   * 做空利息的**日终结算**：每个游戏日收盘收一次（由 Game.settleDay 调用）。
   *
   * 结算日 = 刚刚收盘的那个交易日（`opts.day` 由 Game.settleDay 传入，与日线同一天）。
   * `lendSettledDay` 记「已收到哪一天」，同一个交易日绝不会收两次；Game 把它落进 meta，
   * 重启后由 Game.ensureDaySettled 补结算时恢复，不会重复收。
   * 真正的扣款见 chargeLendingAccrued（基数来自逐 tick 累计，不是收盘那一刻的仓位）。
   *
   * @param {number} now 结算时刻
   * @param {{day?:number}} [opts] 结算对应的交易日号（缺省时从交易日时钟推）
   * @returns {number} 已结算的交易日号；`-1` 表示这次没结（融券未开放 / 裸空模式 /
   *   这一天已结过、或回退到更早的日子）。**0 是合法交易日号**，调用方要用
   *   `!== -1` 判断，不能拿真假值判
   */
  settleLendingInterest(now = Date.now(), opts = {}) {
    const cfg = config.margin.lending;
    if (!cfg || !cfg.enabled || config.margin.allowNakedShort) return -1;
    const day = opts.day == null ? this.dayNumber(now) : Number(opts.day);
    // 记着的日子 ≥ 今天 = 这一天已经收过（重启补结算时可能重复问同一个 day）
    if (day <= (this.lendSettledDay ?? -1)) return -1;
    this.lendSettledDay = day;
    this.chargeLendingAccrued(now, day);
    return day;
  }

  /**
   * 把 amount 元融券利息分给出借方：按挂借量占池子的比例，最后一位收尾差。
   * 池子已清零时不分（没有收款方，分不出去的钱只能凭空消失）。
   */
  payLenders(amount) {
    if (!(amount > 0) || this.lendTotal <= 0) return 0;
    let assigned = 0;
    for (const acc of this._allAccountsForInterest()) {
      // ledger.get：没挂借的账户分不到钱，也不该在结算路径上给它建一条明细
      const led = acc.ledger.get(this.stockId);
      const offered = led ? led.lendOffered || 0 : 0;
      if (offered <= 0) continue;
      const income = amount * (offered / this.lendTotal);
      if (income <= 0) continue;
      const take = assigned + income >= amount ? amount - assigned : income;
      assigned += take;
      acc.cash = r2(acc.cash + take);
      led.lendInterestEarned = r2((led.lendInterestEarned || 0) + take);
      this.notifyInterest(acc);
    }
    return assigned;
  }

  /**
   * 追缴做空欠息：欠息账户的现金（其次保证金）恢复后优先补缴，
   * 按挂借份额补给当时吃过亏的出借方（与计息同一分配口径）。
   * 池子已清空时继续挂账——没有收款方，扣下来只会让资金凭空消失。
   */
  collectLendingDebt() {
    if (this.lendTotal <= 0) return 0;
    let collected = 0;
    for (const acc of this._allAccountsForInterest()) {
      // ledger.get：没有明细的账户不可能有欠息，别在当前这个每 tick 都会跑的函数里给它建
      const led = acc.ledger.get(this.stockId);
      const owed = led ? led.lendInterestDebt || 0 : 0;
      if (owed <= 0) continue;
      let pay = 0;
      const fromCash = Math.min(owed, Math.max(0, acc.cash));
      if (fromCash > 0) {
        acc.cash = r2(acc.cash - fromCash);
        pay += fromCash;
      }
      const rest = owed - pay;
      if (rest > 0.005 && acc.shortMargin > 0) {
        const fromMargin = Math.min(rest, acc.shortMargin);
        acc.shortMargin = r2(acc.shortMargin - fromMargin);
        pay += fromMargin;
      }
      if (pay <= 0) continue;
      // 补缴的钱同样是实付利息：累计已付 = 当场扣缴 + 事后补缴，与欠息一起构成累计产生额
      led.lendInterestPaid = r2((led.lendInterestPaid || 0) + pay);
      const left = r2(owed - pay);
      led.lendInterestDebt = left > 0.005 ? left : 0;
      collected += pay;
      this.notifyInterest(acc);
    }
    return this.payLenders(r2(collected));
  }

  // ---------- 融资利息 ----------

  /** 当前融资分钟利率（小数）：s = 全市场负债 / (负债 + 可动用现金)，现金越紧利率越高 */
  financeMinuteRate() {
    const cfg = config.margin.finance;
    if (!cfg || !cfg.enabled) return 0;
    let debt = 0;
    let cash = 0;
    for (const acc of this._allAccountsForInterest()) {
      debt += acc.financeDebt(this.stockId);
      if (acc.cash > 0) cash += acc.cash;
    }
    const denom = debt + cash;
    const s = denom > 0 ? debt / denom : 0;
    return Math.min(cfg.baseMinuteRate * (1 + s * cfg.stressK), cfg.maxMinuteRate);
  }

  /**
   * 每 tick 融资利息：按分钟利率折算到 tick，复利摊入各融资批次负债（debt ×= 1 + tickRate），
   * 同步扣减已实现盈亏——权益与账本同时下移，保证 权益 = 初始资金 + 已实现盈亏 + 浮动盈亏。
   * 利息没有对手方（券商资金成本），直接从权益里蒸发，是市场资金的净消耗。
   *
   * **只摊本股票的多头批次**：多股票下每个市场各调一次本函数，若遍历账户全部持仓，
   * 同一笔 B 股负债会被 10 个市场各计一次息。融资计息累计额也按股票记在 ledger 上。
   */
  accrueFinanceInterest(now = Date.now()) {
    const cfg = config.margin.finance;
    if (!cfg || !cfg.enabled) return;
    const tickRate = this.financeMinuteRate() * (config.tickIntervalMs / 60000);
    if (tickRate <= 0) return;
    const day = this.dayNumber(now);
    for (const acc of this._allAccountsForInterest()) {
      const pos = acc.longs.get(this.stockId);
      if (!pos || !pos.lots.length) continue;
      // 每日免息券生效中：这一天的融资利息全免（招伤自带 / 拥挤税补贴档）
      if (broker.interestWaived(acc, day)) continue;
      let total = 0;
      for (const lot of pos.lots) total += lot.debt || 0;
      if (total <= 0) continue;
      const add = r2(total * tickRate);
      if (add <= 0) continue;
      for (const lot of pos.lots) {
        if (lot.debt > 0) lot.debt = r2(lot.debt + add * (lot.debt / total));
      }
      acc.realizedPnL = r2(acc.realizedPnL - add);
      const led = acc.ledgerOf(this.stockId);
      led.financeInterestAccrued = r2((led.financeInterestAccrued || 0) + add);
      this.notifyInterest(acc);
    }
  }

  /**
   * 空头存量披露：**每个游戏日收盘日终结算时调用一次**（见 Game.settleDay）。
   *
   * 披露值（`shortInterestPub`）日内冻结，玩家在融券 tab 看到的「空头总持仓」就是它；
   * `shortHistory` 随之从「5 分钟采样」变成「一天一点」的日频序列。
   *
   * 同一天重复调用（收盘与夜间两段 settleDay / 重启后补结算）直接返回 false 忽略——
   * 与 `settleLendingInterest` 的 `lendSettledDay` 同一套去重思路，水位线只进不退。
   */
  publishShortInterest(day, now = Date.now()) {
    const d = Number(day);
    if (!Number.isFinite(d) || d <= this.shortInterestPubDay) return false;
    this.shortInterestPubDay = d;
    this.shortInterestPub = this.shortInterest;
    this.shortHistory.push({ t: now, day: d, qty: this.shortInterestPub });
    if (this.shortHistory.length > SHORT_HISTORY_DAYS) this.shortHistory.shift();
    return true;
  }

  /**
   * 下单入口
   * @returns {ok, error?, order?}
   */
  place(account, opts) {
    const now = opts.now ?? Date.now();
    const action = opts.action;
    const qty = Math.floor(opts.qty);
    const price = this.roundPrice(opts.price);

    // 停牌优先于其余校验：停牌时应答"已停牌"，而不是"冷却中/资金不足"
    if (this.isHalted(now)) return { ok: false, error: '已停牌，暂停下单' };

    // 交易日阶段门控：午休 / 夜间（收盘结算）不接受下单。
    // 撤单不受此限（见 cancel）——玩家得能在休市时把自己的钱收回来。
    const dc = this.dayCycle;
    if (dc && dc.ok && !dc.canTrade(now)) {
      const st = dc.locate(now);
      return { ok: false, error: `当前${st.phase.label}，暂停下单` };
    }

    if (!VALID_ACTIONS.has(action)) return { ok: false, error: '未知操作类型' };
    if (!Number.isFinite(price) || price <= 0) return { ok: false, error: '价格无效' };
    if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: '数量无效' };

    // 本账户此刻的有效券商参数（两级兜底：broker 覆盖 → 全局默认）。
    // 后面所有费率/冷却/保证金/融资/券源全部读它，不再直接读 config
    const bk = this.brokerFor(account, now);

    const isOpen = action === ACTIONS.BUY_OPEN || action === ACTIONS.SELL_OPEN;
    const lot = this.stock.lotSize;
    if (isOpen && qty % lot !== 0) {
      return { ok: false, error: `开仓数量必须为 ${lot} 股的整数倍` };
    }
    // 券商的禁买名单（天疯「禁买 2 只小票」）：**只拦开仓**。
    // 平仓放行是有意的——转户到禁买券商的玩家若手里正好持有这两只，
    // 连开仓带平仓一起禁会把他永久锁在里面，那不是一个代价、是一个 bug
    if (isOpen && bk.features && bk.features.forbidStocks && bk.features.forbidStocks.includes(this.stock.id)) {
      return { ok: false, error: `${bk.name}不接受本股票的新开仓（禁买名单内）` };
    }
    if (!this.inBand(price)) {
      const b = this.band();
      return { ok: false, error: `价格超出涨跌停范围（${b.down} ~ ${b.up}）` };
    }

    // 同股多空互斥（港交所口径）：同一账户在同一只股票上只能持有一个方向。
    // 占用判定含在途开仓委托，所以想换向必须先撤单、把另一侧真正平掉。
    // 平仓（sell_close / buy_close）与同向加仓不受限，由下面的券源/保证金闸门管。
    if (isOpen) {
      const lock = account.sideLock(this.stock.id);
      if (action === ACTIONS.BUY_OPEN && lock.short) {
        return { ok: false, error: '该股已有空头持仓（或卖出开空委托在途），需先买入平空才能买入开多' };
      }
      if (action === ACTIONS.SELL_OPEN && lock.long) {
        return { ok: false, error: '该股已有多头持仓（或买入开多委托在途），需先卖出平多才能卖出开空' };
      }
    }

    // 下单冷却（NPC 不受限）。冷却时长按**账户券商**取：滑泰 0.5 秒、钟信 3 秒。
    // 嗨通证券的「偶发通道卡顿」也落在这里（约 2% 的报单多等 1 个 tick）——
    // 设计稿 §9 D4 明确不做侵入撮合的「报单延迟 tick」，用冷却表达同源效果、零侵入。
    // glitchDelay 只在「这一单本可以下」的边界上多要一个 tick（无券商/无该 feature 恒为 0）
    if (!account.isNPC && !opts.noCooldown && account.lastOrderAt != null) {
      const wait = bk.cooldownMs + broker.glitchDelay(account, bk) - (now - account.lastOrderAt);
      if (wait > 0) {
        return { ok: false, error: `下单过于频繁，请 ${(wait / 1000).toFixed(1)} 秒后再试`, cooldownMs: wait };
      }
    }

    // 委托价不得过度偏离最新价（NPC 内部报价与系统强平豁免）
    if (!account.isNPC && !opts.noDeviationCheck && this.lastPrice > 0) {
      const dev = Math.abs(price - this.lastPrice) / this.lastPrice;
      if (dev > config.trade.maxDeviation) {
        return {
          ok: false,
          error: `委托价偏离最新价 ${(dev * 100).toFixed(1)}%，超过 ${(config.trade.maxDeviation * 100).toFixed(0)}% 上限`,
        };
      }
    }

    const feeRate = bk.feeRate;
    const ratio = bk.marginRatio;
    const maintenance = bk.maintenance;
    // 自备比例按**账户券商**取：钟信 40%（2.5 倍）、天疯 30%（3.33 倍）、滑泰 60%（1.67 倍）。
    // 声明在 switch 之外，因为下面的委托对象要用它把冻结口径锁在挂单那一刻
    const finRatio = bk.financeRatio;
    let freeze = 0; // 冻结到 orderFrozen 的金额
    let precheck = '';

    switch (action) {
      case ACTIONS.BUY_OPEN: {
        const finCfg = config.margin.finance;
        const useFinance = !!opts.finance;
        if (useFinance && (!finCfg || !finCfg.enabled)) {
          return { ok: false, error: '融资买入未开放' };
        }
        if (useFinance) {
          // 融资开多：按**组合口径**做权益预检——权益是账户全部持仓的合计，
          // 敞口也是账户全部融资多头的合计（含各市场在途开多单），
          // 这样「敞口上限 = 维持率 × 权益」在跨股票时仍然成立；
          // 若只看本股，玩家可以在 10 只股票上各开满 2 倍，总敞口到 20 倍。
          let pendingLongMV = 0;
          for (const o of account.orders.values()) {
            if (o.status === 'live' && o.action === ACTIONS.BUY_OPEN) {
              pendingLongMV += o.price * (o.qty - o.filled);
            }
          }
          const eq = this.equityOf(account);
          const addMV = price * qty;
          const need =
            maintenance * (account.totalLongValue((sid) => this._price(sid)) + pendingLongMV + addMV) +
            r2(addMV * feeRate);
          if (eq < need) return { ok: false, error: '保证金不足，无法融资买入' };
          // 自备资金 = 成交市值 × ratio，手续费随借入部分进负债（见 settleBuy）。
          // 冻结若额外含一份全款手续费，"2 倍"就买不到整 2 倍：满仓玩家会被最后几十元卡住
          freeze = r2(price * qty * finRatio);
        } else {
          freeze = r2(price * qty * (1 + feeRate));
        }
        if (account.cash < freeze) return { ok: false, error: '可用资金不足' };
        break;
      }
      case ACTIONS.SELL_CLOSE: {
        // 挂入融券池的券不能再卖：可卖 = freeSellableLong（可卖 − 已挂借）。
        // 锁仓时长按**账户券商**取（滑泰 5 秒 / 天疯 8 秒 / 基准 10 秒）——
        // 与下面那条提示文案、以及 reserveLong 必须同源，否则会出现
        // 「提示说 5 秒、实际锁 10 秒」的自相矛盾
        const sellable = account.freeSellableLong(this.stock.id, now, bk.lockMs);
        if (sellable < qty) {
          const locked = account.longQty(this.stock.id) - sellable;
          precheck = sellable <= 0 && locked > 0 ? `可卖数量为 0（${bk.lockMs / 1000} 秒锁仓中或已挂借融券）` : `可卖数量不足，当前可卖 ${sellable} 股`;
          return { ok: false, error: precheck };
        }
        // 融资负债预检：深跌破位时卖出款可能盖不住将偿还的负债，此时要求现金补差。
        // 不校验的话结算会把现金打成负数（自愿单不允许穿仓，穿仓只留给强平兜底）。
        // 必须先预览再预留：previewFinanceDebt 只看未预留批次，先 reserve 会把自己的
        // 预留段算成"他人占用"，预览金额直接归零（与 BUY_CLOSE 的保证金预览同一口径）
        const repayPreview = account.previewFinanceDebt(this.stock.id, qty);
        if (!account.reserveLong(this.stock.id, qty, now, bk.lockMs)) {
          return { ok: false, error: '可卖数量不足' };
        }
        if (repayPreview > 0 && account.cash + price * qty < repayPreview + r2(price * qty * feeRate)) {
          account.releaseLong(this.stock.id, qty);
          return { ok: false, error: '可用资金不足（卖出款不足以偿还融资负债）' };
        }
        // 卖单一律不冻结手续费：费用在成交时从卖出款里扣，而卖出款必然覆盖
        // 手续费（费率万分之一），预冻结没有任何兜底作用。
        // 若反过来要求可用余额 ≥ 手续费预估，满仓清仓会因余额只剩几十元
        // 挂不出卖单——持仓卖不掉就永远拿不到钱，账户直接锁死。
        // （NPC 此前就因同一死锁被豁免，此处统一玩家与 NPC 的口径）
        break;
      }
      case ACTIONS.SELL_OPEN: {
        // 裸空后门：allowNakedShort=true 时不借券、不占池、不计息。
        // 默认 false：开空必须从融券池借券，可借不足拒单。
        if (!config.margin.allowNakedShort) {
          if (!config.margin.lending || !config.margin.lending.enabled) {
            return { ok: false, error: '融券做空未开放' };
          }
          // 券源按**账户券商**折算：招伤的券源只有池子的 60%、拥挤重罚档再打 0.7。
          // 券源充裕时（系数 ≥1）这个上限恒不生效，所以 NPC 与无券商账户行为逐位不变
          const avail = this.lendAvailableFor(account);
          if (avail < qty) {
            return {
              ok: false,
              error: `可借券源不足，当前可借 ${avail} 股（请先有人挂借出）`,
            };
          }
          this.lendReserved += qty; // 占用券源，成交/撤单时释放
        }
        // 开空：成交时从卖出所得中扣保证金，此处只做保证金预检。
        // 预检按保证金率（ratio）而不是维持率（maintenance）——保证金是从卖出款里扣的、
        // 不动自有资金，只按维持率放行会把敞口放到 3.3 倍权益，而做多被自备资金卡在 2 倍，
        // 两边不对称，也和"做空保证金 50%"的说明对不上。
        // 在途开空（已挂未成交）的名义市值也要并入占用：否则连挂多张贴边单
        // 各自预检都过、成交后合计跌破维持线，成交即强平
        // 多股票下敞口按**账户全部空头**合计（含各市场在途开空单），与权益的组合口径对称
        let pendingShortMV = 0;
        for (const o of account.orders.values()) {
          if (o.status === 'live' && o.action === ACTIONS.SELL_OPEN) {
            pendingShortMV += o.price * (o.qty - o.filled);
          }
        }
        const eq = this.equityOf(account);
        const addMV = price * qty;
        const need =
          ratio * (account.totalShortMV((sid) => this._price(sid)) + pendingShortMV + addMV) +
          r2(addMV * feeRate);
        if (eq < need) {
          if (!config.margin.allowNakedShort) this.lendReserved = Math.max(0, this.lendReserved - qty);
          return { ok: false, error: '保证金不足，无法继续开空' };
        }
        break;
      }
      case ACTIONS.BUY_CLOSE: {
        if (account.coverableShort(this.stock.id) < qty) {
          return { ok: false, error: '空头持仓不足' };
        }
        // 先预览再预留：preview 只看未预留批次，若先 reserve 会把本单自己的
        // 预留段也算成"他人占用"，预览金额直接归零
        const released = account.previewShortMargin(this.stock.id, qty);
        if (!account.reserveShort(this.stock.id, qty)) {
          return { ok: false, error: '空头持仓不足' };
        }
        freeze = r2(price * qty * feeRate);
        if (account.cash + released < price * qty * (1 + feeRate)) {
          account.releaseShort(this.stock.id, qty);
          return { ok: false, error: '可用资金不足（平空需支付买入款）' };
        }
        // NPC 回补空头不冻结手续费（成交时从结算款里扣），与卖单同一逻辑：
        // 现金被耗尽但保证金在手的机构必须能回补，否则空头把买盘锁死、顶部死锁
        if (account.isNPC) {
          freeze = 0;
        } else if (account.cash < freeze) {
          account.releaseShort(this.stock.id, qty);
          return { ok: false, error: '可用资金不足' };
        }
        break;
      }
      default:
        break;
    }

    if (freeze > 0) {
      account.cash = r2(account.cash - freeze);
      account.orderFrozen = r2(account.orderFrozen + freeze);
    }

    this.orderSeq += 1;
    const order = {
      // 委托号带股票前缀：10 只股票各有自己的 orderSeq，不加前缀会在 orders 表主键上撞号
      id: this.stock.id + '-O' + this.orderSeq,
      seq: this.orderSeq,
      stockId: this.stock.id,
      ownerId: account.name,
      account,
      action,
      side: BUY_ACTIONS.has(action) ? 'buy' : 'sell',
      price,
      qty,
      filled: 0,
      frozen: freeze,
      finance: action === ACTIONS.BUY_OPEN && !!opts.finance, // 融资开多标记（结算按此拆自备/借入）
      // **结算按挂单时的券商参数**，与冻结口径锁死：
      // 每周之星在交易日边界上轮换，A→B 那一刻若同一张挂单还活着，
      // 用结算当刻的费率会与冻结的钱对不上（沿用 order.finance 那条既有推理）
      feeRate,
      finRatio,
      marginRatio: ratio,
      broker: account.broker || null, // 席位（§11.3）：随委托一路带到成交流水
      ts: now,
      status: 'live',
    };

    account.orders.set(order.id, order);
    // 普通 NPC 不记委托/成交历史：3160 个账户各留 100 条会在长跑后把 V8 堆挤爆，
    // 而这两份历史只有玩家 UI 与 AI 主力观测页会读（AI whale 有 ai=true，照常记）
    if (!account.isNPC || account.ai) {
      account.orderHistory.unshift(order);
      if (account.orderHistory.length > 100) account.orderHistory.length = 100;
    }
    if (!account.isNPC && !opts.noCooldown) account.lastOrderAt = now;

    // 集合竞价阶段：**只入簿、不撮合**。成交要等阶段结束时按「最大成交量原则」
    // 一次性集中撮合（见 runAuction）——在此之前每一单都还可能被撤回或被后来者挤掉，
    // 这正是集合竞价与连续撮合的本质区别。
    if (this.auctionKind(now)) {
      this.book.add(order);
    } else {
      this.match(order, now, order.side);
    }
    this.notifyChange(account, order);
    return { ok: true, order };
  }

  /** 主动撮合：把订单与对手盘撮合，剩余挂入订单簿 */
  match(order, now, aggressorSide) {
    while (order.filled < order.qty) {
      // 撮合途中可能被风控撤单：execute 里的 maybeLiquidate 会撤掉本账户的在途委托，
      // 包括这张正在撮合的主动单。此时必须立即收手——继续撮合等于撤销无效，
      // 而走到末尾的 book.add 会把一张 status=canceled 的单塞回订单簿，
      // 变成账户再也撤不掉、却仍能被别人吃到的幽灵单。
      if (order.status !== 'live') return;

      const opp = order.side === 'buy' ? this.book.asks : this.book.bids;
      const best = opp[0];
      if (!best) break;
      if (order.side === 'buy' && best.price > order.price) break;
      if (order.side === 'sell' && best.price < order.price) break;

      // 必须按对手方剩余量取，防止部分成交后越量成交
      const bestRemain = best.qty - best.filled;
      if (bestRemain <= 0) {
        this.book.remove(best);
        continue;
      }
      // 禁止自成交：同一账户的挂单不能当自己的对手盘。
      // 否则零成本对倒即可改写最新价（成交价 = 被动方挂单价），
      // 而最新价既是涨跌幅基准、又是 NPC 公允价值的锚。
      // 必须保证这一轮一定把 best 移出订单簿，否则 continue 会原地打转：
      // cancel 对"在簿但已不在账户挂单表"的残留单会失败且不移簿，故补一次强制移除
      if (best.account === order.account) {
        if (!this.cancel(best.account, best.id, now).ok) this.book.remove(best);
        continue;
      }
      // 价格笼子：脱离笼子的挂单不能按自己的挂单价成交。否则一张远挂单被吃掉就能
      // 把最新价一把拉走（+49% 的对倒刷价、把筹码砸给 NPC 的套现路径都靠这个）。
      // 直接撤掉该挂单：既保证循环一定前进，也避免盘口出现买卖价交叉
      if (!this.inCage(best.price)) {
        if (!this.cancel(best.account, best.id, now).ok) this.book.remove(best);
        continue;
      }
      const take = Math.min(order.qty - order.filled, bestRemain);
      // 被动单的持仓可能已被强平消耗（残留挂单），撤掉后继续找下一个对手盘
      if (!this.isSettleable(best, take)) {
        this.dropStaleOrder(best, now);
        continue;
      }
      const tradePrice = best.price; // 成交价 = 被动方挂单价
      this.execute(order, best, tradePrice, take, now, aggressorSide);
    }
    if (order.filled < order.qty) {
      if (order.status === 'live') this.book.add(order);
    } else {
      this.finishOrder(order, now);
    }
  }

  /**
   * 挂单是否仍具备可结算的持仓。
   * 强平会直接扣减持仓，若不校验，持仓已归零的挂单仍会成交，
   * 从而出现「没有股票却收到卖出款」的凭空造钱路径。
   */
  isSettleable(order, qty) {
    if (order.force) return true;
    const acc = order.account;
    if (order.action === ACTIONS.SELL_CLOSE) return acc.longQty(order.stockId) >= qty;
    if (order.action === ACTIONS.BUY_CLOSE) return acc.shortQty(order.stockId) >= qty;
    return true;
  }

  /** 清理持仓已不存在的残留挂单，退回残余冻结与仓位预留 */
  dropStaleOrder(order, now = Date.now()) {
    this.book.remove(order);
    order.status = 'canceled';
    const acc = order.account;
    if (order.frozen > 0) {
      acc.cash = r2(acc.cash + order.frozen);
      acc.orderFrozen = r2(acc.orderFrozen - order.frozen);
      order.frozen = 0;
    }
    // 与 cancel 同口径释放未成交部分的仓位预留，否则这部分股数会被永久锁死
    const remain = order.qty - order.filled;
    if (remain > 0) {
      if (order.action === ACTIONS.SELL_CLOSE) acc.releaseLong(order.stockId, remain);
      if (order.action === ACTIONS.BUY_CLOSE) acc.releaseShort(order.stockId, remain);
      if (order.action === ACTIONS.SELL_OPEN && !config.margin.allowNakedShort) {
        this.lendReserved = Math.max(0, this.lendReserved - remain);
      }
    }
    acc.orders.delete(order.id);
    this.notifyChange(acc, order);
    this.syncReserved(acc, order.stockId, now);
  }

  /** 单笔撮合：结算双方、记流水、更新行情 */
  execute(taker, maker, price, qty, now, aggressorSide) {
    // 弹幕（§3.3.2）：玩家「清仓割肉」的判定基线必须在 settleSell **之前**取——
    // 卖完之后批次可能整个消失，事后再也算不出买入均价。只对玩家算，NPC 直接跳过
    let dmSell = null;
    if (this.onPlayerAction) {
      const sellOrder0 = taker.side === 'sell' ? taker : maker;
      const acc0 = sellOrder0 && sellOrder0.account;
      if (acc0 && !acc0.isNPC) {
        const pos0 = acc0.longs && acc0.longs.get(this.stockId);
        let q0 = 0;
        let c0 = 0;
        if (pos0 && pos0.lots) {
          for (const l of pos0.lots) {
            q0 += l.qty;
            c0 += l.qty * l.price;
          }
        }
        dmSell = { acc: acc0, qty: q0, avg: q0 > 0 ? c0 / q0 : 0 };
      }
    }

    const feeBuy = this.settleBuy(taker.side === 'buy' ? taker : maker, price, qty, now);
    const feeSell = this.settleSell(taker.side === 'sell' ? taker : maker, price, qty, now);

    // NPC 账户把本股批次合并成一条：一笔成交压一条批次的话，单账户能攒到几千条，
    // 而落盘每 tick 要把脏账户的全部批次整段重写（正式档实测 40 万行/tick）。
    // 必须在 notifyChange（标脏）之前合并，写库时才只写合并后的那一条
    if (taker.account.isNPC) taker.account.consolidate(this.stockId);
    if (maker.account !== taker.account && maker.account.isNPC) maker.account.consolidate(this.stockId);

    taker.filled += qty;
    maker.filled += qty;
    if (maker.filled >= maker.qty) {
      this.book.remove(maker);
      this.finishOrder(maker, now);
    }
    if (taker.filled >= taker.qty) this.finishOrder(taker, now);

    // 席位（§11.3）：成交价 = 被动方挂单价，买卖双方各自的券商就是这笔的买卖席位
    const buyOrder = taker.side === 'buy' ? taker : maker;
    const sellOrder = taker.side === 'buy' ? maker : taker;
    const buyBroker = buyOrder.account.broker || null;
    const sellBroker = sellOrder.account.broker || null;
    const amount = r2(price * qty);
    this.addSeatFlow(buyBroker, sellBroker, amount);
    // 券商进度（星级用）：只记玩家
    this.addBrokerProgress(buyOrder.account, amount, now);
    this.addBrokerProgress(sellOrder.account, amount, now);
    // 东风人气 buff 的燃料：只统计**东风玩家的成交额**（NPC 的东风标签不算，
    // 否则热度会由 NPC 自己凭空烧起来，与"本券商客户把论坛吵热"的设定不符）
    for (const o of [buyOrder, sellOrder]) {
      if (!o.account.isNPC && o.account.broker === 'dongfeng') this.dongfengTurnover += amount;
    }

    this.onTrade(price, qty, aggressorSide, now, buyBroker, sellBroker);

    // 记录双方成交：内存流水用于客户端展示，落库明细用于重启后恢复成交记录
    this.notifyChange(taker.account, taker);
    this.notifyChange(maker.account, maker);
    // 成交序号：**跨股票全局单调**（见文件头的 TRADE_SEQ）。`/open/v1/fills` 拿它做
    // 增量游标；同一 tick 可能连出好几笔，用时间戳会把同毫秒的成交整批漏掉。
    const tradeSeq = nextTradeSeq();
    for (const o of [taker, maker]) {
      const rec = {
        id: 'T' + tradeSeq + '-' + o.id + '-' + qty,
        orderId: o.id,
        stockId: o.stockId,
        action: o.action,
        price,
        qty,
        t: now,
        side: aggressorSide,
        // 成交序号：开放接口的 /fills 用它做增量游标（同一 tick 可能连出好几笔，
        // 用时间戳做游标会把同毫秒的成交整批漏掉）
        seq: tradeSeq,
      };
      // 与 orderHistory 同规矩：普通 NPC 不留内存成交史（AI whale 与玩家照记）
      if (!o.account.isNPC || o.account.ai) {
        o.account.tradeHistory.unshift(rec);
        if (o.account.tradeHistory.length > 100) o.account.tradeHistory.length = 100;
      }
      // SYSTEM 是虚拟对手盘，不是真实账户，不进成交流水
      if (this.journal && o.account.name !== 'SYSTEM') {
        this.journal.recordTrade({
          account: o.account.name,
          role: o === taker ? 'taker' : 'maker',
          orderId: o.id,
          stockId: o.stockId,
          action: o.action,
          side: aggressorSide,
          price,
          qty,
          fee: o.side === 'buy' ? feeBuy : feeSell,
          tradeSeq,
          t: now,
          // 席位随成交流水落库，重启后磁带的买卖席位能原样恢复（§11.4.5）
          broker: o.account.broker || null,
          counterBroker: (o === taker ? maker : taker).account.broker || null,
        });
      }
    }

    // 成交后立即做风控检查
    this.maybeLiquidate(taker.account, now);
    if (maker.account !== taker.account) this.maybeLiquidate(maker.account, now);

    // 结算里的 consume 按 FIFO 吃批次，可能吃到「别的委托占着的那一批」，预留量就此与
    // 在途委托量脱钩（见 Account.syncReserved）。成交是唯一会移动持仓的路径，收尾重摊一次
    this.syncReserved(taker.account, this.stockId, now);
    if (maker.account !== taker.account) this.syncReserved(maker.account, this.stockId, now);

    // 弹幕（§3.3.2）：玩家成交的被动反应。放在风控之后——这笔成交若直接打穿保证金，
    // 「有人被抬走了」应该先于「有人割在地板上」。整段吞异常：观测层绝不能穿回撮合路径
    if (this.onPlayerAction) {
      try {
        if (buyOrder.account && !buyOrder.account.isNPC) {
          this.onPlayerAction(buyOrder.account, 'buy', this.stockId, amount, qty, now, null);
        }
        if (dmSell && dmSell.acc === sellOrder.account) {
          this.onPlayerAction(sellOrder.account, 'sell', this.stockId, amount, qty, now, {
            avg: dmSell.avg,
            qtyBefore: dmSell.qty,
            posAfter: sellOrder.account.longQty(this.stockId),
          });
        }
      } catch (e) {
        /* 弹幕异常不影响成交 */
      }
    }
  }

  /**
   * 席位流水累计（§11.3）：按券商聚合当日买入/卖出成交额。
   *
   * **只喂展示层**——席位榜与龙虎榜读它，拥挤度不读它（拥挤度是配置里的固有属性，§9 D3）。
   * 系统兜底账户（SYSTEM）没有券商，不入账。
   */
  addSeatFlow(buyer, seller, amount) {
    if (buyer && buyer !== 'SYSTEM') {
      const row = this.seatFlow.get(buyer) || { buyAmt: 0, sellAmt: 0, buyVol: 0, sellVol: 0 };
      row.buyAmt += amount;
      this.seatFlow.set(buyer, row);
    }
    if (seller && seller !== 'SYSTEM') {
      const row = this.seatFlow.get(seller) || { buyAmt: 0, sellAmt: 0, buyVol: 0, sellVol: 0 };
      row.sellAmt += amount;
      this.seatFlow.set(seller, row);
    }
  }

  /**
   * 玩家的券商进度累计（§5.4 星级 / 合规分）。
   *
   * **NPC 不计**：NPC 的券商只是展示标签，给它记进度毫无意义，还白白增加每 tick 的写入。
   * 累计成交额是「在这家券商做的量」，所以转户后目标券商从零开始（这正是设计意图）。
   */
  addBrokerProgress(acc, amount, now) {
    if (!acc || acc.isNPC || !acc.broker) return;
    const rec = broker.statsOf(acc, acc.broker);
    rec.volume = (rec.volume || 0) + amount;
  }

  /** 东风人气 buff 的配置（写在券商条目里，与券商的其它参数放在一起） */
  dongfengHeatCfg() {
    const b = config.brokers && config.brokers.list && config.brokers.list.dongfeng;
    return (b && b.heat) || null;
  }

  /**
   * 推进「论坛热度」（§3.6）：当日东风客户成交额占流通市值的比例 → 0~1 的热度，
   * 每 tick 向目标值缓动（涨得快、退得慢）。
   *
   * **只调制散户 NPC 的交易行为**（跟风强度），绝不碰公允价值与噪声——项目纪律。
   * 没有东风客户、或配置关掉时热度恒为 0，NPC 行为逐位不变。
   */
  updateDongfengHeat(now = Date.now()) {
    const cfg = this.dongfengHeatCfg();
    if (!cfg || !cfg.enabled) {
      this.dongfengHeat = 0;
      return 0;
    }
    const cap = this.stock.floatShares * this.stock.initPrice * (cfg.refTurnoverPct || 0.02);
    const target = cap > 0 ? Math.min(1, this.dongfengTurnover / cap) : 0;
    const rate = cfg.decayPerTick == null ? 0.004 : cfg.dongfengDecayPerTick || cfg.decayPerTick;
    this.dongfengHeat = Math.max(0, this.dongfengHeat + (target - this.dongfengHeat) * rate);
    return this.dongfengHeat;
  }

  onTrade(price, qty, aggressorSide, now, buyBroker, sellBroker) {
    // 本交易日第一笔成交决定「今开」，同时把最高/最低从昨收的占位值上摘下来
    if (this.dayTradeCount === 0) {
      this.open = price;
      this.high = price;
      this.low = price;
    }
    this.dayTradeCount += 1;
    this.lastPrice = price;
    if (price > this.high) this.high = price;
    if (price < this.low) this.low = price;
    this.volume += qty;
    this.turnover += price * qty;
    // 内外盘：主动买进外盘、主动卖进内盘，净流入 = 外盘额 − 内盘额
    flow.addTrade(this, aggressorSide, price, qty);
    this.trades.unshift({
      seq: this.trades.length ? this.trades[0].seq + 1 : 1,
      t: now,
      price,
      qty,
      side: aggressorSide, // 主动方向：buy=买盘主动(sell贴)、sell=卖盘主动
      // 逐笔的「买方席位 / 卖方席位」（§11.3）
      buyBroker: buyBroker || null,
      sellBroker: sellBroker || null,
    });
    if (this.trades.length > config.market.tradeTapeSize) this.trades.length = config.market.tradeTapeSize;
  }

  /** 买入方向结算（开多 / 平空） */
  settleBuy(order, price, qty, now) {
    const acc = order.account;
    const feeRate = order.feeRate != null ? order.feeRate : config.trade.feeRate;
    const fee = r2(price * qty * feeRate);
    // 系统兜底账户只是虚拟对手盘，不参与建仓/持仓统计，否则会无限累积
    const isGhost = acc === SYSTEM_ACCOUNT;

    if (order.action === ACTIONS.BUY_OPEN) {
      const finCfg = config.margin.finance;
      const finRatio = order.finRatio != null ? order.finRatio : finCfg.ratio;
      const fin = !!order.finance; // 按下单时的标记结算（冻结口径与之一致，不受配置热改影响）
      // 退回按挂单价冻结的资金，按实际成交价结算
      const frozenPerShare = fin ? finRatio : 1 + feeRate;
      const rel = this.releaseFrozen(order, r2(order.price * qty * frozenPerShare));
      const cost = r2(price * qty);
      // 融资单只支付自备部分（ratio × 成交市值），手续费不扣现金而是并入负债：
      // 冻结口径只含自备部分，若手续费另从现金扣，满仓时会因差几十元当场结算成负数
      const selfPay = fin ? r2(cost * finRatio) : cost;
      const cashFee = fin ? 0 : fee;
      acc.cash = r2(acc.cash + rel - selfPay - cashFee);
      if (!isGhost) {
        // 新买入批次：以本次成交时间起算锁仓；融资单带负债（借入本金 + 开仓手续费，利息按 tick 摊入）。
        // principal 是其中借来的本金部分（固定不动），debt 随利息复利上浮，两者之差就是这批已计利息。
        const borrow = fin ? r2(cost * (1 - finRatio) + fee) : 0;
        acc.longPos(order.stockId).lots.push({
          qty,
          price,
          ts: now,
          reserved: 0,
          debt: borrow,
          principal: borrow,
        });
        // 开仓手续费也计入已实现盈亏，否则 权益 ≠ 初始资金 + 已实现盈亏 + 浮动盈亏
        acc.realizedPnL = r2(acc.realizedPnL - fee);
      }
    } else {
      // 平空：退回费用预估 + 释放保证金 + 支付买入款（盈亏只记账，现金里隐含在原始卖出去处）
      const rel = this.releaseFrozen(order, r2(order.price * qty * feeRate));
      const cons = acc.consumeShort(order.stockId, qty);
      acc.shortMargin = r2(acc.shortMargin - cons.margin);
      const pnl = r2(cons.openSum - price * cons.qty);
      acc.cash = r2(acc.cash + rel + cons.margin - price * cons.qty - fee);
      acc.realizedPnL = r2(acc.realizedPnL + pnl - fee);
      if (!isGhost) {
        this.shortInterest -= cons.qty;
        // 平空还券：释放借出额度回池
        if (!config.margin.allowNakedShort) {
          this.lendBorrowed = Math.max(0, this.lendBorrowed - cons.qty);
        }
      }
    }
    // 返回实际收取的手续费，供成交流水记账
    return fee;
  }

  /** 卖出方向结算（平多 / 开空） */
  settleSell(order, price, qty, now) {
    const acc = order.account;
    const feeRate = order.feeRate != null ? order.feeRate : config.trade.feeRate;
    const fee = r2(price * qty * feeRate);
    const isGhost = acc === SYSTEM_ACCOUNT;

    if (order.action === ACTIONS.SELL_CLOSE) {
      const rel = this.releaseFrozen(order, r2(order.price * qty * feeRate));
      const cons = acc.consumeLong(order.stockId, qty);
      // 只按实际扣减到的持仓入账：持仓不足时不得凭空产生现金
      const sold = Math.min(cons.qty, qty);
      const soldFee = r2(price * sold * feeRate);
      // 卖出款优先偿还该批次融资负债（利息已在摊入时计入 realizedPnL，这里只还钱）
      acc.cash = r2(acc.cash + price * sold + rel - cons.debt - soldFee);
      acc.realizedPnL = r2(acc.realizedPnL + (price * sold - cons.cost) - soldFee);
      // 按实际扣减到的数量计费，与被扣的手续费保持一致
      return soldFee;
    } else {
      // 开空：卖出所得入账，按成交市值冻结保证金。保证金率按账户券商（天疯 30% / 滑泰 60%）
      const marginRatio = order.marginRatio != null ? order.marginRatio : config.margin.ratio;
      const proceeds = r2(price * qty);
      const marginAdd = r2(proceeds * marginRatio);
      acc.cash = r2(acc.cash + proceeds - marginAdd - fee);
      acc.shortMargin = r2(acc.shortMargin + marginAdd);
      if (!isGhost) {
        acc.shortPos(order.stockId).lots.push({ qty, price, margin: marginAdd, reserved: 0 });
        acc.realizedPnL = r2(acc.realizedPnL - fee);
        this.shortInterest += qty;
        // 借券开仓：释放下单占用、计入已借出（裸空后门不走池）
        if (!config.margin.allowNakedShort) {
          this.lendReserved = Math.max(0, this.lendReserved - qty);
          this.lendBorrowed += qty;
        }
      }
    }
    return fee;
  }

  /** 退回挂单冻结（不超过剩余 frozen），返回退回金额 */
  releaseFrozen(order, want) {
    const rel = Math.min(order.frozen, want);
    order.frozen = r2(order.frozen - rel);
    if (rel > 0) {
      order.account.orderFrozen = r2(order.account.orderFrozen - rel);
    }
    return rel;
  }

  /** 订单完结（全部成交）：清退残余冻结、移出挂单表 */
  finishOrder(order, now = Date.now()) {
    if (order.status !== 'live') return;
    order.status = 'filled';
    const acc = order.account;
    if (order.frozen > 0) {
      acc.cash = r2(acc.cash + order.frozen);
      acc.orderFrozen = r2(acc.orderFrozen - order.frozen);
      order.frozen = 0;
    }
    // 释放未成交部分的仓位预留（按 action 由 cancel 之外的路径：此处只在完全成交时无需处理，
    // 部分成交后由 cancel 处理剩余；但完全成交时预留应刚好等于成交数量，已被 consume 掉）
    acc.orders.delete(order.id);
    this.notifyChange(acc, order);
    // 完全成交也可能留下残留预留：consume 按 FIFO 扣批次，一旦吃到的批次归别的委托所有，
    // 本单自己那份预留就没被扣掉（它已经没有委托号可以释放了），只能按在途委托重摊
    this.syncReserved(acc, order.stockId, now);
  }

  /**
   * 撤单。
   * @param {{internal?:boolean}} [opts] internal=true 表示系统内部撤单（撮合兜底、日终结算、
   *   NPC 重报价），不受集合竞价「锁定期不可撤单」约束；玩家的撤单请求不传，会被拦下。
   */
  cancel(account, orderId, now, opts = {}) {
    const order = account.orders.get(orderId);
    if (!order) return { ok: false, error: '委托不存在或已完结' };
    if (order.status !== 'live') {
      account.orders.delete(orderId);
      return { ok: false, error: '委托已完结' };
    }
    // 集合竞价最后 10 秒锁死：想撤的人撤不掉、想追的人不敢追。
    // 这是整个竞价系统最有价值的心理设计点（真实市场 09:20 那条硬线）
    if (!opts.internal && this.auctionLocked(now)) {
      return { ok: false, error: '集合竞价已锁定，不可撤单（等待开盘集中撮合）' };
    }
    const remain = order.qty - order.filled;
    this.book.cancel(order.id);
    // 释放剩余冻结
    if (order.frozen > 0) {
      account.cash = r2(account.cash + order.frozen);
      account.orderFrozen = r2(account.orderFrozen - order.frozen);
      order.frozen = 0;
    }
    // 释放仓位预留
    if (remain > 0) {
      if (order.action === ACTIONS.SELL_CLOSE) account.releaseLong(order.stockId, remain);
      if (order.action === ACTIONS.BUY_CLOSE) account.releaseShort(order.stockId, remain);
      // 开空撤单：归还占用的券源
      if (order.action === ACTIONS.SELL_OPEN && !config.margin.allowNakedShort) {
        this.lendReserved = Math.max(0, this.lendReserved - remain);
      }
    }
    order.status = 'canceled';
    account.orders.delete(order.id);
    this.notifyChange(account, order);
    // release 按「最早已占的批次」退，而这张单当初是按「最早未占的批次」占的——
    // 交错时退不干净，按在途委托重摊一次把差额补齐
    this.syncReserved(account, order.stockId, now);
    return { ok: true, order };
  }

  /**
   * 爆仓检查（权益 < 维持保证金 × 敞口 时强平）：
   * - 空头端：先视需要卖出多头补充现金，再逐笔买入平空（吃对手盘，不足则系统兜底价）
   * - 融资多头端：强卖多头偿还负债。卖出只是把市值换成现金、不抬权益，
   *   目的是缩敞口止损——持仓缩小后维持线下移，直到权益重新达标或负债清零。
   *   全款多头（负债=0）不触发：权益 ≥ 多头市值 ≥ 维持线，永远不会被强卖。
   */
  maybeLiquidate(account, now) {
    if (!account || account === SYSTEM_ACCOUNT) return false;
    if (account._liquidating) return false;
    // 集合竞价与休市不做风控强平：竞价簿里买卖价允许交叉，强平单按它撮合会被交叉价拉飞；
    // 休市则压根没有对手盘。等进入连续竞价再处置，账户权益口径不变
    if (!this.continuousNow(now)) return false;
    // 阶段切换那一 tick 里 phase 已经翻到下一段，continuousNow() 会误判成"已进入连续竞价"，
    // 此时竞价撮合正在跑（runAuction 中），强平单会被交叉盘口拉飞，故全程冻结
    if (this._auctionRunning) return false;
    const bk = this.brokerFor(account, now);
    const feeRate = bk.feeRate;
    const m = bk.maintenance;
    // 强平触发线 = 维持线 − 缓冲。「预警 + 缓一档」：刚跌破维持线时只预警（见
    // serializeAccount 的 marginCall），再低 5 个百分点才真强平，中间那段是留给
    // 玩家补保证金/等反弹的窗口。天疯的「零缓冲强平」就是把这一档拿掉——破线即全平。
    // 缓冲为 0 时触发线 = 维持线，与引入券商之前的判据逐位一致
    const mTrig = m - (bk.liquidationBuffer || 0);
    const last = this.lastPrice;
    // 组合口径：权益含账户全部持仓（各股按各股最新价），敞口也按账户总空头/总融资多头计。
    // 多股票下若只看本股，一只股票的亏损不会惊动另一只的持仓，穿仓可以藏在没被扫到的股票里。
    const eq = this.equityOf(account);
    const priceOf = (sid) => this._price(sid);
    const shortMV = account.totalShortMV(priceOf);
    const longMV = account.totalLongValue(priceOf);
    const debt = account.totalFinanceDebt();
    // 本股没有对应敞口就不由本市场处置（交给持有该敞口的市场去强平）
    const myShort = account.shortQty(this.stockId);
    const myLong = account.longQty(this.stockId);
    const shortTriggered = shortMV > 0 && myShort > 0 && eq < mTrig * shortMV;
    const longTriggered = debt > 0 && longMV > 0 && myLong > 0 && eq < mTrig * longMV;
    if (!shortTriggered && !longTriggered) return false;

    account._liquidating = true;
    const events = [];
    try {
      // 强平会直接扣减多头/空头持仓，先撤掉该账户全部在途委托：
      // 平仓挂单失去持仓依据会变成幽灵挂单；开仓挂单则会被自己的强平单吃到（自成交），
      // 强平既收不回现金，被强卖的多头还会带着新的锁仓时间原样回到账上。
      // 这些委托可能挂在别的股票的簿上，必须按委托自身的 stockId 路由（见 cancelAny）
      for (const o of [...account.orders.values()]) {
        this.cancelAny(account, o.id, now);
      }
      // 空头端：判定与推进都用组合口径（权益 vs 账户总空头市值），
      // 本市场只处置本股的空头与多头；本股清完后剩余敞口交给持有该敞口的市场
      let guard = 0;
      while (shortTriggered && guard++ < 500) {
        const needQty = account.shortQty(this.stockId);
        if (needQty <= 0) break;
        const curEq = this.equityOf(account);
        const totalShort = account.totalShortMV(priceOf);
        if (totalShort <= 0 || curEq >= m * totalShort) break;

        // 覆盖全部空头所需资金估算
        const needCash = r2(needQty * this.lastPrice * (1 + feeRate));
        // 挂借中的券不能强卖；全部挂借时跳过本分支直接走买入平空，
        // 否则 forceSellLong 返回 0 会 break 掉整个强平循环
        const sellableLong = account.forceSellableLong(this.stockId);
        if (account.cash + account.shortMargin < needCash && sellableLong > 0) {
          // 先强卖多头补充现金（若批次带融资负债，回款先还债，现金增量小于卖出款）
          const sold = this.forceSellLong(account, Math.min(sellableLong, needQty), now);
          if (sold <= 0) break;
          events.push({ type: 'force_sell_long', qty: sold });
          continue;
        }
        // 买入平空（能负担多少平多少）
        const budget = account.cash + account.shortMargin;
        const maxQty = Math.floor(budget / (this.lastPrice * (1 + feeRate)));
        const target = Math.min(needQty, Math.max(maxQty, 0));
        if (target <= 0) {
          // 完全没钱：穿仓兜底，允许现金为负，全部强平
          const closed = this.forceCoverShort(account, needQty, now, true);
          events.push({ type: 'force_cover', qty: closed, bankruptcy: true });
          break;
        }
        const closed = this.forceCoverShort(account, target, now, false);
        if (closed <= 0) break;
        events.push({ type: 'force_cover', qty: closed });
      }

      // 融资多头强平：卖到 权益 ≥ 维持率 × 账户总多头市值 或 本股负债清零 或 无可卖
      guard = 0;
      while (guard++ < 500) {
        if (account.financeDebt(this.stockId) <= 0) break;
        const curLongMV = account.longValue(this.stockId, this.lastPrice);
        if (curLongMV <= 0) break;
        const curEq = this.equityOf(account);
        const totalLong = account.totalLongValue(priceOf);
        if (totalLong <= 0 || curEq >= m * totalLong) break;
        // 需卖出市值 = (维持线 - 权益) / (维持率 - 手续费率)：
        // 卖出费用拉低权益、市值缩水同等拉低维持线，两者每元卖出净改善 (m - fee)。
        // 维持线用账户总多头，缺口按本股可卖量分摊消耗
        const xNeed = (m * totalLong - curEq) / (m - feeRate);
        const lot = this.stock.lotSize;
        const sellable = account.forceSellableLong(this.stockId);
        let qtyNeed = Math.ceil((Math.max(0, xNeed) / Math.max(this.lastPrice, 0.01) / lot)) * lot;
        qtyNeed = Math.min(qtyNeed, sellable);
        if (qtyNeed <= 0) qtyNeed = Math.min(lot, sellable); // 数值抖动兜底：至少卖一手
        if (qtyNeed <= 0) break; // 无可卖（全部挂借锁死）
        const sold = this.forceSellLong(account, qtyNeed, now);
        if (sold <= 0) break;
        events.push({ type: 'force_sell_long', qty: sold, reason: 'finance' });
      }
    } finally {
      account._liquidating = false;
    }
    if (events.length) {
      this.journal?.touch(account);
      account.liquidations = account.liquidations || [];
      account.liquidations.unshift({ t: now, events });
      if (account.liquidations.length > 20) account.liquidations.length = 20;
      // 爆仓记录计入券商进度：4★ / 5★ 的「无爆仓记录」这一档就是靠它守门（§9 D7）
      if (account.broker && !account.isNPC) {
        broker.statsOf(account, account.broker).liquidations += 1;
      }
      // 强平落地通知（彩蛋 C02 首次爆仓）：这里只上报，判定与状态全在 game/milestones。
      // market 不认识彩蛋——它只提供一个事件源，且这条通知绝不改变本函数的任何结果。
      // （异常隔离在钩子内部：`Game.onLiquidate` 自己吞异常。这里是撮合链上的一环，
      // 异常穿回去会打断 `execute` 所在的撮合循环、留下撤不掉的幽灵单）
      this.onLiquidate?.(account, now, this.stockId);
    }
    return events.length > 0;
  }

  /**
   * 是否已跌破维持线、但还没到强平触发线 —— 也就是「预警」档（§7 追保通知）。
   * 只读展示：客户端据此显示券商的追加保证金通知（文案随券商风格变），
   * 天疯的缓冲是 0，所以它永远给不出预警，破线就是全平
   */
  marginCallState(account, now = Date.now()) {
    if (!account || account === SYSTEM_ACCOUNT) return null;
    const bk = this.brokerFor(account, now);
    const m = bk.maintenance;
    const mTrig = m - (bk.liquidationBuffer || 0);
    if (mTrig >= m) return null; // 零缓冲：没有预警档
    const eq = this.equityOf(account);
    const shortMV = account.totalShortMV((sid) => this._price(sid));
    const longMV = account.totalLongValue((sid) => this._price(sid));
    const shortWarn = shortMV > 0 && eq < m * shortMV && eq >= mTrig * shortMV;
    const longWarn = account.totalFinanceDebt() > 0 && longMV > 0 && eq < m * longMV && eq >= mTrig * longMV;
    if (!shortWarn && !longWarn) return null;
    const exposure = shortWarn ? shortMV : longMV;
    const need = r2(m * exposure - eq);
    return {
      broker: bk.key,
      name: bk.name,
      maintenance: m,
      trigger: mTrig,
      exposure: r2(exposure),
      need, // 需要补多少权益才能回到维持线上
      // 距离强平触发线还有多少权益空间（跌到 0 就强平）
      left: r2(eq - mTrig * exposure),
      side: shortWarn ? 'short' : 'long',
    };
  }

  /** 强卖多头（吃买盘，不足系统兜底），返回成交股数 */
  forceSellLong(account, qty, now) {
    // 挂借中的券不能强卖：与 place 卖单的挂借闸门同一底线（T+ 锁仓对强平豁免）。
    // 卖出后 longQty ≥ lendOffered 始终成立，池子的券源主张才有持仓背书
    let need = Math.min(qty, account.forceSellableLong(this.stockId));
    let total = 0;
    while (need > 0) {
      const top = this.book.bids[0];
      // 脱离价格笼子的买盘不接（按系统兜底价成交），否则强平会把最新价一步砸穿
      const bid = top && this.inCage(top.price) ? top : null;
      let price;
      let take = need;
      if (bid) {
        const remain = bid.qty - bid.filled;
        if (remain <= 0) {
          this.book.remove(bid);
          continue;
        }
        if (!this.isSettleable(bid, Math.min(need, remain))) {
          this.dropStaleOrder(bid, now);
          continue;
        }
        price = bid.price;
        take = Math.min(need, remain);
      } else {
        // 恐慌深时 fbPanicSlip>1，系统兜底滑点加大 → 强平踩踏自我强化（feedback 层）
        const slip = config.margin.liquidationSlippage * (this.fbPanicSlip || 1);
        price = this.clampPrice(this.lastPrice * (1 - slip));
      }
      const order = this.makeForceOrder(account, ACTIONS.SELL_CLOSE, price, take);
      this.execute(order, bid || this.makeGhost(order), price, take, now, 'sell');
      need -= take;
      total += take;
      if (account.forceSellableLong(this.stockId) <= 0) break;
      if (!bid && this.book.bids.length === 0) break;
    }
    return total;
  }

  /** 强平买入平空（吃卖盘，不足系统兜底价） */
  forceCoverShort(account, qty, now, allowDebt) {
    let need = Math.min(qty, account.shortQty(this.stockId));
    let total = 0;
    let guard = 0;
    while (need > 0 && guard++ < 200) {
      const top = this.book.asks[0];
      // 脱离价格笼子的卖盘不接（按系统兜底价成交），否则强平会把最新价一步拉飞
      const ask = top && this.inCage(top.price) ? top : null;
      let price;
      let take;
      if (ask) {
        const remain = ask.qty - ask.filled;
        if (remain <= 0) {
          this.book.remove(ask);
          continue;
        }
        price = ask.price;
        const afford = allowDebt
          ? need
          : Math.min(need, Math.floor((account.cash + account.shortMargin) / (price * (1 + this.brokerFor(account, now).feeRate))));
        if (afford <= 0) break;
        take = Math.min(afford, remain);
        if (!this.isSettleable(ask, take)) {
          this.dropStaleOrder(ask, now);
          continue;
        }
      } else {
        // 强平买入平空的兜底滑点（向上）；恐慌时主要放大卖侧，买侧保持基准
        price = this.clampPrice(this.lastPrice * (1 + config.margin.liquidationSlippage));
        if (!allowDebt) {
          const afford = Math.floor((account.cash + account.shortMargin) / (price * (1 + this.brokerFor(account, now).feeRate)));
          if (afford <= 0) break;
          take = Math.min(need, afford);
        } else {
          take = need;
        }
      }
      const order = this.makeForceOrder(account, ACTIONS.BUY_CLOSE, price, take);
      this.execute(order, ask || this.makeGhost(order), price, take, now, 'buy');
      need -= take;
      total += take;
      if (account.shortQty(this.stockId) <= 0) break;
      if (!ask && this.book.asks.length === 0 && !allowDebt) break;
    }
    return total;
  }

  /** 强平用的临时订单（不入簿） */
  makeForceOrder(account, action, price, qty) {
    const bk = this.brokerFor(account);
    return {
      id: 'F' + Math.random().toString(36).slice(2, 8),
      stockId: this.stock.id,
      ownerId: account.name,
      account,
      action,
      side: BUY_ACTIONS.has(action) ? 'buy' : 'sell',
      price,
      qty,
      filled: 0,
      frozen: 0,
      feeRate: bk.feeRate, // 强平也按账户券商的费率计费
      finRatio: bk.financeRatio,
      marginRatio: bk.marginRatio,
      broker: account.broker || null,
      ts: Date.now(),
      status: 'live',
      force: true,
    };
  }

  /** 对手方虚拟单（系统兜底成交时充当对手） */
  makeGhost(order) {
    return {
      id: 'G' + Math.random().toString(36).slice(2, 8),
      stockId: this.stock.id,
      ownerId: 'SYSTEM',
      account: SYSTEM_ACCOUNT,
      action: order.side === 'buy' ? ACTIONS.SELL_OPEN : ACTIONS.BUY_OPEN,
      side: order.side === 'buy' ? 'sell' : 'buy',
      price: order.price,
      qty: order.qty,
      filled: 0,
      frozen: 0,
      ts: Date.now(),
      status: 'live',
      force: true,
    };
  }

  /**
   * 席位榜 / 龙虎榜（§11.3）：按券商聚合当日净买入排行。
   * 个股当日涨跌超 ±7% 时额外披露「买卖前五席位」（真实龙虎榜就是这么披露的）。
   * 数据只来自 seatFlow，**不参与任何数值计算**
   */
  seatBoard() {
    const cfg = (config.brokers && config.brokers.seat) || {};
    if (!cfg.enabled) return null;
    let total = 0;
    for (const v of this.seatFlow.values()) total += v.buyAmt + v.sellAmt;
    const rows = [];
    for (const b of broker.list()) {
      const v = this.seatFlow.get(b.key);
      if (!v) continue;
      rows.push({
        key: b.key,
        abbr: b.abbr,
        name: b.name,
        buyAmt: r2(v.buyAmt),
        sellAmt: r2(v.sellAmt),
        net: r2(v.buyAmt - v.sellAmt),
        pct: total > 0 ? Math.round(((v.buyAmt + v.sellAmt) / total) * 100) : 0,
      });
    }
    rows.sort((a, b) => b.net - a.net || (a.key < b.key ? -1 : 1));
    rows.forEach((r, i) => {
      r.rank = i + 1;
    });
    const changePct = this.prevClose ? r2(((this.lastPrice - this.prevClose) / this.prevClose) * 100) : 0;
    const surge = total > 0 && Math.abs(changePct) >= (cfg.surgePct || 7);
    const out = {
      rows: rows.slice(0, cfg.leaderboardRows || 6),
      surge,
      changePct,
      total: r2(total),
    };
    if (surge) {
      const top = (field) =>
        [...rows]
          .filter((r) => r[field] > 0)
          .sort((a, b) => b[field] - a[field])
          .slice(0, cfg.topRows || 5)
          .map((r) => ({ key: r.key, abbr: r.abbr, amt: r[field] }));
      out.top = { buy: top('buyAmt'), sell: top('sellAmt') };
    }
    return out;
  }

  /**
   * 五档 + 每档的**挂单券商构成**（§11.3.1）：每档显示占比最高的前 N 家券商图标，
   * 一眼看出这个价位是哪家在堆货。纯展示，不影响撮合。
   */
  depthWithBrokers(levels, topN) {
    const agg = (book) => {
      const out = [];
      const idx = new Map();
      for (const o of book) {
        let row = idx.get(o.price);
        if (row === undefined) {
          // 书是按价格有序的，所以「已收满前 N 档后又见到新价」后面全是更远的档，直接跳过
          if (out.length >= levels) continue;
          row = { price: o.price, qty: 0, by: new Map() };
          idx.set(o.price, row);
          out.push(row);
        }
        const r = o.qty - (o.filled || 0);
        if (r <= 0) continue;
        row.qty += r;
        const key = o.account && o.account.broker ? o.account.broker : null;
        if (key) row.by.set(key, (row.by.get(key) || 0) + r);
      }
      for (const row of out) {
        row.brokers = [...row.by.entries()]
          .map(([key, qty]) => ({ key, qty, pct: row.qty > 0 ? Math.round((qty / row.qty) * 100) : 0 }))
          .sort((a, b) => b.qty - a.qty || (a.key < b.key ? -1 : 1))
          .slice(0, topN);
        delete row.by;
      }
      return out;
    };
    return { bids: agg(this.book.bids), asks: agg(this.book.asks) };
  }

  /** 行情快照（给客户端） */
  snapshot(depthLevels) {
    const levels = depthLevels || config.market.depthLevels;
    const seatCfg = (config.brokers && config.brokers.seat) || {};
    const depth = seatCfg.enabled
      ? this.depthWithBrokers(levels, seatCfg.depthBrokers || 2)
      : this.book.depthAgg(levels);
    const change = r2(this.lastPrice - this.prevClose);
    const changePct = this.prevClose ? r2((change / this.prevClose) * 100) : 0;
    return {
      stockId: this.stock.id,
      name: this.stock.name,
      last: this.lastPrice,
      prevClose: this.prevClose,
      open: this.open,
      high: this.high,
      low: this.low,
      change,
      changePct,
      volume: this.volume,
      turnover: this.turnover,
      // 当日内外盘与资金净流入（外盘额 − 内盘额），客户端盘口与日线图都吃它
      flow: flow.flowSnapshot(this),
      lotSize: this.stock.lotSize,
      floatShares: this.stock.floatShares,
      // 公司资料（公开信息，客户端档案卡 / 行情列表 / 顶栏直接用）：
      // initPrice 是发行价（= 开服开盘价，也是指数基期的分母口径），
      // marketCap 是**实时**流通市值 = 流通股 × 最新价，随行情每帧变
      initPrice: this.stock.initPrice,
      marketCap: this.stock.floatShares * this.lastPrice,
      issueCap: this.stock.floatShares * this.stock.initPrice,
      depth,
      trades: this.trades.slice(0, 30),
      band: this.band(),
      // 集合竞价阶段下发虚拟参考价（最大成交量价），客户端在盘口中显示为「虚拟开盘价」
      auction: this.auctionSnapshot(),
      lending: this.lendingSnapshot(),
      // 席位榜 / 龙虎榜（§11.3）：当日各券商净买入排行
      seats: this.seatBoard(),
    };
  }

  /** 集合竞价快照：虚拟成交价 / 可成交量 / 是否已进入不可撤单窗口；非竞价阶段返回 null */
  auctionSnapshot(now = Date.now()) {
    const kind = this.auctionKind(now);
    if (!kind) return null;
    const q = this.auctionQuote();
    return {
      kind,
      price: q ? q.price : null,
      volume: q ? q.volume : 0,
      locked: this.auctionLocked(now),
    };
  }

  /** 融券池快照（给客户端融券 tab） */
  lendingSnapshot() {
    const cfg = config.margin.lending || {};
    return {
      enabled: !!cfg.enabled,
      total: this.lendTotal,
      borrowed: this.lendBorrowed,
      reserved: this.lendReserved,
      available: this.lendAvailable(),
      utilization: r2(this.lendUtilization() * 100), // 紧张度 %
      dailyRate: r2(this.lendDailyRate() * 10000) / 100, // 日息 %（保留两位小数，0.05 表示 0.05%/日）
      settle: 'daily', // 计息口径：每个游戏日结算一次（收盘日终结算）
      settledDay: this.lendSettledDay, // -1 = 还没结过任何一天
      allowNakedShort: !!config.margin.allowNakedShort,
      // 空头总持仓：**收盘披露口径**，每个游戏日收盘后刷新一次、日内冻结（见
      // publishShortInterest）。还没披露过（新开局第一天 / 从没到过收盘）是 `null`，
      // 前端显示 `—`——既不能退回实时值（泄当日建空动向），也不能填 0（会被读成"零空头"）
      shortInterest: this.pubShortInterest(),
      shortInterestDay: this.shortInterestPubDay, // -1 = 还没披露过（此时 shortInterest 为 null）
      history: this.shortHistory,
    };
  }

  /**
   * 对外可见的空头存量：已披露过就用披露值，**还没披露过返回 `null`（未知）**。
   * 展示层（融券 tab、开放平台 holders）统一走这里，别各读各的字段。
   *
   * 这里**不能**退回实时值：那就是把当天机构偷偷建空的动向直接摊给玩家，
   * 也正是这次改动要去掉的东西（新开局第一个交易日盘中尤其明显——NPC 建初始
   * 空仓的那几十分钟恰好是玩家最爱盯盘的时候）。也不能填 0：0 是"确实没人做空"
   * 的有效值，填 0 会让玩家把"还没披露"读成"零空头"。所以给 `null`，
   * 前端显示 `—`，接口文档也写清楚以 `shortInterestDay` 判断。
   */
  pubShortInterest() {
    return this.shortInterestPubDay < 0 ? null : this.shortInterestPub;
  }
}

// 系统兜底对手账户（只做记账，不参与风控）
const SYSTEM_ACCOUNT = new (require('./store').Account)('SYSTEM', true);
SYSTEM_ACCOUNT.cash = Infinity;

module.exports = { Market, ACTIONS, setTradeSeqBase };
