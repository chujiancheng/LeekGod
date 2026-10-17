/**
 * 主力脑调度器（软脑 + 可见 AI 账户）。
 * - config.npc.llm.whales 定义跨股主力（现配 **1 个**：`AI·一号主力`，1 亿现金）
 * - 每游戏日在 triggerPhases / midTriggers / preTrigger 各异步决策一次（约 6 次/游戏日）
 * - N 个脑的决策先合议成一份计划 → **只写回一次**各股 NpcManager.llmPlan
 * - 每个脑再按自己的 stance 给同名 AI 账户下限价单（量化护栏仍在 market.place）
 *
 * 2026-10-17 二次修订（收敛为单脑后暴露的问题）：
 * ③ 挂单查重：限价单常挂着不成交，旧实现只查持仓（longQty/shortQty）→ 每轮再挂一张，
 *    六轮下来同一只票叠出数张同向单。改为「同股有在途单就跳过」。
 * ④ 慢轮顺延：单次推理 4~26s，而 auction→morning 只隔 30s，busy 时直接丢会让某个阶段
 *    完全没有决策。改为记下最新一次，当前轮结束后立刻补跑。
 * ⑤ 注资只做一次：重启时按 `equity < cashEach*0.5` 补钱等于给亏损 AI 无限续命，
 *    现在用 `deposited` 记账，补过就不再补。
 * - 失败或超预算：静默跳过，其余 NPC 照旧规则
 *
 * 调用是 fire-and-forget：绝不在 Game.tick 同步 await 网络。
 *
 * 2026-10-17 修订（上一版有两个会让功能空转的问题）：
 * ① `NpcManager.llmPlan` 是**单槽**，而旧实现让 4 个脑顺序 await 后各自写全部 10 只股票，
 *    整轮结束只剩最后一个脑（游资快枪）的计划——"4 脑"实际等于"1 脑"，前面脑点名的
 *    accumulate/distribute 还会被后面的中性全局偏置擦成 none。现在先 `mergePlans`
 *    合成一份再写，立场按权重叠加、方向打架的股票直接不表态。
 * ② 4 次调用并发（原来串行，最坏 4×8s=32s，收盘竞价只有 20s/最后 10s 锁单，订单基本
 *    赶不上撮合）；报单用 `Date.now()`（原来把阶段起点的 now 一路传进 market.place，
 *    canTrade/isHalted 判定的是过期时刻，可能往已休市的盘口塞单）。
 */
const config = require('../config');
const { logger } = require('../logger');
const { chat } = require('./client');
const { parseWhaleDecision, intentAgrees, clampNum } = require('./schema');
const { systemPrompt, userPrompt, stockLine } = require('./prompt');
const { ACTIONS } = require('../market');
const { Account } = require('../store');

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

/**
 * 多脑合议（纯函数，可单测）。
 *
 * 规则刻意写成"立场相加、全局只当潮水"：
 * - 全局 bias = 各脑 bias 的均值，只以 `0.25×` 作用在**未被点名的股票**上；
 * - 每只股票：`bias = 全局bias×0.25 + Σ(方向×权重)×0.30`，再夹进 clamp.bias。
 *   两个脑同向 0.9 → 直接顶到上限；多空各 0.9 → 净 0，该股**不表态**（分歧不硬凑）；
 * - aggro / intentChance 只从**同向**的脑里取（权重加权 / 取最大），中性脑不稀释力度。
 *
 * @param {Array<{whale:{id:string,label:string}, plan:object}>} entries
 * @param {string[]} stockIds
 * @param {object} clampCfg config.npc.llm.clamp
 */
