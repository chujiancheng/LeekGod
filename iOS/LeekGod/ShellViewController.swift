/* ==========================================================================
   ShellViewController.swift — WKWebView 壳
   --------------------------------------------------------------------------
   与 Android 壳（Mobile/）能力对齐，页面代码零改动：
   - 加载 <server>/m/ 移动端页面，全屏（页面自己吃 safe-area，见 viewport-fit=cover）
   - 服务器地址：UserDefaults("server_url") > Info.plist GushenServerUrl（CI 可注入）
   - 断网 / 连不上 → 内置离线页 Offline.html（重试 / 换地址）
   - JS 桥：注入 window.AndroidHost（server / retry / changeServer / shareText / shareImage），
     前端 share.js、view-me.js 已有这套约定，iOS 侧同名实现即可复用
   - 换地址：长按屏幕左上角 1.2 秒，或「我的」页「切换服务器」
   - 分享：UIActivityViewController（微信/QQ 等系统面板，不引第三方 SDK）
   ========================================================================== */
import UIKit
import WebKit

final class ShellViewController: UIViewController {

    private var webView: WKWebView!
    private var bridgeProxy: BridgeProxy?
    private let storeKey = "server_url"

    /// 当前服务器地址（已规范化，无尾斜杠）。空 = 还没设置。
    private var server = ""
    private var didAskServer = false

