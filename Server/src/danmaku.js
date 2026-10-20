/**
 * 分时图弹幕 —— 见 Doc/弹幕方案.md
 *
 * 定位：**场内声音，不是聊天室。** 顶栏在线人数是真的，弹幕却每分钟好几条，
 * 所以说话的人一律以「机构 / 游资 / 大户 / 中户 / 散户 / 自营」身份出现，
 * 玩家发的话才带昵称。这条定位决定了下面所有文案与协议的口径。
 *
 * 三层形态里本期只做 L1（飘屏）：
 *   L1 飘屏 —— 本文件产出 items，客户端按 seq 增量渲染
 *   L2 事件锚点 —— P1（当前 liquidation 只发飘屏，不带图上点位）
 *   L3 面板 —— P2
 *
 * 三条红线（§3.5，测试逐条钉住）：
 *   ① 不剧透：下发的 item 键集合固定为白名单，不含 fairValue / force / intent / llmPlan；
 *   ② 不评论未公开消息：P0 根本没有「对消息反应」这条触发（P1 才做，届时必须过 visibleFor）；
 *   ③ 不骂人不点名：playerB 类 item **不带 playerId / 昵称 / 精确金额**，文案里也没有 {nick}。
 */
const config = require('./config');
const text = require('./danmaku-text');
const { logger } = require('./logger');

/** 说话人类型的展示序（客户端配色用，服务端只下发 key） */
const TYPES = new Set(['small', 'mid', 'big', 'hot', 'inst', 'mm', 'human']);

/** playerB 优先让这几种人开口：「有大哥进场了」得由游资/大户说才像 */
const PLAYER_B_SPEAKERS = ['hot', 'big', 'mid', 'small', 'inst'];

/** 玩家弹幕的极简敏感词（不做军备竞赛，只挡骂人与导流） */
const BANNED = ['傻逼', '操你', '妈的', '垃圾人', '加群', '微信群', '代操盘', '包赚', '必涨', '内幕消息'];

/** 导流：URL 与各类邀请码句式（只挡最直白的几种，不做军备竞赛） */
const URL_RE = /(https?:\/\/|www\.|\.(com|cn|net|org|xyz)\b|加\s*[vV微]|私\s*聊|企鹅群|公众号)/i;
/** 至少含一个中日韩文字或字母数字，否则是纯符号刷屏 */
const WORD_RE = /[\u4e00-\u9fa5a-zA-Z0-9]/;
/** 同一字符连续 6 次以上（「啊啊啊啊啊啊」「！！！！！！」） */
const REPEAT_RE = /(.)\1{5,}/;

const r0 = (v) => Math.round(v);

class DanmakuSystem {
  constructor(game) {
    this.game = game;
    this.cfg = config.danmaku || {};
    this.seq = 0;
    /** 滚动缓冲：最近若干条（下发用，不落库） */
    this.items = [];
    /** 待发队列：玩家行为反应要延迟几百毫秒才自然，不能和成交同一帧出现 */
    this.queue = [];
    this.lastGlobalAt = 0;
    this.stockHits = new Map(); // stockId -> number[]（最近 1 分钟的发送时刻）
    this.accLast = new Map(); // accName -> 最近发言时刻（单账户 10 分钟）
    this.playerComment = new Map(); // 玩家账户 -> 最近被评论时刻（5 分钟）
    this.playerLiq = new Map(); // 玩家账户 -> 最近被评论强平时刻（2 分钟）
    this.agg = new Map(); // 玩家账户 -> { t0, buy, sell, stockId, quietUntil }
    this.watchers = new Map(); // stockId -> 最近有人在看的时刻
    this.playerSent = new Map(); // 玩家账户 -> 最近主动发弹幕时刻
    this.playerText = new Map(); // 玩家账户 -> { text, t }（同文 60 秒去重）
    this.playerDaily = new Map(); // 玩家账户 -> { key, n }（自然日条数上限）
    this.playerBHits = new Map(); // stockId -> number[]（playerB 自己的 1 分钟配额）
    this.stockPlayerHits = new Map(); // stockId -> number[]（玩家弹幕 1 分钟窗口）
    this._scans = new Map(); // stockId -> { t, list }（情绪扫描缓存，3 秒）
    this._lastHealthLog = 0;
  }

