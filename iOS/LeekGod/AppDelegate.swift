/* ==========================================================================
   AppDelegate.swift — 纯代码启动（无 storyboard / 无 scene manifest）

   Info.plist 里故意不声明 UIApplicationSceneManifest，走传统 window 生命周期，
   这样 Windows/Linux 上也能靠 GitHub Actions 的 macos runner 直接 xcodebuild，
   不用在工程里塞 .storyboard（手写 storyboard XML 极易在 CI 上炸）。
   ========================================================================== */
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let win = UIWindow(frame: UIScreen.main.bounds)
        win.rootViewController = ShellViewController()
        win.makeKeyAndVisible()
        window = win
        return true
    }
}
