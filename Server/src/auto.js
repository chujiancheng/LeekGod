/**
 * 玩家自动化交易：止盈止损 / 网格 / 双均线 / 定投
 *
 * 由 Game.tick 驱动（停牌时整段冻结），下单走 market.place 与手动委托同一路径——
 * 冷却、锁仓、资金校验、价格笼子一视同仁，不给自动单开任何后门。
 * 策略随存档落盘，重启后接着跑；动作日志只存内存，重启后清空。
 */
const config = require('./config');
const { logger } = require('./logger');
const { ACTIONS } = require('./market');
const { r2 } = require('./store');

const TYPE_LABEL = { tps: '止盈止损', grid: '网格', ma: '双均线', dca: '定投' };

const round2 = (v) => Math.round(v * 100) / 100;

/** 网格第 level 格的买入价（level 从 1 起） */
const gridBuyPrice = (base, stepPct, level) =>
  Math.max(0.01, round2(base * Math.pow(1 - stepPct / 100, level)));

/** 网格第 level 格的卖出目标价 */
const gridSellPrice = (base, stepPct, level) =>
  Math.max(0.01, round2(base * Math.pow(1 + stepPct / 100, level)));

class AutoManager {
  /**
   * @param {Map<string, import('./market').Market>} markets 全部市场（stockId -> Market）
   * @param {Map<string, {id:string, name:string, lotSize:number, initPrice:number}>} stocks
   * @param {import('./store').Store} store
   */
  constructor(markets, stocks, store) {
    this.markets = markets;
    this.stocks = stocks;
    this.store = store;
    this.byId = new Map();
    this.seq = 0;
    // 由 Game 注入的持久化器（与 market.journal 同一模式）
    this.journal = null;
  }

  /** 策略所属的股票与市场；股票已下线时返回 null */
  ctxOf(stockId) {
    const market = this.markets.get(stockId);
    const stock = this.stocks.get(stockId);
    return market && stock ? { market, stock } : null;
  }

  listFor(name) {
    return [...this.byId.values()].filter((s) => s.account === name);
  }

  activeCount(name) {
    return this.listFor(name).filter((s) => s.enabled && !s.done).length;
  }

  // ---------- 增删改 ----------

  create(account, type, paramsRaw, stockId) {
    if (!account || account.isNPC) return { ok: false, error: '仅玩家账户可使用自动交易' };
    if (!TYPE_LABEL[type]) return { ok: false, error: '未知策略类型' };
    const ctx = this.ctxOf(stockId);
    if (!ctx) return { ok: false, error: '未知股票' };
    // 上限按账户跨股票合计（20 条是防刷的账户级配额，不是每只股票 20 条）
    if (this.listFor(account.name).length >= config.auto.maxPerAccount) {
      return { ok: false, error: `单账户最多 ${config.auto.maxPerAccount} 条策略，请先删除旧策略` };
    }
    const v = this.validate(type, paramsRaw, ctx);
    if (!v.ok) return v;

    this.seq += 1;
    const now = Date.now();
    const s = {
      id: 'A' + this.seq,
      account: account.name,
      stockId: ctx.stock.id,
      type,
      enabled: true,
      done: false,
      params: v.params,
      state: v.state || {},
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(s.id, s);
    this.logEvent(s, now, `策略已创建（${TYPE_LABEL[type]}·${ctx.stock.name}）`);
    this.journal?.autoChanged(s);
    return { ok: true, id: s.id };
  }

  update(account, id, patch) {
    const s = this.byId.get(id);
    if (!s || s.account !== account.name) return { ok: false, error: '策略不存在' };
    const now = Date.now();
    if (patch && patch.enabled != null) {
      const en = !!patch.enabled;
      if (en && s.done) return { ok: false, error: '策略已结束，无法重新启用' };
      if (en !== s.enabled) {
        s.enabled = en;
        this.logEvent(s, now, en ? '已启用' : '已暂停');
      }
    }
    s.updatedAt = now;
    this.journal?.autoChanged(s);
    return { ok: true, id: s.id };
  }

  remove(account, id) {
    const s = this.byId.get(id);
    if (!s || s.account !== account.name) return { ok: false, error: '策略不存在' };
    this.byId.delete(id);
    this.journal?.autoRemoved(id);
    return { ok: true, id: s.id };
  }

  /** 从存档行恢复（坏行跳过，不让一格脏数据废掉整局策略） */
  restore(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      try {
        if (!row || !TYPE_LABEL[row.type] || !row.id) continue;
        // 股票已不在本局配置里的策略直接跳过（配置变动后不该留孤儿策略在跑）
        if (!row.stock_id || !this.ctxOf(row.stock_id)) continue;
        const s = {
          id: String(row.id),
          account: String(row.account),
          stockId: String(row.stock_id),
          type: row.type,
          enabled: !!row.enabled,
          done: !!row.done,
          params: JSON.parse(row.params),
          state: JSON.parse(row.state || '{}') || {},
          events: [],
          createdAt: row.created_at || Date.now(),
          updatedAt: row.updated_at || Date.now(),
        };
        delete s.state.events; // 日志不落盘
        this.byId.set(s.id, s);
        const n = parseInt(String(row.id).slice(1), 10);
        if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
      } catch (e) {
        logger.warn(`[我是股神] 自动交易策略恢复失败，已跳过: ${row && row.id} ${e.message}`);
      }
    }
  }

