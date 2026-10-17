/**
 * LLM 主力脑：schema 解析 + 多脑合议 + 软写回 + AI 账户（测试强制 NPC_LLM=0，禁止真调 API）
 */
process.env.NPC_LLM = '0';
const assert = require('assert');
const config = require('../src/config');
const { Game } = require('../src/game');
const { extractJsonObject, parseWhaleDecision } = require('../src/llm/schema');
const { mergePlans } = require('../src/llm/whales');

const STOCK_IDS = config.stocks.map((s) => s.id);
const CLAMP = () => Object.assign({}, config.npc.llm.clamp, { maxStocksPerDecision: 5 });

// [1] 从围栏/散文里抽出 JSON；note 里的花括号不该把对象提前截断
{
  const t = '好的，策略如下：\n```json\n{"bias":0.3,"stocks":{}}\n```\n以上。';
  const o = extractJsonObject(t);
  assert.ok(o && o.bias === 0.3, 'fenced json');

  const brace = extractJsonObject('{"bias":0.1,"note":"看到 {支撑} 就买","stocks":{}}');
  assert.ok(brace && brace.note.includes('{支撑}'), '字符串里的花括号不参与配对');

  // 前面先出现一个非法 `{...}` 片段，要继续找后面那个可解析的
  const two = extractJsonObject('先给个坏片段 {不是json} 再给真的 {"bias":0.2}');
  assert.ok(two && two.bias === 0.2, '首个对象坏掉时换下一个起点');
}

// [2] 解析 + 夹紧
{
  const r = parseWhaleDecision(
    JSON.stringify({
      bias: 9,
      intent: 'accumulate',
      intentChance: 5,
      aggressiveness: 99,
      note: '低位吸筹',
      stocks: {
        [STOCK_IDS[0]]: { stance: 'bullish', intent: 'accumulate', weight: 0.9 },
        [STOCK_IDS[1]]: { stance: 'bearish', intent: 'distribute', weight: 0.2 },
        [STOCK_IDS[2]]: { stance: 'neutral', intent: 'none', weight: 1 },
      },
    }),
    STOCK_IDS,
    CLAMP()
  );
  assert.ok(r.ok, 'parse ok');
  assert.ok(r.plan.bias <= config.npc.llm.clamp.bias, 'bias clamped');
  assert.ok(r.plan.intentChance <= config.npc.llm.clamp.intentChance[1], 'chance clamped');
  assert.ok(r.plan.aggro <= config.npc.llm.clamp.aggro[1], 'aggro clamped');
  assert.ok(r.plan.stocks[STOCK_IDS[0]], 'stock0 kept');
  assert.ok(!r.plan.stocks[STOCK_IDS[2]], 'neutral stock dropped');
  assert.ok(r.plan.stocks[STOCK_IDS[1]], 'stock1 kept');
}

// [3] 非法枚举丢弃；同义词/中文/名称键都能认
{
  const bad = parseWhaleDecision('我建议买入', STOCK_IDS, CLAMP());
  assert.strictEqual(bad.ok, false);
  const weird = parseWhaleDecision(
    JSON.stringify({ stocks: { [STOCK_IDS[0]]: { stance: 'sideways', intent: 'moon', weight: 1 } } }),
    STOCK_IDS,
    CLAMP()
  );
  assert.ok(weird.ok);
  assert.ok(!weird.plan.stocks[STOCK_IDS[0]], 'invalid enums drop the stock');

  const alias = parseWhaleDecision(
    JSON.stringify({ stocks: { 大米集团: { stance: '看涨', intent: '吸筹', weight: 0.8 } } }),
    config.stocks,
    CLAMP()
  );
  assert.ok(alias.ok);
  assert.deepStrictEqual(alias.plan.stocks['600001'], {
    stance: 'bullish',
    intent: 'accumulate',
    weight: 0.8,
  });
}

// [4] 缺失的 aggressiveness 必须是中性 1（旧写法 clamp(NaN)→0.55 会砍半吃单率）
{
  const r = parseWhaleDecision(JSON.stringify({ bias: 0.2, stocks: {} }), STOCK_IDS, CLAMP());
  assert.ok(r.ok);
  assert.strictEqual(r.plan.aggro, 1, '缺省力度 = 1');
  const hi = parseWhaleDecision(JSON.stringify({ bias: 0.2, aggressiveness: 99 }), STOCK_IDS, CLAMP());
  assert.strictEqual(hi.plan.aggro, config.npc.llm.clamp.aggro[1], '越界仍夹紧');
}

