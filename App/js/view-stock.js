/* ==========================================================================
   view-stock.js — 个股详情（二级页）
   分时/五日/日K + 五档 + 资金 + 逐笔 + 弹幕 + 底部买卖
   ========================================================================== */
(function (GS) {
  'use strict';

  const {
    $, esc, fmtP, fmtPct, fmtChg, fmtQty, fmtAmt, fmtMoney, fmtTime, fmtHM, fmtLeft, cls, num,
  } = GS.core;

  const state = {
    stockId: '',
    mode: 'min', // min | 5d | day | week | month
    cursor: -1,
    bars: null,
    barsFor: '',
    barsDay: 0,
    unsub: null,
    dmSeen: new Set(),
    dmWatchTimer: null,
    auTimer: null, // 竞价倒计时（500ms）
    lastDraw: 0,
    ctl: null, // 当前二级页控制器（左右翻票原地换内容用）
    day: 0, // 最近看到的服务端交易日号（跨天清零 Cross-hair 用）
    auSig: '', // 竞价条当前渲染的是开盘还是收盘竞价（结构重建的签名）
  };

  /** 首次进个股页弹一次的「左右滑」提示（本地只弹一次，换账号也不烦） */
  const SWIPE_HINT_KEY = 'gushen_app_swipe_hint';

  const ACTION_LABEL = {
    buy_open: '买入开多',
    sell_close: '卖出平多',
    sell_open: '卖出开空',
    buy_close: '买入平空',
  };

  // K 线视窗（双指捏合缩放 + 单指拖动平移，网页版 klineView 同口径）：
  //   count  = 屏上放几根（0 = 没调过，取默认值）
  //   offset = 右端丢掉几根（0 = 贴最新一根；>0 = 正在翻历史）
  // 一律**相对尾部**记：贴最新看的玩家 offset=0，新的一根进来视窗自动右移；
  // 翻历史的玩家 offset>0，窗口内容原地不动，不会被新数据顶走。
  const KVIEW_MIN_BARS = 15; // 最多放大到 15 根（再少就看不出形态了）
  const kViews = {
    day: { count: 0, offset: 0 },
    week: { count: 0, offset: 0 },
    month: { count: 0, offset: 0 },
  };

  const isKlineMode = () => state.mode !== 'min' && state.mode !== '5d';

  /* ---------------------------------------------------------------- 骨架 */

  /** 公司档案入口行：徽记 + 拟人名预告（静态数据，open 时一次性填好，不进帧循环） */
  function archiveEntryHtml(m) {
    const lore = GS.company && GS.company.loreOf ? GS.company.loreOf(m.stockId) : null;
    if (!lore) return '';
    const logo = lore.logo
      ? '<img class="co-entry-logo" src="' + esc(lore.logo) + '" alt="">'
      : '';
    return (
      '<button class="co-entry" id="coEntry">' +
        logo +
        '<div class="grow">' +
          '<div class="co-entry-name">公司档案 · 股娘图鉴</div>' +
          '<div class="co-entry-sub">拟人 · ' + esc(lore.waifu) + ' · ' + esc(lore.title) + '</div>' +
        '</div>' +
        '<span class="co-entry-arrow">档案 ›</span>' +
      '</button>'
    );
  }

  const CHART_TABS = [
    ['min', '分时'],
    ['5d', '五日'],
    ['day', '日K'],
    ['week', '周K'],
    ['month', '月K'],
  ];

  function skeleton(m) {
    // 指数（999999）复用同一套骨架：行情头 + 图表 + 资金 + 消息完全一样，
    // 只把「交易件」换掉——没有五档/分时成交（指数没有自己的盘口），
    // 换成分成股列表；没有买卖栏、没有弹幕（指数没有 NPC 池，不产生弹幕）
    const idx = !!(m && m.isIndex);
    const shareBtn = m
      ? '<button class="icon-btn" id="stockShare" aria-label="分享">' + GS.core.icon('share') + '</button>'
      : '';
    // 「档案 ›」角标只在真有档案数据时挂（没有就别骗人点）
    const hasLore = !!(m && GS.company && GS.company.loreOf && GS.company.loreOf(m.stockId));
    // 图表类型跟着 state.mode 走：左右翻票时保留玩家刚选的类型，不被打回分时
    const tabBtns = CHART_TABS.map((t) =>
      '<button data-mode="' + t[0] + '"' + (state.mode === t[0] ? ' class="on"' : '') + '>' + t[1] + '</button>'
    ).join('');
    // .page-inner：左右翻票的「跟手层」。翻票只换这一层的内容，不重建二级页
    // （closePage/openPage 会把整页滑出屏幕再滑入，和跟手动画打架）
    return (
      '<div class="page-inner">' +
      GS.core.pageHead(m ? m.name : '个股', m ? m.stockId : '', pagerHtml() + shareBtn, {
        tapId: 'stockArchive',
        badge: hasLore ? '档案 ›' : '',
      }) +
      '<div class="page-body" id="stockBody">' +
        '<div class="quote-head">' +
          // 集合竞价条：竞价阶段才有内容（开盘 / 收盘两段都用它）。
          // 竞价时 last 还是**昨收**（只入簿不撮合），大价格一动不动，玩家不知道
          // 会开在哪——所以虚拟成交价必须顶到报价卡最上面，与网页版 auction-strip 同口径。
          '<div class="auction-bar" id="auctionBar" hidden>' +
            '<div class="ab-head">' +
              '<span class="ab-tag" id="abTag">集合竞价</span>' +
              '<span class="ab-clock num" id="abClock">--:--</span>' +
              '<span class="ab-left num" id="abLeft"></span>' +
            '</div>' +
            '<div class="ab-mid">' +
              '<span class="ab-label" id="abLabel">虚拟开盘</span>' +
              '<b class="ab-price num" id="abPrice">--</b>' +
              '<span class="ab-chg num" id="abChg"></span>' +
            '</div>' +
            '<div class="ab-note" id="abNote"></div>' +
            '<i class="ab-prog" id="abProg"></i>' +
          '</div>' +
          '<div class="quote-line">' +
            '<span class="quote-big num" id="qBig">—</span>' +
            '<span class="quote-chg num" id="qChg">—</span>' +
          '</div>' +
          '<div class="quote-grid">' +
            '<span>今开<b class="num" id="qOpen">—</b></span>' +
            '<span>最高<b class="num" id="qHigh">—</b></span>' +
            '<span>最低<b class="num" id="qLow">—</b></span>' +
            '<span>昨收<b class="num" id="qPrev">—</b></span>' +
            '<span>成交<b class="num" id="qTurn">—</b></span>' +
            '<span>' + (idx ? '总市值' : '市值') + '<b class="num" id="qCap">—</b></span>' +
          '</div>' +
        '</div>' +

        // 停牌 / 休市提示放到报价卡正下方：原先挂在整页最末尾（消息卡之后），
        // 玩家得往下滑才能看到——停牌与休市恰恰是最该第一眼看见的两件事
        '<div id="haltBox"></div>' +

        (m ? archiveEntryHtml(m) : '') +

        '<div class="stock-columns">' +
          '<div class="card chart-card">' +
            '<div class="chart-tabs" id="chartTabs">' + tabBtns + '</div>' +
            '<div class="chart-wrap" id="chartWrap">' +
              '<canvas id="chartCanvas"></canvas>' +
              '<div class="chart-tip" id="chartTip" hidden></div>' +
            '</div>' +
            (idx
              ? ''
              : '<div class="dm-send">' +
                  '<input id="dmInput" maxlength="60" placeholder="发条弹幕…" enterkeyhint="send">' +
                  '<button class="mini-btn" id="dmSend">发送</button>' +
                '</div>') +
          '</div>' +
          (idx
            ? '<div class="book-panel comp-panel">' +
                '<div class="book-panel-title">成分股</div>' +
                '<div class="comp-list" id="compList"></div>' +
                '<div class="book-sub">点成分看个股</div>' +
              '</div>'
            : '<div class="book-panel">' +
                '<div class="book-panel-title">五档盘口</div>' +
                // 竞价时盘口是「交叉的」，五档读起来像数据错——虚拟价压缩成两行小字
                // 顶在档位上方，挂单时眼睛不用在盘口与顶部竞价条之间来回跳
                '<div class="book-auction" id="bookAuction" hidden>' +
                  '<span class="ba-label" id="baLabel">虚拟开盘</span>' +
                  '<b class="ba-price num" id="baPrice">--</b>' +
                  '<span class="ba-vol" id="baVol"></span>' +
                '</div>' +
                '<div class="book" id="bookBox"></div>' +
                '<div class="book-sub">分时成交</div>' +
                '<div class="panel-ticker" id="tickerBox"></div>' +
              '</div>') +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><div class="card-title">' +
            (idx ? '资金 · 成分合计' : '资金') + '</div>' +
            '<div class="card-more num" id="flowNet">—</div></div>' +
          '<div class="flow-bar"><i id="flowOuter"></i><i id="flowInner"></i></div>' +
          '<div class="flow-legend"><span id="flowOuterTxt">外盘 —</span>' +
            '<span id="flowInnerTxt">内盘 —</span></div>' +
        '</div>' +

        '<div class="card card-flat">' +
          '<div class="news-list" id="stockNewsHints"></div>' +
          '<div class="news-list" id="stockNews"></div>' +
          '<button class="news-more" id="stockNewsMore">更多消息 ›</button>' +
        '</div>' +
      '</div>' +
      (idx
        ? ''
        : '<div class="act-bar" id="actBar">' +
            '<button class="btn-buy" data-side="buy_open">买入</button>' +
            '<button class="btn-sell" data-side="sell_close">卖出</button>' +
            '<button class="btn-flat" data-cond-open="1">条件单</button>' +
          '</div>') +
      '</div>'
    );
  }

  /* ---------------------------------------------------------------- 打开 */

  function open(stockId) {
    state.stockId = stockId || state.stockId;
    // 从列表/消息点进来一律回到分时；左右滑翻票走 swapTo，不动玩家选的图表类型
    state.mode = 'min';
    resetStock();
    const ctl = GS.core.openPage({
      html: skeleton(GS.core.market(state.stockId)),
      onMount(el) {
        mount(el, 0);
      },
    });
    const prevClose = ctl.onClose;
    ctl.onClose = () => {
      stopWatch();
      if (prevClose) prevClose();
    };
    return ctl;
  }

  /**
   * 把内容装进二级页容器：绑定 + 首帧。
   * dir ≠ 0 表示是左右翻过来的一只票（滑入动画），0 = 正常打开。
   */
  function mount(ctl, dir) {
    const root = ctl.el.querySelector('.page-inner') || ctl.el;
    ctl.root = root;
    state.ctl = ctl;

    GS.core.bindPageBack(root);
    // 分享当前个股行情（头部右上角）
    GS.core.on(root, '#stockShare', 'click', () => GS.share.stockText(state.stockId));
    // 公司档案两处入口：点头部股票名 / 点报价卡下的档案行（指数是「股娘天团」）
    const openArchive = () => {
      if (GS.company) GS.company.openProfile(state.stockId);
    };
    GS.core.on(root, '#stockArchive', 'click', openArchive);
    GS.core.on(root, '#coEntry', 'click', openArchive);
    // 消息卡：点个股行不跳（就在本股），点「更多」进消息 tab 的本股过滤
    GS.core.on(root, '#stockNewsMore', 'click', () => {
      // 指数没有「本股」概念，直接进消息 tab 的「大盘」档
      if (GS.core.isIndex(state.stockId)) GS.viewNews.open({ filter: 'index' });
      else GS.viewNews.open({ stockId: state.stockId });
    });
    // 成分股：换一只票看（原地换内容，不再叠一层 / 滑出整页）
    GS.core.on(root, '.comp-row', 'click', (e, t) => {
      const sid = t.dataset.compStock;
      if (!sid || sid === state.stockId) return;
      navigateTo(sid);
    });
    bindTabs(root);
    bindChartTouch(root);
    bindAct(root);
    bindDanmakuSend(root);
    bindSwipe(root);

    renderNews();
    draw();
    // 拉分时（日线在 draw 里按需拉）
    GS.api.loadHistory(state.stockId).then(() => draw());
    startWatch();

    if (dir) playSlide(root, dir);
    else hintSwipe();
  }

  /** 清掉「上一只票」的图表/十字光标/弹幕状态（图表类型 state.mode 不动） */
  function resetStock() {
    state.cursor = -1;
    state.bars = null;
    state.barsFor = '';
    state.barsDay = 0;
    state.dmSeen.clear();
  }

  /** 收订阅与弹幕观看心跳（关页 / 换票前都要收，否则旧票的 tick 会打在新页上） */
  function stopWatch() {
    if (state.unsub) state.unsub();
    state.unsub = null;
    if (state.dmWatchTimer) {
      clearInterval(state.dmWatchTimer);
      state.dmWatchTimer = null;
    }
    if (state.auTimer) {
      clearInterval(state.auTimer);
      state.auTimer = null;
    }
  }

  /** 订阅帧 + 打弹幕观看心跳（60s 一次，与网页版同口径：没有它 watcher 过期后
   *  这只票就不再生成 NPC 弹幕——纯 App 玩家盯的票会整场冷清。指数没有 NPC 池，跳过） */
  function startWatch() {
    stopWatch();
    state.unsub = GS.core.subscribe(() => {
      tick();
    });
    // 竞价倒计时按 500ms 平滑推进（帧是 700ms 一帧，只吃帧数字会一格一格跳）。
    // 非竞价阶段 paintAuction 第一行就返回，不产生额外开销
    state.auTimer = setInterval(paintAuction, 500);
    if (GS.core.isIndex(state.stockId)) return;
    const watchTick = () => {
      GS.api
        .getJSON('/api/danmaku/watch?stock=' + encodeURIComponent(state.stockId))
        .catch(() => {});
    };
    watchTick();
    state.dmWatchTimer = setInterval(watchTick, 60000);
  }

  /* ---------------------------------------------------- 翻票（上一个/下一个） */

  /** 翻页顺序 = 首页「全部标的」的顺序；指数 999999 不在其中，不参与左右翻 */
  function marketList() {
    const st = GS.core.S.state;
    return st && Array.isArray(st.markets) ? st.markets : [];
  }

  /**
   * 相对当前个股的上(-1)/下(+1)一只，**首尾循环**：最后一只往左滑回到第一只，
   * 第一只往右滑跳到最后一只（用户要求：翻到头不要卡住）。
   * 当前标的不在列表里（指数 999999）返回 ''，即不参与左右翻。
   */
  function neighborOf(dir) {
    const list = marketList();
    const n = list.length;
    if (n < 2) return '';
    const i = list.findIndex((m) => m.stockId === state.stockId);
    if (i < 0) return '';
    return list[(i + dir + n) % n].stockId;
  }

  /** 头部「3/10」页码：知道自己在第几只，也暗示这页可以左右翻 */
  function pagerHtml() {
    const list = marketList();
    const i = list.findIndex((m) => m.stockId === state.stockId);
    if (i < 0 || list.length < 2) return '';
    return '<span class="head-pager num" id="stockPager">' + (i + 1) + '/' + list.length + '</span>';
  }

  /** 点成分股等「跳到任意一只」：按在标的列表里的前后关系决定滑入方向 */
  function navigateTo(sid) {
    const list = marketList();
    const from = list.findIndex((m) => m.stockId === state.stockId);
    const to = list.findIndex((m) => m.stockId === sid);
    const dir = from >= 0 && to >= 0 && to !== from ? (to > from ? 1 : -1) : 0;
    swapTo(sid, dir);
  }

  /**
   * 原地换一只票：只替换 .page-inner 的内容并重新绑定，不 closePage/openPage。
   * 走开关页会把整页滑出屏幕再滑入（还有 300ms 的隐藏延时），和跟手翻页打架。
   * 图表类型（state.mode）保留——玩家选了日K，翻下一只还是日K。
   */
  function swapTo(sid, dir) {
    const ctl = state.ctl || GS.core.S.page;
    const m = GS.core.market(sid);
    if (!ctl || !m) return false;
    stopWatch();
    state.stockId = sid;
    resetStock();
    ctl.el.innerHTML = skeleton(m);
    ctl.body = ctl.el.querySelector('.page-body');
    mount(ctl, dir || 0);
    return true;
  }

  /* -------------------------------------------------------- 左右滑手势 */

  // 起手就放过的区域：图表自己吃手势（K 线平移/捏合、分时十字光标），
  // 买卖栏、横向 tab 条与输入框也不该被翻页抢走
  const SWIPE_SKIP = '#chartWrap, .act-bar, .chart-tabs, input, textarea, select';
  const SWIPE_MIN = 54; // 松手时水平位移超过这么多 px 才翻页（约屏幕 1/7）
  const SWIPE_SLOPE = 1.25; // 水平/垂直位移比：大于它才算「左右滑」，否则当竖向滚动

  /**
   * 左右滑切换上一个/下一个标的（首尾循环，翻到最后一只再左滑回到第一只）：
   * 跟手位移 + 松手够远才翻。
   * 手势绑在 .page-inner 上（每次换票都会重建，天然不累积监听）。
   * CSS 里这套容器是 touch-action: pan-y，横向手势浏览器不抢，全程能收到 touchmove。
   */
  function bindSwipe(root) {
    let g = null; // { x0, y0, dx, axis:null|'x'|'y' }

    const reset = () => {
      if (!g) return;
      root.classList.remove('swiping');
      root.style.transform = ''; // 松手回弹（.page-inner 上有 0.22s 过渡）
      g = null;
    };

    root.addEventListener(
      'touchstart',
      (ev) => {
        if (ev.touches.length !== 1) {
          reset();
          return;
        }
        const tg = ev.target;
        if (tg && tg.closest && tg.closest(SWIPE_SKIP)) {
          g = null;
          return;
        }
        const t = ev.touches[0];
        g = { x0: t.clientX, y0: t.clientY, dx: 0, axis: null };
      },
      { passive: true }
    );

    root.addEventListener(
      'touchmove',
      (ev) => {
        if (!g || ev.touches.length !== 1) return;
        const t = ev.touches[0];
        const dx = t.clientX - g.x0;
        const dy = t.clientY - g.y0;
        if (!g.axis) {
          if (Math.abs(dx) < 9 && Math.abs(dy) < 9) return;
          g.axis = Math.abs(dx) > Math.abs(dy) * SWIPE_SLOPE ? 'x' : 'y';
          // 跟手期间必须去掉过渡，否则每帧都在追 0.22s 的动画
          if (g.axis === 'x') root.classList.add('swiping');
        }
        if (g.axis !== 'x') return;
        g.dx = dx;
        // 翻不动的情形（指数页 / 标的少于 2 只）只给 1/4 阻尼位移，表示这边没有别的票
        const stick = neighborOf(dx < 0 ? 1 : -1) ? dx : dx * 0.25;
        const cap = (window.innerWidth || 360) * 0.6;
        root.style.transform = 'translateX(' + Math.max(-cap, Math.min(cap, stick)) + 'px)';
      },
      { passive: true }
    );

    root.addEventListener(
      'touchend',
      () => {
        if (!g) return;
        const { dx, axis } = g;
        const target = axis === 'x' ? neighborOf(dx < 0 ? 1 : -1) : '';
        reset();
        if (target && Math.abs(dx) >= SWIPE_MIN) swapTo(target, dx < 0 ? 1 : -1);
      },
      { passive: true }
    );

    root.addEventListener('touchcancel', reset, { passive: true });
  }

  /** 新一只滑入：手指往左（看下一只）→ 新内容从右边进，反之从左边 */
  function playSlide(root, dir) {
    const k = dir > 0 ? 'slide-next' : 'slide-prev';
    root.classList.add(k);
    root.addEventListener('animationend', () => root.classList.remove(k), { once: true });
  }

  /** 首次进个股页提示一次左右滑（没人会去读说明，手势得自己冒出来） */
  function hintSwipe() {
    if (!neighborOf(1) && !neighborOf(-1)) return;
    if (GS.core.store.get(SWIPE_HINT_KEY, '')) return;
    GS.core.store.set(SWIPE_HINT_KEY, '1');
    setTimeout(() => GS.core.toast('左右滑动可切换个股'), 700);
  }

  /** 弹幕发送：POST /api/danmaku（长度/频率/敏感词由服务端判，错误信息直接展示） */
  function bindDanmakuSend(el) {
    const input = el.querySelector('#dmInput');
    const btn = el.querySelector('#dmSend');
    if (!input || !btn) return;
    const send = () => {
      const text = (input.value || '').trim();
      if (!text) return;
      btn.disabled = true;
      GS.api
        .postJSON('/api/danmaku', { stockId: state.stockId, text })
        .then((r) => {
          btn.disabled = false;
          if (r && r.ok) {
            input.value = '';
            GS.core.toast('弹幕已发送', 'ok');
            return;
          }
          GS.core.toast((r && r.error) || '发送失败', 'err');
        })
        .catch(() => {
          btn.disabled = false;
          GS.core.toast('网络异常', 'err');
        });
    };
    GS.core.on(el, '#dmSend', 'click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
  }

  function close() {
    GS.core.closePage();
  }

  /* ---------------------------------------------------------------- 绑定 */

  function bindTabs(el) {
    GS.core.on(el, '#chartTabs button', 'click', (e, t) => {
      state.mode = t.dataset.mode;
      state.cursor = -1;
      el.querySelectorAll('#chartTabs button').forEach((b) => b.classList.toggle('on', b === t));
      if (state.mode !== 'min' && state.mode !== '5d') ensureBars();
      draw();
    });
  }

  /**
   * K 线可视窗口（缩放/平移的唯一真源，网页版 klineView 同口径）。
   * 越界就地夹回：count ∈ [min(KVIEW_MIN_BARS,total), total]，offset ∈ [0, total-count]。
   * 注意不把夹过的值写回 kViews——kViews 记的是「玩家想要多少根」，不是「这只票能给多少根」。
   * @returns {{start:number, count:number, total:number, offset:number}}
   */
  function klineViewOf(bars, w) {
    const total = bars.length;
    const st = kViews[state.mode] || (kViews[state.mode] = { count: 0, offset: 0 });
    const defW = Math.max(20, Math.floor((w || 300) / 7));
    const def = state.mode === 'day' ? Math.min(defW, total) : total;
    const floor = Math.min(KVIEW_MIN_BARS, total);
    let count = Math.round(st.count) || def;
    count = Math.max(floor, Math.min(count, total));
    let offset = Math.round(st.offset) || 0;
    offset = Math.max(0, Math.min(offset, total - count));
    const end = total - offset;
    return { start: end - count, count, total, offset };
  }

  function bindChartTouch(el) {
    const wrap = el.querySelector('#chartWrap');
    const tip = el.querySelector('#chartTip');
    let touch = null; // 单指会话（K 线模式：拖动平移；点按看十字光标）
    let pinch = null; // 双指会话（捏合缩放）
    let lastTapT = 0;
    let lastTapX = 0;

    const barsNow = () => {
      const m = GS.core.market(state.stockId);
      return m ? klineSeriesOf(m) : [];
    };
    const dist2 = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    /** 十字光标：clientX → 最近一根 bar，画竖线 + 弹 tooltip */
    const cursorAt = (clientX) => {
      const rect = wrap.getBoundingClientRect();
      const geo = state.geo;
      if (!geo || !geo.hit) return;
      const idx = geo.hit(clientX - rect.left);
      if (idx < 0) return;
      state.cursor = idx;
      draw();
      showTip(tip, idx);
    };

    /** 分时/五日：单指即十字光标（旧口径） */
    const moveCursor = (ev) => {
      const t = ev.touches && ev.touches[0];
      if (t) cursorAt(t.clientX);
    };

    /** 缩放到 nextCount 根，锚点 mx（画布内 x）下的那根不动（网页版 zoomKline 同口径） */
    const applyZoom = (bars, nextCount, mx) => {
      const total = bars.length;
      if (total < 2) return;
      const W = wrap.clientWidth || 300;
      const v = klineViewOf(bars, W);
      const floor = Math.min(KVIEW_MIN_BARS, total);
      const next = Math.max(floor, Math.min(total, Math.round(nextCount)));
      if (next === v.count) return;
      const x = Math.max(0, Math.min(W, mx));
      const vi = v.start + (x / W) * v.count; // 锚点下的「虚拟下标」（可小数）
      const slot = W / next;
      let start = Math.round(vi - x / slot);
      start = Math.max(0, Math.min(start, total - next));
      kViews[state.mode] = { count: next, offset: total - next - start };
    };

    wrap.addEventListener(
      'touchstart',
      (ev) => {
        if (!isKlineMode()) {
          moveCursor(ev);
          return;
        }
        if (ev.touches.length === 1) {
          const t = ev.touches[0];
          touch = { x0: t.clientX, y0: t.clientY, lastX: t.clientX, t0: Date.now(), moved: false };
        } else if (ev.touches.length === 2) {
          touch = null;
          tip.hidden = true;
          const rect = wrap.getBoundingClientRect();
          pinch = {
            d0: dist2(ev.touches[0], ev.touches[1]),
            mx: (ev.touches[0].clientX + ev.touches[1].clientX) / 2 - rect.left,
          };
        }
      },
      { passive: true }
    );

    wrap.addEventListener(
      'touchmove',
      (ev) => {
        if (!isKlineMode()) {
          moveCursor(ev);
          return;
        }
        if (pinch && ev.touches.length === 2) {
          const bars = barsNow();
          if (bars.length < 2) return;
          const d = dist2(ev.touches[0], ev.touches[1]);
          if (d < 8) return;
          const v = klineViewOf(bars, wrap.clientWidth);
          // 双指张开 = 放大（屏上根数变少）；捏合 = 缩小（看到更多根）
          applyZoom(bars, v.count * (pinch.d0 / d), pinch.mx);
          state.cursor = -1;
          tip.hidden = true;
          draw();
          return;
        }
        if (touch && ev.touches.length === 1) {
          const t = ev.touches[0];
          if (!touch.moved) {
            if (Math.hypot(t.clientX - touch.x0, t.clientY - touch.y0) < 8) return;
            touch.moved = true; // 手抖不算拖动
          }
          // 拖动平移：往右拖 = 右端多丢几根 = 看更早的（网页版同口径）
          const bars = barsNow();
          const geo = state.geo;
          if (!geo || !geo.slot || bars.length < 2) return;
          const v = klineViewOf(bars, wrap.clientWidth);
          const offset = Math.max(
            0,
            Math.min(v.total - v.count, Math.round(v.offset + (t.clientX - touch.lastX) / geo.slot))
          );
          touch.lastX = t.clientX;
          if (offset === v.offset) return;
          kViews[state.mode] = { count: v.count, offset };
          state.cursor = -1;
          tip.hidden = true;
          draw();
        }
      },
      { passive: true }
    );

    const clearCursor = () => {
      state.cursor = -1;
      tip.hidden = true;
      draw();
    };

    wrap.addEventListener(
      'touchend',
      (ev) => {
        if (!isKlineMode()) {
          clearCursor();
          return;
        }
        if (pinch) {
          if (ev.touches.length < 2) pinch = null;
          if (ev.touches.length <= 1) touch = null; // 抬起一指后不立刻转拖动，防跳
          return;
        }
        if (touch && ev.touches.length === 0) {
          const t = ev.changedTouches && ev.changedTouches[0];
          const now = Date.now();
          const isTap = !!t && !touch.moved && now - touch.t0 < 350;
          if (isTap && now - lastTapT < 320 && Math.abs(t.clientX - lastTapX) < 48) {
            // 双击：复位视窗（默认根数 + 贴最新一根）
            kViews[state.mode] = { count: 0, offset: 0 };
            clearCursor();
          } else if (isTap) {
            cursorAt(t.clientX); // 单击：十字光标
          }
          lastTapT = now;
          lastTapX = t ? t.clientX : 0;
          touch = null;
        }
      },
      { passive: true }
    );

    wrap.addEventListener(
      'touchcancel',
      () => {
        touch = null;
        pinch = null;
        if (!isKlineMode()) clearCursor();
      },
      { passive: true }
    );
  }

  /**
   * 游戏内时刻（自 00:00 起的毫秒）→ 'HH:MM'。
   * **不能**用 core.fmtHM：那个是「时间戳按本地时区取时分」，喂 11:30 的毫秒数（41400000）
   * 会被当成 1970-01-01T00:00Z 再按 +08:00 显示成 19:30——分时图刻度整体偏 8 小时。
   */
  function gameHM(ms) {
    const v = ((Number(ms) % 86400000) + 86400000) % 86400000;
    const p = (n) => String(n).padStart(2, '0');
    return p(Math.floor(v / 3600000)) + ':' + p(Math.floor((v % 3600000) / 60000));
  }

  /** 分时点的时间文案：游戏内时刻（跨天补「N日」前缀），没有交易日时钟时退回墙钟 */
  function minuteTimeLabel(t, withSec) {
    const g = clockAtAxis(axisCoord(t));
    if (!g) return withSec ? fmtTime(t) : fmtHM(t);
    const hm = withSec
      ? gameHM(g.ms) + ':' + String(Math.floor((g.ms % 60000) / 1000)).padStart(2, '0')
      : gameHM(g.ms);
    const d = dayInfo();
    return d && g.day !== d.day ? g.day + '日 ' + hm : hm;
  }

  function showTip(tip, idx) {
    const geo = state.geo;
    if (!geo || !geo.points || !geo.points[idx]) {
      tip.hidden = true;
      return;
    }
    const pt = geo.points[idx];
    if (state.mode !== 'min' && state.mode !== '5d') {
      const b = pt.bar || {};
      const label = b.label || (b.day != null ? '第' + b.day + '天' : '');
      const md = geo.macd;
      // MACD 数组按全量 bars 下标，points 是窗口内偏移，要加回窗口起点
      const gi = geo.start + (state.cursor >= 0 ? state.cursor : geo.points.length - 1);
      const dif = md ? md.dif[gi] || 0 : 0;
      const dea = md ? md.dea[gi] || 0 : 0;
      const warn = geo.total && geo.total < GS.chart.MACD_MIN_BARS
        ? '<span class="dim">（样本 ' + geo.total + ' 根，未预热）</span>' : '';
      tip.innerHTML =
        '<span>' + esc(label) + (b.live ? ' · 实时' : '') + '</span>' +
        '<span>开 ' + fmtP(b.open) + '</span>' +
        '<span>高 ' + fmtP(b.high) + '</span>' +
        '<span>低 ' + fmtP(b.low) + '</span>' +
        '<span>收 ' + fmtP(b.close) + '</span>' +
        (b.volume ? '<span>量 ' + fmtQty(b.volume) + '</span>' : '') +
        '<span class="' + cls(dif - dea) + '">DIF ' + dif.toFixed(3) + '</span>' +
        '<span class="' + cls(dea - dif) + '">DEA ' + dea.toFixed(3) + '</span>' +
        warn;
    } else {
      const m = GS.core.market(state.stockId);
      const base = m ? num(m.prevClose) : 0;
      const pct = base ? ((pt.price - base) / base) * 100 : 0;
      // 成交量与柱子同口径：这一刻的增量（日切回落时取当日累计），括号里补总量
      const dv = geo.deltas ? geo.deltas[idx] || 0 : 0;
      const tv = pt.vol || 0;
      const md = geo.macd;
      const dif = md ? md.dif[idx] || 0 : 0;
      const dea = md ? md.dea[idx] || 0 : 0;
      const warn = md && md.dif.length < GS.chart.MACD_MIN_BARS
        ? '<span class="dim">（未预热）</span>' : '';
      tip.innerHTML =
        '<span>' + esc(minuteTimeLabel(pt.t, true)) + '</span>' +
        '<span class="' + cls(pt.price - base) + '">' + fmtP(pt.price) + '</span>' +
        '<span class="' + cls(pct) + '">' + fmtPct(pct) + '</span>' +
        (tv ? '<span>量 ' + fmtQty(dv) + ' <span class="dim">(累计 ' + fmtQty(tv) + ')</span></span>' : '') +
        '<span class="' + cls(dif - dea) + '">DIF ' + dif.toFixed(3) + '</span>' +
        '<span class="' + cls(dea - dif) + '">DEA ' + dea.toFixed(3) + '</span>' +
        warn;
    }
    tip.hidden = false;
  }

  function bindAct(el) {
    GS.core.on(el, '[data-side]', 'click', (e, t) => {
      openOrder(t.dataset.side);
    });
    // 条件单入口：休市也能建（服务端只在开市时段执行，建单不受限）
    GS.core.on(el, '[data-cond-open]', 'click', () => {
      if (GS.cond) GS.cond.openCreate(state.stockId);
      else GS.core.toast('条件单模块未加载', 'err');
    });
  }

  /* -------------------------------------------------------------- 日线 */

  function ensureBars() {
    // 缓存作废的时机有两个（网页版同口径）：**跨天**（图里要多一根）与**进入夜间**
    // （当日那根刚刚收盘定格，服务端已有真 K 线，不再让前端现拼的盖上去）
    const day = GS.core.S.state && GS.core.S.state.day;
    const today = (day && day.day) || 0;
    const dayKey = today ? today + (day.phase === 'night' ? ':settled' : ':open') : '';
    if (state.barsFor === state.stockId && state.bars && state.barsDay === dayKey) return;
    state.barsFor = state.stockId;
    state.barsDay = dayKey;
    GS.api
      .getJSON('/api/daily?stock=' + encodeURIComponent(state.stockId) + '&limit=260')
      .then((r) => {
        if (r && r.ok) {
          state.bars = r.bars || [];
          draw();
        } else {
          state.barsDay = 0; // 失败允许下次再试
        }
      })
      .catch(() => {
        state.barsDay = 0;
      });
  }

  /* ------------------------------------------------- 分时压缩横轴（对齐网页版） */

  /** 交易日时钟（服务端 day 未启用时为 null，横轴退化成墙钟） */
  function dayInfo() {
    const d = GS.core.S.state && GS.core.S.state.day;
    return d && d.enabled && Array.isArray(d.phases) && d.phases.length ? d : null;
  }

  /** 不占横轴宽度的阶段：开盘集合竞价（只定价不连续成交）与休市（午休/夜间） */
  const AXIS_ZERO_PHASES = ['auction', 'lunch', 'night'];

  /** 该阶段在横轴上占的宽度（游戏内毫秒）；休市与开盘竞价 = 0 */
  function axisPhaseWidth(p) {
    return AXIS_ZERO_PHASES.indexOf(p && p.key) >= 0 ? 0 : Math.max(0, Number(p && p.gm) || 0);
  }

  /** 一个交易日在横轴上的总宽（= 240 分钟：上午 120 + 下午 117 + 收盘竞价 3） */
  function axisDayWidth(phases) {
    let w = 0;
    for (const p of phases) w += axisPhaseWidth(p);
    return w;
  }

  /**
   * 墙钟 t → 压缩轴坐标（天序号 × 一天有效宽 + 阶段内进度）。
   * 休市与开盘竞价宽 0，段内所有时刻塌到段首坐标——11:30 与 13:00 落在同一个 x 上，
   * 曲线原地接续；隔夜跳空就是一根竖线。与网页版 axisAt 同一套逐阶段插值。
   */
  function axisAt(t) {
    const d = dayInfo();
    if (!d || !Number.isFinite(t)) return null;
    const dayMs = Number(d.dayEndsAt) - Number(d.dayStartAt);
    const dayW = axisDayWidth(d.phases);
    if (!(dayMs > 0) || !(dayW > 0)) return null;
    const dayOffset = Math.floor((t - d.dayStartAt) / dayMs);
    const rest = t - d.dayStartAt - dayOffset * dayMs;
    let acc = 0; // 墙钟累计
    let aAcc = 0; // 轴坐标累计
    for (let i = 0; i < d.phases.length; i += 1) {
      const p = d.phases[i];
      const ms = Number(p.ms) || 0;
      const w = axisPhaseWidth(p);
      const last = i === d.phases.length - 1;
      if (rest < acc + ms || last) {
        const frac = ms > 0 ? Math.max(0, Math.min(1, (rest - acc) / ms)) : 0;
        return dayOffset * dayW + aAcc + frac * w;
      }
      acc += ms;
      aAcc += w;
    }
    return null;
  }

  /** 分时横轴坐标：有阶段表时压掉休市，没有时就是墙钟本身 */
  function axisCoord(t) {
    const a = axisAt(t);
    return a == null ? t : a;
  }

  /** 分时窗口实际覆盖的天数：「5 日」是上限，本局还没跑满 5 天时按已开天数收窄 */
  function minuteDays() {
    if (state.mode !== '5d') return 1;
    const d = dayInfo();
    const todayNo = Number(d && d.day) || 1;
    return Math.max(1, Math.min(5, todayNo));
  }

  /** 压缩轴坐标 → 游戏内时刻 { day, ms, seam }（seam = 午休压 0 宽后的接缝） */
  function clockAtAxis(a, atDayEnd) {
    const d = dayInfo();
    if (!d || !Number.isFinite(a)) return null;
    const on = d.phases.filter((p) => axisPhaseWidth(p) > 0);
    if (!on.length) return null;
    const dayW = axisDayWidth(d.phases);
    let dayOffset = Math.floor(a / dayW);
    let rest = a - dayOffset * dayW;
    if (atDayEnd && rest < 1) {
      dayOffset -= 1;
      rest = dayW;
    }
    let aAcc = 0;
    let prevEnd = null;
    for (let i = 0; i < on.length; i += 1) {
      const p = on[i];
      const w = axisPhaseWidth(p);
      const last = i === on.length - 1;
      if (rest < aAcc + w || last) {
        const frac = Math.max(0, Math.min(1, (rest - aAcc) / w));
        const g = Number(p.g) || 0;
        const gm = Number(p.gm) || 0;
        const seam =
          prevEnd != null && rest - aAcc < 1 && prevEnd !== g ? prevEnd : null;
        return {
          day: (Number(d.day) || 1) + dayOffset,
          ms: (g + frac * gm) % 86400000,
          seam,
        };
      }
      prevEnd = (Number(p.g) + Number(p.gm)) % 86400000;
      aAcc += w;
    }
    return null;
  }

  /** 刻度文案：游戏内时刻，接缝写「11:30/13:00」，跨天补「N日」前缀 */
  function axisTimeLabel(a, atDayEnd) {
    const c = clockAtAxis(a, atDayEnd);
    if (!c) return GS.core.fmtHM(a); // 没有阶段表：a 就是墙钟（时间戳）
    // 本局开服之前的天（天号 < 1）没有行情：5 日视图开局不足 5 天时，
    // 左侧几格会算成「0日 / -1日 09:30」这种不存在的日期，直接不画
    if (c.day < 1) return null;
    // 游戏内毫秒走 gameHM（自 00:00 起），不能用按本地时区格式化的 fmtHM
    const hm = c.seam != null
      ? gameHM(c.seam) + '/' + gameHM(c.ms)
      : gameHM(c.ms);
    const d = dayInfo();
    return d && c.day !== d.day ? c.day + '日 ' + hm : hm;
  }

  /** 刻度步长：2~480 分钟里挑最小的一档，让一屏落 3~7 根刻度 */
  function axisTickStep(dom) {
    const ladder = [480, 240, 120, 60, 30, 20, 15, 10, 5, 2];
    for (let i = ladder.length - 1; i >= 0; i -= 1) {
      if (dom / (ladder[i] * 60000) <= 6) return ladder[i] * 60000;
    }
    return ladder[0] * 60000;
  }

  /* -------------------------------------------------------- K 线序列（对齐网页版） */

  /** 一周几个交易日：与服务端 broker.weeklyPick 同源，配置缺失回落 7 */
  function weekPer() {
    const w = (GS.core.S.state && GS.core.S.state.rules && GS.core.S.state.rules.brokerMeta &&
      GS.core.S.state.rules.brokerMeta.weekly) || {};
    const per = Math.floor(Number(w.daysPerWeek));
    return Number.isFinite(per) && per >= 1 ? per : 7;
  }

  /**
   * 日线序列：已收盘的 K 线 + 当日实时现拼的那根（网页版 daySeriesOf 同口径）。
   * 服务端要等收盘结算才定格，不现拼的话今天在图上是空的；今天已结算（盘里已有）
   * 就不再拼，否则夜间会用归零行情盖掉刚收盘的真 K 线。
   */
  function daySeriesOf(m) {
    const bars = (state.bars || []).slice();
    const today = GS.core.S.state && GS.core.S.state.day && GS.core.S.state.day.day;
    if (today && !bars.some((b) => +b.day === +today)) {
      bars.push({
        day: today,
        open: m.open,
        high: m.high,
        low: m.low,
        close: m.last,
        volume: m.volume,
        turnover: m.turnover,
        live: true,
      });
    }
    return bars;
  }

  /**
   * K 线序列（按当前模式）：日线原样；周/月线把日线按交易日号聚合——
   * 周 = 每 daysPerWeek 个交易日、月 = 每 4 周。开取期内第一根的开、
   * 最后一根的收、高/低取极值、量额累加，与网页版 klineSeriesOf 同口径。
   */
  function klineSeriesOf(m) {
    const days = daySeriesOf(m);
    if (state.mode === 'day') return days;
    const per = state.mode === 'week' ? weekPer() : weekPer() * 4;
    const unit = state.mode === 'week' ? '周' : '月';
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
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume || 0,
          turnover: b.turnover || 0,
          live: !!b.live,
        };
        out.push(cur);
      } else {
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += b.volume || 0;
        cur.turnover += b.turnover || 0;
        cur.live = !!b.live;
        cur.day = b.day;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- 绘制 */

  function draw() {
    const cvs = $('chartCanvas');
    const m = GS.core.market(state.stockId);
    if (!cvs || !m) return;
    // K 线模式手勢（拖动平移/捏合缩放）由画布接管；切回分时/五日要摘掉，
    // 否则 touch-action:none 一直挡着页面滚动
    const wrapEl = cvs.parentElement;
    if (wrapEl) wrapEl.classList.toggle('kline-mode', isKlineMode());
    state.lastDraw = Date.now();

    if (isKlineMode()) {
      ensureBars();
      const bars = klineSeriesOf(m);
      const view = bars.length >= 2 ? klineViewOf(bars, cvs.clientWidth || 300) : null;
      state.geo = GS.chart.daily(cvs, { bars, cursor: state.cursor, view });
      return;
    }

    // 分时：按窗口裁点（当日 = 今天开盘起；五日 = 再往前 4 个交易日）
    let pts = GS.api.historyOf(state.stockId);
    const d = GS.core.S.state.day;
    if (d && d.dayStartAt) {
      const dayMs = Math.max(1, num(d.dayEndsAt) - num(d.dayStartAt));
      const from = state.mode === '5d' ? num(d.dayStartAt) - dayMs * (minuteDays() - 1) : num(d.dayStartAt);
      pts = pts.filter((p) => p.t >= from);
    }
    if (pts.length < 2) {
      state.geo = GS.chart.minute(cvs, { pts, prevClose: num(m.prevClose), cursor: state.cursor });
      return;
    }

    // 压缩横轴（网页版同口径）：休市/开盘竞价压 0 宽，右端固定压在今天收盘上——
    // 开盘时曲线只占左边一小段、随时间往右生长，与真实行情软件的分时一致。
    // 没有阶段表（交易日时钟未启用）时退化成墙钟贴合数据的旧口径。
    const ax = dayInfo();
    if (ax) {
      const dayW = axisDayWidth(ax.phases);
      const endA = axisCoord(Number(d.dayEndsAt)); // 今天收盘 = 今天轴末端
      if (dayW > 0 && Number.isFinite(endA)) {
        const days = minuteDays();
        const a0 = endA - days * dayW;
        pts = pts.map((p) => ({ t: p.t, price: p.price, vol: p.vol, a: axisCoord(p.t) }));
        // 底部时间刻度：游戏内时刻（09:30 / 11:30·13:00 / 15:00），跨天补「N日」
        const ticks = [];
        const stepT = axisTickStep(endA - a0);
        let prevLabel = '';
        for (let k = 0, av = Math.ceil(a0 / stepT) * stepT; av <= endA + 1 && k < 12; k += 1, av += stepT) {
          const label = axisTimeLabel(av, av >= endA - 1);
          if (!label || label === prevLabel) continue;
          prevLabel = label;
          ticks.push({ a: av, label });
        }
        state.geo = GS.chart.minute(cvs, {
          pts,
          prevClose: num(m.prevClose),
          cursor: state.cursor,
          from: a0,
          to: endA,
          ticks,
          macdKey: state.stockId + '|' + state.mode,
        });
        return;
      }
    }

    // 退化口径：墙钟贴合数据
    state.geo = GS.chart.minute(cvs, {
      pts,
      prevClose: num(m.prevClose),
      cursor: state.cursor,
      from: pts[0].t,
      to: pts[pts.length - 1].t,
      macdKey: state.stockId + '|' + state.mode,
    });
  }

  /* ---------------------------------------------------------------- 刷新 */

  /**
   * 跨交易日：清掉「昨天」的观看残留。
   * 夜里停在个股页不动的情况很常见（App 熄屏挂一夜），这段时间没有任何人会重建页面，
   * 而十字光标 state.cursor 是**点下标**，跨天后点集整个换过一批，它还指着昨天的那一根
   * ——画出来的竖线停在图中间，tooltip 冒出的也是昨天的价格与时刻。所以换天就收起光标。
   * 日线缓存自带 day 版本号（ensureBars），分时每帧按 dayStartAt 重裁，都不用管。
   */
  function onNewDay(st) {
    const today = Number(st.day && st.day.day) || 0;
    if (!today) return;
    if (state.day && state.day !== today) {
      state.cursor = -1;
      const tip = $('chartTip');
      if (tip) tip.hidden = true;
    }
    state.day = today;
  }

  function tick() {
    const st = GS.core.S.state;
    if (!st) return;
    const m = GS.core.market(state.stockId);
    if (!m) return;

    onNewDay(st);

    const set = (id, v, klass) => {
      const el = $(id);
      if (!el) return;
      if (v != null) el.textContent = v;
      if (klass != null) el.className = klass;
    };

    set('qBig', fmtP(m.last), 'quote-big num ' + cls(m.change));
    set('qChg', fmtChg(m.change) + '  ' + fmtPct(m.changePct), 'quote-chg num ' + cls(m.change));
    // 报价格子按「相对昨收」涨红跌绿（东财口径）
    const pc = num(m.prevClose);
    set('qOpen', fmtP(m.open), 'num ' + cls(m.open - pc));
    set('qHigh', fmtP(m.high), 'num ' + cls(m.high - pc));
    set('qLow', fmtP(m.low), 'num ' + cls(m.low - pc));
    set('qPrev', fmtP(m.prevClose), 'num flat');
    set('qTurn', fmtAmt(m.turnover));
    set('qCap', fmtAmt(m.marketCap));

    // 指数（大盘行情页）：只有成分股、资金合计、消息与图表，没有盘口/逐笔/弹幕/下单
    if (m.isIndex) {
      renderComponents(m);
      renderFlow(m);
      renderAuction(st);
      renderHalt(st, m);
      renderNews();
      if (Date.now() - state.lastDraw > 500) draw();
      return;
    }

    renderAuction(st);
    renderBook(m);
    renderFlow(m);
    renderTicker(m);
    renderHalt(st, m);
    renderNews();
    pumpDanmaku(st);
    drawActState(m);

    // 画布不必每帧重绘（700ms 一帧，重绘一次就够）
    if (Date.now() - state.lastDraw > 500) draw();
  }

  /** 本股消息卡：大盘 + 本股，最近 4 条（网页端「当前股票」过滤同口径）。
   *  行不带跳转（noNav）——就在本股页里，点行再叠开一层个股页只会把 pageStack 搞乱 */
  function renderNews() {
    if (!GS.viewNews) return;
    const opt = { filter: 'active', stockId: state.stockId, limit: 4, noNav: true };
    GS.viewNews.renderHints($('stockNewsHints'), opt);
    GS.viewNews.renderRows($('stockNews'), opt);
  }

  /* ------------------------------------------- 集合竞价（开盘 / 收盘） */

  /** 游戏内时刻（自 00:00 的毫秒）→ HH:MM（顶栏 clock 同口径，不带秒） */
  function fmtClock(ms) {
    const v = ((num(ms) % 86400000) + 86400000) % 86400000;
    const p = (n) => String(n).padStart(2, '0');
    const h = Math.floor(v / 3600000);
    const m = Math.floor((v - h * 3600000) / 60000);
    return p(h) + ':' + p(m);
  }

  /**
   * 竞价阶段剩余毫秒：优先 `phaseEndsAt − serverNow()`。
   * 只吃 state 帧里的 phaseLeftMs 的话，倒计时会跟着 700ms 一帧的数字一格一格跳；
   * 用服务端给的绝对结束时刻 + 本机流逝插值，500ms 定时器一刷就是平滑的。
   */
  function auctionLeft(d) {
    const end = num(d && d.phaseEndsAt);
    const byEnd = end > 0 ? end - GS.core.serverNow() : Infinity;
    // 封顶到「帧里那一刻的剩余」：熄屏 / 切后台回来时本机流逝可能虚高，
    // 不封顶会直接把倒计时压到 0，显示成「正在撮合」
    return Math.max(0, Math.min(num(d && d.phaseLeftMs), byEnd));
  }

  /** 竞价展示的开关：停牌优先（停牌时价格本来就不该有虚拟价） */
  function auctionShowing(st) {
    const d = st && st.day;
    return !!(d && d.enabled && d.auction && !(st.halt && st.halt.halted));
  }

  /** 只在个股页展示：指数快照没有自己的盘口（无 auction 字段），竞价信息退到 halt-tip */
  function auctionTarget(st) {
    const m = GS.core.market(state.stockId);
    return auctionShowing(st) && m && !m.isIndex ? m : null;
  }

  /** 竞价条的显隐 + 开盘/收盘切换（结构只在 kind 变化时重建，其余帧只 patch 文本） */
  function renderAuction(st) {
    const bar = $('auctionBar');
    if (!bar) return;
    const m = auctionTarget(st);
    const bookBox = $('bookAuction');
    if (!m) {
      if (!bar.hidden) bar.hidden = true;
      if (bookBox && !bookBox.hidden) bookBox.hidden = true;
      state.auSig = '';
      return;
    }
    if (bar.hidden) bar.hidden = false;
    const kind = (m.auction && m.auction.kind) || st.day.auction;
    if (state.auSig !== kind) {
      state.auSig = kind;
      const isOpen = kind === 'open';
      const tag = $('abTag');
      const lbl = $('abLabel');
      const bl = $('baLabel');
      if (tag) tag.textContent = isOpen ? '开盘竞价' : '收盘竞价';
      if (lbl) lbl.textContent = isOpen ? '虚拟开盘' : '虚拟收盘';
      if (bl) bl.textContent = isOpen ? '虚拟开盘' : '虚拟收盘';
      bar.dataset.kind = kind || '';
    }
    if (bookBox && bookBox.hidden) bookBox.hidden = false;
    paintAuction();
  }

  function patchTxt(id, txt, klass) {
    const el = $(id);
    if (!el) return;
    if (txt != null && el.textContent !== txt) el.textContent = txt;
    if (klass != null && el.className !== klass) el.className = klass;
  }

  /**
   * 竞价条的动态部分（每帧 + 每 500ms 定时器各跑一次）。
   * 信息优先级：虚拟成交价 > 不可撤单倒计时 > 可成交量。
   * 竞价簿允许买卖价交叉，所以「无交叉盘口」是正常状态而不是故障，文案要说清楚。
   */
  function paintAuction() {
    const st = GS.core.S.state;
    const bar = $('auctionBar');
    if (!st || !bar || bar.hidden) return;
    const m = auctionTarget(st);
    if (!m) return;
    const d = st.day;
    const a = m.auction || {};
    const isOpen = (a.kind || d.auction) === 'open';
    const left = auctionLeft(d);
    const drift = Math.max(0, num(d.phaseLeftMs) - left); // 帧内已经流逝的墙钟毫秒
    // 游戏内时钟跟着同一份流逝走（各阶段压缩比不同，用 phaseGameMs/phaseMs 换算）
    const rate = num(d.phaseGameMs) / Math.max(1, num(d.phaseMs));
    const clock = num(d.gameClockMs) + drift * (rate > 0 ? rate : 0);

    // 剩余时间：开盘竞价接「开盘集中撮合」，收盘竞价接「收盘撮合」（= 当天收盘价）
    patchTxt('abLeft', (left <= 0 ? '正在撮合' : fmtLeft(left) + '后' + (isOpen ? '开盘' : '收盘')), 'ab-left num');
    patchTxt('abClock', fmtClock(clock), 'ab-clock num');

    const price = a.price == null ? null : num(a.price);
    const pc = num(m.prevClose);
    if (price == null) {
      patchTxt('abPrice', '--', 'ab-price num dim');
      patchTxt('abChg', '盘口未交叉', 'ab-chg num dim');
    } else {
      const diff = price - pc;
      const pct = pc ? (diff / pc) * 100 : 0;
      patchTxt('abPrice', fmtP(price), 'ab-price num ' + cls(diff));
      patchTxt('abChg', fmtPct(pct), 'ab-chg num ' + cls(diff));
    }

    // 不可撤单窗口：真实市场 09:20 / 14:57 那条硬线。撤单失败前先让玩家看见
    const locked = !!(a.locked || d.locked);
    const unlockLeft = Math.max(0, num(d.unlockLeftMs) - drift);
    const volTxt = price == null ? '暂无可成交量' : '可成交 ' + fmtQty(a.volume) + ' 股';
    let tail;
    if (locked) tail = '已进入不可撤单窗口';
    else if (num(d.unlockLeftMs) > 0) tail = '距不可撤单 ' + fmtLeft(unlockLeft);
    else tail = isOpen ? '阶段结束集中撮合' : '阶段结束定收盘价';
    patchTxt('abNote', volTxt + ' · ' + tail, 'ab-note' + (locked ? ' locked' : ''));

    // 阶段进度条（CSSOM：CSP 禁内联 style 属性）
    const prog = $('abProg');
    if (prog) {
      const ms = Math.max(1, num(d.phaseMs));
      const pct = Math.max(0, Math.min(100, ((ms - left) / ms) * 100));
      prog.style.width = pct.toFixed(1) + '%';
    }

    // 盘口上方的两行紧凑版：挂单时眼睛不用回到报价卡
    patchTxt('baPrice', price == null ? '--' : fmtP(price),
      'ba-price num ' + (price == null ? 'dim' : cls(price - pc)));
    patchTxt('baVol', price == null ? '无交叉' : '量 ' + fmtAmt(a.volume), 'ba-vol');
  }

  function renderBook(m) {
    const box = $('bookBox');
    if (!box) return;
    const depth = m.depth || { bids: [], asks: [] };
    const asks = (depth.asks || []).slice(0, 5);
    const bids = (depth.bids || []).slice(0, 5);
    let maxQty = 1;
    asks.concat(bids).forEach((r) => (maxQty = Math.max(maxQty, num(r.qty))));

    const rowHtml = (r, i, side) => {
      const q = num(r.qty);
      const pct = Math.round((q / maxQty) * 100);
      // 价差配色跟随「相对昨收」，而不是固定卖绿买红：跨过昨收的档位要变色
      const tone = num(r.price) >= num(m.prevClose) ? 'up' : 'down';
      return (
        '<div class="book-row">' +
          '<span class="book-bar ' + (side === 'ask' ? 'up' : 'down') + '" data-w="' + pct + '"></span>' +
          // 卖侧入参已 reverse（上→下 5→1），买侧保持服务端原序（买1 在最上），
          // 所以档位号要分侧算：卖 5-i，买 i+1
          '<span class="lab">' + (side === 'ask' ? '卖' : '买') + (side === 'ask' ? 5 - i : i + 1) + '</span>' +
          '<span class="px ' + tone + '">' + fmtP(r.price) + '</span>' +
          '<span class="qt">' + fmtQty(q) + '</span>' +
        '</div>'
      );
    };

    // 卖盘从上到下 5→1，买盘 1→5
    const asksHtml = asks
      .slice()
      .reverse()
      .map((r, i) => rowHtml(r, i, 'ask'))
      .join('');
    const bidsHtml = bids.map((r, i) => rowHtml(r, i, 'bid')).join('');

    box.innerHTML =
      asksHtml +
      '<div class="book-mid"><span class="num ' + cls(m.change) + '">' +
        fmtP(m.last) + '</span><span>停 ' + fmtP(m.band && m.band.up) + '/' +
        fmtP(m.band && m.band.down) + '</span></div>' +
      bidsHtml;

    // 深度条宽度走 CSSOM（CSP 不许内联 style 属性）
    box.querySelectorAll('.book-bar').forEach((el) => {
      el.style.width = (el.dataset.w || 0) + '%';
    });
  }

  /**
   * 成分股列表（指数页右栏，替代个股的五档/分时成交）。
   * 一帧一变的价格只 patch 文本；名单与权重变动才重建（权重每 tick 由服务端重算）。
   * 行是 button：点一只成分股就换到那只票的详情页。
   */
  function renderComponents(m) {
    const box = $('compList');
    if (!box) return;
    const rows = m.components || [];
    const sig = rows.map((r) => r.stockId).join(',');
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.innerHTML =
        rows
          .map(
            (r) =>
              '<button class="comp-row" data-comp-stock="' + esc(r.stockId) + '">' +
                '<span class="comp-name">' + esc(r.name || r.stockId) + '</span>' +
                '<span class="comp-pct num" data-cpct="' + esc(r.stockId) + '">' +
                  fmtPct(r.changePct) + '</span>' +
                '<i class="comp-bar"><b data-cw="' + esc(r.stockId) + '"></b></i>' +
              '</button>'
          )
          .join('') || '<div class="empty">暂无成分</div>';
    }
    rows.forEach((r) => {
      const pct = box.querySelector('[data-cpct="' + r.stockId + '"]');
      if (pct) {
        pct.textContent = fmtPct(r.changePct);
        pct.className = 'comp-pct num ' + cls(r.changePct);
      }
      // 权重条宽度走 CSSOM（CSP 禁内联 style 属性）
      const bar = box.querySelector('[data-cw="' + r.stockId + '"]');
      if (bar) bar.style.width = Math.max(0, Math.min(100, num(r.weight))) + '%';
    });
  }

  function renderFlow(m) {
    const f = m.flow || {};
    const outer = num(f.outerVol);
    const inner = num(f.innerVol);
    const total = outer + inner;
    const po = total ? Math.round((outer / total) * 100) : 50;
    const bar1 = $('flowOuter');
    const bar2 = $('flowInner');
    if (bar1) bar1.style.width = po + '%';
    if (bar2) bar2.style.width = 100 - po + '%';
    if (bar1) bar1.style.background = 'var(--up)';
    if (bar2) bar2.style.background = 'var(--down)';
    const t1 = $('flowOuterTxt');
    const t2 = $('flowInnerTxt');
    if (t1) t1.textContent = '外盘 ' + fmtAmt(outer) + ' 股';
    if (t2) t2.textContent = '内盘 ' + fmtAmt(inner) + ' 股';
    const net = $('flowNet');
    if (net) {
      const v = num(f.net);
      net.textContent = '净流入 ' + (v >= 0 ? '+' : '') + fmtAmt(v);
      net.className = 'card-more num ' + cls(v);
    }
  }

  function renderTicker(m) {
    const box = $('tickerBox');
    if (!box) return;
    // 「分时成交」是当日口径：服务端已按 dayStartAt 裁过一道（见 Market.tapeToday），
    // 这里再兜一次——旧服务端、或者 App 拿到的帧与 day 段不同步时，
    // 面板会翻出昨天 14:5x 那批成交，玩家一眼看上去就是「昨天的分时成交没清」。
    const since = Number(dayInfo() && dayInfo().dayStartAt) || 0;
    const all = since ? (m.trades || []).filter((t) => num(t.ts || t.t) >= since) : m.trades || [];
    const trades = all.slice(0, 14);
    if (!trades.length) {
      if (box.dataset.empty !== '1') {
        box.dataset.empty = '1';
        box.innerHTML = '<div class="empty">暂无成交</div>';
      }
      return;
    }
    box.dataset.empty = '0';
    box.innerHTML = trades
      .map((t) => {
        const dir = t.action === 'buy_open' || t.action === 'buy_close' ? 'up' : 'down';
        return (
          '<div class="tick-row">' +
            '<span class="tick-time">' + fmtHM(t.ts || t.t || 0) + '</span>' +
            '<span class="' + dir + '">' + fmtP(t.price) + '</span>' +
            '<span class="tick-qty">' + fmtQty(t.qty) + '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  function renderHalt(st, m) {
    const box = $('haltBox');
    if (!box) return;
    const halt = st.halt;
    const day = st.day;
    const idx = !!(m && m.isIndex);
    let html = '';
    if (halt && halt.halted) {
      html =
        '<div class="halt-tip halted">⛔ <b>已停牌</b> · ' + esc(halt.reason || '运维暂停交易') +
        (halt.until ? '，预计 ' + fmtTime(halt.until) + ' 恢复' : '') +
        '<span class="ht-sub">停牌期间不撮合、不能下单</span></div>';
    } else if (day && !day.trading) {
      // 午休与夜间是两种完全不同的「休市」：一个 40 秒后继续交易，一个结算完才开新的一天。
      // 原先共用一句「休市期间不能下单」，玩家分不清是午休还是已经收盘
      const night = day.phase === 'night';
      const left = num(day.phaseLeftMs);
      html =
        '<div class="halt-tip closed ' + (night ? 'night' : 'lunch') + '">' +
        (night ? '🌙 ' : '🕐 ') +
        '<b>' + esc(day.label || (night ? '已收盘结算' : '休市')) + '</b>' +
        '<span class="ht-sub">' +
        (night
          ? '未成交委托已失效' + (left > 0 ? '，' + fmtLeft(left) + '后开盘集合竞价' : '，即将开盘集合竞价')
          : '暂停下单与撮合' + (left > 0 ? '，' + fmtLeft(left) + '后恢复交易' : '，即将恢复交易')) +
        '</span></div>';
    } else if (idx && day && day.auction) {
      // 指数没有自己的盘口（快照里没有 auction 字段），拿不到虚拟价——只报阶段与倒计时。
      // 个股页的竞价信息在报价卡顶部的竞价条里，这里不再重复
      const left = num(day.phaseLeftMs);
      html =
        '<div class="halt-tip auction">📣 <b>' + esc(day.label || '集合竞价') + '</b>' +
        '<span class="ht-sub">' +
        (left > 0 ? fmtLeft(left) + '后' + (day.auction === 'open' ? '开盘' : '收盘') + '集中撮合'
          : '正在集中撮合') +
        ' · 成分股按匹配价定价</span></div>';
    }
    if (box.dataset.last !== html) {
      box.dataset.last = html;
      box.innerHTML = html;
    }
  }

  function drawActState(m) {
    const bar = $('actBar');
    if (!bar) return;
    const st = GS.core.S.state;
    const canTrade = GS.core.isTrading();
    const cd = num(st.cooldownLeft);
    // 只动带 data-side 的按钮——act-bar 里还有「条件单」这类非交易按钮，不能被改文字
    bar.querySelectorAll('button[data-side]').forEach((b) => {
      const side = b.dataset.side;
      const pos = GS.core.position(state.stockId);
      let ok = canTrade;
      if (side === 'sell_close' && !(pos && pos.long && pos.long.sellable > 0)) ok = false;
      b.disabled = !ok;
      if (side === 'buy_open') b.textContent = cd > 0 ? '冷却 ' + (cd / 1000).toFixed(1) + 's' : '买入';
      else b.textContent = '卖出';
    });
  }

  /* -------------------------------------------------------------- 弹幕 */

  function pumpDanmaku(st) {
    const wrap = $('chartWrap');
    const dm = st.danmaku;
    if (!wrap || !dm || !Array.isArray(dm.items)) return;
    if (!wrap.querySelector('.dm-layer')) {
      const layer = document.createElement('div');
      layer.className = 'dm-layer';
      wrap.appendChild(layer);
    }
    const layer = wrap.querySelector('.dm-layer');
    dm.items.forEach((it) => {
      if (!it.id || state.dmSeen.has(it.id)) return;
      state.dmSeen.add(it.id);
      if (state.dmSeen.size > 400) state.dmSeen.clear();
      const text = it.text || '';
      if (!text) return;
      const el = document.createElement('div');
      el.className = 'dm-item' + (it.level >= 2 ? ' hot' : '');
      el.textContent = text;
      el.style.top = 8 + Math.floor(Math.random() * 46) + '%';
      el.style.animationDuration = 6.5 + Math.random() * 3 + 's';
      layer.appendChild(el);
      setTimeout(() => el.remove(), 11000);
    });
  }

  /* -------------------------------------------------------------- 下单 */

  function maxQty(action, price) {
    const st = GS.core.S.state;
    const acc = st.account || {};
    const rules = st.rules || {};
    const pos = GS.core.position(state.stockId);
    const fee = num(rules.feeRate);
    if (action === 'buy_open') {
      return Math.max(0, Math.floor(num(acc.cash) / (price * (1 + fee))));
    }
    if (action === 'sell_close') {
      return pos && pos.long ? num(pos.long.sellable) : 0;
    }
    if (action === 'buy_close') {
      return pos && pos.short ? num(pos.short.coverable) : 0;
    }
    // sell_open：保证金口径
    const ratio = num(rules.marginRatio) || 0.5;
    const shortMV = num(acc.shortValue);
    const v = Math.max(0, (num(acc.equity) - ratio * shortMV) / (ratio + fee));
    return Math.floor(v / Math.max(price, 0.01));
  }

  /**
   * 竞价阶段的下单提示。竞价只入簿不撮合，玩家最容易犯的两个错：
   * ① 以为「下单即成交」——成交其实在阶段末尾按最大成交量价一次性撮合；
   * ② 拖到最后一刻想撤——最后 10 秒（真实市场 09:20 / 14:57 那条硬线）撤不掉。
   */
  function auctionTip(st, m) {
    const d = st && st.day;
    if (!d || !d.enabled || !d.auction || !m || m.isIndex || !m.auction) return '';
    const kind = m.auction.kind === 'open' ? '开盘' : '收盘';
    return d.locked
      ? kind + '集合竞价 · 已进入不可撤单窗口，现在下的单不可撤'
      : kind + '集合竞价 · 先入簿，阶段结束时按最大成交量价集中撮合';
  }

  function openOrder(action) {
    const m = GS.core.market(state.stockId);
    if (!m) return;
    const st = GS.core.S.state;
    if (!GS.core.isTrading()) {
      GS.core.toast('当前休市或停牌，不能下单', 'err');
      return;
    }
    const lot = num(m.lotSize) || 100;
    let side = action === 'buy_open' || action === 'buy_close' ? 'buy' : 'sell';
    let cur = action;
    // 竞价阶段 last 还是昨收（只入簿不撮合），拿它当默认价等于让玩家对着「昨收」下单；
    // 有虚拟成交价就先用它，没有（盘口未交叉）才退回最新价
    const au = m.auction && m.auction.price != null ? m.auction : null;
    const auTip = auctionTip(st, m);
    let price = au ? num(au.price) : num(m.last);
    let qty = lot;

    const html =
      (auTip ? '<div class="ord-auction">📣 ' + esc(auTip) + '</div>' : '') +
      '<div class="order-side" id="sideRow">' +
        '<button data-act="buy_open">买入开多</button>' +
        '<button data-act="sell_close">卖出平多</button>' +
        '<button data-act="sell_open">卖出开空</button>' +
        '<button data-act="buy_close">买入平空</button>' +
      '</div>' +
      '<div class="stepper">' +
        '<button data-step="price" data-dir="-1">−</button>' +
        '<input id="ordPrice" inputmode="decimal" value="' + fmtP(price) + '">' +
        '<button data-step="price" data-dir="1">+</button>' +
      '</div>' +
      '<div class="chip-row" id="priceChips">' +
        '<button class="chip" data-px="last">' + (au ? '虚拟价' : '最新') + '</button>' +
        '<button class="chip" data-px="bid">买一</button>' +
        '<button class="chip" data-px="ask">卖一</button>' +
      '</div>' +
      '<div class="sec-title">数量</div>' +
      '<div class="stepper">' +
        '<button data-step="qty" data-dir="-1">−</button>' +
        '<input id="ordQty" inputmode="numeric" value="' + qty + '">' +
        '<button data-step="qty" data-dir="1">+</button>' +
      '</div>' +
      '<div class="chip-row" id="qtyChips">' +
        '<button class="chip" data-frac="0.25">1/4</button>' +
        '<button class="chip" data-frac="0.5">半仓</button>' +
        '<button class="chip" data-frac="1">全仓</button>' +
      '</div>' +
      '<div class="field-line"><span>预估金额</span><b id="estAmt">—</b></div>' +
      '<div class="field-line"><span>手续费</span><b id="estFee">—</b></div>' +
      '<div class="field-line"><span>可用 / 最大</span><b id="estMax">—</b></div>' +
      '<button class="btn-primary" id="ordBtn">确认买入</button>' +
      '<div class="hint" id="ordHint"></div>';

    GS.core.sheet({
      title: m.name + ' ' + m.stockId,
      html,
      onMount(ctl) {
        const body = ctl.body;
        const pIn = body.querySelector('#ordPrice');
        const qIn = body.querySelector('#ordQty');
        const btn = body.querySelector('#ordBtn');

        const sync = () => {
          price = Math.max(0.01, num(pIn.value));
          qty = Math.max(lot, Math.round(num(qIn.value) / lot) * lot);
          const gross = price * qty;
          const fee = gross * num(st.rules.feeRate);
          body.querySelector('#estAmt').textContent = '¥' + fmtMoney(gross);
          body.querySelector('#estFee').textContent = '¥' + fmtMoney(fee);
          const mx = maxQty(cur, price);
          body.querySelector('#estMax').textContent = fmtQty(mx) + ' 股';
          body.querySelectorAll('#sideRow button').forEach((b) => {
            b.className = '';
            if (b.dataset.act === cur) {
              b.className = b.dataset.act.indexOf('buy') === 0 ? 'on-buy' : 'on-sell';
            }
          });
          btn.textContent = ACTION_LABEL[cur];
          btn.className = 'btn-primary';
          btn.disabled = qty > mx || qty <= 0 || !GS.core.isTrading();
          const hint = body.querySelector('#ordHint');
          hint.textContent =
            qty > mx
              ? '超出可下单数量（最大 ' + fmtQty(mx) + ' 股）'
              : '整手交易，每手 ' + lot + ' 股；下单后有冷却时间';
        };

        GS.core.on(body, '#sideRow button', 'click', (e, t) => {
          cur = t.dataset.act;
          sync();
        });

        GS.core.on(body, '[data-step]', 'click', (e, t) => {
          const dir = num(t.dataset.dir);
          if (t.dataset.step === 'price') {
            pIn.value = Math.max(0.01, num(pIn.value) + dir * 0.01).toFixed(2);
          } else {
            qIn.value = Math.max(lot, num(qIn.value) + dir * lot);
          }
          sync();
        });

        GS.core.on(body, '#priceChips button', 'click', (e, t) => {
          const k = t.dataset.px;
          const d = (m.depth || {});
          let v = au ? num(au.price) : num(m.last);
          if (k === 'bid' && d.bids && d.bids[0]) v = num(d.bids[0].price);
          if (k === 'ask' && d.asks && d.asks[0]) v = num(d.asks[0].price);
          pIn.value = fmtP(v);
          sync();
        });

        GS.core.on(body, '#qtyChips button', 'click', (e, t) => {
          const mx = maxQty(cur, num(pIn.value));
          const frac = num(t.dataset.frac);
          const raw = Math.floor((mx * frac) / lot) * lot;
          qIn.value = String(Math.max(0, raw));
          sync();
        });

        pIn.addEventListener('input', sync);
        qIn.addEventListener('input', sync);

        btn.onclick = () => {
          btn.disabled = true;
          btn.textContent = '提交中…';
          GS.api.api
            .order({ stockId: state.stockId, action: cur, qty, price: num(pIn.value), finance: false })
            .then((r) => {
              if (r && r.ok) {
                const o = r.order || {};
                const filled = num(o.filled);
                const txt =
                  filled > 0
                    ? filled >= num(o.qty)
                      ? '全部成交'
                      : '成交 ' + fmtQty(filled) + '/' + fmtQty(o.qty) + ' 股'
                    : au
                      ? '已进竞价簿，阶段末集中撮合'
                      : '已挂单';
                GS.core.toast(ACTION_LABEL[cur] + ' ' + txt, 'ok');
                GS.core.closeSheet();
                return;
              }
              btn.disabled = false;
              btn.textContent = ACTION_LABEL[cur];
              GS.core.toast((r && r.error) || '下单失败', 'err');
            })
            .catch(() => {
              btn.disabled = false;
              btn.textContent = ACTION_LABEL[cur];
              GS.core.toast('网络异常，下单未确认', 'err');
            });
        };

        // 预填：卖出类默认全部可卖
        if (cur === 'sell_close' || cur === 'buy_close') {
          const mx = maxQty(cur, price);
          if (mx > 0) qIn.value = String(mx);
        }
        sync();
      },
    });
  }

  /* ---------------------------------------------------------------- 导出 */

  GS.viewStock = {
    open, close, redraw: draw,
    get stockId() { return state.stockId; },
    // K 线视窗只读出口（验收脚本用；与网页版导出 klineView 同一个意图）
    get kviews() { return kViews; },
  };
})(window.GS);
