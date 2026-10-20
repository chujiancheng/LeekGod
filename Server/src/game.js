/**
 * 游戏主循环：NPC/消息推进、风控扫描、分时记录、状态快照、存档
 * 存档器由外部注入（见 index.js）：未注入时纯内存运行，测试脚本即走这条路径。
 */
const crypto = require('crypto');
const v8 = require('v8');
const config = require('./config');
const { logger } = require('./logger');
const { Store, Account, r2 } = require('./store');
const { Market, ACTIONS, setTradeSeqBase } = require('./market');
const { NewsSystem } = require('./news');
const { NpcManager, normalizeNpcType } = require('./npc');
const { AutoManager } = require('./auto');
const { IndexFeed } = require('./indexfeed');
const { DayCycle } = require('./daycycle');
const flow = require('./flow');
const broker = require('./broker');
const milestones = require('./milestones');
const { WhaleManager } = require('./llm/whales');

// 同一账户最多保留的活跃令牌数（多标签页够用，防止 sessions 无界增长）
const MAX_SESSIONS_PER_ACCOUNT = 5;

// 堆内存巡检间隔：3160 NPC 长跑曾 heap OOM，每 5 分钟打一条 used/limit 便于事后对时间线
const HEAP_LOG_EVERY_TICKS = Math.max(1, Math.round(5 * 60 * 1000 / (config.tickIntervalMs || 700)));

// 股东快照：每个账户保留最近若干次自己的操作快照（内存环形缓冲，重启清空）。
// 快照给「较上次操作」的变动列和股东占比走势图提供基线与历史点。
const HOLDER_SNAPSHOT_LIMIT = 30;
// 每份快照记多少名股东：覆盖当前前十并留余量，否则刚被挤出前十的股东算不出变动
const HOLDER_SNAPSHOT_ROWS = 30;

/** JSON 列读回：坏了就当空对象，不让一条脏数据把整局卡死在启动阶段 */
function safeParseJson(text, fallback) {
  if (!text) return fallback;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) {
    logger.warn(`[我是股神] 存档里的 JSON 列无法解析，已按空值处理：${String(text).slice(0, 80)}`);
    return fallback;
  }
}

class Game {
  /**
   * @param {{persist?: import('./persist').Persister|null}} [opts]
   */
  constructor(opts = {}) {
    this.stocks = config.stocks;
    this.stocksById = new Map(this.stocks.map((s) => [s.id, s]));
    this.store = new Store();
    // 交易日时钟（服务端权威）：全市场共用一份。阶段只由「本轮开盘时刻 + 当前时间」
    // 推出，是纯函数，所以重启后只要把开盘时刻恢复回来就能接着走。
    this.startedAt = Date.now();
    this.day = new DayCycle(config.day, this.startedAt);
    this._dayState = null;
    // 最近一次已结算的交易日序号（落 meta），用于续跑时补做停机期间错过的日终结算
    this._daySettled = 0;
    // 做空利息已结算到第几个交易日（落 meta）：做空利息按游戏日结算，重启后不能重复收。
    // **-1 = 还没结过任何一天**。收盘结算时 completedDay 恒 ≥ 1（首次收盘就是第 1 天，
    // 见 settleDay），0 只会出现在第 1 个交易日的盘中且被 ensureDaySettled 的闸门挡掉；
    // 用 -1 而不是 0 当哨兵，是为了让「没结过」与「结过第 0 天」这两种状态不会撞在一起
    this._lendSettled = -1;
    // 每只股票一套完全独立的市场与做市引擎：各自盘口、融券池、做市资金、趋势与情绪。
    // 玩家账户跨这些市场共享现金、持仓按股票分账（Account.longs/shorts 就是 Map<stockId>）。
    this.markets = new Map();
    this.npcs = new Map();
    for (const stock of this.stocks) {
      const market = new Market(stock);
      market.journal = opts.persist || null;
      market.dayCycle = this.day; // 阶段门控、集合竞价、日终结算都靠它
      market.accountsProvider = () => this.store.all();
      // 跨股票取价：风控要按整个账户算权益，就得知道账户在其它股票上的持仓值多少
      market.priceOf = (stockId) => this.marketOf(stockId).lastPrice;
      // 跨股票找市场：强平撤单要把委托交回它所属股票的市场（见 Market.cancelAny）
      market.marketOf = (stockId) => this.markets.get(stockId);
      // 强平落地通知（彩蛋 C02 首次爆仓）：market 只负责上报，判定与状态在 game/milestones
      market.onLiquidate = (acc, now) => this.onLiquidate(acc, now);
      this.markets.set(stock.id, market);
      this.npcs.set(stock.id, new NpcManager(market, null, this.store));
    }
    this.news = new NewsSystem(this.stocks);
    for (const npc of this.npcs.values()) npc.news = this.news;
    // 泄露期的可观测性指标（消息分层 §7.2 MVP 验收口径）：让消息系统能取到价格，
    // 在每条消息公开时算一次「泄露期内的价格漂移」并落日志，证明机制真的在起作用
    this.news.priceOf = (stockId) => (stockId ? this.priceOf(stockId) : this.index.lastPrice);

    this.index = new IndexFeed(this.stocks);
    this.markets.set(this.index.stockId, this.index); // 指数也进 markets：取价、落盘、广播一视同仁
    // 指数与个股共用同一套日线/资金记账（flow.js），所以也要有时钟与落盘句柄：
    // 时钟用来判断「当日数据属于哪一天」，句柄用来把定格的日线写进 daily_bars
    this.index.journal = opts.persist || null;
    this.index.dayCycle = this.day;

    this.auto = new AutoManager(this.markets, this.stocksById, this.store);
    // 大模型主力脑（config.npc.llm.enabled 时才真正调 API；默认关闭）
    this.whales = new WhaleManager(this);
    this.persist = opts.persist || null;
    // 成交序号跨重启接续：把全局计数器抬到存档里最大序号之上，`/open/v1/fills` 的
    // 增量游标才不会在重启后回退（回退会让客户端漏掉重启后的一部分成交）
    if (this.persist) setTradeSeqBase(this.persist.maxTradeSeq());
    this.auto.journal = this.persist;
    this.timer = null;
    this.tickCount = 0;
    this.listeners = new Set(); // SSE 广播回调
    this.lastNews = null;
    this.sessions = new Map(); // 登录令牌 -> 账号名
    this._stats = null; // 排行榜 / 前十大股东缓存，每 tick 刷新一次
    this._holderSnapshots = new Map(); // 账号名 -> 操作时刻的股东快照数组（环形缓冲）
  }

  /** 取某只股票的市场/指数（未知 id 抛错，调用方应先校验） */
  marketOf(stockId) {
    const m = this.markets.get(stockId);
    if (!m) throw new Error(`未知标的: ${stockId}`);
    return m;
  }

  /** 是否是可交易股票（指数不可交易） */
  stockOf(stockId) {
    return this.stocksById.get(stockId) || null;
  }

  /** 取某只标的的最新价（风控、账户权益、序列化都走它） */
  priceOf(stockId) {
    return this.markets.get(stockId).lastPrice;
  }

  /** 账户的组合口径权益（跨全部持仓股票汇总），外部与测试直接用它 */
  equityOf(account) {
    return account.equity((sid) => this.priceOf(sid));
  }

  /** 归一化客户端传来的 stockId：缺省回落到第一只股票，非法值返回 null */
  resolveStockId(raw) {
    if (raw == null || raw === '') return this.stocks[0].id;
    return this.stocksById.has(String(raw)) ? String(raw) : null;
  }

  /**
   * 只读接口（分时等）用的标的解析：除股票外还接受大盘指数，
   * 指数同样有分时序列，客户端要能画它的走势图。
   */
  resolveMarketId(raw) {
    if (raw == null || raw === '') return this.stocks[0].id;
    const id = String(raw);
    return this.markets.has(id) ? id : null;
  }