  // ---------- 主循环驱动 ----------

  step(now) {
    for (const s of this.byId.values()) {
      if (!s.enabled || s.done) continue;
      const ctx = this.ctxOf(s.stockId);
      if (!ctx) continue;
      // 停牌按股票单独判断：只有本股在停牌才冻结它的策略，其它股票照跑
      if (ctx.market.isHalted(now)) continue;
      try {
        if (s.type === 'tps') this.stepTps(s, ctx, now);
        else if (s.type === 'grid') this.stepGrid(s, ctx, now);
        else if (s.type === 'ma') this.stepMa(s, ctx, now);
        else if (s.type === 'dca') this.stepDca(s, ctx, now);
      } catch (e) {
        logger.error(`[我是股神] 自动策略 ${s.id}(${s.type}) 执行异常:`, e);
        this.logEvent(s, now, '执行异常，本 tick 跳过');
        this.journal?.autoChanged(s);
      }
    }
  }

  // ---------- 止盈止损（一次性触发） ----------

  stepTps(s, ctx, now) {
    const acc = this.store.get(s.account);
    if (!acc) {
      this.markDone(s, now, '账户不存在，策略结束');
      return;
    }
    const p = s.params;
    const last = ctx.market.lastPrice;
    const sid = ctx.stock.id;
    const isLong = p.position === 'long';
    const total = isLong ? acc.longQty(sid) : acc.shortQty(sid);
    if (total <= 0) {
      this.markDone(s, now, isLong ? '已无多头持仓，策略结束' : '已无空头持仓，策略结束');
      return;
    }

    let fire = false;
    if (isLong) {
      if (p.tp && last >= p.tp) fire = true;
      if (p.sl && last <= p.sl) fire = true;
    } else {
      if (p.tp && last <= p.tp) fire = true;
      if (p.sl && last >= p.sl) fire = true;
    }
    if (!fire) return;

    const target = p.qty > 0 ? Math.min(p.qty, total) : total;
    const avail = isLong ? acc.freeSellableLong(sid, now) : acc.coverableShort(sid);
    const qty = Math.min(target, avail);
    if (qty <= 0) {
      if (!s.state.waiting) {
        s.state.waiting = true;
        this.logEvent(s, now, isLong ? '已触发卖出，但可卖为 0（锁仓中），等待解锁' : '已触发平仓，但可平为 0，等待');
        this.journal?.autoChanged(s);
      }
      return;
    }
    const action = isLong ? ACTIONS.SELL_CLOSE : ACTIONS.BUY_CLOSE;
    const price = isLong ? this.pegSell(ctx.market, last) : this.pegBuy(ctx.market, last);
    const r = ctx.market.place(acc, { action, qty, price, now });
    if (r.ok) {
      s.state.waiting = false;
      this.markDone(s, now, `已触发${isLong ? '卖出平多' : '买入平空'} ${qty}股 @${price}，策略完成`);
    } else if (!/频繁/.test(r.error || '')) {
      this.logEvent(s, now, `触发后下单失败: ${r.error}`);
      this.journal?.autoChanged(s);
    }
  }

