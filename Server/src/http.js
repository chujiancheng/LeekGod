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
const { logger } = require('./logger');

const CLIENT_DIR = path.join(__dirname, '..', '..', 'Client');
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

/**
 * 券商图标：`/img/broker-<key>.png`（1024 原图，登录卡片墙 / 我的券商卡用）与
 * `/img/broker-<key>-96.png`（96px 缩略图，五档 / 逐笔 / 排行榜这些高频小位置用——
 * 原图 262KB~990KB，十档盘口每帧都要画几十个 12px 图标，用原图是纯浪费）。
 *
 * **按券商 key 白名单生成，不做目录直出**：静态服务一律白名单，路径既不能拼用户输入、
 * 也不能走出指定目录（避免 `../` 穿越）。图标文件缺失时不注册，请求落到 404，
 * 前端只会看到空图标而不会报错。
 */
const BROKER_ICONS = new Map();
for (const key of Object.keys((config.brokers && config.brokers.list) || {})) {
  for (const [suffix, size] of [['', 'lg'], ['-96', 'sm']]) {
    const name = `broker-${key}${suffix}.png`;
    if (fs.existsSync(path.join(CLIENT_DIR, 'img', name))) {
      BROKER_ICONS.set(`/img/${name}`, { file: path.join('img', name), type: 'image/png', size });
    }
  }
}

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

function createServer(game) {
  const hub = new SseHub(game);
  const rl = config.http.rateLimit;
  const limiters = {
    login: new RateLimiter(rl.login),
    order: new RateLimiter(rl.order),
    deposit: new RateLimiter(rl.deposit),
    state: new RateLimiter(rl.state),
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
      // ---- API ----
      if (p === '/api/login' && req.method === 'POST') {
        if (!guardWrite(req, res, ip, limiters.login)) return;
        const body = await readBody(req);
        // 首次登录必须一并提交券商（§9 D2）。响应里的 needBroker=true 告诉客户端
        // 「还差一步选券商」，前端据此把卡片墙亮出来而不是当普通失败处理
        const r = game.login(body.name, body.broker);
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

      // ---- 券商图标（白名单，见 BROKER_ICONS）----
      if (req.method === 'GET' && BROKER_ICONS.has(p)) {
        const spec = BROKER_ICONS.get(p);
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

  return server;
}

module.exports = { createServer };
