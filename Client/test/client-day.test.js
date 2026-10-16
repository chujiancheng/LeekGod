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
function mkEl(id) {
  const cls = new Set();
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
    addEventListener() {},
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
  fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
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
  const calls = [];
  sandbox.fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  };
  const dailyCalls = () => calls.filter((u) => u.includes('/api/daily')).length;

  api.setChartMode('day');
  // 第 14 天盘中：第一次进日线模式 → 拉一次
  api.onState(mkState({ ...AUCTION_DAY, day: 14, phase: 'morning', label: '上午连续竞价', auction: null }, null));
  assert(dailyCalls() === 1, `盘中首帧拉一次日线（${dailyCalls()} 次）`);
  assert(api.el('chartSub').textContent === '日线 · 蜡烛 + 成交量 + MA5/MA10', `日线副标题 ${api.el('chartSub').textContent}`);
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


console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