function mergePlans(entries, stockIds, clampCfg) {
  const c = clampCfg || {};
  const biasMax = clampNum(c.bias, 0, 5, 0.45);
  const chanceHi = Array.isArray(c.intentChance) ? c.intentChance[1] : 0.55;
  const list = (entries || []).filter((e) => e && e.plan);

  const globalBias = mean(list.map((e) => e.plan.bias));
  const globalAggro = mean(list.map((e) => e.plan.aggro));

  const byStock = new Map();
  for (const { whale, plan } of list) {
    for (const [id, sub] of Object.entries(plan.stocks || {})) {
      if (!sub) continue;
      const sign = sub.stance === 'bullish' ? 1 : sub.stance === 'bearish' ? -1 : 0;
      if (!sign) continue;
      // 个股没写意图时，才拿该脑的全局意图补偿，且必须和方向自洽
      const intent =
        sub.intent && sub.intent !== 'none' && intentAgrees(sub.stance, sub.intent)
          ? sub.intent
          : intentAgrees(sub.stance, plan.intent)
            ? plan.intent
            : 'none';
      let arr = byStock.get(id);
      if (!arr) byStock.set(id, (arr = []));
      arr.push({
        whaleId: whale.id,
        sign,
        weight: sub.weight,
        intent,
        aggro: plan.aggro,
        chance: clampNum(plan.intentChance, 0, 1, 0.22),
      });
    }
  }

  const stocks = {};
  for (const id of stockIds) {
    const arr = byStock.get(id);
    if (!arr || !arr.length) continue;
    const net = arr.reduce((s, x) => s + x.sign * x.weight, 0);
    // 多空互相抵消到没有净立场：宁可不表态，也不要随机挑一方
    if (Math.abs(net) < 0.15) continue;
    const stance = net > 0 ? 'bullish' : 'bearish';
    const agree = arr.filter((x) => x.sign === (net > 0 ? 1 : -1));
    const wsum = agree.reduce((s, x) => s + x.weight, 0) || 1;
    const top = agree.reduce((a, b) => (b.weight > a.weight ? b : a));
    const aggro = agree.reduce((s, x) => s + x.aggro * x.weight, 0) / wsum;
    // 多脑才需要"合议加成"（单脑的表态概率就用模型自己给的）；
    // 否则 0.15+0.4w 这个下限会把模型明确说的 0.2 抬到 0.5 左右，
    // 等于"模型说轻仓试探、代码却按高置信度启动意图"。
    const chance =
      arr.length <= 1
        ? top.chance
        : Math.min(chanceHi, Math.max(0.15 + 0.4 * top.weight, top.chance));
    stocks[id] = {
      stance,
      weight: clampNum(top.weight, 0, 1, 0),
      intent: top.intent,
      intentChance: clampNum(chance, 0, 1, 0),
      aggro: clampNum(aggro, 0.5, 1.6, 1),
      bias: clampNum(globalBias * 0.25 + net * 0.3, -biasMax, biasMax, 0),
      by: top.whaleId,
    };
  }

  return {
    bias: clampNum(globalBias, -biasMax, biasMax, 0),
    aggro: clampNum(globalAggro, 0.5, 1.6, 1),
    stocks,
    notes: list.map((e) => ({ id: e.whale.id, label: e.whale.label, note: e.plan.note || '' })),
  };
}

class WhaleManager {
  /**
   * @param {import('../game').Game} game
   */
  constructor(game) {
    this.game = game;
    this.cfg = config.npc.llm || null;
    this.busy = false;
    this.lastNote = new Map(); // whaleId -> string
    this.lastPlanDay = new Map(); // whaleId -> day:phaseKey
    this._callDay = null;
    this._callCount = 0;
    /** 上一轮完整决策（供观测页）：{t, day, phase, phaseLabel, merged, decisions[]} */
    this.lastRound = null;
    /** 最近 N 轮决策历史（新→旧），观测页要回看 */
    this.decisionHistory = [];
    /** 段中定时器：key -> Timeout */
    this._midTimers = new Map();
    this._preTimer = null; // 收盘决策的提前排程（见 preTrigger）
    /** 慢轮期间被顺延的那一次决策（只留最新，见 _kick） */
    this._pendingKick = null;
  }

  get enabled() {
    return !!(this.cfg && this.cfg.enabled && Array.isArray(this.cfg.whales) && this.cfg.whales.length);
  }

  /** 账号名：`AI·一号主力`（与 NPC 前缀不撞，可被玩家在股东榜看见） */
  accountName(whale) {
    const prefix = this.cfg.accountPrefix || 'AI·';
    return `${prefix}${whale.label}`;
  }

