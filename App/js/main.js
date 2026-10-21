/* ==========================================================================
   main.js — 启动 / 顶部栏 / 底部 tabbar / 视图调度
   ========================================================================== */
(function (GS) {
  'use strict';

  const { $, esc, icon, num, fmtLeft, cls } = GS.core;

  const VIEWS = [
    { id: 'market', title: '行情', icon: 'market', view: () => GS.viewMarket },
    { id: 'trade', title: '交易', icon: 'trade', view: () => GS.viewTrade },
    { id: 'rank', title: '排行', icon: 'rank', view: () => GS.viewRank },
    { id: 'me', title: '我的', icon: 'me', view: () => GS.viewMe },
  ];

  let active = GS.core.S.tab || 'market';
  let timer = null;
  let sparkTimer = null;

  /* ---------------------------------------------------------------- 顶栏 */

  function renderHeader() {
    const head = $('appHeader');
    if (!head) return;
    const st = GS.core.S.state;
    const day = st && st.day;
    const phase = day ? day.label || '' : '连接中';
    const dayNo = day && day.day ? '第 ' + day.day + ' 天' : '';
    head.innerHTML =
      '<div class="head-row">' +
        '<div class="grow">' +
          '<div class="head-title">股神请就位</div>' +
          '<div class="head-sub" id="headSub">' + esc(dayNo) + (dayNo && phase ? ' · ' : '') + esc(phase) + '</div>' +
        '</div>' +
        '<div class="head-live"><span class="dot off" id="connDot"></span><span id="connTxt">连接中</span></div>' +
        '<button class="icon-btn" id="refreshBtn" aria-label="刷新">' + icon('refresh') + '</button>' +
      '</div>';

    $('refreshBtn').onclick = () => {
      refreshAll();
      GS.core.toast('已刷新');
    };
    updateConn(GS.api.connected);
  }

  function updateConn(ok) {
    const dot = $('connDot');
    const txt = $('connTxt');
    if (dot) dot.classList.toggle('off', !ok);
    if (txt) txt.textContent = ok ? '实时' : '重连中';
  }

  /** 顶栏时钟：阶段倒计时（每 500ms 刷一次，只动文本） */
  function tickHeader() {
    const st = GS.core.S.state;
    const sub = $('headSub');
    if (!sub || !st) return;
    const day = st.day;
    if (!day) return;
    const parts = [];
    if (day.day) parts.push('第 ' + day.day + ' 天');
    parts.push(day.label || '');
    if (day.phaseLeftMs > 0) parts.push(fmtLeft(day.phaseLeftMs));
    if (st.halt && st.halt.halted) parts.push('已停牌');
    const txt = parts.join(' · ');
    if (sub.textContent !== txt) sub.textContent = txt;
  }

  /* -------------------------------------------------------------- tabbar */

  function renderTabbar() {
    const bar = $('tabbar');
    if (!bar) return;
    bar.innerHTML = VIEWS.map(
      (v) =>
        '<button class="tab' + (v.id === active ? ' on' : '') + '" data-view="' + v.id + '">' +
          icon(v.icon) +
          '<span>' + v.title + '</span>' +
        '</button>'
    ).join('');
    GS.core.on(bar, '[data-view]', 'click', (e, t) => {
      switchTo(t.dataset.view);
    });
  }

  function switchTo(id) {
    if (!VIEWS.find((v) => v.id === id)) return;
    active = id;
    GS.core.S.tab = id;
    GS.core.store.set(GS.core.KEY.tab, id);
    document.querySelectorAll('#tabbar .tab').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === id);
    });
    document.querySelectorAll('#appMain [data-pane]').forEach((el) => {
      el.hidden = el.dataset.pane !== id;
    });
    const pane = document.querySelector('#appMain [data-pane="' + id + '"]');
    if (pane) pane.scrollTop = 0;
    renderActive();
  }

  /* ---------------------------------------------------------------- 视图 */

  function buildPanes() {
    const main = $('appMain');
    main.innerHTML = VIEWS.map(
      (v) => '<div data-pane="' + v.id + '" class="pane"' + (v.id === active ? '' : ' hidden') + '></div>'
    ).join('');
  }

  function renderActive() {
    const pane = document.querySelector('#appMain [data-pane="' + active + '"]');
    const v = VIEWS.find((x) => x.id === active);
    if (!pane || !v) return;
    v.view().update(pane);
  }

  function renderAll() {
    VIEWS.forEach((v) => {
      const pane = document.querySelector('#appMain [data-pane="' + v.id + '"]');
      if (!pane || pane.hidden) return;
      v.view().update(pane);
    });
  }

  /* -------------------------------------------------------------- 刷新 */

  function refreshAll() {
    GS.api
      .api.state()
      .then((s) => {
        if (s && s.markets) {
          GS.core.S.state = s;
          GS.core.S.stateAt = Date.now();
          GS.core.emit();
          tickHeader();
        }
      })
      .catch(() => {});
    GS.api.loadSparks().then(() => renderAll());
  }

  /* ---------------------------------------------------------------- 进入 */

  function enter() {
    $('boot').hidden = true;
    GS.viewLogin.hide();
    $('shell').hidden = false;
    renderHeader();
    renderTabbar();
    buildPanes();
    switchTo(active);

    // 无论从哪条路进来（冷启动 / 登录页 / 开户），进壳都要确保 SSE 在连
    if (GS.core.S.token && !GS.api.connected) GS.api.connect();

    // 首帧可能还没到：先拉一次全量兜底
    if (!GS.core.S.state) refreshAll();

    GS.core.subscribe(() => {
      renderAll();
      tickHeader();
    });

    GS.api.onConn((ok) => updateConn(ok));

    // 兜底重登：服务端重启导致令牌失效
    GS.api.onRelogin((ok) => {
      if (ok) {
        GS.core.toast('服务已重启，已自动重新登录', 'info');
        refreshAll();
      } else {
        GS.app.showLogin(GS.core.S.account);
      }
    });

    clearInterval(timer);
    timer = setInterval(tickHeader, 500);

    // 迷你走势 30 秒刷一次（服务端本身就是降采样，不必更频）
    clearInterval(sparkTimer);
    sparkTimer = setInterval(() => {
      GS.api.loadSparks().then(() => {
        if (active === 'market') renderActive();
      });
    }, 30000);
    GS.api.loadSparks().then(() => renderActive());
  }

  function showLogin(prefill) {
    clearInterval(timer);
    clearInterval(sparkTimer);
    $('shell').hidden = true;
    $('boot').hidden = true;
    GS.api.disconnect();
    GS.viewLogin.open(prefill || '');
  }

  /* ---------------------------------------------------------------- 启动 */

  function boot() {
    GS.core.bindBackKey();
    GS.api.boot().then((r) => {
      if (r.ok) {
        enter();
        return;
      }
      if (r.reason === 'need-onboard') {
        // 账号在、没开完户：直接进第二步（账号预填）
        $('boot').hidden = true;
        GS.viewLogin.openOnboard(r.account);
        return;
      }
      if (r.reason === 'network') {
        $('bootTip').textContent = '连不上服务器，检查网络后重试';
        const tip = $('bootTip');
        tip.style.pointerEvents = 'auto';
        tip.style.cursor = 'pointer';
        tip.onclick = () => location.reload();
        return;
      }
      showLogin(GS.core.S.account || '');
    });
  }

  GS.app = { enter, showLogin, refreshAll, switchTo };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.GS);
