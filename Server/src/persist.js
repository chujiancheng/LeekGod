/**
 * 持久化：账号 / 持仓 / 活动委托 / 成交流水 / 令牌 / 行情断点 / 日线
 *
 * 写入模型：游戏主循环每秒调一次 commit()，把该 tick 的全部变更放进**一个事务**提交，
 * 因此不存在"钱改了一半"的中间态。任何改动资金或持仓的路径都必须调 touch(account)，
 * 否则该账户不会被写库——config.persistence.sweepTicks 的轮转全量扫描是这件事的兜底。
 *
 * NPC 的报价单不落盘。它每 tick 重新报价，落盘反而会跟 NpcManager.ownResting 打架
 * （恢复出来却不在 ownResting 里的挂单永远撤不掉，变成幽灵单）。所以写 NPC 账户时把
 * 挂单冻结退回现金、批次预留归零：账实仍然守恒，只是重启后盘中报价重新生成。
 */
const config = require('./config');
const { openDatabase } = require('./db');
const { r2 } = require('./store');
const milestones = require('./milestones');
const { logger } = require('./logger');

const ORDER_HISTORY_KEEP = 100; // 每个账户保留的已完结委托行数（与内存 orderHistory 一致）
const TAPE_KEEP = 500; // 逐笔成交恢复条数（与 config.market.tradeTapeSize 一致）
const PRICE_KEEP_MS = 2 * 60 * 60 * 1000; // 分时序列保留窗口，与 priceHistorySize 同为 2 小时
const DAILY_KEEP = config.market.dailyBarsKeep || 260; // 日线恢复根数（与内存上限一致）
const PRUNE_EVERY_TICKS = 300;

