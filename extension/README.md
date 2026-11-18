# 牛B下载器 · 浏览器扩展

把网页上的链接、视频、磁力直接推给本机的牛B下载器。

## 先决条件

1. 牛B下载器正在运行（本地接口 `http://127.0.0.1:8977`）
2. 在 App 里打开 **⚙ 设置**，复制「浏览器扩展令牌」

## Chrome / Edge 安装

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选这个仓库里的 `extension/chrome` 目录
4. 点扩展图标 → 「设置令牌 / 地址」→ 令牌粘贴进去 → 保存并测试连接

## Firefox 安装

1. 打开 `about:debugging#/runtime/this-firefox`
2. 点「临时载入附加组件」，选 `extension/firefox/manifest.json`
3. 同样在扩展设置里填令牌

> 临时载入在 Firefox 重启后会失效。要长期使用，需要用 `web-ext build` 打包后签名，
> 或改用 Firefox Developer Edition 的 `xpinstall.signatures.required=false`。

## Safari 安装（macOS）

Safari 使用单独的 Web Extension 清单，并需先由 Apple 工具生成宿主 App：

1. 在终端从仓库根目录运行 `bash extension/build-safari.sh`
2. 打开 `dist/safari/NiuBiliTy Safari.app`，按提示前往 Safari 设置启用扩展
3. 点击 Safari 工具栏中的牛B下载器图标，在设置页粘贴 App「⚙ 设置」中的扩展令牌

首次构建需要安装 Xcode。通过 Xcode 自行构建时，选择个人开发团队进行签名；未签名的下载包可能被 macOS Gatekeeper 拦截。

## 用法

- **右键链接** → 「用牛B下载器下载此链接」
- **右键视频** → 「用牛B下载器下载此视频」
- **右键页面** → 「用牛B下载器下载本页视频」（App 会嗅探页面里的 HLS/DASH/MP4）
- **点扩展图标** → 快速发送当前标签页

成功时图标上会出现绿色 ✓，失败是红色 !。

## 安全说明

- 令牌只存在浏览器本地（`storage.local`），请求走 `127.0.0.1`，不出本机
- App 侧没有令牌一律 401，任何本机程序都拿不到任务控制权
