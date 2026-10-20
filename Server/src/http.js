/**
 * HTTP 服务：REST API + SSE 实时推送 + 静态资源
 *
 * 身份来源：登录后签发的会话令牌（Authorization: Bearer <token>）。
 * 请求体里的 name 不再作为身份依据。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const admin = require('./admin');
const openapi = require('./openapi');
const milestones = require('./milestones');
const { logger } = require('./logger');

const CLIENT_DIR = path.join(__dirname, '..', '..', 'Client');
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/lore.js': { file: 'lore.js', type: 'application/javascript; charset=utf-8' },
  // AI 主力观测页：仅白名单账号（写死 chu）能拉 /api/whales
  '/whales.html': { file: 'whales.html', type: 'text/html; charset=utf-8' },
  '/whales.js': { file: 'whales.js', type: 'application/javascript; charset=utf-8' },
  '/whales.css': { file: 'whales.css', type: 'text/css; charset=utf-8' },
  // 开放平台：玩家自助签发 / 查看 / 撤销 API Key（/api/open/keys 需要会话令牌）
  '/portal.html': { file: 'portal.html', type: 'text/html; charset=utf-8' },
  '/portal.js': { file: 'portal.js', type: 'application/javascript; charset=utf-8' },
  '/portal.css': { file: 'portal.css', type: 'text/css; charset=utf-8' },
  // 开放平台文档阅读页（?doc=player|api 在 docs.js 里取对应 .md）
  '/docs.html': { file: 'docs.html', type: 'text/html; charset=utf-8' },
  '/docs.js': { file: 'docs.js', type: 'application/javascript; charset=utf-8' },
  '/docs.css': { file: 'docs.css', type: 'text/css; charset=utf-8' },
};

/**
 * 文档白名单：只放玩家会用到的两份，从仓库根 Doc/ 直接读。
 * `?download=1` 走 Content-Disposition 附件下载；不带则以 text/markdown 直出
 * （浏览器里能看，阅读页 /docs.html 会 fetch 后再渲染）。
 * 路径与文件名都写死，不接受用户输入拼路径。
 */
const DOC_DIR = path.join(__dirname, '..', '..', 'Doc');
const DOC_FILES = {
  '/docs/player-apikey.md': {
    src: path.join(DOC_DIR, '玩家申请APIKey.md'),
    downloadName: 'gushen-apikey-guide.md',
  },
  '/docs/openapi.md': {
    src: path.join(DOC_DIR, '开放平台API.md'),
    downloadName: 'gushen-openapi-v1.md',
  },
};

/**
 * 图片资源白名单，两类：
 * ① 券商图标 `/img/broker-<key>.png`（1024 原图，登录卡片墙 / 我的券商卡用）与
 *    `/img/broker-<key>-96.png`（96px 缩略图，五档 / 逐笔 / 排行榜这些高频小位置用——
 *    原图 262KB~990KB，十档盘口每帧都要画几十个 12px 图标，用原图是纯浪费）；
 * ② 股神猫头像 `/img/egg-cat-<key>-96.png`（彩蛋演出用，**只有** 96px——横幅里显示
 *    32~40px，原图 850KB 是纯浪费）。
 * ③ 主题吉祥物立绘 `/img/mascot-<key>.png`（1024 原图，留给以后的大图位）、
 *    `-256`（主页 hero 高 120px，2 倍屏 240px 够用）与 `-96`（选择卡 + 彩蛋横幅头像）。
 * ④ 开户四宫格漫画 `/img/comic-<set><n>.png`（4 套 × 4 格，512px；开户弹层逐格展示）。
 *
 * **按 key 白名单生成，不做目录直出**：静态服务一律白名单，路径既不能拼用户输入、
 * 也不能走出指定目录（避免 `../` 穿越）。图标文件缺失时不注册，请求落到 404，
 * 前端只会看到空图标而不会报错。
 *
 * ⚠️ **新增图片资源必须在这里登记**：漏登记不会报错、只会 404，前端表现是**裂图**。
 * 吉祥物阵容（id / 名称 / 文案）在前端 `Client/app.js` 的 `MASCOTS`，两处的 key 必须同名。
 */
