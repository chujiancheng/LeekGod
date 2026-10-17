/**
 * 账户存储（内存）：玩家与 NPC 共用同一结构
 */
const config = require('./config');
const milestones = require('./milestones');

const r2 = (v) => Math.round(v * 100) / 100;

class Account {
  constructor(name, isNPC = false, role = null) {
    this.name = name; // 账号：登录凭据（唯一、不可改），也是存档里各表的 account 键
    this.nick = null; // 昵称：展示名，开户时填、之后可改。null = 还没开完户
    this.isNPC = isNPC;
    this.role = role || (isNPC ? 'npc' : 'player'); // inst / hot / big / mid / small / whale / player
    // AI 主力（大模型驱动的跨股机构）：isNPC + role=whale；标记只在内存派生，不落库
    this.ai = false;
    this.aiId = null;
    this.aiLabel = null;
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

    // ---- 券商（出身门派，见 Doc/券商方案.md）----
    // 玩家：登录时必选，落库；NPC：由账户名哈希派生的**派生标签**，只缓存在内存（不落库）。
    // 两者共用同一个字段，但 broker.forAccount 对 NPC 直接返回全局基准——
    // 券商对 NPC 是「纯展示、零行为影响」（§11.4.3）。
    this.broker = null;
    this.brokerChangedAt = null;
    // 当前券商的入会交易日号（免费重选窗口 / 转户冷却都按交易日算，不是墙钟）
    this.brokerSinceDay = null;
    // 每家券商各一份进度：{key: {volume, profitBase, liquidations, orders, cancels}}
    this.brokerStats = {};
    this.freeReselectUsed = false;
    // 每日免息券：今天这张用掉没有 / 今天是否利息全免（都按交易日号）
    this.couponUsedDay = null;
    this.freeInterestDay = null;

    // ---- 彩蛋里程碑（见 Doc/彩蛋玩法方案.md）----
    // **只有玩家有**：NPC 一律 null——彩蛋是玩家专属，3160 个 NPC 账户既不判也不落盘。
    // 判定内核只读这里的状态、只读账户快照，绝不回写任何交易字段
    this.milestones = isNPC ? null : milestones.emptyState();
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

  /**
   * 同股多空互斥（港交所口径）：同一账户在同一只股票上只能持有一个方向。
   * 判定同时看**已成持仓**与**在途开仓委托**——只看持仓会漏掉「两张反向开仓单
   * 同时在途、先后成交后多空并存」的窗口。
   * 返回的两端表示该方向已被占用：占用端禁止再开仓，但平仓与同向加仓照常。
   * 动作字符串与 market.ACTIONS 一致（store 不能 require market，会成环）。
   * @returns {{long: boolean, short: boolean}}
   */
  sideLock(stockId) {
    let long = this.longQty(stockId) > 0;
    let short = this.shortQty(stockId) > 0;
    for (const o of this.orders.values()) {
      if (o.status !== 'live' || o.stockId !== stockId) continue;
      if (o.action === 'buy_open') long = true;
      else if (o.action === 'sell_open') short = true;
    }
    return { long, short };
  }

  shortQty(stockId) {
    const p = this.shorts.get(stockId);
    return p ? p.lots.reduce((s, l) => s + l.qty, 0) : 0;
  }

  /**
   * 可卖出的多头：已过锁仓时间且未被其他委托占用。
   *
   * **锁仓时长必须由调用方按账户券商传入**（滑泰 5 秒 / 天疯 8 秒 / 基准 10 秒，
   * 见 `broker.forAccount().lockMs`）。这里是撮合与 UI 共用的唯一判定点，
   * 写死全局值会让券商的「T+锁仓砍半」变成一句文案——store 不能 require broker
   * （会成环），所以只接收，不自己解析。
   * 缺省回落全局基准：NPC 与无券商账户因此逐位等于引入券商之前的行为。
   *
   * @param {number} [lockMs] 该账户券商的锁仓时长
   */
  sellableLong(stockId, now, lockMs = config.trade.lockMs) {
    const p = this.longs.get(stockId);
    if (!p) return 0;
    let n = 0;
    for (const lot of p.lots) {
      if (now - lot.ts >= lockMs) {
        n += lot.qty - lot.reserved;
      }
    }
    return n;
  }

  /** 真正可卖：可卖多头中未挂入融券池的部分（挂借量按股票取） */
  freeSellableLong(stockId, now, lockMs = config.trade.lockMs) {
    const offered = this.ledgerOf(stockId).lendOffered || 0;
    return Math.max(0, this.sellableLong(stockId, now, lockMs) - offered);
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

  /**
   * 按「当前在途平仓委托」重摊批次预留（FIFO，与 reserve / consume 同序）。
   *
   * 预留只是批次上的一个数字，**不带「是哪张委托占的」**，而三个操作各按不同顺序遍历批次：
   * reserve 从「最早未占的」占、release 从「最早已占的」退、consume 从「最早的」扣。
   * 只要中途撤掉一张平仓单，三者就会错位：成交时 consume 吃到的是没有预留的早批次，
   * 本单自己的预留却留在后面批次上再也退不掉——持仓还在、可平/可卖却是 0，
   * 而账上没有任何在途委托可撤，玩家既平不掉也开不了反向仓。
   * 下单/成交/撤单之后按在途委托重摊一次就把这条不变量重新钉住；
   * 重启恢复时也调一次，顺带修掉存档里已经错位的预留。
   *
   * @param {number} [lockMs] 多头只有已过锁仓的批次可被占用（与 reserveLong 同口）
   * @param {number} [now] 判定锁仓的当前时刻
   */
  syncReserved(stockId, lockMs = config.trade.lockMs, now = Date.now()) {
    let longNeed = 0;
    let shortNeed = 0;
    for (const o of this.orders.values()) {
      if (o.status !== 'live' || o.stockId !== stockId) continue;
      if (o.action === 'sell_close') longNeed += o.qty - o.filled;
      else if (o.action === 'buy_close') shortNeed += o.qty - o.filled;
    }
    const lp = this.longs.get(stockId);
    if (lp) {
      let need = longNeed;
      for (const lot of lp.lots) {
        const take = now - lot.ts >= lockMs ? Math.min(lot.qty, need) : 0;
        lot.reserved = take;
        need -= take;
      }
    }
    const sp = this.shorts.get(stockId);
    if (sp) {
      let need = shortNeed;
      for (const lot of sp.lots) {
        const take = Math.min(lot.qty, need);
        lot.reserved = take;
        need -= take;
      }
    }
  }

  /**
   * 从多头 FIFO 中预留 qty（需可卖），成功返回 true。
   * `lockMs` 与 `sellableLong` 同口：由调用方传账户券商的锁仓时长，缺省回落全局基准
   */
  reserveLong(stockId, qty, now, lockMs = config.trade.lockMs) {
    let need = qty;
    const p = this.longs.get(stockId);
    if (!p) return false;
    const before = p.lots.map((l) => l.reserved);
    for (const lot of p.lots) {
      if (need <= 0) break;
      if (now - lot.ts < lockMs) continue;
      const avail = lot.qty - lot.reserved;
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      lot.reserved += take;
      need -= take;
    }
    // 预留不够就**整体回滚**：旧写法会留下半截预留，而调用方只把这张单判为失败、
    // 不会去释放它（它没有委托号，之后也无从释放），那截就这么永久留在批次上
    if (need > 0) {
      p.lots.forEach((lot, i) => { lot.reserved = before[i]; });
      return false;
    }
    return true;
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

  /** 从空头 FIFO 中预留 qty，成功返回 true（不够则整体回滚，理由同 reserveLong） */
  reserveShort(stockId, qty) {
    let need = qty;
    const p = this.shorts.get(stockId);
    if (!p) return false;
    const before = p.lots.map((l) => l.reserved);
    for (const lot of p.lots) {
      if (need <= 0) break;
      const avail = lot.qty - lot.reserved;
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      lot.reserved += take;
      need -= take;
    }
    if (need > 0) {
      p.lots.forEach((lot, i) => { lot.reserved = before[i]; });
      return false;
    }
    return true;
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