  // ---------------- 外部打点 ----------------

  /** 「有人在看这只股票」：由 `/api/history?stock=` 打点（切股票 / 刷新本来就会拉） */
  noteWatch(stockId, now = Date.now()) {
    if (!this.cfg.enabled || !stockId) return;
    this.watchers.set(stockId, now);
  }

  /**
   * 玩家成交通知 —— 由 `Market.execute` 旁挂调用。
   * **这里是撮合热路径**，所以只做 O(1) 记账；扫池、选人、取文案全部推迟到 step()。
   * @param {object} acc 玩家账户（NPC 一律不触发，否则 3160 个 NPC 会互相评论成菜市场）
   * @param {'buy'|'sell'} side
   * @param {string} stockId
   * @param {number} amount 本笔成交额
   * @param {number} qty 本笔成交量
   * @param {number} now
   * @param {{avg?:number, qtyBefore?:number, posAfter?:number}|null} ctx 卖出侧的判定基线
   */
  onPlayerAction(acc, side, stockId, amount, qty, now, ctx) {
    const pcfg = this.cfg.playerB;
    if (!this.cfg.enabled || !pcfg || !pcfg.enabled || !acc || acc.isNPC) return;
    if (!(amount > 0)) return;
    const key = acc.name;
    let a = this.agg.get(key);
    if (!a || now - a.t0 > pcfg.windowMs) {
      a = { t0: now, buy: 0, sell: 0, stockId, quietUntil: 0 };
      this.agg.set(key, a);
    }
    if (now < a.quietUntil) return;
    if (a.stockId !== stockId) {
      a.stockId = stockId;
      a.buy = 0;
      a.sell = 0;
    }

    if (side === 'buy') {
      a.buy += amount;
      const floatMv = this._floatMv(stockId);
      if (floatMv > 0 && a.buy >= floatMv * pcfg.floatMvPct) {
        this._queuePlayerB(key, stockId, 'bigBuy', now);
        a.quietUntil = now + pcfg.quietMs;
        a.buy = 0;
        a.sell = 0;
      }
      return;
    }

    a.sell += amount;
    // 清仓割肉：这笔卖完该股持仓归零 + 累计卖出额过门槛 + 成交价低于买入均价。
    // 用**累计**金额而不是本笔：一单 40 万拆成 12 笔，最后一笔可能只有 2 万
    const cut =
      ctx &&
      ctx.posAfter <= 0 &&
      ctx.qtyBefore > 0 &&
      a.sell >= pcfg.minAmount &&
      ctx.avg > 0 &&
      amount / Math.max(1, qty) < ctx.avg;
    if (cut) {
      this._queuePlayerB(key, stockId, 'cutLoss', now);
      a.quietUntil = now + pcfg.quietMs;
      a.buy = 0;
      a.sell = 0;
    }
  }

  /**
   * 强平通知 —— 由 `Game.onLiquidate` 转发（market 只上报，不碰弹幕）。
   * NPC 被强平由**他本人**说话（「我没了」）；玩家被强平走 playerB（「刚刚有人被抬走了」），
   * 且不受 5 分钟 chat 冷却约束——爆仓是事件，不是闲聊。
   */
  onLiquidate(acc, stockId, now = Date.now()) {
    if (!this.cfg.enabled || !acc) return;
    if (!acc.isNPC) {
      const pcfg = this.cfg.playerB;
      if (!pcfg || !pcfg.enabled) return;
      const last = this.playerLiq.get(acc.name) || 0;
      if (last > 0 && now - last < pcfg.liqGapMs) return;
      this.playerLiq.set(acc.name, now);
      // 爆仓这条**不受** 5 分钟 chat 冷却约束（事件优先），但它同样是一次「被评论」——
      // 必须写进 playerComment，否则强平平仓顺手产生的 cutLoss 会紧接着再说他一遍，
      // 玩家看到的就是「刚刚有人被抬走了」+「有人割在地板上了」两条在说同一个人
      this.playerComment.set(acc.name, now);
      this.queue.push({ kind: 'playerB', scene: 'liquidation', stockId, dueAt: now + 400 });
      return;
    }
    const type = this._typeOf(acc);
    this._speak(stockId, { acc, type }, 'liquidation', { pct: this._pctOf(acc, stockId) }, now, {
      force: true,
    });
  }

