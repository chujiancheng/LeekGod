/**
 * 行情与撮合引擎：
 * - 限价订单簿（价格优先、时间优先）
 * - 多头买卖 / 空头开平（保证金模式，固定流通盘）
 * - T+锁仓、下单冷却、手续费、涨跌停（可开关）、爆仓强平
 */
const config = require('./config');
const { OrderBook } = require('./orderbook');
const { r2 } = require('./store');

const ACTIONS = {
  BUY_OPEN: 'buy_open', // 买入开多
  SELL_CLOSE: 'sell_close', // 卖出平多
  SELL_OPEN: 'sell_open', // 卖出开空
  BUY_CLOSE: 'buy_close', // 买入平空
};

const BUY_ACTIONS = new Set([ACTIONS.BUY_OPEN, ACTIONS.BUY_CLOSE]);
const VALID_ACTIONS = new Set(Object.values(ACTIONS));

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
    this.orderSeq = 0;
    this.shortInterest = 0; // 未平空单总量（虚拟流通增量）
    // 融券池：挂借总量 / 已借出 / 开单中占用。可借 = 总挂借 − 已借出 − 开单占用。
    // allowNakedShort=true 时开空不走池（lendBorrowed 仅统计借券开仓的部分）。
    this.lendTotal = 0;
    this.lendBorrowed = 0;
    this.lendReserved = 0; // SELL_OPEN 已下单未成交占用的券源
    this.shortHistory = []; // 空头仓位采样 [{t, qty}]，每 5 分钟一点，约 24h
    this._lastShortSample = 0;
    this.haltUntil = 0; // 停牌截止时间戳（0 = 正常交易），手动运营开关
    this.haltReason = '';
    // 由 Game 注入的持久化器；未注入时纯内存运行（测试脚本就是这样）
    this.journal = null;
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
  }

  /** 涨跌停区间（关闭时返回 null） */
  band() {
    const cfg = config.priceLimit;
    if (!cfg.enabled) return null;
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

  /** 池子紧张度 s ∈ [0,1]：已借出 / 总挂借 */
  lendUtilization() {
    return this.lendTotal > 0 ? Math.min(1, this.lendBorrowed / this.lendTotal) : 0;
  }

  /** 当前分钟利率（小数）：券源越少利率越高，base × (1 + s × k)，封顶 maxMinuteRate */
  lendMinuteRate() {
    const cfg = config.margin.lending;
    if (!cfg || !cfg.enabled) return 0;
    const raw = cfg.baseMinuteRate * (1 + this.lendUtilization() * cfg.stressK);
    return Math.min(raw, cfg.maxMinuteRate);
  }

  /** 某账户挂借中不可撤的量（已借出 + 在途开空占用，按池子比例分摊） */
  lendLockedQty(account) {
    const offered = account.lendOffered || 0;
    if (offered <= 0 || this.lendTotal <= 0) return 0;
    // 只按 borrowed 算会漏掉 lendReserved：在途开空单占用的券源同样锁住，
    // 否则出借人可把已承诺的券撤走，成交后 lendBorrowed > lendTotal、借券方从此不计息
    const lockedRatio = Math.min(1, (this.lendBorrowed + this.lendReserved) / this.lendTotal);
    return Math.min(offered, Math.floor(offered * lockedRatio));
  }

  /** 某账户当前可撤回的挂借量（与 unlendShares 闸门同口径） */
  lendRemovableQty(account) {
    return Math.max(0, (account.lendOffered || 0) - this.lendLockedQty(account));
  }

  /** 玩家/NPC 挂借：从可卖持仓中划出 qty 进入融券池 */
  lendShares(account, qty, now = Date.now()) {
    const cfg = config.margin.lending;
    if (!cfg || !cfg.enabled) return { ok: false, error: '融券功能未开放' };
    const lot = this.stock.lotSize;
    qty = Math.floor(Number(qty));
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: '数量无效' };
    if (qty % lot !== 0) return { ok: false, error: `挂借数量必须为 ${lot} 股的整数倍` };
    const free = account.freeSellableLong(this.stockId, now);
    if (qty > free) return { ok: false, error: `可挂借不足，当前可挂借 ${free} 股` };
    account.lendOffered = (account.lendOffered || 0) + qty;
    this.lendTotal += qty;
    this.notifyChange(account);
    return { ok: true, qty, lendOffered: account.lendOffered, available: this.lendAvailable() };
  }

  /** 撤回挂借：只能撤未被借走、也未被在途开空单占用的部分 */
  unlendShares(account, qty, now = Date.now()) {
    const lot = this.stock.lotSize;
    qty = Math.floor(Number(qty));
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: '数量无效' };
    const offered = account.lendOffered || 0;
    // 被锁定的量 = 池子借出率 × 本人挂借（含在途开空占用）；剩余可撤
    const removable = this.lendRemovableQty(account);
    if (qty > removable) {
      return { ok: false, error: `可撤回不足，当前最多可撤 ${Math.floor(removable / lot) * lot} 股（被借走/开空占用部分需空头平仓后释放）` };
    }
    account.lendOffered = offered - qty;
    this.lendTotal = Math.max(0, this.lendTotal - qty);
    this.notifyChange(account);
    return { ok: true, qty, lendOffered: account.lendOffered, available: this.lendAvailable() };
  }

  /**
   * 每 tick 融券利息：空头付、出借方收。
   * 按分钟利率折算到 tick：interest = 借出市值 × 分钟息 × (tickMs / 60000)。
   * 只对「借券开仓」的部分计息（裸空不计）；空头先扣现金再扣保证金，
   * 都不够则记欠息（不触发强平）；出借方按池子份额分摊实收。
   */
  accrueLendingInterest(now = Date.now()) {
    const cfg = config.margin.lending;
    if (!cfg || !cfg.enabled || this.lendBorrowed <= 0 || this.lendTotal <= 0) return;
    const tickRate = this.lendMinuteRate() * (config.tickIntervalMs / 60000);
    if (tickRate <= 0) return;
    const last = this.lastPrice;
    // 总利息池 = 已借出市值 × tick 利率
    const totalInterest = this.lendBorrowed * last * tickRate;
    if (totalInterest <= 0) return;

    // 1) 向空头收取：按各账户空头市值占比分摊（借券部分 = min(shortQty, lendBorrowed 口径下全算借券）
    //    allowNakedShort=false 时全部空头都来自池；=true 时不调用本函数的借券计息路径外的裸空不收息
    let collected = 0;
    const payers = [];
    for (const acc of this._allAccountsForInterest()) {
      const shortQty = acc.shortQty(this.stockId);
      if (shortQty <= 0) continue;
      const share = shortQty / this.lendBorrowed;
      const owed = totalInterest * share;
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
      if (rest > 0.005) acc.lendInterestDebt = r2((acc.lendInterestDebt || 0) + rest);
      if (pay > 0) {
        collected += pay;
        payers.push({ acc, pay });
      }
      if (pay > 0 || rest > 0) this.notifyChange(acc);
    }

    // 2) 向出借方分配：按挂借量占总挂借的比例（被借走的才真正参与计息分配）
    if (collected > 0 && this.lendTotal > 0) {
      const receivers = [];
      let assigned = 0;
      for (const acc of this._allAccountsForInterest()) {
        const offered = acc.lendOffered || 0;
        if (offered <= 0) continue;
        const income = collected * (offered / this.lendTotal);
        if (income <= 0) continue;
        const take = assigned + income >= collected ? collected - assigned : income;
        assigned += take;
        acc.cash = r2(acc.cash + take);
        acc.lendInterestEarned = r2((acc.lendInterestEarned || 0) + take);
        receivers.push({ acc, take });
        this.notifyChange(acc);
      }
    }
  }

  /** 空头仓位 5 分钟采样（在 game.tick 里调用） */
  sampleShortInterest(now = Date.now()) {
    const interval = 5 * 60 * 1000;
    if (now - this._lastShortSample < interval && this.shortHistory.length > 0) return;
    this._lastShortSample = now;
    this.shortHistory.push({ t: now, qty: this.shortInterest });
    if (this.shortHistory.length > 300) this.shortHistory.shift(); // ~24h
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

    if (!VALID_ACTIONS.has(action)) return { ok: false, error: '未知操作类型' };
    if (!Number.isFinite(price) || price <= 0) return { ok: false, error: '价格无效' };
    if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: '数量无效' };

    const isOpen = action === ACTIONS.BUY_OPEN || action === ACTIONS.SELL_OPEN;
    const lot = this.stock.lotSize;
    if (isOpen && qty % lot !== 0) {
      return { ok: false, error: `开仓数量必须为 ${lot} 股的整数倍` };
    }
    if (!this.inBand(price)) {
      const b = this.band();
      return { ok: false, error: `价格超出涨跌停范围（${b.down} ~ ${b.up}）` };
    }

    // 下单冷却（NPC 不受限）
    if (!account.isNPC && !opts.noCooldown && account.lastOrderAt != null) {
      const wait = config.trade.cooldownMs - (now - account.lastOrderAt);
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

    const feeRate = config.trade.feeRate;
    const { ratio, maintenance } = config.margin;
    let freeze = 0; // 冻结到 orderFrozen 的金额
    let precheck = '';

    switch (action) {
      case ACTIONS.BUY_OPEN: {
        freeze = r2(price * qty * (1 + feeRate));
        if (account.cash < freeze) return { ok: false, error: '可用资金不足' };
        break;
      }
      case ACTIONS.SELL_CLOSE: {
        // 挂入融券池的券不能再卖：可卖 = freeSellableLong（可卖 − 已挂借）
        const sellable = account.freeSellableLong(this.stock.id, now);
        if (sellable < qty) {
          const locked = account.longQty(this.stock.id) - sellable;
          precheck = sellable <= 0 && locked > 0 ? `可卖数量为 0（${config.trade.lockMs / 60000} 分钟锁仓中或已挂借融券）` : `可卖数量不足，当前可卖 ${sellable} 股`;
          return { ok: false, error: precheck };
        }
        if (!account.reserveLong(this.stock.id, qty, now)) {
          return { ok: false, error: '可卖数量不足' };
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
          if (this.lendAvailable() < qty) {
            return {
              ok: false,
              error: `可借券源不足，当前可借 ${this.lendAvailable()} 股（请先有人挂借出）`,
            };
          }
          this.lendReserved += qty; // 占用券源，成交/撤单时释放
        }
        // 开空：成交时从卖出所得中扣保证金，此处只做维持保证金预检。
        // 在途开空（已挂未成交）的名义市值也要并入占用：否则连挂多张贴边单
        // 各自预检都过、成交后合计跌破维持线，成交即强平
        let pendingShortMV = 0;
        for (const o of account.orders.values()) {
          if (o.status === 'live' && o.action === ACTIONS.SELL_OPEN) {
            pendingShortMV += o.price * (o.qty - o.filled);
          }
        }
        const eq = account.equity(this.stock.id, this.lastPrice);
        const addMV = price * qty;
        const need = maintenance * (account.shortMV(this.stock.id, this.lastPrice) + pendingShortMV + addMV) + r2(addMV * feeRate);
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
      id: 'O' + this.orderSeq,
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
      ts: now,
      status: 'live',
    };

    account.orders.set(order.id, order);
    account.orderHistory.unshift(order);
    if (account.orderHistory.length > 100) account.orderHistory.length = 100;
    if (!account.isNPC && !opts.noCooldown) account.lastOrderAt = now;

    this.match(order, now, order.side);
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
        this.dropStaleOrder(best);
        continue;
      }
      const tradePrice = best.price; // 成交价 = 被动方挂单价
      this.execute(order, best, tradePrice, take, now, aggressorSide);
    }
    if (order.filled < order.qty) {
      if (order.status === 'live') this.book.add(order);
    } else {
      this.finishOrder(order);
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
  dropStaleOrder(order) {
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
  }

  /** 单笔撮合：结算双方、记流水、更新行情 */
  execute(taker, maker, price, qty, now, aggressorSide) {
    const feeBuy = this.settleBuy(taker.side === 'buy' ? taker : maker, price, qty, now);
    const feeSell = this.settleSell(taker.side === 'sell' ? taker : maker, price, qty, now);

    taker.filled += qty;
    maker.filled += qty;
    if (maker.filled >= maker.qty) {
      this.book.remove(maker);
      this.finishOrder(maker);
    }
    if (taker.filled >= taker.qty) this.finishOrder(taker);

    this.onTrade(price, qty, aggressorSide, now);

    // 记录双方成交：内存流水用于客户端展示，落库明细用于重启后恢复成交记录
    this.notifyChange(taker.account, taker);
    this.notifyChange(maker.account, maker);
    const tradeSeq = this.trades[0] ? this.trades[0].seq : 0;
    for (const o of [taker, maker]) {
      const rec = {
        id: 'T' + tradeSeq + '-' + o.id + '-' + qty,
        orderId: o.id,
        action: o.action,
        price,
        qty,
        t: now,
        side: aggressorSide,
      };
      o.account.tradeHistory.unshift(rec);
      if (o.account.tradeHistory.length > 100) o.account.tradeHistory.length = 100;
      // SYSTEM 是虚拟对手盘，不是真实账户，不进成交流水
      if (this.journal && o.account.name !== 'SYSTEM') {
        this.journal.recordTrade({
          account: o.account.name,
          role: o === taker ? 'taker' : 'maker',
          orderId: o.id,
          action: o.action,
          side: aggressorSide,
          price,
          qty,
          fee: o.side === 'buy' ? feeBuy : feeSell,
          tradeSeq,
          t: now,
        });
      }
    }

    // 成交后立即做风控检查
    this.maybeLiquidate(taker.account, now);
    if (maker.account !== taker.account) this.maybeLiquidate(maker.account, now);
  }

  onTrade(price, qty, aggressorSide, now) {
    this.lastPrice = price;
    if (price > this.high) this.high = price;
    if (price < this.low) this.low = price;
    this.volume += qty;
    this.turnover += price * qty;
    this.trades.unshift({
      seq: this.trades.length ? this.trades[0].seq + 1 : 1,
      t: now,
      price,
      qty,
      side: aggressorSide, // 主动方向：buy=买盘主动(sell贴)、sell=卖盘主动
    });
    if (this.trades.length > config.market.tradeTapeSize) this.trades.length = config.market.tradeTapeSize;
  }

  /** 买入方向结算（开多 / 平空） */
  settleBuy(order, price, qty, now) {
    const acc = order.account;
    const fee = r2(price * qty * config.trade.feeRate);
    // 系统兜底账户只是虚拟对手盘，不参与建仓/持仓统计，否则会无限累积
    const isGhost = acc === SYSTEM_ACCOUNT;

    if (order.action === ACTIONS.BUY_OPEN) {
      // 退回按挂单价冻结的资金，按实际成交价结算
      const rel = this.releaseFrozen(order, r2(order.price * qty * (1 + config.trade.feeRate)));
      const cost = r2(price * qty);
      acc.cash = r2(acc.cash + rel - cost - fee);
      if (!isGhost) {
        // 新买入批次：以本次成交时间起算锁仓
        acc.longPos(order.stockId).lots.push({ qty, price, ts: now, reserved: 0 });
        // 开仓手续费也计入已实现盈亏，否则 权益 ≠ 初始资金 + 已实现盈亏 + 浮动盈亏
        acc.realizedPnL = r2(acc.realizedPnL - fee);
      }
    } else {
      // 平空：退回费用预估 + 释放保证金 + 支付买入款（盈亏只记账，现金里隐含在原始卖出去处）
      const rel = this.releaseFrozen(order, r2(order.price * qty * config.trade.feeRate));
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
    const fee = r2(price * qty * config.trade.feeRate);
    const isGhost = acc === SYSTEM_ACCOUNT;

    if (order.action === ACTIONS.SELL_CLOSE) {
      const rel = this.releaseFrozen(order, r2(order.price * qty * config.trade.feeRate));
      const cons = acc.consumeLong(order.stockId, qty);
      // 只按实际扣减到的持仓入账：持仓不足时不得凭空产生现金
      const sold = Math.min(cons.qty, qty);
      const soldFee = r2(price * sold * config.trade.feeRate);
      acc.cash = r2(acc.cash + price * sold + rel - soldFee);
      acc.realizedPnL = r2(acc.realizedPnL + (price * sold - cons.cost) - soldFee);
      // 按实际扣减到的数量计费，与被扣的手续费保持一致
      return soldFee;
    } else {
      // 开空：卖出所得入账，按成交市值冻结保证金
      const proceeds = r2(price * qty);
      const marginAdd = r2(proceeds * config.margin.ratio);
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
  finishOrder(order) {
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
  }

  /** 撤单 */
  cancel(account, orderId, now) {
    const order = account.orders.get(orderId);
    if (!order) return { ok: false, error: '委托不存在或已完结' };
    if (order.status !== 'live') {
      account.orders.delete(orderId);
      return { ok: false, error: '委托已完结' };
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
    return { ok: true, order };
  }

  /**
   * 爆仓检查：equity < 维持保证金 × 空头市值 时强平
   * 强平顺序：先视需要卖出多头补充现金，再逐笔买入平空（吃对手盘，不足则系统兜底价）
   */
  maybeLiquidate(account, now) {
    if (!account || account === SYSTEM_ACCOUNT) return false;
    if (account._liquidating) return false;
    const last = this.lastPrice;
    const mv = account.shortMV(this.stockId, last);
    if (mv <= 0) return false;
    const eq = account.equity(this.stockId, last);
    if (eq >= config.margin.maintenance * mv) return false;

    account._liquidating = true;
    const events = [];
    try {
      // 强平会直接扣减多头/空头持仓，先撤掉该账户全部在途委托：
      // 平仓挂单失去持仓依据会变成幽灵挂单；开仓挂单则会被自己的强平单吃到（自成交），
      // 强平既收不回现金，被强卖的多头还会带着新的锁仓时间原样回到账上
      for (const o of [...account.orders.values()]) {
        this.cancel(account, o.id, now);
      }
      let guard = 0;
      while (guard++ < 500) {
        const curMV = account.shortMV(this.stockId, this.lastPrice);
        if (curMV <= 0) break;
        const curEq = account.equity(this.stockId, this.lastPrice);
        if (curEq >= config.margin.maintenance * curMV) break;

        // 覆盖全部空头所需资金估算
        const needQty = account.shortQty(this.stockId);
        const needCash = r2(needQty * this.lastPrice * (1 + config.trade.feeRate));
        // 挂借中的券不能强卖；全部挂借时跳过本分支直接走买入平空，
        // 否则 forceSellLong 返回 0 会 break 掉整个强平循环
        const sellableLong = account.forceSellableLong(this.stockId);
        if (account.cash + account.shortMargin < needCash && sellableLong > 0) {
          // 先强卖多头补充现金
          const sold = this.forceSellLong(account, Math.min(sellableLong, needQty), now);
          if (sold <= 0) break;
          events.push({ type: 'force_sell_long', qty: sold });
          continue;
        }
        // 买入平空（能负担多少平多少）
        const budget = account.cash + account.shortMargin;
        const maxQty = Math.floor(budget / (this.lastPrice * (1 + config.trade.feeRate)));
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
    } finally {
      account._liquidating = false;
    }
    if (events.length) {
      this.journal?.touch(account);
      account.liquidations = account.liquidations || [];
      account.liquidations.unshift({ t: now, events });
      if (account.liquidations.length > 20) account.liquidations.length = 20;
    }
    return events.length > 0;
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
          this.dropStaleOrder(bid);
          continue;
        }
        price = bid.price;
        take = Math.min(need, remain);
      } else {
        price = this.clampPrice(this.lastPrice * (1 - config.margin.liquidationSlippage));
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
          : Math.min(need, Math.floor((account.cash + account.shortMargin) / (price * (1 + config.trade.feeRate))));
        if (afford <= 0) break;
        take = Math.min(afford, remain);
        if (!this.isSettleable(ask, take)) {
          this.dropStaleOrder(ask);
          continue;
        }
      } else {
        price = this.clampPrice(this.lastPrice * (1 + config.margin.liquidationSlippage));
        if (!allowDebt) {
          const afford = Math.floor((account.cash + account.shortMargin) / (price * (1 + config.trade.feeRate)));
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

  /** 行情快照（给客户端） */
  snapshot(depthLevels) {
    const levels = depthLevels || config.market.depthLevels;
    const depth = this.book.depthAgg(levels);
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
      lotSize: this.stock.lotSize,
      floatShares: this.stock.floatShares,
      depth,
      trades: this.trades.slice(0, 30),
      band: this.band(),
      lending: this.lendingSnapshot(),
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
      minuteRate: r2(this.lendMinuteRate() * 10000) / 100, // 分钟息 %（保留两位小数，0.01 表示 0.01%）
      allowNakedShort: !!config.margin.allowNakedShort,
      shortInterest: this.shortInterest,
      history: this.shortHistory,
    };
  }
}

// 系统兜底对手账户（只做记账，不参与风控）
const SYSTEM_ACCOUNT = new (require('./store').Account)('SYSTEM', true);
SYSTEM_ACCOUNT.cash = Infinity;

module.exports = { Market, ACTIONS };
