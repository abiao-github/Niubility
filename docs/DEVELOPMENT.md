# 开发说明（NiuBiliTy）

> 面向维护者。用户文档见 [README.md](../README.md) / [README_CN.md](../README_CN.md)。

## 目录

```
micro-torrent/
  src/
    main.js              主进程：IPC、窗口、协议注册、本地 API、偏好、网盘
    preload.js           contextBridge 暴露 window.api
    tasks.js             统一任务管理（bt/http/ftp/hls/dash/metalink/ipfs/ed2k）
    net/                 协议适配器：http/proxy/ftp/hls/dash/metalink/ipfs/ed2k/media/sniff/cloud
    search/              发现层：gateway、normalize、relevance、translate、sources、providers/*
    local-index.js       本机 DHT 索引的启停（spawn 子进程）
    stream-server.js     边下边播：Range 服务 + ffmpeg 转码端点
    indexer-monitor.js   Prowlarr 源健康巡检
    renderer/            index.html / renderer.js / style.css / empty-fx.js / icon.svg
  indexer/               自建 DHT 索引（可独立部署到服务器）
  test/                  unit-*.js + e2e-*.js（17）
  extension/             chrome(MV3) / firefox(MV2) 浏览器扩展
  extension/README.md    扩展安装说明
  scripts/               prowlarr-bench.py、index-tunnel.sh、after-pack.js
```

## 关键约定

- **发现层不渗进协议适配器**：provider 只产出 `SearchResult`；`gateway.toTask(resultId)` 调
  `TaskManager.add()`，与手动粘磁力完全同一条路径。
- **任务状态只有四种**：`active` / `queued` / `paused` / `done`（+`error` 用 task.error 表示）。
- **持久化**：`userData/tasks.json`（1.5s 防抖写盘，tmp+rename）；BT 的 `.torrent` 缓存在
  `userData/torrents/<infohash>.torrent`，恢复时无需等 DHT。
- **凭据只在本机**：`userData/api-token.txt`、`cloud-accounts.json`，权限 600，UI 不回传明文。

## 本地端口

| 端口 | 用途 |
|---|---|
| 8977 | 本地 HTTP API（扩展 / 命令行），`/ping` 免令牌，其余要 `X-Api-Token` |
| 8899 | 服务器1 的 DHT 索引（经 launchd 隧道，仅本机） |
| 9696 | Prowlarr（外部服务，应用通过它聚合 indexer） |
| 随机 | 边下边播的 Range 服务（`stream-server.js`，只监听 127.0.0.1） |

## 打包

```bash
npm run build:mac     # electronDist 指向本地，避免联网下载
npm run build:win
npm run build:linux
```

注意事项：

1. **macOS 必须 ad-hoc 签名**（`scripts/after-pack.js`）：无证书时 electron-builder 会跳过签名，
   arm64 上会导致应用无法启动（双击无反应）。
2. **同一脚本里先删语言包再签名**：Electron 自带 55 个 `.lproj`（约 45MB），只留中英文，删完必须
   再签名，否则包被改动签名失效。
3. **indexer/ 走 extraResources**：要被子进程执行，不能进 asar；它的 `node_modules` 另列一条。
4. **Windows/Linux 交叉构建不要传 `-c.electronDist`**，否则会拿 macOS 的 Electron 去拼 Linux 包。
5. `dist/` 里 mac 产物在 `mac-arm64/`，win 在 `win-unpacked/`，linux 在 `linux-unpacked/`。

## 测试

```bash
npm run test:unit   # unit tests + indexer tests
npm run test        # 17 个独立临时用户目录中的 e2e
```

- E2E 启动器会为每个用例设置独立的临时用户目录，并启用 `MT_TEST=1`，避免读写日常任务与下载文件。
- torrent 相关的 e2e 用 `infoHash` 定位任务（任务持久化后 `snapshot()[0]` 可能是恢复的旧任务）。
- 限速服务器用本地 HTTP server 模拟（`unit-segmented.js` 每连接限 1MB/s）。

## 已知坑（都踩过）

| 现象 | 原因 | 处理 |
|---|---|---|
| 双击 app 无反应 | arm64 要求有效签名，打包改动后签名失效 | afterPack 里 `codesign --force --deep --sign -` |
| 首屏只有静态粒子 | 系统开了「减弱动态效果」，`prefers-reduced-motion` 命中 | 降档播放而不是停掉 |
| 搜索 0 结果 | 站点返回热门兜底榜 + 唯一有内容的源不可用 | 相关性过滤 + indexer 巡检 |
| Prowlarr 聚合超时 | 单个源卡 50s 拖垮整批 | indexer-monitor 停用慢源 |
| 播放器黑屏 | Chromium 不支持 MKV/HEVC/DTS | 走 `/transcode` ffmpeg 通道 |
| 任务重启丢失 | 早期没有持久化 | `tasks.json` + torrent 缓存 |
