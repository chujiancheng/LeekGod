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

const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{1,16}$/;

// 同一账户最多保留的活跃令牌数（多标签页够用，防止 sessions 无界增长）
const MAX_SESSIONS_PER_ACCOUNT = 5;

class Game {
  /**
   * @param {{persist?: import('./persist').Persister|null}} [opts]
   */
  constructor(opts = {}) {
    this.stock = config.stocks[0];
    this.store = new Store();
    this.market = new Market(this.stock);
    this.news = new NewsSystem();
    this.npc = new NpcManager(this.market, this.news, this.store);
    this.auto = new AutoManager(this.market, this.stock, this.store);
    this.persist = opts.persist || null;
    this.market.journal = this.persist;
    this.market.accountsProvider = () => this.store.all();
    this.auto.journal = this.persist;
    this.startedAt = Date.now();
    this.timer = null;
    this.tickCount = 0;
    this.listeners = new Set(); // SSE 广播回调
    this.lastNews = null;
    this.sessions = new Map(); // 登录令牌 -> 账号名
    this._stats = null; // 排行榜 / 前十大股东缓存，每 tick 刷新一次
  }

  start() {
    if (this.timer) return;
    const snap = this.persist ? this.persist.loadAll(this.stock.id) : null;
    const resumed = !!(snap && snap.resumed);
    if (resumed) {
      this.applySnapshot(snap);
    } else {
      this.startedAt = Date.now();
      this.npc.init(this.startedAt);
      this.market.priceHistory.push({ t: this.startedAt, price: this.market.lastPrice, vol: 0 });
      this.persist?.startRound(this.startedAt, this.stock.id);
    }
    // NPC 首轮报价（续跑时报价单不入存档，靠这一步把双边盘口重新挂上）
    this.npc.step(Date.now());
    this.refreshStats();
    // 新开局的基线立即落盘：初始持仓、分时起点与行情断点，第一秒内被杀也能续跑
    if (!resumed && this.persist) {
      const h = this.market.priceHistory;
      this.persist.commit({
        now: Date.now(),
        market: this.market,
        pricePoint: h[h.length - 1],
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
      acc.lendOffered = row.lend_offered || 0;
      acc.lendInterestEarned = row.lend_interest_earned || 0;
      acc.lendInterestDebt = row.lend_interest_debt || 0;
      this.store.put(acc);
      byName.set(acc.name, acc);
    }

    for (const row of snap.lots) {
      const acc = byName.get(row.account);
      if (!acc) continue;
      const pos = row.side === 'long' ? acc.longPos(row.stock_id) : acc.shortPos(row.stock_id);
      const lot = { qty: row.qty, price: row.price, reserved: row.reserved };
      // 多头批次带锁仓起始时间（T+锁仓依据）与融资负债；空头批次带保证金
      if (row.side === 'long') {
        lot.ts = row.ts;
        lot.debt = row.debt || 0;
      } else {
        lot.margin = row.margin;
      }
      pos.lots.push(lot);
    }

    const m = snap.market;
    this.market.lastPrice = m.last_price;
    this.market.prevClose = m.prev_close;
    this.market.open = m.open;
    this.market.high = m.high;
    this.market.low = m.low;
    this.market.volume = m.volume;
    this.market.turnover = m.turnover;
    this.market.shortInterest = m.short_interest;
    this.market.orderSeq = Math.max(this.market.orderSeq, m.order_seq);

    // 融券池聚合值从账户挂借量 + shortInterest 重建（挂借量已随 accounts 恢复）
    this.rebuildLendingPool();

    // 停牌跟着存档走：重启不该把正在停牌的一局悄悄变回正常交易
    if (snap.halt) {
      this.market.haltUntil = snap.halt.until || 0;
      this.market.haltReason = snap.halt.reason || '';
    }

    // 活动委托回填订单簿与账户挂单表（账号 id 由 orderSeq 递增，不回退，避免与旧单撞号）
    for (const row of snap.orders) {
      const acc = byName.get(row.account);
      if (!acc) continue;
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
      this.market.book.add(order);
      this.market.orderSeq = Math.max(this.market.orderSeq, order.seq);
      // 未成交的开空单在重启前占用了券源，回填时重新计入
      if (order.action === ACTIONS.SELL_OPEN && !config.margin.allowNakedShort) {
        this.market.lendReserved += order.qty - order.filled;
      }
    }

    this.market.priceHistory = snap.prices.map((p) => ({ t: p.t, price: p.price, vol: p.vol }));
    this.market.trades = snap.tape.map((t) => ({
      seq: t.trade_seq,
      t: t.t,
      price: t.price,
      qty: t.qty,
      side: t.side,
    }));

    for (const row of snap.sessions) {
      if (byName.has(row.account)) this.sessions.set(row.token, row.account);
    }

    // 重建 NPC 报价对象：持仓/现金已在上面恢复，这里只补 manager 的运行期字段
    const typeKeys = Object.keys(config.npc.types);
    const npcRows = snap.accounts
      .filter((r) => r.is_npc && typeKeys.includes(normalizeNpcType(r.role)))
      .map((r) => ({ ...r, role: normalizeNpcType(r.role) }))
      .sort((a, b) =>
        a.role === b.role
          ? a.name.length - b.name.length || a.name.localeCompare(b.name)
          : a.role.localeCompare(b.role)
      );
    let instIdx = 0;
    for (const row of npcRows) {
      const typeKey = row.role;
      const t = config.npc.types[typeKey];
      this.npc.npcs.push({
        acc: byName.get(row.name),
        type: typeKey,
        profile: t,
        initialLong: row.initial_long,
        initialCash: t ? t.totalCash / t.count : 0,
        camp: t && t.useCamp ? (instIdx++ % 2 === 0 ? 1 : -1) : 0,
        ownBias: 0,
        ownResting: [],
        requoteIn: 0,
      });
    }
    this.npc.tickCount = 0;
    // 公允价值/重心/趋势阶段/情绪结构不落盘（随机游走的中间量），重新锚到现价
    this.npc.fairValue = this.market.lastPrice;
    this.npc.fund = this.market.lastPrice;
    this.npc.regime = 0;
    this.npc.regimeIn = 0;
    this.npc.trendDrift = 0;
    this.npc.instMood = 0;
    this.npc.polar = 0.2;
    this.npc.polarTarget = 0.2;
    this.npc.polarIn = 0;

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

    if (this.market.expireHalt(now)) logger.info('[我是股神] 停牌到期，已自动复牌');

    // 停牌期间行情、报价、风控一并冻结：价格若继续走，玩家看到的停牌倒计时就成了假的
    const halted = this.market.isHalted(now);
    if (!halted) {
      const news = this.news.maybeEmit(now, this.npc.regime * config.news.regimeBias);
      if (news) this.lastNews = news;

      this.npc.step(now);
    }

    const allAccounts = this.store.all();

    if (!halted) {
      // 全账户风控扫描（成交触发之外的兜底）
      for (const acc of allAccounts) {
        this.market.maybeLiquidate(acc, now);
      }
      // 玩家自动化策略：停牌时整段冻结，复牌后继续
      this.auto.step(now);
      // 融券利息：空头按 tick 付给出借方，券源越少利率越高
      this.market.accrueLendingInterest(now);
      // 做空欠息追缴：现金/保证金恢复后优先补缴历史欠息
      this.market.collectLendingDebt();
      // 融资利息：摊入批次负债并计入已实现盈亏，现金越紧利率越高
      this.market.accrueFinanceInterest(now);
    }

    // 空头仓位 5 分钟采样（停牌也记，走势图不断点）
    this.market.sampleShortInterest(now);

    // 分时序列（每秒一个点，vol 为累计成交量供客户端算柱）；停牌补平线，走势图不断点
    const h = this.market.priceHistory;
    h.push({ t: now, price: this.market.lastPrice, vol: this.market.volume });
    // 保留最近 N 个点：push 在尾部，截断必须从头丢，h.length=N 会把最新点砍掉导致分时冻住
    if (h.length > config.market.priceHistorySize) h.splice(0, h.length - config.market.priceHistorySize);

    // 排行榜/股东按 tick 算一次，避免每个 SSE 连接各算一遍
    this.refreshStats();
    this.broadcast();

    // 本 tick 的全部变更（账户、委托、成交、行情）在一个事务里落盘
    this.persist?.commit({ now, market: this.market, pricePoint: h[h.length - 1], allAccounts });
  }

  /** 刷新排行榜与前十大股东缓存 */
  refreshStats() {
    this._stats = {
      players: this.leaderboard(),
      topHolders: this.computeTopHolders(),
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

  placeOrder(token, body) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    const qty = Number(body.qty);
    const price = Number(body.price);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) {
      return { ok: false, error: '价格或数量无效' };
    }
    const res = this.market.place(acc, {
      action: body.action,
      qty,
      price,
      finance: body.finance === true, // 融资买入开关（仅 buy_open 生效）
      now: Date.now(),
    });
    if (res.ok) this.broadcast();
    return res.ok
      ? { ok: true, order: this.serializeOrder(res.order, Date.now()), cooldownLeft: this.cooldownLeft(acc, Date.now()) }
      : res;
  }

  cancelOrder(token, orderId) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    const res = this.market.cancel(acc, orderId, Date.now());
    if (res.ok) this.broadcast();
    return res.ok ? { ok: true, order: this.serializeOrder(res.order, Date.now()) } : res;
  }

  // ---------- 融券：挂借 / 撤借 ----------

  /** 从账户挂借量重建池子聚合值（新开局全部为 0，续跑时从存档恢复） */
  rebuildLendingPool() {
    let total = 0;
    for (const acc of this.store.all()) total += acc.lendOffered || 0;
    this.market.lendTotal = total;
    // 借出量 = 未平空头（非裸空模式下空头都来自池）；裸空模式不走池
    this.market.lendBorrowed = config.margin.allowNakedShort ? 0 : Math.min(this.market.shortInterest, total);
    this.market.lendReserved = 0; // 活动委托回填时单独累计
  }

  /** 挂借：把可卖持仓划入融券池生息 */
  lend(token, qty) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    if (acc.isNPC) return { ok: false, error: '仅玩家可操作挂借' };
    const r = this.market.lendShares(acc, qty, Date.now());
    if (r.ok) {
      logger.info(`[我是股神] 账户 ${acc.name} 挂借 ${r.qty} 股（累计 ${r.lendOffered}，可借 ${r.available}）`);
      this.persist?.touch(acc);
      this.broadcast();
    }
    return r;
  }