  // ---------- 网格（循环） ----------

  stepGrid(s, ctx, now) {
    const acc = this.store.get(s.account);
    if (!acc) {
      this.markDone(s, now, '账户不存在，策略结束');
      return;
    }
    const p = s.params;
    const st = s.state;
    if (!Array.isArray(st.buys)) st.buys = [];
    if (!Number.isFinite(st.nextLevel)) st.nextLevel = 0;
    const sid = ctx.stock.id;
    const last = ctx.market.lastPrice;

    // 1) 结算已完结的网格挂单（成交部分进格子库存）
    for (const key of ['pendingBuyId', 'pendingSellId']) {
      const id = st[key];
      if (!id) continue;
      if (acc.orders.has(id)) continue; // 仍在挂
      const doneOrder = acc.orderHistory.find((o) => o.id === id);
      const filled = doneOrder ? doneOrder.filled || 0 : 0;
      if (key === 'pendingBuyId') {
        if (filled > 0) {
          st.buys.push({ level: st.pendingBuyLevel, shares: filled });
          this.logEvent(s, now, `第${st.pendingBuyLevel}格买入成交 ${filled}股`);
        } else {
          this.logEvent(s, now, `第${st.pendingBuyLevel}格买入未成交已失效`);
        }
        st.pendingBuyLevel = null;
      } else {
        if (filled > 0 && st.buys.length) {
          st.buys[0].shares -= filled;
          this.logEvent(s, now, `网格卖出成交 ${filled}股`);
          if (st.buys[0].shares <= 0) st.buys.shift();
        }
      }
      st[key] = null;
      this.journal?.autoChanged(s);
    }

    // 2) 卖出：最早一格（FIFO）达到目标价
    if (!st.pendingSellId && st.buys.length && st.buys[0].shares > 0) {
      const entry = st.buys[0];
      const target = gridSellPrice(p.base, p.stepPct, entry.level);
      if (last >= target && this.cooldownLeft(acc, now) <= 0) {
        const sellable = acc.freeSellableLong(sid, now);
        const qty = Math.min(entry.shares, sellable);
        if (qty > 0) {
          // 买一已 ≥ 目标价就按买价打（锁定更高卖价），否则挂目标价等
          const bid = ctx.market.book.bids[0];
          const raw = bid && bid.price >= target ? bid.price : target;
          const price = this.clampLimit(ctx.market, raw, last);
          const r = ctx.market.place(acc, { action: ACTIONS.SELL_CLOSE, qty, price, now });
          if (r.ok) {
            st.pendingSellId = r.order.id;
            this.logEvent(s, now, `第${entry.level}格触发卖出 ${qty}股 @${price}`);
            this.journal?.autoChanged(s);
          } else if (!/频繁|锁仓/.test(r.error || '')) {
            this.logEvent(s, now, `第${entry.level}格卖出失败: ${r.error}`);
            this.journal?.autoChanged(s);
          }
        }
      }
    }

    // 3) 买入：价格跌到下一格
    const openLevels = st.buys.filter((b) => b.shares > 0).length;
    if (!st.pendingBuyId && openLevels < p.maxLevels) {
      const level = st.nextLevel + 1;
      const bp = gridBuyPrice(p.base, p.stepPct, level);
      if (last <= bp && this.cooldownLeft(acc, now) <= 0) {
        const need = r2(bp * p.qty * (1 + config.trade.feeRate));
        if (acc.cash < need) {
          if (!st.cashWarned) {
            st.cashWarned = true;
            this.logEvent(s, now, `第${level}格需 ${need} 元，可用资金不足，暂停买入`);
            this.journal?.autoChanged(s);
          }
        } else {
          // 卖一已 ≤ 格子价就按卖价打（更快成交），否则挂格子价
          const ask = ctx.market.book.asks[0];
          const raw = ask && ask.price <= bp ? ask.price : bp;
          const price = this.clampLimit(ctx.market, raw, last);
          const r = ctx.market.place(acc, { action: ACTIONS.BUY_OPEN, qty: p.qty, price, now });
          if (r.ok) {
            st.pendingBuyId = r.order.id;
            st.pendingBuyLevel = level;
            st.nextLevel = level;
            st.cashWarned = false;
            this.logEvent(s, now, `第${level}格触发买入 ${p.qty}股 @${price}`);
            this.journal?.autoChanged(s);
          } else if (!/频繁/.test(r.error || '')) {
            this.logEvent(s, now, `第${level}格买入失败: ${r.error}`);
            this.journal?.autoChanged(s);
          }
        }
      }
    }
  }