  /**
   * 确保配置中的 AI 主力账户存在（新开局发钱；续跑补标记）。
   * 只给现金、不抽流通盘——像「带钱进场的新机构」，从盘口自己买。
   * 若旧档里还有不在本配置的 AI 账户（曾做过四脑），去掉 ai 标记、不再当「AI主力」展示。
   * 权益明显低于目标现金时（例如旧档 3000 万 → 现配 1 亿）补足到 cashEach，
   * 但已赚厚的账户不会被反复注资（权益 ≥ cashEach×0.5 则不动）。
   */
  ensureAccounts(opts = {}) {
    const whales = this.cfg && Array.isArray(this.cfg.whales) ? this.cfg.whales : [];
    const cash = Number.isFinite(this.cfg && this.cfg.cashEach) ? this.cfg.cashEach : 100000000;
    const created = [];
    const topped = [];
    const keep = new Set(whales.map((w) => this.accountName(w)));
    for (const w of whales) {
      const name = this.accountName(w);
      let acc = this.game.store.get(name);
      if (!acc) {
        acc = new Account(name, true, 'whale');
        acc.cash = cash;
        acc.deposited = cash; // 记账：初始注资要留痕，否则重启时会被当成"没发过钱"
        acc.nick = w.label;
        this.game.store.put(acc);
        this.game.persist?.touch(acc);
        created.push(name);
      } else {
        // 旧档把初始资金补到 cashEach（如 3000 万 → 1 亿），**只补一次**。
        // 用 `deposited`（终身累计注资额，会落盘）当"补过没有"的凭据，补完记到 cashEach。
        // 旧写法只看 `equity < cash*0.5`，等于每次重启都给亏钱的 AI 补回满血——
        // 既让「AI 到底赚没赚钱」在存档里永远看不出来，也等于无限续命。
        const equity = this.game.equityOf(acc);
        const seeded = Number(acc.deposited) || 0;
        if (seeded < cash) {
          if (equity < cash * 0.5 && acc.cash < cash) {
            const add = cash - acc.cash;
            if (add > 0) {
              acc.cash += add;
              topped.push(`${name}+${Math.round(add)}`);
            }
          }
          // 无论补没补，都记下"已按 cashEach 口径注资"，杜绝反复补
          acc.deposited = cash;
          this.game.persist?.touch(acc);
        }
      }
      acc.isNPC = true;
      acc.role = 'whale';
      acc.ai = true;
      acc.aiId = w.id;
      acc.aiLabel = w.label;
      acc.nick = w.label;
    }
    // 旧四脑残留：不再打 AI 标
    for (const acc of this.game.store.all()) {
      if (!acc.ai && acc.role !== 'whale') continue;
      if (keep.has(acc.name)) continue;
      acc.ai = false;
      acc.aiId = null;
      acc.aiLabel = null;
      if (acc.role === 'whale') acc.role = 'npc';
    }
    if (created.length) {
      logger.info(
        `[LLM] ${opts.fresh ? '新开局已创建' : '续跑补建'} AI 主力账户：${created.join('、')}（各 ${cash} 元）`
      );
    }
    if (topped.length) logger.info(`[LLM] AI 主力补足资金：${topped.join('、')}`);
  }

  /** 是否已对「某交易日 + 某阶段」决策过（防同阶段重复触发） */
  _already(day, phaseKey, whaleId) {
    const key = `${day}:${phaseKey}`;
    return this.lastPlanDay.get(whaleId) === key;
  }

  _mark(day, phaseKey, whaleId) {
    this.lastPlanDay.set(whaleId, `${day}:${phaseKey}`);
  }