// [5] 名额按 weight 取前 N，而不是配置顺序
{
  const cfg = Object.assign({}, CLAMP(), { maxStocksPerDecision: 1 });
  const r = parseWhaleDecision(
    JSON.stringify({
      stocks: {
        [STOCK_IDS[0]]: { stance: 'bullish', intent: 'accumulate', weight: 0.2 },
        [STOCK_IDS[1]]: { stance: 'bullish', intent: 'accumulate', weight: 0.9 },
      },
    }),
    STOCK_IDS,
    cfg
  );
  assert.ok(r.ok);
  assert.deepStrictEqual(Object.keys(r.plan.stocks), [STOCK_IDS[1]], '权重最高的留下');
}

// [6] NPC_LLM=0 时 manager 不触发；applyLlmPlan 过期
{
  assert.strictEqual(config.npc.llm.enabled, false, '测试强制关闭 LLM');
  const g = new Game();
  assert.ok(g.whales, 'whales manager present');
  assert.strictEqual(g.whales.enabled, false);
  g.whales.onPhase({ day: 5, phase: { key: 'auction', label: '开盘集合竞价' } }, Date.now());
  assert.strictEqual(g.whales.busy, false, 'disabled 时不得进入 busy');

  const npc = g.npcs.get(STOCK_IDS[0]);
  npc.tickCount = 10;
  npc.applyLlmPlan({ bias: 0.3, intent: 'accumulate', intentChance: 0.4, aggro: 1.2, untilTick: 50 });
  assert.strictEqual(npc.liveLlmPlan().bias, 0.3);
  npc.tickCount = 51;
  assert.strictEqual(npc.liveLlmPlan(), null, '过期后清空');
}

// [7] applyLlmPlan(null) 安全 + ensureAccounts 建 4 个 AI 主力
{
  const g = new Game();
  const npc = g.npcs.get(STOCK_IDS[0]);
  npc.applyLlmPlan(null);
  assert.strictEqual(npc.liveLlmPlan(), null);

  g.whales.ensureAccounts({ fresh: true });
  const names = config.npc.llm.whales.map((w) => g.whales.accountName(w));
  for (const name of names) {
    const acc = g.store.get(name);
    assert.ok(acc, `AI account exists: ${name}`);
    assert.ok(acc.isNPC, 'whale is NPC-like');
    assert.strictEqual(acc.role, 'whale');
    assert.ok(acc.ai, 'ai flag');
    assert.strictEqual(acc.cash, config.npc.llm.cashEach, 'initial cash');
    assert.ok(acc.aiLabel, 'aiLabel set');
  }
  // 不重复发钱
  const cash0 = g.store.get(names[0]).cash;
  g.store.get(names[0]).cash = 12345;
  g.whales.ensureAccounts({ fresh: true });
  assert.strictEqual(g.store.get(names[0]).cash, 12345, 'resume must not re-fund');
}

// [8] 四脑合议：每个脑点名的股票都要活下来（旧实现被最后一个脑整体覆盖）
{
  const [s0, s1] = STOCK_IDS;
  const A = { id: 'whale_a', label: '一号主力' };
  const B = { id: 'whale_b', label: '空头猎手' };
  const C = { id: 'whale_c', label: '做市老庄' };
  const entries = [
    {
      whale: A,
      plan: {
        bias: 0.4, aggro: 1.2, intent: 'accumulate', intentChance: 0.3,
        stocks: { [s0]: { stance: 'bullish', intent: 'accumulate', weight: 0.9 } },
        note: '吸筹',
      },
    },
    {
      whale: B,
      plan: {
        bias: -0.2, aggro: 1.1, intent: 'distribute', intentChance: 0.25,
        // 只给了全局 intent，个股没写 → 用全局意图补偿
        stocks: { [s1]: { stance: 'bearish', intent: 'none', weight: 1 } },
        note: '派发',
      },
    },
    {
      whale: C,
      plan: { bias: 0, aggro: 0.9, intent: 'none', intentChance: 0.1, stocks: {}, note: '' },
    },
  ];
  const m = mergePlans(entries, STOCK_IDS, CLAMP());
  assert.ok(m.stocks[s0], 'A 点名的股票没被 C 的全局计划擦掉');
  assert.strictEqual(m.stocks[s0].stance, 'bullish');
  assert.ok(m.stocks[s0].bias > 0.2, `bullish 偏置应显著为正，实际 ${m.stocks[s0].bias}`);
  assert.strictEqual(m.stocks[s0].intent, 'accumulate');
  assert.strictEqual(m.stocks[s0].by, 'whale_a');
  assert.strictEqual(m.stocks[s1].stance, 'bearish');
  assert.ok(m.stocks[s1].bias < -0.15, 'bearish 偏置为负');
  assert.strictEqual(m.stocks[s1].intent, 'distribute', '全局 intent 补偿到个股');
  // 全局 bias 是四脑均值，只作为未点名股票的弱潮水
  assert.ok(Math.abs(m.bias - (0.4 - 0.2 + 0) / 3) < 1e-9, '全局 bias = 均值');
  assert.ok(m.bias < 0.2, '全局偏置不该被单脑拉满');
}

