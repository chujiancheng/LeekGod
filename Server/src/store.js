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
    this.orderFrozen = 0; // 挂单冻结（买入资金 / 开空保证金预估 / 费用预估）
    this.shortMargin = 0; // 已成交开空的真实保证金
    this.realizedPnL = 0; // 已实现盈亏（累计）
    this.deposited = 0; // 终身累计加钱额（受 config.account.deposit.maxLifetime 封顶）
    this.initialLong = 0; // 开服/建仓时初始持股（用于股东变动统计）
    this.lendOffered = 0; // 已挂入融券池的股数（从可卖持仓中冻结，被借走前可撤）
    this.lendInterestEarned = 0; // 出借累计利息收入（展示用）
    this.lendInterestDebt = 0; // 做空方欠息（现金+保证金都扣不动时挂账，计入权益、恢复后追缴）
    this.longs = new Map(); // stockId -> { lots: [{qty, price, ts, reserved}] }
    this.shorts = new Map(); // stockId -> { lots: [{qty, price, margin, reserved}] }
    this.orders = new Map(); // 挂单中的订单 id -> order
    this.orderHistory = []; // 最近委托（含已完结）
    this.tradeHistory = []; // 最近成交
    this.lastOrderAt = null; // 上次下单时间（冷却），null 表示从未下单
    this.createdAt = Date.now();
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

  /** 真正可卖：可卖多头中未挂入融券池的部分 */
  freeSellableLong(stockId, now) {
    return Math.max(0, this.sellableLong(stockId, now) - (this.lendOffered || 0));
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
    return Math.max(0, n - (this.lendOffered || 0));
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

  /**
   * 权益 = 可用现金 + 挂单冻结 + 空头保证金 + 多头市值 - 空头市值 - 融资负债 - 做空欠息
   * （融券现金流模型：开空时卖出所得已入账，空头盈亏隐含在 -空头市值 中；
   *   融资负债含未付利息，利息在摊入时已同步扣减 realizedPnL，权益与账本同步下移；
   *   做空欠息是扣不动现金/保证金时挂账的融券利息，性质同样是负债，
   *   不扣会让破产账户的权益虚高，排行榜与维持率判定一起失真）
   */
  equity(stockId, lastPrice) {
    return (
      this.cash +
      this.orderFrozen +
      this.shortMargin +
      this.longValue(stockId, lastPrice) -
      this.shortMV(stockId, lastPrice) -
      this.financeDebt(stockId) -
      this.lendInterestDebt
    );
  }

  shortMV(stockId, lastPrice) {
    return this.shortQty(stockId) * lastPrice;
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