  /** 本地自然日（不是 UTC：Math.floor(now/86400000) 会在北京时间 08:00 才翻篇） */
  _dayKey(now) {
    const d = new Date(now);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  _budgetOk(now) {
    const b = this.cfg.budget || {};
    const max = b.maxCallsPerDay != null ? b.maxCallsPerDay : 1200;
    if (max <= 0) return true;
    const dayKey = this._dayKey(now);
    if (this._callDay !== dayKey) {
      this._callDay = dayKey;
      this._callCount = 0;
    }
    if (this._callCount >= max) return false;
    this._callCount += 1;
    return true;
  }

  /**
   * 提前量：下午段剩余时间 - leadMs（毫秒）。缺 `leftMs` 或算不出正数时返回 null。
   * 收盘竞价只有 20s（最后 10s 锁单），单次推理实测 ~8s，等竞价开始再决策根本赶不上撮合。
   */
  _preTriggerDelay(dayState, pre) {
    if (!dayState || !Number.isFinite(dayState.leftMs)) return null;
    const lead = Number.isFinite(pre && pre.leadMs) ? pre.leadMs : 20000;
    return Math.max(500, dayState.leftMs - lead);
  }

  _clearPre() {
    if (this._preTimer) {
      clearTimeout(this._preTimer);
      this._preTimer = null;
    }
    for (const t of this._midTimers.values()) clearTimeout(t);
    this._midTimers.clear();
  }

  /**
   * 阶段变化钩子：进入 triggerPhases 时异步开一轮决策；
   * midTriggers 在阶段走完 atPct 后再决策；preTrigger 在阶段结束前 leadMs 提前跑收盘那轮。
   * @param {{day:number, phase:object, leftMs?:number, elapsedMs?:number}} dayState
   * @param {number} now
   */
  onPhase(dayState, now) {
    if (!this.enabled) return;
    if (!dayState || !dayState.phase) return;
    if (dayState.day < 1) return;
    this._clearPre();
    const phaseKey = dayState.phase.key;

    if (Array.isArray(this.cfg.triggerPhases) && this.cfg.triggerPhases.includes(phaseKey)) {
      this._kick(dayState, now, phaseKey);
    }

    // 段中决策：进入阶段后 atPct 比例处再跑一轮
    const mids = Array.isArray(this.cfg.midTriggers) ? this.cfg.midTriggers : [];
    for (const m of mids) {
      if (!m || m.phase !== phaseKey) continue;
      const total = Number(dayState.phase.ms) || 0;
      const pct = Number.isFinite(m.atPct) ? m.atPct : 0.5;
      const delay = Math.max(500, total * pct);
      const key = m.key || `${phaseKey}_mid`;
      const timer = setTimeout(() => {
        this._midTimers.delete(key);
        this._kick(this.game.day.ok ? this.game.day.locate(Date.now()) : dayState, Date.now(), key);
      }, delay);
      if (timer.unref) timer.unref();
      this._midTimers.set(key, timer);
      logger.info(`[LLM] 段中决策排程 ${key}：${Math.round(delay / 1000)}s 后（${phaseKey}×${pct}）`);
    }

    const pre = this.cfg.preTrigger;
    if (pre && pre.phase === phaseKey) {
      const delay = this._preTriggerDelay(dayState, pre);
      if (delay != null) {
        const dedupeKey = pre.dedupeKey || 'closeAuction';
        this._preTimer = setTimeout(() => {
          this._preTimer = null;
          this._kick(dayState, Date.now(), dedupeKey);
        }, delay);
        // 别让一个待触发的定时器把进程退出拖住
        if (this._preTimer.unref) this._preTimer.unref();
        logger.info(
          `[LLM] 收盘决策提前 ${Math.round((dayState.leftMs - delay) / 1000)}s 排程（${dedupeKey}）`
        );
      }
    }
  }

  /** 起一轮决策（busy 防重入）。dedupeKey 是「这轮算哪一阶段」——提前跑的那轮算收盘竞价 */
  _kick(dayState, now, dedupeKey) {
    if (this.busy) {
      // 单次推理实测 4~26s，而 auction→morning 只隔 30s：慢轮直接丢掉会让
      // "这个阶段的决策没了"。改成只记最新的一次，等当前轮结束立刻补跑。
      this._pendingKick = {
        dayState: this.game.day && this.game.day.ok ? this.game.day.locate(Date.now()) : dayState,
        dedupeKey,
      };
      logger.warn(
        `[LLM] 上一轮决策未结束，${dayState.phase.label || dayState.phase.key} 顺延到本轮结束后执行`
      );
      return;
    }
    this.busy = true;
    setImmediate(() => {
      this._runRound(dayState, now, dedupeKey)
        .catch((e) => logger.error('[LLM] 主力脑轮次异常:', e))
        .finally(() => {
          this.busy = false;
          const pending = this._pendingKick;
          this._pendingKick = null;
          if (pending && pending.dayState) {
            this._kick(pending.dayState, Date.now(), pending.dedupeKey);
          }
        });
    });
  }

  async _runRound(dayState, now, dedupeKey) {
    const snapshot = this._snapshot(dayState);
    const stockIds = snapshot.stocks.map((s) => s.id);
    const clampCfg = Object.assign({}, this.cfg.clamp || {}, {
      maxStocksPerDecision: this.cfg.maxStocksPerDecision,
    });
    const phaseKey = dedupeKey || dayState.phase.key;
    const phaseLabel =
      (dayState.phase.label || dayState.phase.key) +
      (phaseKey !== dayState.phase.key ? `→${phaseKey}` : '');

    // 串行决策：多脑并发打同一 API 极易互相拖超时（日志里常见「3/4 timeout」），
    // 串行后每个脑独享 timeoutMs；现在只 1 个脑，耗时 ≈ 单次推理
    const t0 = Date.now();
    const results = [];
    for (const whale of this.cfg.whales) {
      if (this._already(dayState.day, phaseKey, whale.id)) continue;
      if (!this._budgetOk(now)) {
        logger.warn('[LLM] 主力脑今日调用已达预算上限，跳过剩余决策');
        break;
      }
      results.push(await this._decide(whale, snapshot, clampCfg));
    }
    if (!results.length) return;

    const good = results.filter((r) => r && r.plan);

    for (const r of results) {
      if (!r) continue;
      if (r.plan) {
        logger.info(
          `[LLM] ${r.whale.label} @${phaseLabel} bias=${r.plan.bias} ` +
            `intent=${r.plan.intent} aggro=${r.plan.aggro} ` +
            `stocks=${Object.keys(r.plan.stocks).join(',') || '-'} ` +
            `tokens=${r.usage ? `${r.usage.prompt_tokens || 0}/${r.usage.completion_tokens || 0}` : '-'} ` +
            `(${r.ms}ms)`
        );
      } else {
        logger.warn(`[LLM] ${r.whale.label} 决策失败: ${r.error}`);
      }
    }
    if (!good.length) {
      logger.warn('[LLM] 本轮无可用决策，保持量化规则');
      this._pushRound({
        t: Date.now(),
        day: dayState.day,
        phase: phaseKey,
        phaseLabel,
        merged: null,
        decisions: results.map((r) => this._decisionRecord(r, dayState, phaseKey, phaseLabel, false, [], [])),
      });
      return;
    }

    const merged = mergePlans(good, stockIds, clampCfg);
    this._apply(merged, good);
    for (const r of good) {
      this.lastNote.set(r.whale.id, r.plan.note || '');
      this._mark(dayState.day, phaseKey, r.whale.id);
    }
    const picks = Object.entries(merged.stocks)
      .map(([id, s]) => `${id}:${s.stance}(${s.weight.toFixed(2)},${s.bias.toFixed(2)})`)
      .join(' ');
    logger.info(
      `[LLM] 决策合议 @${phaseLabel} bias=${merged.bias} ` +
        `aggro=${merged.aggro} ${picks || '无点名'} (${Date.now() - t0}ms)`
    );

    // 软计划写回之后再各自下单：账户层保留"每个脑按自己观点交易"的差异化
    const ordersByWhale = new Map();
    for (const { whale, plan } of good) {
      ordersByWhale.set(whale.id, this._executeWhaleOrders(plan, whale));
    }

    this._pushRound({
      t: Date.now(),
      day: dayState.day,
      phase: phaseKey,
      phaseLabel,
      merged: {
        bias: merged.bias,
        aggro: merged.aggro,
        stocks: merged.stocks,
        notes: merged.notes,
      },
      decisions: results.map((r) => {
        const ords = ordersByWhale.get(r.whale && r.whale.id) || [];
        return this._decisionRecord(r, dayState, phaseKey, phaseLabel, !!r.plan, ords, ords);
      }),
    });
  }

  _pushRound(round) {
    this.lastRound = round;
    this.decisionHistory.unshift(round);
    const cap = 10;
    if (this.decisionHistory.length > cap) this.decisionHistory.length = cap;
  }

  _decisionRecord(r, dayState, phaseKey, phaseLabel, ok, orders = [], orderList = []) {
    const plan = r && r.plan;
    const stockNames = {};
    for (const s of this.game.stocks) stockNames[s.id] = s.name;
    const stocks = plan
      ? Object.entries(plan.stocks || {}).map(([id, sub]) => ({
          stockId: id,
          stockName: stockNames[id] || id,
          stance: sub.stance,
          intent: sub.intent,
          weight: sub.weight,
        }))
      : [];
    const placed = Array.isArray(orderList) && orderList.length
      ? orderList.length
      : Number(orders) || 0;
    return {
      whaleId: r.whale.id,
      label: r.whale.label,
      ok: !!plan,
      error: r.error || null,
      bias: plan ? plan.bias : null,
      intent: plan ? plan.intent : null,
      intentChance: plan ? plan.intentChance : null,
      aggressiveness: plan ? plan.aggro : null,
      note: plan ? plan.note || '' : '',
      stocks,
      ordersPlaced: placed,
      orders: Array.isArray(orderList) ? orderList : [],
      ms: r.ms || 0,
      tokens: r.usage
        ? { prompt: r.usage.prompt_tokens || 0, completion: r.usage.completion_tokens || 0 }
        : null,
      day: dayState.day,
      phase: phaseKey,
      phaseLabel,
    };
  }

  async _decide(whale, snapshot, clampCfg) {
    const t0 = Date.now();
    const res = await chat(this.cfg, {
      system: systemPrompt(whale),
      user: userPrompt(whale, snapshot, this.lastNote.get(whale.id), this._accountSnapshot(whale)),
    });
    if (!res.ok) return { whale, error: res.error, ms: Date.now() - t0, usage: res.usage };
    const parsed = parseWhaleDecision(res.text, snapshot.stocks, clampCfg);
    if (!parsed.ok) {
      // 把"为什么没解析出来"带上：reasoning 吃光 max_tokens 时 content 会被截断/掏空，
      // 只报一句 no_json 根本分不清是模型乱写还是预算不够
      const tok = res.usage
        ? `${res.usage.completion_tokens || 0}${res.usage.completion_tokens_details ? `(推理${res.usage.completion_tokens_details.reasoning_tokens || 0})` : ''}`
        : '-';
      const why = `${parsed.error}${res.finish === 'length' ? '·输出被 max_tokens 截断' : ''} tok=${tok}`;
      return { whale, error: why, ms: Date.now() - t0, usage: res.usage };
    }
    return { whale, plan: parsed.plan, usage: res.usage, ms: Date.now() - t0 };
  }

  /** 该 AI 账户的现金/权益/持仓（模型要管钱，不能连自己有多少都不知道） */
  _accountSnapshot(whale) {
    const acc = this.game.store.get(this.accountName(whale));
    if (!acc) return null;
    const positions = [];
    for (const stock of this.game.stocks) {
      const long = acc.longQty(stock.id);
      const short = acc.shortQty(stock.id);
      if (long || short) positions.push({ id: stock.id, long, short });
    }
    return {
      cash: Math.round(acc.cash),
      frozen: Math.round(acc.orderFrozen || 0),
      equity: Math.round(this.game.equityOf(acc)),
      positions,
    };
  }

  /** 把合议结果摊到各股 NpcManager（一份计划，不会互相覆盖） */
  _apply(merged, entries) {
    const g = this.game;
    const biasScale = this.cfg.biasScale || {};
    const clampTicks = Array.isArray(this.cfg.clamp && this.cfg.clamp.planTicks)
      ? this.cfg.clamp.planTicks
      : [80, 900];
    const ticks = clampNum(
      this.cfg.defaultPlanTicks,
      clampTicks[0],
      clampTicks[1],
      480
    );
    const label = entries.map((e) => e.whale.label).join('/');
    const note = merged.notes
      .map((n) => (n.note ? `${n.label}:${n.note}` : ''))
      .filter(Boolean)
      .join(' | ')
      .slice(0, 160);
    const ids = entries.map((e) => e.whale.id).join('+');

    for (const stock of g.stocks) {
      const npc = g.npcs.get(stock.id);
      if (!npc) continue;
      const sub = merged.stocks[stock.id];
      // 未点名的股票只留很弱的全局潮水（0.25×），不参与意图与力度
      const plan = {
        bias: sub ? sub.bias : merged.bias * 0.25,
        intent: sub ? sub.intent : 'none',
        intentChance: sub ? sub.intentChance : 0,
        aggro: sub ? sub.aggro : 1 + (merged.aggro - 1) * 0.2,
        untilTick: npc.tickCount + ticks,
        whale: ids,
        label,
        note: sub ? note : '',
        scaleHot: biasScale.hot != null ? biasScale.hot : 0.55,
      };
      npc.applyLlmPlan(plan);
    }
  }

  /**
   * 该账户在这只股票上是否还有在途挂单。
   * 只查持仓（longQty/shortQty）是不够的：限价单经常挂着不成交，下一轮决策就会再挂一张，
   * 6 轮/游戏日下来同一只票能堆出好几张同向单（实测连续两轮同样 3 只票各挂 2 张）。
   */
  _liveOrderOn(acc, stockId) {
    for (const o of acc.orders.values()) {
      if (o.stockId !== stockId || o.status !== 'live') continue;
      if (o.qty - (o.filled || 0) > 0) return o;
    }
    return null;
  }

  /**
   * AI 主力账户执行：对点名股票按 stance 下一张限价单。
   * 仍走 market.place（涨跌停/笼子/停牌/同股多空互斥全生效），不绕过风控。
   * @param {object} plan 该脑自己的决策（不是合议后的）
   */
  _executeWhaleOrders(plan, whale) {
    const g = this.game;
    const acc = g.store.get(this.accountName(whale));
    const placedOrders = [];
    if (!acc) return placedOrders;
    // 必须用"此刻"：并发/重试后阶段可能已经翻篇，沿用阶段起点的 now 会让
    // market.place 的 canTrade / isHalted 判定到过去，把单塞进已休市的盘口
    const now = Date.now();
    const ratio = this.cfg.orderCashRatio != null ? this.cfg.orderCashRatio : 0.12;
    const maxOrders = clampNum(this.cfg.maxOrdersPerDecision, 0, 10, 2);
    // 名额与资金都按 conviction 降序花，避免永远只动前两只票
    const entries = Object.entries(plan.stocks || {}).sort((a, b) => b[1].weight - a[1].weight);
    const stockName = (id) => (this.game.stocksById.get(id) || {}).name || id;
    const noteOrder = (action, stockId, qty, price, ok, error) => {
      placedOrders.push({
        action,
        stockId,
        stockName: stockName(stockId),
        qty: qty || 0,
        price: price || 0,
        ok: !!ok,
        error: ok ? null : error || null,
      });
    };
    let placed = 0;
    let held = 0;
    for (const [stockId, sub] of entries) {
      if (placed >= maxOrders) break;
      const market = g.markets.get(stockId);
      const stock = g.stocksById.get(stockId);
      if (!market || !stock) continue;
      if (market.isHalted && market.isHalted(now)) continue;
      // 已经挂着同股的单就不再追：一轮一轮叠加会把仓位堆到决策本意的数倍
      if (this._liveOrderOn(acc, stockId)) {
        held += 1;
        continue;
      }
      const lot = stock.lotSize || 100;
      const last = market.lastPrice;
      if (!(last > 0)) continue;

      if (sub.stance === 'bullish') {
        // 有任何空头（含不足 1 手的零股尾仓）都先平掉：sideLock 会让零股尾仓
        // 永远开不了多、而 <1 手的平空又常被"不足一手"的写法跳过，只能在这里收口
        const shortQty = acc.shortQty(stockId);
        if (shortQty > 0) {
          const coverable = acc.coverableShort(stockId);
          const qty = Math.min(coverable, lot * 50);
          if (qty <= 0) continue;
          const price = market.clampPrice(last * 0.998);
          const r = market.place(acc, {
            action: ACTIONS.BUY_CLOSE,
            qty,
            price,
            now,
            noCooldown: true,
          });
          noteOrder(ACTIONS.BUY_CLOSE, stockId, qty, price, r && r.ok, r && r.error);
          if (r && r.ok) placed += 1;
          continue;
        }
        if (acc.longQty(stockId) > 0) continue; // 已有同向持仓，决策周期内不加仓（防刷单）
        const budget = Math.max(0, acc.cash - acc.orderFrozen) * ratio * (0.4 + 0.6 * sub.weight);
        const qty = Math.floor(budget / last / lot) * lot;
        if (qty < lot) continue;
        const price = market.clampPrice(last * 0.998);
        const r = market.place(acc, {
          action: ACTIONS.BUY_OPEN,
          qty,
          price,
          now,
          noCooldown: true,
        });
        noteOrder(ACTIONS.BUY_OPEN, stockId, qty, price, r && r.ok, r && r.error);
        if (r && r.ok) placed += 1;
      } else if (sub.stance === 'bearish') {
        const longQty = acc.longQty(stockId);
        if (longQty > 0) {
          const free = acc.freeSellableLong(stockId, now);
          let qty = Math.floor(Math.min(free, longQty * 0.4) / lot) * lot;
          // 零股尾仓出清：按整手算会变成 0，永远卡在 sideLock 里
          if (qty < lot) qty = Math.min(free, longQty);
          if (qty <= 0) continue;
          const price = market.clampPrice(last * 1.002);
          const r = market.place(acc, {
            action: ACTIONS.SELL_CLOSE,
            qty,
            price,
            now,
            noCooldown: true,
          });
          noteOrder(ACTIONS.SELL_CLOSE, stockId, qty, price, r && r.ok, r && r.error);
          if (r && r.ok) placed += 1;
          continue;
        }
        if (acc.shortQty(stockId) > 0) continue;
        // 开空：需要券源；量按权益一小份
        const equity = Math.max(0, acc.equity((sid) => g.priceOf(sid)));
        const mv = equity * 0.15 * (0.4 + 0.6 * sub.weight);
        const qty = Math.floor(mv / last / lot) * lot;
        if (qty < lot) continue;
        const price = market.clampPrice(last * 1.002);
        const r = market.place(acc, {
          action: ACTIONS.SELL_OPEN,
          qty,
          price,
          now,
          noCooldown: true,
        });
        noteOrder(ACTIONS.SELL_OPEN, stockId, qty, price, r && r.ok, r && r.error);
        if (r && r.ok) placed += 1;
      }
    }
    if (placed) logger.info(`[LLM] ${whale.label} 本轮挂单 ${placed} 张`);
    else if (held) logger.debug(`[LLM] ${whale.label} 点名股票均已有在途挂单，本轮不追单`);
    return placedOrders;
  }

  /** 决策轮次 → 下发结构（观测页用） */
  _serializeRound(round) {
    if (!round) return null;
    const stockNames = {};
    for (const s of this.game.stocks) stockNames[s.id] = s.name;
    const mergedStocks = {};
    if (round.merged && round.merged.stocks) {
      for (const [id, s] of Object.entries(round.merged.stocks)) {
        mergedStocks[id] = {
          stockId: id,
          stockName: stockNames[id] || id,
          stance: s.stance,
          intent: s.intent,
          weight: s.weight,
          bias: s.bias,
        };
      }
    }
    return {
      t: round.t,
      day: round.day,
      phase: round.phase,
      phaseLabel: round.phaseLabel,
      merged: round.merged
        ? {
            bias: round.merged.bias,
            aggro: round.merged.aggro,
            stocks: mergedStocks,
            notes: round.merged.notes || [],
          }
        : null,
      decisions: (round.decisions || []).map((d) => ({
        whaleId: d.whaleId,
        label: d.label,
        ok: d.ok,
        error: d.error,
        bias: d.bias,
        intent: d.intent,
        aggressiveness: d.aggressiveness,
        note: d.note,
        stocks: d.stocks,
        ordersPlaced: d.ordersPlaced,
        orders: d.orders || [],
        ms: d.ms,
        tokens: d.tokens,
        phaseLabel: d.phaseLabel,
        day: d.day,
      })),
    };
  }

  /** 最近决策快照（观测页用）；内存态不落盘。history 最多 10 条 */
  lastDecisionSnapshot() {
    return {
      last: this._serializeRound(this.lastRound),
      history: (this.decisionHistory || []).map((r) => this._serializeRound(r)),
    };
  }

  _snapshot(dayState) {
    const g = this.game;
    const stocks = [];
    for (const stock of g.stocks) {
      const market = g.markets.get(stock.id);
      const npc = g.npcs.get(stock.id);
      if (!market || !npc) continue;
      stocks.push(stockLine({ stock, market, npc }));
    }
    const index = g.index && Number.isFinite(g.index.lastPrice) ? { last: g.index.lastPrice } : null;
    const { formatGameClock } = require('../daycycle');
    const clock =
      dayState && dayState.gameClockMs != null ? formatGameClock(dayState.gameClockMs) : '';
    return {
      day: dayState ? dayState.day : 0,
      phaseKey: dayState && dayState.phase ? dayState.phase.key : '',
      clock,
      stocks,
      index,
    };
  }
}

module.exports = { WhaleManager, mergePlans };