    // MARK: - 生命周期

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.957, green: 0.961, blue: 0.969, alpha: 1)
        overrideUserInterfaceStyle = .light
        setupWebView()

        server = storedServer()
        if server.isEmpty {
            loadOffline()
        } else {
            loadSite()
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // 装好后第一次打开且构建时没注入地址：在这里弹（viewDidLoad 里 present 时视图还没进窗口）
        if server.isEmpty && !didAskServer {
            didAskServer = true
            askServer()
        }
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "gushen")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .darkContent
    }

    // MARK: - WebView

    private func setupWebView() {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []

        let proxy = BridgeProxy()
        proxy.target = self
        cfg.userContentController.add(proxy, name: "gushen")
        bridgeProxy = proxy

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.translatesAutoresizingMaskIntoConstraints = false
        wv.navigationDelegate = self
        wv.allowsLinkPreview = false
        wv.allowsBackForwardNavigationGestures = false
        // 页面自己用 env(safe-area-inset-*) 排安全区，别让 WKWebView 再叠一层
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.bounces = false
        wv.scrollView.alwaysBounceVertical = false
        if #available(iOS 16.4, *) {
            wv.isInspectable = true
        }
        view.addSubview(wv)
        NSLayoutConstraint.activate([
            wv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            wv.topAnchor.constraint(equalTo: view.topAnchor),
            wv.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        webView = wv

        // 隐藏入口：长按左上角 1.2 秒换服务器（与安卓壳一致）
        let lp = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        lp.minimumPressDuration = 1.2
        lp.cancelsTouchesInView = false
        lp.delegate = self
        wv.addGestureRecognizer(lp)
    }

    // MARK: - 地址

    private func storedServer() -> String {
        let saved = UserDefaults.standard.string(forKey: storeKey) ?? ""
        if !saved.isEmpty {
            return normalize(saved)
        }
        let plist = (Bundle.main.object(forInfoDictionaryKey: "GushenServerUrl") as? String) ?? ""
        return normalize(plist)
    }

    /// 补协议头、去尾斜杠；占位符（__GUSHEN_SERVER_URL__）当空处理
    private func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty || s.hasPrefix("__") {
            return ""
        }
        let low = s.lowercased()
        if !low.hasPrefix("http://") && !low.hasPrefix("https://") {
            s = "http://" + s
        }
        while s.hasSuffix("/") {
            s.removeLast()
        }
        return s
    }

    private func loadSite() {
        guard !server.isEmpty else {
            loadOffline()
            return
        }
        injectBridge()
        guard let url = URL(string: server + "/m/") else {
            loadOffline()
            return
        }
        webView.load(URLRequest(url: url, timeoutInterval: 15))
    }

    private func loadOffline() {
        // 离线页也要能用桥：显示当前地址、重试、换地址
        injectBridge()
        guard let file = Bundle.main.url(forResource: "Offline", withExtension: "html") else {
            return
        }
        webView.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
    }

    @objc private func handleLongPress(_ g: UILongPressGestureRecognizer) {
        guard g.state == .began else { return }
        let p = g.location(in: webView)
        // 只认左上角一小块，避免影响页面里正常的长按（行情行、分享卡等）
        guard p.x <= 100, p.y <= 120 else { return }
        askServer()
    }

    private func askServer() {
        let ac = UIAlertController(title: "服务器地址",
                                   message: "填游戏服务器地址，例如 116.236.172.42:8888",
                                   preferredStyle: .alert)
        ac.addTextField { tf in
            tf.placeholder = "http://192.168.1.9:3000"
            tf.text = self.server
            tf.keyboardType = .URL
            tf.autocapitalizationType = .none
            tf.autocorrectionType = .no
            tf.clearButtonMode = .whileEditing
        }
        ac.addAction(UIAlertAction(title: "取消", style: .cancel))
        ac.addAction(UIAlertAction(title: "连接", style: .default) { [weak self, weak ac] _ in
            guard let self = self, let tf = ac?.textFields?.first else { return }
            let s = self.normalize(tf.text ?? "")
            if s.isEmpty {
                return
            }
            self.server = s
            UserDefaults.standard.set(s, forKey: self.storeKey)
            self.loadSite()
        })
        present(ac, animated: true)
    }

    // MARK: - JS 桥

    private func injectBridge() {
        let ucc = webView.configuration.userContentController
        ucc.removeAllUserScripts()
        ucc.addUserScript(WKUserScript(source: bridgeJS(server: server),
                                       injectionTime: .atDocumentStart,
                                       forMainFrameOnly: true))
    }

    private func bridgeJS(server: String) -> String {
        let lit = jsLiteral(server)
        return """
        (function () {
          if (window.AndroidHost) { return; }
          var post = function (m) {
            try { window.webkit.messageHandlers.gushen.postMessage(m); } catch (e) {}
          };
          window.AndroidHost = {
            server: function () { return \(lit); },
            retry: function () { post({ cmd: 'retry' }); },
            changeServer: function () { post({ cmd: 'changeServer' }); },
            shareText: function (t) {
              post({ cmd: 'shareText', text: t == null ? '' : String(t) });
            },
            shareImage: function (b64, name) {
              post({ cmd: 'shareImage',
                     data: b64 == null ? '' : String(b64),
                     name: name == null ? 'share.png' : String(name) });
            }
          };
        })();
        """
    }

    private func jsLiteral(_ s: String) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: [s]),
           let str = String(data: data, encoding: .utf8) {
            // ["..."] → "..."
            return String(str.dropFirst().dropLast())
        }
        return "\"\""
    }

    fileprivate func handle(message: WKScriptMessage) {
        guard message.name == "gushen", let body = message.body as? [String: Any] else { return }
        let cmd = body["cmd"] as? String ?? ""
        switch cmd {
        case "retry":
            loadSite()
        case "changeServer":
            askServer()
        case "shareText":
            let t = (body["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty {
                presentShare(items: [t])
            }
        case "shareImage":
            shareImage(base64: body["data"] as? String ?? "",
                       name: body["name"] as? String ?? "share.png")
        default:
            break
        }
    }

    // MARK: - 分享

    private func presentShare(items: [Any]) {
        let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let pop = vc.popoverPresentationController {
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        present(vc, animated: true)
    }

    /// 前端传的是 canvas.toDataURL 去掉前缀后的纯 base64
    private func shareImage(base64: String, name: String) {
        guard !base64.isEmpty,
              let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
              let img = UIImage(data: data) else {
            return
        }
        // 文件名过一遍白名单，只为存临时文件用（分享给 UIImage 更友好，微信按图片收）
        let safe = name.filter { $0.isLetter || $0.isNumber || "._-".contains($0) }
        if !safe.isEmpty {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(safe)
            try? data.write(to: url, options: .atomic)
        }
        presentShare(items: [img])
    }

    // MARK: - 导航失败兜底

    fileprivate func handleNavError(_ error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled {
            return
        }
        // 已经在离线页上就不再重复加载
        if webView.url?.isFileURL == true {
            return
        }
        loadOffline()
    }
}

// MARK: - JS 消息转发（弱引用，避免 userContentController 强引用 VC 造成循环）

final class BridgeProxy: NSObject, WKScriptMessageHandler {
    weak var target: ShellViewController?

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        target?.handle(message: message)
    }
}

// MARK: - WKNavigationDelegate

extension ShellViewController: WKNavigationDelegate {

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleNavError(error)
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        handleNavError(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // 内存吃紧被系统回收（长时间挂后台再回来）：直接重载
        loadSite()
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if url.isFileURL {
            decisionHandler(.allow)
            return
        }
        // 出了本站（外链）交给系统浏览器，别在壳里跑丢
        let host = url.host ?? ""
        let mine = URL(string: server)?.host ?? ""
        if !mine.isEmpty && host != mine {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

// MARK: - 手势

extension ShellViewController: UIGestureRecognizerDelegate {

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        // 不和 WKWebView 内部的滚动/点按手势抢
        return true
    }
}