const IMG_ASSETS = new Map();
function registerImg(name, size, type = 'image/png') {
  if (!fs.existsSync(path.join(CLIENT_DIR, 'img', name))) return;
  IMG_ASSETS.set(`/img/${name}`, { file: path.join('img', name), type, size });
}
for (const key of Object.keys((config.brokers && config.brokers.list) || {})) {
  registerImg(`broker-${key}.png`, 'lg');
  registerImg(`broker-${key}-96.png`, 'sm');
}
for (const key of milestones.MASCOT_KEYS) registerImg(`egg-cat-${key}-96.png`, 'sm');
// 主题吉祥物：key 与前端 app.js 的 MASCOTS 对齐（不含 'cat'——股神猫没有主页立绘，
// 只用上面那批 egg-cat 头像）
for (const key of ['sakura', 'magic', 'maodiao', 'orange', 'doro', 'duck', 'knight', 'kanpan', 'whale']) {
  registerImg(`mascot-${key}.png`, 'lg');
  registerImg(`mascot-${key}-256.png`, 'md');
  registerImg(`mascot-${key}-96.png`, 'sm');
}
// 开户四宫格漫画：4 套（a/b/c/d）× 4 格。只有开户弹层一个场景用，512px 一档就够
// （每格最大约 250 CSS px，2 倍屏 500px）。文案/分镜见 Doc/开户四宫格漫画.md
for (const setKey of ['a', 'b', 'c', 'd']) {
  for (let i = 1; i <= 4; i += 1) registerImg(`comic-${setKey}${i}.png`, 'md');
}
// 上市公司档案立绘（股娘图鉴）：key 与 config.stocks 的股票 id 对齐，
// 前端档案数据在 Client/lore.js（COMPANY_LORE），弹层立绘 640px 一档
for (const s of config.stocks) registerImg(`company-${s.id}.png`, 'lg');
// 股娘全员合照海报：档案弹层底部「看全员合照」入口的竖版大图（1240×1754，492KB，单场景单文件）
registerImg('waifu-group-poster.png', 'lg');
// 公司徽记 logo：手绘 SVG（矢量、单文件 <2KB），档案卡 40px / 顶栏 24px / 切换栏 14px 三档复用
for (const s of config.stocks) registerImg(`company-logo-${s.id}.svg`, 'md', 'image/svg+xml');

// 安全响应头。CSP 不放开 unsafe-inline：前端不使用内联 style 属性与内联脚本。
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

const withSecurity = (headers) => Object.assign({}, SECURITY_HEADERS, headers);

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, withSecurity({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }));
  res.end(body);
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** 写接口要求 application/json（避免跨站表单/简单请求直达） */
function isJsonRequest(req) {
  return /^application\/json\b/i.test(String(req.headers['content-type'] || '').trim());
}

/**
 * 是否本机回环来源（运维关服这类不可逆操作的额外一道门槛）。
 * node 在不同栈下拿到的是 `127.0.0.1` / `::1` / `::ffff:127.0.0.1` 三种写法之一。
 */
function isLoopback(ip) {
  const s = String(ip || '');
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1' || s.startsWith('127.');
}

/** 带 Origin 的请求必须同源；同源的非浏览器请求不带 Origin */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (e) {
    return false;
  }
}

function bearerToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
  return m ? m[1] : '';
}

