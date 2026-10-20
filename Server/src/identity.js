/**
 * NPC 身份系统：把 3160 个 NPC 从「大米·游资1」变成有名有姓的投资者。
 *
 * 两个字段分工（见 Doc/NPC真实身份方案.md §1）：
 * - **账号**（`acc.name`）：内部唯一键，`npc-0001`，玩家永远看不到；
 * - **昵称**（`acc.nick`）：展示名，`曹俊（杭州）` / `望元私募` / `宁波桑田路·孙叔`，
 *   前端一律走 `Game.displayName()`，所以换名不需要改任何渲染代码。
 *
 * 名字**确定性**生成：同一个 (类型, 序号) 永远得到同一个名字，重启不换人。
 * 全局去重（`used`）保证 3160 个展示名互不相同——顺序固定，结果就固定。
 * 顺序由 `Game.start` 的建号循环决定（股票顺序 → 类型顺序 → 池内序号），
 * 所以每次新局开始时必须先 `reset()`（不 reset 的话第二次建局会继承上一局的禁用集，
 * 名字会整体漂移）。
 */

// ---------- 词库 ----------
const SURNAME = (
  '王 李 张 刘 陈 杨 黄 赵 周 吴 徐 孙 马 朱 胡 郭 何 高 林 罗 郑 梁 谢 宋 唐 许 韩 冯 邓 曹 彭 曾 萧 田 董 潘 袁 蔡 蒋 余 于 杜 叶 程 苏 魏 吕 丁 任 沈 姚 卢 姜 崔 钟 谭 陆 汪 范 金 石'
).split(' ');

// 男性单字：偏"上一辈"的用字；女性单字同理。双字由同池组合而成
const GIVEN_M = (
  '伟 强 磊 军 洋 勇 杰 涛 明 超 刚 平 辉 鹏 华 飞 鑫 毅 俊 峰 亮 宇 浩 凯 斌 龙 建 国 志 远 文 博 嘉 泽 昊 睿 航 晨 曦 楠 锋 新 生 立 成 宏 波'
).split(' ');
const GIVEN_F = (
  '芳 娜 敏 静 丽 艳 娟 霞 秀 英 玲 燕 婷 雪 琳 悦 欣 怡 雅 梦 洁 倩 晶 颖 蕾 薇 萍 慧 珊 嘉 宁 秋 月 语 竹 梅 兰 荷 云 露'
).split(' ');

const CITY = (
  '北京 上海 深圳 广州 杭州 宁波 温州 成都 武汉 南京 苏州 厦门 福州 西安 重庆 长沙 青岛 大连 天津 郑州 合肥 济南 东莞 佛山 无锡 台州 绍兴 常州'
).split(' ');

// 机构名：A + B + 后缀，组合空间 20 × 20 × 8 = 3200，足够 100 个不撞
const ORG_A = ('晟 青 九 磐 北 长 明 泰 元 恒 汇 泓 睿 鼎 润 熙 沐 望 知 衡').split(' ');
const ORG_B = ('元 禾 章 石 岸 岭 川 泽 承 信 和 景 立 方 山 林 原 舟 屿 桥').split(' ');
const ORG_C = ['资本', '资产', '投资', '私募', '资管', '基金', '创投', '控股'];

// 游资：地域帮派 / 打法 + 江湖绰号，组合空间 12 × 14 = 168
const HOT_TAG = (
  '涨停敢死队 深圳帮 温州帮 宁波桑田路 成都系 杭州帮 山东帮 佛山帮 作手 首板客 打板王 游资老炮'
).split(' ');
const HOT_HONOR = (
  '赵哥 陈总 孙叔 老徐 阿强 徐总 老李 王哥 老周 小马哥 阿昌 老吴 唐总 阿峰'
).split(' ');

/** 做市商（券商自营）的展示名后缀。券商名由 broker.js 提供，见 makerNick */
const MAKER_SUFFIX = '自营';

// ---------- 确定性随机 ----------

/**
 * 字符串 → [0,1)。FNV-1a 负责折叠，末尾三轮 xor-multiply 做雪崩。
 *
 * ⚠️ 少了雪崩那三步会出大问题：单用 FNV-1a 时相邻种子（`small1` / `small2`）
 * 的高位几乎一样，取模后大面积落进同一个桶——实测 2200 个散户重名 1051 个，
 * 名字会成串重复。加 finalizer 后重名降到 6%（去重前），接近真实水平。
 */
function hash(seed) {
  let x = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    x ^= seed.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function pick(list, seed) {
  return list[Math.min(list.length - 1, Math.floor(hash(seed) * list.length))];
}

// ---------- 生成器 ----------

function personCandidate(seed) {
  const male = hash('g:' + seed) < 0.62;
  const surname = pick(SURNAME, 's:' + seed);
  const pool = male ? GIVEN_M : GIVEN_F;
  const given = pick(pool, 'n:' + seed) + (hash('d:' + seed) < 0.42 ? pick(pool, 'n2:' + seed) : '');
  return `${surname}${given}（${pick(CITY, 'c:' + seed)}）`;
}

function orgCandidate(seed) {
  return pick(ORG_A, 'a:' + seed) + pick(ORG_B, 'b:' + seed) + pick(ORG_C, 'z:' + seed);
}

function hotCandidate(seed) {
  return `${pick(HOT_TAG, 't:' + seed)}·${pick(HOT_HONOR, 'h:' + seed)}`;
}

const GENERATORS = {
  inst: orgCandidate,
  hot: hotCandidate,
  // 大户 / 中户 / 散户共用一套人名池：区分它们的是行为参数，不是名字长什么样
  big: personCandidate,
  mid: personCandidate,
  small: personCandidate,
};

// ---------- 对外接口 ----------

let used = new Set();

/** 新局开始时清空去重集。必须在建号循环之前调用一次 */
function reset() {
  used = new Set();
}

/**
 * 取一个展示名。同一个 (类型, 序号) 在同一个 reset 周期内永远得到同一个名字，
 * 撞名时按固定步长（7919，与 3200/168 都互质）往后跳，所以跳过的顺序也是确定的。
 * @param {string} typeKey inst / hot / big / mid / small
 * @param {number} seq 全局唯一序号（跨股票递增，见 Game 构造里的 seqBase）
 */
function nameFor(typeKey, seq) {
  const gen = GENERATORS[typeKey] || personCandidate;
  for (let k = 0; k < 120; k++) {
    const cand = gen(seq + k * 7919);
    if (!used.has(cand)) {
      used.add(cand);
      return cand;
    }
  }
  // 词库被榨干（只有游资的 168 组合在极端情况下可能）——用序号兜底，保证唯一
  const fallback = `${gen(seq)}${seq}`;
  used.add(fallback);
  return fallback;
}

/**
 * 账号（内部键）。**故意不含股票代码**：`/api/holders` 会把 account 一起下发，
 * 带股票代码的话玩家一眼就能看出"这个投资者是配给哪只票的"，等于自己拆穿自己。
 */
function accountFor(seq) {
  return `npc-${String(seq).padStart(4, '0')}`;
}

/**
 * 做市商的展示名：`钟信自营`。
 * @param {string} brokerAbbr broker.js 里的券商简称（钟信 / 华泰 / …）
 */
function makerNick(brokerAbbr) {
  return `${brokerAbbr}${MAKER_SUFFIX}`;
}

module.exports = { nameFor, accountFor, makerNick, reset, hash };
