/* ==========================================================================
   chart.js — 画布层：迷你走势 / 分时（含成交量）/ 日 K 蜡烛
   全部用 Canvas 2D，自己按 devicePixelRatio 放大，保证真机不模糊
   ========================================================================== */
(function (GS) {
  'use strict';

  const C = {
    grid: 'rgba(255,255,255,0.055)',
    axis: 'rgba(255,255,255,0.12)',
    txt: '#66717f',
    up: '#ff4d5e',
    down: '#17c08a',
    line: '#48c6ef',
    gold: '#ffc94a',
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
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
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

  /* ---------------------------------------------------------------- 分时 */

  /**
   * 分时图（上 72% 价格 + 下 24% 成交量）。
   * @param {HTMLCanvasElement} canvas
   * @param {{pts:Array, prevClose:number, cursor:number, from:number, to:number}} o
   * @returns {{points:Array<{x:number,y:number}>, hit:Function}}
   */
  function minute(canvas, o) {
    const { ctx, w, h } = prep(canvas);
    const pts = o.pts || [];
    const priceH = h * 0.7;
    const volTop = h * 0.78;
    const volH = h * 0.16;
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
    let vmax = 1;
    pts.forEach((p) => {
      const v = +p.price;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      const vol = +p.vol || 0;
      if (vol > vmax) vmax = vol;
    });
    // 上下留 8% 余量，并把基准价包进来（否则横盘时基准线会飘到框外）
    const span = Math.max(hi - lo, base * 0.004, 0.02);
    lo = Math.min(lo, base) - span * 0.18;
    hi = Math.max(hi, base) + span * 0.18;

    // 时间轴：优先用交易日窗口，没有就按点数均分
    const t0 = o.from || pts[0].t;
    const t1 = o.to || pts[pts.length - 1].t;
    const spanT = Math.max(1, t1 - t0);
    const X = (t) => ((t - t0) / spanT) * w;
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
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, yb);
    ctx.lineTo(w, yb);
    ctx.stroke();
    ctx.setLineDash([]);

    const up = +pts[pts.length - 1].price >= base;
    const main = up ? C.up : C.down;

    // 面积渐变
    const g = ctx.createLinearGradient(0, 0, 0, priceH);
    g.addColorStop(0, up ? 'rgba(255,77,94,0.30)' : 'rgba(23,192,138,0.30)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(X(pts[0].t), priceH);
    pts.forEach((p) => ctx.lineTo(X(p.t), Y(+p.price)));
    ctx.lineTo(X(pts[pts.length - 1].t), priceH);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();

    // 折线
    ctx.beginPath();
    pts.forEach((p, i) => {
      const px = X(p.t);
      const py = Y(+p.price);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.strokeStyle = main;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // 成交量柱
    const bw = Math.max(1, w / Math.max(pts.length, 30) - 0.6);
    pts.forEach((p, i) => {
      const vol = +p.vol || 0;
      if (!vol) return;
      const bh = Math.max(1, (vol / vmax) * volH);
      const prev = i ? +pts[i - 1].price : +p.price;
      ctx.fillStyle = +p.price >= prev ? 'rgba(255,77,94,0.55)' : 'rgba(23,192,138,0.55)';
      ctx.fillRect(X(p.t) - bw / 2, volTop + volH - bh, bw, bh);
    });

    // 右侧价格刻度
    ctx.fillStyle = C.txt;
    ctx.textAlign = 'right';
    ctx.fillText(hi.toFixed(2), w - 2, 11);
    ctx.fillText(lo.toFixed(2), w - 2, priceH - 3);

    // 十字光标
    const points = pts.map((p) => ({ x: X(p.t), y: Y(+p.price), t: p.t, price: +p.price, vol: +p.vol || 0 }));
    let hitIdx = -1;
    if (o.cursor >= 0 && o.cursor < points.length) {
      hitIdx = o.cursor;
      const pt = points[hitIdx];
      ctx.strokeStyle = 'rgba(255,255,255,0.42)';
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

    return { points, hit, priceH, volTop };
  }

  /* -------------------------------------------------------------- 日 K */

  /**
   * 日 K 蜡烛图（上 74% 蜡烛 + 下 16% 成交量）
   * @param {{bars:Array, cursor:number}} o bars: [{open,high,low,close,volume}]
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
    const view = bars.slice(Math.max(0, bars.length - maxBars));

    const priceH = h * 0.72;
    const volTop = h * 0.8;
    const volH = h * 0.14;

    let lo = Infinity;
    let hi = -Infinity;
    let vmax = 1;
    view.forEach((b) => {
      lo = Math.min(lo, +b.low);
      hi = Math.max(hi, +b.high);
      vmax = Math.max(vmax, +b.volume || 0);
    });
    const span = Math.max(hi - lo, 0.02);
    lo -= span * 0.06;
    hi += span * 0.06;

    const step = w / view.length;
    const bw = Math.max(1.5, step * 0.62);
    const Y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (priceH - 12);

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
      const cx = step * (i + 0.5);
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
      ctx.fillStyle = red ? 'rgba(255,77,94,0.5)' : 'rgba(23,192,138,0.5)';
      ctx.fillRect(cx - bw / 2, volTop + volH - bh, bw, bh);
    });

    ctx.fillStyle = C.txt;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(hi.toFixed(2), w - 2, 11);
    ctx.fillText(lo.toFixed(2), w - 2, priceH - 3);

    const points = view.map((b, i) => ({
      x: step * (i + 0.5),
      y: Y((+b.high + +b.low) / 2),
      bar: b,
    }));

    if (o.cursor >= 0 && o.cursor < points.length) {
      const pt = points[o.cursor];
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
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

    return { points, hit, view };
  }

  GS.chart = { spark, minute, daily, prep };
})(window.GS);