  // ---------- 双均线（金叉买 / 死叉卖） ----------

  stepMa(s, ctx, now) {
    const acc = this.store.get(s.account);
    if (!acc) {
      this.markDone(s, now, '账户不存在，策略结束');
      return;
    }
    const p = s.params;
    const st = s.state;
    const hist = ctx.market.priceHistory;
    if (hist.length < p.slow) {
      if (!st.warmLogged) {
        st.warmLogged = true;
        this.logEvent(s, now, `行情采集中，还需 ${p.slow - hist.length} 个点才能计算均线`);
        this.journal?.autoChanged(s);
      }
      return;
    }

    let sumFast = 0;
    let sumSlow = 0;
    const start = hist.length - p.slow;
    for (let i = start; i < hist.length; i++) {
      const px = hist[i].price;
      sumSlow += px;
      if (i >= hist.length - p.fast) sumFast += px;
    }
    const fastMa = sumFast / p.fast;
    const slowMa = sumSlow / p.slow;
    const side = fastMa > slowMa ? 1 : 0;

    if (st.lastSide == null) {
      st.lastSide = side;
      this.journal?.autoChanged(s);
      return;
    }
    if (side !== st.lastSide) {
      st.lastSide = side;
      st.pendingSignal = side;
      this.logEvent(
        s,
        now,
        side === 1
          ? `金叉：快线 ${fastMa.toFixed(2)} > 慢线 ${slowMa.toFixed(2)}，等待买入`
          : `死叉：快线 ${fastMa.toFixed(2)} ≤ 慢线 ${slowMa.toFixed(2)}，等待卖出`
      );
      this.journal?.autoChanged(s);
    }
    if (st.pendingSignal == null) return;
    if (this.cooldownLeft(acc, now) > 0) return;

    const last = ctx.market.lastPrice;
    const sid = ctx.stock.id;
    if (st.pendingSignal === 1) {
      const price = this.pegBuy(ctx.market, last);
      const budget = acc.cash * (p.budgetPct / 100);
      const lot = ctx.stock.lotSize;
      const qty = Math.floor(budget / (price * (1 + config.trade.feeRate)) / lot) * lot;
      if (qty < lot) {
        this.clearSignal(s, now, '金叉触发但按投入比例可买资金不足，放弃本次买入');
        return;
      }
      const r = ctx.market.place(acc, { action: ACTIONS.BUY_OPEN, qty, price, now });
      if (r.ok) this.clearSignal(s, now, `金叉买入 ${qty}股 @${price}`);
      else if (!/频繁/.test(r.error || '')) this.clearSignal(s, now, `金叉买入失败: ${r.error}`);
    } else {
      const qty = acc.freeSellableLong(sid, now);
      if (qty <= 0) {
        if (acc.longQty(sid) <= 0) this.clearSignal(s, now, '死叉触发但无多头持仓，跳过本次卖出');
        return; // 锁仓中：等解锁后下个 tick 重试
      }
      const price = this.pegSell(ctx.market, last);
      const r = ctx.market.place(acc, { action: ACTIONS.SELL_CLOSE, qty, price, now });
      if (r.ok) this.clearSignal(s, now, `死叉卖出 ${qty}股 @${price}`);
      else if (!/频繁/.test(r.error || '')) this.clearSignal(s, now, `死叉卖出失败: ${r.error}`);
    }
  }

