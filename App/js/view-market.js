/* ==========================================================================
   view-market.js — 首页「行情」
   结构：公告横幅 → 指数 Hero（含迷你走势）→ 10 只标的列表
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
      '<div class="hero" id="idxHero">' +
        '<div class="hero-name"><span id="idxName">全村希望</span>' +
          '<span class="tag" id="idxCode">999999</span></div>' +
        '<div class="hero-price"><b class="num" id="idxLast">—</b>' +
          '<span class="hero-chg num" id="idxChg">—</span></div>' +
        '<div class="hero-meta">' +
          '<span>今开<b class="num" id="idxOpen">—</b></span>' +
          '<span>最高<b class="num" id="idxHigh">—</b></span>' +
          '<span>最低<b class="num" id="idxLow">—</b></span>' +
          '<span>成交<b class="num" id="idxTurn">—</b></span>' +
        '</div>' +
        '<div class="hero-spark"><canvas class="spark-canvas" id="idxSpark"></canvas></div>' +
      '</div>' +
      '<div class="sec-title">全部标的</div>' +
      '<div class="card card-flat"><div class="stock-list" id="stockList"></div></div>' +
      '<div class="hint">点任意标的进入详情。左侧迷你走势来自全市场降采样，约 30 秒更新一次。</div>';

    GS.core.on(root, '.stock-row', 'click', (e, t) => {
      GS.viewStock.open(t.dataset.stock);
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
    title: '行情',
    update,
    /** 首次进入时清掉缓存，避免切回来不刷新 */
    reset() {
      built = false;
      sig = '';
    },
  };
})(window.GS);
