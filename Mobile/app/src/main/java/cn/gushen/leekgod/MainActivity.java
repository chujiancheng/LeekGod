package cn.gushen.leekgod;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * 股神请就位 —— Android WebView 壳。
 *
 * 纯 framework 实现（零第三方依赖）：远端模式，加载游戏服务器上的 /m/ 移动端页面。
 * 服务器地址存本地，首次启动预填 gradle.properties 里的 gushenServerUrl。
 *
 * 玩家可见行为：
 *  - 首次启动弹一次「服务器地址」输入框；
 *  - 断网 / 服务器不在时进入内置离线页，可一键重试或改地址；
 *  - 物理返回键：先关 App 内的弹层/二级页（复用页面自己的 GS.core 逻辑），
 *    到根部再按一次退出；
 *  - 隐藏入口：长按屏幕左上角 1.2 秒，随时改服务器地址。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "gushen";
    private static final String KEY_URL = "server_url";

    private WebView web;
    private SharedPreferences prefs;
    /** 当前游戏服根地址（不带 /m/） */
    private String base = "";
    private long lastBackAt = 0;
    private float touchDownX;
    private float touchDownY;
    private long touchDownAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#080b10"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // localStorage：登录态存这里
        s.setDatabaseEnabled(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);        // 内置离线页走 file:///android_asset
        if (Build.VERSION.SDK_INT >= 21) {
            // 服务器目前是 http 直连，允许混合内容兜底
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        // 服务端日志里能认出这是壳 App 的流量
        s.setUserAgentString(s.getUserAgentString() + " GushenApp/" + BuildConfig.VERSION_NAME);
        // 桌面 Chrome chrome://inspect 可直接调试页面
        WebView.setWebContentsDebuggingEnabled(true);

        web.addJavascriptInterface(new Bridge(), "AndroidHost");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                return handleExternal(req.getUrl());
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showOffline();
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest req,
                                            android.webkit.WebResourceResponse resp) {
                if (req.isForMainFrame() && resp.getStatusCode() >= 500) showOffline();
            }
        });

        // 长按左上角 1.2s 改服务器地址（隐藏入口，不占 UI）
        web.setOnTouchListener((v, e) -> {
            if (e.getAction() == MotionEvent.ACTION_DOWN) {
                touchDownX = e.getX();
                touchDownY = e.getY();
                touchDownAt = System.currentTimeMillis();
            } else if (e.getAction() == MotionEvent.ACTION_UP) {
                float dp = getResources().getDisplayMetrics().density;
                if (touchDownX < 56 * dp && touchDownY < 56 * dp
                        && System.currentTimeMillis() - touchDownAt > 1200) {
                    askServer(defaultUrl());
                    return true;
                }
            }
            return false;
        });

        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        String saved = prefs.getString(KEY_URL, "").trim();
        if (saved.isEmpty()) askServer(defaultUrl());
        else loadSite(saved);
    }

    /** gradle.properties 里的内置默认地址 */
    private String defaultUrl() {
        return BuildConfig.SERVER_URL;
    }

    /** 地址规范化：补协议、去尾部斜杠。返回 null 表示格式不合法 */
    private static String normalize(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (u.isEmpty()) return null;
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u.matches("https?://\\S+") ? u : null;
    }

    private void loadSite(String rawBase) {
        String n = normalize(rawBase);
        if (n == null) {
            Toast.makeText(this, "地址格式不对", Toast.LENGTH_SHORT).show();
            askServer(defaultUrl());
            return;
        }
        base = n;
        prefs.edit().putString(KEY_URL, base).apply();
        web.loadUrl(base + "/m/");
    }

    /** http/https 一律留在 WebView 里；其他 scheme 交给系统 */
    private boolean handleExternal(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (scheme.equals("http") || scheme.equals("https")) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
        }
        return true;
    }

    private void showOffline() {
        web.loadUrl("file:///android_asset/offline.html");
    }

    /** 服务器地址输入框 */
    private void askServer(String prefill) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setHint("例如 http://192.168.1.9:3000");
        input.setText(prefill == null ? "" : prefill);
        input.setSelection(input.getText().length());

        new AlertDialog.Builder(this)
                .setTitle("服务器地址")
                .setMessage("填游戏服务器根地址，App 会加载它的移动端页面 /m/")
                .setView(input)
                .setCancelable(false)
                .setPositiveButton("进入", (d, w) -> {
                    String v = input.getText().toString();
                    if (normalize(v) == null) {
                        Toast.makeText(this, "地址格式不对", Toast.LENGTH_SHORT).show();
                        askServer(v);
                        return;
                    }
                    loadSite(v);
                })
                .setNegativeButton("退出", (d, w) -> finish())
                .show();
    }

    /**
     * 返回键：问页面「弹层/二级页开没开」，开着就先关；到根部双击退出。
     * 逻辑与 web 端 core.js 的 popstate 拦截同一口径。
     */
    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
            "(function(){try{var s=document.getElementById('sheet'),p=document.getElementById('page');"
            + "if(s&&!s.hidden){if(window.GS&&GS.core)GS.core.closeSheet();return 'y';}"
            + "if(p&&!p.hidden){if(window.GS&&GS.core)GS.core.closePage();return 'y';}"
            + "return 'n';}catch(e){return 'n';}})()",
            value -> {
                if (value != null && value.contains("y")) return;   // 页面自己消费了
                long now = System.currentTimeMillis();
                if (now - lastBackAt < 2000) {
                    finish();
                } else {
                    lastBackAt = now;
                    Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show();
                }
            });
    }

    /** 暴露给内置离线页的桥 */
    public class Bridge {
        /** 重试当前服务器 */
        @JavascriptInterface
        public void retry() {
            runOnUiThread(() -> {
                if (!base.isEmpty()) web.loadUrl(base + "/m/");
                else askServer(defaultUrl());
            });
        }

        /** 改服务器地址 */
        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> askServer(base.isEmpty() ? defaultUrl() : base));
        }

        /** 当前服务器地址（离线页展示用） */
        @JavascriptInterface
        public String server() {
            return base;
        }
    }
}
