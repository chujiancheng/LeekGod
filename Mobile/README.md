# 股神请就位 · Android 壳（Mobile/）

原生 WebView 壳，零第三方依赖（连 AndroidX 都不用）。加载的是游戏服务器上的移动端页面 `/m/`，
**页面代码全部在仓库 `App/` 目录**，壳里只有：地址管理、离线兜底页、返回键适配。

## 发布流程（一键打包）

**双击 `Mobile\build-apk.bat` 即可**，产物自动落到 `output\LeekGod-v<版本>.apk`。

脚本会自动探测 JDK 17 / Android SDK / Gradle 8.x（找不到再退回 `JAVA_HOME`、`ANDROID_HOME`、
`local.properties`、常见安装路径），构建完自动验签、归档，并把大小打出来。

发版前只需要改两处：

1. `gradle.properties -> gushenServerUrl`：内置默认服务器地址（玩家首次启动会预填它）。
2. `app/build.gradle -> versionCode / versionName`：**升级必须递增 versionCode**。

命令行用法：

```bat
build-apk.bat             :: 只打包
build-apk.bat install     :: 打包并 adb install -r 到已连接的设备
build-apk.bat --no-pause  :: 跑完不停窗口（脚本/CI 里调用）
```

前提：JDK 17 + Android SDK（本机在 `D:\andriod`，`local.properties` 已指好）。
脚本内注释与输出保持纯 ASCII——`.bat` 里混中文再 `chcp 65001` 会让 cmd 行偏移错乱、
把注释当命令执行，中文说明一律写在本文档。

## 签名（重要）

- `keystore.properties` + `keystore/gushen-release.jks` 都在 `.gitignore` 里，**不进 git**。
- **丢了密钥库就无法给老用户升级（只能卸载重装），请务必备份这两份文件。**
- 当前口令记录在 `keystore.properties`；要换就重新生成 jks 后同步改 properties。

## 玩家侧说明（可直接转发）

- 安装 `app-release.apk`（允许未知来源）。
- 首次启动填服务器地址，例如 `http://192.168.1.9:3000`（和服务器同一 WiFi 才能连上）。
- 断网/服务器关了会进兜底页，可以重试或改地址；**平时改地址：长按屏幕左上角 1.2 秒**。
- 数据（账号、登录态）存在手机本地；换地址 = 换了一个站，账号跟着服务器走。

## 服务端要求

- 服务器开着 `node index.js`（默认 3000 端口），移动端页面在 `/m/`。
- 目前是 HTTP 直连：手机和服务器必须在同一局域网，或给服务器做公网端口映射/内网穿透
  （frp、Tailscale 等都可以），地址相应填公网地址。
- HTTPS 不是硬要求（壳里已放开 cleartext），但要上外网建议套 HTTPS。

## 返回键口径（壳与页面约定）

页面（`App/js/core.js`）通过 `<section id="sheet">` / `<section id="page">` 的 hidden 状态表达
弹层/二级页；壳在物理返回键时用 `evaluateJavascript` 探测并优先调用 `GS.core.closeSheet()` /
`GS.core.closePage()`，页面自己消费；到根部再按一次退出。页面改造时别改这两个 id 与 GS.core
导出名，壳会失配。
