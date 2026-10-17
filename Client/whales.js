/**
 * AI 主力观测页（仅白名单账号：服务端写死 chu）。
 * 会话令牌从 localStorage `gushen_token` 读，与交易端同源共享。
 */
(function () {
  const listEl = document.getElementById('list');
  const metaEl = document.getElementById('meta');
  const deniedEl = document.getElementById('denied');
  const refreshBtn = document.getElementById('refreshBtn');

  function token() {
    try {
      return localStorage.getItem('gushen_token') || '';
    } catch {
      return '';
    }
  }

  function money(n) {
    return Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }

  function pct(n) {
    return ((Number(n) || 0) * 100).toFixed(2) + '%';
  }

  function render(data) {
    metaEl.textContent =
      `第 ${data.day} 交易日 · ${data.phaseLabel || data.phase} · ` +
      `LLM ${data.llmEnabled ? '开' : '关'} · ${new Date(data.t).toLocaleTimeString('zh-CN')}`;
    listEl.innerHTML = '';
    for (const w of data.whales || []) {
      const card = document.createElement('section');
      card.className = 'whale-card';
      card.innerHTML = `
        <div class="whale-top">
          <div class="whale-name">${esc(w.label || w.account)}<span class="ai-chip">AI</span></div>
          <div class="whale-kv">账号<b>${esc(w.account)}</b></div>
          <div class="whale-kv">权益<b>${money(w.equity)}</b></div>
          <div class="whale-kv">现金<b>${money(w.cash)}</b></div>
          <div class="whale-kv">已实现<b>${money(w.realizedPnL)}</b></div>
          <div class="whale-kv">风险度<b>${pct(w.marginUsage)}</b></div>
        </div>
      `;
      if (!w.positions || !w.positions.length) {
        card.appendChild(el('div', 'empty', '当前空仓'));
      } else {
        const t = document.createElement('table');
        t.className = 'whale-table';
        t.innerHTML =
          '<thead><tr><th>股票</th><th>现价</th><th>多头</th><th>成本</th><th>多头盈亏</th><th>空头</th><th>空头盈亏</th></tr></thead>';
        const tb = document.createElement('tbody');
        for (const p of w.positions) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${esc(p.stockName)}</td>
            <td>${money(p.last)}</td>
            <td>${p.longQty || 0}</td>
            <td>${p.longCost == null ? '--' : money(p.longCost)}</td>
            <td>${money(p.longPnl)}</td>
            <td>${p.shortQty || 0}</td>
            <td>${money(p.shortPnl)}</td>
          `;
          tb.appendChild(tr);
        }
        t.appendChild(tb);
        card.appendChild(t);
      }
      if (w.orders && w.orders.length) {
        const tip = el('div', 'empty', `在途委托 ${w.orders.length} 笔：` +
          w.orders.map((o) => `${o.stockName} ${o.action} ${o.qty}@${o.price}`).join('；'));
        card.appendChild(tip);
      }
      listEl.appendChild(card);
    }
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    n.textContent = text || '';
    return n;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  async function load() {
    const t = token();
    if (!t) {
      deniedEl.hidden = false;
      listEl.innerHTML = '';
      metaEl.textContent = '未登录';
      return;
    }
    metaEl.textContent = '读取中…';
    try {
      const res = await fetch('/api/whales', {
        headers: { Authorization: 'Bearer ' + t },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        deniedEl.hidden = false;
        listEl.innerHTML = '';
        metaEl.textContent = data.error || '无权查看';
        return;
      }
      deniedEl.hidden = true;
      render(data);
    } catch (e) {
      metaEl.textContent = '加载失败：' + (e && e.message ? e.message : e);
    }
  }

  refreshBtn.addEventListener('click', load);
  load();
  setInterval(load, 15000);
})();
