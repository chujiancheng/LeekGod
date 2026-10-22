/**
 * 开放交易接口 v1（`/open/v1/*`）—— 玩家自带的量化模型从这里读写。
 *
 * ═══ 三条设计红线 ═══
 *
 * ① **鉴权独立于 H5**。`/api/*` 认的是免密登录签发的会话令牌（`POST /api/login` 只要
 *    账号名就发），把它交给程序化接口等于「知道谁叫啥就能下谁的蛋」。所以这里另立
 *    API Key：`gs_<id>_<secret>`，库里只存 secret 的 sha256，签发时明文只出现一次，
 *    可以单独撤销、单独设来源白名单、单独限额。Key **不能**当会话令牌用，会话令牌
 *    **也不能**当 Key 用——两条鉴权链路互不认对方的凭据。
 *
 * ② **下单没有后门**。`POST /open/v1/orders` 最终调 `game.placeOrderFor(acc, body)`，
 *    与手动下单同一个入口：冷却、锁仓、费率、保证金、同股多空互斥、价格笼子、涨跌停、
 *    阶段门控，一条都不绕过。这个文件里**不做任何交易规则判定**，只做鉴权、限流、幂等、
 *    参数整形。规则一旦在这里复制一份，改配置那天它就会静默变成一套假规则。
 *
 * ③ **内幕字段不出圈**。行情只给「H5 也能看到的那些」：最新价/五档/逐笔/内外盘/融券池。
 *    `fairValue` / `fund` / `regime` / 力量天平 `force` / NPC 战术意图 / LLM 计划
 *    一律不出现——它们是做市引擎的底牌，泄露等于把牌桌掀了。行情快照直接复用
 *    `Market.snapshot()`（H5 的同一份），不另写一套"更全"的版本。
 *
 * ═══ 为什么有幂等 ═══
 * 网络超时、脚本重连、进程被 OOM 杀掉都会让「已经下出去的单」被重发一次。手点时代价是
 * 一单，程序化时代价是循环放大。所以下单**强烈建议**带 `clientOrderId`（可选但生产必带），
 * 同一个 Key 下同 id 在窗口内只成交一次；同 id 换了参数则视为写错、直接拒绝，不静默回放。
 * **只缓存成功结果**：冷却被拒、资金不足这类失败必须能被重试，缓存失败会让策略在
 * 10 分钟里一直读到那条旧错误、以为市场坏了。
 */
const crypto = require('crypto');
const config = require('./config');
const broker = require('./broker');
const { SseBackpressure } = require('./sseback');
const { logger } = require('./logger');

const PREFIX = '/open/v1';
const KEY_PREFIX = 'gs';
const OPEN_CORS = {
  // Key 走请求头、不依赖 cookie，所以 `*` 不会带来 CSRF/凭据泄露问题；
  // 玩家在浏览器里调试策略（fetch 直连）也要能用，因此不按 Origin 卡。
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
  'Access-Control-Max-Age': '600',
};
const OPEN_HEADERS = Object.assign(
  {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  },
  OPEN_CORS
);

// 这里的 send/readJson 是 http.js 同名逻辑的精简副本。刻意不 require('./http')：
// http.js 要 require 本文件来挂路由，反向依赖会成环。两边都只依赖 node 原生模块。
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, OPEN_HEADERS));
  res.end(body);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const e = new Error('请求体过大');
        e.statusCode = 413;
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        const err = new Error('请求体不是合法 JSON');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const nowMs = () => Date.now();
const clampInt = (v, min, max, dflt) => {
  // 注意 `Number(null) === 0`：参数缺省时必须走默认值，否则默认 depth 会变 0（盘口全没了）
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
};