  // ---------- 定投 ----------

  stepDca(s, ctx, now) {
    const acc = this.store.get(s.account);
    if (!acc) {
      this.markDone(s, now, '账户不存在，策略结束');
      return;
    }
    const p = s.params;
    const st = s.state;
    if (st.nextAt == null) st.nextAt = now;
    if (now < st.nextAt) return;
    if (p.maxTimes > 0 && st.doneTimes >= p.maxTimes) {
      this.markDone(s, now, `已完成 ${st.doneTimes} 次定投，策略自动结束`);
      return;
    }
    if (this.cooldownLeft(acc, now) > 0) return;

    const last = ctx.market.lastPrice;
    const price = this.pegBuy(ctx.market, last);
    const budget = Math.min(p.amount, acc.cash);
    const lot = ctx.stock.lotSize;
    const qty = Math.floor(budget / (price * (1 + config.trade.feeRate)) / lot) * lot;
    if (qty < lot) {
      this.markDone(s, now, '可用资金不足以完成 1 手定投，策略自动结束');
      return;
    }
    const r = ctx.market.place(acc, { action: ACTIONS.BUY_OPEN, qty, price, now });
    if (r.ok) {
      st.doneTimes = (st.doneTimes || 0) + 1;
      st.totalSpent = r2((st.totalSpent || 0) + price * qty);
      st.nextAt = now + p.intervalMs;
      this.logEvent(s, now, `第${st.doneTimes}次定投买入 ${qty}股 @${price}`);
      if (p.maxTimes > 0 && st.doneTimes >= p.maxTimes) {
        this.markDone(s, now, `已完成 ${st.doneTimes} 次定投，策略自动结束`);
        return;
      }
      this.journal?.autoChanged(s);
    } else if (!/频繁/.test(r.error || '')) {
      // 失败也顺延，避免每个 tick 重试刷屏
      st.nextAt = now + p.intervalMs;
      this.logEvent(s, now, `定投买入失败: ${r.error}`);
      this.journal?.autoChanged(s);
    }
  }

  // ---------- 工具 ----------

  cooldownLeft(acc, now) {
    if (acc.lastOrderAt == null) return 0;
    return Math.max(0, config.trade.cooldownMs - (now - acc.lastOrderAt));
  }

  /**
   * 限价夹进「最新价 ± maxDeviation」窗口，避免委托被偏离校验拒掉。
   *
   * 必须留出余量：夹到窗口边界后还要取整到分，而 `round()` 可能把价格推到边界之外
   * （如 19.99 的上界 29.985 取整成 29.99，偏离变成 50.03% 就被服务端拒单）。
   * 盘口里有脱离行情的旧挂单时（玩家/网格/均线留下的远价单），贴对手价就会取到这种价格，
   * 策略于是每个间隔都下单失败——这里按「至少一分钱或 0.5%」的余量把价格收进窗口内侧。
   */
  clampLimit(market, price, last) {
    const margin = Math.max(0.01, last * 0.005);
    const hi = market.roundPrice(last * (1 + config.trade.maxDeviation) - margin);
    const lo = Math.max(0.01, market.roundPrice(last * (1 - config.trade.maxDeviation) + margin));
    return market.roundPrice(Math.min(hi, Math.max(lo, price)));
  }

