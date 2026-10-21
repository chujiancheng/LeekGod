/* ==========================================================================
   api.js — 网络层：令牌 / REST / SSE 实时帧
   与 H5 客户端共用同一套接口（服务端零改动）：
     请求头是 authorization: Bearer <token>，令牌由 /api/login 或 /api/onboard 签发
   ========================================================================== */
(function (GS) {
  'use strict';

  const { S, KEY, store } = GS.core;

  /** 接口基址：与页面同源（/m/ 下也发 /api/*）。套壳成 App 时只改这一行。 */
  const ORIGIN = '';

  function headers(extra) {
    const h = Object.assign({}, extra || {});
    if (S.token) h.authorization = 'Bearer ' + S.token;
    return h;
  }

  function apiGet(path) {
    return fetch(ORIGIN + path, { headers: headers() });
  }

  function apiPost(path, body) {
    return fetch(ORIGIN + path, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body || {}),
    });
  }

  /** GET 并解析 JSON，非 200 也照解析（服务端错误体是 {ok:false,error}） */
  async function getJSON(path) {
    const r = await apiGet(path);
    return r.json();
  }

  async function postJSON(path, body) {
    const r = await apiPost(path, body);
    return r.json();
  }

  /* ---------------------------------------------------------------- 身份 */

  function setIdentity(account, nick, token) {
    S.account = account || '';
    S.nick = nick || '';
    if (token != null) S.token = token || '';
    store.set(KEY.account, S.account);
    store.set(KEY.nick, S.nick);
    if (S.token) store.set(KEY.token, S.token);
    else store.del(KEY.token);
  }

  function clearIdentity() {
    setIdentity('', '', '');
  }

  /* ------------------------------------------------------------ 业务接口 */

  const api = {
    /** 免密登录（只认账号）。未开户返回 {ok:false, needOnboard:true} */
    login: (account) => postJSON('/api/login', { account }),
    /** 开户：账号 + 昵称 + 券商，一次提交 */
    onboard: (account, nick, broker) => postJSON('/api/onboard', { account, nick, broker }),
    /** 券商目录（登录页要，未登录也能拉） */
    brokers: () => getJSON('/api/brokers'),
    /** 全量状态（首屏兜底；SSE 断了用它续命） */
    state: () => getJSON('/api/state'),
    /** 分时（含历史，5 日窗口由前端裁剪） */
    history: (stockId) => getJSON('/api/history?stock=' + encodeURIComponent(stockId)),
    /** 全市场降采样迷你走势 */
    sparks: () => getJSON('/api/sparks'),
    /** 下单：action=buy|sell|short|cover，qty 必须整手 */
    order: (body) => postJSON('/api/order', body),
    /** 撤单 */
    cancel: (orderId) => postJSON('/api/cancel', { orderId }),
    /** 加钱（服务端开关 rules.deposit.enabled） */
    deposit: (amount) => postJSON('/api/deposit', { amount }),
    /** 改昵称 */
    nick: (nick) => postJSON('/api/nick', { nick }),
    /** 换头像 */
    avatar: (key) => postJSON('/api/avatar', { key }),
  };

  /* ------------------------------------------------------------ 分时缓存 */

  const hist = new Map(); // stockId -> [{t, price, vol}]（跨天连续，与网页版同口径）
  const histPending = new Set();

  /** 分时序列容量上限：与网页版一致（服务端保留约 2 小时 ≈ 10300 点） */
  const HIST_MAX = 10300;

  function historyOf(stockId) {
    return hist.get(stockId) || [];
  }

  function loadHistory(stockId) {
    if (histPending.has(stockId)) return Promise.resolve(historyOf(stockId));
    histPending.add(stockId);
    return api
      .history(stockId)
      .then((r) => {
        histPending.delete(stockId);
        if (r && r.ok && Array.isArray(r.priceHistory)) {
          // 服务端全量覆盖本地累积的点；期间新到的点（时间戳更晚）保序接在尾部，不丢帧
          const local = hist.get(stockId) || [];
          const merged = r.priceHistory.slice();
          const lastT = merged.length ? merged[merged.length - 1].t : 0;
          for (const p of local) if (p.t > lastT) merged.push(p);
          // 定格期（竞价/午休/夜间）：服务端序列里带着这一段的平线，落地前先塌成一个锚点，
          // 否则休市期间进个股页会先看到一条爬到「现在」的水平线，等下一帧才收回去
          const freezeAt = frozenPhaseStart();
          if (freezeAt != null) {
            const tail = merged.length ? merged[merged.length - 1] : null;
            cutAfter(merged, freezeAt);
            if (tail && merged.length && merged[merged.length - 1].t < freezeAt) {
              merged.push({ t: freezeAt, price: tail.price, vol: tail.vol });
            }
          }
          hist.set(stockId, merged);
          return merged;
        }
        return historyOf(stockId);
      })
      .catch(() => {
        histPending.delete(stockId);
        return historyOf(stockId);
      });
  }

  /** 往某条序列尾部追加一个分时点（同时间戳覆盖，超长丢弃最旧的）— 与网页版 appendPoint 同口径 */
  function appendPoint(map, stockId, t, price, vol) {
    let arr = map.get(stockId);
    if (!arr) {
      arr = [];
      map.set(stockId, arr);
    }
    const last = arr[arr.length - 1];
    if (!last || t > last.t) arr.push({ t, price, vol });
    else if (t === last.t) arr[arr.length - 1] = { t, price, vol };
    if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);
  }

  /* ------------------------------------------------ 分时定格（竞价/午休/夜间） */

  /**
   * 与网页版同一套口径：只有连续竞价（trading 且非 auction）才让分时往后生长。
   * 定格期整段只留阶段起点一个锚点，画面完全静止——否则休市期间照抄逐帧价格
   * 会把线拉成越来越长的水平直线，x 轴跟着最新点一路右移，看起来像还在交易。
   * 定格期返回本阶段**起点时刻**（phaseEndsAt − phaseMs 反推）；连续竞价返回 null。
   */
  function frozenPhaseStart() {
    const d = S.state && S.state.day;
    if (!d) return null;
    if (d.trading && !d.auction) return null;
    const end = Number(d.phaseEndsAt);
    const ms = Number(d.phaseMs);
    if (!Number.isFinite(end) || !Number.isFinite(ms) || ms <= 0) return null;
    return end - ms;
  }

  /** 丢掉尾部所有落在 t 之后的点（定格里塌掉整段，阶段起点之前的历史保留） */
  function cutAfter(arr, t) {
    let n = arr.length;
    while (n > 0 && arr[n - 1].t >= t) n -= 1;
    if (n !== arr.length) arr.length = n;
  }

  /** 按帧记一个分时点：连续竞价正常追加，定格期只维护阶段起点那一个锚点 */
  function addFramePoint(map, stockId, t, price, vol, freezeAt) {
    if (freezeAt == null) {
      appendPoint(map, stockId, t, price, vol);
      return;
    }
    let arr = map.get(stockId);
    if (!arr) {
      arr = [];
      map.set(stockId, arr);
    }
    cutAfter(arr, freezeAt);
    appendPoint(map, stockId, Math.min(freezeAt, t), price, vol);
  }

  /**
   * 逐帧把最新价补进分时缓存。与网页版同口径：吃服务端帧的 serverTime（不走本地插值，
   * 本地插值在定格期会凭空造点）、每帧给**全市场**追加（切股票不用回头补）、
   * 指数也记一条（个股页 hero 用得到）。
   */
  function appendTick(st) {
    if (!st || !Array.isArray(st.markets)) return;
    const t = Number(st.serverTime) || Date.now();
    const freezeAt = frozenPhaseStart();
    for (const m of st.markets) {
      addFramePoint(hist, m.stockId, t, m.last, m.volume, freezeAt);
      addFramePoint(sparks, m.stockId, t, m.last, m.volume, freezeAt);
    }
    // 指数也记一条：服务端 /api/sparks 不含指数，首页 hero 的迷你走势全靠这里养
    if (st.index) {
      addFramePoint(hist, st.index.stockId, t, st.index.last, 0, freezeAt);
      addFramePoint(sparks, st.index.stockId, t, st.index.last, 0, freezeAt);
    }
  }

  /* ------------------------------------------------------------ 迷你走势 */

  const sparks = new Map(); // stockId -> [{t, price}]

  function loadSparks() {
    return api
      .sparks()
      .then((r) => {
        if (r && r.ok) {
          Object.entries(r.sparks || {}).forEach(([id, pts]) => sparks.set(id, pts));
        }
      })
      .catch(() => {});
  }

  const sparkOf = (stockId) => sparks.get(stockId) || [];

  /* ---------------------------------------------------------------- SSE */

  let es = null;
  let retryTimer = null;
  let retryMs = 1500;
  let alive = false;

  const onAlive = new Set();
  function onConn(fn) {
    onAlive.add(fn);
    return () => onAlive.delete(fn);
  }

  function fireConn(v) {
    alive = v;
    onAlive.forEach((fn) => {
      try {
        fn(v);
      } catch (e) {
        /* 忽略 */
      }
    });
  }

  function connect() {
    if (es) {
      es.close();
      es = null;
    }
    if (!S.token) return;
    clearTimeout(retryTimer);
    const url = ORIGIN + '/api/events?token=' + encodeURIComponent(S.token);
    es = new EventSource(url);

    es.addEventListener('state', (ev) => {
      retryMs = 1500;
      fireConn(true);
      let s = null;
      try {
        s = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (!s) return;
      // 服务端重启会让令牌失效：account 变 null 就静默重登一次
      if (s.account === null && S.account) {
        relogin();
        return;
      }
      S.state = s;
      S.stateAt = Date.now();
      // 默认选中第一只
      if (!S.stockId) {
        const first = s.markets && s.markets[0];
        if (first) {
          S.stockId = first.stockId;
          store.set(KEY.stock, S.stockId);
        }
      }
      appendTick(s);
      GS.core.emit();
    });

    es.onopen = () => {
      retryMs = 1500;
      fireConn(true);
    };

    es.onerror = () => {
      fireConn(false);
      if (es) {
        es.close();
        es = null;
      }
      // 自己退避重连（不要指望 EventSource 内建重试：它在 401 上会无限空转）
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 1.7, 12000);
    };
  }

  function disconnect() {
    clearTimeout(retryTimer);
    if (es) {
      es.close();
      es = null;
    }
    fireConn(false);
  }

  /* -------------------------------------------------------------- 重登 */

  let relogging = false;
  const onRelogin = new Set();

  function relogin() {
    if (relogging || !S.account) return;
    relogging = true;
    api
      .login(S.account)
      .then((r) => {
        relogging = false;
        if (r && r.ok) {
          setIdentity(r.account, r.nick, r.token);
          onRelogin.forEach((fn) => fn(true, r));
          connect();
          return;
        }
        onRelogin.forEach((fn) => fn(false, r));
      })
      .catch(() => {
        relogging = false;
        onRelogin.forEach((fn) => fn(false, null));
      });
  }

  /* ------------------------------------------------------ 前后台 / 网络 */

  function bindLifecycle() {
    // 回到前台：SSE 在 iOS 后台会被静默挂起，这里直接重连一次
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (S.token && (!es || es.readyState === 2)) connect();
      // 顺便拉一次全量，补上后台期间漏掉的帧
      if (S.token) {
        api
          .state()
          .then((s) => {
            if (s && s.ok !== false && s.markets) {
              S.state = s;
              S.stateAt = Date.now();
              appendTick(s);
              GS.core.emit();
            }
          })
          .catch(() => {});
      }
    });
    window.addEventListener('online', () => {
      if (S.token) connect();
    });
  }

  /**
   * 冷启动：有本地账号 → 静默登录 → 连 SSE 拉首屏。
   * 失败（服务端换了库 / 没开过户）返回 needOnboard 或 null，交给登录页。
   */
  async function boot() {
    bindLifecycle();
    if (!S.account) return { ok: false, reason: 'no-account' };
    try {
      const r = await api.login(S.account);
      if (r && r.ok) {
        setIdentity(r.account, r.nick, r.token);
        connect();
        return { ok: true };
      }
      if (r && r.needOnboard) {
        return { ok: false, reason: 'need-onboard', account: r.account || S.account };
      }
      return { ok: false, reason: 'login-failed', error: r && r.error };
    } catch (e) {
      return { ok: false, reason: 'network' };
    }
  }

  GS.api = {
    ORIGIN, apiGet, apiPost, getJSON, postJSON,
    setIdentity, clearIdentity, api,
    historyOf, loadHistory, loadSparks, sparkOf, appendTick,
    connect, disconnect, onConn, onRelogin, relogin, boot,
    get connected() {
      return alive;
    },
  };
})(window.GS);
