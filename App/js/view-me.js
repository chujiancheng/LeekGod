/* ==========================================================================
   view-me.js — 「我的」页：身份卡 + 境界进度 + 券商 + 入金/改昵称/换头像/退出
   ========================================================================== */
(function (GS) {
  'use strict';

  const { $, esc, fmtAmt, fmtMoney, fmtPct, num } = GS.core;

  let built = false;

  // 资产轨迹（/api/account/assets，只回本人）：服务端每交易日收盘定格一行 daily_assets。
  // 60 秒节流——收盘一天才定格一次，没必要跟着 SSE 每帧拉；失败 20 秒后重试
  // （归零会变成每帧一次请求，断网时自己打自己）
  const TRAIL_TTL = 60000;
  const TRAIL_RETRY = 20000;
  let trail = { acct: '', rows: [], live: null, fetchedAt: 0, key: '' };
  const trailFresh = (acct) => ({ acct: acct, rows: [], live: null, fetchedAt: 0, key: '' });

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
      // 资产轨迹：收盘权益折线 + 当日盘中点（数据来自 daily_assets，服务端只回本人）
      '<div class="card" id="meTrailCard">' +
        '<div class="card-head"><span class="card-title">资产轨迹</span>' +
          '<span class="card-more" id="meTrailSub"></span></div>' +
        '<div class="trail-box" id="meTrail"><div class="trail-empty">首个交易日收盘后开始记录</div></div>' +
      '</div>' +
      '<div id="meBroker"></div>' +
      '<div class="menu" id="meMenu"></div>' +
      '<div class="hint">模拟盘游戏 · 所有行情与资金均为虚构<br>不构成任何投资建议</div>';

    GS.core.on(root, '#meAvaBtn', 'click', openAvatar);
    // 券商卡里的按钮（转户 / 免息券）：挂在**稳定的 #meBroker 容器**上做委托，
    // 卡片 innerHTML 每帧可能重建，逐个 addEventListener 会跟着一起丢
    GS.core.on(root, '#meBroker [data-act]', 'click', (e, t) => {
      const k = t.dataset.act;
      if (k === 'transfer') openTransfer();
      else if (k === 'coupon') useCoupon(t);
    });
    GS.core.on(root, '#meMenu .menu-item', 'click', (e, t) => {
      const k = t.dataset.act;
      if (k === 'deposit') openDeposit();
      else if (k === 'nick') openNick();
      else if (k === 'mascot') openMascot();
      else if (k === 'logout') logout();
      else if (k === 'invite') GS.share.inviteText();
      else if (k === 'portal') location.href = '/portal.html';
      else if (k === 'rules') openRules();
      else if (k === 'pwa') openPwaTip();
      else if (k === 'server') {
        try { window.AndroidHost.changeServer(); } catch (e) { /* 无桥忽略 */ }
      }
    });

    built = true;
  }

  function update(root) {
    // 同 view-market：pane 被重建后 DOM 会空，必须复查而不是只信 built
    if (!built || !root.childElementCount) build(root);
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
          (num(r.next.pct) * 100).toFixed(1) + '%）'
        : '已到顶';
    }
    if (bar) {
      // 服务端 pct 是 0~1 小数（realm.view 口径），进度条按百分数落 CSSOM
      const pct = r.next ? Math.max(0, Math.min(100, num(r.next.pct) * 100)) : 100;
      bar.style.width = pct + '%';
    }

    renderTrail();
    loadTrail();
    renderBroker(a);
    renderMenu(st, a);
  }

  /* ------------------------------------------------------------ 资产轨迹 */

  /** 主题色读计算样式：SVG 只能吃具体色值，var() 在 presentation 属性里不生效 */
  function cssColor(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return String(v || '').trim() || fallback;
    } catch (e) {
      return fallback;
    }
  }

  /**
   * 「资产轨迹」卡：收盘权益折线 + 当日盘中点。update 每帧都会进来，
   * 靠 key（各点 day:equity + 画布宽度）去重——数据没变就不碰 DOM。
   * 上色全走 SVG presentation 属性（CSP 不开内联 style），颜色随区间涨跌（红涨绿跌）。
   */
  function renderTrail() {
    const box = $('meTrail');
    if (!box) return;
    const sub = $('meTrailSub');
    // 服务端给的是新→旧，翻成旧→新；当日盘中点排最后
    const pts = [];
    for (let i = trail.rows.length - 1; i >= 0; i--) {
      const r = trail.rows[i];
      if (r && Number.isFinite(r.equity)) pts.push({ day: r.day, equity: r.equity, live: false });
    }
    // 服务端已按「库里有没有这天的行」判过重，这里再挡一道：同一天两个点画出来是错的
    if (trail.live && Number.isFinite(trail.live.equity) && !pts.some((p) => p.day === trail.live.day)) {
      pts.push({ day: trail.live.day, equity: trail.live.equity, live: true });
    }
    // 宽度按卡片实际像素进 viewBox（横向拉伸会把圆点压成椭圆）；面板隐藏时给个兜底宽度
    const W = Math.round(box.clientWidth || 0) || 320;

    if (!pts.length) {
      if (trail.key === 'empty|' + W) return;
      trail.key = 'empty|' + W;
      box.innerHTML = '<div class="trail-empty">首个交易日收盘后开始记录</div>';
      if (sub) sub.textContent = '';
      return;
    }

    const first = pts[0];
    const last = pts[pts.length - 1];
    const key = W + '|' + pts.map((p) => p.day + ':' + p.equity).join('|');
    if (key === trail.key) return;
    trail.key = key;

    const chg = last.equity - first.equity;
    const chgPct = first.equity !== 0 ? (chg / Math.abs(first.equity)) * 100 : 0;
    const tint = chg > 0
      ? cssColor('--up', '#e8413c')
      : chg < 0
        ? cssColor('--down', '#0aa06e')
        : cssColor('--txt-3', '#99a2ad');
    const tone = chg > 0 ? 'up' : chg < 0 ? 'down' : '';

    if (sub) {
      // 「盘中」不写「实时」：这个点是 60 秒节流拉回来的
      sub.innerHTML = pts.length > 1
        ? '第 ' + esc(first.day) + '→' + esc(last.day) + ' 天' + (last.live ? ' · 盘中' : '') +
          ' · <b class="' + tone + '">' + (chg > 0 ? '+' : '') + chgPct.toFixed(2) + '%</b>'
        : '第 ' + esc(first.day) + ' 天' + (first.live ? ' · 盘中' : ' 收盘');
    }

    if (pts.length < 2) {
      // 只有一格：先给数不给线。刚开盘（还没收盘）时这一格是盘中点，别写成「已记录 1 个收盘」
      box.innerHTML = '<div class="trail-empty">' + (first.live ? '今日盘中权益 ' : '已记录 1 个收盘 · 权益 ') +
        '<b>¥' + fmtMoney(first.equity) + '</b></div>';
      return;
    }

    const H = 56;
    const PAD = 6;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p.equity < lo) lo = p.equity;
      if (p.equity > hi) hi = p.equity;
    }
    if (hi === lo) { hi += 1; lo -= 1; }
    const x = (i) => (PAD + (i / (pts.length - 1)) * (W - PAD * 2)).toFixed(1);
    const y = (v) => (PAD + ((hi - v) / (hi - lo)) * (H - PAD * 2)).toFixed(1);
    const line = pts.map((p, i) => x(i) + ',' + y(p.equity)).join(' ');
    const area = x(0) + ',' + (H - PAD) + ' ' + line + ' ' + x(pts.length - 1) + ',' + (H - PAD);
    const baseY = y(first.equity);
    const dots = pts.map((p, i) =>
      '<circle cx="' + x(i) + '" cy="' + y(p.equity) + '" r="' + (p.live ? 2.6 : 1.8) + '"' +
      ' fill="' + (p.live ? tint : 'none') + '" stroke="' + tint + '" stroke-width="1.3"></circle>'
    ).join('');
    box.innerHTML =
      '<svg class="trail-svg" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<polygon points="' + area + '" fill="' + tint + '" fill-opacity="0.10"></polygon>' +
      '<line x1="' + x(0) + '" y1="' + baseY + '" x2="' + x(pts.length - 1) + '" y2="' + baseY +
      '" stroke="' + tint + '" stroke-width="0.8" stroke-dasharray="3 4" stroke-opacity="0.35"></line>' +
      '<polyline points="' + line + '" fill="none" stroke="' + tint + '" stroke-width="1.4"' +
      ' stroke-linejoin="round" stroke-linecap="round"></polyline>' + dots + '</svg>';
  }

  function loadTrail() {
    const acct = GS.core.S.account || '';
    if (!GS.core.S.token) return;
    // 换号后必须先清掉上一个号的轨迹，否则会画出别人的曲线
    if (trail.acct !== acct) trail = trailFresh(acct);
    const now = Date.now();
    if (now - trail.fetchedAt < TRAIL_TTL) return;
    trail.fetchedAt = now;
    GS.api.getJSON('/api/account/assets?limit=60')
      .then((r) => {
        if (!r || !r.ok) return;
        trail.rows = Array.isArray(r.rows) ? r.rows : [];
        trail.live = r.live || null;
        trail.key = '';
        renderTrail();
      })
      .catch(() => {
        trail.fetchedAt = Date.now() - (TRAIL_TTL - TRAIL_RETRY);
      });
  }

  /* ------------------------------------------------------------ 券商 */

  /**
   * 券商展示元数据：`state.rules.brokers` 是 describeAll() 的**数组**（与登录页
   * /api/brokers 同一份），字段含 name/abbr/persona/strengths/costs/crowdPct/preview。
   * rules.brokers 每帧都带（lite 帧只裁 realm/avatar），所以这里不额外发请求。
   */
  function brokerMetas() {
    const list = GS.core.S.state && GS.core.S.state.rules && GS.core.S.state.rules.brokers;
    return Array.isArray(list) ? list : [];
  }

  function metaOf(key, list) {
    const arr = list || brokerMetas();
    for (const m of arr) if (m.key === key) return m;
    return {};
  }

  /** 佣金显示成「万N」，比 0.0002 直观（与网页版 fmtFeeRate 同口径） */
  function fmtFee(rate) {
    if (!Number.isFinite(+rate)) return '--';
    return '万' + Math.round(+rate * 1000000) / 100;
  }

  /** 特权进度条宽度必须走 CSSOM：CSP 的 style-src 没放开 unsafe-inline */
  function paintBars(root) {
    if (!root) return;
    root.querySelectorAll('.bk-bar b[data-w]').forEach((el) => {
      const w = num(el.dataset.w);
      el.style.width = Math.max(2, Math.min(100, w)) + '%';
      el.classList.toggle('full', w >= 100);
    });
  }

  function starText(star, max) {
    const m = Math.max(1, num(max) || 5);
    const s = Math.max(0, Math.min(m, num(star)));
    return '★'.repeat(s) + '☆'.repeat(m - s);
  }

  function renderBroker(a) {
    const box = $('meBroker');
    if (!box || !a.broker) return;
    const b = a.broker;

    // 特权清单：当前值 / 满额值 + 强度条（服务端算好的 pct，前端不算第二遍）
    const priv = (b.privileges || [])
      .map((r) =>
        '<div class="bk-priv-row">' +
          '<span class="bk-priv-k">' + esc(r.label) + '</span>' +
          '<span class="bk-priv-v">' + esc(r.now) + '<i>/' + esc(r.full) + '</i></span>' +
          '<span class="bk-bar"><b data-w="' + num(r.pct) + '"></b></span>' +
          (r.extra ? '<span class="tag tag-gold">' + esc(r.extra) + '</span>' : '') +
        '</div>'
      )
      .join('');

    // 下一星门槛：progress 里给了现状值/门槛值，前端只负责拼文案
    const pr = b.progress;
    const nextStar = pr
      ? '<div class="bk-note">距 ' + esc(pr.next) + '★：成交额 ' + fmtAmt(pr.volume) + ' / ' + fmtAmt(pr.volumeNeed) +
          (num(pr.profitNeed) > 0 ? '，累计盈利 ' + fmtAmt(pr.profit) + ' / ' + fmtAmt(pr.profitNeed) : '') +
          (pr.noLiquidation ? '（且不能爆仓，当前 ' + num(pr.liquidations) + ' 次）' : '') +
        '</div>'
      : '<div class="bk-note">星级已满</div>';

    const wk = b.weekly || {};
    const weekly = wk.key
      ? '<div class="bk-note">本周之星：<b>' + esc(metaOf(wk.key).name || wk.key) + '</b>' +
          (wk.isStar
            ? '（就是本家：佣金减半 · 融资额度 +0.5×）'
            : '（下周 ' + esc(metaOf(wk.nextKey).name || wk.nextKey) + '）') +
        '</div>'
      : '';

    // 免息券按天发：perDay=0 的券商压根没有这张券，不画按钮
    const cp = b.coupon || {};
    const couponBtn = cp.perDay
      ? '<button class="mini-btn" data-act="coupon">' +
          (cp.active ? '今日利息已全免' : cp.available ? '用免息券' : '今日券已用') +
        '</button>'
      : '';

    const html =
      '<div class="card bk-card">' +
        '<div class="me-row">' +
          '<img class="broker-logo" src="/img/broker-' + esc(b.key) + '-96.png" alt="">' +
          '<div class="list-main">' +
            '<div class="list-t1">' + esc(b.name) +
              ' <span class="bk-star">' + starText(b.star, b.starMax) + '</span></div>' +
            '<div class="list-t2">' + esc(b.abbr || '') +
              ' · 拥挤度 ' + num(b.crowdPct) + '%（' + esc(b.crowdLabel || '') + '）' +
              ' · 特权强度 ' + num(b.intensity) + '%</div>' +
          '</div>' +
        '</div>' +
        '<div class="broker-tags">' +
          (b.strengths || []).map((s) => '<span class="tag tag-good">' + esc(s) + '</span>').join('') +
          (b.costs || []).map((s) => '<span class="tag tag-bad">' + esc(s) + '</span>').join('') +
        '</div>' +
        '<div class="bk-note">佣金 ' + fmtFee(b.feeRate) +
          (b.weekly && b.weekly.isStar ? '（本周半价）' : '') +
          ' · 下单冷却 ' + (num(b.cooldownMs) / 1000).toFixed(1) + 's' +
          ' · 融资 ' + num(b.leverage).toFixed(2) + '×' +
          ' · 保证金 ' + Math.round(num(b.marginRatio) * 100) + '%' +
        '</div>' +
        (priv ? '<div class="bk-priv">' + priv + '</div>' : '') +
        nextStar +
        weekly +
        '<div class="bk-acts">' +
          '<button class="mini-btn" data-act="transfer">转户</button>' +
          couponBtn +
        '</div>' +
      '</div>';
    if (box.dataset.h !== html) {
      box.dataset.h = html;
      box.innerHTML = html;
      paintBars(box);
    }
  }

  /**
   * 转户规则原文（rules.brokerMeta.transfer）。
   * 账户切片里的 account.broker.transfer 只给「这次能不能转」，不含配置项
   * （cooldownDays / freeReselectDays），文案里的天数得从规则表取。
   */
  function transferConf() {
    const st = GS.core.S.state;
    const gm = st && st.rules && st.rules.brokerMeta && st.rules.brokerMeta.transfer;
    return gm || {};
  }

  /** 转户细节一段话：费用口径与冷却天数都取服务端下发的，别在前端写死 */
  function transferNote(bk) {
    const tf = bk.transfer || {};
    const conf = transferConf();
    const days = num(tf.cooldownDays != null ? tf.cooldownDays : conf.cooldownDays) || 1;
    const freeDays = num(conf.freeReselectDays) || 1;
    const rate = (num(tf.feeRate != null ? tf.feeRate : conf.feeRate) * 100).toFixed(2) + '%';
    const cap = fmtMoney(tf.feeCap != null ? tf.feeCap : conf.feeCap == null ? 50000 : conf.feeCap);
    return (
      '<div class="bk-tf-note">转户费 = 总资产 × ' + rate + '（上限 ¥' + cap + '）' +
        ' · 冷却 ' + days + ' 个交易日 · 开户后 ' + freeDays + ' 个交易日内可免费重选 1 次' +
        (tf.freeReselectUsed ? '（本次免费重选机会已用掉）' : '') +
        '<br>转户会<b>清空离开那家与目标那家</b>的声誉星级与特权进度——回到老东家也要重新攒。</div>'
    );
  }

  /**
   * 转户弹层：六家券商逐张列出，服务端 transfer.options 已经算好每家
   * 「能不能转 / 免不免费 / 多少钱 / 为什么不能」，前端只做标注与两次点击确认
   * （移动端不用原生 confirm：样式丑、且 iOS PWA 里会被拦）。
   */
  function openTransfer() {
    const st = GS.core.S.state;
    const a = st && st.account;
    const bk = a && a.broker;
    if (!bk) return;
    const metas = brokerMetas();
    if (!metas.length) {
      GS.core.toast('券商目录还没拉到，稍后再试', 'err');
      return;
    }
    const opts = {};
    for (const o of (bk.transfer && bk.transfer.options) || []) opts[o.key] = o;

    const cards = metas
      .map((m) => {
        const o = opts[m.key] || {};
        const cur = m.key === bk.key;
        const p = m.preview || {};
        let cls = 'bk-tf-card';
        let tag = '';
        let tagCls = 'tag';
        if (cur) {
          cls += ' cur';
          tag = '当前券商';
          tagCls = 'tag tag-gold';
        } else if (o.free) {
          tag = '免费重选';
          tagCls = 'tag tag-good';
        } else if (o.ok) {
          tag = '转户费 ¥' + fmtMoney(o.fee);
        } else {
          cls += ' off';
          tag = o.reason || '暂不可转';
          tagCls = 'tag tag-bad';
        }
        const lock = cur || !o.ok;
        return (
          '<div class="' + cls + '" data-tf="' + esc(m.key) + '"' +
            (lock ? ' data-lock="1"' : '') + '>' +
            '<div class="me-row">' +
              '<img class="broker-logo" src="/img/broker-' + esc(m.key) + '-96.png" alt="">' +
              '<div class="list-main">' +
                '<div class="list-t1">' + esc(m.name) +
                  '<span class="bk-abbr">' + esc(m.abbr || '') + '</span>' +
                  (bk.weekly && bk.weekly.key === m.key ? '<span class="tag tag-gold">本周之星</span>' : '') +
                '</div>' +
                '<div class="list-t2">佣金 ' + fmtFee(p.feeRate) +
                  ' · 冷却 ' + (num(p.cooldownMs) / 1000).toFixed(1) + 's' +
                  ' · 融资 ' + num(p.leverage).toFixed(2) + '×' +
                  ' · 拥挤度 ' + num(m.crowdPct) + '%（' + esc(m.crowdLabel || '') + '）</div>' +
              '</div>' +
              '<span class="' + tagCls + '">' + esc(tag) + '</span>' +
            '</div>' +
            '<div class="broker-tags">' +
              (m.strengths || []).slice(0, 2).map((s) => '<span class="tag tag-good">' + esc(s) + '</span>').join('') +
              (m.costs || []).slice(0, 1).map((s) => '<span class="tag tag-bad">' + esc(s) + '</span>').join('') +
            '</div>' +
            (lock
              ? ''
              : '<div class="bk-tf-armed" hidden>' +
                  '<span class="bk-tf-ask">' +
                    (o.free ? '确认免费转入？' : '确认支付 ¥' + fmtMoney(o.fee) + ' 转户？') +
                    '两边星级与进度会清空' +
                  '</span>' +
                  '<button class="mini-btn primary" data-go="' + esc(m.key) + '">确认转户</button>' +
                  '<button class="mini-btn" data-cancel="1">取消</button>' +
                '</div>') +
          '</div>'
        );
      })
      .join('');

    GS.core.sheet({
      title: '转户',
      html:
        '<div class="bk-tf-head">' + esc(bk.name) + ' · ' + starText(bk.star, bk.starMax) +
          ' · 总资产 ¥' + fmtMoney(a.equity) + '</div>' +
        '<div class="bk-tf-list">' + cards + '</div>' +
        transferNote(bk),
      onMount(ctl) {
        const body = ctl.body;
        const disarm = () =>
          body.querySelectorAll('.bk-tf-armed').forEach((n) => {
            n.hidden = true;
          });
        GS.core.on(body, '[data-tf]', 'click', (e, t) => {
          // 卡片内部的确认/取消按钮自己处理，别被卡片点击冒泡抢走
          if (e.target.closest('[data-go]') || e.target.closest('[data-cancel]')) return;
          if (t.dataset.lock === '1') {
            const o = opts[t.dataset.tf] || {};
            if (t.dataset.tf !== bk.key) GS.core.toast(o.reason || '暂不可转', 'err');
            return;
          }
          const wasOpen = t.querySelector('.bk-tf-armed:not([hidden])');
          disarm();
          const armed = t.querySelector('.bk-tf-armed');
          if (armed && !wasOpen) armed.hidden = false;
        });
        GS.core.on(body, '[data-cancel]', 'click', (e, t) => {
          const armed = t.closest('.bk-tf-armed');
          if (armed) armed.hidden = true;
        });
        GS.core.on(body, '[data-go]', 'click', (e, t) => {
          submitTransfer(t, t.dataset.go, opts[t.dataset.go] || {});
        });
      },
    });
  }

  function submitTransfer(btn, key, o) {
    const name = metaOf(key).name || key;
    btn.disabled = true;
    btn.textContent = '处理中…';
    GS.api.api
      .transfer(key)
      .then((r) => {
        if (r && r.ok) {
          GS.core.toast(
            r.free ? '已免费转到 ' + name : '已转户到 ' + name + '，费用 ¥' + fmtMoney(r.fee),
            'ok'
          );
          GS.core.closeSheet();
          refreshState();
          return;
        }
        btn.disabled = false;
        btn.textContent = '确认转户';
        GS.core.toast((r && (r.error || r.reason)) || '转户失败', 'err');
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = '确认转户';
        GS.core.toast('网络异常', 'err');
      });
  }

  function useCoupon(btn) {
    const a = GS.core.S.state && GS.core.S.state.account;
    const cp = (a && a.broker && a.broker.coupon) || {};
    if (cp.active) return GS.core.toast('今天的利息已经全免了', 'ok');
    if (!cp.available) return GS.core.toast('今天的免息券已经用过了', 'err');
    if (btn) btn.disabled = true;
    GS.api.api
      .coupon()
      .then((r) => {
        if (r && r.ok) {
          GS.core.toast('今日融资 / 融券利息全免已生效', 'ok');
          refreshState();
          return;
        }
        if (btn) btn.disabled = false;
        GS.core.toast((r && r.error) || '免息券不可用', 'err');
      })
      .catch(() => {
        if (btn) btn.disabled = false;
        GS.core.toast('网络异常', 'err');
      });
  }

  /**
   * 转户/用券之后拉一次全量 state 立即刷新界面。
   * 不等下一帧 SSE：星级、特权、免息券这些字段都在账户切片里，自己改完马上看到
   * 结果比等 700ms 舒服，也避免「点了没反应」的错觉。
   */
  function refreshState() {
    return GS.api.api
      .state()
      .then((s) => {
        if (s && s.ok !== false && s.markets) {
          GS.core.S.state = s;
          GS.core.S.stateAt = Date.now();
          GS.core.emit();
        }
      })
      .catch(() => {});
  }

  function renderMenu(st, a) {
    const box = $('meMenu');
    if (!box) return;
    const canDeposit = !!(st.rules && st.rules.deposit && st.rules.deposit.enabled);
    const items = [
      { k: 'deposit', icon: '💰', label: '加钱', val: canDeposit ? '可用' : '未开放', off: !canDeposit },
      { k: 'nick', icon: '✏️', label: '改昵称', val: a.nick || '' },
      { k: 'mascot', icon: '🎀', label: '换看板娘', val: mascotName() },
      { k: 'invite', icon: '📣', label: '邀请好友', val: '' },
      { k: 'portal', icon: '🔑', label: '开放接口 API Key', val: '' },
      { k: 'rules', icon: '📖', label: '交易规则', val: '' },
      { k: 'logout', icon: '🚪', label: '退出登录', val: '' },
    ];
    // iPhone/iPad 浏览器里还没装到主屏幕：给一条引导（装了就像原生 App 全屏跑）
    const env = GS.appEnv || {};
    if (env.isIOS && !env.standalone) {
      items.unshift({ k: 'pwa', icon: '📲', label: '装到主屏幕', val: '全屏体验' });
    }
    // 壳 App 里才有 AndroidHost 桥：加「切换服务器」入口，展示当前地址
    let host = null;
    try { host = window.AndroidHost || null; } catch (e) { /* 浏览器无桥 */ }
    if (host && typeof host.changeServer === 'function') {
      let cur = '';
      try { cur = String(host.server() || ''); } catch (e) { cur = ''; }
      items.splice(5, 0, {
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

  /* ------------------------------------------------------ 添加到主屏幕引导 */

  function openPwaTip() {
    GS.core.sheet({
      title: '装到主屏幕',
      html:
        '<div class="hint">把游戏装成 iPhone 上的「App」，全屏运行、桌面图标直达：</div>' +
        '<div class="card pwa-steps">' +
          '<div class="pwa-step"><b>1.</b> 点 Safari 底部中间的「分享」按钮 <span class="pwa-glyph">⬆︎</span></div>' +
          '<div class="pwa-step"><b>2.</b> 往下滑，找到「添加到主屏幕」</div>' +
          '<div class="pwa-step"><b>3.</b> 点「添加」，回桌面就能看到韭菜图标</div>' +
        '</div>' +
        '<div class="hint">下次开盘直接从桌面进，不再占浏览器标签页。</div>',
    });
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

  GS.viewMe = {
    id: 'me',
    title: '我的',
    update,
    openDeposit,
    openAvatar,
    reset() {
      built = false;
      trail = trailFresh('');
    },
  };
})(window.GS);
