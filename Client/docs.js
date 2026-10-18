/**
 * 开放平台文档阅读页：fetch 白名单里的 markdown，用页内极简渲染器转成 HTML。
 * 不引外部库（CSP 只允许 self）；源文件同时提供 ?download=1 下载。
 */
(function () {
  'use strict';

  var DOCS = {
    player: {
      url: '/docs/player-apikey.md',
      title: '开放平台入门（玩家版）',
      file: '玩家申请APIKey.md',
    },
    api: {
      url: '/docs/openapi.md',
      title: '开放交易接口 v1 完全手册',
      file: '开放平台API.md',
    },
  };

  var $ = function (id) { return document.getElementById(id); };

  function pick() {
    var q = new URLSearchParams(location.search).get('doc');
    return DOCS[q] ? q : 'player';
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, text, href) {
        var h = String(href).trim();
        // 只放行站内与锚点，防止文档里出现奇怪外链
        if (h.charAt(0) !== '/' && h.charAt(0) !== '#' && !/^https?:\/\//i.test(h)) {
          return text;
        }
        var external = /^https?:\/\//i.test(h);
        return '<a href="' + esc(h) + '"' + (external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + text + '</a>';
      });
  }

  function renderMd(src) {
    var lines = String(src).replace(/\r\n/g, '\n').split('\n');
    var html = [];
    var i = 0;
    var listOpen = null; // 'ul' | 'ol' | null

    function closeList() {
      if (listOpen) {
        html.push('</' + listOpen + '>');
        listOpen = null;
      }
    }

    while (i < lines.length) {
      var line = lines[i];

      // 代码块
      if (/^```/.test(line)) {
        closeList();
        var lang = line.slice(3).trim();
        var buf = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        i += 1;
        html.push(
          '<pre class="docs-pre"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '><code>' +
            esc(buf.join('\n')) +
            '</code></pre>'
        );
        continue;
      }

      // 表格
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        closeList();
        var header = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim() !== '') {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        html.push('<div class="docs-table-wrap"><table class="docs-table"><thead><tr>');
        for (var c = 0; c < header.length; c += 1) html.push('<th>' + inline(header[c]) + '</th>');
        html.push('</tr></thead><tbody>');
        for (var r = 0; r < rows.length; r += 1) {
          html.push('<tr>');
          for (var k = 0; k < rows[r].length; k += 1) html.push('<td>' + inline(rows[r][k]) + '</td>');
          html.push('</tr>');
        }
        html.push('</tbody></table></div>');
        continue;
      }

      // 标题
      var hm = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hm) {
        closeList();
        var lv = hm[1].length;
        html.push('<h' + lv + ' class="docs-h' + lv + '">' + inline(hm[2]) + '</h' + lv + '>');
        i += 1;
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        closeList();
        html.push('<hr class="docs-hr">');
        i += 1;
        continue;
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        closeList();
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        html.push('<blockquote class="docs-quote">' + inline(quote.join(' ')) + '</blockquote>');
        continue;
      }

      // 列表
      var ul = /^[-*+]\s+(.*)$/.exec(line);
      var ol = /^\d+\.\s+(.*)$/.exec(line);
      if (ul || ol) {
        var kind = ul ? 'ul' : 'ol';
        if (listOpen !== kind) {
          closeList();
          html.push('<' + kind + ' class="docs-list">');
          listOpen = kind;
        }
        html.push('<li>' + inline((ul || ol)[1]) + '</li>');
        i += 1;
        continue;
      }

      // 空行
      if (line.trim() === '') {
        closeList();
        i += 1;
        continue;
      }

      // 段落（连续非空行合并）
      closeList();
      var para = [line];
      i += 1;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^```/.test(lines[i]) &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !/^[-*+]\s+/.test(lines[i]) &&
        !/^\d+\.\s+/.test(lines[i]) &&
        !/^\s*>/.test(lines[i])
      ) {
        para.push(lines[i]);
        i += 1;
      }
      html.push('<p class="docs-p">' + inline(para.join(' ')) + '</p>');
    }
    closeList();
    return html.join('\n');
  }

  function splitRow(row) {
    var t = String(row).trim().replace(/^\|/, '').replace(/\|$/, '');
    // 简单按 | 切；文档里没有转义竖线的用法
    return t.split('|').map(function (x) { return x.trim(); });
  }

  function load() {
    var key = pick();
    var meta = DOCS[key];
    var body = $('docBody');
    var dl = $('downloadBtn');
    var path = location.pathname.replace(/\/$/, '') || '/docs.html';

    document.title = meta.title + ' · 我是股神';
    $('docMeta').textContent = meta.file;
    dl.href = meta.url + '?download=1';
    $('tabPlayer').classList.toggle('active', key === 'player');
    $('tabApi').classList.toggle('active', key === 'api');

    // 当前 tab 的 href 保留 ?doc=
    $('tabPlayer').setAttribute('href', path + '?doc=player');
    $('tabApi').setAttribute('href', path + '?doc=api');

    body.innerHTML = '<p class="docs-empty">正在加载文档…</p>';
    fetch(meta.url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        body.innerHTML = '<article class="docs-article">' + renderMd(text) + '</article>';
      })
      .catch(function () {
        body.innerHTML =
          '<p class="docs-empty docs-error">文档加载失败。请确认服务在跑，或直接访问 <code>' +
          meta.url +
          '</code>。</p>';
      });
  }

  load();
})();
