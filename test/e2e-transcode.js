// 转码通道验证：用 ffmpeg 生成一个 MKV(H.264+OPUS)，通过 /transcode 端点应能拿到可播放的 MP4
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
require('../src/main.js');

function getBuffer(url, timeout = 40000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const ev = (c) => win.webContents.executeJavaScript(c, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-tc-'));
  const mkv = path.join(dir, 'clip.mkv');
  // 3 秒小视频：H.264 视频 + OPUS 音频，装进 MKV（Chromium 播不了 MKV）
  execFileSync('/opt/homebrew/bin/ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'libopus', '-shortest', mkv
  ]);

  const mod = await import('webtorrent');
  const W = mod.default || mod;
  const seeder = new W({ maxConns: 10, dht: false, utp: false });
  await new Promise((r) => seeder.once('listening', r));
  const st = await new Promise((r) => seeder.seed(dir, { announce: [] }, r));
  await ev(`window.api.addLink('magnet:?xt=urn:btih:${st.infoHash}')`);

  let meta = null;
  for (let i = 0; i < 30 && !meta; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const raw = await ev(`window.api.snapshot().then(l => { const t = l.find(x => x.id === '${st.infoHash}'); return t ? JSON.stringify(t) : ''; })`);
    if (raw) {
      const m = JSON.parse(raw);
      if (m.files && m.files.some((f) => /clip\.mkv$/.test(f.name))) meta = m;
    }
  }
  if (!meta) { console.log('E2E_TRANSCODE_FAIL no task'); app.exit(1); return; }

  const idx = meta.files.findIndex((f) => /clip\.mkv$/.test(f.name));
  const info = await ev(`window.api.playUrl(${JSON.stringify(meta.id)}, ${idx})`);
  console.log('MODE', info.mode, '| hasFfmpeg', info.hasFfmpeg);

  const res = await getBuffer(info.url);
  const isMp4 = res.body.length > 2000 && res.body.includes(Buffer.from('ftyp'));
  console.log('TRANSCODE', res.status, res.body.length, isMp4 ? 'mp4-ok' : 'not-mp4');

  console.log(info.mode === 'transcode' && res.status === 200 && isMp4 ? 'E2E_TRANSCODE_PASS' : 'E2E_TRANSCODE_FAIL');
  seeder.destroy(() => setTimeout(() => app.exit(0), 300));
}).catch((e) => { console.error('FATAL', e && e.stack || e); app.exit(1); });
