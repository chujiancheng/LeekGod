/**
 * 成交统计页（/stats.html）：每日玩家/NPC 成交额 + 玩家成交排行。
 * 公开只读接口 /api/stats/turnover，无需会话令牌；数据口径见页脚说明。
 */
(function () {
  const metaEl = document.getElementById('meta');
  const overviewTitle = document.getElementById('overviewTitle');
  const ovPlayer = document.getElementById('ovPlayer');
  const ovNpc = document.getElementById('ovNpc');
  const ovShare = document.getElementById('ovShare');
  const ovFills = document.getElementById('ovFills');
  const daysHint = document.getElementById('daysHint');
  const daysBox = document.getElementById('daysBox');
  const rankTitle = document.getElementById('rankTitle');
  const rankBox = document.getElementById('rankBox');
  const daySelect = document.getElementById('daySelect');
  const refreshBtn = document.getElementById('refreshBtn');

  // 窄屏（≤640px）表格会折成卡片，每个值前面要靠 td[data-label] 显出列名，
  // 列名顺序必须和下面 <thead> 里的一一对应
  const DAY_COLS = ['交易日', '玩家成交额', 'NPC 成交额', '玩家占比', '玩家笔数', 'NPC 笔数'];
  const RANK_COLS = ['排名', '昵称', '成交金额', '买入', '卖出', '笔数'];

  /** 当前排行选中的交易日（'' = 今日实时） */
  let rankDay = '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  /** 金额：大数折算成万/亿， tabular 数字更好对位 */
  function amt(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e8) return '¥' + (n / 1e8).toFixed(2) + '亿';
    if (abs >= 1e4) return '¥' + (n / 1e4).toFixed(2) + '万';
    return '¥' + Math.round(n).toLocaleString('zh-CN');
  }

  function int(n) {
    return (Number(n) || 0).toLocaleString('zh-CN');
  }

  function pctOf(player, npc) {
    const total = (Number(player) || 0) + (Number(npc) || 0);
    if (total <= 0) return '--';
    return ((player / total) * 100).toFixed(1) + '%';
  }

  function tagCells(row, labels) {
    Array.prototype.forEach.call(row.children, (td, i) => {
      if (labels[i]) td.dataset.label = labels[i];
    });
  }

  /** 表格外面套一层横向滚动壳：桌面看不出区别，窄屏时不会把列裁掉 */
  function withScroll(table) {
    const box = document.createElement('div');
    box.className = 'table-scroll';
    box.appendChild(table);
    return box;
  }

  function emptyBox(box, text) {
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = text;
    box.appendChild(d);
  }

  function renderOverview(today) {
    overviewTitle.textContent = today.day >= 1 ? `今日概览 · 第 ${today.day} 交易日` : '今日概览';
    ovPlayer.textContent = amt(today.playerAmt);
    ovNpc.textContent = amt(today.npcAmt);
    ovShare.textContent = pctOf(today.playerAmt, today.npcAmt);
    ovFills.textContent = int((today.playerFills || 0) + (today.npcFills || 0));
  }

  function renderDays(days) {
    daysHint.textContent = days.length ? `最近 ${days.length} 个交易日` : '';
    if (!days.length) {
      emptyBox(daysBox, '还没有收盘定格的数据——收盘结算后每天会多一行（升级当天从今往后起算）。');
      return;
    }
    const t = document.createElement('table');
    t.className = 'whale-table';
    t.innerHTML =
      '<thead><tr><th>交易日</th><th>玩家成交额</th><th>NPC 成交额</th><th>玩家占比</th><th>玩家笔数</th><th>NPC 笔数</th></tr></thead>';
    const tb = document.createElement('tbody');
    for (const d of days) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>第 ${d.day} 日</td>
        <td>${amt(d.playerAmt)}</td>
        <td>${amt(d.npcAmt)}</td>
        <td>${pctOf(d.playerAmt, d.npcAmt)}</td>
        <td>${int(d.playerFills)}</td>
        <td>${int(d.npcFills)}</td>
      `;
      tagCells(tr, DAY_COLS);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    daysBox.innerHTML = '';
    daysBox.appendChild(withScroll(t));
  }

  function renderRanking(day, list) {
    const label = day === '' || day == null ? '今日' : `第 ${day} 日`;
    rankTitle.textContent = `玩家成交排行 · ${label}`;
    if (!list.length) {
      emptyBox(rankBox, day === '' ? '今日还没有玩家成交。' : '该交易日没有玩家成交记录。');
      return;
    }
    const t = document.createElement('table');
    t.className = 'whale-table';
    t.innerHTML =
      '<thead><tr><th>排名</th><th>昵称</th><th>成交金额</th><th>买入</th><th>卖出</th><th>笔数</th></tr></thead>';
    const tb = document.createElement('tbody');
    list.forEach((r, i) => {
      const tr = document.createElement('tr');
      const rankCls = i < 3 ? ` class="rank-${i + 1}"` : '';
      tr.innerHTML = `
        <td${rankCls}>${i + 1}</td>
        <td>${esc(r.nick || r.name)}</td>
        <td>${amt(r.amt)}</td>
        <td>${amt(r.buyAmt)}</td>
        <td>${amt(r.sellAmt)}</td>
        <td>${int(r.fills)}</td>
      `;
      tagCells(tr, RANK_COLS);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    rankBox.innerHTML = '';
    rankBox.appendChild(withScroll(t));
  }

  function renderDayOptions(data) {
    // 选项：今日 + 已收盘的交易日（新→旧）。保留当前选择，不存在时回落到今日
    const cur = rankDay;
    daySelect.innerHTML = '';
    const optToday = document.createElement('option');
    optToday.value = '';
    optToday.textContent = data.today.day >= 1 ? `今日（第 ${data.today.day} 日）` : '今日';
    daySelect.appendChild(optToday);
    for (const d of data.days) {
      const o = document.createElement('option');
      o.value = String(d.day);
      o.textContent = `第 ${d.day} 日`;
      daySelect.appendChild(o);
    }
    const has = [...daySelect.options].some((o) => o.value === cur);
    rankDay = has ? cur : '';
    daySelect.value = rankDay;
  }

  function render(data) {
    metaEl.textContent =
      (data.today.day >= 1 ? `第 ${data.today.day} 交易日 · ` : '') +
      `更新于 ${new Date(data.t).toLocaleTimeString('zh-CN')}`;
    renderOverview(data.today);
    renderDays(data.days || []);
    renderDayOptions(data);
    renderRanking(rankDay, data.ranking || []);
  }

  async function loadRanking() {
    const qs = rankDay === '' ? '' : '?day=' + encodeURIComponent(rankDay);
    const res = await fetch('/api/stats/turnover' + qs);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || '读取失败');
    renderRanking(rankDay, data.ranking || []);
  }

  async function load() {
    metaEl.textContent = '读取中…';
    try {
      const res = await fetch('/api/stats/turnover');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || '读取失败');
      render(data);
    } catch (e) {
      metaEl.textContent = '加载失败：' + (e && e.message ? e.message : e);
    }
  }

  daySelect.addEventListener('change', () => {
    rankDay = daySelect.value;
    loadRanking().catch((e) => {
      metaEl.textContent = '加载失败：' + (e && e.message ? e.message : e);
    });
  });
  refreshBtn.addEventListener('click', load);
  load();
  setInterval(load, 20000);
})();
