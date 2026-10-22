/* ==========================================================================
   view-news.js — 「消息」tab：消息磁带 + 泄露期异动提示 + 新消息提醒
   与网页端消息 tab 同一口径：news / newsHints / lastNews 都在 state 帧里，
   服务端零接口改动。过滤：全部 / 大盘 / 个股；从个股页进来时多一档「本股」
   （= 大盘 + 本股，网页端「当前股票」同口径）。
   三个渲染面共用 renderHints / renderRows：消息 tab、首页「最新消息」卡、个股页消息卡。
   CSP 同规：生成的 HTML 里不写内联 style 属性。
   ========================================================================== */
(function (GS) {
  'use strict';

  const { esc, fmtTime, num, $, on } = GS.core;

  let built = false;
  /** 过滤：all=全部 index=只大盘 stock=只个股 active=大盘+本股 */
  let filter = 'all';
  /** active 档的「本股」；空 = 不在个股上下文 */
  let focusStock = '';
  /** lastNews.id 已见水位（首帧只登记不提醒） */
  let lastNewsSeen = null;
  let unread = 0;

  /* ---------------------------------------------------------------- 过滤 */

  /** 过滤档：个股上下文时给「本股」打头（网页端「当前股票」同口径） */
  function chips() {
    if (!focusStock) {
      return [['all', '全部'], ['index', '大盘'], ['stock', '个股']];
    }
    const nm = GS.core.stockName(focusStock);
    return [
      ['active', '本股·' + (nm || focusStock)],
      ['all', '全部'],
      ['index', '大盘'],
    ];
  }

  function selectItems(items, opt) {
    const f = (opt && opt.filter) || 'all';
    const sid = (opt && opt.stockId) || '';
    if (f === 'index') return items.filter((n) => !n.stockId);
    if (f === 'stock') return items.filter((n) => !!n.stockId);
    if (f === 'active') return items.filter((n) => !n.stockId || n.stockId === sid);
    return items;
  }

  function selectHints(hints, opt) {
    const f = (opt && opt.filter) || 'all';
    const sid = (opt && opt.stockId) || '';
    if (f === 'index') return [];
    if (f === 'active') return hints.filter((h) => h.stockId === sid);
    return hints;
  }

  /* ---------------------------------------------------------------- 行 html */

  function rowHtml(n, opt) {
    const klass =
      'n-row' + (n.dir > 0 ? ' npos' : n.dir < 0 ? ' nneg' : '') + (n.early ? ' nearly' : '');
    const tags = [];
    if (n.session && n.session !== '盘中') {
      tags.push('<span class="n-sess">' + esc(n.session) + '</span>');
    }
    if (n.early) {
      tags.push('<span class="n-early">' + (n.masked ? '未公开' : '提前') + '</span>');
    }
    const nav = opt && opt.noNav ? '' : n.stockId ? ' data-stock="' + esc(n.stockId) + '"' : '';
    return (
      '<div class="' + klass + '"' + nav + '>' +
        '<div class="n-top">' +
          '<span class="n-type">' + esc(n.type || '消息') + '</span>' +
          (n.stockId
            ? '<span class="n-stock">' + esc(n.stockName || n.stockId) + '</span>'
            : '<span class="n-stock idx">大盘</span>') +
          tags.join('') +
          '<span class="n-time num">' + fmtTime(n.t) + '</span>' +
        '</div>' +
        '<div class="n-text">' + esc(n.text) + '</div>' +
      '</div>'
    );
  }

  function hintHtml(h, opt) {
    const nav = opt && opt.noNav ? '' : h.stockId ? ' data-stock="' + esc(h.stockId) + '"' : '';
    return (
      '<div class="n-hint"' + nav + '>' +
        '<span class="n-hint-icon">⚡</span>' +
        '<div class="n-hint-text">' + esc(h.text) + '</div>' +
        '<span class="n-hint-time num">距公开约 ' +
          Math.max(0, Math.round(num(h.leftMs) / 1000)) + ' 秒</span>' +
      '</div>'
    );
  }

  /* -------------------------------------------------------- 共用渲染口 */

  /** 异动提示（泄露期模糊提示，§7.2）。条数少，每帧直接重建 */
  function renderHints(el, opt) {
    if (!el) return;
    const st = GS.core.S.state;
    const hints = selectHints((st && st.newsHints) || [], opt || {});
    el.innerHTML = hints.map((h) => hintHtml(h, opt)).join('');
  }

  /**
   * 消息行。内容签名（id+形态）变了才重建——tapeSnapshot 里 masked 条目公开后
   * 同 id 内容会变（未明→真方向），所以签名要把 early/masked 也算进去。
   * opt.noNav：行不带 data-stock（个股页消息卡里点行不该再叠开一层个股页）。
   */
  function renderRows(el, opt) {
    if (!el) return;
    const st = GS.core.S.state;
    const o = opt || {};
    const items = selectItems((st && st.news) || [], o);
    const rows = o.limit ? items.slice(0, o.limit) : items;
    // 签名带上过滤参数：切档后即使行内容巧合相同也要重建
    const sig =
      (o.filter || 'all') + '|' + (o.stockId || '') + '|' + (o.limit || 0) + '|' +
      rows
        .map((n) => n.id + (n.type || '') + (n.early ? 'e' : '') + (n.masked ? 'm' : ''))
        .join(',');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML =
      rows.map((n) => rowHtml(n, o)).join('') || '<div class="empty">暂无消息</div>';
  }

  /* ------------------------------------------------------------ 消息 tab */

  function renderSeg(root) {
    const seg = root.querySelector('#newsSeg');
    if (!seg) return;
    const sig = focusStock + '|' + filter;
    if (seg.dataset.sig === sig) return;
    seg.dataset.sig = sig;
    seg.innerHTML = chips()
      .map(
        (c) =>
          '<button data-nf="' + c[0] + '"' + (c[0] === filter ? ' class="on"' : '') + '>' +
          esc(c[1]) + '</button>'
      )
      .join('');
  }

  function renderPane() {
    renderHints($('newsHints'), { filter: filter, stockId: focusStock });
    renderRows($('newsRows'), { filter: filter, stockId: focusStock });
  }

  function build(root) {
    root.innerHTML =
      '<div class="segment" id="newsSeg"></div>' +
      '<div class="card card-flat">' +
        '<div class="news-list" id="newsHints"></div>' +
        '<div class="news-list" id="newsRows"></div>' +
      '</div>' +
      '<div class="hint">消息驱动行情：利好推公允价、利空压盘。泄露期只有高情报等级的玩家能提前看到，' +
        '「⚡异动提示」是给所有人的公平窗口。</div>';

    on(root, '#newsSeg button', 'click', (e, t) => {
      filter = t.dataset.nf || 'all';
      renderSeg(root);
      renderPane();
    });
    // 点个股行/异动提示进个股详情（大盘行没有 data-stock，不可点）
    on(root, '[data-stock]', 'click', (e, t) => {
      if (t.dataset.stock) GS.viewStock.open(t.dataset.stock);
    });

    built = true;
    renderSeg(root);
    renderPane();
  }

  function update(root) {
    if (!built) build(root);
    renderSeg(root);
    renderPane();
    // 看着消息 tab 时清零未读
    if (unread) {
      unread = 0;
      paintBadge();
    }
  }

  /* ---------------------------------------------------- 新消息提醒 + 角标 */

  function paintBadge() {
    const el = $('newsBadge');
    if (!el) return;
    el.hidden = unread <= 0;
    el.textContent = unread > 99 ? '99+' : String(unread);
  }

  /** 每帧调（main.js 订阅）：lastNews 变了就提醒 */
  function onFrame(st) {
    const n = st && st.lastNews;
    if (!n || !n.id) return;
    if (lastNewsSeen === null) {
      lastNewsSeen = n.id;
      return;
    }
    if (n.id === lastNewsSeen) return;
    lastNewsSeen = n.id;
    // toast 照弹（网页端同口径）；正在看消息 tab 时只提醒、不计未读
    const tag = n.stockName ? n.stockName + ' · ' : '大盘 · ';
    GS.core.toast(
      '【' + tag + (n.type || '消息') + '】' + n.text,
      n.dir > 0 ? 'err' : n.dir < 0 ? 'ok' : 'gold'
    );
    if (GS.core.S.tab === 'news') return;
    unread += 1;
    paintBadge();
  }

  /* ---------------------------------------------------------------- 入口 */

  /**
   * 打开消息 tab。个股页「更多」带 stockId 进来时，过滤默认「本股」
   * （= 大盘 + 本股，网页端「当前股票」同口径）；压着的二级页先收掉。
   */
  function open(opt) {
    const o = opt || {};
    focusStock = o.stockId || '';
    filter = o.filter || (focusStock ? 'active' : 'all');
    if (GS.core.S.page) GS.core.closePage();
    if (GS.app && GS.app.switchTo) GS.app.switchTo('news');
  }

  /** 从 tabbar 直接进消息 tab：清掉个股上下文，回默认「全部」 */
  function resetContext() {
    focusStock = '';
    filter = 'all';
  }

  GS.viewNews = {
    id: 'news',
    title: '消息',
    update,
    open,
    resetContext,
    onFrame,
    renderHints,
    renderRows,
    paintBadge,
  };
})(window.GS);
