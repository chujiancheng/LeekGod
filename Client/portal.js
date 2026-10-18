/**
 * 开放平台页：自助签发 / 查看 / 撤销 API Key
 *
 * 鉴权用**网页登录态**（localStorage 的 gushen_token），只操作自己的 Key。
 * 明文只在「生成」的响应里出现一次，服务器只存哈希，所以页面不做任何"再看一眼"。
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'gushen_token';
  var THEME_KEY = 'gushen_theme';

  var $ = function (id) { return document.getElementById(id); };
  var token = '';
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; }

  // 跟随主页选过的主题（没选过就用默认「深夜终端」）
  try {
    var theme = localStorage.getItem(THEME_KEY);
    if (theme) document.documentElement.setAttribute('data-theme', theme);
  } catch (e) { /* 隐私模式忽略 */ }

  var state = { cap: 8, keys: [], busy: false };

  function api(method, path, body) {
    var headers = {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    };
    return fetch(path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data || {} };
      });
    });
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function show(el, visible) {
    if (el) el.hidden = !visible;
  }

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'portal-msg' + (kind ? ' ' + kind : '');
  }

  function showLogin() {
    show($('loginHint'), true);
    show($('createCard'), false);
    show($('keysCard'), false);
    show($('quickCard'), false);
    $('whoami').textContent = '未登录';
  }

  function scopesTag(scopes) {
    var span = document.createElement('span');
    var trade = String(scopes || '').indexOf('trade') >= 0;
    span.className = 'tag ' + (trade ? 'trade' : 'read');
    span.textContent = trade ? 'read,trade' : 'read';
    return span;
  }

  function renderKeys() {
    var body = $('keysBody');
    body.textContent = '';
    var live = state.keys.filter(function (k) { return !k.revoked; });

    show($('keysEmpty'), live.length === 0);
    show($('keysWrap'), live.length > 0);
    $('quotaNote').textContent = live.length + ' / ' + state.cap + ' 把';

    live.forEach(function (k) {
      var tr = document.createElement('tr');

      var id = document.createElement('td');
      id.className = 'mono';
      id.textContent = k.id;

      var label = document.createElement('td');
      label.textContent = k.label || '—';

      var scopes = document.createElement('td');
      scopes.appendChild(scopesTag(k.scopes));

      var created = document.createElement('td');
      created.className = 'mono';
      created.textContent = fmtDate(k.createdAt);

      var used = document.createElement('td');
      used.className = 'mono';
      used.textContent = k.lastUsedAt ? fmtDate(k.lastUsedAt) : '从未';

      var op = document.createElement('td');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'portal-btn danger';
      btn.textContent = '撤销';
      btn.addEventListener('click', function () { revoke(k.id); });
      op.appendChild(btn);

      tr.appendChild(id);
      tr.appendChild(label);
      tr.appendChild(scopes);
      tr.appendChild(created);
      tr.appendChild(used);
      tr.appendChild(op);
      body.appendChild(tr);
    });
  }

  function quickCode() {
    var base = location.origin;
    $('quickCode').textContent =
      "export GUSHEN_API_KEY='gs_你的Key'\n" +
      'export GUSHEN_BASE=\'' + base + "'\n" +
      'curl -s -H "X-API-Key: $GUSHEN_API_KEY" $GUSHEN_BASE/open/v1/ping\n' +
      '# 看到 "ok": true 就通了';
  }

  function load() {
    return api('GET', '/api/open/keys').then(function (r) {
      if (r.status === 401) { showLogin(); return; }
      if (!r.data.ok) {
        $('whoami').textContent = '读取失败：' + (r.data.error || ('HTTP ' + r.status));
        return;
      }
      state.cap = r.data.cap || 8;
      state.keys = r.data.keys || [];
      $('whoami').textContent = '账号 ' + r.data.account + ' · 已登录';
      show($('loginHint'), false);
      show($('createCard'), true);
      show($('keysCard'), true);
      show($('quickCard'), true);
      quickCode();
      renderKeys();
    }).catch(function () {
      $('whoami').textContent = '网络异常，刷新试试';
    });
  }

  function openSecret(key) {
    $('secretValue').textContent = key;
    setMsg($('copyMsg'), '');
    show($('secretModal'), true);
  }

  function closeSecret() {
    show($('secretModal'), false);
    $('secretValue').textContent = '';
    setMsg($('copyMsg'), '');
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.className = 'portal-copy-helper';
    ta.value = text;
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function create(ev) {
    if (ev) ev.preventDefault();
    if (state.busy) return;
    state.busy = true;
    var btn = $('createBtn');
    btn.disabled = true;
    setMsg($('createMsg'), '生成中…');

    api('POST', '/api/open/keys', {
      label: $('labelInput').value.trim(),
      scopes: $('scopesSelect').value
    }).then(function (r) {
      if (r.status === 401) { showLogin(); return; }
      if (!r.data.ok) {
        setMsg($('createMsg'), r.data.error || ('生成失败（HTTP ' + r.status + '）'), 'error');
        return;
      }
      setMsg($('createMsg'), '已生成 KeyID ' + r.data.id, 'ok');
      $('labelInput').value = '';
      openSecret(r.data.key);
      load();
    }).catch(function () {
      setMsg($('createMsg'), '网络异常，请重试', 'error');
    }).then(function () {
      state.busy = false;
      btn.disabled = false;
    });
  }

  function revoke(id) {
    if (state.busy) return;
    if (!window.confirm('撤销 KeyID ' + id + '？\n撤销后立即失效，无法恢复；正在跑的策略下一次请求就会 401。')) return;
    state.busy = true;
    api('DELETE', '/api/open/keys/' + encodeURIComponent(id), {}).then(function (r) {
      if (r.status === 401) { showLogin(); return; }
      if (!r.data.ok) {
        setMsg($('createMsg'), r.data.error || '撤销失败', 'error');
        return;
      }
      setMsg($('createMsg'), '已撤销 ' + id, 'ok');
      load();
    }).catch(function () {
      setMsg($('createMsg'), '网络异常，请重试', 'error');
    }).then(function () { state.busy = false; });
  }

  function bind() {
    $('createForm').addEventListener('submit', create);
    $('refreshBtn').addEventListener('click', function () { load(); });
    $('closeModalBtn').addEventListener('click', closeSecret);
    $('copyBtn').addEventListener('click', function () {
      var text = $('secretValue').textContent || '';
      if (!text) return;
      copyText(text).then(function (ok) {
        setMsg($('copyMsg'), ok ? '已复制，去存进环境变量' : '复制失败，请手动选中上面的 Key', ok ? 'ok' : 'error');
      });
    });
  }

  bind();
  quickCode();
  if (!token) showLogin();
  else load();
})();
