/**
 * 决策 JSON 解析 + 夹紧。
 * 模型输出永远不可信：抽第一个 JSON 对象、枚举校验、数值夹进 config 安全区间。
 *
 * 2026-10-17 修订：
 * - 括号抽取改为**字符串感知**（note 里写 `{}` 不会再把 JSON 提前截断），
 *   且首个 `{...}` 解析失败时继续试后面的起点，不再一条坏对象废掉整轮决策。
 * - 股票键支持 **代码 / 名称 / 简称** 三种写法（模型经常回「大米集团」而不是 600001）。
 * - 名额按 **weight 降序** 截断（原来按配置顺序 break，永远只喂前几只票）。
 * - `aggressiveness` 缺失时回落 **1.0**（继续沿用 clamp 的 NaN→lo 会把吃单率砍到 0.55）。
 */
const { logger } = require('../logger');

const STANCES = new Set(['bullish', 'bearish', 'neutral']);
const INTENTS = new Set(['none', 'accumulate', 'distribute', 'squeeze']);

// 模型爱写同义词/中文，统一归一到内部枚举；识别不了的一律当无效值丢弃
const STANCE_ALIAS = {
  bullish: 'bullish', bull: 'bullish', long: 'bullish', buy: 'bullish', up: 'bullish',
  看多: 'bullish', 看涨: 'bullish', 多: 'bullish',
  bearish: 'bearish', bear: 'bearish', short: 'bearish', sell: 'bearish', down: 'bearish',
  看空: 'bearish', 看跌: 'bearish', 空: 'bearish',
  neutral: 'neutral', flat: 'neutral', none: 'neutral',
  中性: 'neutral', 观望: 'neutral', 无: 'neutral',
};
const INTENT_ALIAS = {
  none: 'none', hold: 'none', idle: 'none',
  无: 'none', 不动: 'none', 观望: 'none',
  accumulate: 'accumulate', accumulation: 'accumulate', collect: 'accumulate', buy: 'accumulate',
  吸筹: 'accumulate', 建仓: 'accumulate', 收集: 'accumulate',
  distribute: 'distribute', distribution: 'distribute', dump: 'distribute', sell: 'distribute',
  派发: 'distribute', 出货: 'distribute', 减仓: 'distribute',
  squeeze: 'squeeze', short_squeeze: 'squeeze', 挤兑: 'squeeze', 逼空: 'squeeze',
};

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** 数值夹紧，但缺省/非法值回落 dflt（clamp 的 NaN→lo 只适合「越小越安全」的量） */
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function normEnum(raw, table) {
  const k = String(raw == null ? '' : raw).trim().toLowerCase();
  return table[k] || null;
}

/** 从模型文本里挖出第一个可解析的平衡 {...}；字符串里的花括号不参与配对，兼容 ```json 围栏 */
function extractJsonObject(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  let start = s.indexOf('{');
  while (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let closed = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          try {
            return JSON.parse(s.slice(start, i + 1));
          } catch {
            // 这一段不是合法 JSON：可能是前面某句散文里的 `{}`，换下一个起点继续找
          }
          break;
        }
      }
    }
    if (!closed && depth > 0) break; // 从 start 开始没闭合，后面也不会闭合
    start = s.indexOf('{', start + 1);
  }
  return null;
}

/** 把「代码 / 名称 / 简称」三种键统一映射回内部股票代码 */
function buildResolver(stocks) {
  const byKey = new Map();
  for (const s of stocks || []) {
    const id = typeof s === 'string' ? s : s && s.id;
    if (!id) continue;
    byKey.set(String(id), id);
    if (s && s.name) byKey.set(String(s.name).trim(), id);
    if (s && s.alias) byKey.set(String(s.alias).trim(), id);
  }
  return byKey;
}

/** 全局 intent 只在和个股方向一致时才拿来补偿；bullish+distribute 这种自相矛盾的要丢掉 */
function intentAgrees(stance, intent) {
  if (!intent || intent === 'none') return false;
  if (stance === 'bullish') return intent === 'accumulate' || intent === 'squeeze';
  if (stance === 'bearish') return intent === 'distribute';
  return false;
}

