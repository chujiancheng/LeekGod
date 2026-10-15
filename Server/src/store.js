/**
 * 账户存储（内存）：玩家与 NPC 共用同一结构
 */
const config = require('./config');

const r2 = (v) => Math.round(v * 100) / 100;

class Account {
  constructor(name, isNPC = false, role = null) {
    this.name = name;
    this.isNPC = isNPC;
    this.role = role || (isNPC ? 'npc' : 'player'); // inst / hot / big / mid / small / player
    this.cash = config.account.initialCash;
    this.orderFrozen = 0; // 挂单冻结（买入资金 / 开空保证金预估 / 费用预估），跨股票汇总
    this.shortMargin = 0; // 已成交开空的真实保证金合计（跨股票）
    this.realizedPnL = 0; // 已实现盈亏（累计）
    this.deposited = 0; // 终身累计加钱额（受 config.account.deposit.maxLifetime 封顶）
    this.initialLong = 0; // 开服/建仓时初始持股（用于股东变动统计）
    // 按股票的融券/融资明细。融券池每只股票一套，挂借量与欠息必须按股票记账：
    // 混在一个数里会让 A 股的欠息被拿去补 B 股的出借人，撤借闸门也会串池
    // { stockId: { lendOffered, lendInterestEarned, lendInterestDebt, lendInterestPaid, financeInterestAccrued } }
    this.ledger = new Map();
    this.longs = new Map(); // stockId -> { lots: [{qty, price, ts, reserved, debt, principal}] }
    this.shorts = new Map(); // stockId -> { lots: [{qty, price, margin, reserved}] }
    this.orders = new Map(); // 挂单中的订单 id -> order
    this.orderHistory = []; // 最近委托（含已完结）
    this.tradeHistory = []; // 最近成交
    this.lastOrderAt = null; // 上次下单时间（冷却），null 表示从未下单
    this.createdAt = Date.now();
  }

  /** 取某只股票的融券/计息明细（没有则建一条全零的） */
  ledgerOf(stockId) {
    let l = this.ledger.get(stockId);
    if (!l) {
      l = {
        lendOffered: 0,
        lendInterestEarned: 0,
        lendInterestDebt: 0,
        lendInterestPaid: 0,
        financeInterestAccrued: 0,
      };
      this.ledger.set(stockId, l);
    }
    return l;
  }

  // ---------- 账户级汇总（多股票口径） ----------

  /** 全部股票的多头市值合计 */
  totalLongValue(priceOf) {
    let v = 0;
    for (const [stockId, p] of this.longs) {
      if (!p.lots.length) continue;
      v += this.longQty(stockId) * priceOf(stockId);
    }
    return v;
  }

  /** 全部股票的空头市值合计 */
  totalShortMV(priceOf) {
    let v = 0;
    for (const [stockId, p] of this.shorts) {
      if (!p.lots.length) continue;
      v += this.shortQty(stockId) * priceOf(stockId);
    }
    return v;
  }

  /** 全部股票的融资负债合计 */
  totalFinanceDebt() {
    let d = 0;
    for (const p of this.longs.values()) {
      for (const lot of p.lots) d += lot.debt || 0;
    }
    return d;
  }

  /** 全部股票的做空欠息合计（负债，计入权益） */
  totalLendInterestDebt() {
    let d = 0;
    for (const l of this.ledger.values()) d += l.lendInterestDebt || 0;
    return d;
  }

  longPos(stockId) {
    let p = this.longs.get(stockId);
    if (!p) {
      p = { lots: [] };
      this.longs.set(stockId, p);
    }
    return p;
  }

  shortPos(stockId) {
    let p = this.shorts.get(stockId);
    if (!p) {
      p = { lots: [] };
      this.shorts.set(stockId, p);
    }
    return p;
  }

  longQty(stockId) {
    const p = this.longs.get(stockId);
    return p ? p.lots.reduce((s, l) => s + l.qty, 0) : 0;
  }

