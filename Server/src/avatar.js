/**
 * 头像内核 —— 见 Doc/头像方案.md
 *
 * 定位：**观测层的第三块屏幕**。彩蛋回答「你刚做成了什么」，境界回答「你现在是谁」，
 * 头像回答「别人一眼怎么认出你」——排行榜上出现两个「老王」时，名字救不了你，脸可以。
 * 零数值特权、零日内状态，绝不回写任何交易字段。
 *
 * 五条口径（与方案一一对应）：
 * ① **只存 key**：`accounts.avatar` 存的是目录里的 key，不是 URL / 路径 / base64。
 *    拼 `/img/avatar-<key>-96.png` 是客户端的事（方案 §6.3）——配置里能写 URL 的那天，
 *    `img-src 'self'` 的白名单就等于没有；
 * ② **没有「无脸」这个状态**：`avatar` 为 NULL 时按 `hash('ava:' + 账号)` 确定性派生一张基础脸。
 *    加 `ava:` 前缀是为了与券商标签的哈希**解耦**——直接 `hash(name)` 会让「钟信客户」和
 *    「某张脸」系统性绑在一起，榜上一眼看出规律（方案 §5.2）；
 * ③ **NPC 只派生、永不读列、永不写列**：`persist.writeAccount` 对 NPC 写 NULL。
 *    「NPC 逐 tick 标脏」是本项目禁忌（见 AGENTS.md / 项目知识 §4）；
 * ④ **解锁判定只在服务端**：前端只渲染 `unlock.text`。前端写死一份文案，改配置那天它就
 *    静默变成骗人的说明书（与 realm 整表同一规矩）；
 * ⑤ **关了的功能整组不下发**：彩蛋 / 境界关掉时对应组整组消失——否则会出现「永远解不开的锁」。
 *
 * 解锁三源（方案 §5.4）：
 *   base   → 恒真
 *   broker → `accounts.broker_seen` 含该 key（转户不收回；当前券商天然在列）
 *   realm  → **历史最高**境界（`milestones.peakEquity` 反推的大境界序号 ≥ 目标大境界）
 *   egg    → `milestones.fired` 含该彩蛋 id（零新判定，彩蛋系统已经在算）
 */

const config = require('./config');
const identity = require('./identity');
const realm = require('./realm');
const fs = require('fs');
const path = require('path');

/** 站点图片目录（两档派生图都在这里）。require 时用来挡「配了 key 却没图」 */
const IMG_DIR = path.join(__dirname, '..', '..', 'Client', 'img');

const CFG = config.avatar || {};
const CATALOG = Array.isArray(CFG.catalog) ? CFG.catalog : [];
const GROUPS = Array.isArray(CFG.groups) ? CFG.groups : [];
const GROUP_IDS = new Set(GROUPS.map((g) => g.id));
const BY_KEY = new Map(CATALOG.map((r) => [r.key, r]));

/** 基础组：默认脸的取值池。空表时整个头像系统降级为「不渲染」 */
const BASE = CATALOG.filter((r) => r.group === 'base');

/** 大境界的先后顺序（境界组头像按它比大小） */
const REALM_GROUPS = Array.isArray((config.realm || {}).groups) ? config.realm.groups : [];
const REALM_ORDER = new Map(REALM_GROUPS.map((g, i) => [g.key, i]));

/** 彩蛋 id 全集：从 config.milestones 的各族里收（配错一个 = 永远解不开的锁，必须启动时红） */
function eggIds() {
  const out = new Set();
  const m = config.milestones || {};
  for (const v of Object.values(m)) {
    if (!Array.isArray(v)) continue;
    for (const item of v) if (item && typeof item.id === 'string') out.add(item.id);
  }
  return out;
}

const KEY_RE = /^[a-z][a-z0-9-]{1,15}$/;

