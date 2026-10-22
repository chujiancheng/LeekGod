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
  // 已提示过的系统公告 id：服务端每帧都带 notice，靠 id 只弹一次 toast
  let lastNoticeId = 0;
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
  let holdersAt = 0; // 最近一次**成功**响应的时刻
  let holdersTriedAt = 0; // 最近一次发起请求的时刻（成功失败都算），最小间隔防抖用
  let holdersFails = 0; // 连续失败次数（限流 / 网络），驱动退避
  let holdersPending = false; // 有请求在飞（加载中状态显示用）
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
  // 日线**默认**一屏放多少根（不是数据上限）：260 根全铺开每根只有 2px，挤成发丝。
  // 放大/缩小走 kViews 的 count，最多能缩到全量（见 klineView）
  const DAY_SHOW_MAX = 120;
  // K 线视窗（滚轮缩放 + 拖动平移）：按模式各记一份，日/周/月切换互不影响。
  //   count  = 屏上放几根（0 = 还没调过，取默认值）
  //   offset = 右端丢掉几根（0 = 贴最新一根；>0 = 正在翻历史）
  // 一律**相对尾部**记：跟着最新价看的玩家 offset=0，新的一根进来时视窗自动右移；
  // 正在翻历史的玩家 offset>0，窗口内容原地不动，不会被新数据顶走。
  const KVIEW_MIN_BARS = 15; // 最多放大到 15 根（再少就看不出形态了）
  const ZOOM_STEP = 1.25;    // 每一格滚轮的缩放倍率
  const kViews = {
    day: { count: 0, offset: 0 },
    week: { count: 0, offset: 0 },
    month: { count: 0, offset: 0 },
  };
  let chartPan = null; // 拖动平移的会话（pointerdown 起、pointerup 止）
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
    { id: 'eyecare', name: '护眼纸感', tag: '护眼', desc: '米绿纸底 · 低蓝光久看不累' },
    { id: 'skyblue', name: '晴蓝事务所', tag: '清爽', desc: '雾蓝纸底 · 白卡靛蓝透气' },
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
    { id: 'kanpan',  name: '看盘少女', img: '/img/mascot-kanpan-256.png', thumb: '/img/mascot-kanpan-96.png', desc: '盯盘不眨眼，只看涨' },
    { id: 'whale',   name: '小鲸鱼', img: '/img/mascot-whale-256.png', thumb: '/img/mascot-whale-96.png', desc: '深海捞涨点' },
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
    if (next !== me) {
      resetEggStream();
      resetDanmakuStream(); // 弹幕水位同理：换号不换水位，新号的弹幕会被旧 id 挡住
    }
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
  /**
   * 市值（流通市值 / 总市值）：带「万亿」这一档，且**不带「元」后缀**——
   * 行情表一列里 "20.00亿" 比 "20.00亿元" 省地方，表头已经写明是市值。
   * 个股流通市值量级 20~45 亿，指数总市值约 290 亿，万亿档是给长牛局留的余量。
   */
  function fmtCap(v) {
    const n = Number(v) || 0;
    if (n >= 1e12) return (n / 1e12).toFixed(2) + '万亿';
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(2) + '万';
    return n.toFixed(0) + '元';
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
   * 分时窗口实际覆盖的天数。
   * 「5 日」是个**上限**：本局才跑到第 2 天时，往前 5 天有 3 天根本不存在，
   * 硬按 5 天铺轴会在左边画出「-3日 / 0日 09:30」这种不存在的日期（天号从 1 起）。
   * 所以按已开的天数收窄——开局时 5 日视图就等于当日视图，跑到第 5 天才真是 5 天。
   */
  function minuteDays() {
    if (minuteRange !== '5d') return 1;
    const todayNo = Number((dayInfo() || {}).day) || 1;
    return Math.max(1, Math.min(MINUTE_DAYS, todayNo));
  }

  /**
   * 分时窗口的起始时刻：当日 = 今天开盘竞价开始；5 日 = 再往前 N 个交易日。
   * 锚点 `dayStartAt` 由服务端下发（客户端没有阶段偏移表，自己算不出来）。
   * 没有交易日时钟时返回 0 = 不过滤，行为与引入窗口之前逐位一致。
   */
  function minuteFrom() {
    const d = dayInfo();
    if (!d || !d.dayStartAt) return 0;
    const dayMs = Math.max(1, Number(d.dayEndsAt || 0) - Number(d.dayStartAt));
    return minuteRange === '5d' ? d.dayStartAt - (minuteDays() - 1) * dayMs : d.dayStartAt;
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
    // 切股票要把在飞的弹幕收掉：上一只票的声音飘在新图上，是最容易出戏的一种错
    const dmLayer = $('danmakuLayer');
    if (dmLayer) dmLayer.textContent = '';
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
    // 破境 / 跌境横幅按大境界上色（左边线 + 标题）。CSSOM 写变量，不受 CSP 限制；
    // 非境界事件必须**清掉**上一次留下的 --rtone，否则彩蛋横幅会沿用上一个境界色
    if (ev.realmGroup) el.style.setProperty('--rtone', 'var(--realm-' + ev.realmGroup + ')');
    else el.style.removeProperty('--rtone');
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
  /**
   * 主页「境界 · 称号」卡（Doc/头衔方案.md §6.2）：**主徽章只有一个——境界**。
   * 彩蛋（A 族发家线）的称号降级成下面的 chips：两套称号并排，玩家会看懵
   * （"我到底是保本出关还是结丹后期？"）。A 族的"下一档还差多少"挪去规则面板讲，
   * 卡片上只留一个进度条——修为条。
   *
   * 老服务端（只有 account.events、没有 account.realm）时退回纯彩蛋卡，不报错。
   */
  function renderEggCard() {
    const el = $('eggCard');
    if (!el) return;
    const a = state && state.account;
    const r = a && a.realm;
    const eggs = a && a.events;
    const realmOn = !!(state && state.rules && state.rules.realm && state.rules.realm.enabled);
    const eggsOn = !!(state && state.rules && state.rules.milestones && state.rules.milestones.enabled);
    const showRealm = !!(r && r.name && realmOn);
    const showEggs = !!(eggs && eggsOn);
    if (!showRealm && !showEggs) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    // 境界色走 CSS 变量（CSP 禁内联 style 属性，CSSOM 的 setProperty 不受限）
    el.style.setProperty('--rtone', 'var(--realm-' + (r && r.group ? r.group : 'mortal') + ')');

    const rar = { common: '普通', rare: '稀有', epic: '史诗', legend: '传说' };
    const titles = (eggs && eggs.titles) || [];
    const dd = eggs ? (Math.max(0, eggs.drawdown || 0) * 100).toFixed(1) : '0.0';
    const ddm = eggs ? (Math.max(0, eggs.maxDrawdown || 0) * 100).toFixed(1) : '0.0';

    // ---- 境界块 ----
    let realmHtml = '';
    if (showRealm) {
      let barHtml;
      if (r.next) {
        const pct = Math.max(2, Math.min(100, Math.round((r.pct || 0) * 100)));
        const needText = r.pending
          ? '已达门槛，等收盘结算确认'
          : `还差 ${fmtAmount(r.next.need)}`;
        barHtml = `
          <div class="realm-bar">
            <label>修为 · 距「${esc(r.next.name)}」</label>
            <i class="mb-bar"><b data-w="${pct}"></b></i>
            <span class="realm-need">${needText}</span>
          </div>`;
      } else {
        barHtml = '<div class="egg-note">此界已至尽头——再往上没有境界，只有传说。</div>';
      }
      const peakText =
        r.peak && r.peak.idx > r.idx ? `历史最高 · ${esc(r.peak.name)}` : '已是历史最高';
      realmHtml = `
        <div class="realm-top">
          <span class="realm-name">${esc(r.name)}</span>
          <span class="realm-honor">${esc(r.honor || '')}</span>
          <span class="egg-cur-sub">${peakText}</span>
        </div>
        ${barHtml}
        <div class="realm-meta">
          <span>权益 <b>${fmtAmount(r.equity || 0)}</b></span>
          <span>峰值 <b>${fmtAmount(r.peakEquity == null ? r.equity || 0 : r.peakEquity)}</b></span>
          ${showEggs ? `<span>已获称号 <b>${titles.length}</b> 个</span>` : ''}
          ${r.dropping ? '<span>道基不稳：今晚若还在这儿会跌境</span>' : ''}
        </div>`;
    } else if (eggs) {
      // 老服务端：退回原来的"当前称号"一行
      const cur = eggs.title;
      realmHtml = `
        <div class="egg-top">
          ${
            cur
              ? `<span class="egg-cur ${esc(cur.rarity || 'common')}">${esc(cur.title)}</span>
                 <span class="egg-cur-sub">当前称号 · ${esc(rar[cur.rarity] || '普通')}</span>`
              : '<span class="egg-cur-sub">暂无称号</span>'
          }
        </div>`;
    }

    // ---- 称号 chips ----
    // 彩蛋整体关掉时**整段不渲染**：否则会显示"已获称号 0 个 / 还没有称号"，
    // 像是在说玩家一个成就都没拿到，实际是这个功能没开
    let chipsHtml = '';
    if (showEggs) {
      const chips = titles.length
        ? titles
            .slice()
            .reverse()
            .map((t) => `<span class="egg-chip ${esc(t.rarity || 'common')}">${esc(t.title)}</span>`)
            .join('')
        : '<span class="empty">还没有称号——先活过今天收盘。</span>';
      chipsHtml = `<div class="realm-sub-title">里程碑称号</div><div class="egg-titles">${chips}</div>`;
    }

    el.innerHTML = `
      <div class="panel-title">
        <span>境界 · 称号</span>
        ${
          // 回撤口径来自彩蛋段（peakEquity / maxDrawdown），彩蛋关了就没有这两个数，
          // 不能写死 0.0%——那会显示成"从未回撤"，是假信息
          showEggs ? `<span class="panel-sub">回撤 <b>${dd}%</b> · 历史最大 <b>${ddm}%</b></span>` : ''
        }
      </div>
      ${realmHtml}
      ${chipsHtml}
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
    // 头像：顶栏 26px 是唯一入口（Doc/头像方案.md §7.4）
    bindAvaDialog();
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
   * 顶栏境界徽标（Doc/头衔方案.md §6.1）。
   * 只显示**收盘已确认**的境界；盘中越过下一档时加一圈光晕（`pending`），
   * 跨进跌境缓冲带时换虚线边（`dropping`）——都不在顶栏跳数字。
   * 窄屏只留大境界一个字，完整名进 title（靠 CSS 切换，不监听 resize）。
   */
  const REALM_MINI = {
    mortal: '凡', lianqi: '炼', zhuji: '筑', jindan: '结', yuanying: '元',
    huashen: '神', lianxu: '虚', heti: '合', dacheng: '乘', dujie: '劫',
  };
  let realmChipSig = '';
  // 境界整表只在首屏 /api/state 下发（SSE 增量帧 lite 不带）：拿到一次就缓存，
  // 规则面板从这儿读，所以**不能**直接挂在 state.rules 上——每帧都会被替换掉
  let realmLadder = null;

  function renderRealmChip() {
    const el = $('whoRealm');
    if (!el) return;
    const r = state && state.account && state.account.realm;
    const on = !!(state && state.rules && state.rules.realm && state.rules.realm.enabled);
    if (!r || !on || !r.name) {
      if (realmChipSig !== 'off') {
        realmChipSig = 'off';
        el.hidden = true;
        el.className = 'realm-chip';
      }
      return;
    }
    // 只在真的变了才动 DOM：徽标挂在顶栏，每帧重写会拖慢整页（同 renderIdentity 的取舍）。
    // 但 `sig` 只含"外观"（档位 / 大境界 / 两个状态位）——权益与差额每帧都在变，
    // 把它们塞进 sig 等于每帧重写 innerHTML。所以下面分成两段：
    // 外观走 sig 闸门，**title 每帧都拼一次**（纯字符串赋值，一行 DOM 属性，不布局）
    const sig = [r.idx, r.group, r.pending ? 1 : 0, r.dropping ? 1 : 0].join('|');
    const changed = sig !== realmChipSig;
    realmChipSig = sig;
    if (changed) {
      el.hidden = false;
      el.className =
        'realm-chip g-' + (r.group || 'mortal') + (r.pending ? ' pending' : '') + (r.dropping ? ' dropping' : '');
      const mini = REALM_MINI[r.group] || (r.name || '').slice(0, 1);
      el.innerHTML =
        '<span class="rc-full">' + esc(r.name) + '</span><span class="rc-mini">' + esc(mini) + '</span>';
    }
    const parts = [r.name, r.honor].filter(Boolean);
    if (Number.isFinite(r.equity)) parts.push('权益 ' + fmtAmount(r.equity));
    if (r.next) parts.push('距' + r.next.name + ' ' + fmtAmount(r.next.need));
    else parts.push('已在最高境界');
    if (r.pending) parts.push('已越过门槛，等收盘结算确认');
    el.title = parts.join(' · ');
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
    renderRealmChip();
    renderTopAvatar();
  }

  // ---------- 头像（Doc/头像方案.md） ----------
  // 与「外观 / 吉祥物」的语义分工（§2.1）：吉祥物是**只有自己看得见**的桌面摆件（localStorage），
  // 头像是**别人在榜单/股东榜里看到的脸**（落库、服务端权威）。两者入口、文案、存储全分家。
  // 目录整表只在首屏下发（lite 帧只有 enabled），拿到一次就缓存——同 realmLadder 的取舍
  let avatarCatalog = null;
  let avaCatalogPending = false;
  const AVA_SEEN_KEY = 'gushen_ava_seen'; // 首次引导只提示一次（§8.1）
  let avaIntroShown = false;
  // 'off' 是"当前没有头像"的哨兵值：用它而不是空串，才能区分
  // 「服务端撤回/关掉了头像」（要隐藏）与「还没渲染过」（什么都不用做）
  let avaTopSig = 'off';

  /** 两档图：≤40 CSS px 用 -96，>40 用 -192（§4.2）。**不引用 512 母版** */
  function avatarSrc(key, size) {
    return '/img/avatar-' + encodeURIComponent(key) + '-' + (size > 40 ? 192 : 96) + '.png';
  }

  /** 当前账户的大境界（环色用它）。没有 realm（彩蛋/境界关掉）→ 中性灰 */
  function myRealmGroup() {
    return (state && state.account && state.account.realm && state.account.realm.group) || 'mortal';
  }

  /**
   * 头像 HTML。两个坑写在代码里：
   * ① **环色不许写内联 style**：CSP 是 `style-src 'self'`，内联样式被拦后节点还在、
   *    样式静默作废（本项目真踩过）——所以走 `g-<realm.group>` class 映射 `--rtone`；
   * ② **不许写内联 onerror**：`script-src 'self'` 同样会拦，裂图兜底由 bindAvaFallback
   *    用 addEventListener 挂（见 §4.6）。
   */
  function avaHtml(key, size, group, name) {
    if (!key) return '';
    const ch = String(name || '?').slice(0, 1);
    return (
      '<span class="ava s' + size + ' g-' + esc(group || 'mortal') + '">' +
        '<img class="ava-img" src="' + esc(avatarSrc(key, size)) + '" alt="" width="' + size +
        '" height="' + size + '" decoding="async">' +
        '<span class="ava-ch" hidden>' + esc(ch) + '</span>' +
      '</span>'
    );
  }

  /** 裂图降级（§4.6）：图隐藏、首字兜位。`<img>` 宽高已固定，行高列宽不会因此错位 */
  function onAvaImgError(img) {
    if (!img) return;
    img.hidden = true;
    const ch = img.nextElementSibling;
    if (ch) ch.hidden = false;
  }

  function bindAvaFallback(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    root.querySelectorAll('img.ava-img').forEach((img) => {
      if (img.getAttribute('data-ava-bound')) return;
      img.setAttribute('data-ava-bound', '1');
      img.addEventListener('error', () => onAvaImgError(img));
    });
  }

  /**
   * 顶栏头像（26px，唯一入口）。只在"外观"真的变了才动 DOM：
   * 它挂在顶栏、每帧都会被调到，每帧重写 src 会让浏览器反复查缓存（同 renderRealmChip 的取舍）。
   */
  function renderTopAvatar() {
    const btn = $('avaBtn');
    if (!btn) return;
    const av = state && state.account && state.account.avatar;
    const on = !!(state && state.rules && state.rules.avatar && state.rules.avatar.enabled);
    if (!on || !av || !av.key) {
      if (avaTopSig !== 'off') {
        avaTopSig = 'off';
        btn.hidden = true;
      }
      return;
    }
    const group = myRealmGroup();
    const sig = av.key + '|' + group;
    if (sig !== avaTopSig) {
      avaTopSig = sig;
      btn.hidden = false;
      // 三个类缺一不可：`ava` 给 box-shadow 环与 --rtone 的消费点，`s26` 给环宽档，
      // `g-<group>` 给环色。只写 `ava-top g-…` 时 <button> 一条 `.ava` 规则都吃不到，
      // 环就静默不存在——真机上只表现为"少了圈细边"，headless 里查 box-shadow 才看得见
      btn.className = 'ava ava-top s26 g-' + group;
      const img = $('avaImg');
      if (img) {
        img.hidden = false;
        img.src = avatarSrc(av.key, 26);
      }
      const ch = $('avaCh');
      if (ch) {
        ch.hidden = true;
        ch.textContent = String(av.name || '?').slice(0, 1);
      }
      btn.title = '换一张脸（当前：' + (av.name || av.key) + '）';
    }
    maybeAvaIntro(av);
  }

  /** 首次引导（§8.1）：从没主动选过的人给一个金点 + 一条 toast，**只提示一次** */
  function maybeAvaIntro(av) {
    let seen = false;
    try { seen = localStorage.getItem(AVA_SEEN_KEY) === '1'; } catch (e) { /* 隐私模式忽略 */ }
    const dot = $('avaNew');
    if (dot) dot.hidden = seen || !!av.chosen;
    if (seen || av.chosen || avaIntroShown) return;
    avaIntroShown = true;
    toast('给你配了张脸：' + (av.name || '已就绪') + '。不合眼缘？点顶栏头像换。');
  }

  function markAvaSeen() {
    try { localStorage.setItem(AVA_SEEN_KEY, '1'); } catch (e) { /* 忽略 */ }
    const dot = $('avaNew');
    if (dot) dot.hidden = true;
  }

  /** 换脸弹层的卡片（四组：已解锁=可点，未解锁=灰 + 锁 + 条件文案） */
  function avaCellsHtml() {
    const cat = avatarCatalog;
    const cur = state && state.account && state.account.avatar ? state.account.avatar : null;
    const unlocked = new Set((cur && cur.unlocked) || []);
    if (!cat || !Array.isArray(cat.groups) || !cat.groups.length) {
      return '<div class="panel-sub">头像目录还没到手，稍等一下或刷新页面。</div>';
    }
    const group = myRealmGroup();
    return cat.groups.map((g) => {
      const cells = g.rows.map((r) => {
        const isCur = !!(cur && cur.key === r.key);
        const ok = unlocked.has(r.key);
        const cls = 'ava-cell' + (isCur ? ' cur' : '') + (ok ? '' : ' locked');
        return (
          '<button class="' + cls + '" type="button" data-key="' + esc(r.key) + '"' +
            ' data-locked="' + (ok ? '0' : '1') + '"' +
            ' data-unlock="' + esc((r.unlock && r.unlock.text) || '') + '"' +
            ' title="' + esc(r.name) + '">' +
            avaHtml(r.key, 64, group, r.name) +
            '<span class="ava-name">' + esc(r.name) + '</span>' +
            (isCur ? '<span class="ava-tick" aria-hidden="true">✓</span>' : '') +
            (ok ? '' : '<span class="ava-lock" aria-hidden="true">🔒</span>') +
          '</button>'
        );
      }).join('');
      return (
        '<div class="ava-group">' +
          '<div class="ava-group-head"><b>' + esc(g.label) + '</b><span>' + esc(g.hint) + '</span></div>' +
          '<div class="ava-grid">' + cells + '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderAvaCells() {
    const box = $('avaGroups');
    if (!box) return;
    box.innerHTML = avaCellsHtml();
    bindAvaFallback(box);
  }

  /** 目录没拿到（切号 / 刷新竞态）时补拉一次：整表只在首屏 /api/state 里 */
  function ensureAvatarCatalog() {
    if (avatarCatalog || avaCatalogPending) return;
    avaCatalogPending = true;
    apiGet('/api/state')
      .then((r) => r.json())
      .then((s) => {
        const av = s && s.rules && s.rules.avatar;
        if (av && Array.isArray(av.groups) && av.groups.length) {
          avatarCatalog = av;
          renderAvaCells();
        }
      })
      .catch(() => { /* 下一帧再说 */ })
      .then(() => { avaCatalogPending = false; });
  }

  function openAvaOverlay() {
    ensureAvatarCatalog();
    renderAvaCells();
    $('avaOverlay').classList.remove('hidden');
    markAvaSeen();
  }

  /** 换脸动效（§8.2）：原地翻牌 300ms。reduced-motion 在 CSS 里直接关掉 */
  function flipTopAvatar() {
    const btn = $('avaBtn');
    if (!btn || !btn.classList) return;
    btn.classList.remove('flip');
    btn.classList.add('flip');
    setTimeout(() => btn.classList.remove('flip'), 340);
  }

  /** 换脸：只打一次 `/api/avatar`，body 只有 `{key}` */
  function pickAvatar(key) {
    const cur = state && state.account && state.account.avatar;
    if (cur && cur.key === key) return; // 点自己那张脸不发请求
    apiPost('/api/avatar', { key })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) {
          toast(res.error || '换脸失败', 'err');
          return;
        }
        if (state && state.account) state.account.avatar = res.avatar;
        avaTopSig = ''; // 保险：key 变了本来就该变，清掉签名强制重刷
        renderTopAvatar();
        renderAvaCells();
        flipTopAvatar();
        toast('换脸成功。名字没变，人设变了。');
      })
      .catch(() => toast('网络抖动，这次没换成', 'err'));
  }

  /**
   * 点一张卡。锁卡只出服务端给的文案、**不发请求**（省一次 403）；
   * 服务端仍会校验——前端拦截只是体验，不是安全边界。
   * 抽成独立函数是为了让离线自检能直接调它（桩 DOM 没有 closest / 事件冒泡）
   */
  function avaCellClick(cell) {
    if (!cell) return;
    if (cell.getAttribute('data-locked') === '1') {
      toast(cell.getAttribute('data-unlock') || '这张脸还没解锁');
      return;
    }
    pickAvatar(cell.getAttribute('data-key'));
  }

  function bindAvaDialog() {
    const btn = $('avaBtn');
    if (btn) btn.addEventListener('click', openAvaOverlay);
    const close = $('avaCloseBtn');
    if (close) close.addEventListener('click', () => $('avaOverlay').classList.add('hidden'));
    const img = $('avaImg');
    if (img) img.addEventListener('error', () => onAvaImgError(img));
    const box = $('avaGroups');
    if (box) {
      box.addEventListener('click', (e) => {
        const t = e && e.target;
        avaCellClick(t && typeof t.closest === 'function' ? t.closest('.ava-cell') : null);
      });
    }
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
    const lg = $('companyLogo');
    // 指数没有徽记（lore.logo 为空）：隐藏 logo 位，防止裂图
    lg.hidden = !lore.logo;
    if (lore.logo) {
      lg.src = lore.logo;
      lg.alt = m.name + '徽记';
    }
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
    // 公司资料四件套：发行价 / 流通股本 / 流通市值 / 较发行价。
    // 全部来自服务端快照（initPrice / floatShares / marketCap），客户端不做二次口径；
    // 老服务端缺字段时这几格显示 --，不会因为 NaN 把整张卡画崩
    const float = Number(m.floatShares) || 0;
    const issue = Number(m.initPrice) || 0;
    const capNow = m.marketCap != null ? m.marketCap : float * (Number(m.last) || 0);
    const vsIssue = issue > 0 ? (Number(m.last) / issue - 1) * 100 : null;
    $('companyStats').innerHTML =
      '<div class="cs-item"><label>最新价</label><b class="' + ch + '">' + esc(fmtP(m.last)) + '</b></div>' +
      '<div class="cs-item"><label>涨跌幅</label><b class="' + ch + '">' +
        (m.changePct >= 0 ? '+' : '') + esc(m.changePct.toFixed(2)) + '%</b></div>' +
      '<div class="cs-item"><label>成交量</label><b>' + esc(fmtVol(m.volume)) + '</b></div>' +
      '<div class="cs-item"><label>成交额</label><b>' + esc(fmtAmount(m.turnover)) + '</b></div>' +
      '<div class="cs-item"><label title="发行价（开服定价，也是指数基期的分母口径）">发行价</label><b>' +
        (issue > 0 ? esc(fmtP(issue)) : '--') + '</b></div>' +
      '<div class="cs-item"><label title="全部登记在 NPC 名下的可交易股本">流通股本</label><b>' +
        (float > 0 ? esc(fmtVol(float)) : '--') + '</b></div>' +
      '<div class="cs-item"><label title="流通股本 × 现价，随行情实时变化">流通市值</label><b>' +
        esc(fmtCap(capNow)) + '</b></div>' +
      '<div class="cs-item"><label title="现价相对发行价（开服定价）的涨跌幅">较发行价</label><b class="' +
        (vsIssue == null ? '' : cls(vsIssue)) + '">' +
        (vsIssue == null ? '--' : (vsIssue >= 0 ? '+' : '') + esc(vsIssue.toFixed(2)) + '%') + '</b></div>';
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
    // 境界整表只在首屏下发：缓存一份给规则面板（增量帧的 rules.realm 只有 enabled）
    if (s.rules && s.rules.realm && Array.isArray(s.rules.realm.ladder) && s.rules.realm.ladder.length) {
      realmLadder = s.rules.realm;
    }
    // 头像目录同款：整表只在首屏下发，缓存一份给换脸弹层用（增量帧只有 enabled）
    if (s.rules && s.rules.avatar && Array.isArray(s.rules.avatar.groups) && s.rules.avatar.groups.length) {
      avatarCatalog = s.rules.avatar;
    }
    renderRealmChip();
    renderTopAvatar();
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
    renderNotice();
    renderHalt();
    renderDay();
    renderDepth();
    renderTape();
    renderDanmaku(s);
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
  // 服务端对冻结段（集合竞价 / 午休 / 夜间）只补阶段起点一个锚点、不逐 tick 打点，
  // 但客户端自己逐帧累积的点并不知道阶段：这几段里价格一动不动，照抄就会把线拉成
  // 一条越来越长的水平直线——价没动、线在动，x 轴跟着最新点一路右移，整张图都在"走"，
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
    // 公司徽记：没有档案或档案没配 logo（指数）时隐藏 logo 位
    const lore = window.COMPANY_LORE && window.COMPANY_LORE[m.stockId];
    const sl = $('stockLogo');
    if (sl) {
      sl.hidden = !(lore && lore.logo);
      if (lore && lore.logo && sl.getAttribute('src') !== lore.logo) sl.src = lore.logo;
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
    // 市值：个股是流通市值（流通股 × 现价），指数是成分股合计的总市值。
    // 老服务端没有 marketCap 时保持 --（不拿 volume 之类瞎凑）
    $('stCapLabel').textContent = m.isIndex ? '总市值' : '流通市值';
    $('stCap').textContent = m.marketCap == null ? '--' : fmtCap(m.marketCap);
    $('stCap').title = m.isIndex
      ? '全部成分股流通市值合计（成分股现价 × 流通股）'
      : `流通股 ${fmtVol(m.floatShares)} × 现价 ${fmtP(m.last)}` +
        (m.initPrice ? `；发行价 ${fmtP(m.initPrice)}，发行市值 ${fmtCap(m.issueCap)}` : '');
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
    // 「当日 / 5 日」只对分时有效，K 线模式整块隐藏（K 线本来就是按期一根一根的）；
    // 缩放/平移按钮反过来——只在 K 线模式出现（分时是连续曲线，没有「根数」可缩放）
    const ranges = $('chartRanges');
    if (ranges) {
      ranges.hidden = isKline();
      ranges.querySelectorAll('.chart-mode').forEach((b) => {
        b.classList.toggle('on', b.dataset.range === minuteRange);
      });
    }
    const zoomBox = $('chartZoom');
    if (zoomBox) zoomBox.hidden = !isKline();
    // 弹幕层跟着模式走：K 线没有「今天几点」，飘字没有落点（方案 §2.4）
    refreshDanmakuChrome();
    const m = curMarket() || {};
    const sub = $('chartSub');
    if (!sub) return;
    if (isKline()) {
      // 周/月线由日线聚合（周 = 每 N 个交易日、月 = 每 4 周），副标题说清口径
      const label = chartMode === 'week' ? '周线' : chartMode === 'month' ? '月线' : '日线';
      const unit = chartMode === 'week' ? ` · 每 ${weekPer()} 个交易日` : chartMode === 'month' ? ' · 每 4 周' : '';
      sub.textContent = `${m.isIndex ? m.name : ''}${label}${unit} · 蜡烛 + 成交量 + MA5/10/20/30/60/120/250 + MACD(12,26,9)`;
      return;
    }
    const dn = minuteDays();
    // 本局还没跑满 5 天时如实说「连续 N 日」，别写 5 日让玩家找不存在的前几天
    const scope = dn > 1 ? `连续 ${dn} 日` : '当日';
    // 定格期在副标题里说明白，否则玩家会以为分时卡住了（数据是对的：竞价/休市价不动）
    const d = dayInfo();
    const frozen = d && frozenPhaseStart() != null ? ` · ${d.label || '休市'}，分时定格` : '';
    sub.textContent = m.isIndex
      ? `${m.name}分时 · ${scope}${frozen} · 成分股按流通市值加权`
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

  // ---------- 分时图弹幕（Doc/弹幕方案.md · L1 飘屏） ----------
  const DM_ON_KEY = 'gushen_danmaku';
  const DM_SEQ_KEY = 'gushen_dm_seq';
  const DM_MAX_ON_SCREEN = 8;
  // 已渲染到的最大 id。服务端重启 seq 会回退，那时必须重置水位，
  // 否则新弹幕的 id 全都小于它，客户端一条都不播（彩蛋的 gushen_event_seq 出过这个事故）
  let dmSeq = 0;
  let dmOn = true;
  let dmTrack = 0;
  let dmChromeShown = null; // 弹幕层显隐的缓存值：每帧都会算，只有变了才动 DOM
  let dmBeatAt = 0; // 上次观看心跳时刻（60 秒一次）
  /**
   * 表情系列（pack）——「经典」是默认系列，也是目前唯一的一个。
   * 每个表情是 24×24 的双色 SVG：描边 `currentColor`（自动继承说话人身份色：
   * 散户灰 / 游资红 / 大户紫 / 玩家金），内部填一层自己的语义色 `tone`
   * （火橙、涨红、跌绿）——纯灰线在深色终端里太素，全彩 emoji 又会在 12.5px 糊成脏点。
   * `tone` 写死不跟主题走：涨就该是红的，换皮肤也一样。
   *
   * key 必须与 `Server/src/danmaku-emotes.js` 的 KEYS 一致（服务端只下发 key）。
   * 这些 svg 是**本地常量**，没有任何一个字节来自玩家输入——所以 `innerHTML` 在这里
   * 是安全的；玩家的自由文本仍然只能走 textContent（见 spawnDanmaku）。
   *
   * 加新系列：在数组里追加一项，id 与服务端 PACKS 对齐，key 全局唯一（新系列请带前缀，
   * 如 `food:burger`）；系列多于一个时选择器顶部会自动多出一排 tab。
   */
  const DM_EMOTE_PACKS = [
    {
      id: 'classic',
      label: '经典',
      items: {
        cry: {
          label: '哭',
          tone: '#4fa3e3',
          svg: '<circle cx="12" cy="12" r="8.6" fill="#4fa3e3" fill-opacity=".22"/>' +
            '<circle cx="9.2" cy="10.2" r="1.1" fill="#4fa3e3" stroke="none"/>' +
            '<circle cx="14.8" cy="10.2" r="1.1" fill="#4fa3e3" stroke="none"/>' +
            '<path d="M9.2 12.4v2.1M14.8 12.4v2.1" stroke="#4fa3e3" stroke-width="2.6"/>' +
            '<path d="M8.8 17.4c1.4-1.5 4.9-1.5 6.4 0"/>',
        },
        laugh: {
          label: '笑',
          tone: '#f0c14b',
          svg: '<circle cx="12" cy="12" r="8.6" fill="#f0c14b" fill-opacity=".22"/>' +
            '<path d="M7.2 10.2c.7-1.1 2-1.1 2.7 0M14.1 10.2c.7-1.1 2-1.1 2.7 0"/>' +
            '<path d="M8.2 13.6c1.3 2.5 6.3 2.5 7.6 0" fill="#f0c14b" fill-opacity=".55"/>',
        },
        sweat: {
          label: '汗',
          tone: '#4fb3d9',
          svg: '<circle cx="12" cy="12" r="8.6" fill="#4fb3d9" fill-opacity=".16"/>' +
            '<circle cx="9.2" cy="10.6" r="1.1" fill="#4fb3d9" stroke="none"/>' +
            '<circle cx="14.8" cy="10.6" r="1.1" fill="#4fb3d9" stroke="none"/>' +
            '<path d="M9.8 16h4.4"/>' +
            '<path d="M19.4 6.4c.9 1.5 1.5 2.6 1.5 3.3a1.5 1.5 0 0 1-3 0c0-.7.6-1.8 1.5-3.3z" fill="#4fb3d9" fill-opacity=".9"/>',
        },
        rage: {
          label: '怒',
          tone: '#e2563d',
          svg: '<circle cx="12" cy="12" r="8.6" fill="#e2563d" fill-opacity=".22"/>' +
            '<path d="M7 8.2l3.2 1.7M17 8.2l-3.2 1.7"/>' +
            '<circle cx="9.4" cy="12.2" r="1.2" fill="#e2563d" stroke="none"/>' +
            '<circle cx="14.6" cy="12.2" r="1.2" fill="#e2563d" stroke="none"/>' +
            '<path d="M8.8 17.2c1.3-1.5 5.1-1.5 6.4 0"/>',
        },
        shock: {
          label: '惊',
          tone: '#f2d24b',
          svg: '<circle cx="12" cy="12" r="8.6" fill="#f2d24b" fill-opacity=".18"/>' +
            '<circle cx="9.2" cy="10" r="1.7" fill="#f2d24b" fill-opacity=".95"/>' +
            '<circle cx="14.8" cy="10" r="1.7" fill="#f2d24b" fill-opacity=".95"/>' +
            '<circle cx="12" cy="16" r="1.7" fill="#f2d24b" fill-opacity=".9"/>',
        },
        skull: {
          label: '骷髅',
          tone: '#d8dee9',
          svg: '<path d="M12 3.2a7.6 7.6 0 0 0-4.6 13.6V20h9.2v-3.2A7.6 7.6 0 0 0 12 3.2z" fill="#d8dee9" fill-opacity=".2"/>' +
            '<circle cx="9" cy="11" r="1.9" fill="#2a3243" stroke="none"/>' +
            '<circle cx="15" cy="11" r="1.9" fill="#2a3243" stroke="none"/>' +
            '<path d="M10.2 20v-2.2M12 20v-2.2M13.8 20v-2.2"/>',
        },
        rocket: {
          label: '火箭',
          tone: '#ef6c3f',
          svg: '<path d="M12 2.8c3.3 2 5 5.4 5 9v3.4L12 19l-5-3.8V11.8c0-3.6 1.7-7 5-9z" fill="#c9d4e6" fill-opacity=".24"/>' +
            '<circle cx="12" cy="9" r="1.7" fill="#5aa9e6" fill-opacity=".95"/>' +
            '<path d="M7 11.6 4.6 15.2l2.9-.5M17 11.6l2.4 3.6-2.9-.5" fill="#e2563d" fill-opacity=".4"/>' +
            '<path d="M10.4 19.4c.3 1.3.8 2.3 1.6 3.2.8-.9 1.3-1.9 1.6-3.2" fill="#f2a33c" fill-opacity=".95"/>',
        },
        fire: {
          label: '火',
          tone: '#ef6a3a',
          svg: '<path d="M12 2.8c2.8 3.2 4.8 5.8 4.8 9.2a4.8 4.8 0 0 1-9.6 0c0-3.4 2-6 4.8-9.2z" fill="#ef6a3a" fill-opacity=".32"/>' +
            '<path d="M12 11.6c1 1.2 1.6 2.2 1.6 3.2a1.6 1.6 0 0 1-3.2 0c0-1 .6-2 1.6-3.2z" fill="#ffd24a" fill-opacity=".9"/>',
        },
        coin: {
          label: '铜钱',
          tone: '#e8b64a',
          svg: '<circle cx="12" cy="12" r="8.4" fill="#e8b64a" fill-opacity=".3"/>' +
            '<rect x="9.4" y="9.4" width="5.2" height="5.2" rx=".8"/>',
        },
        heartbreak: {
          label: '心碎',
          tone: '#e2566f',
          svg: '<path d="M12 20.4 4.8 13a4.4 4.4 0 0 1 6.2-6.2l1 1 1-1A4.4 4.4 0 0 1 19.2 13z" fill="#e2566f" fill-opacity=".3"/>' +
            '<path d="M13.4 7.6 11.4 11.4h2.8l-1.8 3.6" stroke="#ffd166" stroke-width="2.2"/>',
        },
        leek: {
          label: '韭菜',
          tone: '#7cbf4a',
          svg: '<path d="M12 21V11.4" stroke="#7cbf4a"/>' +
            '<path d="M12 11.4c-3.6 0-5.4-2.6-4.7-6.4 3.2.5 4.7 2.8 4.7 6.4z" fill="#7cbf4a" fill-opacity=".45"/>' +
            '<path d="M12 11.4c3.6 0 5.4-2.6 4.7-6.4-3.2.5-4.7 2.8-4.7 6.4z" fill="#7cbf4a" fill-opacity=".45"/>' +
            '<path d="M12 15.2h.01M12 18h.01"/>' +
            '<path d="M8.8 21h6.4"/>',
        },
        eyes: {
          label: '盯着',
          tone: '#f0c14b',
          svg: '<ellipse cx="7.4" cy="12" rx="3.6" ry="2.7" fill="#f0c14b" fill-opacity=".18"/>' +
            '<ellipse cx="16.6" cy="12" rx="3.6" ry="2.7" fill="#f0c14b" fill-opacity=".18"/>' +
            '<circle cx="7.4" cy="12" r="1.35" fill="#f0c14b" stroke="none"/>' +
            '<circle cx="16.6" cy="12" r="1.35" fill="#f0c14b" stroke="none"/>',
        },
        zzz: {
          label: '睡着',
          tone: '#8db3d9',
          svg: '<path d="M4 14.4h4.6L4 18.8h4.6" stroke="#8db3d9"/>' +
            '<path d="M9.8 8h4L9.8 11.8h4" stroke="#8db3d9"/>' +
            '<path d="M15.2 2.2h3.4L15.2 5.6h3.4" stroke="#8db3d9" stroke-opacity=".55"/>',
        },
        question: {
          label: '问号',
          tone: '#e8b64a',
          svg: '<path d="M8.4 9.2a3.7 3.7 0 1 1 5.3 3.4c-1 .4-1.7 1.2-1.7 2.4v.6" stroke="#e8b64a"/>' +
            '<circle cx="12" cy="19.4" r="1.25" fill="#e8b64a" stroke="none"/>',
        },
        chartup: {
          label: '涨',
          tone: '#f0464b',
          svg: '<path d="M3.4 17.4 9 11.4l3.4 3 6.2-6.8" stroke="#f0464b" stroke-width="2.2"/>' +
            '<path d="M14.8 6.2h5v5z" fill="#f0464b" fill-opacity=".9" stroke="none"/>',
        },
        chartdown: {
          label: '跌',
          tone: '#1fb978',
          svg: '<path d="M3.4 6.6 9 12.6l3.4-3 6.2 6.8" stroke="#1fb978" stroke-width="2.2"/>' +
            '<path d="M14.8 17.8h5v-5z" fill="#1fb978" fill-opacity=".9" stroke="none"/>',
        },
        thumbup: {
          label: '赞',
          tone: '#e8b64a',
          svg: '<path d="M7.4 10.8v9.8"/>' +
            '<path d="M7.4 20.6H5.4a1.6 1.6 0 0 1-1.6-1.6v-6.6a1.6 1.6 0 0 1 1.6-1.6h2" fill="#e8b64a" fill-opacity=".24"/>' +
            '<path d="M7.4 10.8 10.5 3.6a2.3 2.3 0 0 1 2.4 2.7l-.6 2.9h4.4a1.7 1.7 0 0 1 1.65 2.1l-1.45 5.9a1.7 1.7 0 0 1-1.65 1.3H7.4" fill="#e8b64a" fill-opacity=".24"/>',
        },
        face: {
          label: '平静',
          tone: '#93a1b5',
          svg: '<circle cx="12" cy="12" r="8.6" fill="#93a1b5" fill-opacity=".14"/>' +
            '<circle cx="9.2" cy="10.2" r="1.1" fill="#93a1b5" stroke="none"/>' +
            '<circle cx="14.8" cy="10.2" r="1.1" fill="#93a1b5" stroke="none"/>' +
            '<path d="M9 15.4c1.6 1.3 4.4 1.3 6 0"/>',
        },
  
      },
    },
  ];
  const DM_DEFAULT_PACK = 'classic';
  const DM_PACK_KEY = 'gushen_dm_pack';
  let dmEmotePick = ''; // 当前选中的表情 key（空 = 不带）
  // 选择器当前停在哪一页。记住它属于操作习惯：常翻的那一页不该每次重开都跳回第一页
  let dmPack = DM_DEFAULT_PACK;
  try {
    const savedPack = localStorage.getItem(DM_PACK_KEY);
    if (savedPack && DM_EMOTE_PACKS.some((p) => p.id === savedPack)) dmPack = savedPack;
  } catch (e) { /* 忽略 */ }

  /** 按 id 找系列；找不到（版本回退 / 手改 localStorage）就退回默认系列 */
  function dmPackOf(id) {
    return DM_EMOTE_PACKS.find((p) => p.id === id) || DM_EMOTE_PACKS[0];
  }

  /**
   * key → 表情定义，**跨系列查**：玩家选中的表情属于哪个系列都认得，
   * 翻到别的系列也不会把已经选好的表情弄丢（key 全局唯一，协议里只有 key）
   */
  function dmEmoteDef(key) {
    if (!key) return null;
    for (const p of DM_EMOTE_PACKS) {
      if (p.items[key]) return p.items[key];
    }
    return null;
  }

  /** 全部系列的 key：服务端白名单必须被它覆盖（测试对着比，少一个就红） */
  function dmEmoteKeys() {
    const out = [];
    for (const p of DM_EMOTE_PACKS) for (const k of Object.keys(p.items)) out.push(k);
    return out;
  }

  function setDmPack(id) {
    dmPack = dmPackOf(id).id;
    try { localStorage.setItem(DM_PACK_KEY, dmPack); } catch (e) { /* 忽略 */ }
    if (dmPad) {
      // 选中态写在 HTML 里（dmEmotePadHtml 按 dmEmotePick 拼 .on），重建后不用再补标一遍
      dmPad.innerHTML = dmEmotePadHtml();
      paintEmotePad();
    }
    positionEmotePad();
  }
  try { dmOn = localStorage.getItem(DM_ON_KEY) !== '0'; } catch (e) { /* 忽略 */ }
  // 水位落盘：刷新页面时不能把最近 5 秒已经播过的弹幕再播一遍
  try { dmSeq = Number(localStorage.getItem(DM_SEQ_KEY)) || 0; } catch (e) { dmSeq = 0; }

  /** 换账号时清水位（setIdentity 调用）：新账号不该被上一个账号的 id 挡住 */
  function resetDanmakuStream() {
    dmSeq = 0;
    try { localStorage.removeItem(DM_SEQ_KEY); } catch (e) { /* 忽略 */ }
  }

  /** 弹幕只出现在「交易终端 · 分时」：K 线没有「今天几点」，主页那块也太小（方案 §2.4） */
  function dmVisible() {
    return dmOn && activeView === 'trade' && !isKline();
  }

  function setDanmakuOn(on) {
    dmOn = !!on;
    try { localStorage.setItem(DM_ON_KEY, dmOn ? '1' : '0'); } catch (e) { /* 忽略 */ }
    dmChromeShown = null; // 强制刷新一次显隐
    refreshDanmakuChrome();
  }

  /**
   * 弹幕层与标题栏输入条的显隐。三处会让它变：开关、图表模式（分时/K 线）、
   * 当前标的（个股/指数）。每帧调一次，但状态没变时不动 DOM。
   */
  function refreshDanmakuChrome() {
    const show = dmVisible();
    if (show !== dmChromeShown) {
      dmChromeShown = show;
      const layer = $('danmakuLayer');
      if (layer) {
        layer.classList.toggle('off', !show);
        if (!show) layer.textContent = ''; // 不显示时把还在飞的收掉，别留在屏上
      }
    }
    const bar = $('dmBar');
    if (bar) {
      // 输入条只在「交易终端 · 个股」出现：K 线下不显示弹幕，指数也不生成弹幕
      const m = curMarket() || {};
      bar.hidden = activeView !== 'trade' || !!m.isIndex;
      // 输入条收起来了，表情面板不能还在屏上飘着（它是 fixed 定位，挂在 body 上）
      if (bar.hidden && dmPad && !dmPad.hidden) toggleEmotePad(false);
    }
    const eye = $('dmEye');
    if (eye) {
      eye.classList.toggle('on', dmOn);
      eye.title = dmOn ? '隐藏弹幕' : '显示弹幕';
    }
  }

  /** 十字光标激活时把弹幕压暗：读数优先（方案 §6.4） */
  function dimDanmaku(on) {
    const layer = $('danmakuLayer');
    if (layer) layer.classList.toggle('dim', !!on);
  }

  /**
   * 观看心跳：`/api/history` 一只票只拉一次，而服务端 watcher 的 TTL 是 5 分钟。
   * 没有这个心跳，玩家盯同一只票超过 5 分钟后它就不再生成弹幕（方案 §3.4）。
   */
  function danmakuHeartbeat() {
    const now = Date.now();
    if (now - dmBeatAt < 60000) return;
    if (activeView !== 'trade' || isKline() || !activeStockId) return;
    const m = curMarket() || {};
    if (m.isIndex) return; // 指数不生成弹幕，不浪费请求
    dmBeatAt = now;
    apiGet('/api/danmaku/watch?stock=' + encodeURIComponent(activeStockId)).catch(() => {
      dmBeatAt = 0; // 失败了下轮再补
    });
  }

  /** 每帧处理一次增量：只播 id > dmSeq 的，且只播当前这只股票的 */
  function renderDanmaku(s) {
    const d = s && s.danmaku;
    if (!d) return;
    // 服务端重启 / 换存档：seq 归零，本地水位必须跟着归零，否则新弹幕一条都不播
    if (d.seq > 0 && d.seq < dmSeq) dmSeq = 0;
    const items = d.items || [];
    let moved = false;
    for (const it of items) {
      if (!it || typeof it.id !== 'number' || it.id <= dmSeq) continue;
      dmSeq = it.id; // 即使不播也要推进水位，否则切回来会重播旧弹幕
      moved = true;
      if (!dmVisible()) continue;
      if (it.stockId !== activeStockId) continue;
      spawnDanmaku(it);
    }
    if (moved) {
      try { localStorage.setItem(DM_SEQ_KEY, String(dmSeq)); } catch (e) { /* 忽略 */ }
    }
  }

  /**
   * 把表情 key 变成一个 span。key 不在表里就返回 null（服务端版本比客户端新时，
   * 宁可少一个表情，也不能让整条弹幕挂掉）。
   */
  function dmEmoteNode(key) {
    const def = dmEmoteDef(key);
    if (!def) return null;
    const sp = document.createElement('span');
    sp.className = 'dm-emote';
    sp.title = def.label;
    sp.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + def.svg + '</svg>';
    return sp;
  }

  function spawnDanmaku(it) {
    const layer = $('danmakuLayer');
    if (!layer) return;
    const el = document.createElement('div');
    let cls = 'dm-item dm-' + (it.type || 'mid');
    if (it.flag === 'playerB') cls += ' dm-pb';
    if (it.kind === 'event') cls += ' dm-event';
    el.className = cls;
    // textContent 而不是 innerHTML：玩家弹幕是自由文本，拼 HTML 就是自找注入
    el.textContent = it.kind === 'player' && it.from ? it.from + '：' + it.text : it.text;
    // 表情单独挂一个 span：图形只来自上面的本地表，玩家能影响的只有 key 在不在表里
    const emote = dmEmoteNode(it.emote);
    if (emote && el.appendChild) el.appendChild(emote);
    // 4 条固定泳道，高度不够就少开几条，避免两条叠在一起
    const tracks = Math.max(1, Math.min(4, Math.floor((layer.clientHeight || 88) / 22)));
    el.style.top = ((dmTrack++ % tracks) * 22 + 2) + 'px';
    // 先挂上去（但不跑动画）再量宽度：位移必须按容器宽度算。写死 1400px 的话，
    // 大屏上字会在飞到左边缘之前就停住、然后整条消失，而且速度随屏宽忽快忽慢
    el.style.animation = 'none';
    layer.appendChild(el);
    const boxW = layer.clientWidth || 600;
    const dist = Math.round(boxW + (el.offsetWidth || 160) + 8);
    // 匀速 70px/s（窄屏 60）；玩家行为反应再慢一点（×0.78），让他来得及反应「这条在说我」
    const speed = (boxW < 520 ? 60 : 70) * (it.flag === 'playerB' ? 0.78 : 1);
    el.style.setProperty('--dm-dist', '-' + dist + 'px');
    el.style.animation = ''; // 恢复 CSS 的 animation-name，从这一刻开始飞
    el.style.animationDuration = (dist / speed).toFixed(2) + 's';
    // 屏上最多 8 条：超了立刻收最旧的，不等它飞完（否则密集时会盖成一片）
    while (layer.children.length > DM_MAX_ON_SCREEN) layer.removeChild(layer.firstElementChild);
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  // ---------- 表情选择器 ----------
  // 面板挂在 body 上而不是 .dm-bar 里：.panel 是 overflow:hidden，从标题栏往下弹会被裁掉
  let dmPad = null;

  function dmEmotePadHtml() {
    const pack = dmPackOf(dmPack);
    // 只有一个系列时不画 tab 行——一个 tab 的 tab 栏纯属噪音。
    // 加第二个系列后这里会自动出现，不用再改代码
    const tabs = DM_EMOTE_PACKS.length > 1
      ? '<div class="dm-emo-tabs">' + DM_EMOTE_PACKS.map((p) =>
        `<button type="button" class="dm-emo-tab${p.id === pack.id ? ' on' : ''}" ` +
        `data-pack="${p.id}">${p.label}</button>`).join('') + '</div>'
      : '';
    // 选中态与配色都**不能**写进这里的 HTML：
    // ① 选中态直接拼 class（重建面板后依然亮着，切回原系列不会丢）；
    // ② 配色一律交给 paintEmotePad() 用 CSSOM 写 —— CSP 是 `style-src 'self'`，
    //    innerHTML 里的 `style="color:…"` 会被浏览器拦掉（控制台报 "Applying inline style
    //    violates…"），整个面板会退成一排同色的灰线（预览页是 file://、没有 CSP，
    //    所以看不出来——这正是当初埋下这个坑的原因）
    const grid = Object.keys(pack.items)
      .map((k) => `<button type="button" data-emo="${k}" title="${pack.items[k].label}"` +
        `${k === dmEmotePick ? ' class="on"' : ''}>` +
        `<svg viewBox="0 0 24 24" aria-hidden="true">${pack.items[k].svg}</svg></button>`)
      .join('');
    return tabs + '<div class="dm-emo-grid">' + grid + '</div>';
  }

  /**
   * 给面板里的表情上色 —— 描边色用每个表情自己的 `tone`（飘屏里才用说话人身份色）。
   * 必须走 CSSOM：CSP 只禁内联 style 属性与内联 `<script>`，不拦 `el.style.x = …`
   * （资产构成条的比例条也是这么写的，见 renderHome 里那段注释）
   */
  function paintEmotePad() {
    if (!dmPad || !dmPad.querySelectorAll) return;
    dmPad.querySelectorAll('button[data-emo]').forEach((b) => {
      const def = dmEmoteDef(b.dataset.emo);
      if (def) b.style.color = def.tone;
    });
  }

  /** 按钮本身当「当前选中」的指示灯：没选时显示「表」，选中后直接显示那个表情 */
  function syncEmoteBtn() {
    const btn = $('dmEmoBtn');
    if (!btn) return;
    const def = dmEmoteDef(dmEmotePick);
    btn.classList.toggle('has-pick', !!def);
    btn.title = def ? `已选表情：${def.label}（再点一次取消）` : '加个表情';
    if (def) {
      btn.style.color = def.tone;
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${def.svg}</svg>`;
    } else {
      btn.style.color = '';
      btn.textContent = '表';
    }
  }

  function ensureEmotePad() {
    if (dmPad) return dmPad;
    const pad = document.createElement('div');
    pad.className = 'dm-emo-pad';
    pad.id = 'dmEmoPad';
    pad.hidden = true;
    pad.innerHTML = dmEmotePadHtml();
    pad.addEventListener('click', (ev) => {
      const t = ev.target;
      // 系列 tab：只翻页，不关面板（关掉的话想再翻一页还得重开）
      const tabBtn = t && t.closest ? t.closest('button[data-pack]') : null;
      if (tabBtn) {
        setDmPack(tabBtn.dataset.pack);
        return;
      }
      const b = t && t.closest ? t.closest('button[data-emo]') : null;
      if (!b) return;
      const key = b.dataset.emo;
      dmEmotePick = dmEmotePick === key ? '' : key; // 再点一次 = 取消
      syncEmoteBtn();
      toggleEmotePad(false);
      const input = $('dmInput');
      if (input && input.focus) input.focus();
    });
    (document.body || document.documentElement).appendChild(pad);
    dmPad = pad;
    return pad;
  }

  /**
   * 贴按钮下沿摆放：右边放不下就往左挪，底下放不下就往上翻，绝不顶出窗口。
   * 尺寸必须现量——多系列时面板会多一行 tab，每页条数也可能不同，
   * 照老公式算会让面板一半露在窗口外。
   * 窗口缩放 / 页面滚动时也会重新调这里（面板是 fixed，坐标只算一次就会飘）。
   */
  function positionEmotePad() {
    const pad = dmPad;
    const btn = $('dmEmoBtn');
    if (!pad || pad.hidden) return;
    // 首次定位先挪出视口再量，否则会看见面板在默认位置闪一下。
    // 之后（重算）不能再挪——滚动时每帧都挪到 -9999 会看得见抖动，而 offsetWidth
    // 不依赖位置，元素渲染后随时能量
    if (!pad.style.left) {
      pad.style.left = '0px';
      pad.style.top = '-9999px';
    }
    const w = pad.offsetWidth || (6 * 28 + 5 * 2 + 6 * 2 + 2);
    const h = pad.offsetHeight || (3 * 28 + 2 * 2 + 6 * 2 + 2);
    const rect = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
    // 老浏览器/测试桩的 rect 可能没有 right/bottom，用 left+width 兜一下
    const anchorRight = rect ? (rect.right == null ? (rect.left || 0) + (rect.width || 0) : rect.right) : 0;
    const anchorBottom = rect ? (rect.bottom == null ? (rect.top || 0) + (rect.height || 0) : rect.bottom) : 0;
    const left = rect ? Math.max(8, Math.min(anchorRight - w, vw - w - 8)) : 8;
    // 底下放得下就贴下沿；放不下就**翻到按钮上方**（不是简单夹进视口——
    // 夹住的话面板会盖住「表」按钮本身，想再点一次关掉都点不到）；两边都放不下才夹
    const below = (rect ? anchorBottom + 6 : 60);
    const above = (rect ? (rect.top == null ? anchorBottom - (rect.height || 0) : rect.top) : 60) - h - 6;
    const top = below + h <= vh - 8 ? below : Math.max(8, above);
    pad.style.left = left + 'px';
    pad.style.top = Math.min(top, vh - h - 8) + 'px';
  }

  /**
   * 面板跟着窗口走：缩放（含手机弹出键盘）或页面滚动后重算坐标。
   * 滚动用捕获阶段监听——输入条在图表容器里，滚动的是它，不是 window
   */
  function refitEmotePad() {
    if (!dmPad || dmPad.hidden) return;
    const bar = $('dmBar');
    // 输入条自己都被藏了（切到 K 线 / 指数）就别留一块浮层在屏上
    if (bar && bar.hidden) { toggleEmotePad(false); return; }
    positionEmotePad();
  }

  function toggleEmotePad(open) {
    const pad = ensureEmotePad();
    const btn = $('dmEmoBtn');
    const next = open === undefined ? !!pad.hidden : !!open;
    pad.hidden = !next;
    if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (!next) return;
    // 每次打开都重建一次：系列表/当前页可能在面板关着的时候变过
    // （加新系列、切账号），重建比维护一堆"脏了没"的标记可靠
    pad.innerHTML = dmEmotePadHtml();
    paintEmotePad(); // 配色只能走 CSSOM（CSP 不许内联 style 属性）
    positionEmotePad();
  }

  function bindDanmaku() {
    refreshDanmakuChrome();
    const eye = $('dmEye');
    if (eye) eye.addEventListener('click', () => setDanmakuOn(!dmOn));
    const emo = $('dmEmoBtn');
    if (emo) {
      syncEmoteBtn();
      emo.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation(); // 别被下面那个「点外面关掉」接住
        toggleEmotePad();
      });
    }
    document.addEventListener('click', (ev) => {
      if (!dmPad || dmPad.hidden) return;
      const t = ev && ev.target;
      if (t && (t === emo || (dmPad.contains && dmPad.contains(t)))) return;
      toggleEmotePad(false);
    });
    document.addEventListener('keydown', (ev) => {
      if (ev && ev.key === 'Escape' && dmPad && !dmPad.hidden) toggleEmotePad(false);
    });
    // 面板是 fixed 定位，坐标只在打开那一刻算：窗口缩放（含手机弹键盘）与任何容器滚动
    // 都会让按钮挪位置，不重算的话面板会飘在半空。scroll 用捕获阶段——滚的往往是
    // 图表容器而不是 window
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', refitEmotePad);
      window.addEventListener('scroll', refitEmotePad, true);
    }
    const input = $('dmInput');
    if (!input) return;
    const send = () => {
      const body = (input.value || '').trim();
      if (!body) {
        // 只点了表情、没写字：回车/点发送必须给一句回执，否则看起来像按钮坏了
        if (dmEmotePick) toast('表情要跟着一句话一起发', 'err');
        return;
      }
      const emote = dmEmotePick;
      input.value = '';
      dmEmotePick = '';
      syncEmoteBtn();
      /**
       * 没发出去就把内容还给他：被冷却/敏感词拦下时要改一改再发，重打一遍很烦。
       * 但服务端说「没有这个表情」时不能还——那是客户端留着一个旧版本才有的 key，
       * 还回去的话按钮显示「表」（查不到定义）却每次都带着它发，只能刷新页面才能解开
       */
      const handBack = (msg) => {
        input.value = body;
        dmEmotePick = /没有这个表情/.test(msg || '') ? '' : (emote || '');
        syncEmoteBtn();
        toast(msg || '发送失败', 'err');
      };
      apiPost('/api/danmaku', { stockId: activeStockId, text: body, emote })
        .then((r) => r.json())
        .then((res) => {
          if (res && res.ok) return;
          handBack(res && res.error);
        })
        .catch(() => handBack('发送失败'));
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      send();
    });
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
    mm: '自营',
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
    mm: 'role-mm',
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
    const m = curMarket();
    const sid = (m || {}).stockId;
    const data = holdersData && holdersStockId === sid ? holdersData : null;
    const rows = (data && data.rows) || [];
    const stock = marketList().find((x) => x.stockId === sid);
    const float = (stock && stock.floatShares) || 1;
    const sumQty = rows.reduce((s, h) => s + h.qty, 0);
    // 「我」按**账号**认，不按昵称——昵称可重名、可改，用它比对会认错行
    const myRow = rows.find((h) => h.account === me);
    const snap = data && data.holderSnapshot;
    $('holdersMeta').innerHTML = `
      <div class="item"><label>标的</label><span>${esc((stock && stock.name) || '--')}</span></div>
      <div class="item"><label>流通盘</label><span>${fmtQty(float)} 股</span></div>
      <div class="item"><label>前十大合计</label><span>${data ? ((sumQty / float) * 100).toFixed(2) + '%' : '--'}</span></div>
      <div class="item"><label>我的排名</label><span>${myRow ? '第 ' + (rows.indexOf(myRow) + 1) + ' 名' : '未进前十'}</span></div>
      <div class="item"><label>我的持股</label><span>${myRow ? fmtQty(myRow.qty) + ' 股（' + myRow.pct.toFixed(2) + '%）' : '--'}</span></div>
      <div class="item"><label>上次操作快照</label><span>${
        snap && snap.t
          ? `${fmtTime(snap.t)}（${HOLDER_ACTION_LABEL[snap.action] || snap.action}）· ${snap.count}/${snap.limit} 次`
          : '暂无，登录后自动记录'
      }</span></div>
    `;
    // 空表要分清「还没拉到」和「真的没有」：数据不属于当前股票（在飞 / 防抖间隙 / 失败退避）
    // 都是暂态，说「暂无数据」是撒谎；只有当前股票的响应确实给了空 rows 才是真空表。
    // 指数没有股东榜，单独说明
    const emptyHtml = m && m.isIndex
      ? '<tr><td colspan="7" class="empty">大盘指数没有股东榜，选一只个股查看</td></tr>'
      : data
        ? '<tr><td colspan="7" class="empty">暂无数据</td></tr>'
        : '<tr><td colspan="7" class="empty">' +
          (holdersPending || holdersFails < 2 ? '加载中…' : '加载失败，自动重试中…') +
          '</td></tr>';
    $('holdersBody').innerHTML =
      rows
        .map((h, i) => {
          const mine = h.account === me;
          const roleCls = ROLE_CLS[h.role] || 'role-retail';
          const openCell = `<span class="${cls(h.change)}">${h.change > 0 ? '+' : ''}${fmtQty(h.change)} 股</span><span class="delta-sub ${cls(h.changePct)}">${h.changePct > 0 ? '+' : ''}${h.changePct.toFixed(2)}pp</span>`;
          return `<tr${mine ? ' class="row-mine"' : ''} data-holder="${esc(h.account)}" data-nick="${esc(h.name)}">
            <td>${i + 1}</td>
            <td>${avaHtml(h.ava, 18, h.realm && h.realm.group, h.name)}${esc(h.name)}${mine ? '（我）' : ''}${
              h.realm && h.realm.idx > 0
                ? `<span class="realm-chip sm g-${esc(h.realm.group)}" title="${esc(h.realm.honor || '')}">${esc(h.realm.short || h.realm.name)}</span>`
                : ''
            }</td>
            <td><span class="tag ${roleCls}">${esc(ROLE_LABEL[h.role] || h.role)}${h.ai ? ' · AI' : ''}</span></td>
            <td>${fmtQty(h.qty)}</td>
            <td>${h.pct.toFixed(2)}%</td>
            <td class="delta-cell">${openCell}</td>
            <td class="delta-cell">${deltaCell(h.dQty, h.dPct, !!snap)}</td>
          </tr>`;
        })
        .join('') || emptyHtml;
    // 18px 小头像的裂图兜底同样要挂在这次 innerHTML 之后
    bindAvaFallback($('holdersBody'));
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
    // 大盘指数没有股东榜（服务端必拒），直接不请求，省得白吃限流配额
    if (state && state.index && stockId === state.index.stockId) return;
    const now = Date.now();
    // 失败退避：连续失败（429 限流 / 网络抖动）时把静默窗口逐次拉长（4s → 8s → …上限 20s）。
    // 没有退避的话 tickUI 每 200ms 重发一次，5 发/秒正好把服务端限流桶顶死，永远 429 自锁——
    // 玩家看到的就是股东 tab 一直「暂无数据」。失败后 holdersAt 不动，靠 holdersFails 拉长窗口。
    const quiet = holdersFails ? Math.min(4000 + holdersFails * 4000, 20000) : 4000;
    if (!force && holdersStockId === stockId && now - holdersAt < quiet) return;
    // 最小请求间隔：无论 force 与否不重复发；失败时同样退避（700ms → …上限 5s），
    // 换股后持续失败也不会以固定频率硬顶限流桶
    const minGap = holdersFails ? Math.min(700 + holdersFails * 700, 5000) : 700;
    if (now - holdersTriedAt < minGap) return;
    holdersTriedAt = now;
    holdersPending = true;
    apiGet('/api/holders?stock=' + encodeURIComponent(stockId))
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (!res || !res.ok) {
          holdersFails += 1; // 429 / 400 / 500：退避，tickUI 下轮再试
          return;
        }
        // 期间用户可能已切走，丢弃过期响应（不算失败，不推进退避）
        if (res.stockId !== (curMarket() || {}).stockId) return;
        holdersFails = 0;
        holdersData = res;
        holdersStockId = res.stockId;
        holdersAt = Date.now();
        renderHolders();
      })
      .catch(() => {
        holdersFails += 1; // 网络错误同样退避
      })
      .finally(() => {
        holdersPending = false;
        renderHolders();
      });
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
    // 空头总持仓是**收盘披露口径**：服务端每个交易日收盘结算后刷新一次，日内冻结
    // （`shortInterestDay` = 已披露到第几个交易日，-1 表示还没披露过）
    // 还没披露过时服务端给 `null`（不是 0，也不是实时值）：显示 `—` +「未披露」角标。
    // 老版本服务端不下发 `shortInterestDay`、`shortInterest` 恒为数字，走原样显示
    const shortKnown = L.shortInterest !== null && L.shortInterest !== undefined;
    const shortQty = shortKnown ? L.shortInterest : 0;
    const shortVal = shortKnown
      ? `${fmtQty(shortQty)} 股（${((shortQty / float) * 100).toFixed(2)}%）`
      : '—';
    const shortDayTag = L.shortInterestDay === -1 ? '<span class="sub-code">未披露</span>' : '';
    $('lendingMeta').innerHTML = `
      <div class="item"><label>标的</label><span>${esc(m.name)}</span></div>
      <div class="item"><label>可借券源</label><span>${fmtQty(L.available)} 股</span></div>
      <div class="item"><label>总挂借</label><span>${fmtQty(L.total)} 股</span></div>
      <div class="item"><label>已借出</label><span>${fmtQty(L.borrowed)} 股</span></div>
      <div class="item"><label title="每个交易日收盘结算后披露一次，日内不随成交变化（真实市场的融券余额也是盘后披露）">空头总持仓</label><span>${shortVal}${shortDayTag}</span></div>
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

  /** 空头仓位变化：一个交易日一点的日频折线（收盘披露，日内不更新） */
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
      ctx.fillText(
        hist && hist.length === 1
          ? '已披露 1 个交易日（每交易日收盘一点）'
          : '暂无披露记录（每个交易日收盘更新）',
        W / 2,
        H / 2
      );
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

    // 轴标：x 走**交易日号**（游戏日被压缩到几分钟，墙钟时间读不出"第几天"）
    ctx.fillStyle = withA(themeC.ink, .4);
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fmtQty(hi), pad.l - 4, pad.t + 8);
    ctx.fillText(fmtQty(lo), pad.l - 4, pad.t + ih);
    const dayLabel = (p) => {
      if (p.day != null) return `第 ${p.day} 日`;
      const d = new Date(p.t);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    };
    ctx.textAlign = 'left';
    ctx.fillText(dayLabel(hist[0]), pad.l, H - 6);
    ctx.textAlign = 'right';
    ctx.fillText(dayLabel(hist[hist.length - 1]), W - pad.r, H - 6);
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
        // 「按账号取数」：按钮带上账号而不是昵称——昵称可重名、可随时改。
        // 但 data-account 只做取数键，**不上屏**：榜上对外只露昵称。
        const nick = p.name || '匿名玩家';
        const act = p.account
          ? `<td class="rank-act-cell"><button class="mini-btn rank-pos-btn" type="button"
               data-account="${esc(p.account)}" data-nick="${esc(nick)}">持仓</button></td>`
          : '<td class="rank-act-cell"></td>';
        // 境界只作**附加展示**：不参与排序（排序键永远是权益），也不改行的宽度口径
        const realmTag =
          p.realm && p.realm.idx > 0
            ? `<span class="realm-chip sm g-${esc(p.realm.group)}" title="${esc(p.realm.honor || '')}">${esc(p.realm.short || p.realm.name)}</span>`
            : '';
        // 前三给奖牌徽章 + 行高亮（纯展示，不动排序口径）
        const topCls = i < 3 ? ` rank-top rank-top-${i + 1}` : '';
        const noCell =
          i < 3
            ? `<span class="rank-medal rm${i + 1}" title="第 ${i + 1} 名">${i + 1}</span>`
            : String(i + 1);
        return `<tr class="${topCls.trim()}${mine ? ' row-mine' : ''}">
          <td>${noCell}</td>
          <td><span class="rank-player"><span class="rank-nick">${avaHtml(p.ava, 22, p.realm && p.realm.group, nick)}<span class="rank-nick-text">${esc(nick)}${mine ? '（我）' : ''}</span></span><span class="rank-tags">${tag}${realmTag}</span></span></td>
          <td class="${cls(p.equity - state.rules.initialCash)}">${fmtMoney(p.equity)}</td>
          ${act}
        </tr>`;
      })
      .join('');
  }

  function renderRank() {
    $('rankBody').innerHTML = rankRowsHtml() || '<tr><td colspan="4" class="empty">暂无玩家</td></tr>';
    // 榜单每 700ms 整块重写：裂图兜底得在写完之后重新挂一次（新节点没有监听器）
    bindAvaFallback($('rankBody'));
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
    // 标题只用昵称：账号是取数键，不上屏
    $('rankPosTitle').textContent = (nick || '玩家') + ' · 持仓';
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
    // 弹窗只露昵称与券商：账号属于登录凭据，不进任何对外画面
    $('rankPosSub').innerHTML = `${esc(sub)} · 总权益
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
  const HOME_RANK_LIMIT = 10;
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
        <div class="mcell"><label>总市值</label><span>${fmtCap(idx.marketCap)}</span></div>
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
        '<div class="rule-cell"><b>指数看得见，摸不着</b><span>「' + esc(state.index ? state.index.name : '全村希望') + '」由十只股票加权合成，只做参照，不能下单。</span></div>' +
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

  /**
   * 修仙境界（Doc/头衔方案.md §6.3）：整表吃服务端下发的 `rules.realm`，
   * 前端**一个门槛数字都不写死**（与交易日六段表、券商对照表同一条规矩）。
   * 整表只在首屏下发，缓存在 `realmLadder`（增量帧的 rules 会被整份替换掉）。
   */
  function rulesRealmHtml() {
    const t = realmLadder;
    const cur = state && state.account && state.account.realm;
    if (!t || !Array.isArray(t.ladder) || !t.ladder.length) {
      return '<div class="rule-lead">境界表还没拉到（首屏才下发整表）——刷新页面即可。</div>';
    }
    const honorOf = {};
    for (const g of t.groups || []) honorOf[g.key] = g.honor;
    // 说明文字里的 3% / 3 档 / 加钱上限全部吃服务端下发值：
    // 写死的话改了 `config.realm.demoteBuffer`，规则页就开始说谎
    const bufPct = Math.round((Number.isFinite(t.demoteBuffer) ? t.demoteBuffer : 0.03) * 100);
    const maxDrop = Number.isFinite(t.demoteMaxPerDay) ? t.demoteMaxPerDay : 3;
    const capText = Number.isFinite(t.depositCap)
      ? `加钱终身上限 ${fmtAmount(t.depositCap)}${t.depositCapTier ? ' = ' + esc(t.depositCapTier) : ''}。再往上，只能靠交易赚。`
      : '加钱有终身上限。再往上，只能靠交易赚。';
    const rows = [];
    const first = t.ladder[0] ? t.ladder[0].equity : 0;
    rows.push([
      '<b>凡骨</b>',
      '凡骨',
      '&lt; ' + fmtAmount(first),
      cur && cur.idx === 0 ? '<b>你在这里</b>' : '',
    ]);
    for (const tier of t.ladder) {
      const here = cur && cur.idx === tier.i;
      rows.push([
        here ? '<b>' + esc(tier.name) + '</b>' : esc(tier.name),
        esc(honorOf[tier.group] || ''),
        '<span class="rule-num">' + fmtAmount(tier.equity) + '</span>',
        here ? '<b>你在这里</b>' : '',
      ]);
    }
    return (
      '<div class="rule-lead">境界只看<b>收盘权益</b>，与门派（券商）完全无关：转户不掉境，' +
        '也不会因为境界高就给你更好的费率。<b>零数值特权，只有排面</b>。</div>' +
      '<div class="rule-grid">' +
        '<div class="rule-cell"><b>什么时候判</b><span>只在<b>收盘结算</b>那一刻判一次。盘中越过门槛只给徽标加一圈光晕，不提前宣布。</span></div>' +
        `<div class="rule-cell"><b>跌境很慢</b><span>要跌破门槛 <b>${bufPct}%</b> 才确认（防止门槛上横盘来回播），且<b>单日最多降 ${maxDrop} 档</b>。</span></div>` +
        '<div class="rule-cell"><b>名号不跌</b><span>跌境后「历史最高」永久留在主页卡上——修为可以跌，履历不会。</span></div>' +
        `<div class="rule-cell"><b>钱有尽头</b><span>${capText}</span></div>` +
      '</div>' +
      ruleTable(['境界', '尊号', '收盘权益门槛', ''], rows)
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
      key: 'realm',
      label: '境界',
      html: rulesRealmHtml,
      when: (S) => !!(S && S.rules && S.rules.realm && S.rules.realm.enabled),
    },
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

  // ---------- 安卓 App 下载 ----------
  // 包是打包脚本产出的静态文件（不是游戏数据），/api/app/info 只回答「有没有 / 多大 / 什么版本」。
  // 登录页与主页两个入口共用这一个弹层，所以探测结果缓存一次就够（appDlLoaded）。
  let appDlLoaded = false;

  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
    if (v >= 1024) return Math.round(v / 1024) + ' KB';
    return v + ' B';
  }

  function fmtDay(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '--';
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function loadAppDownload(force) {
    const meta = $('appDlMeta');
    const btn = $('appDlDownload');
    if (!meta || !btn) return;
    if (appDlLoaded && !force) return;
    meta.textContent = '正在检查安装包…';
    btn.hidden = true;
    try {
      const res = await apiGet('/api/app/info');
      const info = await res.json();
      appDlLoaded = true;
      if (!info || !info.available) {
        // 没包不算错误：刚克隆下来的仓库本来就没有 output/，说清楚就行
        meta.textContent = '服务器上还没有可下载的安装包，先用网页版吧。';
        return;
      }
      meta.innerHTML = `版本 <b>v${esc(info.version || '?')}</b> · ${esc(fmtBytes(info.size))}`
        + `<br>更新于 ${esc(fmtDay(info.updatedAt))}`;
      // 带版本号查询串：换了包之后浏览器不会拿上一版缓存
      btn.href = `${info.url}?v=${encodeURIComponent(info.version || '')}`;
      btn.hidden = false;
    } catch (e) {
      appDlLoaded = false;
      meta.textContent = '检查失败，看看网络，或者等一下再点一次。';
    }
  }

  function openAppDownload() {
    $('appDlOverlay').classList.remove('hidden');
    loadAppDownload(false);
  }

  function closeAppDownload() {
    $('appDlOverlay').classList.add('hidden');
  }

  function bindAppDownload() {
    const entry = $('appDlBtn');
    if (entry) entry.addEventListener('click', openAppDownload);
    const homeEntry = $('downloadAppBtn');
    if (homeEntry) homeEntry.addEventListener('click', openAppDownload);
    $('appDlCloseBtn').addEventListener('click', closeAppDownload);
    // 点遮罩空白处关闭（点卡片本身不关）
    $('appDlOverlay').addEventListener('click', (e) => {
      if (e.target === $('appDlOverlay')) closeAppDownload();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('appDlOverlay').classList.contains('hidden')) closeAppDownload();
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
    let cap = 0;
    for (const m of markets) {
      if (m.change > 0) up += 1;
      else if (m.change < 0) down += 1;
      else flat += 1;
      turnover += m.turnover || 0;
      volume += m.volume || 0;
      cap += m.marketCap || 0;
    }
    $('homeMarketStats').innerHTML = `
      <div class="mcell"><label>上市股票</label><span>${markets.length}</span></div>
      <div class="mcell"><label>上涨</label><span class="up">${up}</span></div>
      <div class="mcell"><label>下跌</label><span class="down">${down}</span></div>
      <div class="mcell"><label>平盘</label><span>${flat}</span></div>
    `;
    $('homeMarketSub').innerHTML =
      `总市值 <b>${fmtCap(cap)}</b> · 总成交额 <b>${fmtAmount(turnover)}</b> · 总成交量 <b>${fmtVol(volume)}</b><br>` +
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
            <td class="q-cap" title="成分股总流通市值">${fmtCap(idx.marketCap)}</td>
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
            <td class="q-cap" title="流通股 ${fmtVol(m.floatShares)} × 现价 ${fmtP(m.last)}">${fmtCap(m.marketCap)}</td>
            <td>${fmtVol(m.volume)}</td>
            <td>${fmtAmount(m.turnover)}</td>
            <td class="q-act">交易</td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="10" class="empty">暂无行情</td></tr>');

    const initialCash = state.rules.initialCash || 0;
    const retPct = initialCash > 0 ? ((a.equity - initialCash) / initialCash) * 100 : 0;
    const mixTotal = (a.cash || 0) + (a.longValue || 0) + (a.shortMargin || 0);
    const mixPct = (v) => (mixTotal > 0 ? (v / mixTotal) * 100 : 0);
    const mixSegs = [
      { label: '可用资金', value: a.cash || 0, tone: 'cash' },
      { label: '持仓市值', value: a.longValue || 0, tone: 'long' },
      { label: '空头保证金', value: a.shortMargin || 0, tone: 'short' },
    ].filter((s) => s.value > 0.005);
    // 配色与比例**都不许写成内联 style**：CSP 是 style-src 'self'，innerHTML 里带
    // `style="..."` 的节点会被浏览器整条丢弃（控制台报 "Applying inline style violates…"），
    // 资产构成条以前就是这样一直没上色。颜色走 .tone-* class，比例插入后用 CSSOM 写 flex。
    const mixBar = mixSegs.length
      ? mixSegs.map((s) => `<i class="mix-seg tone-${s.tone}" data-mix="${s.value}"></i>`).join('')
      : '<i class="mix-seg tone-empty"></i>';
    const mixLegend = mixSegs.map((s) => `
      <div class="mix-item">
        <i class="tone-${s.tone}"></i>
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
    // 段宽 = 该段占「现金 + 持仓市值 + 空头保证金」的比例（flex-grow 百分比，basis 0）。
    // 走 CSSOM（和进度条同一套写法）：CSP 拦的是 HTML 里的 style 属性，不拦 CSSOM
    $('homeAssets').querySelectorAll('.mix-bar .mix-seg').forEach((el) => {
      const v = Number(el.dataset.mix);
      if (v > 0) el.style.flexGrow = mixPct(v).toFixed(2);
    });

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

  /** 游戏内时刻 → 'HH:MM'：分时图的时间刻度只要到分钟（秒在这一层挤成一团） */
  function fmtHM(ms) {
    return fmtClockMs(ms).slice(0, 5);
  }

  /**
   * 把**任意**时间戳映射回游戏内交易时刻 `{ day, ms }`（ms 自 00:00 起）；没有交易日时钟返回 null。
   *
   * 分时图的横轴是墙钟（点的 t 就是服务端 tick 的时刻），可玩家要读的是「09:30 / 11:30 / 13:00」
   * 这层游戏内时间——就是顶栏时钟显示的那个。不能拿**当前阶段**的压缩比整条轴外推：各阶段
   * 压缩比差一个量级（上午 230s→120min、午休 40s→90min、夜间 40s→1095min），外推会把前面的
   * 刻度全算歪。这里按服务端下发的阶段表（`day.phases`）**逐阶段**线性插值——与
   * daycycle.js 的 `gameClock()` 同一套算法，只是反过来查；天号按 dayStartAt 回推（每天等长），
   * 5 日视图因此不会串日。
   */
  function gameClockAt(t) {
    const d = dayInfo();
    if (!d || !Array.isArray(d.phases) || !d.phases.length || !Number.isFinite(t)) return null;
    const dayMs = Number(d.dayEndsAt) - Number(d.dayStartAt);
    if (!(dayMs > 0)) return null;
    // 先落到「第几天 + 当天进度」（t 早于今天时 offset 为负，floor 仍然给出 0 ≤ rest < dayMs）
    const dayOffset = Math.floor((t - d.dayStartAt) / dayMs);
    const rest = t - d.dayStartAt - dayOffset * dayMs;
    let acc = 0;
    for (let i = 0; i < d.phases.length; i++) {
      const p = d.phases[i];
      const ms = Number(p.ms) || 0;
      const last = i === d.phases.length - 1;
      if (rest < acc + ms || last) {
        const frac = ms > 0 ? Math.max(0, Math.min(1, (rest - acc) / ms)) : 0;
        const v = (Number(p.g) + frac * (Number(p.gm) || ms)) % 86400000;
        return { day: (Number(d.day) || 1) + dayOffset, ms: (v + 86400000) % 86400000 };
      }
      acc += ms;
    }
    return null;
  }

  // ---------- 分时横轴：休市与开盘竞价压成 0 宽 ----------
  //
  // 墙钟横轴会把「根本没有行情的时间」照样铺开：午休只有 40 秒墙钟，却要在一天里
  // 占掉 6% 的宽度，而这几段只留一个定格锚点（见上面「分时定格」），于是 11:30 到
  // 13:00 之间被拉出一条又长又平的横线——看着像停牌、又像行情卡住了。
  //
  // 这里把横轴换成**连续竞价时间轴**：每个阶段按它映射的真实交易时长（phases[].gm）
  // 占宽，休市（午休 / 夜间）与开盘集合竞价占 0 宽。于是 11:30 与 13:00 落在同一个 x 上，
  // 曲线原地接续，中间既没有空档也没有横线；开盘竞价同理塌在轴头，第一笔连续竞价
  // 直接从最左边画起。轴坐标 = 天序号 × 一天的有效宽度 + 当天进度，天与天首尾相接
  // （收盘价直接连次日开盘价，隔夜跳空就是一根竖线），与真实行情软件的「N 日分时」同口径。
  //
  // 没有阶段表（老服务端 / 没接交易日时钟）时 axisAt() 返回 null，
  // axisCoord() 退化成墙钟——与引入压缩之前逐位一致。

  /** 不占横轴宽度的阶段：开盘集合竞价（只定价不连续成交）与休市（午休 / 夜间） */
  const AXIS_ZERO_PHASES = new Set(['auction', 'lunch', 'night']);

  /** 该阶段在横轴上占的宽度（毫秒 · 游戏内交易时间）；休市与开盘竞价 = 0 */
  function axisPhaseWidth(p) {
    return AXIS_ZERO_PHASES.has(p && p.key) ? 0 : Math.max(0, Number(p && p.gm) || 0);
  }

  /** 一个交易日在横轴上的总宽（= 240 分钟：上午 120 + 下午 117 + 收盘竞价 3） */
  function axisDayWidth(phases) {
    let w = 0;
    for (const p of phases) w += axisPhaseWidth(p);
    return w;
  }

  /**
   * 墙钟 t → 横轴坐标。阶段表缺失 / 不可用时返回 null（调用方退回墙钟）。
   * 与 gameClockAt 同一套「逐阶段定位 + 阶段内线性插值」，只是把每段的宽度换成
   * axisPhaseWidth：休市段宽 0，段内所有时刻都塌到段首那一个坐标上。
   */
  function axisAt(t) {
    const d = dayInfo();
    const phases = d && Array.isArray(d.phases) && d.phases.length ? d.phases : null;
    if (!phases || !Number.isFinite(t)) return null;
    const dayMs = Number(d.dayEndsAt) - Number(d.dayStartAt);
    const dayW = axisDayWidth(phases);
    if (!(dayMs > 0) || !(dayW > 0)) return null;
    // 先落到「第几天 + 当天进度」（t 早于今天时 offset 为负，floor 仍然给出 0 ≤ rest < dayMs）
    const dayOffset = Math.floor((t - d.dayStartAt) / dayMs);
    const rest = t - d.dayStartAt - dayOffset * dayMs;
    let acc = 0; // 墙钟累计
    let aAcc = 0; // 轴坐标累计
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i];
      const ms = Number(p.ms) || 0;
      const w = axisPhaseWidth(p);
      const last = i === phases.length - 1;
      if (rest < acc + ms || last) {
        const frac = ms > 0 ? Math.max(0, Math.min(1, (rest - acc) / ms)) : 0;
        return dayOffset * dayW + aAcc + frac * w;
      }
      acc += ms;
      aAcc += w;
    }
    return null;
  }

  /** 分时图的横轴坐标：有阶段表时压掉休市，没有时就是墙钟本身 */
  function axisCoord(t) {
    const a = axisAt(t);
    return a == null ? t : a;
  }

  /**
   * 横轴坐标 → 游戏内时刻 `{ day, ms, seam }`。
   * seam = 这一点同时是「上一段收盘」和「本段开盘」（午休被压成 0 宽后的那道接缝），
   * 刻度据此写成「11:30/13:00」——玩家一眼看到中间没有行情、也没有空白。
   * atDayEnd = 落在日界（= 前一天收盘 15:00）时按前一天读，否则会被写成「次日 09:30」。
   */
  function clockAtAxis(a, atDayEnd) {
    const d = dayInfo();
    const phases = d && Array.isArray(d.phases) && d.phases.length ? d.phases : null;
    if (!phases || !Number.isFinite(a)) return null;
    const on = phases.filter((p) => axisPhaseWidth(p) > 0);
    if (!on.length) return null;
    const dayW = axisDayWidth(on);
    let dayOffset = Math.floor(a / dayW);
    let rest = a - dayOffset * dayW;
    if (atDayEnd && rest < 1) {
      dayOffset -= 1;
      rest = dayW;
    }
    let aAcc = 0;
    let prevEnd = null; // 上一个占宽阶段的游戏内收盘时刻
    for (let i = 0; i < on.length; i++) {
      const p = on[i];
      const w = axisPhaseWidth(p);
      const g = Number(p.g) || 0;
      const gm = Number(p.gm) || 0;
      const last = i === on.length - 1;
      if (rest < aAcc + w || last) {
        const frac = Math.max(0, Math.min(1, (rest - aAcc) / w));
        // 接缝：正好压在两个占宽阶段之间的那一点（午休 0 宽，11:30 与 13:00 同 x）
        const seam = prevEnd != null && rest - aAcc < 1 && prevEnd !== g ? prevEnd : null;
        return { day: (Number(d.day) || 1) + dayOffset, ms: (g + frac * gm) % 86400000, seam };
      }
      prevEnd = (g + gm) % 86400000;
      aAcc += w;
    }
    return null;
  }

  /**
   * 分时图横轴区间 `{ a0, a1, full }`（轴坐标）。
   *  · full=true（有阶段表，常规）：**固定整天刻度**——当日视图 = 今天 09:30~15:00，
   *    5 日视图 = 最近 5 天，右端永远压在**今天收盘**上。于是刻度从开盘到收盘一目了然，
   *    开盘时曲线只占左边一小段、随时间往右生长，和真实行情软件的分时同口径
   *    （不再像以前那样「贴合已有数据」把 5 分钟撑满全屏、刻度跟着数据跑）。
   *  · full=false（老服务端 / 没接交易日时钟）：算不出全天宽度，退回贴合数据的老口径。
   */
  function minuteDomain(pts) {
    const phases = axisPhases();
    const d = dayInfo();
    if (phases && d && pts.length) {
      const dayW = axisDayWidth(phases);
      const endA = axisCoord(Number(d.dayEndsAt)); // 今天收盘（15:00）＝ 今天轴末端
      if (dayW > 0 && Number.isFinite(endA)) {
        const days = minuteDays();
        return { a0: endA - days * dayW, a1: endA, full: true };
      }
    }
    // 退化口径：只留最近约 2 小时的分时点，域贴合数据（与压缩之前的画法一致）
    const a0 = axisCoord(pts[0].t);
    const aLast = axisCoord(pts[pts.length - 1].t);
    const minSpan = 5 * 60 * 1000;
    const a1 = aLast + Math.max(20 * 1000, Math.max(minSpan - (aLast - a0), (aLast - a0) * 0.08));
    return { a0, a1, full: false };
  }

  /** 横轴刻度的文案：游戏内时刻，接缝写「11:30/13:00」，跨天补「N日」前缀 */
  function axisTimeLabel(a, atDayEnd) {
    const c = clockAtAxis(a, atDayEnd);
    // 没有阶段表：a 就是墙钟（axisCoord 的退化口径），刻度照旧读墙钟
    if (!c) return fmtHM(a);
    // 本局开服之前的天（天号 < 1）根本没有行情：5 日视图在开局不足 5 天时，
    // 左侧那几格会被换算成「0日 / -1日 09:30」这种不存在的日期（天号从 1 开始），
    // 玩家只会以为时间显示错了。这类刻度直接不画（调用方把 null 当"跳过"）。
    if (c.day < 1) return null;
    const d = dayInfo();
    const hm = c.seam != null ? `${fmtHM(c.seam)}/${fmtHM(c.ms)}` : fmtHM(c.ms);
    return d && c.day !== d.day ? `${c.day}日 ${hm}` : hm;
  }

  /** 刻度步长：在 2~480 分钟里挑最小的一档，让一屏落 3~7 根刻度（且总是整分） */
  function axisTickStep(dom) {
    const MIN = 60 * 1000;
    const ladder = [480, 240, 120, 60, 30, 20, 15, 10, 5, 2];
    for (let i = ladder.length - 1; i >= 0; i--) {
      if (dom / (ladder[i] * MIN) <= 6) return ladder[i] * MIN;
    }
    return ladder[0] * MIN;
  }

  /** 当前的阶段表（老服务端 / 没接交易日时钟时为 null） */
  function axisPhases() {
    const d = dayInfo();
    return d && Array.isArray(d.phases) && d.phases.length ? d.phases : null;
  }

  /** 收盘集合竞价在当天轴坐标上的位置（start = 14:57 的轴偏移，width = 3 分钟）；没有该阶段返回 null */
  function axisCloseAuctionSpan() {
    const phases = axisPhases();
    if (!phases) return null;
    let acc = 0;
    let span = null;
    for (const p of phases) {
      if (p && p.key === 'closeAuction') span = { start: acc, width: axisPhaseWidth(p) };
      acc += axisPhaseWidth(p);
    }
    return span && span.width > 0 ? span : null;
  }

  /**
   * 落在轴区间 [lo, hi] 里的「竞价分界」标记，供画图用：
   *   kind='open'  开盘集合竞价的收口点。竞价本身 0 宽（见 axisAt），所以这个点同时是
   *                当天连续竞价的起点——当日视图里它就是左边界，5 日视图里是交易日的分界。
   *   kind='close' 收盘集合竞价的起点（14:57）。这一段有 3 分钟真实宽度，画成淡色带，
   *                玩家能看出「最后三分钟是集中撮合、不是连续竞价」。
   * 没有阶段表时返回空数组，画图那边什么也不加（与引入标记之前逐位一致）。
   */
  function axisAuctionMarks(lo, hi) {
    const phases = axisPhases();
    if (!phases || !Number.isFinite(lo) || !Number.isFinite(hi)) return [];
    const dayW = axisDayWidth(phases);
    if (!(dayW > 0)) return [];
    const ca = axisCloseAuctionSpan();
    const todayNo = Number((dayInfo() || {}).day) || 1;
    const out = [];
    // 只取与 [lo, hi] 真的相交的那些天。lo 可以是**负数**（5 日视图的轴起点在今天之前
    // 第 4 天），所以这里不能夹到 0，否则前四天的分界标记全丢
    const k0 = Math.floor(lo / dayW);
    const k1 = Math.floor((hi - 1) / dayW);
    for (let k = k0; k <= k1; k++) {
      // 本局开服之前的天（天号 < 1）没有行情，分界标记也不该出现——
      // 否则 5 日视图开局就画出「-3日 / -2日」几条空天的金线，看着像时间轴串位
      if (todayNo + k < 1) continue;
      const base = k * dayW;
      // 只留下真的落在 [lo, hi) 里的标记：右端那根（正好压在 hi 上）留给下一次滚动，
      // 否则数据没走到的地方也会冒出一根线
      if (base >= lo && base < hi) out.push({ day: k, kind: 'open', a: base, width: 0 });
      if (ca && base + ca.start >= lo && base + ca.start < hi) {
        out.push({ day: k, kind: 'close', a: base + ca.start, width: ca.width });
      }
    }
    return out;
  }

  /** 分时图的时间文案：游戏内时刻（跨天补「N日」前缀），没有交易日时钟时退回墙钟。
   *  withSec = 十字光标（精确到秒），否则刻度只要 HH:MM */
  function minuteTimeLabel(t, withSec) {
    const g = gameClockAt(t);
    if (!g) return withSec ? fmtTime(t) : fmtTime(t).slice(0, 5);
    const hm = withSec ? fmtClockMs(g.ms) : fmtHM(g.ms);
    const d = dayInfo();
    return d && g.day !== d.day ? `${g.day}日 ${hm}` : hm;
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

  /**
   * 系统公告横幅（运维关服 / 重启前由 server.py 下发）。
   *
   * 横幅常驻到公告过期或撤下——关服通知不是"一闪而过的 toast"，
   * 玩家回来瞄一眼就该知道要停服了；首次出现时再补一条 toast 提醒。
   * 文案一律 textContent 写入（内容来自服务端，不拼 HTML）。
   */
  function renderNotice() {
    const banner = $('noticeBanner');
    const n = state && state.notice;
    if (!n || !n.text) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    // shutdown = 红色停服提示；info = 绿色恢复提示
    banner.className = 'halt-banner sys-notice' + (n.kind === 'shutdown' ? '' : ' ok');
    $('noticeText').textContent = n.text;
    $('noticeTag').textContent = n.kind === 'shutdown' ? '停服' : '公告';
    if (n.id !== lastNoticeId) {
      lastNoticeId = n.id;
      toast(n.text, n.kind === 'shutdown' ? 'err' : 'ok');
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
    // 日线**不再截断**：能缩放到全量 260 根，截断就白拉了（一屏放多少根由 klineView 的
    // count 决定，默认最近 DAY_SHOW_MAX 根）。周/月线本来就要吃全量才能并出足够多的期
    return bars;
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

  /**
   * K 线可视窗口（缩放 / 平移的唯一真源）。
   * 返回 `{ start, end, count, total, offset }`，`start/end` 是**全量 bars 的下标**（end 为开区间），
   * 绘制、十字光标、拖动反解都吃这一份，避免三处各算一套窗口导致错位。
   *
   * 越界一律就地夹回（缩放 / 平移 / 新数据进来都只改 count 与 offset 两个数）：
   * offset 的最大值是 `total - count`，不是 total——右端留不满一屏时再往左滑就没意义了。
   */
  function klineView(bars) {
    const total = bars.length;
    const st = kViews[chartMode] || (kViews[chartMode] = { count: 0, offset: 0 });
    const def = chartMode === 'day' ? Math.min(DAY_SHOW_MAX, total) : total;
    const floor = Math.min(KVIEW_MIN_BARS, total);
    let count = Math.round(st.count) || def;
    count = Math.max(floor, Math.min(count, total));
    let offset = Math.round(st.offset) || 0;
    offset = Math.max(0, Math.min(offset, total - count));
    // 注意：**不把夹过的值写回 st**。st 记的是「玩家想要多少根」，不是「这只股票能给多少根」：
    // 切开到一只只有 30 根日线的股票时 count 被夹到 30，写回的话切回 260 根的股票就只剩 30 根了
    const end = total - offset;
    return { start: end - count, end, count, total, offset, zoomed: count < total || offset > 0 };
  }

  /** 视窗复位：恢复该模式的默认视图（日线最近 120 根、周/月线全量、贴最新一根） */
  function resetKlineView() {
    kViews[chartMode] = { count: 0, offset: 0 };
  }

  /**
   * 缩放：`dir` = +1 缩小（看到更多根）、-1 放大，`mx` 是画布内 x（缩放围绕光标下的那根，
   * 与行情软件一致——否则放大一次，正在看的那段就被推出屏幕了）。
   * 纯计算 + 写 kViews，不负责重绘（调用方决定什么时候画）。
   * @returns {boolean} 是否真的改了窗口
   */
  function zoomKline(bars, dir, mx, W) {
    const total = bars.length;
    if (total < 2) return false;
    const L = dayLayout(W, 800, bars); // H 只影响三带高度，不影响 x 轴
    const plotW = W - L.PAD_L - L.PAD_R;
    if (plotW <= 0) return false;
    const x = Math.max(0, Math.min(plotW, mx - L.PAD_L));
    const floor = Math.min(KVIEW_MIN_BARS, total);
    const next = Math.max(floor, Math.min(total, Math.round(L.count * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP))));
    if (next === L.count) return false;
    // 光标下的「虚拟下标」（可以是小数）：缩放前后必须停在同一个 x 位置
    const vi = L.start + (x / plotW) * L.count;
    const slot = plotW / next;
    let start = Math.round(vi - x / slot);
    start = Math.max(0, Math.min(start, total - next));
    kViews[chartMode] = { count: next, offset: total - next - start };
    return true;
  }

  /** K 线图的几何布局：绘制与十字光标共用一套，避免两处坐标算法跑偏。价格 / 成交量 / MACD 三带。
   *  `view` 不传时按当前模式的视窗现算（klineView），价格/量的取值范围只算**窗口内**的根——
   *  放大到 15 根时，y 轴要贴着这 15 根的振幅，而不是被两年前的一根针拉平。 */
  function dayLayout(W, H, bars, view) {
    const v = view || klineView(bars);
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
    for (let i = v.start; i < v.end; i++) {
      const b = bars[i];
      if (!b) continue;
      lo = Math.min(lo, b.low);
      hi = Math.max(hi, b.high);
      maxVol = Math.max(maxVol, b.volume || 0);
    }
    // 窗口空 / 数据异常时兜一个极小区间，免得 y 轴拿到 Infinity 画出空白
    if (!(hi > lo)) {
      lo = Number.isFinite(lo) ? lo - 0.05 : 0;
      hi = Number.isFinite(hi) ? hi + 0.05 : 1;
    }
    const padP = Math.max((hi - lo) * 0.08, 0.02);
    lo -= padP;
    hi += padP;
    const slot = (W - PAD_L - PAD_R) / Math.max(v.count, 1);
    return {
      W, H, PAD_L, PAD_R, PAD_T, PAD_B, VOL_H, MACD_H, priceH, volTop, macdTop, lo, hi, maxVol, slot,
      start: v.start, end: v.end, count: v.count, total: v.total, offset: v.offset,
      // 蜡烛中心与价格轴映射：i 是**全量 bars 的下标**（与均线/MACD 数组同下标）
      xc: (i) => PAD_L + slot * (i - v.start + 0.5),
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
    // 屏上只有 [L.start, L.end) 这几根（滚轮缩放 / 拖动平移的结果）；
    // 均线、MACD 这些序列仍按全量下标存，所以循环一律从 L.start 起、到 L.end 止
    const lastIdx = L.end - 1;
    const bw = Math.max(1.5, Math.min(L.slot * 0.68, 22));

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

    // 时间刻度（纵线，日线标签用交易日号，周/月线用期号）。
    // 密度按**可见宽度**定：放大到 15 根时 6 条刻度太稀，缩到 260 根时 6 条又太密
    const plotW = W - L.PAD_L - L.PAD_R;
    const ticks = Math.max(2, Math.min(7, L.count, Math.floor(plotW / 72)));
    ctx.textAlign = 'center';
    for (let k = 0; k < ticks; k++) {
      const i = L.start + Math.round(((L.count - 1) * k) / Math.max(1, ticks - 1));
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

    // 蜡烛与成交量柱（只画窗口内的根）
    for (let i = L.start; i < L.end; i++) {
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
      for (let i = L.start; i < L.end; i++) {
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

    // 当期未收盘的标记：只有「贴着最新一根」看的时候才有意义，翻历史时不画
    const last = bars[lastIdx];
    if (last.live && lastIdx === n - 1) {
      ctx.beginPath();
      ctx.arc(L.xc(lastIdx), L.y(last.close), 3, 0, Math.PI * 2);
      ctx.strokeStyle = themeC.ink;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // MACD(12,26,9)：柱 = 2×(DIF−DEA)，红柱 DIF>DEA / 绿柱 DIF<DEA（与分时同一套画法）。
    // 数值按全量算（EMA 要看历史才对），但**刻度取窗口内的极值**——否则放大到一小段时
    // MACD 会被窗口外的历史峰值压成一条平线
    const macd = klineMacdOf(bars);
    let mAbs = 1e-9;
    for (let i = L.start; i < L.end; i++) {
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
    for (let i = L.start; i < L.end; i++) {
      const h = (Math.abs(macd.hist[i]) / mAbs) * (L.MACD_H / 2 - 8);
      if (h < 0.4) continue;
      ctx.fillStyle = macd.hist[i] > 0 ? withA(themeC.red, .9) : withA(themeC.green, .9);
      ctx.fillRect(L.xc(i) - bw / 2, macd.hist[i] > 0 ? mMid - h : mMid, bw, h);
    }
    ctx.beginPath();
    for (let i = L.start; i < L.end; i++) {
      const px = L.xc(i);
      const py = mY(macd.dif[i]);
      if (i === L.start) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = themeC.gold;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.beginPath();
    for (let i = L.start; i < L.end; i++) {
      const px = L.xc(i);
      const py = mY(macd.dea[i]);
      if (i === L.start) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = themeC.blue;
    ctx.lineWidth = 1.3;
    ctx.stroke();

    // 图例（数值取**最右可见那根**：翻历史时图例要跟屏幕上的内容对上，而不是永远报最新价）
    ctx.textAlign = 'left';
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = themeC.muted;
    let lx = L.PAD_L + 4;
    const zoomTxt = L.count < n || L.offset > 0 ? ` · 显示 ${L.count}/${n} 根` : ` · 共 ${n} 根`;
    const head = `${modeLabel}${zoomTxt}${last.live && lastIdx === n - 1 ? '（含当期未收盘）' : ''}`;
    ctx.fillText(head, lx, L.PAD_T - 3);
    lx += ctx.measureText(head).width + 12;
    // 只列画得出线的均线：根数不够的那几条不占位置（否则周/月线上半屏全是 --），
    // 但要说清「有几条没画出来」，别让玩家以为指标漏了
    let hiddenMa = 0;
    for (const ma of maSeries) {
      if (ma.arr[lastIdx] == null) {
        hiddenMa += 1;
        continue;
      }
      const txt = 'MA' + ma.period + (ma.approx ? '≈' : ' ') + ma.arr[lastIdx].toFixed(2);
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
      const difTxt = 'DIF ' + macd.dif[lastIdx].toFixed(3);
      ctx.fillText(difTxt, lx, L.macdTop + 8);
      lx += ctx.measureText(difTxt).width + 12;
      ctx.fillStyle = themeC.blue;
      ctx.fillText('DEA ' + macd.dea[lastIdx].toFixed(3), lx, L.macdTop + 8);
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
    // 光标在右侧价格轴 / 画布边缘外时不弹框（那边的 x 反解出来是窗口外的下标）
    if (mx < L.PAD_L || mx > rect.width - L.PAD_R) {
      tip.hidden = true;
      return;
    }
    // 下标要加窗口起点：xc(i) 里的 i 是全量下标，mx 反解出来的是窗口内的偏移
    const i = L.start + Math.floor((mx - L.PAD_L) / L.slot);
    if (i < L.start || i >= L.end) {
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

    // x 轴域：全天固定刻度（见 minuteDomain）——当日 09:30~15:00、5 日整 5 天，
    // 右端压在今天收盘上；没有阶段表时退回贴合数据的口径
    const { a0, a1 } = minuteDomain(pts);
    const spanA = a1 - a0 || 1;
    // 轴坐标 → 像素（x(t) 与竞价分界标记共用一套映射，免得两处各算一遍走样）
    const xa = (a) => PAD_L + ((a - a0) / spanA) * (W - PAD_L - PAD_R);
    const x = (t) => xa(axisCoord(t));

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
    // 刻度读**游戏内交易时刻**（09:30 / 10:30 / 11:30·13:00 / 14:00 / 15:00），与顶栏时钟同源——
    // 墙钟 19:25 对玩家没有任何意义（既不是开盘也不是收盘）。横轴已把休市压成 0 宽，
    // 所以午休那根竖线同时是上午收盘与下午开盘，文案写成「11:30/13:00」。
    // 跨天的刻度补「N日」前缀，5 日视图才分得清是哪一天；
    // 没有交易日时钟（day 未启用 / 老服务端）时 a 就是墙钟，刻度照旧读墙钟。
    ctx.textAlign = 'center';
    ctx.fillStyle = themeC.muted;
    const tickStep = axisTickStep(spanA);
    let prevTick = '';
    for (let k = 0, av = Math.ceil(a0 / tickStep) * tickStep; av <= a1 + 1 && k < 12; k++, av += tickStep) {
      // 日界上的刻度有两读法（前一天收盘 15:00 / 次日开盘 09:30）：**只有最右端那根**
      // （= 今天收盘，数据还没走到也照样按收盘读）读收盘，中间的日界一律读次日开盘
      const label = axisTimeLabel(av, av >= a1 - 1);
      // 数据还没走到的右侧留白区里，刻度会一起夹在同一个时刻上：重复的不画，
      // 免得两条竖线贴在一起、两个一样的字叠成一坨
      if (!label || label === prevTick) continue;
      prevTick = label;
      const xx = PAD_L + ((av - a0) / spanA) * (W - PAD_L - PAD_R);
      // 居中绘制会越出画布，两端按**实际字宽**夹回可视区（「123日 11:30/13:00」比「11:30」宽好几倍，
      // 还按固定 18px 夹会压到右侧价格轴上）
      const half = ctx.measureText(label).width / 2;
      const lo = PAD_L + half;
      const hi = W - PAD_R - half;
      ctx.fillText(label, hi > lo ? Math.min(Math.max(xx, lo), hi) : (lo + hi) / 2, H - PAD_B / 2 - 2);
      ctx.strokeStyle = themeC.grid;
      ctx.beginPath();
      ctx.moveTo(xx, PAD_T);
      ctx.lineTo(xx, macdTop + MACD_H);
      ctx.stroke();
    }

    // 竞价分界（画在行情线**之下**：标记是背景信息，不该压住价格）
    //  · 开盘集合竞价被压成 0 宽，收口点 = 连续竞价的起点；当日视图里它就是左边界（不重复画），
    //    5 日视图里每天一根淡虚线，正好当交易日分隔。
    //  · 收盘集合竞价有 3 分钟真实宽度：淡色带 + 起点竖线 + 竖排小字，让「尾盘三分钟是集中撮合」
    //    看得见——否则玩家只会觉得 15:00 前那段线怪怪的。
    {
      const plotR = W - PAD_R;
      const bandBottom = macdTop + MACD_H;
      for (const mk of axisAuctionMarks(a0, a1)) {
        const mx = xa(mk.a);
        if (mx > plotR - 0.5) continue;
        if (mk.kind === 'open') {
          if (mx <= PAD_L + 1.5) continue; // 就是左边界，再压一条线只是把边框画粗
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = withA(themeC.muted, 0.5);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(mx + 0.5, PAD_T);
          ctx.lineTo(mx + 0.5, bandBottom);
          ctx.stroke();
          ctx.setLineDash([]);
          continue;
        }
        const ex = xa(mk.a + mk.width);
        const l = Math.max(mx, PAD_L);
        const r = Math.min(ex, plotR);
        if (r > l + 0.5) {
          ctx.fillStyle = withA(themeC.gold, 0.08);
          ctx.fillRect(l, PAD_T, r - l, bandBottom - PAD_T);
        }
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = withA(themeC.gold, 0.6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mx + 0.5, PAD_T);
        ctx.lineTo(mx + 0.5, bandBottom);
        ctx.stroke();
        ctx.setLineDash([]);
        // 竖排小字：带子够宽才画。当日视图满屏时带宽 ≈ 8.5~9.3px（3 分钟 / 240+ 分钟域），
        // 5 日视图只有 ~2px，画了就糊成一团。逐字竖排（不旋转），从带顶往下排
        if (r - l >= 7) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(l, PAD_T, r - l, bandBottom - PAD_T);
          ctx.clip();
          ctx.font = '9px -apple-system, "PingFang SC", sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = withA(themeC.gold, 0.9);
          const cx = l + (r - l) / 2;
          '收盘竞价'.split('').forEach((ch, i) => {
            ctx.fillText(ch, cx, PAD_T + 7 + i * 10);
          });
          ctx.restore();
        }
      }
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
    // 量柱宽度按**轴上的实际间距**算（全天固定刻度后，开盘时点很少但挤在最左边，
    // 再按「画布宽 / 点数」就会画出几十像素宽的柱子、糊成一整块）
    let gapSum = 0;
    let gapN = 0;
    for (let i = 1; i < pts.length; i++) {
      const g = x(pts[i].t) - x(pts[i - 1].t);
      if (g > 0.01) {
        gapSum += g;
        gapN += 1;
      }
    }
    const bw = Math.max(1, Math.min(6, (gapN ? gapSum / gapN : 1) * 0.72));
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
      // 光标在读盘：弹幕压到 35%，读数优先（方案 §6.4）
      dimDanmaku(true);
      // 拖动平移中不弹光标框：它跟着手指跑、还挡着 K 线
      if (chartPan && chartPan.moved) {
        tip.hidden = true;
        dimDanmaku(false);
        return;
      }
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
      // 反解（与 drawMinuteChart 的 x 轴同一套域）：横向比例 → **轴坐标**，再按轴坐标
      // 找最近的点。休市被压成 0 宽后，墙钟上的远近不再等于画面上的远近——
      // 按 t 找的话，午休锚点会把光标从 11:30 拽到 12:15 附近去。
      // 域必须与画图共用 minuteDomain：固定全天刻度后若各算各的，光标会整体偏移
      const { a0, a1 } = minuteDomain(pts);
      const spanA = a1 - a0 || 1;
      const W = rect.width;
      const PAD_L = 8;
      const PAD_R = 58;
      const frac = (mx - PAD_L) / (W - PAD_L - PAD_R);
      if (frac < 0 || frac > 1) {
        tip.hidden = true;
        return;
      }
      const av = a0 + frac * spanA;
      let best = pts[0];
      let bestI = 0;
      let bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(axisCoord(pts[i].t) - av);
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
      // 光标时间同样走游戏内交易时刻（与轴刻度、顶栏时钟同源）；5 日视图补天号
      const tLabel = minuteTimeLabel(best.t, true);
      tip.innerHTML =
        `<span class="t">${tLabel}</span><br>价格 <b class="${cls(best.price - prev)}">${fmtP(best.price)}</b> <span class="${cls(best.price - prev)}">${(pct >= 0 ? '+' : '') + pct.toFixed(2)}%</span><br><span class="t">成交量</span> ${fmtVol(mv)} <span class="t">（累计 ${fmtVol(bv)}）</span><br>` +
        `<span class="t">MACD</span> DIF <b class="${cls(difV)}">${difV.toFixed(3)}</b> DEA <b class="${cls(deaV)}">${deaV.toFixed(3)}</b>`;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(mx + 14, rect.width - tw - 6) + 'px';
      tip.style.top = Math.min(my + 14, rect.height - 86) + 'px';
    });
    c.addEventListener('mouseleave', () => {
      tip.hidden = true;
      dimDanmaku(false);
    });
  }

  /**
   * K 线的缩放与平移（只对日/周/月生效，分时图不受影响）：
   *   滚轮           → 以光标为中心缩放（下滚缩小、上滚放大）
   *   按住左键拖动   → 左右平移（往右拖看更早的）
   *   双击           → 复位（默认根数 + 贴最新一根）
   *   右上角 −/+/⟲   → 没滚轮的触控板 / 触屏设备走按钮
   * 拖动期间锁住十字光标（跟着手跳、还挡视线），松手后下一帧自动恢复。
   */
  function bindKlineView() {
    const c = canvas();

    c.addEventListener('wheel', (e) => {
      if (!isKline() || activeView !== 'trade') return;
      const m = curMarket();
      if (!m) return;
      const bars = klineSeriesOf(m);
      if (bars.length < 2) return;
      // passive: false 才能 preventDefault，否则滚轮会把整个页面一起滚
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const dir = e.deltaY > 0 ? 1 : -1; // 下滚 = 缩小（看到更多根）
      if (!zoomKline(bars, dir, e.clientX - rect.left, rect.width)) return;
      $('chartTip').hidden = true;
      drawChart();
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      if (!isKline() || activeView !== 'trade' || e.button !== 0) return;
      const m = curMarket();
      if (!m) return;
      const bars = klineSeriesOf(m);
      if (bars.length < 2) return;
      const rect = c.getBoundingClientRect();
      const L = dayLayout(rect.width, rect.height, bars);
      if (!(L.slot > 0)) return;
      chartPan = {
        id: e.pointerId,
        x0: e.clientX,
        slot: L.slot,
        total: bars.length,
        count: L.count,
        offset: L.offset,
        moved: false,
      };
      // 指针捕获：拖出画布再松手也能收到 pointerup，否则 chartPan 会一直挂着
      if (c.setPointerCapture) {
        try {
          c.setPointerCapture(e.pointerId);
        } catch (err) {
          /* 老浏览器没有捕获，窗口级的 pointerup 兜底 */
        }
      }
    });

    c.addEventListener('pointermove', (e) => {
      if (!chartPan || e.pointerId !== chartPan.id) return;
      const dx = e.clientX - chartPan.x0;
      if (!chartPan.moved && Math.abs(dx) < 3) return; // 手抖不算拖动，别把光标锁住
      chartPan.moved = true;
      // 拖动方向与内容方向相反：往右拖 = 右端多丢几根 = 看更早的行情
      let offset = Math.round(chartPan.offset + dx / chartPan.slot);
      offset = Math.max(0, Math.min(offset, chartPan.total - chartPan.count));
      const st = kViews[chartMode] || (kViews[chartMode] = { count: 0, offset: 0 });
      if (offset === st.offset) return;
      kViews[chartMode] = { count: chartPan.count, offset };
      $('chartTip').hidden = true;
      c.classList.add('panning');
      drawChart();
    });

    const endPan = (e) => {
      if (!chartPan) return;
      if (e && e.pointerId !== undefined && e.pointerId !== chartPan.id) return;
      chartPan = null;
      c.classList.remove('panning');
    };
    c.addEventListener('pointerup', endPan);
    c.addEventListener('pointercancel', endPan);
    // 窗口级兜底：指针在画布外松开（没捕获成功）时也要收尾
    window.addEventListener('pointerup', endPan);

    c.addEventListener('dblclick', () => {
      if (!isKline()) return;
      resetKlineView();
      $('chartTip').hidden = true;
      drawChart();
    });

    const box = $('chartZoom');
    if (!box) return;
    box.querySelectorAll('[data-zoom]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!isKline()) return;
        const m = curMarket();
        if (!m) return;
        const cW = c.getBoundingClientRect().width;
        const act = btn.dataset.zoom;
        if (act === 'reset') resetKlineView();
        // 按钮没有光标位置，以绘图区中心为锚点缩放
        else zoomKline(klineSeriesOf(m), act === 'out' ? 1 : -1, (cW - 58 + 8) / 2, cW);
        drawChart();
      });
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
    // 观看心跳（内部 60 秒节流）：服务端 watcher 的 TTL 只有 5 分钟，没有它盯盘会哑掉
    danmakuHeartbeat();
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
    bindKlineView();
    bindChartMode();
    bindDanmaku();
    bindTransfer();
    bindEggs();
    bindCompanyProfile();
    bindRules();
    bindAppDownload();
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

