/**
 * 持久化：账号 / 持仓 / 活动委托 / 成交流水 / 令牌 / 行情断点
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

const ORDER_HISTORY_KEEP = 100; // 每个账户保留的已完结委托行数（与内存 orderHistory 一致）
const TAPE_KEEP = 500; // 逐笔成交恢复条数（与 config.market.tradeTapeSize 一致）
const PRICE_KEEP_MS = 2 * 60 * 60 * 1000; // 分时序列保留窗口，与 priceHistorySize 同为 2 小时
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
    this.liveOrders = new Map(); // orderId -> 账户名，当前在册的活动委托
    this.tickCount = 0;
    this.sweepCursor = 0;
    this.stockId = null;
    this.lastHalt = ''; // 上次写库的停牌状态，用于跳过无变化的写入

    const db = this.db;
    this.st = {
      upsertAccount: db.prepare(`
        INSERT INTO accounts
          (name, is_npc, role, cash, order_frozen, short_margin, realized_pnl, initial_long, last_order_at, created_at, deposited,
           lend_offered, lend_interest_earned, lend_interest_debt)
        VALUES
          (@name, @is_npc, @role, @cash, @order_frozen, @short_margin, @realized_pnl, @initial_long, @last_order_at, @created_at, @deposited,
           @lend_offered, @lend_interest_earned, @lend_interest_debt)
        ON CONFLICT(name) DO UPDATE SET
          is_npc = @is_npc, role = @role, cash = @cash, order_frozen = @order_frozen,
          short_margin = @short_margin, realized_pnl = @realized_pnl,
          initial_long = @initial_long, last_order_at = @last_order_at, deposited = @deposited,
          lend_offered = @lend_offered, lend_interest_earned = @lend_interest_earned, lend_interest_debt = @lend_interest_debt
      `),
      delLots: db.prepare('DELETE FROM lots WHERE account = ?'),
      insLot: db.prepare(`
        INSERT INTO lots (account, stock_id, side, seq, qty, price, ts, reserved, margin, debt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insOrder: db.prepare(`
        INSERT INTO orders (id, account, stock_id, seq, action, side, price, qty, filled, frozen, ts, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET filled = excluded.filled, frozen = excluded.frozen, status = excluded.status
      `),
      setOrderState: db.prepare('UPDATE orders SET filled = ?, frozen = ?, status = ? WHERE id = ?'),
      delOrder: db.prepare('DELETE FROM orders WHERE id = ?'),
      insTrade: db.prepare(`
        INSERT INTO trades (account, role, order_id, stock_id, action, side, price, qty, fee, trade_seq, t)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      upsertMarket: db.prepare(`
        INSERT INTO market_state
          (stock_id, last_price, prev_close, open, high, low, volume, turnover, short_interest, order_seq, trade_seq, updated_at)
        VALUES
          (@stock_id, @last_price, @prev_close, @open, @high, @low, @volume, @turnover, @short_interest, @order_seq, @trade_seq, @updated_at)
        ON CONFLICT(stock_id) DO UPDATE SET
          last_price = @last_price, prev_close = @prev_close, open = @open, high = @high, low = @low,
          volume = @volume, turnover = @turnover, short_interest = @short_interest,
          order_seq = @order_seq, trade_seq = @trade_seq, updated_at = @updated_at
      `),
      upsertPrice: db.prepare('INSERT OR REPLACE INTO prices (t, price, vol) VALUES (?, ?, ?)'),
      prunePrices: db.prepare('DELETE FROM prices WHERE t < ?'),
      pruneOrders: db.prepare(`
        DELETE FROM orders
         WHERE status <> 'live'
           AND id IN (
             SELECT x.id FROM orders AS x
              WHERE x.status <> 'live' AND x.account = orders.account
              ORDER BY x.seq DESC LIMIT -1 OFFSET ?
           )
      `),
      insSession: db.prepare('INSERT OR REPLACE INTO sessions (token, account) VALUES (?, ?)'),
      delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
      setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      insAuto: db.prepare(`
        INSERT INTO auto_strategies (id, account, type, enabled, done, params, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled, done = excluded.done, params = excluded.params,
          state = excluded.state, updated_at = excluded.updated_at
      `),
      delAuto: db.prepare('DELETE FROM auto_strategies WHERE id = ?'),
      allAuto: db.prepare('SELECT * FROM auto_strategies'),
      allAccounts: db.prepare('SELECT * FROM accounts'),
      allLots: db.prepare('SELECT * FROM lots ORDER BY account, stock_id, side, seq'),
      liveOrders: db.prepare("SELECT * FROM orders WHERE status = 'live' ORDER BY seq"),
      orderHistory: db.prepare('SELECT * FROM orders WHERE account = ? ORDER BY seq DESC LIMIT ?'),
      tradeHistory: db.prepare(`
        SELECT id, order_id, action, side, price, qty, trade_seq, t
          FROM trades WHERE account = ? ORDER BY id DESC LIMIT ?
      `),
      allSessions: db.prepare('SELECT token, account FROM sessions'),
      marketState: db.prepare('SELECT * FROM market_state WHERE stock_id = ?'),
      recentPrices: db.prepare('SELECT t, price, vol FROM prices ORDER BY t DESC LIMIT ?'),
      recentTape: db.prepare(`
        SELECT trade_seq, t, price, qty, side FROM trades
         WHERE role = 'taker' ORDER BY trade_seq DESC LIMIT ?
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

  /** 新开一局：记下开局时间，行情断点由首个 tick 的 commit 写入 */
  startRound(startedAt, stockId) {
    this.stockId = stockId;
    this.st.setMeta.run('round_started_at', String(startedAt));
  }

  /** 每 tick 一次：账户 + 委托对账 + 成交 + 行情，全部在一个事务里 */
  commit({ now, market, pricePoint, allAccounts }) {
    this.commitTx({ now, market, pricePoint, allAccounts });
  }

  commitInner({ now, market, pricePoint, allAccounts }) {
    this.tickCount += 1;

    for (const acc of this.dirty.values()) this.writeAccount(acc);
    this.dirty.clear();

    this.writeOrders(market);
    this.writeAutos();
    this.verifyLiveOrders(allAccounts);

    for (const r of this.pendingTrades) {
      this.st.insTrade.run(
        r.account, r.role, r.orderId, market.stockId, r.action, r.side, r.price, r.qty, r.fee, r.tradeSeq, r.t
      );
    }
    this.pendingTrades.length = 0;

    this.st.upsertMarket.run({
      stock_id: market.stockId,
      last_price: market.lastPrice,
      prev_close: market.prevClose,
      open: market.open,
      high: market.high,
      low: market.low,
      volume: market.volume,
      turnover: market.turnover,
      short_interest: market.shortInterest,
      order_seq: market.orderSeq,
      trade_seq: market.trades.length ? market.trades[0].seq : 0,
      updated_at: now,
    });

    if (pricePoint) this.st.upsertPrice.run(pricePoint.t, pricePoint.price, pricePoint.vol);

    // 停牌状态只在变化时写：meta 是单行覆盖，没必要每秒重写一次同样的值
    const halt = JSON.stringify({ until: market.haltUntil || 0, reason: market.haltReason || '' });
    if (halt !== this.lastHalt) {
      this.st.setMeta.run('halt', halt);
      this.lastHalt = halt;
    }

    this.sweep(allAccounts);

    if (this.tickCount % PRUNE_EVERY_TICKS === 0) {
      this.st.prunePrices.run(now - PRICE_KEEP_MS);
      this.st.pruneOrders.run(ORDER_HISTORY_KEEP);
    }
  }

  /**
   * 本 tick 有状态变化的委托按终态写库。
   * pendingOrders 存的是订单对象引用，所以撮合过程中同一单被反复标记也只写一次最终状态。
   */
  writeOrders(market) {
    for (const o of this.pendingOrders.values()) {
      this.st.insOrder.run(
        o.id, o.account.name, market.stockId, o.seq, o.action, o.side,
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
        s.id, s.account, s.type, s.enabled ? 1 : 0, s.done ? 1 : 0,
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
      cash,
      order_frozen: orderFrozen,
      short_margin: acc.shortMargin,
      realized_pnl: acc.realizedPnL,
      initial_long: acc.initialLong,
      last_order_at: acc.lastOrderAt,
      created_at: acc.createdAt,
      deposited: acc.deposited || 0,
      lend_offered: acc.lendOffered || 0,
      lend_interest_earned: acc.lendInterestEarned || 0,
      lend_interest_debt: acc.lendInterestDebt || 0,
    });

    this.st.delLots.run(acc.name);
    for (const [stockId, pos] of acc.longs) {
      for (let i = 0; i < pos.lots.length; i++) {
        const lot = pos.lots[i];
        this.st.insLot.run(acc.name, stockId, 'long', i, lot.qty, lot.price, lot.ts ?? null, isNpc ? 0 : lot.reserved || 0, 0, lot.debt || 0);
      }
    }
    for (const [stockId, pos] of acc.shorts) {
      for (let i = 0; i < pos.lots.length; i++) {
        const lot = pos.lots[i];
        this.st.insLot.run(acc.name, stockId, 'short', i, lot.qty, lot.price, lot.ts ?? null, isNpc ? 0 : lot.reserved || 0, lot.margin, 0);
      }
    }
  }

  // ---------- 读取侧 ----------

  /**
   * 读回上一局存档。resumed=false 表示没有可续跑的存档（全新开局）。
   * 返回的都是库里的原始行，由 game.js 负责重建对象。
   */
  loadAll(stockId) {
    this.stockId = stockId;
    const startedRow = this.st.getMeta.get('round_started_at');
    const halt = this.readHalt();
    const accounts = this.st.allAccounts.all();
    const lots = this.st.allLots.all();
    const orders = this.st.liveOrders.all();
    const sessions = this.st.allSessions.all();
    const market = this.st.marketState.get(stockId) || null;
    // prices 按时间升序（对齐 market.priceHistory），tape 按新到旧（对齐 market.trades）
    const prices = this.st.recentPrices.all(config.market.priceHistorySize).reverse();
    const tape = this.st.recentTape.all(TAPE_KEEP);
    const auto = this.st.allAuto.all();

    // 回填在册活动委托集合，供 commit 时的自愈扫尾判断
    this.liveOrders.clear();
    for (const o of orders) this.liveOrders.set(o.id, o.account);

    return {
      resumed: !!startedRow && accounts.length > 0 && !!market,
      startedAt: startedRow ? Number(startedRow.value) : null,
      halt,
      accounts,
      lots,
      orders,
      sessions,
      market,
      prices,
      tape,
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

  /** 玩家委托记录：活动委托用内存对象（状态会随成交变化），已完结的用库里的快照 */
  orderHistory(account, limit = ORDER_HISTORY_KEEP) {
    return this.st.orderHistory.all(account.name, limit).map(
      (r) =>
        account.orders.get(r.id) || {
          id: r.id,
          action: r.action,
          price: r.price,
          qty: r.qty,
          filled: r.filled,
          status: r.status,
          ts: r.ts,
        }
    );
  }

  /** 玩家成交记录，字段与 market.execute 里生成的流水一致 */
  tradeHistory(account, limit = ORDER_HISTORY_KEEP) {
    return this.st.tradeHistory.all(account.name, limit).map((r) => ({
      id: `T${r.trade_seq}-${r.order_id}-${r.qty}`,
      orderId: r.order_id,
      action: r.action,
      side: r.side,
      price: r.price,
      qty: r.qty,
      t: r.t,
    }));
  }

  close() {
    this.db.close();
  }
}

module.exports = { Persister };
