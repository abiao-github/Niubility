// 边下边播：验证本地 HTTP 服务能按 Range 读出 torrent 里"已下载的部分"
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
require('../src/main.js');
const { makeFixture } = require('./fixture');

function fetchRange(url, start, end) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Range: `bytes=${start}-${end}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const ev = (c) => win.webContents.executeJavaScript(c, true);

  // 造一个"视频"文件（内容随意，只要字节能对上）
  const fixture = makeFixture();
  const videoPath = path.join(fixture.dir, 'clip.mp4');
  const payload = Buffer.alloc(200 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  fs.writeFileSync(videoPath, payload);

  const mod = await import('webtorrent');
  const W = mod.default || mod;
  const seeder = new W({ maxConns: 10, dht: false, utp: false });
  await new Promise((r) => seeder.once('listening', r));
  const sport = seeder.address().port;
  const st = await new Promise((r) => seeder.seed(fixture.dir, { announce: [] }, r));

  await ev(`window.api.addLink('magnet:?xt=urn:btih:${st.infoHash}')`);

  // 等 app 的分片端口
  let appPort = 0;
  for (let i = 0; i < 25 && !appPort; i++) {
    const s = await ev(`window.api.snapshot().then(l => l[0] && l[0].id || '')`);
    if (s) appPort = Number(await ev(`(async () => { const r = await fetch('http://127.0.0.1:0/'); return 0; })().catch(() => 0)`)) || 0;
    await new Promise((r) => setTimeout(r, 300));
  }
  // 直接用 app 自己的局域端口：向 BT 客户端问
  const portInfo = await ev(`window.api.snapshot().then(l => JSON.stringify(l[0] && l[0]))`);
  console.log('TASK', portInfo && portInfo.slice(0, 160));

  // 给种子加对端，让它开始下
  seeder.torrents[0].addPeer(`127.0.0.1:${sport}`);
  const dlDir = path.join(os.homedir(), 'NiuBiliTyDownloads', path.basename(fixture.dir));
  const target = path.join(dlDir, 'clip.mp4');

  // 等至少下载一部分（不要求下完）
  let partial = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try { if (fs.statSync(target).size > 32 * 1024) { partial = true; break; } } catch { /* 还没落盘 */ }
  }
  console.log('PARTIAL', partial);

  // 取播放地址并测试 Range
  const meta = JSON.parse(await ev(`window.api.snapshot().then(l => { const t = l.find(x => x.id === '${st.infoHash}'); return t ? JSON.stringify(t) : ''; })`));
  const id = meta.id;
  const idx = meta.files.findIndex((f) => /clip\.mp4$/.test(f.name));
  console.log('FILE_INDEX', idx, meta.files.map((f) => f.name).join(' | '));
  const res = await ev(`window.api.playUrl(${JSON.stringify(id)}, ${idx})`);
  console.log('PLAY_URL', res && res.url ? 'ok' : 'fail', res && res.name, res && res.length);

  const r1 = await fetchRange(res.url, 0, 1023);
  const headOk = r1.status === 206 && r1.body.length === 1024 && r1.body.equals(payload.subarray(0, 1024));
  console.log('RANGE_HEAD', r1.status, r1.body.length, headOk ? 'ok' : 'mismatch');

  // 读一段靠后的数据（可能还没下载完 → 服务应该按需补齐）
  const r2 = await fetchRange(res.url, 100 * 1024, 100 * 1024 + 4095);
  const tailOk = r2.status === 206 && r2.body.length === 4096 && r2.body.equals(payload.subarray(100 * 1024, 100 * 1024 + 4096));
  console.log('RANGE_TAIL', r2.status, r2.body.length, tailOk ? 'ok' : 'mismatch');

  const headersOk = (r1.headers['accept-ranges'] === 'bytes') && /video\/mp4/.test(r1.headers['content-type'] || '');
  console.log('HEADERS', headersOk ? 'ok' : JSON.stringify(r1.headers));

  console.log(headOk && tailOk && headersOk ? 'E2E_STREAM_PASS' : 'E2E_STREAM_FAIL');
  seeder.destroy(() => setTimeout(() => app.exit(0), 300));
}).catch((e) => { console.error('FATAL', e && e.stack || e); app.exit(1); });
