# 股神请就位 · iOS 壳（iOS/）

原生 WKWebView 壳，加载服务器上的 `/m/` 移动端页面（页面代码在仓库 `App/`，**与安卓壳共用同一套页面**）。
壳里只有：地址管理、离线兜底页、JS 桥（`window.AndroidHost`）、系统分享面板、长按换地址。

> 目标场景：**自己和朋友自己装**，不上架。所以整个流程围绕「免费 Apple ID + 侧载」设计。

---

## 为什么要在 GitHub 上构建

iOS App 必须有 macOS + Xcode 才能编译，本机是 Windows。所以：

```
你 push 代码 → GitHub Actions 的 macOS 机器编译 → 产出未签名 ipa → 发到 Release
                                                        ↓
                              你在 Windows 上用 Sideloadly/AltStore 用免费 Apple ID 重签 → 装进 iPhone
```

公开仓库的 macOS runner 免费，单次构建约 3~6 分钟。

## 一、构建（不用 Mac）

1. push 改动了 `iOS/` 目录的提交，或到仓库 **Actions → iOS IPA → Run workflow** 手动触发。
2. 等绿勾（约 5 分钟）。
3. 产物在 **Releases** 里：`ios-build-<编号>`，附件 `LeekGod-unsigned.ipa`（公开仓库无需登录即可下载）。

想在 App 里预置服务器地址（朋友装上就不用填）：

> 仓库 **Settings → Secrets and variables → Actions → Variables → New repository variable**
> 名字 `GUSHEN_SERVER_URL`，值例如 `http://1.2.3.4:8888`（不要带尾斜杠）

不设也能用：App 第一次打开会弹框让填地址。

## 二、装到 iPhone（免费 Apple ID）

### 先看版本：决定走哪条路

「设置 → 通用 → 关于本机」看版本号。**未签名的 ipa 点网页链接是装不上的**（Safari 只会把它存进「文件」App），
iOS 的安装通道都要验签，所以免费路线只有下面两种：

| 你的 iOS 版本 | 推荐方式 | 效果 |
|---|---|---|
| **14.0 beta2 – 16.6.1、16.7 RC（20H18）、17.0** | **TrollStore**（见方案 C） | **一次装好、永久有效**，之后点 ipa 就装，不用续签 |
| 17.0.1 及以上 / iOS 18 / 26 | Sideloadly（方案 A）或 AltStore（方案 B） | 7 天有效期，重签一次即可 |

TrollStore 官方口径：17.0.1 以上与 iOS 18/26 **不支持、也不会支持**（CoreTrust 漏洞已被修），
网上"iOS 18 巨魔""26 巨魔"都是别的工具，别为它买激活码。

要「点链接就能装」且不需要 7 天续签的，只有付费开发者账号（约 688 元/年）：
TestFlight 或 Ad-Hoc OTA（`itms-services://` 落地页 + 设备 UDID 登记）。需要时再改 CI 出签名包。

### 方案 A：Sideloadly（17.0.1+ 最省事）

