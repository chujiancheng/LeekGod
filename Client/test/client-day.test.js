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
    className: '',
    disabled: false,
    title: '',
    value: '',
    style: {},
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
    renderNews, newsRowsHtml,
    renderFlow, renderChartMode, onState,
    renderBrokerWall, renderMyBroker, renderSeats, renderMarginCall,
    renderBrokerWeeklyHint, seatHtml, newsHintsHtml, brokerCardHtml, fmtFeeRate, rankRowsHtml,
    pumpEggs, renderEggCard, showEggBanner, hideEggBanner, bindEggs, eggSeqStored,
    setIdentity, resetEggStream,
    eggState: () => ({ lastSeq: lastEggSeq, queued: eggQueue.length, busy: eggBusy }),
    eggTimerInfo: () => (eggTimer == null ? null : __timers.get(eggTimer) || null),
    setState: (v) => { state = v; },
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
    renderPositions, posRowsHtml,
    identity: () => ({ account: me, nick: myNick, token }),
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
    api.el('chartSub').textContent === '日线 · 蜡烛 + 成交量 + MA5/MA10 + MACD(12,26,9)',
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
  assert(api.el('chartSub').textContent === '周线 · 每 7 个交易日 · 蜡烛 + 成交量 + MA5/MA10 + MACD(12,26,9)',
    `周线副标题 ${api.el('chartSub').textContent}`);
  assert(api.el('chartRanges').hidden === true, '周线模式隐藏「当日 / 5 日」');
  api.setChartMode('month');
  api.renderChartMode();
  assert(api.el('chartSub').textContent === '月线 · 每 4 周 · 蜡烛 + 成交量 + MA5/MA10 + MACD(12,26,9)',
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
  // ---- 日线抓 260 根只为周/月线：日线自己只画最近 120 根 ----
  const long = [];
  for (let d = 1; d <= 260; d++) long.push(mkBar(d, 10, 11, 9, 10 + d * 0.1, 1000));
  api.setDayBars(STOCK, long);
  const stLong = mkState({ ...AUCTION_DAY, day: 260, phase: 'morning', auction: null }, null);
  api.setState(stLong);
  api.setChartMode('day');
  const d120 = api.daySeriesOf(stLong.markets[0]);
  assert(d120.length === 120, `日线只画最近 120 根（${d120.length} 根）`);
  assert(d120[d120.length - 1].day === 260, `截的是尾部、末根仍是第 260 天（${d120[d120.length - 1].day}）`);
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
  assert(api.el('chartSub').textContent === '周线 · 每 5 个交易日 · 蜡烛 + 成交量 + MA5/MA10 + MACD(12,26,9)',
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
  api.setChartMode('minute');
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

  // ---- 进度卡 ----
  const st = mkState({ ...AUCTION_DAY, phase: 'morning', label: '上午连续竞价', auction: null }, null);
  st.rules = Object.assign(st.rules, { milestones: { enabled: true, tone: 'savage' } });
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
  });
  api.setState(st);
  api.renderEggCard();
  const card = api.el('eggCard');
  assert(card.hidden === false, '有彩蛋段时卡片显示');
  const html = card.innerHTML;
  assert(html.indexOf('半个千万') >= 0 && html.indexOf('当前称号') >= 0, '展示当前称号（取稀有度最高）');
  assert(html.indexOf('八百万') >= 0 && html.indexOf('277.00万元') >= 0, '展示下一档与还差多少');
  assert(html.indexOf('520.00万元') >= 0, '展示峰值权益（水位线）');
  assert(html.indexOf('6.2%') >= 0 && html.indexOf('18.0%') >= 0, '展示当前回撤与历史最大回撤');
  assert(html.indexOf('保本出关') >= 0, '已获得的称号都列出来');
  assert(html.indexOf('data-w="7"') >= 0, '进度条宽度走 data-w（CSP 禁内联 style）');

  // 门槛已达：文案切换成「等收盘确认」
  const st2 = JSON.parse(JSON.stringify(st));
  st2.account.events.progress = { id: 'A06', title: '八百万', equity: 8000000, from: 5000000, need: 0, pct: 1, reached: true };
  api.setState(st2);
  api.renderEggCard();
  assert(api.el('eggCard').innerHTML.indexOf('等收盘结算确认') >= 0, '已越过门槛时提示等收盘确认');

  // 服务端关掉彩蛋 / 老服务端没有这个段：卡片隐藏且不报错
  api.setState(mkState(AUCTION_DAY, null));
  api.renderEggCard();
  assert(api.el('eggCard').hidden === true, '没有 account.events 段（老服务端）时卡片隐藏');
  const st3 = JSON.parse(JSON.stringify(st));
  st3.rules.milestones = { enabled: false };
  api.setState(st3);
  api.renderEggCard();
  assert(api.el('eggCard').hidden === true, '服务端关掉彩蛋时卡片隐藏');

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

  assert(api.themes().length === 5, `主题表含默认在内共 5 套（实际 ${api.themes().length}）`);
  assert(api.themes()[1] === 'broker' && api.themes()[4] === 'magic', '主题表顺序 = 弹窗里的排列顺序');

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
      lending: { enabled: true, baseMinuteRate: 0.0001, maxMinuteRate: 0.0004 },
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
    assert(api.rulesTabs().length === 7, `七个分类（实际 ${api.rulesTabs().length}）`);
    assert((api.rulesNavHtml().match(/class="rules-tab/g) || []).length === 7, '分类栏渲染出七个按钮');
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
    assert(api.rulesTabs().length === 7 && (api.rulesNavHtml().match(/class="rules-tab/g) || []).length === 6, '关掉彩蛋后「称号」分类自动消失');
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

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