/**
 * 解析「一脑一决策」输出。
 * @param {string} text 模型原文
 * @param {Array<string|{id:string,name?:string,alias?:string}>} stocks 可选股票集合
 * @param {object} [clampCfg] config.npc.llm.clamp（+ maxStocksPerDecision）
 * @returns {{ok:true, plan:object}|{ok:false, error:string}}
 * plan: { bias, intent, intentChance, aggro, stocks: {stockId:{stance,intent,weight}}, note }
 */
function parseWhaleDecision(text, stocks, clampCfg) {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'no_json' };

  const c = clampCfg || {};
  const biasMax = clampNum(c.bias, 0, 5, 0.45);
  const [aggroLo, aggroHi] = Array.isArray(c.aggro) ? c.aggro : [0.55, 1.45];
  const [chanceLo, chanceHi] = Array.isArray(c.intentChance) ? c.intentChance : [0, 0.55];
  const maxStocks = clampNum(c.maxStocksPerDecision, 1, 50, 5);

  const byKey = buildResolver(stocks);
  const rawStocks =
    obj.stocks && typeof obj.stocks === 'object' && !Array.isArray(obj.stocks) ? obj.stocks : {};

  // 先映射回内部代码；同一个代码被写两次（名字一次、代码一次）取权重大的那条
  const picked = new Map();
  let unknown = 0;
  for (const [key, raw] of Object.entries(rawStocks)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = byKey.get(String(key).trim());
    if (!id) {
      unknown += 1;
      continue;
    }
    const stance = normEnum(raw.stance, STANCE_ALIAS) || 'neutral';
    const intent = normEnum(raw.intent, INTENT_ALIAS) || 'none';
    if (stance === 'neutral' && intent === 'none') continue;
    const weight = clampNum(raw.weight, 0, 1, 0);
    if (weight < 0.15) continue;
    const prev = picked.get(id);
    if (prev && prev.weight >= weight) continue;
    picked.set(id, { stance, intent, weight });
  }
  if (unknown) logger.warn(`[LLM] 决策里有 ${unknown} 个无法识别的股票键（既不是代码也不是名称）`);

  // 名额按 conviction 降序：配置顺序截断会让前几只票永远占满名额
  const ranked = [...picked.entries()]
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, maxStocks);
  const outStocks = {};
  for (const [id, s] of ranked) {
    if (s.stance === 'neutral' && s.intent === 'none') continue;
    outStocks[id] = s;
  }

  // 全局 bias：优先读 obj.bias，否则由活跃股票 stance 合成一个弱偏置
  let bias = Number(obj.bias);
  if (!Number.isFinite(bias)) {
    const signed = Object.values(outStocks).map((s) => {
      if (s.stance === 'bullish') return s.weight;
      if (s.stance === 'bearish') return -s.weight;
      return 0;
    });
    const avg = signed.length ? signed.reduce((a, b) => a + b, 0) / signed.length : 0;
    bias = avg * 0.5;
  }
  bias = clamp(bias, -biasMax, biasMax);

  let intent = normEnum(obj.intent, INTENT_ALIAS) || 'none';
  // 全局 intent 若与活跃股票一致优先保留，否则取权重最高的股票 intent
  if (intent === 'none' && Object.keys(outStocks).length) {
    const entries = Object.entries(outStocks).sort((a, b) => b[1].weight - a[1].weight);
    intent = entries[0][1].intent || 'none';
  }

  const aggroRaw = obj.aggressiveness != null ? obj.aggressiveness : obj.aggro;
  // 缺失必须是 1（中性力度）；旧写法 clamp(NaN) 会落到 0.55，等于偷偷把吃单率砍半
  const aggro = clampNum(aggroRaw, aggroLo, aggroHi, 1);
  const intentChance = clampNum(
    obj.intentChance != null ? obj.intentChance : 0.22,
    chanceLo,
    chanceHi,
    0.22
  );
  const note = obj.note != null ? String(obj.note).slice(0, 120) : '';

  return {
    ok: true,
    plan: {
      bias,
      intent,
      intentChance,
      aggro,
      stocks: outStocks,
      note,
    },
  };
}

module.exports = {
  extractJsonObject,
  parseWhaleDecision,
  intentAgrees,
  clamp,
  clampNum,
  STANCES,
  INTENTS,
};