1. 电脑装 [iTunes](https://www.apple.com/itunes/download/win64)（只为装苹果驱动；Win11 也可装「Apple Devices」应用）。
2. 装 [Sideloadly](https://sideloadly.io/)，打开。
3. iPhone 用数据线连电脑，插上后手机上点「信任此电脑」。
4. Sideloadly 里：**IPA 选 `LeekGod-unsigned.ipa`**，**Apple ID 填你自己的 Apple ID**（免费账号即可）。
5. 点 **Start**，输入 Apple ID 密码（会验证一次；开了双重认证的账号需要用 App 专用密码，Sideloadly 会提示）。
6. 装完手机上：**设置 → 通用 → VPN 与设备管理 → 信任开发者**，然后才能打开 App。

### 方案 B：AltStore（能自动续签，但要在电脑上常驻 AltServer）

适合「几个人长期玩」：插线只需要第 1 次，之后同 WiFi 自动续签，不用每 7 天手动重签。

1. 电脑装 [AltStore](https://altstore.io/)（Windows 版要 iTunes + iCloud）。
2. AltServer 跑在电脑上，iPhone 和电脑同一个 WiFi，AltStore 里登录 Apple ID。
3. **My Apps → 左上角 + → 选 ipa 文件** → 安装。
4. 保持 AltServer 常驻，手机连同一 WiFi 时会自动续签。

### 方案 C：TrollStore（免费 + 永久，仅限上面那些版本）

1. 先装 TrollStore 本体 —— 它不能像普通 App 那样侧载，要按版本走对应安装器，
   照 [ios.cfw.guide 的 TrollStore 章节](https://ios.cfw.guide/installing-trollstore/) 操作（装完桌面有个 TrollStore 图标）。
2. 把 `LeekGod-unsigned.ipa` 存到手机「文件」App（Safari 点下载链接会存到「下载」里）。
3. 打开 TrollStore → 右下角 **+** → 选那个 ipa → **Install**。
4. 装完永久可用，重启不失效，也不用续签；以后有新版直接重复第 2~3 步覆盖安装（数据保留）。

### 免费账号的三条硬限制（Sideloadly / AltStore 才有，TrollStore 不受限）

| 限制 | 说明 |
|---|---|
| **7 天有效期** | 到期 App 打不开，重新签一次即可（数据不丢，UserDefaults/WebView 存储都在） |
| **最多 3 个自签 App** | 同一设备上 |
| **每人签自己的** | 签名绑 Apple ID + 设备，不能把签好的包发给朋友 |

朋友要装：让他自己下载 ipa，按他自己的版本走上面某一条路线。


## 三、App 里怎么用

- **首次打开**：填服务器地址（若构建时注入了 `GUSHEN_SERVER_URL` 则跳过）。
- **换地址**：长按屏幕**左上角 1.2 秒**，或在「我的」页点「切换服务器」。
- **连不上**：自动进内置离线页（重试 / 换地址）。
- **分享**：个股页分享按钮、战绩卡、邀请好友 —— 走系统分享面板（微信/QQ 均可）。
- iOS 14+ 首次访问局域网地址会弹「本地网络」权限，点允许。

## 四、工程结构

```
iOS/
├── project.yml                  # xcodegen 配置（.xcodeproj 是生成物，不入库）
└── LeekGod/
    ├── AppDelegate.swift        # 纯代码启动（无 storyboard / 无 scene manifest）
    ├── ShellViewController.swift# WKWebView + 地址管理 + JS 桥 + 分享 + 离线兜底
    ├── Offline.html             # 内置离线页（断网/连不上时显示）
    ├── Info.plist               # ATS 放开 http、竖屏、启动屏、GushenServerUrl 占位
    └── Assets.xcassets/         # AppIcon(1024) + 启动背景色 + 启动 logo
```

**JS 桥与安卓壳同名**（`window.AndroidHost`：`server()` / `retry()` / `changeServer()` / `shareText()` / `shareImage()`），
所以 `App/js/share.js`、`App/js/view-me.js` 里检测桥的代码**一行都不用改**。

## 五、有 Mac 时的本地构建

```bash
brew install xcodegen
cd iOS && xcodegen generate && open LeekGod.xcodeproj
```

Xcode 里选你的 iPhone，Signing 选自己的免费 Apple ID，直接 Run。产物位置同 CI：
`build/Release-iphoneos/LeekGod.app` → 塞进 `Payload/` 目录 zip 成 ipa。

## 六、已知边界

- **没有推送**：iOS 上没有 APNs 配置（自签包也拿不到推送），新消息靠 App 内的角标与 toast。
- **http 明文**：`Info.plist` 已开 `NSAllowsArbitraryLoads`，自用没问题；哪天要上架必须换 HTTPS 并说明理由。
- **版本号**：`project.yml` 里 `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`，升级时递增后者。
- **Bundle ID**：`cn.gushen.leekgod`，与安卓壳的包名一致（两个平台互不影响）。
