/**
 * 游戏主循环：NPC/消息推进、风控扫描、分时记录、状态快照、存档
 * 存档器由外部注入（见 index.js）：未注入时纯内存运行，测试脚本即走这条路径。
 */
const crypto = require('crypto');
const config = require('./config');
const { logger } = require('./logger');
const { Store, Account, r2 } = require('./store');
const { Market, ACTIONS } = require('./market');
const { NewsSystem } = require('./news');
const { NpcManager, normalizeNpcType } = require('./npc');
const { AutoManager } = require('./auto');
const { IndexFeed } = require('./indexfeed');
const { DayCycle } = require('./daycycle');
const flow = require('./flow');

const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{1,16}$/;

// 同一账户最多保留的活跃令牌数（多标签页够用，防止 sessions 无界增长）
const MAX_SESSIONS_PER_ACCOUNT = 5;

// 股东快照：每个账户保留最近若干次自己的操作快照（内存环形缓冲，重启清空）。
// 快照给「较上次操作」的变动列和股东占比走势图提供基线与历史点。
const HOLDER_SNAPSHOT_LIMIT = 30;
// 每份快照记多少名股东：覆盖当前前十并留余量，否则刚被挤出前十的股东算不出变动
const HOLDER_SNAPSHOT_ROWS = 30;

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
      this.markets.set(stock.id, market);
      this.npcs.set(stock.id, new NpcManager(market, null, this.store));
    }
    this.news = new NewsSystem(this.stocks);
    for (const npc of this.npcs.values()) npc.news = this.news;

    this.index = new IndexFeed(this.stocks);
    this.markets.set(this.index.stockId, this.index); // 指数也进 markets：取价、落盘、广播一视同仁
    // 指数与个股共用同一套日线/资金记账（flow.js），所以也要有时钟与落盘句柄：
    // 时钟用来判断「当日数据属于哪一天」，句柄用来把定格的日线写进 daily_bars
    this.index.journal = opts.persist || null;
    this.index.dayCycle = this.day;

    this.auto = new AutoManager(this.markets, this.stocksById, this.store);
    this.persist = opts.persist || null;
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

    const byName = new Map();
    for (const row of snap.accounts) {
      const acc = new Account(row.name, !!row.is_npc, row.role);
      acc.cash = row.cash;
      acc.orderFrozen = row.order_frozen;
      acc.shortMargin = row.short_margin;
      acc.realizedPnL = row.realized_pnl;
      acc.initialLong = row.initial_long;
      acc.lastOrderAt = row.last_order_at;
      acc.createdAt = row.created_at;
      acc.deposited = row.deposited || 0;
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
      }));
    }

    // 指数断点：点位直接读存档，分时与成分由价格推出
    const idxSnap = snap.markets?.get(this.index.stockId);
    this.index.applyState(idxSnap && idxSnap.state, idxSnap && idxSnap.prices);
    flow.restoreFlow(this.index, idxSnap && idxSnap.state, idxSnap && idxSnap.bars);
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
      // 公允价值/重心/趋势阶段/情绪结构不落盘（随机游走的中间量），重新锚到现价
      npc.fairValue = market.lastPrice;
      npc.fund = market.lastPrice;
      npc.regime = 0;
      npc.regimeIn = 0;
      npc.trendDrift = 0;
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
      let bias = 0;
      for (const npc of this.npcs.values()) bias += npc.regime * config.news.regimeBias;
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
      const news = this.news.maybeEmit(now, bias, { phaseKey, untilFloor });
      if (news) this.lastNews = news;
    }

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
        // 融券利息：空头按 tick 付给出借方，券源越少利率越高
        market.accrueLendingInterest(now);
        // 做空欠息追缴：现金/保证金恢复后优先补缴历史欠息
        market.collectLendingDebt();
        // 融资利息：摊入批次负债并计入已实现盈亏，现金越紧利率越高
        market.accrueFinanceInterest(now);
      }
      // 空头仓位 5 分钟采样（停牌也记，走势图不断点）
      market.sampleShortInterest(now);

      // 分时序列（每 tick 一个点，vol 为累计成交量供客户端算柱）；停牌补平线，走势图不断点
      const h = market.priceHistory;
      h.push({ t: now, price: market.lastPrice, vol: market.volume });
      // 保留最近 N 个点：push 在尾部，截断必须从头丢，h.length=N 会把最新点砍掉导致分时冻住
      if (h.length > config.market.priceHistorySize) {
        h.splice(0, h.length - config.market.priceHistorySize);
      }
    }

    // 玩家自动化策略（按策略所属股票逐个判断停牌与休市）
    if (active) this.auto.step(now);

    // 大盘指数：用各股最新价合成点位并记分时
    this.index.update(this.markets, now);

    // 排行榜/股东按 tick 算一次，避免每个 SSE 连接各算一遍
    this.refreshStats();
    this.broadcast();

    // 本 tick 的全部变更（账户、委托、成交、行情）在一个事务里落盘。
    // markets 含 10 只股票 + 指数，接口同构所以一起写
    this.persist?.commit({ now, markets: [...this.markets.values()], allAccounts });
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
   * 今开/最高/最低/成交量额归零，活动委托全部作废。
   * `_daySettled` 记的是**哪一天的收盘已经滚进昨收**：
   * 夜间结算时是今天；次日盘中补结时是昨天（今天还没收盘，不能记成今天，
   * 否则今晚的日终结算会被跳过）。
   */
  settleDay(now = Date.now(), opts = {}) {
    const st = this.day.ok ? this.day.locate(now) : null;
    const completedDay = st ? (st.phase.key === 'night' ? st.day : st.day - 1) : 0;
    // 指数的量额与内外盘是**成分股合计**，必须在成分股被清零之前重算一遍：
    // 否则指数那根日线的量额会落成 0，收盘竞价那批成交更会整个丢掉
    this.index.recompute(this.markets);
    let canceled = 0;
    for (const stock of this.stocks) {
      canceled += this.markets
        .get(stock.id)
        .settleDay(now, { cancelOrders: opts.cancelOrders, day: completedDay }).canceled;
    }
    this.index.settleDay(now, { day: completedDay });
    if (completedDay >= 1) this._daySettled = completedDay;
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

  /**
   * 登录：输入账号名即进入，同名始终对应同一个账户（首次输入即创建）。
   * 无密码设计；令牌仅用于把请求绑定到会话，不做账号独占。
   */
  login(name) {
    name = String(name || '').trim();
    if (!NAME_RE.test(name)) {
      return { ok: false, error: '账号需为 1-16 位中文、字母、数字或下划线' };
    }
    const existing = this.store.get(name);
    if (!existing && this.store.playerCount >= config.account.maxAccounts) {
      return { ok: false, error: '本局账号已达上限，请稍后再试' };
    }
    const acc = this.store.createOrGet(name);
    // 新账户立刻纳入落盘范围，避免仅登录不下单的账号在重启后消失
    this.persist?.touch(acc);
    const t = this.newToken();
    this.sessions.set(t, acc.name);
    this.persist?.addSession(t, acc.name);
    this.trimSessions(acc.name);
    // 登录即给每只股票各留一份基线快照：不动手也能在任一只股票上看到「较上次操作」的变动。
    // 快照按 (账号, 股票) 存，所以这里要逐只记，不能只记一只
    for (const stock of this.stocks) this.snapshotHolders(acc, 'login', stock.id);
    if (!existing) this.refreshStats();
    return { ok: true, name: acc.name, token: t };
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
   * 下单。stockId 必填；指数不可交易；下单按股票路由到各自的市场。
   * 账户冷却跨股票共享：2 秒内不管下哪只都算同一笔冷却，防止刷单。
   */
  placeOrder(token, body) {
    const acc = this.accountFor(token);
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

  /** 撤单：按委托自身所属股票路由（交易所有各自的簿，撤单必须找对市场） */
  cancelOrder(token, orderId) {
    const acc = this.accountFor(token);
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

  // ---------- 状态快照 ----------

  cooldownLeft(acc, now) {
    if (acc.lastOrderAt == null) return 0;
    return Math.max(0, config.trade.cooldownMs - (now - acc.lastOrderAt));
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
    const base = {
      serverTime: now,
      startedAt: this.startedAt,
      markets,
      index,
      // 交易日时钟（全市场共用一份）：第几天、哪个阶段、还剩多久、游戏内时刻
      day: this.day.snapshot(now),
      // 兼容字段：老客户端只认单个 market。取第一只股票，新客户端一律走 markets
      market: markets[0],
      news: this.news.tapeSnapshot(50),
      lastNews: this.lastNews,
      rules: {
        feeRate: config.trade.feeRate,
        cooldownMs: config.trade.cooldownMs,
        lockMs: config.trade.lockMs,
        marginRatio: config.margin.ratio,
        maintenance: config.margin.maintenance,
        allowNakedShort: !!config.margin.allowNakedShort,
        lending: {
          enabled: !!(config.margin.lending && config.margin.lending.enabled),
          baseMinuteRate: config.margin.lending ? config.margin.lending.baseMinuteRate : 0,
          maxMinuteRate: config.margin.lending ? config.margin.lending.maxMinuteRate : 0,
        },
        finance: {
          enabled: !!(config.margin.finance && config.margin.finance.enabled),
          ratio: config.margin.finance ? config.margin.finance.ratio : 1,
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
        index: { code: this.index.stockId, name: this.index.stock.name, base: this.index.base },
        stocks: this.stocks.map((s) => ({
          id: s.id,
          name: s.name,
          alias: s.alias,
          lotSize: s.lotSize,
          floatShares: s.floatShares,
        })),
        deposit: {
          enabled: !!config.account.deposit.enabled,
          maxLifetime: config.account.deposit.maxLifetime,
          minPerTime: config.account.deposit.minPerTime,
          presets: config.account.deposit.presets,
        },
        auto: {
          maxPerAccount: config.auto.maxPerAccount,
          dcaMinIntervalMs: config.auto.dcaMinIntervalMs,
          grid: config.auto.grid,
          ma: config.auto.ma,
        },
      },
      players: stats.players,
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
  serializePosition(acc, stock, now) {
    const sid = stock.id;
    const market = this.markets.get(sid);
    const last = market.lastPrice;
    const longPos = acc.longs.get(sid);
    const shortPos = acc.shorts.get(sid);
    let longCost = 0;
    const longLots = [];
    if (longPos) {
      for (const lot of longPos.lots) {
        longCost += lot.qty * lot.price;
        const lockedUntil = lot.ts + config.trade.lockMs;
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
        sellable: acc.freeSellableLong(sid, now),
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
      lending: this.serializeLending(acc, sid),
    };
  }

  serializeAccount(acc, now) {
    const positions = [];
    for (const stock of this.stocks) {
      const p = this.serializePosition(acc, stock, now);
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

    const riskDebt = r2(debt + lendDebt);
    return {
      name: acc.name,
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
      // 风险度 = （空头市值 + 融资负债 + 做空欠息）/ 权益
      marginUsage: riskDebt > 0 && equity > 0 ? r2(((shortValue + riskDebt) / equity) * 100) : 0,
      orders,
      orderHistory,
      trades,
      liquidations: (acc.liquidations || []).slice(0, 5),
      auto: this.auto.serializeAll(acc.name, now),
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
  serializeLending(acc, stockId) {
    const m = this.markets.get(stockId);
    const stock = this.stocksById.get(stockId);
    const led = acc.ledger.get(stockId);
    const offered = led ? led.lendOffered || 0 : 0;
    const lentOut = Math.floor(offered * m.lendUtilization());
    // 可撤口径必须与撤借闸门一致（含在途开空占用），否则 UI 显示可撤、点撤借却被拒
    const removable = m.lendRemovableQty(acc);
    const free = acc.freeSellableLong(stockId, Date.now());
    return {
      stockId,
      offered,
      lentOut,
      removable,
      freeToLend: Math.max(0, Math.floor(free / stock.lotSize) * stock.lotSize),
      interestEarned: r2(led ? led.lendInterestEarned || 0 : 0),
      interestDebt: r2(led ? led.lendInterestDebt || 0 : 0),
      interestPaid: r2(led ? led.lendInterestPaid || 0 : 0),
    };
  }

  /** 玩家资产排行（组合口径：跨全部股票的总权益） */
  leaderboard() {
    const priceOf = (s) => this.markets.get(s).lastPrice;
    return this.store
      .players()
      .map((a) => ({ name: a.name, equity: r2(a.equity(priceOf)) }))
      .sort((x, y) => y.equity - x.equity)
      .slice(0, 20);
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
        name: acc.name,
        role, // inst / hot / big / mid / small / player
        qty,
        pct: r2((qty / total) * 100),
        change: qty - base,
        changePct: r2(((qty - base) / total) * 100),
      });
    }
    rows.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
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
      name: r.name,
      qty: r.qty,
      pct: r.pct,
    }));
    const snap = { t: Date.now(), tick: this.tickCount, action, stockId, rows };
    // 快照是不可变的，索引直接挂上去（不可枚举，不进 JSON）：
    // 每 tick 每条 SSE 连接都要查一次，别再重复建 Map
    const byName = new Map();
    for (const r of rows) byName.set(r.name, r);
    Object.defineProperty(snap, 'byName', { value: byName });
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
    const prev = snap ? snap.byName : null;
    const list = acc ? this._holderSnapshots.get(Game.snapKey(acc.name, stockId)) || [] : [];
    return {
      ok: true,
      stockId,
      stockName: this.stocksById.get(stockId).name,
      rows: rows.map((h) => {
        const p = prev ? prev.get(h.name) || null : null;
        return {
          name: h.name,
          role: h.role,
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
