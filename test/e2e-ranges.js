// 可播放范围：边下边播时，ranges 应随下载推进而增长，且都在文件长度内
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/main.js');

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const ev = (c) => win.webContents.executeJavaScript(c, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-rg-'));
  const big = path.join(dir, 'movie.mp4');
  const buf = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31) % 251;
  fs.writeFileSync(big, buf);

  const mod = await import('webtorrent');
  const W = mod.default || mod;
  const seeder = new W({ maxConns: 12, dht: false, utp: false });
  // 限速上传，保证采样时文件仍是"部分下载"状态
  if (typeof seeder.throttleUpload === 'function') seeder.throttleUpload(150 * 1024);
  await new Promise((r) => seeder.once('listening', r));
  const st = await new Promise((r) => seeder.seed(dir, { announce: [] }, r));
  await ev(`window.api.addLink('magnet:?xt=urn:btih:${st.infoHash}')`);

  let meta = null;
  for (let i = 0; i < 30 && !meta; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const raw = await ev(`window.api.snapshot().then(l => { const t = l.find(x => x.id === '${st.infoHash}'); return t ? JSON.stringify(t) : ''; })`);
    if (raw) meta = JSON.parse(raw);
  }
  if (!meta) { console.log('E2E_RANGES_FAIL no task'); app.exit(1); return; }
  const idx = meta.files.findIndex((f) => /movie\.mp4$/.test(f.name));

  const r1 = await ev(`window.api.playRanges(${JSON.stringify(meta.id)}, ${idx})`);
  const firstBytes = (r1.ranges || []).reduce((n, r) => n + (r[1] - r[0]), 0);
  await new Promise((r) => setTimeout(r, 2500));
  const r2 = await ev(`window.api.playRanges(${JSON.stringify(meta.id)}, ${idx})`);
  const laterBytes = (r2.ranges || []).reduce((n, r) => n + (r[1] - r[0]), 0);

  const inBounds = (r2.ranges || []).every(([a, b]) => a >= 0 && b <= r2.length && a < b);
  const monotonic = laterBytes >= firstBytes;
  const partialAtFirst = firstBytes < r2.length;
  console.log('PARTIAL_AT_FIRST', partialAtFirst, '| GROWTH', laterBytes - firstBytes);

  console.log('LEN', r2.length, '| ranges', (r2.ranges || []).length, '| bytes', firstBytes, '→', laterBytes);
  console.log('IN_BOUNDS', inBounds, '| MONOTONIC', monotonic);
  console.log(inBounds && monotonic && partialAtFirst && laterBytes > firstBytes && r2.length === buf.length
    ? 'E2E_RANGES_PASS' : 'E2E_RANGES_FAIL');
  seeder.destroy(() => setTimeout(() => app.exit(0), 300));
}).catch((e) => { console.error('FATAL', e && e.stack || e); app.exit(1); });
