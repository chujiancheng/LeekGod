/**
 * 独立页（/stats.html /whales.html）的主题还原。
 * 必须是外部脚本：CSP 是 script-src 'self'（见 Server/src/http.js），内联 <script>
 * 会被静默拦截——之前这两页把这段写在 <head> 里，浅色主题在独立页上一直没生效。
 * 同步外链放在 <head> 里、CSS link 之前执行，首屏不会闪黑底。
 */
(function () {
  try {
    var theme = localStorage.getItem('gushen_theme');
    if (theme) document.documentElement.dataset.theme = theme;
  } catch (e) { /* 隐私模式等场景忽略 */ }
})();