  /**
   * 玩家主动发一条弹幕 —— 由 `/api/danmaku` 调用。
   * @returns {{ok:boolean, error?:string, item?:object}}
   */
  postPlayer(acc, stockId, raw, now = Date.now()) {
    const pcfg = this.cfg.player || {};
    if (!this.cfg.enabled || pcfg.enabled === false) return { ok: false, error: '弹幕已关闭' };
    if (!acc) return { ok: false, error: '请先登录' };
    const stock = this.game.stocksById.get(stockId);
    if (!stock) return { ok: false, error: '未知标的' };
    const body = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!body) return { ok: false, error: '说点什么' };
    const maxLen = pcfg.maxLen || 24;
    if ([...body].length > maxLen) return { ok: false, error: `最多 ${maxLen} 个字` };
    const low = body.toLowerCase();
    if (BANNED.some((w) => low.includes(w))) return { ok: false, error: '这句话不太合适' };
    // 导流与刷屏：URL / 纯符号 / 同一字符连刷（「啊啊啊啊啊啊」）一律拒。
    // 命中都不回显命中了哪个词——不给试探留信号
    if (URL_RE.test(body) || !WORD_RE.test(body) || REPEAT_RE.test(body)) {
      return { ok: false, error: '这句话不太合适' };
    }

    const last = this.playerSent.get(acc.name) || 0;
    if (last > 0 && now - last < (pcfg.gapMs || 5000)) return { ok: false, error: '说慢点，喘口气' };
    // 同文去重：60 秒内同一句只发一次（复制粘贴刷屏是移动端最省力的攻击）
    const prev = this.playerText.get(acc.name);
    if (prev && prev.text === body && now - prev.t < (pcfg.sameTextGapMs || 60000)) {
      return { ok: false, error: '这句刚说过，换个说法' };
    }
    // 自然日总量：防脚本（内存计数，重启清零）
    const dayKey = new Date(now).toISOString().slice(0, 10);
    let daily = this.playerDaily.get(acc.name);
    if (!daily || daily.key !== dayKey) {
      daily = { key: dayKey, n: 0 };
      this.playerDaily.set(acc.name, daily);
    }
    if (daily.n >= (pcfg.maxPerDay || 120)) return { ok: false, error: '今天说得够多了，明天再来' };
    const hits = this._trimHits(this.stockPlayerHits.get(stockId), now);
    if (hits.length >= (pcfg.perMin || 6)) return { ok: false, error: '这只票的弹幕有点挤，稍等' };

