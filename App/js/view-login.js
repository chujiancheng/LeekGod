/* ==========================================================================
   view-login.js — 登录 / 开户（全屏，两步）
   第一步只认账号（身份凭据）；没开过户才进第二步：起昵称 + 选券商
   ========================================================================== */
(function (GS) {
  'use strict';

  const { $, esc, toast } = GS.core;
  const api = GS.api;

  const ACCOUNT_RE = /^[A-Za-z][A-Za-z0-9_-]{2,31}$/;
  const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9_\-·]{2,12}$/;

  let brokers = [];
  let picked = '';

  function shell() {
    return $('loginBody');
  }

  function brandHtml() {
    return (
      '<div class="login-brand">' +
        '<div class="login-title">股神<b>请就位</b></div>' +
        '<div class="login-sub">韭 菜 进 化 论</div>' +
      '</div>'
    );
  }

  /* ------------------------------------------------------------ 第一步 */

  function stepAccount(prefill) {
    shell().innerHTML =
      brandHtml() +
      '<div class="login-card">' +
        '<div class="step-tip">账号即身份，无需密码。第一次进来会自动开户。</div>' +
        '<div class="field">' +
          '<span class="field-label">账号</span>' +
          '<input id="accInput" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
            'placeholder="字母开头，3~32 位" value="' + esc(prefill || '') + '">' +
        '</div>' +
        '<div class="field-hint" id="accHint">开局送你 100 万虚拟资金</div>' +
        '<button class="btn-primary" id="accBtn">进入交易大厅</button>' +
      '</div>' +
      '<div class="hint login-foot">' +
        '本游戏为模拟盘，所有资金与行情均为虚构，不构成任何投资建议' +
      '</div>';

    const input = $('accInput');
    const btn = $('accBtn');

    btn.onclick = () => submitAccount(input.value.trim());

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAccount(input.value.trim());
    });
    input.addEventListener('input', () => {
      const v = input.value.trim();
      $('accHint').textContent = !v
        ? '开局送你 100 万虚拟资金'
        : ACCOUNT_RE.test(v)
          ? '格式正确，点下面按钮进入'
          : '账号需字母开头，3~32 位英文/数字/下划线/连字符';
    });
  }

  function submitAccount(account) {
    if (!ACCOUNT_RE.test(account)) {
      toast('账号格式不对：字母开头，3~32 位英文/数字/下划线', 'err');
      return;
    }
    const btn = $('accBtn');
    if (btn.disabled) return; // 慢网双击防重：请求在途时忽略再次触发
    btn.disabled = true;
    btn.textContent = '正在登录…';

    api
      .api.login(account)
      .then((r) => {
        btn.disabled = false;
        btn.textContent = '进入交易大厅';
        if (r && r.ok) {
          api.setIdentity(r.account, r.nick, r.token);
          GS.app.enter();
          return;
        }
        if (r && r.needOnboard) {
          api.setIdentity(r.account || account, '', '');
          stepOnboard(r.account || account);
          return;
        }
        toast((r && r.error) || '登录失败', 'err');
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = '进入交易大厅';
        toast('连不上服务器，检查网络', 'err');
      });
  }

  /* ------------------------------------------------------------ 第二步 */

  function stepOnboard(account) {
    shell().innerHTML =
      '<div class="login-brand">' +
        '<div class="login-title">开 个 <b>户</b></div>' +
        '<div class="login-sub">选一家券商，决定你的命</div>' +
      '</div>' +
      '<div class="login-card">' +
        '<div class="field">' +
          '<span class="field-label">昵称</span>' +
          '<input id="nickInput" autocomplete="off" placeholder="2~12 位，中文可用">' +
        '</div>' +
        '<div class="field-hint" id="nickHint">昵称可以随时改，账号不行</div>' +
        '<div class="sec-title">选择券商</div>' +
        '<div class="broker-list" id="brokerList">' +
          '<div class="skel skel-row"></div>' +
        '</div>' +
        '<button class="btn-primary" id="obBtn" disabled>开户并领取 100 万</button>' +
      '</div>';

    const nick = $('nickInput');
    const btn = $('obBtn');

    api
      .api.brokers()
      .then((r) => {
        brokers = (r && r.brokers) || [];
        renderBrokers();
      })
      .catch(() => {
        $('brokerList').innerHTML = '<div class="empty">券商目录拉取失败，检查网络</div>';
      });

    nick.addEventListener('input', () => {
      const v = nick.value.trim();
      $('nickHint').textContent = NICK_RE.test(v) ? '好名字' : '2~12 位，中文/字母/数字';
      syncBtn();
    });

    btn.onclick = () => {
      if (btn.disabled) return; // 慢网双击防重：两次成功回调会各进一次壳，第二次 enter 会清空页面
      const v = nick.value.trim();
      if (!NICK_RE.test(v)) return toast('昵称 2~12 位，中文/字母/数字', 'err');
      if (!picked) return toast('先选一家券商', 'err');
      btn.disabled = true;
      btn.textContent = '开户中…';
      api
        .api.onboard(account, v, picked)
        .then((r) => {
          btn.disabled = false;
          btn.textContent = '开户并领取 100 万';
          if (r && r.ok) {
            api.setIdentity(r.account, r.nick, r.token);
            GS.app.enter();
            return;
          }
          toast((r && r.error) || '开户失败', 'err');
        })
        .catch(() => {
          btn.disabled = false;
          btn.textContent = '开户并领取 100 万';
          toast('连不上服务器', 'err');
        });
    };

    function syncBtn() {
      btn.disabled = !(NICK_RE.test(nick.value.trim()) && picked);
    }

    function renderBrokers() {
      const box = $('brokerList');
      if (!box) return;
      box.innerHTML = brokers
        .map((b) => {
          const p = b.preview || {};
          return (
            '<div class="broker-item' + (picked === b.key ? ' on' : '') + '" data-broker="' + esc(b.key) + '">' +
              '<img class="broker-logo" src="/img/broker-' + esc(b.key) + '-96.png" alt="">' +
              '<div class="broker-main">' +
                '<div class="broker-name">' + esc(b.name) + '</div>' +
                '<div class="broker-desc">' + esc(b.slogan || b.persona || '') + '</div>' +
                '<div class="broker-tags">' +
                  '<span class="tag">佣金 ' + (p.feeRate != null ? (p.feeRate * 10000).toFixed(1) + '‱' : '—') + '</span>' +
                  '<span class="tag">冷却 ' + ((p.cooldownMs || 0) / 1000).toFixed(1) + 's</span>' +
                  '<span class="tag ' + (b.crowdPct >= 45 ? 'tag-bad' : 'tag-good') + '">' +
                    esc(b.crowdLabel || '') + ' ' + esc(String(b.crowdPct || 0)) + '%</span>' +
                '</div>' +
              '</div>' +
            '</div>'
          );
        })
        .join('');

      GS.core.on(box, '[data-broker]', 'click', (e, t) => {
        picked = t.dataset.broker;
        box.querySelectorAll('.broker-item').forEach((el) => el.classList.remove('on'));
        t.classList.add('on');
        syncBtn();
      });
    }
  }

  /* ---------------------------------------------------------------- 导出 */

  const view = {
    /** 打开登录（可带账号预填） */
    open(prefill) {
      $('login').hidden = false;
      $('shell').hidden = true;
      stepAccount(prefill || '');
    },
    /** 直接进开户第二步（服务端说没开过户） */
    openOnboard(account) {
      $('login').hidden = false;
      $('shell').hidden = true;
      stepOnboard(account);
    },
    hide() {
      $('login').hidden = true;
      shell().innerHTML = '';
    },
  };

  GS.viewLogin = view;
})(window.GS);
