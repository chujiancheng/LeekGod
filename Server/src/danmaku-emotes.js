/**
 * 弹幕表情 —— 白名单 + 情境权重，见 Doc/弹幕方案.md §3.8 / §5.2
 *
 * 服务端只认 key，不认图形：真正画出来的是客户端 `Client/app.js` 里的 `DM_EMOTE_PACKS`
 * （24×24 的双色 SVG，外轮廓 `stroke: currentColor`）。这样表情会自动继承说话人的颜色
 * （散户灰 / 游资红 / 大户紫 / 玩家金），客户端换皮也不用动服务端一根线。
 *
 * **表情分系列（pack）**：`classic` 是默认系列，现在只有它。加新系列的步骤见 §3.8：
 * 在这里往 `PACKS` 里登记 key，再把 id 加进 `config.danmaku.emotePacks` 让 NPC 去用。
 * key 全局唯一（新系列请带前缀，如 `food:burger`），协议不用改——还是只发一个字符串。
 *
 * 硬约束：**表情只能从这份白名单里取**。
 * 玩家自由输入的文字一律不许带 emoji——一旦允许，长度闸门（24 字）就形同虚设，
 * 一个 ZWJ 序列能塞进任意图形，飘屏层直接失控。所以玩家那边只收 key，
 * 自己贴的 emoji 会被 `postPlayer` 拒掉并提示用表情按钮。
 */
const config = require('./config');

/**
 * 系列登记表。系列的边界只有客户端在意（选择器里分 tab），服务端只用来
 * ① 拼白名单 ② 按 config.danmaku.emotePacks 决定 NPC 能从哪些系列里挑。
 */
const PACKS = {
  classic: {
    id: 'classic',
    label: '经典',
    keys: [
      'cry', 'laugh', 'sweat', 'rage', 'shock', 'skull', 'rocket', 'fire',
      'coin', 'heartbreak', 'leek', 'eyes', 'zzz', 'question', 'chartup', 'chartdown',
      'thumbup', 'face',
    ],
  },
};

/** 默认系列：客户端只认不出的 pack id 时回退到它，配置空着时也用它 */
const DEFAULT_PACK = 'classic';

/** 全部合法 key（所有系列的并集）。客户端必须全覆盖它（测试对着比，少一个就红） */
const KEYS = Object.values(PACKS).flatMap((p) => p.keys);
const KEY_SET = new Set(KEYS);
/** key -> 系列 id，用来按系列过滤候选池 */
const KEY_PACK = new Map();
for (const p of Object.values(PACKS)) for (const k of p.keys) KEY_PACK.set(k, p.id);

/**
 * 情境 → 候选表情。重复的 key 就是权重：
 * 亏 8 个点八成是哭，偶尔心碎/冒汗/绿箭头——同一个表情连着刷会腻，也显得假。
 */
const SCENE_POOL = {
  deepLoss: ['cry', 'cry', 'cry', 'heartbreak', 'sweat', 'chartdown', 'leek'],
  win: ['laugh', 'laugh', 'laugh', 'rocket', 'coin', 'fire', 'chartup'],
  liquidation: ['skull', 'skull', 'skull', 'cry', 'shock', 'sweat'],
  idle: ['eyes', 'eyes', 'zzz', 'question', 'sweat', 'leek', 'face'],
  // 旁观者看玩家做事（playerB）：不是自己的情绪，别配「哭」这种太私人的脸
  bigBuy: ['fire', 'eyes', 'shock', 'rocket', 'thumbup'],
  cutLoss: ['sweat', 'cry', 'leek', 'shock', 'heartbreak'],
};

/** 机构与自营不带表情：「暂无观点 🙂」不是研报该有的样子 */
const FORMAL_TYPES = new Set(['inst', 'mm']);

function isKey(k) {
  return typeof k === 'string' && KEY_SET.has(k);
}

/** key 属于哪个系列（未知 key 返回 null） */
function packOf(k) {
  return KEY_PACK.get(k) || null;
}

/** 当前启用的系列：配置空着 / 写错 id 时退回默认系列，别把 NPC 弄哑 */
function enabledPacks() {
  const cfg = config.danmaku || {};
  const list = Array.isArray(cfg.emotePacks) ? cfg.emotePacks.filter((id) => PACKS[id]) : [];
  return new Set(list.length ? list : [DEFAULT_PACK]);
}

/** 某情境的候选池（只含启用系列里的 key；未登记的 scene 返回 null） */
function poolOf(scene) {
  const raw = SCENE_POOL[scene];
  if (!Array.isArray(raw)) return null;
  const on = enabledPacks();
  return raw.filter((k) => on.has(KEY_PACK.get(k)));
}

/**
 * 按情境抽一个表情
 * @param {string} scene deepLoss|win|liquidation|idle|bigBuy|cutLoss
 * @param {string} type  说话人类型（inst / mm 直接返回 null）
 * @param {number} [chance] 出现概率，默认取 config.danmaku.emoteChance
 * @returns {string|null}
 */
function pick(scene, type, chance) {
  if (FORMAL_TYPES.has(type)) return null;
  const cfg = config.danmaku || {};
  const p = chance != null ? chance : (cfg.emoteChance == null ? 0.55 : cfg.emoteChance);
  if (!(p > 0) || Math.random() >= p) return null;
  const pool = poolOf(scene);
  if (!pool || !pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = {
  PACKS, DEFAULT_PACK, KEYS, SCENE_POOL, FORMAL_TYPES,
  isKey, packOf, poolOf, pick, enabledPacks,
};