  shortQty(stockId) {
    const p = this.shorts.get(stockId);
    return p ? p.lots.reduce((s, l) => s + l.qty, 0) : 0;
  }

  /** 可卖出的多头：已过锁仓时间且未被其他委托占用 */
  sellableLong(stockId, now) {
    const p = this.longs.get(stockId);
    if (!p) return 0;
    let n = 0;
    for (const lot of p.lots) {
      if (now - lot.ts >= config.trade.lockMs) {
        n += lot.qty - lot.reserved;
      }
    }
    return n;
  }

  /** 真正可卖：可卖多头中未挂入融券池的部分（挂借量按股票取） */
  freeSellableLong(stockId, now) {
    const offered = this.ledgerOf(stockId).lendOffered || 0;
    return Math.max(0, this.sellableLong(stockId, now) - offered);
  }

  /**
   * 强平可卖多头：豁免 T+ 锁仓（强平不受自愿卖出的锁仓限制），
   * 但挂借中的券不能动——否则出借人一边被卖掉券、一边继续挂借收息
   */
  forceSellableLong(stockId) {
    const p = this.longs.get(stockId);
    if (!p) return 0;
    let n = 0;
    for (const lot of p.lots) n += lot.qty - lot.reserved;
    return Math.max(0, n - (this.ledgerOf(stockId).lendOffered || 0));
  }

  /** 可平掉的空头（未被占用） */
  coverableShort(stockId) {
    const p = this.shorts.get(stockId);
    if (!p) return 0;
    return p.lots.reduce((s, l) => s + (l.qty - l.reserved), 0);
  }

  /** 从多头 FIFO 中预留 qty（需可卖），成功返回 true */
  reserveLong(stockId, qty, now) {
    let need = qty;
    const p = this.longs.get(stockId);
    if (!p) return false;
    for (const lot of p.lots) {
      if (need <= 0) break;
      if (now - lot.ts < config.trade.lockMs) continue;
      const avail = lot.qty - lot.reserved;
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      lot.reserved += take;
      need -= take;
    }
    return need === 0;
  }

  releaseLong(stockId, qty) {
    const p = this.longs.get(stockId);
    if (!p) return;
    let need = qty;
    for (const lot of p.lots) {
      if (need <= 0) break;
      const take = Math.min(lot.reserved, need);
      lot.reserved -= take;
      need -= take;
    }
  }

  /**
   * 扣减多头 FIFO（先释放预留再扣数量），返回实际扣减的总成本与批次负债。
   * 负债（融资买入的借入本金 + 已摊入利息）随批次按比例偿还。
   */
  consumeLong(stockId, qty) {
    const p = this.longs.get(stockId);
    if (!p) return { qty: 0, cost: 0, debt: 0 };
    let need = qty;
    let cost = 0;
    let debt = 0;
    const kept = [];
    for (const lot of p.lots) {
      if (need <= 0) {
        kept.push(lot);
        continue;
      }
      const take = Math.min(lot.qty, need);
      const frac = take / lot.qty;
      cost += take * lot.price;
      debt += (lot.debt || 0) * frac;
      // 本金与负债同比例减少，批次上的"未还利息 = debt − principal"才不会被平仓打乱
      lot.principal = r2((lot.principal || 0) - (lot.principal || 0) * frac);
      lot.qty -= take;
      lot.debt = r2((lot.debt || 0) - (lot.debt || 0) * frac);
      lot.reserved = Math.max(0, lot.reserved - take);
      need -= take;
      if (lot.qty > 0) kept.push(lot);
    }
    p.lots = kept;
    return { qty: qty - need, cost, debt: r2(debt) };
  }