/** 按 key 的滑窗限流（与 http.js 的 RateLimiter 同口径，独立实例、独立计数） */
class SlidingWindow {
  constructor({ limit, windowMs, maxKeys = 8192 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  allow(key) {
    const now = nowMs();
    if (this.hits.size >= this.maxKeys) {
      this.sweep(now);
      if (this.hits.size >= this.maxKeys) this.hits.clear();
    }
    let arr = this.hits.get(key);
    if (!arr) {
      arr = [];
      this.hits.set(key, arr);
    }
    while (arr.length && now - arr[0] >= this.windowMs) arr.shift();
    if (arr.length >= this.limit) return false;
    arr.push(now);
    return true;
  }

  sweep(now) {
    for (const [k, arr] of this.hits) {
      while (arr.length && now - arr[0] >= this.windowMs) arr.shift();
      if (!arr.length) this.hits.delete(k);
    }
  }
}

/**
 * API Key 仓库：内存索引 + SQLite 权威副本。
 *
 * 签发/撤销是**低频**操作，直接同步写库（每秒几百次的下单走的是主循环那套 tick 事务，
 * 两者互不干扰）。`last_used_at` 按 60 秒节流回写，否则每次轮询都写库会把 WAL 撑起来——
 * 它只用于「这把 Key 还用不用」的运维判断，精度到分钟足够。
 */
class ApiKeys {
  constructor(db) {
    this.db = db || null;
    this.byId = new Map();
    if (this.db) {
      this.st = {
        all: this.db.prepare('SELECT * FROM api_keys WHERE revoked_at IS NULL'),
        byAccount: this.db.prepare('SELECT * FROM api_keys WHERE account = ? ORDER BY created_at DESC'),
        ins: this.db.prepare(`
          INSERT INTO api_keys (id, account, secret_hash, label, scopes, ip_allow, created_at)
          VALUES (@id, @account, @secret_hash, @label, @scopes, @ip_allow, @created_at)
        `),
        revoke: this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
        touch: this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?'),
        count: this.db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE account = ? AND revoked_at IS NULL'),
      };
    }
    this.reload();
  }

  reload() {
    this.byId.clear();
    if (!this.st) return 0;
    for (const row of this.st.all.all()) this.byId.set(row.id, row);
    return this.byId.size;
  }

  countFor(account) {
    return this.st ? this.st.count.get(account).n : [...this.byId.values()].filter((r) => r.account === account).length;
  }

  /** 签发：明文 key 只在这里出现一次，调用方必须当场显示给用户 */
  issue(account, opts = {}) {
    const id = crypto.randomBytes(4).toString('hex');
    const secret = crypto.randomBytes(24).toString('base64url');
    const scopes = normalizeScopes(opts.scopes);
    if (!scopes) return { ok: false, error: 'scopes 只能是 read / trade 的组合（或 *）' };
    const rec = {
      id,
      account,
      secret_hash: sha256(secret),
      label: String(opts.label || '').slice(0, 40) || null,
      scopes,
      ip_allow: normalizeIpAllow(opts.ipAllow),
      created_at: nowMs(),
      last_used_at: null,
      revoked_at: null,
    };
    if (this.st) {
      this.st.ins.run(rec);
    }
    this.byId.set(id, rec);
    return { ok: true, id, key: `${KEY_PREFIX}_${id}_${secret}`, account, scopes, label: rec.label };
  }

  revoke(id) {
    const rec = this.byId.get(id);
    if (!rec) return { ok: false, error: '未找到该 Key（或已撤销）' };
    if (this.st) this.st.revoke.run(nowMs(), id);
    this.byId.delete(id);
    // 已建立的 SSE 也要掐掉：只删鉴权索引的话，那条 /stream 连接会继续推行情，
    // 等于撤销后市场数据还在往外漏（下单会被挡住，行情不会）。
    if (this.onRevoked) {
      try {
        this.onRevoked(id);
      } catch (e) {
        logger.warn(`[我是股神] Key 撤销后断开推送失败 ${id}: ${e.message}`);
      }
    }
    return { ok: true, id, account: rec.account };
  }

  list(account) {
    const rows = this.st && account ? this.st.byAccount.all(account) : [...this.byId.values()];
    return rows
      .filter((r) => !account || r.account === account)
      .map((r) => ({
        id: r.id,
        account: r.account,
        label: r.label,
        scopes: r.scopes,
        ipAllow: r.ip_allow,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        revoked: !!r.revoked_at,
      }));
  }

  /**
   * 校验。返回 `{ok, rec}` 或 `{ok:false, code, error}`。
   * secret 与库里的哈希做定时比较（长度相同才比），避免按字节探测。
   */
  verify(raw, ip) {
    const s = String(raw || '').trim();
    if (!s) return { ok: false, code: 401, error: '缺少 API Key（请求头 X-API-Key 或 Authorization: Bearer）' };
    const m = new RegExp(`^${KEY_PREFIX}_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$`).exec(s);
    if (!m) return { ok: false, code: 401, error: 'API Key 格式不正确' };
    const rec = this.byId.get(m[1]);
    if (!rec) return { ok: false, code: 401, error: 'API Key 无效或已撤销' };
    const a = Buffer.from(sha256(m[2]), 'hex');
    const b = Buffer.from(String(rec.secret_hash), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, code: 401, error: 'API Key 无效或已撤销' };
    }
    if (rec.ip_allow && !ipAllowed(rec.ip_allow, ip)) {
      return { ok: false, code: 403, error: `该 Key 只允许从 ${rec.ip_allow} 调用` };
    }
    // last_used_at 节流回写（见类注释）
    const t = nowMs();
    if (this.st && (!rec.last_used_at || t - rec.last_used_at > 60000)) {
      rec.last_used_at = t;
      try {
        this.st.touch.run(t, rec.id);
      } catch (e) {
        logger.warn(`[我是股神] API Key 使用时间回写失败: ${e.message}`);
      }
    }
    return { ok: true, rec };
  }
}

function normalizeScopes(raw) {
  const parts = String(raw == null ? 'read,trade' : raw)
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes('*')) return 'read,trade';
  const out = [];
  for (const p of parts) {
    if (p !== 'read' && p !== 'trade') return null;
    if (!out.includes(p)) out.push(p);
  }
  if (!out.length) return null;
  return out.join(',');
}

