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
    lastDraw: 0,
  };

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

  function skeleton(m) {
    const shareBtn = m
      ? '<button class="icon-btn" id="stockShare" aria-label="分享">' + GS.core.icon('share') + '</button>'
      : '';
    return (
      GS.core.pageHead(m ? m.name : '个股', m ? m.stockId : '', shareBtn) +
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
              '<button data-mode="week">周K</button>' +
              '<button data-mode="month">月K</button>' +
            '</div>' +
            '<div class="chart-wrap" id="chartWrap">' +
              '<canvas id="chartCanvas"></canvas>' +
              '<div class="chart-tip" id="chartTip" hidden></div>' +
            '</div>' +
            '<div class="dm-send">' +
              '<input id="dmInput" maxlength="60" placeholder="发条弹幕…" enterkeyhint="send">' +
              '<button class="mini-btn" id="dmSend">发送</button>' +
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
    state.barsDay = 0;
    state.dmSeen.clear();

    const m = GS.core.market(state.stockId);
    const ctl = GS.core.openPage({
      html: skeleton(m),
      onMount(el) {
        GS.core.bindPageBack(el.el);
        // 分享当前个股行情（头部右上角）
        GS.core.on(el.el, '#stockShare', 'click', () => GS.share.stockText(state.stockId));
        bindTabs(el.el);
        bindChartTouch(el.el);
        bindAct(el.el);
        bindDanmakuSend(el.el);
        draw();
      },
    });

    // 拉分时 + 日线（日线按需）
    GS.api.loadHistory(state.stockId).then(() => draw());
    if (state.unsub) state.unsub();
    state.unsub = GS.core.subscribe(() => {
      tick();
    });
    // 弹幕观看心跳（60s 一次，与网页版同口径）：没有它 watcher 过期后，
    // 这只票就不再生成 NPC 弹幕——纯 App 玩家盯的票会整场冷清
    const watchTick = () => {
      GS.api
        .getJSON('/api/danmaku/watch?stock=' + encodeURIComponent(state.stockId))
        .catch(() => {});
    };
    watchTick();
    state.dmWatchTimer = setInterval(watchTick, 60000);
    const prevClose = ctl.onClose;
    ctl.onClose = () => {
      if (state.unsub) state.unsub();
      state.unsub = null;
      if (state.dmWatchTimer) {
        clearInterval(state.dmWatchTimer);
        state.dmWatchTimer = null;
      }
      if (prevClose) prevClose();
    };
    return ctl;
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

  /** 分时点的时间文案：游戏内时刻（跨天补「N日」前缀），没有交易日时钟时退回墙钟 */
  function minuteTimeLabel(t, withSec) {
    const g = clockAtAxis(axisCoord(t));
    if (!g) return withSec ? fmtTime(t) : fmtHM(t);
    const hm = GS.core.fmtHM(g.ms);
    const hms = withSec
      ? hm + ':' + String(Math.floor((g.ms % 60000) / 1000)).padStart(2, '0')
      : hm;
    const d = dayInfo();
    return d && g.day !== d.day ? g.day + '日 ' + hms : hms;
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
    if (!c) return GS.core.fmtHM(a); // 没有阶段表：a 就是墙钟
    const hm = c.seam != null
      ? GS.core.fmtHM(c.seam) + '/' + GS.core.fmtHM(c.ms)
      : GS.core.fmtHM(c.ms);
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
      const from = state.mode === '5d' ? num(d.dayStartAt) - dayMs * 4 : num(d.dayStartAt);
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
        const days = state.mode === '5d' ? 5 : 1;
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

  GS.viewStock = {
    open, close, redraw: draw,
    get stockId() { return state.stockId; },
    // K 线视窗只读出口（验收脚本用；与网页版导出 klineView 同一个意图）
    get kviews() { return kViews; },
  };
})(window.GS);