  /** 从空头 FIFO 中预留 qty，成功返回 true */
  reserveShort(stockId, qty) {
    let need = qty;
    const p = this.shorts.get(stockId);
    if (!p) return false;
    for (const lot of p.lots) {
      if (need <= 0) break;
      const avail = lot.qty - lot.reserved;
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      lot.reserved += take;
      need -= take;
    }
    return need === 0;
  }

  releaseShort(stockId, qty) {
    const p = this.shorts.get(stockId);
    if (!p) return;
    let need = qty;
    for (const lot of p.lots) {
      if (need <= 0) break;
      const take = Math.min(lot.reserved, need);
      lot.reserved -= take;
      need -= take;
    }
  }

  /**
   * 预览平多 qty 将偿还的融资负债（与 reserveLong 同序遍历未预留部分，不修改状态）。
   * 与 previewShortMargin 同口径：只看 qty - reserved，避免并发卖单重复计入预检。
   */
  previewFinanceDebt(stockId, qty) {
    const p = this.longs.get(stockId);
    if (!p) return 0;
    let need = qty;
    let debt = 0;
    for (const lot of p.lots) {
      if (need <= 0) break;
      const avail = lot.qty - lot.reserved;
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      if (lot.debt > 0) debt += lot.debt * (take / lot.qty);
      need -= take;
    }
    return r2(debt);
  }

  /**
   * 预览平空 qty 将释放的保证金（与 reserveShort 同序遍历未预留部分，不修改状态）。
   * 下单预检必须用这个值而不是 shortMargin 总额：结算只回 FIFO 消耗部分，
   * 按总额预检会让部分平空把现金结算成负数。
   * 只看 qty - reserved：并发平空单各按自己的预留段预览，
   * 否则多张单都从 FIFO 头起算，同一段保证金会被重复计入预检
   */
  previewShortMargin(stockId, qty) {
    const p = this.shorts.get(stockId);
    if (!p) return 0;
    let need = qty;
    let margin = 0;
    for (const lot of p.lots) {
      if (need <= 0) break;
      const avail = lot.qty - lot.reserved;
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      margin += lot.margin * (take / lot.qty);
      need -= take;
    }
    return margin;
  }

  /**
   * 平空 FIFO 扣减，返回 {qty, margin, openSum}
   * openSum = Σ 开仓价×股数，用于计算已实现盈亏
   */
  consumeShort(stockId, qty) {
    const p = this.shorts.get(stockId);
    if (!p) return { qty: 0, margin: 0, openSum: 0 };
    let need = qty;
    let margin = 0;
    let openSum = 0;
    const kept = [];
    for (const lot of p.lots) {
      if (need <= 0) {
        kept.push(lot);
        continue;
      }
      const take = Math.min(lot.qty, need);
      const frac = take / lot.qty;
      margin += lot.margin * frac;
      openSum += lot.price * take;
      lot.qty -= take;
      lot.margin -= lot.margin * frac;
      lot.reserved = Math.max(0, lot.reserved - take);
      need -= take;
      if (lot.qty > 0) kept.push(lot);
    }
    p.lots = kept;
    return { qty: qty - need, margin, openSum };
  }

  /** 多头市值 */
  longValue(stockId, lastPrice) {
    return this.longQty(stockId) * lastPrice;
  }

  /** 融资负债（多头批次 borrow 本金 + 已摊利息合计） */
  financeDebt(stockId) {
    const p = this.longs.get(stockId);
    if (!p) return 0;
    let d = 0;
    for (const lot of p.lots) d += lot.debt || 0;
    return d;
  }

  /** 融资负债里还没还的借入本金（debt − principal = 这批已计但未还的利息） */
  financePrincipal(stockId) {
    const p = this.longs.get(stockId);
    if (!p) return 0;
    let d = 0;
    for (const lot of p.lots) d += lot.principal || 0;
    return d;
  }