/** 来源白名单：`1.2.3.4` 精确匹配，或以 `.` 结尾的前缀（`192.168.1.` 覆盖整个网段） */
function normalizeIpAllow(raw) {
  if (raw == null || raw === '') return null;
  const list = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((x) => String(x).trim())
    .filter(Boolean);
  return list.length ? list.join(',') : null;
}

function ipAllowed(list, ip) {
  const v = String(ip || '').replace(/^::ffff:/, '');
  return String(list)
    .split(',')
    .some((p) => (p.endsWith('.') ? v.startsWith(p) : v === p));
}

/** 下单幂等缓存（只缓存成功，见文件头注释）。条目带请求指纹，同 cid 换参数不回放 */
class IdemCache {
  constructor({ ttlMs, max }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }

  get(k) {
    const v = this.map.get(k);
    if (!v) return null;
    if (nowMs() - v.at > this.ttlMs) {
      this.map.delete(k);
      return null;
    }
    return v;
  }

  set(k, res, fp) {
    if (this.map.size >= this.max) {
      // 简单的 FIFO 淘汰：Map 保插入顺序，删最早的
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
    this.map.set(k, { at: nowMs(), res, fp });
  }
}

/** 幂等指纹：字段顺序固定，与调用方传给 placeOrderFor 的语义一一对应 */
function orderFingerprint(body) {
  return JSON.stringify({
    stockId: String(body.stockId),
    action: body.action == null ? '' : String(body.action),
    qty: body.qty,
    price: body.price,
    finance: body.finance === true,
  });
}

/** 把查询参数规范化成行情视图选项（SSE 每条连接在建立时算一次，之后每帧复用） */
function marketOpts(q) {
  return {
    depthN: clampInt(q.get('depth'), 0, config.open.maxDepth, config.open.maxDepth),
    tradeN: clampInt(q.get('trades'), 0, config.open.maxTrades, config.open.maxTrades),
    withSeats: q.get('seats') === '1',
  };
}

/** 行情视图：只保留 H5 同款字段，按需裁剪 */
function marketsViewFrom(snaps, opt) {
  const { depthN, tradeN, withSeats } = opt || marketOpts(new URLSearchParams());
  const out = [];
  for (const s of snaps) {
    const m = {
      stockId: s.stockId,
      name: s.name,
      last: s.last,
      prevClose: s.prevClose,
      open: s.open,
      high: s.high,
      low: s.low,
      change: s.change,
      changePct: s.changePct,
      volume: s.volume,
      turnover: s.turnover,
      lotSize: s.lotSize,
      band: s.band,
      auction: s.auction,
      flow: s.flow,
      lending: s.lending,
      depth: depthN
        ? {
            bids: (s.depth.bids || []).slice(0, depthN),
            asks: (s.depth.asks || []).slice(0, depthN),
          }
        : null,
      trades: tradeN ? s.trades.slice(0, tradeN) : null,
    };
    // 席位榜默认不下发：策略用不上，10 只股票各一份会让每帧体积翻倍
    if (withSeats) m.seats = s.seats;
    out.push(m);
  }
  return out;
}

/** 单次请求的便捷入口：自己抓一份快照 */
function marketsView(game, opt) {
  return marketsViewFrom(game.marketSnapshots(), opt);
}

function indexView(game) {
  const s = game.index.snapshot();
  return {
    stockId: s.stockId,
    name: s.name,
    last: s.last,
    prevClose: s.prevClose,
    change: s.change,
    changePct: s.changePct,
    volume: s.volume,
    turnover: s.turnover,
  };
}

/** 该账户的有效规则（券商覆盖后的值，与 H5「游戏规则」面板同源） */
function rulesView(game, acc) {
  const now = nowMs();
  const bk = acc ? game.brokerOf(acc, now) : broker.forAccount(null, { day: 0 });
  return {
    feeRate: bk.feeRate,
    cooldownMs: bk.cooldownMs,
    lockMs: bk.lockMs,
    marginRatio: bk.marginRatio,
    maintenance: bk.maintenance,
    financeRatio: bk.financeRatio,
    allowNakedShort: !!config.margin.allowNakedShort,
    finance: {
      enabled: !!(config.margin.finance && config.margin.finance.enabled),
      baseMinuteRate: config.margin.finance ? config.margin.finance.baseMinuteRate : 0,
      maxMinuteRate: config.margin.finance ? config.margin.finance.maxMinuteRate : 0,
    },
    lending: {
      enabled: !!(config.margin.lending && config.margin.lending.enabled),
      // 做空利息按游戏日结算（每个交易日收盘收一次），下发给策略的是日息
      baseDailyRate: config.margin.lending ? config.margin.lending.baseDailyRate : 0,
      maxDailyRate: config.margin.lending ? config.margin.lending.maxDailyRate : 0,
    },
    // 涨跌停幅度给**百分数**（30 = ±30%），与 config 里的小数 0.3 区分开：
    // 策略作者写 `if (pct > 29.5)` 时不该还要猜单位
    priceLimit: game.day.ok
      ? {
          enabled: !!(config.priceLimit && config.priceLimit.enabled),
          pct: config.priceLimit ? Math.round(config.priceLimit.pct * 100) : 0,
        }
      : { enabled: false, pct: 0 },
    actions: ['buy_open', 'sell_close', 'sell_open', 'buy_close'],
    orderTypes: ['limit'],
  };
}

function createOpenApi(game) {
  const cfg = config.open;
  const db = game.persist && game.persist.db ? game.persist.db : null;
  const keys = new ApiKeys(db);
  if (!db) {
    logger.warn('[我是股神] 持久化已关闭，开放接口的 API Key 只存在内存里，重启即失效');
  }

  const rl = cfg.rateLimit;
  const limiters = {
    read: new SlidingWindow(rl.read),
    trade: new SlidingWindow(rl.trade),
    ip: new SlidingWindow(rl.ip),
  };
  const idem = new IdemCache(cfg.idempotency);

  // ---- SSE：只推行情与交易日时钟，**不推账户段** ----
  // 账户变化走 GET /open/v1/account：策略一次决策读一次就够，每 tick 推一遍只会
  // 让 100 条连接各自拼一份 JSON（H5 那么做是因为要实时刷新界面）。
  const streams = new Set();
  const streamByKey = new Map();
  // 写背压闸门与 H5 的 SseHub 共用一套门槛（见 src/sseback.js）：
  // 策略脚本挂死/断网时连接不会 close，每 tick 的行情帧会无限堆在写队列里。
  const streamBack = new SseBackpressure(config.http.sse, (c, why, buffered) => {
    dropStream(c);
    try {
      if (c.res.socket) c.res.socket.destroy();
      else c.res.destroy();
    } catch (e) {
      /* 已断 */
    }
    logger.warn(
      `[我是股神] 断开积压的开放接口行情流（${why}，队列 ${(buffered / 1048576).toFixed(1)}MB）：key=${c.keyId}`
    );
  });
  game.onTick(() => {
    if (!streams.size) return;
    // 行情快照每 tick 只算一次，各连接按自己的 depth/trades 裁剪
    const snaps = game.marketSnapshots();
    const day = game.day.snapshot();
    const index = indexView(game);
    for (const c of [...streams]) {
      if (!streamBack.check(c, nowMs())) continue;
      const frame = {
        seq: game.tickCount,
        t: nowMs(),
        day,
        index,
        markets: marketsViewFrom(snaps, c.opt),
      };
      try {
        c.res.write(`event: tick\ndata: ${JSON.stringify(frame)}\n\n`);
      } catch (e) {
        dropStream(c);
      }
    }
  });
  const heartbeat = setInterval(() => {
    for (const c of [...streams]) {
      if (!streamBack.check(c, nowMs())) continue;
      try {
        c.res.write(': ping\n\n');
      } catch (e) {
        dropStream(c);
      }
    }
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  function dropStream(c) {
    if (!streams.delete(c)) return;
    const n = (streamByKey.get(c.keyId) || 0) - 1;
    if (n > 0) streamByKey.set(c.keyId, n);
    else streamByKey.delete(c.keyId);
  }

  // 撤销 Key 时掐掉它的全部 SSE：见 ApiKeys.revoke 的注释。
  // SSE 连接上仅 res.end() 有时不会让客户端立刻看到 close，这里直接拆 socket。
  keys.onRevoked = (id) => {
    for (const c of [...streams]) {
      if (c.keyId !== id) continue;
      try {
        if (c.res.socket) c.res.socket.destroy();
        else c.res.destroy();
      } catch (e) {
        /* socket 已断也算掐掉 */
      }
      dropStream(c);
    }
  };

  /** 鉴权 + 限流 + scope 的公共前置；返回 rec 或 null（已写回响应） */
  function gate(req, res, ip, scope) {
    const raw =
      req.headers['x-api-key'] ||
      (/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim()) || [])[1] ||
      '';
    const v = keys.verify(raw, ip);
    if (!v.ok) {
      send(res, v.code, { ok: false, error: v.error, code: v.code === 401 ? 'unauthorized' : 'forbidden' });
      return null;
    }
    const rec = v.rec;
    if (scope && !String(rec.scopes).split(',').includes(scope)) {
      send(res, 403, { ok: false, error: `该 Key 没有 ${scope} 权限`, code: 'forbidden' });
      return null;
    }
    return rec;
  }

  function limited(res, limiter, key) {
    if (!rl.enabled || limiter.allow(key)) return false;
    send(res, 429, { ok: false, error: '请求过于频繁，请降低轮询频率或加长间隔', code: 'rate_limited' });
    return true;
  }

  async function handle(req, res, url, pathname) {
    if (!cfg.enabled) {
      return send(res, 503, { ok: false, error: '开放接口未启用（config.open.enabled = false）', code: 'disabled' });
    }
    // CORS 预检：浏览器里的策略脚本会先发这个，不需要鉴权
    if (req.method === 'OPTIONS') {
      res.writeHead(204, OPEN_CORS);
      return res.end();
    }
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    // IP 兜底限流放在鉴权之前：拿假 Key 刷也能被挡住
    if (limited(res, limiters.ip, ip)) return;

    const seg = pathname.slice(PREFIX.length).split('/').filter(Boolean);
    const q = url.searchParams;

    // ---- 免鉴权的存活探针：只回版本与服务器时间，不碰任何账户数据 ----
    if (seg.length === 1 && seg[0] === 'health' && req.method === 'GET') {
      return send(res, 200, { ok: true, version: 'v1', serverTime: nowMs() });
    }

    // ---- 以下全部需要 Key ----
    const isTrade = seg[0] === 'orders' && (req.method === 'POST' || req.method === 'DELETE');
    const rec = gate(req, res, ip, isTrade ? 'trade' : 'read');
    if (!rec) return;
    if (limited(res, isTrade ? limiters.trade : limiters.read, rec.id)) return;
    const acc = game.store.get(rec.account);
    if (!acc || acc.isNPC) {
      return send(res, 401, { ok: false, error: '该 Key 绑定的账户不存在', code: 'unauthorized' });
    }

    // ---- GET /open/v1 ：能力目录（人肉调接口时的第一站）----
    if (!seg.length && req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        version: 'v1',
        account: acc.name,
        endpoints: [
          'GET  /open/v1/health',
          'GET  /open/v1/ping',
          'GET  /open/v1/meta',
          'GET  /open/v1/markets?depth=5&trades=30&seats=0',
          'GET  /open/v1/markets/:stockId/bars?limit=120',
          'GET  /open/v1/markets/:stockId/minute',
          'GET  /open/v1/markets/:stockId/holders',
          'GET  /open/v1/account',
          'GET  /open/v1/orders?status=live|all&since=',
          'GET  /open/v1/fills?since=&limit=50',
          'POST /open/v1/orders',
          'DELETE /open/v1/orders/:orderId',
          'GET  /open/v1/stream?depth=1&trades=0',
        ],
      });
    }

    // ---- GET /open/v1/ping：鉴权自检 + 当前 tick 与冷却 ----
    if (seg.length === 1 && seg[0] === 'ping' && req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        account: acc.name,
        nick: acc.nick || acc.name,
        keyId: rec.id,
        scopes: rec.scopes,
        seq: game.tickCount,
        serverTime: nowMs(),
        cooldownLeftMs: game.cooldownLeft(acc, nowMs()),
      });
    }

    // ---- GET /open/v1/meta：标的清单 + 本账户的有效规则 ----
    if (seg.length === 1 && seg[0] === 'meta' && req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        version: 'v1',
        seq: game.tickCount,
        serverTime: nowMs(),
        day: game.day.snapshot(),
        stocks: game.stocks.map((s) => ({ id: s.id, name: s.name, lotSize: s.lotSize })),
        index: { stockId: game.index.stockId, name: game.index.stock.name },
        rules: rulesView(game, acc),
        tickIntervalMs: config.tickIntervalMs,
      });
    }

    // ---- GET /open/v1/markets：全市场快照（10 只 + 指数）----
    if (seg.length === 1 && seg[0] === 'markets' && req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        seq: game.tickCount,
        serverTime: nowMs(),
        day: game.day.snapshot(),
        index: indexView(game),
        markets: marketsView(game, marketOpts(q)),
      });
    }

    // ---- GET /open/v1/markets/:id/bars：已收盘日线 ----
    if (seg.length === 3 && seg[0] === 'markets' && seg[2] === 'bars' && req.method === 'GET') {
      const r = game.dailyFor(seg[1], clampInt(q.get('limit'), 1, 260, 120));
      return send(res, r.ok ? 200 : 400, r);
    }

    // ---- GET /open/v1/markets/:id/minute：分时序列（跨天连续，保留约 2 小时）----
    if (seg.length === 3 && seg[0] === 'markets' && seg[2] === 'minute' && req.method === 'GET') {
      const r = game.historyFor(seg[1]);
      return send(res, r.ok ? 200 : 400, r);
    }

    // ---- GET /open/v1/markets/:id/holders：筹码概览（多头合计/流通盘/未平空；不是前十大名单）----
    if (seg.length === 3 && seg[0] === 'markets' && seg[2] === 'holders' && req.method === 'GET') {
      const r = game.holdersSummary(seg[1]);
      if (!r) return send(res, 400, { ok: false, error: '未知股票', code: 'bad_request' });
      return send(res, 200, { ok: true, ...r });
    }

    // ---- GET /open/v1/account：账户快照 ----
    if (seg.length === 1 && seg[0] === 'account' && req.method === 'GET') {
      const now = nowMs();
      const view = game.serializeAccount(acc, now);
      return send(res, 200, {
        ok: true,
        seq: game.tickCount,
        serverTime: now,
        cooldownLeftMs: game.cooldownLeft(acc, now),
        broker: acc.broker,
        marginCall: game.marginCallFor(acc, now),
        ...view,
        rules: rulesView(game, acc),
      });
    }

    // ---- GET /open/v1/orders：在途委托 / 全部委托 ----
    if (seg.length === 1 && seg[0] === 'orders' && req.method === 'GET') {
      const now = nowMs();
      const status = q.get('status') === 'all' ? 'all' : 'live';
      const since = Number(q.get('since')) || 0;
      const limit = clampInt(q.get('limit'), 1, 200, 100);
      let rows;
      if (status === 'live') {
        rows = [...acc.orders.values()].map((o) => game.serializeOrder(o, now));
      } else {
        // 在途在前、已完结在后，按时间倒序；客户端拿 orderId 去重即可
        const live = [...acc.orders.values()].map((o) => game.serializeOrder(o, now));
        const done = acc.orderHistory.map((o) => game.serializeOrder(o, now));
        rows = live.concat(done);
      }
      if (since) rows = rows.filter((o) => (o.ts || 0) >= since);
      rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return send(res, 200, { ok: true, seq: game.tickCount, serverTime: now, orders: rows.slice(0, limit) });
    }

    // ---- POST /open/v1/orders：下单（幂等）----
    if (seg.length === 1 && seg[0] === 'orders' && req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, e.statusCode || 400, { ok: false, error: e.message, code: 'bad_request' });
      }
      const cid = body && body.clientOrderId != null ? String(body.clientOrderId) : '';
      if (cid && !/^[A-Za-z0-9._:-]{1,64}$/.test(cid)) {
        return send(res, 400, {
          ok: false,
          error: 'clientOrderId 只能包含字母/数字/._:-，长度 1~64',
          code: 'bad_request',
        });
      }
      const idemKey = cid ? `${rec.id}:${cid}` : '';
      // 缺 stockId 时 Game.placeOrderFor 会**默认第一只股票**（H5 的历史行为），
      // 对脚本来说这是一个静默下错标的的陷阱：宁可 400 也不猜。
      // 这道门必须在幂等回放**之前**：否则同 cid 不带 stockId 也会被当成重试回放。
      if (body.stockId == null || String(body.stockId).trim() === '') {
        return send(res, 400, { ok: false, error: '缺少 stockId（股票代码，见 GET /open/v1/meta）', code: 'bad_request' });
      }
      const fp = orderFingerprint(body);
      if (idemKey) {
        const hit = idem.get(idemKey);
        // 回放时冷却按**现在**算：首次响应里的剩余毫秒早过期了，照抄会误导策略多睡一会儿
        if (hit) {
          if (hit.fp !== fp) {
            // 同 cid 换了参数：多半是 id 生成器写错了。静默回放会把策略骗到以为新单已下。
            return send(res, 409, {
              ok: false,
              error: 'clientOrderId 已被本窗口内的另一笔下单占用（参数不一致），请换一个 id',
              code: 'idempotency_conflict',
            });
          }
          return send(res, 200, {
            ...hit.res,
            cooldownLeftMs: game.cooldownLeft(acc, nowMs()),
            serverTime: nowMs(),
            replayed: true,
          });
        }
      }
      const now = nowMs();
      const r = game.placeOrderFor(acc, {
        stockId: body.stockId,
        action: body.action,
        qty: body.qty,
        price: body.price,
        finance: body.finance,
      });
      if (r.ok) {
        // 显式挑字段而不是整个透传：`cooldownLeft` 是 H5 的旧字段名，开放接口只留
        // `cooldownLeftMs`，免得策略作者在两个同义字段之间猜哪个才是权威
        const payload = {
          ok: true,
          order: r.order,
          cooldownLeftMs: game.cooldownLeft(acc, nowMs()),
          seq: game.tickCount,
          serverTime: now,
        };
        if (idemKey) idem.set(idemKey, payload, fp);
        logger.info(
          `[我是股神][open] ${rec.id} ${acc.name} ${body.action} ${body.stockId} ` +
            `${body.qty}@${body.price} → ${r.order.id}`
        );
        return send(res, 200, payload);
      }
      logger.info(
        `[我是股神][open] ${rec.id} ${acc.name} ${body.action || '?'} ${body.stockId || '?'} 被拒：${r.error}`
      );
      return send(res, 400, { ok: false, code: 'rejected', error: r.error, detail: r });
    }

    // ---- DELETE /open/v1/orders/:id：撤单 ----
    if (seg.length === 2 && seg[0] === 'orders' && req.method === 'DELETE') {
      const r = game.cancelOrderFor(acc, seg[1]);
      if (r.ok) {
        logger.info(`[我是股神][open] ${rec.id} ${acc.name} 撤单 ${seg[1]}`);
        return send(res, 200, { ...r, seq: game.tickCount, serverTime: nowMs() });
      }
      return send(res, 400, { ok: false, code: 'rejected', error: r.error, detail: r });
    }

    // ---- GET /open/v1/fills：成交回报（可增量）----
    if (seg.length === 1 && seg[0] === 'fills' && req.method === 'GET') {
      const since = Number(q.get('since')) || 0;
      const limit = clampInt(q.get('limit'), 1, 100, 50);
      let rows = acc.tradeHistory.slice(0, limit);
      if (since) rows = rows.filter((t) => (t.seq || 0) > since);
      return send(res, 200, {
        ok: true,
        seq: game.tickCount,
        serverTime: nowMs(),
        // nextSince 是**成交序号**游标（不是时间戳）：同一 tick 内可能连出好几笔，
        // 用时间戳做游标会把同毫秒的成交整批漏掉
        nextSince: rows.reduce((a, t) => Math.max(a, t.seq || 0), since),
        fills: rows.map((t) => ({
          seq: t.seq || 0,
          id: t.id,
          orderId: t.orderId,
          stockId: t.stockId,
          action: t.action,
          side: t.side,
          price: t.price,
          qty: t.qty,
          t: t.t,
        })),
      });
    }

    // ---- GET /open/v1/stream：SSE 行情流 ----
    if (seg.length === 1 && seg[0] === 'stream' && req.method === 'GET') {
      if (streams.size >= cfg.maxStreams) {
        return send(res, 503, { ok: false, error: '推送连接数已达上限', code: 'unavailable' });
      }
      if ((streamByKey.get(rec.id) || 0) >= cfg.maxStreamsPerKey) {
        return send(res, 429, { ok: false, error: `单个 Key 最多 ${cfg.maxStreamsPerKey} 条推送连接`, code: 'rate_limited' });
      }
      res.writeHead(
        200,
        Object.assign({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' }, OPEN_HEADERS)
      );
      res.write('retry: 2000\n\n');
      const conn = { res, keyId: rec.id, opt: marketOpts(q) };
      streams.add(conn);
      streamByKey.set(rec.id, (streamByKey.get(rec.id) || 0) + 1);
      // 首帧立即给一份，脚本不用等到下一个 tick
      try {
        res.write(
          `event: tick\ndata: ${JSON.stringify({
            seq: game.tickCount,
            t: nowMs(),
            day: game.day.snapshot(),
            index: indexView(game),
            markets: marketsView(game, conn.opt),
          })}\n\n`
        );
      } catch (e) {
        dropStream(conn);
      }
      req.on('close', () => dropStream(conn));
      return;
    }

    return send(res, 404, { ok: false, error: '没有这个接口，见 GET /open/v1', code: 'not_found' });
  }

  return { handle, keys, PREFIX };
}

module.exports = { createOpenApi, ApiKeys, PREFIX };
