/* ==========================================================================
   company.js — 上市公司档案（股娘图鉴）
   数据在 /lore.js 的 window.COMPANY_LORE（与网页端同一份静态数据，服务端不感知）。
   入口三处：个股页头部股票名、个股页报价卡「公司档案」行、首页指数 hero。
   弹层走 core.sheet；公司色只用 CSSOM 上色（CSP 禁内联 style 属性）。
   ========================================================================== */
(function (GS) {
  'use strict';

  const { esc, fmtP, fmtPct, fmtAmt, cls, num } = GS.core;

  /** 档案条目；/lore.js 没加载或没这只股时返回 null */
  function loreOf(stockId) {
    return (window.COMPANY_LORE && window.COMPANY_LORE[stockId]) || null;
  }

  /** 标的行情：个股在 markets，指数走 state.index */
  function marketOf(stockId) {
    const m = GS.core.market(stockId);
    if (m && m.stockId === stockId) return m;
    const st = GS.core.S.state;
    return st && st.index && st.index.stockId === stockId ? st.index : null;
  }

  /** 股数紧凑显示（与网页 fmtVol 同口径：亿股/万股/股） */
  function fmtVol(v) {
    const n = num(v);
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿股';
    if (n >= 1e4) return (n / 1e4).toFixed(2) + '万股';
    return n.toFixed(0) + '股';
  }

  const stat = (label, val, klass) =>
    '<div class="co-stat"><span class="co-stat-label">' + esc(label) + '</span>' +
    '<b class="num' + (klass ? ' ' + klass : '') + '">' + esc(val) + '</b></div>';

  /** 公司资料 8 格：发行价/流通股本/流通市值/较发行价 全吃服务端快照，老服务端缺字段显示 -- */
  function statsHtml(m, isIndex) {
    const ch = cls(m.change);
    const float = num(m.floatShares);
    const issue = num(m.initPrice);
    const capNow = m.marketCap != null ? num(m.marketCap) : float * num(m.last);
    const vsIssue = issue > 0 ? (num(m.last) / issue - 1) * 100 : null;
    return (
      stat('最新价', fmtP(m.last), ch) +
      stat('涨跌幅', fmtPct(m.changePct), ch) +
      stat('成交量', fmtVol(m.volume)) +
      stat('成交额', fmtAmt(m.turnover)) +
      stat('发行价', issue > 0 ? fmtP(issue) : '--') +
      stat('流通股本', float > 0 ? fmtVol(float) : '--') +
      stat(isIndex ? '总市值' : '流通市值', fmtAmt(capNow)) +
      stat('较发行价', vsIssue == null ? '--' : fmtPct(vsIssue), vsIssue == null ? '' : cls(vsIssue))
    );
  }

  /** 上市公司档案弹层（指数也有：股娘天团，立绘是全员合照） */
  function openProfile(stockId) {
    const m = marketOf(stockId);
    const lore = loreOf(stockId);
    if (!m || !lore) {
      GS.core.toast('暂无该公司档案', 'err');
      return;
    }
    const st = GS.core.S.state;
    const isIndex = !!(st && st.index && st.index.stockId === m.stockId);
    const logoHtml = lore.logo
      ? '<img class="co-logo" src="' + esc(lore.logo) + '" alt="' + esc(m.name) + '徽记">'
      : '';
    const html =
      '<div class="co-ribbon"></div>' +
      '<div class="co-portrait"><img src="' + esc(lore.img) + '" alt="' +
        esc(lore.waifu + '（' + m.name + '拟人）') + '"></div>' +
      '<div class="co-head">' +
        logoHtml +
        '<div class="grow">' +
          '<div class="co-name">' + esc(m.name) + '</div>' +
          '<div class="co-code">' + esc(m.stockId) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="co-waifu-row">' +
        '<span class="co-waifu" id="coWaifu">拟人 · ' + esc(lore.waifu) + '</span>' +
        '<span class="co-title">' + esc(lore.title) + '</span>' +
      '</div>' +
      '<p class="co-intro">' + esc(lore.intro) + '</p>' +
      '<div class="co-stats">' + statsHtml(m, isIndex) + '</div>' +
      '<button class="btn-ghost co-poster-btn" id="coPosterBtn">看全员合照</button>';

    GS.core.sheet({
      title: '公司档案',
      html,
      onMount(ctl) {
        // 公司主题色：色带渐变 + 拟人胶囊描边/底色，都走 CSSOM（CSP 不许内联 style）
        const rib = ctl.body.querySelector('.co-ribbon');
        if (rib) {
          rib.style.backgroundImage =
            'linear-gradient(120deg, ' + lore.color + ' 0%, rgba(0, 0, 0, 0) 70%)';
        }
        const wf = ctl.body.querySelector('#coWaifu');
        if (wf) {
          wf.style.background = lore.color + '2e';
          wf.style.borderColor = lore.color;
        }
        const btn = ctl.body.querySelector('#coPosterBtn');
        if (btn) {
          btn.onclick = () => openPoster(m.stockId);
        }
      },
    });
  }

  /** 股娘全员合照（竖版海报）；backTo 有值时给「返回档案」，从档案进来可以退回 */
  function openPoster(backTo) {
    GS.core.sheet({
      title: '股娘全员合照',
      html:
        '<img class="poster-img" src="/img/waifu-group-poster.png" ' +
          'alt="股娘全员合照海报：十家上市公司拟人齐聚行情大屏前">' +
        '<div class="hint co-poster-hint">十家上市公司拟人齐聚行情大屏前</div>' +
        (backTo ? '<button class="btn-ghost" id="coPosterBack">返回档案</button>' : ''),
      onMount(ctl) {
        const back = ctl.body.querySelector('#coPosterBack');
        if (back) back.onclick = () => openProfile(backTo);
      },
    });
  }

  GS.company = { openProfile, openPoster, loreOf };
})(window.GS);
