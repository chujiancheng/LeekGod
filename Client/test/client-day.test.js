/**
 * 客户端交易日 UI 的离线自检（不进浏览器）：
 * 用 vm + 极简 DOM 桩把 app.js 真跑一遍，只把内部函数暴露出来做断言。
 * 目的是挡住"改了 id / 算错倒计时 / 阶段分支写反"这类回归，不替代真机截图。
 *
 *   node test/client-day.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + msg);
  } else {
    failed += 1;
    console.log('  ✗ ' + msg);
  }
}

// ---- 极简 DOM 桩：$() 按 id 惰性造元素，把要断言的值直接挂在元素上 ----
// 2D 上下文桩：画布那几条绘制函数（drawMinuteChart / drawDayChart / 持仓与挂借走势）
// 在砌「切主题要重绘」这类断言时会被真调到，桩里每个方法都得存在且可链式调用
function mkCtx2d() {
  const gradient = { addColorStop() {} };
  const noop = () => {};
  return {
    font: '', textAlign: '', textBaseline: '', lineWidth: 1, strokeStyle: '', fillStyle: '',
    globalAlpha: 1, lineJoin: '', lineCap: '', shadowBlur: 0, shadowColor: '',
    measureText: () => ({ width: 8 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop, arc: noop,
    rect: noop, stroke: noop, fill: noop, clip: noop, setLineDash: noop,
    fillRect: noop, strokeRect: noop, clearRect: noop, fillText: noop, strokeText: noop,
    translate: noop, scale: noop, rotate: noop, setTransform: noop, drawImage: noop,
  };
}

const els = new Map();
// 事件登记处：记录每个元素挂的监听器，于是自检能**真的点一次按钮**（`fire('loginBtn','click')`），
// 而不是只调内部函数——「点登录 → 切到开户步骤」这类接线错误只有走点击路径才拦得住
const elHandlers = new Map();
function mkEl(id) {
  const cls = new Set();
  const handlers = new Map();
  elHandlers.set(id, handlers);
  return {
    id,
    hidden: false,
    textContent: '',
    innerHTML: '',
    className: '',
    disabled: false,
    title: '',
    value: '',
    // CSSOM 桩：代码里一律走 `el.style.x = …` 或 `setProperty`（CSP 禁内联 style 属性），
    // 两个入口都得能跑，否则 `--rtone` 这类 CSS 变量在测试里就会抛「not a function」
    style: {
      _vars: {},
      setProperty(k, v) { this._vars[k] = String(v); },
      getPropertyValue(k) { return this._vars[k] || ''; },
      removeProperty(k) { delete this._vars[k]; },
    },
    dataset: {},
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      toggle: (c, force) => {
        const on = force === undefined ? !cls.has(c) : !!force;
        if (on) cls.add(c);
        else cls.delete(c);
        return on;
      },
      contains: (c) => cls.has(c),
    },
    addEventListener(type, fn) {
      const arr = handlers.get(type) || [];
      arr.push(fn);
      handlers.set(type, arr);
    },
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    appendChild() {},
    focus() {},
    get offsetWidth() {
      return 120;
    },
    get offsetHeight() {
      return 96;
    },
    getContext: () => mkCtx2d(),
    width: 800,
    height: 400,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }),
  };
}
const getEl = (id) => {
  if (!els.has(id)) els.set(id, mkEl(id));
  return els.get(id);
};
/** 在某个元素上触发事件（模拟真实点击 / 回车），返回是否真的有监听器被调用 */
const fire = (id, type, ev) => {
  const m = elHandlers.get(id);
  const fns = ((m && m.get(type)) || []).slice();
  fns.forEach((fn) => fn(ev || { key: '', preventDefault() {}, target: getEl(id) }));
  return fns.length;
};

const store = { gushen_stock: '600001', gushen_name: '', gushen_token: '' };
const localStorageStub = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    store[k] = v;
  },
  removeItem: (k) => {
    delete store[k];
  },
};

// ---- 定时器登记处：只记录不触发（真跑 app.js，但不等 8 秒横幅超时）----
let timerSeq = 0;
const timers = new Map();
const stubSetTimeout = (fn, delay) => {
  timerSeq += 1;
  timers.set(timerSeq, { id: timerSeq, fn, delay: delay || 0, cleared: false });
  return timerSeq;
};
const stubClearTimeout = (id) => {
  const t = timers.get(id);
  if (t) t.cleared = true;
};

// ---- 可编程 fetch：默认"什么都失败"，登录/开户的用例各自临时换脚本 ----
let fetchCalls = [];
let fetchHandler = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
/** 让下一次（及后续）fetch 返回给定 JSON；同时记录请求，便于断言"没发请求"这类行为 */
const scriptFetch = (responder) => {
  fetchCalls = [];
  fetchHandler = (url, opts) => {
    fetchCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    const res = typeof responder === 'function' ? responder(url, opts) : responder;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(res) });
  };
};
const resetFetch = () => {
  fetchCalls = [];
  fetchHandler = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
};
/** 等微任务队列把 then 链走完（fetch 桩是 resolve 的 Promise，两跳足够） */
const flush = () => new Promise((r) => setImmediate(r));

// ---- 把 app.js 真跑一遍，并在收尾前把内部函数挂到 globalThis 上 ----
const srcPath = path.join(__dirname, '..', '..', 'Client', 'app.js');
// 仓库里的源码是 CRLF，先归一化成 LF 再匹配 IIFE 收尾（vm 执行对换行不敏感）
let src = fs.readFileSync(srcPath, 'utf8').replace(/\r\n/g, '\n');
const tail = /\n  init\(\);\n\}\)\(\);\s*$/;
if (!tail.test(src)) {
  console.log('!! 找不到 app.js 的 IIFE 收尾，无法注入探针');
  process.exit(1);
}
src = src.replace(
  tail,
  `
  init();
  globalThis.__day = {
    renderDay, renderClock, gameClockNow, fmtClockMs, dayInfo,
    // 分时时间刻度：墙钟 → 游戏内交易时刻
    gameClockAt, fmtHM, minuteTimeLabel,
    // 分时横轴（休市压成 0 宽）：墙钟 → 轴坐标 ↔ 游戏内时刻
    axisAt, axisCoord, axisDayWidth, clockAtAxis, axisTimeLabel, axisTickStep,
    axisPhases, axisCloseAuctionSpan, axisAuctionMarks,
    renderNews, newsRowsHtml,
    renderFlow, renderChartMode, onState,
    renderBrokerWall, renderMyBroker, renderSeats, renderMarginCall, renderLending,
    renderBrokerWeeklyHint, seatHtml, newsHintsHtml, brokerCardHtml, fmtFeeRate, rankRowsHtml,
    pumpEggs, renderEggCard, showEggBanner, hideEggBanner, bindEggs, eggSeqStored,
    renderRealmChip, rulesRealmHtml,
    // 头像（Doc/头像方案.md）：顶栏只认 account.avatar.key，环色走 class 不写内联 style
    renderTopAvatar, avaHtml, avaCellsHtml, avaCellClick, onAvaImgError, bindAvaFallback,
    avatarSrcOf: avatarSrc, openAvaOverlay, pickAvatar, renderAvaCells, markAvaSeen,
    setAvatarCatalog: (v) => { avatarCatalog = v; },
    avatarCatalogOf: () => avatarCatalog,
    setAvaTopSig: (v) => { avaTopSig = v; },
    setAvaIntroShown: (v) => { avaIntroShown = v; },
    avaSeenStored: () => localStorage.getItem('gushen_ava_seen'),
    avaBtn: () => { const b = $('avaBtn'); return { hidden: !!b.hidden, cls: b.className, title: b.title }; },
    avaImg: () => ({ src: $('avaImg').src || '', hidden: !!$('avaImg').hidden }),
    avaCh: () => ({ hidden: !!$('avaCh').hidden, text: $('avaCh').textContent }),
    avaNewHidden: () => !!$('avaNew').hidden,
    setIdentity, resetEggStream,
    eggState: () => ({ lastSeq: lastEggSeq, queued: eggQueue.length, busy: eggBusy }),
    eggTimerInfo: () => (eggTimer == null ? null : __timers.get(eggTimer) || null),
    setState: (v) => { state = v; },
    setRealmLadder: (v) => { realmLadder = v; },
    setBrokers: (m) => { brokerMeta = m; },
    setPicked: (k) => { pickedBroker = k; },
    brokerKeys,
    // 主题系统
    setTheme, repaintTheme, maybeFirstTheme, setView, applyMascot,
    themeOf: () => currentTheme,
    themeAttr: () => ('theme' in document.documentElement.dataset ? document.documentElement.dataset.theme : null),
    themes: () => THEMES.map((t) => t.id),
    mascots: () => MASCOTS.map((m) => m.id),
    mascotPickOf: () => currentMascot,
    mascotOf: () => { const c = mascotConf(); return { id: c.id, img: c.img, thumb: c.thumb }; },
    themeBtnText: () => $('themeBtn').textContent,
    themeOverlayShown: () => !$('themeOverlay').classList.contains('hidden'),
    heroMascot: () => { const h = $('heroMascot'); return { hidden: !!h.hidden, src: h.src || '' }; },
    setMascotPick: (v) => { currentMascot = v; },
    setActiveView: (v) => { activeView = v; },
    activeTabOf: () => activeTab,
    setActiveTab: (t) => { activeTab = t; },
    setDrift: (ms) => { lastStateAt = Date.now() - ms; },
    setChartMode: (m) => { chartMode = m; },
    setMinuteRange: (r) => { minuteRange = r === '5d' ? '5d' : 'day'; },
    minuteDomain,
    dayLoadedSize: () => dayLoaded.size,
    chartModeOf: () => chartMode,
    // 分时取数窗口（当日 / 5 日）
    setHistory: (id, arr) => { histories.set(id, arr); },
    histOf, minutePts, minuteFrom, macdOf, setMinuteRange,
    minuteRangeOf: () => minuteRange,
    // 分时定格：竞价/休市不往后生长
    loadHistory, resetHistLoaded: () => histLoaded.clear(),
    // K 线（日/周/月）：注入日线缓存、聚合、布局与 MACD
    setDayBars: (id, arr) => { dayBars.set(id, arr); },
    dayLoadedOf: (id) => dayLoaded.get(id),
    klineSeriesOf, dayLayout, klineMacdOf, computeMacd, daySeriesOf, weekPer,
    // K 线视窗：滚轮缩放 / 拖动平移（count = 屏上几根、offset = 右端丢几根）
    klineView, zoomKline, resetKlineView,
    viewOf: () => ({ ...kViews[chartMode] }),
    setKView: (count, offset) => { kViews[chartMode] = { count, offset }; },
    kviewMin: () => KVIEW_MIN_BARS,
    drawChart, dayCrosshair,
    // 均线组：日周月线共用一套 MA5/10/20/30/60/120/250
    movingAvg, klineMaOf, klineLeadBars,
    maPeriods: () => KLINE_MAS.map((x) => x.period),
    maColors: () => KLINE_MAS.map((x) => x.color),
    crosshairHtml: () => $('chartTip').innerHTML,
    crosshairHidden: () => !!$('chartTip').hidden,
    // 账号 / 昵称 / 登录开户
    doLoginFlow, doOnboardFlow, probeLogin, showLoginStep, showLogin, renderIdentity, saveNick,
    // 游戏规则（主页入口 + 分类弹窗）
    renderRules, openRules, closeRules,
    rulesTabs: () => RULES_TABS.map((t) => t.key),
    rulesTabOf: () => rulesTabKey,
    rulesBodyHtml: () => $('rulesBody').innerHTML,
    rulesNavHtml: () => $('rulesNav').innerHTML,
    rulesEntryNew: () => $('rulesBtn').classList.contains('has-new'),
    rulesOverlayShown: () => !$('rulesOverlay').classList.contains('hidden'),
    rulesSubText: () => $('rulesSub').textContent,
    // 开户过场漫画
    openComic, closeComic, pickComic, switchComic, nextComic, finishComic,
    comicSets: () => COMICS.map((c) => ({ id: c.id, title: c.title, short: c.short, n: c.panels.length })),
    comicSeenList: () => comicSeen(),
    resetComicSeen: () => localStorage.removeItem(COMIC_SEEN_KEY),
    comicPlayedOf: () => comicPlayed,
    comicReplayOf: () => comicReplay,
    comicSetNow: () => (comicCurrent ? comicCurrent.id : ''),
    comicKickerText: () => $('comicKicker').textContent,
    comicGoText: () => $('comicGoBtn').textContent,
    renderHolders, setHolders: (d) => { holdersData = d; holdersStockId = d.stockId; },
    renderHome,
    // 排行 → 玩家持仓弹窗
    openPlayerPositions, closePlayerPositions, renderPlayerPositions,
    rankPosShown: () => !$('rankPosOverlay').classList.contains('hidden'),
    renderPositions, posRowsHtml,
    identity: () => ({ account: me, nick: myNick, token }),
    // 弹幕表情：渲染节点 + 选择器（面板挂在 body 上，靠 toggle 开合）
    dmEmoteNode, dmEmoteKeys,
    dmPacks: () => DM_EMOTE_PACKS,
    dmPack: () => dmPack,
    setDmPack,
    dmEmoteDef,
    // 测试里临时注册一个系列，验证「以后加系列」这条路是通的（用完不删也不影响别的断言）
    dmPushPack: (p) => DM_EMOTE_PACKS.push(p),
    dmPackSaved: () => localStorage.getItem('gushen_dm_pack'),
    // 把全部系列的 items 摊平成一个对象，方便断言「每个表情都有语义色」
    dmEmotes: () => {
      const all = {};
      for (const p of DM_EMOTE_PACKS) Object.assign(all, p.items);
      return all;
    },
    setEmotePick: (k) => { dmEmotePick = k; syncEmoteBtn(); },
    emoteBtnText: () => $('dmEmoBtn').textContent,
    emoteBtnHtml: () => $('dmEmoBtn').innerHTML,
    emotePadShown: () => !!(dmPad && !dmPad.hidden),
    toggleEmotePad,
    emotePadHtml: () => (dmPad ? dmPad.innerHTML : ''),
    accountRe: () => String(ACCOUNT_RE),
    nickRe: () => String(NICK_RE),
    acctKey: () => localStorage.getItem('gushen_account'),
    nickKey: () => localStorage.getItem('gushen_nick'),
    legacyKey: () => localStorage.getItem('gushen_name'),
    el: (id) => $('id'.replace('id', id)),
  };
})();
`
);