// [9] 多空对打的股票不表态；单脑同向叠加会顶到 clamp
{
  const s0 = STOCK_IDS[0];
  const mk = (id, bias, stance, weight) => ({
    whale: { id, label: id },
    plan: { bias, aggro: 1, intent: 'none', intentChance: 0.2, stocks: { [s0]: { stance, intent: 'none', weight } }, note: '' },
  });
  const clash = mergePlans([mk('a', 0.4, 'bullish', 0.9), mk('b', -0.4, 'bearish', 0.9)], STOCK_IDS, CLAMP());
  assert.ok(!clash.stocks[s0], '多空各 0.9 → 净 0，不表态');

  const agree = mergePlans([mk('a', 0.3, 'bullish', 0.9), mk('b', 0.3, 'bullish', 0.9)], STOCK_IDS, CLAMP());
  assert.strictEqual(agree.stocks[s0].stance, 'bullish');
  assert.ok(agree.stocks[s0].bias <= config.npc.llm.clamp.bias + 1e-9, '叠加不超过 clamp');
  assert.ok(agree.stocks[s0].bias > 0.4, '两个脑同向应接近上限');
}

// [10] 每日预算：按本地自然日计数，跨日重置
{
  const g = new Game();
  const w = g.whales;
  const old = config.npc.llm.budget.maxCallsPerDay;
  config.npc.llm.budget.maxCallsPerDay = 2;
  try {
    const now = new Date(2026, 9, 17, 10, 0, 0).getTime();
    assert.strictEqual(w._budgetOk(now), true);
    assert.strictEqual(w._budgetOk(now), true);
    assert.strictEqual(w._budgetOk(now), false, '超出后熔断');
    const next = new Date(2026, 9, 18, 0, 0, 10).getTime();
    assert.strictEqual(w._budgetOk(next), true, '本地零点后重置');
  } finally {
    config.npc.llm.budget.maxCallsPerDay = old;
  }
}

// [11] 收盘提前排程：剩余时间 - leadMs，至少 500ms；缺 leftMs 不排
{
  const g = new Game();
  const w = g.whales;
  assert.strictEqual(w._preTriggerDelay({ leftMs: 260000 }, { leadMs: 20000 }), 240000);
  assert.strictEqual(w._preTriggerDelay({ leftMs: 5000 }, { leadMs: 20000 }), 500);
  assert.strictEqual(w._preTriggerDelay({}, { leadMs: 20000 }), null, '没有 leftMs 就不排程');
  assert.ok(config.npc.llm.preTrigger, '配置里有提前排程');
  assert.strictEqual(config.npc.llm.preTrigger.phase, 'afternoon');
}

// [12] 进入下午段会排一个「收盘决策」定时器，且换阶段时被清掉
{
  const g = new Game();
  const w = g.whales;
  const old = config.npc.llm.enabled;
  config.npc.llm.enabled = true;
  try {
    w.onPhase(
      { day: 3, phase: { key: 'afternoon', label: '下午连续竞价' }, leftMs: 260000 },
      Date.now()
    );
    assert.ok(w._preTimer, '下午段应排出收盘决策');
    assert.strictEqual(w.busy, false, 'afternoon 不在 triggerPhases，不该直接跑一轮');
    w.onPhase(
      { day: 3, phase: { key: 'night', label: '休市结算' }, leftMs: 40000 },
      Date.now()
    );
    assert.strictEqual(w._preTimer, null, '换阶段必须清掉旧定时器');
  } finally {
    w._clearPre();
    config.npc.llm.enabled = old;
  }
}

console.log('llm.test.js: all passed');
