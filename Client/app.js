/**
 * 股神请就位 · 韭菜进化论（原「我是股神」）· 客户端
 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  // me = **账号**（登录凭据，服务端各表引用的键，用于"我是哪一行"的判定）；
  // myNick = 昵称（展示名，随时可改，所以不能拿它当身份）。
  // 旧键 gushen_name 是"账号与昵称还没分家"时留下的，读一次兜底，免得老浏览器卡在登录页
  let me = localStorage.getItem('gushen_account') || localStorage.getItem('gushen_name') || '';
  /**
   * 一个游戏日有多少**真实**分钟（620 秒 ≈ 10.3 分钟，取服务端下发的 `rules.day.totalMs`）。
   *
   * 做空利息按游戏日结算，界面上凡是把日息折算成「每分钟」的地方都必须用这个数：
   * 融资那边的分钟息是**真实分钟**（服务端逐 tick 摊），两边混在一行里相加时
   * 单位必须一致。用 A 股的 240 交易分钟折算会让做空成本少算约 23 倍。
   */
  function minutesPerGameDay() {
    const ms = state && state.rules && state.rules.day && Number(state.rules.day.totalMs);
    return ms > 0 ? ms / 60000 : 620000 / 60000;
  }
  let myNick = localStorage.getItem('gushen_nick') || '';
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
  // 玩家持仓弹窗（排行 → 「持仓」）：按需拉，不进每帧 state
  let rankPosAccount = ''; // 当前弹窗看的是哪个账号
  let rankPosData = null;
  // 股东榜改为按需拉取（10 只股票全推会把每帧撑爆）：进 tab / 切股票时拉，前台 5 秒刷新
  let holdersData = null; // /api/holders 的最近一次响应
  let holdersStockId = '';
  let holdersAt = 0;
  // 消息过滤：all = 全部，index = 只大盘，个股 stockId
  let newsFilter = 'all';
  // 图表模式：minute = 分时（tick 级走势），day/week/month = 日/周/月 K 线。选择记在本地，刷新后保持
  const CHART_MODES = ['minute', 'day', 'week', 'month'];
  const chartModeRaw = localStorage.getItem('gushen_chart');
  let chartMode = CHART_MODES.includes(chartModeRaw) ? chartModeRaw : 'minute';
  // 日/周/月共用一套 K 线画法与日线缓存，只有「是不是分时」需要分支
  const isKline = () => chartMode !== 'minute';
  // 日线抓多少根：日线一屏 120 根就够看；**周/月线是「多根并一根」，根数不够就并不出东西**
  //（周线 120 根只剩 17 根、月线只剩 4 根，MACD 与 MA10 全废）。所以进了 K 线模式按服务端
  // 上限 260 抓（config.market.dailyBarsKeep），日线只画最近 120 根，免得 260 根挤成发丝。
  const DAILY_LIMIT_DAY = 120;
  const DAILY_LIMIT_KLINE = 260;
  const DAY_SHOW_MAX = 120;
  // MACD 预热门槛：DIF = EMA12 − EMA26、DEA 再套 EMA9，不足慢线 + 信号线（26 + 9）根时
  // 数值只是「从第一根开始推」的初始化残差，不是 MACD。图上要标「未预热」而不是让它冒充指标
  //（实测月线常常只有 4 根、周线 10 根，都在这条线以下）
  const MACD_MIN_BARS = 35;
  // 分时的取数窗口（只有分时模式用得上）：
  //   day = 只看当天（默认；真实行情软件的分时口径，跨天不再连成一条）
  //   5d  = 连续 5 个交易日
  // 服务端的分时序列是**跨天连续**的一整条（保留 10300 点 ≈ 11.6 个交易日），
  // 不加窗口的话昨天、前天的走势会一直连在左边，开盘价跳一次就看不明白了
  const MINUTE_RANGE_KEY = 'gushen_minute_range';
  const MINUTE_DAYS = 5; // 「5 日」窗口覆盖的交易日数（含当天）
  let minuteRange = localStorage.getItem(MINUTE_RANGE_KEY) === '5d' ? '5d' : 'day';
  // 日线：每只标的**已收盘**的 K 线（/api/daily 按需拉）。当日那根要到收盘结算才定格，
  // 由客户端拿实时行情现拼，所以它每帧都在动、不需要额外推送
  const dayBars = new Map(); // stockId -> [{day, open, high, low, close, volume, turnover, net}]
  // 已拉过日线的标的 → 已拉的根数（与 histLoaded 同理，不能用 dayBars.has 判断）。
  // 用 Map 而不是 Set：周/月线要多得多的根数，拉到「服务端全量」时记 Infinity，之后不再重拉
  const dayLoaded = new Map();
  // 「交易日号 + 是否已收盘结算」：跨天与进入夜间都要作废日线缓存（见 onState）
  let lastDayKey = '';

  // ---------- 主题系统 ----------
  // 主题 = <html data-theme> 一个属性 + localStorage。每套主题在 style.css 里重写
  // 同一套 token，DOM 样式零改动即时生效；画布/SVG 里的颜色走 themeC 缓存，
  // 切换主题时刷新缓存并整体重绘一次。吉祥物换装：二次元主题自带专属立绘，
  // 主页 hero 和彩蛋横幅头像一起换（themeConf(id).mascot）。
  const THEMES = [
    { id: '',       name: '深夜终端', tag: '默认', desc: '深蓝黑交易终端 · 经典默认' },
    { id: 'broker', name: '老牌券商厅', tag: '传统', desc: '红木黄铜 · 90 年代营业部大厅' },
    { id: 'gold',   name: '黑金股神', tag: '传统', desc: '黑金配色 · 尊贵感拉满' },
    { id: 'sakura', name: '樱色交易所', tag: '二次元', desc: '樱粉白卡 · 抽卡式软萌 UI', mascotId: 'sakura' },
    { id: 'magic',  name: '魔法夜空', tag: '二次元', desc: '深紫夜空 · 魔法少女夜战', mascotId: 'magic' },
  ];
  const THEME_KEY = 'gushen_theme'; // 只在玩家主动选过之后才写入：null = 从没选过（首次登录要弹选择）
  let currentTheme = '';
  let themeC = {}; // 画布/SVG 用的 token 缓存，themeTokens() 刷新
  const themeConf = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

  // 吉祥物阵容：默认跟随主题（mascotId），玩家在弹窗里自选后记 localStorage、跨主题生效
  const MASCOTS = [
    { id: '',        name: '跟随主题', img: '', thumb: '/img/egg-cat-smug-96.png', desc: '二次元主题带专属换装' },
    { id: 'cat',     name: '股神猫', img: '', thumb: '/img/egg-cat-smug-96.png', desc: '经典原版' },
    // 立绘走 -256（主页 hero 高 120px，2 倍屏要 240px 才不糊）；缩略图走 -96，
    // 供选择卡（56px）与彩蛋横幅头像（44px）用——原图 1024/1~2MB，别在这两处引用
    { id: 'sakura',  name: '和服猫耳少女', img: '/img/mascot-sakura-256.png', thumb: '/img/mascot-sakura-96.png', desc: '樱色原配' },
    { id: 'magic',   name: '魔法少女', img: '/img/mascot-magic-256.png', thumb: '/img/mascot-magic-96.png', desc: '夜空原配' },
    { id: 'maodiao', name: '耄耋猫', img: '/img/mascot-maodiao-256.png', thumb: '/img/mascot-maodiao-96.png', desc: '亏麻了，也要招财' },
    { id: 'orange',  name: '丑橘猫', img: '/img/mascot-orange-256.png', thumb: '/img/mascot-orange-96.png', desc: '涨了！傻乐' },
    { id: 'doro',    name: '小恶魔朵洛', img: '/img/mascot-doro-256.png', thumb: '/img/mascot-doro-96.png', desc: '举爪招涨' },
    { id: 'duck',    name: '咕咕嘎嘎', img: '/img/mascot-duck-256.png', thumb: '/img/mascot-duck-96.png', desc: 'duck 不服' },
    { id: 'knight',  name: '刀盾骑士', img: '/img/mascot-knight-256.png', thumb: '/img/mascot-knight-96.png', desc: '我的刀！我的盾！' },
  ];
  const MASCOT_KEY = 'gushen_mascot'; // '' = 跟随主题；null = 从没选过（同样跟随主题）
  let currentMascot = null;
  function mascotConf() {
    // 未选择 / 选了「跟随主题」→ 用当前主题的默认吉祥物，主题没配就用股神猫
    const pick = currentMascot || themeConf(currentTheme).mascotId || 'cat';
    return MASCOTS.find((m) => m.id === pick) || MASCOTS[1];
  }

  function themeTokens() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    themeC = {
      ink: v('--ink', '#dce3ef'),
      muted: v('--muted', '#7d879b'),
      red: v('--red', '#f0464b'),
      green: v('--green', '#1fb978'),
      blue: v('--blue', '#4c8dff'),
      gold: v('--gold', '#f0b429'),
      grid: v('--chart-grid', 'rgba(255,255,255,.06)'),
    };
  }

  /** 十六进制色 + 透明度 → rgba()（画布不认 CSS color-mix，只能手动算） */
  function withA(hex, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /** 吉祥物换装：当前吉祥物有立绘就换上；股神猫没有主页立绘（保持原版，只有彩蛋头像） */
  function applyMascot() {
    const conf = mascotConf();
    const hero = $('heroMascot');
    if (hero) {
      if (conf.img) {
        hero.src = conf.img;
        hero.hidden = false;
      } else {
        hero.hidden = true;
      }
    }
  }

  /** 轻量应用：只切属性/存档/刷新 token 缓存，不触发重绘（启动阶段用，此时还没数据） */
  function setTheme(id, save) {
    const conf = themeConf(id);
    currentTheme = conf.id;
    if (currentTheme) document.documentElement.dataset.theme = currentTheme;
    else delete document.documentElement.dataset.theme;
    if (save) {
      try { localStorage.setItem(THEME_KEY, currentTheme); } catch (e) { /* 隐私模式等场景忽略 */ }
    }
    themeTokens();
    applyMascot();
    const b = $('themeBtn');
    if (b) b.textContent = '主题 · ' + conf.name;
  }

  /** 重绘当前视图：DOM 部分吃 CSS 变量已即时生效，这里补画布/SVG 和纯 JS 拼的 HTML */
  function repaintTheme() {
    renderStockTabs();
    if (activeView === 'home') {
      renderHome();
    } else {
      renderHeader();
      renderDepth();
      renderTape();
      renderFlow();
      renderChartMode();
      drawChart();
      renderPositions();
      renderHolders();
      renderLending();
      renderOrderPanel();
    }
  }

  // ---------- 主题选择弹窗 ----------
  function buildThemeCards() {
    const wall = $('themeWall');
    if (!wall || wall.childElementCount) return;
    for (const t of THEMES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'theme-card' + (t.id === currentTheme ? ' on' : '');
      card.dataset.theme = t.id; // 子树内直接吃到该主题的 CSS 变量，预览即所见
      card.innerHTML =
        '<span class="tc-tag">' + t.tag + '</span>' +
        '<div class="tc-demo">' +
          '<div class="tc-bar"><i class="up num">+2.35%</i><i class="down num">-1.20%</i></div>' +
          '<div class="tc-line"></div>' +
          '<div class="tc-line short"></div>' +
        '</div>' +
        '<b class="tc-name">' + t.name + '</b>' +
        '<span class="tc-desc">' + t.desc + '</span>';
      card.addEventListener('click', () => {
        setTheme(t.id, true);
        repaintTheme();
        wall.querySelectorAll('.theme-card').forEach((c) => c.classList.toggle('on', c === card));
      });
      wall.appendChild(card);
    }
  }

  function buildMascotCards() {
    const wall = $('mascotWall');
    if (!wall || wall.childElementCount) return;
    for (const m of MASCOTS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'mascot-card';
      card.dataset.mascot = m.id;
      card.title = m.desc;
      card.innerHTML =
        '<img src="' + (m.thumb || m.img) + '" alt="" loading="lazy" />' +
        '<b>' + m.name + '</b>' +
        '<span>' + m.desc + '</span>';
      card.addEventListener('click', () => {
        currentMascot = m.id;
        try { localStorage.setItem(MASCOT_KEY, m.id); } catch (e) { /* 忽略 */ }
        applyMascot();
        wall.querySelectorAll('.mascot-card').forEach((c) => c.classList.toggle('on', c === card));
        if (m.img) toast('吉祥物换成了「' + m.name + '」');
      });
      wall.appendChild(card);
    }
  }

  function openThemePicker() {
    buildThemeCards();
    const wall = $('themeWall');
    if (wall) wall.querySelectorAll('.theme-card').forEach((c) => c.classList.toggle('on', themeConf(currentTheme).id === c.dataset.theme));
    // 吉祥物区：首次进来现建，之后只刷新选中态
    buildMascotCards();
    const mw = $('mascotWall');
    if (mw) {
      const pick = currentMascot || '';
      mw.querySelectorAll('.mascot-card').forEach((c) => c.classList.toggle('on', c.dataset.mascot === pick));
    }
    $('themeOverlay').classList.remove('hidden');
  }

  /** 首次登录（本地从没存过主题选择）登录成功后弹一次 */
  function maybeFirstTheme() {
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (stored === null) openThemePicker();
  }


  // ---- 券商（出身门派）----
  // 展示元数据在**登录前**就要有（开户卡片墙），所以走公开的 /api/brokers，
  // 不能等 state（那是登录之后才拉的）。键与 config.brokers.list 一致
  let brokerMeta = {}; // key -> 展示元数据
  let pickedBroker = ''; // 登录页/转户弹窗里当前选中的券商
  let brokerFetching = false;

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
  /**
   * 记录身份。第一个参数是**账号**（身份），第二个是昵称（展示名）。
   * 只有账号变化才重置彩蛋水位——改昵称不该把事件流从头开始播。
   */
  function setIdentity(account, nick, tok) {
    // 换号 = 换一条彩蛋事件流：水位（gushen_event_seq）必须跟着清，否则新账号的
    // seq 从 0 起、本地旧水位却还在，新事件全被 `e.seq > lastEggSeq` 挡掉
    const next = account || '';
    if (next !== me) resetEggStream();
    me = next;
    myNick = nick || next;
    token = tok || '';
    if (me) localStorage.setItem('gushen_account', me);
    else localStorage.removeItem('gushen_account');
    if (myNick) localStorage.setItem('gushen_nick', myNick);
    else localStorage.removeItem('gushen_nick');
    // 老键不再写，但清掉它，避免下次启动又从一个过期的账号名兜底进来
    localStorage.removeItem('gushen_name');
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

  /** 某只股票的**全量**分时序列（跨天连续，服务端保留最近约 2 小时） */
  function histOf(stockId) {
    return histories.get(stockId) || [];
  }

  /**
   * 分时窗口的起始时刻：当日 = 今天开盘竞价开始；5 日 = 再往前 4 个交易日。
   * 锚点 `dayStartAt` 由服务端下发（客户端没有阶段偏移表，自己算不出来）。
   * 没有交易日时钟时返回 0 = 不过滤，行为与引入窗口之前逐位一致。
   */
  function minuteFrom() {
    const d = dayInfo();
    if (!d || !d.dayStartAt) return 0;
    const dayMs = Math.max(1, Number(d.dayEndsAt || 0) - Number(d.dayStartAt));
    return minuteRange === '5d' ? d.dayStartAt - (MINUTE_DAYS - 1) * dayMs : d.dayStartAt;
  }

  /** 分时图真正要画的点：按窗口裁掉更早的交易日（序列按时间升序，二分找起点） */
  function minutePts(stockId) {
    const all = histOf(stockId);
    const from = minuteFrom();
    if (!from || all.length < 2) return all;
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid].t < from) lo = mid + 1;
      else hi = mid;
    }
    return lo <= 0 ? all : all.slice(lo);
  }

  /** 切换交易终端看的股票 */
  function setActiveStock(stockId) {
    if (!stockId || stockId === activeStockId) return;
    activeStockId = stockId;
    localStorage.setItem('gushen_stock', stockId);
    priceDirty = false;
    loadHistory(stockId);
    loadHolders(stockId, true);
    if (isKline()) loadDaily(stockId);
    renderStockTabs();
    if (activeView === 'trade') {
      renderHeader();
      renderDepth();
      renderTape();
      renderFlow();
      renderChartMode();
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

  // ---------- 彩蛋（里程碑，见 Doc/彩蛋玩法方案.md） ----------
  // 判定与文案**全在服务端**（权益口径只有一处，前端重算必然漂移），这里只负责演出：
  // 服务端每帧在 account.events 里带最近若干条事件，客户端靠 `seq` 去重后串行播放。
  const EGG_SEQ_KEY = 'gushen_event_seq';
  const EGG_RARITY = ['common', 'rare', 'epic', 'legend'];
  // P0 不做全屏过场（L3）/ 全服广播（L4），统一降级成横幅 + 更长展示时间；
  // 等级仍按服务端下发的值走，P1 接上全屏时不用改判定
  const EGG_SHOW_MS = { L1: 2600, L2: 4200, L3: 6000, L4: 8000 };
  const EGG_BANNER_H = 72; // 横幅高 66（见 style.css）+ 6 间隔：toast 容器让到它下沿之外
  let lastEggSeq = null; // null = 还没从 localStorage 读过
  let eggQueue = [];
  let eggBusy = false;
  // 横幅自动收起的定时器句柄：手动点「收起」时必须一起撤掉，否则它会在几秒后
  // 把**下一条**横幅提前掐掉并推进队列（一条压一条，后面的全被截短）
  let eggTimer = null;

  function eggSeqStored() {
    const raw = localStorage.getItem(EGG_SEQ_KEY);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * 换账号 / 开新局 = 换一条事件流，水位必须跟着清。
   * 这个键是**跨账号共用**的：不清的话新账号的 seq 从 0 重新开始，而本地还留着旧账号的
   * `lastSeq`（比如 12），`e.seq > lastEggSeq` 永远不成立——彩蛋横幅与 L1 toast 会
   * 一条都不播，直到新账号攒够 13 个事件。同名的 `gushen_stock` / `gushen_chart`
   * 是纯展示偏好，可以跨账号留；水位不行。
   */
  function resetEggStream() {
    lastEggSeq = null;
    eggQueue = [];
    localStorage.removeItem(EGG_SEQ_KEY);
  }

  /**
   * 收下发下来的彩蛋事件。
   * **刷新不重播**：`lastSeq` 落 localStorage；首次进入（没有那个键）= 从当前 seq 起步，
   * 不补播历史——否则新玩家一进页面会被一堆陈年横幅糊脸。
   */
  function pumpEggs(info) {
    if (lastEggSeq === null) {
      lastEggSeq = eggSeqStored();
      if (lastEggSeq === null) {
        lastEggSeq = info.seq || 0;
        localStorage.setItem(EGG_SEQ_KEY, String(lastEggSeq));
        return;
      }
    }
    // 服务端 seq 比本地还小 = 开新局（存档被换掉）等水位回退：同样按"新事件流"处理。
    // 不能继续拿旧水位比，否则新账号的事件全被挡在门外（换号那次由 resetEggStream 兜）
    if (Number.isFinite(info.seq) && info.seq < lastEggSeq) {
      lastEggSeq = info.seq;
      localStorage.setItem(EGG_SEQ_KEY, String(lastEggSeq));
      return;
    }
    const fresh = (info.events || []).filter((e) => e && Number.isFinite(e.seq) && e.seq > lastEggSeq);
    if (!fresh.length) return;
    // 同一帧来多条时按稀有度降序排队，避免几个横幅叠在一起
    fresh.sort((a, b) => EGG_RARITY.indexOf(b.rarity) - EGG_RARITY.indexOf(a.rarity) || a.seq - b.seq);
    for (const e of fresh) eggQueue.push(e);
    lastEggSeq = Math.max(lastEggSeq, ...fresh.map((e) => e.seq));
    localStorage.setItem(EGG_SEQ_KEY, String(lastEggSeq));
    pumpEggQueue();
  }

  /** 串行播放队列：L1 直接 toast 掉不占横幅位，其余排队等横幅空出来 */
  function pumpEggQueue() {
    if (eggBusy) return;
    while (eggQueue.length && eggQueue[0].level === 'L1') toast(eggQueue.shift().text, 'egg');
    if (!eggQueue.length) return;
    showEggBanner(eggQueue.shift());
  }

  /**
   * 彩蛋横幅的落点（px）。
   * 默认 60（顶栏下沿），但顶部那三条状态横幅——停牌 / 交易日 / 追保——在**文档流**里，
   * 占的正是这块位置：它们可见时把横幅排到它们下面。改的是 fixed 元素的 `top`，不引起
   * 重排（图表不会跳），也不会盖住追保预警这种必须被看见的提示。
   */
  function eggBannerTop() {
    let bottom = 0;
    for (const id of ['haltBanner', 'dayBanner', 'marginCallBanner']) {
      const node = $(id);
      if (!node || node.hidden || !node.getBoundingClientRect) continue;
      const r = node.getBoundingClientRect();
      if (r && r.bottom > bottom) bottom = r.bottom;
    }
    return Math.max(60, Math.round(bottom) + 8);
  }

  function showEggBanner(ev) {
    const el = $('eggBanner');
    if (!el) return;
    eggBusy = true;
    const av = $('eggAvatar');
    if (av) {
      // 当前吉祥物有立绘时，彩蛋头像一起换装；没有立绘（股神猫 / 跟随主题）则用事件自带的
      // 表情头像。头像位只有 44px，所以立绘也取 -96 缩略图，不拉 -256 立绘
      const conf = mascotConf();
      av.src = conf.img ? conf.thumb : '/img/egg-cat-' + (ev.mascot || 'smug') + '-96.png';
    }
    const head = $('eggHead');
    if (head) head.textContent = `第 ${ev.day} 天 · ${ev.title}`;
    const txt = $('eggText');
    if (txt) txt.textContent = ev.text;
    // 稀有度 + 族决定配色（CSS 类，不用内联 style —— CSP 禁内联）
    el.className = 'egg-banner ' + (ev.rarity || 'common') + ' ' + (ev.kind || 'wealth');
    // 位置同样走 CSSOM：横幅让开状态横幅，toast 再让到横幅下沿之外
    // （否则第一条 toast 会被完全盖住——包括 pumpEggQueue 刚 toast 的 L1 事件
    //   和玩家的成交 / 爆仓提醒）
    const top = eggBannerTop();
    el.style.top = top + 'px';
    const tw = $('toastWrap');
    if (tw) tw.style.top = top + EGG_BANNER_H + 'px';
    el.hidden = false;
    clearTimeout(eggTimer);
    eggTimer = setTimeout(hideEggBanner, EGG_SHOW_MS[ev.level] || EGG_SHOW_MS.L2);
  }

  function hideEggBanner() {
    const el = $('eggBanner');
    if (el) {
      el.hidden = true;
      el.style.top = '';
    }
    clearTimeout(eggTimer);
    eggTimer = null;
    const tw = $('toastWrap');
    if (tw) tw.style.top = '';
    eggBusy = false;
    pumpEggQueue();
  }

  /** 主页「股神里程碑」卡：当前称号 + 下一档进度条 + 已获得称号 */
  function renderEggCard() {
    const el = $('eggCard');
    if (!el) return;
    const eggs = state && state.account && state.account.events;
    const on = !!(state && state.rules && state.rules.milestones && state.rules.milestones.enabled);
    if (!eggs || !on) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const titles = eggs.titles || [];
    const cur = eggs.title;
    const pr = eggs.progress;
    const rar = { common: '普通', rare: '稀有', epic: '史诗', legend: '传说' };

    let progressHtml = '<div class="egg-note">十二档全部达成——你已经封神。</div>';
    if (pr) {
      const pct = Math.max(2, Math.min(100, Math.round((pr.pct || 0) * 100)));
      progressHtml = `
        <div class="egg-goal">
          <label>下一档「${esc(pr.title)}」 <span class="pfull">${fmtAmount(pr.equity)}</span></label>
          <i class="mb-bar"><b data-w="${pct}"></b></i>
          <span class="egg-need">${
            pr.reached ? '已达门槛，等收盘结算确认' : `还差 ${fmtAmount(pr.need)}`
          }</span>
        </div>`;
    }
    const chips = titles.length
      ? titles
          .slice()
          .reverse()
          .map((t) => `<span class="egg-chip ${esc(t.rarity || 'common')}">${esc(t.title)}</span>`)
          .join('')
      : '<span class="empty">还没有称号——先活过今天收盘。</span>';

    el.innerHTML = `
      <div class="panel-title">
        <span>股神里程碑</span>
        <span class="panel-sub">回撤 <b>${(Math.max(0, eggs.drawdown || 0) * 100).toFixed(1)}%</b> · 历史最大 <b>${(Math.max(0, eggs.maxDrawdown || 0) * 100).toFixed(1)}%</b></span>
      </div>
      <div class="egg-top">
        ${
          cur
            ? `<span class="egg-cur ${esc(cur.rarity || 'common')}">${esc(cur.title)}</span>
               <span class="egg-cur-sub">当前称号 · ${esc(rar[cur.rarity] || '普通')}</span>`
            : '<span class="egg-cur-sub">暂无称号</span>'
        }
        <span class="egg-cur-sub">峰值权益 ${fmtAmount(eggs.peakEquity || 0)} · 已获称号 ${titles.length} 个</span>
      </div>
      ${progressHtml}
      <div class="egg-titles">${chips}</div>
    `;
    el.querySelectorAll('.mb-bar b[data-w]').forEach((n) => {
      n.style.width = Math.max(2, Math.min(100, Number(n.dataset.w) || 0)) + '%';
    });
  }

  // ---------- 登录 / 开户 ----------
  // 账号（登录凭据）与昵称（展示名）是两套规则，客户端这两条只做**软提示**，
  // 最终判定以服务端为准（broker.validateAccount / validateNick）
  const ACCOUNT_RE = /^[A-Za-z][A-Za-z0-9_-]{2,15}$/;
  const NICK_RE = /^[\p{L}\p{N}_-]{2,12}$/u;
  const ACCOUNT_HINT = '账号需 3~16 位、字母开头，仅英文 / 数字 / _ / -';
  const NICK_HINT = '昵称需 2~12 个字符，中文 / 英文 / 数字 / _ / -';

  /** 拉券商展示元数据（公开接口，登录前就要有）。失败时静默——登录仍可提交 */
  function loadBrokers() {
    if (brokerFetching) return Promise.resolve();
    brokerFetching = true;
    return apiGet('/api/brokers')
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        brokerFetching = false;
        if (!res || !res.brokers) return;
        brokerMeta = {};
        for (const b of res.brokers) brokerMeta[b.key] = b;
        brokerMeta.__selected = res.selected || {};
        brokerMeta.__weekly = res.weekly || {};
        if (!pickedBroker) pickedBroker = (res.weekly && res.weekly.key) || Object.keys(brokerMeta)[0] || '';
        renderBrokerWall();
        renderBrokerWeeklyHint();
      })
      .catch(() => {
        brokerFetching = false;
      });
  }

  /** 佣金显示成「万N」比 0.0002 直观 */
  function fmtFeeRate(rate) {
    if (!Number.isFinite(rate)) return '--';
    const wan = rate * 10000;
    return '万' + (Math.round(wan * 100) / 100).toString();
  }

  /**
   * 券商图标。`xs` 走 96px 缩略图（盘口/逐笔/排行榜这些高频小位置）——
   * 1024 原图 262KB~990KB，一屏几十个 12px 图标用原图纯属浪费；
   * 卡片墙与「我的券商」卡才用原图（§11.5）
   */
  function brokerIcon(key, cls) {
    const suffix = cls && cls.indexOf('xs') >= 0 ? '-96' : '';
    return `<img class="bk-ico ${cls || ''}" src="/img/broker-${esc(key)}${suffix}.png" alt="">`;
  }

  /** 五档/逐笔里的「券商席位」小标识：**图标必须配两字简称**——招伤与东风的红
   *  与行情「涨红」同色，只靠颜色区分会误读（Doc/券商方案.md §11.5） */
  function seatHtml(key) {
    if (!key) return '<span class="seat-cell none">--</span>';
    const b = brokerMeta[key];
    const abbr = b ? b.abbr : key;
    return `<span class="seat-cell" title="${esc(b ? b.name : key)}">${brokerIcon(key, 'xs')}<span class="seat-abbr">${esc(abbr)}</span></span>`;
  }

  /**
   * 一张券商卡片。登录开户墙与转户弹窗共用同一份渲染：
   * 图标 + 名称 + 人设 + 强项/代价 chip + 关键数值 + 拥挤度条（CSSOM 设宽度，CSP 禁内联样式）。
   * @param {string} key
   * @param {{mode?:'pick'|'view', dim?:boolean, tag?:string}} [opts]
   */
  function brokerCardHtml(key, opts) {
    const o = opts || {};
    const b = brokerMeta[key];
    if (!b) return '';
    const p = b.preview || {};
    const tier = esc(b.crowdTier || 'normal');
    const on = o.mode !== 'view' && key === pickedBroker;
    const cls = ['broker-card'];
    if (on) cls.push('on');
    if (o.dim) cls.push('dim');
    if (o.mode === 'view') cls.push('locked');
    const week = brokerMeta.__weekly && brokerMeta.__weekly.key === key;
    const cnt = (brokerMeta.__selected || {})[key] || 0;
    return `<div class="${cls.join(' ')}" data-bk="${esc(key)}">
      <div class="bk-top">
        ${brokerIcon(key)}
        <div>
          <div class="bk-name">${esc(b.name)}<span class="bk-abbr">${esc(b.abbr)}</span></div>
          <div class="bk-metrics">已有 ${b.virtualClients} 万客户${cnt > 0 ? ` · 本服 ${cnt} 人已选` : ''}</div>
        </div>
      </div>
      <div class="bk-persona">${esc(b.persona)}</div>
      <div class="bk-chips">
        ${(b.strengths || []).slice(0, 2).map((s) => `<span class="chip good">${esc(s)}</span>`).join('')}
        ${(b.costs || []).slice(0, 1).map((s) => `<span class="chip bad">${esc(s)}</span>`).join('')}
        ${week ? '<span class="chip gold">本周之星 · 佣金减半</span>' : ''}
        ${o.tag ? `<span class="chip">${esc(o.tag)}</span>` : ''}
      </div>
      <div class="bk-metrics">
        佣金 <b>${fmtFeeRate(p.feeRate)}</b> · 冷却 <b>${(p.cooldownMs / 1000).toFixed(1)}s</b> ·
        锁仓 <b>${(p.lockMs / 1000).toFixed(0)}s</b> · 融资 <b>${p.leverage}×</b><br>
        保证金 <b>${Math.round((p.financeRatio || 0) * 100)}%</b> · 券源 <b>${p.lendCapacityPct}%</b> ·
        策略 <b>${p.autoMax} 条</b>${p.newsLeadMs ? ` · 提前量 <b>${(p.newsLeadMs / 1000).toFixed(1)}s</b>` : ''}
      </div>
      <div class="bk-foot">
        <span class="bk-crowd">拥挤度 ${b.crowdPct}%<i class="crowd-bar"><b data-w="${b.crowdPct}" data-tier="${tier}"></b></i></span>
        <span class="crowd-tag ${tier}">${esc(b.crowdLabel)}</span>
      </div>
      <div class="bk-persona">适合：${esc(b.suitable)}</div>
    </div>`;
  }

  /** 把卡片里的拥挤度条宽度用 CSSOM 设好（CSP 禁内联 style 属性） */
  function paintCrowdBars(root) {
    if (!root) return;
    const TIERS = ['heavy', 'light', 'normal', 'subsidy'];
    root.querySelectorAll('.crowd-bar b[data-w]').forEach((el) => {
      const w = Number(el.dataset.w) || 0;
      el.style.width = Math.max(2, Math.min(100, w)) + '%';
      const t = String(el.dataset.tier || '');
      el.className = TIERS.indexOf(t) >= 0 ? t : 'normal';
    });
  }

  function renderBrokerWall() {
    const wall = $('brokerWall');
    if (!wall) return;
    const keys = brokerKeys();
    if (!keys.length) {
      wall.innerHTML = '<div class="bk-persona">券商列表加载中…（若一直为空，请检查服务端 /api/brokers）</div>';
      return;
    }
    wall.innerHTML = keys.map((k) => brokerCardHtml(k, { mode: 'pick' })).join('');
    paintCrowdBars(wall);
    wall.querySelectorAll('.broker-card').forEach((el) => {
      el.addEventListener('click', () => {
        pickedBroker = el.dataset.bk;
        renderBrokerWall();
      });
    });
  }

  function brokerKeys() {
    return Object.keys(brokerMeta).filter((k) => k.indexOf('__') !== 0);
  }

  function renderBrokerWeeklyHint() {
    const el = $('brokerWeeklyHint');
    const w = brokerMeta.__weekly;
    if (!el) return;
    if (!w || !w.key || !brokerMeta[w.key]) {
      el.textContent = '';
      return;
    }
    el.textContent = `本周之星：${brokerMeta[w.key].name}（佣金减半 · 额度 +0.5×）`;
  }

  /** 登录弹层切到第几步：1 = 输账号，2 = 开户（填昵称 + 选券商） */
  function showLoginStep(step, account, nick) {
    const step2 = step === 2;
    $('loginStep1').hidden = step2;
    $('loginStep2').hidden = !step2;
    $('loginErr').hidden = true;
    if (step2) {
      $('onboardAccount').textContent = account || '';
      $('loginNick').value = nick || '';
      loadBrokers(); // 卡片墙的数据源（公开接口，登录前就能读）
      // 开户流程开场先播一套四宫格漫画（4 选 1），播完 / 跳过后再聚焦昵称框。
      // comicPlayed 只锁本次页面：「换账号」退回第一步再进来不重复打扰
      if (comicPlayed) {
        $('loginNick').focus();
      } else {
        comicPlayed = true;
        openComic(() => $('loginNick').focus());
      }
    } else {
      $('loginAccount').value = account || '';
      $('loginAccount').focus();
    }
  }

  // ---------- 开户四宫格漫画 ----------
  /**
   * 开户第二步之前播一套四宫格（A/B/C/D 随机 4 选 1）。
   * 图在 `Client/img/comic-<set><n>.png`（512px，服务端 http.js 白名单登记），
   * **画面里不带任何文字**——台词全在下面这张表里由 DOM 字幕层渲染，
   * 所以改文案不用重画图。完整分镜与接入说明：Doc/开户四宫格漫画.md
   */
  const COMIC_SEEN_KEY = 'gushen_comic_seen'; // 看过哪几套（跨会话，四套轮完再从头）
  const COMICS = [
    {
      id: 'A',
      short: '起点',
      title: '股神都是这么开始的',
      panels: [
        { who: '股神猫', text: '听说每个股神，都有一个凡人的起点。' },
        { who: '股神猫', text: '本喵入市时只有 100 万，现在……也就一个亿吧。' },
        { who: '股神猫', text: '先别飘。股神，是从开户这一步开始的。' },
        { who: '股神猫', text: '起名要响，门派要准——剩下的，交给行情。' },
      ],
    },
    {
      id: 'B',
      short: '门派',
      title: '门派拜师记',
      panels: [
        { who: '旁白', text: '江湖传言：入对门派，少亏十年。' },
        { who: '仓鼠', text: '钟信要钱多，滑泰跑得快，天疯……一天归零？！' },
        { who: '股神猫', text: '没有最强的门派，只有最适合你的打法。' },
        { who: '股神猫', text: '股神的江湖，从择门开始。' },
      ],
    },
    {
      id: 'C',
      short: '第一课',
      title: '猫的市场第一课',
      panels: [
        { who: '旁白', text: '这里的股市会呼吸：消息一出，满城风雨。' },
        { who: '股神猫', text: '机构在算，散户在冲——你要赚谁的钱？' },
        { who: '股神猫', text: '很好，赔钱的人都是这么想的。' },
        { who: '股神猫', text: '先开户，再交学费——哦不，是赚学费。' },
      ],
    },
    {
      id: 'D',
      short: '挑战',
      title: '三秒开户挑战',
      panels: [
        { who: '股神猫', text: '下一个。要变股神的排队，要变韭菜的也排队。' },
        { who: '仓鼠', text: '我要满仓！我要杠杆！我要明天一个亿！' },
        { who: '股神猫', text: '先立个小小的目标。上一个这么说的，锦旗就是他留的。' },
        { who: '股神猫', text: '名字起好，券商选好——故事从这一页开始。' },
      ],
    },
  ];
  let comicPlayed = false; // 本次页面会话只播一次
  let comicTimers = []; // 打字机 / 换格的 pending 计时器，跳过时要全部清掉
  let comicFinish = null; // 收场回调（聚焦昵称框）
  let comicDone = false; // 四格都播完了没有（决定「跳过」是收场还是直接进门）
  let comicCurrent = null;
  /** false = 开户过场（随机 1 套、播完「开始开户」）；true = 首页回看（可翻四套、播完「下一套」） */
  let comicReplay = false;

  const prefersReduced = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function comicSeen() {
    try {
      const v = JSON.parse(localStorage.getItem(COMIC_SEEN_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  /** 优先播没看过的；四套都看过就清空重来（避免紧接着又播同一套） */
  function pickComic() {
    const seen = comicSeen();
    let pool = COMICS.filter((c) => seen.indexOf(c.id) < 0);
    if (!pool.length) {
      pool = COMICS;
      try {
        localStorage.removeItem(COMIC_SEEN_KEY);
      } catch (e) {
        /* 隐私模式下写不进就算了 */
      }
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function rememberComic(id) {
    try {
      const seen = comicSeen();
      if (seen.indexOf(id) < 0) seen.push(id);
      localStorage.setItem(COMIC_SEEN_KEY, JSON.stringify(seen));
    } catch (e) {
      /* localStorage 不可用：只是重复播放概率高一点，不影响功能 */
    }
  }

  function stopComicTimers() {
    comicTimers.forEach((t) => clearTimeout(t));
    comicTimers = [];
  }

  /** 字幕逐字出现。光标是**兄弟节点**（不塞进文字里）——这样只靠 textContent 截断推进，
   *  不需要 text node，字幕层在离屏 DOM 桩里也能跑 */
  function typeComicText(el, text, done) {
    el.textContent = '';
    let i = 0;
    const tick = () => {
      if (i >= text.length) {
        if (done) done();
        return;
      }
      i += 1;
      el.textContent = text.slice(0, i);
      comicTimers.push(setTimeout(tick, 45));
    };
    tick();
  }

  const comicImg = (comic, i) => `/img/comic-${comic.id.toLowerCase()}${i + 1}.png`;

  const comicNo = () => COMICS.findIndex((c) => comicCurrent && c.id === comicCurrent.id) + 1;

  /** 进度行：开户过场只报格数；回看多报一个「第几套」，让玩家知道还有几套没翻 */
  function comicProgressText(cells) {
    const total = comicCurrent ? comicCurrent.panels.length : 4;
    const tail = `${cells} / ${total} 格`;
    return comicReplay ? `第 ${comicNo()} / ${COMICS.length} 套 · ${tail}` : tail;
  }

  /** 宫格 HTML：每格图 + 说话人 + 字幕槽（台词不进图，改文案不用重画） */
  function comicPanelsHtml(comic) {
    return comic.panels
      .map(
        (p, i) => `
      <figure class="comic-panel" data-i="${i}">
        <img src="${comicImg(comic, i)}" alt="第 ${i + 1} 格">
        <figcaption class="comic-cap">
          <span class="comic-who">${esc(p.who)}</span>
          <span class="comic-text"></span><span class="comic-caret">▍</span>
        </figcaption>
      </figure>`
      )
      .join('');
  }

  /** 回看模式的四套切换片（开户过场里整块藏起来） */
  function renderComicSets() {
    const box = $('comicSets');
    if (!box) return;
    if (!comicReplay) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = COMICS.map(
      (c) =>
        `<button class="comic-set${comicCurrent && c.id === comicCurrent.id ? ' on' : ''}" type="button" data-comic="${c.id}">${c.id} · ${esc(c.short)}</button>`
    ).join('');
  }

  /** 一次把所有格子和整段台词摊开（跳过 / 减少动效时用） */
  function revealComicAll() {
    const comic = comicCurrent;
    if (!comic) return;
    const grid = $('comicGrid');
    grid.querySelectorAll('.comic-caret').forEach((n) => n.classList.add('hidden'));
    grid.querySelectorAll('.comic-panel').forEach((p, i) => {
      p.classList.add('on');
      const t = p.querySelector('.comic-text');
      if (t && comic.panels[i]) t.textContent = comic.panels[i].text;
    });
  }

  /** 四格播完：按钮亮出来。开户 → 「开始开户」；回看 → 「下一套 ›」（四套轮着翻） */
  function finishComic() {
    comicDone = true;
    const go = $('comicGoBtn');
    $('comicProgress').textContent = comicReplay
      ? `第 ${comicNo()} / ${COMICS.length} 套 · 故事讲完了`
      : `${comicCurrent ? comicCurrent.panels.length : 4} / ${comicCurrent ? comicCurrent.panels.length : 4} 格 · 故事讲完了`;
    if (go) {
      go.textContent = comicReplay ? '下一套 ›' : '开始开户';
      go.hidden = false;
      go.focus();
    }
  }

  function playComic() {
    const comic = comicCurrent;
    const grid = $('comicGrid');
    const fast = prefersReduced();
    let idx = 0;
    const step = () => {
      if (!comic) return;
      if (idx >= comic.panels.length) {
        finishComic();
        return;
      }
      const panel = grid.querySelector(`.comic-panel[data-i="${idx}"]`);
      const txt = panel && panel.querySelector('.comic-text');
      $('comicProgress').textContent = comicProgressText(idx + 1);
      if (panel) panel.classList.add('on');
      if (!txt) {
        idx += 1;
        step();
        return;
      }
      if (fast) {
        txt.textContent = comic.panels[idx].text;
        idx += 1;
        step();
        return;
      }
      typeComicText(txt, comic.panels[idx].text, () => {
        const caret = panel.querySelector('.comic-caret');
        if (caret) caret.classList.add('hidden'); // 本格打完，光标收掉
        idx += 1;
        // 每格台词打完停 900ms 再出下一格，给玩家读完的时间
        comicTimers.push(setTimeout(step, 900));
      });
    };
    if (fast) {
      revealComicAll();
      finishComic();
      return;
    }
    step();
  }

  /** 换一套重播（只给回看模式用；开户过场固定随机那一套，不让人先挑） */
  function switchComic(id) {
    const next = COMICS.filter((c) => c.id === id)[0];
    if (!next || (comicCurrent && next.id === comicCurrent.id)) return;
    stopComicTimers();
    comicCurrent = next;
    rememberComic(next.id);
    comicDone = false;
    $('comicTitle').textContent = next.title;
    $('comicProgress').textContent = '';
    $('comicGoBtn').hidden = true;
    $('comicGrid').innerHTML = comicPanelsHtml(next);
    renderComicSets();
    playComic();
  }

  /** 回看模式「下一套」：按 A→B→C→D→A 循环，比再随机一次好预期 */
  function nextComic() {
    if (!comicCurrent) return;
    const i = COMICS.findIndex((c) => c.id === comicCurrent.id);
    switchComic(COMICS[(i + 1) % COMICS.length].id);
  }

  /**
   * 打开漫画层。
   * @param {Function} [onDone] 收场回调（开户流程用来聚焦昵称框）
   * @param {boolean}  [replay] true = 首页回看：四套可翻、按钮文案换成「下一套」
   */
  function openComic(onDone, replay) {
    const overlay = $('comicOverlay');
    if (!overlay) {
      if (onDone) onDone();
      return;
    }
    comicReplay = !!replay;
    const comic = pickComic();
    rememberComic(comic.id);
    comicCurrent = comic;
    comicFinish = onDone || null;
    comicDone = false;
    stopComicTimers();
    // 两种模式的措辞分开：过场是催着开户，回看是「随便翻」
    if ($('comicKicker')) $('comicKicker').textContent = comicReplay ? '开户漫画 · 四套随便翻' : '开户前，先看个故事';
    if ($('comicSkipBtn')) $('comicSkipBtn').textContent = comicReplay ? '关闭' : '跳过 ›';
    $('comicTitle').textContent = comic.title;
    $('comicProgress').textContent = '';
    $('comicGoBtn').hidden = true;
    $('comicGrid').innerHTML = comicPanelsHtml(comic);
    renderComicSets();
    overlay.classList.remove('hidden');
    // 预载本套四张：逐格出现时不再等网络（离屏 DOM 桩里没有 Image，跳过即可）
    if (typeof Image === 'function') {
      comic.panels.forEach((p, i) => {
        const im = new Image();
        im.src = comicImg(comic, i);
      });
    }
    playComic();
  }

  /** 收场：藏起过场、回到开户表单 / 首页。跳过与「开始开户」都走这里 */
  function closeComic() {
    const overlay = $('comicOverlay');
    if (!overlay || overlay.classList.contains('hidden')) return;
    stopComicTimers();
    overlay.classList.add('hidden');
    $('comicGrid').innerHTML = '';
    if ($('comicSets')) {
      $('comicSets').hidden = true;
      $('comicSets').innerHTML = '';
    }
    comicCurrent = null;
    comicDone = false;
    comicReplay = false;
    const cb = comicFinish;
    comicFinish = null;
    if (cb) cb();
  }

  function bindComic() {
    const skip = $('comicSkipBtn');
    if (skip) skip.addEventListener('click', closeComic);
    // 「开始开户」收场；回看模式下同一颗按钮变成「下一套」
    const go = $('comicGoBtn');
    if (go) {
      go.addEventListener('click', () => {
        if (comicReplay) nextComic();
        else closeComic();
      });
    }
    // 四套切换片（事件委托；桩环境里没有 closest，用 dataset 兜一层保护）
    const sets = $('comicSets');
    if (sets) {
      sets.addEventListener('click', (e) => {
        const t = e && e.target;
        const chip = t && t.closest ? t.closest('.comic-set') : null;
        if (!chip || !chip.dataset) return;
        switchComic(chip.dataset.comic);
      });
    }
    // 首页「看漫画」：回看入口，和开户流程完全脱钩（不传 onDone）
    const replayBtn = $('comicReplayBtn');
    if (replayBtn) replayBtn.addEventListener('click', () => openComic(null, true));
    // 首页「AI 主力」：跳观测台（会话 token 由 whales.html 自己从 localStorage 读）
    const whalesBtn = $('whalesBtn');
    if (whalesBtn) whalesBtn.addEventListener('click', () => { location.href = '/whales.html'; });
    const portalBtn = $('portalBtn');
    if (portalBtn) portalBtn.addEventListener('click', () => { location.href = '/portal.html'; });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const overlay = $('comicOverlay');
      if (overlay && !overlay.classList.contains('hidden')) closeComic();
    });
  }

  /** 弹回登录页（首次进入 / 换号 / 登录态失效都走这里），停在第一步 */
  function showLogin(account) {
    $('loginOverlay').classList.remove('hidden');
    showLoginStep(1, account == null ? me : account);
  }

  /**
   * 静默探测（页面加载 / 令牌失效后自动重登）：成功就直接进市场，没开过户就**停在第一步**。
   *
   * 落点是刻意的——**开户步骤只能由玩家点一次「登录」进入**，不在加载时自动跳。
   * 否则本地还留着上一局（或已被清库）的账号名时，一打开页面就直接是「填昵称 + 选券商」，
   * 玩家会以为自己没经过登录。账号预填在输入框里，点一次「登录」就继续。
   */
  function probeLogin(account) {
    return apiPost('/api/login', { account })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok) {
          setIdentity(res.account, res.nick, res.token);
          enterApp();
          maybeFirstTheme(); // 首次登录弹一次主题选择（之后从顶栏「主题」随时换）
          return res;
        }
        // 没开完户 / 登录失败：界面回到第一步，账号预填回输入框。
        // **不合规的名字不预填**（老档中文名 / 手输的脏数据）：那种名字点了必被打回，
        // 预填只会让玩家对着一个"一提交就报错"的框发愣
        const keep = ACCOUNT_RE.test(res.account || account) ? res.account || account : '';
        setIdentity(keep, res.nick || myNick, '');
        showLogin(keep);
        return res;
      });
  }

  /**
   * 玩家点了「登录」：成功进市场，没开过户就**切到开户步骤**（填昵称 + 选券商），
   * 免得让玩家再输一遍账号。返回服务端响应，调用方只管展示错误文案。
   */
  function doLoginFlow(account) {
    return apiPost('/api/login', { account })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok) {
          setIdentity(res.account, res.nick, res.token);
          enterApp();
          maybeFirstTheme();
          return res;
        }
        // 服务端会回带该账号已填过的昵称（老档可能没有），有就预填省一次输入
        if (res.needOnboard) showLoginStep(2, res.account || account, res.nick || '');
        return res;
      });
  }

  /** 开户（第二步）：账号 + 昵称 + 券商一次提交，成功即进市场（等价于"首次登录"） */
  function doOnboardFlow(account, nick, broker) {
    return apiPost('/api/onboard', { account, nick, broker })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok) {
          setIdentity(res.account, res.nick, res.token);
          enterApp();
          maybeFirstTheme();
        }
        return res;
      });
  }

  function bindLogin() {
    const accEl = $('loginAccount');
    const nickEl = $('loginNick');
    const setHint = (el, msg) => {
      el.textContent = msg;
      el.classList.toggle('bad', !!msg);
    };
    const fail = (msg) => {
      const err = $('loginErr');
      err.hidden = false;
      err.textContent = msg;
    };

    // 两条规则都只做**软提示**：最终判定在服务端（同一个账号在服务端眼里才是权威）
    accEl.addEventListener('input', () => {
      const v = accEl.value.trim();
      setHint($('accountHint'), !v || ACCOUNT_RE.test(v) ? '' : ACCOUNT_HINT);
    });
    nickEl.addEventListener('input', () => {
      const v = nickEl.value.trim();
      setHint($('nickHint'), NICK_RE.test(v) ? '' : NICK_HINT);
    });

    /** 第一步：先本地卡一道明显不合法的输入，再交给服务端 */
    const doLogin = () => {
      const account = accEl.value.trim();
      $('loginErr').hidden = true;
      if (!account) {
        toast('请输入账号', 'err');
        return;
      }
      // 规则不合只给**软提示**，照样提交：最终判定在服务端（老档里可能存在中文账号，
      // 本地硬拦会把它的玩家锁在门外——服务端认识它就会放行）
      setHint($('accountHint'), ACCOUNT_RE.test(account) ? '' : ACCOUNT_HINT);
      doLoginFlow(account)
        .then((res) => {
          if (!res.ok && !res.needOnboard) fail(res.error || '登录失败');
        })
        .catch(() => toast('网络异常，请重试', 'err'));
    };

    const doOnboard = () => {
      const account = $('onboardAccount').textContent.trim();
      const nick = nickEl.value.trim();
      $('loginErr').hidden = true;
      if (!NICK_RE.test(nick)) {
        fail(NICK_HINT);
        return;
      }
      if (!pickedBroker) {
        fail('请选择一家券商开户');
        return;
      }
      doOnboardFlow(account, nick, pickedBroker)
        .then((res) => {
          if (!res.ok) fail(res.error || '开户失败');
        })
        .catch(() => toast('网络异常，请重试', 'err'));
    };

    $('loginBtn').addEventListener('click', doLogin);
    accEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
    nickEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doOnboard();
    });
    $('onboardBtn').addEventListener('click', doOnboard);
    // 刚才账号输错了：退回第一步，把输入留在框里
    $('onboardBackBtn').addEventListener('click', () => showLoginStep(1, accEl.value.trim()));
    $('switchBtn').addEventListener('click', () => {
      if (confirm('切换账号？当前账号将退出登录。')) {
        setIdentity('', '', '');
        location.reload();
      }
    });
    // 改昵称：昵称只是展示名，随时可改、不要求唯一，所以这里只校验格式
    bindNickDialog();
    // 主题：顶栏常驻入口 + 选择弹窗
    $('themeBtn').addEventListener('click', openThemePicker);
    $('themeConfirmBtn').addEventListener('click', () => {
      try { localStorage.setItem(THEME_KEY, currentTheme); } catch (e) {}
      $('themeOverlay').classList.add('hidden');
      toast('已切换到「' + themeConf(currentTheme).name + '」');
    });
    $('themeCloseBtn').addEventListener('click', () => $('themeOverlay').classList.add('hidden'));
  }

  /**
   * 顶栏身份：显示**昵称**（给人看的），账号放进 title（那才是登录凭据）。
   * 排行榜/股东榜上"我在哪一行"的判定永远用账号，不能用昵称——昵称可重名、可改。
   */
  function renderIdentity() {
    const el = $('whoName');
    if (!el) return;
    el.textContent = myNick || me || '--';
    el.title = me ? `账号：${me}（登录凭据，不可改）` : '';
  }

  /**
   * 改昵称：只走格式校验 + 服务端写入。账号（me）与令牌都不动，彩蛋水位也不动——
   * 换个展示名不该把事件流从头开始播。
   */
  function saveNick(nick) {
    return apiPost('/api/nick', { nick })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok) {
          myNick = res.nick;
          try { localStorage.setItem('gushen_nick', myNick); } catch (e) {}
          renderIdentity();
        }
        return res;
      });
  }

  /** 改昵称弹窗：昵称不唯一、不影响任何数值，所以这里只挡格式 */
  function bindNickDialog() {
    const input = $('nickInput');
    const hint = $('nickEditHint');
    const close = () => $('nickOverlay').classList.add('hidden');
    const save = () => {
      const v = input.value.trim();
      if (!NICK_RE.test(v)) {
        hint.textContent = NICK_HINT;
        hint.classList.add('bad');
        return;
      }
      saveNick(v)
        .then((res) => {
          if (!res.ok) {
            hint.textContent = res.error || '改昵称失败';
            hint.classList.add('bad');
            return;
          }
          toast('昵称已改为「' + res.nick + '」');
          close();
        })
        .catch(() => toast('网络异常，请重试', 'err'));
    };
    $('nickBtn').addEventListener('click', () => {
      $('nickAccount').textContent = me || '--';
      input.value = myNick || '';
      hint.textContent = '';
      hint.classList.remove('bad');
      $('nickOverlay').classList.remove('hidden');
      input.focus();
    });
    $('nickCancelBtn').addEventListener('click', close);
    $('nickSaveBtn').addEventListener('click', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
    input.addEventListener('input', () => {
      const ok = NICK_RE.test(input.value.trim());
      hint.textContent = ok ? '' : NICK_HINT;
      hint.classList.toggle('bad', !ok);
    });
  }

  // ---------- 上市公司档案（股娘图鉴） ----------
  /** 顶栏点股票名：打开档案弹层（指数没有公司档案，只提示） */
  function openCompanyProfile() {
    dismissArchiveHint();
    const m = curMarket();
    if (!m) return;
    const lore = window.COMPANY_LORE && window.COMPANY_LORE[m.stockId];
    if (!lore) {
      toast('「' + m.name + '」是指数，没有公司档案 · 点一只股票看看', 'err');
      return;
    }
    $('companyRibbon').style.background =
      'linear-gradient(120deg, ' + lore.color + ' 0%, rgba(0,0,0,0) 70%)';
    $('companyImg').src = lore.img;
    $('companyImg').alt = lore.waifu + '（' + m.name + '拟人）';
    $('companyLogo').src = lore.logo;
    $('companyLogo').alt = m.name + '徽记';
    $('companyName').textContent = m.name;
    $('companyCode').textContent = m.stockId;
    $('companyWaifu').textContent = '拟人 · ' + lore.waifu;
    const wf = $('companyWaifu');
    // 胶囊跟着公司主题色走（CSSOM 改，CSP 不允许内联 style= 属性）
    wf.style.background = lore.color + '2e';
    wf.style.borderColor = lore.color;
    $('companyTitle').textContent = lore.title;
    $('companyIntro').textContent = lore.intro;
    const ch = cls(m.change);
    $('companyStats').innerHTML =
      '<div class="cs-item"><label>最新价</label><b class="' + ch + '">' + esc(fmtP(m.last)) + '</b></div>' +
      '<div class="cs-item"><label>涨跌幅</label><b class="' + ch + '">' +
        (m.changePct >= 0 ? '+' : '') + esc(m.changePct.toFixed(2)) + '%</b></div>' +
      '<div class="cs-item"><label>成交量</label><b>' + esc(fmtVol(m.volume)) + '</b></div>' +
      '<div class="cs-item"><label>成交额</label><b>' + esc(fmtAmount(m.turnover)) + '</b></div>';
    $('companyOverlay').classList.remove('hidden');
  }

  function bindCompanyProfile() {
    $('stockBtn').addEventListener('click', openCompanyProfile);
    $('companyCloseBtn').addEventListener('click', () => $('companyOverlay').classList.add('hidden'));
    // 点遮罩空白处关闭（点卡片本身不关）
    $('companyOverlay').addEventListener('click', (e) => {
      if (e.target === $('companyOverlay')) $('companyOverlay').classList.add('hidden');
    });
    // 全员合照：从档案底部进入（关档案开合照，同一时刻只留一层弹窗）
    $('companyPosterBtn').addEventListener('click', () => {
      $('companyOverlay').classList.add('hidden');
      $('posterOverlay').classList.remove('hidden');
    });
    $('posterCloseBtn').addEventListener('click', () => $('posterOverlay').classList.add('hidden'));
    $('posterOverlay').addEventListener('click', (e) => {
      if (e.target === $('posterOverlay')) $('posterOverlay').classList.add('hidden');
    });
  }

  // 上市公司档案入口的一次性指引：只弹一次（localStorage 记账），
  // 已经手动点开过档案、或看过这条提示的玩家都不再弹
  const ARCHIVE_HINT_KEY = 'gushen_archive_hint';
  let archiveShowTimer = 0;
  let archiveHideTimer = 0;

  function maybeShowArchiveHint() {
    if (localStorage.getItem(ARCHIVE_HINT_KEY)) return;
    const hint = $('stockHint');
    if (!hint) return;
    clearTimeout(archiveShowTimer);
    clearTimeout(archiveHideTimer);
    archiveShowTimer = setTimeout(() => {
      if (localStorage.getItem(ARCHIVE_HINT_KEY)) return;
      hint.hidden = false;
      archiveHideTimer = setTimeout(dismissArchiveHint, 12000);
    }, 1500);
  }

  function dismissArchiveHint() {
    clearTimeout(archiveShowTimer);
    clearTimeout(archiveHideTimer);
    const hint = $('stockHint');
    if (hint) hint.hidden = true;
    localStorage.setItem(ARCHIVE_HINT_KEY, '1');
  }

  function enterApp() {
    $('loginOverlay').classList.add('hidden');
    $('app').classList.remove('hidden');
    renderIdentity();
    loadInitial();
    connectSSE();
    setView('home'); // 登录后先落到交易大厅
    maybeShowArchiveHint();
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
      if (isKline()) loadDaily(activeStockId); // K 线同理：只在真要看的时候拉
      renderStockTabs();
      renderHeader();
      renderDepth();
      renderTape();
      renderFlow();
      renderChartMode();
      renderPositions();
      renderHolders();
      renderLending();
      renderOrderPanel();
      renderRisk();
      renderSeats();
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
        if (isKline()) loadDaily(activeStockId);
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
        // 定格期（竞价/午休/夜间）：服务端序列里带着这一段的平线，落地前先塌成一个锚点，
        // 否则刷新/切股票后会先看到一条爬到"现在"的水平线，等下一帧才收回去
        const freezeAt = frozenPhaseStart();
        if (freezeAt != null) {
          const tail = merged.length ? merged[merged.length - 1] : null;
          cutAfter(merged, freezeAt);
          if (tail && merged.length && merged[merged.length - 1].t < freezeAt) {
            merged.push({ t: freezeAt, price: tail.price, vol: tail.vol });
          }
        }
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

  /** 令牌失效（例如服务端重启）：用原**账号**重新登录一次（昵称不参与身份） */
  function relogin() {
    if (relogging) return;
    relogging = true;
    apiPost('/api/login', { account: me })
      .then((r) => r.json())
      .then((res) => {
        relogging = false;
        if (res.ok) {
          setIdentity(res.account, res.nick, res.token);
          toast('服务已重启，已自动重新登录', 'info');
          loadInitial();
          connectSSE();
          return;
        }
        // 账号没开完户（服务端换了库）/ 账号不合法：退回登录页**第一步**，
        // 由玩家自己点一次「登录」再进开户流程。账号留在本地、只作废令牌
        toast(res.error || '登录状态已失效，请重新登录', 'err');
        const account = me;
        setIdentity(account, res.nick || myNick, '');
        es && es.close();
        $('app').classList.add('hidden');
        showLogin(res.needOnboard ? res.account || account : account);
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
    // 服务端是昵称的权威（别的标签页改过名 / 改名请求刚回来）：跟着它同步顶栏
    if (s.account && s.account.nick && s.account.nick !== myNick) {
      myNick = s.account.nick;
      try { localStorage.setItem('gushen_nick', myNick); } catch (e) { /* 忽略 */ }
      renderIdentity();
    }
    $('connDot').classList.remove('off');
    ensureStock();

    // 每只股票按帧追加一个分时点（同时间戳去重）。SSE 帧本身不带分时，
    // 客户端自己往后累积；切股票时再用 /api/history 拉一次全量补历史。
    // 集合竞价与休市期价格是冻住的（竞价只入簿、不撮合），这时不逐帧打点，
    // 整段塌成一个锚点——见 addFramePoint
    const freezeAt = frozenPhaseStart();
    for (const m of marketList()) {
      addFramePoint(histories, m.stockId, s.serverTime, m.last, m.volume, freezeAt);
      addFramePoint(sparks, m.stockId, s.serverTime, m.last, m.volume, freezeAt);
    }
    if (s.index) addFramePoint(histories, s.index.stockId, s.serverTime, s.index.last, 0, freezeAt);

    // 日线缓存作废的时机有两个：**跨天**（图里要多一根）与**进入夜间**（当日那根刚刚收盘定格）。
    // 少作废一次，夜间就会拿已经归零的实时行情（成交量额清零、开高低都等于收盘价）
    // 拼出一根假的当日 K 线，把服务端刚落下的那根真 K 线盖掉
    const dayNo = s.day && s.day.day ? s.day.day : 0;
    const dayKey = dayNo ? dayNo + (s.day.phase === 'night' ? ':settled' : ':open') : '';
    if (dayKey && dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      dayLoaded.clear();
      if (isKline()) loadDaily(activeStockId);
    }

    renderHeader();
    renderStockTabs();
    renderHalt();
    renderDay();
    renderDepth();
    renderTape();
    renderFlow();
    renderChartMode();
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
    renderMarginCall();
    if (activeTab === 'seats') renderSeats();

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
    // 彩蛋事件（服务端下发最近若干条，这里按 seq 去重后串行播放）
    if (s.account && s.account.events) pumpEggs(s.account.events);

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

  // ---------- 分时定格（集合竞价 / 午休 / 夜间） ----------
  //
  // 服务端每 tick 都往分时序列补一个点，可它并不区分阶段：集合竞价只入簿不撮合、
  // 午休与夜间直接冻结行情，这几段里价格一动不动。客户端要是照抄，线就会被拉成一条
  // 越来越长的水平直线——价没动、线在动，x 轴跟着最新点一路右移，整张图都在"走"，
  // 看起来像还在连续交易。
  //
  // 这里的口径是：**只有连续竞价（trading 且非 auction）才让分时往后生长**。
  // 定格期整段只留阶段起点一个锚点，画面完全静止；夜间结算把收盘价定死时，
  // 这个锚点原地换价（线只跳一下，不拖尾巴），恢复交易后才重新生长。
  // 阶段与否一律吃服务端下发的 state.day，客户端不自己算阶段。

  /** 定格期返回本阶段的**起点时刻**（分时锚点）；连续竞价/没有交易日时钟返回 null */
  function frozenPhaseStart() {
    const d = dayInfo();
    if (!d) return null;
    if (d.trading && !d.auction) return null;
    // phaseStartAt 没有直接下发：用「阶段末尾 − 阶段时长」反推，与 gameClockNow 同一套算法
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

  // ---------- 顶栏 ----------
  function renderHeader() {
    const m = curMarket();
    if (!m) return;
    $('stockName').textContent = m.name;
    $('stockCode').textContent = m.stockId;
    // 公司徽记：指数没有档案数据，隐藏 logo 位
    const lore = window.COMPANY_LORE && window.COMPANY_LORE[m.stockId];
    const sl = $('stockLogo');
    if (sl) {
      sl.hidden = !lore;
      if (lore && sl.getAttribute('src') !== lore.logo) sl.src = lore.logo;
    }
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
    renderClock();
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
        const lore = window.COMPANY_LORE && window.COMPANY_LORE[m.stockId];
        const logo = lore ? `<img class="sc-logo" src="${lore.logo}" alt="" loading="lazy">` : '';
        return `<button class="stock-chip${on}" data-stock="${esc(m.stockId)}">
          <span class="sc-name">${logo}${esc(m.name)}</span>
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
    // 整侧没有挂单时渲染一行说明，而不是五行 "--"：五行空占位看起来像渲染坏了，
    // 玩家分不清是"没人挂"还是"页面出错"（服务端买盘空档实测占连续竞价的 7.8%，
    // 属于会经常遇到的正常状态，必须能被正确读懂）
    $('asksBody').innerHTML = asks.length
      ? Array.from({ length: 5 }, (_, i) => depthRow('卖', 5 - i, asks[i], 'ask')).join('')
      : emptyDepth('ask');
    $('bidsBody').innerHTML = bids.length
      ? Array.from({ length: 5 }, (_, i) => depthRow('买', i + 1, bids[i], 'bid')).join('')
      : emptyDepth('bid');

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
    // 该档挂单占比最高的前 2 家券商（§11.3.1）。这一处按设计稿**只给小图标 + hover 全名**——
    // 五档的价格列很窄，再塞两字简称会把价格挤到看不清；简称留给逐笔与席位榜。
    // 服务端只在开席位时下发 brokers 段，老服务端没有就只显示价格与量
    const bks = (d.brokers || [])
      .map((b) => {
        const meta = brokerMeta[b.key] || {};
        return `<span class="depth-seat" title="${esc(meta.name || b.key)} 本档占 ${b.pct}%">${brokerIcon(b.key, 'xs')}</span>`;
      })
      .join('');
    return `<tr class="${clsName}"><td class="lv">${side}${lv}</td><td class="px">${fmtP(d.price)}${
      bks ? `<span class="depth-brokers">${bks}</span>` : ''
    }</td><td class="qty">${fmtBookQty(d.qty)}</td></tr>`;
  }
  function emptyDepth(side) {
    const tip = side === 'bid' ? '当前无买盘挂单' : '当前无卖盘挂单';
    return `<tr><td colspan="3" class="lv center">${tip}</td></tr>`;
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
        <span>${seatHtml(t.buyBroker)}</span>
        <span>${seatHtml(t.sellBroker)}</span>
      </div>`;
    });
    $('tape').innerHTML = rows.join('') || '<div class="tape-row"><span class="time">暂无成交</span></div>';
  }

  // ---------- 资金指标条（内外盘 / 净流入） ----------
  /**
   * 内外盘与资金净流入。口径与服务端 flow.js 一致：
   * 外盘 = 主动买成交、内盘 = 主动卖成交，净流入 = 外盘成交额 − 内盘成交额。
   * 数值都从 state.markets[].flow 来（指数是成分股合计），老服务端没有这一段时保持 --。
   */
  function renderFlow() {
    const m = curMarket();
    const f = m && m.flow;
    if (!f) return;
    $('flowOutVol').textContent = fmtVol(f.outerVol);
    $('flowOutAmt').textContent = fmtAmount(f.outerAmt);
    $('flowInVol').textContent = fmtVol(f.innerVol);
    $('flowInAmt').textContent = fmtAmount(f.innerAmt);
    const net = $('flowNet');
    net.textContent = (f.net >= 0 ? '+' : '-') + fmtAmount(Math.abs(f.net));
    net.className = cls(f.net);
    const total = (f.outerAmt || 0) + (f.innerAmt || 0);
    const pct = f.outerPct == null ? null : Number(f.outerPct);
    $('flowPct').textContent = pct == null ? '--' : pct.toFixed(2) + '%';
    $('flowPct').className = pct == null ? '' : pct >= 50 ? 'up' : 'down';
    $('flowPctSub').textContent = total > 0 ? '总成交额 ' + fmtAmount(total) : '当日暂无成交';
    // 占比条宽度：只动 CSSOM，不在 HTML 里写 style 属性（CSP 禁内联样式）
    const barOut = $('flowBarOut');
    const barIn = $('flowBarIn');
    if (barOut && barIn) {
      barOut.style.width = (pct == null ? 50 : pct) + '%';
      barIn.style.width = (pct == null ? 50 : 100 - pct) + '%';
    }
  }

  /** 图表模式按钮与副标题（分时 / 日线的画法、口径不同，副标题要说清） */
  function renderChartMode() {
    const wrap = $('chartModes');
    if (wrap) {
      wrap.querySelectorAll('.chart-mode').forEach((b) => {
        b.classList.toggle('on', b.dataset.mode === chartMode);
      });
    }
    // 「当日 / 5 日」只对分时有效，K 线模式整块隐藏（K 线本来就是按期一根一根的）
    const ranges = $('chartRanges');
    if (ranges) {
      ranges.hidden = isKline();
      ranges.querySelectorAll('.chart-mode').forEach((b) => {
        b.classList.toggle('on', b.dataset.range === minuteRange);
      });
    }
    const m = curMarket() || {};
    const sub = $('chartSub');
    if (!sub) return;
    if (isKline()) {
      // 周/月线由日线聚合（周 = 每 N 个交易日、月 = 每 4 周），副标题说清口径
      const label = chartMode === 'week' ? '周线' : chartMode === 'month' ? '月线' : '日线';
      const unit = chartMode === 'week' ? ` · 每 ${weekPer()} 个交易日` : chartMode === 'month' ? ' · 每 4 周' : '';
      sub.textContent = `${m.isIndex ? '大盘指数' : ''}${label}${unit} · 蜡烛 + 成交量 + MA5/10/20/30/60/120/250 + MACD(12,26,9)`;
      return;
    }
    const scope = minuteRange === '5d' ? `连续 ${MINUTE_DAYS} 日` : '当日';
    // 定格期在副标题里说明白，否则玩家会以为分时卡住了（数据是对的：竞价/休市价不动）
    const d = dayInfo();
    const frozen = d && frozenPhaseStart() != null ? ` · ${d.label || '休市'}，分时定格` : '';
    sub.textContent = m.isIndex
      ? `大盘指数分时 · ${scope}${frozen} · 成分股按流通市值加权`
      : `${scope}分时${frozen} · 均价与价格 · 成交量 · MACD(12,26,9)`;
  }

  /** 分时取数窗口：当日（默认）/ 连续 5 日。选择记在本地，刷新后保持 */
  function setMinuteRange(range) {
    const next = range === '5d' ? '5d' : 'day';
    if (next === minuteRange) return;
    minuteRange = next;
    localStorage.setItem(MINUTE_RANGE_KEY, minuteRange);
    renderChartMode();
    drawChart();
  }

  function bindChartMode() {
    const wrap = $('chartModes');
    if (wrap) {
      wrap.querySelectorAll('.chart-mode').forEach((btn) => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.mode;
          if (!CHART_MODES.includes(mode) || mode === chartMode) return;
          chartMode = mode;
          localStorage.setItem('gushen_chart', chartMode);
          renderChartMode();
          if (isKline()) loadDaily(activeStockId);
          drawChart();
        });
      });
    }
    const ranges = $('chartRanges');
    if (!ranges) return;
    ranges.querySelectorAll('.chart-mode').forEach((btn) => {
      btn.addEventListener('click', () => setMinuteRange(btn.dataset.range));
    });
  }

  // ---------- 资产 ----------
  /** 分钟息（百分数）→ 小数费率。做空利息按**游戏日**结算，融券这边是「日息 ÷ 一天的真实分钟数」 */
  function minuteRateOf(kind) {
    const r = state.rules || {};
    if (kind === 'finance') {
      return r.finance && r.finance.enabled ? (Number(r.finance.minuteRate) || 0) / 100 : 0;
    }
    // 裸空不计息，与 accrueLendingInterest / settleLendingInterest 的计息口径一致
    const m = curMarket();
    const L = m && m.lending;
    if (!L || !L.enabled || r.allowNakedShort) return 0;
    const perDay = (Number(L.dailyRate) || 0) / 100;
    // 除数必须是**一个游戏日的真实分钟数**（≈10.3），不是 A 股的 240 交易分钟：
    // 融资那边是真实分钟口径，两个数字要能加在同一行里
    return perDay / minutesPerGameDay();
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
    // 持仓利息：融资按负债基数（逐 tick 摊）、融券按空头市值（**按持仓时长累计、收盘一次性扣**，
    // 这里摊到每分钟显示），两边都是「真实每分钟」口径，才能加在同一行里
    const perMin =
      a.financeDebt * minuteRateOf('finance') + (a.shortValue || 0) * minuteRateOf('lend');
    const perMinItem =
      perMin > 0
        ? `<div class="item"><label title="当前持仓每分钟要付的利息：融资负债 × 融资分钟息 + 空头市值 × 融券日息 ÷ ${minutesPerGameDay().toFixed(1)}（一个游戏日的真实分钟数）。融券利息按持仓时长累计、每个交易日收盘结算时一次性从现金扣，不逐分钟扣">持仓利息</label><span class="down">${fmtMoney(perMin)}/分</span></div>`
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
    $('posBody').innerHTML = posRowsHtml() || '<tr><td colspan="9" class="empty">暂无持仓</td></tr>';
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
        (n) => `<li class="${n.dir > 0 ? 'npos' : n.dir < 0 ? 'nneg' : ''}${n.early ? ' nearly' : ''}">
            <span class="ntime">${fmtTime(n.t)}</span>
            <span class="ntype">${esc(n.type)}</span>
            ${newsTag(n)}
            ${n.session && n.session !== '盘中' ? `<span class="nsess">${esc(n.session)}</span>` : ''}
            ${n.early ? `<span class="nearly-tag">${n.masked ? '未公开' : '提前'}</span>` : ''}
            <span class="ntext">${esc(n.text)}</span>
          </li>`
      )
      .join('');
  }

  /**
   * 泄露期的「异动提示」（消息分层 §7.2）：不点方向、不点原因、不点谁。
   * 它存在的意义是让「偷偷买进」不沦为纯黑箱——普通玩家至少知道这只股票有事
   */
  function newsHintsHtml() {
    const hints = (state && state.newsHints) || [];
    if (!hints.length) return '';
    return hints
      .map(
        (h) =>
          `<li class="news-hint">⚡ ${esc(h.text)}<span class="panel-sub">距公开约 ${Math.max(0, Math.round((h.leftMs || 0) / 1000))} 秒</span></li>`
      )
      .join('');
  }

  function renderNews() {
    const items = (state && state.news) || [];
    $('newsList').innerHTML =
      newsHintsHtml() + (newsRowsHtml(items) || '<li class="empty">暂无消息</li>');
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
    whale: 'AI主力',
  };
  const ROLE_CLS = {
    inst: 'role-inst',
    hot: 'role-hot',
    big: 'role-big',
    mid: 'role-mid',
    small: 'role-retail',
    retail: 'role-retail',
    player: 'role-player',
    whale: 'role-whale',
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
    // 「我」按**账号**认，不按昵称——昵称可重名、可改，用它比对会认错行
    const myRow = rows.find((h) => h.account === me);
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
          const mine = h.account === me;
          const roleCls = ROLE_CLS[h.role] || 'role-retail';
          const openCell = `<span class="${cls(h.change)}">${h.change > 0 ? '+' : ''}${fmtQty(h.change)} 股</span><span class="delta-sub ${cls(h.changePct)}">${h.changePct > 0 ? '+' : ''}${h.changePct.toFixed(2)}pp</span>`;
          return `<tr${mine ? ' class="row-mine"' : ''} data-holder="${esc(h.account)}" data-nick="${esc(h.name)}">
            <td>${i + 1}</td>
            <td>${esc(h.name)}${mine ? '（我）' : ''}</td>
            <td><span class="tag ${roleCls}">${esc(ROLE_LABEL[h.role] || h.role)}${h.ai ? ' · AI' : ''}</span></td>
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
  /** @param {string} account 账号（身份键）。快照也按账号存，改名不会把曲线打断 */
  function openHolderChart(account, nick) {
    holderHistName = account;
    holderHist = null;
    $('holderTitle').textContent = (nick || account) + ' · 占比走势';
    $('holderSub').textContent = '正在读取…';
    $('holderActions').innerHTML = '';
    $('holderOverlay').classList.remove('hidden');
    drawHolderHistory();
    loadHolderHistory(account);
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
      const r = (s.rows || []).find((x) => x.account === name) || null;
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

    ctx.strokeStyle = withA(themeC.ink, .06);
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + (ih * i) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(W - pad.r, y);
      ctx.stroke();
    }

    if (known.length === 0) {
      ctx.fillStyle = withA(themeC.ink, .35);
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
    ctx.strokeStyle = themeC.blue;
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
      ctx.fillStyle = i === lastIdx ? themeC.gold : themeC.blue;
      ctx.fill();
    });

    ctx.font = '10px sans-serif';
    ctx.fillStyle = withA(themeC.ink, .45);
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
    ctx.fillStyle = themeC.gold;
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
      if (tr) openHolderChart(tr.dataset.holder, tr.dataset.nick);
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
      <div class="item"><label>当前日息</label><span class="${L.dailyRate > 0.3 ? 'down' : L.dailyRate > 0.15 ? '' : 'up'}">${Number(L.dailyRate || 0).toFixed(2)}%/日</span></div>
      <div class="item"><label>池子紧张度</label><span>${L.utilization.toFixed(1)}%</span></div>
      <div class="item"><label>计息方式</label><span>收盘结算（按持仓时长累计）</span></div>
      <div class="item"><label>做空模式</label><span>${L.allowNakedShort ? '裸空（不借券）' : '融券（必须借券）'}</span></div>
    `;

    // 我的挂借按当前股票取（服务端 account.positions[].lending 已按股票切好）
    const pos = curPosition();
    const mine = (pos && pos.lending) || null;
    if (mine) {
      $('myLendSub').textContent = `可挂借 ${fmtQty(mine.freeToLend)} 股 · 日息 ${Number(L.dailyRate || 0).toFixed(2)}%（每个交易日收盘结算一次）`;
      $('lendingMine').innerHTML = `
        <div class="item"><label>已挂借</label><span>${fmtQty(mine.offered)} 股</span></div>
        <div class="item"><label>被借走</label><span>${fmtQty(mine.lentOut)} 股</span></div>
        <div class="item"><label>可撤回</label><span>${fmtQty(mine.removable)} 股</span></div>
        <div class="item"><label>累计利息收入</label><span class="up">+${fmtMoney(mine.interestEarned)}</span></div>
        ${mine.interestPaid > 0 ? `<div class="item"><label>（做空已付息）</label><span class="down">${fmtMoney(mine.interestPaid)}</span></div>` : ''}
        ${mine.interestPending > 0 ? `<div class="item"><label title="今天已经累计、还没到收盘结算的做空利息。利息按持仓时长累计，收盘那一刻一次性从现金扣（不够扣保证金，再不够挂成欠息）">（今日待结息）</label><span class="down">${fmtMoney(mine.interestPending)}</span></div>` : ''}
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
    ctx.strokeStyle = withA(themeC.ink, .06);
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + (ih * i) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(W - pad.r, y);
      ctx.stroke();
    }

    if (!hist || hist.length < 2) {
      ctx.fillStyle = withA(themeC.ink, .35);
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
    ctx.strokeStyle = themeC.blue;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(xAt(hist.length - 1), pad.t + ih);
    ctx.lineTo(xAt(0), pad.t + ih);
    ctx.closePath();
    ctx.fillStyle = withA(themeC.blue, .12);
    ctx.fill();

    // 轴标
    ctx.fillStyle = withA(themeC.ink, .4);
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
  /** 排行行 HTML（主页只取前几行）。带券商简称与**组内名次**——组内名次是软分流的关键
   *  （冷门券商的组内名次天然更容易靠前，争榜的动机会把人往冷门赶，§5.3） */
  function rankRowsHtml(limit) {
    const rows = (state.players || []).slice(0, limit || undefined);
    return rows
      .map((p, i) => {
        const mine = p.account === me; // 按账号认"我"，昵称可重名可改
        const b = p.broker ? brokerMeta[p.broker] : null;
        const tag = b
          ? `<span class="seat-cell" title="${esc(b.name)}">${brokerIcon(p.broker, 'xs')}<span class="seat-abbr">${esc(b.abbr)}</span></span>
             <span class="panel-sub">组内 #${p.brokerRank || 1}</span>${p.star > 1 ? `<span class="mb-star flat">${'★'.repeat(Math.min(p.star, 5))}</span>` : ''}`
          : '<span class="panel-sub">未开户</span>';
        // 「按账号取数」：按钮带上账号而不是昵称——昵称可重名、可随时改
        const act = p.account
          ? `<td class="rank-act-cell"><button class="mini-btn rank-pos-btn" type="button"
               data-account="${esc(p.account)}" data-nick="${esc(p.name || p.account)}">持仓</button></td>`
          : '<td class="rank-act-cell"></td>';
        return `<tr${mine ? ' class="row-mine"' : ''}>
          <td>${i + 1}</td>
          <td>${esc(p.name)}${mine ? '（我）' : ''} ${tag}</td>
          <td class="${cls(p.equity - state.rules.initialCash)}">${fmtMoney(p.equity)}</td>
          ${act}
        </tr>`;
      })
      .join('');
  }

  function renderRank() {
    $('rankBody').innerHTML = rankRowsHtml() || '<tr><td colspan="4" class="empty">暂无玩家</td></tr>';
    renderBrokerBoard();
  }

  /** 券商榜（§5.3）：总榜 + 券商榜 + 组内榜。组内榜就是玩家表里的「组内 #N」 */
  function renderBrokerBoard() {
    const rows = (state && state.brokerBoard) || [];
    const body = $('brokerBoardBody');
    if (!body) return;
    const myKey = state && state.account && state.account.broker ? state.account.broker.key : null;
    $('brokerBoardMeta').innerHTML =
      rows.length
        ? `<span class="panel-sub">按券商聚合本服玩家总权益；冷门券商的组内名次天然更容易靠前</span>`
        : '';
    body.innerHTML =
      rows
        .map((g) => {
          const b = brokerMeta[g.key] || {};
          const mine = g.key === myKey;
          return `<tr class="${mine ? 'row-mine' : ''}">
            <td>${g.rank}</td>
            <td><span class="bk-inline">${brokerIcon(g.key, 'xs')}${esc(b.name || g.key)}</span></td>
            <td>${g.clients}</td>
            <td>${fmtMoney(g.equity)}</td>
            <td>${g.top ? esc(g.top) : '--'}</td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="5" class="empty">暂无数据</td></tr>';
  }

  // ---------- 玩家持仓弹窗（排行 → 「持仓」） ----------
  /**
   * 拉某玩家的持仓。走 `?account=`（账号而不是昵称）——昵称可重名、可随时改。
   * 期间点了别的玩家就把旧响应丢掉，避免"先点 A 后点 B，回来的是 A"。
   */
  function loadPlayerPositions(account) {
    apiGet('/api/player/positions?account=' + encodeURIComponent(account))
      .then((r) => r.json())
      .then((res) => {
        if (account !== rankPosAccount) return;
        if (!res || !res.ok) {
          rankPosData = null;
          $('rankPosSub').textContent = (res && res.error) || '读取失败';
          $('rankPosBody').innerHTML = '<tr><td colspan="7" class="empty">读取失败</td></tr>';
          return;
        }
        rankPosData = res;
        renderPlayerPositions();
      })
      .catch(() => {
        if (account !== rankPosAccount) return;
        $('rankPosSub').textContent = '网络错误';
        $('rankPosBody').innerHTML = '<tr><td colspan="7" class="empty">网络错误</td></tr>';
      });
  }

  function openPlayerPositions(account, nick) {
    if (!account) return;
    rankPosAccount = account;
    rankPosData = null;
    $('rankPosTitle').textContent = (nick || account) + ' · 持仓';
    $('rankPosSub').textContent = '正在读取…';
    $('rankPosMeta').innerHTML = '';
    $('rankPosBody').innerHTML = '<tr><td colspan="7" class="empty">正在读取…</td></tr>';
    $('rankPosOverlay').classList.remove('hidden');
    loadPlayerPositions(account);
  }

  function closePlayerPositions() {
    $('rankPosOverlay').classList.add('hidden');
    rankPosAccount = '';
    rankPosData = null;
  }

  /** 弹窗内容：账户级汇总（权益/现金/持仓市值/盈亏）+ 持仓明细（按市值降序，多空各占一行） */
  function renderPlayerPositions() {
    const d = rankPosData;
    if (!d) return;
    const b = d.broker ? brokerMeta[d.broker] : null;
    const pnl = d.longPnl + d.shortPnl;
    const signed = (v) => (v >= 0 ? '+' : '') + fmtMoney(v);
    const sub = b
      ? `${b.name}${d.star > 1 ? ' · ' + '★'.repeat(Math.min(d.star, 5)) : ''}`
      : '未开户';
    $('rankPosSub').innerHTML = `${esc(sub)} · 账号 <b>${esc(d.account)}</b> · 总权益
      <span class="${cls(d.equity - d.initialCash)}">¥${fmtMoney(d.equity)}</span>`;
    $('rankPosMeta').innerHTML = `
      <div class="item"><label>可用资金</label><span>¥${fmtMoney(d.cash)}</span></div>
      <div class="item"><label>持仓市值</label><span>¥${fmtMoney(d.longValue)}</span></div>
      <div class="item"><label>空头市值</label><span>¥${fmtMoney(d.shortValue)}</span></div>
      <div class="item"><label>浮动盈亏</label><span class="${cls(pnl)}">${signed(pnl)}</span></div>
      <div class="item"><label>已实现盈亏</label><span class="${cls(d.realizedPnL)}">${signed(d.realizedPnL)}</span></div>
      <div class="item"><label>融资负债</label><span>¥${fmtMoney(d.financeDebt)}</span></div>
    `;
    $('rankPosBody').innerHTML =
      (d.positions || [])
        .map((p) => {
          const long = p.side === 'long';
          return `<tr class="${long ? 'row-long' : 'row-short'}">
            <td>${esc(p.name)}<span class="sub-code">${esc(p.stockId)}</span></td>
            <td>${long ? '多头' : '空头'}</td>
            <td>${fmtQty(p.qty)}</td>
            <td>${fmtP(p.avg)}</td>
            <td>${fmtP(p.last)}</td>
            <td>${fmtMoney(p.value)}</td>
            <td class="${cls(p.pnl)}">${signed(p.pnl)}</td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="7" class="empty">暂无持仓（空仓）</td></tr>';
  }

  /** 「持仓」按钮的事件委托：两张榜每帧都整块重写 innerHTML，只能挂在容器上 */
  function bindPlayerPositions() {
    const pick = (e) => {
      const btn = e.target.closest('.rank-pos-btn');
      if (!btn) return;
      openPlayerPositions(btn.dataset.account, btn.dataset.nick);
    };
    const rankBody = $('rankBody');
    if (rankBody) rankBody.addEventListener('click', pick);
    const homeRank = $('homeRankBody');
    if (homeRank) homeRank.addEventListener('click', pick);
    $('rankPosCloseBtn').addEventListener('click', closePlayerPositions);
    $('rankPosOverlay').addEventListener('click', (e) => {
      if (e.target === $('rankPosOverlay')) closePlayerPositions();
    });
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
    const spark = sparkSvg(sparks.get(idx.stockId) || [], idx.change >= 0 ? themeC.red : themeC.green);
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

  /**
   * 「我的券商」卡（§6 前端对接点）：名称 / 声誉星级 / 拥挤度 / 我的特权清单 /
   * 本周加成 / 免息券 / 转户入口。数值全部来自服务端 account.broker，
   * **客户端不自己算券商规则**（算两遍必然与服务端漂移）。
   */
  function renderMyBroker() {
    const el = $('myBrokerCard');
    if (!el) return;
    const a = state && state.account;
    const bk = a && a.broker;
    if (!bk || !bk.key) {
      el.innerHTML = '<div class="panel-title"><span>我的券商</span></div><div class="empty">未开户</div>';
      return;
    }
    const b = brokerMeta[bk.key] || {};
    const starMax = bk.starMax || 5;
    let stars = '';
    for (let i = 1; i <= starMax; i++) stars += i <= bk.star ? '★' : '<span class="off">★</span>';
    const pr = bk.progress;
    const pct = bk.intensity || 0;

    const cells = [
      ['佣金', fmtFeeRate(bk.feeRate), bk.weekly && bk.weekly.isStar ? '本周半价' : ''],
      ['下单冷却', (bk.cooldownMs / 1000).toFixed(1) + 's', ''],
      ['买入锁仓', (bk.lockMs / 1000).toFixed(0) + 's', ''],
      ['融资额度', bk.leverage + '×', '自备 ' + Math.round(bk.financeRatio * 100) + '%'],
      ['保证金', Math.round(bk.marginRatio * 100) + '%', ''],
      ['维持率', Math.round(bk.maintenance * 100) + '%', bk.features && bk.features.zeroBufferLiquidation ? '零缓冲' : ''],
      ['融券券源', bk.lendCapacityPct + '%', bk.lendRateMul > 1 ? '券息 ×' + bk.lendRateMul : ''],
      ['策略上限', bk.autoMax + ' 条', bk.autoSlots + ' 槽'],
    ];
    const privRows = (bk.privileges || [])
      .map(
        (r) => `<div class="mb-priv-row">
          <label>${esc(r.label)}</label>
          <span class="pv">${esc(r.now)}</span>
          <i class="mb-bar"><b data-w="${r.pct}"></b></i>
          <span class="pfull">满额 ${esc(r.full)}</span>
          ${r.extra ? `<span class="chip gold">${esc(r.extra)}</span>` : ''}
        </div>`
      )
      .join('');

    const nextStar = pr
      ? `<div class="mb-note">
           距 ${pr.next}★：成交额 ${fmtAmount(pr.volume)} / ${fmtAmount(pr.volumeNeed)}${
             pr.profitNeed > 0 ? `，累计盈利 ${fmtMoney(pr.profit)} / ${fmtMoney(pr.profitNeed)}` : ''
           }
           ${pr.noLiquidation ? `（且不能有爆仓记录，当前 ${pr.liquidations} 次）` : ''}
           ${pr.cancelRate > 0.8 ? ` · 撤单率 ${(pr.cancelRate * 100).toFixed(0)}%` : ''}
         </div>`
      : '<div class="mb-note">已满级</div>';

    const coupon = bk.coupon || {};
    const couponBtn = coupon.perDay
      ? `<button class="mini-btn" id="mbCouponBtn" ${coupon.available ? '' : 'disabled'}>
           ${coupon.active ? '今日利息已全免' : coupon.available ? `用免息券（剩 ${coupon.available ? 1 : 0} 张）` : '今日券已用'}
         </button>`
      : '';
    const weekly = bk.weekly && bk.weekly.key
      ? `<div class="mb-note">本周之星：<b>${esc((brokerMeta[bk.weekly.key] || {}).name || bk.weekly.key)}</b>${
          bk.weekly.isStar ? '（就是本家：佣金减半 · 额度 +0.5×）' : `（下周 ${esc((brokerMeta[bk.weekly.nextKey] || {}).name || bk.weekly.nextKey)}）`
        }</div>`
      : '';

    el.className = 'panel home-card span-3 my-broker-card';
    el.innerHTML = `
      <div class="panel-title">
        <span>我的券商</span>
        <span class="panel-sub">${esc(b.slogan ? '「' + b.slogan + '」' : '')}</span>
      </div>
      <div class="mb-grid">
        <div class="mb-id">
          ${brokerIcon(bk.key, 'lg')}
          <div>
            <div class="mb-name">${esc(bk.name || bk.key)}<span class="mb-star">${stars}</span></div>
            <div class="mb-slogan">${esc(b.abbr || '')}${b.scale ? ' · ' + esc(b.scale) + '券商' : ''}</div>
            <div class="mb-sub">
              拥挤度 ${bk.crowdPct}% · <span class="crowd-tag ${esc(bk.crowdTier || 'normal')}">${esc(bk.crowdLabel || '')}</span>
              · 特权强度 ${pct}%
            </div>
            <div class="mb-sub">${esc(b.persona || '')}</div>
          </div>
        </div>
        <div>
          <div class="mb-cells">
            ${cells
              .map(
                (c) =>
                  `<div class="mb-cell"><label>${esc(c[0])}</label><b>${esc(String(c[1]))}</b>${c[2] ? `<i>${esc(c[2])}</i>` : ''}</div>`
              )
              .join('')}
          </div>
          ${privRows ? `<div class="mb-priv gap-top">${privRows}</div>` : ''}
        </div>
        <div>
          ${nextStar}
          ${weekly}
          <div class="mb-note">${(b.costs || []).map((c) => '· ' + esc(c)).join('<br>')}</div>
          <div class="mb-actions">
            <button class="mini-btn" id="mbTransferBtn">转户</button>
            ${couponBtn}
          </div>
        </div>
      </div>
    `;
    paintCrowdBars(el);
    el.querySelectorAll('.mb-bar b[data-w]').forEach((n) => {
      n.style.width = Math.max(2, Math.min(100, Number(n.dataset.w) || 0)) + '%';
    });
    const tb = $('mbTransferBtn');
    if (tb) tb.addEventListener('click', openTransfer);
    const cb = $('mbCouponBtn');
    if (cb) cb.addEventListener('click', useCoupon);
  }

  // ---------- 转户 ----------
  function openTransfer() {
    const a = state && state.account;
    if (!a || !a.broker) return;
    renderTransferWall();
    $('transferOverlay').classList.remove('hidden');
  }
  function closeTransfer() {
    $('transferOverlay').classList.add('hidden');
  }
  function renderTransferWall() {
    const a = state && state.account;
    const bk = a && a.broker;
    if (!bk) return;
    const opts = {};
    for (const o of bk.transfer.options || []) opts[o.key] = o;
    const keys = brokerKeys();
    const wall = $('transferWall');
    if (!wall) return;
    wall.innerHTML = keys
      .map((k) => {
        const o = opts[k] || {};
        let tag = '';
        if (k === bk.key) tag = '当前券商';
        else if (o.free) tag = '免费重选';
        else if (o.ok) tag = '转户费 ¥' + fmtMoney(o.fee);
        else tag = o.reason || '暂不可转';
        return brokerCardHtml(k, {
          mode: k === bk.key ? 'view' : 'pick',
          dim: k !== bk.key && !o.ok,
          tag,
        });
      })
      .join('');
    paintCrowdBars(wall);
    $('transferSub').textContent = `${bk.name} · ${bk.star}★ · 总资产 ¥${fmtMoney(a.equity)}`;
    $('transferNote').innerHTML =
      `转户费 = 总资产 × ${((bk.transfer.feeRate || 0.001) * 100).toFixed(1)}%（上限 ¥${fmtMoney(bk.transfer.feeCap)}）` +
      ` · 冷却 1 个交易日 · 开户首日内可免费重选 1 次<br>` +
      `转户会**清空离开那家与目标那家**的声誉星级与特权进度——回到老东家也要重新攒` +
      (bk.transfer.freeReselectUsed ? '<br>（本次免费重选机会已用掉）' : '');
    wall.querySelectorAll('.broker-card').forEach((el) => {
      const key = el.dataset.bk;
      if (key === bk.key) return;
      const o = opts[key] || {};
      if (!o.ok) return;
      el.addEventListener('click', () => doTransfer(key, o));
    });
  }

  function doTransfer(key, o) {
    const msg = o.free
      ? `确认免费转到 ${(brokerMeta[key] || {}).name || key}？（每人仅 1 次，且仅限开户首日）`
      : `确认转户到 ${(brokerMeta[key] || {}).name || key}？\n转户费 ¥${fmtMoney(o.fee)}，并清空两边的星级与特权进度。`;
    if (!confirm(msg)) return;
    apiPost('/api/broker/transfer', { broker: key })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) {
          toast(res.error || '转户失败', 'err');
          return;
        }
        toast(res.free ? '已免费转户到 ' + key : `已转户，费用 ¥${fmtMoney(res.fee)}`, 'ok');
        closeTransfer();
        loadInitial();
      })
      .catch(() => toast('网络异常', 'err'));
  }

  function useCoupon() {
    apiPost('/api/broker/coupon', {})
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) {
          toast(res.error || '免息券不可用', 'err');
          return;
        }
        toast('今日融资 / 融券利息全免已生效', 'ok');
      })
      .catch(() => toast('网络异常', 'err'));
  }

  function bindTransfer() {
    const cancel = $('transferCancelBtn');
    if (cancel) cancel.addEventListener('click', closeTransfer);
    const ov = $('transferOverlay');
    if (ov) {
      ov.addEventListener('click', (e) => {
        if (e.target === ov) closeTransfer();
      });
    }
  }

  // ---------- 席位榜 / 龙虎榜 ----------
  function renderSeats() {
    const m = curMarket();
    const seats = m && m.seats;
    const meta = $('seatMeta');
    if (!meta) return;
    if (!seats) {
      meta.innerHTML = '<span class="panel-sub">本服务端未开启席位玩法</span>';
      $('seatBody').innerHTML = '<tr><td colspan="6" class="empty">暂无数据</td></tr>';
      $('surgeWrap').hidden = true;
      return;
    }
    const myKey = state && state.account && state.account.broker ? state.account.broker.key : null;
    meta.innerHTML =
      `<span class="panel-sub">${esc(m.name)} · 当日成交额 ${fmtAmount(seats.total)} · 涨跌 ` +
      `<b class="${cls(m.change)}">${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}%</b></span>` +
      (myKey ? `<span class="chip">我的席位：${esc((brokerMeta[myKey] || {}).abbr || myKey)}</span>` : '');
    $('seatBody').innerHTML = (seats.rows || [])
      .map((r) => {
        const mine = r.key === myKey;
        return `<tr class="${mine ? 'row-mine' : ''}">
          <td>${r.rank}</td>
          <td><span class="bk-inline">${brokerIcon(r.key, 'xs')}${esc(r.name)}</span></td>
          <td>${fmtAmount(r.buyAmt)}</td>
          <td>${fmtAmount(r.sellAmt)}</td>
          <td class="seat-net ${r.net >= 0 ? 'pos' : 'neg'}">${r.net >= 0 ? '+' : '-'}${fmtAmount(Math.abs(r.net))}</td>
          <td>${r.pct}%</td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="6" class="empty">当日暂无成交</td></tr>';

    const wrap = $('surgeWrap');
    wrap.hidden = !seats.surge;
    if (seats.surge && seats.top) {
      $('surgeSub').textContent = `当日 ${seats.changePct >= 0 ? '+' : ''}${seats.changePct.toFixed(2)}%，披露买卖前五席位`;
      const rowsOf = (arr) =>
        (arr || [])
          .map(
            (r, i) =>
              `<tr><td>${i + 1}</td><td><span class="bk-inline">${brokerIcon(r.key, 'xs')}${esc(r.abbr)}</span></td><td>${fmtAmount(r.amt)}</td></tr>`
          )
          .join('') || '<tr><td colspan="3" class="empty">--</td></tr>';
      $('surgeBuyBody').innerHTML = rowsOf(seats.top.buy);
      $('surgeSellBody').innerHTML = rowsOf(seats.top.sell);
    }
  }

  /** 追保预警横幅（§7 彩蛋）：文案随券商风格变。天疯没有预警档，永远不会出现 */
  function renderMarginCall() {
    const el = $('marginCallBanner');
    if (!el) return;
    const mc = state && state.account && state.account.marginCall;
    if (!mc) {
      el.hidden = true;
      return;
    }
    const style = { zhongxin: '正式公函', tianfeng: '跑', dongfeng: '客服', huatai: 'App 推送', zhaoshang: '客户经理' };
    const who = style[mc.name ? mc.broker : ''] || '券商';
    el.hidden = false;
    $('marginCallText').textContent =
      `${esc(mc.name)}（${who}）追加保证金通知：${esc(mc.stockName || '')}` +
      `${mc.side === 'short' ? '空头' : '融资多头'}维持率已跌破 ${Math.round(mc.maintenance * 100)}%，` +
      `需补权益 ¥${fmtMoney(mc.need)}；再跌 ¥${fmtMoney(Math.max(0, mc.left))} 触发强平`;
    $('marginCallLeft').textContent = '';
  }

  // ==================================================================
  // 游戏规则（主页「规则」入口 + 分类弹窗）
  // 数值一律读 state.rules：佣金 / 冷却 / 锁仓 / 保证金这些都是 **per-broker 的有效值**，
  // 在客户端写死一份，改配置那天就会静默变成"骗人的说明书"。
  // 交易日阶段表同理——客户端不许自己算阶段（§3.1），所以阶段表也只能吃 rules.day。
  // ==================================================================
  const RULES_SEEN_KEY = 'gushen_rules_seen';
  let rulesSeen = false;
  let rulesTabKey = 'start';

  const trimNum = (v, digits) => {
    const s = Number(v).toFixed(digits);
    return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };
  // 注意：时长格式化复用下方交易日模块的 fmtDur（函数声明会提升，规则面板先用到没问题）——
  // 两处各写一份的话，倒计时显示「10 分 20 秒」而规则页显示「10分20秒」，观感会分家
  /** 0.0001 → "0.01%"：费率 / 分钟息这类**比例**值（finance.minuteRate 已经是百分数，别走这里） */
  const fmtRatePct = (v, digits) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '--';
    return trimNum(n * 100, digits == null ? 2 : digits) + '%';
  };
  /** 0.5 → "50%" */
  const fmtRatio = (v, digits) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '--';
    return trimNum(n * 100, digits == null ? 0 : digits) + '%';
  };

  const ruleKv = (k, v, note) =>
    '<div class="rule-kv"><span class="rk">' + k + '</span><span class="rv">' + v +
    (note ? '<em>' + note + '</em>' : '') + '</span></div>';

  const ruleTable = (heads, rows) =>
    '<div class="rule-table"><table><thead><tr>' +
    heads.map((h) => '<th>' + h + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.map((cells) => '<tr>' + cells.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';

  /** 快速上手：目标 + 三步走 + 五条底层设定 */
  function rulesStartHtml(S) {
    const r = S.rules || {};
    const lot = r.lotSize || 100;
    const stocks = (r.stocks || []).length || 10;
    const cash = Number(r.initialCash);
    const cashText = Number.isFinite(cash) ? fmtMoney(cash) : '1000000.00';
    return (
      '<div class="rule-lead">同服所有人的起跑线一样：<b>¥' + cashText + '</b> 虚拟本金、<b>' + stocks +
        '</b> 只股票、一群不知疲倦的对手盘。没有剧本、没有人发牌——<b>收盘时总权益最高的人，就是股神</b>。</div>' +
      '<div class="rule-h">三步上手</div>' +
      '<div class="rule-steps">' +
        '<div class="rule-step"><i>1</i><div><b>挑一只股票</b><span>主页「行情列表」点任意一行进交易终端，顶部切换栏可以随时换盘口。</span></div></div>' +
        '<div class="rule-step"><i>2</i><div><b>选方向下单</b><span>看涨买入开多，看跌卖出开空。数量按「手」算，1 手 = ' + lot + ' 股。</span></div></div>' +
        '<div class="rule-step"><i>3</i><div><b>盯盘或者托管</b><span>手动挂单，或建一条自动化策略让服务端替你跑（下线也照跑）。</span></div></div>' +
      '</div>' +
      '<div class="rule-h">先记住这五件事</div>' +
      '<div class="rule-grid">' +
        '<div class="rule-cell"><b>一份本金，十个盘口</b><span>现金全股票共用、持仓按股票分账。重仓一只，别的股票就没子弹了。</span></div>' +
        '<div class="rule-cell"><b>同股只能一个方向</b><span>同一只股票要么做多要么做空（含在途开仓单），不能自己跟自己对着干。</span></div>' +
        '<div class="rule-cell"><b>一天只有 ' + fmtDur((r.day && r.day.totalMs) || 620000) + '</b><span>开盘竞价 → 上午 → 午休 → 下午 → 收盘竞价 → 夜间结算。</span></div>' +
        '<div class="rule-cell"><b>赚差价，也付利息</b><span>融资逐分钟计息；融券按持仓时长累计、每个游戏日收盘结算一次。扛得越久，成本越高。</span></div>' +
        '<div class="rule-cell"><b>指数看得见，摸不着</b><span>大盘指数由十只股票加权合成，只做参照，不能下单。</span></div>' +
      '</div>' +
      '<div class="rule-tip"><b>涨红跌绿</b>：红色 = 涨，绿色 = 跌（A 股口径，和美股正好相反）。</div>'
    );
  }

  /** 交易规则：四个方向 + 撮合约束 */
  function rulesTradeHtml(S) {
    const r = S.rules || {};
    const lot = r.lotSize || 100;
    const cd = r.cooldownMs == null ? 2000 : r.cooldownMs;
    const lock = r.lockMs == null ? 10000 : r.lockMs;
    const dev = r.maxDeviation == null ? 0.5 : r.maxDeviation;
    const cage = r.cagePct == null ? 0.05 : r.cagePct;
    const pl = r.priceLimit || {};
    const fin = r.finance || {};
    const own = fin.ratio == null ? 0.5 : fin.ratio;
    const dirTable = ruleTable(['方向', '做什么', '前提'], [
      ['<b>买入开多</b><span class="rule-sub">buy_open</span>', '用现金买股票，涨了赚', '现金够（勾了融资则只需自备 ' + fmtRatio(own) + '）'],
      ['<b>卖出平多</b><span class="rule-sub">sell_close</span>', '把手上的多头卖掉兑现', '过了锁仓期、数量不超过可平'],
      ['<b>卖出开空</b><span class="rule-sub">sell_open</span>', '先借券卖出，跌了再买回还券', '该股券源可借 + 保证金够'],
      ['<b>买入平空</b><span class="rule-sub">buy_close</span>', '买回股票还给借出方', '有对应的空头持仓'],
    ]);
    return (
      '<div class="rule-lead">四种方向决定你是<b>开仓</b>还是<b>平仓</b>；能不能开，还要看方向锁与券源。</div>' +
      dirTable +
      '<div class="rule-h">撮合与约束</div>' +
      ruleKv('交易单位', '1 手 = ' + lot + ' 股', '金额随股价不同，下单面板会自动折算') +
      ruleKv('手续费', fmtFeeRate(r.feeRate), '买卖都收，没有最低 5 元') +
      ruleKv('下单冷却', fmtDur(cd), '跨股票共享：冷却里换一只股票下，也算同一笔') +
      ruleKv('买入锁仓', 'T+' + fmtDur(lock), '按成交时间算，锁仓期内不能卖') +
      ruleKv('委托价偏离', '±' + fmtRatio(dev), '相对最新价，防止手滑打错价格') +
      ruleKv('价格笼子', '±' + fmtRatio(cage, 1), '单笔成交价相对最新价的偏离上限') +
      ruleKv('涨跌停', pl.enabled === false ? '本服未开启' : '±' + fmtRatio(pl.pct == null ? 0.1 : pl.pct), '相对昨收，集合竞价也受它约束') +
      ruleKv('交易方向', '多空双向', '当天买当天就能卖（过了锁仓期即可）') +
      '<div class="rule-warn"><b>挂得远，不等于成交得远。</b>脱离价格笼子的委托会留在盘口等着，' +
        '等最新价靠近它才可能成交；想马上成交，就把价格挂在笼子里。</div>' +
      '<div class="rule-tip"><b>同股多空互斥：</b>一只股票上持有多头（或有买入开仓在途）就不能再卖出开空，' +
        '反之亦然。想反手，先把这一侧平干净。平仓与同向加仓不受限制。</div>'
    );
  }

  /** 融资融券：杠杆、爆仓、券源 */
  function rulesMarginHtml(S) {
    const r = S.rules || {};
    const fin = r.finance || {};
    const lend = r.lending || {};
    const own = fin.ratio == null ? 0.5 : fin.ratio;
    const margin = r.marginRatio == null ? 0.5 : r.marginRatio;
    const maint = r.maintenance == null ? 0.3 : r.maintenance;
    const slip = r.liquidationSlippage == null ? 0.005 : r.liquidationSlippage;
    const lev = own > 0 ? trimNum(1 / own, 2) : '--';
    const finNow = Number(fin.minuteRate);
    const finBase = Number(fin.baseMinuteRate);
    const finMax = Number(fin.maxMinuteRate);
    const lendBase = Number(lend.baseDailyRate);
    const lendMax = Number(lend.maxDailyRate);
    return (
      '<div class="rule-lead">钱不够可以<b>融资</b>，看跌没股票可以<b>融券</b>。两样都是借来的，都要付利息，也都可能被强平。</div>' +
      '<div class="rule-h">融资（加杠杆做多）</div>' +
      ruleKv('自备比例', fmtRatio(own), '剩下的由券商垫，最高 ' + lev + ' 倍杠杆') +
      ruleKv('利息', fmtRatePct(finBase) + '/分',
        Number.isFinite(finBase)
          ? '约 ' + fmtRatePct(finBase * 1440, 1) + '/日 · 现金越紧张越贵，封顶 ' + fmtRatePct(finMax) + '/分'
          : '') +
      (Number.isFinite(finNow) ? ruleKv('当前利率', trimNum(finNow, 2) + '%/分', '按全市场资金紧张度实时浮动，逐分钟摊入负债') : '') +
      ruleKv('爆仓线', '权益 < ' + fmtRatio(maint) + ' × 多头市值', '跌破即强平，卖股还债') +
      '<div class="rule-h">融券（做空）</div>' +
      ruleKv('保证金', '卖出市值 × ' + fmtRatio(margin), '开空先冻结这笔钱，平仓后释放') +
      ruleKv('维持保证金率', fmtRatio(maint), '权益扛不住这个比率就爆仓') +
      ruleKv('券源', '每只股票一口独立的池子', '只能借到别人挂出来的券，借不到就开不了空') +
      ruleKv('融券利息', fmtRatePct(lendBase) + '/日 起',
        '池子越紧张越贵，封顶 ' + fmtRatePct(lendMax) + '/日') +
      ruleKv('计息方式', '<b>每个游戏日收盘结算一次</b>',
        '盘中按持仓时长一秒一秒累计，收盘那一刻一次性扣；持仓期间现金不掉，但平仓早也不能免') +
      ruleKv('挂借收息', '可卖持仓挂出去借给空头', '按日计息，在「融券」标签页挂借 / 撤借') +
      ruleKv('裸空', r.allowNakedShort ? '本服开启（无券也能空）' : '本服关闭（必须借到券）', '') +
      '<div class="rule-warn"><b>强平不讲价。</b>系统在爆仓时直接挂单平掉你的仓位，' +
        '如果盘口没有足够的对手盘，会按 ' + fmtRatio(slip, 1) + ' 的滑点兜底成交——实际成交价可能比你看到的最差价还差。' +
        '跌破维持线但还没到强平线时，会先弹一条「追保预警」。</div>' +
      '<div class="rule-tip">做空的利息按日结算：扛多久算多久，收盘那一刻从现金里一次性扣；' +
        '现金不够就扣保证金，都不够会记成「做空欠息」，等你账上有钱再补缴。' +
        '融资利息则是逐分钟摊进负债的，两者节奏不同，别混着算。</div>'
    );
  }

  /** 交易日：六段节奏、集合竞价、结算与跳空 */
  function rulesDayHtml(S) {
    const r = S.rules || {};
    const day = r.day || {};
    const phases = Array.isArray(day.phases) ? day.phases : [];
    const curKey = S.day && S.day.enabled ? S.day.phase : null;
    const rows = phases.map((p) => {
      const name = esc(p.label) +
        (p.auction ? '<span class="rule-badge">集合竞价</span>' : '') +
        (p.key === curKey ? '<span class="rule-now">当前</span>' : '');
      const trade = p.trading ? '<span class="rule-yes">可以</span>' : '<span class="rule-no">不可</span>';
      return [name, esc(p.gameTime || '--'), fmtDur(p.ms), trade];
    });
    const table = rows.length
      ? ruleTable(['阶段', '盘面时刻', '真实时长', '能下单'], rows)
      : '<div class="rule-warn">本服务端没有下发交易日阶段表，可能未开启交易日时钟。</div>';
    const total = fmtDur(day.totalMs || 620000);
    return (
      '<div class="rule-lead">一天被切成六段，共 <b>' + total + '</b>。段与段之间发生的事完全不同：' +
        '竞价只入簿不撮合、午休与夜间完全冻结、收盘那一 tick 结算全天。</div>' +
      table +
      '<div class="rule-h">集合竞价怎么算价</div>' +
      ruleKv('报价', '只入簿，不撮合', '盘口允许买卖价交叉，看到的就是「虚拟成交价」') +
      ruleKv('开盘价', '最大成交量原则', '能成交最多的那个价，并列时取最接近昨收的') +
      ruleKv('成交', '所有单按同一个价成交', '挂得低的卖方也享受这个价') +
      ruleKv('撤单', '最后 10 秒不能撤', '复刻真实市场 09:20 那条硬线，逼你认账') +
      '<div class="rule-h">收盘结算会发生什么</div>' +
      ruleKv('昨收', '收盘价滚动成新昨收', '次日涨跌停区间跟着换') +
      ruleKv('委托', '当日委托全部作废', '没成交的单不会活到明天') +
      ruleKv('K 线', '当天定格成一根日线', '日线图从这个时刻起才算数') +
      '<div class="rule-tip"><b>隔夜跳空是设计出来的：</b>午休与夜间不撮合、不报价，但消息照发、' +
        '定价重心继续迁移。所以第二天开盘价常和昨收差一截——跳空是真规则，不是 bug。</div>'
    );
  }

  /** 券商：六家的差异 + 星级 / 每周之星 / 转户 */
  function rulesBrokerHtml(S) {
    const r = S.rules || {};
    const list = Array.isArray(r.brokers) ? r.brokers : [];
    const meta = r.brokerMeta || {};
    const tr = meta.transfer || {};
    const weekly = meta.weekly || {};
    const myKey = S.account && S.account.broker ? S.account.broker.key : '';
    const rows = list.map((b) => {
      const p = b.preview || {};
      const name = '<b>' + esc(b.name) + '</b>' +
        (b.key === myKey ? '<span class="rule-now">我的</span>' : '') +
        '<span class="rule-sub">' + esc(b.persona || '') + '</span>';
      return [
        name,
        fmtFeeRate(p.feeRate),
        p.leverage ? trimNum(p.leverage, 2) + '×' : '--',
        p.maintenance == null ? '--' : fmtRatio(p.maintenance),
        p.lockMs == null ? '--' : fmtDur(p.lockMs),
        p.lendCapacityPct == null ? '--' : p.lendCapacityPct + '%',
      ];
    });
    const table = rows.length
      ? ruleTable(['券商', '佣金', '融资上限', '维持率', '锁仓', '券源'], rows)
      : '<div class="rule-warn">本服未开启券商玩法，所有账户按基准参数交易。</div>';
    return (
      '<div class="rule-lead">开户时选的<b>券商（出身门派）</b>不是贴纸：佣金、冷却、锁仓、融资额度、保证金、券源、' +
        '消息提前量全都不一样。表里是每家养成到满额后能拿到的数值。</div>' +
      table +
      '<div class="rule-h">声誉星级</div>' +
      ruleKv('怎么升', '按本券商的累计成交额 + 累计盈利', '还有一条硬门槛：爆过仓就上不去高星') +
      ruleKv('有什么用', '1~' + (meta.starMax || 5) + '★ 逐步解锁特权', '「更好」的一面按星级递进，「更差」的代价立刻生效') +
      ruleKv('转户', '冷却 ' + (tr.cooldownDays == null ? 1 : tr.cooldownDays) + ' 个交易日',
        '费用 = 总资产 × ' + fmtRatePct(tr.feeRate, 1) + '（上限 ¥' + fmtMoney(tr.feeCap == null ? 50000 : tr.feeCap) + '），两边星级与进度清空') +
      ruleKv('免费重选', '开户后 ' + (tr.freeReselectDays == null ? 1 : tr.freeReselectDays) + ' 个交易日内 1 次', '之后再换就要付转户费') +
      '<div class="rule-h">每周之星</div>' +
      ruleKv('轮换', '每 ' + (weekly.daysPerWeek == null ? 7 : weekly.daysPerWeek) + ' 个交易日换一家', '轮换表在开户卡片墙与「我的券商」卡上') +
      ruleKv('加成', '佣金 ×' + (weekly.feeMul == null ? 0.5 : weekly.feeMul) +
        ' · 融资额度 +' + (weekly.financeBonus == null ? 0.5 : weekly.financeBonus) + ' 倍', '轮到谁谁便宜，与你选哪家无关') +
      '<div class="rule-tip"><b>拥挤税：</b>人气越旺的券商，佣金与券源越差——人多的地方，券少价高。</div>'
    );
  }

  /** 自动化策略 */
  function rulesAutoHtml(S) {
    const r = S.rules || {};
    const auto = r.auto || {};
    const grid = auto.grid || {};
    const ma = auto.ma || {};
    const dcaMs = auto.dcaMinIntervalMs == null ? 5000 : auto.dcaMinIntervalMs;
    const maxN = auto.maxPerAccount == null ? 20 : auto.maxPerAccount;
    return (
      '<div class="rule-lead">不想盯盘？把规则交给服务端。策略<b>由服务端每 tick 执行</b>，你关掉页面、人不在，它照样下单。</div>' +
      ruleTable(['类型', '逻辑'], [
        ['<b>止盈止损</b>', '价格达到设定的盈利 % 或亏损 % 时自动平仓'],
        ['<b>网格</b>', '在区间内每跌一档买、每涨一档卖，反复薅震荡'],
        ['<b>双均线</b>', '快线上穿慢线开仓、下穿平仓，趋势跟随'],
        ['<b>定投</b>', '每隔一段时间固定金额买入，摊平成本'],
      ]) +
      '<div class="rule-h">约束</div>' +
      ruleKv('配额', '每个账户最多 ' + maxN + ' 条', '跨股票合计，含已完成的历史策略') +
      ruleKv('绑定', '一条策略只服务一只股票', '在哪个盘口建的，就只对那只股票下单') +
      ruleKv('下单口径', '走正常撮合，没有后门', '该收的手续费、该守的锁仓与方向锁一样不少') +
      ruleKv('网格参数', (grid.minStepPct == null ? 0.3 : grid.minStepPct) + '% ~ ' + (grid.maxStepPct == null ? 20 : grid.maxStepPct) + '% 间距',
        '最多 ' + (grid.maxLevels == null ? 50 : grid.maxLevels) + ' 格') +
      ruleKv('均线参数', '快线 ' + (ma.minFast == null ? 10 : ma.minFast) + '~' + (ma.maxFast == null ? 300 : ma.maxFast) +
        ' · 慢线最大 ' + (ma.maxSlow == null ? 900 : ma.maxSlow),
        '快慢线至少间隔 ' + (ma.minSlowGap == null ? 10 : ma.minSlowGap) + ' 根') +
      ruleKv('定投间隔', '不少于 ' + fmtDur(dcaMs), '') +
      '<div class="rule-tip">休市期（午休 / 夜间）策略会跳过，不在冻结的盘口上干等；竞价段照常可用。</div>'
    );
  }

  /** 称号 / 里程碑：只讲机制，不抄门槛（门槛会随运营调整，主页卡片上有实时进度） */
  function rulesEggHtml() {
    return (
      '<div class="rule-lead">收盘结算时，系统会翻一遍你的账户，把这一天的<b>里程碑</b>记下来，' +
        '并对得上的称号发一条播报。判定<b>只在收盘那一刻</b>，不会在盘中跳出来打断你。</div>' +
      ruleTable(['族', '记什么'], [
        ['<b>发家线</b>', '收盘权益向上跨过档位：从「保本出关」一路到「封神」'],
        ['<b>绝对水位</b>', '收盘权益跌破档位：从「出师不利」一路到「倒欠券商」'],
        ['<b>回撤</b>', '相对历史最高收盘权益的回撤幅度，越过 30% / 50% / 70% / 90% 依次点亮'],
        ['<b>风险度</b>', '收盘风险度逼近强平线、擦边过关、以及首次被强平'],
      ]) +
      '<div class="rule-tip">称号在主页「股神里程碑」卡里看：当前称号、下一档还差多少、历史最大回撤都在那儿。' +
        '刷新页面不会重播旧的播报。</div>'
    );
  }

  const RULES_TABS = [
    { key: 'start', label: '快速上手', html: rulesStartHtml },
    { key: 'trade', label: '交易规则', html: rulesTradeHtml },
    { key: 'margin', label: '融资融券', html: rulesMarginHtml },
    { key: 'day', label: '交易日', html: rulesDayHtml },
    { key: 'broker', label: '券商', html: rulesBrokerHtml },
    { key: 'auto', label: '自动化', html: rulesAutoHtml },
    {
      key: 'egg',
      label: '称号',
      html: rulesEggHtml,
      when: (S) => !!(S && S.rules && S.rules.milestones && S.rules.milestones.enabled),
    },
  ];

  function renderRules() {
    const S = state;
    const nav = $('rulesNav');
    const body = $('rulesBody');
    if (!S || !nav || !body) return;
    const tabs = RULES_TABS.filter((t) => !t.when || t.when(S));
    if (!tabs.some((t) => t.key === rulesTabKey)) rulesTabKey = tabs[0].key;
    nav.innerHTML = tabs
      .map(
        (t) =>
          '<button class="rules-tab' + (t.key === rulesTabKey ? ' on' : '') + '" type="button" data-tab="' +
          t.key + '">' + esc(t.label) + '</button>'
      )
      .join('');
    const cur = tabs.find((t) => t.key === rulesTabKey) || tabs[0];
    body.innerHTML = cur ? cur.html(S) : '';
    body.scrollTop = 0;
    // 副标题点明"这些数字是你的券商的"——同一个规则对不同券商有不同的值
    const sub = $('rulesSub');
    if (sub) {
      const bkName = S.account && S.account.broker ? S.account.broker.name : '';
      sub.textContent = bkName
        ? '按「' + bkName + '」的有效参数生成 · 运营调整后自动跟着变'
        : '数值按服务端当前配置生成';
    }
  }

  /** 入口上的"新"点：没点开过规则的人看得见，点过就不再提示 */
  function syncRulesEntry() {
    const btn = $('rulesBtn');
    if (btn) btn.classList.toggle('has-new', !rulesSeen);
  }

  function markRulesSeen() {
    if (rulesSeen) return;
    rulesSeen = true;
    try { localStorage.setItem(RULES_SEEN_KEY, '1'); } catch (e) { /* 隐私模式忽略 */ }
    syncRulesEntry();
  }

  function openRules(tab) {
    if (!state || !state.rules) {
      toast('行情还没连上，稍等一下再看规则', 'err');
      return;
    }
    if (tab) rulesTabKey = tab;
    renderRules();
    $('rulesOverlay').classList.remove('hidden');
    markRulesSeen();
  }

  function closeRules() {
    $('rulesOverlay').classList.add('hidden');
  }

  function bindRules() {
    try { rulesSeen = localStorage.getItem(RULES_SEEN_KEY) === '1'; } catch (e) { rulesSeen = false; }
    syncRulesEntry();
    $('rulesBtn').addEventListener('click', () => openRules());
    $('rulesCloseBtn').addEventListener('click', closeRules);
    $('rulesCloseX').addEventListener('click', closeRules);
    // 点遮罩空白处关闭（点卡片本身不关）
    $('rulesOverlay').addEventListener('click', (e) => {
      if (e.target === $('rulesOverlay')) closeRules();
    });
    // 分类切换：tab 是每帧重建的，事件必须挂在容器上
    $('rulesNav').addEventListener('click', (e) => {
      const btn = e.target.closest ? e.target.closest('.rules-tab') : null;
      if (!btn || !btn.dataset) return;
      rulesTabKey = btn.dataset.tab;
      renderRules();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('rulesOverlay').classList.contains('hidden')) closeRules();
    });
  }

  function renderHome() {
    const a = state && state.account;
    if (!a) return;
    const markets = marketList(state);

    const players = state.players || [];
    const myIdx = players.findIndex((p) => p.account === me);
    const pnl = (a.longPnl || 0) + (a.shortPnl || 0);
    const pos = positionsOf(a, markets);
    const heldStocks = new Set(pos.map((r) => r.stock.stockId)).size;
    const money = (v) => (v >= 0 ? '+' : '-') + '¥' + fmtMoney(Math.abs(v));

    // 主页招呼语用昵称；账号是登录凭据，只在顶栏的 title 里露出来
    $('homeName').textContent = a.nick || myNick || me;
    // 加钱按钮跟随服务端开关（config.account.deposit.enabled）
    $('addCashBtn').hidden = !(state.rules.deposit && state.rules.deposit.enabled);

    renderIndexCard();
    renderMyBroker();
    renderEggCard();

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
            <td>${sparkSvg(sparks.get(idx.stockId) || [], idx.change >= 0 ? themeC.red : themeC.green)}</td>
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
          const spark = sparkSvg(sparks.get(m.stockId) || [], m.change >= 0 ? themeC.red : themeC.green);
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

    const initialCash = state.rules.initialCash || 0;
    const retPct = initialCash > 0 ? ((a.equity - initialCash) / initialCash) * 100 : 0;
    const mixTotal = (a.cash || 0) + (a.longValue || 0) + (a.shortMargin || 0);
    const mixPct = (v) => (mixTotal > 0 ? (v / mixTotal) * 100 : 0);
    const mixSegs = [
      { label: '可用资金', value: a.cash || 0, color: 'var(--blue)' },
      { label: '持仓市值', value: a.longValue || 0, color: 'var(--gold)' },
      { label: '空头保证金', value: a.shortMargin || 0, color: 'var(--green)' },
    ].filter((s) => s.value > 0.005);
    const mixBar = mixSegs.length
      ? mixSegs.map((s) => `<i style="flex:${mixPct(s.value).toFixed(2)};background:${s.color}"></i>`).join('')
      : '<i style="flex:1;background:var(--line)"></i>';
    const mixLegend = mixSegs.map((s) => `
      <div class="mix-item">
        <i style="background:${s.color}"></i>
        <label>${s.label}</label>
        <span>¥${fmtMoney(s.value)}<em>${mixPct(s.value).toFixed(0)}%</em></span>
      </div>`).join('');
    $('homeAssets').innerHTML = `
      <div class="cell hero-cell">
        <label>总权益</label>
        <span class="${cls(a.equity - initialCash)}">¥${fmtMoney(a.equity)}</span>
        <em class="hero-sub">初始资金 ¥${fmtMoney(initialCash)} · 收益率 <b class="${cls(retPct)}">${retPct >= 0 ? '+' : ''}${retPct.toFixed(1)}%</b></em>
      </div>
      <div class="asset-quad">
        <div class="cell"><label>浮动盈亏</label><span class="${cls(pnl)}">${money(pnl)}</span></div>
        <div class="cell"><label>已实现盈亏</label><span class="${cls(a.realizedPnL)}">${money(a.realizedPnL)}</span></div>
        <div class="cell"><label title="现金口径，含融券卖出所得；开空后会大于总权益">可用资金</label><span>¥${fmtMoney(a.cash)}</span></div>
        <div class="cell"><label>持仓市值</label><span>¥${fmtMoney(a.longValue || 0)}</span></div>
      </div>
      <div class="asset-mix">
        <div class="mix-bar">${mixBar}</div>
        <div class="mix-legend">${mixLegend}</div>
      </div>
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
      rankRowsHtml(HOME_RANK_LIMIT) || '<tr><td colspan="4" class="empty">暂无玩家</td></tr>';

    const news = filterNews(state.news || []).slice(0, HOME_NEWS_LIMIT);
    $('homeNewsSub').textContent = (state.news || []).length ? `最近 ${news.length} 条` : '';
    $('homeNews').innerHTML =
      newsHintsHtml() + (newsRowsHtml(news) || '<li class="empty">暂无消息</li>');
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
      if (isKline()) loadDaily(stockId);
    }
    setView('trade');
    renderStockTabs();
    renderHeader();
    renderDepth();
    renderTape();
    renderFlow();
    renderChartMode();
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
        if (activeTab === 'seats') renderSeats();
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
    // 休市（午休 / 夜间）与停牌一样整段冻结四个方向：服务端本来就会拒，
    // 这里提前禁用省得玩家点出一个红 toast
    const day = dayInfo();
    const closed = !!day && !day.trading;
    const frozen = halted || closed;
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
            buy_open: frozen || lock.short,
            sell_close: frozen || !pos || pos.long.sellable <= 0,
            sell_open: frozen || noBorrow || lock.long,
            buy_close: frozen || !pos || pos.short.coverable <= 0,
          };
      document.querySelectorAll('.act-btn').forEach((btn) => {
        const d = dis[btn.dataset.action];
        btn.disabled = d;
        if (isIndex) btn.title = '指数不可交易，仅供观察大盘';
        else if (halted) btn.title = '已停牌，暂停下单';
        else if (closed) btn.title = `${day.label || '休市'}中，暂停下单`;
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
    const finAvailable = !isIndex && selectedAction === 'buy_open' && !!(fin && fin.enabled) && !frozen;
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

  /** 日息（百分数，0.1 表示 0.1%/日）→ 主文与折算到「真实每分钟」（做空利息按游戏日结算） */
  function fmtDailyRate(pct) {
    const r = Number(pct) || 0;
    const mins = minutesPerGameDay();
    return {
      rate: `${Number(r.toFixed(3))}%/日`,
      min: r > 0 ? `收盘结算 · ≈${Number((r / mins).toFixed(4))}%/分` : '',
    };
  }

  /**
   * 杠杆利息常显：做多（融资）与做空（融券）各一行，选中方向且这笔真会借钱/借券时高亮。
   * 融资买入不勾选只是一笔全款买单，不计息，所以高亮跟着勾选状态走。
   * 融资逐分钟摊息、做空按游戏日结算，两行的单位因此不同（/分 vs /日）。
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
      const s = fmtDailyRate(L.dailyRate);
      $('leverValShort').innerHTML = `${s.rate}<i>${s.min}</i>`;
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
    // 都换算成「真实每分钟」——与服务端计息的基数同一口径（做空那半是日息 ÷ 一个游戏日的真实分钟数）
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
      const isShort = selectedAction === 'sell_open';
      // 做空利息按游戏日结算：文案给日成本，别让人以为每分钟都在扣
      $('estInterest').innerHTML = isShort
        ? `${fmtMoney(perMin * minutesPerGameDay())}/日<i>≈${fmtMoney(perMin)}/分 · 收盘结算</i>`
        : `${fmtMoney(perMin)}/分<i>≈${fmtMoney(perMin * 1440)}/日</i>`;
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
    // 停牌、休市与方向锁一并在这里处理：tickUI 每 200ms 会重写 submitBtn.disabled，
    // 只在 renderOrderPanel 里禁用会被它覆盖回可点
    const halted = !!(state.halt && state.halt.halted);
    const day = dayInfo();
    const closed = !!day && !day.trading; // 午休 / 夜间：整段不接受下单
    const lock = directionLock();
    const locked =
      (selectedAction === 'buy_open' && lock.short) ||
      (selectedAction === 'sell_open' && lock.long);
    $('cooldownText').textContent = halted
      ? '已停牌'
      : closed
        ? day.label || '休市中'
        : locked
          ? '本股方向已锁'
          : left > 0
            ? `冷却 ${(left / 1000).toFixed(1)}s`
            : '';
    $('submitBtn').disabled = halted || closed || left > 0 || locked || !!(curMarket() || {}).isIndex;
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

  // ---------- 交易日（见服务端 src/daycycle.js） ----------
  //
  // 阶段一律吃服务端下发的 state.day，客户端**不自己算阶段**——客户端算的话
  // 一旦本机时钟偏了或掉线重连，横幅、倒计时与真实撮合窗口就会错位。

  /** 服务端下发的交易日段（老服务端没有 day 字段时返回 null，前端自动退回旧口径） */
  function dayInfo() {
    const d = state && state.day;
    return d && d.enabled ? d : null;
  }

  /** 距上一帧 state 的毫秒数：倒计时与游戏内时钟都按它往前推，与冷却同口径 */
  function stateDrift() {
    return Math.max(0, Date.now() - lastStateAt);
  }

  /**
   * 游戏内的真实交易时刻（毫秒，自 00:00 起）。
   * 服务端只给到「上一帧那一刻」，这里按阶段内的真实比例线性推进：
   * 竞价 30 秒映射 09:15→09:25，于是 3 秒后顶栏正好走到 09:16。
   * 跨过阶段末尾时就夹住，等下一帧（最慢 200ms）把阶段对齐。
   */
  function gameClockNow() {
    const d = dayInfo();
    if (!d) return null;
    const phaseMs = d.phaseMs || 1;
    const span = d.phaseGameMs || phaseMs;
    const elapsed = d.phaseElapsedMs || 0;
    const done = Math.min(1, elapsed / phaseMs);
    // 阶段起点的游戏内时刻：用「当前时刻 − 已走完的进度」反推。
    // 不能直接在当前时刻上加"漂移量 × 比例"——那样漂移超过阶段末尾时会多算一整段跨度
    // （实测 09:18:48 漂到 09:28:48，本该夹在阶段末尾 09:25:00）
    const startMs = d.gameClockMs - span * done;
    const ratio = Math.min(1, (elapsed + stateDrift()) / phaseMs);
    const v = (startMs + span * ratio) % 86400000;
    return (v + 86400000) % 86400000;
  }

  /** 自 00:00 起的毫秒 → 'HH:MM:SS' */
  function fmtClockMs(ms) {
    const v = ((ms % 86400000) + 86400000) % 86400000;
    const p = (n) => String(n).padStart(2, '0');
    const h = Math.floor(v / 3600000);
    const m = Math.floor((v - h * 3600000) / 60000);
    const s = Math.floor((v - h * 3600000 - m * 60000) / 1000);
    return `${p(h)}:${p(m)}:${p(s)}`;
  }

  /** 顶栏时钟：有交易日时钟就显示游戏内交易时刻，否则退回服务器时间 */
  function renderClock() {
    const g = gameClockNow();
    $('clock').textContent = g == null ? fmtTime(serverNow()) : fmtClockMs(g);
  }

  /**
   * 交易日 UI：顶栏徽标、阶段横幅、盘口虚拟成交价、下单面板时段提示。
   * 每帧与每 200ms 各跑一次——倒计时必须按本机流逝平滑推进，
   * 只靠 state 帧的话数字会一格一格跳。
   */
  function renderDay() {
    if (!state) return;
    const d = dayInfo();
    const chip = $('dayChip');
    const banner = $('dayBanner');
    const note = $('sessionNote');
    const strip = $('auctionStrip');
    if (!d) {
      chip.hidden = true;
      banner.hidden = true;
      note.hidden = true;
      strip.hidden = true;
      return;
    }

    const drift = stateDrift();
    const left = Math.max(0, (d.phaseLeftMs || 0) - drift);
    $('dayNo').textContent = `第 ${d.day} 天`;
    $('dayPhase').textContent = d.label || '';
    $('dayLeft').textContent = left > 0 ? fmtDur(left) : '即将切换';
    chip.hidden = false;
    chip.className = 'day-chip' + (d.auction ? ' auction' : '') + (d.trading ? '' : ' closed');

    const m = curMarket() || {};
    if (d.auction) {
      // 集合竞价：横幅把「虚拟成交价」顶到最显眼处，玩家挂单前先看它
      const a = m.auction;
      banner.hidden = false;
      banner.className = 'halt-banner day-banner auction';
      $('dayBannerTag').textContent = `第 ${d.day} 天 · ${d.auction === 'open' ? '开盘竞价' : '收盘竞价'}`;
      $('dayBannerText').textContent =
        a && a.price != null
          ? `虚拟成交价 ${fmtP(a.price)} · 可成交 ${fmtQty(a.volume)} 股`
          : '盘口未交叉，暂撮合不出价格';
      const unlock = Math.max(0, (d.unlockLeftMs || 0) - drift);
      $('dayBannerLeft').textContent = d.locked
        ? '已进入不可撤单窗口'
        : `距不可撤单 ${fmtDur(unlock)} · 阶段结束集中撮合`;
    } else if (!d.trading) {
      banner.hidden = false;
      banner.className = 'halt-banner day-banner closed';
      $('dayBannerTag').textContent = `第 ${d.day} 天`;
      $('dayBannerText').textContent =
        d.phase === 'lunch' ? '午间休市，13:00 恢复交易' : '已收盘结算，未成交委托按当日失效';
      $('dayBannerLeft').textContent = `恢复交易还有 ${fmtDur(left)}`;
    } else {
      banner.hidden = true;
    }

    note.hidden = d.trading;
    if (!d.trading) note.textContent = `当前${d.label || '休市'}，暂停下单与撮合`;

    if (d.auction && m.auction) {
      strip.hidden = false;
      $('auctionTag').textContent = m.auction.kind === 'open' ? '虚拟开盘价' : '虚拟收盘价';
      $('auctionPrice').textContent = m.auction.price == null ? '--' : fmtP(m.auction.price);
      $('auctionVol').textContent =
        m.auction.price == null
          ? '无交叉盘口'
          : `可成交 ${fmtQty(m.auction.volume)} 股${m.auction.locked ? ' · 已锁定' : ''}`;
    } else {
      strip.hidden = true;
    }
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

  // ---------- 分时 / K 线（日/周/月） ----------
  const canvas = () => $('chart');

  /**
   * 拉某只标的的已收盘日线（切到 K 线模式 / 换标的 / 跨天时各拉一次）。
   * 按**当前模式**决定请求根数：日线 120，周/月线 260（服务端上限）。已经拉过够长的就不再拉；
   * 服务端返回的根数达不到请求数说明库里就这么点（记 Infinity），不必为同一批数据再打一次。
   */
  function loadDaily(stockId) {
    if (!stockId) return;
    const want = isKline() ? DAILY_LIMIT_KLINE : DAILY_LIMIT_DAY;
    if ((dayLoaded.get(stockId) || 0) >= want) return;
    dayLoaded.set(stockId, want); // 先占位，避免同一帧连发多次
    apiGet('/api/daily?stock=' + encodeURIComponent(stockId) + '&limit=' + want)
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (!res || !res.ok) {
          dayLoaded.delete(stockId); // 失败允许下次再试
          return;
        }
        const bars = res.bars || [];
        dayBars.set(stockId, bars);
        // 拿到的比要的少 = 服务端只有这么多（新局 / 刚开几天），别再为它重拉
        dayLoaded.set(stockId, bars.length < want ? Infinity : want);
        if (stockId === activeStockId && activeView === 'trade' && isKline()) drawChart();
      })
      .catch(() => {
        dayLoaded.delete(stockId);
      });
  }

  /**
   * 日线序列：已收盘的 K 线 + 当日那根。
   * 当日那根用实时行情（今开/最高/最低/最新/成交量）现拼——服务端要等收盘结算才定格，
   * 不现拼的话今天在图上是空的。今天已经结算过（盘口里已经有今天这根）就不再拼，
   * 否则夜间那段会用归零后的行情盖掉刚收盘的那根真 K 线。
   */
  function daySeriesOf(m) {
    const bars = (dayBars.get(m.stockId) || []).slice();
    const today = state && state.day && state.day.day ? state.day.day : null;
    if (today && !bars.some((b) => b.day === today)) {
      bars.push({
        day: today,
        open: m.open,
        high: m.high,
        low: m.low,
        close: m.last,
        volume: m.volume,
        turnover: m.turnover,
        net: m.flow ? m.flow.net : 0,
        live: true,
      });
    }
    // 日线只画最近 DAY_SHOW_MAX 根（含当日那根）：抓 260 根是给周/月线并期用的，
    // 日线全铺上会挤成发丝；周/月线必须吃全量，否则并不出足够多的期
    return chartMode === 'day' ? bars.slice(-DAY_SHOW_MAX) : bars;
  }

  /**
   * 一周几个交易日：**必须跟服务端同源**——broker.weeklyPick 用的是
   * `Math.floor((day-1)/config.brokers.weekly.daysPerWeek)`，运营把这个值调了，
   * 客户端写死 7 的话周线分组会和「当周之星」错位。配置没下发时回落 7。
   */
  function weekPer() {
    const w = (state && state.rules && state.rules.brokerMeta && state.rules.brokerMeta.weekly) || {};
    const per = Math.floor(Number(w.daysPerWeek));
    return Number.isFinite(per) && per >= 1 ? per : 7;
  }

  /**
   * K 线序列（按当前模式）：日线原样；周/月线把日线按交易日号聚合——
   * 周 = 每 `daysPerWeek` 个交易日（与券商「当周之星」同口径）、月 = 每 4 周。
   * 聚合规则与行情软件一致：开取期内第一根的开、收取期内最后一根的收、高/低取极值、量额净流入累加。
   */
  function klineSeriesOf(m) {
    const days = daySeriesOf(m);
    if (chartMode === 'day') return days;
    const per = chartMode === 'week' ? weekPer() : weekPer() * 4;
    const unit = chartMode === 'week' ? '周' : '月';
    const out = [];
    let cur = null;
    let curIdx = -1;
    for (const b of days) {
      const idx = Math.floor((b.day - 1) / per);
      if (!cur || idx !== curIdx) {
        curIdx = idx;
        cur = {
          day: b.day,
          label: '第' + (idx + 1) + unit,
          dayFrom: b.day,
          dayTo: b.day,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume || 0,
          turnover: b.turnover || 0,
          net: b.net || 0,
          live: !!b.live,
        };
        out.push(cur);
      } else {
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += b.volume || 0;
        cur.turnover += b.turnover || 0;
        cur.net += b.net || 0;
        cur.live = !!b.live;
        cur.dayTo = b.day;
      }
    }
    return out;
  }

  /** K 线图的几何布局：绘制与十字光标共用一套，避免两处坐标算法跑偏。价格 / 成交量 / MACD 三带 */
  function dayLayout(W, H, bars) {
    const PAD_L = 8;
    const PAD_R = 58;
    const PAD_T = 14;
    const PAD_B = 20;
    const VOL_H = Math.max(18, Math.min(36, H * 0.11));
    const MACD_H = Math.max(36, Math.min(72, H * 0.18));
    const priceH = H - PAD_T - PAD_B - VOL_H - MACD_H - 16;
    const volTop = PAD_T + priceH + 8;
    const macdTop = volTop + VOL_H + 8;
    let lo = Infinity;
    let hi = -Infinity;
    let maxVol = 1;
    for (const b of bars) {
      lo = Math.min(lo, b.low);
      hi = Math.max(hi, b.high);
      maxVol = Math.max(maxVol, b.volume || 0);
    }
    const padP = Math.max((hi - lo) * 0.08, 0.02);
    lo -= padP;
    hi += padP;
    const slot = (W - PAD_L - PAD_R) / Math.max(bars.length, 1);
    return {
      W, H, PAD_L, PAD_R, PAD_T, PAD_B, VOL_H, MACD_H, priceH, volTop, macdTop, lo, hi, maxVol, slot,
      // 蜡烛中心与价格轴映射
      xc: (i) => PAD_L + slot * (i + 0.5),
      y: (p) => PAD_T + ((hi - p) / (hi - lo)) * priceH,
    };
  }

  /** 收盘价均线（MA），与 bars 逐根对齐，不足周期的点返回 null（不画）。
   *  period 先取整：调用方算出小数窗口时 `i >= period` 永远不成立，整条线会静默消失 */
  function movingAvg(bars, period) {
    const p = Math.max(1, Math.round(period));
    const out = new Array(bars.length).fill(null);
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].close;
      if (i >= p) sum -= bars[i - p].close;
      if (i >= p - 1) out[i] = sum / p;
    }
    return out;
  }

  // K 线均线组：日/周/月线共用（5/10/20/30/60/120/250）。
  // 颜色避开 K 线自身的红绿（涨跌），免得长均线被误读成方向信号；周期越大线越粗，
  // 长均线画在最上层不被短均线盖住。与 style.css 的 .ma-c* 一一对应
  const KLINE_MAS = [
    { period: 5,   color: '#f0b429' },             // 金
    { period: 10,  color: '#4c8dff' },             // 蓝
    { period: 20,  color: '#e879c8' },             // 粉
    { period: 30,  color: '#a78bfa' },             // 紫
    { period: 60,  color: '#2ec4b6' },             // 青
    { period: 120, color: '#9aa7bd' },             // 灰蓝
    { period: 250, color: '#c0c8d8', width: 1.8 }, // 浅灰
  ];
  /** 均线配色 class（十字光标用）：CSP 禁内联 style，颜色只能走样式表 */
  const maCls = (period) => 'ma-c' + period;

  /**
   * 周/月线尾部「还没并进任何一期」的日线根数。
   *
   * 现在的 `klineSeriesOf` 是把当日也算进当期（当期 K 线带 live 标记），所以这里
   * 正常返回空数组；留着它是给「未走完的期要不要丢」留口子——真改了那条口径，
   * 均线窗口必须同步剔除这几根，否则末几根 K 线的均线会取到错位的日线。
   */
  function klineLeadBars(m) {
    if (chartMode === 'day') return [];
    const all = daySeriesOf(m); // 周/月线模式吃全量日线
    if (!all.length) return [];
    const lastPeriodDay = klineSeriesOf(m).reduce((mx, b) => Math.max(mx, b.dayTo || 0), 0);
    return lastPeriodDay ? all.filter((b) => b.day > lastPeriodDay) : [];
  }

  /**
   * K 线某一周期的均线，返回值与 `klineSeriesOf(m)` **按下标对齐**（null = 该根还没有均线）。
   *
   * 日线直接按根算。周/月线**在日线上平滑**：MA20(周) = 最近 100 个交易日的收盘均价
   *（即按交易日平滑的 100 日均线）。理由：周线 MA250 名义要 1750 个交易日、月线 MA120
   * 要 3360 个，而服务端只存 260 根日线（dailyBarsKeep），严格并期永远算不出来；
   * 展开成交易日算，价位仍落在价格带上，只是样本比名义周期短（note 写明实际窗口）。
   * 与严格并期（每期等权）的差别只在期内收盘分布不均时有微差，差得出来（>0.2%）
   * 或窗口被截短时标 `approx`，图例/光标写 `MA20≈`，不冒充精确值。
   * @returns {{arr:Array<number|null>, approx:boolean, note:string, window:number, nominal:number}}
   */
  function klineMaOf(m, period) {
    const bars = klineSeriesOf(m);
    if (chartMode === 'day') {
      return { arr: movingAvg(bars, period), approx: false, note: '', window: period, nominal: period };
    }
    const span = chartMode === 'week' ? weekPer() : weekPer() * 4;
    const want = Math.max(1, period * span);
    // 严格并期算得出来（K 线根数够）就用它：每期等权，最贴近「MA20 周线」的本义。
    // 只有样本不够时才退回日线窗口平滑——否则会被平滑的偏差误标 ≈，白丢精度
    const strict = movingAvg(bars, period);
    const strictOk = bars.length >= period && strict[strict.length - 1] != null;
    // K 线少到画不出趋势（不足 5 根）时一律留空：这时候连「一条线」都不成立，
    // 用日线平滑硬凑只会给出一根冒充长均线的假线
    if (bars.length < 5) {
      return {
        arr: new Array(bars.length).fill(null),
        approx: false,
        note: `需 5 根 K 线，现有 ${bars.length} 根`,
        window: 0,
        nominal: want,
      };
    }
    // 预热用全量日线（日线模式下 daySeriesOf 只给 120 根，长均线得靠这里的全量）
    const raw = dayBars.get(m.stockId) || [];
    const seq = raw.length ? raw : daySeriesOf(m);
    const lead = klineLeadBars(m);
    // 窗口在「已成期的日线」上取：尾部还没并进任何一期的日线不参与，
    // 否则窗口会吃掉末尾的 lead 根，最后几根 K 线的均线被挤成 null（看着像整条断掉）
    const body = lead.length ? seq.slice(0, seq.length - lead.length) : seq;
    const kept = Math.max(1, Math.min(want, body.length));
    const smooth = movingAvg(body, kept);          // 与 body 同长（日线下标）
    // 把日线下标的均线映射到 K 线下标：第 k 根 K 线取它那一期最后一根日线的值。
    // 直接 slice(skip) 是错的——skip 是「未成期的根数」，不是 K 线下标偏移
    const smoothArr = bars.map((b) => {
      const iDay = Math.min(body.length - 1, Math.max(0, (b.dayTo || b.day) - 1));
      const v = smooth[iDay];
      return v == null ? null : v;
    });
    const arr = strictOk ? strict : smoothArr;
    // 平滑值才有「近似」一说；严格并期永远是精确值
    const a = strict[strict.length - 1];
    const b = smoothArr[smoothArr.length - 1];
    const approx = !strictOk && (kept < want || (a != null && b != null && Math.abs(a - b) > Math.abs(a) * 0.002));
    // note 说清「实际用了多少个交易日的窗口」，图例/光标据此写 ≈
    const note = !strictOk && kept < want ? `按 ${kept} 个交易日计（名义 ${want}）` : '';
    return { arr, approx, note, window: strictOk ? period : kept, nominal: want };
  }



  /**
   * K 线的 MACD：直接现算，**不做缓存**。
   * 分时那边要缓存是因为一条序列 10300 点、光标一动就全量重算；K 线最多 260 根，
   * 一次 O(n) 循环可以忽略。而「缓存键」这种东西在 K 线上反而不安全——键只能取到
   * 根数 / 首末值，中间某根被结算改写（或 dayBars 整体换掉）时根数与末根收盘都可能不变，
   * 于是读到上一次的 MACD。少一层缓存就少一类这种 bug。
   */
  function klineMacdOf(bars) {
    return computeMacd(bars.map((b) => ({ price: b.close })));
  }

  /**
   * K 线图（日/周/月）：蜡烛 + 成交量 + MA5/10/20/30/60/120/250 + MACD(12,26,9)。
   * 蜡烛按「收 ≥ 开」上色，与分时图同一套 A 股配色（涨红跌绿）；
   * 最后一根是「正在走」的当期 K 线时，在收盘价上点一个空心圈作标记。
   */
  function drawDayChart(c, m) {
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = c.width / dpr;
    const H = c.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const bars = klineSeriesOf(m);
    const modeLabel = chartMode === 'week' ? '周线' : chartMode === 'month' ? '月线' : '日线';
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
    if (!bars.length) {
      ctx.fillStyle = themeC.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('暂无' + modeLabel + '数据（收盘结算后每根 K 线落一笔）', W / 2, H / 2);
      return;
    }

    const L = dayLayout(W, H, bars);
    const n = bars.length;
    const bw = Math.max(1.5, Math.min(L.slot * 0.68, 18));

    // 网格 + 右侧价格标签
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const p = L.lo + ((L.hi - L.lo) * i) / 4;
      const yy = L.y(p);
      ctx.strokeStyle = themeC.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L.PAD_L, yy);
      ctx.lineTo(W - L.PAD_R, yy);
      ctx.stroke();
      ctx.fillStyle = themeC.muted;
      ctx.textAlign = 'left';
      ctx.fillText(p.toFixed(2), W - L.PAD_R + 6, yy);
    }

    // 时间刻度（纵线，日线标签用交易日号，周/月线用期号）
    const ticks = Math.min(6, n);
    ctx.textAlign = 'center';
    for (let k = 0; k < ticks; k++) {
      const i = Math.round(((n - 1) * k) / Math.max(1, ticks - 1));
      const xx = L.xc(i);
      ctx.strokeStyle = themeC.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xx, L.PAD_T);
      ctx.lineTo(xx, L.macdTop + L.MACD_H);
      ctx.stroke();
      ctx.fillStyle = themeC.muted;
      const tickLabel = bars[i].label || '第' + bars[i].day + '天';
      ctx.fillText(tickLabel, Math.min(Math.max(xx, L.PAD_L + 20), W - L.PAD_R - 22), H - L.PAD_B / 2 - 2);
    }

    // 蜡烛与成交量柱
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const up = b.close >= b.open;
      const color = up ? themeC.red : themeC.green;
      const x = L.xc(i);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, L.y(b.high));
      ctx.lineTo(x, L.y(b.low));
      ctx.stroke();
      const yo = L.y(b.open);
      const yc = L.y(b.close);
      ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
      const vh = ((b.volume || 0) / L.maxVol) * L.VOL_H;
      if (vh >= 0.5) {
        ctx.fillStyle = up ? withA(themeC.red, .55) : withA(themeC.green, .55);
        ctx.fillRect(x - bw / 2, L.volTop + (L.VOL_H - vh), bw, vh);
      }
    }

    // 均线组 MA5/10/20/30/60/120/250（周/月线的长周期转成日线窗口，见 klineMaOf）
    const maSeries = KLINE_MAS.map((ma) => ({ ...ma, ...klineMaOf(m, ma.period) }));
    const drawMa = (arr, color, width) => {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (arr[i] == null) continue;
        const px = L.xc(i);
        const py = L.y(arr[i]);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else ctx.lineTo(px, py);
      }
      if (!started) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width || 1.2;
      ctx.stroke();
    };
    for (const ma of maSeries) drawMa(ma.arr, ma.color, ma.width);

    // 当期未收盘的标记
    const last = bars[n - 1];
    if (last.live) {
      ctx.beginPath();
      ctx.arc(L.xc(n - 1), L.y(last.close), 3, 0, Math.PI * 2);
      ctx.strokeStyle = themeC.ink;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // MACD(12,26,9)：柱 = 2×(DIF−DEA)，红柱 DIF>DEA / 绿柱 DIF<DEA（与分时同一套画法）
    const macd = klineMacdOf(bars);
    let mAbs = 1e-9;
    for (let i = 0; i < n; i++) {
      mAbs = Math.max(mAbs, Math.abs(macd.dif[i]), Math.abs(macd.dea[i]), Math.abs(macd.hist[i]));
    }
    const mMid = L.macdTop + L.MACD_H / 2;
    const mY = (v) => mMid - (v / mAbs) * (L.MACD_H / 2 - 8);
    ctx.strokeStyle = themeC.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L.PAD_L, mMid);
    ctx.lineTo(W - L.PAD_R, mMid);
    ctx.stroke();
    for (let i = 0; i < n; i++) {
      const h = (Math.abs(macd.hist[i]) / mAbs) * (L.MACD_H / 2 - 8);
      if (h < 0.4) continue;
      ctx.fillStyle = macd.hist[i] > 0 ? withA(themeC.red, .9) : withA(themeC.green, .9);
      ctx.fillRect(L.xc(i) - bw / 2, macd.hist[i] > 0 ? mMid - h : mMid, bw, h);
    }
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = L.xc(i);
      const py = mY(macd.dif[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = themeC.gold;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = L.xc(i);
      const py = mY(macd.dea[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = themeC.blue;
    ctx.lineWidth = 1.3;
    ctx.stroke();

    // 图例
    ctx.textAlign = 'left';
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = themeC.muted;
    let lx = L.PAD_L + 4;
    const head = `${modeLabel} · 共 ${n} 根${last.live ? '（含当期未收盘）' : ''}`;
    ctx.fillText(head, lx, L.PAD_T - 3);
    lx += ctx.measureText(head).width + 12;
    // 只列画得出线的均线：根数不够的那几条不占位置（否则周/月线上半屏全是 --），
    // 但要说清「有几条没画出来」，别让玩家以为指标漏了
    let hiddenMa = 0;
    for (const ma of maSeries) {
      if (ma.arr[n - 1] == null) {
        hiddenMa += 1;
        continue;
      }
      const txt = 'MA' + ma.period + (ma.approx ? '≈' : ' ') + ma.arr[n - 1].toFixed(2);
      const tw = ctx.measureText(txt).width;
      if (lx + tw > W - L.PAD_R) break; // 排不下就不画，免得溢出右边界
      ctx.fillStyle = ma.color;
      ctx.fillText(txt, lx, L.PAD_T - 3);
      lx += tw + 12;
    }
    if (hiddenMa > 0) {
      const more = `+${hiddenMa} 条样本不足`;
      if (lx + ctx.measureText(more).width <= W - L.PAD_R) {
        ctx.fillStyle = themeC.muted;
        ctx.fillText(more, lx, L.PAD_T - 3);
      }
    }
    // MACD 图例（与分时同款，标在 MACD 带左上角）。
    // **根数不足 MACD_MIN_BARS 时不报 DIF/DEA 数值**：那时 EMA26/EMA9 还没收敛，
    // 写出来的数字只是初始化残差（月线只有 4 根时尤其离谱），改标「未预热」。
    // 精确数值仍可在十字光标里看（那里同样带「样本不足」字样）。
    lx = L.PAD_L + 4;
    ctx.fillStyle = themeC.muted;
    ctx.fillText('MACD(12,26,9)', lx, L.macdTop + 8);
    lx += ctx.measureText('MACD(12,26,9)').width + 10;
    if (n < MACD_MIN_BARS) {
      ctx.fillStyle = themeC.gold;
      ctx.fillText(`样本 ${n} 根 · 未预热`, lx, L.macdTop + 8);
    } else {
      ctx.fillStyle = themeC.gold;
      const difTxt = 'DIF ' + macd.dif[n - 1].toFixed(3);
      ctx.fillText(difTxt, lx, L.macdTop + 8);
      lx += ctx.measureText(difTxt).width + 12;
      ctx.fillStyle = themeC.blue;
      ctx.fillText('DEA ' + macd.dea[n - 1].toFixed(3), lx, L.macdTop + 8);
    }
  }

  /** K 线的十字光标：显示该根的开高低收、成交量、资金净流入与 MACD */
  function dayCrosshair(m, rect, mx, my) {
    const tip = $('chartTip');
    const bars = klineSeriesOf(m);
    if (!bars.length) {
      tip.hidden = true;
      return;
    }
    const L = dayLayout(rect.width, rect.height, bars);
    const i = Math.floor((mx - L.PAD_L) / L.slot);
    if (i < 0 || i >= bars.length) {
      tip.hidden = true;
      return;
    }
    const b = bars[i];
    // 涨跌幅相对**上一根收盘**（首根没有上一根时用自身开盘价兜底）
    const prev = bars[i - 1] ? bars[i - 1].close : b.open;
    const pct = prev ? ((b.close - prev) / prev) * 100 : 0;
    const c = cls(b.close - prev);
    // 期号标签：日线「第 N 天」；周/月线带日区间，便于对照顶栏交易日号
    const title = b.label
      ? `${b.label}（第 ${b.dayFrom}–${b.dayTo} 天${b.live ? '，含未收盘' : ''}）`
      : `第 ${b.day} 天${b.live ? '（未收盘）' : ''}`;
    const md = klineMacdOf(bars);
    const difV = md.dif[i] || 0;
    const deaV = md.dea[i] || 0;
    // 根数不到预热门槛时给个明确提示：此时 DIF/DEA 是初始化残差，不是 MACD
    const macdWarn = bars.length < MACD_MIN_BARS ? ` <span class="t">（样本 ${bars.length} 根，未预热）</span>` : '';
    // 均线那一行只列该根有值的（前几根短均线还没值，长均线更是整条没起来）。
    // 周/月线的均线是日线平滑出来的，窗口被截短时标 ≈（与图例同口径）
    const maCells = KLINE_MAS.map((ma) => {
      const got = klineMaOf(m, ma.period);
      const v = got.arr[i];
      if (v == null) return '';
      return `MA${ma.period}${got.approx ? '≈' : ''} <span class="${maCls(ma.period)}">${v.toFixed(2)}</span>`;
    }).filter(Boolean);
    const maLine = maCells.length
      ? `<span class="t">均线</span> ${maCells.join(' ')}` +
        (maCells.length < KLINE_MAS.length ? ' <span class="t">（其余样本不足）</span>' : '') +
        '<br>'
      : '';
    tip.innerHTML =
      `<span class="t">${esc(title)}</span><br>` +
      `开 <b>${fmtP(b.open)}</b> 高 <b>${fmtP(b.high)}</b><br>` +
      `低 <b>${fmtP(b.low)}</b> 收 <b class="${c}">${fmtP(b.close)}</b> ` +
      `<span class="${c}">${(pct >= 0 ? '+' : '') + pct.toFixed(2)}%</span><br>` +
      `<span class="t">成交量</span> ${fmtVol(b.volume || 0)}<br>` +
      `<span class="t">成交额</span> ${fmtAmount(b.turnover || 0)} · <span class="t">净流入</span> ` +
      `<b class="${cls(b.net)}">${(b.net >= 0 ? '+' : '-') + fmtAmount(Math.abs(b.net || 0))}</b><br>` +
      maLine +
      `<span class="t">MACD</span> DIF <b class="${cls(difV)}">${difV.toFixed(3)}</b> DEA <b class="${cls(deaV)}">${deaV.toFixed(3)}</b>${macdWarn}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    // 多了一行均线，提示框可能比画布还高：上下都夹在画布内，别被裁掉半截
    const th = tip.offsetHeight;
    tip.style.left = Math.min(mx + 14, Math.max(0, rect.width - tw - 6)) + 'px';
    tip.style.top = Math.max(4, Math.min(my + 14, rect.height - th - 6)) + 'px';
  }

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
  // 缓存键带上 stockId 与取数窗口：切股票、切「当日/5日」后序列都变了，必须重算
  let macdCache = { stockId: '', range: '', n: -1, lastT: 0, arr: null };
  function macdOf() {
    const m = curMarket();
    const stockId = m ? m.stockId : '';
    const pts = minutePts(stockId);
    const lastT = pts.length ? pts[pts.length - 1].t : 0;
    if (
      macdCache.stockId !== stockId ||
      macdCache.range !== minuteRange ||
      macdCache.n !== pts.length ||
      macdCache.lastT !== lastT
    ) {
      macdCache = { stockId, range: minuteRange, n: pts.length, lastT, arr: computeMacd(pts) };
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
    if (isKline()) drawDayChart(c, m);
    else drawMinuteChart(c, m);
  }

  function drawMinuteChart(c, m) {
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = c.width / dpr;
    const H = c.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 指数没有均价/MACD 之外的量，但走势结构与个股一致，同一套画法即可
    const prev = m.prevClose;
    const pts = minutePts(m.stockId);
    if (!pts.length) return;

    const PAD_R = 58;
    const PAD_L = 8;
    const PAD_T = 10;
    const PAD_B = 20;
    const VOL_H = Math.max(40, Math.min(80, H * 0.14));
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
      ctx.strokeStyle = themeC.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD_L, yy);
      ctx.lineTo(W - PAD_R, yy);
      ctx.stroke();
      ctx.fillStyle = themeC.muted;
      ctx.textAlign = 'left';
      ctx.fillText(p.toFixed(2), W - PAD_R + 6, yy);
      // 涨跌幅刻度
      const pct = ((p - prev) / prev) * 100;
      ctx.fillStyle = pct > 0 ? themeC.red : pct < 0 ? themeC.green : themeC.muted;
      ctx.fillText((pct >= 0 ? '+' : '') + pct.toFixed(2) + '%', W - PAD_R + 6, yy + 11);
    }

    // 时间刻度（纵线贯穿价格/成交量/MACD 三带）
    ctx.textAlign = 'center';
    ctx.fillStyle = themeC.muted;
    for (let i = 0; i <= 4; i++) {
      const tt = t0 + ((t1 - t0) * i) / 4;
      const xx = x(tt);
      // 居中绘制会越出画布，两端夹回可视区
      const tx = Math.min(Math.max(xx, PAD_L + 18), W - PAD_R - 18);
      ctx.fillText(fmtTime(tt).slice(0, 5), tx, H - PAD_B / 2 - 2);
      ctx.strokeStyle = themeC.grid;
      ctx.beginPath();
      ctx.moveTo(xx, PAD_T);
      ctx.lineTo(xx, macdTop + MACD_H);
      ctx.stroke();
    }

    // 昨收虚线
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = themeC.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, y(prev));
    ctx.lineTo(W - PAD_R, y(prev));
    ctx.stroke();
    ctx.setLineDash([]);

    const up = m.last >= prev;
    const lineColor = up ? themeC.red : themeC.green;

    // 面积
    ctx.beginPath();
    ctx.moveTo(x(pts[0].t), y(pts[0].price));
    for (const p of pts) ctx.lineTo(x(p.t), y(p.price));
    ctx.lineTo(x(pts[pts.length - 1].t), PAD_T + priceH);
    ctx.lineTo(x(pts[0].t), PAD_T + priceH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + priceH);
    grad.addColorStop(0, up ? withA(themeC.red, .28) : withA(themeC.green, .28));
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
    ctx.strokeStyle = withA(themeC.gold, .85);
    ctx.lineWidth = 1;
    ctx.stroke();

    // 成交量柱（按该分钟涨跌着色：价升红 / 价跌绿 / 平盘灰蓝）
    let maxVol = 1;
    const deltas = [];
    for (let i = 0; i < pts.length; i++) {
      const v = pts[i].vol || 0;
      const pv = i === 0 ? 0 : pts[i - 1].vol || 0;
      // 日切检测：收盘结算会把当日成交量归零，直接相减会出现负差——
      // 一根柱子凭空消失，下一根又从零重新长。检测到 vol 回落就当成"新的一天"，
      // 用当日累计量本身作为这一根的增量（开盘竞价那一笔巨量正好一根柱画完）
      const d = i === 0 ? 0 : v < pv ? v : Math.max(0, v - pv);
      deltas.push(d);
      if (d > maxVol) maxVol = d;
    }
    const bw = Math.max(1, ((W - PAD_L - PAD_R) / Math.max(pts.length, 1)) * 0.7);
    for (let i = 1; i < pts.length; i++) {
      const h = (deltas[i] / maxVol) * VOL_H;
      if (h < 0.5) continue;
      const dp = pts[i].price - pts[i - 1].price;
      ctx.fillStyle = withA(dp > 0 ? themeC.red : dp < 0 ? themeC.green : themeC.blue, .6);
      ctx.fillRect(x(pts[i].t) - bw / 2, volTop + (VOL_H - h), bw, h);
    }
    // 量带标注：左上「成交量」+ 右侧满仓刻度，让柱子有可读的量纲
    ctx.textAlign = 'left';
    ctx.fillStyle = themeC.muted;
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText('成交量', PAD_L + 4, volTop + 7);
    ctx.textAlign = 'right';
    ctx.fillText(fmtVol(maxVol), W - PAD_R - 4, volTop + 7);
    ctx.textAlign = 'left';
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';

    // MACD(12,26,9)：柱 = 2×(DIF−DEA)，红柱 DIF>DEA / 绿柱 DIF<DEA（与涨跌配色一致）
    const macd = macdOf();
    const nM = pts.length;
    let mAbs = 1e-9;
    for (let i = 0; i < nM; i++) {
      mAbs = Math.max(mAbs, Math.abs(macd.dif[i]), Math.abs(macd.dea[i]), Math.abs(macd.hist[i]));
    }
    const mMid = macdTop + MACD_H / 2;
    const mY = (v) => mMid - (v / mAbs) * (MACD_H / 2 - 10);
    ctx.strokeStyle = themeC.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, mMid);
    ctx.lineTo(W - PAD_R, mMid);
    ctx.stroke();
    for (let i = 0; i < nM; i++) {
      const h = (Math.abs(macd.hist[i]) / mAbs) * (MACD_H / 2 - 10);
      if (h < 0.4) continue;
      ctx.fillStyle = macd.hist[i] > 0 ? withA(themeC.red, .9) : withA(themeC.green, .9);
      ctx.fillRect(x(pts[i].t) - bw / 2, macd.hist[i] > 0 ? mMid - h : mMid, bw, h);
    }
    ctx.beginPath();
    for (let i = 0; i < nM; i++) {
      const px = x(pts[i].t);
      const py = mY(macd.dif[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = themeC.gold;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < nM; i++) {
      const px = x(pts[i].t);
      const py = mY(macd.dea[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = themeC.blue;
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
    ctx.fillStyle = themeC.gold;
    ctx.fillText('均价', PAD_L + 4, PAD_T + 8);
    ctx.fillStyle = lineColor;
    ctx.fillText('价格', PAD_L + 36, PAD_T + 8);
    ctx.fillStyle = themeC.muted;
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    let lx = PAD_L + 4;
    ctx.fillText('MACD(12,26,9)', lx, macdTop + 9);
    lx += ctx.measureText('MACD(12,26,9)').width + 10;
    ctx.fillStyle = themeC.gold;
    ctx.fillText('DIF ' + macd.dif[nM - 1].toFixed(3), lx, macdTop + 9);
    lx += ctx.measureText('DIF ' + macd.dif[nM - 1].toFixed(3)).width + 12;
    ctx.fillStyle = themeC.blue;
    ctx.fillText('DEA ' + macd.dea[nM - 1].toFixed(3), lx, macdTop + 9);
  }

  // 十字光标
  function bindCrosshair() {
    const c = canvas();
    const tip = $('chartTip');
    c.addEventListener('mousemove', (e) => {
      const m = curMarket();
      if (!state || !m) return;
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // K 线走自己那套（单根的开高低收 + MACD），几何与 drawDayChart 同一份布局
      if (isKline()) {
        dayCrosshair(m, rect, mx, my);
        return;
      }
      const pts = minutePts(m.stockId);
      if (!pts.length) return;
      // 反解时间（与 drawMinuteChart 的 x 轴同一套域）
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
      // 成交量与柱子同口径：这一分钟的增量（日切回落时取当日累计），括号里补总量
      const pv = bestI === 0 ? 0 : pts[bestI - 1].vol || 0;
      const bv = best.vol || 0;
      const mv = bestI === 0 ? 0 : bv < pv ? bv : Math.max(0, bv - pv);
      const md = macdOf();
      const difV = md.dif[bestI] || 0;
      const deaV = md.dea[bestI] || 0;
      tip.innerHTML =
        `<span class="t">${fmtTime(best.t)}</span><br>价格 <b class="${cls(best.price - prev)}">${fmtP(best.price)}</b> <span class="${cls(best.price - prev)}">${(pct >= 0 ? '+' : '') + pct.toFixed(2)}%</span><br><span class="t">成交量</span> ${fmtVol(mv)} <span class="t">（累计 ${fmtVol(bv)}）</span><br>` +
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
    renderDay();
    renderClock();
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
  /** 彩蛋横幅的收起按钮：点掉立刻播下一条 */
  function bindEggs() {
    const el = $('eggClose');
    if (el) el.addEventListener('click', hideEggBanner);
  }

  function init() {
    bindLogin();
    bindComic();
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
    bindPlayerPositions();
    bindCrosshair();
    bindChartMode();
    bindTransfer();
    bindEggs();
    bindCompanyProfile();
    bindRules();
    renderChartMode();
    // 恢复上次的主题与吉祥物（都没选过=默认：深夜终端 + 跟随主题）
    try { currentMascot = localStorage.getItem(MASCOT_KEY); } catch (e) { /* 忽略 */ }
    setTheme(localStorage.getItem(THEME_KEY) || '', false);
    setInterval(tickUI, 200);
    // 券商卡片墙在**登录之前**就要渲染，所以先拉公开的 /api/brokers，再决定要不要弹登录
    loadBrokers();
    if (me) {
      // 有账号就静默登录一次（令牌在服务端重启后必失效，所以这里始终走一次登录换新令牌）。
      // **没开过户不会自动进开户步骤**——探测失败就停在第一步、账号预填在框里，
      // 开户流程一律要玩家自己点一次「登录」才进入（见 probeLogin）
      const account = me;
      probeLogin(account)
        .then((res) => {
          if (res && !res.ok && res.error) toast(res.error, 'err');
        })
        .catch(() => showLogin(ACCOUNT_RE.test(account) ? account : ''));
    } else {
      showLogin('');
    }
  }

  init();
})();

