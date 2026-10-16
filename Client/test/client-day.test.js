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
const els = new Map();
function mkEl(id) {
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
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    appendChild() {},
    focus() {},
    get offsetWidth() {
      return 120;
    },
    getContext: () => null,
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
    setState: (v) => { state = v; },
    setDrift: (ms) => { lastStateAt = Date.now() - ms; },
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
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: () => 0,
  localStorage: localStorageStub,
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
  },
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

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