/** 按 key 的滑窗限流器 */
class RateLimiter {
  constructor({ limit, windowMs, maxKeys = 4096 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  allow(key) {
    const now = Date.now();
    if (this.hits.size >= this.maxKeys) {
      this.sweep(now);
      // 真实 key 太多时直接重置，避免限流器自身变成内存泄漏
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

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const fail = (statusCode, message) => {
      const e = new Error(message);
      e.statusCode = statusCode;
      e.publicMessage = message;
      reject(e);
      req.destroy();
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        fail(413, '请求体过大');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        const err = new Error('invalid json');
        err.statusCode = 400;
        err.publicMessage = '请求体不是合法 JSON';
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

class SseHub {
  constructor(game) {
    this.game = game;
    this.conns = new Set();
    this.byIp = new Map();
    this.cfg = config.http.sse;
    this.unsubscribe = game.onTick(() => this.broadcastAll());
    this.heartbeat = setInterval(() => {
      for (const c of this.conns) {
        try {
          c.res.write(': ping\n\n');
        } catch (e) {
          this.remove(c);
        }
      }
    }, 15000);
  }

  /** 还能否接受新连接；返回 null 表示允许 */
  rejectReason(ip) {
    if (this.conns.size >= this.cfg.maxConnections) return '服务器推送连接数已达上限';
    if ((this.byIp.get(ip) || 0) >= this.cfg.maxPerIp) return '同一客户端的推送连接数已达上限';
    return null;
  }

  add(conn) {
    this.conns.add(conn);
    this.byIp.set(conn.ip, (this.byIp.get(conn.ip) || 0) + 1);
  }

  remove(conn) {
    if (!this.conns.delete(conn)) return;
    const n = (this.byIp.get(conn.ip) || 0) - 1;
    if (n > 0) this.byIp.set(conn.ip, n);
    else this.byIp.delete(conn.ip);
  }

  send(conn, event, data) {
    try {
      conn.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      this.remove(conn);
    }
  }

  broadcastAll() {
    // 行情快照（10 只股票 + 指数）每条连接都一样，按 tick 只算一次；账户段仍按各自令牌单独拼。
    // 分时历史与股东榜都不进帧（体积太大），客户端按需拉 /api/history、/api/holders
    const markets = this.game.marketSnapshots();
    const index = this.game.index.snapshot();
    for (const conn of this.conns) {
      const state = this.game.stateFor(conn.token, { markets, index });
      this.send(conn, 'state', state);
    }
  }
}

/**
 * @param {Game} game
 * @param {object} [options] `onShutdown(reason)`：收到运维关服指令后执行的收尾函数
 *   （由 index.js 注入——http 层只管把请求转成一次「该关了」的通知，
 *   怎么关、关完退不退进程，属于入口层的职责）
 */
function createServer(game, options) {
  const opts = options || {};
  const hub = new SseHub(game);
  // 开放交易接口（/open/v1）：独立鉴权（API Key）、独立限流、独立 SSE。
  // 与下面的 /api/* 完全平行——两条链路不共享凭据，也不共享限流计数。
  const open = openapi.createOpenApi(game);
  if (config.open && config.open.enabled) {
    const n = open.keys.reload();
    logger.info(`[我是股神] 开放接口已启用：${openapi.PREFIX}（有效 Key ${n} 把）`);
  }
  const rl = config.http.rateLimit;
  const limiters = {
    login: new RateLimiter(rl.login),
    order: new RateLimiter(rl.order),
    deposit: new RateLimiter(rl.deposit),
    state: new RateLimiter(rl.state),
    write: new RateLimiter(rl.write),
    holders: new RateLimiter(rl.holders),
    daily: new RateLimiter(rl.daily),
    admin: new RateLimiter(rl.admin),
  };

  /** 写接口前置校验：同源 + JSON Content-Type + 限流 */
  const guardWrite = (req, res, ip, limiter) => {
    if (!sameOrigin(req)) {
      json(res, 403, { ok: false, error: '跨站请求被拒绝' });
      return false;
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { ok: false, error: 'Content-Type 必须为 application/json' });
      return false;
    }
    if (rl.enabled && !limiter.allow(ip)) {
      json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      return false;
    }
    return true;
  };

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      return json(res, 400, { ok: false, error: '非法请求' });
    }
    const p = url.pathname;
    const ip = clientIp(req);

    try {
      // ---- 开放交易接口：整段前缀交给 openapi.js，不走下面的同源/会话校验 ----
      // 它有自己的鉴权（API Key）与限流（按 Key），这里只负责把前缀切过去。
      // 顺序必须在静态资源与 404 之前，否则 /open/v1/* 会掉进静态白名单的兜底分支。
      if (p === openapi.PREFIX || p.startsWith(`${openapi.PREFIX}/`)) {
        return await open.handle(req, res, url, p);
      }

      // ---- API ----
      if (p === '/api/login' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.login)) return;
        const body = await readBody(req);
        // **只认账号**（§3.2）。账号还没开完户时响应里带 needOnboard=true，
        // 客户端据此切到「填昵称 + 选券商」那一步，而不是当普通失败处理。
        // 这里不会建号——建号只发生在 /api/onboard
        const r = game.login(body.account);
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 开户（首次登录的最后一步）：账号 + 昵称 + 券商，成功后直接发令牌进市场 ----
      if (p === '/api/onboard' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.login)) return;
        const body = await readBody(req);
        const r = game.onboard(body.account, body.nick, body.broker);
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 改昵称：昵称只是展示名，随时可改、不要求唯一（§3.2） ----
      if (p === '/api/nick' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.write)) return;
        const body = await readBody(req);
        const r = game.setNickFor(bearerToken(req), body.nick);
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 开放接口自助管理：网页上签发 / 查看 / 撤销自己的 API Key ----
      // 鉴权走**会话令牌**（这是"管理凭据"的入口），/open/v1 走 Key（"用凭据干活"）。
      // 明文只在 POST 的响应里出现一次，之后任何接口都读不到（库里只存 sha256）。
      if (p === '/api/open/keys' && (req.method === 'GET' || req.method === 'POST')) {
        const acc = game.accountFor(bearerToken(req));
        if (!acc) return json(res, 401, { ok: false, error: '请先登录' });
        if (!config.open || !config.open.enabled) {
          return json(res, 503, { ok: false, error: '开放接口已关闭' });
        }
        if (req.method === 'GET') {
          if (rl.enabled && !limiters.write.allow(ip)) {
            return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
          }
          return json(res, 200, {
            ok: true,
            account: acc.name,
            cap: config.open.maxKeysPerAccount,
            limits: {
              read: config.open.rateLimit.read.limit,
              trade: config.open.rateLimit.trade.limit,
              windowMs: config.open.rateLimit.read.windowMs,
            },
            keys: open.keys.list(acc.name),
          });
        }
        if (!guardWrite(req, res, ip, limiters.write)) return;
        if (!game.isOnboarded(acc)) {
          return json(res, 400, { ok: false, error: '还没走完开户（缺昵称或券商），先回主页补完再来' });
        }
        const cap = config.open.maxKeysPerAccount;
        if (open.keys.countFor(acc.name) >= cap) {
          return json(res, 400, { ok: false, error: `最多 ${cap} 把有效 Key，先撤销不用的再申请` });
        }
        const body = await readBody(req);
        const r = open.keys.issue(acc.name, { label: body.label, scopes: body.scopes });
        if (!r.ok) return json(res, 400, r);
        logger.info(
          `[我是股神][open] 自助签发 ${r.id} → ${acc.name}（${r.scopes}，${r.label || '无备注'}）`
        );
        return json(res, 200, { ...r, cap, createdAt: Date.now() });
      }

      if (p.startsWith('/api/open/keys/') && req.method === 'DELETE') {
        const acc = game.accountFor(bearerToken(req));
        if (!acc) return json(res, 401, { ok: false, error: '请先登录' });
        if (!guardWrite(req, res, ip, limiters.write)) return;
        const id = p.slice('/api/open/keys/'.length);
        const rec = open.keys.byId.get(id);
        // 别人的 Key 一律按"不存在"回：否则这个路由就成了 KeyID 探测器
        if (!rec || rec.account !== acc.name) {
          return json(res, 404, { ok: false, error: 'Key 不存在或已撤销' });
        }
        const r = open.keys.revoke(id);
        if (r.ok) logger.info(`[我是股神][open] 自助撤销 ${id}（${acc.name}）`);
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 券商开户卡片墙的展示元数据：**登录前**就要能拿到，所以不做鉴权 ----
      // 只包含对外可见的文案与数值预览，没有任何账户信息或内幕字段
      if (p === '/api/brokers' && req.method === 'GET') {
        if (rl.enabled && !limiters.state.allow(ip)) {
          return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        }
        return json(res, 200, game.brokersFor());
      }

      if (p === '/api/state' && req.method === 'GET') {
        if (rl.enabled && !limiters.state.allow(ip)) {
          return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        }
        const token = bearerToken(req) || url.searchParams.get('token') || '';
        if (!game.accountFor(token)) {
          return json(res, 401, { ok: false, error: '请先登录', account: null });
        }
        // 多股票后完整状态里不再带分时（10 只 × 10300 点太大），
        // 首屏要的那只走 /api/history?stock=
        return json(res, 200, game.stateFor(token));
      }

      // ---- 分时序列：切换股票时按需拉该股全量 ----
      if (p === '/api/history' && req.method === 'GET') {
        if (rl.enabled && !limiters.state.allow(ip)) {
          return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        }
        const token = bearerToken(req) || url.searchParams.get('token') || '';
        if (!game.accountFor(token)) {
          return json(res, 401, { ok: false, error: '请先登录' });
        }
        const r = game.historyFor(url.searchParams.get('stock'));
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 全部标的的降采样分时：主页行情列表的迷你走势 ----
      if (p === '/api/sparks' && req.method === 'GET') {
        if (rl.enabled && !limiters.state.allow(ip)) {
          return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        }
        const token = bearerToken(req) || url.searchParams.get('token') || '';
        if (!game.accountFor(token)) {
          return json(res, 401, { ok: false, error: '请先登录' });
        }
        return json(res, 200, game.sparksFor());
      }

      // ---- 日线（K 线图）：切到日线模式 / 换股票时按需拉该标的的已收盘日线 ----
      if (p === '/api/daily' && req.method === 'GET') {
        if (rl.enabled && !limiters.daily.allow(ip)) {
          return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        }
        const token = bearerToken(req) || url.searchParams.get('token') || '';
        if (!game.accountFor(token)) {
          return json(res, 401, { ok: false, error: '请先登录' });
        }
        const r = game.dailyFor(url.searchParams.get('stock'), Number(url.searchParams.get('limit')) || 120);
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 某只股票的前十大股东（含两层变动）：进股东 tab / 切股票时拉，5 秒刷新 ----
      if (p === '/api/holders' && req.method === 'GET') {
        if (rl.enabled && !limiters.holders.allow(ip)) {
          return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        }
        const token = bearerToken(req) || url.searchParams.get('token') || '';
        if (!game.accountFor(token)) {
          return json(res, 401, { ok: false, error: '请先登录' });
        }
        const r = game.holdersFor(token, url.searchParams.get('stock'));
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 股东占比走势：本账户在某只股票上最近若干次操作时的前十大快照 ----
      if (p === '/api/holders/history' && req.method === 'GET') {
        if (rl.enabled && !limiters.holders.allow(ip)) {
          return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        }
        const token = bearerToken(req) || url.searchParams.get('token') || '';
        const r = game.holderHistoryFor(token, url.searchParams.get('stock'));
        return json(res, r.ok ? 200 : 401, r);
      }

      // ---- 某玩家的持仓概况：排行里点「持仓」按钮时按需拉 ----
      // 榜单每 tick 都在重绘，把所有人的持仓塞进 state 会白撑 SSE 帧，所以走单独的按需接口。
      // 只回仓位与账户级汇总（批次明细/强平价/委托/成交都不给）。
      if (p === '/api/player/positions' && req.method === 'GET') {
        if (rl.enabled && !limiters.holders.allow(ip)) {
          return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        }
        const token = bearerToken(req) || url.searchParams.get('token') || '';
        if (!game.accountFor(token)) {
          return json(res, 401, { ok: false, error: '请先登录' });
        }
        const r = game.playerPortfolio(url.searchParams.get('account'));
        return json(res, r.ok ? 200 : 404, r);
      }

      if (p === '/api/order' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.order)) return;
        const body = await readBody(req);
        const r = game.placeOrder(bearerToken(req), body);
        return json(res, r.ok ? 200 : 400, r);
      }

      if (p === '/api/cancel' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.order)) return;
        const body = await readBody(req);
        const r = game.cancelOrder(bearerToken(req), body.orderId);
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 分时图弹幕：玩家主动发一条 ----
      // 长度 / 频率 / 敏感词都在 DanmakuSystem 里判（错误信息直接回给客户端展示），
      // 这里只做同源 + 登录态 + 通用写限流
      if (p === '/api/danmaku' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.write)) return;
        const body = (await readBody(req)) || {};
        const r = game.sendDanmaku(bearerToken(req), body.stockId, body.text, Date.now(), body.emote);
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 弹幕观看心跳：交易终端每 60 秒一次，只打点不产出 ----
      // 没有它的话，玩家盯同一只票超过 watchTtlMs 后 watcher 过期，这只票就不再生成弹幕
      if (p === '/api/danmaku/watch' && req.method === 'GET') {
        if (rl.enabled && !limiters.holders.allow(ip)) {
          return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        }
        const r = game.watchDanmaku(url.searchParams.get('stock'));
        return json(res, r.ok ? 200 : 404, r);
      }

      // ---- 自动化交易：创建 / 启停 / 删除（列表走 /api/state 的 account.auto）----
      if (p === '/api/auto' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.order)) return;
        const body = await readBody(req);
        const op = body && body.op;
        let r;
        if (op === 'create') r = game.createAuto(bearerToken(req), body);
        else if (op === 'update') r = game.updateAuto(bearerToken(req), body);
        else if (op === 'remove') r = game.removeAuto(bearerToken(req), body);
        else r = { ok: false, error: '未知操作' };
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 融券：挂借 / 撤借（列表走 /api/state 的 account.positions[].lending）----
      if (p === '/api/lend' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.order)) return;
        const body = await readBody(req);
        const op = body && body.op;
        const qty = body && body.qty;
        let r;
        if (op === 'lend') r = game.lend(bearerToken(req), qty, body && body.stockId);
        else if (op === 'unlend') r = game.unlend(bearerToken(req), qty, body && body.stockId);
        else r = { ok: false, error: '未知操作' };
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 加钱：单账户终身累计上限由 config.account.deposit 决定 ----
      if (p === '/api/deposit' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.deposit)) return;
        const body = await readBody(req);
        const r = game.deposit(bearerToken(req), body.amount);
        if (!r.ok) logger.info(`[我是股神] 加钱被拒(${ip}): ${r.error}`);
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 券商：转户 / 每日免息券（都要求已登录）----
      if (p === '/api/broker/transfer' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.order)) return;
        const body = await readBody(req);
        const r = game.transferBrokerFor(bearerToken(req), body.broker);
        if (!r.ok) logger.info(`[我是股神] 转户被拒(${ip}): ${r.error}`);
        return json(res, r.ok ? 200 : 400, r);
      }

      if (p === '/api/broker/coupon' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.order)) return;
        const r = game.useCouponFor(bearerToken(req));
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- AI 主力详情：仅白名单玩家账号（写死 chu）；口令走玩家会话 token ----
      if (p === '/api/whales' && req.method === 'GET') {
        const token = bearerToken(req) || url.searchParams.get('token') || '';
        if (!game.canViewWhales(token)) {
          logger.warn(`[LLM] AI 持仓页鉴权失败: ${ip}`);
          return json(res, 403, { ok: false, error: '无权查看' });
        }
        return json(res, 200, game.whalePortfolio());
      }

      // ---- 运维：AI 主力持仓组合（口令同停牌；玩家接口一律不下发）----
      if (p === '/api/admin/whales' && req.method === 'GET') {
        if (!admin.authorized(req.headers['x-admin-token'])) {
          logger.warn(`[LLM] 运维持仓接口口令校验失败: ${ip}`);
          return json(res, 403, { ok: false, error: '运维口令无效' });
        }
        return json(res, 200, game.whalePortfolio());
      }

      // ---- 运维：开放平台 API Key 管理（签发 / 列表 / 撤销，口令同停牌）----
      //
      // 刻意不做「玩家自助申领」：这一版是给熟人圈用的，Key 由运维发。少一套注册/邮箱/
      // 验证码，就少一整片攻击面。将来真要公开，加的是这一层的自助入口，Key 体系不用动。
      //
      // 明文 Key **只在签发响应里出现一次**（库里只有 sha256），运维必须当场交给玩家；
      // 丢了只能撤销重发——这是设计上故意的，能读回来的秘密就不算秘密。
      if (p === '/api/admin/keys' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.admin)) return;
        if (!admin.authorized(req.headers['x-admin-token'])) {
          logger.warn(`[我是股神] API Key 签发口令校验失败: ${ip}`);
          return json(res, 403, { ok: false, error: '运维口令无效' });
        }
        const body = await readBody(req);
        const account = String(body.account || '').trim();
        const acc = game.store.get(account);
        if (!acc || acc.isNPC) return json(res, 400, { ok: false, error: '账户不存在（先用游戏登录一次建号）' });
        if (!game.isOnboarded(acc)) {
          return json(res, 400, { ok: false, error: '该账号还没走完开户（缺昵称或券商），先进游戏开完户' });
        }
        const cap = config.open.maxKeysPerAccount;
        if (open.keys.countFor(account) >= cap) {
          return json(res, 400, { ok: false, error: `单账户最多 ${cap} 把有效 Key，请先撤销不用的` });
        }
        const r = open.keys.issue(account, body);
        if (r.ok) {
          logger.info(`[我是股神] 签发 API Key ${r.id} → ${account}（${r.scopes}，${r.label || '无备注'}）`);
        }
        return json(res, r.ok ? 200 : 400, r);
      }

      if (p === '/api/admin/keys' && req.method === 'GET') {
        if (rl.enabled && !limiters.admin.allow(ip)) {
          return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        }
        if (!admin.authorized(req.headers['x-admin-token'])) {
          return json(res, 403, { ok: false, error: '运维口令无效' });
        }
        return json(res, 200, { ok: true, keys: open.keys.list(url.searchParams.get('account') || '') });
      }

      if (p.startsWith('/api/admin/keys/') && req.method === 'DELETE') {
        if (rl.enabled && !limiters.admin.allow(ip)) {
          return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        }
        if (!admin.authorized(req.headers['x-admin-token'])) {
          return json(res, 403, { ok: false, error: '运维口令无效' });
        }
        const id = p.slice('/api/admin/keys/'.length);
        const r = open.keys.revoke(id);
        if (r.ok) logger.info(`[我是股神] 撤销 API Key ${r.id}（${r.account}）`);
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 运维：交易日时钟（server.py 的安全关服判定每秒轮询它）----
      //
      // 故意**不过 admin 限流**：admin 档是 10 次/分钟，而休市窗口（收盘后的 night 段）
      // 只有 40 秒，40 秒内最多问 6 次就等于没有精度。这是纯只读、几十字节的接口，
      // 又有口令把关，放开频率比让脚本瞎猜安全得多。
      if (p === '/api/admin/clock' && req.method === 'GET') {
        if (!admin.authorized(req.headers['x-admin-token'])) {
          logger.warn(`[我是股神] 运维时钟接口口令校验失败: ${ip}`);
          return json(res, 403, { ok: false, error: '运维口令无效' });
        }
        return json(res, 200, { ok: true, ...game.opsClock() });
      }

      // ---- 运维：优雅下线（server.py stop / restart 的唯一停服通道）----
      //
      // 为什么不让脚本直接 taskkill：Windows 上强杀 = TerminateProcess，走不到
      // index.js 的 SIGTERM 收尾，log4js 的尾巴和 SQLite 的 WAL 都靠运气。
      // 这里让进程自己收尾（停 tick → 关存档 → 关监听 → exit），脚本在外面等 PID 消失。
      // 只接受回环来源：真正跑运维脚本的一定是这台机器。
      if (p === '/api/admin/shutdown' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.admin)) return;
        if (!admin.authorized(req.headers['x-admin-token'])) {
          logger.warn(`[我是股神] 运维关服口令校验失败: ${ip}`);
          return json(res, 403, { ok: false, error: '运维口令无效' });
        }
        if (!isLoopback(ip)) {
          logger.warn(`[我是股神] 拒绝来自 ${ip} 的关服指令（只接受本机）`);
          return json(res, 403, { ok: false, error: '关服指令只接受本机来源' });
        }
        logger.info(`[我是股神] 收到运维关服指令（来自 ${ip}）`);
        json(res, 200, { ok: true, note: '正在关闭' });
        // 先把 200 写回去，脚本要靠它判断「指令已送达」再去等进程消失；
        // 立刻 exit 会把响应掐断，脚本只能看到连接被重置
        setTimeout(() => opts.onShutdown && opts.onShutdown('admin-http'), 200);
        return;
      }

      // ---- 运维：系统公告（关服 / 重启前通知玩家）----
      //
      // 只存最新一条、只存内存（进程一停就该消失）。
      // `{clear: true}` 或空文本 = 撤下公告：运维脚本在等待关服的途中按了 Ctrl+C
      // 时必须能撤回，否则玩家会一直盯着一条永远不发生的「即将关闭」。
      if (p === '/api/admin/notice' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.admin)) return;
        if (!admin.authorized(req.headers['x-admin-token'])) {
          logger.warn(`[我是股神] 系统公告口令校验失败: ${ip}`);
          return json(res, 403, { ok: false, error: '运维口令无效' });
        }
        const body = await readBody(req);
        const text = body.clear ? '' : body.text;
        const r = game.setNotice(text, { minutes: body.minutes, kind: body.kind });
        if (r.ok) {
          logger.info(
            r.notice
              ? `[我是股神] 系统公告（${ip}，${body.minutes || 30} 分钟）: ${r.notice.text}`
              : `[我是股神] 系统公告已撤下（${ip}）`
          );
        }
        return json(res, r.ok ? 200 : 400, r);
      }

      // ---- 运维：停牌 / 复牌（口令见 config.admin.tokenFile）----
      if (p === '/api/admin/halt' || p === '/api/admin/resume') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '仅支持 POST' });
        if (!guardWrite(req, res, ip, limiters.admin)) return;
        if (!admin.authorized(req.headers['x-admin-token'])) {
          logger.warn(`[我是股神] 运维接口口令校验失败: ${ip}`);
          return json(res, 403, { ok: false, error: '运维口令无效' });
        }
        const body = await readBody(req);
        const isHalt = p === '/api/admin/halt';
        const r = isHalt ? game.halt(body.minutes, body.reason) : game.resume();
        logger.info(
          `[我是股神] ${isHalt ? '停牌' : '复牌'}请求来自 ${ip}: ` +
            (r.ok ? JSON.stringify(r) : r.error)
        );
        return json(res, r.ok ? 200 : 400, r);
      }

      if (p === '/api/events' && req.method === 'GET') {
        // EventSource 无法自定义请求头，令牌允许走 query
        const token = bearerToken(req) || url.searchParams.get('token') || '';
        if (!game.accountFor(token)) {
          return json(res, 401, { ok: false, error: '请先登录' });
        }
        const reason = hub.rejectReason(ip);
        if (reason) {
          return json(res, 503, { ok: false, error: reason });
        }
        res.writeHead(200, withSecurity({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        }));
        res.write('retry: 2000\n\n');
        const conn = { res, token, ip };
        hub.add(conn);
        // 首帧立即推送（行情全量 + 账户快照；分时按需拉 /api/history）
        hub.send(conn, 'state', game.stateFor(token));
        req.on('close', () => hub.remove(conn));
        return;
      }

      // ---- 图片资源（白名单，见 IMG_ASSETS：券商图标 + 股神猫头像）----
      if (req.method === 'GET' && IMG_ASSETS.has(p)) {
        const spec = IMG_ASSETS.get(p);
        fs.readFile(path.join(CLIENT_DIR, spec.file), (err, buf) => {
          if (err) {
            res.writeHead(404, withSecurity({ 'Content-Type': 'text/plain; charset=utf-8' }));
            res.end('Not Found');
            return;
          }
          res.writeHead(200, withSecurity({
            'Content-Type': spec.type,
            // 图标是构建产物、内容不变，可以放心长缓存（与小图/原图各自独立）
            'Cache-Control': 'public, max-age=86400',
          }));
          res.end(buf);
        });
        return;
      }

      // ---- 开放平台文档：白名单 markdown，在线阅读 / 下载（无需登录）----
      if (req.method === 'GET' && DOC_FILES[p]) {
        const spec = DOC_FILES[p];
        const wantDownload = url.searchParams.get('download') === '1';
        return fs.readFile(spec.src, (err, buf) => {
          if (err) {
            res.writeHead(404, withSecurity({ 'Content-Type': 'text/plain; charset=utf-8' }));
            res.end('Not Found');
            return;
          }
          const headers = {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Cache-Control': 'no-cache',
          };
          if (wantDownload) {
            // 非 ASCII 文件名走 RFC 5987，老浏览器回落 filename=
            headers['Content-Disposition'] =
              `attachment; filename="${spec.downloadName}"; filename*=UTF-8''${encodeURIComponent(path.basename(spec.src))}`;
          }
          res.writeHead(200, withSecurity(headers));
          res.end(buf);
        });
      }

      // ---- 静态资源 ----
      if (req.method === 'GET' && STATIC_FILES[p]) {
        const spec = STATIC_FILES[p];
        const file = path.join(CLIENT_DIR, spec.file);
        fs.readFile(file, (err, buf) => {
          if (err) {
            res.writeHead(404, withSecurity({ 'Content-Type': 'text/plain; charset=utf-8' }));
            res.end('Not Found');
            return;
          }
          res.writeHead(200, withSecurity({
            'Content-Type': spec.type,
            'Cache-Control': 'no-cache',
          }));
          res.end(buf);
        });
        return;
      }

      json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      if (res.headersSent || res.destroyed) return;
      if (e && e.statusCode) {
        return json(res, e.statusCode, { ok: false, error: e.publicMessage || '请求处理失败' });
      }
      // 内部异常只记服务端日志，不回显给客户端
      logger.error('[我是股神] 请求处理异常:', e);
      json(res, 400, { ok: false, error: '请求处理失败' });
    }
  });

  // 限制慢速请求占用连接的时间
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;
  // 暴露给测试（签发 Key / 断言限流用）。运行期没有别的地方读它。
  server.openApi = open;

  return server;
}

module.exports = { createServer };