  /** 撤借：撤回未被借走的挂借量 */
  unlend(token, qty) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    if (acc.isNPC) return { ok: false, error: '仅玩家可操作撤借' };
    const r = this.market.unlendShares(acc, qty, Date.now());
    if (r.ok) {
      logger.info(`[我是股神] 账户 ${acc.name} 撤借 ${r.qty} 股（剩余 ${r.lendOffered}，可借 ${r.available}）`);
      this.persist?.touch(acc);
      this.broadcast();
    }
    return r;
  }

  // ---------- 自动化交易 ----------

  createAuto(token, body) {
    const acc = this.accountFor(token);
    if (!acc) return { ok: false, error: '请先登录' };
    const r = this.auto.create(acc, body && body.type, body && body.params);
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

  /** 手动停牌，minutes 省略时用默认时长 */
  halt(minutes, reason) {
    const r = this.market.halt(minutes ?? config.halt.defaultMinutes, reason);
    if (r.ok) this.broadcast();
    return r;
  }

  /** 立即复牌 */
  resume() {
    this.broadcast();
    return this.market.resume();
  }

  // ---------- 状态快照 ----------

  cooldownLeft(acc, now) {
    if (acc.lastOrderAt == null) return 0;
    return Math.max(0, config.trade.cooldownMs - (now - acc.lastOrderAt));
  }

  /** 玩家视角完整状态 */
  stateFor(token, opts = {}) {
    const now = Date.now();
    const acc = this.accountFor(token);
    // 行情快照可由调用方传入：SSE 每 tick 要给每条连接推一份，市场部分完全一样
    const market = opts.market || this.market.snapshot();
    if (!this._stats) this.refreshStats();
    const stats = this._stats;
    const base = {
      serverTime: now,
      startedAt: this.startedAt,
      market,
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
          // 当前分钟息（百分数，0.01 = 0.01%/分）：1e6/1e4 比 r2 更干净地消掉浮点尾数
          minuteRate: Math.round(this.market.financeMinuteRate() * 1e6) / 1e4,
        },
        initialCash: config.account.initialCash,
        lotSize: this.stock.lotSize,
        maxDeviation: config.trade.maxDeviation,
        cagePct: config.trade.cagePct,
        priceLimit: config.priceLimit,
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
      topHolders: stats.topHolders,
      halt: this.market.haltInfo(now),
    };
    if (opts.withHistory) base.priceHistory = this.market.priceHistory;
    if (!acc) {
      base.account = null;
      return base;
    }
    base.account = this.serializeAccount(acc, market.last, now);
    base.cooldownLeft = this.cooldownLeft(acc, now);
    return base;
  }

  serializeAccount(acc, last, now) {
    const sid = this.stock.id;
    const longPos = acc.longs.get(sid);
    const shortPos = acc.shorts.get(sid);
    let longCost = 0;
    let financeDebtOfLots = 0;
    const longLots = [];
    if (longPos) {
      for (const lot of longPos.lots) {
        longCost += lot.qty * lot.price;
        financeDebtOfLots += lot.debt || 0;
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
        shortLots.push({
          qty: lot.qty,
          price: r2(lot.price),
          margin: r2(lot.margin),
        });
      }
    }

    const longQty = acc.longQty(sid);
    const shortQty = acc.shortQty(sid);
    const longValue = r2(longQty * last);
    const shortValue = r2(shortQty * last);
    const equity = r2(acc.equity(sid, last));
    const longPnl = r2(longValue - longCost);
    const shortPnl = r2(shortCost - shortValue);

    // 强平价推导（含融资负债与做空欠息）：cash+orderFrozen+shortMargin-debt-debtLend + (L-S)*P = 维持率×敞口×P
    // 空头强平价：K = ((1+m)*S - L) * P → P = K / ((1+m)S - L)；K 为负时空头端安全
    // K 的两项负债口径必须与 equity（maybeLiquidate 判定用）完全一致，否则显示与真实触发点分叉：
    // m 取自配置（写死数字改维持率后即失真），欠息也要扣（它同样进了 equity）
    const m = config.margin.maintenance;
    let liquidationPrice = null;
    const lendDebt = r2(acc.lendInterestDebt);
    const riskDebt = r2(financeDebtOfLots + lendDebt); // 融资负债 + 做空欠息
    const K = acc.cash + acc.orderFrozen + acc.shortMargin - riskDebt;
    const denom = (1 + m) * shortQty - longQty;
    if (shortQty > 0 && denom > 0) {
      const p = K / denom;
      if (p > 0) liquidationPrice = r2(p);
    }
    // 多头（融资）强平价：K + (1-维持率)*Lq*P - Sq*P = 0 → P = -K / ((1-m)*Lq - Sq)
    let liquidationPriceLong = null;
    const denomL = (1 - m) * longQty - shortQty;
    if (r2(financeDebtOfLots) > 0 && longQty > 0 && K < 0 && denomL > 0) {
      const p = -K / denomL;
      if (p > 0) liquidationPriceLong = r2(p);
    }

    const orders = [];
    for (const o of acc.orders.values()) {
      orders.push(this.serializeOrder(o, now));
    }
    const orderHistory = acc.orderHistory.slice(0, 50).map((o) => this.serializeOrder(o, now));

    const trades = acc.tradeHistory.slice(0, 50).map((t) => ({
      id: t.id,
      orderId: t.orderId,
      action: t.action,
      price: t.price,
      qty: t.qty,
      t: t.t,
      side: t.side,
    }));

    return {
      name: acc.name,
      cash: r2(acc.cash),
      orderFrozen: r2(acc.orderFrozen),
      shortMargin: r2(acc.shortMargin),
      financeDebt: r2(financeDebtOfLots), // 融资负债（本金 + 已摊利息）
      equity,
      realizedPnL: r2(acc.realizedPnL),
      deposited: r2(acc.deposited || 0), // 终身累计加钱额
      long: {
        qty: longQty,
        cost: r2(longCost),
        value: longValue,
        pnl: longPnl,
        lots: longLots,
        sellable: acc.freeSellableLong(sid, now),
      },
      short: {
        qty: shortQty,
        cost: r2(shortCost),
        value: shortValue,
        margin: r2(shortMarginOfLots),
        pnl: shortPnl,
        lots: shortLots,
        coverable: acc.coverableShort(sid),
      },
      // 风险度 = （空头市值 + 融资负债 + 做空欠息）/ 权益
      marginUsage: riskDebt > 0 && equity > 0 ? r2(((shortValue + riskDebt) / equity) * 100) : 0,
      liquidationPrice,
      liquidationPriceLong,
      // 融券：本人挂借 / 被借走 / 累计利息（被借走 = 挂借 × 池子借出率）
      lending: this.serializeLending(acc),
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
      action: o.action,
      price: o.price,
      qty: o.qty,
      filled: o.filled,
      status: o.status,
      ts: o.ts,
      remain: o.qty - o.filled,
    };
  }

  /** 账户融券视角：可挂借、挂借中、被借走、可撤、累计利息 */
  serializeLending(acc) {
    const m = this.market;
    const offered = acc.lendOffered || 0;
    const lentOut = Math.floor(offered * m.lendUtilization());
    // 可撤口径必须与撤借闸门一致（含在途开空占用），否则 UI 显示可撤、点撤借却被拒
    const removable = m.lendRemovableQty(acc);
    const free = acc.freeSellableLong(this.stock.id, Date.now());
    return {
      offered,
      lentOut,
      removable,
      freeToLend: Math.max(0, Math.floor(free / this.stock.lotSize) * this.stock.lotSize),
      interestEarned: r2(acc.lendInterestEarned || 0),
      interestDebt: r2(acc.lendInterestDebt || 0),
    };
  }

  /** 玩家资产排行 */
  leaderboard() {
    const last = this.market.lastPrice;
    return this.store
      .players()
      .map((a) => ({ name: a.name, equity: r2(a.equity(this.stock.id, last)) }))
      .sort((x, y) => y.equity - x.equity)
      .slice(0, 20);
  }

  /** 前十大股东（走 tick 缓存） */
  topHolders() {
    if (!this._stats) this.refreshStats();
    return this._stats.topHolders;
  }

  /**
   * 前十大股东：按当前持股排序（含 NPC 与玩家）
   * change = 当前持股 - 开服/建仓持股
   */
  computeTopHolders(limit = 10) {
    const sid = this.stock.id;
    const total = this.stock.floatShares;
    const rows = [];
    for (const acc of this.store.all()) {
      if (acc.name === 'SYSTEM') continue;
      const qty = acc.longQty(sid);
      if (qty <= 0) continue;
      const role = acc.isNPC ? acc.role || 'npc' : 'player';
      rows.push({
        name: acc.name,
        role, // inst / hot / big / mid / small / player
        qty,
        pct: r2((qty / total) * 100),
        change: qty - (acc.initialLong || 0),
      });
    }
    rows.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
    return rows.slice(0, limit);
  }

  /** 股东合计（校验流通盘用） */
  holdersSummary() {
    const sid = this.stock.id;
    let total = 0;
    for (const acc of this.store.all()) {
      if (acc.name === 'SYSTEM') continue;
      total += acc.longQty(sid);
    }
    return { longTotal: total, float: this.stock.floatShares, shortInterest: this.market.shortInterest };
  }
}

module.exports = { Game, ACTIONS };
