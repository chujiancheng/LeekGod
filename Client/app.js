/**
 * 我是股神 · 客户端
 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  let me = localStorage.getItem('gushen_name') || '';
  let token = localStorage.getItem('gushen_token') || '';
  let state = null;
  // 分时：每只股票一条独立序列（切股票时拉该股全量，之后靠 SSE 每帧追加）。
  // 之前是单个 history 数组，多股票下会被 10 只股票互相覆盖
  const histories = new Map(); // stockId -> [{t, price, vol}]
  // 已经拉过**全量**分时的标的。不能用 histories.has() 判断：onState 每帧会给全部标的
  // 追加一个点，第一帧过后每只股票都在 histories 里了，那样 /api/history 永远不会被调用，
  // 分时图就只剩「本次会话累积的点」，刷新页面后看不到服务端已积累的历史
  const histLoaded = new Set();
  // 迷你走势用的**降采样**序列（/api/sparks 一次拉全，之后同样按帧追加）
  const sparks = new Map(); // stockId -> [{t, price, vol}]
  let activeStockId = localStorage.getItem('gushen_stock') || ''; // 交易终端当前看的股票
  let es = null;
  let selectedAction = 'buy_open';
  let priceDirty = false;
  let lastNewsSeen = null;
  let lastLiquidations = 0;
  let newsUnread = 0;
  let lastStateAt = 0;
  let relogging = false;
  let activeView = 'home'; // home = 交易大厅，trade = 分时交易终端
  let holderHist = null; // 股东占比走势快照（点股东那行时按需拉取，不随每帧刷新）
  let holderHistName = ''; // 当前弹窗看的是哪位股东
  let holderFetching = false;
  // 股东榜改为按需拉取（10 只股票全推会把每帧撑爆）：进 tab / 切股票时拉，前台 5 秒刷新
  let holdersData = null; // /api/holders 的最近一次响应
  let holdersStockId = '';
  let holdersAt = 0;
  // 消息过滤：all = 全部，index = 只大盘，个股 stockId
  let newsFilter = 'all';

  const ACTION_LABEL = {
    buy_open: '买入开多',
    sell_close: '卖出平多',
    sell_open: '卖出开空',
    buy_close: '买入平空',
  };

  // ---------- 工具 ----------
  const $ = (id) => document.getElementById(id);

  // 任何来自服务端的字符串插入 HTML 前必须过一遍
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  // 身份只走令牌，请求体不再携带账号名
  function apiGet(path) {
    const headers = {};
    if (token) headers.authorization = 'Bearer ' + token;
    return fetch(path, { headers });
  }
  function apiPost(path, body) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    return fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  }
  function setIdentity(name, tok) {
    me = name || '';
    token = tok || '';
    if (me) localStorage.setItem('gushen_name', me);
    else localStorage.removeItem('gushen_name');
    if (token) localStorage.setItem('gushen_token', token);
    else localStorage.removeItem('gushen_token');
  }

  const fmtP = (v) => (v == null ? '--' : Number(v).toFixed(2));
  const fmtMoney = (v) =>
    Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtQty = (v) => Number(v).toLocaleString('zh-CN');
  // 档口挂单量紧凑显示：≥100万 用 M（100万→1M，120万→1.2M），其余保持千分位
  function fmtBookQty(v) {
    const n = Number(v) || 0;
    if (n >= 1e6) {
      const m = n / 1e6;
      return (m >= 100 ? Math.round(m) : Math.round(m * 10) / 10) + 'M';
    }
    return n.toLocaleString('zh-CN');
  }
  function fmtVol(v) {
    v = Number(v) || 0;
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿股';
    if (v >= 1e4) return (v / 1e4).toFixed(2) + '万股';
    return v + '股';
  }
  function fmtAmount(v) {
    v = Number(v) || 0;
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿元';
    if (v >= 1e4) return (v / 1e4).toFixed(2) + '万元';
    return v.toFixed(2) + '元';
  }
  function fmtTime(ts, withDate) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    const hm = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    return withDate ? d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hm : hm;
  }
  function cls(v) {
    return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  }

  // ---------- 多股票上下文 ----------
  /** 全部股票行情（服务端 state.markets），不含指数 */
  function marketList(s) {
    const st = s || state;
    if (!st || !Array.isArray(st.markets)) return [];
    return st.markets;
  }

  /** 按 stockId 取行情 */
  function marketOf(stockId) {
    return marketList().find((m) => m.stockId === stockId) || null;
  }

  /** 交易终端当前看的标的行情（股票或指数）；未选定或已失效时回落到第一只股票 */
  function curMarket() {
    if (state && state.index && activeStockId === state.index.stockId) return state.index;
    const list = marketList();
    return list.find((x) => x.stockId === activeStockId) || list[0] || (state && state.index) || null;
  }

  /** 账户在某只股票上的持仓切片（服务端 account.positions） */
  function positionOf(stockId) {
    const a = state && state.account;
    if (!a || !Array.isArray(a.positions)) return null;
    return a.positions.find((p) => p.stockId === stockId) || null;
  }

  /** 当前股票的持仓切片 */
  const curPosition = () => positionOf((curMarket() || {}).stockId);

  /**
   * 同股多空互斥（港交所口径）：同一账户在同一只股票上只能持有一个方向。
   * 判定口径与服务端 place() 完全一致——已成持仓与**在途开仓委托**都算占用该方向；
   * 占用端禁的是反向开仓，平仓与同向加仓不受影响。
   */
  function directionLock() {
    const m = curMarket();
    const lock = { long: false, short: false };
    if (!m || m.isIndex) return lock;
    const pos = positionOf(m.stockId);
    if (pos) {
      if (pos.long.qty > 0) lock.long = true;
      if (pos.short.qty > 0) lock.short = true;
    }
    const orders = (state.account && state.account.orders) || [];
    for (const o of orders) {
      if (o.stockId !== m.stockId || o.status !== 'live') continue;
      if (o.action === 'buy_open') lock.long = true;
      else if (o.action === 'sell_open') lock.short = true;
    }
    return lock;
  }

  /** 某只股票的分时序列 */
  function histOf(stockId) {
    return histories.get(stockId) || [];
  }

  /** 切换交易终端看的股票 */
  function setActiveStock(stockId) {
    if (!stockId || stockId === activeStockId) return;
    activeStockId = stockId;
    localStorage.setItem('gushen_stock', stockId);
    priceDirty = false;
    loadHistory(stockId);
    loadHolders(stockId, true);
    renderStockTabs();
    if (activeView === 'trade') {
      renderHeader();
      renderDepth();
      renderTape();
      renderOrderPanel();
      renderPositions();
      renderHolders();
      renderLending();
      renderRisk();
      drawChart();
    }
  }
  function toast(msg, type) {
    const wrap = $('toastWrap');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(() => el.remove(), 320);
    }, 2600);
  }

  // ---------- 登录 ----------
  function bindLogin() {
    const doLogin = () => {
      const name = $('loginName').value.trim();
      if (!name) {
        toast('请输入账号', 'err');
        return;
      }
      // 输入名字即进入：同名永远回到同一个账户
      apiPost('/api/login', { name })
        .then((r) => r.json())
        .then((res) => {
          if (!res.ok) {
            toast(res.error || '登录失败', 'err');
            return;
          }
          setIdentity(res.name, res.token);
          enterApp();
        })
        .catch(() => toast('网络异常，请重试', 'err'));
    };
    $('loginBtn').addEventListener('click', doLogin);
    $('loginName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
    $('switchBtn').addEventListener('click', () => {
      if (confirm('切换账号？当前账号将退出登录。')) {
        setIdentity('', '');
        location.reload();
      }
    });
  }

  function enterApp() {
    $('loginOverlay').classList.add('hidden');
    $('app').classList.remove('hidden');
    loadInitial();
    connectSSE();
    setView('home'); // 登录后先落到交易大厅
  }

  // ---------- 视图切换 ----------
  function setView(v) {
    activeView = v === 'trade' ? 'trade' : 'home';
    $('homeView').hidden = activeView !== 'home';
    $('tradeView').hidden = activeView !== 'trade';
    $('stockTabs').hidden = activeView !== 'trade';
    $('viewNav').querySelectorAll('.nav-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === activeView);
    });
    if (activeView === 'trade') {
      resizeChart(); // 隐藏期间容器尺寸为 0，重新进页要重算画布
      // 分时与股东都是按需拉取的，进终端时确保当前股票的数据到位
      if (activeStockId) {
        loadHistory(activeStockId);
        loadHolders(activeStockId, true);
      }
      renderStockTabs();
      renderHeader();
      renderDepth();
      renderTape();
      renderPositions();
      renderHolders();
      renderLending();
      renderOrderPanel();
      renderRisk();
    } else {
      renderHome();
    }
  }

  function bindViewNav() {
    $('viewNav').querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });
    $('goTradeBtn').addEventListener('click', () => setView('trade'));
    $('goPositionBtn').addEventListener('click', () => {
      setView('trade');
      const tab = $('tabs').querySelector('[data-tab="position"]');
      if (tab) tab.click();
    });
  }

  // ---------- 数据 ----------
  function loadInitial() {
    apiGet('/api/state')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!s) {
          toast('状态加载失败', 'err');
          return;
        }
        onState(s);
        // 首屏要的分时按需拉：当前股票的完整序列 + 全市场降采样迷你走势
        ensureStock();
        loadHistory(activeStockId);
        loadSparks();
      })
      .catch(() => toast('状态加载失败', 'err'));
  }

  /** 交易终端选定的标的；没选过或已失效时落到第一只股票（指数也是合法选项） */
  function ensureStock() {
    const list = marketList();
    if (!list.length) return;
    const valid =
      list.some((m) => m.stockId === activeStockId) ||
      (state.index && state.index.stockId === activeStockId);
    if (!valid) {
      activeStockId = list[0].stockId;
      localStorage.setItem('gushen_stock', activeStockId);
    }
  }

  /** 拉某只股票的完整分时（首次切到该标的时用，之后靠 SSE 追加） */
  function loadHistory(stockId) {
    if (!stockId || histLoaded.has(stockId)) return;
    histLoaded.add(stockId);
    apiGet('/api/history?stock=' + encodeURIComponent(stockId))
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (!res || !res.ok) {
          histLoaded.delete(stockId); // 失败允许下次再试
          return;
        }
        // 服务端全量覆盖本地累积的点；期间新到的点（时间戳更晚）保序接在尾部，不丢帧
        const local = histories.get(stockId) || [];
        const merged = (res.priceHistory || []).slice();
        const lastT = merged.length ? merged[merged.length - 1].t : 0;
        for (const p of local) if (p.t > lastT) merged.push(p);
        histories.set(stockId, merged);
        if (stockId === activeStockId && activeView === 'trade') drawChart();
      })
      .catch(() => {
        histLoaded.delete(stockId);
      });
  }

  /** 拉全市场降采样迷你走势（主页行情列表用） */
  function loadSparks() {
    apiGet('/api/sparks')
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (!res || !res.ok) return;
        for (const [stockId, pts] of Object.entries(res.sparks || {})) {
          sparks.set(stockId, pts);
        }
        if (activeView === 'home') renderHome();
      })
      .catch(() => {});
  }

  function connectSSE() {
    if (es) es.close();
    es = new EventSource('/api/events?token=' + encodeURIComponent(token));
    es.addEventListener('state', (ev) => {
      try {
        onState(JSON.parse(ev.data));
      } catch (e) {
        /* ignore */
      }
    });
    es.onopen = () => $('connDot').classList.remove('off');
    es.onerror = () => $('connDot').classList.add('off');
  }

  /** 令牌失效（例如服务端重启）：用原名字重新登录一次 */
  function relogin() {
    if (relogging) return;
    relogging = true;
    apiPost('/api/login', { name: me })
      .then((r) => r.json())
      .then((res) => {
        relogging = false;
        if (res.ok) {
          setIdentity(res.name, res.token);
          toast('服务已重启，已自动重新登录', 'info');
          loadInitial();
          connectSSE();
          return;
        }
        // 名字不合法等：退回登录页
        toast(res.error || '登录状态已失效，请重新登录', 'err');
        setIdentity('', '');
        es && es.close();
        $('app').classList.add('hidden');
        $('loginOverlay').classList.remove('hidden');
      })
      .catch(() => {
        relogging = false;
      });
  }

  function onState(s) {
    const prev = state;

    // 服务端重启导致登录态丢失：自动重新登录一次
    if (s.account === null && me) {
      relogin();
      return;
    }

    state = s;
    lastStateAt = Date.now();
    $('connDot').classList.remove('off');
    ensureStock();

    // 每只股票按帧追加一个分时点（同时间戳去重）。SSE 帧本身不带分时，
    // 客户端自己往后累积；切股票时再用 /api/history 拉一次全量补历史
    for (const m of marketList()) {
      appendPoint(histories, m.stockId, s.serverTime, m.last, m.volume);
      appendPoint(sparks, m.stockId, s.serverTime, m.last, m.volume);
    }
    if (s.index) appendPoint(histories, s.index.stockId, s.serverTime, s.index.last, 0);

    renderHeader();
    renderStockTabs();
    renderHalt();
    renderDepth();
    renderTape();
    renderAssets();
    renderPositions();
    renderOrders();
    renderTrades();
    renderNews();
    renderHolders();
    renderLending();
    renderRank();
    renderAuto();
    renderOrderPanel();

    // 新消息提醒
    if (s.lastNews && s.lastNews.id !== lastNewsSeen) {
      if (lastNewsSeen !== null) {
        const tag = s.lastNews.stockName ? s.lastNews.stockName + '·' : '大盘·';
        toast(`【${tag}${s.lastNews.type}】${s.lastNews.text}`, s.lastNews.dir > 0 ? 'err' : 'info');
        if (activeTab !== 'news') {
          newsUnread += 1;
          updateBadges();
        }
      }
      lastNewsSeen = s.lastNews.id;
    }
    // 爆仓提醒
    const liqCount = s.account && s.account.liquidations ? s.account.liquidations.length : 0;
    if (prev && liqCount > lastLiquidations && liqCount > 0) {
      toast('触发强制平仓！请关注保证金风险', 'err');
    }
    lastLiquidations = liqCount;

    if (activeView === 'trade') {
      drawChart();
    } else {
      renderHome();
    }
  }

  /** 往某条序列尾部追加一个分时点（同时间戳覆盖，超长丢弃最旧的） */
  function appendPoint(map, stockId, t, price, vol) {
    let arr = map.get(stockId);
    if (!arr) {
      arr = [];
      map.set(stockId, arr);
    }
    const last = arr[arr.length - 1];
    if (!last || t > last.t) arr.push({ t, price, vol });
    else if (t === last.t) arr[arr.length - 1] = { t, price, vol };
    if (arr.length > 10300) arr.splice(0, arr.length - 10300);
  }

  // ---------- 顶栏 ----------
  function renderHeader() {
    const m = curMarket();
    if (!m) return;
    $('stockName').textContent = m.name;
    $('stockCode').textContent = m.stockId;
    const lp = $('lastPrice');
    lp.textContent = fmtP(m.last);
    lp.className = 'big-price ' + cls(m.change);
    const ch = $('priceChange');
    ch.textContent = `${m.change >= 0 ? '+' : ''}${fmtP(m.change)}  ${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}%`;
    ch.className = 'price-change ' + cls(m.change);
    $('stOpen').textContent = fmtP(m.open);
    $('stHigh').textContent = fmtP(m.high);
    $('stLow').textContent = fmtP(m.low);
    $('stPrev').textContent = fmtP(m.prevClose);
    $('stVol').textContent = fmtVol(m.volume);
    $('stAmount').textContent = fmtAmount(m.turnover);
    if (m.band) {
      $('bandStat').hidden = false;
      $('stBand').textContent = `${fmtP(m.band.down)} / ${fmtP(m.band.up)}`;
    } else {
      $('bandStat').hidden = true;
    }
    $('clock').textContent = fmtTime(state.serverTime);
    $('onlineCount').textContent = '在线 ' + (state.online || 0) + ' 人';
  }

  /**
   * 股票切换栏：10 只股票 + 指数各一个标签，每帧刷新报价。
   * 指数标签只读（不可下单），点它进「指数视图」看大盘分时与成分股。
   */
  function renderStockTabs() {
    const wrap = $('stockTabs');
    if (!wrap) return;
    const idx = state && state.index;
    const chips = marketList()
      .map((m) => {
        const on = m.stockId === activeStockId ? ' on' : '';
        return `<button class="stock-chip${on}" data-stock="${esc(m.stockId)}">
          <span class="sc-name">${esc(m.name)}</span>
          <span class="sc-last ${cls(m.change)}">${fmtP(m.last)}</span>
          <span class="sc-pct ${cls(m.change)}">${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}%</span>
        </button>`;
      })
      .join('');
    const idxChip = idx
      ? `<button class="stock-chip idx-chip${activeStockId === idx.stockId ? ' on' : ''}" data-stock="${esc(idx.stockId)}">
          <span class="sc-name">${esc(idx.name)}</span>
          <span class="sc-last ${cls(idx.change)}">${fmtP(idx.last)}</span>
          <span class="sc-pct ${cls(idx.change)}">${idx.changePct >= 0 ? '+' : ''}${idx.changePct.toFixed(2)}%</span>
        </button>`
      : '';
    wrap.innerHTML = chips + idxChip;
  }

  // ---------- 五档 ----------
  function renderDepth() {
    const m = curMarket();
    if (!m) return;
    const d = m.depth || { asks: [], bids: [] };
    const asks = (d.asks || []).slice().reverse(); // 卖5在上
    const bids = d.bids || [];
    let html = '';
    for (let i = 0; i < 5; i++) {
      html += depthRow('卖', 5 - i, asks[i], 'ask');
    }
    $('asksBody').innerHTML = html || emptyDepth('ask');
    html = '';
    for (let i = 0; i < 5; i++) html += depthRow('买', i + 1, bids[i], 'bid');
    $('bidsBody').innerHTML = html || emptyDepth('bid');

    const dl = $('depthLast');
    dl.textContent = fmtP(m.last);
    dl.className = cls(m.change);
    const dc = $('depthChange');
    dc.textContent = `${m.change >= 0 ? '+' : ''}${fmtP(m.change)} ${m.changePct.toFixed(2)}%`;
    dc.className = cls(m.change);
  }
  function depthRow(side, lv, d, clsName) {
    if (!d) {
      return `<tr class="${clsName}"><td class="lv">${side}${lv}</td><td class="px">--</td><td class="qty">--</td></tr>`;
    }
    return `<tr class="${clsName}"><td class="lv">${side}${lv}</td><td class="px">${fmtP(d.price)}</td><td class="qty">${fmtBookQty(d.qty)}</td></tr>`;
  }
  function emptyDepth() {
    return '<tr><td colspan="3" class="lv center">--</td></tr>';
  }

  // ---------- 逐笔 ----------
  function renderTape() {
    const m = curMarket();
    if (!m) return;
    const trades = m.trades || [];
    const rows = trades.slice(0, 40).map((t) => {
      const side = t.side === 'buy' ? 'B' : 'S';
      return `<div class="tape-row">
        <span class="time">${fmtTime(t.t)}</span>
        <span class="${cls(t.price - m.prevClose)}">${fmtP(t.price)}</span>
        <span>${fmtQty(t.qty)}</span>
        <span class="side-${side}">${side === 'B' ? '买' : '卖'}</span>
      </div>`;
    });
    $('tape').innerHTML = rows.join('') || '<div class="tape-row"><span class="time">暂无成交</span></div>';
  }

  // ---------- 资产 ----------
  /** 分钟息（百分数）→ 小数费率 */
  function minuteRateOf(kind) {
    const r = state.rules || {};
    if (kind === 'finance') {
      return r.finance && r.finance.enabled ? (Number(r.finance.minuteRate) || 0) / 100 : 0;
    }
    // 裸空不计息，与 accrueLendingInterest 的计息口径一致
    const m = curMarket();
    const L = m && m.lending;
    return L && L.enabled && !r.allowNakedShort ? (Number(L.minuteRate) || 0) / 100 : 0;
  }

  function renderAssets() {
    const a = state.account;
    if (!a) return;
    const floatPnl = (a.longPnl || 0) + (a.shortPnl || 0);
    // 做空欠息按股票汇总（各股的融券欠息分开记账）
    const lendDebt = (a.positions || []).reduce((s, p) => s + ((p.lending && p.lending.interestDebt) || 0), 0);
    // 做空已付息同样按股票汇总
    const lendPaid = (a.positions || []).reduce((s, p) => s + ((p.lending && p.lending.interestPaid) || 0), 0);
    const debtItem =
      a.financeDebt > 0
        ? `<div class="item"><label title="融资买入借入的资金（含未付利息与开仓手续费），按分钟计息，平仓/强平时优先从卖出款偿还">融资负债</label><span class="${cls(-1)}">${fmtMoney(a.financeDebt)}</span></div>`
        : '';
    const lendDebtItem =
      lendDebt > 0
        ? `<div class="item"><label title="现金与保证金都扣不动时挂账的融券利息，已从权益中扣除；现金恢复后自动补缴给出借方">做空欠息</label><span class="${cls(-1)}">${fmtMoney(lendDebt)}</span></div>`
        : '';
    // 融资负债拆两段：还没还的本金 / 已计但未还的利息（两者之和 = 融资负债）
    const finPrincipal = a.financePrincipal || 0;
    const finUnpaidInterest = Math.max(0, (a.financeDebt || 0) - finPrincipal);
    const finPrincipalItem =
      a.financeDebt > 0
        ? `<div class="item"><label title="融资买入借入的本金（含开仓手续费），平仓/强平时优先从卖出款偿还">融资本金</label><span class="down">${fmtMoney(finPrincipal)}</span></div>`
        : '';
    const finInterestItem =
      a.financeDebt > 0
        ? `<div class="item"><label title="融资负债里已计但还没还的利息（= 负债 − 本金）。累计已计息 ${fmtMoney(a.financeInterest || 0)}，含平仓时已随批次还掉的部分">融资已计息</label><span class="down">${fmtMoney(finUnpaidInterest)}</span></div>`
        : '';
    const paidInterestItem =
      lendPaid > 0
        ? `<div class="item"><label title="做空累计已付的融券利息（欠息部分见「做空欠息」）">做空已付息</label><span class="down">${fmtMoney(lendPaid)}</span></div>`
        : '';
    // 持仓利息：融资按负债基数、融券按空头市值，与服务端每 tick 的摊息口径一致
    const perMin =
      a.financeDebt * minuteRateOf('finance') + (a.shortValue || 0) * minuteRateOf('lend');
    const perMinItem =
      perMin > 0
        ? `<div class="item"><label title="当前持仓每分钟要付的利息：融资负债 × 融资分钟息 + 空头市值 × 融券分钟息">持仓利息</label><span class="down">${fmtMoney(perMin)}/分</span></div>`
        : '';
    $('assetsRow').innerHTML = `
      <div class="item"><label>总权益</label><span class="hl ${cls(a.equity - state.rules.initialCash)}">${fmtMoney(a.equity)}</span></div>
      <div class="item"><label title="现金口径，含融券卖出所得；开空后会大于总权益">可用资金</label><span>${fmtMoney(a.cash)}</span></div>
      <div class="item"><label>挂单冻结</label><span>${fmtMoney(a.orderFrozen)}</span></div>
      <div class="item"><label>空头保证金</label><span>${fmtMoney(a.shortMargin)}</span></div>
      <div class="item"><label>持仓市值</label><span>${fmtMoney(a.longValue || 0)}</span></div>
      ${debtItem}
      ${finPrincipalItem}
      ${finInterestItem}
      ${lendDebtItem}
      ${paidInterestItem}
      ${perMinItem}
      <div class="item"><label>浮动盈亏</label><span class="${cls(floatPnl)}">${(floatPnl >= 0 ? '+' : '') + fmtMoney(floatPnl)}</span></div>
      <div class="item"><label>已实现盈亏</label><span class="${cls(a.realizedPnL)}">${(a.realizedPnL >= 0 ? '+' : '') + fmtMoney(a.realizedPnL)}</span></div>
    `;
  }

  // ---------- 持仓 ----------
  /**
   * 持仓行 HTML（底部标签页与主页共用）。
   * 服务端 account.positions 已是「按股票切片」的数组，这里把每只股票的多头与空头
   * 各展开一行，因此多股票持仓自然排成多行。
   */
  function posRowsHtml() {
    const a = state.account;
    if (!a) return '';
    const rows = [];
    for (const p of a.positions || []) {
      if (p.long.qty > 0) {
        const avg = p.long.cost / p.long.qty;
        const lockedLot = p.long.lots.find((l) => l.lockedUntil > state.serverTime);
        const status = p.long.sellable <= 0
          ? '<span class="tag lock">锁仓中</span>'
          : lockedLot
            ? `<span class="tag ok">可卖 ${fmtQty(p.long.sellable)}</span>`
            : `<span class="tag ok">可卖 ${fmtQty(p.long.sellable)}</span>`;
        const debtTag =
          p.financeDebt > 0
            ? `<span class="tag warn" title="该股融资负债（含未付利息），平仓时从卖出款优先偿还">融资 ${fmtMoney(p.financeDebt)}</span>`
            : '';
        rows.push(`<tr class="row-long">
          <td>${esc(p.name)}<span class="sub-code">${esc(p.stockId)}</span></td>
          <td>多头持仓</td>
          <td>${fmtQty(p.long.qty)}</td>
          <td>${fmtQty(p.long.sellable)}</td>
          <td>${fmtP(avg)}</td>
          <td>${fmtP(p.last)}</td>
          <td>${fmtMoney(p.long.value)}</td>
          <td class="${cls(p.long.pnl)}">${(p.long.pnl >= 0 ? '+' : '') + fmtMoney(p.long.pnl)}</td>
          <td>${status} ${debtTag}</td>
        </tr>`);
      }
      if (p.short.qty > 0) {
        const avg = p.short.cost / p.short.qty;
        rows.push(`<tr class="row-short">
          <td>${esc(p.name)}<span class="sub-code">${esc(p.stockId)}</span></td>
          <td>空头持仓</td>
          <td>${fmtQty(p.short.qty)}</td>
          <td>${fmtQty(p.short.coverable)}</td>
          <td>${fmtP(avg)}</td>
          <td>${fmtP(p.last)}</td>
          <td>${fmtMoney(p.short.value)}</td>
          <td class="${cls(p.short.pnl)}">${(p.short.pnl >= 0 ? '+' : '') + fmtMoney(p.short.pnl)}</td>
          <td><span class="tag">保证金 ${fmtMoney(p.short.margin)}</span></td>
        </tr>`);
      }
    }
    return rows.join('');
  }

  function renderPositions() {
    $('posBody').innerHTML = posRowsHtml() || '<tr><td colspan="8" class="empty">暂无持仓</td></tr>';
  }

  // ---------- 委托 ----------
  function renderOrders() {
    const a = state.account;
    if (!a) return;
    const liveIds = new Set(a.orders.map((o) => o.id));
    const list = a.orderHistory.filter((o) => liveIds.has(o.id) || o.status !== 'live').slice(0, 50);
    const rows = list.map((o) => {
      const isLive = liveIds.has(o.id);
      const statusTag = isLive
        ? '<span class="tag live">挂单中</span>'
        : o.status === 'filled'
          ? '<span class="tag done">已成交</span>'
          : '<span class="tag done">已撤单</span>';
      const cancel = isLive ? `<button class="cancel-btn" data-cancel="${esc(o.id)}">撤单</button>` : '';
      const stockName = (marketOf(o.stockId) || {}).name || o.stockId || '';
      return `<tr>
        <td>${fmtTime(o.ts)}</td>
        <td>${esc(stockName)}</td>
        <td>${esc(ACTION_LABEL[o.action] || o.action)}</td>
        <td>${fmtP(o.price)}</td>
        <td>${fmtQty(o.qty)}</td>
        <td>${fmtQty(o.filled)}</td>
        <td>${statusTag}</td>
        <td>${cancel}</td>
      </tr>`;
    });
    $('ordersBody').innerHTML = rows.join('') || '<tr><td colspan="8" class="empty">暂无委托</td></tr>';
    $('ordersBody').querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => cancelOrder(btn.dataset.cancel));
    });
    const liveCount = a.orders.length;
    $('badgeOrders').hidden = liveCount === 0;
    $('badgeOrders').textContent = liveCount;
  }

  function cancelOrder(orderId) {
    apiPost('/api/cancel', { orderId })
      .then((r) => r.json())
      .then((res) => {
        toast(res.ok ? '已撤单' : res.error || '撤单失败', res.ok ? 'ok' : 'err');
      })
      .catch(() => toast('网络异常', 'err'));
  }

  // ---------- 成交 ----------
  function renderTrades() {
    const a = state.account;
    if (!a) return;
    const rows = a.trades.map((t) => {
      const dir = t.action === 'buy_open' || t.action === 'buy_close' ? 'buy' : 'sell';
      const stockName = (marketOf(t.stockId) || {}).name || t.stockId || '';
      return `<tr>
        <td>${fmtTime(t.t)}</td>
        <td>${esc(stockName)}</td>
        <td class="${dir === 'buy' ? 'up' : 'down'}">${esc(ACTION_LABEL[t.action] || t.action)}</td>
        <td>${fmtP(t.price)}</td>
        <td>${fmtQty(t.qty)}</td>
        <td>${fmtMoney(t.price * t.qty)}</td>
      </tr>`;
    });
    $('tradesBody').innerHTML = rows.join('') || '<tr><td colspan="6" class="empty">暂无成交</td></tr>';
  }

  // ---------- 消息 ----------
  /** 消息所属标的的显示名：大盘消息没有 stockId */
  const newsTag = (n) =>
    n.stockId ? `<span class="nstock">${esc(n.stockName || n.stockId)}</span>` : '<span class="nstock idx">大盘</span>';

  /** 消息过滤：全部 / 大盘 / 当前股票 */
  function filterNews(items) {
    if (newsFilter === 'index') return items.filter((n) => !n.stockId);
    if (newsFilter === 'active') {
      const sid = curMarket() ? curMarket().stockId : '';
      return items.filter((n) => !n.stockId || n.stockId === sid);
    }
    return items;
  }

  function newsRowsHtml(items, limit) {
    const list = filterNews(items || []).slice(0, limit || undefined);
    return list
      .map(
        (n) => `<li class="${n.dir > 0 ? 'npos' : 'nneg'}">
            <span class="ntime">${fmtTime(n.t)}</span>
            <span class="ntype">${esc(n.type)}</span>
            ${newsTag(n)}
            <span class="ntext">${esc(n.text)}</span>
          </li>`
      )
      .join('');
  }

  function renderNews() {
    const items = state.news || [];
    $('newsList').innerHTML = newsRowsHtml(items) || '<li class="empty">暂无消息</li>';
  }

  // ---------- 前十大股东 ----------
  const ROLE_LABEL = {
    inst: '机构',
    hot: '游资',
    big: '大户',
    mid: '中户',
    small: '散户',
    retail: '散户',
    player: '玩家',
    npc: '投资者',
  };
  const ROLE_CLS = {
    inst: 'role-inst',
    hot: 'role-hot',
    big: 'role-big',
    mid: 'role-mid',
    small: 'role-retail',
    retail: 'role-retail',
    player: 'role-player',
  };
  const HOLDER_ACTION_LABEL = {
    login: '登录',
    order: '下单',
    cancel: '撤单',
    lend: '挂借',
    unlend: '撤借',
  };

  /**
   * 变动单元格：股数变化在上（精确、可核对），占比变化在下（1pp = 流通盘的 1%）。
   * dPct/dQty 为 null 表示算不出——hasSnap=false 是还没操作过，否则是该股东当时未进前 30 名
   */
  function deltaCell(dQty, dPct, hasSnap) {
    if (dPct == null || dQty == null) {
      return hasSnap
        ? '<span class="delta-new">新进</span>'
        : '<span class="flat">--</span>';
    }
    const sign = dQty > 0 ? '+' : '';
    return `<span class="${cls(dQty)}">${sign}${fmtQty(dQty)} 股</span><span class="delta-sub ${cls(dPct)}">${dPct > 0 ? '+' : ''}${dPct.toFixed(2)}pp</span>`;
  }

  function renderHolders() {
    // 股东榜按需拉取：10 只股票 × 前 30 名每帧全推会把 SSE 帧撑爆。
    // 进 tab / 切股票时拉一次，前台每 5 秒刷新（见 tickUI）
    const sid = (curMarket() || {}).stockId;
    const data = holdersData && holdersStockId === sid ? holdersData : null;
    const rows = (data && data.rows) || [];
    const stock = marketList().find((m) => m.stockId === sid);
    const float = (stock && stock.floatShares) || 1;
    const sumQty = rows.reduce((s, h) => s + h.qty, 0);
    const myRow = rows.find((h) => h.name === me);
    const snap = data && data.holderSnapshot;
    $('holdersMeta').innerHTML = `
      <div class="item"><label>标的</label><span>${esc((stock && stock.name) || '--')}</span></div>
      <div class="item"><label>流通盘</label><span>${fmtQty(float)} 股</span></div>
      <div class="item"><label>前十大合计</label><span>${((sumQty / float) * 100).toFixed(2)}%</span></div>
      <div class="item"><label>我的排名</label><span>${myRow ? '第 ' + (rows.indexOf(myRow) + 1) + ' 名' : '未进前十'}</span></div>
      <div class="item"><label>我的持股</label><span>${myRow ? fmtQty(myRow.qty) + ' 股（' + myRow.pct.toFixed(2) + '%）' : '--'}</span></div>
      <div class="item"><label>上次操作快照</label><span>${
        snap && snap.t
          ? `${fmtTime(snap.t)}（${HOLDER_ACTION_LABEL[snap.action] || snap.action}）· ${snap.count}/${snap.limit} 次`
          : '暂无，登录后自动记录'
      }</span></div>
    `;
    $('holdersBody').innerHTML =
      rows
        .map((h, i) => {
          const mine = h.name === me;
          const roleCls = ROLE_CLS[h.role] || 'role-retail';
          const openCell = `<span class="${cls(h.change)}">${h.change > 0 ? '+' : ''}${fmtQty(h.change)} 股</span><span class="delta-sub ${cls(h.changePct)}">${h.changePct > 0 ? '+' : ''}${h.changePct.toFixed(2)}pp</span>`;
          return `<tr${mine ? ' class="row-mine"' : ''} data-holder="${esc(h.name)}">
            <td>${i + 1}</td>
            <td>${esc(h.name)}${mine ? '（我）' : ''}</td>
            <td><span class="tag ${roleCls}">${esc(ROLE_LABEL[h.role] || h.role)}</span></td>
            <td>${fmtQty(h.qty)}</td>
            <td>${h.pct.toFixed(2)}%</td>
            <td class="delta-cell">${openCell}</td>
            <td class="delta-cell">${deltaCell(h.dQty, h.dPct, !!snap)}</td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="7" class="empty">暂无数据</td></tr>';

    // 弹窗开着时，服务端又快照了一次（我刚操作过）就顺手刷新，免得看的是旧曲线
    if (holderHistName && !holderFetching) {
      const mine = holderHist && holderHist.snapshots;
      const lastT = mine && mine.length ? mine[mine.length - 1].t : 0;
      if (snap && snap.t && snap.t !== lastT) loadHolderHistory(holderHistName);
    }
  }

  /** 拉某只股票的前十大股东（进 tab / 切股票时强制拉，前台每 5 秒静默刷新） */
  function loadHolders(stockId, force) {
    if (!stockId) return;
    if (!force && holdersStockId === stockId && Date.now() - holdersAt < 4000) return;
    apiGet('/api/holders?stock=' + encodeURIComponent(stockId))
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (!res || !res.ok) return;
        // 期间用户可能已切走，丢弃过期响应
        if (res.stockId !== (curMarket() || {}).stockId) return;
        holdersData = res;
        holdersStockId = res.stockId;
        holdersAt = Date.now();
        renderHolders();
      })
      .catch(() => {});
  }

  // ---------- 股东占比走势弹窗 ----------
  function openHolderChart(name) {
    holderHistName = name;
    holderHist = null;
    $('holderTitle').textContent = name + ' · 占比走势';
    $('holderSub').textContent = '正在读取…';
    $('holderActions').innerHTML = '';
    $('holderOverlay').classList.remove('hidden');
    drawHolderHistory();
    loadHolderHistory(name);
  }

  function closeHolderChart() {
    $('holderOverlay').classList.add('hidden');
    holderHistName = '';
    holderHist = null;
  }

  function loadHolderHistory(name) {
    holderFetching = true;
    const sid = (curMarket() || {}).stockId || '';
    apiGet('/api/holders/history?stock=' + encodeURIComponent(sid))
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) {
          toast(res.error || '读取股东走势失败', 'err');
          return;
        }
        holderHist = res;
        if (holderHistName === name) drawHolderHistory();
      })
      .catch(() => toast('网络错误', 'err'))
      .then(() => {
        holderFetching = false;
      });
  }

  /** 该股东在各次操作快照里的持股与占比；不在快照里（当时未进前 30）的点记为 null */
  function holderSeries(name) {
    const list = (holderHist && holderHist.snapshots) || [];
    return list.map((s) => {
      const r = (s.rows || []).find((x) => x.name === name) || null;
      return { t: s.t, action: s.action, qty: r ? r.qty : null, pct: r ? r.pct : null };
    });
  }

  function drawHolderHistory() {
    const canvas = $('holderChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pts = holderSeries(holderHistName);
    const known = pts.filter((p) => p.pct != null);

    // 底部操作流水：时间 / 动作 / 占比 / 较上次的变动
    $('holderActions').innerHTML =
      pts.length === 0
        ? '<div class="ha-empty">还没有快照，登录或下单后开始记录</div>'
        : pts
            .slice()
            .reverse()
            .map((p, i, arr) => {
              const prev = arr[i + 1] || null;
              const d = p.pct != null && prev && prev.pct != null ? p.pct - prev.pct : null;
              const n = arr.length - 1 - i;
              return `<div class="ha-row">
                <span class="ha-time">${fmtTime(p.t)}</span>
                <span class="ha-act">${esc(HOLDER_ACTION_LABEL[p.action] || p.action || '')}</span>
                <span class="ha-pct">${p.pct == null ? '--' : p.pct.toFixed(2) + '%'}</span>
                <span class="ha-delta ${d == null ? 'flat' : cls(d)}">${d == null ? '--' : (d > 0 ? '+' : '') + d.toFixed(2) + 'pp'}</span>
                <span class="ha-qty">${p.qty == null ? '未进前 30' : fmtQty(p.qty) + ' 股'}</span>
                <span class="ha-qty">第 ${n + 1} 次</span>
              </div>`;
            })
            .join('');

    $('holderSub').textContent = known.length
      ? `最近 ${pts.length} 次操作 · 当前 ${known[known.length - 1].pct.toFixed(2)}%` +
        (known.length < pts.length ? '（有 ' + (pts.length - known.length) + ' 次未进前 30 名）' : '')
      : '最近 ' + pts.length + ' 次操作 · 该股东未出现在快照前 30 名内';

    const pad = { l: 54, r: 14, t: 14, b: 24 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;

    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + (ih * i) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(W - pad.r, y);
      ctx.stroke();
    }

    if (known.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(pts.length ? '该股东未进过快照前 30 名' : '暂无快照，登录或下单后开始记录', W / 2, H / 2);
      return;
    }

    // 纵轴按占比定范围，单点或全平时给一点上下留白
    let lo = Math.min(...known.map((p) => p.pct));
    let hi = Math.max(...known.map((p) => p.pct));
    if (hi - lo < 0.02) {
      const mid = (hi + lo) / 2;
      lo = Math.max(0, mid - 0.01);
      hi = mid + 0.01;
    }
    const span = hi - lo;
    const xAt = (i) => (pts.length === 1 ? pad.l + iw / 2 : pad.l + (iw * i) / (pts.length - 1));
    const yAt = (p) => pad.t + ih - ((p - lo) / span) * ih;

    // 折线：缺失点断开，不臆造连续
    let started = false;
    ctx.beginPath();
    pts.forEach((p, i) => {
      if (p.pct == null) {
        started = false;
        return;
      }
      const x = xAt(i);
      const y = yAt(p.pct);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = '#5b9cff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 数据点 + 末点标注
    let lastIdx = -1;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (pts[i].pct != null) {
        lastIdx = i;
        break;
      }
    }
    pts.forEach((p, i) => {
      if (p.pct == null) return;
      ctx.beginPath();
      ctx.arc(xAt(i), yAt(p.pct), i === lastIdx ? 3.2 : 2.2, 0, Math.PI * 2);
      ctx.fillStyle = i === lastIdx ? '#f0b429' : '#5b9cff';
      ctx.fill();
    });

    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.textAlign = 'right';
    ctx.fillText(hi.toFixed(2) + '%', pad.l - 6, pad.t + 8);
    ctx.fillText(((hi + lo) / 2).toFixed(2) + '%', pad.l - 6, pad.t + ih / 2 + 4);
    ctx.fillText(lo.toFixed(2) + '%', pad.l - 6, pad.t + ih);
    ctx.textAlign = 'left';
    ctx.fillText(fmtTime(pts[0].t), pad.l, H - 7);
    if (pts.length > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(fmtTime(pts[pts.length - 1].t), W - pad.r, H - 7);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f0b429';
    const lp = pts[lastIdx];
    ctx.fillText(
      lp.pct.toFixed(2) + '%',
      Math.min(xAt(lastIdx) + 6, W - pad.r - 34),
      Math.max(pad.t + 10, yAt(lp.pct) - 6)
    );
  }

  function bindHolders() {
    // 表格每帧重写 innerHTML，事件挂在容器上做代理
    $('holdersBody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-holder]');
      if (tr) openHolderChart(tr.dataset.holder);
    });
    $('holderCloseBtn').addEventListener('click', closeHolderChart);
    $('holderOverlay').addEventListener('click', (e) => {
      if (e.target === $('holderOverlay')) closeHolderChart();
    });
  }

  // ---------- 融券池 ----------
  function renderLending() {
    const m = curMarket();
    const L = (m && m.lending) || null;
    if (!L || !L.enabled) {
      $('lendingMeta').innerHTML = '<div class="item"><label>融券</label><span>未开放</span></div>';
      $('lendingMine').textContent = '';
      return;
    }
    const float = m.floatShares || 1;
    const shortPct = ((L.shortInterest / float) * 100).toFixed(2);
    $('lendingMeta').innerHTML = `
      <div class="item"><label>标的</label><span>${esc(m.name)}</span></div>
      <div class="item"><label>可借券源</label><span>${fmtQty(L.available)} 股</span></div>
      <div class="item"><label>总挂借</label><span>${fmtQty(L.total)} 股</span></div>
      <div class="item"><label>已借出</label><span>${fmtQty(L.borrowed)} 股</span></div>
      <div class="item"><label>空头总持仓</label><span>${fmtQty(L.shortInterest)} 股（${shortPct}%）</span></div>
      <div class="item"><label>当前分钟息</label><span class="${L.minuteRate > 0.03 ? 'down' : L.minuteRate > 0.015 ? '' : 'up'}">${L.minuteRate.toFixed(2)}%</span></div>
      <div class="item"><label>池子紧张度</label><span>${L.utilization.toFixed(1)}%</span></div>
      <div class="item"><label>做空模式</label><span>${L.allowNakedShort ? '裸空（不借券）' : '融券（必须借券）'}</span></div>
    `;

    // 我的挂借按当前股票取（服务端 account.positions[].lending 已按股票切好）
    const pos = curPosition();
    const mine = (pos && pos.lending) || null;
    if (mine) {
      $('myLendSub').textContent = `可挂借 ${fmtQty(mine.freeToLend)} 股 · 分钟息 ${L.minuteRate.toFixed(2)}%（≈日息 ${(L.minuteRate * 1440).toFixed(1)}%）`;
      $('lendingMine').innerHTML = `
        <div class="item"><label>已挂借</label><span>${fmtQty(mine.offered)} 股</span></div>
        <div class="item"><label>被借走</label><span>${fmtQty(mine.lentOut)} 股</span></div>
        <div class="item"><label>可撤回</label><span>${fmtQty(mine.removable)} 股</span></div>
        <div class="item"><label>累计利息收入</label><span class="up">+${fmtMoney(mine.interestEarned)}</span></div>
        ${mine.interestPaid > 0 ? `<div class="item"><label>（做空已付息）</label><span class="down">${fmtMoney(mine.interestPaid)}</span></div>` : ''}
        ${mine.interestDebt > 0 ? `<div class="item"><label>（做空欠息）</label><span class="down">${fmtMoney(mine.interestDebt)}</span></div>` : ''}
      `;
      $('lendLotHint').textContent = '可挂 ' + fmtQty(mine.freeToLend);
    } else {
      $('myLendSub').textContent = '';
      $('lendingMine').textContent = '';
      $('lendLotHint').textContent = '';
    }

    drawShortHistory(L.history || []);
  }

  /** 空头仓位变化：5 分钟采样的简单折线 */
  function drawShortHistory(hist) {
    const canvas = $('shortHistChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pad = { l: 48, r: 12, t: 12, b: 22 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;

    // 背景网格
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + (ih * i) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(W - pad.r, y);
      ctx.stroke();
    }

    if (!hist || hist.length < 2) {
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(hist && hist.length === 1 ? '采样中…（每 5 分钟一点）' : '暂无空头仓位采样', W / 2, H / 2);
      return;
    }

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of hist) {
      if (p.qty < lo) lo = p.qty;
      if (p.qty > hi) hi = p.qty;
    }
    if (hi === lo) {
      hi += 1;
      lo = Math.max(0, lo - 1);
    }
    const xAt = (i) => pad.l + (iw * i) / (hist.length - 1);
    const yAt = (q) => pad.t + ih - ((q - lo) / (hi - lo)) * ih;

    // 面积 + 折线
    ctx.beginPath();
    hist.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.qty);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#5b9cff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(xAt(hist.length - 1), pad.t + ih);
    ctx.lineTo(xAt(0), pad.t + ih);
    ctx.closePath();
    ctx.fillStyle = 'rgba(91,156,255,.12)';
    ctx.fill();

    // 轴标
    ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fmtQty(hi), pad.l - 4, pad.t + 8);
    ctx.fillText(fmtQty(lo), pad.l - 4, pad.t + ih);
    const t0 = new Date(hist[0].t);
    const t1 = new Date(hist[hist.length - 1].t);
    const hm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    ctx.textAlign = 'left';
    ctx.fillText(hm(t0), pad.l, H - 6);
    ctx.textAlign = 'right';
    ctx.fillText(hm(t1), W - pad.r, H - 6);
  }

  // 挂借 / 撤借操作（都带当前股票的 stockId：融券池是按股票隔离的）
  function bindLending() {
    const lot = () => (state && state.rules ? state.rules.lotSize : 100);
    const myLend = () => {
      const pos = curPosition();
      return (pos && pos.lending) || null;
    };
    const parseQty = () => {
      const n = parseInt($('lendQtyInput').value, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const post = (op, qty, okText) => {
      const m = curMarket();
      apiPost('/api/lend', { op, qty, stockId: m ? m.stockId : undefined })
        .then((r) => r.json())
        .then((res) => {
          if (!res.ok) toast(res.error || (op === 'lend' ? '挂借失败' : '撤回失败'), 'err');
          else toast(`${okText} ${fmtQty(res.qty)} 股`, 'ok');
        })
        .catch(() => toast('网络错误', 'err'));
    };
    $('lendAllBtn').addEventListener('click', () => {
      const mine = myLend();
      $('lendQtyInput').value = mine ? mine.freeToLend : 0;
    });
    $('lendHalfBtn').addEventListener('click', () => {
      const mine = myLend();
      const half = mine ? Math.floor(mine.freeToLend / 2 / lot()) * lot() : 0;
      $('lendQtyInput').value = half;
    });
    $('unlendAllBtn').addEventListener('click', () => {
      const mine = myLend();
      $('lendQtyInput').value = mine ? mine.removable : 0;
    });
    $('lendBtn').addEventListener('click', () => {
      const qty = parseQty();
      if (qty <= 0) return toast('请输入挂借数量', 'err');
      post('lend', qty, '已挂借');
    });
    $('unlendBtn').addEventListener('click', () => {
      const qty = parseQty();
      if (qty <= 0) return toast('请输入撤回数量', 'err');
      post('unlend', qty, '已撤回');
    });
  }

  // ---------- 排行 ----------
  /** 排行行 HTML（主页只取前几行） */
  function rankRowsHtml(limit) {
    const rows = (state.players || []).slice(0, limit || undefined);
    return rows
      .map((p, i) => {
        const mine = p.name === me;
        return `<tr${mine ? ' class="row-mine"' : ''}>
          <td>${i + 1}</td>
          <td>${esc(p.name)}${mine ? '（我）' : ''}</td>
          <td class="${cls(p.equity - state.rules.initialCash)}">${fmtMoney(p.equity)}</td>
        </tr>`;
      })
      .join('');
  }

  function renderRank() {
    $('rankBody').innerHTML = rankRowsHtml() || '<tr><td colspan="3" class="empty">暂无玩家</td></tr>';
  }

  // ---------- 主页：交易大厅 ----------
  const HOME_RANK_LIMIT = 5;
  const HOME_NEWS_LIMIT = 4;

  /**
   * 迷你走势用内联 SVG 而不是 canvas：行情列表每秒整块重建，
   * canvas 会被反复销毁重建，SVG 只是普通标记，重建没有副作用。
   */
  function sparkSvg(pts, color) {
    if (!pts || pts.length < 2) return '';
    const W = 96;
    const H = 26;
    const PAD = 2;
    // 已有降采样序列（/api/sparks），这里再压到 ~48 点就够画迷你图了
    const step = Math.max(1, Math.ceil(pts.length / 48));
    const sp = [];
    for (let i = 0; i < pts.length; i += step) sp.push(pts[i]);
    if (sp[sp.length - 1] !== pts[pts.length - 1]) sp.push(pts[pts.length - 1]);
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of sp) {
      if (p.price < lo) lo = p.price;
      if (p.price > hi) hi = p.price;
    }
    if (hi === lo) {
      hi += 0.01;
      lo -= 0.01;
    }
    const n = sp.length;
    const x = (i) => (PAD + (i / (n - 1)) * (W - PAD * 2)).toFixed(1);
    const y = (p) => (PAD + ((hi - p) / (hi - lo)) * (H - PAD * 2)).toFixed(1);
    const line = sp.map((p, i) => x(i) + ',' + y(p.price)).join(' ');
    const area = x(0) + ',' + (H - PAD) + ' ' + line + ' ' + x(n - 1) + ',' + (H - PAD);
    return (
      `<svg class="row-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      `<polygon points="${area}" fill="${color}" fill-opacity="0.14"/>` +
      `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.2"` +
      ` stroke-linejoin="round" stroke-linecap="round"/>` +
      `</svg>`
    );
  }

  /**
   * 把账户持仓摊平成「股票 × 方向」列表。
   * 服务端 account.positions 是「按股票切片」的数组，每片自带 stockId/名称/现价。
   */
  function positionsOf(a, markets) {
    if (!a || !Array.isArray(a.positions)) return [];
    const rows = [];
    for (const p of a.positions) {
      const stock = markets.find((m) => m.stockId === p.stockId) || { stockId: p.stockId, name: p.name, last: p.last };
      if (p.long.qty > 0) {
        rows.push({
          stock, side: 'long', label: '多头', rowCls: 'row-long',
          qty: p.long.qty, closable: p.long.sellable,
          avg: p.long.cost / p.long.qty, value: p.long.value, pnl: p.long.pnl,
          margin: 0,
        });
      }
      if (p.short.qty > 0) {
        rows.push({
          stock, side: 'short', label: '空头', rowCls: 'row-short',
          qty: p.short.qty, closable: p.short.coverable,
          avg: p.short.cost / p.short.qty, value: p.short.value, pnl: p.short.pnl,
          margin: p.short.margin,
        });
      }
    }
    return rows;
  }

  /** 大盘指数卡：点位 / 涨跌 / 迷你走势 / 成分股涨跌家数 */
  function renderIndexCard() {
    const el = $('homeIndex');
    const idx = state && state.index;
    if (!el) return;
    if (!idx) {
      el.innerHTML = '';
      return;
    }
    const c = cls(idx.change);
    const spark = sparkSvg(sparks.get(idx.stockId) || [], idx.change >= 0 ? '#f0464b' : '#1fb978');
    const comps = idx.components || [];
    const up = comps.filter((x) => x.changePct > 0).length;
    const down = comps.filter((x) => x.changePct < 0).length;
    el.className = 'panel home-card span-3 index-card';
    el.innerHTML = `
      <div class="idx-left">
        <div class="idx-name">${esc(idx.name)}<span class="idx-code">${esc(idx.stockId)}</span></div>
        <div class="idx-points ${c}">${fmtP(idx.last)}</div>
        <div class="idx-change ${c}">${idx.change >= 0 ? '+' : ''}${fmtP(idx.change)}　${idx.changePct >= 0 ? '+' : ''}${idx.changePct.toFixed(2)}%</div>
      </div>
      <div class="idx-spark">${spark}</div>
      <div class="idx-stat">
        <div class="mcell"><label>成分</label><span>${comps.length}</span></div>
        <div class="mcell"><label>上涨</label><span class="up">${up}</span></div>
        <div class="mcell"><label>下跌</label><span class="down">${down}</span></div>
        <div class="mcell"><label>成交额</label><span>${fmtAmount(idx.turnover)}</span></div>
      </div>
      <div class="idx-hint">点击查看大盘分时与成分股</div>
    `;
  }

  function renderHome() {
    const a = state && state.account;
    if (!a) return;
    const markets = marketList(state);
    const players = state.players || [];
    const myIdx = players.findIndex((p) => p.name === me);
    const pnl = (a.longPnl || 0) + (a.shortPnl || 0);
    const pos = positionsOf(a, markets);
    const heldStocks = new Set(pos.map((r) => r.stock.stockId)).size;
    const money = (v) => (v >= 0 ? '+' : '-') + '¥' + fmtMoney(Math.abs(v));

    $('homeName').textContent = me;
    // 加钱按钮跟随服务端开关（config.account.deposit.enabled）
    $('addCashBtn').hidden = !(state.rules.deposit && state.rules.deposit.enabled);

    renderIndexCard();

    // 市场概览：全部按市场维度统计，与任何单只股票解耦
    let up = 0;
    let down = 0;
    let flat = 0;
    let turnover = 0;
    let volume = 0;
    for (const m of markets) {
      if (m.change > 0) up += 1;
      else if (m.change < 0) down += 1;
      else flat += 1;
      turnover += m.turnover || 0;
      volume += m.volume || 0;
    }
    $('homeMarketStats').innerHTML = `
      <div class="mcell"><label>上市股票</label><span>${markets.length}</span></div>
      <div class="mcell"><label>上涨</label><span class="up">${up}</span></div>
      <div class="mcell"><label>下跌</label><span class="down">${down}</span></div>
      <div class="mcell"><label>平盘</label><span>${flat}</span></div>
    `;
    $('homeMarketSub').innerHTML =
      `总成交额 <b>${fmtAmount(turnover)}</b> · 总成交量 <b>${fmtVol(volume)}</b><br>` +
      `在线 <b>${state.online || 0}</b> 人 · 共 <b>${players.length}</b> 位玩家`;

    $('homeSub').innerHTML = [
      `收益排名 ${myIdx >= 0 ? `第 <b>${myIdx + 1}</b> / ${players.length} 名` : `共 <b>${players.length}</b> 位玩家`}`,
      `总权益 <b class="${cls(a.equity - state.rules.initialCash)}">¥${fmtMoney(a.equity)}</b>`,
      `持仓 <b>${heldStocks}</b> 只`,
      `挂单 <b>${a.orders.length}</b> 笔`,
    ].join('<span class="sep">·</span>');

    // 行情列表：一行一只股票，点击进入该股票的交易终端
    const idx = state.index;
    $('homeQuoteSub').textContent = markets.length ? `共 ${markets.length} 只 · 点击行进入交易` : '';
    const idxRow = idx
      ? `<tr class="quote-row idx-row" data-stock="${esc(idx.stockId)}">
            <td class="q-code">${esc(idx.stockId)}</td>
            <td class="q-name">${esc(idx.name)}<span class="idx-badge">指数</span></td>
            <td>${sparkSvg(sparks.get(idx.stockId) || [], idx.change >= 0 ? '#f0464b' : '#1fb978')}</td>
            <td class="q-last ${cls(idx.change)}">${fmtP(idx.last)}</td>
            <td class="${cls(idx.change)}">${idx.change >= 0 ? '+' : ''}${fmtP(idx.change)}</td>
            <td class="${cls(idx.change)}">${idx.changePct >= 0 ? '+' : ''}${idx.changePct.toFixed(2)}%</td>
            <td>${fmtVol(idx.volume)}</td>
            <td>${fmtAmount(idx.turnover)}</td>
            <td class="q-act">查看</td>
          </tr>`
      : '';
    $('homeQuoteBody').innerHTML =
      idxRow +
      (markets
        .map((m) => {
          const c = cls(m.change);
          const spark = sparkSvg(sparks.get(m.stockId) || [], m.change >= 0 ? '#f0464b' : '#1fb978');
          return `<tr class="quote-row" data-stock="${esc(m.stockId)}">
            <td class="q-code">${esc(m.stockId)}</td>
            <td class="q-name">${esc(m.name)}</td>
            <td>${spark}</td>
            <td class="q-last ${c}">${fmtP(m.last)}</td>
            <td class="${c}">${m.change >= 0 ? '+' : ''}${fmtP(m.change)}</td>
            <td class="${c}">${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}%</td>
            <td>${fmtVol(m.volume)}</td>
            <td>${fmtAmount(m.turnover)}</td>
            <td class="q-act">交易</td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="9" class="empty">暂无行情</td></tr>');

    $('homeAssets').innerHTML = `
      <div class="cell hero-cell"><label>总权益</label><span class="${cls(a.equity - state.rules.initialCash)}">¥${fmtMoney(a.equity)}</span></div>
      <div class="cell"><label title="现金口径，含融券卖出所得；开空后会大于总权益">可用资金</label><span>¥${fmtMoney(a.cash)}</span></div>
      <div class="cell"><label>浮动盈亏</label><span class="${cls(pnl)}">${money(pnl)}</span></div>
      <div class="cell"><label>已实现盈亏</label><span class="${cls(a.realizedPnL)}">${money(a.realizedPnL)}</span></div>
      <div class="cell"><label>持仓市值</label><span>¥${fmtMoney(a.longValue || 0)}</span></div>
      <div class="cell"><label>空头保证金</label><span>¥${fmtMoney(a.shortMargin)}</span></div>
    `;

    // 持仓：按「股票 × 方向」展开，多股票时自然排成多行
    $('homePosSub').innerHTML = pos.length
      ? `共 ${heldStocks} 只 · 浮动盈亏 <span class="${cls(pnl)}">${money(pnl)}</span>`
      : '';
    $('homePosBody').innerHTML =
      pos
        .map((r) => {
          const status = r.side === 'long'
            ? r.closable > 0
              ? `<span class="tag ok">可平 ${fmtQty(r.closable)}</span>`
              : '<span class="tag lock">锁仓中</span>'
            : `<span class="tag">保证金 ${fmtMoney(r.margin)}</span>`;
          return `<tr class="${r.rowCls}" data-stock="${esc(r.stock.stockId)}">
            <td>${esc(r.stock.name)}<span class="sub-code">${esc(r.stock.stockId)}</span></td>
            <td>${r.label}</td>
            <td>${fmtQty(r.qty)}</td>
            <td>${fmtQty(r.closable)}</td>
            <td>${fmtP(r.avg)}</td>
            <td>${fmtP(r.stock.last)}</td>
            <td>${fmtMoney(r.value)}</td>
            <td class="${cls(r.pnl)}">${(r.pnl >= 0 ? '+' : '') + fmtMoney(r.pnl)}</td>
            <td>${status}</td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="9" class="empty">暂无持仓</td></tr>';

    $('homeRankSub').textContent = myIdx >= 0 ? `我第 ${myIdx + 1} 名` : `共 ${players.length} 人`;
    $('homeRankBody').innerHTML =
      rankRowsHtml(HOME_RANK_LIMIT) || '<tr><td colspan="3" class="empty">暂无玩家</td></tr>';

    const news = filterNews(state.news || []).slice(0, HOME_NEWS_LIMIT);
    $('homeNewsSub').textContent = (state.news || []).length ? `最近 ${news.length} 条` : '';
    $('homeNews').innerHTML = newsRowsHtml(news) || '<li class="empty">暂无消息</li>';
  }

  function bindHome() {
    // 行情列表每秒整块重建，事件委托挂在容器上才不会随重建失效。
    // 点哪一行就进哪只股票的交易终端；点指数行进指数视图
    $('homeQuoteBody').addEventListener('click', (e) => {
      const tr = e.target.closest('.quote-row');
      if (!tr) return;
      openStock(tr.dataset.stock);
    });
    // 持仓行也能直接跳到那只股票
    $('homePosBody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-stock]');
      if (!tr) return;
      openStock(tr.dataset.stock);
    });
    const idxCard = $('homeIndex');
    if (idxCard) {
      idxCard.addEventListener('click', () => {
        if (state && state.index) openStock(state.index.stockId);
      });
    }
  }

  /** 进入某只股票（或指数）的交易终端 */
  function openStock(stockId) {
    if (!stockId) return;
    const changed = stockId !== activeStockId;
    activeStockId = stockId;
    localStorage.setItem('gushen_stock', stockId);
    if (changed) {
      loadHistory(stockId);
      loadHolders(stockId, true);
    }
    setView('trade');
    renderStockTabs();
    renderHeader();
    renderDepth();
    renderTape();
    renderOrderPanel();
    renderPositions();
    renderHolders();
    renderLending();
    drawChart();
  }

  /** 股票切换栏的点击：直接切当前终端看的股票（不跳视图） */
  function bindStockTabs() {
    const wrap = $('stockTabs');
    if (!wrap) return;
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.stock-chip');
      if (!btn) return;
      const sid = btn.dataset.stock;
      if (!sid) return;
      if (activeView !== 'trade') {
        openStock(sid);
        return;
      }
      setActiveStock(sid);
    });
  }

  /** 消息过滤按钮 */
  function bindNewsFilter() {
    const wrap = $('newsFilter');
    if (!wrap) return;
    wrap.querySelectorAll('.mini-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        newsFilter = btn.dataset.nf;
        wrap.querySelectorAll('.mini-btn').forEach((b) => b.classList.toggle('active', b === btn));
        renderNews();
      });
    });
  }

  // ---------- 加钱 ----------
  const depositRules = () => (state && state.rules && state.rules.deposit) || null;

  // 快捷金额：整万/整亿给口语化标签，其余照原数
  function amtLabel(v) {
    v = Number(v) || 0;
    if (v >= 1e8 && v % 1e8 === 0) return v / 1e8 + '亿';
    if (v >= 1e4 && v % 1e4 === 0) return v / 1e4 + '万';
    return fmtQty(v);
  }

  function closeDeposit() {
    $('depositOverlay').classList.add('hidden');
  }

  function openDeposit() {
    const rules = depositRules();
    if (!rules || !rules.enabled) return;
    const a = state.account;
    const deposited = Number(a && a.deposited) || 0;
    const remaining = Math.max(0, Math.floor(rules.maxLifetime - deposited));
    $('depMax').textContent = '¥' + fmtMoney(rules.maxLifetime);
    $('depQuota').innerHTML =
      `已加 <b>¥${fmtMoney(deposited)}</b>` +
      '<span class="sep">·</span>' +
      `剩余可加 <b class="quota-left">¥${fmtMoney(remaining)}</b>`;
    if (remaining < (rules.minPerTime || 1)) {
      toast(`已达终身上限（¥${fmtMoney(rules.maxLifetime)}），无法继续加钱`, 'err');
      return;
    }
    const presets = (rules.presets || []).filter((v) => v > 0);
    $('depPresets').innerHTML =
      presets
        .map((v) => {
          const ok = v <= remaining;
          return `<button class="mini-btn dep-preset" data-amt="${esc(v)}"${ok ? '' : ' disabled'}>${amtLabel(v)}</button>`;
        })
        .join('') +
      `<button class="mini-btn dep-preset dep-all" data-amt="${remaining}">全部</button>`;
    $('depAmount').value = '';
    $('depAmount').max = String(remaining);
    $('depositOverlay').classList.remove('hidden');
    $('depAmount').focus();
  }

  function submitDeposit() {
    const rules = depositRules();
    if (!rules || !rules.enabled) return;
    const amt = Math.floor(Number($('depAmount').value));
    if (!Number.isFinite(amt) || amt < (rules.minPerTime || 1)) {
      toast('请输入有效金额', 'err');
      return;
    }
    apiPost('/api/deposit', { amount: amt })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) {
          toast(res.error || '加钱失败', 'err');
          return;
        }
        toast(`加钱成功 +¥${fmtMoney(res.added)}`, 'ok');
        closeDeposit();
        loadInitial(); // SSE 下一 tick 也会推，这里先立刻把余额刷出来
      })
      .catch(() => toast('网络异常，请重试', 'err'));
  }

  function bindDeposit() {
    $('addCashBtn').addEventListener('click', openDeposit);
    $('depCancelBtn').addEventListener('click', closeDeposit);
    $('depConfirmBtn').addEventListener('click', submitDeposit);
    $('depAmount').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitDeposit();
      if (e.key === 'Escape') closeDeposit();
    });
    // 快捷金额每开一次弹窗才重建，事件委托挂在容器上
    $('depPresets').addEventListener('click', (e) => {
      const btn = e.target.closest('.dep-preset');
      if (!btn || btn.disabled) return;
      $('depAmount').value = btn.dataset.amt;
      $('depAmount').focus();
    });
    // 点遮罩空白处关闭
    $('depositOverlay').addEventListener('click', (e) => {
      if (e.target === $('depositOverlay')) closeDeposit();
    });
  }

  // ---------- 自动化交易 ----------
  let autoType = 'tps';

  function autoParamsText(s) {
    const p = s.params || {};
    if (s.type === 'tps') {
      const pos = p.position === 'short' ? '空头' : '多头';
      const parts = [pos];
      if (p.tp) parts.push('止盈 ' + fmtP(p.tp));
      if (p.sl) parts.push('止损 ' + fmtP(p.sl));
      parts.push(p.qty > 0 ? p.qty + '股' : '全部');
      return parts.join(' · ');
    }
    if (s.type === 'grid') {
      return `基准 ${fmtP(p.base)} · 间距 ${p.stepPct}% · 每格 ${fmtQty(p.qty)}股 · 最多 ${p.maxLevels} 格`;
    }
    if (s.type === 'ma') {
      return `快线 ${p.fast}tick · 慢线 ${p.slow}tick · 每次投入 ${p.budgetPct}%`;
    }
    if (s.type === 'dca') {
      const times = p.maxTimes > 0 ? `共 ${p.maxTimes} 次` : '不限次数';
      return `每次 ${fmtMoney(p.amount)} 元 · 间隔 ${(p.intervalMs / 1000).toFixed(0)} 秒 · ${times}`;
    }
    return '';
  }

  function autoStateHtml(s) {
    const st = s.state || {};
    if (s.done) return '<span class="tag done">已完成</span>';
    if (!s.enabled) return '<span class="tag lock">已暂停</span>';
    if (s.type === 'tps') {
      return st.waiting
        ? '<span class="tag lock">已触发，等待可平</span>'
        : '<span class="tag ok">监控中</span>';
    }
    if (s.type === 'grid') {
      const pending = st.pending ? ' · 挂单中' : '';
      return `<span class="tag ok">运行中</span> ${st.openLevels || 0}/${s.params.maxLevels}格 · ${fmtQty(st.heldShares || 0)}股${pending}`;
    }
    if (s.type === 'ma') {
      if (!st.ready) {
        const done = s.params.slow - (st.warmupLeft || 0);
        return `<span class="tag lock">采集中 ${done}/${s.params.slow}</span>`;
      }
      const side = st.side === 1 ? '多头排列' : st.side === 0 ? '空头排列' : '待定';
      const sig = st.pendingSignal === 1 ? ' · 等待买入' : st.pendingSignal === 0 ? ' · 等待卖出' : '';
      return `<span class="tag ok">运行中</span> ${side}${sig}`;
    }
    if (s.type === 'dca') {
      const next = st.nextAt > Date.now() ? ' · 下次 ' + fmtTime(st.nextAt) : '';
      return `<span class="tag ok">运行中</span> 已投 ${st.doneTimes || 0} 次${next}`;
    }
    return '';
  }

  function renderAuto() {
    const a = state.account;
    if (!a) return;
    const list = a.auto || [];
    const rows = list.map((s) => {
      const lastEvt = s.events && s.events.length ? s.events[0] : null;
      const evtHtml = lastEvt
        ? `<div class="auto-evt">${fmtTime(lastEvt.t)} ${esc(lastEvt.text)}</div>`
        : '<span class="empty">--</span>';
      let targets = '';
      if (s.type === 'grid' && s.state) {
        const nb = s.state.nextBuy;
        const ns = s.state.nextSell;
        targets = `<div class="auto-targets">买入 ≤ ${nb != null ? fmtP(nb) : '--'} · 卖出 ≥ ${ns != null ? fmtP(ns) : '--'}</div>`;
      }
      const toggleBtn = s.done
        ? ''
        : `<button class="mini-btn" data-auto-toggle="${s.id}" data-enable="${s.enabled ? '0' : '1'}">${s.enabled ? '暂停' : '启用'}</button>`;
      return `<tr>
        <td>${esc(s.stockName || s.stockId || '--')}</td>
        <td>${esc(s.typeLabel || s.type)}</td>
        <td><div>${esc(autoParamsText(s))}</div>${targets}</td>
        <td>${autoStateHtml(s)}</td>
        <td class="auto-evt-cell">${evtHtml}</td>
        <td class="auto-ops">${toggleBtn}<button class="cancel-btn" data-auto-remove="${s.id}">删除</button></td>
      </tr>`;
    });
    $('autoBody').innerHTML =
      rows.join('') || '<tr><td colspan="6" class="empty">暂无自动化策略，点右上「新建策略」创建</td></tr>';
    $('autoBody').querySelectorAll('[data-auto-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        apiPost('/api/auto', { op: 'update', id: btn.dataset.autoToggle, enabled: btn.dataset.enable === '1' })
          .then((r) => r.json())
          .then((res) => toast(res.ok ? '已更新' : res.error || '操作失败', res.ok ? 'ok' : 'err'))
          .catch(() => toast('网络异常', 'err'));
      });
    });
    $('autoBody').querySelectorAll('[data-auto-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!confirm('删除该策略？进行中的挂单不受影响。')) return;
        apiPost('/api/auto', { op: 'remove', id: btn.dataset.autoRemove })
          .then((r) => r.json())
          .then((res) => toast(res.ok ? '已删除' : res.error || '删除失败', res.ok ? 'ok' : 'err'))
          .catch(() => toast('网络异常', 'err'));
      });
    });
    const active = list.filter((s) => s.enabled && !s.done).length;
    $('badgeAuto').hidden = active === 0;
    $('badgeAuto').textContent = active;
    const maxN = (state.rules && state.rules.auto && state.rules.auto.maxPerAccount) || 20;
    $('autoSub').textContent = list.length
      ? `${list.length}/${maxN} 条策略 · ${active} 条运行中`
      : `单账户最多 ${maxN} 条`;
  }

  function renderAutoFields() {
    // 基准价/手数按**所选股票**取（弹窗里可以挑股票，不一定是当前终端看的那只）
    const selStock = $('afStock') ? $('afStock').value : '';
    const selMarket = marketOf(selStock) || curMarket() || {};
    const last = selMarket.last || 0;
    const rules = (state.rules && state.rules.auto) || {};
    if (autoType === 'tps') {
      $('autoFields').innerHTML = `
        <div class="field"><label>持仓方向</label>
          <select id="afPosition"><option value="long">多头持仓</option><option value="short">空头持仓</option></select>
        </div>
        <div class="field"><label>止盈价（空头是跌到买回；留空不启用）</label>
          <input id="afTp" type="number" step="0.01" min="0.01" placeholder="留空不启用">
        </div>
        <div class="field"><label>止损价（空头是涨到买回；留空不启用）</label>
          <input id="afSl" type="number" step="0.01" min="0.01" placeholder="留空不启用">
        </div>
        <div class="field"><label>数量（股，0 = 全部可平）</label>
          <input id="afQty" type="number" step="100" min="0" value="0">
        </div>`;
    } else if (autoType === 'grid') {
      $('autoFields').innerHTML = `
        <div class="field"><label>基准价（留空 = 当前价 ${fmtP(last)}）</label>
          <input id="afBase" type="number" step="0.01" min="0.01" placeholder="${fmtP(last)}">
        </div>
        <div class="field"><label>网格间距（%）</label>
          <input id="afStep" type="number" step="0.1" min="${rules.grid ? rules.grid.minStepPct : 0.3}" max="${rules.grid ? rules.grid.maxStepPct : 20}" value="2">
        </div>
        <div class="field"><label>每格数量（股，必须 100 的倍数）</label>
          <input id="afQty" type="number" step="100" min="100" value="100">
        </div>
        <div class="field"><label>最大格数（同时持格上限）</label>
          <input id="afLevels" type="number" step="1" min="1" max="${rules.grid ? rules.grid.maxLevels : 50}" value="10">
        </div>`;
    } else if (autoType === 'ma') {
      const gap = rules.ma ? rules.ma.minSlowGap : 10;
      $('autoFields').innerHTML = `
        <div class="field"><label>快线窗口（tick，1 tick ≈ 0.7 秒）</label>
          <input id="afFast" type="number" step="1" min="${rules.ma ? rules.ma.minFast : 10}" max="${rules.ma ? rules.ma.maxFast : 300}" value="45">
        </div>
        <div class="field"><label>慢线窗口（tick，至少 = 快线 + ${gap}）</label>
          <input id="afSlow" type="number" step="1" min="${45 + gap}" max="${rules.ma ? rules.ma.maxSlow : 900}" value="150">
        </div>
        <div class="field"><label>每次投入比例（% 可用资金）</label>
          <input id="afBudget" type="number" step="1" min="1" max="100" value="50">
        </div>`;
    } else {
      const minSec = Math.round(((rules.dcaMinIntervalMs || 5000) / 1000));
      $('autoFields').innerHTML = `
        <div class="field"><label>每次金额（元）</label>
          <input id="afAmount" type="number" step="100" min="1" placeholder="如 5000">
        </div>
        <div class="field"><label>间隔（秒，最少 ${minSec}）</label>
          <input id="afInterval" type="number" step="1" min="${minSec}" value="60">
        </div>
        <div class="field"><label>总次数（0 = 不限，资金不足自动停）</label>
          <input id="afTimes" type="number" step="1" min="0" value="0">
        </div>`;
    }
  }

  function submitAuto() {
    let params = {};
    if (autoType === 'tps') {
      params = {
        position: $('afPosition').value,
        tp: $('afTp').value,
        sl: $('afSl').value,
        qty: $('afQty').value,
      };
    } else if (autoType === 'grid') {
      params = {
        base: $('afBase').value,
        stepPct: $('afStep').value,
        qty: $('afQty').value,
        maxLevels: $('afLevels').value,
      };
    } else if (autoType === 'ma') {
      params = {
        fast: $('afFast').value,
        slow: $('afSlow').value,
        budgetPct: $('afBudget').value,
      };
    } else {
      params = {
        amount: $('afAmount').value,
        intervalMs: Number($('afInterval').value) * 1000,
        maxTimes: $('afTimes').value,
      };
    }
    apiPost('/api/auto', {
      op: 'create',
      type: autoType,
      params,
      stockId: $('afStock') ? $('afStock').value : undefined,
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok) {
          toast('策略已创建', 'ok');
          closeAutoOverlay();
        } else {
          toast(res.error || '创建失败', 'err');
        }
      })
      .catch(() => toast('网络异常', 'err'));
  }

  /** 策略弹窗里的股票下拉：全部股票，默认选中当前终端看的那只 */
  function fillAutoStocks() {
    const sel = $('afStock');
    if (!sel) return;
    const cur = sel.value || activeStockId;
    sel.innerHTML = marketList()
      .map((m) => `<option value="${esc(m.stockId)}">${esc(m.name)}（${esc(m.stockId)}）</option>`)
      .join('');
    if (marketOf(cur)) sel.value = cur;
  }

  function openAutoOverlay() {
    autoType = 'tps';
    fillAutoStocks();
    $('autoTypeRow').querySelectorAll('.auto-type-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.type === autoType);
    });
    renderAutoFields();
    $('autoOverlay').classList.remove('hidden');
  }

  function closeAutoOverlay() {
    $('autoOverlay').classList.add('hidden');
  }

  function bindAuto() {
    $('autoNewBtn').addEventListener('click', openAutoOverlay);
    $('autoCancelBtn').addEventListener('click', closeAutoOverlay);
    $('autoConfirmBtn').addEventListener('click', submitAuto);
    // 换股票 → 基准价等提示跟着变
    if ($('afStock')) $('afStock').addEventListener('change', renderAutoFields);
    $('autoTypeRow').querySelectorAll('.auto-type-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        autoType = btn.dataset.type;
        $('autoTypeRow').querySelectorAll('.auto-type-btn').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        renderAutoFields();
      });
    });
    $('autoOverlay').addEventListener('click', (e) => {
      if (e.target === $('autoOverlay')) closeAutoOverlay();
    });
  }

  // ---------- 标签页 ----------
  let activeTab = 'position';
  function bindTabs() {
    $('tabs').querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        $('tabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        $('tabPanels').querySelectorAll('.tab-panel').forEach((p) => {
          p.classList.toggle('active', p.dataset.panel === activeTab);
        });
        if (activeTab === 'news') {
          newsUnread = 0;
          updateBadges();
        }
        // 股东榜按需拉取：切到该 tab 时立即拉一次
        if (activeTab === 'holders') {
          const m = curMarket();
          if (m) loadHolders(m.stockId, true);
        }
        drawChart();
      });
    });
  }
  function updateBadges() {
    $('badgeNews').hidden = newsUnread === 0;
    $('badgeNews').textContent = newsUnread;
  }

  // ---------- 下单面板 ----------
  function bindOrderPanel() {
    document.querySelectorAll('.act-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedAction = btn.dataset.action;
        priceDirty = false;
        renderOrderPanel();
      });
    });
    $('priceInput').addEventListener('input', () => {
      priceDirty = true;
      renderEstimates();
    });
    $('qtyInput').addEventListener('input', renderEstimates);
    $('financeCheck').addEventListener('change', () => {
      renderEstimates();
      renderLeverRates();
    });
    $('pxUp').addEventListener('click', () => stepPrice(0.01));
    $('pxDown').addEventListener('click', () => stepPrice(-0.01));
    $('pxAtMarket').addEventListener('click', () => {
      priceDirty = false;
      renderOrderPanel();
    });
    document.querySelectorAll('.quick-row .mini-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const frac = parseFloat(btn.dataset.frac);
        $('qtyInput').value = maxQtyForAction(frac);
        renderEstimates();
      });
    });
    $('submitBtn').addEventListener('click', submitOrder);
  }

  function stepPrice(d) {
    const cur = parseFloat($('priceInput').value) || (curMarket() || {}).last || 0;
    const next = Math.max(0.01, Math.round((cur + d) * 100) / 100);
    $('priceInput').value = next.toFixed(2);
    priceDirty = true;
    renderEstimates();
  }

  function counterPrice() {
    const m = curMarket() || {};
    const d = m.depth || { asks: [], bids: [] };
    const isBuy = selectedAction === 'buy_open' || selectedAction === 'buy_close';
    if (isBuy) {
      const ask = d.asks && d.asks[0];
      return ask ? ask.price : m.last || 0;
    }
    const bid = d.bids && d.bids[0];
    return bid ? bid.price : m.last || 0;
  }

  function maxQtyForAction(frac) {
    const a = state.account;
    const lot = state.rules.lotSize;
    const lock = directionLock();
    // 平仓方向要求已有持仓；开仓方向只看资金/保证金/券源，没有持仓也应有额度
    const needPos = selectedAction === 'sell_close' || selectedAction === 'buy_close';
    const pos = curPosition();
    const price = parseFloat($('priceInput').value) || counterPrice();
    if (!a || price <= 0) return 0;
    if (needPos && !pos) return 0;
    // 反向开仓被方向锁挡住：这里也归零，"全部"按钮不会填出一个必被拒的数量
    if (selectedAction === 'buy_open' && lock.short) return 0;
    if (selectedAction === 'sell_open' && lock.long) return 0;
    let max = 0;
    switch (selectedAction) {
      case 'buy_open': {
        const fin = state.rules.finance;
        const useFinance = !!(fin && fin.enabled && $('financeCheck').checked);
        if (useFinance) {
          // 与服务端同口径：现金 ≥ V×ratio，权益 ≥ maint×(全账户多头市值 + V) + V×fee
          //   →  V ≤ min(cash / ratio, (equity - maint×longMV) / (maint + fee)) / price
          // 手续费进融资负债，所以现金口径只按自备比例卡。
          // 多股票：权益与多头市值都是**账户级**汇总，与服务端的组合口径一致
          const capCash = a.cash / fin.ratio;
          const capEq = (a.equity - state.rules.maintenance * (a.longValue || 0)) /
            (state.rules.maintenance + state.rules.feeRate);
          max = Math.floor(Math.max(0, Math.min(capCash, capEq)) / price);
        } else {
          max = Math.floor(a.cash / (price * (1 + state.rules.feeRate)));
        }
        break;
      }
      case 'sell_close':
        max = pos ? pos.long.sellable : 0;
        break;
      case 'sell_open': {
        // 与服务端同口径：equity ≥ ratio × (账户总空头市值 + V) + V × feeRate
        //   →  V ≤ (equity - ratio × totalShortMV) / (ratio + feeRate)
        const ratio = state.rules.marginRatio;
        const shortMV = a.shortValue || 0;
        const cap = (a.equity - ratio * shortMV) / (ratio + state.rules.feeRate);
        max = Math.floor(Math.max(0, cap) / price);
        // 融券模式下还要夹紧该股可借券源
        const m = curMarket();
        if (state.rules.allowNakedShort === false && m && m.lending) {
          max = Math.min(max, m.lending.available);
        }
        break;
      }
      case 'buy_close':
        max = pos ? pos.short.coverable : 0;
        break;
      default:
        max = 0;
    }
    max = Math.floor(max * frac);
    if (selectedAction === 'buy_open' || selectedAction === 'sell_open') {
      max = Math.floor(max / lot) * lot;
    } else {
      max = Math.floor(max);
    }
    return Math.max(0, max);
  }

  /**
   * 方向锁提示：同一只股票只能持有一个方向。两侧都有（旧档残留）时只剩平仓可走。
   */
  function renderDirectionLock(lock) {
    const el = $('dirLock');
    let text = '';
    if (lock.long && lock.short) {
      text = '本股多空两侧都有持仓：只能平仓，平到只剩一侧才能再开仓';
    } else if (lock.short) {
      text = '本股已持空头：可加空或买入平空；要买入开多需先把空头全部平掉';
    } else if (lock.long) {
      text = '本股已持多头：可加多或卖出平多；要卖出开空需先把多头全部卖出';
    }
    el.hidden = !text;
    el.textContent = text;
  }

  function renderOrderPanel() {
    const m = curMarket();
    const isIndex = !!(m && m.isIndex);
    document.querySelectorAll('.act-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.action === selectedAction);
    });
    const a = state.account;
    const halted = !!(state.halt && state.halt.halted);
    const pos = curPosition();
    const lock = directionLock();
    renderDirectionLock(lock);
    if (a && m) {
      // 指数不可交易：四个方向按钮全部禁用
      const L = m.lending;
      const noBorrow =
        state.rules.allowNakedShort === false &&
        (!L || !L.enabled || L.available <= 0);
      const dis = isIndex
        ? { buy_open: true, sell_close: true, sell_open: true, buy_close: true }
        : {
            buy_open: halted || lock.short,
            sell_close: halted || !pos || pos.long.sellable <= 0,
            sell_open: halted || noBorrow || lock.long,
            buy_close: halted || !pos || pos.short.coverable <= 0,
          };
      document.querySelectorAll('.act-btn').forEach((btn) => {
        const d = dis[btn.dataset.action];
        btn.disabled = d;
        if (isIndex) btn.title = '指数不可交易，仅供观察大盘';
        else if (halted) btn.title = '已停牌，暂停下单';
        else if (btn.dataset.action === 'sell_open' && noBorrow) {
          btn.title = !L || !L.enabled ? '融券做空未开放' : '可借券源不足，请先在融券页挂借';
        } else if (btn.dataset.action === 'buy_open' && lock.short) {
          btn.title = '该股已持空头（或有卖出开空委托在途），需先买入平空才能买入开多';
        } else if (btn.dataset.action === 'sell_open' && lock.long) {
          btn.title = '该股已持多头（或有买入开多委托在途），需先卖出平多才能卖出开空';
        } else btn.title = d ? '无可操作持仓' : '';
      });
    }
    if (!priceDirty && !isIndex) {
      $('priceInput').value = counterPrice().toFixed(2);
    }
    // 融资开关只在买入开多且服务端开放时出现
    const fin = state.rules.finance;
    const finRow = $('financeRow');
    const finAvailable = !isIndex && selectedAction === 'buy_open' && !!(fin && fin.enabled) && !halted;
    finRow.hidden = !finAvailable;
    if (finAvailable) {
      const times = fin.ratio > 0 ? (1 / fin.ratio).toFixed(1).replace(/\.0$/, '') : '1';
      // 利率交给下面的「杠杆利息」常显块，这里只留杠杆口径，免得两个数并排把标签挤换行
      $('financeTag').textContent = `自备 ${Math.round(fin.ratio * 100)}% · 最高${times}倍`;
    }
    const submit = $('submitBtn');
    submit.textContent = isIndex ? '指数不可交易' : ACTION_LABEL[selectedAction];
    submit.classList.toggle('sell-mode', selectedAction === 'sell_close' || selectedAction === 'sell_open');
    renderEstimates();
    renderLeverRates();
    renderRisk();
    renderCooldown();
  }

  /** 分钟息（百分数，0.01 表示 0.01%/分）→ 主文与折算日息 */
  function fmtMinuteRate(pct) {
    const r = Number(pct) || 0;
    return {
      rate: `${Number(r.toFixed(3))}%/分`,
      day: r > 0 ? `≈${Number((r * 1440).toFixed(1))}%/日` : '',
    };
  }

  /**
   * 杠杆利息常显：做多（融资）与做空（融券）各一行，选中方向且这笔真会借钱/借券时高亮。
   * 融资买入不勾选只是一笔全款买单，不计息，所以高亮跟着勾选状态走。
   */
  function renderLeverRates() {
    const fin = state.rules.finance;
    const m = curMarket();
    const L = m && m.lending;

    const longRow = $('leverRowLong');
    const longOn = selectedAction === 'buy_open' && !!$('financeCheck').checked;
    if (fin && fin.enabled) {
      const f = fmtMinuteRate(fin.minuteRate);
      $('leverValLong').innerHTML = `${f.rate}<i>${f.day}</i>`;
      longRow.className = 'lever-row' + (longOn ? ' on' : '');
    } else {
      $('leverValLong').textContent = '未开放';
      longRow.className = 'lever-row off';
    }

    const shortRow = $('leverRowShort');
    if (!L || !L.enabled) {
      $('leverValShort').textContent = '未开放';
      shortRow.className = 'lever-row short off';
    } else if (state.rules.allowNakedShort) {
      $('leverValShort').textContent = '裸空不计息';
      shortRow.className = 'lever-row short off';
    } else {
      const s = fmtMinuteRate(L.minuteRate);
      $('leverValShort').innerHTML = `${s.rate}<i>${s.day}</i>`;
      shortRow.className = 'lever-row short' + (selectedAction === 'sell_open' ? ' on' : '');
    }
  }

  function renderEstimates() {
    const m = curMarket();
    const isIndex = !!(m && m.isIndex);
    const price = parseFloat($('priceInput').value) || 0;
    const qty = parseInt($('qtyInput').value, 10) || 0;
    $('lotHint').textContent = '= ' + (qty / state.rules.lotSize).toFixed(2).replace(/\.?0+$/, '') + '手';
    // 指数不可交易：这几项没有意义，直接置灰成 --
    if (isIndex) {
      $('estAmount').textContent = '--';
      $('estFee').textContent = '--';
      $('estMax').textContent = '--';
      $('estInterestRow').hidden = true;
      $('estFinanceRow').hidden = true;
      if (state.account) {
        $('fundsLine').textContent =
          `可用 ${fmtMoney(state.account.cash)} · 冻结 ${fmtMoney(state.account.orderFrozen)} · 保证金 ${fmtMoney(state.account.shortMargin)} · 权益 ${fmtMoney(state.account.equity)}`;
      }
      return;
    }
    $('estAmount').textContent = fmtMoney(price * qty);
    $('estFee').textContent = fmtMoney(price * qty * state.rules.feeRate);
    const max = maxQtyForAction(1);
    const unit = selectedAction === 'sell_close' || selectedAction === 'buy_close' ? '可平' : '可开';
    $('estMax').textContent = `${unit} ${fmtQty(max)} 股`;

    // 融资拆分预估：勾选时按自备比例展示两段金额
    const fin = state.rules.finance;
    const finOn = selectedAction === 'buy_open' && !!(fin && fin.enabled) && $('financeCheck').checked;
    $('estFinanceRow').hidden = !finOn;
    if (finOn) {
      $('estFinance').textContent = `${fmtMoney(price * qty * fin.ratio)} / ${fmtMoney(price * qty * (1 - fin.ratio))}`;
    }

    // 本次开杠杆的利息成本：融资按借入口径（含开仓手续费）计息，融券按借券市值计息，
    // 都乘以当前分钟息——与服务端逐 tick 摊息的基数同一口径
    const estInterestRow = $('estInterestRow');
    let perMin = 0;
    if (finOn) {
      const finFee = price * qty * state.rules.feeRate;
      perMin = (price * qty * (1 - fin.ratio) + finFee) * minuteRateOf('finance');
    } else if (selectedAction === 'sell_open') {
      perMin = price * qty * minuteRateOf('lend');
    }
    estInterestRow.hidden = perMin <= 0;
    if (perMin > 0) {
      $('estInterest').innerHTML = `${fmtMoney(perMin)}/分<i>≈${fmtMoney(perMin * 1440)}/日</i>`;
    }

    if (state.account) {
      $('fundsLine').textContent =
        `可用 ${fmtMoney(state.account.cash)} · 冻结 ${fmtMoney(state.account.orderFrozen)} · 保证金 ${fmtMoney(state.account.shortMargin)} · 权益 ${fmtMoney(state.account.equity)}`;
    }
  }

  /**
   * 风险行：按**当前股票**展示敞口与强平价。
   * 多股票下账户权益是组合口径，强平价按「其它持仓按现价冻结」推导（服务端同一口径）。
   */
  function renderRisk() {
    const a = state.account;
    const el = $('riskLine');
    const m = curMarket();
    const pos = curPosition();
    const hasFinance = !!(pos && pos.financeDebt > 0);
    const hasShort = !!(pos && pos.short.qty > 0);
    if (!a || (!hasShort && !hasFinance)) {
      el.textContent = '';
      el.className = 'risk-line';
      return;
    }
    const last = m ? m.last : 0;
    const liqShort = pos && pos.liquidationPrice;
    const liqLong = pos && pos.liquidationPriceLong;
    const parts = [`风险度 ${a.marginUsage}%`];
    if (hasShort) parts.push(`空头 ${fmtQty(pos.short.qty)} 股`);
    if (hasFinance) parts.push(`融资 ${fmtMoney(pos.financeDebt)}`);
    const prices = [];
    if (liqShort) prices.push(`空强平 ${fmtP(liqShort)}`);
    if (liqLong) prices.push(`多强平 ${fmtP(liqLong)}`);
    if (prices.length) parts.push(prices.join(' · '));
    el.textContent = parts.join(' · ');
    const danger =
      (liqShort && last >= liqShort) || (liqLong && last <= liqLong);
    el.className = 'risk-line ' + (danger ? 'danger' : a.marginUsage > 60 ? 'warn' : '');
  }

  function cooldownMsLeft() {
    if (!state) return 0;
    return state.cooldownLeft || 0;
  }

  function renderCooldown() {
    const left = cooldownMsLeft();
    // 停牌与方向锁一并在这里处理：tickUI 每 200ms 会重写 submitBtn.disabled，
    // 只在 renderOrderPanel 里禁用会被它覆盖回可点
    const halted = !!(state.halt && state.halt.halted);
    const lock = directionLock();
    const locked =
      (selectedAction === 'buy_open' && lock.short) ||
      (selectedAction === 'sell_open' && lock.long);
    $('cooldownText').textContent = halted
      ? '已停牌'
      : locked
        ? '本股方向已锁'
        : left > 0
          ? `冷却 ${(left / 1000).toFixed(1)}s`
          : '';
    $('submitBtn').disabled = halted || left > 0 || locked || !!(curMarket() || {}).isIndex;
  }

  // ---------- 停牌 ----------

  /** 服务端时间估算（与顶栏时钟同口径），倒计时不受本机时钟偏差影响 */
  function serverNow() {
    return state ? state.serverTime + (Date.now() - lastStateAt) : Date.now();
  }

  function fmtDur(ms) {
    const s = Math.ceil(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`;
  }

  /** 停牌横幅：原因与剩余时间，复牌后自动隐藏 */
  function renderHalt() {
    const banner = $('haltBanner');
    const h = state && state.halt;
    if (!h || !h.halted) {
      banner.hidden = true;
      return;
    }
    const left = Math.max(0, h.until - serverNow());
    banner.hidden = false;
    // 原因来自服务端，一律走 textContent 写入
    $('haltText').textContent = h.reason ? `暂停交易 · ${h.reason}` : '暂停交易';
    $('haltLeft').textContent = left > 0 ? `剩余 ${fmtDur(left)}` : '即将复牌';
  }

  function submitOrder() {
    const m = curMarket();
    if (!m || m.isIndex) return toast('指数不可交易', 'err');
    const price = parseFloat($('priceInput').value);
    const qty = parseInt($('qtyInput').value, 10);
    if (!price || price <= 0) return toast('请输入有效价格', 'err');
    if (!qty || qty <= 0) return toast('请输入有效数量', 'err');
    $('submitBtn').disabled = true;
    const finance = selectedAction === 'buy_open' && $('financeCheck').checked;
    apiPost('/api/order', { stockId: m.stockId, action: selectedAction, qty, price, finance })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) {
          toast(res.error || '下单失败', 'err');
          renderCooldown();
          return;
        }
        const o = res.order;
        const filled = o.filled > 0 ? (o.filled === o.qty ? '全部成交' : `成交 ${o.filled}/${o.qty} 股`) : '已挂单';
        toast(`${ACTION_LABEL[o.action]} ${filled}`, 'ok');
        renderCooldown();
      })
      .catch(() => {
        toast('网络异常', 'err');
        renderCooldown();
      });
  }

  // ---------- 分时图 ----------
  const canvas = () => $('chart');

  /** MACD(12,26,9)：DIF=EMA12−EMA26，DEA=DIF 的 EMA9，柱=2×(DIF−DEA) */
  function computeMacd(pts, fast = 12, slow = 26, sig = 9) {
    const n = pts.length;
    const dif = new Array(n);
    const dea = new Array(n);
    const hist = new Array(n);
    if (!n) return { dif, dea, hist };
    const kf = 2 / (fast + 1);
    const ks = 2 / (slow + 1);
    const kd = 2 / (sig + 1);
    let ef = pts[0].price;
    let es = pts[0].price;
    for (let i = 0; i < n; i++) {
      const p = pts[i].price;
      if (i > 0) {
        ef = kf * p + (1 - kf) * ef;
        es = ks * p + (1 - ks) * es;
      }
      dif[i] = ef - es;
      dea[i] = i === 0 ? dif[0] : kd * dif[i] + (1 - kd) * dea[i - 1];
      hist[i] = 2 * (dif[i] - dea[i]);
    }
    return { dif, dea, hist };
  }

  // 分时重绘时刷新缓存；十字光标只读缓存，避免每次 mousemove 全量算一遍。
  // 缓存键带上 stockId：切股票后序列变了，必须重算
  let macdCache = { stockId: '', n: -1, lastT: 0, arr: null };
  function macdOf() {
    const m = curMarket();
    const stockId = m ? m.stockId : '';
    const pts = histOf(stockId);
    const lastT = pts.length ? pts[pts.length - 1].t : 0;
    if (macdCache.stockId !== stockId || macdCache.n !== pts.length || macdCache.lastT !== lastT) {
      macdCache = { stockId, n: pts.length, lastT, arr: computeMacd(pts) };
    }
    return macdCache.arr;
  }

  function resizeChart() {
    const c = canvas();
    const box = c.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(300, Math.floor(box.width * dpr));
    c.height = Math.max(200, Math.floor(box.height * dpr));
    drawChart();
  }
  window.addEventListener('resize', resizeChart);

  function drawChart() {
    if (!state || activeView !== 'trade') return;
    const m = curMarket();
    if (!m) return;
    const c = canvas();
    if (c.width === 0) return;
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = c.width / dpr;
    const H = c.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 指数没有均价/MACD 之外的量，但走势结构与个股一致，同一套画法即可
    $('chartSub').textContent = m.isIndex
      ? '大盘指数分时 · 成分股按流通市值加权'
      : '均价与价格 · 成交量 · MACD(12,26,9)';

    const prev = m.prevClose;
    const pts = histOf(m.stockId);
    if (!pts.length) return;

    const PAD_R = 58;
    const PAD_L = 8;
    const PAD_T = 10;
    const PAD_B = 20;
    const VOL_H = Math.min(40, H * 0.13);
    const MACD_H = Math.max(56, Math.min(96, H * 0.26));
    const priceH = H - PAD_T - PAD_B - VOL_H - MACD_H - 12;
    const volTop = PAD_T + priceH + 6;
    const macdTop = volTop + VOL_H + 6;

    // x 轴时间域：贴合当前保留的分时点（服务端/客户端只留最近约 2 小时）。
    // 固定「开局 + 4 小时」会让开局挤在最左、数据裁剪后右侧大片空白。
    const t0 = pts[0].t;
    const tLast = pts[pts.length - 1].t;
    const minSpan = 5 * 60 * 1000;
    const t1 = tLast + Math.max(20 * 1000, Math.max(minSpan - (tLast - t0), (tLast - t0) * 0.08));
    const x = (t) => PAD_L + ((t - t0) / (t1 - t0)) * (W - PAD_L - PAD_R);

    // y 轴价格域
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p.price < lo) lo = p.price;
      if (p.price > hi) hi = p.price;
    }
    lo = Math.min(lo, prev);
    hi = Math.max(hi, prev);
    const padP = Math.max((hi - lo) * 0.12, 0.05);
    lo -= padP;
    hi += padP;
    const y = (p) => PAD_T + ((hi - p) / (hi - lo)) * priceH;

    // 网格 + 右侧价格标签
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
    ctx.textBaseline = 'middle';
    const lines = 5;
    for (let i = 0; i <= lines; i++) {
      const p = lo + ((hi - lo) * i) / lines;
      const yy = y(p);
      ctx.strokeStyle = 'rgba(30,38,54,.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD_L, yy);
      ctx.lineTo(W - PAD_R, yy);
      ctx.stroke();
      ctx.fillStyle = '#7d879b';
      ctx.textAlign = 'left';
      ctx.fillText(p.toFixed(2), W - PAD_R + 6, yy);
      // 涨跌幅刻度
      const pct = ((p - prev) / prev) * 100;
      ctx.fillStyle = pct > 0 ? '#f0464b' : pct < 0 ? '#1fb978' : '#7d879b';
      ctx.fillText((pct >= 0 ? '+' : '') + pct.toFixed(2) + '%', W - PAD_R + 6, yy + 11);
    }

    // 时间刻度（纵线贯穿价格/成交量/MACD 三带）
    ctx.textAlign = 'center';
    ctx.fillStyle = '#7d879b';
    for (let i = 0; i <= 4; i++) {
      const tt = t0 + ((t1 - t0) * i) / 4;
      const xx = x(tt);
      // 居中绘制会越出画布，两端夹回可视区
      const tx = Math.min(Math.max(xx, PAD_L + 18), W - PAD_R - 18);
      ctx.fillText(fmtTime(tt).slice(0, 5), tx, H - PAD_B / 2 - 2);
      ctx.strokeStyle = 'rgba(30,38,54,.6)';
      ctx.beginPath();
      ctx.moveTo(xx, PAD_T);
      ctx.lineTo(xx, macdTop + MACD_H);
      ctx.stroke();
    }

    // 昨收虚线
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#7d879b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, y(prev));
    ctx.lineTo(W - PAD_R, y(prev));
    ctx.stroke();
    ctx.setLineDash([]);

    const up = m.last >= prev;
    const lineColor = up ? '#f0464b' : '#1fb978';

    // 面积
    ctx.beginPath();
    ctx.moveTo(x(pts[0].t), y(pts[0].price));
    for (const p of pts) ctx.lineTo(x(p.t), y(p.price));
    ctx.lineTo(x(pts[pts.length - 1].t), PAD_T + priceH);
    ctx.lineTo(x(pts[0].t), PAD_T + priceH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + priceH);
    grad.addColorStop(0, up ? 'rgba(240,70,75,.28)' : 'rgba(31,185,120,.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // 价格线
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const px = x(pts[i].t);
      const py = y(pts[i].price);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // 均价线（简单滚动均值）
    ctx.beginPath();
    let acc = 0;
    for (let i = 0; i < pts.length; i++) {
      acc += pts[i].price;
      const avg = acc / (i + 1);
      const px = x(pts[i].t);
      const py = y(avg);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = 'rgba(240,180,41,.85)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 成交量柱
    let maxVol = 1;
    const deltas = [];
    for (let i = 0; i < pts.length; i++) {
      const d = i === 0 ? 0 : Math.max(0, (pts[i].vol || 0) - (pts[i - 1].vol || 0));
      deltas.push(d);
      if (d > maxVol) maxVol = d;
    }
    const bw = Math.max(1, ((W - PAD_L - PAD_R) / Math.max(pts.length, 1)) * 0.7);
    ctx.fillStyle = 'rgba(76,141,255,.55)';
    for (let i = 1; i < pts.length; i++) {
      const h = (deltas[i] / maxVol) * VOL_H;
      if (h < 0.5) continue;
      ctx.fillRect(x(pts[i].t) - bw / 2, volTop + (VOL_H - h), bw, h);
    }

    // MACD(12,26,9)：柱 = 2×(DIF−DEA)，红柱 DIF>DEA / 绿柱 DIF<DEA（与涨跌配色一致）
    const macd = macdOf();
    const nM = pts.length;
    let mAbs = 1e-9;
    for (let i = 0; i < nM; i++) {
      mAbs = Math.max(mAbs, Math.abs(macd.dif[i]), Math.abs(macd.dea[i]), Math.abs(macd.hist[i]));
    }
    const mMid = macdTop + MACD_H / 2;
    const mY = (v) => mMid - (v / mAbs) * (MACD_H / 2 - 10);
    ctx.strokeStyle = 'rgba(30,38,54,.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, mMid);
    ctx.lineTo(W - PAD_R, mMid);
    ctx.stroke();
    for (let i = 0; i < nM; i++) {
      const h = (Math.abs(macd.hist[i]) / mAbs) * (MACD_H / 2 - 10);
      if (h < 0.4) continue;
      ctx.fillStyle = macd.hist[i] > 0 ? 'rgba(240,70,75,.9)' : 'rgba(31,185,120,.9)';
      ctx.fillRect(x(pts[i].t) - bw / 2, macd.hist[i] > 0 ? mMid - h : mMid, bw, h);
    }
    ctx.beginPath();
    for (let i = 0; i < nM; i++) {
      const px = x(pts[i].t);
      const py = mY(macd.dif[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#f0b429';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < nM; i++) {
      const px = x(pts[i].t);
      const py = mY(macd.dea[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#4c8dff';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // 最新点
    const lastPt = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(x(lastPt.t), y(lastPt.price), 3, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    // 图例
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f0b429';
    ctx.fillText('均价', PAD_L + 4, PAD_T + 8);
    ctx.fillStyle = lineColor;
    ctx.fillText('价格', PAD_L + 36, PAD_T + 8);
    ctx.fillStyle = '#7d879b';
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    let lx = PAD_L + 4;
    ctx.fillText('MACD(12,26,9)', lx, macdTop + 9);
    lx += ctx.measureText('MACD(12,26,9)').width + 10;
    ctx.fillStyle = '#f0b429';
    ctx.fillText('DIF ' + macd.dif[nM - 1].toFixed(3), lx, macdTop + 9);
    lx += ctx.measureText('DIF ' + macd.dif[nM - 1].toFixed(3)).width + 12;
    ctx.fillStyle = '#4c8dff';
    ctx.fillText('DEA ' + macd.dea[nM - 1].toFixed(3), lx, macdTop + 9);
  }

  // 十字光标
  function bindCrosshair() {
    const c = canvas();
    const tip = $('chartTip');
    c.addEventListener('mousemove', (e) => {
      const m = curMarket();
      if (!state || !m) return;
      const pts = histOf(m.stockId);
      if (!pts.length) return;
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // 反解时间（与 drawChart 的 x 轴同一套域）
      const t0 = pts[0].t;
      const tLast = pts[pts.length - 1].t;
      const minSpan = 5 * 60 * 1000;
      const t1 = tLast + Math.max(20 * 1000, Math.max(minSpan - (tLast - t0), (tLast - t0) * 0.08));
      const W = rect.width;
      const PAD_L = 8;
      const PAD_R = 58;
      const frac = (mx - PAD_L) / (W - PAD_L - PAD_R);
      if (frac < 0 || frac > 1) {
        tip.hidden = true;
        return;
      }
      const tt = t0 + frac * (t1 - t0);
      let best = pts[0];
      let bestI = 0;
      let bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(pts[i].t - tt);
        if (d < bd) {
          bd = d;
          best = pts[i];
          bestI = i;
        }
      }
      const prev = m.prevClose;
      const pct = ((best.price - prev) / prev) * 100;
      const md = macdOf();
      const difV = md.dif[bestI] || 0;
      const deaV = md.dea[bestI] || 0;
      tip.innerHTML =
        `<span class="t">${fmtTime(best.t)}</span><br>价格 <b class="${cls(best.price - prev)}">${fmtP(best.price)}</b> <span class="${cls(best.price - prev)}">${(pct >= 0 ? '+' : '') + pct.toFixed(2)}%</span><br><span class="t">成交量</span> ${fmtQty(best.vol || 0)}<br>` +
        `<span class="t">MACD</span> DIF <b class="${cls(difV)}">${difV.toFixed(3)}</b> DEA <b class="${cls(deaV)}">${deaV.toFixed(3)}</b>`;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(mx + 14, rect.width - tw - 6) + 'px';
      tip.style.top = Math.min(my + 14, rect.height - 86) + 'px';
    });
    c.addEventListener('mouseleave', () => {
      tip.hidden = true;
    });
  }

  // ---------- 心跳 / 冷却刷新 ----------
  function tickUI() {
    if (!state) return;
    if (Date.now() - lastStateAt > 4000) $('connDot').classList.add('off');
    renderCooldown();
    renderHalt();
    $('clock').textContent = fmtTime(state.serverTime + (Date.now() - lastStateAt));
    // 股东榜：进 tab 时按需拉，前台每 5 秒刷新一次（服务端只在操作时记快照，
    // 但持股会随行情外的成交变动，5 秒足够新）
    if (activeView === 'trade' && activeTab === 'holders') {
      const m = curMarket();
      if (m) loadHolders(m.stockId, false);
    }
    // 价格跟随（未手动改动时）
    if (!priceDirty && state.account) {
      const cur = $('priceInput').value;
      const target = counterPrice().toFixed(2);
      if (cur !== target) {
        $('priceInput').value = target;
        renderEstimates();
      }
    }
  }

  // ---------- 启动 ----------
  function init() {
    bindLogin();
    bindViewNav();
    bindHome();
    bindStockTabs();
    bindNewsFilter();
    bindDeposit();
    bindAuto();
    bindTabs();
    bindOrderPanel();
    bindLending();
    bindHolders();
    bindCrosshair();
    setInterval(tickUI, 200);
    if (me) {
      apiPost('/api/login', { name: me })
        .then((r) => r.json())
        .then((res) => {
          if (res.ok) {
            setIdentity(res.name, res.token);
            enterApp();
          } else {
            setIdentity('', '');
            $('loginOverlay').classList.remove('hidden');
            $('loginName').focus();
            toast(res.error || '请重新登录', 'err');
          }
        })
        .catch(() => {
          $('loginOverlay').classList.remove('hidden');
        });
    } else {
      $('loginOverlay').classList.remove('hidden');
      $('loginName').focus();
    }
  }

  init();
})();