  start() {
    if (this.timer) return;
    const ids = [...this.markets.keys()];
    const snap = this.persist ? this.persist.loadAll(ids) : null;
    const resumed = !!(snap && snap.resumed);
    if (resumed) {
      this.applySnapshot(snap);
    } else {
      this.startedAt = Date.now();
      this.day.reanchor(this.startedAt);
      const now = this.startedAt;
      for (const stock of this.stocks) {
        const market = this.markets.get(stock.id);
        this.npcs.get(stock.id).init(now);
        market.priceHistory.push({ t: now, price: market.lastPrice, vol: 0 });
      }
      this.index.update(this.markets, now);
      this.persist?.startRound(now);
    }
    // 续跑时补做停机期间错过的日终结算：昨收要滚到停机前最后的价格，
    // 否则涨跌停区间会锚在几天前的收盘价上、所有委托都被判成越界
    if (resumed) this.catchUpDay(Date.now());
    // NPC 首轮报价（续跑时报价单不入存档，靠这一步把双边盘口重新挂上）
    for (const npc of this.npcs.values()) npc.step(Date.now());
    // AI 主力账户：新开局发初始资金；续跑只补内存标记（现金/持仓来自存档）
    this.whales.ensureAccounts({ fresh: !resumed });
    this.refreshStats();
    // 新开局的基线立即落盘：初始持仓、分时起点与行情断点，第一秒内被杀也能续跑
    if (!resumed && this.persist) {
      this.persist.commit({
        now: Date.now(),
        markets: [...this.markets.values()],
        allAccounts: this.store.all(),
      });
    }
    // 主循环兜底：tick 内任何异常（最典型的是落盘 commit 抛错）都不该掀掉整个进程，
    // 记日志后继续跑，下一 tick 的轮转全量扫描会把漏掉的账户补写回去
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        logger.error('[我是股神] 主循环 tick 异常:', e);
      }
    }, config.tickIntervalMs);
  }

  /**
   * 用存档重建内存态：账户/持仓 → 活动委托 → 行情断点 → 分时与逐笔 → 令牌。
   * NPC 账户和持仓来自存档，所以不能走 npc.init()（那是新开局的初始建仓）。
   */
  applySnapshot(snap) {
    this.startedAt = snap.startedAt || Date.now();
    this.day.reanchor(this.startedAt);
    this._daySettled = snap.daySettled || 0;
    // 做空利息已结算到第几个交易日（-1 = 旧档没结过 / 还没结过任何一天）
    this._lendSettled = snap.lendSettled == null || Number.isNaN(Number(snap.lendSettled))
      ? -1
      : Number(snap.lendSettled);

    const byName = new Map();
    for (const row of snap.accounts) {
      const acc = new Account(row.name, !!row.is_npc, row.role);
      // 昵称：老档（版本 5 升级上来）为 NULL，表示"还没开完户"，下次登录时补填（§3.2）
      acc.nick = row.nick || null;
      acc.cash = row.cash;
      acc.orderFrozen = row.order_frozen;
      acc.shortMargin = row.short_margin;
      acc.realizedPnL = row.realized_pnl;
      acc.initialLong = row.initial_long;
      acc.lastOrderAt = row.last_order_at;
      acc.createdAt = row.created_at;
      acc.deposited = row.deposited || 0;
      // 券商：老档（版本 3 升级上来）这些列是 NULL，表示"还没选过"，
      // 该玩家下次登录时补选（§9 D2 登录必须选券商）
      acc.broker = row.broker || null;
      acc.brokerChangedAt = row.broker_changed_at || null;
      acc.brokerSinceDay = row.broker_since_day == null ? null : row.broker_since_day;
      acc.brokerStats = safeParseJson(row.broker_stats, {});
      acc.freeReselectUsed = !!row.free_reselect_used;
      acc.couponUsedDay = row.coupon_used_day == null ? null : row.coupon_used_day;
      acc.freeInterestDay = row.free_interest_day == null ? null : row.free_interest_day;
      // 彩蛋里程碑：NPC 恒为 null（不判不落盘），只有玩家有状态
      acc.milestones = acc.isNPC ? null : milestones.parse(safeParseJson(row.milestones, null));
      this.store.put(acc);
      byName.set(acc.name, acc);
    }

    // 存档里的标的可能已经不在本局配置里（改了 config.stocks 又沿用旧档）。
    // 这类行的价格取不到，留着会让 equity / 风控在 priceOf 上直接抛错、整局起不来，
    // 所以连同行情一起丢弃并记一条日志（换股票列表的正规做法仍是删档开新局）
    let droppedRows = 0;

    // 按股票的融券/融资明细：挂借量、欠息、各类利息累计
    for (const row of snap.ledger || []) {
      const acc = byName.get(row.account);
      if (!acc) continue;
      if (!this.markets.has(row.stock_id)) {
        droppedRows += 1;
        continue;
      }
      acc.ledger.set(row.stock_id, {
        lendOffered: row.lend_offered || 0,
        lendInterestEarned: row.lend_interest_earned || 0,
        lendInterestDebt: row.lend_interest_debt || 0,
        lendInterestPaid: row.lend_interest_paid || 0,
        financeInterestAccrued: row.finance_interest_accrued || 0,
        // 当日已累计、尚未到收盘结算的做空利息：不落盘的话每次重启都会把当天
        // 已经攒下的那部分抹掉（收盘只扣重启之后累计的，等于给空头打折）
        lendInterestAccrued: row.lend_interest_accrued || 0,
      });
    }

    for (const row of snap.lots) {
      const acc = byName.get(row.account);
      if (!acc) continue;
      if (!this.markets.has(row.stock_id)) {
        droppedRows += 1;
        continue;
      }
      const pos = row.side === 'long' ? acc.longPos(row.stock_id) : acc.shortPos(row.stock_id);
      const lot = { qty: row.qty, price: row.price, reserved: row.reserved };
      // 多头批次带锁仓起始时间（T+锁仓依据）与融资负债；空头批次带保证金
      if (row.side === 'long') {
        lot.ts = row.ts;
        lot.debt = row.debt || 0;
        lot.principal = row.principal || 0;
      } else {
        lot.margin = row.margin;
      }
      pos.lots.push(lot);
    }
    // NPC 账户的批次合并成一条：旧档里每个 NPC 可能已经攒了几千条碎片批次，
    // 不先合并的话重启后的头几个 tick 仍要把它们整段重写一遍（见 Account.consolidate）
    for (const acc of this.store.all()) {
      if (!acc.isNPC) continue;
      for (const sid of acc.longs.keys()) acc.consolidate(sid);
      for (const sid of acc.shorts.keys()) acc.consolidate(sid);
    }
    if (droppedRows) {
      logger.warn(
        `[我是股神] 存档里有 ${droppedRows} 条持仓/融券明细属于本局已下线的标的，已忽略` +
          `（改动 config.stocks 后建议删档开新局）`
      );
    }

    // 逐只恢复股票行情断点与分时/逐笔
    for (const stock of this.stocks) {
      const market = this.markets.get(stock.id);
      const mk = snap.markets?.get(stock.id);
      const m = mk && mk.state;
      if (!m) continue; // 本轮新增、存档里没有的股票：保持开盘价，由主循环接着跑
      market.lastPrice = m.last_price;
      market.prevClose = m.prev_close;
      market.open = m.open;
      market.high = m.high;
      market.low = m.low;
      market.volume = m.volume;
      market.turnover = m.turnover;
      market.shortInterest = m.short_interest;
      market.orderSeq = Math.max(market.orderSeq, m.order_seq);
      market.priceHistory = mk.prices.map((p) => ({ t: p.t, price: p.price, vol: p.vol }));
      // 当日内外盘累计（外盘+内盘要等于当日成交量，不恢复就会对不上账）与已收盘的日线
      flow.restoreFlow(market, m, mk.bars);
      market.trades = mk.tape.map((t) => ({
        seq: t.trade_seq,
        t: t.t,
        price: t.price,
        qty: t.qty,
        side: t.side,
        // 买方/卖方席位（§11.3）：主动方那一行的 broker 是主动方，counter_broker 是被动方。
        // 版本 4 之前写下的行没有这两列 → 席位为空，前端留空不显示
        buyBroker: t.side === 'buy' ? t.broker || null : t.counter_broker || null,
        sellBroker: t.side === 'sell' ? t.broker || null : t.counter_broker || null,
      }));
    }

    // 指数断点：点位直接读存档，分时与成分由价格推出
    const idxSnap = snap.markets?.get(this.index.stockId);
    this.index.applyState(idxSnap && idxSnap.state, idxSnap && idxSnap.prices);
    flow.restoreFlow(this.index, idxSnap && idxSnap.state, idxSnap && idxSnap.bars);

    // 彩蛋水位线必须在**行情恢复之后**才能初始化（权益要取到各股价格）。
    // 老档没有 milestones 列（版本 4 及更早）、新号还没结过盘——`peakEquity` 一律取
    // **当时的权益**：取 0 会让老玩家一进来就"回撤 100%"（方案 §4.3）
    for (const acc of this.store.players()) {
      milestones.initPeak(acc.milestones, r2(this.equityOf(acc)));
    }
    this.index.update(this.markets, Date.now());

    // 融券池聚合值从账户挂借量 + shortInterest 重建（挂借量已随 accounts 恢复）
    this.rebuildLendingPool();

    // 停牌是全市场一起停：把状态摊到每只股票（指数跟随，不单独停）
    if (snap.halt && snap.halt.until) {
      for (const stock of this.stocks) {
        const market = this.markets.get(stock.id);
        market.haltUntil = snap.halt.until || 0;
        market.haltReason = snap.halt.reason || '';
      }
    }

    // 活动委托回填订单簿与账户挂单表（账号 id 由 orderSeq 递增，不回退，避免与旧单撞号）
    for (const row of snap.orders) {
      const acc = byName.get(row.account);
      if (!acc) continue;
      const market = this.markets.get(row.stock_id);
      if (!market) continue;
      const order = {
        id: row.id,
        seq: row.seq,
        stockId: row.stock_id,
        ownerId: acc.name,
        account: acc,
        action: row.action,
        side: row.side,
        price: row.price,
        qty: row.qty,
        filled: row.filled,
        frozen: row.frozen,
        ts: row.ts,
        status: 'live',
      };
      acc.orders.set(order.id, order);
      market.book.add(order);
      market.orderSeq = Math.max(market.orderSeq, order.seq);
      // 未成交的开空单在重启前占用了券源，回填时重新计入
      if (order.action === ACTIONS.SELL_OPEN && !config.margin.allowNakedShort) {
        market.lendReserved += order.qty - order.filled;
      }
    }

    for (const row of snap.sessions) {
      if (byName.has(row.account)) this.sessions.set(row.token, row.account);
    }

    // 批次预留与「在途平仓委托量」必须恒等（见 Account.syncReserved）。老档里可能已经错位：
    // 一张平仓单成交时 FIFO 吃掉了别的委托占着的批次，那份预留就永久留在账上——
    // 界面上是「持仓还在、可平/可卖却是 0」，而委托表里没有任何在途单可以撤，玩家被锁死。
    // 在途委托恢复完之后按委托重摊一遍，这类残留在启动时就地修掉
    const restoreNow = Date.now();
    for (const acc of this.store.all()) {
      if (!acc.longs.size && !acc.shorts.size) continue;
      const lockMs = this.brokerOf(acc, restoreNow).lockMs;
      for (const sid of new Set([...acc.longs.keys(), ...acc.shorts.keys()])) {
        acc.syncReserved(sid, lockMs, restoreNow);
      }
    }

    // 重建 NPC 报价对象：持仓/现金已在上面恢复，这里只补 manager 的运行期字段。
    // 每个 NPC 账户属于唯一一只股票（账户名带股票简称前缀），按前缀分派回各自的 manager
    const typeKeys = Object.keys(config.npc.types);
    for (const stock of this.stocks) {
      const npc = this.npcs.get(stock.id);
      const market = this.markets.get(stock.id);
      const prefix = `${stock.alias}·`;
      const rows = snap.accounts
        .filter((r) => r.is_npc && typeKeys.includes(normalizeNpcType(r.role)) && r.name.startsWith(prefix))
        .map((r) => ({ ...r, role: normalizeNpcType(r.role) }))
        .sort((a, b) =>
          a.role === b.role
            ? a.name.length - b.name.length || a.name.localeCompare(b.name)
            : a.role.localeCompare(b.role)
        );
      const capScale =
        (stock.floatShares * stock.initPrice) / config.npc.refMarketCap;
      let instIdx = 0;
      for (const row of rows) {
        const typeKey = row.role;
        const t = config.npc.types[typeKey];
        npc.npcs.push({
          acc: byName.get(row.name),
          type: typeKey,
          profile: t,
          initialLong: row.initial_long,
          initialCash: t ? (t.totalCash / t.count) * capScale : 0,
          camp: t && t.useCamp ? (instIdx++ % 2 === 0 ? 1 : -1) : 0,
          ownBias: 0,
          ownResting: [],
          requoteIn: 0,
        });
      }
      npc.tickCount = 0;
      // 券商归属（席位数据源）与消息情报等级都是**由账户名确定性派生**的派生标签，
      // 不落盘，所以恢复时按同一套账户名重算一遍即可（§11.4.1）
      npc.applyTags();
      // 公允价值/重心/趋势阶段/情绪结构不落盘（随机游走的中间量），重新锚到现价。
      // 周期层同样不落盘：fund 锚到 lastPrice 时已经隐含了过往周期的累计涨幅
      //（价格本身就是周期走出来的结果），所以 cycleLog 无需恢复——保险丝极弱（2e-5），
      // 不会把重启后的价格拉回发行价；方向/推力下个 tick 由 updateCycle 重新抽
      npc.fairValue = market.lastPrice;
      npc.fund = market.lastPrice;
      npc.regime = 0;
      npc.regimeIn = 0;
      npc.trendDrift = 0;
      npc.cycleDir = 0;
      npc.cycleDrift = 0;
      npc.cycleLeft = 0;
      // 周期成分从现价接续：过往周期走出的涨幅已经体现在现价里，把它记成
      // cycleLog 的起点，重启不会把价格往发行价拉回去（纹理从 0 开始重新积累）
      npc.cycleLog = Math.log(market.lastPrice / stock.initPrice);
      npc._cycInit = false;
      // 反馈层（恐慌/贪婪）同样不落盘：重启后从平静重新观察，峰值锚到现价
      npc.mood = 0;
      npc.peakPx = market.lastPrice;
      npc._grind = false;
      npc._fbMul = { aggro: 1, qty: 1, spread: 1 };
      npc.instMood = 0;
      npc.polar = 0.2;
      npc.polarTarget = 0.2;
      npc.polarIn = 0;
    }

    // 玩家委托/成交记录从存档回填（活动委托用内存对象，保证状态随成交实时变化）
    for (const acc of this.store.players()) {
      acc.orderHistory = this.persist.orderHistory(acc);
      acc.tradeHistory = this.persist.tradeHistory(acc);
    }

    // 自动交易策略恢复（依赖 store 里的账户已就位）
    this.auto.restore(snap.auto);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = Date.now();
    this.tickCount += 1;

    // ---- 交易日时钟：定位当前阶段，并在阶段切换时做该做的事 ----
    // 阶段由「本轮开盘时刻 + 当前时间」纯函数推出，没有内部状态，重启后自动接上
    const dayState = this.day.ok ? this.day.locate(now) : null;
    const prevDay = this._dayState;
    if (
      dayState &&
      (!prevDay || prevDay.day !== dayState.day || prevDay.phase.key !== dayState.phase.key)
    ) {
      this.onPhaseChange(prevDay, dayState, now);
    }
    this._dayState = dayState;
    // 结算兜底：tick 跨过收盘竞价时（休眠唤醒、长 GC）onPhaseChange 看到的 prev
    // 不是 closeAuction，会漏结；这里每帧用「已收盘日」判据补一次
    this.ensureDaySettled(now);
    // 休市（午休 / 夜间）：不接受下单、不撮合、不报价，但公允价值继续迁移
    const closed = !!(dayState && !dayState.phase.trading);
    // 分时定格段：休市或集合竞价（价格冻结，走势图不该往前走）。
    // 没有交易日时钟（day 未启用）时恒为 false，退化为逐 tick 打点的旧行为
    const frozenPhase = !!(dayState && (!dayState.phase.trading || dayState.phase.auction));

    // 停牌是全市场一起停（运营开关），以第一只股票的状态为准摊到全部股票
    const primary = this.markets.get(this.stocks[0].id);
    if (primary.expireHalt(now)) {
      for (const stock of this.stocks) {
        const m = this.markets.get(stock.id);
        if (m !== primary && m.haltUntil) m.resume(now);
      }
      logger.info('[我是股神] 停牌到期，已自动复牌');
    }
    const halted = primary.isHalted(now);
    // 可交易 = 未停牌 且 不在休市阶段。集合竞价算可交易（只是不连续撮合）
    const active = !halted && !closed;

    // 日内节奏：把当前阶段与段内进度下发给每只股票的做市引擎——NPC 据它调制
    // 主动吃单率 / 单笔量 / 重报价频率 / 点差（U 型），并在开盘竞价锁单前从
    // 「试探档」收敛回常规报价缓冲。时钟缺失（day 未启用）时下发 null，退化为旧行为
    const session = dayState
      ? {
          key: dayState.phase.key,
          pct: dayState.phase.ms ? dayState.elapsedMs / dayState.phase.ms : 0,
          auction: dayState.phase.auction || null,
          converging: !!(
            dayState.phase.auction &&
            dayState.phase.cancelLockMs &&
            dayState.leftMs <=
              dayState.phase.cancelLockMs + (config.npc.auctionConvergeMs || 0)
          ),
        }
      : null;
    for (const npc of this.npcs.values()) npc.setSession(session);

    if (!halted) {
      // 消息方向偏置取全市场平均阶段：10 只股票各自的牛熊互相对冲，
      // 大盘消息（全体 scope）代表的是「整个市场」的方向，用均值最合理。
      // **休市也照发**：盘后公告正是隔夜跳空的燃料，停掉它"天"就没有夜了。
      // 产出节奏与 scope 分布按阶段走（config.news.phaseRules）：盘前/盘后密集、
      // 午休保底一条、收盘竞价不发；盘后个股消息改走公告文案池。
      // 消息方向偏置（2026-10-18 周期层第二步）：
      // - **大盘消息**（全体 scope）取全市场均值：十只股票各自的牛熊互相抵消，
      //   均值才是「整个市场」的方向；分钟级 regime + 周月级 cycleDir 两层叠加。
      // - **个股消息**用该股自己的 cycleDir/regime（stockBias），牛股出利好、
      //   熊股出利空，故事才跟得上那只股票的走势；只用市场均值会把个股故事抹平。
      let bias = 0;
      const stockBias = new Map();
      for (const npc of this.npcs.values()) {
        const b =
          npc.regime * config.news.regimeBias + npc.cycleDir * config.news.cycleBias;
        const clamped = Math.max(-0.35, Math.min(0.35, b));
        stockBias.set(npc.stock.id, clamped);
        bias += clamped;
      }
      bias /= this.npcs.size;
      const phaseKey = dayState ? dayState.phase.key : null;
      // 盘后消息把作用期抬到**次日开盘竞价结束**：60s 墙钟会在夜间（40s）结束前
      // 就让消息过期，隔夜公允价值迁移与次日竞价的情绪就全吃不到它了。
      // 夜间是当天最后一段，dayEndsAt 即次日开盘竞价的起点。
      let untilFloor = 0;
      if (phaseKey === 'night') {
        const openAuction = this.day.phases.find((p) => p.auction === 'open');
        if (openAuction) untilFloor = dayState.dayEndsAt + openAuction.ms;
      }
      const news = this.news.maybeEmit(now, bias, { phaseKey, untilFloor, stockBias });
      if (news) this.lastNews = news;
    }
    // 泄露期漂移的可观测性：进入泄露期时记价格、公开时算一次漂移并落日志（不落盘）。
    // 这是「消息公开前 N 秒价格已开始漂移」唯一不靠感觉的验证口径
    this.news.noteLeakDrift(now);

    const allAccounts = this.store.all();

    // 逐只股票推进：做市报价、风控扫描、融券/融资利息都按股票各自结算。
    // 停牌时整段冻结（价格若继续走，玩家看到的停牌倒计时就成了假的）
    for (const stock of this.stocks) {
      const market = this.markets.get(stock.id);
      if (!halted) {
        if (active) {
          this.npcs.get(stock.id).step(now);
          // 全账户风控扫描（成交触发之外的兜底）。只扫持有本股敞口的账户：
          // 10 只股票 × 3160 个 NPC 账户全扫一遍是几万次无效检查
          for (const acc of allAccounts) {
            if (!acc.longs.has(stock.id) && !acc.shorts.has(stock.id)) continue;
            market.maybeLiquidate(acc, now);
          }
        } else {
          // 休市：只推进定价锚（趋势 + 消息 + 向重心回归），不报价不撮合。
          // 次日开盘竞价的跳空就是这么攒出来的
          this.npcs.get(stock.id).stepFairValue(now);
        }
        // 融资利息：摊入批次负债并计入已实现盈亏，现金越紧利率越高。
        market.accrueFinanceInterest(now);
        // 做空利息：逐 tick 按「空头市值 × 日利率 × tick/一天」**累计**（不动现金），
        // 收盘日终结算时一次性实扣（见 settleDay）。每天一结，但基数按持仓时长积分——
        // 收盘前平空不再能免掉一整天的息（见 Market.accrueLendingInterest）
        market.accrueLendingInterest(now);
        // 做空欠息追缴：现金/保证金一恢复就补缴给出借方（不能等下一个收盘）
        market.collectLendingDebt();
      }
      // 空头仓位 5 分钟采样（停牌也记，走势图不断点）
      market.sampleShortInterest(now);
      // 东风人气热度推进（只影响散户 NPC 的跟风强度；无东风客户时恒为 0）
      market.updateDongfengHeat(now);

      // 分时序列（每 tick 一个点，vol 为累计成交量供客户端算柱）；停牌补平线，走势图不断点
      // 冻结段（集合竞价 / 午休 / 夜间）**不逐 tick 打点**：价格一动不动，逐 tick 补平点会把
      // 分时序列拉成一条往右爬的水平直线——客户端的定格锚点只救得了实时帧，救不了
      // /api/history 里的整段平线（刷新页面 / 切股票后就现出原形）。改为整段只打一个
      // 阶段起点锚点：线停在那里不走，恢复连续竞价后才继续生长（与客户端定格同口径，
      // 见 Client/app.js「分时定格」段）。收盘竞价集中撮合后的收盘价由夜间锚点带走，不丢。
      const h = market.priceHistory;
      if (frozenPhase) {
        const lastPt = h[h.length - 1];
        if (!lastPt || lastPt.t < dayState.phaseStartAt) {
          h.push({ t: dayState.phaseStartAt, price: market.lastPrice, vol: market.volume });
        }
      } else {
        h.push({ t: now, price: market.lastPrice, vol: market.volume });
      }
      // 保留最近 N 个点：push 在尾部，截断必须从头丢，h.length=N 会把最新点砍掉导致分时冻住
      if (h.length > config.market.priceHistorySize) {
        h.splice(0, h.length - config.market.priceHistorySize);
      }
    }

    // 玩家自动化策略（按策略所属股票逐个判断停牌与休市）
    if (active) this.auto.step(now);

    // 大盘指数：用各股最新价合成点位并记分时（冻结段与个股同口径：只补阶段起点锚点）
    if (frozenPhase) {
      const v = this.index.recompute(this.markets);
      const ih = this.index.priceHistory;
      const lastPt = ih[ih.length - 1];
      if (!lastPt || lastPt.t < dayState.phaseStartAt) {
        ih.push({ t: dayState.phaseStartAt, price: v, vol: 0 });
        if (ih.length > config.market.priceHistorySize) {
          ih.splice(0, ih.length - config.market.priceHistorySize);
        }
      }
    } else {
      this.index.update(this.markets, now);
    }

    // 排行榜/股东按 tick 算一次，避免每个 SSE 连接各算一遍
    this.refreshStats();
    this.broadcast();

    // 本 tick 的全部变更（账户、委托、成交、行情）在一个事务里落盘。
    // markets 含 10 只股票 + 指数，接口同构所以一起写
    this.persist?.commit({ now, markets: [...this.markets.values()], allAccounts });

    if (this.tickCount % HEAP_LOG_EVERY_TICKS === 0) {
      const hs = v8.getHeapStatistics();
      const usedMb = (hs.used_heap_size / 1048576).toFixed(0);
      const limitMb = (hs.heap_size_limit / 1048576).toFixed(0);
      logger.info(`[我是股神] 堆内存 used=${usedMb}MB / limit=${limitMb}MB（accounts=${allAccounts.length}）`);
    }
  }

  // ---------- 交易日（见 src/daycycle.js） ----------

  /**
   * 阶段切换：集合竞价结束 → 按最大成交量原则集中撮合（开盘与收盘各一次）。
   * 日终结算不放在这里——放这里的话 tick 跨过 closeAuction 时会漏结，
   * 统一交给 ensureDaySettled（见 tick）。
   */
  onPhaseChange(prev, next, now) {
    if (!prev) {
      logger.info(`[我是股神] 交易时钟就位：第 ${next.day} 个交易日 · ${next.phase.label}`);
      return;
    }
    // 大模型主力脑：开盘/收盘竞价起各决策一次（异步，不阻塞本帧撮合）
    try {
      this.whales.onPhase(next, now);
    } catch (e) {
      logger.error('[LLM] onPhase 钩子异常:', e);
    }
    if (prev.phase.auction) {
      const kind = prev.phase.auction === 'open' ? '开盘' : '收盘';
      let traded = 0;
      for (const stock of this.stocks) {
        const m = this.markets.get(stock.id);
        const r = m.runAuction(now);
        if (r.price == null) continue;
        traded += 1;
        const gap = m.prevClose > 0 ? ((r.price - m.prevClose) / m.prevClose) * 100 : 0;
        logger.info(
          `[我是股神] ${stock.name} ${kind}集合竞价成交价 ${r.price}，` +
            `成交量 ${r.qty} 股，对昨收 ${m.prevClose} 跳空 ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}%`
        );
      }
      if (!traded) logger.info(`[我是股神] ${kind}集合竞价无成交（盘口未交叉）`);
    }
    if (next.phase.key === 'auction') {
      logger.info(
        `[我是股神] 第 ${next.day} 个交易日开盘集合竞价开始（涨跌停 ±${config.priceLimit.enabled ? config.priceLimit.pct * 100 : 0}%）`
      );
    }
  }

  /**
   * 日终结算：每只标的（含指数）当日定格成一根日线，收盘价定格为新昨收，
   * 今开/最高/最低/成交量额归零，活动委托全部作废；同日一并结算做空利息。
   * `_daySettled` 记的是**哪一天的收盘已经滚进昨收**：
   * 夜间结算时是今天；次日盘中补结时是昨天（今天还没收盘，不能记成今天，
   * 否则今晚的日终结算会被跳过）。
   *
   * `completedDay` = 刚刚收盘的那个交易日的序号。**收盘时它恒 ≥ 1**（第 1 个交易日
   * 收盘就是 1，不是 0）：夜间段 `locate().day` 已经是当天，白天段才是「今天 − 1」。
   * `st` 为空（时钟未启用）时落成 0，此时既不记日线也不判彩蛋。
   */
  settleDay(now = Date.now(), opts = {}) {
    const st = this.day.ok ? this.day.locate(now) : null;
    const completedDay = st ? (st.phase.key === 'night' ? st.day : st.day - 1) : 0;
    // 指数的量额与内外盘是**成分股合计**，必须在成分股被清零之前重算一遍：
    // 否则指数那根日线的量额会落成 0，收盘竞价那批成交更会整个丢掉
    this.index.recompute(this.markets);
    let lendSettled = 0;
    let lendCharged = 0;
    for (const stock of this.stocks) {
      const m = this.markets.get(stock.id);
      // 把「已收到哪一天」推给市场：重启后的补结算、收盘与夜间两次 settleDay
      // 都靠这个水位线去重，同一天的息只会收一次。**不能夹 0**——-1 是「还没结过」的
      // 唯一哨兵，`|| 0` 会让哨兵退化成「结过第 0 天」
      m.lendSettledDay = this._lendSettled == null
        ? m.lendSettledDay
        : Math.max(m.lendSettledDay ?? -1, this._lendSettled);
      // 返回值是「已结算的交易日号」，-1 才是没结（同一天已收过 / 裸空模式 / 融券未开）。
      // 用 `!== -1` 判断而不是真假值——0 也是合法交易日号
      if (m.settleLendingInterest(now, { day: completedDay }) !== -1) {
        lendSettled += 1;
        if (m.lastLendCharge > 0) lendCharged += 1;
      }
      // 做空欠息追缴：日结算收完立刻再补缴一轮（现金/保证金这一刻刚回到账上的账户当场销账）
      m.collectLendingDebt();
    }
    if (lendSettled > 0) {
      // 落 meta：重启后补结算不能把同一天再收一遍（收盘与夜间两段都会走去重判据）
      this._lendSettled = completedDay;
      if (opts.meta) this.persist?.setMeta('lend_settled', String(completedDay));
      logger.info(
        `[我是股神] 第 ${completedDay} 个交易日做空利息已结算（${lendCharged}/${lendSettled} 只标的实际扣息）`
      );
    }
    let canceled = 0;
    for (const stock of this.stocks) {
      canceled += this.markets
        .get(stock.id)
        .settleDay(now, { cancelOrders: opts.cancelOrders, day: completedDay }).canceled;
    }
    this.index.settleDay(now, { day: completedDay });
    // 彩蛋硬门槛一律挂在**收盘结算**上（方案 §2.1）：一天一个数、顺序确定、重启可复现。
    // 走 settleDay 而不是 onPhaseChange，是为了让 tick 跨过收盘竞价的兜底路径
    // （ensureDaySettled）也能判一次——只挂定时路径会漏
    if (completedDay >= 1) {
      this.evaluateMilestones(now, completedDay);
      this._daySettled = completedDay;
    }
    if (opts.meta) this.persist?.setMeta('day_settled', String(this._daySettled));
    logger.info(
      `[我是股神] 第 ${this._daySettled || (st ? st.day : '?')} 个交易日收盘结算：当日已定格成一根日线，` +
        `昨收已滚动到各股收盘价，${canceled} 笔未成交委托当日作废`
    );
  }

  /**
   * 确保所有「已经收盘」的交易日都结算过。两个调用点：
   * ① `start()` 续跑补结算；② `tick()` 每帧兜底。
   *
   * 「已收盘」= 当前若在夜间则是今天，否则是昨天。**不能**用 `st.day > _daySettled`
   * 当判据——那样 day2 上午（昨天已结、今天还没收盘）会被误结，昨收滚成盘中价、
   * 当日量额被清零。也不补的话，tick 跨过 closeAuction（休眠唤醒）会永远漏结。
   *
   * 补结算只滚昨收与当日高低量额，**默认不动委托**——除了夜间（那时委托本就该全部作废），
   * 免得把玩家新一天刚挂的单清掉。落在夜间时先补一次收盘集中撮合，
   * 否则崩溃在收盘竞价里的那批委托会被「当日作废」整批吞掉。
   */
  ensureDaySettled(now = Date.now()) {
    if (!this.day.ok) return;
    const st = this.day.locate(now);
    const completedDay = st.phase.key === 'night' ? st.day : st.day - 1;
    const settledBefore = this._daySettled || 0;
    if (completedDay <= settledBefore) return;
    if (st.phase.key === 'night') {
      for (const stock of this.stocks) {
        const r = this.markets.get(stock.id).runAuction(now);
        if (r.price != null) {
          logger.info(
            `[我是股神] ${stock.name} 补做收盘集合竞价成交价 ${r.price}，成交量 ${r.qty} 股`
          );
        }
      }
    }
    const cancelOrders = st.phase.key === 'night';
    this.settleDay(now, { meta: true, cancelOrders });
    logger.info(
      `[我是股神] 补做日终结算（已收盘 ${completedDay - settledBefore} 个交易日未结，` +
        `当前第 ${st.day} 天 · ${st.phase.label}${cancelOrders ? '，委托已按当日作废' : ''}）`
    );
  }

  /** 语义同 ensureDaySettled（续跑入口保留旧名） */
  catchUpDay(now = Date.now()) {
    this.ensureDaySettled(now);
  }

  // ---------- 彩蛋（里程碑，见 Doc/彩蛋玩法方案.md） ----------

  /**
   * 风险度（%）=（空头市值 + 融资负债 + 做空欠息）/ 权益 × 100。
   *
   * **单一落点**：`serializeAccount` 下发给客户端的 `marginUsage` 与彩蛋 C00/C01 的
   * 判定读的是同一个函数。两边各算一遍必然差几分，然后玩家会追问"我明明 95% 了为什么没弹"。
   * 判定用 `equity` 也由调用方传入（就是 `stateFor` 下发的那个数，见 `equityOf`）。
   */
  marginUsageOf(acc, equity = this.equityOf(acc)) {
    const shortValue = r2(acc.totalShortMV((sid) => this.priceOf(sid)));
    const riskDebt = r2(acc.totalFinanceDebt() + acc.totalLendInterestDebt());
    return milestones.marginUsageOf(r2(equity), shortValue, riskDebt);
  }

  /**
   * 收盘彩蛋评估：只遍历**玩家**账户（NPC 那 3160 个一个都不扫，逐 tick 标脏是项目禁忌）。
   * 判定内核只读账户快照，不回写任何交易状态——彩蛋挂了也不能影响一次撮合。
   * @param {number} day 刚收盘的那个交易日号
   */
  evaluateMilestones(now, day) {
    if (!config.milestones || !config.milestones.enabled) return 0;
    let fired = 0;
    for (const acc of this.store.players()) {
      if (!acc.milestones) continue;
      // 权益与 stateFor 同函数同取整：`equityOf` + r2，与 serializeAccount 的 equity 逐位相等
      const equity = r2(this.equityOf(acc));
      const events = milestones.evaluateClose(acc.milestones, {
        equity,
        marginUsage: this.marginUsageOf(acc, equity),
        day,
        now,
      });
      // **无论有没有发事件都要标脏**：评估本身会原地更新 `peakEquity` / `maxDrawdown` /
      // `dayEvaluated` / `liqDay`，不落盘的话重启后水位线会退回旧值（真实峰值被后来的
      // 收盘价重新锚低，B2 族从此漏判）。只遍历玩家，NPC 一个都不碰
      this.persist?.touch(acc);
      if (!events.length) continue;
      fired += events.length;
      for (const ev of events) {
        logger.info(
          `[我是股神] 彩蛋 ${acc.name} 触发 ${ev.id}「${ev.title}」` +
            `（第 ${day} 个交易日收盘，权益 ¥${Math.round(equity)}，${ev.rarity}）`
        );
      }
    }
    return fired;
  }

  /**
   * 强平落地（C 族 C02「天台初体验」）：由 `Market.maybeLiquidate` 通过 `onLiquidate`
   * 钩子上报。这条是事件驱动的，不走收盘判定——爆仓可能发生在一天里的任何时刻。
   */
  onLiquidate(acc, now = Date.now()) {
    if (!config.milestones || !config.milestones.enabled) return;
    if (!acc || acc.isNPC || !acc.milestones) return;
    try {
      const equity = r2(this.equityOf(acc));
      const events = milestones.onLiquidation(acc.milestones, {
        equity,
        day: this.dayNumber(now),
        now,
      });
      if (!events.length) return;
      this.persist?.touch(acc);
      for (const ev of events) {
        logger.info(`[我是股神] 彩蛋 ${acc.name} 触发 ${ev.id}「${ev.title}」（强制平仓落地）`);
      }
    } catch (e) {
      // 彩蛋是观测层：它挂了也绝不能让异常穿回撮合路径——钩子的调用链是
      // `execute` → `maybeLiquidate`（market.js），而 execute 跑在撮合循环里，
      // 异常断在循环中间会留下撤不掉的幽灵单。这里吞掉并记一条账，交易照常
      logger.error(`[我是股神] 强平彩蛋上报异常（已忽略，不影响撮合）：${(e && e.message) || e}`);
    }
  }

  /** 刷新排行榜与各股票的前十大股东缓存 */
  refreshStats() {
    const topHolders = new Map();
    for (const stock of this.stocks) topHolders.set(stock.id, this.computeTopHolders(stock.id));
    this._stats = {
      players: this.leaderboard(),
      topHolders,
    };
  }

  onTick(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  broadcast() {
    if (this.listeners.size === 0) return;
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (e) {
        // 单个连接异常不影响主循环
      }
    }
  }

  // ---------- 玩家操作 ----------

  newToken() {
    return crypto.randomBytes(24).toString('hex');
  }

  /** 当前交易日号（没有挂交易日时钟时返回 0）。券商的星级/转户/免息券都按交易日算 */
  dayNumber(now = Date.now()) {
    if (!this.day || !this.day.ok) return 0;
    return this.day.locate(now).day;
  }

  /** 某账户此刻的有效券商参数——market/npc/auto/game 的统一读取入口（见 broker.js） */
  brokerOf(acc, now = Date.now()) {
    return broker.forAccount(acc, { day: this.dayNumber(now) });
  }

  /**
   * 泄露期的「异动提示」（消息分层 §7.2 公平窗口）。
   *
   * 给公众一条**模糊**提示：不点方向、不点原因、不说是谁。它存在的意义是让「偷偷买进」
   * 不沦为纯黑箱——普通玩家至少知道这只股票有事，可以选择跟不上但别踩进去。
   * `config.news.irregularHint=false` 时整体关闭（保留"读盘口才是真本事"的口径）。
   */
  newsHints(now) {
    const cfg = config.news || {};
    if (!cfg.irregularHint) return [];
    const minLeft = cfg.irregularHintMinMs || 0;
    const out = [];
    for (const it of this.news.leakingStocks(now).values()) {
      if (minLeft > 0 && it.leftMs > minLeft) continue;
      out.push({
        stockId: it.stockId,
        name: it.stockName,
        text: `${it.stockName} 出现大额资金异动`,
        leftMs: Math.max(0, Math.round(it.leftMs)),
      });
    }
    return out;
  }

  /**
   * 把账户挂到某家券商上（开户或转户都走这里）。
   *
   * 两件事必须一起做，否则「每升一级解锁 1/4 特权」会瞬间失效：
   * ① `brokerSinceDay` 记成**当前交易日号**（免费重选窗口与转户冷却按交易日算）；
   * ② 该券商的进度把 `profitBase` 锚到**此刻的已实现盈亏**——星级里的「累计盈利」
   *    是"在这家券商赚的"，不是账户一辈子的总盈亏。不锚的话老玩家一开户就接近满星。
   */
  assignBroker(acc, key, opts = {}) {
    const entry = broker.get(key);
    if (!entry) return { ok: false, error: '券商不存在' };
    const day = opts.day == null ? this.dayNumber() : opts.day;
    // 转户：离开的这家与要去的那家，进度都从零开始（§5.2「清空该券商的特权进度与声誉星级」）。
    // 不清的话「先选热门攒够星级 → 转去冷门吃组内榜 → 再转回来」就是一条免成本的后门
    if (!opts.initial) {
      if (acc.broker) delete acc.brokerStats[acc.broker];
      delete acc.brokerStats[key];
    }
    acc.broker = key;
    acc.brokerChangedAt = opts.now == null ? Date.now() : opts.now;
    acc.brokerSinceDay = day;
    const rec = broker.statsOf(acc, key);
    rec.profitBase = acc.realizedPnL || 0;
    // 开户礼（体验金）：**同时加进现金与已实现盈亏**，保住「权益 = 初始资金 + 已实现盈亏
    // + 浮动盈亏」这条不变量。只加现金的话，账上会凭空多出一笔对不上任何科目的权益
    const gift = entry.overrides && entry.overrides.openGift ? entry.overrides.openGift : 0;
    if (opts.initial && gift > 0) {
      acc.cash = r2(acc.cash + gift);
      acc.realizedPnL = r2(acc.realizedPnL + gift);
      rec.profitBase = acc.realizedPnL;
    }
    this.persist?.touch(acc);
    return { ok: true, key, gift: opts.initial ? gift : 0 };
  }

  /**
   * 展示名：玩家看昵称，NPC 没有昵称（它的名字本来就是派生标签）→ 回落账户名。
   * 排行榜 / 股东榜 / 席位榜这些"给人看"的地方统一走这里。
   */
  static displayName(acc) {
    if (!acc) return '';
    return acc.nick || acc.name;
  }

  /**
   * 登录：**只认账号**（§3.2）。账号与昵称分家后，名字不再是"输入即建号"的凭据，
   * 所以这里分两种结果：
   * - 账号已开户 → 发令牌进市场；
   * - 账号不存在、或存在但没走完开户（老档升级上来）→ 返回 `needOnboard`，
   *   让客户端把「填昵称 + 选券商」那一步亮出来。
   *
   * **不在这里静默建号**：账号是玩家自己填的登录凭据，打错一个字母不该凭空多出一个号，
   * 更不该因此拿到一笔开户礼。建号只在 onboard 里发生。
   */
  login(account) {
    const name = String(account || '').trim();
    const existing = this.store.get(name) || null;
    const chk = broker.validateAccount(name, !!existing);
    if (!chk.ok) return { ok: false, error: chk.error };
    // NPC 账户名（`别名·标签N`）不会是 ASCII，但 SYSTEM 是——它已经被规则挡掉，
    // 这里再兜一层：万一将来 NPC 换命名，也不至于让玩家顶掉系统账户
    if (existing && existing.isNPC) return { ok: false, error: '这个账号名不可用，请换一个' };

    if (!existing || !this.isOnboarded(existing)) {
      return {
        ok: false,
        needOnboard: true,
        account: name,
        nick: existing && existing.nick ? existing.nick : '',
        error: existing ? '该账号还没开完户，请填写昵称并选择券商' : '账号不存在，请先开户',
      };
    }
    return this.startSession(existing, { isNew: false });
  }

  /** 开完户 = 有昵称 + 有券商。两者缺一都得回来补（老档升级上来时正好两样都缺） */
  isOnboarded(acc) {
    return !!(acc && acc.nick && acc.broker);
  }

  /**
   * 开户（= 首次登录的最后一步）：账号 + 昵称 + 券商一次性落定，成功即进市场。
   *
   * 已开过户的账号不走这里——否则开户会变成一条"能把昵称和券商随手覆盖掉"的后门
   * （改昵称走 setNick、换券商走 transferBroker，两者各有各的规则与成本）。
   */
  onboard(account, nick, brokerKey) {
    const name = String(account || '').trim();
    const existing = this.store.get(name) || null;
    const accChk = broker.validateAccount(name, !!existing);
    if (!accChk.ok) return { ok: false, error: accChk.error };
    if (existing && existing.isNPC) return { ok: false, error: '这个账号名不可用，请换一个' };
    if (existing && this.isOnboarded(existing)) {
      return { ok: false, error: '该账号已经开过户了，直接登录即可' };
    }
    const nickChk = broker.validateNick(nick);
    if (!nickChk.ok) return { ok: false, error: nickChk.error };
    // 券商必选、不给"跳过用默认"（§9 D2）：被默认的那家会被动成为最大的一家
    const key = String(brokerKey || '').trim();
    if (!key) return { ok: false, needBroker: true, error: '请选择一家券商开户' };
    if (!broker.has(key)) return { ok: false, needBroker: true, error: '券商不存在' };
    if (!existing && this.store.playerCount >= config.account.maxAccounts) {
      return { ok: false, error: '本局账号已达上限，请稍后再试' };
    }

    const acc = this.store.createOrGet(name);
    acc.nick = String(nick).trim();
    // 彩蛋水位线：第一次见到这个账户（新号，或老档升级上来还没初始化过的）就用当前权益
    // 锚住——留成 null/0 会立刻算成"回撤 100%"
    milestones.initPeak(acc.milestones, r2(this.equityOf(acc)));
    const r = this.assignBroker(acc, key, { initial: true });
    if (!r.ok) return { ok: false, needBroker: true, error: r.error };
    logger.info(
      `[我是股神] 新开户：账号 ${acc.name}（昵称 ${acc.nick}）→ ${r.key}` + (r.gift > 0 ? `，开户礼 ¥${r.gift}` : '')
    );
    return this.startSession(acc, { isNew: !existing });
  }

  /**
   * 发令牌 + 记股东快照基线。登录与开户两条路都收口在这里，
   * 免得将来其中一条漏掉"新账户要立刻纳入落盘范围"这一步（仅登录不下单的号会重启即消失）。
   */
  startSession(acc, opts = {}) {
    this.persist?.touch(acc);
    const t = this.newToken();
    this.sessions.set(t, acc.name);
    this.persist?.addSession(t, acc.name);
    this.trimSessions(acc.name);
    // 登录即给每只股票各留一份基线快照：不动手也能在任一只股票上看到「较上次操作」的变动。
    // 快照按 (账号, 股票) 存，所以这里要逐只记，不能只记一只
    for (const stock of this.stocks) this.snapshotHolders(acc, 'login', stock.id);
    if (opts.isNew) this.refreshStats();
    return {
      ok: true,
      account: acc.name,
      nick: Game.displayName(acc),
      token: t,
      broker: acc.broker,
    };
  }

  /**
   * 改昵称：昵称只是展示名，所以**随时可改、不要求唯一**（§3.2）。
   * 账号（acc.name）一动不动——它才是身份，改了会把所有持仓与流水都甩掉。
   */
  setNick(acc, nick) {
    if (!acc) return { ok: false, error: '请先登录' };
    const chk = broker.validateNick(nick);
    if (!chk.ok) return { ok: false, error: chk.error };
    const next = String(nick).trim();
    if (next === acc.nick) return { ok: true, nick: next, unchanged: true };
    const old = acc.nick;
    acc.nick = next;
    this.persist?.touch(acc);
    logger.info(`[我是股神] ${acc.name} 改昵称：${old || '（未设）'} → ${next}`);
    return { ok: true, nick: next };
  }

  /**
   * 转户（§5.2 / §9 D5）：1 个交易日冷却 + 转户费 = 总资产 × 0.1%（上限 5 万），
   * 免费重选 1 次且仅限开户后首个交易日内。转户清空新旧两家的特权进度与声誉星级。
   */
  transferBroker(acc, targetKey, now = Date.now()) {
    if (!acc) return { ok: false, error: '账户不存在' };
    const day = this.dayNumber(now);
    const check = broker.canTransfer(acc, targetKey, { day, equity: this.equityOf(acc) });
    // canTransfer 是纯函数，用 `reason` 表达拒绝原因；对外接口统一用 `error`
    // （前端只读 error，混着两套字段会让「被拦住了但界面没提示」）
    if (!check.ok) return { ok: false, error: check.reason || '无法转户', fee: check.fee, needDay: check.needDay };
    if (check.fee > 0 && acc.cash < check.fee) {
      return { ok: false, error: `转户费 ¥${check.fee} 超过可用资金`, fee: check.fee };
    }
    const from = acc.broker;
    if (check.fee > 0) acc.cash = r2(acc.cash - check.fee);
    // 任何一次转户都消耗掉「免费重选」这份一次性权益：不置位的话，
    // 同一天在新券商上又能满足「开户首日 + 未用过」而免费再转一次，转户费形同虚设
    acc.freeReselectUsed = true;
    this.assignBroker(acc, targetKey, { initial: false, day, now });
    // 转户也是"我的操作"，给每只股票各记一份股东快照基线（与 login 同口径）
    for (const stock of this.stocks) this.snapshotHolders(acc, 'transfer', stock.id);
    logger.info(`[我是股神] ${acc.name} 转户：${from || '（未选）'} → ${targetKey}，费用 ¥${check.fee}${check.free ? '（首日免费重选）' : ''}`);
    return { ok: true, from, to: targetKey, fee: check.fee, free: check.free, day };
  }

  /**
   * 使用当日的免息券（招伤自带；拥挤税补贴档的券商也送）。
   * 券是"当日融资/融券利息全免"，用掉之后这一天不再计杠杆利息。
   */
  useCoupon(acc, now = Date.now()) {
    if (!acc) return { ok: false, error: '账户不存在' };
    const day = this.dayNumber(now);
    const bk = this.brokerOf(acc, now);
    if (!bk.freeCouponPerDay) return { ok: false, error: '本券商不提供免息券' };
    if (!bk.freeCouponAvailable) return { ok: false, error: '今天的免息券已经用过了' };
    acc.couponUsedDay = day;
    acc.freeInterestDay = day;
    this.persist?.touch(acc);
    return { ok: true, day };
  }

  /** 券商开户卡片墙的元数据（登录前可读，不含任何账户信息） */
  brokersFor() {
    return {
      ok: true,
      enabled: !!config.brokers.enabled,
      brokers: broker.describeAll(),
      // 登录页要按这两条规则实时校验，所以连文案一起公开（登录前读得到）
      accountPattern: '3~16 位，字母开头，仅英文/数字/下划线/连字符',
      nickPattern: '2~12 个字符，中文/英文/数字/下划线/连字符',
      weekly: broker.weeklyPick(this.dayNumber()),
      starLevels: (config.brokers.star || {}).levels || [],
      // 展示层的「本服已有 N 人开户」：只读真实占比，**不参与任何数值计算**（§9 D3）
      selected: this.brokerSelectionCounts(),
    };
  }

  /** 选择页的参考值：本服各券商已开户的真实人数（纯提示，不进任何公式） */
  brokerSelectionCounts() {
    const out = {};
    for (const a of this.store.players()) {
      if (!a.broker) continue;
      out[a.broker] = (out[a.broker] || 0) + 1;
    }
    return out;
  }

  /** 转户（带令牌的入口） */
  transferBrokerFor(token, key) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    const r = this.transferBroker(acc, String(key || '').trim());
    return r;
  }

  /** 使用免息券（带令牌的入口） */
  useCouponFor(token) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    return this.useCoupon(acc);
  }

  /** 改昵称（带令牌的入口）。改完广播一帧，排行榜/股东榜上的名字立刻跟着变 */
  setNickFor(token, nick) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    const r = this.setNick(acc, nick);
    if (r.ok && !r.unchanged) this.broadcast();
    return r;
  }


  /** 同一账户只保留最近的若干令牌，避免 sessions 无限增长 */
  trimSessions(name) {
    const mine = [];
    for (const [tok, n] of this.sessions) {
      if (n === name) mine.push(tok);
    }
    for (let i = 0; i < mine.length - MAX_SESSIONS_PER_ACCOUNT; i++) {
      this.sessions.delete(mine[i]);
      this.persist?.removeSession(mine[i]);
    }
  }

  /** 令牌 -> 账户（身份的唯一来源） */
  accountFor(token) {
    if (!token) return null;
    const name = this.sessions.get(token);
    return name ? this.store.get(name) : null;
  }

  /**
   * 下单（H5 入口）。身份从会话令牌解析，实际逻辑在 placeOrderFor。
   * 账户冷却跨股票共享：2 秒内不管下哪只都算同一笔冷却，防止刷单。
   */
  placeOrder(token, body) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    return this.placeOrderFor(acc, body);
  }

  /**
   * 下单内核：**H5 与开放接口共用这一个入口**。
   *
   * 两条鉴权链路（会话令牌 / API Key）只负责"你是谁"，到这里之后一律走
   * `market.place` —— 冷却、锁仓、费率、保证金、同股多空互斥、价格笼子、
   * 涨跌停、阶段门控全在下游，这里不复制任何一条规则。
   *
   * 开放接口传进来的 acc 已经过 Key 校验，**不需要再验一次 token**；这也是为什么
   * 要把它抽出来而不是让开放接口自己造一个假 token —— 假 token 会进 sessions 表，
   * 玩家在 H5 的"登录设备"里会看到一条来路不明的会话。
   *
   * stockId 必填；指数不可交易；下单按股票路由到各自的市场。
   */
  placeOrderFor(acc, body) {
    if (!acc) return { ok: false, error: '请先登录' };
    const raw = body && body.stockId;
    if (raw && raw === this.index.stockId) return { ok: false, error: '指数不可交易，仅供观察大盘' };
    const stockId = this.resolveStockId(raw);
    if (!stockId) return { ok: false, error: '未知股票' };
    const qty = Number(body.qty);
    const price = Number(body.price);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) {
      return { ok: false, error: '价格或数量无效' };
    }
    const res = this.markets.get(stockId).place(acc, {
      action: body.action,
      qty,
      price,
      finance: body.finance === true, // 融资买入开关（仅 buy_open 生效）
      now: Date.now(),
    });
    if (res.ok) {
      this.snapshotHolders(acc, 'order', stockId);
      this.broadcast();
    }
    return res.ok
      ? { ok: true, order: this.serializeOrder(res.order, Date.now()), cooldownLeft: this.cooldownLeft(acc, Date.now()) }
      : res;
  }

  /** 撤单（H5 入口） */
  cancelOrder(token, orderId) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    return this.cancelOrderFor(acc, orderId);
  }

  /** 撤单内核：按委托自身所属股票路由（交易所有各自的簿，撤单必须找对市场） */
  cancelOrderFor(acc, orderId) {
    if (!acc) return { ok: false, error: '请先登录' };
    const order = acc.orders.get(orderId);
    if (!order) return { ok: false, error: '委托不存在或已完结' };
    const market = this.markets.get(order.stockId);
    if (!market) return { ok: false, error: '未知股票' };
    const res = market.cancel(acc, orderId, Date.now());
    if (res.ok) {
      this.snapshotHolders(acc, 'cancel', order.stockId);
      this.broadcast();
    }
    return res.ok ? { ok: true, order: this.serializeOrder(res.order, Date.now()) } : res;
  }

  // ---------- 融券：挂借 / 撤借 ----------

  /** 从账户各股票的挂借量重建每只股票的池子聚合值（新开局全为 0，续跑时从存档恢复） */
  rebuildLendingPool() {
    for (const stock of this.stocks) {
      const market = this.markets.get(stock.id);
      let total = 0;
      for (const acc of this.store.all()) {
        const led = acc.ledger.get(stock.id);
        if (led) total += led.lendOffered || 0;
      }
      market.lendTotal = total;
      // 借出量 = 未平空头（非裸空模式下空头都来自池）；裸空模式不走池
      market.lendBorrowed = config.margin.allowNakedShort
        ? 0
        : Math.min(market.shortInterest, total);
      market.lendReserved = 0; // 活动委托回填时单独累计
      // 做空利息已结到哪一天：Game 从 meta 恢复的水位线要落到市场上，
      // 否则重启后到下一个收盘前下发的 `lending.settledDay` 会退回 -1，与 meta 对不上
      market.lendSettledDay = this._lendSettled == null ? -1 : this._lendSettled;
    }
  }

  /** 挂借：把某只股票的可卖持仓划入该股的融券池生息 */
  lend(token, qty, stockIdRaw) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    if (acc.isNPC) return { ok: false, error: '仅玩家可操作挂借' };
    const stockId = this.resolveStockId(stockIdRaw);
    if (!stockId) return { ok: false, error: '未知股票' };
    const r = this.markets.get(stockId).lendShares(acc, qty, Date.now());
    if (r.ok) {
      logger.info(
        `[我是股神] 账户 ${acc.name} 挂借 ${this.stocksById.get(stockId).name} ${r.qty} 股（累计 ${r.lendOffered}，可借 ${r.available}）`
      );
      this.persist?.touch(acc);
      this.snapshotHolders(acc, 'lend', stockId);
      this.broadcast();
    }
    return r;
  }

  /** 撤借：撤回未被借走的挂借量 */
  unlend(token, qty, stockIdRaw) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    if (acc.isNPC) return { ok: false, error: '仅玩家可操作撤借' };
    const stockId = this.resolveStockId(stockIdRaw);
    if (!stockId) return { ok: false, error: '未知股票' };
    const r = this.markets.get(stockId).unlendShares(acc, qty, Date.now());
    if (r.ok) {
      logger.info(
        `[我是股神] 账户 ${acc.name} 撤借 ${this.stocksById.get(stockId).name} ${r.qty} 股（剩余 ${r.lendOffered}，可借 ${r.available}）`
      );
      this.persist?.touch(acc);
      this.snapshotHolders(acc, 'unlend', stockId);
      this.broadcast();
    }
    return r;
  }

  // ---------- 自动化交易 ----------

  createAuto(token, body) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    const r = this.auto.create(acc, body && body.type, body && body.params, this.resolveStockId(body && body.stockId));
    if (r.ok) this.broadcast();
    return r;
  }

  updateAuto(token, body) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    const r = this.auto.update(acc, body && body.id, body || {});
    if (r.ok) this.broadcast();
    return r;
  }

  removeAuto(token, body) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    const r = this.auto.remove(acc, body && body.id);
    if (r.ok) this.broadcast();
    return r;
  }

  // ---------- 加钱（主页「加钱」按钮） ----------

  /**
   * 给自己的账户加钱。上限由 config.account.deposit 决定：
   * 单账户**终身累计**不得超过 maxLifetime（默认 1 个亿），累计数随存档走。
   * @param {string} token 会话令牌
   * @param {*} amountRaw 金额（元），按整数处理
   */
  deposit(token, amountRaw) {
    const dep = config.account.deposit;
    if (!dep.enabled) return { ok: false, error: '加钱功能未开放' };
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    if (acc.isNPC) return { ok: false, error: '仅玩家账户可加钱' };

    const amount = Math.floor(Number(amountRaw));
    if (!Number.isFinite(amount) || amount < dep.minPerTime) {
      return { ok: false, error: `单次至少加 ${dep.minPerTime} 元` };
    }

    const used = acc.deposited || 0;
    const remaining = dep.maxLifetime - used;
    if (remaining < dep.minPerTime) {
      return { ok: false, error: `已达终身上限（${dep.maxLifetime} 元），无法继续加钱` };
    }
    if (amount > remaining) {
      return { ok: false, error: `超出终身上限，剩余可加 ${Math.floor(remaining)} 元` };
    }

    acc.cash = r2(acc.cash + amount);
    acc.deposited = r2(used + amount);
    logger.info(
      `[我是股神] 账户 ${acc.name} 加钱 ${amount} 元（累计 ${acc.deposited} / 上限 ${dep.maxLifetime}）`
    );
    this.persist?.touch(acc); // 改钱必须标脏，否则重启后这笔加钱会消失
    this.broadcast();
    return {
      ok: true,
      added: amount,
      deposited: acc.deposited,
      remaining: Math.max(0, r2(dep.maxLifetime - acc.deposited)),
      cash: r2(acc.cash),
    };
  }

  // ---------- 运维：停牌 ----------

  /**
   * 手动停牌：**全市场一起停**（10 只股票同时冻结，指数随之走平）。
   * 单股停牌会让「停牌倒计时」变成对各股票含义不同的东西，运营口径也复杂化，
   * 这里保持与单股时代一致的语义：一次操作停掉整个盘面。
   * 只操作真实股票——指数是被合成的，没有独立的停牌语义，成分股停了它自然平。
   */
  halt(minutes, reason) {
    const mins = minutes ?? config.halt.defaultMinutes;
    let r = { ok: false, error: '停牌时长无效' };
    for (const stock of this.stocks) {
      r = this.markets.get(stock.id).halt(mins, reason);
      if (!r.ok) return r;
    }
    if (r.ok) this.broadcast();
    return r;
  }

  /** 立即复牌（全市场） */
  resume() {
    this.broadcast();
    let r = { ok: false, error: '未知股票' };
    for (const stock of this.stocks) r = this.markets.get(stock.id).resume();
    return r;
  }

  // ---------- 运维：系统公告 ----------

  /**
   * 系统公告（关服 / 重启前的通知，也可临时口播）。
   *
   * 只保留**最新一条**：`id` 自增，客户端按 id 判断"是不是新公告"再弹 toast，
   * 靠文本比对会被重复推送砸出满屏提示。带过期时间，且**只存内存不落库**——
   * 进程一停公告就该消失，重启后玩家不该还看到「即将关闭」。
   * 下发走 `stateFor` 的 `notice` 段（每帧都带），刷新页 / 新登录的玩家也能立刻看见，
   * 只靠广播一次性推给在线连接是不够的。
   */
  setNotice(text, options) {
    const o = options || {};
    const body = String(text || '').trim().slice(0, 120);
    if (!body) {
      this.notice = null;
      this.broadcast();
      return { ok: true, notice: null };
    }
    const mins = Number(o.minutes);
    const now = Date.now();
    // id 用时间戳做基数再自增：进程重启后公告 id 仍单调递增，
    // 客户端靠 id 去重才不会把「服务已恢复」当成旧公告吞掉
    this.noticeSeq = Math.max(this.noticeSeq || 0, now) + 1;
    this.notice = {
      id: this.noticeSeq,
      text: body,
      kind: String(o.kind || 'info'),
      at: now,
      expiresAt: now + (Number.isFinite(mins) && mins > 0 ? Math.round(mins * 60000) : 30 * 60000),
    };
    this.broadcast();
    return { ok: true, notice: this.notice };
  }

  /** 当前有效公告（过期的当没有） */
  noticeSnapshot(now = Date.now()) {
    const n = this.notice;
    if (!n || n.expiresAt <= now) return null;
    return n;
  }

  // ---------- 状态快照 ----------

  /** 下单冷却剩余毫秒（按账户券商的冷却，不是全局值） */
  cooldownLeft(acc, now) {
    if (!acc || acc.lastOrderAt == null) return 0;
    const cd = this.brokerOf(acc, now).cooldownMs;
    return Math.max(0, cd - (now - acc.lastOrderAt));
  }

  /** 全部标的的行情快照（10 只股票 + 指数）。每 tick 只算一次，给所有 SSE 连接共用 */
  marketSnapshots() {
    const out = [];
    for (const stock of this.stocks) out.push(this.markets.get(stock.id).snapshot());
    return out;
  }

  /** 玩家视角完整状态 */
  stateFor(token, opts = {}) {
    const now = Date.now();
    const acc = this.accountFor(token);
    // 行情快照可由调用方传入：SSE 每 tick 要给每条连接推一份，行情部分完全一样
    const markets = opts.markets || this.marketSnapshots();
    const index = opts.index || this.index.snapshot();
    if (!this._stats) this.refreshStats();
    const stats = this._stats;
    const primary = this.markets.get(this.stocks[0].id);
    // 券商参数按账户解析（两级兜底：broker 覆盖 → 全局默认）。
    // 未登录（acc=null）时必须给**纯基准**并把「每周之星」也关掉——day:0 让 weeklyPick 不生效，
    // 否则登录页会看到一个被当周之星减半的费率
    const bk = acc ? this.brokerOf(acc, now) : broker.forAccount(null, { day: 0 });
    const vipLead = bk.newsVipLeadMs || 0;
    const viewer = vipLead > 0
      ? { tier: 'vip', leadMs: vipLead, showDir: !!bk.newsVipVisible }
      : null;
    const base = {
      serverTime: now,
      startedAt: this.startedAt,
      markets,
      index,
      // 交易日时钟（全市场共用一份）：第几天、哪个阶段、还剩多久、游戏内时刻
      day: this.day.snapshot(now),
      // 系统公告（运维关服 / 重启前的通知）：每帧都带一份，刷新的玩家也能立刻看到
      notice: this.noticeSnapshot(now),
      // 兼容字段：老客户端只认单个 market。取第一只股票，新客户端一律走 markets
      market: markets[0],
      // 消息磁带：**泄露期的消息不出现在公众视野里**（消息分层三段式的灵魂）。
      // 达到 L2 情报等级的券商客户能在公开前看到"哪只股票有消息"；方向是否可见
      // 取决于声誉星级到没到 4★ 以上（§8.1）
      news: this.news.tapeSnapshot(50, now, viewer),
      lastNews: NewsSystem.visibleFor(this.lastNews, viewer, now) ? this.lastNews : null,
      // 公平窗口（§7.2）：泄露期里给公众一条**模糊**提示，不点方向、不点原因、不点谁。
      // 「偷偷买进」不能是纯黑箱，否则普通玩家只剩被割
      newsHints: this.newsHints(now),
      rules: {
        feeRate: bk.feeRate,
        cooldownMs: bk.cooldownMs,
        lockMs: bk.lockMs,
        marginRatio: bk.marginRatio,
        maintenance: bk.maintenance,
        allowNakedShort: !!config.margin.allowNakedShort,
        lending: {
          enabled: !!(config.margin.lending && config.margin.lending.enabled),
          // 做空利息按**游戏日**结算（收盘日终结算收一次），所以下发的是日息
          baseDailyRate: config.margin.lending ? config.margin.lending.baseDailyRate : 0,
          maxDailyRate: config.margin.lending ? config.margin.lending.maxDailyRate : 0,
        },
        finance: {
          enabled: !!(config.margin.finance && config.margin.finance.enabled),
          ratio: bk.financeRatio,
          baseMinuteRate: config.margin.finance ? config.margin.finance.baseMinuteRate : 0,
          maxMinuteRate: config.margin.finance ? config.margin.finance.maxMinuteRate : 0,
          // 当前分钟息（百分数，0.01 = 0.01%/分）：1e6/1e4 比 r2 更干净地消掉浮点尾数。
          // 融资利率按市场整体现金紧张度算，各股同一档，取第一只即可
          minuteRate: Math.round(primary.financeMinuteRate() * 1e6) / 1e4,
        },
        initialCash: config.account.initialCash,
        lotSize: this.stocks[0].lotSize,
        maxDeviation: config.trade.maxDeviation,
        cagePct: config.trade.cagePct,
        priceLimit: config.priceLimit,
        // 交易日规则表：客户端「游戏规则」面板要逐段展示时长与能否下单，
        // 而**客户端不许自己算阶段**（见 §3.1），所以阶段表也只能由服务端下发
        day: {
          enabled: !!config.day.enabled,
          totalMs: config.day.phases.reduce((sum, p) => sum + p.ms, 0),
          phases: config.day.phases.map((p) => ({
            key: p.key,
            label: p.label,
            ms: p.ms,
            gameTime: p.gameTime || '',
            trading: !!p.trading,
            auction: p.auction || null,
            cancelLockMs: p.cancelLockMs || 0,
          })),
        },
        // 强平撮合不到对手盘时的系统兜底滑点（规则面板要讲清"强平不保证成交在你看到的价格"）
        liquidationSlippage: config.margin.liquidationSlippage,
        index: { code: this.index.stockId, name: this.index.stock.name, base: this.index.base },
        stocks: this.stocks.map((s) => ({
          id: s.id,
          name: s.name,
          alias: s.alias,
          lotSize: s.lotSize,
          floatShares: s.floatShares,
        })),
        // 六家券商的展示元数据（登录卡片墙与「我的券商」卡共用）。放在 rules 里是为了
        // 与 stocks 同构；未登录时也能拿到，所以登录页不需要额外接口
        brokers: broker.describeAll(),
        brokerMeta: {
          enabled: !!config.brokers.enabled,
          baseSlots: config.brokers.baseSlots,
          starMax: (config.brokers.star || {}).max || 5,
          maxPrivilegeStar: (config.brokers.star || {}).maxPrivilegeStar || 4,
          nickPattern: '3~16 位，字母开头，仅英文/数字/下划线/连字符',
          transfer: config.brokers.transfer,
          weekly: {
            daysPerWeek: (config.brokers.weekly || {}).daysPerWeek,
            feeMul: (config.brokers.weekly || {}).feeMul,
            financeBonus: (config.brokers.weekly || {}).financeBonus,
          },
          seat: config.brokers.seat,
        },
        deposit: {
          enabled: !!config.account.deposit.enabled,
          maxLifetime: config.account.deposit.maxLifetime,
          minPerTime: config.account.deposit.minPerTime,
          presets: config.account.deposit.presets,
        },
        auto: {
          maxPerAccount: bk.autoMax,
          dcaMinIntervalMs: config.auto.dcaMinIntervalMs,
          grid: config.auto.grid,
          ma: config.auto.ma,
        },
        // 彩蛋开关（客户端据此决定要不要渲染里程碑卡；文案与判定全在服务端）
        milestones: { enabled: !!config.milestones.enabled, tone: config.milestones.tone },
      },
      players: stats.players,
      // 券商榜：总榜在 players 里，这里给按券商聚合的一份（§5.3）
      brokerBoard: this.brokerBoard(),
      online: this.store.playerCount,
      // 股东榜改为按需拉取（/api/holders?stock=X）：10 只股票 × 前 30 名每 tick 全推会把帧撑爆
      halt: primary.haltInfo(now),
    };
    if (!acc) {
      base.account = null;
      return base;
    }
    base.account = this.serializeAccount(acc, now);
    base.cooldownLeft = this.cooldownLeft(acc, now);
    return base;
  }

  /** 账户在某只股票上的持仓切片 */
  serializePosition(acc, stock, now, bk) {
    const sid = stock.id;
    const market = this.markets.get(sid);
    const last = market.lastPrice;
    // 锁仓时长按账户券商解析（滑泰 5 秒 / 天疯 8 秒 / 基准 10 秒）。
    // 这里与 market.place 的卖出闸门必须同源：早先两处各读各的（这里写死全局根值），
    // 出现了「rules.lockMs 显示 5 秒、lockedUntil 与可卖却按 10 秒算」的自相矛盾
    const brokerCfg = bk || this.brokerOf(acc, now);
    const lockMs = brokerCfg.lockMs;
    const longPos = acc.longs.get(sid);
    const shortPos = acc.shorts.get(sid);
    let longCost = 0;
    const longLots = [];
    if (longPos) {
      for (const lot of longPos.lots) {
        longCost += lot.qty * lot.price;
        const lockedUntil = lot.ts + lockMs;
        longLots.push({
          qty: lot.qty,
          price: r2(lot.price),
          ts: lot.ts,
          lockedUntil,
          debt: r2(lot.debt || 0),
          sellable: Math.max(0, lot.qty - lot.reserved) >= 1 && now >= lockedUntil,
        });
      }
    }
    let shortCost = 0;
    let shortMarginOfLots = 0;
    const shortLots = [];
    if (shortPos) {
      for (const lot of shortPos.lots) {
        shortCost += lot.qty * lot.price;
        shortMarginOfLots += lot.margin;
        shortLots.push({ qty: lot.qty, price: r2(lot.price), margin: r2(lot.margin) });
      }
    }
    const longQty = acc.longQty(sid);
    const shortQty = acc.shortQty(sid);
    const debt = r2(acc.financeDebt(sid));
    const led = acc.ledger.get(sid);
    const offered = led ? led.lendOffered || 0 : 0;
    // 没持仓、没挂借、没负债的股票整条不下发（省帧体积）
    if (longQty <= 0 && shortQty <= 0 && !offered && debt <= 0) return null;

    const longValue = r2(longQty * last);
    const shortValue = r2(shortQty * last);

    // 强平价推导（含融资负债与做空欠息）：cash+orderFrozen+shortMargin-debt-debtLend + (L-S)*P = 维持率×敞口×P
    // 空头强平价：K = ((1+m)*S - L) * P → P = K / ((1+m)S - L)；K 为负时空头端安全
    // K 的两项负债口径必须与 equity（maybeLiquidate 判定用）完全一致，否则显示与真实触发点分叉：
    // m 取自配置（写死数字改维持率后即失真），欠息也要扣（它同样进了 equity）
    // 多股票：账户现金与保证金是共享的，所以 K 里要并入「其它股票的净持仓值」，
    // 否则持有其它股票时这只的强平价会算得过高/过低。
    // 但**维持线那一侧也要并入其它股票的敞口**：触发条件是组合口径的
    // equity < 维持率 × 账户总敞口，只把其它股票算进 K、不算进维持线，
    // 解出来的价格就不是真正的触发点（空头会偏低、多头会偏高），显示与强平脱钩
    const m = config.margin.maintenance;
    const priceOf = (s) => this.markets.get(s).lastPrice;
    let otherLong = 0;
    let otherShort = 0;
    let otherDebt = 0;
    for (const [oid, pos] of acc.longs) {
      if (oid === sid) continue;
      otherLong += acc.longQty(oid) * priceOf(oid);
      for (const lot of pos.lots) otherDebt += lot.debt || 0;
    }
    for (const [oid] of acc.shorts) {
      if (oid === sid) continue;
      otherShort += acc.shortQty(oid) * priceOf(oid);
    }
    const lendDebt = r2(acc.totalLendInterestDebt());
    const K =
      acc.cash + acc.orderFrozen + acc.shortMargin - debt - lendDebt + otherLong - otherShort - otherDebt;

    // 空头强平价：K + (L−S)·P = 维持率 × (其它空头市值 + S·P) → P = (K − 维持率×其它空头市值) / ((1+m)S − L)
    let liquidationPrice = null;
    const denom = (1 + m) * shortQty - longQty;
    if (shortQty > 0 && denom > 0) {
      const p = (K - m * otherShort) / denom;
      if (p > 0) liquidationPrice = r2(p);
    }
    // 多头（融资）强平价：K + (L−S)·P = 维持率 × (其它多头市值 + L·P)
    //   → P = (维持率×其它多头市值 − K) / ((1−m)L − S)
    let liquidationPriceLong = null;
    const denomL = (1 - m) * longQty - shortQty;
    if (debt > 0 && longQty > 0 && m * otherLong - K > 0 && denomL > 0) {
      const p = (m * otherLong - K) / denomL;
      if (p > 0) liquidationPriceLong = r2(p);
    }

    return {
      stockId: sid,
      name: stock.name,
      last,
      long: {
        qty: longQty,
        cost: r2(longCost),
        value: longValue,
        pnl: r2(longValue - longCost),
        lots: longLots,
        sellable: acc.freeSellableLong(sid, now, lockMs),
      },
      short: {
        qty: shortQty,
        cost: r2(shortCost),
        value: shortValue,
        margin: r2(shortMarginOfLots),
        pnl: r2(shortCost - shortValue),
        lots: shortLots,
        coverable: acc.coverableShort(sid),
      },
      financeDebt: debt, // 融资负债（本金 + 已摊利息）
      financePrincipal: r2(acc.financePrincipal(sid)), // 其中还没还的借入本金
      financeInterest: r2(led ? led.financeInterestAccrued || 0 : 0), // 该股累计已计利息（展示用）
      liquidationPrice,
      liquidationPriceLong,
      lending: this.serializeLending(acc, sid, lockMs),
    };
  }

  serializeAccount(acc, now) {
    // 券商参数在**账户粒度**算一次，给 10 只股票的持仓切片共用（锁仓时长 / 可卖口径都读它）
    const bk = this.brokerOf(acc, now);
    const positions = [];
    for (const stock of this.stocks) {
      const p = this.serializePosition(acc, stock, now, bk);
      if (p) positions.push(p);
    }
    const priceOf = (s) => this.markets.get(s).lastPrice;
    const equity = r2(acc.equity(priceOf));
    const longValue = r2(acc.totalLongValue(priceOf));
    const shortValue = r2(acc.totalShortMV(priceOf));
    const debt = r2(acc.totalFinanceDebt());
    const lendDebt = r2(acc.totalLendInterestDebt());
    // 累计已计利息是展示口径（按股票加总）
    let financeInterest = 0;
    let financePrincipal = 0;
    for (const l of acc.ledger.values()) financeInterest += l.financeInterestAccrued || 0;
    for (const p of acc.longs.values()) {
      for (const lot of p.lots) financePrincipal += lot.principal || 0;
    }

    const orders = [];
    for (const o of acc.orders.values()) orders.push(this.serializeOrder(o, now));
    const orderHistory = acc.orderHistory.slice(0, 50).map((o) => this.serializeOrder(o, now));
    const trades = acc.tradeHistory.slice(0, 50).map((t) => ({
      id: t.id,
      orderId: t.orderId,
      stockId: t.stockId,
      action: t.action,
      price: t.price,
      qty: t.qty,
      t: t.t,
      side: t.side,
    }));

    return {
      name: acc.name, // 账号：登录凭据，也是各表引用的键
      nick: Game.displayName(acc), // 昵称：界面上给人看的就是它
      cash: r2(acc.cash),
      orderFrozen: r2(acc.orderFrozen),
      shortMargin: r2(acc.shortMargin),
      financeDebt: debt, // 跨股票合计
      financePrincipal: r2(financePrincipal),
      financeInterest: r2(financeInterest),
      equity,
      realizedPnL: r2(acc.realizedPnL),
      deposited: r2(acc.deposited || 0), // 终身累计加钱额
      positions,
      // 汇总口径（客户端资产区用）：全部股票的持仓市值与浮盈
      longValue,
      shortValue,
      longPnl: r2(positions.reduce((a, p) => a + p.long.pnl, 0)),
      shortPnl: r2(positions.reduce((a, p) => a + p.short.pnl, 0)),
      // 风险度 = （空头市值 + 融资负债 + 做空欠息）/ 权益。走单一落点，与彩蛋 C00/C01 判定同源
      marginUsage: this.marginUsageOf(acc, equity),
      orders,
      orderHistory,
      trades,
      liquidations: (acc.liquidations || []).slice(0, 5),
      auto: this.auto.serializeAll(acc.name, now),
      broker: this.serializeBroker(acc, now),
      // 彩蛋：已获得的称号 / 下一档发家线的进度 / 最近若干条待播事件（客户端按 seq 去重）
      events: milestones.summary(acc.milestones, {
        equity,
        initialCash: config.account.initialCash,
      }),
      // 追保预警（§7 彩蛋）：跌破维持线但还没到强平线时给一条通知，
      // 文案随券商风格变（钟信=正式公函体、天疯=没有这一档，破线即全平）
      marginCall: this.marginCallFor(acc, now),
    };
  }

  /** 账户级的追保预警：遍历持有敞口的市场，取最急的那一条 */
  marginCallFor(acc, now) {
    let worst = null;
    for (const stock of this.stocks) {
      if (!acc.longs.has(stock.id) && !acc.shorts.has(stock.id)) continue;
      const m = this.markets.get(stock.id).marginCallState(acc, now);
      if (!m) continue;
      m.stockId = stock.id;
      m.stockName = stock.name;
      if (!worst || m.left < worst.left) worst = m;
    }
    return worst;
  }

  /**
   * 「我的券商」卡片需要的全部信息：名称/星级/拥挤度/特权清单/本周加成/转户状态。
   * 也顺带给出**下一星的进度**与免息券可用性，前端不用自己算。
   */
  serializeBroker(acc, now) {
    const day = this.dayNumber(now);
    const bk = broker.forAccount(acc, { day });
    const list = broker.privilegeList(acc, { day });
    const weeks = broker.weeklyPick(day);
    const transfer = {
      // 能否转、转给谁花多少：前端把六家都算一遍就能直接标注"免费/¥N"
      cooldownDay: acc.brokerSinceDay == null ? null : acc.brokerSinceDay + ((config.brokers.transfer || {}).cooldownDays || 1),
      freeReselectUsed: !!acc.freeReselectUsed,
      freeReselectDay: acc.brokerSinceDay,
      feeRate: (config.brokers.transfer || {}).feeRate,
      feeCap: (config.brokers.transfer || {}).feeCap,
      options: Object.keys(config.brokers.list || {}).map((k) => {
        const c = broker.canTransfer(acc, k, { day, equity: this.equityOf(acc) });
        return { key: k, ok: c.ok, free: !!c.free, fee: c.fee || 0, reason: c.reason || '' };
      }),
    };
    return {
      key: acc.broker,
      name: bk.name || (acc.broker ? acc.broker : ''),
      abbr: bk.abbr || '',
      star: bk.star,
      starMax: (config.brokers.star || {}).max || 5,
      intensity: Math.round(bk.intensity * 100),
      crowd: bk.crowd.value,
      crowdPct: bk.crowd.pct,
      crowdTier: bk.crowd.tier,
      crowdLabel: bk.crowd.label,
      tier: bk.crowd.tier,
      // 有效数值（已含拥挤税与每周加成、已按星级折算）
      feeRate: bk.feeRate,
      cooldownMs: bk.cooldownMs,
      lockMs: bk.lockMs,
      financeRatio: bk.financeRatio,
      leverage: broker.leverageOf(bk.financeRatio),
      marginRatio: bk.marginRatio,
      maintenance: bk.maintenance,
      lendCapacityPct: Math.round(bk.lendCapacityMul * 100),
      lendRateMul: bk.lendRateMul,
      autoMax: bk.autoMax,
      autoSlots: bk.autoSlots,
      newsVipLeadMs: bk.newsVipLeadMs,
      newsVipVisible: bk.newsVipVisible,
      features: bk.features,
      strengths: (bk.entry && bk.entry.strengths) || [],
      costs: (bk.entry && bk.entry.costs) || [],
      privileges: list.rows,
      progress: broker.starProgress(acc, acc.broker),
      weekly: {
        key: weeks.key,
        nextKey: weeks.nextKey,
        isStar: bk.weekly.isStar,
        feeMul: bk.weekly.feeMul,
        financeBonus: bk.weekly.financeBonus,
        weekEndDay: weeks.weekEndDay,
      },
      coupon: {
        perDay: bk.freeCouponPerDay,
        available: bk.freeCouponAvailable,
        active: !!bk.freeInterestOn,
        usedDay: acc.couponUsedDay == null ? null : acc.couponUsedDay,
      },
      transfer,
      sinceDay: acc.brokerSinceDay,
      stats: broker.statsOf(acc, acc.broker),
    };
  }

  serializeOrder(o, now) {
    return {
      id: o.id,
      stockId: o.stockId,
      action: o.action,
      price: o.price,
      qty: o.qty,
      filled: o.filled,
      status: o.status,
      ts: o.ts,
      remain: o.qty - o.filled,
    };
  }

  /** 账户在某只股票上的融券视角：可挂借、挂借中、被借走、可撤、累计利息 */
  serializeLending(acc, stockId, lockMs) {
    const m = this.markets.get(stockId);
    const stock = this.stocksById.get(stockId);
    const led = acc.ledger.get(stockId);
    const offered = led ? led.lendOffered || 0 : 0;
    const lentOut = Math.floor(offered * m.lendUtilization());
    // 可撤口径必须与撤借闸门一致（含在途开空占用），否则 UI 显示可撤、点撤借却被拒
    const removable = m.lendRemovableQty(acc);
    // 可挂借口径必须与 market.lendShares 的闸门同源——两处都按**账户券商的锁仓时长**
    const free = acc.freeSellableLong(
      stockId,
      Date.now(),
      lockMs == null ? this.brokerOf(acc).lockMs : lockMs
    );
    return {
      stockId,
      offered,
      lentOut,
      removable,
      freeToLend: Math.max(0, Math.floor(free / stock.lotSize) * stock.lotSize),
      interestEarned: r2(led ? led.lendInterestEarned || 0 : 0),
      interestDebt: r2(led ? led.lendInterestDebt || 0 : 0),
      interestPaid: r2(led ? led.lendInterestPaid || 0 : 0),
      // 今日已累计、还没到收盘结算的做空利息（收盘那一刻一次性从现金扣）
      interestPending: r2(led ? led.lendInterestAccrued || 0 : 0),
    };
  }

  /** 玩家资产排行（组合口径：跨全部股票的总权益）。展示名走昵称，账号另带一份供前端自行识别 */
  leaderboard(limit = 20) {
    const priceOf = (s) => this.markets.get(s).lastPrice;
    const all = this.store
      .players()
      .map((a) => ({
        account: a.name,
        name: Game.displayName(a),
        equity: r2(a.equity(priceOf)),
        broker: a.broker || null,
        star: a.broker ? broker.starOf(a, a.broker) : 1,
      }))
      .sort((x, y) => y.equity - x.equity || x.account.localeCompare(y.account));
    // 组内名次：同一家券商内部再排一次。这是**最有效的软分流**——冷门券商的组内名次
    // 天然更容易靠前，头部玩家的「争榜」动机于是把人往冷门赶（§5.3）
    const seen = new Map();
    for (const r of all) {
      const k = r.broker || '__none';
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      r.brokerRank = n;
    }
    this._brokerBoard = broker.groupBoard(all);
    return all.slice(0, limit);
  }

  /**
   * 某个玩家的持仓概况（排行里点「持仓」按需拉，不进每帧 SSE）。
   * 只给「看得懂的仓位」：股票 × 方向的数量 / 均价 / 现价 / 市值 / 盈亏 + 账户级汇总。
   * 批次明细、强平价、挂单与成交流水**不下发**——那是本人视角；别人看榜只需要仓位。
   * 口径复用 serializePosition，避免「榜上的盈亏」与「他自己看到的盈亏」两套算法。
   */
  playerPortfolio(account) {
    const acc = account ? this.store.get(account) : null;
    // NPC 与不存在的账号一律当「查无此人」：榜单只列玩家，别让这个接口变成 NPC 探针
    if (!acc || acc.isNPC) return { ok: false, error: '玩家不存在' };
    const now = Date.now();
    const bk = this.brokerOf(acc, now);
    const priceOf = (s) => this.priceOf(s);
    const positions = [];
    for (const stock of this.stocks) {
      const p = this.serializePosition(acc, stock, now, bk);
      if (!p) continue;
      if (p.long.qty > 0) {
        positions.push({
          stockId: p.stockId,
          name: p.name,
          last: p.last,
          side: 'long',
          qty: p.long.qty,
          avg: r2(p.long.cost / p.long.qty),
          value: p.long.value,
          pnl: p.long.pnl,
        });
      }
      if (p.short.qty > 0) {
        positions.push({
          stockId: p.stockId,
          name: p.name,
          last: p.last,
          side: 'short',
          qty: p.short.qty,
          avg: r2(p.short.cost / p.short.qty),
          value: p.short.value,
          pnl: p.short.pnl,
          margin: p.short.margin,
        });
      }
    }
    positions.sort((a, b) => b.value - a.value);
    const longValue = r2(acc.totalLongValue(priceOf));
    const shortValue = r2(acc.totalShortMV(priceOf));
    return {
      ok: true,
      t: now,
      account: acc.name,
      name: Game.displayName(acc),
      broker: acc.broker || null,
      star: acc.broker ? broker.starOf(acc, acc.broker) : 1,
      equity: r2(acc.equity(priceOf)),
      initialCash: config.account.initialCash,
      cash: r2(acc.cash),
      orderFrozen: r2(acc.orderFrozen),
      shortMargin: r2(acc.shortMargin),
      longValue,
      shortValue,
      longPnl: r2(positions.reduce((a, p) => a + (p.side === 'long' ? p.pnl : 0), 0)),
      shortPnl: r2(positions.reduce((a, p) => a + (p.side === 'short' ? p.pnl : 0), 0)),
      financeDebt: r2(acc.totalFinanceDebt()),
      realizedPnL: r2(acc.realizedPnL),
      positions,
    };
  }

  /** 券商榜（§5.3）：按券商聚合客户数与总权益，含组内第一名 */
  brokerBoard() {
    if (!this._brokerBoard) this.leaderboard();
    return this._brokerBoard || [];
  }

  /**
   * 运维时钟快照：给 `python server.py stop/restart` 的安全关服判定用。
   *
   * 为什么不复用 `stateFor` / `/api/state`：那条链路要玩家会话令牌，而且要把十只股票的
   * 全量盘口序列化一遍，是给浏览器画图的重量级快照；运维脚本只想回答一个问题——
   * 「现在是不是可以安全停进程的休市窗口」，每秒钟问一次。给它一个几十字节的答案即可。
   *
   * 只暴露时间轴与停牌开关（客户端顶栏本来就看得见），不含任何内幕。
   */
  opsClock() {
    const now = Date.now();
    const day = this.day.snapshot(now);
    // 停牌是**全市场一起停**（见 Game.halt），取第一只的状态就代表全部
    const primary = this.markets.get(this.stocks[0].id);
    const halt = primary ? primary.haltInfo(now) : { halted: false, until: 0, reason: '' };
    // 带上公告，运维脚本发完能回读确认「真的挂上去了 / 真的撤掉了」
    return { serverTime: now, day, halt, notice: this.noticeSnapshot(now) };
  }

  /**
   * AI 主力完整持仓组合。
   * **所有已登录玩家**可看 `/whales` 页与 `/api/whales`；运维另走 `/api/admin/whales`。
   * 不进 stateFor——详情按需拉取，普通帧推送仍只有公开行情。
   */
  /** 该玩家令牌是否允许看 AI 主力详情（已登录即可） */
  canViewWhales(token) {
    return !!this.accountFor(token);
  }

  /**
   * AI 主力完整持仓组合（详情：现金 / 权益 / 多空明细 / 挂单）。
   */
  whalePortfolio() {
    const priceOf = (s) => this.priceOf(s);
    const day = this.day.ok ? this.day.locate(Date.now()) : null;
    const whales = [];
    for (const acc of this.store.all()) {
      if (!acc.ai && acc.role !== 'whale') continue;
      const positions = [];
      const stockIds = new Set([...acc.longs.keys(), ...acc.shorts.keys()]);
      for (const stockId of stockIds) {
        if (!this.markets.has(stockId)) continue;
        const stock = this.stocksById.get(stockId);
        const longQty = acc.longQty(stockId);
        const shortQty = acc.shortQty(stockId);
        if (longQty <= 0 && shortQty <= 0) continue;
        const last = this.priceOf(stockId);
        const long = this.serializePosition(acc, stock, Date.now(), this.brokerOf(acc));
        const shortP = long && long.short ? long.short : null;
        const longP = long && long.long ? long.long : null;
        positions.push({
          stockId,
          stockName: stock.name,
          last: r2(last),
          longQty,
          shortQty,
          longValue: r2(longQty * last),
          shortValue: r2(shortQty * last),
          longCost: longP ? longP.cost : null,
          shortCost: shortP ? shortP.cost : null,
          longPnl: longP ? longP.pnl : 0,
          shortPnl: shortP ? shortP.pnl : 0,
        });
      }
      positions.sort((a, b) => b.longValue + b.shortValue - (a.longValue + a.shortValue));
      const orders = [];
      for (const o of acc.orders.values()) {
        orders.push({
          id: o.id,
          stockId: o.stockId,
          stockName: this.stocksById.get(o.stockId)?.name || o.stockId,
          action: o.action,
          price: o.price,
          qty: o.qty,
          filled: o.filled || 0,
          status: o.status,
          t: o.t,
        });
      }
      const trades = acc.tradeHistory.slice(0, 10).map((t) => ({
        stockId: t.stockId,
        stockName: this.stocksById.get(t.stockId)?.name || t.stockId,
        action: t.action,
        price: t.price,
        qty: t.qty,
        side: t.side,
        t: t.t,
      }));
      const equity = r2(acc.equity(priceOf));
      whales.push({
        account: acc.name,
        label: acc.aiLabel || Game.displayName(acc),
        aiId: acc.aiId || null,
        cash: r2(acc.cash),
        orderFrozen: r2(acc.orderFrozen),
        equity,
        realizedPnL: r2(acc.realizedPnL),
        marginUsage: this.marginUsageOf(acc, equity),
        longValue: r2(acc.totalLongValue(priceOf)),
        shortValue: r2(acc.totalShortMV(priceOf)),
        positions,
        orders,
        recentTrades: trades,
      });
    }
    whales.sort((a, b) => b.equity - a.equity);
    return {
      ok: true,
      t: Date.now(),
      day: day ? day.day : null,
      phase: day ? day.phase.key : null,
      phaseLabel: day ? day.phase.label : null,
      llmEnabled: !!(config.npc.llm && config.npc.llm.enabled),
      lastDecision: this.whales && this.whales.lastDecisionSnapshot
        ? this.whales.lastDecisionSnapshot().last
        : null,
      decisionHistory: this.whales && this.whales.lastDecisionSnapshot
        ? this.whales.lastDecisionSnapshot().history
        : [],
      whales,
    };
  }

  /** 某只股票的前十大股东（走 tick 缓存） */
  topHolders(stockId) {
    if (!this._stats) this.refreshStats();
    return this._stats.topHolders.get(stockId) || [];
  }

  /**
   * 前十大股东：按当前持股排序（含 NPC 与玩家）
   * change/changePct = 当前持股与占比 − 开服/建仓时的持股与占比
   */
  computeTopHolders(stockId, limit = 10) {
    const stock = this.stocksById.get(stockId);
    if (!stock) return [];
    const total = stock.floatShares;
    const rows = [];
    for (const acc of this.store.all()) {
      if (acc.name === 'SYSTEM') continue;
      const qty = acc.longQty(stockId);
      if (qty <= 0) continue;
      const role = acc.isNPC ? acc.role || 'npc' : 'player';
      // NPC 的初始持股记录在账户上（每股一套 NPC 池，账户只属于一只股票）
      const base = acc.isNPC ? acc.initialLong || 0 : 0;
      rows.push({
        account: acc.name, // 快照与"我"的判定都按账号走，昵称改名不影响
        name: Game.displayName(acc),
        role, // inst / hot / big / mid / small / whale / player
        ai: !!acc.ai,
        aiLabel: acc.aiLabel || null,
        qty,
        pct: r2((qty / total) * 100),
        change: qty - base,
        changePct: r2(((qty - base) / total) * 100),
      });
    }
    rows.sort((a, b) => b.qty - a.qty || a.account.localeCompare(b.account));
    return rows.slice(0, limit);
  }

  // ---------- 股东快照（内存环形缓冲，重启清空） ----------

  /** 快照键：账号 + 股票。股东榜是每只股票一份，快照也必须按股票分开存 */
  static snapKey(name, stockId) {
    return `${name}#${stockId}`;
  }

  /**
   * 给某账户在某只股票上记一份「操作时刻」的股东快照。
   * 存的是当时按持股排序的前 N 名（含占比），既用来算「较上次操作」的变动，
   * 也用来画某个股东的占比走势。只走内存，不入库、重启清空。
   */
  snapshotHolders(acc, action, stockId) {
    if (!acc) return null;
    const rows = this.computeTopHolders(stockId, HOLDER_SNAPSHOT_ROWS).map((r) => ({
      account: r.account,
      name: r.name, // 记下当时的展示名，日后改名了曲线标签也还看得懂
      qty: r.qty,
      pct: r.pct,
    }));
    const snap = { t: Date.now(), tick: this.tickCount, action, stockId, rows };
    // 快照是不可变的，索引直接挂上去（不可枚举，不进 JSON）：
    // 每 tick 每条 SSE 连接都要查一次，别再重复建 Map。
    // **索引必须按账号**——按昵称的话玩家一改名，历史快照里那条就"查无此人"，
    // 「较上次操作」会整列变成新进
    const byAccount = new Map();
    for (const r of rows) byAccount.set(r.account, r);
    Object.defineProperty(snap, 'byAccount', { value: byAccount });
    const key = Game.snapKey(acc.name, stockId);
    let list = this._holderSnapshots.get(key);
    if (!list) {
      list = [];
      this._holderSnapshots.set(key, list);
    }
    list.push(snap);
    if (list.length > HOLDER_SNAPSHOT_LIMIT) list.splice(0, list.length - HOLDER_SNAPSHOT_LIMIT);
    return snap;
  }

  /** 某账户在某只股票上最近一次股东快照（没有则 null） */
  lastHolderSnapshot(name, stockId) {
    const list = this._holderSnapshots.get(Game.snapKey(name, stockId));
    return list && list.length ? list[list.length - 1] : null;
  }

  /**
   * 股东占比走势：本账户在某只股票上的快照序列里每个股东在各次操作时的持股与占比。
   * 客户端拿到后按点击的股东名自己抽曲线，省得每点一行都来回请求。
   */
  holderHistoryFor(token, stockIdRaw) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    const stockId = this.resolveStockId(stockIdRaw);
    if (!stockId) return { ok: false, error: '未知股票' };
    const list = this._holderSnapshots.get(Game.snapKey(acc.name, stockId)) || [];
    return {
      ok: true,
      account: acc.name,
      stockId,
      limit: HOLDER_SNAPSHOT_LIMIT,
      snapshots: list.map((s) => ({ t: s.t, tick: s.tick, action: s.action, rows: s.rows })),
    };
  }

  /**
   * 某只股票的前十大股东 + 两层变动（按需下发，见 /api/holders）：
   * - change / changePct：相对开服建仓
   * - prevQty / prevPct / dQty / dPct：相对本账户在该股上最近一次操作快照。
   *   没有快照（还没登录过）或该股东当时未进快照前 N 名时，这四个字段为 null，
   *   客户端据此显示「--」或「新进」，不做「上次持股按 0 算」的臆测
   */
  holdersFor(token, stockIdRaw) {
    const stockId = this.resolveStockId(stockIdRaw);
    if (!stockId) return { ok: false, error: '未知股票' };
    const acc = this.accountFor(token);
    const rows = this.topHolders(stockId);
    const snap = acc ? this.lastHolderSnapshot(acc.name, stockId) : null;
    const prev = snap ? snap.byAccount : null;
    const list = acc ? this._holderSnapshots.get(Game.snapKey(acc.name, stockId)) || [] : [];
    return {
      ok: true,
      stockId,
      stockName: this.stocksById.get(stockId).name,
      rows: rows.map((h) => {
        const p = prev ? prev.get(h.account) || null : null;
        return {
          account: h.account,
          name: h.name,
          role: h.role,
          ai: !!h.ai,
          aiLabel: h.aiLabel || null,
          qty: h.qty,
          pct: h.pct,
          change: h.change,
          changePct: h.changePct,
          prevQty: p ? p.qty : null,
          prevPct: p ? p.pct : null,
          dQty: p ? h.qty - p.qty : null,
          dPct: p ? r2(h.pct - p.pct) : null,
        };
      }),
      holderSnapshot: snap
        ? { t: snap.t, action: snap.action, count: list.length, limit: HOLDER_SNAPSHOT_LIMIT }
        : null,
    };
  }

  /** 某只股票的股东合计（校验流通盘用） */
  holdersSummary(stockIdRaw) {
    const stockId = this.resolveStockId(stockIdRaw);
    const stock = this.stocksById.get(stockId);
    if (!stock) return null;
    let total = 0;
    for (const acc of this.store.all()) {
      if (acc.name === 'SYSTEM') continue;
      total += acc.longQty(stockId);
    }
    return {
      stockId,
      longTotal: total,
      float: stock.floatShares,
      shortInterest: this.markets.get(stockId).shortInterest,
    };
  }

  /**
   * 某只标的（股票或指数）的分时序列。客户端切股票时按需拉全量，SSE 帧里不带，
   * 否则 10 只股票各 10300 点会把每帧撑到几 MB。
   */
  historyFor(stockIdRaw) {
    const stockId = this.resolveMarketId(stockIdRaw);
    if (!stockId) return { ok: false, error: '未知标的' };
    const market = this.markets.get(stockId);
    return { ok: true, stockId, priceHistory: market.priceHistory };
  }

  /**
   * 某只标的（股票或指数）的**已收盘日线**，K 线图按需拉取（切到日线模式 / 换股票时）。
   *
   * 只回已收盘的：当日那根要到收盘结算才定格（`settleDay`），此刻还没落盘，
   * 由客户端拿实时行情自己拼一根「正在走」的——这样它每帧都在动，不需要额外推送。
   * `today` 告诉客户端今天是第几个交易日，用来把重复的那根剔掉。
   */
  dailyFor(stockIdRaw, limit = 120) {
    const stockId = this.resolveMarketId(stockIdRaw);
    if (!stockId) return { ok: false, error: '未知标的' };
    const market = this.markets.get(stockId);
    const n = Math.max(1, Math.min(Number(limit) || 120, config.market.dailyBarsKeep || 260));
    return {
      ok: true,
      stockId,
      today: this.day.ok ? this.day.locate(Date.now()).day : null,
      bars: market.dailyBars.slice(-n),
    };
  }

  /**
   * 全部标的的**降采样**分时，只用于主页行情列表的迷你走势。
   * 全量分时是 10 只 × 10300 点（几 MB），首屏拉不动；这里每只压到 ~60 点，
   * 一次请求把所有股票的走势形状都拿到，之后客户端靠 SSE 自己往后追加。
   */
  sparksFor(points = 60) {
    const sparks = {};
    for (const [id, m] of this.markets) {
      const h = m.priceHistory;
      if (!h.length) {
        sparks[id] = [];
        continue;
      }
      const step = Math.max(1, Math.ceil(h.length / points));
      const out = [];
      for (let i = 0; i < h.length; i += step) out.push({ t: h[i].t, price: h[i].price, vol: h[i].vol });
      const tail = h[h.length - 1];
      if (out[out.length - 1].t !== tail.t) out.push({ t: tail.t, price: tail.price, vol: tail.vol });
      sparks[id] = out;
    }
    return { ok: true, sparks };
  }
}

module.exports = { Game, ACTIONS };
