/* ==========================================================================
   view-rank.js — 「排行」页：玩家榜 / 券商榜
   ========================================================================== */
(function (GS) {
  'use strict';

  const { $, esc, fmtAmt, cls, num } = GS.core;

  let tab = 'player';
  let built = false;

  function build(root) {
    root.innerHTML =
      '<div class="segment" id="rankSeg">' +
        '<button data-tab="player" class="on">玩家榜</button>' +
        '<button data-tab="broker">券商榜</button>' +
      '</div>' +
      '<div class="card card-flat" id="rankList"></div>' +
      '<div class="hint">按总资产排序。榜上会显示昵称与头像，账户名不公开。</div>';

    GS.core.on(root, '#rankSeg button', 'click', (e, t) => {
      tab = t.dataset.tab;
      root.querySelectorAll('#rankSeg button').forEach((b) => b.classList.toggle('on', b === t));
      renderList();
    });
    built = true;
  }

  function update(root) {
    if (!built) build(root);
    renderList();
  }

  function renderList() {
    const box = $('rankList');
    if (!box) return;
    const st = GS.core.S.state;
    if (!st) return;

    if (tab === 'player') {
      const players = (st.players || []).slice();
      if (!players.length) {
        box.innerHTML = '<div class="empty"><div class="empty-icon">🏆</div>榜上还没有人</div>';
        return;
      }
      box.innerHTML = players
        .map((p, i) => {
          const mine = p.account === GS.core.S.account;
          return (
            '<div class="rank-row"' + (mine ? ' data-mine="1"' : '') + '>' +
              '<div class="rank-no ' + (i < 3 ? 'top' + (i + 1) : '') + '">' + (i + 1) + '</div>' +
              '<img class="ava" src="/img/avatar-' + esc(p.ava || 'auntie') + '-96.png" alt="">' +
              '<div class="list-main">' +
                '<div class="list-t1">' + esc(p.name || p.account) +
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
    box.innerHTML = board
      .map((b, i) => {
        return (
          '<div class="rank-row">' +
            '<div class="rank-no ' + (i < 3 ? 'top' + (i + 1) : '') + '">' + (i + 1) + '</div>' +
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
    },
  };
})(window.GS);
