/* ==========================================================================
   view-rank.js — 「排行」页：玩家榜 / 券商榜
   玩家榜：点某行拉 /api/player/positions 看他的仓位（按需接口，不进 SSE 帧）
   ========================================================================== */
(function (GS) {
  'use strict';

  const { $, esc, fmtAmt, fmtMoney, fmtP, fmtQty, cls, num } = GS.core;

  let tab = 'player';
  let built = false;
  let posSeq = 0; // 连点两个人时丢弃旧响应，避免「先点 A 后点 B，回来的是 A」

  function build(root) {
    root.innerHTML =
      '<div class="segment" id="rankSeg">' +
        '<button data-tab="player" class="on">玩家榜</button>' +
        '<button data-tab="broker">券商榜</button>' +
      '</div>' +
      '<div class="rank-share" id="rankShareRow" hidden>' +
        '<button class="mini-btn" id="rankShare">晒排名</button>' +
      '</div>' +
      '<div class="card card-flat" id="rankList"></div>' +
      '<div class="hint">按总资产排序，点玩家可看持仓。榜上会显示昵称与头像，账户名不公开。</div>';

    GS.core.on(root, '#rankSeg button', 'click', (e, t) => {
      tab = t.dataset.tab;
      root.querySelectorAll('#rankSeg button').forEach((b) => b.classList.toggle('on', b === t));
      renderList();
    });
    GS.core.on(root, '#rankShare', 'click', () => GS.share.rankText());
    // 榜单每帧整块重写 innerHTML，事件只能挂在容器上（委托到 root）
    GS.core.on(root, '#rankList .rank-row[data-account]', 'click', (e, t) => {
      openPositions(t.dataset.account, t.dataset.nick);
    });
    built = true;
  }

  function update(root) {
    if (!built || !root.childElementCount) build(root);
    renderList();
  }

  function renderList() {
    const box = $('rankList');
    if (!box) return;
    const st = GS.core.S.state;
    if (!st) return;

    if (tab === 'player') {
      const players = (st.players || []).slice();
      // 晒排名：只有玩家榜、且自己上榜时亮出来
      const shareRow = $('rankShareRow');
      if (shareRow) {
        shareRow.hidden = tab !== 'player' ||
          !players.some((p) => p.account === GS.core.S.account);
      }
      if (!players.length) {
        box.innerHTML = '<div class="empty"><div class="empty-icon">🏆</div>榜上还没有人</div>';
        return;
      }
      box.innerHTML = players
        .map((p, i) => {
          const mine = p.account === GS.core.S.account;
          const clickable = !!p.account;
          // 对外只露昵称：account 只作取数键（data-account），不上屏
          const nick = p.name || '匿名玩家';
          return (
            '<div class="rank-row' + (i < 3 ? ' rtop-' + (i + 1) : '') + '"' +
              (mine ? ' data-mine="1"' : '') +
              (clickable
                ? ' data-account="' + esc(p.account) + '" data-nick="' + esc(nick) + '" role="button"'
                : '') +
              '>' +
              '<div class="rank-no ' + (i < 3 ? 'md' + (i + 1) : '') + '">' + (i + 1) + '</div>' +
              '<img class="ava" src="/img/avatar-' + esc(p.ava || 'auntie') + '-96.png" alt="">' +
              '<div class="list-main">' +
                '<div class="list-t1">' + esc(nick) +
                  (mine ? ' <span class="tag tag-gold">我</span>' : '') + '</div>' +
                '<div class="list-t2">' +
                  (p.realm ? esc(p.realm.name) + ' · ' + esc(p.realm.short || p.realm.honor || '') : '') +
                  (p.broker ? ' · ' + esc(brokerAbbr(p.broker)) : '') +
                '</div>' +
              '</div>' +
              '<div class="list-right">' +
                '<div class="list-v1">' + fmtAmt(p.equity) + '</div>' +
                '<div class="list-v2">' + (p.star ? '★'.repeat(Math.min(5, num(p.star))) : '') + '</div>' +
              '</div>' +
              (clickable ? '<div class="rank-arrow">›</div>' : '') +
            '</div>'
          );
        })
        .join('');
      return;
    }

    const board = st.brokerBoard || [];
    if (!board.length) {
      box.innerHTML = '<div class="empty"><div class="empty-icon">🏦</div>暂无数据</div>';
      return;
    }
    // 券商榜没有「我的排名」，晒排名行藏起来
    const shareRow = $('rankShareRow');
    if (shareRow) shareRow.hidden = true;
    box.innerHTML = board
      .map((b, i) => {
        return (
          '<div class="rank-row">' +
            '<div class="rank-no ' + (i < 3 ? 'md' + (i + 1) : '') + '">' + (i + 1) + '</div>' +
            '<img class="ava" src="/img/broker-' + esc(b.key) + '-96.png" alt="">' +
            '<div class="list-main">' +
              '<div class="list-t1">' + esc(b.name) + '</div>' +
              '<div class="list-t2">' + num(b.clients) + ' 位客户 · 榜首 ' + esc(b.top || '—') + '</div>' +
            '</div>' +
            '<div class="list-right">' +
              '<div class="list-v1">' + fmtAmt(b.equity) + '</div>' +
            '</div>' +
          '</div>'
        );
      })
      .join('');
  }

  /* ------------------------------------------------------ 玩家持仓弹层 */

  function openPositions(account, nick) {
    if (!account) return;
    const seq = ++posSeq;
    const ctl = GS.core.sheet({
      title: (nick || '玩家') + ' · 持仓',
      html: '<div class="pos-loading">正在读取…</div>',
    });
    GS.api
      .getJSON('/api/player/positions?account=' + encodeURIComponent(account))
      .then((r) => {
        if (seq !== posSeq || !ctl.el || ctl.el.hidden) return;
        if (!r || !r.ok) {
          ctl.body.innerHTML = '<div class="pos-loading">' + esc((r && r.error) || '读取失败') + '</div>';
          return;
        }
        renderPositions(ctl, r);
      })
      .catch(() => {
        if (seq !== posSeq || !ctl.el || ctl.el.hidden) return;
        ctl.body.innerHTML = '<div class="pos-loading">网络错误</div>';
      });
  }

  function renderPositions(ctl, d) {
    const pnl = num(d.longPnl) + num(d.shortPnl);
    const signed = (v) => (num(v) >= 0 ? '+' : '') + fmtMoney(v);
    const stars = d.star > 1 ? ' · ' + '★'.repeat(Math.min(5, num(d.star))) : '';
    const rows = (d.positions || [])
      .map((p) => {
        const long = p.side === 'long';
        return (
          '<div class="pos-row' + (long ? ' is-long' : ' is-short') + '">' +
            '<div class="pos-name">' + esc(p.name) + '<span class="pos-code">' + esc(p.stockId) + '</span>' +
              '<span class="pos-side">' + (long ? '多头' : '空头') + '</span></div>' +
            '<div class="pos-main">' +
              '<span>' + fmtQty(p.qty) + ' 股</span>' +
              '<span>成本 ' + fmtP(p.avg) + '</span>' +
              '<span>现价 ' + fmtP(p.last) + '</span>' +
            '</div>' +
            '<div class="pos-right">' +
              '<div class="pos-val">' + fmtMoney(p.value) + '</div>' +
              '<div class="pos-pnl ' + cls(p.pnl) + '">' + signed(p.pnl) + '</div>' +
            '</div>' +
          '</div>'
        );
      })
      .join('');

    ctl.body.innerHTML =
      '<div class="pos-head">' +
        '<img class="ava" src="/img/avatar-' + esc((d.avatar && d.avatar.key) || 'auntie') + '-96.png" alt="">' +
        '<div class="pos-head-main">' +
          '<div class="pos-head-name">' + esc(d.name || '匿名玩家') + '</div>' +
          '<div class="pos-head-sub">' +
            (d.broker ? esc(brokerAbbr(d.broker)) + stars : '未开户') +
          '</div>' +
        '</div>' +
        '<div class="pos-head-right">' +
          '<div class="pos-eq ' + cls(num(d.equity) - num(d.initialCash)) + '">¥' + fmtMoney(d.equity) + '</div>' +
          '<div class="pos-eq-label">总权益</div>' +
        '</div>' +
      '</div>' +
      '<div class="pos-stats">' +
        stat('可用资金', '¥' + fmtMoney(d.cash)) +
        stat('持仓市值', '¥' + fmtMoney(d.longValue)) +
        stat('空头市值', '¥' + fmtMoney(d.shortValue)) +
        stat('浮动盈亏', signed(pnl), cls(pnl)) +
        stat('已实现盈亏', signed(d.realizedPnL), cls(d.realizedPnL)) +
        stat('融资负债', '¥' + fmtMoney(d.financeDebt)) +
      '</div>' +
      (rows || '<div class="pos-loading">暂无持仓（空仓）</div>');

    function stat(label, val, colorCls) {
      return (
        '<div class="pos-stat"><div class="pos-stat-label">' + label + '</div>' +
        '<div class="pos-stat-val ' + (colorCls || '') + '">' + val + '</div></div>'
      );
    }
  }

  function brokerAbbr(key) {
    const st = GS.core.S.state;
    const list = (st.rules && st.rules.brokers) || [];
    const hit = list.find((b) => b.key === key);
    return hit ? hit.abbr || hit.name : key;
  }

  GS.viewRank = {
    id: 'rank',
    title: '排行',
    update,
    reset() {
      built = false;
      posSeq = 0;
    },
  };
})(window.GS);