class Persister {
  /** @param {string} file 存档文件路径 */
  constructor(file) {
    this.db = openDatabase(file);
    this.file = file;
    this.dirty = new Map(); // name -> Account，本 tick 待写账户
    this.pendingTrades = []; // 本 tick 待写成交
    this.pendingOrders = new Map(); // orderId -> order，本 tick 状态有变化的委托
    this.pendingAuto = new Map(); // strategyId -> strategy，本 tick 有变化的自动交易策略
    this.autoRemovals = new Set(); // 本 tick 删除的策略 id
    this.pendingBars = []; // 本 tick 定格的日线（每个交易日结算时每只标的至多一根）
    this.liveOrders = new Map(); // orderId -> 账户名，当前在册的活动委托
    this.tickCount = 0;
    this.sweepCursor = 0;
    this.stockId = null;
    this.lastHalt = ''; // 上次写库的停牌状态，用于跳过无变化的写入

    const db = this.db;
    this.st = {
      upsertAccount: db.prepare(`
        INSERT INTO accounts
          (name, is_npc, role, nick, home_stock, cash, order_frozen, short_margin, realized_pnl, initial_long, last_order_at, created_at, deposited,
           broker, broker_changed_at, broker_since_day, broker_stats, free_reselect_used, coupon_used_day, free_interest_day,
           milestones, avatar, broker_seen)
        VALUES
          (@name, @is_npc, @role, @nick, @home_stock, @cash, @order_frozen, @short_margin, @realized_pnl, @initial_long, @last_order_at, @created_at, @deposited,
           @broker, @broker_changed_at, @broker_since_day, @broker_stats, @free_reselect_used, @coupon_used_day, @free_interest_day,
           @milestones, @avatar, @broker_seen)
        ON CONFLICT(name) DO UPDATE SET
          is_npc = @is_npc, role = @role, nick = @nick, home_stock = @home_stock, cash = @cash, order_frozen = @order_frozen,
          short_margin = @short_margin, realized_pnl = @realized_pnl,
          initial_long = @initial_long, last_order_at = @last_order_at, deposited = @deposited,
          broker = @broker, broker_changed_at = @broker_changed_at, broker_since_day = @broker_since_day,
          broker_stats = @broker_stats, free_reselect_used = @free_reselect_used,
          coupon_used_day = @coupon_used_day, free_interest_day = @free_interest_day,
          milestones = @milestones, avatar = @avatar, broker_seen = @broker_seen
      `),
      delLedger: db.prepare('DELETE FROM stock_ledger WHERE account = ?'),
      insLedger: db.prepare(`
        INSERT INTO stock_ledger
          (account, stock_id, origin_qty, lend_offered, lend_interest_earned, lend_interest_debt, lend_interest_paid,
           lend_interest_accrued, finance_interest_accrued)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      delLots: db.prepare('DELETE FROM lots WHERE account = ?'),
      insLot: db.prepare(`
        INSERT INTO lots (account, stock_id, side, seq, qty, price, ts, reserved, margin, debt, principal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insOrder: db.prepare(`
        INSERT INTO orders (id, account, stock_id, seq, action, side, price, qty, filled, frozen, ts, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET filled = excluded.filled, frozen = excluded.frozen, status = excluded.status
      `),
      setOrderState: db.prepare('UPDATE orders SET filled = ?, frozen = ?, status = ? WHERE id = ?'),
      delOrder: db.prepare('DELETE FROM orders WHERE id = ?'),
      insTrade: db.prepare(`
        INSERT INTO trades (account, role, order_id, stock_id, action, side, price, qty, fee, trade_seq, t, broker, counter_broker)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      upsertMarket: db.prepare(`
        INSERT INTO market_state
          (stock_id, last_price, prev_close, open, high, low, volume, turnover, short_interest, order_seq, trade_seq,
           outer_vol, outer_amt, inner_vol, inner_amt, closed_day, updated_at)
        VALUES
          (@stock_id, @last_price, @prev_close, @open, @high, @low, @volume, @turnover, @short_interest, @order_seq, @trade_seq,
           @outer_vol, @outer_amt, @inner_vol, @inner_amt, @closed_day, @updated_at)
        ON CONFLICT(stock_id) DO UPDATE SET
          last_price = @last_price, prev_close = @prev_close, open = @open, high = @high, low = @low,
          volume = @volume, turnover = @turnover, short_interest = @short_interest,
          order_seq = @order_seq, trade_seq = @trade_seq,
          outer_vol = @outer_vol, outer_amt = @outer_amt, inner_vol = @inner_vol, inner_amt = @inner_amt,
          closed_day = @closed_day,
          updated_at = @updated_at
      `),
      // 日线：每个交易日结算时记下的那根 K 线（同一天重复结算走覆盖，不追加第二根）
      upsertBar: db.prepare(`
        INSERT INTO daily_bars
          (stock_id, day, open, high, low, close, volume, turnover, outer_vol, outer_amt, inner_vol, inner_amt, settled_at)
        VALUES
          (@stock_id, @day, @open, @high, @low, @close, @volume, @turnover, @outer_vol, @outer_amt, @inner_vol, @inner_amt, @settled_at)
        ON CONFLICT(stock_id, day) DO UPDATE SET
          open = @open, high = @high, low = @low, close = @close,
          volume = @volume, turnover = @turnover,
          outer_vol = @outer_vol, outer_amt = @outer_amt, inner_vol = @inner_vol, inner_amt = @inner_amt,
          settled_at = @settled_at
      `),
      upsertPrice: db.prepare('INSERT OR REPLACE INTO prices (stock_id, t, price, vol) VALUES (?, ?, ?, ?)'),
      prunePrices: db.prepare('DELETE FROM prices WHERE t < ?'),
      // 成交流水只保留最近 config.persistence.tradeKeepMs：读取侧（逐笔恢复、玩家成交记录）
      // 都只看最近的若干条，NPC 之间每 tick 都在成交，不裁这张表会无限膨胀
      pruneTrades: db.prepare('DELETE FROM trades WHERE t < ?'),
      pruneOrders: db.prepare(`
        DELETE FROM orders
         WHERE status <> 'live'
           AND id IN (
             SELECT x.id FROM orders AS x
              WHERE x.status <> 'live' AND x.account = orders.account
              ORDER BY x.ts DESC, x.id DESC LIMIT -1 OFFSET ?
           )
      `),
      insSession: db.prepare('INSERT OR REPLACE INTO sessions (token, account) VALUES (?, ?)'),
      delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
      setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      delMeta: db.prepare('DELETE FROM meta WHERE key = ?'),
      // 每日成交统计（/stats.html）：收盘结算定格一行 + 当日玩家排行整批重写
      upsertDailyTurnover: db.prepare(`
        INSERT INTO daily_turnover (day, player_amt, npc_amt, player_fills, npc_fills, settled_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET
          player_amt = excluded.player_amt, npc_amt = excluded.npc_amt,
          player_fills = excluded.player_fills, npc_fills = excluded.npc_fills,
          settled_at = excluded.settled_at
      `),
      delDailyPlayers: db.prepare('DELETE FROM daily_player_turnover WHERE day = ?'),
      insDailyPlayer: db.prepare(`
        INSERT INTO daily_player_turnover (day, account, amt, buy_amt, sell_amt, fills)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, account) DO UPDATE SET
          amt = excluded.amt, buy_amt = excluded.buy_amt,
          sell_amt = excluded.sell_amt, fills = excluded.fills
      `),
      loadDailyTurnover: db.prepare(`
        SELECT day, player_amt, npc_amt, player_fills, npc_fills, settled_at
          FROM daily_turnover ORDER BY day DESC LIMIT ? OFFSET ?
      `),
      countDailyTurnover: db.prepare('SELECT COUNT(*) AS n FROM daily_turnover'),
      // 只取交易日号（排行榜日选择下拉用，全量、很轻）
      listDailyTurnoverDays: db.prepare('SELECT day FROM daily_turnover ORDER BY day DESC'),
      loadDailyPlayers: db.prepare(`
        SELECT account, amt, buy_amt, sell_amt, fills
          FROM daily_player_turnover WHERE day = ? ORDER BY amt DESC
      `),
      clearDailyTurnover: db.prepare('DELETE FROM daily_turnover'),
      clearDailyPlayers: db.prepare('DELETE FROM daily_player_turnover'),
      insAuto: db.prepare(`
        INSERT INTO auto_strategies (id, account, stock_id, type, enabled, done, params, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          stock_id = excluded.stock_id,
          enabled = excluded.enabled, done = excluded.done, params = excluded.params,
          state = excluded.state, updated_at = excluded.updated_at
      `),
      delAuto: db.prepare('DELETE FROM auto_strategies WHERE id = ?'),
      allAuto: db.prepare('SELECT * FROM auto_strategies'),
      allAccounts: db.prepare('SELECT * FROM accounts'),
      allLedger: db.prepare('SELECT * FROM stock_ledger'),
      allLots: db.prepare('SELECT * FROM lots ORDER BY account, stock_id, side, seq'),
      liveOrders: db.prepare("SELECT * FROM orders WHERE status = 'live' ORDER BY ts, id"),
      // 多股票后每只股票各有自己的 seq，跨股票按时间排「最近委托」才正确
      orderHistory: db.prepare('SELECT * FROM orders WHERE account = ? ORDER BY ts DESC, id DESC LIMIT ?'),
      tradeHistory: db.prepare(`
        SELECT id, order_id, action, side, price, qty, trade_seq, t, stock_id
          FROM trades WHERE account = ? ORDER BY id DESC LIMIT ?
      `),
      allSessions: db.prepare('SELECT token, account FROM sessions'),
      marketState: db.prepare('SELECT * FROM market_state WHERE stock_id = ?'),
      // 某只标的最近若干根日线（新到旧，读取侧再反转成时间升序）
      recentBars: db.prepare('SELECT * FROM daily_bars WHERE stock_id = ? ORDER BY day DESC LIMIT ?'),
      recentPrices: db.prepare('SELECT t, price, vol FROM prices WHERE stock_id = ? ORDER BY t DESC LIMIT ?'),
      // 逐笔磁带的恢复：取主动方那一行，带上双方席位（broker / counter_broker）。
      // 升级到版本 4 之前写下的行没有席位列（NULL），那段磁带的席位显示为空
      recentTape: db.prepare(`
        SELECT trade_seq, t, price, qty, side, broker, counter_broker FROM trades
         WHERE role = 'taker' AND stock_id = ? ORDER BY trade_seq DESC LIMIT ?
      `),
    };

    this.commitTx = db.transaction((ctx) => this.commitInner(ctx));
  }

  // ---------- 写入侧 ----------

  /** 标记账户待落盘（改钱或改持仓后必须调用） */
  touch(account) {
    if (account && account.name !== 'SYSTEM') this.dirty.set(account.name, account);
  }

  /**
   * 委托状态有变化（新建 / 成交 / 撤单）。
   * 只记引用不记快照，落盘时取终态，所以同一 tick 里多次变化只会写一次，
   * 且"下单即成交"的委托也能进委托记录（它从没出现在内存挂单表里）。
   */
  orderChanged(order) {
    // NPC 报价单重启后重新生成；强平临时单不在内存委托历史里，两者都不入存档
    if (!order || order.force || !order.account || order.account.isNPC) return;
    this.pendingOrders.set(order.id, order);
    if (order.status === 'live') this.liveOrders.set(order.id, order.account.name);
    else this.liveOrders.delete(order.id);
  }

  /** 记录一笔成交（一笔撮合两个方向各调一次） */
  recordTrade(rec) {
    this.pendingTrades.push(rec);
  }

  /**
   * 定格了一根日线（flow.recordDailyBar 调）。
   * 与成交流水一样是本 tick 的追加数据，跟行情一起进同一个事务。
   */
  barChanged(stockId, bar) {
    if (!stockId || !bar) return;
    this.pendingBars.push({ stockId, bar });
  }

  /** 自动交易策略有变化（新建 / 触发 / 启停） */
  autoChanged(strategy) {
    if (strategy) this.pendingAuto.set(strategy.id, strategy);
  }

  /** 删除自动交易策略 */
  autoRemoved(id) {
    if (!id) return;
    this.pendingAuto.delete(id);
    this.autoRemovals.add(id);
  }

  addSession(token, account) {
    this.st.insSession.run(token, account);
  }

  removeSession(token) {
    this.st.delSession.run(token);
  }

  /** 读一条 meta（不存在返回 ''） */
  getMeta(key) {
    const row = this.st.getMeta.get(key);
    return row ? row.value : '';
  }

  /** 写一条 meta（交易日结算进度等小状态；大对象不要往这里塞） */
  setMeta(key, value) {
    this.st.setMeta.run(String(key), String(value));
  }

  /** 删一条 meta（不存在时静默） */
  delMeta(key) {
    this.st.delMeta.run(String(key));
  }

  /**
   * 定格一个交易日的成交统计（/stats.html，聚合来自 Game.writeTurnoverDay）。
   * 当日玩家排行整批重写（先删后插）：收盘后这一天的数据不再变化，重写幂等，
   * 崩溃补结算时重复写也只会得到同一份值。
   * @param {number} day 交易日号
   * @param {{playerAmt:number, npcAmt:number, playerFills:number, npcFills:number}} agg 全市场聚合
   * @param {Map<string,{amt:number,buyAmt:number,sellAmt:number,fills:number}>} accts 玩家排行
   */
  recordDailyTurnover(day, agg, accts) {
    const tx = this.db.transaction(() => {
      this.st.upsertDailyTurnover.run(
        day, agg.playerAmt, agg.npcAmt, agg.playerFills, agg.npcFills, Date.now()
      );
      this.st.delDailyPlayers.run(day);
      for (const [name, r] of accts) {
        this.st.insDailyPlayer.run(day, name, r.amt, r.buyAmt, r.sellAmt, r.fills);
      }
    });
    tx();
  }

  /**
   * 分页取成交统计（新→旧），供 /api/stats/turnover 的每日趋势：
   * 页大小由调用方定（当前 30），totalDays 供前端算总页数画分页器。
   */
  loadDailyTurnover(limit = 30, offset = 0) {
    return this.st.loadDailyTurnover.all(limit, offset).map((r) => ({
      day: r.day,
      playerAmt: r.player_amt,
      npcAmt: r.npc_amt,
      playerFills: r.player_fills,
      npcFills: r.npc_fills,
      settledAt: r.settled_at,
    }));
  }

  /** 已收盘定格的交易日总数（每日趋势分页用） */
  countDailyTurnover() {
    return this.st.countDailyTurnover.get().n;
  }

  /** 全部已收盘的交易日号（新→旧），供排行榜的日选择下拉（不受每日趋势分页影响） */
  loadDailyTurnoverDays() {
    return this.st.listDailyTurnoverDays.all().map((r) => r.day);
  }

  /** 某个交易日的玩家成交排行（按成交金额降序） */
  loadDailyPlayers(day) {
    return this.st.loadDailyPlayers.all(day);
  }

  /**
   * 新开一局：记下开局时间并清掉上一局的行情断点，行情由首个 tick 的 commit 写入。
   * 多股票下 prices/market_state 每只股票各一行，按 stock_id 区分，不需要按股票清表。
   */
  startRound(startedAt) {
    this.st.setMeta.run('round_started_at', String(startedAt));
    // 新一局的交易日号从 1 重新数起，上一局的成交统计必须清掉，
    // 否则新一局第 1 天的收盘定格会与旧局的第 1 天撞主键
    this.st.clearDailyTurnover.run();
    this.st.clearDailyPlayers.run();
    this.st.delMeta.run('turnover_live');
  }

  /**
   * 每 tick 一次：账户 + 委托对账 + 成交 + 行情，全部在一个事务里。
   * @param {{now:number, markets:Array, allAccounts:Array}} ctx
   *   markets 是「本 tick 要落盘的行情对象」列表：10 只股票的 Market + 1 个大盘指数。
   *   指数的落盘接口与 Market 对齐（stockId/lastPrice/priceHistory…），所以这里不区分两者。
   */
  commit({ now, markets, allAccounts }) {
    this.commitTx({ now, markets, allAccounts });
  }

  commitInner({ now, markets, allAccounts }) {
    this.tickCount += 1;

    // 成交流水先「摘走」再写：后面任何一步（writeAccount / upsertBar / prune / 事务提交）
    // 抛错都不会把这一批留在 pendingTrades 里。旧实现把清空放在写入之后，
    // 一旦 commit 中途抛出，下一 tick 就在旧队列上再叠一层——长跑几小时即 heap OOM
    const trades = this.pendingTrades;
    this.pendingTrades = [];

    for (const acc of this.dirty.values()) this.writeAccount(acc);
    this.dirty.clear();

    this.writeOrders();
    this.writeAutos();
    this.verifyLiveOrders(allAccounts);

    // 成交流水：单行失败只丢这一行（并 warn），不牵连同批其它行、更不拖垮队列
    let tradeFail = 0;
    for (const r of trades) {
      try {
        this.st.insTrade.run(
          r.account, r.role, r.orderId, r.stockId, r.action, r.side, r.price, r.qty, r.fee, r.tradeSeq, r.t,
          r.broker || null, r.counterBroker || null
        );
      } catch (e) {
        tradeFail += 1;
      }
    }
    if (tradeFail) {
      logger.warn(`[存档] 本 tick 有 ${tradeFail} 条成交流水写入失败，已丢弃（账面资金不受影响）`);
    }
    // 成交流水每 tick 裁一次（带 idx_trades_t 的区间删除，稳态下删的行数≈本 tick 新写的行数）：
    // 体量因此被压在「保留窗口 × 成交速度」，不会像 prices/orders 那样攒到几百轮再删
    const tradeKeepMs = config.persistence.tradeKeepMs;
    if (tradeKeepMs > 0) this.st.pruneTrades.run(now - tradeKeepMs);

    let halt = '';
    for (const m of markets) {
      this.st.upsertMarket.run({
        stock_id: m.stockId,
        last_price: m.lastPrice,
        prev_close: m.prevClose,
        open: m.open,
        high: m.high,
        low: m.low,
        volume: m.volume,
        turnover: m.turnover,
        short_interest: m.shortInterest,
        order_seq: m.orderSeq,
        trade_seq: m.trades.length ? m.trades[0].seq : 0,
        outer_vol: m.outerVol || 0,
        outer_amt: m.outerAmt || 0,
        inner_vol: m.innerVol || 0,
        inner_amt: m.innerAmt || 0,
        closed_day: m.closedDay ? JSON.stringify(m.closedDay) : null,
        updated_at: now,
      });
      const h = m.priceHistory;
      if (h.length) {
        const p = h[h.length - 1];
        this.st.upsertPrice.run(m.stockId, p.t, p.price, p.vol);
      }
      // 停牌状态只在变化时写：meta 是单行覆盖，没必要每秒重写一次同样的值。
      // 多股票是**全市场一起停**，所有市场共用一份状态，取第一只的即可（见 Game.halt）
      if (!halt) halt = JSON.stringify({ until: m.haltUntil || 0, reason: m.haltReason || '' });
    }
    if (halt && halt !== this.lastHalt) {
      this.st.setMeta.run('halt', halt);
      this.lastHalt = halt;
    }

    // 本 tick 定格的日线：每个交易日收盘结算时每只标的（含指数）至多一根
    for (const { stockId, bar } of this.pendingBars) {
      this.st.upsertBar.run({
        stock_id: stockId,
        day: bar.day,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        turnover: bar.turnover,
        outer_vol: bar.outerVol,
        outer_amt: bar.outerAmt,
        inner_vol: bar.innerVol,
        inner_amt: bar.innerAmt,
        settled_at: bar.t,
      });
    }
    this.pendingBars.length = 0;

    this.sweep(allAccounts);

    if (this.tickCount % PRUNE_EVERY_TICKS === 0) {
      this.st.prunePrices.run(now - PRICE_KEEP_MS);
      this.st.pruneOrders.run(ORDER_HISTORY_KEEP);
    }
  }

  /**
   * 本 tick 有状态变化的委托按终态写库。
   * pendingOrders 存的是订单对象引用，所以撮合过程中同一单被反复标记也只写一次最终状态。
   * 股票取订单自身的 stockId（多股票下不再由「当前市场」推断）。
   */
  writeOrders() {
    for (const o of this.pendingOrders.values()) {
      this.st.insOrder.run(
        o.id, o.account.name, o.stockId, o.seq, o.action, o.side,
        o.price, o.qty, o.filled, o.frozen, o.ts, o.status
      );
    }
    this.pendingOrders.clear();
  }

  /** 本 tick 有变化的自动交易策略写库；params/state 整段 JSON 覆盖 */
  writeAutos() {
    for (const id of this.autoRemovals) this.st.delAuto.run(id);
    this.autoRemovals.clear();
    for (const s of this.pendingAuto.values()) {
      this.st.insAuto.run(
        s.id, s.account, s.stockId, s.type, s.enabled ? 1 : 0, s.done ? 1 : 0,
        JSON.stringify(s.params), JSON.stringify(s.state || {}), s.createdAt, s.updatedAt
      );
    }
    this.pendingAuto.clear();
  }

  /**
   * 自愈扫尾：在册委托若已不在内存挂单表，说明收尾钩子漏了，
   * 按内存委托历史把终态补上（查不到说明该单已被挤出 100 条之外，直接删行）。
   */
  verifyLiveOrders(allAccounts) {
    if (this.liveOrders.size === 0) return;
    const byName = new Map();
    for (const acc of allAccounts) byName.set(acc.name, acc);

    for (const [id, name] of this.liveOrders) {
      const acc = byName.get(name);
      if (acc && acc.orders.has(id)) continue;
      const done = acc ? acc.orderHistory.find((o) => o.id === id) : null;
      if (done) this.st.setOrderState.run(done.filled, done.frozen || 0, done.status, id);
      else this.st.delOrder.run(id);
      this.liveOrders.delete(id);
    }
  }

  /** 轮转全量扫描：分摊到每个 tick 写一小批，边界成本可忽略 */
  sweep(allAccounts) {
    const sweepTicks = config.persistence.sweepTicks;
    if (!sweepTicks || allAccounts.length === 0) return;
    const per = Math.max(1, Math.ceil(allAccounts.length / sweepTicks));
    for (let i = 0; i < per; i++) {
      this.writeAccount(allAccounts[(this.sweepCursor + i) % allAccounts.length]);
    }
    this.sweepCursor = (this.sweepCursor + per) % allAccounts.length;
  }

  writeAccount(acc) {
    const isNpc = acc.isNPC ? 1 : 0;
    // NPC 报价单不落盘，对应的冻结与预留必须一起撤掉，否则重启后资金被永久冻住
    const orderFrozen = isNpc ? 0 : acc.orderFrozen;
    const cash = isNpc ? r2(acc.cash + acc.orderFrozen) : acc.cash;

    this.st.upsertAccount.run({
      name: acc.name,
      is_npc: isNpc,
      role: acc.role,
      // 昵称：玩家填的、NPC 由 identity.js 生成的真实姓名（曹俊（杭州））。
      // 这里曾经对 NPC 写 null（那时名字由账户名 `大米·游资1` 派生，落一份是冗余）——
      // 名字与账号分家之后 nick 是**唯一**的展示名来源，必须落盘，否则重启后
      // 股东榜会退回 npc-0312 这种内部键
      nick: acc.nick || null,
      // NPC 的"常住"股票（归属），玩家为 NULL
      home_stock: acc.homeStock || null,
      cash,
      order_frozen: orderFrozen,
      short_margin: acc.shortMargin,
      realized_pnl: acc.realizedPnL,
      initial_long: acc.initialLong,
      last_order_at: acc.lastOrderAt,
      created_at: acc.createdAt,
      deposited: acc.deposited || 0,
      // NPC 的券商是账户名派生的标签，**不落盘**（落盘会踩「NPC 逐 tick 标脏」的禁忌，
      // 也会让存档里多出一份与账户名冗余、且可能不一致的副本）。重启后按账户名重算即可
      broker: isNpc ? null : acc.broker || null,
      broker_changed_at: isNpc ? null : acc.brokerChangedAt || null,
      broker_since_day: isNpc ? null : (acc.brokerSinceDay == null ? null : acc.brokerSinceDay),
      broker_stats: isNpc || !acc.brokerStats || !Object.keys(acc.brokerStats).length
        ? null
        : JSON.stringify(acc.brokerStats),
      free_reselect_used: isNpc || acc.freeReselectUsed ? 1 : 0,
      coupon_used_day: isNpc ? null : (acc.couponUsedDay == null ? null : acc.couponUsedDay),
      free_interest_day: isNpc ? null : (acc.freeInterestDay == null ? null : acc.freeInterestDay),
      // 彩蛋里程碑：**NPC 写 NULL**（与券商那几列同规矩）——写它等于让 3160 个 NPC
      // 每 tick 都有变化可写，踩的就是「NPC 逐 tick 标脏」这条禁忌
      milestones: isNpc || !acc.milestones ? null : milestones.serialize(acc.milestones),
      // 头像与「待过的券商」：同样**只对玩家写**。NPC 的脸是现算的派生脸（avatar.of），
      // 落盘等于每 tick 都有变化可写；`broker_seen` 去重后是逗号串，空数组写 NULL
      avatar: isNpc ? null : acc.avatar || null,
      broker_seen: isNpc || !Array.isArray(acc.brokerSeen) || !acc.brokerSeen.length
        ? null
        : acc.brokerSeen.join(','),
    });

    // 按股票的融券/融资计息明细：整段重写（行数很少，省去逐行 diff 的复杂度）。
    // 没有挂借也没有欠息的股票不写行，避免 NPC 的 3160 个账户各写 10 行空数据。
    // `originQty` 必须进这个判断：NPC 把初始持仓卖光之后，这一行就只剩它一个非零值，
    // 漏掉的话重启后初始持仓归零、股东榜的"变动"列会凭空多出一大截
    this.st.delLedger.run(acc.name);
    for (const [stockId, led] of acc.ledger) {
      if (
        !led.originQty &&
        !led.lendOffered &&
        !led.lendInterestEarned &&
        !led.lendInterestDebt &&
        !led.lendInterestPaid &&
        !led.lendInterestAccrued &&
        !led.financeInterestAccrued
      ) {
        continue;
      }
      this.st.insLedger.run(
        acc.name, stockId,
        led.originQty || 0,
        led.lendOffered || 0,
        led.lendInterestEarned || 0, led.lendInterestDebt || 0,
        led.lendInterestPaid || 0, led.lendInterestAccrued || 0, led.financeInterestAccrued || 0
      );
    }

    this.st.delLots.run(acc.name);
    for (const [stockId, pos] of acc.longs) {
      for (let i = 0; i < pos.lots.length; i++) {
        const lot = pos.lots[i];
        this.st.insLot.run(
          acc.name, stockId, 'long', i, lot.qty, lot.price, lot.ts ?? null,
          isNpc ? 0 : lot.reserved || 0, 0, lot.debt || 0, lot.principal || 0
        );
      }
    }
    for (const [stockId, pos] of acc.shorts) {
      for (let i = 0; i < pos.lots.length; i++) {
        const lot = pos.lots[i];
        this.st.insLot.run(
          acc.name, stockId, 'short', i, lot.qty, lot.price, lot.ts ?? null,
          isNpc ? 0 : lot.reserved || 0, lot.margin, 0, 0
        );
      }
    }
  }

  // ---------- 读取侧 ----------

  /**
   * 读回上一局存档。resumed=false 表示没有可续跑的存档（全新开局）。
   * 返回的都是库里的原始行，由 game.js 负责重建对象。
   * @param {string[]} stockIds 本局全部标的（10 只股票 + 指数代码），逐只读行情断点与分时
   */
  loadAll(stockIds) {
    const startedRow = this.st.getMeta.get('round_started_at');
    const daySettledRow = this.st.getMeta.get('day_settled');
    // 做空利息按游戏日结算：已收到第几个交易日，续跑时不许重复收同一天
    const lendSettledRow = this.st.getMeta.get('lend_settled');
    // 空头存量披露水位线：{day, at, values:{stockId: qty}}，空/坏一律当「没披露过」
    const shortPub = this.readJsonMeta('short_pub');
    const halt = this.readHalt();
    const accounts = this.st.allAccounts.all();
    const ledger = this.st.allLedger.all();
    const lots = this.st.allLots.all();
    const orders = this.st.liveOrders.all();
    const sessions = this.st.allSessions.all();
    const auto = this.st.allAuto.all();

    // 逐只读行情：market_state 一行 + prices 一路分时（升序，对齐 market.priceHistory）
    // + 逐笔（新到旧，对齐 market.trades）+ 日线（升序，对齐 market.dailyBars）
    const markets = new Map();
    for (const id of stockIds) {
      markets.set(id, {
        state: this.st.marketState.get(id) || null,
        prices: this.st.recentPrices.all(id, config.market.priceHistorySize).reverse(),
        tape: this.st.recentTape.all(id, TAPE_KEEP),
        bars: this.st.recentBars.all(id, DAILY_KEEP).reverse(),
      });
    }
    // 只要有任意一只存在行情断点就算续跑（本轮新增的股票可能是空的）
    const resumed = !!startedRow && accounts.length > 0 && [...markets.values()].some((m) => !!m.state);

    // 回填在册活动委托集合，供 commit 时的自愈扫尾判断
    this.liveOrders.clear();
    for (const o of orders) this.liveOrders.set(o.id, o.account);

    return {
      resumed,
      startedAt: startedRow ? Number(startedRow.value) : null,
      // 已结算到第几个交易日：续跑时据此补做停机期间错过的日终结算
      daySettled: daySettledRow ? Number(daySettledRow.value) || 0 : 0,
      // 做空利息已结算到第几个交易日：续跑时不许重复收同一天。
      // **-1 = 老档没有这条记录**（还没按日结过），不能写 0——0 是第 1 个交易日的合法水位线，
      // 写成 0 会让续跑后的第一个收盘以为「day 0 已经收过」而跳过
      lendSettled: lendSettledRow ? Number(lendSettledRow.value) : -1,
      // 空头存量已披露到第几天、各股定格多少股（null = 还没披露过，展示层退回实时值）
      shortPub,
      halt,
      accounts,
      ledger,
      lots,
      orders,
      sessions,
      markets,
      auto,
    };
  }

  /**
   * 读回停牌状态。存档坏掉就当没停牌——停牌是个运营开关，
   * 不能因为一行 JSON 解析失败让这一局再也开不了盘。
   */
  readHalt() {
    const row = this.st.getMeta.get('halt');
    let halt = null;
    if (row) {
      try {
        halt = JSON.parse(row.value);
      } catch (e) {
        halt = null;
      }
    }
    // 坏值不记入 lastHalt，首个 commit 会把它覆盖掉
    this.lastHalt = halt ? row.value : '';
    return halt;
  }

  /**
   * 读一条 JSON meta。存档坏掉/格式不对一律返回 null，由调用方按「没有这条记录」处理——
   * 展示类的落盘状态（空头存量披露水位线）绝不能因为一行 JSON 解析失败卡住启动。
   */
  readJsonMeta(key) {
    const row = this.st.getMeta.get(key);
    if (!row) return null;
    try {
      const v = JSON.parse(row.value);
      return v && typeof v === 'object' ? v : null;
    } catch (e) {
      return null;
    }
  }

  /** 玩家委托记录：活动委托用内存对象（状态会随成交变化），已完结的用库里的快照 */
  orderHistory(account, limit = ORDER_HISTORY_KEEP) {
    return this.st.orderHistory.all(account.name, limit).map(
      (r) =>
        account.orders.get(r.id) || {
          id: r.id,
          stockId: r.stock_id,
          action: r.action,
          price: r.price,
          qty: r.qty,
          filled: r.filled,
          status: r.status,
          ts: r.ts,
        }
    );
  }

  /** 存档里已有的最大成交序号：重启时用它把全局计数器抬到旧值之上（`/fills` 游标不回退） */
  maxTradeSeq() {
    const row = this.db.prepare('SELECT MAX(trade_seq) AS n FROM trades').get();
    return row && row.n ? Number(row.n) : 0;
  }

  /** 玩家成交记录，字段与 market.execute 里生成的流水一致 */
  tradeHistory(account, limit = ORDER_HISTORY_KEEP) {
    return this.st.tradeHistory.all(account.name, limit).map((r) => ({
      id: `T${r.trade_seq}-${r.order_id}-${r.qty}`,
      orderId: r.order_id,
      stockId: r.stock_id,
      action: r.action,
      side: r.side,
      price: r.price,
      qty: r.qty,
      t: r.t,
      // 成交序号也要恢复：`/open/v1/fills` 的增量游标靠它。库里存的是写入时的
      // 全服序号，重启时 Game 会从这个最大值继续往上发号，游标不会回退
      seq: r.trade_seq,
    }));
  }

  close() {
    this.db.close();
  }
}

module.exports = { Persister };
