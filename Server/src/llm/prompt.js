/**
 * 组 prompt：与具体模型无关。状态摘要要短——每次决策只花 ~2k token。
 *
 * 2026-10-17 修订：
 * - 人设描述与实现对齐：模型看不到自己的账户、却一直被代下单，这里补上账户快照
 *   （现金/冻结/权益/持仓），并说明「你的立场会让同名 AI 账户在盘口挂限价单」。
 * - 个股补 `shortFloatPct`（空头占流通盘比例，绝对股数模型读不出轻重）与 `lot`。
 * - 修掉「不要输出数组以外的废话」这种和「只输出 JSON 对象」自相矛盾的约束。
 */
const config = require('../config');

function r(n, d = 2) {
  const x = Number(n);
  return Number.isFinite(x) ? Number(x.toFixed(d)) : 0;
}

function sideDepth(book, side, n = 3) {
  const arr = (book && book[side]) || [];
  return arr.slice(0, n).map((x) => ({ p: r(x.price, 2), q: Number(x.qty) || 0 }));
}

/**
 * 单只股票的紧凑摘要
 * @param {{stock:object, market:object, npc:object}} ctx
 */
function stockLine(ctx) {
  const { stock, market, npc } = ctx;
  const last = market.lastPrice || 0;
  const prev = market.prevClose || stock.initPrice || 0;
  const chg = prev > 0 ? r(((last - prev) / prev) * 100, 2) : 0;
  const level =
    stock.initPrice > 0 && npc && npc.fund > 0 ? r((npc.fund / stock.initPrice - 1) * 100, 1) : 0;
  const force = npc && Number.isFinite(npc.force) ? r(npc.force, 2) : 0;
  const regime = npc && npc.regime > 0 ? 'bull' : npc && npc.regime < 0 ? 'bear' : 'range';
  const shortQty = Number(market.shortInterest) || 0;
  const floatShares = Number(stock.floatShares) || 0;
  return {
    id: stock.id,
    name: stock.name,
    last: r(last, 2),
    prevClose: r(prev, 2),
    chgPct: chg,
    force,
    regime,
    fundLevelPct: level,
    shortInterest: shortQty,
    // 空头占流通盘的比例：只给绝对股数时模型读不出「空头是轻是重」
    shortFloatPct: floatShares > 0 ? r((shortQty / floatShares) * 100, 2) : 0,
    lot: stock.lotSize || 100,
    bids: sideDepth(market.book, 'bids'),
    asks: sideDepth(market.book, 'asks'),
    intent: npc && npc.intent ? npc.intent.mode : 'none',
  };
}

function systemPrompt(whale) {
  const maxOrders = config.npc.llm ? config.npc.llm.maxOrdersPerDecision : 3;
  const limitPct = config.priceLimit && config.priceLimit.enabled ? config.priceLimit.pct * 100 : 0;
  return [
    `你是炒股模拟游戏里的职业操盘手：${whale.label}。`,
    `人设：${whale.style}`,
    '唯一目标：**把账户权益做大（多赚钱）**。可以做多，也可以做空；方向服从机会，不站死多头或死空头。',
    '你服务两种执行体：① 本股「机构/游资」NPC 的买卖倾向；② 一个与你同名的 AI 机构账户——你的 stance 会让它在盘口挂限价单，每次决策至多 ' +
      maxOrders +
      ' 张。',
    '所以你既要判断方向，也要考虑自己的钱和已有仓位；优先集中 1~3 只最有把握的股票，不要撒胡椒面。',
    '游戏规则要点：可对多只股票做多/做空；存在涨跌停（' +
      limitPct +
      '%）与集合竞价；空头有券源上限；同股多空互斥（要翻向必须先平掉另一侧）。',
    '你只输出严格 JSON，不要 markdown 解释、不要额外文字。',
    '输出 schema（全部字段尽量给全）：',
    '{"bias": -1~1, "intent": "none|accumulate|distribute|squeeze", "intentChance": 0~1, "aggressiveness": 0.5~1.5, "note": "一句话", "stocks": {"股票代码": {"stance": "bullish|bearish|neutral", "intent": "none|accumulate|distribute|squeeze", "weight": 0~1}}}',
    '约束：最多对少数几只股票给出非 neutral 策略；其余应省略或 neutral。',
    '不要编造不存在的股票代码；stocks 里必须用上面列出的 id；只输出一个 JSON 对象。',
  ].join('\n');
}

function accountLine(account) {
  if (!account) return null;
  const pos = (account.positions || [])
    .map((p) => `${p.id}:多${p.long}/空${p.short}`)
    .join('，');
  return (
    `你的 AI 账户：现金 ${account.cash}，挂单冻结 ${account.frozen}，权益 ${account.equity}` +
    (pos ? `，持仓（${pos}）` : '，当前空仓')
  );
}

function userPrompt(whale, snapshot, lastNote, account) {
  const lines = [];
  lines.push(`交易日 snapshot：day=${snapshot.day}，phase=${snapshot.phaseKey}，time=${snapshot.clock}`);
  if (lastNote) lines.push(`你上一轮判断：${lastNote}`);
  const acc = accountLine(account);
  if (acc) lines.push(acc);
  lines.push('全市场：');
  lines.push(JSON.stringify(snapshot.stocks));
  if (snapshot.index) lines.push(`大盘指数：${JSON.stringify(snapshot.index)}`);
  lines.push('请给出本阶段你的组合策略 JSON。');
  return lines.join('\n');
}

module.exports = { systemPrompt, userPrompt, stockLine };