  /** 主动买入挂价：优先贴卖一 */
  pegBuy(market, last) {
    const ask = market.book.asks[0];
    const raw = ask ? ask.price : market.roundPrice(last * 1.002);
    return this.clampLimit(market, raw, last);
  }

  /** 主动卖出挂价：优先贴买一 */
  pegSell(market, last) {
    const bid = market.book.bids[0];
    const raw = bid ? bid.price : market.roundPrice(last * 0.998);
    return this.clampLimit(market, raw, last);
  }

  markDone(s, now, text) {
    s.done = true;
    s.enabled = false;
    this.logEvent(s, now, text);
    this.journal?.autoChanged(s);
  }

  clearSignal(s, now, text) {
    s.state.pendingSignal = null;
    this.logEvent(s, now, text);
    this.journal?.autoChanged(s);
  }

  logEvent(s, now, text) {
    s.events.unshift({ t: now, text: String(text).slice(0, 120) });
    if (s.events.length > config.auto.eventKeep) s.events.length = config.auto.eventKeep;
    s.updatedAt = now;
  }

  // ---------- 参数校验 ----------

  /**
   * 参数校验。基准价/手数的默认值取**策略所属股票**的行情与手数；
   * 网格 base 缺省时用该股最新价，所以 ctx 必传。
   */
  validate(type, raw, ctx) {
    const p = raw || {};
    const num = (v) => Number(v);
    const last = ctx.market.lastPrice || ctx.stock.initPrice;
    const lot = ctx.stock.lotSize;

    if (type === 'tps') {
      const position = p.position === 'short' ? 'short' : 'long';
      const tp = p.tp == null || p.tp === '' ? 0 : num(p.tp);
      const sl = p.sl == null || p.sl === '' ? 0 : num(p.sl);
      if ((tp && (!Number.isFinite(tp) || tp <= 0)) || (sl && (!Number.isFinite(sl) || sl <= 0))) {
        return { ok: false, error: '止盈/止损价必须为正数' };
      }
      if (!tp && !sl) return { ok: false, error: '止盈和止损至少设置一个' };
      let qty = p.qty == null || p.qty === '' ? 0 : Math.floor(num(p.qty));
      if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: '数量无效' };
      return { ok: true, params: { position, tp: r2(tp), sl: r2(sl), qty }, state: {} };
    }

    if (type === 'grid') {
      const g = config.auto.grid;
      const base = p.base == null || p.base === '' ? last : num(p.base);
      if (!Number.isFinite(base) || base <= 0) return { ok: false, error: '基准价无效' };
      const stepPct = num(p.stepPct);
      if (!Number.isFinite(stepPct) || stepPct < g.minStepPct || stepPct > g.maxStepPct) {
        return { ok: false, error: `网格间距需在 ${g.minStepPct}% ~ ${g.maxStepPct}% 之间` };
      }
      const qty = Math.floor(num(p.qty));
      if (!Number.isFinite(qty) || qty <= 0 || qty % lot !== 0) {
        return { ok: false, error: `每格数量必须为 ${lot} 股的整数倍` };
      }
      let maxLevels = Math.floor(num(p.maxLevels == null || p.maxLevels === '' ? 10 : p.maxLevels));
      if (!Number.isFinite(maxLevels) || maxLevels < 1) maxLevels = 10;
      if (maxLevels > g.maxLevels) maxLevels = g.maxLevels;
      return {
        ok: true,
        params: { base: r2(base), stepPct, qty, maxLevels },
        state: { buys: [], nextLevel: 0, pendingBuyId: null, pendingSellId: null, pendingBuyLevel: null, cashWarned: false },
      };
    }