const sandbox = {
  console,
  Date,
  Math,
  JSON,
  Number,
  String,
  Array,
  Object,
  Map,
  Set,
  Promise,
  RegExp,
  parseInt,
  parseFloat,
  isNaN,
  encodeURIComponent,
  setTimeout: stubSetTimeout,
  clearTimeout: stubClearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: () => 0,
  localStorage: localStorageStub,
  __timers: timers,
  location: { href: 'http://127.0.0.1/', search: '', hash: '' },
  navigator: { userAgent: 'node' },
  document: {
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: (tag) => mkEl(tag),
    body: mkEl('body'),
    hidden: false,
    // 主题系统要读它：setTheme 写 documentElement.dataset.theme
    documentElement: { dataset: {} },
  },
  // 主题 token 在真浏览器里从计算样式读；桩里一律给空串，themeTokens() 会走自己的兜底默认值
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  EventSource: function () {
    this.addEventListener = () => {};
    this.close = () => {};
  },
  // fetch 可编程：登录/开户这两条链路的用例要按脚本给响应（默认一律失败，保证其它用例不受影响）
  fetch: (url, opts) => fetchHandler(url, opts),
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1280,
  innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { filename: srcPath });
} catch (e) {
  console.log('!! app.js 在桩环境里跑不起来: ' + e.message);
  console.log(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
const api = sandbox.__day;
if (!api) {
  console.log('!! 探针注入失败');
  process.exit(1);
}

// ---- 造一份"服务端下发的 state"，字段与 /api/state 完全一致 ----
const STOCK = '600001';
const mkState = (day, auction) => ({
  serverTime: Date.now(),
  online: 3,
  day,
  halt: { halted: false },
  markets: [
    {
      stockId: STOCK,
      name: '大米集团',
      last: 20.01,
      prevClose: 20,
      open: 20.01,
      high: 20.01,
      low: 20,
      change: 0.01,
      changePct: 0.05,
      volume: 542900,
      turnover: 1e7,
      depth: { bids: [], asks: [] },
      trades: [],
      band: { up: 22, down: 18 },
      auction,
    },
  ],
  index: { stockId: 'GUSHEN', isIndex: true, last: 1000, prevClose: 1000, change: 0, changePct: 0, trades: [], depth: { bids: [], asks: [] } },
  account: { orders: [], orderHistory: [], trades: [], positions: [] },
  rules: { allowNakedShort: true, feeRate: 0.0001, cooldownMs: 2000, lockMs: 10000, marginRatio: 0.5, maintenance: 0.4 },
  news: [],
});

// 真实抓自 /api/state（竞价刚过 11.4 秒）
const AUCTION_DAY = {
  enabled: true,
  day: 1,
  phase: 'auction',
  label: '开盘集合竞价',
  trading: true,
  auction: 'open',
  locked: false,
  unlockLeftMs: 8559,
  phaseMs: 30000,
  phaseElapsedMs: 11441,
  phaseLeftMs: 18559,
  gameClockMs: 33528820,
  phaseGameMs: 600000,
};

console.log('\n[1] 游戏内时钟：与服务端 formatGameClock 同口径');
{
  // 09:15:00 + (11441/30000)*10min = 09:18:48.8
  api.setState(mkState(AUCTION_DAY, { kind: 'open', price: 20.01, volume: 542900, locked: false }));
  api.setDrift(0);
  assert(api.fmtClockMs(api.gameClockNow()) === '09:18:48', `帧时刻 ${api.fmtClockMs(api.gameClockNow())}`);
  // 再走 3 秒 → 09:15 + (14441/30000)*10min = 09:19:48.7
  api.setDrift(3000);
  assert(api.fmtClockMs(api.gameClockNow()) === '09:19:48', `3 秒后 ${api.fmtClockMs(api.gameClockNow())}（按阶段内比例推进）`);
  // 漂移超过阶段长度时夹在阶段末尾（等下一帧对齐），不能算出 >10:00
  api.setDrift(999999);
  assert(api.fmtClockMs(api.gameClockNow()) === '09:25:00', `超长漂移夹在阶段末尾 ${api.fmtClockMs(api.gameClockNow())}`);
}

console.log('\n[2] 顶栏时钟：有交易日时钟显示游戏内时刻，没有则退回服务器时间');
{
  api.setState(mkState(AUCTION_DAY, null));
  api.setDrift(0);
  api.renderClock();
  assert(api.el('clock').textContent === '09:18:48', `时钟 ${api.el('clock').textContent}`);

  api.setState({ ...mkState({ enabled: false, trading: true }, null) });
  api.setDrift(0);
  api.renderClock();
  assert(/^\d{2}:\d{2}:\d{2}$/.test(api.el('clock').textContent), `老服务端（无 day 段）退回服务器时间 ${api.el('clock').textContent}`);
}

console.log('\n[3] 顶栏徽标与竞价横幅');
{
  const st = mkState(AUCTION_DAY, { kind: 'open', price: 20.01, volume: 542900, locked: false });
  api.setState(st);
  api.setDrift(0);
  api.renderDay();
  assert(api.el('dayChip').hidden === false, '徽标显示');
  assert(api.el('dayNo').textContent === '第 1 天', `天号 ${api.el('dayNo').textContent}`);
  assert(api.el('dayPhase').textContent === '开盘集合竞价', `阶段 ${api.el('dayPhase').textContent}`);
  assert(api.el('dayLeft').textContent === '19 秒', `阶段倒计时 ${api.el('dayLeft').textContent}`);
  assert(api.el('dayChip').className.includes('auction'), '竞价阶段徽标带 auction 强调');

  assert(api.el('dayBanner').hidden === false, '竞价横幅显示');
  assert(api.el('dayBanner').className.includes('auction'), '竞价横幅用蓝色系');
  assert(api.el('dayBannerTag').textContent === '第 1 天 · 开盘竞价', `横幅标签 ${api.el('dayBannerTag').textContent}`);
  assert(
    /^虚拟成交价 20\.01 · 可成交 [\d,]+ 股$/.test(api.el('dayBannerText').textContent),
    `横幅正文「${api.el('dayBannerText').textContent}」`
  );
  assert(/距不可撤单 9 秒/.test(api.el('dayBannerLeft').textContent), `横幅右侧「${api.el('dayBannerLeft').textContent}」`);

  assert(api.el('auctionStrip').hidden === false, '盘口虚拟成交价条显示');
  assert(api.el('auctionTag').textContent === '虚拟开盘价', `标签 ${api.el('auctionTag').textContent}`);
  assert(api.el('auctionPrice').textContent === '20.01', `虚拟价 ${api.el('auctionPrice').textContent}`);
  assert(/^可成交 [\d,]+ 股$/.test(api.el('auctionVol').textContent), `可成交量 ${api.el('auctionVol').textContent}`);
  assert(api.el('sessionNote').hidden === true, '竞价仍可下单，不显示休市提示');
}

console.log('\n[4] 进入撤单锁定期');
{
  const st = mkState({ ...AUCTION_DAY, locked: true, unlockLeftMs: 0, phaseElapsedMs: 22000, phaseLeftMs: 8000, gameClockMs: 33528820 + 3533333 }, null);
  api.setState(st);
  api.setDrift(0);
  api.renderDay();
  assert(api.el('dayBannerLeft').textContent === '已进入不可撤单窗口', `横幅右侧「${api.el('dayBannerLeft').textContent}」`);
  assert(api.el('dayChip').className.includes('auction'), '徽标仍是竞价态');
}

console.log('\n[5] 集合竞价无成交（盘口未交叉）');
{
  const st = mkState(AUCTION_DAY, { kind: 'open', price: null, volume: 0, locked: false });
  api.setState(st);
  api.setDrift(0);
  api.renderDay();
  assert(api.el('dayBannerText').textContent === '盘口未交叉，暂撮合不出价格', `横幅正文「${api.el('dayBannerText').textContent}」`);
  assert(api.el('auctionPrice').textContent === '--' && api.el('auctionVol').textContent === '无交叉盘口', '虚拟价条显示 -- / 无交叉盘口');
}

console.log('\n[6] 午间休市 / 夜间休市');
{
  const lunch = mkState(
    { ...AUCTION_DAY, phase: 'lunch', label: '午间休市', trading: false, auction: null, locked: false, phaseLeftMs: 40000, phaseElapsedMs: 0, gameClockMs: 41400000 },
    null
  );
  api.setState(lunch);
  api.setDrift(0);
  api.renderDay();
  assert(api.el('dayChip').hidden === false && api.el('dayChip').className.includes('closed'), '徽标进入休市态');
  assert(api.el('dayPhase').textContent === '午间休市', `阶段 ${api.el('dayPhase').textContent}`);
  assert(api.el('dayBanner').hidden === false && api.el('dayBanner').className.includes('closed'), '休市横幅显示');
  assert(api.el('dayBannerText').textContent === '午间休市，13:00 恢复交易', `横幅正文「${api.el('dayBannerText').textContent}」`);
  assert(api.el('dayBannerLeft').textContent === '恢复交易还有 40 秒', `横幅右侧「${api.el('dayBannerLeft').textContent}」`);
  assert(api.el('sessionNote').hidden === false && /暂停下单/.test(api.el('sessionNote').textContent), `下单面板提示「${api.el('sessionNote').textContent}」`);
  assert(api.el('auctionStrip').hidden === true, '休市不显示虚拟成交价条');

  const night = mkState(
    { ...AUCTION_DAY, phase: 'night', label: '休市结算', trading: false, auction: null, locked: false, phaseLeftMs: 40000, phaseElapsedMs: 0, gameClockMs: 54000000 },
    null
  );
  api.setState(night);
  api.setDrift(0);
  api.renderDay();
  assert(api.el('dayBannerText').textContent === '已收盘结算，未成交委托按当日失效', `夜间横幅「${api.el('dayBannerText').textContent}」`);
}

console.log('\n[7] 连续竞价：横幅与提示都收起');
{
  const st = mkState(
    { ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null, locked: false, phaseLeftMs: 230000, phaseElapsedMs: 0, gameClockMs: 34200000 },
    null
  );
  api.setState(st);
  api.setDrift(0);
  api.renderDay();
  assert(api.el('dayBanner').hidden === true, '连续竞价不显示横幅');
  assert(api.el('sessionNote').hidden === true, '连续竞价不显示休市提示');
  assert(api.el('auctionStrip').hidden === true, '连续竞价不显示虚拟成交价条');
  assert(api.el('dayChip').className === 'day-chip', `徽标回到常态（${api.el('dayChip').className}）`);
  assert(api.el('dayLeft').textContent === '3 分 50 秒', `倒计时 ${api.el('dayLeft').textContent}`);
}

console.log('\n[8] 消息行：盘前/午间/盘后带时段标签，盘中与老数据不带');
{
  const st = mkState(AUCTION_DAY, null);
  st.news = [
    { id: 'N1', t: Date.now(), dir: 1, type: '利好', scope: '全体', stockId: null, stockName: null, text: '盘后公告正文', session: '盘后' },
    { id: 'N2', t: Date.now(), dir: -1, type: '利空', scope: '机构', stockId: '600001', stockName: '大米集团', text: '盘中消息正文', session: '盘中' },
    { id: 'N3', t: Date.now(), dir: 1, type: '利好', scope: '全体', stockId: null, stockName: null, text: '盘前消息正文', session: '盘前' },
    { id: 'N4', t: Date.now(), dir: 1, type: '利好', scope: '全体', stockId: null, stockName: null, text: '无 session 的老数据' },
  ];
  api.setState(st);
  api.renderNews();
  const html = api.el('newsList').innerHTML;
  assert(html.includes('class="nsess">盘后</span>'), '盘后消息带「盘后」标签');
  assert(html.includes('class="nsess">盘前</span>'), '盘前消息带「盘前」标签');
  assert((html.match(/class="nsess"/g) || []).length === 2, `时段标签只渲染 2 个（盘中与老数据不带，实际 ${(html.match(/class="nsess"/g) || []).length}）`);
  assert(html.includes('大盘') && html.includes('大米集团'), '标的标签仍正常（大盘 / 个股）');
  assert(html.includes('npos') && html.includes('nneg'), '利好/利空着色类仍在');
}

console.log('\n[9] 资金指标条：外盘/内盘/净流入/占比与占比条');
{
  const st = mkState(AUCTION_DAY, null);
  st.markets[0].flow = { outerVol: 600, outerAmt: 12060, innerVol: 400, innerAmt: 7960, net: 4100, outerPct: 60.24 };
  api.setState(st);
  api.renderFlow();
  assert(api.el('flowOutVol').textContent === '600股', `外盘量 ${api.el('flowOutVol').textContent}`);
  assert(api.el('flowOutAmt').textContent === '1.21万元', `外盘额 ${api.el('flowOutAmt').textContent}`);
  assert(api.el('flowInVol').textContent === '400股', `内盘量 ${api.el('flowInVol').textContent}`);
  assert(api.el('flowInAmt').textContent === '7960.00元', `内盘额 ${api.el('flowInAmt').textContent}`);
  assert(api.el('flowNet').textContent === '+4100.00元', `净流入带正号 ${api.el('flowNet').textContent}`);
  assert(api.el('flowNet').className === 'up', `净流入红字（${api.el('flowNet').className}）`);
  assert(api.el('flowPct').textContent === '60.24%', `外盘占比 ${api.el('flowPct').textContent}`);
  assert(api.el('flowPct').className === 'up', '外盘占比 >50% 走红字');
  assert(api.el('flowPctSub').textContent === '总成交额 2.00万元', `占比副标题 ${api.el('flowPctSub').textContent}`);
  assert(api.el('flowBarOut').style.width === '60.24%', `占比条外盘宽 ${api.el('flowBarOut').style.width}`);
  assert(api.el('flowBarIn').style.width === '39.76%', `占比条内盘宽 ${api.el('flowBarIn').style.width}`);

  // 净流出：绿字 + 内盘占优
  st.markets[0].flow = { outerVol: 100, outerAmt: 2000, innerVol: 900, innerAmt: 9000, net: -7000, outerPct: 18.18 };
  api.setState(st);
  api.renderFlow();
  assert(api.el('flowNet').textContent === '-7000.00元', `净流出带负号 ${api.el('flowNet').textContent}`);
  assert(api.el('flowNet').className === 'down', '净流出绿字');
  assert(api.el('flowPct').className === 'down', '外盘占比 <50% 走绿字');

  // 当日一笔都没成交：占比无意义，显示 --（不能报 0% 或 50%）
  st.markets[0].flow = { outerVol: 0, outerAmt: 0, innerVol: 0, innerAmt: 0, net: 0, outerPct: null };
  api.setState(st);
  api.renderFlow();
  assert(api.el('flowPct').textContent === '--', `无成交时占比 ${api.el('flowPct').textContent}`);
  assert(api.el('flowPctSub').textContent === '当日暂无成交', `无成交提示「${api.el('flowPctSub').textContent}」`);
  assert(api.el('flowBarOut').style.width === '50%', '占比条各占一半');

  // 老服务端（没有 flow 段）不能报错，保持上一帧的画面即可
  delete st.markets[0].flow;
  api.setState(st);
  api.renderFlow();
  assert(api.el('flowNet').textContent === '+0.00元', '老服务端（无 flow 段）保持上一帧、不抛错');
}

console.log('\n[10] 日线缓存：跨天与进入夜间都要重拉');
{
  // 用可编程 fetch（只记录、不关心响应体），避免覆盖 sandbox.fetch 影响后面的用例
  scriptFetch(() => ({ ok: false }));
  const calls = fetchCalls;
  const dailyCalls = () => calls.filter((c) => String(c.url).includes('/api/daily')).length;

  api.setChartMode('day');
  // 第 14 天盘中：第一次进日线模式 → 拉一次
  api.onState(mkState({ ...AUCTION_DAY, day: 14, phase: 'morning', label: '上午连续竞价', auction: null }, null));
  assert(dailyCalls() === 1, `盘中首帧拉一次日线（${dailyCalls()} 次）`);
  assert(
    api.el('chartSub').textContent === '日线 · 蜡烛 + 成交量 + MA5/10/20/30/60/120/250 + MACD(12,26,9)',
    `日线副标题 ${api.el('chartSub').textContent}`
  );
  // 同一帧反复推：不能再拉（缓存有效）
  api.onState(mkState({ ...AUCTION_DAY, day: 14, phase: 'morning', label: '上午连续竞价', auction: null }, null));
  assert(dailyCalls() === 1, `同一阶段不重复拉（${dailyCalls()} 次）`);
  // 进入夜间：当日那根刚收盘定格 → 必须重拉，否则夜间会用归零的行情拼出假 K 线
  api.onState(mkState({ ...AUCTION_DAY, day: 14, phase: 'night', label: '休市结算', trading: false, auction: null }, null));
  assert(dailyCalls() === 2, `进入夜间重拉一次（${dailyCalls()} 次）`);
  // 跨天：新的一天多一根 → 再拉
  api.onState(mkState({ ...AUCTION_DAY, day: 15, phase: 'auction', label: '开盘集合竞价' }, null));
  assert(dailyCalls() === 3, `跨天重拉一次（${dailyCalls()} 次）`);
  // 分时模式不吃日线：切回分时后不再请求
  api.setChartMode('minute');
  api.onState(mkState({ ...AUCTION_DAY, day: 16, phase: 'auction', label: '开盘集合竞价' }, null));
  assert(dailyCalls() === 3, `分时模式不拉日线（${dailyCalls()} 次）`);
  api.setChartMode('day');
  resetFetch();
}

console.log('\n[10b] 周/月线聚合：日线按交易日号并期，MACD 与副标题跟模式走');
{
  const st = mkState({ ...AUCTION_DAY, day: 16, phase: 'morning', label: '上午连续竞价', auction: null }, null);
  api.setState(st);
  api.setActiveView('trade');
  // 16 根已收盘日线（day 1..16），当日 day=16 不再现拼（缓存里已有）
  const mkBar = (day, o, h, l, c, v) => ({ day, open: o, high: h, low: l, close: c, volume: v, turnover: v * c, net: 0 });
  const dayBars = [];
  for (let d = 1; d <= 16; d++) dayBars.push(mkBar(d, 10 + d, 11 + d, 9 + d, 10.5 + d, 1000 + d));
  api.setDayBars(STOCK, dayBars);
  const market = st.markets[0];

  // ---- 日线原样返回 ----
  api.setChartMode('day');
  const days = api.klineSeriesOf(market);
  assert(days.length === 16, `日线 16 根（${days.length}）`);
  assert(days[0].label == null, '日线不带期号标签（沿用「第 N 天」）');

  // ---- 周线：每 7 个交易日一根（day 1-7 / 8-14 / 15-16）----
  api.setChartMode('week');
  const weeks = api.klineSeriesOf(market);
  assert(weeks.length === 3, `周线 3 根（${weeks.length}）`);
  assert(weeks[0].label === '第1周' && weeks[1].label === '第2周' && weeks[2].label === '第3周',
    `周标签 ${weeks.map((w) => w.label).join(',')}`);
  assert(weeks[0].open === 11 && weeks[0].dayFrom === 1 && weeks[0].dayTo === 7,
    `第1周开=${weeks[0].open} 区间=${weeks[0].dayFrom}-${weeks[0].dayTo}`);
  // 第1周：day7 的 close = 10.5+7 = 17.5；high = max(12..18)=18；low = min(10..16)=10
  assert(weeks[0].close === 17.5 && weeks[0].high === 18 && weeks[0].low === 10,
    `第1周 收=${weeks[0].close} 高=${weeks[0].high} 低=${weeks[0].low}`);
  // 量累加：1001+…+1007 = 7*1001 + (0+…+6) = 7007+21 = 7028
  assert(weeks[0].volume === 7028, `第1周量累加 ${weeks[0].volume}`);
  // 末周只有 day15-16 两根，live 跟随最后一根日线（day16 是缓存里的已收盘根，不 live）
  assert(weeks[2].dayFrom === 15 && weeks[2].dayTo === 16 && !weeks[2].live,
    `第3周 区间=${weeks[2].dayFrom}-${weeks[2].dayTo} live=${weeks[2].live}`);

  // ---- 月线：每 4 周（28 个交易日）一根；16 天只有 1 根 ----
  api.setChartMode('month');
  const months = api.klineSeriesOf(market);
  assert(months.length === 1, `月线 1 根（${months.length}）`);
  assert(months[0].label === '第1月' && months[0].dayFrom === 1 && months[0].dayTo === 16,
    `月标签 ${months[0].label} 区间 ${months[0].dayFrom}-${months[0].dayTo}`);
  assert(months[0].open === 11 && months[0].close === 26.5, `月线开收 ${months[0].open}/${months[0].close}`);

  // ---- 当日现拼的 live 根并进当周/当月 ----
  st.day.day = 17;
  st.markets[0].open = 28;
  st.markets[0].high = 29;
  st.markets[0].low = 27.5;
  st.markets[0].last = 28.2;
  st.markets[0].volume = 500;
  api.setState(st);
  api.setChartMode('week');
  const weeks2 = api.klineSeriesOf(st.markets[0]);
  assert(weeks2.length === 3, `含当日后仍 3 根周线（${weeks2.length}）`);
  assert(weeks2[2].live === true && weeks2[2].dayTo === 17 && weeks2[2].close === 28.2,
    `第3周吸收当日 live 根：live=${weeks2[2].live} dayTo=${weeks2[2].dayTo} 收=${weeks2[2].close}`);

  // ---- 副标题与「当日/5日」显隐 ----
  api.renderChartMode();
  assert(api.el('chartSub').textContent === '周线 · 每 7 个交易日 · 蜡烛 + 成交量 + MA5/10/20/30/60/120/250 + MACD(12,26,9)',
    `周线副标题 ${api.el('chartSub').textContent}`);
  assert(api.el('chartRanges').hidden === true, '周线模式隐藏「当日 / 5 日」');
  api.setChartMode('month');
  api.renderChartMode();
  assert(api.el('chartSub').textContent === '月线 · 每 4 周 · 蜡烛 + 成交量 + MA5/10/20/30/60/120/250 + MACD(12,26,9)',
    `月线副标题 ${api.el('chartSub').textContent}`);

  // ---- 布局含 MACD 带；K 线 MACD 按收盘价算且缓存键跟模式 ----
  const L = api.dayLayout(600, 300, months);
  assert(L.MACD_H > 0 && L.macdTop > L.volTop, `布局有 MACD 带（H=${L.MACD_H} top=${L.macdTop}）`);
  const md1 = api.klineMacdOf(months);
  assert(md1.dif.length === 1, `月线 MACD 根数跟随（${md1.dif.length}）`);
  const mdDay = (() => {
    api.setChartMode('day');
    return api.klineMacdOf(days);
  })();
  assert(mdDay.dif.length === 16, `日线 MACD 16 根（${mdDay.dif.length}）`);
  // 算法与分时共用 computeMacd：手工验一根（2 根收盘价 10.5+1=11.5、10.5+2=12.5）
  const man = api.computeMacd([{ price: 11.5 }, { price: 12.5 }]);
  assert(man.dif.length === 2 && Math.abs(man.hist[1] - 2 * (man.dif[1] - man.dea[1])) < 1e-12,
    'computeMacd 柱 = 2×(DIF−DEA)');

  // ---- 脏 chartMode 回落分时（localStorage 手改成未知值不抛错）----
  api.setChartMode('week');
  api.setChartMode('minute');
  api.renderChartMode();
  assert(api.el('chartRanges').hidden === false, '分时模式恢复「当日 / 5 日」');

  // ================= 10b-2：数据量与口径（实测存档只有 65 根日线 / 4 根月线）=================
  // ---- 日线抓 260 根：序列拿全量，默认窗口只放最近 120 根（可缩放）----
  const long = [];
  for (let d = 1; d <= 260; d++) long.push(mkBar(d, 10, 11, 9, 10 + d * 0.1, 1000));
  api.setDayBars(STOCK, long);
  const stLong = mkState({ ...AUCTION_DAY, day: 260, phase: 'morning', auction: null }, null);
  api.setState(stLong);
  api.setChartMode('day');
  api.resetKlineView();
  const d120 = api.daySeriesOf(stLong.markets[0]);
  assert(d120.length === 260, `日线序列返回全量 260 根（${d120.length} 根，缩放到全量才用得上）`);
  assert(d120[d120.length - 1].day === 260, `末根仍是第 260 天（${d120[d120.length - 1].day}）`);
  const Lday = api.dayLayout(900, 320, d120);
  assert(Lday.count === 120 && Lday.end === 260 && Lday.start === 140,
    `日线默认窗口 = 最近 120 根（start ${Lday.start} / end ${Lday.end}）`);
  api.setChartMode('week');
  const wk260 = api.klineSeriesOf(stLong.markets[0]);
  assert(wk260.length === 38, `周线吃全量 260 根并期（${wk260.length} 根，期望 38）`);
  api.setChartMode('month');
  assert(api.klineSeriesOf(stLong.markets[0]).length === 10, `月线吃全量 260 根并期（期望 10 根）`);

  // ---- 周线周期跟服务端配置走（rules.brokerMeta.weekly.daysPerWeek），不再写死 7 ----
  api.setDayBars(STOCK, dayBars); // 换回 16 根（day 1..16）
  const stPer = mkState({ ...AUCTION_DAY, day: 16, phase: 'morning', auction: null }, null);
  api.setState(stPer);
  assert(api.weekPer() === 7, `配置没下发时回落 7（${api.weekPer()}）`);
  stPer.rules.brokerMeta = { weekly: { daysPerWeek: 5 } };
  api.setState(stPer);
  assert(api.weekPer() === 5, `跟随 daysPerWeek=5（${api.weekPer()}）`);
  api.setChartMode('week');
  const w5 = api.klineSeriesOf(stPer.markets[0]);
  assert(w5.length === 4 && w5[0].dayTo === 5 && w5[3].dayFrom === 16,
    `5 天一周：16 天并 4 根（${w5.length} 根，首周 1-${w5[0].dayTo}、末周 ${w5[3].dayFrom} 起）`);
  api.setChartMode('month');
  assert(api.klineSeriesOf(stPer.markets[0]).length === 1, '5 天一周时「月」= 20 个交易日 → 16 天并 1 根');
  api.setChartMode('week');
  api.renderChartMode();
  assert(api.el('chartSub').textContent === '周线 · 每 5 个交易日 · 蜡烛 + 成交量 + MA5/10/20/30/60/120/250 + MACD(12,26,9)',
    `副标题跟着配置改口（${api.el('chartSub').textContent}）`);
  delete stPer.rules.brokerMeta;
  api.setState(stPer);
  assert(api.weekPer() === 7, '配置被摘掉后回落 7');

  // ---- 手机画布 238px（减 4px 内外边距 = 230）三带都要留得下，价格区不能被压没 ----
  const Lm = api.dayLayout(360, 230, wk260);
  assert(Lm.priceH >= 100, `手机价格区高度 ${Lm.priceH.toFixed(1)}px（≥100）`);
  assert(Lm.volTop >= Lm.PAD_T + Lm.priceH && Lm.macdTop >= Lm.volTop + Lm.VOL_H, '价格 / 量 / MACD 三带不重叠');
  assert(Math.abs(Lm.macdTop + Lm.MACD_H - (230 - Lm.PAD_B)) < 1e-9,
    `MACD 带底部正好抵住 PAD_B（${(Lm.macdTop + Lm.MACD_H).toFixed(2)} vs ${230 - Lm.PAD_B}）`);

  // ---- K 线 MACD 不缓存：根数与末根收盘都没变、只改中间那根，也必须重算 ----
  api.setChartMode('day');
  const s1 = dayBars.map((b) => ({ ...b }));
  const a1 = api.klineMacdOf(s1);
  const s2 = s1.map((b) => ({ ...b }));
  s2[1].close += 5; // 根数不变、末根收盘不变
  const a2 = api.klineMacdOf(s2);
  assert(Math.abs(a1.dif[1] - a2.dif[1]) > 1e-6,
    `中间根改写后 MACD 要重算（${a1.dif[1].toFixed(4)} → ${a2.dif[1].toFixed(4)}）`);
  assert(Math.abs(a1.dif[1] - api.klineMacdOf(s1).dif[1]) < 1e-12, '同一份序列重算结果稳定');

  // ================= 10b-3：均线组（5/10/20/30/60/120/250，日周月共用）=================
  // ---- 周期清单与配色：七条，颜色两两不同（同色两根线叠在一起就分不清了）----
  const periods = api.maPeriods();
  assert(periods.join(',') === '5,10,20,30,60,120,250', `均线七条且有序（${periods.join(',')}）`);
  const colors = api.maColors();
  assert(new Set(colors).size === colors.length, `七条均线颜色互不相同（${colors.length} 个色值）`);

  // ---- movingAvg：手工验算 + 不足周期留空 + 小数周期不许整条消失 ----
  const closes = [1, 2, 3, 4, 5, 6];
  const mv = (arr, p) => api.movingAvg(arr.map((x) => ({ close: x })), p);
  const mv3 = mv(closes, 3);
  assert(mv3[0] === null && mv3[1] === null, 'MA3 前两根留空（不画）');
  assert(Math.abs(mv3[2] - 2) < 1e-12 && Math.abs(mv3[5] - 5) < 1e-12,
    `MA3 逐根均值（第 3 根 ${mv3[2]}、第 6 根 ${mv3[5]}）`);
  assert(mv(closes, 2.4)[2] !== null && Math.abs(mv(closes, 2.4)[2] - 2.5) < 1e-9,
    '小数周期取整成 2（2.4 → MA2），不会整条变空');

  // ---- 日线：与 klineSeriesOf 逐根对齐，窗口就是名义周期 ----
  api.setDayBars(STOCK, dayBars); // 16 根（day 1..16）
  const stMa = mkState({ ...AUCTION_DAY, day: 16, phase: 'morning', auction: null }, null);
  api.setState(stMa);
  const mMa = stMa.markets[0];
  api.setChartMode('day');
  const dBars = api.klineSeriesOf(mMa);
  const dMa5 = api.klineMaOf(mMa, 5);
  assert(dMa5.arr.length === dBars.length, `日线均线与 K 线等长（${dMa5.arr.length} vs ${dBars.length}）`);
  assert(dMa5.approx === false && dMa5.note === '', '日线均线是精确值（不标 ≈、无 note）');
  assert(dMa5.window === 5 && dMa5.nominal === 5, `日线窗口 = 名义周期（${dMa5.window}/${dMa5.nominal}）`);
  const want5 = (dBars[15].close + dBars[14].close + dBars[13].close + dBars[12].close + dBars[11].close) / 5;
  assert(Math.abs(dMa5.arr[15] - want5) < 1e-12, `日线 MA5 末根 = 最近 5 根收盘均价（${dMa5.arr[15].toFixed(4)}）`);
  assert(dMa5.arr[3] === null && dMa5.arr[4] !== null, '日线第 5 根才开始有 MA5');
  // 日线序列拿全量 260 根，均线按全量算（窗口只是「画哪几根」，不影响指标精度）
  api.setDayBars(STOCK, long);
  api.setState(stLong);
  api.setChartMode('day');
  const mLong = stLong.markets[0];
  const dMa120 = api.klineMaOf(mLong, 120);
  const dMa250 = api.klineMaOf(mLong, 250);
  assert(dMa120.arr[119] !== null && dMa120.arr[118] === null, '日线 MA120 从第 120 根起有值');
  assert(dMa250.arr[249] !== null && dMa250.arr[248] === null,
    '日线 260 根时 MA250 从第 250 根起有值（不再整条空）');

  // ---- 周线：展开成交易日平滑，窗口被截短时标 ≈ 并写明实际/名义窗口 ----
  api.setChartMode('week');
  const wBars = api.klineSeriesOf(mLong); // 260 天 → 38 根周线
  assert(wBars.length === 38, `周线 38 根（${wBars.length}）`);
  const wMa250 = api.klineMaOf(mLong, 250);
  // 名义 250 周 = 1750 个交易日，只有 260 根 → 截到全量 260
  assert(wMa250.nominal === 1750, `周线 MA250 名义窗口 = 250×7 = 1750（${wMa250.nominal}）`);
  assert(wMa250.window === 260, `周线 MA250 实际窗口截到全量日线 260（${wMa250.window}）`);
  assert(wMa250.approx === true, '周线 MA250 样本不足 → 标 ≈');
  assert(/按 260 个交易日计（名义 1750）/.test(wMa250.note), `周线 MA250 写明实际窗口（${wMa250.note}）`);
  assert(wMa250.arr.length === 38, `周线 MA250 与 K 线等长（${wMa250.arr.length}）`);
  const allCloses = long.map((b) => b.close);
  const meanAll = allCloses.reduce((s, x) => s + x, 0) / allCloses.length;
  assert(Math.abs(wMa250.arr[37] - meanAll) < 1e-9,
    `周线 MA250 末根 = 全量 260 日均价（${wMa250.arr[37].toFixed(4)} vs ${meanAll.toFixed(4)}）`);
  // MA20(周)：38 根周线够 20 根 → 走严格并期（比日线平滑准），窗口就是名义的 20 期
  const wMa20 = api.klineMaOf(mLong, 20);
  assert(wMa20.nominal === 140, `周线 MA20 名义 = 20×7 = 140 个交易日（${wMa20.nominal}）`);
  assert(wMa20.window === 20 && wMa20.approx === false,
    `周线 MA20 样本够 20 期 → 严格并期、不标 ≈（window ${wMa20.window}）`);
  assert(wMa20.arr[37] !== null && wMa20.arr[18] === null && wMa20.arr[19] !== null,
    '周线 MA20 从第 20 根起才有值');
  const wStrict20 = api.movingAvg(wBars, 20);
  assert(Math.abs(wMa20.arr[37] - wStrict20[37]) < 1e-12,
    `周线 MA20 末根 = 严格并期（${wMa20.arr[37].toFixed(4)}）`);
  // 5 周 = 35 个交易日，38 根周线够 → 同样是严格并期
  const wMa5 = api.klineMaOf(mLong, 5);
  assert(wMa5.window === 5 && wMa5.approx === false, `周线 MA5 走严格并期（window ${wMa5.window}）`);
  assert(wMa5.arr[37] !== null && wMa5.arr[36] !== null, '周线 MA5 尾部两根都有值');
  assert(wMa5.arr[3] === null && wMa5.arr[4] !== null, '周线第 5 根才开始有 MA5');

  // ---- 月线：4 周一期，MA20 名义 560 天 > 260，一律 ≈ ----
  api.setChartMode('month');
  const moBars = api.klineSeriesOf(mLong);
  assert(moBars.length === 10, `260 天并 10 根月线（${moBars.length}）`);
  const moMa20 = api.klineMaOf(mLong, 20);
  assert(moMa20.nominal === 560, `月线 MA20 名义 = 20×28 = 560（${moMa20.nominal}）`);
  assert(moMa20.arr.length === moBars.length, `月线均线与 K 线等长（${moMa20.arr.length} vs ${moBars.length}）`);
  // 10 根月线算不出真 MA20（要 20 期）；退回日线窗口 → 实际只有 260 天，必须标 ≈ 并写明
  assert(moMa20.approx === true && moMa20.window === 260, `月线 MA20 用 260 个交易日、标 ≈（window ${moMa20.window}）`);
  assert(moMa20.note === '按 260 个交易日计（名义 560）', `月线 MA20 写明实际/名义窗口（${moMa20.note}）`);
  assert(moMa20.arr[9] !== null, '月线 MA20 末根有值（否则图例里这条线等于不存在）');
  // 月线 MA5：10 根够 5 期 → 严格并期
  const moMa5 = api.klineMaOf(mLong, 5);
  assert(moMa5.approx === false && moMa5.window === 5 && moMa5.arr[9] !== null,
    `月线 MA5 走严格并期（window ${moMa5.window}）`);

  // ---- 七条均线都进得了绘制流程（桩画布是 noop，只要求不抛异常、能跑到最后）----
  api.setChartMode('week');
  api.renderChartMode();
  let drew = false;
  try {
    api.drawChart();
    drew = true;
  } catch (e) {
    drew = false;
    console.log('    周线绘制抛异常：' + e.message);
  }
  assert(drew, '周线七条均线能画完（不抛异常）');
  assert(/MA5\/10\/20\/30\/60\/120\/250/.test(api.el('chartSub').textContent),
    `副标题列出全部均线（${api.el('chartSub').textContent}）`);

  // ---- 十字光标：均线一行按 class 上色（CSP 禁内联 style）----
  api.setChartMode('day');
  api.setState(stLong);
  api.dayCrosshair(mLong, { width: 900, height: 320, left: 0, top: 0 }, 400, 100);
  const tipHtml = api.crosshairHtml();
  assert(/ma-c5|ma-c\d+/.test(tipHtml), `十字光标带上均线一行（${tipHtml.slice(-160)}）`);
  assert(!/style=/.test(tipHtml), '均线颜色走 class，不用内联 style（CSP style-src self）');

  // ================= 10b-4：缩放 / 平移（滚轮 + 拖动 + 双击复位）=================
  api.setChartMode('day');
  api.setState(stLong);
  api.setActiveView('trade');
  api.resetKlineView();
  const plotCenter = 8 + (900 - 8 - 58) / 2;

  // ---- 放大一格：根数 120 → 96，光标（画布中心）下那根不动 ----
  const L0 = api.dayLayout(900, 320, d120);
  const okZoom = api.zoomKline(d120, -1, plotCenter, 900);
  const L1 = api.dayLayout(900, 320, d120);
  assert(okZoom && L1.count === 96, `放大一格：120 → 96 根（${L1.count}）`);
  assert(Math.abs(L1.start + L1.count / 2 - (L0.start + L0.count / 2)) < 0.51,
    `缩放围绕光标：中心下标 ${L0.start + L0.count / 2} → ${L1.start + L1.count / 2}`);

  // ---- 缩小到底 = 全量；放大到底 = KVIEW_MIN_BARS ----
  for (let k = 0; k < 40; k++) api.zoomKline(d120, 1, plotCenter, 900);
  const Lall = api.dayLayout(900, 320, d120);
  assert(Lall.count === 260 && Lall.start === 0 && Lall.offset === 0,
    `一直缩小能铺满全量（count ${Lall.count} / start ${Lall.start} / offset ${Lall.offset}）`);
  for (let k = 0; k < 20; k++) api.zoomKline(d120, -1, plotCenter, 900);
  const Lmin = api.dayLayout(900, 320, d120);
  assert(Lmin.count === api.kviewMin(), `一直放大夹在最少 ${api.kviewMin()} 根（${Lmin.count}）`);
  assert(Lmin.slot > 20, `放大后每根 ~${Lmin.slot.toFixed(1)}px（蜡烛才画得开）`);
  assert(api.klineSeriesOf(mLong).length === 260, '缩放不改数据，序列还是 260 根');

  // ---- offset 越界夹回：右端最多丢到 total−count（再丢左边就空了）----
  api.setKView(40, 5000);
  const Lp = api.dayLayout(900, 320, d120);
  assert(Lp.count === 40 && Lp.offset === 220 && Lp.end === 40 && Lp.start === 0,
    `offset 夹到 total−count（offset ${Lp.offset} / end ${Lp.end}）`);
  api.setKView(40, 30);
  const Lh = api.dayLayout(900, 320, d120);
  assert(Lh.end === 230 && Lh.start === 190, `翻历史：右端丢 30 根（${Lh.start}–${Lh.end}）`);

  // ---- y 轴只看窗口内的根：窗口外的历史尖刺不该把放大后的图拉平 ----
  const spike = long.map((b, i) => (i === 5 ? { ...b, high: 999, low: 0.01 } : { ...b }));
  api.setKView(40, 0);
  const Ls = api.dayLayout(900, 320, spike);
  assert(Ls.hi < 100 && Ls.lo > 0.01, `y 轴按窗口取范围（lo ${Ls.lo.toFixed(2)} / hi ${Ls.hi.toFixed(2)}）`);

  // ---- 拖动平移：真的走一遍 pointerdown → pointermove → pointerup ----
  api.resetKlineView();
  const beforeCount = api.dayLayout(800, 320, d120).count;
  const beforeOffset = api.dayLayout(800, 320, d120).offset;
  fire('chart', 'pointerdown', { button: 0, pointerId: 1, clientX: 400, clientY: 100, preventDefault() {} });
  fire('chart', 'pointermove', { pointerId: 1, clientX: 402, clientY: 100 }); // 手抖 2px：不算拖动
  assert(api.dayLayout(800, 320, d120).offset === beforeOffset, '手抖 2px 不触发平移');
  fire('chart', 'pointermove', { pointerId: 1, clientX: 460, clientY: 100 });
  const dragged = api.viewOf();
  const Ldrag = api.dayLayout(800, 320, d120);
  assert(dragged.offset > 0 && Ldrag.end < 260,
    `往右拖 60px 看更早的（offset ${dragged.offset} / 末根 ${Ldrag.end - 1}）`);
  assert(Ldrag.count === beforeCount, `拖动只平移，不改缩放（根数 ${Ldrag.count} 不变）`);
  fire('chart', 'pointerup', { pointerId: 1 });
  assert(api.dayLayout(800, 320, d120).offset === dragged.offset, '松手后视窗停住');

  // ---- 滚轮：上滚放大、下滚缩小 ----
  const c0 = api.dayLayout(800, 320, d120).count;
  const prevented = { flag: false };
  fire('chart', 'wheel', { deltaY: -120, clientX: 400, clientY: 100, preventDefault() { prevented.flag = true; } });
  assert(prevented.flag, '滚轮阻止了页面滚动（passive:false）');
  assert(api.dayLayout(800, 320, d120).count < c0, `上滚放大：${c0} → ${api.dayLayout(800, 320, d120).count} 根`);
  fire('chart', 'dblclick', {});
  assert(api.viewOf().count === 0 && api.viewOf().offset === 0, '双击复位成默认视图');

  // ---- 「复位」按钮与默认窗口随模式各记一份 ----
  api.setKView(30, 5);
  const dayKept = api.viewOf();
  api.setChartMode('week');
  const wv = api.viewOf();
  assert(wv.count === 0 && wv.offset === 0, '周线有自己的视窗（不受日线缩放影响）');
  const wLayout = api.dayLayout(800, 320, api.klineSeriesOf(mLong));
  assert(wLayout.count === wLayout.total, `周线默认看全量（${wLayout.count} 根）`);
  api.setKView(20, 0);
  assert(api.dayLayout(800, 320, api.klineSeriesOf(mLong)).count === 20, '周线也能缩到 20 根');
  api.setChartMode('day');
  assert(api.viewOf().count === dayKept.count && api.viewOf().offset === dayKept.offset,
    '切回日线还是刚才那段（按模式各记一份）');

  // ---- DOM：按钮组只在 K 线模式出现 ----
  api.setChartMode('day');
  api.renderChartMode();
  assert(api.el('chartZoom').hidden === false, '日线模式显示缩放按钮组');
  api.setChartMode('minute');
  api.renderChartMode();
  assert(api.el('chartZoom').hidden === true, '分时模式隐藏缩放按钮组');
  const idxHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(idxHtml.indexOf('id="chartZoom"') > 0, 'HTML 里有 #chartZoom');
  assert((idxHtml.match(/data-zoom="/g) || []).length === 3, '缩放组三个按钮（−/+/复位）');

  api.setChartMode('minute');
  api.setDayBars(STOCK, dayBars);
  api.setState(stMa);
}

// ---- 券商 UI：卡片墙 / 我的券商卡 / 席位 / 追保预警 / 提前消息 ----
const BROKERS = [
  ['zhongxin', '钟信证券', '钟信', 52, 'heavy', '重罚'],
  ['huatai', '滑泰证券', '滑泰', 34, 'light', '轻罚'],
  ['zhaoshang', '招伤证券', '招伤', 28, 'normal', '中性'],
  ['tianfeng', '天疯证券', '天疯', 16, 'subsidy', '补贴'],
  ['haitong', '嗨通证券', '嗨通', 22, 'normal', '中性'],
  ['dongfeng', '东风财富', '东风', 68, 'heavy', '重罚'],
].map(([key, name, abbr, crowdPct, crowdTier, crowdLabel]) => ({
  key,
  name,
  abbr,
  persona: name + '的人设',
  slogan: name + '口号',
  color: '#123456',
  scale: '中',
  virtualClients: 1000,
  crowd: crowdPct / 100,
  crowdPct,
  crowdTier,
  crowdLabel,
  crowdFeeMul: 1,
  crowdLendMul: 1,
  icon: 'broker-' + key + '.png',
  strengths: [name + '的强项'],
  costs: [name + '的代价'],
  suitable: '适合谁',
  preview: {
    feeRate: 0.0002,
    cooldownMs: 2000,
    lockMs: 10000,
    leverage: 2,
    financeRatio: 0.5,
    maintenance: 0.3,
    lendCapacityPct: 90,
    newsLeadMs: key === 'zhaoshang' ? 3000 : 0,
    autoSlots: 2,
    autoMax: 20,
    openGift: 0,
    freeCouponPerDay: key === 'zhaoshang' ? 1 : 0,
    forbidStocks: key === 'tianfeng' ? ['600006', '600010'] : [],
  },
}));

console.log('\n[11] 券商：开户卡片墙');
{
  const meta = {};
  for (const b of BROKERS) meta[b.key] = b;
  meta.__selected = { dongfeng: 3 };
  meta.__weekly = { key: 'zhaoshang', nextKey: 'tianfeng' };
  api.setBrokers(meta);
  api.setPicked('huatai');
  api.renderBrokerWall();
  api.renderBrokerWeeklyHint();
  const html = api.el('brokerWall').innerHTML;
  assert((html.match(/class="broker-card/g) || []).length === 6, '六张卡片都渲染出来');
  assert(html.indexOf('/img/broker-zhongxin.png') >= 0, '图标按 key 拼路径');
  assert(html.indexOf('已选') < 0 || html.indexOf('broker-card on') >= 0, '选中项带 on 类');
  assert(html.indexOf('data-bk="huatai"') >= 0 && /data-bk="huatai"[^>]*class|class="broker-card on" data-bk="huatai"/.test(html), '选中态落在挑中的那家');
  assert(html.indexOf('拥挤度 68%') >= 0, '东风拥挤度按元数据渲染（不参与计算，只展示）');
  assert(html.indexOf('重罚') >= 0 && html.indexOf('补贴') >= 0, '拥挤度档位标签渲染');
  assert(html.indexOf('本服 3 人已选') >= 0, '展示层用真实已选人数');
  assert(html.indexOf('本周之星') >= 0, '当周之星角标渲染');
  assert(html.indexOf('style=') < 0, '卡片里没有内联 style（CSP 禁）');
  const hint = api.el('brokerWeeklyHint').textContent;
  assert(hint.indexOf('招伤证券') >= 0 && hint.indexOf('佣金减半') >= 0, `本周之星提示：${hint}`);
  // 没拉到元数据时不能报错
  api.setBrokers({});
  api.renderBrokerWall();
  assert(api.el('brokerWall').innerHTML.indexOf('加载中') >= 0, '元数据未就绪时给出提示而不是空白/报错');

  const meta2 = {};
  for (const b of BROKERS) meta2[b.key] = b;
  meta2.__selected = {};
  meta2.__weekly = { key: 'zhaoshang', nextKey: 'tianfeng' };
  api.setBrokers(meta2);
}

console.log('\n[12] 券商：我的券商卡');
{
  const bk = {
    key: 'zhaoshang',
    name: '招伤证券',
    abbr: '招伤',
    star: 3,
    starMax: 5,
    intensity: 75,
    crowd: 0.28,
    crowdPct: 28,
    crowdTier: 'normal',
    crowdLabel: '中性',
    feeRate: 0.0002,
    cooldownMs: 2000,
    lockMs: 10000,
    financeRatio: 0.5,
    leverage: 2,
    marginRatio: 0.5,
    maintenance: 0.3,
    lendCapacityPct: 60,
    lendRateMul: 1.4,
    autoMax: 20,
    autoSlots: 2,
    newsVipLeadMs: 2250,
    newsVipVisible: false,
    features: {},
    privileges: [{ key: 'news', label: '消息提前量', now: '2.3s', full: '3.0s', pct: 75 }],
    progress: { star: 3, next: 4, volume: 2e7, volumeNeed: 8e7, profit: 1e5, profitNeed: 5e5, noLiquidation: true, liquidations: 0, cancelRate: 0 },
    weekly: { key: 'zhongxin', nextKey: 'huatai', isStar: false, feeMul: 1, financeBonus: 0, weekEndDay: 7 },
    coupon: { perDay: 1, available: true, active: false, usedDay: null },
    transfer: { feeRate: 0.001, feeCap: 50000, freeReselectUsed: false, options: [{ key: 'zhongxin', ok: true, free: false, fee: 1000, reason: '' }] },
    stats: { volume: 2e7, profitBase: 0, liquidations: 0, orders: 10, cancels: 1 },
  };
  api.setState(mkState({ ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null }, null));
  api.setState(
    Object.assign(mkState({ ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null }, null), {
      account: Object.assign(
        mkState({}, null).account,
        { equity: 1234567, broker: bk, marginCall: null }
      ),
      players: [
        { name: 'me', equity: 1234567, broker: 'zhaoshang', brokerRank: 2, star: 3 },
        { name: 'other', equity: 900000, broker: 'zhaoshang', brokerRank: 1, star: 1 },
        { name: 'third', equity: 500000, broker: null, brokerRank: 1, star: 1 },
      ],
      brokerBoard: [
        { key: 'zhaoshang', name: '招伤证券', abbr: '招伤', clients: 2, equity: 2134567, top: 'other', rank: 1 },
        { key: 'huatai', name: '滑泰证券', abbr: '滑泰', clients: 0, equity: 0, top: null, rank: 2 },
      ],
    })
  );
  api.renderMyBroker();
  const html = api.el('myBrokerCard').innerHTML;
  assert(html.indexOf('招伤证券') >= 0, '卡片显示券商名');
  assert((html.match(/★/g) || []).length >= 5, '渲染星级（满级位也占位）');
  assert(html.indexOf('拥挤度 28%') >= 0, '显示拥挤度');
  assert(html.indexOf('特权强度 75%') >= 0, '显示当前特权强度');
  assert(html.indexOf('消息提前量') >= 0 && html.indexOf('满额 3.0s') >= 0, '特权清单带满额对照');
  assert(html.indexOf('60%') >= 0 && html.indexOf('券息 ×1.4') >= 0, '券源与券息倍率都显示');
  assert(html.indexOf('距 4★') >= 0, '显示下一星进度');
  assert(html.indexOf('用免息券') >= 0, '有免息券按钮');
  assert(
    html.indexOf('本周之星') >= 0 && html.indexOf('钟信证券') >= 0 && html.indexOf('下周') >= 0,
    '显示本周之星（非本家时给出下周轮换）'
  );
  assert(html.indexOf('style=') < 0, '没有内联 style（CSP 禁，进度条宽度走 CSSOM）');

  // 未开户时不能报错
  api.setState(
    Object.assign(mkState({ ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null }, null), {
      account: Object.assign(mkState({}, null).account, { broker: null }),
    })
  );
  api.renderMyBroker();
  assert(api.el('myBrokerCard').innerHTML.indexOf('未开户') >= 0, '未开户时显示占位而不是报错');

  // 排行行带券商与组内名次
  api.setState(
    Object.assign(mkState({ ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null }, null), {
      rules: Object.assign(mkState({}, null).rules, { initialCash: 1000000 }),
      players: [
        { name: 'other', equity: 900000, broker: 'zhaoshang', brokerRank: 1, star: 1 },
        { name: 'third', equity: 500000, broker: null, brokerRank: 1, star: 1 },
      ],
    })
  );
  const rank = api.rankRowsHtml();
  assert(rank.indexOf('组内 #1') >= 0, '玩家总榜带组内名次');
  assert(rank.indexOf('未开户') >= 0, '无券商的行标未开户');
}

console.log('\n[13] 席位：五档图标 / 逐笔席位 / 席位榜 / 龙虎榜');
{
  assert(api.seatHtml(null).indexOf('none') >= 0, '没有席位时显示 --');
  const s = api.seatHtml('dongfeng');
  assert(s.indexOf('/img/broker-dongfeng-96.png') >= 0, '席位小图标走 96px 缩略图（高频位置不用 1024 原图）');
  assert(s.indexOf('东风') >= 0, '席位必须带两字简称（招伤/东风的红与涨红同色，只靠颜色会误读）');

  const seats = {
    rows: [
      { key: 'zhaoshang', abbr: '招伤', name: '招伤证券', buyAmt: 1e7, sellAmt: 2e6, net: 8e6, pct: 40, rank: 1 },
      { key: 'dongfeng', abbr: '东风', name: '东风财富', buyAmt: 1e6, sellAmt: 5e6, net: -4e6, pct: 30, rank: 2 },
    ],
    surge: true,
    changePct: 8.12,
    total: 2e7,
    top: { buy: [{ key: 'zhaoshang', abbr: '招伤', amt: 1e7 }], sell: [{ key: 'dongfeng', abbr: '东风', amt: 5e6 }] },
  };
  const st = mkState({ ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null }, null);
  st.markets[0].seats = seats;
  st.account = Object.assign(st.account, { broker: { key: 'zhaoshang' } });
  api.setState(st);
  api.renderSeats();
  const body = api.el('seatBody').innerHTML;
  assert(body.indexOf('招伤证券') >= 0 && body.indexOf('东风财富') >= 0, '席位榜渲染券商名');
  assert(body.indexOf('row-mine') >= 0, '我的席位高亮');
  assert(body.indexOf('seat-net pos') >= 0 && body.indexOf('seat-net neg') >= 0, '净买入按正负着色');
  assert(api.el('seatMeta').innerHTML.indexOf('我的席位：招伤') >= 0, '标题栏标出我的席位');
  assert(api.el('surgeWrap').hidden === false, '涨跌超 7% 时龙虎榜展开');
  assert(api.el('surgeBuyBody').innerHTML.indexOf('招伤') >= 0, '龙虎榜买入前五席位');

  // 涨幅不足 → 不披露龙虎榜
  st.markets[0].seats = Object.assign({}, seats, { surge: false, changePct: 1.2 });
  delete st.markets[0].seats.top;
  api.setState(JSON.parse(JSON.stringify(st)));
  api.renderSeats();
  assert(api.el('surgeWrap').hidden === true, '涨幅不足 ±7% 不披露龙虎榜');
  // 老服务端没有 seats 段
  const old = mkState({ ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null }, null);
  api.setState(old);
  api.renderSeats();
  assert(api.el('seatBody').innerHTML.indexOf('暂无') >= 0, '老服务端（无 seats 段）不报错');
}

console.log('\n[14] 追保预警与提前消息');
{
  const st = mkState({ ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null }, null);
  api.setState(st);
  api.renderMarginCall();
  assert(api.el('marginCallBanner').hidden === true, '没有预警时横幅隐藏');
  st.account = Object.assign(st.account, {
    marginCall: { broker: 'zhaoshang', name: '招伤证券', stockName: '大米集团', maintenance: 0.3, trigger: 0.25, exposure: 1e6, need: 50000, left: 20000, side: 'short' },
  });
  api.setState(JSON.parse(JSON.stringify(st)));
  api.renderMarginCall();
  const banner = api.el('marginCallBanner');
  assert(banner.hidden === false, '跌破维持线时出现追保横幅');
  const txt = api.el('marginCallText').textContent;
  assert(txt.indexOf('追加保证金') >= 0 && txt.indexOf('大米集团') >= 0, `追保文案带上股票：${txt.slice(0, 40)}…`);
  assert(txt.indexOf('再跌') >= 0, '给出距强平的最后一档空间');

  // 泄露期异动提示
  api.setState(
    Object.assign(mkState({ ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null }, null), {
      newsHints: [{ stockId: STOCK, name: '大米集团', text: '大米集团 出现大额资金异动', leftMs: 3200 }],
      news: [],
    })
  );
  const hints = api.newsHintsHtml();
  assert(hints.indexOf('大额资金异动') >= 0, '泄露期给出模糊异动提示（不点方向/原因/是谁）');
  assert(hints.indexOf('距公开约 3 秒') >= 0, '提示带公开倒计时');
  assert(hints.indexOf('利好') < 0 && hints.indexOf('利空') < 0, '提示里不含方向');
  // 提前拿到的消息：未满 4★ 带 masked，满 5★ 给方向
  const early = api.newsRowsHtml([
    { id: 'E1', t: Date.now(), dir: 0, type: '未明', scope: '机构', power: 0, stockId: STOCK, stockName: '大米集团', text: '【大米集团】出现未公开信息，方向待确认', until: Date.now() + 3000, publicAt: Date.now() + 3000, early: true, masked: true },
    { id: 'E2', t: Date.now(), dir: 1, type: '利好', scope: '机构', power: 0.5, stockId: STOCK, stockName: '大米集团', text: '【大米集团】利好', until: Date.now() + 60000, early: true },
  ]);
  assert(early.indexOf('未公开') >= 0, '未满 4★ 的提前消息标「未公开」且无方向');
  assert(early.indexOf('nearly') >= 0, '提前条目左侧有强调');
  assert(early.indexOf('提前') >= 0, '5★ 的提前消息标「提前」并带方向');
}

console.log('\n[15] 彩蛋：toast / 横幅 / 队列 / seq 去重与进度卡');
{
  // ---- seq 去重：首次进入从当前水位起步，不补播历史 ----
  const mkEggs = (seq, events, extra = {}) =>
    Object.assign(
      {
        enabled: true,
        seq,
        events,
        count: 0,
        titles: [],
        title: null,
        peakEquity: 1000000,
        drawdown: 0,
        maxDrawdown: 0,
        progress: null,
      },
      extra
    );
  const ev = (id, seq, level, rarity, kind) => ({
    id,
    seq,
    day: 3,
    t: Date.now(),
    kind,
    level,
    rarity,
    title: `称号${id}`,
    text: `文案${id}`,
    mascot: 'smug',
  });

  assert(api.eggState().lastSeq === null, '初始还没读过 localStorage 的水位');
  api.pumpEggs(mkEggs(9, [ev('A01', 8, 'L2', 'common', 'wealth')]));
  assert(api.eggState().lastSeq === 9, '首次进入把水位记成当前 seq');
  assert(api.eggState().queued === 0, '首次进入不补播历史事件（陈年横幅不糊脸）');
  assert(api.eggState().busy === false && api.el('eggHead').textContent === '', '首次进入不弹横幅（横幅位空着，标题从没被写过）');

  assert(api.eggSeqStored() === 9, '水位落进 localStorage（刷新不重播）');

  // ---- L1 走 toast，不占横幅位 ----
  api.pumpEggs(mkEggs(10, [ev('B1-01', 10, 'L1', 'common', 'crash')]));
  assert(api.eggState().queued === 0, 'L1 事件直接播完，不进横幅队列');
  assert(api.eggState().busy === false, 'L1 不占用横幅位');

  // ---- L2 及以上走横幅：猫头像 + 稀有度配色 ----
  api.pumpEggs(mkEggs(11, [ev('A07', 11, 'L3', 'rare', 'wealth')]));
  const b = api.el('eggBanner');
  assert(b.hidden === false, 'L2/L3 弹出横幅');
  assert(b.className.indexOf('rare') >= 0 && b.className.indexOf('wealth') >= 0, `横幅带稀有度与族类：${b.className}`);
  assert(api.el('eggAvatar').src === '/img/egg-cat-smug-96.png', `猫头像走白名单路径：${api.el('eggAvatar').src}`);
  assert(api.el('eggHead').textContent.indexOf('称号A07') >= 0, `标题带称号：${api.el('eggHead').textContent}`);
  assert(api.el('eggText').textContent === '文案A07', '正文用服务端下发的文案');
  assert(api.eggState().busy === true, '横幅占用中');

  // ---- 同一帧来多条：按稀有度降序排队，横幅收起后串行播下一条 ----
  api.pumpEggs(
    mkEggs(13, [ev('B2-04', 12, 'L4', 'legend', 'crash'), ev('A03', 13, 'L2', 'common', 'wealth')])
  );
  assert(api.eggState().queued === 2, '横幅忙时新事件进队列等待');
  api.hideEggBanner(); // 模拟自动收起
  assert(api.el('eggBanner').className.indexOf('legend') >= 0, '队列按稀有度降序：传说档先播');
  assert(api.el('eggHead').textContent.indexOf('称号B2-04') >= 0, '先播的是传说档');
  api.hideEggBanner();
  assert(api.el('eggHead').textContent.indexOf('称号A03') >= 0, '串行播下一条');
  assert(api.eggState().queued === 0, '队列播空');
  api.hideEggBanner();
  assert(api.el('eggBanner').hidden === true, '队列空了横幅收起');

  // ---- 已经播过的 seq 不重播（同一帧反复收到也不叠加） ----
  api.pumpEggs(mkEggs(13, [ev('A03', 13, 'L2', 'common', 'wealth')]));
  assert(api.eggState().queued === 0 && api.el('eggBanner').hidden === true, 'seq 不大于水位的事件被丢弃');

  // ---- 主页卡：主徽章只有一个——境界；彩蛋称号降级成 chips（Doc/头衔方案.md §6.2）----
  const st = mkState({ ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null }, null);
  st.rules = Object.assign(st.rules, {
    milestones: { enabled: true, tone: 'savage' },
    realm: { enabled: true },
  });
  st.account = Object.assign(st.account, {
    events: mkEggs(13, [], {
      count: 3,
      titles: [
        { id: 'A01', title: '保本出关', rarity: 'common', level: 'L1', day: 1 },
        { id: 'A05', title: '半个千万', rarity: 'rare', level: 'L2', day: 2 },
      ],
      title: { id: 'A05', title: '半个千万', rarity: 'rare', level: 'L2', day: 2 },
      peakEquity: 5200000,
      drawdown: 0.0615,
      maxDrawdown: 0.18,
      progress: { id: 'A06', title: '八百万', equity: 8000000, from: 5000000, need: 2770000, pct: 0.0733, reached: false },
    }),
    realm: {
      idx: 16,
      name: '结丹后期',
      short: '千万身家',
      honor: '金丹真人',
      group: 'jindan',
      equity: 10320000,
      total: 38,
      peak: { idx: 17, name: '结丹圆满' },
      // 峰值权益跟境界段走（彩蛋段那个 peakEquity 是彩蛋自己的水位，两套数互不相干）
      peakEquity: 13000000,
      next: { idx: 17, name: '结丹圆满', equity: 13000000, need: 2680000, pct: 0.83 },
      pct: 0.83,
      pending: false,
      dropping: false,
      changedDay: 12,
    },
  });
  api.setState(st);
  api.renderEggCard();
  const card = api.el('eggCard');
  assert(card.hidden === false, '有境界段时卡片显示');
  const html = card.innerHTML;
  assert(html.indexOf('结丹后期') >= 0 && html.indexOf('金丹真人') >= 0, '主徽章是境界 + 尊号');
  assert(html.indexOf('距「结丹圆满」') >= 0 && html.indexOf('268.00万元') >= 0, '修为条展示下一境界与还差多少');
  assert(html.indexOf('历史最高 · 结丹圆满') >= 0, '展示历史最高境界（名号不跌）');
  assert(html.indexOf('1300.00万元') >= 0, '展示峰值权益（水位线，吃 realm.peakEquity）');
  assert(html.indexOf('6.2%') >= 0 && html.indexOf('18.0%') >= 0, '展示当前回撤与历史最大回撤');
  assert(html.indexOf('里程碑称号') >= 0 && html.indexOf('保本出关') >= 0, 'A 族称号降级为 chips 但仍列出');
  assert(html.indexOf('data-w="83"') >= 0, '修为条宽度走 data-w（CSP 禁内联 style）');
  assert(card.style.getPropertyValue('--rtone').indexOf('jindan') >= 0, '境界色走 CSS 变量（CSSOM 不受 CSP 限制）');

  // 门槛已达：文案切换成「等收盘确认」
  const st2 = JSON.parse(JSON.stringify(st));
  st2.account.realm.pending = true;
  api.setState(st2);
  api.renderEggCard();
  assert(api.el('eggCard').innerHTML.indexOf('等收盘结算确认') >= 0, '已越过门槛时提示等收盘确认');

  // 跌境缓冲带：卡片给出"今晚会跌境"的预告
  const st2b = JSON.parse(JSON.stringify(st));
  st2b.account.realm.dropping = true;
  api.setState(st2b);
  api.renderEggCard();
  assert(api.el('eggCard').innerHTML.indexOf('道基不稳') >= 0, '踩进缓冲带时提示「道基不稳」');

  // 服务端关掉彩蛋 / 老服务端没有这两个段：卡片隐藏且不报错
  api.setState(mkState(AUCTION_DAY, null));
  api.renderEggCard();
  assert(api.el('eggCard').hidden === true, '两个段都没有时卡片隐藏');
  const st3 = JSON.parse(JSON.stringify(st));
  st3.rules.milestones = { enabled: false };
  st3.rules.realm = { enabled: false };
  api.setState(st3);
  api.renderEggCard();
  assert(api.el('eggCard').hidden === true, '服务端同时关掉彩蛋与境界时卡片隐藏');

  // 老服务端（只有 events、没有 realm）：退回纯彩蛋卡，不报错
  const st4 = JSON.parse(JSON.stringify(st));
  delete st4.account.realm;
  st4.rules.realm = undefined;
  api.setState(st4);
  api.renderEggCard();
  assert(api.el('eggCard').hidden === false && api.el('eggCard').innerHTML.indexOf('当前称号') >= 0, '老服务端退回纯彩蛋卡');

  // 彩蛋关掉、境界开着：称号段与回撤列**整段不渲染**——否则会显示「已获称号 0 个」
  // 「还没有称号」「回撤 0.0%」，把"功能没开"说成"你一个成就都没拿到、一次都没回撤"
  const st5 = JSON.parse(JSON.stringify(st));
  st5.rules.milestones = { enabled: false };
  delete st5.account.events;
  api.setState(st5);
  api.renderEggCard();
  const h5 = api.el('eggCard').innerHTML;
  assert(h5.indexOf('结丹后期') >= 0, '彩蛋关掉后境界段照常显示');
  assert(h5.indexOf('已获称号') < 0 && h5.indexOf('还没有称号') < 0, '彩蛋关掉后不显示称号计数与空态');
  assert(h5.indexOf('回撤') < 0, '彩蛋关掉后不显示回撤（那两个数来自彩蛋段）');
  assert(h5.indexOf('峰值') >= 0 && h5.indexOf('1300.00万元') >= 0, '峰值改吃 account.realm.peakEquity');

  // ---- 顶栏境界徽标：只显示已确认境界，pending / dropping 只换样式 ----
  api.setState(st);
  api.renderRealmChip();
  const chip = api.el('whoRealm');
  assert(chip.hidden === false && chip.innerHTML.indexOf('结丹后期') >= 0, '顶栏徽标显示境界名');
  assert(chip.className.indexOf('g-jindan') >= 0, '徽标带大境界配色类');
  assert(chip.title.indexOf('距结丹圆满') >= 0, 'hover 出下一境界差额');
  api.setState(st2);
  api.renderRealmChip();
  assert(api.el('whoRealm').className.indexOf('pending') >= 0, '越过门槛时徽标加 pending 光晕');
  api.setState(st2b);
  api.renderRealmChip();
  assert(api.el('whoRealm').className.indexOf('dropping') >= 0, '缓冲带里徽标换虚线边');
  api.setState(mkState(AUCTION_DAY, null));
  api.renderRealmChip();
  assert(api.el('whoRealm').hidden === true, '没有境界段时徽标隐藏');

  // 外观没变但权益变了：hover 文案必须跟着刷新（不能为了省 DOM 把 title 一起冻住）
  api.setState(st);
  api.renderRealmChip();
  const st6 = JSON.parse(JSON.stringify(st));
  st6.account.realm.equity = 11000000;
  st6.account.realm.next.need = 2000000;
  api.setState(st6);
  api.renderRealmChip();
  assert(api.el('whoRealm').title.indexOf('1100.00万元') >= 0, '权益变了、外观没变时 hover 文案照样刷新');
  assert(api.el('whoRealm').className.indexOf('g-jindan') >= 0, '外观没被反复重写（类名保持）');

  // ---- CSS 接线：`--rtone` 由 app.js 写、样式表必须真的读 ----
  // 上一版的坑：JS 老老实实 setProperty('--rtone', …)，CSS 里却一条 var(--rtone) 都没有，
  // DOM 断言全绿、真机上卡片一点境界色都没有。这类"写了没人读"只能靠读样式表拦
  const cssRealm = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  assert(/\.realm-name\s*\{[^}]*var\(--rtone/.test(cssRealm), '境界名消费 --rtone');
  assert(/\.realm-honor\s*\{[^}]*var\(--rtone/.test(cssRealm), '尊号消费 --rtone');
  assert(/\.realm-bar \.mb-bar b\s*\{[^}]*var\(--rtone/.test(cssRealm), '修为条消费 --rtone');
  assert(/\.egg-banner\.realm\s*\{[^}]*var\(--rtone/.test(cssRealm), '破境横幅左边线消费 --rtone');
  for (const g of ['mortal', 'lianqi', 'zhuji', 'jindan', 'yuanying', 'huashen', 'lianxu', 'heti', 'dacheng', 'dujie']) {
    assert(cssRealm.indexOf('.realm-chip.g-' + g + ' {') >= 0, `徽标配色类 g-${g} 有样式`);
    assert(cssRealm.indexOf('--realm-' + g + ':') >= 0, `token --realm-${g} 已定义`);
  }
  assert(!/--realm-[a-z]+:\s*var\(--(red|green)/.test(cssRealm), '境界色不借用涨跌 token（--red / --green）');

  // ---- 规则面板「境界」页：整表吃服务端下发的 rules.realm，一个数字都不写死 ----
  api.setState(st);
  api.setRealmLadder({
    mortal: { key: 'mortal', name: '凡骨', honor: '凡骨', tone: 'mortal' },
    // 说明文字里的三个数也走服务端下发：改了配置，规则页不许继续说旧值
    demoteBuffer: 0.05,
    demoteMaxPerDay: 2,
    depositCap: 100000000,
    depositCapTier: '化神圆满',
    groups: [
      { key: 'lianqi', name: '炼气期', honor: '炼气士', tone: 'lianqi' },
      { key: 'jindan', name: '结丹期', honor: '金丹真人', tone: 'jindan' },
    ],
    ladder: [
      { i: 1, group: 'lianqi', name: '炼气一层', short: '初入山门', equity: 900000 },
      { i: 2, group: 'lianqi', name: '炼气二层', short: '持牌散修', equity: 1000000 },
      { i: 16, group: 'jindan', name: '结丹后期', short: '千万身家', equity: 10000000 },
    ],
  });
  const rulesHtml = api.rulesRealmHtml();
  assert(rulesHtml.indexOf('炼气一层') >= 0 && rulesHtml.indexOf('90.00万元') >= 0, '规则页列出境界与门槛');
  assert(rulesHtml.indexOf('你在这里') >= 0, '当前境界高亮「你在这里」');
  assert(rulesHtml.indexOf('凡骨') >= 0, '凡骨作为门槛之下的状态单独一行');
  assert(rulesHtml.indexOf('5%') >= 0 && rulesHtml.indexOf('最多降 2 档') >= 0, '跌境缓冲与降幅上限吃下发值（不写死 3% / 3 档）');
  assert(rulesHtml.indexOf('1.00亿元') >= 0 && rulesHtml.indexOf('化神圆满') >= 0, '加钱上限与对应档位吃下发值（不写死 1 亿）');
  api.setRealmLadder(null);
  assert(api.rulesRealmHtml().indexOf('刷新页面') >= 0, '整表没拉到时给提示而不是空白/报错');

  // ---- 横幅与 toast 的落点：两类 fixed 元素撞同一块位置，横幅 z-index 更高 ----
  // 不让位的话，第一条 toast 会被完全盖住——而那正是 pumpEggQueue 刚 toast 出来的 L1 事件，
  // 也会盖住玩家的成交 / 爆仓提醒
  ['haltBanner', 'dayBanner', 'marginCallBanner'].forEach((id) => {
    api.el(id).hidden = true; // 真实页面里这三条初始带 hidden 属性
  });
  api.pumpEggs(mkEggs(21, [ev('B1-03', 21, 'L1', 'rare', 'crash'), ev('C02', 22, 'L3', 'rare', 'liquidation')]));
  assert(api.el('eggBanner').hidden === false, '同批里 L1 先 toast、L2+ 接着弹横幅');
  assert(api.el('eggHead').textContent.indexOf('称号C02') >= 0, '横幅显示的是 L3 那条');
  assert(api.el('eggBanner').style.top === '60px', `没有状态横幅时落在顶栏下沿（${api.el('eggBanner').style.top}）`);
  assert(api.el('toastWrap').style.top === '132px', `toast 容器让到横幅下沿之外（60+72 → ${api.el('toastWrap').style.top}）`);
  api.hideEggBanner();
  assert(api.el('toastWrap').style.top === '' && api.el('eggBanner').style.top === '', '横幅收起后两处都复位');

  // ---- 状态横幅可见时，彩蛋横幅让到它下面（追保预警这类提示不能被盖住）----
  api.el('marginCallBanner').hidden = false;
  api.el('marginCallBanner').getBoundingClientRect = () => ({ top: 103.6, bottom: 137.7, height: 34.1 });
  api.pumpEggs(mkEggs(23, [ev('C01', 23, 'L2', 'common', 'liquidation')]));
  assert(
    api.el('eggBanner').style.top === '146px',
    `让到追保横幅下沿（137.7 + 8 → 146px，实际 ${api.el('eggBanner').style.top}）`
  );
  assert(api.el('toastWrap').style.top === '218px', `toast 跟着让（146+72 → ${api.el('toastWrap').style.top}）`);
  api.hideEggBanner();
  api.el('marginCallBanner').hidden = true;

  // ---- 手动「收起」必须撤掉自动收起的定时器 ----
  api.pumpEggs(mkEggs(24, [ev('A10', 24, 'L4', 'epic', 'wealth')]));
  const t1 = api.eggTimerInfo();
  assert(!!t1 && t1.delay === 8000 && t1.cleared === false, `L4 横幅挂 8 秒的自动收起定时器（${t1 && t1.delay}）`);
  api.pumpEggs(mkEggs(25, [ev('A12', 25, 'L4', 'legend', 'wealth')]));
  api.hideEggBanner(); // 手动点「收起」
  assert(t1.cleared === true, '手动收起把这一条的定时器一起撤掉了');
  const t2 = api.eggTimerInfo();
  assert(!!t2 && t2.id !== t1.id && t2.cleared === false, '新横幅有自己的定时器（不会被上一条的残留提前掐掉）');
  api.hideEggBanner();

  // ---- 服务端 seq 回退（换存档 / 开新局）= 重起一条事件流 ----
  assert(api.eggSeqStored() === 25, `本地水位推到 25（${api.eggSeqStored()}）`);
  api.pumpEggs(mkEggs(2, [ev('A01', 1, 'L2', 'common', 'wealth')]));
  assert(api.eggSeqStored() === 2, '服务端 seq 比本地小 → 水位跟着回退（不再永久封堵新事件）');
  assert(api.eggState().queued === 0, '回退这一次不补播历史');
  api.pumpEggs(mkEggs(3, [ev('A02', 3, 'L2', 'common', 'wealth')]));
  assert(api.el('eggHead').textContent.indexOf('称号A02') >= 0, '回退之后新事件能正常播');
  api.hideEggBanner();

  // ---- 换号 = 换一条事件流：水位必须跟着清 ----
  api.setIdentity('alice', 'tok-a');
  api.pumpEggs(mkEggs(5, [ev('A01', 5, 'L2', 'common', 'wealth')]));
  assert(api.eggSeqStored() === 5, `alice 的水位记到 5（${api.eggSeqStored()}）`);
  api.setIdentity('', '');
  assert(api.eggSeqStored() === null && api.eggState().lastSeq === null, '换号把水位清掉（内存与 localStorage）');
  api.setIdentity('bob', 'tok-b');
  api.pumpEggs(mkEggs(1, [ev('A01', 1, 'L2', 'common', 'wealth')])); // 首帧只锚水位（与"首次进入不补播"同规矩）
  api.pumpEggs(mkEggs(2, [ev('A02', 2, 'L2', 'common', 'wealth')]));
  assert(api.el('eggHead').textContent.indexOf('称号A02') >= 0, 'bob 的事件照常播（没有继承 alice 的水位）');
  api.hideEggBanner();
}

console.log('\n[16] 主题系统：切换 / 落盘 / 吉祥物换装 / 两个视图都要能重绘');
{
  // ---- 默认（localStorage 没有 gushen_theme）= 深夜终端，html 上不挂 data-theme ----
  api.setTheme('', false);
  assert(api.themeOf() === '' && api.themeAttr() === null, '默认主题不写 html[data-theme]（靠 :root 兜底）');
  assert(api.themeBtnText() === '主题 · 深夜终端', `顶栏按钮显示当前主题名（实际「${api.themeBtnText()}」）`);

  // ---- 切主题三件套：属性 / 落盘 / 按钮文案 ----
  api.setTheme('sakura', true);
  assert(api.themeAttr() === 'sakura', '切主题把 id 写到 html[data-theme]');
  assert(localStorageStub.getItem('gushen_theme') === 'sakura', '切主题落 localStorage（刷新后靠它恢复）');
  assert(api.themeBtnText() === '主题 · 樱色交易所', `顶栏按钮跟着换（实际「${api.themeBtnText()}」）`);

  // ---- 脏值兜底：老存档 / 手改 localStorage 写进未知 id 时回落默认，不抛 ----
  api.setTheme('nope', false);
  assert(api.themeOf() === '' && api.themeAttr() === null, '未知主题 id 回落默认主题');

  assert(api.themes().length === 7, `主题表含默认在内共 7 套（实际 ${api.themes().length}）`);
  assert(api.themes()[1] === 'broker' && api.themes()[4] === 'eyecare' && api.themes()[5] === 'skyblue' && api.themes()[6] === 'magic', '主题表顺序 = 弹窗里的排列顺序（浅色三套排第二行）');

  // ---- 主题 token 完整性：每套主题必须重写同一组 token（漏一个就继承默认深色，浅底上必翻车）----
  const cssAll = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  const themeBlock = (id) => {
    const m = new RegExp('\\[data-theme="' + id + '"\\]\\s*\\{([\\s\\S]*?)\\}').exec(cssAll);
    return m ? m[1] : '';
  };
  const tok = (block, name) => {
    const m = new RegExp('--' + name + '\\s*:\\s*(#[0-9a-fA-F]{6})').exec(block);
    return m ? m[1].toLowerCase() : '';
  };
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const HEX_TOKENS = ['bg', 'panel', 'panel-2', 'line', 'ink', 'muted', 'red', 'green', 'blue', 'gold',
    'grad-a', 'grad-b', 'grad-green-a', 'grad-green-b', 'on-grad'];
  for (const id of ['broker', 'gold', 'sakura', 'eyecare', 'skyblue', 'magic']) {
    const block = themeBlock(id);
    const miss = HEX_TOKENS.filter((t) => !tok(block, t))
      .concat(['float-bg', 'chart-grid'].filter((t) => block.indexOf('--' + t + ':') < 0));
    assert(miss.length === 0, `${id} 主题 token 齐全（缺：${miss.join('/') || '无'}）`);
  }

  // ---- 浅色主题口径：底色真的浅，且字压得住（护眼不是"看着淡"，是能长时间读）----
  for (const id of ['sakura', 'eyecare', 'skyblue']) {
    const bg = tok(themeBlock(id), 'bg');
    assert(lum(bg) >= 0.7, `${id} 是浅底（bg ${bg} · L=${lum(bg).toFixed(2)}）`);
  }
  // 每套浅底都过一遍对比度下限（正文 / 次要字 / 四强调色 / 渐变按钮字 / 金底配字）
  for (const id of ['eyecare', 'skyblue']) {
    const blk = themeBlock(id);
    assert(blk.indexOf('--on-gold:') >= 0, `${id} 自带 --on-gold（暗金底要配浅字）`);
    assert(ratio(tok(blk, 'ink'), tok(blk, 'bg')) >= 7, `${id} 正文对比 ≥7（实际 ${ratio(tok(blk, 'ink'), tok(blk, 'bg')).toFixed(1)}）`);
    assert(ratio(tok(blk, 'muted'), tok(blk, 'panel')) >= 3.8, `${id} 次要字对比 ≥3.8（实际 ${ratio(tok(blk, 'muted'), tok(blk, 'panel')).toFixed(1)}）`);
    for (const t of ['red', 'green', 'blue', 'gold']) {
      const r = ratio(tok(blk, t), tok(blk, 'panel'));
      assert(r >= 4.5, `${id} --${t} 在卡片底上对比 ≥4.5（实际 ${r.toFixed(1)}）`);
    }
    assert(ratio(tok(blk, 'on-grad'), tok(blk, 'grad-b')) >= 4.5, `${id} 渐变按钮文字对比 ≥4.5（实际 ${ratio(tok(blk, 'on-grad'), tok(blk, 'grad-b')).toFixed(1)}）`);
  }
  const eye = themeBlock('eyecare');
  assert(ratio(tok(eye, 'ink'), tok(eye, 'bg')) >= 7, `护眼主题正文对比 ≥7（实际 ${ratio(tok(eye, 'ink'), tok(eye, 'bg')).toFixed(1)}）`);
  assert(ratio(tok(eye, 'muted'), tok(eye, 'panel')) >= 3.8, `护眼主题次要字对比 ≥3.8（实际 ${ratio(tok(eye, 'muted'), tok(eye, 'panel')).toFixed(1)}）`);
  for (const t of ['red', 'green', 'blue', 'gold']) {
    const r = ratio(tok(eye, t), tok(eye, 'panel'));
    assert(r >= 4.5, `护眼主题 --${t} 在卡片底上对比 ≥4.5（实际 ${r.toFixed(1)}）`);
  }
  assert(ratio(tok(eye, 'on-grad'), tok(eye, 'grad-b')) >= 4.5, `护眼主题渐变按钮文字对比 ≥4.5（实际 ${ratio(tok(eye, 'on-grad'), tok(eye, 'grad-b')).toFixed(1)}）`);
  api.setTheme('eyecare', false);
  assert(api.themeBtnText() === '主题 · 护眼纸感', `浅色护眼主题进主题表（实际「${api.themeBtnText()}」）`);

  // ---- 吉祥物：默认跟随主题，二次元主题自带换装 ----
  api.setMascotPick(null);
  api.setTheme('sakura', false);
  assert(api.mascotOf().id === 'sakura', `跟随主题时用该主题的默认吉祥物（实际 ${api.mascotOf().id}）`);
  assert(api.heroMascot().src === '/img/mascot-sakura-256.png' && !api.heroMascot().hidden, '二次元主题换上主页立绘');
  api.setTheme('broker', false);
  assert(api.mascotOf().id === 'cat' && api.heroMascot().hidden, '主题没配吉祥物 → 股神猫，主页立绘隐藏');

  // ---- 自选吉祥物：写进 currentMascot，跨主题保持 ----
  api.setMascotPick('knight');
  api.applyMascot();
  assert(api.mascotOf().id === 'knight' && api.heroMascot().src === '/img/mascot-knight-256.png', '自选吉祥物立刻换装');
  api.setTheme('magic', false);
  assert(api.mascotOf().id === 'knight', '自选吉祥物不被后来的主题切走（跨主题生效）');
  api.setMascotPick('');
  api.setTheme('magic', false);
  assert(api.mascotOf().id === 'magic', '选回「跟随主题」后再次跟着主题走');

  // ---- 立绘与缩略图分档：主页 120px 用 -256，44/56px 的小位用 -96（别挂 1~2MB 原图）----
  assert(api.mascotOf().img.endsWith('-256.png') && api.mascotOf().thumb.endsWith('-96.png'), '立绘取 -256、缩略图取 -96');

  // ---- 新成员「看盘少女」：阵容在册、可自选、上主页立绘 ----
  assert(api.mascots().includes('kanpan'), '吉祥物阵容包含看盘少女（kanpan）');
  api.setMascotPick('kanpan');
  api.applyMascot();
  assert(api.mascotOf().id === 'kanpan' && api.heroMascot().src === '/img/mascot-kanpan-256.png' && !api.heroMascot().hidden, '看盘少女可自选并上主页立绘');
  api.setMascotPick('');

  // ---- 新成员「小鲸鱼」：阵容在册、可自选、上主页立绘 ----
  assert(api.mascots().includes('whale'), '吉祥物阵容包含小鲸鱼（whale）');
  api.setMascotPick('whale');
  api.applyMascot();
  assert(api.mascotOf().id === 'whale' && api.heroMascot().src === '/img/mascot-whale-256.png' && !api.heroMascot().hidden, '小鲸鱼可自选并上主页立绘');
  api.setMascotPick('');

  // ---- 首次登录弹一次：本地从没选过才弹，选过就不再打扰 ----
  api.el('themeOverlay').classList.add('hidden');
  localStorageStub.removeItem('gushen_theme');
  api.maybeFirstTheme();
  assert(api.themeOverlayShown(), '本地没存过主题选择 → 首次登录弹选择窗');
  api.el('themeOverlay').classList.add('hidden');
  localStorageStub.setItem('gushen_theme', 'magic');
  api.maybeFirstTheme();
  assert(!api.themeOverlayShown(), '选过之后不再弹');

  // ---- 切主题要整体重绘：两个视图都必须跑通（repaintTheme 里调错函数名会在这里炸）----
  api.setState(mkState({ ...AUCTION_DAY, day: 3, phase: 'morning', label: '上午连续竞价', auction: null }, null));
  for (const view of ['home', 'trade']) {
    api.setActiveView(view);
    api.setTheme('gold', false);
    let err = null;
    try {
      api.repaintTheme();
    } catch (e) {
      err = e.message;
    }
    assert(err === null, `${view} 视图下 repaintTheme 不抛异常（实际：${err || '无'}）`);
  }
}


console.log('\n[17] 账号与昵称分家：账号登录 → 开户（昵称 + 券商）→ 改昵称');
(async () => {
  // ---- 两步的骨架：加载时先看到第一步；两个步骤容器各自是列 flex ----
  // 这条是「静默失效」型回归：`#loginStep1/#loginStep2` 少了 flex 列布局，输入框与登录按钮
  // 会缩成"按内容宽度"的小方块（文字从盒子里溢出），逻辑与自检全绿、只有肉眼看截图才发现
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  assert(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').indexOf('<div id="loginStep2" hidden>') >= 0, '第二步在 HTML 里默认隐藏（打开页面先看到输账号）');
  assert(/#loginStep1\s*,\s*#loginStep2\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s.test(css), '两个步骤容器各自是列 flex');
  assert(/#loginStep1\s*,\s*#loginStep2\s*\{[^}]*gap:\s*14px/s.test(css), '步骤容器的间距与 .login-card 一致（14px）');

  // ---- 两条规则与服务端一致（账号 ASCII 唯一凭据；昵称中文可用、2~12 字符）----
  assert(/A-Za-z/.test(api.accountRe()), `账号规则是 ASCII 那套（${api.accountRe()}）`);
  assert(/\\p\{L\}|p\{L\}/.test(api.nickRe()), `昵称规则允许任意语言字母（${api.nickRe()}）`);

  // ---- 两步切换：第一步输账号，第二步（开户）才亮昵称 + 券商 ----
  api.showLoginStep(2, 'tester', '小明');
  assert(api.el('loginStep1').hidden === true && api.el('loginStep2').hidden === false, '切到开户步骤后只显示第二步');
  assert(api.el('onboardAccount').textContent === 'tester', `第二步顶部显示账号（${api.el('onboardAccount').textContent}）`);
  assert(api.el('loginNick').value === '小明', '第二步预填昵称（老档可能已填过）');
  api.showLogin('zhangsan');
  assert(api.el('loginStep1').hidden === false && api.el('loginStep2').hidden === true, '退回第一步只显示第一步');
  assert(api.el('loginAccount').value === 'zhangsan', '退回第一步保留刚输的账号');

  // ---- 页面加载 / 自动重登：没开过户也**停在第一步**，绝不自动跳进开户步骤 ----
  api.setIdentity('', '', '');
  scriptFetch(() => ({ ok: false, needOnboard: true, account: 'tester', nick: '小明', error: '账号不存在，请先开户' }));
  let probe = null;
  api.probeLogin('tester').then((r) => { probe = r; });
  await flush(); await flush();
  assert(probe && probe.needOnboard === true, 'probeLogin 原样透出服务端响应');
  assert(api.el('loginStep1').hidden === false, '加载时探测到"没开户"仍停在第一步');
  assert(api.el('loginStep2').hidden === true, '开户步骤不自动出现（要玩家点一次「登录」）');
  assert(api.el('loginAccount').value === 'tester', '第一步预填账号（刷新后不用重打）');
  assert(api.el('loginOverlay').classList.contains('hidden') === false, '登录弹层保持可见');
  assert(api.identity().account === 'tester' && api.identity().token === '', '账号留下、令牌作废');

  // 本地残留的账号名可能已经不合规（老档中文名）：那种名字点了必被打回，不预填
  scriptFetch(() => ({ ok: false, needOnboard: true, account: '张三', nick: '', error: '账号不存在，请先开户' }));
  api.probeLogin('张三').then(() => {});
  await flush(); await flush();
  assert(api.el('loginAccount').value === '', '不合规的旧账号名不预填（让玩家重新输一个）');
  assert(api.identity().account === '' && api.acctKey() === null, '脏账号名从本地清掉');

  // ---- 点「登录」的真实点击路径：账号没开过户 → 切到第二步 + 不写身份 ----
  scriptFetch(() => ({ ok: false, needOnboard: true, account: 'tester', nick: '小明', error: '账号不存在，请先开户' }));
  api.el('loginAccount').value = 'tester';
  assert(fire('loginBtn', 'click') === 1, '「登录」按钮挂着监听器');
  await flush(); await flush();
  const loginCalls = fetchCalls.filter((c) => c.url === '/api/login');
  assert(loginCalls.length === 1, `点登录只打一次 /api/login（实际 ${loginCalls.length} 次）`);
  assert(!fetchCalls.some((c) => c.url === '/api/onboard'), '需要开户时不偷偷建号（不打 /api/onboard）');
  assert(loginCalls[0].body.account === 'tester' && loginCalls[0].body.name === undefined, '请求体只有 account（不再有 name/broker）');
  assert(api.el('loginStep2').hidden === false && api.el('loginStep1').hidden === true, '点登录后切到开户步骤');
  assert(api.el('onboardAccount').textContent === 'tester', '开户步骤用的是服务端回带的账号');
  assert(api.identity().account === '' && api.acctKey() === null, '没开户前不写本地身份');

  // 软提示而不是硬拦：本地不合规的名字照样提交，由服务端裁决（老档里可能有中文账号）
  scriptFetch(() => ({ ok: false, error: '账号需为 3~16 位、字母开头，只允许英文字母 / 数字 / 下划线 / 连字符' }));
  api.el('loginAccount').value = '张三丰';
  fire('loginBtn', 'click');
  await flush(); await flush();
  assert(fetchCalls.filter((c) => c.url === '/api/login').length === 1, '不合规的账号也会提交（不在本地硬拦）');
  assert(api.el('loginErr').hidden === false && /账号需为/.test(api.el('loginErr').textContent), `服务端的规则文案被展示（${api.el('loginErr').textContent}）`);

  // ---- 第二步：填昵称 + 选券商 + 点「开户并进入市场」→ 账号与昵称分别落盘，弹层收起 ----
  scriptFetch(() => ({ ok: true, account: 'tester', nick: '股神小明', token: 'tok-1', broker: 'zhaoshang' }));
  fire('loginBtn', 'click'); // 先正常走到第二步（账号预填 tester 仍需玩家点一次登录）
  await flush(); await flush();
  assert(api.el('loginStep2').hidden === false, '再次点登录切到开户步骤');
  api.el('loginNick').value = '股神小明';
  api.setPicked('zhaoshang');
  scriptFetch(() => ({ ok: true, account: 'tester', nick: '股神小明', token: 'tok-1', broker: 'zhaoshang' }));
  assert(fire('onboardBtn', 'click') === 1, '「开户并进入市场」按钮挂着监听器');
  await flush(); await flush();
  const onboardCalls = fetchCalls.filter((c) => c.url === '/api/onboard');
  assert(onboardCalls.length === 1, `点开户只打一次 /api/onboard（实际 ${onboardCalls.length} 次）`);
  assert(
    onboardCalls[0].body.account === 'tester' && onboardCalls[0].body.nick === '股神小明' && onboardCalls[0].body.broker === 'zhaoshang',
    `开户请求体齐全（${JSON.stringify(onboardCalls[0].body)}）`
  );
  assert(api.identity().account === 'tester' && api.identity().nick === '股神小明', '账号与昵称分别记进身份');
  assert(api.acctKey() === 'tester' && api.nickKey() === '股神小明', '两个键分别落 localStorage');
  assert(api.legacyKey() === null, '旧键 gushen_name 被清掉（不再从旧账号名兜底）');
  assert(api.el('loginOverlay').classList.contains('hidden'), '开户成功后登录弹层收起');
  assert(api.el('whoName').textContent === '股神小明', `顶栏显示昵称（${api.el('whoName').textContent}）`);
  assert(/tester/.test(api.el('whoName').title), '账号放在 title 里可查');
  // 弹层本身的复位不靠这里：顶栏「换号」走 location.reload()，重进一律从第一步开始

  // ---- 改昵称：账号不动、令牌不动、只改展示名 ----
  scriptFetch(() => ({ ok: true, nick: '股神大神' }));
  let nickRes = null;
  api.saveNick('股神大神').then((r) => { nickRes = r; });
  await flush(); await flush();
  assert(nickRes && nickRes.ok, '改昵称成功');
  assert(fetchCalls[0].url === '/api/nick' && fetchCalls[0].body.nick === '股神大神', '改昵称只提交昵称');  assert(api.identity().account === 'tester' && api.identity().token === 'tok-1', '账号与令牌都没动');
  assert(api.nickKey() === '股神大神' && api.el('whoName').textContent === '股神大神', '新昵称落盘并刷新顶栏');

  // ---- 「我」的判定必须按账号：重名玩家不能把（我）标到别人那一行 ----
  api.setState({
    ...mkState(null),
    players: [
      { account: 'other', name: '股神大神', equity: 2000000, broker: 'zhaoshang', brokerRank: 1, star: 2 },
      { account: 'tester', name: '股神大神', equity: 1000000, broker: 'zhaoshang', brokerRank: 2, star: 1 },
    ],
  });
  const rank = api.rankRowsHtml();
  const mineRows = rank.split('<tr').filter((r) => r.indexOf('row-mine') >= 0);
  assert(mineRows.length === 1, `重名玩家下只有一行属于我（实际 ${mineRows.length} 行）`);
  assert(mineRows[0].indexOf('other') === -1 && mineRows[0].indexOf('股神大神') >= 0, '高亮的是账号匹配的那一行（另一行的同名人没被标）');
  assert(rank.split('（我）').length === 2, `（我）整张榜只出现一次（实际 ${rank.split('（我）').length - 1} 次）`);
  assert(rank.indexOf('股神大神') >= 0, '展示的是昵称');
  assert(rank.indexOf('/img/broker-zhaoshang-96.png') >= 0, '两张同名的行都带券商图标（不是只渲染了一行）');

  // 股东榜同理：按 h.account 认我，标题与曲线也走账号键
  api.setHolders({
    stockId: STOCK,
    rows: [
      { account: 'other', name: '股神大神', role: 'player', qty: 500, pct: 5, change: 0, changePct: 0, dQty: null, dPct: null },
      { account: 'tester', name: '股神大神', role: 'player', qty: 300, pct: 3, change: 0, changePct: 0, dQty: null, dPct: null },
    ],
    holderSnapshot: null,
  });
  api.setActiveView('trade');
  api.renderHolders();
  const body = api.el('holdersBody').innerHTML;
  const holderRows = body.split('<tr').filter((r) => r.indexOf('row-mine') >= 0);
  assert(holderRows.length === 1, `股东榜的重名也不会认错行（实际 ${holderRows.length} 行）`);
  assert(holderRows[0].indexOf('other') === -1, '高亮的是账号匹配的那一行');
  assert(body.split('（我）').length === 2, `（我）整张股东榜只出现一次（实际 ${body.split('（我）').length - 1} 次）`);
  assert(holderRows[0].indexOf('data-holder="tester"') >= 0, '行上的 data-holder 是账号（曲线按账号取数）');
  assert(/我的排名<\/label><span>第 2 名/.test(api.el('holdersMeta').innerHTML), '「我的排名」按账号算（第 2 名）');

  resetFetch();

  console.log('\n[18] 分时取数窗口：默认只看当天，可切连续 5 日');
  {
    const DAY = 620000; // 一个交易日的墙钟长度（与 config.day.phases 合计一致）
    const dayStart = 1700000000000;
    const dayNo = 6;
    // 第 1~6 天各 10 个点，另加 5 个「第 0 天」的旧点，用来验证被裁掉
    const pts = [];
    for (let d = 0; d <= dayNo; d++) {
      for (let i = 0; i < 10; i++) {
        pts.push({ t: dayStart - (dayNo - d) * DAY + i * 1000, price: 20 + d * 0.1 + i * 0.01, vol: 100 * (d * 10 + i) });
      }
    }
    api.setHistory(STOCK, pts);

    const rangeDay = {
      enabled: true, day: dayNo, phase: 'morning', label: '上午连续竞价', trading: true, auction: null, locked: false,
      phaseMs: 230000, phaseElapsedMs: 10000, phaseLeftMs: 220000,
      phaseEndsAt: dayStart + DAY - 40000, dayStartAt: dayStart, dayEndsAt: dayStart + DAY,
      gameClockMs: 0, phaseGameMs: 7200000,
    };

    // ---- 没有 dayStartAt（老服务端 / 没接交易日时钟）→ 不过滤，退回引入窗口之前的行为 ----
    api.setState(mkState({ enabled: false, trading: true }, null));
    assert(api.minuteFrom() === 0 && api.minutePts(STOCK).length === pts.length, `无交易日时钟时不过滤（${api.minutePts(STOCK).length} 点）`);

    // ---- 有锚点：默认「当日」只留今天这一天的点 ----
    api.setState(mkState(rangeDay, null));
    api.setMinuteRange('day');
    const todayPts = api.minutePts(STOCK);
    assert(todayPts.length === 10, `当日窗口只留今天的点（${todayPts.length}/70）`);
    assert(todayPts[0].t === dayStart && todayPts[9].t === dayStart + 9000, '留下的正是本交易日的首尾段');
    assert(api.minuteFrom() === dayStart, '当日窗口起点 = 本交易日开盘竞价时刻');

    // ---- 切「5 日」：往前多留 4 个交易日 ----
    api.setMinuteRange('5d');
    assert(api.minuteRangeOf() === '5d', '窗口切成 5 日');
    assert(api.minuteFrom() === dayStart - 4 * DAY, '5 日窗口起点 = 当天再往前 4 个交易日');
    const fivePts = api.minutePts(STOCK);
    assert(fivePts.length === 50, `5 日窗口留最近 5 个交易日（${fivePts.length}/70）`);
    assert(fivePts[0].t === dayStart - 4 * DAY, '第 1 天的点没被留（跨度刚好 5 天）');

    // ---- 落盘 + 副标题 + MACD 与画法共用同一份窗口 ----
    api.setChartMode('minute'); // 上一节把模式留在了日线，副标题要按分时的口径看
    api.renderChartMode();
    assert(store[ 'gushen_minute_range' ] === '5d', '窗口选择落 localStorage');
    assert(/连续 5 日分时/.test(api.el('chartSub').textContent), `副标题跟着窗口走（${api.el('chartSub').textContent}）`);
    assert(api.macdOf().dif.length === fivePts.length, `MACD 用的也是裁过的序列（${api.macdOf().dif.length}）`);
    api.setMinuteRange('day');
    assert(/^当日分时/.test(api.el('chartSub').textContent), `切回当日（${api.el('chartSub').textContent}）`);
    assert(api.macdOf().dif.length === 10, '切回当日后 MACD 重算（缓存键带窗口）');

    // ---- 日线模式整块隐藏（K 线本来就是一天一根）----
    api.setChartMode('minute');
    api.renderChartMode();
    assert(api.el('chartRanges').hidden === false, '分时模式显示「当日 / 5 日」');
    api.setChartMode('day');
    api.renderChartMode();
    assert(api.el('chartRanges').hidden === true, '日线模式隐藏「当日 / 5 日」');
    api.setChartMode('minute');
    api.renderChartMode();

    // ---- 骨架：两块控件都在 HTML 里（桩环境的 querySelectorAll 是空的，只能查源码）----
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert(html.indexOf('id="chartRanges"') >= 0 && html.indexOf('data-range="5d"') >= 0, 'HTML 里有「当日 / 5 日」这组控件');
    assert(
      html.indexOf('data-mode="week"') >= 0 && html.indexOf('data-mode="month"') >= 0,
      'HTML 里有周线/月线模式按钮'
    );
  }

  // ==================================================================
  console.log('\n[18b] 分时时间刻度：墙钟 → 游戏内交易时刻（09:15 / 11:30 / 13:00）');
  {
    const P = 620000; // 一天
    const T0 = 1700000000000; // 今日开盘竞价起点（墙钟锚）
    // 与 config.day.phases 同源（服务端 snapshot 下发的就是这几个字段）
    const PHASES = [
      { key: 'auction', ms: 30000, g: 33300000, gm: 600000 },      // 09:15 +10min
      { key: 'morning', ms: 230000, g: 34200000, gm: 7200000 },    // 09:30 +120min
      { key: 'lunch', ms: 40000, g: 41400000, gm: 5400000 },       // 11:30 +90min
      { key: 'afternoon', ms: 260000, g: 46800000, gm: 7020000 },  // 13:00 +117min
      { key: 'closeAuction', ms: 20000, g: 53820000, gm: 180000 }, // 14:57 +3min
      { key: 'night', ms: 40000, g: 54000000, gm: 65700000 },      // 15:00 +1095min
    ];
    const DAY = {
      enabled: true, day: 6, phase: 'morning', label: '上午连续竞价', trading: true, auction: null, locked: false,
      phaseMs: 230000, phaseElapsedMs: 10000, phaseLeftMs: 220000,
      phaseEndsAt: T0 + P - 360000, dayStartAt: T0, dayEndsAt: T0 + P,
      gameClockMs: 34200000, phaseGameMs: 7200000, phases: PHASES,
    };
    api.setState(mkState(DAY, null));

    // ---- 纯函数：各阶段边界与阶段内插值（与 daycycle.js 的 gameClock 同算法）----
    const at = (off) => api.gameClockAt(T0 + off);
    const hm = (off) => api.fmtHM(at(off).ms);
    assert(hm(0) === '09:15', `竞价起点 09:15（${hm(0)}）`);
    assert(hm(15000) === '09:20', `竞价中点 09:20（${hm(15000)}）`);
    assert(hm(30000) === '09:30', `上午开盘 09:30（${hm(30000)}）`);
    assert(hm(30000 + 115000) === '10:30', `上午中点 10:30（${hm(30000 + 115000)}）`);
    assert(hm(260000) === '11:30', `午休起点 = 上午收盘 11:30（${hm(260000)}）`);
    assert(hm(260000 + 20000) === '12:15', `午休中点 12:15（${hm(260000 + 20000)}）`);
    assert(hm(300000) === '13:00', `下午开盘 13:00（${hm(300000)}）`);
    assert(hm(560000) === '14:57', `收盘竞价 14:57（${hm(560000)}）`);
    assert(hm(580000) === '15:00', `夜间起点 15:00（${hm(580000)}）`);
    assert(api.fmtClockMs(at(580000 + 20000).ms) === '00:07:30', `夜间中点跨夜回卷 00:07:30（${api.fmtClockMs(at(580000 + 20000).ms)}）`);
    assert(at(30000).day === 6, `当天点带天号（${at(30000).day}）`);
    assert(at(-P + 30000).day === 5, `前一天的点天号回推（${at(-P + 30000).day}）`);
    assert(hm(-P + 30000) === '09:30', `前一天同一阶段同样是 09:30（${hm(-P + 30000)}）`);

    // ---- 刻度文案：当天只写 HH:MM，跨天补「N日」前缀 ----
    assert(api.minuteTimeLabel(T0 + 30000) === '09:30', `当天刻度 ${api.minuteTimeLabel(T0 + 30000)}`);
    assert(api.minuteTimeLabel(T0 - P + 30000) === '5日 09:30', `跨天刻度带天号 ${api.minuteTimeLabel(T0 - P + 30000)}`);
    assert(/^\d{2}:\d{2}:\d{2}$/.test(api.minuteTimeLabel(T0 + 30000, true)), `光标文案带秒 ${api.minuteTimeLabel(T0 + 30000, true)}`);
    assert(api.minuteTimeLabel(T0 + 30000, true) === '09:30:00', `光标时刻 09:30:00（${api.minuteTimeLabel(T0 + 30000, true)}）`);

    // ---- 没有阶段表（老服务端 / day 未启用）→ 退回墙钟，不能崩 ----
    api.setState(mkState({ ...DAY, enabled: false }, null));
    assert(api.gameClockAt(T0 + 30000) === null, 'day 未启用时 gameClockAt 返回 null');
    const wall = (ts) => {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    assert(api.minuteTimeLabel(T0 + 30000) === wall(T0 + 30000), `无时钟时退回墙钟（${api.minuteTimeLabel(T0 + 30000)}）`);
  }

  // ==================================================================
  console.log('\n[18c] 分时横轴：休市/开盘竞价压成 0 宽（11:30 直接接 13:00）');
  {
    const P = 620000; // 一天（墙钟）
    const T0 = 1700000000000; // 今日开盘竞价起点
    // 与 config.day.phases 同源
    const PHASES = [
      { key: 'auction', ms: 30000, g: 33300000, gm: 600000 },      // 09:15 +10min
      { key: 'morning', ms: 230000, g: 34200000, gm: 7200000 },    // 09:30 +120min
      { key: 'lunch', ms: 40000, g: 41400000, gm: 5400000 },       // 11:30 +90min
      { key: 'afternoon', ms: 260000, g: 46800000, gm: 7020000 },  // 13:00 +117min
      { key: 'closeAuction', ms: 20000, g: 53820000, gm: 180000 }, // 14:57 +3min
      { key: 'night', ms: 40000, g: 54000000, gm: 65700000 },      // 15:00 +1095min
    ];
    const DAY = {
      enabled: true, day: 6, phase: 'morning', label: '上午连续竞价', trading: true, auction: null, locked: false,
      phaseMs: 230000, phaseElapsedMs: 10000, phaseLeftMs: 220000,
      phaseEndsAt: T0 + P - 360000, dayStartAt: T0, dayEndsAt: T0 + P,
      gameClockMs: 34200000, phaseGameMs: 7200000, phases: PHASES,
    };
    api.setState(mkState(DAY, null));

    const MIN = 60000;
    const DAYW = 240 * MIN; // 上午 120 + 下午 117 + 收盘竞价 3
    const A = (off) => api.axisAt(T0 + off);

    // ---- 一天的有效宽度 = 只有连续竞价 + 收盘竞价 ----
    assert(api.axisDayWidth(PHASES) === DAYW, `一天占 240 分钟（${api.axisDayWidth(PHASES) / MIN}）`);

    // ---- 开盘竞价塌在轴头：09:15 与 09:30 同一个 x ----
    assert(A(0) === 0, `竞价起点在轴头（${A(0)}）`);
    assert(A(30000) === 0, `开盘竞价整段不占宽：09:30 仍在轴头（${A(30000)}）`);
    assert(A(15000) === 0, `竞价中段同样塌在轴头（${A(15000)}）`);

    // ---- 午休压成一点：11:30 / 12:15 / 13:00 同一个 x ----
    const noon = A(260000);
    assert(noon === 120 * MIN, `11:30 落在 120 分钟处（${noon / MIN}）`);
    assert(A(260000 + 20000) === noon, `午休中点 12:15 与 11:30 同一个 x（不留空档）`);
    assert(A(300000) === noon, `13:00 与 11:30 同一个 x（中间没有横线的位置）`);
    assert(A(259000) < noon, '11:29 严格在 11:30 左边（压缩只发生在休市段）');
    assert(A(301000) > noon, '13:01 严格在 13:00 右边');

    // ---- 收盘价直接连次日开盘价（隔夜跳空是竖线，不是空档）----
    assert(A(580000) === DAYW, `15:00 在一天轴宽的末端（${A(580000) / MIN}）`);
    assert(A(P + 30000) === DAYW, `次日 09:30 也在这个坐标上（收盘接开盘）`);

    // ---- 轴坐标 → 游戏内时刻：午休那道接缝写成「11:30/13:00」----
    const seam = api.clockAtAxis(noon, false);
    assert(seam && api.fmtHM(seam.ms) === '13:00', `接缝读作 13:00（${seam && api.fmtHM(seam.ms)}）`);
    assert(seam && api.fmtHM(seam.seam) === '11:30', `接缝同时带上 11:30（${seam && api.fmtHM(seam.seam)}）`);
    assert(api.axisTimeLabel(noon) === '11:30/13:00', `刻度文案 11:30/13:00（${api.axisTimeLabel(noon)}）`);
    assert(api.axisTimeLabel(0) === '09:30', `轴头刻度 09:30（${api.axisTimeLabel(0)}）`);
    assert(api.axisTimeLabel(DAYW, true) === '15:00', `日界按前一天收盘读 15:00（${api.axisTimeLabel(DAYW, true)}）`);
    assert(api.axisTimeLabel(DAYW, false) === '7日 09:30', `不标日界就是次日开盘（${api.axisTimeLabel(DAYW, false)}）`);
    assert(api.axisTimeLabel(-DAYW) === '5日 09:30', `往前一天补天号前缀（${api.axisTimeLabel(-DAYW)}）`);
    // 整点刻度落在整分上：一天 = 09:30 / 10:30 / 11:30·13:00 / 14:00 / 15:00
    const step = api.axisTickStep(DAYW);
    assert(step === 60 * MIN, `一天视图按 60 分钟落刻度（${step / MIN}）`);
    const ticks = [];
    for (let a = Math.ceil(0 / step) * step; a <= DAYW + 1; a += step) ticks.push(api.axisTimeLabel(a, a >= DAYW - 1));
    assert(ticks.join('|') === '09:30|10:30|11:30/13:00|14:00|15:00', `一天的刻度（${ticks.join('|')}）`);
    assert(api.axisTickStep(5 * DAYW) === 240 * MIN, `5 日视图按 240 分钟落刻度（${api.axisTickStep(5 * DAYW) / MIN}）`);
    // 5 日视图里「今天开盘」那根刻度不读成前一天收盘（数据还长在它后面）
    assert(api.axisTimeLabel(0, false) === '09:30', `有后续数据时日界读开盘（${api.axisTimeLabel(0, false)}）`);

    // ---- 竞价分界：开盘收口点（0 宽）+ 收盘竞价起点（230 宽）----
    const mk1 = api.axisAuctionMarks(0, DAYW);
    assert(mk1.length === 2, `当日视图只有两个竞价标记（${mk1.length}）`);
    assert(mk1[0].kind === 'open' && mk1[0].a === 0, `开盘竞价收口在轴头（${mk1[0] && mk1[0].kind}@${mk1[0] && mk1[0].a}）`);
    assert(mk1[1].kind === 'close' && mk1[1].a === 237 * MIN, `收盘竞价起点 14:57（${mk1[1] && mk1[1].a / MIN}）`);
    assert(mk1[1].width === 3 * MIN, `收盘竞价占 3 分钟（${mk1[1] && mk1[1].width / MIN}）`);
    assert(api.fmtHM(api.clockAtAxis(mk1[1].a).ms) === '14:57', `收盘竞价起点读作 14:57（${api.fmtHM(api.clockAtAxis(mk1[1].a).ms)}）`);
    const ca = api.axisCloseAuctionSpan();
    assert(ca && ca.start === 237 * MIN && ca.width === 3 * MIN, '收盘竞价区间稳定（237~240 分钟）');
    // 5 日：每天一组（开盘分界正好当交易日分隔）
    const mk5 = api.axisAuctionMarks(0, 5 * DAYW);
    assert(mk5.length === 10, `5 日视图 5 组竞价标记（${mk5.length}）`);
    assert(mk5.filter((m) => m.kind === 'open').map((m) => m.day / 1).join(',') === '0,1,2,3,4', '每天一根开盘分界线');
    assert(mk5.filter((m) => m.kind === 'open')[2].a === 2 * DAYW, '第 3 天的开盘分界落在 480 分钟处');
    // 右端正好压在日界上时不许多画下一组（数据没走到那里）
    assert(api.axisAuctionMarks(0, 2 * DAYW).length === 4, '右端不越界多画一组');
    // 当日开盘时刻（刚开始，只有一天的左半）只该有开盘那一根
    assert(api.axisAuctionMarks(0, 30 * MIN).length === 1, '上午 10:00 前只有开盘分界');

    // ---- 横轴固定为「全天刻度」：当日 09:30~15:00、5 日整 5 天，右端压在今天收盘 ----
    const PTS = [
      { t: T0 + 30000, price: 20.0, vol: 100 },
      { t: T0 + 120000, price: 20.1, vol: 200 },
    ];
    const dm1 = api.minuteDomain(PTS);
    assert(dm1.full === true, '有阶段表时走全天固定刻度');
    assert(dm1.a0 === 0 && dm1.a1 === DAYW, `当日视图域 = 09:30~15:00（${dm1.a0}~${dm1.a1 / MIN} 分钟）`);
    api.setMinuteRange('5d');
    const dm5 = api.minuteDomain(PTS);
    assert(dm5.a0 === -4 * DAYW && dm5.a1 === DAYW, `5 日视图域 = 前 4 天到今天收盘（${dm5.a0 / MIN}~${dm5.a1 / MIN} 分钟）`);
    // 负坐标也要画得出竞价分界（5 日视图左端在今天之前）
    assert(api.axisAuctionMarks(-4 * DAYW, DAYW).length === 10, '5 日全天域里 5 组竞价标记都在');
    assert(api.axisAuctionMarks(-4 * DAYW, DAYW).every((m) => m.a >= -4 * DAYW && m.a < DAYW), '标记全部落在域内');
    api.setMinuteRange('day');
    // 全天域的刻度：开盘 → 收盘五根，右端读 15:00（即使数据还没走到）
    const dStep = api.axisTickStep(dm1.a1 - dm1.a0);
    const dTicks = [];
    for (let a = Math.ceil(dm1.a0 / dStep) * dStep; a <= dm1.a1 + 1; a += dStep) {
      dTicks.push(api.axisTimeLabel(a, a >= dm1.a1 - 1));
    }
    assert(dStep === 60 * MIN, `全天刻度按 60 分钟落（${dStep / MIN}）`);
    assert(dTicks.join('|') === '09:30|10:30|11:30/13:00|14:00|15:00', `开盘到收盘五根刻度（${dTicks.join('|')}）`);

    // ---- 没有阶段表：轴坐标就是墙钟，与压缩之前逐位一致 ----
    api.setState(mkState({ ...DAY, enabled: false }, null));
    assert(api.axisAt(T0 + 260000) === null, 'day 未启用时 axisAt 返回 null');
    assert(api.axisCoord(T0 + 260000) === T0 + 260000, 'axisCoord 退化成墙钟');
    assert(api.axisAuctionMarks(0, DAYW).length === 0, '没有阶段表时不画任何竞价标记');
    assert(api.minuteDomain(PTS).full === false, '没有阶段表时横轴退回贴合数据口径');

    // ---- 画一次真图不崩（压缩后的 x 映射会走 measureText / 刻度夹边）----
    api.setState(mkState(DAY, null));
    api.setHistory(STOCK, [
      { t: T0 + 30000, price: 20.0, vol: 1000 },
      { t: T0 + 120000, price: 20.1, vol: 2000 },
      { t: T0 + 260000, price: 20.2, vol: 3000 },
      { t: T0 + 300000, price: 20.15, vol: 4000 },
    ]);
    api.setActiveView('trade');
    let drew = true;
    try {
      api.drawChart();
    } catch (e) {
      drew = false;
      console.log('    drawChart 抛了：' + e.message);
    }
    assert(drew, '压缩横轴下分时图能正常画完（不抛异常）');
  }

  // ==================================================================
  console.log('\n[18] 开户过场：四宫格漫画（4 选 1 随机播）');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

    // ---- 骨架：过场层与四个插槽都在 HTML 里 ----
    ['comicOverlay', 'comicTitle', 'comicGrid', 'comicSkipBtn', 'comicGoBtn'].forEach((id) => {
      assert(html.indexOf(`id="${id}"`) >= 0, `HTML 里有 #${id}`);
    });
    assert(/class="[^"]*comic-overlay[^"]*hidden/.test(html), '过场层默认隐藏（开户第二步才由 JS 打开）');
    assert(/\.comic-grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/s.test(css), '宫格是 2×2');
    assert(/prefers-reduced-motion/.test(css) && /\.comic-panel\s*\{[^}]*transition:\s*none/s.test(css), '减少动效时不做位移/逐字');

    // ---- 数据：4 套 × 4 格，台词不为空，图全部真实存在 ----
    const sets = api.comicSets();
    assert(sets.length === 4, `四套故事（实际 ${sets.length}）`);
    assert(sets.every((s) => s.n === 4), '每套正好 4 格');
    const imgDir = path.join(__dirname, '..', 'img');
    const missing = [];
    sets.forEach((s) => {
      for (let i = 1; i <= s.n; i += 1) {
        const f = path.join(imgDir, `comic-${s.id.toLowerCase()}${i}.png`);
        if (!fs.existsSync(f)) missing.push(path.basename(f));
      }
    });
    assert(missing.length === 0, `16 张单格图都在 Client/img（缺：${missing.join(',') || '无'}）`);

    // ---- 打开：格子按套名拼出 4 张图，字幕走 DOM（画面不烤字）----
    api.resetComicSeen();
    let done = 0;
    api.openComic(() => { done += 1; });
    const grid = api.el('comicGrid').innerHTML;
    const first = api.comicSeenList()[0];
    assert(api.el('comicOverlay').classList.contains('hidden') === false, 'openComic 把过场层显示出来');
    assert(/^[A-D]$/.test(first), `看过的那套写进 gushen_comic_seen（${first}）`);
    assert((grid.match(/class="comic-panel"/g) || []).length === 4, '宫格里拼出 4 格');
    for (let i = 1; i <= 4; i += 1) {
      assert(grid.indexOf(`/img/comic-${first.toLowerCase()}${i}.png`) >= 0, `第 ${i} 格指向 comic-${first.toLowerCase()}${i}.png`);
    }
    assert(/class="comic-who"/.test(grid) && /class="comic-text"/.test(grid), '每格有说话人 + 字幕两个槽（台词不进图）');

    // ---- 跳过：关掉过场 + 回调一次（回到开户表单并聚焦昵称）----
    assert(fire('comicSkipBtn', 'click') === 1, '「跳过」按钮挂着监听器');
    assert(api.el('comicOverlay').classList.contains('hidden') === true, '点跳过立刻收场');
    assert(done === 1, `收场回调只调一次（实际 ${done} 次）`);
    assert(api.el('comicGrid').innerHTML === '', '收场后清空宫格，下次重播不残留');

    // ---- 随机规则：四套轮完才回到起点（纯随机会出现连着两次同一套）----
    api.resetComicSeen();
    const picked = [];
    for (let i = 0; i < 4; i += 1) {
      api.openComic(null);
      picked.push(api.comicSeenList()[api.comicSeenList().length - 1]);
      api.closeComic();
    }
    const uniq = new Set(picked);
    assert(uniq.size === 4, `连开四次拿到四套不同的（${picked.join('')}）`);
    api.openComic(null);
    assert(api.comicSeenList().length === 1, '四套都看过之后从空表重新开始');
    api.closeComic();

    // ---- 关掉之后再点跳过不该重复回调（防止二次收场把焦点抢走）----
    api.closeComic();
    assert(done === 1, '重复 closeComic 不再触发回调');

    // ---- 首页回看入口：四套随便翻，措辞与开户过场分开 ----
    assert(html.indexOf('id="comicReplayBtn"') >= 0, '主页有「看漫画」入口');
    assert(html.indexOf('id="comicSets"') >= 0, '漫画层里留了四套切换片的槽');
    assert(/\.comic-set\b/.test(css), '切换片有样式（不然是一排原生按钮）');

    api.resetComicSeen();
    api.openComic(null, true);
    assert(api.comicReplayOf() === true, 'openComic(null, true) 进回看模式');
    assert(api.comicKickerText() === '开户漫画 · 四套随便翻', `回看的抬头不是催开户（${api.comicKickerText()}）`);
    assert(api.el('comicSkipBtn').textContent === '关闭', '回看时右上角是「关闭」而不是「跳过 ›」');
    assert(api.el('comicSets').hidden === false, '回看时亮出四套切换片');
    const chips = api.el('comicSets').innerHTML;
    assert((chips.match(/class="comic-set/g) || []).length === 4, '四个切换片');
    assert(/data-comic="C"/.test(chips) && /C · 第一课/.test(chips), '切换片带套号与短名（C · 第一课）');
    assert(new RegExp(`data-comic="${api.comicSetNow()}"[^>]*class="comic-set on"|class="comic-set on"[^>]*data-comic="${api.comicSetNow()}"`).test(chips), '当前那一套高亮');

    // 换套：直接重绘宫格，不等动画
    api.switchComic('C');
    assert(api.comicSetNow() === 'C', 'switchComic 换成 C 套');
    assert(api.el('comicGrid').innerHTML.indexOf('/img/comic-c1.png') >= 0, '换套后宫格指向 C 套的图');
    assert(api.el('comicGrid').innerHTML.indexOf('/img/comic-b1.png') < 0, '换套后不残留上一套的图');

    // 播完（桩里定时器不跑，直接叫 finishComic）：按钮变「下一套」，点了不关层
    api.finishComic();
    assert(api.el('comicGoBtn').hidden === false && api.comicGoText() === '下一套 ›', `回看播完是「下一套 ›」（${api.comicGoText()}）`);
    assert(fire('comicGoBtn', 'click') === 1, '「下一套」挂着监听器');
    assert(api.el('comicOverlay').classList.contains('hidden') === false, '「下一套」不关层，继续看');
    assert(api.comicSetNow() === 'D', `「下一套」按 C→D 往后走（实际 ${api.comicSetNow()}）`);
    api.switchComic('D');
    api.nextComic();
    assert(api.comicSetNow() === 'A', 'D 之后回到 A（四套循环）');

    // 收场要把回看模式清干净，否则下次开户过场会带着切换片和「关闭」
    api.closeComic();
    assert(api.comicReplayOf() === false, '关掉后退出回看模式');
    assert(api.el('comicSets').hidden === true && api.el('comicSets').innerHTML === '', '切换片一并收起清空');
    api.resetComicSeen();
    api.openComic(null);
    assert(api.comicReplayOf() === false, '开户过场仍是过场模式');
    assert(api.el('comicSets').hidden === true, '开户过场不给切换片（随机哪套看哪套，别让人先挑）');
    assert(api.comicKickerText() === '开户前，先看个故事', '措辞切回开户');
    assert(api.el('comicSkipBtn').textContent === '跳过 ›', '右上角切回「跳过 ›」');
    api.finishComic();
    assert(api.comicGoText() === '开始开户', `过场播完仍是「开始开户」（${api.comicGoText()}）`);
    assert(fire('comicGoBtn', 'click') === 1 && api.el('comicOverlay').classList.contains('hidden') === true, '「开始开户」照旧收场');
  }

  console.log('\n[19] 游戏规则：主页入口 + 分类弹窗（数值全部读 state.rules）');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

    // ---- 骨架 ----
    ['rulesBtn', 'rulesOverlay', 'rulesNav', 'rulesBody', 'rulesCloseBtn', 'rulesCloseX'].forEach((id) => {
      assert(html.indexOf(`id="${id}"`) >= 0, `HTML 里有 #${id}`);
    });
    assert(/id="rulesOverlay" class="overlay deposit-overlay hidden"/.test(html), '规则层默认隐藏');
    assert(/id="rulesBtn"/.test(html) && /hero-actions[\s\S]{0,900}id="rulesBtn"/.test(html), '规则入口在主页 hero 按钮组里');
    assert(/\.rules-card\s*\{[^}]*max-height/s.test(css), '弹层限高（长内容靠正文滚动，不是把页面撑长）');
    assert(/\.rules-body\s*\{[^}]*overflow-y:\s*auto/s.test(css), '只有正文滚动，头尾常驻');
    assert(/@media \(max-width: 860px\)[\s\S]*\.rules-wrap\s*\{[^}]*flex-direction:\s*column/s.test(css), '窄屏把左侧分类改成横向条');

    // ---- 一份"从服务端来"的 state：数值故意与默认值不同，用来抓前端写死 ----
    const rich = mkState(AUCTION_DAY, null);
    rich.rules = Object.assign({}, rich.rules, {
      feeRate: 0.0003,
      cooldownMs: 3000,
      lockMs: 5000,
      marginRatio: 0.4,
      maintenance: 0.25,
      lotSize: 100,
      initialCash: 1000000,
      maxDeviation: 0.5,
      cagePct: 0.05,
      priceLimit: { enabled: true, pct: 0.1 },
      liquidationSlippage: 0.005,
      stocks: [{ id: '600001', name: '大米集团' }],
      finance: { enabled: true, ratio: 0.4, baseMinuteRate: 0.0001, maxMinuteRate: 0.0004, minuteRate: 0.01 },
      lending: { enabled: true, baseDailyRate: 0.001, maxDailyRate: 0.004 },
      day: {
        enabled: true,
        totalMs: 620000,
        phases: [
          { key: 'auction', label: '开盘集合竞价', ms: 30000, gameTime: '09:15', trading: true, auction: 'open', cancelLockMs: 10000 },
          { key: 'morning', label: '上午连续竞价', ms: 230000, gameTime: '09:30', trading: true, auction: null, cancelLockMs: 0 },
          { key: 'lunch', label: '午间休市', ms: 40000, gameTime: '11:30', trading: false, auction: null, cancelLockMs: 0 },
          { key: 'afternoon', label: '下午连续竞价', ms: 260000, gameTime: '13:00', trading: true, auction: null, cancelLockMs: 0 },
          { key: 'closeAuction', label: '收盘集合竞价', ms: 20000, gameTime: '14:57', trading: true, auction: 'close', cancelLockMs: 10000 },
          { key: 'night', label: '休市结算', ms: 40000, gameTime: '15:00', trading: false, auction: null, cancelLockMs: 0 },
        ],
      },
      auto: {
        maxPerAccount: 12,
        dcaMinIntervalMs: 5000,
        grid: { minStepPct: 0.3, maxStepPct: 20, maxLevels: 50 },
        ma: { minFast: 10, maxFast: 300, minSlowGap: 10, maxSlow: 900 },
      },
      brokers: [
        { key: 'zhongxin', name: '中信证券', persona: '稳健派', preview: { feeRate: 0.0001, leverage: 2, maintenance: 0.3, lockMs: 10000, lendCapacityPct: 100 } },
        { key: 'huatai', name: '华泰证券', persona: '科技派', preview: { feeRate: 0.0002, leverage: 2.5, maintenance: 0.28, lockMs: 8000, lendCapacityPct: 120 } },
      ],
      brokerMeta: {
        starMax: 5,
        transfer: { feeRate: 0.001, feeCap: 50000, cooldownDays: 1, freeReselectDays: 1 },
        weekly: { daysPerWeek: 7, feeMul: 0.5, financeBonus: 0.5 },
      },
      milestones: { enabled: true, tone: 'savage' },
      // 境界整表（首屏才下发）：规则页「境界」靠它渲染，一个门槛数字都不写死
      realm: {
        enabled: true,
        mortal: { key: 'mortal', name: '凡骨', honor: '凡骨', tone: 'mortal' },
        groups: [{ key: 'lianqi', name: '炼气期', honor: '炼气士', tone: 'lianqi' }],
        ladder: [
          { i: 1, group: 'lianqi', name: '炼气一层', short: '初入山门', equity: 900000 },
          { i: 2, group: 'lianqi', name: '炼气二层', short: '持牌散修', equity: 1000000 },
        ],
      },
    });
    rich.account = Object.assign({}, rich.account, { broker: { key: 'huatai', name: '华泰证券' } });
    rich.day = AUCTION_DAY;
    api.setState(rich);
    // DOM 桩不解析 index.html 的 class，这里手工补上「默认隐藏」这个初始态
    api.el('rulesOverlay').classList.add('hidden');

    const body = () => api.rulesBodyHtml();
    const clickTab = (key) => fire('rulesNav', 'click', { target: { closest: () => ({ dataset: { tab: key } }) } });

    // ---- 没连上行情时不硬开（避免渲染半张空说明书）----
    api.setState(null);
    api.openRules();
    assert(api.rulesOverlayShown() === false, '没有 state 时点规则不会开出空弹层');
    api.setState(rich);

    // ---- 首次进入：入口带「新」点 ----
    assert(api.rulesEntryNew() === true, '没点开过规则时入口挂「新」点');
    assert(api.rulesOverlayShown() === false, '规则层默认关着');

    assert(fire('rulesBtn', 'click') === 1, '主页「规则」按钮挂着监听器');
    assert(api.rulesOverlayShown() === true, '点入口打开规则层');
    assert(api.rulesEntryNew() === false, '点开过之后「新」点消失');
    assert(localStorageStub.getItem('gushen_rules_seen') === '1', '看过规则写进 localStorage（刷新不再提示）');
    assert(api.rulesTabOf() === 'start', `默认停在快速上手（实际 ${api.rulesTabOf()}）`);
    assert(/三步上手/.test(body()) && /一份本金/.test(body()), '快速上手讲清了目标与底层设定');
    assert(/10 分 20 秒/.test(body()), '一天时长取 rules.day.totalMs（10 分 20 秒）');
    assert(api.rulesTabs().length === 8, `八个分类（实际 ${api.rulesTabs().length}）`);
    assert((api.rulesNavHtml().match(/class="rules-tab/g) || []).length === 8, '分类栏渲染出八个按钮');
    assert(/rules-tab on"[^>]*>快速上手/.test(api.rulesNavHtml()), '当前分类高亮');

    // ---- 交易规则：手续费 / 冷却 / 锁仓全部跟着 rules 走 ----
    clickTab('trade');
    assert(api.rulesTabOf() === 'trade', '切到交易规则');
    assert(/万3/.test(body()), '手续费取 rules.feeRate（万3，不是写死的万1）');
    assert(/T\+5 秒/.test(body()), '锁仓取 rules.lockMs（T+5 秒）');
    assert(/3 秒/.test(body()), '下单冷却取 rules.cooldownMs（3 秒）');
    assert(/±50%/.test(body()) && /±5%/.test(body()), '委托价偏离 ±50% / 价格笼子 ±5%');
    assert(/买入开多/.test(body()) && /卖出开空/.test(body()), '四种下单方向都讲到了');
    assert(/同股多空互斥/.test(body()), '讲清同股多空互斥');

    // ---- 融资融券：保证金 40% / 维持率 25% / 自备 40%（2.5 倍）----
    clickTab('margin');
    assert(/40%/.test(body()), '保证金比例取 rules.marginRatio');
    assert(/25%/.test(body()), '维持率取 rules.maintenance');
    assert(/2\.5 倍/.test(body()), '杠杆倍数由 finance.ratio 反算（自备 40% → 2.5 倍）');
    assert(/券源/.test(body()) && /强平/.test(body()), '讲清券源与强平');

    // ---- 交易日：六段全在，且当前段有标记 ----
    clickTab('day');
    const dayHtml = body();
    ['开盘集合竞价', '上午连续竞价', '午间休市', '下午连续竞价', '收盘集合竞价', '休市结算'].forEach((label) => {
      assert(dayHtml.indexOf(label) >= 0, `阶段表里有「${label}」`);
    });
    assert(/3 分 50 秒/.test(dayHtml), '上午 230 秒按时长渲染（3 分 50 秒）');
    assert((dayHtml.match(/class="rule-now"/g) || []).length === 1, '只标一个「当前」阶段');
    assert(/集合竞价/.test(dayHtml) && /最大成交量/.test(dayHtml), '讲清竞价成交价的算法');

    // ---- 券商：表里带「我的」标记，数值取 preview ----
    clickTab('broker');
    assert(/华泰证券/.test(body()) && /中信证券/.test(body()), '六家券商都进表（测试里给了两家）');
    assert(/class="rule-now">我的/.test(body()), '当前券商打「我的」标');
    assert(/万2/.test(body()), '券商佣金取 preview.feeRate');
    assert(/转户/.test(body()) && /每周之星/.test(body()), '转户与每周之星都讲到了');
    assert(/按「华泰证券」的有效参数生成/.test(api.rulesSubText()), `副标题点明是按哪家券商算的（${api.rulesSubText()}）`);

    // ---- 自动化 ----
    clickTab('auto');
    assert(/最多 12 条/.test(body()), '策略配额取 rules.auto.maxPerAccount');
    assert(/止盈止损/.test(body()) && /网格/.test(body()) && /双均线/.test(body()) && /定投/.test(body()), '四类策略都讲到了');

    // ---- 称号：milestones 开着才有这一栏 ----
    clickTab('egg');
    assert(/发家线/.test(body()) && /回撤/.test(body()), '称号分类讲清四族判定');
    rich.rules.milestones = { enabled: false };
    api.setState(rich);
    api.renderRules();
    assert(api.rulesTabs().length === 8 && (api.rulesNavHtml().match(/class="rules-tab/g) || []).length === 7, '关掉彩蛋后「称号」分类自动消失（「境界」仍在）');
    assert(api.rulesTabOf() === 'start', '当前分类失效时回落到第一栏，不留空白页');

    // ---- 关闭 ----
    assert(fire('rulesCloseBtn', 'click') === 1, '「知道了」按钮挂着监听器');
    assert(api.rulesOverlayShown() === false, '点「知道了」关掉规则层');
    api.openRules();
    assert(api.rulesOverlayShown() === true, '可以再次打开');
    assert(fire('rulesCloseX', 'click') === 1 && api.rulesOverlayShown() === false, '右上角 × 也能关');
    api.openRules('trade');
    assert(api.rulesTabOf() === 'trade', 'openRules(分类) 能直接落到指定分类');

    // ---- 重开一次也不该把「新」点又亮起来（规则只在没看过时提示一次）----
    api.closeRules();
    assert(api.rulesEntryNew() === false, '看过之后入口不再挂「新」点');
  }

  console.log('\n[20] 持仓表：表头与数据行逐列对齐');
  {
    // 表头少一列，整行数值就右移一格（「多头持仓」压到「数量」下面、数值全串到隔壁表头）
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const thead = (html.match(/<thead><tr>((?:(?!<\/thead>)[\s\S])*)<\/tr><\/thead>\s*<tbody id="posBody"/) || [])[1] || '';
    const ths = (thead.match(/<th>/g) || []).length;
    assert(ths === 9, `持仓表头 9 列（实际 ${ths}）`);
    assert(/<th>持仓<\/th><th>方向<\/th>/.test(thead), '第 2 列是「方向」，对应行里的多头持仓 / 空头持仓');

    const st = mkState(AUCTION_DAY, { kind: 'open', price: 20.01, volume: 542900, locked: false });
    st.serverTime = Date.now();
    st.account.positions = [
      {
        stockId: STOCK, name: '大米集团', last: 20.17, financeDebt: 0, financePrincipal: 0,
        long: { qty: 12800, sellable: 12800, cost: 12800 * 19.44, value: 12800 * 20.17, pnl: 9344, lots: [{ lockedUntil: 0 }] },
        short: { qty: 1900, coverable: 1900, cost: 1900 * 112.03, value: 1900 * 103.93, pnl: -15390, margin: 0 },
      },
    ];
    api.setState(st);
    api.renderPositions();
    const rows = api.el('posBody').innerHTML.split('</tr>').filter((r) => /<tr/.test(r));
    assert(rows.length === 2, `一只股票的多头与空头各一行（实际 ${rows.length} 行）`);
    const cells = rows.map((r) => (r.match(/<td/g) || []).length);
    assert(cells.every((n) => n === ths), `每行 ${cells.join('/')} 格，与表头 ${ths} 列一致`);

    const emptyColspan = (html.match(/id="posBody"><tr><td colspan="(\d+)"/) || [])[1];
    assert(emptyColspan === String(ths), `HTML 里空状态 colspan 也是 ${ths}（实际 ${emptyColspan}）`);
    st.account.positions = [];
    api.setState(st);
    api.renderPositions();
    assert(/colspan="9"/.test(api.el('posBody').innerHTML), '没有持仓时空状态同样占满 9 列');
  }

  console.log('\n[21] 分时定格：集合竞价 / 午休 / 夜间线不往后生长');
  {
    const base = 1700000000000;
    const DAY_MS = 620000; // 一天 = 竞价 30s + 上午 230s + 午休 40s + 下午 260s + 收盘竞价 20s + 夜间 40s
    const mkDay = (day, over) => ({
      enabled: true, day, phase: 'morning', label: '上午连续竞价',
      trading: true, auction: null, locked: false, unlockLeftMs: null,
      phaseMs: 230000, phaseElapsedMs: 0, phaseLeftMs: 230000,
      phaseEndsAt: base + (day - 1) * DAY_MS + 260000,
      dayStartAt: base + (day - 1) * DAY_MS,
      dayEndsAt: base + day * DAY_MS,
      gameClockMs: 0, phaseGameMs: 7200000,
      ...over,
    });
    const mkFrame = (d, t, px, vol) => {
      const st = mkState(d, d.auction ? { kind: d.auction, price: px, volume: 0, locked: false } : null);
      st.serverTime = t;
      st.markets[0].last = px;
      st.markets[0].volume = vol;
      return st;
    };
    api.setChartMode('minute');
    api.setActiveView('trade');

    // ---- 连续竞价：每帧一个点，线正常往后生长 ----
    api.setHistory(STOCK, [{ t: base + 35000, price: 20, vol: 100 }]);
    api.onState(mkFrame(mkDay(1), base + 36000, 20.1, 200));
    api.onState(mkFrame(mkDay(1), base + 36700, 20.2, 300));
    let pts = api.histOf(STOCK);
    assert(pts.length === 3, `连续竞价逐帧生长（${pts.length} 点）`);
    assert(pts[2].t === base + 36700, '末点 = 最新一帧的时刻');

    // ---- 开盘集合竞价：整段只留阶段起点一个锚点 ----
    const auction = mkDay(1, {
      phase: 'auction', label: '开盘集合竞价', auction: 'open',
      phaseMs: 30000, phaseEndsAt: base + 30000, phaseLeftMs: 29000,
    });
    api.setHistory(STOCK, [{ t: base - 1000, price: 20, vol: 0 }]);
    api.onState(mkFrame(auction, base + 1000, 20, 0));
    api.onState(mkFrame(auction, base + 1700, 20, 0));
    api.onState(mkFrame(auction, base + 2400, 20, 0));
    pts = api.histOf(STOCK);
    assert(pts.length === 2, `竞价期不生长，整段塌成一个锚点（${pts.length} 点）`);
    assert(pts[1].t === base, `锚点落在竞价起点（+${pts[1].t - base}ms）`);

    // ---- 午休：同样定格，副标题说明白 ----
    const lunch = mkDay(1, {
      phase: 'lunch', label: '午间休市', trading: false, auction: null,
      phaseMs: 40000, phaseEndsAt: base + 300000, phaseLeftMs: 39000,
    });
    api.setHistory(STOCK, [{ t: base + 259000, price: 21, vol: 500 }]);
    api.onState(mkFrame(lunch, base + 261000, 21, 500));
    api.onState(mkFrame(lunch, base + 280000, 21, 500));
    pts = api.histOf(STOCK);
    assert(pts.length === 2 && pts[1].t === base + 260000, `午休定格在阶段起点（${pts.length} 点，末点 +${pts[1].t - base}ms）`);
    assert(/分时定格/.test(api.el('chartSub').textContent), `副标题点明定格「${api.el('chartSub').textContent}」`);

    // ---- 夜间：锚点原地换成收盘价，不拖尾巴 ----
    const night = mkDay(1, {
      phase: 'night', label: '休市结算', trading: false, auction: null,
      phaseMs: 40000, phaseEndsAt: base + DAY_MS, phaseLeftMs: 39000,
    });
    api.setHistory(STOCK, [{ t: base + 570000, price: 21, vol: 500 }]);
    api.onState(mkFrame(night, base + 581000, 21.6, 0));
    pts = api.histOf(STOCK);
    assert(pts.length === 2 && pts[1].t === base + 580000, `夜间锚点 = 15:00（+${pts[1].t - base}ms）`);
    assert(pts[1].price === 21.6, `锚点价换成收盘价（${pts[1].price}）`);
    api.onState(mkFrame(night, base + 600000, 21.6, 0));
    assert(api.histOf(STOCK).length === 2, '夜间继续推帧也不生长');

    // ---- 次日恢复连续竞价：从锚点接着长 ----
    api.onState(mkFrame(mkDay(2), base + DAY_MS + 1000, 21.7, 100));
    pts = api.histOf(STOCK);
    assert(pts.length === 3 && pts[2].price === 21.7, `恢复交易后继续生长（${pts.length} 点）`);
    assert(!/分时定格/.test(api.el('chartSub').textContent), '连续竞价副标题不挂定格');

    // ---- 刷新 / 切股票：/api/history 带回来的平线落地前就塌成锚点 ----
    api.onState(mkFrame(lunch, base + 261000, 21, 500));
    api.setHistory(STOCK, []);
    api.resetHistLoaded();
    scriptFetch((url) =>
      String(url).includes('/api/history')
        ? {
            ok: true,
            priceHistory: [
              { t: base + 200000, price: 20.5, vol: 400 },
              { t: base + 259000, price: 21, vol: 500 },
              { t: base + 265000, price: 21, vol: 500 },
              { t: base + 280000, price: 21, vol: 500 },
            ],
          }
        : { ok: false }
    );
    api.loadHistory(STOCK);
    await flush();
    await flush();
    pts = api.histOf(STOCK);
    assert(pts.length === 3, `服务端平线只留到午休起点（${pts.length} 点）`);
    assert(pts[1].t === base + 259000 && pts[2].t === base + 260000, '末点被夹到午休起点');
    assert(pts.every((p) => p.t <= base + 260000), '午休期间的点一条都没留下');
    resetFetch();
  }

  console.log('\n[22] 排行 → 「持仓」按钮 + 玩家持仓弹窗');
  {
    // ---- 骨架：两张榜的第 4 列是操作列，弹窗三个容器都在 ----
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    ['rankPosOverlay', 'rankPosTitle', 'rankPosSub', 'rankPosMeta', 'rankPosBody', 'rankPosCloseBtn'].forEach((id) => {
      assert(html.indexOf(`id="${id}"`) >= 0, `HTML 里有 #${id}`);
    });
    const rankHead = (html.match(/<thead><tr>((?:(?!<\/thead>)[\s\S])*)<\/tr><\/thead>\s*<tbody id="rankBody"/) || [])[1] || '';
    assert((rankHead.match(/<th/g) || []).length === 4, `玩家总榜表头 4 列（实际 ${(rankHead.match(/<th/g) || []).length}）`);
    const homeHead = (html.match(/<thead><tr>((?:(?!<\/thead>)[\s\S])*)<\/tr><\/thead>\s*<tbody id="homeRankBody"/) || [])[1] || '';
    assert((homeHead.match(/<th/g) || []).length === 4, `主页排行卡表头 4 列（实际 ${(homeHead.match(/<th/g) || []).length}）`);

    // ---- 行里带按钮，账号不是昵称（重名/改名都不会点错人） ----
    api.setBrokers({ zhaoshang: { key: 'zhaoshang', name: '招伤证券', abbr: '招伤' } });
    api.setState(
      Object.assign(mkState({ ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null }, null), {
        rules: Object.assign(mkState({}, null).rules, { initialCash: 1000000 }),
        players: [
          { account: 'trader_a', name: '股神阿三', equity: 1800000, broker: 'zhaoshang', brokerRank: 1, star: 2 },
          { name: '老服务端没账号', equity: 500000, broker: null },
        ],
      })
    );
    const rank = api.rankRowsHtml();
    assert(rank.indexOf('data-account="trader_a"') >= 0, '「持仓」按钮带的是账号（不是昵称）');
    assert(rank.indexOf('data-nick="股神阿三"') >= 0, '按钮捎带昵称，弹窗标题直接用');
    assert(rank.split('rank-pos-btn').length - 1 === 1, '没有账号的老数据不渲染按钮（避免点了查不到人）');

    // ---- 点按钮：拉 /api/player/positions，弹窗按账号取数并渲染 ----
    scriptFetch((url) =>
      String(url).indexOf('/api/player/positions') === 0
        ? {
            ok: true,
            account: 'trader_a',
            name: '股神阿三',
            broker: 'zhaoshang',
            star: 2,
            equity: 1800000,
            initialCash: 1000000,
            cash: 600000,
            longValue: 1200000,
            shortValue: 0,
            longPnl: 50000,
            shortPnl: 0,
            financeDebt: 0,
            realizedPnL: -1200,
            positions: [
              { stockId: '600001', name: '大米集团', last: 21, side: 'long', qty: 3000, avg: 20, value: 63000, pnl: 3000 },
            ],
          }
        : { ok: false, error: '网络错误' }
    );
    const btn = { dataset: { account: 'trader_a', nick: '股神阿三' } };
    assert(
      fire('rankBody', 'click', { target: { closest: () => btn } }) === 1,
      '总榜容器上挂着「持仓」按钮的事件委托'
    );
    assert(api.rankPosShown(), '点「持仓」打开弹窗');
    assert(api.el('rankPosSub').textContent === '正在读取…', '拉数据期间先给「正在读取…」');
    await flush();
    await flush();
    assert(fetchCalls.length === 1 && fetchCalls[0].url === '/api/player/positions?account=trader_a',
      `按账号拉取（${fetchCalls[0] && fetchCalls[0].url}）`);
    const body = api.el('rankPosBody').innerHTML;
    assert(body.indexOf('大米集团') >= 0 && body.indexOf('多头') >= 0, '持仓明细渲染出来（股票 + 方向）');
    assert((body.match(/<td[ >]/g) || []).length === 7, `明细行 7 格，与弹窗表头 7 列对齐（实际 ${(body.match(/<td[ >]/g) || []).length}）`);
    assert(body.indexOf('63,000.00') >= 0, '市值按千分位显示');
    assert(api.el('rankPosMeta').innerHTML.indexOf('已实现盈亏') >= 0, '账户级汇总在弹窗里（已实现盈亏）');
    assert(api.el('rankPosTitle').textContent === '股神阿三 · 持仓', `标题用昵称（${api.el('rankPosTitle').textContent}）`);

    // ---- 关掉再开别人：旧响应不能串到新弹窗 ----
    assert(fire('rankPosCloseBtn', 'click') === 1, '关闭按钮挂着监听器');
    assert(!api.rankPosShown(), '点关闭收起弹窗');
    scriptFetch(() => ({ ok: true, account: 'other_one', name: '另一个', equity: 900000, initialCash: 1000000,
      cash: 900000, longValue: 0, shortValue: 0, longPnl: 0, shortPnl: 0, financeDebt: 0, realizedPnL: 0, positions: [] }));
    api.openPlayerPositions('other_one', '另一个');
    await flush();
    await flush();
    assert(api.el('rankPosBody').innerHTML.indexOf('空仓') >= 0, '没有持仓时显示「暂无持仓（空仓）」而不是空白表');

    // ---- 失败响应：给错误文案，不冒充空仓 ----
    scriptFetch(() => ({ ok: false, error: '玩家不存在' }));
    api.openPlayerPositions('ghost', '幽灵');
    await flush();
    await flush();
    assert(api.el('rankPosSub').textContent === '玩家不存在', `失败时把服务端文案透出来（${api.el('rankPosSub').textContent}）`);
    assert(api.el('rankPosBody').innerHTML.indexOf('空仓') === -1, '读取失败不渲染成「空仓」');

    // ---- 主页排行卡也走同一个委托 ----
    resetFetch();
    scriptFetch(() => ({ ok: false, error: '玩家不存在' }));
    assert(
      fire('homeRankBody', 'click', { target: { closest: () => ({ dataset: { account: 'trader_a', nick: 'X' } }) } }) === 1,
      '主页排行卡同样能点开「持仓」'
    );
    await flush();
    await flush();
    api.closePlayerPositions();
    resetFetch();
  }

  // ---- 资产构成条：配色与比例都不许走内联 style（CSP style-src 'self' 会把整条属性丢掉）----
  console.log('\n[23] 主页资产构成条（CSP 兼容）');
  {
    const st = mkState({ ...AUCTION_DAY, phase: 'morning', auction: null }, null);
    st.rules = Object.assign({}, st.rules, { initialCash: 1000000 });
    st.account = Object.assign({}, st.account, {
      cash: 400000,
      longValue: 350000,
      shortMargin: 250000,
      equity: 1000000,
      realizedPnL: 0,
    });
    api.setState(st);
    api.renderHome();
    const html = api.el('homeAssets').innerHTML;
    assert(html.indexOf('style=') < 0, '资产构成条里没有内联 style（CSP 禁，会被浏览器整条丢弃）');
    assert((html.match(/tone-(cash|long|short)/g) || []).length >= 6,
      `三段配色走 tone-* class（bar + 图例各一次，共 ${(html.match(/tone-(cash|long|short)/g) || []).length} 处）`);
    assert(/class="mix-seg tone-cash" data-mix="400000"/.test(html),
      '段上带原始金额（插入后由 CSSOM 写 flex-grow 算比例）');
    assert(html.indexOf('¥400000') >= 0 || html.indexOf('¥400,000') >= 0, '图例带各段金额');
    const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
    assert(/\.mix-bar \.tone-cash/.test(css) && /\.mix-item \.tone-long/.test(css),
      'CSS 里有 tone-* 配色规则（bar / 图例共用）');
  }

  // ---- 弹幕：K 线隐藏、位移自适应、光标压暗、心跳、水位落盘（Doc/弹幕方案.md §6）----
  console.log('\n[24] 分时弹幕（飘屏层）');
  {
    const js = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

    // 显隐：只在「交易终端 · 分时 · 开着」时显示，K 线必须不显示（方案 §2.4）
    assert(/function dmVisible\(\)[\s\S]{0,160}!isKline\(\)/.test(js), 'dmVisible 排除 K 线模式');
    assert(/function dmVisible\(\)[\s\S]{0,160}activeView === 'trade'/.test(js), 'dmVisible 排除非交易终端视图');
    assert(/chartZoom[\s\S]{0,260}refreshDanmakuChrome\(\)/.test(js), '切换图表模式时刷新弹幕层显隐');
    assert(/\.danmaku-layer\.off \{ display: none; \}/.test(css), 'CSS 有关层隐藏规则');
    assert(/\.dm-bar\[hidden\] \{ display: none; \}/.test(css), '输入条隐藏规则（inline-flex 会盖掉 [hidden]，必须显式写）');

    // 位移：按容器宽度算，速度恒定；写死数值时大屏飞不到左边缘
    assert(/setProperty\('--dm-dist'/.test(js), 'JS 按容器宽度写 --dm-dist');
    assert(/translateX\(var\(--dm-dist/.test(css), 'keyframes 用 --dm-dist 而不是写死像素');

    // 光标压暗：读数优先
    assert(/\.danmaku-layer\.dim \{ opacity: \.35; \}/.test(css), 'CSS 有光标压暗规则');
    assert(/function dimDanmaku\(/.test(js) && /mouseleave[\s\S]{0,120}dimDanmaku\(false\)/.test(js),
      '光标离开时恢复不透明度');

    // 身份配色：散户也有自己的灰，不能落到默认墨色
    assert(/\.dm-small \{ color:/.test(css), '散户弹幕有独立配色（.dm-small）');

    // 水位：落盘 + 换账号清 + 服务端重启回退
    assert(/localStorage\.setItem\(DM_SEQ_KEY/.test(js), '弹幕水位落盘（刷新不重播旧弹幕）');
    assert(/function resetDanmakuStream\(/.test(js) && /next !== me[\s\S]{0,120}resetDanmakuStream\(\)/.test(js),
      '换账号时清水位');
    assert(/d\.seq < dmSeq\) dmSeq = 0/.test(js), '服务端 seq 回退时重置水位');

    // 心跳：没有它，盯同一只票 5 分钟后服务端 watcher 过期、这只票就哑了
    assert(/function danmakuHeartbeat\(/.test(js) && /\/api\/danmaku\/watch\?stock=/.test(js),
      '有观看心跳请求');
    assert(/function tickUI\(\)[\s\S]{0,600}danmakuHeartbeat\(\)/.test(js), '心跳挂在 200ms UI 定时器上');

    // 安全：玩家弹幕一律 textContent，不许拼 HTML
    assert(/el\.textContent = it\.kind === 'player'/.test(js), '玩家弹幕用 textContent 渲染（防注入）');

    // 表情：一套单色线条，服务端只下发 key
    assert(/\.dm-emote \{/.test(css) && /stroke: currentColor/.test(css),
      '表情用 currentColor 描边（自动跟着说话人颜色）');
    // 三处画表情的地方（飘屏 / 面板 / 标题栏按钮）都必须声明 fill:none，
    // 少一处 path 就会被默认 fill:black 涂成黑块
    const svgHosts = ['.dm-emote svg', '.dm-emo-pad svg', '.dm-emo svg'].filter((sel) => {
      const re = new RegExp(sel.replace(/\./g, '\\.') + ' \\{[\\s\\S]{0,180}?\\}');
      const m = css.match(re);
      return !(m && /fill: none/.test(m[0]) && /stroke: currentColor/.test(m[0]));
    });
    assert(svgHosts.length === 0, `三处表情容器都声明了 fill:none + currentColor（缺：${svgHosts.join(',') || '无'}）`);
    assert(/\.dm-emo-pad \{[\s\S]{0,80}position: fixed/.test(css),
      '表情面板 fixed 定位（.panel 是 overflow:hidden，absolute 会被裁掉）');
    // fixed 坐标只算一次就会飘：缩放（含手机弹键盘）与容器滚动都要重算，
    // 滚动必须用捕获阶段——输入条在图表容器里，滚的是它而不是 window
    assert(/window\.addEventListener\('resize', refitEmotePad\)/.test(js),
      '窗口缩放后面板重定位（fixed 坐标不会自己跟）');
    assert(/window\.addEventListener\('scroll', refitEmotePad, true\)/.test(js),
      '滚动时重定位，且用捕获阶段（滚的是图表容器）');
    // 重算时不能再把面板挪到 -9999 去量尺寸，否则滚动会抖；offsetWidth 不依赖位置
    assert(/if \(!pad\.style\.left\) \{/.test(js), '只有首次定位才把面板挪出视口量尺寸（重算不抖）');
    // 下方放不下要真的翻到按钮上方：只夹进视口的话面板会盖住「表」按钮，关都关不掉
    assert(/below \+ h <= vh - 8 \? below : Math\.max\(8, above\)/.test(js),
      '下方放不下时翻到按钮上方（不只夹进视口，否则盖住按钮）');
    const emoKeys = api.dmEmoteKeys();
    const serverKeys = require(path.join(__dirname, '..', '..', 'Server', 'src', 'danmaku-emotes.js')).KEYS;
    assert(emoKeys.length >= 16, `客户端表情 ${emoKeys.length} 个`);
    assert(emoKeys.length === serverKeys.length && serverKeys.every((k) => emoKeys.includes(k)),
      '客户端表情表覆盖服务端白名单（少一个就红）');
    const node = api.dmEmoteNode('cry');
    assert(node && node.className === 'dm-emote', '白名单 key 渲染成 .dm-emote');
    assert(node && /viewBox="0 0 24 24"/.test(node.innerHTML), '表情是 24×24 的 svg');
    assert(api.dmEmoteNode('不存在的表情') === null, '未知 key 返回 null（不崩整条弹幕）');

    // 双色：光有 currentColor 描边就是一根灰线，深色终端里太素。
    // 每个表情必须自带一个语义色，并且真的画进了 svg —— 将来加表情忘了上色会在这里红
    const emotes = api.dmEmotes();
    const colorless = Object.keys(emotes).filter((k) => {
      const def = emotes[k];
      return !/^#[0-9a-f]{6}$/i.test(def.tone || '') || !/fill="|stroke="#[0-9a-f]{6}"/i.test(def.svg);
    });
    assert(colorless.length === 0, `每个表情都有自己的语义色（缺色：${colorless.join(',') || '无'}）`);
    assert(emotes.chartup.tone !== emotes.chartdown.tone, '涨跌两个表情颜色不同（红涨绿跌）');
    assert(/fill="#f0464b"/i.test(emotes.chartup.svg) && !/fill="#f0464b"/i.test(emotes.chartdown.svg),
      '涨是红、跌是绿（别把 A 股配色反过来）');

    // 选择器：开合 + 选中态回显到按钮
    api.setEmotePick('');
    assert(api.emoteBtnText() === '表', '没选表情时按钮显示「表」');
    api.setEmotePick('cry');
    assert(/viewBox="0 0 24 24"/.test(api.emoteBtnHtml()), '选中后按钮显示那张表情');
    api.toggleEmotePad(true);
    assert(api.emotePadShown(), '面板能打开');
    assert(/data-emo="cry"/.test(api.emotePadHtml()), '面板里是表情按钮（data-emo）');
    // CSP 是 style-src 'self'，innerHTML 里的 `style="color:…"` 会被浏览器整条拦掉
    // （线上实测：控制台 "Applying inline style violates…"，面板退成一排同色灰线；
    //  预览页走 file:// 没有 CSP，所以预览是彩色的、看不出来）
    assert(!/style="/.test(api.emotePadHtml()), '面板 HTML 里没有内联 style（CSP 会拦掉它）');
    assert(/\.style\.color = def\.tone/.test(js), '面板配色走 CSSOM（el.style.color），不受 CSP 限制');
    api.toggleEmotePad(false);
    assert(!api.emotePadShown(), '面板能收起');
    api.setEmotePick('');

    // 发送时把 key 一起带上：服务端只认 key，客户端不传就等于白选
    assert(/apiPost\('\/api\/danmaku', \{ stockId: activeStockId, text: body, emote \}\)/.test(js),
      '发送请求带上 emote');
    // 只点了表情没写字时，回车必须给回执；静默 return 会被当成按钮坏了
    assert(/表情要跟着一句话一起发/.test(js), '只选表情不发文字时给提示（不静默）');

    // 系列（pack）：「经典」是默认系列，协议不变，以后加系列只动两张表
    const serverMod = require(path.join(__dirname, '..', '..', 'Server', 'src', 'danmaku-emotes.js'));
    const packs = api.dmPacks();
    assert(serverMod.DEFAULT_PACK === 'classic' && packs[0].id === 'classic',
      '默认系列都是 classic（客户端与服务端首项对齐）');
    assert(Object.keys(serverMod.PACKS).every((id) => packs.some((p) => p.id === id)),
      '客户端系列覆盖服务端 PACKS（漏一个系列就红）');
    assert(packs.every((p) => p.id && p.label && Object.keys(p.items).length > 0), '每个系列都有 id/label/至少一个表情');
    api.toggleEmotePad(true);
    assert(!/dm-emo-tab/.test(api.emotePadHtml()), '只有一个系列时不渲染 tab 行（一个 tab 的 tab 栏是噪音）');
    api.toggleEmotePad(false);

    // 临时注册第二个系列：验证 tab 出现、能切、选中项跨系列不丢、未知系列回退
    api.dmPushPack({
      id: 'zztest', label: '测试',
      items: { zzwave: { label: '挥手', tone: '#88ccff', svg: '<path d="M4 12h16"/>' } },
    });
    api.toggleEmotePad(true);
    assert(/dm-emo-tab/.test(api.emotePadHtml()) && /data-pack="zztest"/.test(api.emotePadHtml()),
      '多系列时出现 tab 行');
    api.setDmPack('zztest');
    assert(api.dmPack() === 'zztest', '能切到新系列');
    assert(/data-emo="zzwave"/.test(api.emotePadHtml()), '面板换成新系列的表情');
    assert(api.dmPackSaved() === 'zztest', '停在哪一页会记住（localStorage）');
    api.setEmotePick('cry');
    assert(api.dmEmoteDef('cry') && api.dmEmoteDef('zzwave'), '跨系列都能查到定义（切页不丢已选表情）');
    // 切页会重建 innerHTML，选中态必须跟着 HTML 一起拼出来（以前只重建、不补标，切回来就没了）
    api.setDmPack('classic');
    assert(/data-emo="cry"[^>]*class="on"/.test(api.emotePadHtml()), '切回原系列后选中态还在（重建不丢高亮）');
    api.setDmPack('zztest');
    assert(!/data-emo="zzwave"[^>]*class="on"/.test(api.emotePadHtml()), '新系列里没有选中项时不高亮');
    api.setEmotePick('');
    api.setDmPack('不存在的系列');
    assert(api.dmPack() === 'classic', '未知系列 id 回退默认（别让整块面板空掉）');
    api.toggleEmotePad(false);
  }

  console.log('\n[25] 融券面板：空头总持仓走「收盘披露」口径');
  {
    const st = mkState(AUCTION_DAY, null);
    st.markets[0].floatShares = 2000000;
    st.markets[0].lending = {
      enabled: true, total: 500000, borrowed: 200000, reserved: 0, available: 300000,
      utilization: 40, dailyRate: 0.1, settle: 'daily', settledDay: 6,
      allowNakedShort: false,
      // 服务端下发的就是披露值：收盘定格 120000，日内实时值（比如已经 300000）不下发
      shortInterest: 120000, shortInterestDay: 7,
      history: [
        { t: Date.now() - 86400000, day: 6, qty: 90000 },
        { t: Date.now(), day: 7, qty: 120000 },
      ],
    };
    api.setState(st);
    api.renderLending();
    const html = getEl('lendingMeta').innerHTML;
    assert(/空头总持仓/.test(html), '面板仍显示「空头总持仓」这一项');
    assert(/120,000/.test(html), '显示的是当天收盘定格的那个数');
    assert(/6\.00%/.test(html), `占比按披露值算（120000 / 2000000 = 6.00%）`);
    assert(!/未披露/.test(html), '已披露过就不带「未披露」角标');

    // 新开局第一天（服务端 shortInterestDay = -1，shortInterest = null）：显示 —，不显示数字
    st.markets[0].lending.shortInterestDay = -1;
    st.markets[0].lending.shortInterest = null;
    api.renderLending();
    const html2 = getEl('lendingMeta').innerHTML;
    assert(/未披露/.test(html2), '没披露过时打「未披露」角标');
    assert(/>—</.test(html2), '没披露过时显示 —（不给数字，也不填 0）');
    const row2 = html2.split('<div class="item">').find((x) => x.includes('空头总持仓')) || '';
    assert(!/300,000|0\.00%/.test(row2), '「空头总持仓」这一项不拿实时值或 0 冒充收盘数据');

    // 老版本服务端：不下发 shortInterestDay，shortInterest 恒为数字 → 原样显示、不挂角标
    st.markets[0].lending.shortInterestDay = undefined;
    st.markets[0].lending.shortInterest = 300000;
    api.renderLending();
    const html3 = getEl('lendingMeta').innerHTML;
    assert(/300,000/.test(html3) && !/未披露/.test(html3), '老服务端兼容：照旧显示数字，不凭空挂角标');
  }

  // ============================================================
  console.log('\n[26] 头像：顶栏按 account.avatar.key 渲染、环色走 class、锁卡不发请求');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    ['avaBtn', 'avaImg', 'avaCh', 'avaNew', 'avaOverlay', 'avaGroups', 'avaCloseBtn'].forEach((id) => {
      assert(html.indexOf(`id="${id}"`) >= 0, `HTML 里有 #${id}（六个落点里顶栏与弹层的骨架）`);
    });
    // 入口只有一个：顶栏头像。它必须在昵称左边（顺序即布局）
    const topRight = (html.match(/<div class="top-right">([\s\S]*?)<\/header>/) || [])[1] || '';
    assert(topRight.indexOf('id="avaBtn"') >= 0 && topRight.indexOf('id="avaBtn"') < topRight.indexOf('id="whoName"'),
      '顶栏头像在昵称左侧（唯一入口）');

    const mkAvatarState = (avat, extraRules) => {
      const st = mkState(AUCTION_DAY, null);
      st.account.avatar = avat;
      st.account.realm = { idx: 10, name: '结丹中期', group: 'jindan', honor: '金丹真人' };
      st.rules.avatar = extraRules === undefined
        ? {
            enabled: true,
            groups: [
              {
                id: 'base', label: '基础', hint: '开户即全部解锁',
                rows: [
                  { key: 'bull', name: '死多头', unlock: { type: 'base', value: null, text: '' } },
                  { key: 'bear', name: '大空头', unlock: { type: 'base', value: null, text: '' } },
                ],
              },
              {
                id: 'broker', label: '门派', hint: '',
                rows: [{ key: 'broker-huatai', name: '滑泰快枪手', unlock: { type: 'broker', value: 'huatai', text: '转户到滑泰证券后解锁' } }],
              },
            ],
          }
        : extraRules;
      return st;
    };

    // ---- ① 顶栏头像按 key 渲染，环色 = 境界分组（class，不是内联 style）----
    api.setState(mkAvatarState({ key: 'bull', name: '死多头', chosen: false, unlocked: ['bull', 'bear'] }));
    api.setAvatarCatalog(api.setState ? undefined : undefined); // 目录由 onState 缓存，这里直接注入
    api.setAvatarCatalog(mkAvatarState(null).rules.avatar);
    api.setAvaTopSig('');
    api.renderTopAvatar();
    const btn = api.avaBtn();
    assert(!btn.hidden, '顶栏头像可见');
    assert(/g-jindan/.test(btn.cls), `环色 class = g-jindan（实际 ${btn.cls}）`);
    assert(api.avaImg().src === '/img/avatar-bull-96.png', `≤40px 取 -96 档（${api.avaImg().src}）`);
    assert(/换一张脸/.test(btn.title), 'title 说明这是换脸入口');
    const topHtml = api.avaHtml('bull', 26, 'jindan', '死多头');
    assert(topHtml.indexOf('style=') < 0, '头像 HTML 里**没有内联 style**（CSP style-src self 会静默拦掉）');
    assert(/g-jindan/.test(topHtml), '环色靠 g-<group> class 传递');
    assert(new RegExp(`avatar-bull-96\\.png`).test(topHtml), '26px 用 96 档');
    assert(new RegExp(`avatar-bull-192\\.png`).test(api.avaHtml('bull', 64, 'jindan', '死多头')), '64px 用 192 档');

    // ---- ② 排行榜行带头像；「我」按账号认 ----
    const st = mkAvatarState({ key: 'bull', name: '死多头', chosen: true, unlocked: ['bull', 'bear'] });
    st.players = [
      { account: 'user001', name: '老王', equity: 1100000, ava: 'bull', broker: 'zhongxin', brokerRank: 1, star: 1, realm: { idx: 10, group: 'jindan', name: '结丹中期', short: '金丹' } },
      { account: 'user002', name: '老王', equity: 1000000, ava: 'bear', broker: 'huatai', brokerRank: 1, star: 1, realm: null },
    ];
    api.setState(st);
    api.setBrokers({ zhongxin: { name: '钟信证券', abbr: '钟信' }, huatai: { name: '滑泰证券', abbr: '滑泰' } });
    const rows = api.rankRowsHtml(20);
    assert(/avatar-bull-96\.png/.test(rows) && /avatar-bear-96\.png/.test(rows), '两个重名「老王」靠头像区分');
    assert((rows.match(/class="ava s22/g) || []).length === 2, '排行榜每行一个 22px 头像');

    // ---- ③ 锁卡：只出文案、不发请求 ----
    resetFetch();
    api.avaCellClick({ getAttribute: (k) => ({ 'data-locked': '1', 'data-unlock': '转户到滑泰证券后解锁' }[k]) });
    assert(fetchCalls.length === 0, '点锁卡不发请求（省一次 403）');

    // ---- ④ 可换卡：只打一次 /api/avatar，body 只有 {key} ----
    scriptFetch({ ok: true, avatar: { key: 'bear', name: '大空头', chosen: true, unlocked: ['bull', 'bear'] } });
    api.avaCellClick({ getAttribute: (k) => ({ 'data-locked': '0', 'data-key': 'bear' }[k]) });
    await flush();
    await flush();
    const posts = fetchCalls.filter((c) => c.url === '/api/avatar');
    assert(posts.length === 1, `只打一次 /api/avatar（实际 ${posts.length} 次）`);
    assert(posts[0] && JSON.stringify(posts[0].body) === JSON.stringify({ key: 'bear' }),
      `body 只有 {key}（${posts[0] && JSON.stringify(posts[0].body)}）`);
    assert(api.avaImg().src === '/img/avatar-bear-96.png', '换脸成功后顶栏原地刷新成新脸');
    assert(fetchCalls.filter((c) => c.url === '/api/state').length === 0, '换脸不重拉 /api/state（下一帧自然就变）');
    resetFetch();

    // ---- ⑤ 裂图降级：图隐藏、首字兜位（宽高已固定，行高不跳）----
    const fakeImg = { hidden: false, nextElementSibling: { hidden: true } };
    api.onAvaImgError(fakeImg);
    assert(fakeImg.hidden === true && fakeImg.nextElementSibling.hidden === false, 'onerror → 图隐藏、首字可见');

    // ---- ⑥ 老服务端（没有 rules.avatar）：不渲染、不报错 ----
    let threw = false;
    try {
      api.setState(mkAvatarState({ key: 'bull', name: '死多头', chosen: true, unlocked: [] }, null));
      api.setAvaTopSig('');
      api.renderTopAvatar();
    } catch (e) {
      threw = true;
    }
    assert(!threw, '服务端没下发 rules.avatar 时不抛错');
    assert(api.avaBtn().hidden === true, '没有头像目录时顶栏不渲染头像（老服务端照常能用）');

    // ---- ⑦ 首次引导：没主动选过 → 金点 + 一次 toast；选过就不再提示 ----
    delete store.gushen_ava_seen; // 清掉「已看过引导」水位（桩 localStorage 就是这个对象）
    api.setAvaIntroShown(false);
    api.setState(mkAvatarState({ key: 'bull', name: '韭菜本菜', chosen: false, unlocked: ['bull'] }));
    api.setAvaTopSig('');
    api.renderTopAvatar();
    assert(api.avaNewHidden() === false, '没选过脸 → 顶栏头像挂金点');
    api.setState(mkAvatarState({ key: 'bull', name: '死多头', chosen: true, unlocked: ['bull'] }));
    api.renderTopAvatar();
    assert(api.avaNewHidden() === true, '主动选过 → 金点消失');
    api.markAvaSeen();
    assert(api.avaSeenStored() === '1', '点开弹层即记下"已看过引导"（只提示一次）');

    // ---- ⑧ 弹层卡片：三态（已选 / 可换 / 锁定）+ 条件文案来自服务端 ----
    api.setState(mkAvatarState({ key: 'bull', name: '死多头', chosen: true, unlocked: ['bull', 'bear'] }));
    const cells = api.avaCellsHtml();
    assert(/ava-cell cur/.test(cells), '当前那张标 cur（金环 + 勾）');
    assert(/data-locked="1"/.test(cells) && /转户到滑泰证券后解锁/.test(cells), '未解锁的卡带 data-locked 与服务端文案');
    assert(/ava-lock/.test(cells), '锁卡有锁图标');
    assert((cells.match(/avatar-[a-z-]+-192\.png/g) || []).length === 3, '弹层 64px 卡取 -192 档');
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();