  /**
   * 组合口径权益 = 可用现金 + 挂单冻结 + 空头保证金 + Σ各股多头市值 − Σ各股空头市值
   *                − Σ各股融资负债 − Σ各股做空欠息
   *
   * 多股票后必须按**整个账户**汇总：现金是一份（玩家只有一笔钱），
   * 若按单只股票算，每只股票的开仓预检都会各自看到全额现金，敞口会被放大到 N 倍。
   * 单股票账户下与旧口径逐项一致。
   * @param {(stockId:string)=>number} priceOf 取某只股票最新价
   */
  equity(priceOf) {
    return (
      this.cash +
      this.orderFrozen +
      this.shortMargin +
      this.totalLongValue(priceOf) -
      this.totalShortMV(priceOf) -
      this.totalFinanceDebt() -
      this.totalLendInterestDebt()
    );
  }

  /** 单只股票的空头市值（风控按股票定位敞口时用） */
  shortMV(stockId, lastPrice) {
    return this.shortQty(stockId) * lastPrice;
  }

  /**
   * 把某只股票的多头/空头批次合并成一条（数量加权均价）。
   *
   * 只给 NPC 账户用。NPC 每 tick 都在成交，一笔成交就压一条批次，单账户能攒到几千条——
   * 而落盘写一个账户要把它的全部批次整段删除再写回（persist.writeAccount），
   * 正式档实测每 tick 因此要重写 40 万行批次、commit 占掉 2 秒（tick 预算才 0.7 秒）。
   *
   * 合并是**账实等价**的：数量、成本合计（Σ 数量×价格）、融资负债与本金、保证金、
   * 已预留量全部按合计保留，锁仓时间取最早（等于「先卖最早买的」，与原 FIFO 口径一致）。
   * 唯一变化是盈亏口径从 FIFO 变成均价——NPC 不参与排行榜与股东变动统计，没有可见影响；
   * **玩家账户绝不合并**（玩家的已实现盈亏、成本价都是给人看的）。
   */
  consolidate(stockId) {
    const lp = this.longs.get(stockId);
    if (lp && lp.lots.length > 1) {
      let qty = 0;
      let cost = 0;
      let reserved = 0;
      let debt = 0;
      let principal = 0;
      let ts = Infinity;
      for (const l of lp.lots) {
        qty += l.qty;
        cost += l.qty * l.price;
        reserved += l.reserved || 0;
        debt += l.debt || 0;
        principal += l.principal || 0;
        if (l.ts != null && l.ts < ts) ts = l.ts;
      }
      if (qty > 0) {
        lp.lots = [{ qty, price: cost / qty, ts, reserved, debt: r2(debt), principal: r2(principal) }];
      }
    }
    const sp = this.shorts.get(stockId);
    if (sp && sp.lots.length > 1) {
      let qty = 0;
      let cost = 0;
      let margin = 0;
      let reserved = 0;
      for (const l of sp.lots) {
        qty += l.qty;
        cost += l.qty * l.price;
        margin += l.margin || 0;
        reserved += l.reserved || 0;
      }
      if (qty > 0) {
        sp.lots = [{ qty, price: cost / qty, margin: r2(margin), reserved }];
      }
    }
  }
}

class Store {
  constructor() {
    this.accounts = new Map(); // name -> Account
    this.playerCount = 0; // 玩家账户数（不含 NPC），O(1) 供上限判断与在线数展示
  }

  get(name) {
    return this.accounts.get(name) || null;
  }

  createOrGet(name) {
    let acc = this.accounts.get(name);
    if (!acc) {
      acc = new Account(name, false);
      this.accounts.set(name, acc);
      this.playerCount += 1;
    }
    return acc;
  }

  put(acc) {
    if (!this.accounts.has(acc.name) && !acc.isNPC) this.playerCount += 1;
    this.accounts.set(acc.name, acc);
  }

  players() {
    return [...this.accounts.values()].filter((a) => !a.isNPC);
  }

  all() {
    return [...this.accounts.values()];
  }
}

module.exports = { Store, Account, r2 };