    if (type === 'ma') {
      const c = config.auto.ma;
      const fast = Math.floor(num(p.fast));
      const slow = Math.floor(num(p.slow));
      if (!Number.isFinite(fast) || fast < c.minFast || fast > c.maxFast) {
        return { ok: false, error: `快线需在 ${c.minFast} ~ ${c.maxFast} tick 之间` };
      }
      if (!Number.isFinite(slow) || slow < fast + c.minSlowGap || slow > c.maxSlow) {
        return { ok: false, error: `慢线需在 快线+${c.minSlowGap} ~ ${c.maxSlow} tick 之间` };
      }
      let budgetPct = num(p.budgetPct == null || p.budgetPct === '' ? 50 : p.budgetPct);
      if (!Number.isFinite(budgetPct) || budgetPct < 1) budgetPct = 50;
      if (budgetPct > 100) budgetPct = 100;
      return { ok: true, params: { fast, slow, budgetPct }, state: { lastSide: null, pendingSignal: null } };
    }

    if (type === 'dca') {
      const amount = num(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: '每次金额必须为正' };
      let intervalMs = Math.floor(num(p.intervalMs == null || p.intervalMs === '' ? 60000 : p.intervalMs));
      if (!Number.isFinite(intervalMs) || intervalMs < config.auto.dcaMinIntervalMs) {
        intervalMs = config.auto.dcaMinIntervalMs;
      }
      let maxTimes = Math.floor(num(p.maxTimes == null || p.maxTimes === '' ? 0 : p.maxTimes));
      if (!Number.isFinite(maxTimes) || maxTimes < 0) maxTimes = 0;
      return {
        ok: true,
        params: { amount: r2(amount), intervalMs, maxTimes },
        state: { nextAt: Date.now(), doneTimes: 0, totalSpent: 0 },
      };
    }

    return { ok: false, error: '未知策略类型' };
  }

  // ---------- 客户端快照 ----------

  serialize(s, now) {
    const ctx = this.ctxOf(s.stockId);
    const out = {
      id: s.id,
      stockId: s.stockId,
      stockName: ctx ? ctx.stock.name : s.stockId,
      type: s.type,
      typeLabel: TYPE_LABEL[s.type] || s.type,
      enabled: s.enabled,
      done: s.done,
      params: s.params,
      createdAt: s.createdAt,
      events: s.events.slice(0, 5),
    };
    const st = s.state || {};
    if (s.type === 'tps') {
      out.state = { waiting: !!st.waiting };
    } else if (s.type === 'grid') {
      const open = (st.buys || []).filter((b) => b.shares > 0);
      out.state = {
        openLevels: open.length,
        heldShares: open.reduce((a, b) => a + b.shares, 0),
        nextBuy:
          open.length < s.params.maxLevels
            ? gridBuyPrice(s.params.base, s.params.stepPct, (st.nextLevel || 0) + 1)
            : null,
        nextSell: open.length ? gridSellPrice(s.params.base, s.params.stepPct, open[0].level) : null,
        pending: !!(st.pendingBuyId || st.pendingSellId),
      };
    } else if (s.type === 'ma') {
      const histLen = ctx ? ctx.market.priceHistory.length : 0;
      out.state = {
        ready: histLen >= s.params.slow,
        warmupLeft: Math.max(0, s.params.slow - histLen),
        side: st.lastSide == null ? null : st.lastSide,
        pendingSignal: st.pendingSignal == null ? null : st.pendingSignal,
      };
    } else if (s.type === 'dca') {
      out.state = {
        doneTimes: st.doneTimes || 0,
        nextAt: st.nextAt || 0,
        totalSpent: st.totalSpent || 0,
      };
    } else {
      out.state = {};
    }
    return out;
  }

  serializeAll(name, now) {
    return this.listFor(name)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => this.serialize(s, now));
  }
}

module.exports = { AutoManager, TYPE_LABEL };
