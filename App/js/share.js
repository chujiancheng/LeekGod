/* ==========================================================================
   share.js — 分享：文字分享 + canvas 战绩卡图片分享
   App 壳里走 AndroidHost 桥拉起系统分享面板（用户选微信/QQ 等）；
   浏览器里退化成 Web Share API / 复制到剪贴板 / 下载图片。
   分享卡是纯 canvas 绘制（CSP 不限制 canvas），头像等图片与页面同源，
   不会污染画布，toDataURL 可直接导出。
   ========================================================================== */
(function (GS) {
  'use strict';

  const { fmtAmt, fmtMoney, fmtP, fmtPct, fmtChg, cls, num } = GS.core;

  /* ------------------------------------------------------------- 桥 / 环境 */

  function host() {
    try {
      if (window.AndroidHost && typeof window.AndroidHost.shareImage === 'function') {
        return window.AndroidHost;
      }
    } catch (e) { /* 浏览器无桥 */ }
    return null;
  }

  /** 站点链接（分享文案尾部带上）：壳 App 用桥里的服务器地址，网页用当前 origin */
  function siteUrl() {
    try {
      const h = window.AndroidHost;
      const s = h && typeof h.server === 'function' ? String(h.server() || '') : '';
      if (s) return s;
    } catch (e) { /* 忽略 */ }
    return location.origin;
  }

  /* --------------------------------------------------------------- 文字 */

  /** 文字分享：App 内系统分享面板 → Web Share → 复制剪贴板 */
  function text(t) {
    const s = String(t || '').trim();
    if (!s) return;
    const h = host();
    if (h && typeof h.shareText === 'function') {
      h.shareText(s);
      return;
    }
    if (navigator.share) {
      navigator.share({ text: s }).catch(() => { /* 用户取消忽略 */ });
      return;
    }
    copy(s);
  }

  function copy(s) {
    const done = () => GS.core.toast('已复制，去微信粘贴吧', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done, () => fallbackCopy(s, done));
    } else {
      fallbackCopy(s, done);
    }
  }

  function fallbackCopy(s, done) {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.className = 'share-copy-ta';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      GS.core.toast('复制失败', 'err');
    }
    ta.remove();
  }

  /* --------------------------------------------------------------- 图片 */

  /** 图片分享：canvas 导出 PNG。App 内走桥，浏览器退化成 Web Share 文件 / 下载 */
  function image(canvas, fileName) {
    if (!canvas) return;
    const name = fileName || 'share.png';
    const h = host();
    if (h && typeof h.shareImage === 'function') {
      let data;
      try {
        data = canvas.toDataURL('image/png').split(',')[1];
      } catch (e) {
        GS.core.toast('生成分享图失败', 'err');
        return;
      }
      h.shareImage(data, name);
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      const f = new File([blob], name, { type: 'image/png' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [f] })) {
        navigator.share({ files: [f] }).catch(() => { /* 取消忽略 */ });
        return;
      }
      // 浏览器最后兜底：下载
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      GS.core.toast('分享图已下载', 'ok');
    });
  }

  /* ------------------------------------------------------------ 战绩卡 */

  /** 常用色（A 股口径：涨红跌绿） */
  const C = {
    red: '#d92f27',
    green: '#159957',
    ink: '#1c2330',
    sub: '#7a8598',
    line: '#dfe5ee',
    brand: '#2f8fe0',
  };
  /** canvas 上下文里画圆角矩形 */
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /** 同源图片加载（失败不阻塞，画占位圈） */
  function loadImg(src) {
    return new Promise((ok) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => ok(null);
      im.src = src;
    });
  }

  /** 我的排名（players 已按总资产降序，与排行页口径一致）；不在榜返回 0 */
  function myRank() {
    const st = GS.core.S.state;
    const players = (st && st.players) || [];
    for (let i = 0; i < players.length; i += 1) {
      if (players[i].account === GS.core.S.account) return i + 1;
    }
    return 0;
  }

  /**
   * 注册玩家总数。注意 state.players 是服务端榜单**截断后的前 50 名**
   * （game.js leaderboard(limit=50)），不能拿它的 length 当全服人数——
   * 用 state.online（服务端 store.playerCount，注册账户总数；字段名是遗留），
   * 老服务没这字段时才退回榜单长度。
   */
  function totalPlayers() {
    const st = GS.core.S.state;
    const n = num(st && st.online);
    return n > 0 ? n : ((st && st.players) || []).length;
  }

  /**
   * 生成战绩卡（750×1000，2x 密度）：
   * 头像 + 昵称 + 境界 · 第 N 交易日 + 总资产大字 + 浮动盈亏 + 全服名次。
   * 返回 Promise<canvas>，失败 resolve null。
   */
  function statCard() {
    const st = GS.core.S.state;
    const a = st && st.account;
    if (!a) return Promise.resolve(null);

    const W = 750;
    const H = 1000;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');

    const ava = (a.avatar && a.avatar.key) || 'auntie';
    const equity = num(a.equity);
    const float = num(a.longPnl) + num(a.shortPnl);
    const base = num(st.rules && st.rules.initialCash);
    const day = num(st.day && st.day.day);
    const realm = (a.realm && a.realm.name) || '';
    const broker = a.broker && a.broker.name ? a.broker.name : '';
    const rank = myRank();
    const players = totalPlayers();
    const eqCls = cls(equity - base);

    // 背景：浅蓝渐变 + 右上一点品牌色光晕
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#f6f9fd');
    bg.addColorStop(1, '#e9eef8');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    const glow = g.createRadialGradient(W * 0.92, 60, 20, W * 0.92, 60, 460);
    glow.addColorStop(0, 'rgba(47,143,224,0.16)');
    glow.addColorStop(1, 'rgba(47,143,224,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);

    // 顶栏：游戏名 + 模拟盘标注
    g.fillStyle = C.ink;
    g.font = '700 46px sans-serif';
    g.textAlign = 'center';
    g.fillText('股神请就位', W / 2, 120);
    g.fillStyle = C.sub;
    g.font = '400 26px sans-serif';
    g.fillText('韭菜进化论 · 模拟盘', W / 2, 165);

    // 头像（圆 + 白描边）
    const cx = W / 2;
    const cy = 320;
    const r = 96;
    return loadImg('/img/avatar-' + ava + '-192.png').then((im) => {
      g.save();
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.closePath();
      g.fillStyle = '#ffffff';
      g.fill();
      if (im) {
        g.save();
        g.clip();
        g.drawImage(im, cx - r, cy - r, r * 2, r * 2);
        g.restore();
      } else {
        g.fillStyle = C.brand;
        g.font = '700 80px sans-serif';
        g.fillText((a.nick || '?').slice(0, 1), cx, cy + 28);
      }
      g.lineWidth = 8;
      g.strokeStyle = '#ffffff';
      g.beginPath();
      g.arc(cx, cy, r + 4, 0, Math.PI * 2);
      g.stroke();
      g.restore();

      // 昵称 + 境界/券商/交易日
      g.fillStyle = C.ink;
      g.font = '700 42px sans-serif';
      g.fillText(String(a.nick || a.account || ''), cx, 505);
      g.fillStyle = C.sub;
      g.font = '400 28px sans-serif';
      const meta = [realm, broker, day ? '第 ' + day + ' 交易日' : ''].filter(Boolean).join(' · ');
      g.fillText(meta, cx, 556);

      // 资产面板
      roundRect(g, 70, 610, W - 140, 250, 28);
      g.fillStyle = '#ffffff';
      g.fill();
      g.strokeStyle = C.line;
      g.lineWidth = 2;
      g.stroke();

      g.textAlign = 'left';
      g.fillStyle = C.sub;
      g.font = '400 26px sans-serif';
      g.fillText('总资产', 110, 665);
      g.fillStyle = eqCls === 'down' ? C.green : eqCls === 'up' ? C.red : C.ink;
      g.font = '700 76px sans-serif';
      g.fillText('¥' + fmtMoney(equity), 110, 750);
      const fTxt = '浮动盈亏 ' + (float >= 0 ? '+' : '') + fmtAmt(float);
      g.fillStyle = float > 0 ? C.red : float < 0 ? C.green : C.sub;
      g.font = '600 32px sans-serif';
      g.fillText(fTxt, 110, 810);

      g.textAlign = 'right';
      g.fillStyle = C.ink;
      g.font = '700 40px sans-serif';
      g.fillText(rank ? '第 ' + rank + ' 名' : '未进前 50', W - 110, 730);
      g.fillStyle = C.sub;
      g.font = '400 26px sans-serif';
      g.fillText('全服 ' + players + ' 位玩家', W - 110, 775);

      // 底部：slogan + 链接
      g.textAlign = 'center';
      g.fillStyle = C.sub;
      g.font = '400 24px sans-serif';
      g.fillText('模拟盘游戏 · 行情与资金均为虚构 · 不构成投资建议', cx, 930);
      g.fillStyle = C.brand;
      g.font = '600 30px sans-serif';
      g.fillText('来和我同台竞技：' + siteUrl(), cx, 972);

      return cv;
    }).catch(() => null);
  }

  /** 一键：生成战绩卡 → 走图片分享 */
  function shareStatCard() {
    GS.core.toast('生成战绩卡…');
    return statCard().then((cv) => {
      if (!cv) return;
      image(cv, 'gushen-stats.png');
    });
  }

  /* ------------------------------------------------------- 文案（三件套） */

  /** 排行页「晒排名」 */
  function rankText() {
    const st = GS.core.S.state;
    const a = st && st.account;
    if (!a) return;
    const rank = myRank();
    const players = totalPlayers();
    if (!rank) {
      GS.core.toast('你还没进前 50，先买一笔冲冲榜再来晒', 'err');
      return;
    }
    const t =
      '第 ' + num(st.day && st.day.day) + ' 交易日，我以 ¥' + fmtMoney(num(a.equity)) +
      ' 的总资产排全服第 ' + rank + ' 名（共 ' + players + ' 人），境界「' +
      ((a.realm && a.realm.name) || '—') + '」。来《股神请就位》和我同台竞技：' + siteUrl();
    text(t);
  }

  /** 个股页分享当前行情 */
  function stockText(stockId) {
    const m = GS.core.market(stockId);
    if (!m) return;
    const t =
      '《股神请就位》模拟盘 ' + (m.name || stockId) + '（' + stockId + '）现价 ' +
      fmtP(m.last) + '，今日 ' + fmtChg(m.change) + '（' + fmtPct(m.changePct) + '）。' +
      '零门槛开户随便炒：' + siteUrl();
    text(t);
  }

  /** 我的页「邀请好友」 */
  function inviteText() {
    const st = GS.core.S.state;
    const a = st && st.account;
    const day = st ? num(st.day && st.day.day) : 0;
    const eq = a ? fmtAmt(a.equity) : '';
    const t =
      '我在玩《股神请就位》——人人都可当股神的模拟炒股游戏' +
      (a ? '，已经玩到第 ' + day + ' 个交易日，总资产 ' + eq : '') +
      '。NPC 游资、券商自营全在盘中博弈，快来开户当股神：' + siteUrl();
    text(t);
  }

  GS.share = { text, image, statCard, shareStatCard, rankText, stockText, inviteText };
})(window.GS);