// require 时校验一次：配错了必须在启动时炸，而不是让玩家看到一张 404 的脸
(function validate() {
  if (!CATALOG.length) return;
  const seen = new Set();
  CATALOG.forEach((row, i) => {
    if (!row || typeof row.key !== 'string' || !KEY_RE.test(row.key)) {
      throw new Error(`config.avatar.catalog[${i}] 的 key 不合法（要求 ${KEY_RE}）`);
    }
    if (seen.has(row.key)) throw new Error(`config.avatar.catalog 里 key「${row.key}」重复`);
    seen.add(row.key);
    if (!GROUP_IDS.has(row.group)) {
      throw new Error(`config.avatar.catalog「${row.key}」的 group「${row.group}」不在 config.avatar.groups 里`);
    }
    if (!row.name) throw new Error(`config.avatar.catalog「${row.key}」缺少 name`);
    if (row.group === 'broker' && !((config.brokers || {}).list || {})[row.value]) {
      throw new Error(`config.avatar.catalog「${row.key}」的券商「${row.value}」不在 config.brokers.list 里`);
    }
    if (row.group === 'realm' && !REALM_ORDER.has(row.value)) {
      throw new Error(`config.avatar.catalog「${row.key}」的大境界「${row.value}」不在 config.realm.groups 里`);
    }
    if (row.group === 'egg' && !eggIds().has(row.value)) {
      throw new Error(`config.avatar.catalog「${row.key}」的彩蛋 id「${row.value}」不在 config.milestones 里`);
    }
    // 图必须真的在：`http.js` 是按 catalog 循环注册白名单的，缺图 = 线上 404 裂图，
    // 而裂图只会在真机上被看成"页面坏了"——所以在这里挡，启动就红（老坑，见方案 §4.5）
    for (const size of [96, 192]) {
      const file = path.join(IMG_DIR, `avatar-${row.key}-${size}.png`);
      if (!fs.existsSync(file)) {
        throw new Error(
          `config.avatar.catalog「${row.key}」缺图：Client/img/avatar-${row.key}-${size}.png 不存在` +
            `\n先用 art/avatars/build_web_assets.py 派生两档图，或把这条从 catalog 里摘掉`
        );
      }
    }
  });
  for (const g of GROUPS) {
    if (!CATALOG.some((r) => r.group === g.id)) {
      throw new Error(`config.avatar.groups「${g.id}」在 catalog 里一张图都没有（空组会在弹层里显示成一片空白）`);
    }
  }
})();

/** 组是否整体下线：彩蛋组 / 境界组跟着各自开关走（关了就不发，别给玩家一把打不开的锁） */
function groupEnabled(groupId) {
  if (!CFG.enabled) return false;
  if (groupId === 'egg') return !!((config.milestones || {}).enabled);
  if (groupId === 'realm') return !!((config.realm || {}).enabled);
  return true;
}

/**
 * 默认脸：`hash('ava:' + 账号)` → 基础组里的一张。
 * 复用 identity.hash（自带 fmix32 雪崩）——裸 FNV-1a 会让相邻账号（npc-0001/0002）
 * 大面积塌进同一个桶，券商标签已经踩过一模一样的坑（项目知识 §3.2 坑 1）。
 */
function derive(account) {
  if (!BASE.length) return null;
  const idx = Math.min(BASE.length - 1, Math.floor(identity.hash('ava:' + account) * BASE.length));
  return BASE[idx].key;
}

/** 账户「待过的券商」：数组形式（内存里统一用数组，落盘时拼成逗号串） */
function brokerSeenOf(acc) {
  const list = acc && Array.isArray(acc.brokerSeen) ? acc.brokerSeen : [];
  // 当前券商天然在列：老档升级上来时 `broker_seen` 是 NULL，不该因此把门派脸锁死
  if (acc && acc.broker && !list.includes(acc.broker)) return list.concat([acc.broker]);
  return list;
}

/** 记一次「待过这家券商」。只增不减，重复调用无副作用（转户 / 开户两条路都调它） */
function markBrokerSeen(acc, key) {
  if (!acc || !key) return false;
  if (!Array.isArray(acc.brokerSeen)) acc.brokerSeen = [];
  if (acc.brokerSeen.includes(key)) return false;
  acc.brokerSeen.push(key);
  return true;
}

/** 历史最高境界对应的大境界（缺 peakEquity 的老档退回已确认档位；都没有 = 凡骨） */
function peakRealmGroup(acc) {
  const st = acc && acc.milestones;
  if (!st) return 'mortal';
  let idx = 0;
  if (Number.isFinite(st.peakEquity)) idx = realm.idxOf(st.peakEquity);
  else if (Number.isFinite(st.realmIdx)) idx = st.realmIdx;
  if (!(idx > 0)) return 'mortal';
  return realm.tierOf(idx).group || 'mortal';
}

function firedOf(acc) {
  const st = acc && acc.milestones;
  const fired = st && Array.isArray(st.fired) ? st.fired : [];
  return fired;
}

/** 单张脸的解锁判定（唯一判定入口，`stateOf` 与 `set` 都走它） */
function isUnlocked(acc, row) {
  if (!row) return false;
  if (row.group === 'base') return true;
  if (row.group === 'broker') return brokerSeenOf(acc).includes(row.value);
  if (row.group === 'realm') {
    const mine = REALM_ORDER.get(peakRealmGroup(acc));
    const need = REALM_ORDER.get(row.value);
    if (mine == null || need == null) return false;
    return mine >= need;
  }
  if (row.group === 'egg') return firedOf(acc).includes(row.value);
  return false;
}