    this.playerSent.set(acc.name, now);
    this.playerText.set(acc.name, { text: body, t: now });
    daily.n += 1;
    hits.push(now);
    this.stockPlayerHits.set(stockId, hits);
    this.lastGlobalAt = now; // 玩家说话也占全服节奏，避免 NPC 同一秒再来一条
    const item = this._push({
      t: now,
      stockId,
      kind: 'player',
      type: 'human',
      text: body,
      from: String(acc.nick || acc.name || '玩家').slice(0, 8),
    });
    return { ok: true, item };
  }

  // ---------------- 主循环 ----------------

  /**
   * 每 tick 调一次（Game.tick 尾部）
   * @param {number} now
   * @param {{phase?:string, halted?:boolean}|null} [ctx] 交易时钟与停牌状态。
   *   停牌不生成（没有成交、没有事件，说什么都是假的）；午休/夜间密度减半（方案 §2.4）。
   *   不传 ctx 时按「正常盘中」处理——测试与单跑脚本不必构造时钟。
   */
  step(now = Date.now(), ctx) {
    if (!this.cfg.enabled) return;
    this._sweep(now);
    this._flushQueue(now);
    if (!(ctx && ctx.halted)) this._maybeSpeak(now, ctx);
    if (now - this._lastHealthLog >= 5 * 60 * 1000) {
      this._lastHealthLog = now;
      this.logHealth();
    }
  }

  /** 下发快照：只带最近 `snapshotMs` 内的条目，客户端按 id 去重（不靠「上一帧差集」） */
  snapshot(now = Date.now()) {
    if (!this.cfg.enabled) return { seq: 0, items: [] };
    const since = now - (this.cfg.snapshotMs || 5000);
    const items = [];
    for (const it of this.items) if (it.t >= since) items.push(it);
    return { seq: this.seq, items };
  }

  /** 池健康度（§3.7.3）：repeatRate 高的池就是下次要补文案的地方 */
  logHealth() {
    try {
      const h = text.healthSnapshot();
      const hot = Object.entries(h)
        .filter(([, v]) => v.hits >= 5)
        .sort((a, b) => b[1].repeatRate - a[1].repeatRate)
        .slice(0, 4)
        .map(([k, v]) => `${k}=${(v.repeatRate * 100).toFixed(0)}%(${v.hits})`);
      if (hot.length) logger.info(`[弹幕] 池重复率：${hot.join(' ')}`);
    } catch (e) {
      /* 日志失败不影响主循环 */
    }
  }

  // ---------------- 内部 ----------------

  /** 情绪驱动选人：扫该股全部 NPC 的**真实浮盈**，从最惨/最爽里挑，不随机抽人 */
  _maybeSpeak(now, ctx) {
    const cfg = this.cfg;
    if (now - this.lastGlobalAt < (cfg.globalGapMs || 1500)) return;
    // 午休 / 夜间密度减半：这两个阶段没有新成交，说太密就像在念稿子
    const quiet = !!(ctx && (cfg.quietPhases || []).includes(ctx.phase));
    const chance = (cfg.speakChance == null ? 0.55 : cfg.speakChance) * (quiet ? cfg.quietFactor || 0.5 : 1);
    if (Math.random() > chance) return;
    const stockId = this._pickStock(now);
    if (!stockId) return;
    const list = this._scanPnl(stockId, now);
    if (!list || !list.length) return;

    const worst = list[0];
    const best = list[list.length - 1];
    let pick = null;
    let scene = 'idle';
    let vars = null;

    if (best.p >= 0.15 && Math.random() < 0.55) {
      // 关键：不能只认「最爽的那一个」——他刚说完就要被单账户 10 分钟冷却锁住，
      // 于是这只股票从此只剩兜底闲聊。取最爽的**一小撮**，从里面挑还没说过话的
      pick = this._pickFromEdge(list, now, true);
      if (pick) {
        scene = 'win';
        vars = { pct: r0(pick.p * 100) };
      }
    } else if (worst.p <= -0.15 && Math.random() < 0.7) {
      pick = this._pickFromEdge(list, now, false);
      if (pick) {
        scene = 'deepLoss';
        vars = { pct: Math.abs(r0(pick.p * 100)) };
      }
    }
    if (!pick) {
      // 冷场兜底：从该股随机一位，说一句闲话（不然没行情时整张图静得可疑）
      pick = this._pickAny(list, now);
      scene = 'idle';
      vars = null;
    }
    if (!pick) return;
    // 深套/大赚只在对应类型里有池；机构不会「我人麻了」，取不到就退化成 idle
    const type = this._typeOf(pick.acc);
    if (scene !== 'idle' && !text.POOLS[type]?.[scene]) {
      scene = 'idle';
      vars = null;
    }
    this._speak(stockId, { acc: pick.acc, type }, scene, vars, now);
  }

  /** 账户是否还在「单账户 10 分钟」冷却里 */
  _inAccCooldown(acc, now) {
    const last = this.accLast.get(acc.name) || 0;
    return last > 0 && now - last < (this.cfg.accGapMs || 600000);
  }

  /**
   * 从「最爽/最惨队列」的头部或尾部取一小撮候选（默认 12 个），
   * 挑一个没在冷却里的。全体都在冷却时返回 null（交给兜底或下一 tick）。
   */
  _pickFromEdge(list, now, top, k = 12) {
    const n = Math.min(k, list.length);
    const cand = [];
    for (let i = 0; i < n; i++) {
      const item = top ? list[list.length - 1 - i] : list[i];
      if (!item || !item.acc) continue;
      if (this._inAccCooldown(item.acc, now)) continue;
      cand.push(item);
    }
    if (!cand.length) return null;
    return cand[Math.floor(Math.random() * cand.length)];
  }

  /** 全池随机挑一个没在冷却里的（最多试 12 次，避免 316 人全冷却时空转） */
  _pickAny(list, now) {
    for (let i = 0; i < 12; i++) {
      const item = list[Math.floor(Math.random() * list.length)];
      if (item && item.acc && !this._inAccCooldown(item.acc, now)) return item;
    }
    return null;
  }

  /**
   * 该股全部 NPC 按浮盈升序排（最惨在前）。3 秒缓存：pnlOf 要遍历批次，
   * 每 1.5 秒 × 10 只股票全扫太浪费，而情绪本来就是慢变量。
   */
  _scanPnl(stockId, now) {
    const cached = this._scans.get(stockId);
    if (cached && now - cached.t < 3000) return cached.list;
    const mgr = this.game.npcs.get(stockId);
    if (!mgr) return null;
    const list = [];
    for (const n of mgr.npcs) {
      const p = mgr.pnlOf(n);
      if (p == null) continue;
      list.push({ acc: n.acc, p });
    }
    list.sort((a, b) => a.p - b.p);
    this._scans.set(stockId, { t: now, list });
    return list;
  }

  /**
   * 只给「有人在看」的股票生成（方案 §3.4）。
   * **没有 watcher 就返回 null**：没人看的股票不该消耗配额，更不该让正在看的那只冷清。
   * 客户端在交易终端每 60 秒打一次心跳（`/api/danmaku/watch`），所以 TTL 不会在盯盘时过期。
   */
  _pickStock(now) {
    const ttl = this.cfg.watchTtlMs || 300000;
    const live = [];
    for (const [id, t] of this.watchers) {
      if (now - t <= ttl) live.push(id);
      else this.watchers.delete(id);
    }
    if (!live.length) return null;
    return live[Math.floor(Math.random() * live.length)];
  }

  /** 单条落库前的统一闸门：全服节奏 → 单股配额 → 单账户冷却 → 取文案 */
  _speak(stockId, who, scene, vars, now, opts = {}) {
    const cfg = this.cfg;
    if (!stockId || !who || !who.acc) return null;
    if (now - this.lastGlobalAt < (cfg.globalGapMs || 1500)) return null;
    if (!opts.force && !this._allowStock(stockId, now)) return null;
    if (!opts.force) {
      const last = this.accLast.get(who.acc.name) || 0;
      if (last > 0 && now - last < (cfg.accGapMs || 600000)) return null;
    }
    const txt = text.pickText(who.type, scene, vars);
    if (!txt) return null;

    this.lastGlobalAt = now;
    const hits = this._trimHits(this.stockHits.get(stockId), now);
    hits.push(now);
    this.stockHits.set(stockId, hits);
    this.accLast.set(who.acc.name, now);

    const isEvent = !!(opts.force && scene === 'liquidation');
    return this._push({
      t: now,
      stockId,
      kind: isEvent ? 'event' : 'npc',
      type: who.type,
      text: txt,
      // 事件级才带成交价：P1 的 L2 锚点要按 (t, price) 钉点，闲聊没有落点可言
      ...(isEvent ? { price: this._lastPrice(stockId) } : null),
    });
  }

  _lastPrice(stockId) {
    const m = this.game.markets.get(stockId);
    return m && Number.isFinite(m.lastPrice) ? m.lastPrice : null;
  }

  _allowStock(stockId, now) {
    const cfg = this.cfg;
    const hits = this._trimHits(this.stockHits.get(stockId), now);
    this.stockHits.set(stockId, hits);
    if (hits.length >= (cfg.stockPerMin || 4)) return false;
    const last = hits.length ? hits[hits.length - 1] : 0;
    return last === 0 || now - last >= (cfg.stockGapMs || 6000);
  }

  _queuePlayerB(key, stockId, scene, now) {
    const pcfg = this.cfg.playerB;
    if (!this._allowPlayerB(stockId, now)) return;
    const last = this.playerComment.get(key) || 0;
    if (last > 0 && now - last < (pcfg.commentGapMs || 300000)) return;
    if (this.queue.length > 20) return; // 玩家狂刷也不能把队列撑爆
    this.playerComment.set(key, now);
    const hits = this._trimHits(this.playerBHits.get(stockId), now);
    hits.push(now);
    this.playerBHits.set(stockId, hits);
    this.queue.push({ kind: 'playerB', scene, stockId, dueAt: now + 300 + Math.floor(Math.random() * 900) });
  }

  _allowPlayerB(stockId, now) {
    const pcfg = this.cfg.playerB;
    // 自己的配额：每分钟最多 2 条，不占用单股 steady 的 4 条闲聊配额
    const own = this._trimHits(this.playerBHits.get(stockId), now);
    if (own.length >= (pcfg.maxPerMin || 2)) return false;
    // 但不许把两条弹幕挤在一起：仍要守单股 6 秒间隔（全服节奏在 _flushQueue 里判）
    const steady = this._trimHits(this.stockHits.get(stockId), now);
    const last = steady.length ? steady[steady.length - 1] : 0;
    return last === 0 || now - last >= (this.cfg.stockGapMs || 6000);
  }

  _flushQueue(now) {
    if (!this.queue.length) return;
    const cfg = this.cfg;
    // 全服节奏对每一条都成立，事件级也不例外：一次只放一条出去，剩下的留到下个 tick。
    // 之前是整队一起发，同一 tick 能并排冒出两条
    if (now - this.lastGlobalAt < (cfg.globalGapMs || 1500)) return;
    const ttl = cfg.queueTtlMs || 60000;
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i];
      // 过期就丢，不补播陈年反应：「14:02 有人被抬走了」拖到 14:10 才飘过来最出戏
      if (now - q.dueAt > ttl) {
        this.queue.splice(i, 1);
        i--;
        continue;
      }
      if (q.dueAt > now) continue;
      this.queue.splice(i, 1);
      if (q.kind !== 'playerB') return;
      const speaker = this._pickSpeaker(q.stockId, now);
      const txt = text.pickText('playerB', q.scene, null);
      // 说话人全在冷却里，或者取不到文案：这条直接丢，不能硬塞给刚说过话的人
      if (!speaker || !txt) return;
      this.lastGlobalAt = now;
      this.accLast.set(speaker.acc.name, now);
      this._push({
        t: now,
        stockId: q.stockId,
        kind: 'npc',
        type: speaker.type,
        text: txt,
        // 客户端据此给这条加一点点视觉区分（左侧亮边），但协议里**没有**是谁
        flag: 'playerB',
      });
      return;
    }
  }

  /**
   * 从该股挑一个合适的说话人：优先游资/大户（「有大哥进场了」得他们来说）。
   * **必须跳过还在单账户 10 分钟冷却里的人**，否则同一个「曹俊（杭州）」
   * 可能 10 秒内先说一句闲聊、再点评一句玩家 —— 一眼就穿帮（方案 §3.1）。
   */
  _pickSpeaker(stockId, now = Date.now()) {
    const mgr = this.game.npcs.get(stockId);
    if (!mgr || !mgr.npcs.length) return null;
    const tried = new Set();
    // 先按偏好类型找，找不到再放宽到任意没在冷却里的人；两次都做，最多试 16 次
    for (const strict of [true, false]) {
      for (let i = 0; i < 8; i++) {
        const n = mgr.npcs[Math.floor(Math.random() * mgr.npcs.length)];
        if (!n || !n.acc || tried.has(n.acc.name)) continue;
        tried.add(n.acc.name);
        const type = this._typeOf(n.acc);
        if (strict && !PLAYER_B_SPEAKERS.includes(type)) continue;
        if (this._inAccCooldown(n.acc, now)) continue;
        return { acc: n.acc, type };
      }
    }
    return null;
  }

  _typeOf(acc) {
    if (!acc) return 'mid';
    if (acc.isNPC === false) return 'human';
    const role = acc.role || 'mid';
    if (role === 'retail') return 'small';
    return TYPES.has(role) ? role : 'mid';
  }

  _pctOf(acc, stockId) {
    try {
      const mgr = this.game.npcs.get(stockId);
      const n = mgr && mgr.npcs.find((x) => x.acc === acc);
      const p = n ? mgr.pnlOf(n) : null;
      return p == null ? null : Math.abs(r0(p * 100));
    } catch (e) {
      return null;
    }
  }

  _floatMv(stockId) {
    const stock = this.game.stocksById.get(stockId);
    const m = this.game.markets.get(stockId);
    if (!stock || !m) return 0;
    return (stock.floatShares || 0) * (m.lastPrice || 0);
  }

  _trimHits(arr, now, windowMs = 60000) {
    const out = arr || [];
    while (out.length && now - out[0] >= windowMs) out.shift();
    return out;
  }

  _push(item) {
    const it = { id: ++this.seq, ...item };
    this.items.push(it);
    const limit = this.cfg.itemLimit || 60;
    if (this.items.length > limit) this.items.splice(0, this.items.length - limit);
    return it;
  }

  _sweep(now) {
    const keepMs = Math.max(60000, (this.cfg.snapshotMs || 5000) * 4);
    let cut = 0;
    while (cut < this.items.length && now - this.items[cut].t > keepMs) cut++;
    if (cut) this.items.splice(0, cut);

    if (this.agg.size > 64) {
      for (const [k, a] of this.agg) {
        if (now - a.t0 > 300000) this.agg.delete(k);
      }
    }
    if (this.playerComment.size > 256) {
      for (const [k, t] of this.playerComment) {
        if (now - t > 1800000) this.playerComment.delete(k);
      }
    }
    if (this.playerLiq.size > 256) {
      for (const [k, t] of this.playerLiq) {
        if (now - t > 1800000) this.playerLiq.delete(k);
      }
    }
    if (this.accLast.size > 1024) {
      for (const [k, t] of this.accLast) {
        if (now - t > 1800000) this.accLast.delete(k);
      }
    }
    if (this.playerSent.size > 256) {
      for (const [k, t] of this.playerSent) {
        if (now - t > 600000) this.playerSent.delete(k);
      }
    }
    if (this.playerText.size > 256) {
      for (const [k, v] of this.playerText) {
        if (now - v.t > 600000) this.playerText.delete(k);
      }
    }
    // 日配额表按「今天」清：跨天后整表重置（key 是 YYYY-MM-DD）
    if (this.playerDaily.size > 64) {
      const today = new Date(now).toISOString().slice(0, 10);
      for (const [k, v] of this.playerDaily) {
        if (v.key !== today) this.playerDaily.delete(k);
      }
    }
  }
}

module.exports = { DanmakuSystem, TYPES };
