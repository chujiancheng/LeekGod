/* ==========================================================================
   view-me.js — 「我的」页：身份卡 + 境界进度 + 券商 + 入金/改昵称/换头像/退出
   ========================================================================== */
(function (GS) {
  'use strict';

  const { $, esc, fmtAmt, fmtPct, num } = GS.core;

  let built = false;

  function build(root) {
    root.innerHTML =
      '<div class="me-hero" id="meHero">' +
        '<div class="me-row">' +
          '<img class="ava-lg" id="meAva" src="/img/avatar-auntie-192.png" alt="">' +
          '<div class="grow">' +
            '<div class="me-name" id="meName">—</div>' +
            '<div class="me-sub" id="meSub">—</div>' +
          '</div>' +
          '<button class="mini-btn" id="meAvaBtn">换脸</button>' +
        '</div>' +
        '<div class="realm-bar">' +
          '<div class="realm-bar-top"><span id="realmNow">—</span><span id="realmNext">—</span></div>' +
          '<div class="bar"><i id="realmBar"></i></div>' +
        '</div>' +
      '</div>' +
      '<div id="meBroker"></div>' +
      '<div class="menu" id="meMenu"></div>' +
      '<div class="hint">模拟盘游戏 · 所有行情与资金均为虚构<br>不构成任何投资建议</div>';

    GS.core.on(root, '#meAvaBtn', 'click', openAvatar);
    GS.core.on(root, '#meMenu .menu-item', 'click', (e, t) => {
      const k = t.dataset.act;
      if (k === 'deposit') openDeposit();
      else if (k === 'nick') openNick();
      else if (k === 'mascot') openMascot();
      else if (k === 'logout') logout();
      else if (k === 'portal') location.href = '/portal.html';
      else if (k === 'rules') openRules();
      else if (k === 'server') {
        try { window.AndroidHost.changeServer(); } catch (e) { /* 无桥忽略 */ }
      }
    });

    built = true;
  }

  function update(root) {
    if (!built) build(root);
    const st = GS.core.S.state;
    if (!st || !st.account) return;
    const a = st.account;

    const ava = (a.avatar && a.avatar.key) || 'auntie';
    const img = $('meAva');
    if (img && img.dataset.k !== ava) {
      img.dataset.k = ava;
      img.src = '/img/avatar-' + ava + '-192.png';
    }
    const nick = $('meName');
    if (nick) nick.textContent = a.nick || a.name;
    const sub = $('meSub');
    if (sub) {
      const r = a.realm || {};
      sub.textContent =
        (r.honor || '') + ' · ' + (a.broker ? a.broker.name : '') +
        ' · 第 ' + num(st.day && st.day.day) + ' 交易日';
    }

    // 境界进度
    const r = a.realm || {};
    const now = $('realmNow');
    const next = $('realmNext');
    const bar = $('realmBar');
    if (now) now.textContent = r.name || '—';
    if (next) {
      next.textContent = r.next
        ? '距 ' + r.next.name + ' 还差 ' + fmtAmt(Math.max(0, num(r.next.need))) + '（' +
          num(r.next.pct) + '%）'
        : '已到顶';
    }
    if (bar) {
      const pct = r.next ? Math.max(0, Math.min(100, num(r.next.pct))) : 100;
      bar.style.width = pct + '%';
    }

    renderBroker(a);
    renderMenu(st, a);
  }

  function renderBroker(a) {
    const box = $('meBroker');
    if (!box || !a.broker) return;
    const b = a.broker;
    const html =
      '<div class="card">' +
        '<div class="me-row">' +
          '<img class="broker-logo" src="/img/broker-' + esc(b.key) + '-96.png" alt="">' +
          '<div class="list-main">' +
            '<div class="list-t1">' + esc(b.name) +
              ' <span class="tag tag-gold">' + '★'.repeat(Math.min(5, num(b.star))) + '</span></div>' +
            '<div class="list-t2">佣金 ' + (num(b.feeRate) * 10000).toFixed(1) + '‱ · 冷却 ' +
              (num(b.cooldownMs) / 1000).toFixed(1) + 's · 杠杆 ' + num(b.leverage).toFixed(2) + '×</div>' +
          '</div>' +
        '</div>' +
        '<div class="broker-tags">' +
          (b.strengths || []).map((s) => '<span class="tag tag-good">' + esc(s) + '</span>').join('') +
          (b.costs || []).map((s) => '<span class="tag tag-bad">' + esc(s) + '</span>').join('') +
        '</div>' +
      '</div>';
    if (box.dataset.h !== html) {
      box.dataset.h = html;
      box.innerHTML = html;
    }
  }

  function renderMenu(st, a) {
    const box = $('meMenu');
    if (!box) return;
    const canDeposit = !!(st.rules && st.rules.deposit && st.rules.deposit.enabled);
    const items = [
      { k: 'deposit', icon: '💰', label: '加钱', val: canDeposit ? '可用' : '未开放', off: !canDeposit },
      { k: 'nick', icon: '✏️', label: '改昵称', val: a.nick || '' },
      { k: 'mascot', icon: '🎀', label: '换看板娘', val: mascotName() },
      { k: 'portal', icon: '🔑', label: '开放接口 API Key', val: '' },
      { k: 'rules', icon: '📖', label: '交易规则', val: '' },
      { k: 'logout', icon: '🚪', label: '退出登录', val: '' },
    ];
    // 壳 App 里才有 AndroidHost 桥：加「切换服务器」入口，展示当前地址
    let host = null;
    try { host = window.AndroidHost || null; } catch (e) { /* 浏览器无桥 */ }
    if (host && typeof host.changeServer === 'function') {
      let cur = '';
      try { cur = String(host.server() || ''); } catch (e) { cur = ''; }
      items.splice(4, 0, {
        k: 'server', icon: '🛰', label: '切换服务器',
        val: cur.replace(/^https?:\/\//, ''),
      });
    }
    box.innerHTML = items
      .map(
        (it) =>
          '<div class="menu-item" data-act="' + it.k + '">' +
            '<div class="mi-icon">' + it.icon + '</div>' +
            '<div>' + esc(it.label) + '</div>' +
            (it.val ? '<div class="mi-val">' + esc(it.val) + '</div>' : '') +
            '<div class="mi-arrow">›</div>' +
          '</div>'
      )
      .join('');
  }

  /* ---------------------------------------------------------------- 加钱 */

  function openDeposit() {
    const st = GS.core.S.state;
    const dep = (st.rules && st.rules.deposit) || {};
    if (!dep.enabled) {
      GS.core.toast('服务器没有开放加钱', 'err');
      return;
    }
    const presets = dep.presets || [10000, 50000, 200000];
    GS.core.sheet({
      title: '加钱',
      html:
        '<div class="hint">加的是虚拟资金，不计入任何真实资产。上限 ' +
          fmtAmt(dep.maxLifetime) + '。</div>' +
        '<div class="stepper">' +
          '<button data-amt="-1">−</button>' +
          '<input id="depAmt" inputmode="numeric" value="' + presets[0] + '">' +
          '<button data-amt="1">+</button>' +
        '</div>' +
        '<div class="chip-row">' +
          presets.map((p) => '<button class="chip" data-preset="' + p + '">' + fmtAmt(p) + '</button>').join('') +
        '</div>' +
        '<button class="btn-primary" id="depBtn">确认加钱</button>',
      onMount(ctl) {
        const input = ctl.body.querySelector('#depAmt');
        const btn = ctl.body.querySelector('#depBtn');
        const step = Math.max(1, Math.floor(presets[0] / 10) || 1000);
        GS.core.on(ctl.body, '[data-amt]', 'click', (e, t) => {
          input.value = String(Math.max(0, num(input.value) + num(t.dataset.amt) * step));
        });
        GS.core.on(ctl.body, '[data-preset]', 'click', (e, t) => {
          input.value = t.dataset.preset;
        });
        btn.onclick = () => {
          const amt = num(input.value);
          if (!(amt > 0)) return GS.core.toast('金额不对', 'err');
          btn.disabled = true;
          btn.textContent = '提交中…';
          GS.api.api
            .deposit(amt)
            .then((r) => {
              if (r && r.ok) {
                GS.core.toast('已到账 ' + fmtAmt(amt), 'ok');
                GS.core.closeSheet();
                return;
              }
              btn.disabled = false;
              btn.textContent = '确认加钱';
              GS.core.toast((r && r.error) || '加钱失败', 'err');
            })
            .catch(() => {
              btn.disabled = false;
              btn.textContent = '确认加钱';
              GS.core.toast('网络异常', 'err');
            });
        };
      },
    });
  }

  /* -------------------------------------------------------------- 改昵称 */

  function openNick() {
    const a = GS.core.S.state.account;
    GS.core.sheet({
      title: '改昵称',
      html:
        '<div class="field"><span class="field-label">昵称</span>' +
          '<input id="nickIn" value="' + esc(a.nick || '') + '"></div>' +
        '<button class="btn-primary" id="nickBtn">保存</button>',
      onMount(ctl) {
        const input = ctl.body.querySelector('#nickIn');
        const btn = ctl.body.querySelector('#nickBtn');
        btn.onclick = () => {
          const v = input.value.trim();
          if (v.length < 2) return GS.core.toast('昵称太短', 'err');
          btn.disabled = true;
          GS.api.api
            .nick(v)
            .then((r) => {
              if (r && r.ok) {
                GS.api.setIdentity(GS.core.S.account, v, GS.core.S.token);
                GS.core.toast('改好了', 'ok');
                GS.core.closeSheet();
                return;
              }
              btn.disabled = false;
              GS.core.toast((r && r.error) || '改名失败', 'err');
            })
            .catch(() => {
              btn.disabled = false;
              GS.core.toast('网络异常', 'err');
            });
        };
      },
    });
  }

  /* ------------------------------------------------------------ 换看板娘 */

  function mascotName() {
    const hit = GS.core.MASCOTS.find((m) => m.id === GS.core.mascotId());
    return hit ? hit.name : '';
  }

  /** 主页 hero 那张立绘跟着换（行情页不一定开着，找不到就算了，下一帧 update 会补） */
  function applyMascotNow() {
    const img = document.getElementById('heroMascot');
    if (!img) return;
    const mid = GS.core.mascotId();
    img.dataset.k = mid;
    img.src = GS.core.mascotImg(mid, true);
    img.hidden = false;
  }

  function openMascot() {
    const cur = GS.core.mascotId();
    const cells = GS.core.MASCOTS.map((m) =>
      '<button class="ava-cell' + (m.id === cur ? ' on' : '') + '" data-mascot="' + m.id + '">' +
        '<img class="ava" src="' + GS.core.mascotImg(m.id, false) + '" alt="" loading="lazy">' +
        '<span>' + esc(m.name) + '</span>' +
        '<i>' + esc(m.desc) + '</i>' +
      '</button>'
    ).join('');

    GS.core.sheet({
      title: '换看板娘',
      html:
        '<div class="ava-grid mascot-grid">' + cells + '</div>' +
        '<div class="hint">主页行情卡常驻，跟着你选的换。</div>',
      onMount(ctl) {
        GS.core.on(ctl.body, '[data-mascot]', 'click', (e, t) => {
          GS.core.setMascot(t.dataset.mascot);
          applyMascotNow();
          ctl.body.querySelectorAll('.ava-cell').forEach((c) =>
            c.classList.toggle('on', c === t));
          GS.core.toast('看板娘换成了「' + mascotName() + '」', 'ok');
        });
      },
    });
  }

  /* -------------------------------------------------------------- 换头像 */

  // 头像目录缓存：SSE 增量帧（lite）里 rules.avatar 只剩 {enabled}，
  // groups 全表只在首屏 /api/state 全量帧里出现（与老客户端同口径）——
  // 必须在见到带 groups 的帧时缓存下来，否则开弹层时是空格子
  let avaCatalog = null;

  function openAvatar() {
    const st = GS.core.S.state;
    const av = st.rules && st.rules.avatar;
    if (av && Array.isArray(av.groups) && av.groups.length) avaCatalog = av;
    if (!avaCatalog) {
      // 缓存丢了（比如整局都是 SSE 帧）：拉一次全量 /api/state 补上
      GS.core.toast('正在拉取头像目录…');
      GS.api.api
        .state()
        .then((s) => {
          const full = s && s.rules && s.rules.avatar;
          if (full && Array.isArray(full.groups) && full.groups.length) {
            avaCatalog = full;
            renderAvatarSheet();
            return;
          }
          GS.core.toast('头像目录拉取失败', 'err');
        })
        .catch(() => GS.core.toast('网络异常', 'err'));
      return;
    }
    renderAvatarSheet();
  }

  function renderAvatarSheet() {
    const st = GS.core.S.state;
    const a = st.account;
    const catalog = (avaCatalog && avaCatalog.groups) || [];
    const unlocked = new Set((a.avatar && a.avatar.unlocked) || []);
    const cells = catalog
      .map((g) =>
        g.rows
          .map((row) => {
            const ok = unlocked.has(row.key);
            return (
              '<button class="ava-cell' + (ok ? '' : ' lock') + '" data-ava="' + esc(row.key) + '"' +
                (ok ? '' : ' disabled') + '>' +
                '<img class="ava" src="/img/avatar-' + esc(row.key) + '-96.png" alt="">' +
                '<span>' + esc(row.name) + '</span>' +
              '</button>'
            );
          })
          .join('')
      )
      .join('');

    GS.core.sheet({
      title: '换头像',
      html:
        '<div class="ava-grid">' + cells + '</div>' +
        '<div class="hint">开户即解锁全部基础头像，后续头像靠境界与成就解锁。</div>',
      onMount(ctl) {
        GS.core.on(ctl.body, '[data-ava]', 'click', (e, t) => {
          const key = t.dataset.ava;
          GS.api.api
            .avatar(key)
            .then((r) => {
              if (r && r.ok) {
                GS.core.toast('换好了', 'ok');
                GS.core.closeSheet();
                return;
              }
              GS.core.toast((r && r.error) || '换头像失败', 'err');
            })
            .catch(() => GS.core.toast('网络异常', 'err'));
        });
      },
    });
  }

  /* -------------------------------------------------------------- 规则 */

  function openRules() {
    const st = GS.core.S.state;
    const r = st.rules || {};
    const dep = r.deposit || {};
    GS.core.sheet({
      title: '交易规则',
      html:
        '<div class="field-line"><span>佣金费率</span><b>' + (num(r.feeRate) * 10000).toFixed(2) + '‱</b></div>' +
        '<div class="field-line"><span>下单冷却</span><b>' + (num(r.cooldownMs) / 1000).toFixed(1) + ' 秒</b></div>' +
        '<div class="field-line"><span>T+ 锁仓</span><b>' + (num(r.lockMs) / 1000).toFixed(0) + ' 秒</b></div>' +
        '<div class="field-line"><span>保证金比例</span><b>' + (num(r.marginRatio) * 100).toFixed(0) + '%</b></div>' +
        '<div class="field-line"><span>维持率</span><b>' + (num(r.maintenance) * 100).toFixed(0) + '%</b></div>' +
        '<div class="field-line"><span>涨跌停</span><b>±' +
          (r.priceLimit && r.priceLimit.enabled ? num(r.priceLimit.pct) * 100 + '%' : '不设') + '</b></div>' +
        '<div class="field-line"><span>加钱上限</span><b>' + fmtAmt(dep.maxLifetime) + '</b></div>' +
        '<div class="hint hint-gap">' +
          '4 种动作：买入开多 / 卖出平多 / 卖出开空 / 买入平空，同一只股票多空互斥。' +
          '下单冷却期间不能重复下单；成交后 T+ 锁仓期内不能卖出。' +
        '</div>',
    });
  }

  /* ---------------------------------------------------------------- 退出 */

  function logout() {
    GS.api.disconnect();
    GS.api.clearIdentity();
    GS.core.S.state = null;
    GS.app.showLogin('');
  }

  GS.viewMe = { id: 'me', title: '我的', update, openDeposit, openAvatar, reset() { built = false; } };
})(window.GS);
