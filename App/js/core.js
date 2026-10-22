/* ==========================================================================
   core.js — 基础层：格式化 / 存储 / 状态 / 路由 / toast / 弹层
   全局命名空间 GS，后续文件都往 GS 上挂
   ========================================================================== */
window.GS = window.GS || {};

(function (GS) {
  'use strict';

  /* ------------------------------------------------------------ DOM 工具 */

  const $ = (id) => document.getElementById(id);

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  /** 任何服务端字符串进 HTML 前必须过一遍 */
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  const on = (root, sel, ev, fn) => {
    root.addEventListener(ev, (e) => {
      const t = e.target.closest(sel);
      if (t && root.contains(t)) fn(e, t);
    });
  };

  /* ---------------------------------------------------------- 数字格式化 */

  const num = (v) => (Number.isFinite(+v) ? +v : 0);

  /** 价格：固定两位 */
  const fmtP = (v) => num(v).toFixed(2);

  /** 涨跌幅带符号 */
  const fmtPct = (v) => (num(v) >= 0 ? '+' : '') + num(v).toFixed(2) + '%';

  /** 涨跌额带符号 */
  const fmtChg = (v) => (num(v) >= 0 ? '+' : '') + num(v).toFixed(2);

  /** 股数：千分位 */
  const fmtQty = (v) => num(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 });

  /** 金额：万 / 亿 缩写 */
  function fmtAmt(v) {
    const n = num(v);
    const a = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (a >= 1e8) return sign + (a / 1e8).toFixed(2) + '亿';
    if (a >= 1e4) return sign + (a / 1e4).toFixed(1) + '万';
    return sign + a.toFixed(0);
  }

  /** 金额精确到分（下单预估用） */
  const fmtMoney = (v) =>
    num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /** 涨跌配色 class（A 股口径：涨红跌绿） */
  const cls = (v) => (num(v) > 0 ? 'up' : num(v) < 0 ? 'down' : 'flat');

  /** 时刻 HH:MM:SS */
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** 时刻 HH:MM */
  function fmtHM(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 剩余毫秒 → 「12 秒」「3 分 05」 */
  function fmtLeft(ms) {
    const s = Math.max(0, Math.ceil(num(ms) / 1000));
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    return m + ' 分 ' + String(s % 60).padStart(2, '0');
  }

  /* ---------------------------------------------------------------- 存储 */

  const KEY = {
    account: 'gushen_app_account',
    nick: 'gushen_app_nick',
    token: 'gushen_app_token',
    stock: 'gushen_app_stock',
    tab: 'gushen_app_tab',
    mascot: 'gushen_app_mascot',
  };

  /* ------------------------------------------------------------- 看板娘 */

  /**
   * 看板娘阵容（与网页端 MASCOTS 同一批立绘）：立绘 /img/mascot-<id>-256.png、
   * 缩略图 -96.png，都由服务端同一套静态资源出。默认看盘少女。
   */
  const MASCOTS = [
    { id: 'kanpan',  name: '看盘少女', desc: '盯盘不眨眼，只看涨' },
    { id: 'sakura',  name: '和服猫耳少女', desc: '樱色原配' },
    { id: 'magic',   name: '魔法少女', desc: '夜空原配' },
    { id: 'maodiao', name: '耄耋猫', desc: '亏麻了，也要招财' },
    { id: 'orange',  name: '丑橘猫', desc: '涨了！傻乐' },
    { id: 'doro',    name: '小恶魔朵洛', desc: '举爪招涨' },
    { id: 'duck',    name: '咕咕嘎嘎', desc: 'duck 不服' },
    { id: 'knight',  name: '刀盾骑士', desc: '我的刀！我的盾！' },
    { id: 'whale',   name: '小鲸鱼', desc: '深海捞涨点' },
  ];
  const MASCOT_DEFAULT = 'kanpan';

  function mascotId() {
    const v = store.get(KEY.mascot, MASCOT_DEFAULT);
    return MASCOTS.some((m) => m.id === v) ? v : MASCOT_DEFAULT;
  }

  function setMascot(id) {
    store.set(KEY.mascot, MASCOTS.some((m) => m.id === id) ? id : MASCOT_DEFAULT);
  }

  function mascotImg(id, big) {
    return '/img/mascot-' + id + (big ? '-256' : '-96') + '.png';
  }

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : v;
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch (e) {
        /* 隐私模式忽略 */
      }
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch (e) {
        /* 忽略 */
      }
    },
  };

  /* -------------------------------------------------------------- 全局态 */

  const S = {
    /** 服务端 state 帧 */
    state: null,
    /** 最后一次收到 state 的时间 */
    stateAt: 0,
    /** 账号（身份）与昵称（展示名） */
    account: store.get(KEY.account, ''),
    nick: store.get(KEY.nick, ''),
    token: store.get(KEY.token, ''),
    /** 当前个股 */
    stockId: store.get(KEY.stock, ''),
    /** 首页 tab */
    tab: store.get(KEY.tab, 'market'),
    /** 当前二级页（null = 无） */
    page: null,
    /** 全局刷新订阅：视图注册自己的 update */
    listeners: new Set(),
  };

  /** 订阅 state 变化，返回取消函数 */
  function subscribe(fn) {
    S.listeners.add(fn);
    return () => S.listeners.delete(fn);
  }

  function emit() {
    S.listeners.forEach((fn) => {
      try {
        fn(S.state);
      } catch (e) {
        console.error('[view]', e);
      }
    });
  }

  /**
   * 当前标的行情。个股在 `state.markets` 里，**指数（999999）单独挂在 `state.index`**——
   * 服务端 `marketSnapshots()` 不把指数混进 markets 列表，所以这里做一次回落，
   * 让「个股详情页」这套代码能原样拿去渲染大盘（字段同构，见 indexfeed.snapshot）。
   */
  function market(stockId) {
    const st = S.state;
    if (!st) return null;
    if (stockId && st.index && st.index.stockId === stockId) return st.index;
    if (!Array.isArray(st.markets)) return null;
    if (!stockId) return st.markets[0] || null;
    return st.markets.find((m) => m.stockId === stockId) || null;
  }

  /** 是不是大盘指数：只读标的（不能下单、没有五档/股东榜/弹幕） */
  function isIndex(stockId) {
    const st = S.state;
    return !!(st && st.index && st.index.stockId === stockId);
  }

  /** 账户某只股票的持仓 */
  function position(stockId) {
    const acc = S.state && S.state.account;
    if (!acc || !Array.isArray(acc.positions)) return null;
    return (
      acc.positions.find((p) => p.stockId === stockId) || null
    );
  }

  function isTrading() {
    const d = S.state && S.state.day;
    return !!(d && d.trading && !(S.state.halt && S.state.halt.halted));
  }

  /** 服务器时间（用本地时钟插值，避免 700ms 帧之间秒数停住） */
  function serverNow() {
    const st = S.state;
    if (!st || !st.serverTime) return Date.now();
    return st.serverTime + (Date.now() - S.stateAt);
  }

  /* ---------------------------------------------------------------- toast */

  /* 每条 toast 各管各的两个定时器（淡出 / 移除）。
     早期版本共用一个全局 timer：新 toast 的 clearTimeout 会把上一条的「收起」动作
     一起清掉，那条就永远停在屏幕上——尤其容易在「触碰/点击消息」时触发
     （点一下冒出新 toast，旧的就赖着不走了）。
     另外：App 熄屏 / 切后台时 setTimeout 会被冻结，回到前台按出生时刻补清。 */
  const TOAST_MS = 2200; // 停留时长
  const TOAST_FADE = 240; // 淡出，与 CSS transition 对齐
  const TOAST_MAX = 3; // 同屏最多留几条，超了最老的先走
  const toastTimers = new WeakMap(); // el -> { hide, kill }

  /** 收起某条：幂等，重复调用只会走第一次 */
  function dismissToast(el) {
    if (!el || !el.isConnected || el.dataset.out) return;
    const t = toastTimers.get(el);
    if (t) clearTimeout(t.hide);
    el.dataset.out = '1';
    el.classList.remove('in');
    const kill = setTimeout(() => {
      toastTimers.delete(el);
      if (el.parentNode) el.parentNode.removeChild(el);
    }, TOAST_FADE + 80);
    toastTimers.set(el, { hide: 0, kill });
  }

  /** 回到前台：熄屏 / 后台期间被冻结的过期 toast 会被系统留着，按出生时刻补清 */
  function sweepToast() {
    const wrap = $('toastWrap');
    if (!wrap) return;
    const now = Date.now();
    Array.prototype.slice.call(wrap.children).forEach((c) => {
      const born = Number(c.dataset.born) || 0;
      if (!c.dataset.out && born && now - born >= TOAST_MS) dismissToast(c);
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sweepToast();
  });

  function toast(msg, kind) {
    const wrap = $('toastWrap');
    if (!wrap) return;
    // 超上限的部分（只数还在显示的）先让位，避免刷屏糊成一片
    const alive = Array.prototype.filter.call(wrap.children, (c) => !c.dataset.out);
    for (let i = 0; i <= alive.length - TOAST_MAX; i++) dismissToast(alive[i]);

    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = String(msg);
    el.dataset.born = String(Date.now());
    // 手指碰到就收起：父容器是 pointer-events:none，点击会穿透到下面的元素，
    // 反而冒出新 toast——不如让 toast 自己吃掉这一下
    el.addEventListener('click', () => dismissToast(el), { passive: true });
    wrap.appendChild(el);
    void el.offsetHeight; // 强制回流触发过渡；不用 rAF——后台不跑，回来会卡在 opacity:0
    el.classList.add('in');
    toastTimers.set(el, { hide: setTimeout(() => dismissToast(el), TOAST_MS), kill: 0 });
    if (navigator.vibrate) {
      try {
        navigator.vibrate(kind === 'err' ? [0, 26] : 12);
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  /* ---------------------------------------------------------------- 弹层 */

  let curSheet = null;

  /**
   * 底部弹层。
   * @param {{title:string, html:string, onMount?:Function, onClose?:Function}} opt
   */
  function sheet(opt) {
    closeSheet(true);
    const mask = $('sheetMask');
    const el = $('sheet');
    el.innerHTML =
      '<div class="sheet-grip"></div>' +
      '<div class="sheet-head">' +
        '<div class="sheet-title">' + esc(opt.title || '') + '</div>' +
        '<button class="icon-btn" data-sheet-close aria-label="关闭">' + icon('close') + '</button>' +
      '</div>' +
      '<div class="sheet-body">' + (opt.html || '') + '</div>';
    el.hidden = false;
    mask.hidden = false;
    // 强制回流后再加 in，否则过渡不触发
    void el.offsetHeight;
    el.classList.add('in');
    mask.classList.add('in');

    const ctl = {
      el,
      body: el.querySelector('.sheet-body'),
      close() {
        closeSheet();
      },
    };
    curSheet = ctl;

    mask.onclick = () => closeSheet();
    el.querySelector('[data-sheet-close]').onclick = () => closeSheet();
    if (opt.onMount) opt.onMount(ctl);
    return ctl;
  }

  function closeSheet(immediate) {
    const el = $('sheet');
    const mask = $('sheetMask');
    if (!el || el.hidden) return;
    const ctl = curSheet;
    curSheet = null;
    el.classList.remove('in');
    mask.classList.remove('in');
    const done = () => {
      el.hidden = true;
      mask.hidden = true;
      el.innerHTML = '';
      if (ctl && ctl.onClose) ctl.onClose();
    };
    if (immediate) done();
    else setTimeout(done, 280);
  }

  /* ------------------------------------------------------------ 二级页 */

  const pageStack = [];

  /**
   * 打开二级页（右侧滑入）。
   * @param {{html:string, onMount?:Function}} opt
   */
  function openPage(opt) {
    const el = $('page');
    el.innerHTML = opt.html || '';
    el.hidden = false;
    void el.offsetHeight;
    el.classList.add('in');
    const ctl = {
      el,
      body: el.querySelector('.page-body'),
      close() {
        closePage();
      },
    };
    pageStack.push(ctl);
    S.page = ctl;
    if (opt.onMount) opt.onMount(ctl);
    return ctl;
  }

  function closePage() {
    const el = $('page');
    if (!el || el.hidden) return;
    const ctl = pageStack.pop();
    el.classList.remove('in');
    S.page = pageStack[pageStack.length - 1] || null;
    setTimeout(() => {
      if (!S.page) {
        el.hidden = true;
        el.innerHTML = '';
      }
    }, 300);
    if (ctl && ctl.onClose) ctl.onClose();
  }

  /** 安卓物理返回键 / 浏览器返回：先关弹层与二级页，再退 App */
  function bindBackKey() {
    window.addEventListener('popstate', () => {
      if (curSheet) {
        closeSheet();
        history.pushState({ root: true }, '');
        return;
      }
      if (S.page) {
        closePage();
        history.pushState({ root: true }, '');
        return;
      }
    });
    history.pushState({ root: true }, '');
  }

  /* ---------------------------------------------------------------- 图标 */

  const ICONS = {
    market: '<path d="M3 17l5-6 4 3 5-8"/><path d="M3 21h18"/>',
    trade: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M9 10v10"/>',
    rank: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    me: '<circle cx="12" cy="8" r="3.4"/><path d="M4.5 20a7.5 7.5 0 0115 0"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    refresh: '<path d="M20 11a8 8 0 10-2.3 6.7"/><path d="M20 5v6h-6"/>',
    bell: '<path d="M6 9a6 6 0 1112 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z"/><path d="M10 20h4"/>',
    share: '<circle cx="6" cy="12" r="2.6"/><circle cx="17" cy="6" r="2.6"/><circle cx="17" cy="18" r="2.6"/><path d="M8.3 10.8l6.4-3.6M8.3 13.2l6.4 3.6"/>',
  };

  function icon(name, extra) {
    const p = ICONS[name] || '';
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round"' + (extra || '') + '>' + p + '</svg>'
    );
  }

  /* ------------------------------------------------------------ 页面骨架 */

  /** 二级页头部（返回 + 标题 + 右侧插槽）。
   *  opt.tapId：把标题块包成按钮（个股页点股票名开公司档案用）；
   *  opt.badge：名字右侧的常驻小角标（如「档案 ›」，纯展示）。 */
  function pageHead(title, sub, right, opt) {
    const o = opt || {};
    const text =
      '<div class="grow">' +
        '<div class="head-title">' + esc(title) +
          (o.badge ? '<span class="archive-tag">' + esc(o.badge) + '</span>' : '') +
        '</div>' +
        (sub ? '<div class="head-sub">' + esc(sub) + '</div>' : '') +
      '</div>';
    return (
      '<div class="head-row">' +
        '<button class="icon-btn" data-page-back aria-label="返回">' + icon('back') + '</button>' +
        (o.tapId
          ? '<button class="head-tap" id="' + esc(o.tapId) + '" aria-label="查看公司档案">' + text + '</button>'
          : text) +
        (right || '') +
      '</div>'
    );
  }

  function bindPageBack(root) {
    const btn = root.querySelector('[data-page-back]');
    if (btn) btn.onclick = () => closePage();
  }

  /* ------------------------------------------------------------ 深链接 */

  /** 股票代码 → 展示名（来自 rules.stocks） */
  function stockName(id) {
    const st = S.state;
    const list = st && st.rules && st.rules.stocks;
    const hit = list && list.find((x) => x.id === id);
    return hit ? hit.name : id;
  }

  GS.core = {
    $, esc, on,
    fmtP, fmtPct, fmtChg, fmtQty, fmtAmt, fmtMoney, cls, fmtTime, fmtHM, fmtLeft, num,
    store, KEY, S,
    subscribe, emit, market, isIndex, position, isTrading, serverNow, stockName,
    toast, sheet, closeSheet, openPage, closePage, bindBackKey,
    icon, pageHead, bindPageBack,
    MASCOTS, mascotId, setMascot, mascotImg,
  };
})(window.GS);
