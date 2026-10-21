/* ==========================================================================
   view-market.js — 首页
   结构：公告横幅 → 修为卡（境界进度 + 总资产）→ 指数 Hero（含迷你走势）→ 10 只标的列表
   性能口径：DOM 只建一次，之后按帧 patch 文本，不整段重绘
   ========================================================================== */
(function (GS) {
  'use strict';

  const { esc, fmtP, fmtPct, fmtChg, fmtAmt, cls, market, num } = GS.core;

  const refs = new Map(); // stockId -> { row, price, pill, spark, lastPrice }
  let hero = null;
  let built = false;
  let sig = '';

  /* ---------------------------------------------------------------- 构建 */

  function build(root) {
    root.innerHTML =
      '<div id="noticeBox"></div>' +
      // 修为卡：一打开 App 就能看到自己的境界进度与资产，点整卡进「我的」
      '<div class="mine-card" id="mineCard">' +
        '<div class="me-row">' +
          '<img class="ava-md" id="mineAva" alt="">' +
          '<div class="grow mine-main">' +
            '<div class="mine-name-row">' +
              '<span class="mine-name" id="mineName">—</span>' +
              '<span class="tag tag-gold" id="mineRealmTag" hidden></span>' +
            '</div>' +
            '<div class="mine-sub" id="mineSub">—</div>' +
          '</div>' +
          '<div class="mine-asset">' +
            '<div class="mine-asset-label">总资产</div>' +
            '<div class="mine-asset-value num" id="mineEquity">—</div>' +
            '<div class="mine-asset-pnl num" id="minePnl">—</div>' +
          '</div>' +
        '</div>' +
        '<div class="realm-bar" id="mineRealmWrap">' +
          '<div class="realm-bar-top"><span id="mineRealmNow">—</span><span id="mineRealmNext">—</span></div>' +
          '<div class="bar"><i id="mineRealmBar"></i></div>' +
        '</div>' +
      '</div>' +
      '<div class="hero" id="idxHero">' +
        '<div class="hero-name"><span id="idxName">全村希望</span>' +
          '<span class="tag" id="idxCode">999999</span></div>' +
        '<div class="hero-price"><b class="num" id="idxLast">—</b>' +
          '<span class="hero-chg num" id="idxChg">—</span></div>' +
        '<div class="hero-spark"><canvas class="spark-canvas" id="idxSpark"></canvas></div>' +
        '<div class="hero-meta">' +
          '<span>今开<b class="num" id="idxOpen">—</b></span>' +
          '<span>最高<b class="num" id="idxHigh">—</b></span>' +
          '<span>最低<b class="num" id="idxLow">—</b></span>' +
          '<span>成交<b class="num" id="idxTurn">—</b></span>' +
        '</div>' +
        '<img class="hero-mascot" id="heroMascot" alt="看板娘" hidden />' +
      '</div>' +
      '<div class="sec-title">全部标的</div>' +
      '<div class="card card-flat"><div class="stock-list" id="stockList"></div></div>' +
      '<div class="hint">点任意标的进入详情。左侧迷你走势来自全市场降采样，约 30 秒更新一次。</div>';

    GS.core.on(root, '.stock-row', 'click', (e, t) => {
      GS.viewStock.open(t.dataset.stock);
    });
    GS.core.on(root, '#mineCard', 'click', () => {
      GS.app.switchTo('me');
    });

    built = true;
    sig = '';
    refs.clear();
  }

  function buildList(markets) {
    const box = GS.core.$('stockList');
    if (!box) return;
    box.innerHTML = markets
      .map(
        (m) =>
          '<div class="stock-row" data-stock="' + esc(m.stockId) + '">' +
            '<div class="stock-id">' +
              '<div class="stock-name">' + esc(m.name) + '</div>' +
              '<div class="stock-code">' + esc(m.stockId) + '</div>' +
            '</div>' +
            '<div class="stock-spark"><canvas class="spark-canvas" data-spark="' + esc(m.stockId) + '"></canvas></div>' +
            '<div class="stock-quote">' +
              '<div class="stock-price num" data-price="' + esc(m.stockId) + '">' + fmtP(m.last) + '</div>' +
              '<div class="pill flat num" data-pill="' + esc(m.stockId) + '">' + fmtPct(m.changePct) + '</div>' +
            '</div>' +
          '</div>'
      )
      .join('');

    refs.clear();
    markets.forEach((m) => {
      const row = box.querySelector('[data-stock="' + m.stockId + '"]');
      refs.set(m.stockId, {
        row,
        price: box.querySelector('[data-price="' + m.stockId + '"]'),
        pill: box.querySelector('[data-pill="' + m.stockId + '"]'),
        spark: box.querySelector('[data-spark="' + m.stockId + '"]'),
        lastPrice: m.last,
      });
    });

    drawAllSparks();
  }

  function drawAllSparks() {
    refs.forEach((r, id) => {
      const m = market(id);
      const pts = GS.api.sparkOf(id);
      if (r.spark && pts && pts.length > 1) {
        GS.chart.spark(r.spark, pts, m ? m.prevClose : 0);
      }
    });
    const idxSpark = GS.core.$('idxSpark');
    if (idxSpark) {
      const pts = GS.api.sparkOf('999999');
      if (pts && pts.length > 1) GS.chart.spark(idxSpark, pts, num(GS.core.S.state.index.prevClose));
    }
  }

  /* ---------------------------------------------------------------- 更新 */

  function update(root) {
    if (!built) build(root);
    const st = GS.core.S.state;
    if (!st) return;
    const markets = st.markets || [];
    const ids = markets.map((m) => m.stockId).join(',');

    // 看板娘：只在选择变化时换图（换装入口在「我的」页）
    const mid = GS.core.mascotId();
    const mimg = GS.core.$('heroMascot');
    if (mimg && mimg.dataset.k !== mid) {
      mimg.dataset.k = mid;
      mimg.src = GS.core.mascotImg(mid, true);
      mimg.hidden = false;
    }

    // 标的集合变了才重建列表
    if (ids !== sig) {
      sig = ids;
      buildList(markets);
    }

    // 公告
    const nb = GS.core.$('noticeBox');
    if (nb) {
      const n = st.notice;
      nb.innerHTML = n && n.text ? '<div class="notice"><span>📢</span><div>' + esc(n.text) + '</div></div>' : '';
    }

    // 修为卡（账号帧没到就保持占位）
    const acc = st.account;
    if (acc) {
      const setM = (id, v) => {
        const el = GS.core.$(id);
        if (el) el.textContent = v;
      };
      const ava = (acc.avatar && acc.avatar.key) || 'auntie';
      const mava = GS.core.$('mineAva');
      if (mava && mava.dataset.k !== ava) {
        mava.dataset.k = ava;
        mava.src = '/img/avatar-' + ava + '-192.png';
      }
      setM('mineName', acc.nick || acc.name || '—');
      const r = acc.realm || null;
      const tag = GS.core.$('mineRealmTag');
      if (tag) {
        if (r && r.name) {
          tag.textContent = r.name;
          tag.hidden = false;
        } else {
          tag.hidden = true;
        }
      }
      setM('mineSub',
        [r && r.honor, acc.broker && acc.broker.name].filter(Boolean).join(' · ') || '—');
      const eq = GS.core.$('mineEquity');
      if (eq) {
        eq.textContent = '¥' + num(acc.equity).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
      }
      const float = num(acc.longPnl) + num(acc.shortPnl);
      const pnl = GS.core.$('minePnl');
      if (pnl) {
        pnl.textContent = '浮动盈亏 ' + (float >= 0 ? '+' : '') + fmtAmt(float);
        pnl.className = 'mine-asset-pnl num ' + cls(float);
      }
      const wrap = GS.core.$('mineRealmWrap');
      if (wrap) wrap.hidden = !r;
      if (r) {
        setM('mineRealmNow', r.name + (r.short ? ' · ' + r.short : ''));
        setM('mineRealmNext',
          r.next ? '距 ' + r.next.name + ' 还差 ' + fmtAmt(Math.max(0, num(r.next.need))) : '已到顶');
        const bar = GS.core.$('mineRealmBar');
        if (bar) {
          const pct = r.next ? Math.max(0, Math.min(100, num(r.next.pct) * 100)) : 100;
          bar.style.width = pct + '%';
        }
      }
    }

    // 指数
    const idx = st.index;
    if (idx && hero !== false) {
      const set = (id, v) => {
        const el = GS.core.$(id);
        if (el) el.textContent = v;
      };
      set('idxName', idx.name || '全村希望');
      set('idxCode', idx.stockId || '999999');
      const last = GS.core.$('idxLast');
      if (last) {
        last.textContent = fmtP(idx.last);
        last.className = 'num ' + cls(idx.change);
      }
      const chg = GS.core.$('idxChg');
      if (chg) {
        chg.textContent = fmtChg(idx.change) + '  ' + fmtPct(idx.changePct);
        chg.className = 'hero-chg num ' + cls(idx.change);
      }
      set('idxOpen', fmtP(idx.open));
      set('idxHigh', fmtP(idx.high));
      set('idxLow', fmtP(idx.low));
      set('idxTurn', fmtAmt(idx.turnover));
    }

    // 列表 patch
    markets.forEach((m) => {
      const r = refs.get(m.stockId);
      if (!r) return;
      if (r.price) r.price.textContent = fmtP(m.last);
      if (r.pill) {
        r.pill.textContent = fmtPct(m.changePct);
        r.pill.className = 'pill num ' + cls(m.change);
      }
    });

    drawAllSparks();
  }

  /* ---------------------------------------------------------------- 导出 */

  GS.viewMarket = {
    id: 'market',
    title: '首页',
    update,
    /** 首次进入时清掉缓存，避免切回来不刷新 */
    reset() {
      built = false;
      sig = '';
    },
  };
})(window.GS);
