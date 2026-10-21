/* ==========================================================================
   chart.js — 画布层：迷你走势 / 分时（含成交量）/ 日 K 蜡烛
   全部用 Canvas 2D，自己按 devicePixelRatio 放大，保证真机不模糊
   ========================================================================== */
(function (GS) {
  'use strict';

  const C = {
    grid: 'rgba(20,30,48,0.07)',
    axis: 'rgba(20,30,48,0.12)',
    txt: '#99a2ad',
    up: '#e8413c',
    down: '#0aa06e',
    line: '#3c7cff',
    avg: '#f0a020',
    gold: '#dd9520',
  };

  /** 按像素比准备画布，返回 2d 上下文与逻辑尺寸 */
  function prep(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
    const h = canvas.clientHeight || canvas.parentElement.clientHeight || 160;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  /* ------------------------------------------------------------ 迷你走势 */

  function spark(canvas, pts, prevClose) {
    const { ctx, w, h } = prep(canvas);
    if (!pts || pts.length < 2) return;
    const ys = pts.map((p) => +p.price);
    let lo = Math.min.apply(null, ys);
    let hi = Math.max.apply(null, ys);
    const base = prevClose || ys[0];
    lo = Math.min(lo, base);
    hi = Math.max(hi, base);
    if (hi - lo < 0.01) {
      hi += 0.5;
      lo -= 0.5;
    }
    const pad = 3;
    const x = (i) => (i / (pts.length - 1)) * w;
    const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2);

    const up = ys[ys.length - 1] >= base;
    const color = up ? C.up : C.down;

    // 基准虚线
    ctx.strokeStyle = 'rgba(20,30,48,0.18)';
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y(base));
    ctx.lineTo(w, y(base));
    ctx.stroke();
    ctx.setLineDash([]);

    // 面积
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, up ? 'rgba(255,77,94,0.28)' : 'rgba(23,192,138,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(0, h);
    pts.forEach((p, i) => ctx.lineTo(x(i), y(+p.price)));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();

    // 折线
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(i), y(+p.price)) : ctx.moveTo(x(i), y(+p.price))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /* ---------------------------------------------------------- MACD 计算 */

  // 预热门槛（网页版同口径）：DIF=EMA12−EMA26、DEA 再套 EMA9，不足 35 根时数值
  // 只是「从第一根开始推」的初始化残差，图上要标「未预热」而不是让它冒充指标
  const MACD_MIN_BARS = 35;

  /**
   * MACD(12,26,9)：DIF=EMA12−EMA26，DEA=DIF 的 EMA9，柱=2×(DIF−DEA)。
   * pts 每项带 price；返回 {dif, dea, hist} 三条与 pts 等长的数组。
   */
  function computeMacd(pts, fast, slow, sig) {
    fast = fast || 12;
    slow = slow || 26;
    sig = sig || 9;
    const n = pts.length;
    const dif = new Array(n);
    const dea = new Array(n);
    const hist = new Array(n);
    if (!n) return { dif, dea, hist };
    const kf = 2 / (fast + 1);
    const ks = 2 / (slow + 1);
    const kd = 2 / (sig + 1);
    let ef = +pts[0].price;
    let es = ef;
    for (let i = 0; i < n; i += 1) {
      const p = +pts[i].price;
      if (i > 0) {
        ef = kf * p + (1 - kf) * ef;
        es = ks * p + (1 - ks) * es;
      }
      dif[i] = ef - es;
      dea[i] = i === 0 ? dif[0] : kd * dif[i] + (1 - kd) * dea[i - 1];
      hist[i] = 2 * (dif[i] - dea[i]);
    }
    return { dif, dea, hist };
  }

  // 分时重绘时刷新缓存：光标一动就全量重算 EMA 太浪费（一条序列可到 10300 点）。
  // 缓存键带上调用方给的标识（stockId+视图模式）与序列长度/末点时间，任一变了就重算
  const macdCache = { key: '', n: -1, lastT: 0, arr: null };
  function macdOf(key, pts) {
    const lastT = pts.length ? +pts[pts.length - 1].t : 0;
    if (macdCache.key !== key || macdCache.n !== pts.length || macdCache.lastT !== lastT) {
      macdCache.key = key;
      macdCache.n = pts.length;
      macdCache.lastT = lastT;
      macdCache.arr = computeMacd(pts);
    }
    return macdCache.arr;
  }

  /**
   * 在 MACD 带里画柱 + DIF/DEA 双线。scale 只取窗口内极值（否则会被窗口外
   * 历史峰值压成平线），from/to 是 [start, end) 下标。
   */
  function drawMacdBand(ctx, macd, from, to, macdTop, macdH, bw, xAt, warn) {
    let mAbs = 1e-9;
    for (let i = from; i < to; i += 1) {
      mAbs = Math.max(mAbs, Math.abs(macd.dif[i]), Math.abs(macd.dea[i]), Math.abs(macd.hist[i]));
    }
    const mMid = macdTop + macdH / 2;
    const mY = (v) => mMid - (v / mAbs) * (macdH / 2 - 6);

    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mMid);
    ctx.lineTo(ctx.canvas.clientWidth, mMid);
    ctx.stroke();

    for (let i = from; i < to; i += 1) {
      const bh = (Math.abs(macd.hist[i]) / mAbs) * (macdH / 2 - 6);
      if (bh < 0.4) continue;
      ctx.fillStyle = macd.hist[i] > 0 ? 'rgba(232,65,60,0.85)' : 'rgba(10,160,110,0.85)';
      ctx.fillRect(xAt(i) - bw / 2, macd.hist[i] > 0 ? mMid - bh : mMid, bw, bh);
    }

    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = from; i < to; i += 1) {
      const px = xAt(i);
      const py = mY(macd.dif[i]);
      if (i === from) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = C.gold;
    ctx.stroke();
    ctx.beginPath();
    for (let i = from; i < to; i += 1) {
      const px = xAt(i);
      const py = mY(macd.dea[i]);
      if (i === from) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = C.line;
    ctx.stroke();

    // 图例（标在带左上角）：根数不足预热门槛时报「未预热」不报数值
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.txt;
    ctx.fillText('MACD(12,26,9)', 3, macdTop + 8);
    if (warn) {
      ctx.fillText('未预热', 3 + ctx.measureText('MACD(12,26,9)').width + 8, macdTop + 8);
    } else {
      const last = to - 1;
      let lx = 3 + ctx.measureText('MACD(12,26,9)').width + 8;
      const dTxt = 'DIF ' + (macd.dif[last] || 0).toFixed(3);
      const eTxt = 'DEA ' + (macd.dea[last] || 0).toFixed(3);
      ctx.fillStyle = C.gold;
      ctx.fillText(dTxt, lx, macdTop + 8);
      lx += ctx.measureText(dTxt).width + 8;
      ctx.fillStyle = C.line;
      ctx.fillText(eTxt, lx, macdTop + 8);
    }
  }

  /* ---------------------------------------------------------------- 分时 */

  /**
   * 分时图（价格带 + 成交量带 + MACD 带）。
   * @param {HTMLCanvasElement} canvas
   * @param {{pts:Array, prevClose:number, cursor:number, from:number, to:number, ticks?:Array, macdKey?:string}} o
   *   pts 的每一项可带 `a`（压缩横轴坐标，网页版同口径：休市/开盘竞价压 0 宽）；
   *   from/to 是横轴域（轴坐标）；ticks 是 [{a, label}] 底部时间刻度（可选）；
   *   macdKey 是 MACD 缓存键（stockId+视图模式）。
   * @returns {{points:Array<{x:number,y:number}>, hit:Function}}
   */
  function minute(canvas, o) {
    const { ctx, w, h } = prep(canvas);
    const pts = o.pts || [];
    const tickH = 13;
    const volH = Math.max(22, h * 0.12);
    const macdH = Math.max(30, h * 0.18);
    const priceH = Math.max(60, h - 6 - tickH - volH - macdH - 10);
    const volTop = 6 + priceH + 5;
    const macdTop = volTop + volH + 5;
    const padL = 0;
    const padR = 0;

    if (pts.length < 2) {
      ctx.fillStyle = C.txt;
      ctx.font = '12px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('等待开盘…', w / 2, h / 2);
      return { points: [], hit: () => -1 };
    }

    const base = +o.prevClose || +pts[0].price;
    let lo = Infinity;
    let hi = -Infinity;
    pts.forEach((p) => {
      const v = +p.price;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    });
    // 上下留 8% 余量，并把基准价包进来（否则横盘时基准线会飘到框外）
    const span = Math.max(hi - lo, base * 0.004, 0.02);
    lo = Math.min(lo, base) - span * 0.18;
    hi = Math.max(hi, base) + span * 0.18;

    // 横轴：优先用调用方给的压缩轴域（轴坐标），没有就按点数/墙钟均分
    const ax = (p) => (p.a != null ? +p.a : +p.t);
    const t0 = o.from != null ? +o.from : ax(pts[0]);
    const t1 = o.to != null ? +o.to : ax(pts[pts.length - 1]);
    const spanT = Math.max(1e-6, t1 - t0);
    const X = (p) => ((ax(p) - t0) / spanT) * w;
    const Y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (priceH - 12);

    // 水平网格 3 条
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    for (let i = 0; i <= 2; i += 1) {
      const yy = 6 + ((priceH - 12) * i) / 2;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
    }

    // 基准价线 + 标签
    const yb = Y(base);
    ctx.strokeStyle = 'rgba(20,30,48,0.28)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, yb);
    ctx.lineTo(w, yb);
    ctx.stroke();
    ctx.setLineDash([]);

    // 分时主线固定东财蓝，均价线橙色（按成交量加权的累计均价）
    const main = C.line;
    let sumPV = 0;
    let sumV = 0;
    const avgY = pts.map((p, i) => {
      const v = +p.vol || 0;
      if (v > 0) {
        sumPV += (+p.price) * v;
        sumV += v;
      } else {
        sumPV += +p.price;
        sumV += 1;
      }
      return Y(sumV ? sumPV / sumV : +p.price);
    });

    // 面积渐变
    const g = ctx.createLinearGradient(0, 0, 0, priceH);
    g.addColorStop(0, 'rgba(60,124,255,0.14)');
    g.addColorStop(1, 'rgba(60,124,255,0)');
    ctx.beginPath();
    ctx.moveTo(X(pts[0]), priceH);
    pts.forEach((p) => ctx.lineTo(X(p), Y(+p.price)));
    ctx.lineTo(X(pts[pts.length - 1]), priceH);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();

    // 均价线（橙）
    ctx.beginPath();
    avgY.forEach((py, i) => {
      const px = X(pts[i]);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.strokeStyle = C.avg;
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // 折线（蓝）
    ctx.beginPath();
    pts.forEach((p, i) => {
      const px = X(p);
      const py = Y(+p.price);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.strokeStyle = main;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // 成交量柱：vol 是**累计成交量**，画柱取相邻点差值（网页版同口径）。
    // 日切检测：收盘结算会把当日量归零，直接相减出负差——量回落视为新的一天，
    // 用当日累计量本身作为这一根的增量
    const deltas = [];
    let vmax = 1;
    for (let i = 0; i < pts.length; i += 1) {
      const v = +pts[i].vol || 0;
      const pv = i ? +pts[i - 1].vol || 0 : 0;
      const d = i === 0 ? 0 : v < pv ? v : Math.max(0, v - pv);
      deltas.push(d);
      if (d > vmax) vmax = d;
    }
    // 量柱宽度按轴上实际间距算（压缩轴下开盘时点挤在最左，按「画布宽/点数」会糊成一整块）
    let gapSum = 0;
    let gapN = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const g = X(pts[i]) - X(pts[i - 1]);
      if (g > 0.01) {
        gapSum += g;
        gapN += 1;
      }
    }
    const bw = Math.max(1, Math.min(6, (gapN ? gapSum / gapN : 1) * 0.72));
    for (let i = 1; i < pts.length; i += 1) {
      const bh = (deltas[i] / vmax) * volH;
      if (bh < 0.5) continue;
      const dp = +pts[i].price - +pts[i - 1].price;
      ctx.fillStyle =
        dp > 0 ? 'rgba(232,65,60,0.5)' : dp < 0 ? 'rgba(10,160,110,0.5)' : 'rgba(60,124,255,0.45)';
      ctx.fillRect(X(pts[i]) - bw / 2, volTop + volH - bh, bw, bh);
    }
    // 量带标注：右侧满仓刻度，让柱子有可读的量纲
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = C.txt;
    ctx.fillText(GS.core.fmtQty(vmax), w - 2, volTop + 8);

    // MACD(12,26,9) 带
    const macd = macdOf(o.macdKey || '', pts);
    drawMacdBand(ctx, macd, 0, pts.length, macdTop, macdH, bw,
      (i) => X(pts[i]), pts.length < MACD_MIN_BARS);

    // 底部时间刻度（游戏内时刻，由调用方按压缩轴算好传进来）
    if (Array.isArray(o.ticks) && o.ticks.length) {
      ctx.font = '9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = C.txt;
      o.ticks.forEach((tk) => {
        const xx = ((+tk.a - t0) / spanT) * w;
        const half = ctx.measureText(tk.label).width / 2 + 2;
        if (xx < half || xx > w - half) return;
        ctx.fillText(tk.label, Math.min(Math.max(xx, half), w - half), h - 2);
        ctx.strokeStyle = C.grid;
        ctx.beginPath();
        ctx.moveTo(xx, 0);
        ctx.lineTo(xx, macdTop + macdH);
        ctx.stroke();
      });
    }

    // 四角标注（东财口径）：左上/左下价格，右上/右下涨跌幅，按相对昨收涨红跌绿
    ctx.font = '10px -apple-system, sans-serif';
    const pctOf = (v) => (((v - base) / base) * 100).toFixed(2) + '%';
    ctx.textAlign = 'left';
    ctx.fillStyle = hi >= base ? C.up : C.down;
    ctx.fillText(hi.toFixed(2), 2, 11);
    ctx.fillStyle = lo >= base ? C.up : C.down;
    ctx.fillText(lo.toFixed(2), 2, priceH - 3);
    ctx.textAlign = 'right';
    ctx.fillStyle = hi >= base ? C.up : C.down;
    ctx.fillText(pctOf(hi), w - 2, 11);
    ctx.fillStyle = lo >= base ? C.up : C.down;
    ctx.fillText(pctOf(lo), w - 2, priceH - 3);

    // 十字光标
    const points = pts.map((p) => ({ x: X(p), y: Y(+p.price), t: p.t, price: +p.price, vol: +p.vol || 0 }));
    let hitIdx = -1;
    if (o.cursor >= 0 && o.cursor < points.length) {
      hitIdx = o.cursor;
      const pt = points[hitIdx];
      ctx.strokeStyle = 'rgba(20,30,48,0.42)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pt.x, 0);
      ctx.lineTo(pt.x, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, pt.y);
      ctx.lineTo(w, pt.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = main;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    /** 触摸 x → 最近点下标 */
    function hit(x) {
      if (!points.length) return -1;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < points.length; i += 1) {
        const d = Math.abs(points[i].x - x);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    }

    return { points, hit, priceH, volTop, deltas, macd, macdTop };
  }

  /* -------------------------------------------------------------- 日 K */

  /** K 线均线周期与配色（东财常用口径：MA5 橙 / MA10 蓝 / MA20 紫 / MA60 绿） */
  const MA_DEFS = [
    { n: 5, c: '#f0a020' },
    { n: 10, c: '#3c7cff' },
    { n: 20, c: '#9b59d0' },
    { n: 60, c: '#0aa06e' },
  ];

  /** 收盘价简单均线：与 bars 逐根对齐，不足周期的点为 null（不画） */
  function maOf(bars, n) {
    const out = new Array(bars.length).fill(null);
    let acc = 0;
    for (let i = 0; i < bars.length; i += 1) {
      acc += +bars[i].close || 0;
      if (i >= n) acc -= +bars[i - n].close || 0;
      if (i >= n - 1) out[i] = acc / n;
    }
    return out;
  }

  /**
   * K 线蜡烛图（价格带 + 成交量带 + MACD 带）。
   * bars 支持两种来源：服务端已收盘日线，以及前端用实时行情现拼的当日 bar
   * （b.live = true，与网页版 daySeriesOf 同口径）；周/月线的聚合 bar 带 label。
   * @param {{bars:Array, cursor:number}} o
   */
  function daily(canvas, o) {
    const { ctx, w, h } = prep(canvas);
    const bars = o.bars || [];
    if (bars.length < 2) {
      ctx.fillStyle = C.txt;
      ctx.font = '12px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('数据不足，收盘结算后生成日线', w / 2, h / 2);
      return { points: [], hit: () => -1 };
    }
    // 只画最近 N 根，保证蜡烛宽度可读
    const maxBars = Math.max(20, Math.floor(w / 7));
    const start = Math.max(0, bars.length - maxBars);
    const view = bars.slice(start);

    const tickH = 13;
    const volH = Math.max(20, h * 0.11);
    const macdH = Math.max(28, h * 0.17);
    const priceH = Math.max(60, h - 6 - tickH - volH - macdH - 10);
    const volTop = 6 + priceH + 5;
    const macdTop = volTop + volH + 5;

    // 均线按全量算（要看更早的收盘价才对），画的时候再按窗口取
    const mas = MA_DEFS.map((d) => ({ n: d.n, c: d.c, arr: maOf(bars, d.n) }));

    let lo = Infinity;
    let hi = -Infinity;
    let vmax = 1;
    view.forEach((b) => {
      lo = Math.min(lo, +b.low);
      hi = Math.max(hi, +b.high);
      vmax = Math.max(vmax, +b.volume || 0);
    });
    // 均线落在极值附近时别被裁掉
    mas.forEach((ma) => {
      for (let i = start; i < bars.length; i += 1) {
        const v = ma.arr[i];
        if (v == null) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    });
    const span = Math.max(hi - lo, 0.02);
    lo -= span * 0.06;
    hi += span * 0.06;

    const step = w / view.length;
    const bw = Math.max(1.5, step * 0.62);
    const Y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (priceH - 12);
    const xc = (i) => step * (i - start + 0.5);

    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i += 1) {
      const yy = 6 + ((priceH - 12) * i) / 2;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
    }

    view.forEach((b, i) => {
      const cx = xc(i + start);
      const o1 = +b.open;
      const c1 = +b.close;
      const red = c1 >= o1;
      const color = red ? C.up : C.down;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      // 影线
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, Y(+b.high));
      ctx.lineTo(cx, Y(+b.low));
      ctx.stroke();
      // 实体
      const yo = Y(o1);
      const yc = Y(c1);
      const top = Math.min(yo, yc);
      const hh = Math.max(1.2, Math.abs(yc - yo));
      ctx.fillRect(cx - bw / 2, top, bw, hh);
      // 量
      const bh = Math.max(1, ((+b.volume || 0) / vmax) * volH);
      ctx.fillStyle = red ? 'rgba(232,65,60,0.5)' : 'rgba(10,160,110,0.5)';
      ctx.fillRect(cx - bw / 2, volTop + volH - bh, bw, bh);
    });

    // 均线组
    mas.forEach((ma) => {
      ctx.strokeStyle = ma.c;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (let i = start; i < bars.length; i += 1) {
        const v = ma.arr[i];
        if (v == null) {
          started = false;
          continue;
        }
        const px = xc(i);
        const py = Y(v);
        if (started) ctx.lineTo(px, py);
        else {
          ctx.moveTo(px, py);
          started = true;
        }
      }
      ctx.stroke();
    });

    // MACD(12,26,9)：按全量收盘价现算（EMA 要看历史才对，根数少不值得缓存），
    // 刻度取窗口内极值——否则会被窗口外的历史峰值压成一条平线
    const macd = computeMacd(bars.map((b) => ({ price: +b.close || 0 })));
    drawMacdBand(ctx, macd, start, bars.length, macdTop, macdH, bw, xc, bars.length < MACD_MIN_BARS);

    // 均线图例（左上角一行小字）
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    let lx = 4;
    mas.forEach((ma) => {
      const v = ma.arr[bars.length - 1];
      const txt = 'MA' + ma.n + (v == null ? '' : ' ' + v.toFixed(2));
      ctx.fillStyle = ma.c;
      ctx.fillText(txt, lx, 10);
      lx += ctx.measureText(txt).width + 8;
    });

    // 底部时间刻度（日K 读交易日号，周/月K 读期号 label）
    ctx.fillStyle = C.txt;
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const nTicks = Math.max(2, Math.min(6, Math.floor(w / 90)));
    for (let k = 0; k < nTicks; k += 1) {
      const idx = start + Math.round(((view.length - 1) * k) / Math.max(1, nTicks - 1));
      const b = bars[idx];
      if (!b) continue;
      const label = b.label || (b.day != null ? '第' + b.day + '天' : '');
      const xx = xc(idx);
      const half = ctx.measureText(label).width / 2 + 2;
      ctx.fillText(label, Math.min(Math.max(xx, half), w - half), h - 2);
    }

    ctx.fillStyle = C.txt;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(hi.toFixed(2), w - 2, 22);
    ctx.fillText(lo.toFixed(2), w - 2, priceH - 3);

    const points = view.map((b, i) => ({
      x: step * (i + 0.5),
      y: Y((+b.high + +b.low) / 2),
      bar: b,
    }));

    if (o.cursor >= 0 && o.cursor < points.length) {
      const pt = points[o.cursor];
      ctx.strokeStyle = 'rgba(20,30,48,0.4)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pt.x, 0);
      ctx.lineTo(pt.x, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function hit(x) {
      const idx = Math.floor(x / step);
      return Math.max(0, Math.min(view.length - 1, idx));
    }

    return { points, hit, view, macd, total: bars.length, start };
  }

  GS.chart = { spark, minute, daily, prep, computeMacd, MACD_MIN_BARS };
})(window.GS);