/** 这张脸现在能不能用（给 set 用：未知 key / 未解锁分开报错） */
function has(key) {
  return BY_KEY.has(key);
}

/**
 * 账户当下的脸：`{ key, name, chosen }`。**没有「无脸」状态**——
 * 没选过就派一张，读到未知 key（目录下架）也回落派生脸，绝不裂图。
 */
function of(acc) {
  if (!acc) return null;
  if (acc.isNPC) {
    const key = derive(acc.name);
    const row = BY_KEY.get(key);
    return key ? { key, name: row ? row.name : '', chosen: false, npc: true } : null;
  }
  const picked = acc.avatar && BY_KEY.has(acc.avatar) ? acc.avatar : null;
  const key = picked || derive(acc.name);
  if (!key) return null;
  const row = BY_KEY.get(key);
  return { key, name: row ? row.name : '', chosen: !!picked, npc: false };
}

/** 榜单 / 股东榜只要 key（一帧 20 行 × 一个对象是纯浪费） */
function brief(acc) {
  const v = of(acc);
  return v ? v.key : null;
}

/** 账户已解锁的 key 列表（`stateOf` 的第二项；换脸弹层用它标「可换」） */
function unlockedKeys(acc) {
  const out = [];
  for (const row of CATALOG) {
    if (!groupEnabled(row.group)) continue;
    if (isUnlocked(acc, row)) out.push(row.key);
  }
  return out;
}

/** 换脸弹层要的三件套：当前脸 / 是否主动选过 / 已解锁列表 */
function stateOf(acc) {
  const cur = of(acc);
  return {
    key: cur ? cur.key : null,
    name: cur ? cur.name : '',
    chosen: cur ? cur.chosen : false,
    unlocked: acc ? unlockedKeys(acc) : [],
  };
}

/** 解锁条件的人话（服务端唯一一份，前端只渲染它） */
function unlockText(row) {
  if (row.group === 'base') return '';
  if (row.group === 'broker') {
    const b = ((config.brokers || {}).list || {})[row.value];
    return `转户到${b ? b.name : row.value}后解锁`;
  }
  if (row.group === 'realm') {
    const g = REALM_GROUPS.find((x) => x.key === row.value);
    return `历史最高境界到过${g ? g.name : row.value}后解锁`;
  }
  if (row.group === 'egg') return '触发过对应彩蛋后解锁';
  return '';
}

/**
 * `rules.avatars`：整组 33 行只在首屏 /api/state 与 SSE 首帧下发（lite 帧只留 enabled）。
 * 形状与 `rules.realm` 同款，客户端弹层零写死。
 */
function catalogForClient() {
  const groups = GROUPS.filter((g) => groupEnabled(g.id)).map((g) => ({
    id: g.id,
    label: g.label,
    hint: g.hint || '',
    rows: CATALOG.filter((r) => r.group === g.id).map((r) => ({
      key: r.key,
      name: r.name,
      unlock: { type: r.group, value: r.value || null, text: unlockText(r) },
    })),
  }));
  return { enabled: !!CFG.enabled && !!BASE.length, groups };
}

/**
 * 换脸。
 * @returns {{ok:boolean, error?:string, status?:number, unlock?:object, avatar?:object, unchanged?:boolean}}
 *   `status` 只给 http 层用：400 参数/不存在、403 未解锁、200 正常（与方案 §6.1 的表对齐）
 */
function set(acc, key) {
  if (!acc) return { ok: false, status: 401, error: '请先登录' };
  if (!CFG.enabled) return { ok: false, status: 503, error: '头像功能已关闭' };
  if (typeof key !== 'string' || !key.trim()) return { ok: false, status: 400, error: '头像参数不合法' };
  const k = key.trim();
  const row = BY_KEY.get(k);
  if (!row) return { ok: false, status: 400, error: '没有这张脸' };
  if (!groupEnabled(row.group)) return { ok: false, status: 400, error: '这个分组还没开放' };
  if (!isUnlocked(acc, row)) {
    return {
      ok: false,
      status: 403,
      error: '这张脸还不属于你',
      unlock: { type: row.group, value: row.value || null, text: unlockText(row) },
    };
  }
  // 与当前相同：200 直接回，**不写库、不 touch**（玩家点自己那张脸不该产生一次落盘）
  if (acc.avatar === k) return { ok: true, unchanged: true, avatar: of(acc) };
  acc.avatar = k;
  return { ok: true, avatar: of(acc) };
}

module.exports = {
  CATALOG,
  GROUPS,
  BASE,
  KEY_RE,
  has,
  derive,
  markBrokerSeen,
  brokerSeenOf,
  isUnlocked,
  unlockedKeys,
  of,
  brief,
  stateOf,
  catalogForClient,
  unlockText,
  set,
};
