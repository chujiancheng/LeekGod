/* ==========================================================================
   view-trade.js — 「交易」页：资产总览 + 持仓 / 委托 / 成交
   ========================================================================== */
(function (GS) {
  'use strict';

  const {
    $, esc, fmtP, fmtPct, fmtQty, fmtAmt, fmtTime, fmtLeft, cls, num,
  } = GS.core;

  const ACTION_LABEL = {
    buy_open: '买入开多',
    sell_close: '卖出平多',
    sell_open: '卖出开空',
    buy_close: '买入平空',
  };
  const STATUS_LABEL = { live: '挂单中', filled: '已成交', canceled: '已撤单', partial: '部分成交' };

  let tab = 'pos';
  let built = false;

  function build(root) {
    root.innerHTML =
      '<div class="asset-hero">' +
        '<div class="asset-label">总资产（元）</div>' +
        '<div class="asset-value num" id="asEquity">—</div>' +
        '<div class="asset-pnl num" id="asPnl">—</div>' +
        '<button class="mini-btn share-fab" id="asShare">晒战绩</button>' +
        '<div class="stat-grid">' +
          '<div class="stat-cell"><span>可用</span><b class="num" id="asCash">—</b></div>' +
          '<div class="stat-cell"><span>冻结</span><b class="num" id="asFrozen">—</b></div>' +
          '<div class="stat-cell"><span>多头</span><b class="num" id="asLong">—</b></div>' +
          '<div class="stat-cell"><span>空头</span><b class="num" id="asShort">—</b></div>' +
        '</div>' +
      '</div>' +
      '<div class="segment" id="tradeSeg">' +
        '<button data-tab="pos" class="on">持仓</button>' +
        '<button data-tab="order">委托<span id="ordBadge"></span></button>' +
        '<button data-tab="trade">成交</button>' +
      '</div>' +
      '<div class="card card-flat" id="tradeList"></div>' +
      '<div id="tradeFoot"></div>';

    GS.core.on(root, '#tradeSeg button', 'click', (e, t) => {
      tab = t.dataset.tab;
      root.querySelectorAll('#tradeSeg button').forEach((b) => b.classList.toggle('on', b === t));
      renderList();
    });

    // 晒战绩：canvas 生成战绩卡 → 系统分享面板（App 内）/ 下载（浏览器）
    GS.core.on(root, '#asShare', 'click', () => GS.share.shareStatCard());

    GS.core.on(root, '[data-goto]', 'click', (e, t) => {
      if (t.dataset.goto === 'deposit') GS.viewMe.openDeposit();
      else GS.viewStock.open(t.dataset.goto);
    });

    GS.core.on(root, '[data-cancel]', 'click', (e, t) => {
      e.stopPropagation();
      const id = t.dataset.cancel;
      t.disabled = true;
      GS.api.api
        .cancel(id)
        .then((r) => GS.core.toast(r && r.ok ? '已撤单' : (r && r.error) || '撤单失败', r && r.ok ? 'ok' : 'err'))
        .catch(() => GS.core.toast('网络异常', 'err'));
    });

    built = true;
  }

  /* ---------------------------------------------------------------- 更新 */

  function update(root) {
    if (!built || !root.childElementCount) build(root);
    const st = GS.core.S.state;
    if (!st || !st.account) return;
    const a = st.account;

    const set = (id, v, klass) => {
      const el = $(id);
      if (!el) return;
      el.textContent = v;
      if (klass) el.className = klass;
    };
    // 浮动盈亏 = 多头 + 空头（已实现盈亏不重复计）
    const float = num(a.longPnl) + num(a.shortPnl);
    set('asEquity', '¥' + num(a.equity).toLocaleString('zh-CN', { maximumFractionDigits: 2 }),
      'asset-value num ' + cls(a.equity - num(st.rules && st.rules.initialCash)));
    set('asPnl', '浮动盈亏 ' + (float >= 0 ? '+' : '') + fmtAmt(float) +
      (a.financeDebt ? ' · 融资负债 ' + fmtAmt(a.financeDebt) : ''),
      'asset-pnl num ' + cls(float));
    set('asCash', fmtAmt(a.cash));
    set('asFrozen', fmtAmt(a.orderFrozen));
    set('asLong', fmtAmt(a.longValue));
    set('asShort', fmtAmt(a.shortValue));

    const badge = $('ordBadge');
    if (badge) {
      const n = (a.orders || []).length;
      badge.textContent = n ? String(n) : '';
      badge.className = n ? 'tab-badge' : '';
    }

    renderList();
  }

  function renderList() {
    const box = $('tradeList');
    if (!box) return;
    const st = GS.core.S.state;
    const a = st && st.account;
    if (!a) {
      box.innerHTML = '<div class="empty">未登录</div>';
      return;
    }

    if (tab === 'pos') {
      const rows = (a.positions || []).filter((p) => p.long.qty || p.short.qty);
      if (!rows.length) {
        box.innerHTML =
          '<div class="empty"><div class="empty-icon">📭</div>还没有持仓<br>' +
          '<span class="hint">去行情页挑一只，先来一手</span></div>';
        return;
      }
      box.innerHTML = rows
        .map((p) => {
          const lq = num(p.long && p.long.qty);
          const sq = num(p.short && p.short.qty);
          const pnl = num(p.long && p.long.pnl) + num(p.short && p.short.pnl);
          const cost = lq ? num(p.long.cost) / lq : num(p.last);
          return (
            '<div class="list-row" data-goto="' + esc(p.stockId) + '">' +
              '<div class="list-main">' +
                '<div class="list-t1">' + esc(p.name || p.stockId) + '</div>' +
                '<div class="list-t2">' +
                  (lq ? '多 ' + fmtQty(lq) + ' 股' : '') +
                  (lq && sq ? ' · ' : '') +
                  (sq ? '空 ' + fmtQty(sq) + ' 股' : '') +
                  ' · 成本 ' + fmtP(cost) +
                '</div>' +
              '</div>' +
              '<div class="list-right">' +
                '<div class="list-v1">' + fmtP(p.last) + '</div>' +
                '<div class="list-v2 ' + cls(pnl) + '">' +
                  (pnl >= 0 ? '+' : '') + fmtAmt(pnl) + '（' +
                  (num(p.long && p.long.value) + num(p.short && p.short.value) > 0
                    ? fmtPct((pnl / Math.max(1, num(p.long.cost) + num(p.short.cost))) * 100)
                    : '0.00%') + '）' +
                '</div>' +
              '</div>' +
            '</div>'
          );
        })
        .join('');
      return;
    }

    if (tab === 'order') {
      const live = a.orders || [];
      const liveIds = new Set(live.map((o) => o.id));
      const list = (a.orderHistory || [])
        .filter((o) => liveIds.has(o.id) || o.status !== 'live')
        .slice(0, 50);
      if (!list.length) {
        box.innerHTML = '<div class="empty"><div class="empty-icon">📄</div>暂无委托</div>';
        return;
      }
      box.innerHTML = list
        .map((o) => {
          const isLive = liveIds.has(o.id);
          return (
            '<div class="list-row">' +
              '<div class="list-main">' +
                '<div class="list-t1">' + esc(GS.core.stockName(o.stockId)) +
                  ' <span class="tag ' + (isLive ? 'tag-gold' : '') + '">' +
                  (isLive ? '挂单中' : esc(STATUS_LABEL[o.status] || o.status || '')) + '</span></div>' +
                '<div class="list-t2">' + fmtTime(o.ts) + ' · ' +
                  esc(ACTION_LABEL[o.action] || o.action) + ' · ' + fmtP(o.price) + ' × ' +
                  fmtQty(o.qty) + '</div>' +
              '</div>' +
              '<div class="list-right">' +
                (isLive
                  ? '<button class="mini-btn" data-cancel="' + esc(o.id) + '">撤单</button>'
                  : '<div class="list-v2">成交 ' + fmtQty(o.filled) + '</div>') +
              '</div>' +
            '</div>'
          );
        })
        .join('');
      return;
    }

    // 成交
    const trades = (a.trades || []).slice(0, 50);
    if (!trades.length) {
      box.innerHTML = '<div class="empty"><div class="empty-icon">🧾</div>暂无成交</div>';
      return;
    }
    box.innerHTML = trades
      .map((t) => {
        const dir = t.action === 'buy_open' || t.action === 'buy_close' ? 'up' : 'down';
        return (
          '<div class="list-row" data-goto="' + esc(t.stockId) + '">' +
            '<div class="list-main">' +
              '<div class="list-t1">' + esc(GS.core.stockName(t.stockId)) + '</div>' +
              '<div class="list-t2">' + fmtTime(t.ts) + ' · ' +
                esc(ACTION_LABEL[t.action] || t.action) + '</div>' +
            '</div>' +
            '<div class="list-right">' +
              '<div class="list-v1 ' + dir + '">' + fmtP(t.price) + '</div>' +
              '<div class="list-v2">' + fmtQty(t.qty) + ' 股</div>' +
            '</div>' +
          '</div>'
        );
      })
      .join('');
  }

  GS.viewTrade = {
    id: 'trade',
    title: '交易',
    update,
    reset() {
      built = false;
    },
  };
})(window.GS);
