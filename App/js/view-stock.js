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
    mode: 'min', // min | 5d | day
    cursor: -1,
    bars: null,
    barsFor: '',
    unsub: null,
    dmSeen: new Set(),
    lastDraw: 0,
  };

  const ACTION_LABEL = {
    buy_open: '买入开多',
    sell_close: '卖出平多',
    sell_open: '卖出开空',
    buy_close: '买入平空',
  };

  /* ---------------------------------------------------------------- 骨架 */

  function skeleton(m) {
    return (
      GS.core.pageHead(m ? m.name : '个股', m ? m.stockId : '', '') +
      '<div class="page-body" id="stockBody">' +
        '<div class="quote-head">' +
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
            '<span>市值<b class="num" id="qCap">—</b></span>' +
          '</div>' +
        '</div>' +

        '<div class="stock-columns">' +
          '<div class="card chart-card">' +
            '<div class="chart-tabs" id="chartTabs">' +
              '<button data-mode="min" class="on">分时</button>' +
              '<button data-mode="5d">五日</button>' +
              '<button data-mode="day">日K</button>' +
            '</div>' +
            '<div class="chart-wrap" id="chartWrap">' +
              '<canvas id="chartCanvas"></canvas>' +
              '<div class="chart-tip" id="chartTip" hidden></div>' +
            '</div>' +
          '</div>' +
          '<div class="book-panel">' +
            '<div class="book-panel-title">五档盘口</div>' +
            '<div class="book" id="bookBox"></div>' +
            '<div class="book-sub">分时成交</div>' +
            '<div class="panel-ticker" id="tickerBox"></div>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><div class="card-title">资金</div>' +
            '<div class="card-more num" id="flowNet">—</div></div>' +
          '<div class="flow-bar"><i id="flowOuter"></i><i id="flowInner"></i></div>' +
          '<div class="flow-legend"><span id="flowOuterTxt">外盘 —</span>' +
            '<span id="flowInnerTxt">内盘 —</span></div>' +
        '</div>' +

        '<div id="haltBox"></div>' +
      '</div>' +
      '<div class="act-bar" id="actBar">' +
        '<button class="btn-buy" data-side="buy_open">买入</button>' +
        '<button class="btn-sell" data-side="sell_close">卖出</button>' +
      '</div>'
    );
  }

  /* ---------------------------------------------------------------- 打开 */

  function open(stockId) {
    state.stockId = stockId || state.stockId;
    state.mode = 'min';
    state.cursor = -1;
    state.bars = null;
    state.barsFor = '';
    state.dmSeen.clear();

    const m = GS.core.market(state.stockId);
    const ctl = GS.core.openPage({
      html: skeleton(m),
      onMount(el) {
        GS.core.bindPageBack(el.el);
        bindTabs(el.el);
        bindChartTouch(el.el);
        bindAct(el.el);
        draw();
      },
    });

    // 拉分时 + 日线（日线按需）
    GS.api.loadHistory(state.stockId).then(() => draw());
    if (state.unsub) state.unsub();
    state.unsub = GS.core.subscribe(() => {
      tick();
    });
    const prevClose = ctl.onClose;
    ctl.onClose = () => {
      if (state.unsub) state.unsub();
      state.unsub = null;
      if (prevClose) prevClose();
    };
    return ctl;
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
      if (state.mode === 'day') ensureBars();
      draw();
    });
  }

  function bindChartTouch(el) {
    const wrap = el.querySelector('#chartWrap');
    const tip = el.querySelector('#chartTip');
    let dragging = false;

    const move = (ev) => {
      const t = ev.touches && ev.touches[0];
      if (!t) return;
      const rect = wrap.getBoundingClientRect();
      const x = t.clientX - rect.left;
      const geo = state.geo;
      if (!geo || !geo.hit) return;
      const idx = geo.hit(x);
      if (idx < 0) return;
      state.cursor = idx;
      draw();
      showTip(tip, idx);
    };

    wrap.addEventListener(
      'touchstart',
      (ev) => {
        dragging = true;
        move(ev);
      },
      { passive: true }
    );
    wrap.addEventListener(
      'touchmove',
      (ev) => {
        if (!dragging) return;
        move(ev);
      },
      { passive: true }
    );
    const end = () => {
      dragging = false;
      state.cursor = -1;
      tip.hidden = true;
      draw();
    };
    wrap.addEventListener('touchend', end, { passive: true });
    wrap.addEventListener('touchcancel', end, { passive: true });
  }

  function showTip(tip, idx) {
    const geo = state.geo;
    if (!geo || !geo.points || !geo.points[idx]) {
      tip.hidden = true;
      return;
    }
    const pt = geo.points[idx];
    if (state.mode === 'day') {
      const b = pt.bar || {};
      tip.innerHTML =
        '<span>' + esc(b.day || '') + '</span>' +
        '<span>开 ' + fmtP(b.open) + '</span>' +
        '<span>高 ' + fmtP(b.high) + '</span>' +
        '<span>低 ' + fmtP(b.low) + '</span>' +
        '<span>收 ' + fmtP(b.close) + '</span>';
    } else {
      const m = GS.core.market(state.stockId);
      const base = m ? num(m.prevClose) : 0;
      const pct = base ? ((pt.price - base) / base) * 100 : 0;
      tip.innerHTML =
        '<span>' + fmtTime(pt.t) + '</span>' +
        '<span class="' + cls(pt.price - base) + '">' + fmtP(pt.price) + '</span>' +
        '<span class="' + cls(pct) + '">' + fmtPct(pct) + '</span>' +
        (pt.vol ? '<span>量 ' + fmtQty(pt.vol) + '</span>' : '');
    }
    tip.hidden = false;
  }

  function bindAct(el) {
    GS.core.on(el, '[data-side]', 'click', (e, t) => {
      openOrder(t.dataset.side);
    });
  }

  /* -------------------------------------------------------------- 日线 */

  function ensureBars() {
    if (state.barsFor === state.stockId && state.bars) return;
    state.barsFor = state.stockId;
    GS.api
      .getJSON('/api/daily?stock=' + encodeURIComponent(state.stockId) + '&limit=120')
      .then((r) => {
        if (r && r.ok) state.bars = r.bars || [];
        draw();
      })
      .catch(() => {});
  }

  /* ---------------------------------------------------------------- 绘制 */

  function draw() {
    const cvs = $('chartCanvas');
    const m = GS.core.market(state.stockId);
    if (!cvs || !m) return;
    state.lastDraw = Date.now();

    if (state.mode === 'day') {
      ensureBars();
      state.geo = GS.chart.daily(cvs, { bars: state.bars || [], cursor: state.cursor });
      return;
    }

    let pts = GS.api.historyOf(state.stockId);
    let from = 0;
    let to = 0;
    const d = GS.core.S.state.day;
    if (state.mode === 'min' && d && d.dayStartAt) {
      from = d.dayStartAt;
      to = d.dayEndsAt;
      pts = pts.filter((p) => p.t >= from);
    } else if (state.mode === '5d' && d && d.dayEndsAt) {
      // 5 个交易日的近似窗口：按当日总时长 × 5 反推，超出部分自动裁掉
      const dayMs = Math.max(1, num(d.dayEndsAt) - num(d.dayStartAt));
      from = num(d.dayStartAt) - dayMs * 4;
      to = d.dayEndsAt;
      pts = pts.filter((p) => p.t >= from);
    }
    if (pts.length && !from) {
      from = pts[0].t;
      to = pts[pts.length - 1].t;
    }

    state.geo = GS.chart.minute(cvs, {
      pts,
      prevClose: num(m.prevClose),
      cursor: state.cursor,
      from,
      to,
    });
  }

  /* ---------------------------------------------------------------- 刷新 */

  function tick() {
    const st = GS.core.S.state;
    if (!st) return;
    const m = GS.core.market(state.stockId);
    if (!m) return;

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

    renderBook(m);
    renderFlow(m);
    renderTicker(m);
    renderHalt(st, m);
    pumpDanmaku(st);
    drawActState(m);

    // 画布不必每帧重绘（700ms 一帧，重绘一次就够）
    if (Date.now() - state.lastDraw > 500) draw();
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
          '<span class="lab">' + (side === 'ask' ? '卖' : '买') + (5 - i) + '</span>' +
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
    const trades = (m.trades || []).slice(0, 14);
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
    let html = '';
    if (halt && halt.halted) {
      html =
        '<div class="halt-tip">⛔ 已停牌：' + esc(halt.reason || '运维暂停交易') +
        (halt.until ? '，预计 ' + fmtTime(halt.until) + ' 恢复' : '') + '</div>';
    } else if (day && !day.trading) {
      html =
        '<div class="halt-tip">🕐 当前 ' + esc(day.label || '休市') +
        '，' + fmtLeft(day.phaseLeftMs) + '后进入下一阶段。休市期间不能下单。</div>';
    } else if (day && day.auction) {
      html = '<div class="halt-tip">📣 ' + esc(day.label || '集合竞价') + ' 进行中，' +
        fmtLeft(day.phaseLeftMs) + '后开盘。</div>';
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
    bar.querySelectorAll('button').forEach((b) => {
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
    let price = num(m.last);
    let qty = lot;

    const html =
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
        '<button class="chip" data-px="last">最新</button>' +
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
          let v = num(m.last);
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

  GS.viewStock = { open, close, redraw: draw, get stockId() { return state.stockId; } };
})(window.GS);
