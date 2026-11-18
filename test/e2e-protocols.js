// 端到端测试：新增协议在真实 app 里的表现
//  1) HTTP(S) 单文件：断点续传（暂停/继续）+ 内容校验 + 删除
//  2) HLS：m3u8 → 抓分片 → ffmpeg 封装 → 校验时长
//  3) DASH：mpd → 视频+音频轨 → mux → 校验时长
//
// 运行：env -u ELECTRON_RUN_AS_NODE npx electron test/e2e-protocols.js
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.on('uncaughtException', (e) => { process.stderr.write('UNCAUGHT ' + (e && e.stack || e) + '\n'); });
process.on('unhandledRejection', (e) => { process.stderr.write('REJECT ' + (e && e.stack || e) + '\n'); });

const DOWNLOADS = path.join(os.homedir(), 'NiuBiliTyDownloads');
const MEDIA = path.join(os.tmpdir(), 'mt-protocol-media');
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));

// ---------- 本地媒体夹具（HLS / DASH） ----------

function buildMediaFixtures() {
  fs.rmSync(MEDIA, { recursive: true, force: true });
  fs.mkdirSync(path.join(MEDIA, 'hls'), { recursive: true });
  fs.mkdirSync(path.join(MEDIA, 'dash'), { recursive: true });
  if (!FFMPEG) return false;
  const base = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-b:v', '200k',
    '-c:a', 'aac', '-b:a', '64k'
  ];
  execFileSync(FFMPEG, [...base, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(MEDIA, 'hls', 'seg%d.ts'), path.join(MEDIA, 'hls', 'index.m3u8')]);
  execFileSync(FFMPEG, [...base, '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1',
    path.join(MEDIA, 'dash', 'manifest.mpd')]);
  return true;
}

// ---------- 本地 HTTP 服务器：大文件（限速）+ 媒体目录 ----------

const bigPayload = Buffer.alloc(4 * 1024 * 1024);
for (let i = 0; i < bigPayload.length; i++) bigPayload[i] = (i * 13 + 7) % 251;

function makeServer() {
  const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment' };
  return http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);

    if (url === '/files/big.bin') {
      const range = req.headers.range;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="big-4mb.bin"');
      res.setHeader('Accept-Ranges', 'bytes');
      let start = 0;
      let end = bigPayload.length - 1;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        start = Number(m[1]);
        if (m[2]) end = Number(m[2]);
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${bigPayload.length}`);
      }
      res.setHeader('Content-Length', end - start + 1);
      if (req.method === 'HEAD') { res.end(); return; }
      // 限速 ~160KB/s per connection，留出暂停窗口
      let pos = start;
      const timer = setInterval(() => {
        if (pos > end || res.destroyed) { clearInterval(timer); if (!res.destroyed) res.end(); return; }
        const n = Math.min(16384, end - pos + 1);
        res.write(bigPayload.subarray(pos, pos + n));
        pos += n;
      }, 100);
      res.on('close', () => clearInterval(timer));
      return;
    }

    const m = /^\/(hls|dash)\/(.+)$/.exec(url);
    if (m) {
      const file = path.join(MEDIA, m[1], m[2]);
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('nope'); }
      const buf = fs.readFileSync(file);
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Content-Length', buf.length);
      return res.end(buf);
    }

    res.statusCode = 404;
    res.end('nope');
  });
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function ffprobeSeconds(file) {
  if (!FFMPEG) return 0;
  try {
    const out = execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    return 0;
  } catch (err) {
    const text = String(err.stderr || '');
    const d = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(text);
    return d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0;
  }
}

const built = buildMediaFixtures();
const server = makeServer();

require('../src/main.js');

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const win = BrowserWindow.getAllWindows()[0];
  const call = (fn, args = []) => win.webContents.executeJavaScript(
    'window.api.' + fn + '(' + args.map((a) => JSON.stringify(a)).join(',') + ')', true);
  const evalJS = (code) => win.webContents.executeJavaScript(code, true);
  await evalJS('window.__tasks={}; window.api.onTaskUpdate(t=>{window.__tasks[t.id]=t;}); true;');

  const results = [];
  const waitDone = async (id, ms = 90000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 400));
      const t = await evalJS(`window.__tasks[${JSON.stringify(id)}] ? JSON.stringify({done:window.__tasks[${JSON.stringify(id)}].done, error:window.__tasks[${JSON.stringify(id)}].error, dl:window.__tasks[${JSON.stringify(id)}].downloaded, paused:window.__tasks[${JSON.stringify(id)}].paused}) : null`);
      if (!t) continue;
      const s = JSON.parse(t);
      if (s.error) return { ok: false, error: s.error };
      if (s.done) return { ok: true };
    }
    return { ok: false, error: 'timeout' };
  };

  // ---------- 1) HTTP ----------
  const httpTask = await call('addLink', [base + '/files/big.bin']);
  process.stderr.write('HTTP_TASK ' + JSON.stringify({ id: httpTask.id, kind: httpTask.kind, name: httpTask.name, total: httpTask.total }) + '\n');
  await new Promise((r) => setTimeout(r, 700));
  const beforePause = JSON.parse(await evalJS(`JSON.stringify({paused:window.__tasks[${JSON.stringify(httpTask.id)}].paused, queued:window.__tasks[${JSON.stringify(httpTask.id)}].queued, error:window.__tasks[${JSON.stringify(httpTask.id)}].error, dl:window.__tasks[${JSON.stringify(httpTask.id)}].downloaded})`));

  await call('pause', [httpTask.id]);
  await new Promise((r) => setTimeout(r, 700));
  const pausedState = JSON.parse(await evalJS(`JSON.stringify({paused:window.__tasks[${JSON.stringify(httpTask.id)}].paused, dl:window.__tasks[${JSON.stringify(httpTask.id)}].downloaded})`));
  await new Promise((r) => setTimeout(r, 700));
  const afterPause = JSON.parse(await evalJS(`JSON.stringify({dl:window.__tasks[${JSON.stringify(httpTask.id)}].downloaded})`));
  const stopped = pausedState.paused === true && afterPause.dl === pausedState.dl;
  process.stderr.write('HTTP_PAUSE ' + JSON.stringify({ beforePause, pausedState, afterPause, stopped }) + '\n');

  await call('resume', [httpTask.id]);
  const httpDone = await waitDone(httpTask.id);
  const httpFile = httpTask.savePath;
  const httpOk = httpDone.ok && fs.existsSync(httpFile) && fs.statSync(httpFile).size === bigPayload.length
    && md5(httpFile) === crypto.createHash('md5').update(bigPayload).digest('hex');
  process.stderr.write('HTTP_RESULT ' + JSON.stringify({ ok: httpOk, download: httpDone, file: httpFile, size: fs.existsSync(httpFile) ? fs.statSync(httpFile).size : -1 }) + '\n');
  results.push(['http', httpOk && stopped]);

  // ---------- 2) HLS ----------
  let hlsOk = false;
  if (built) {
    const hlsTask = await call('addLink', [base + '/hls/index.m3u8']);
    process.stderr.write('HLS_TASK ' + JSON.stringify({ id: hlsTask.id, kind: hlsTask.kind, name: hlsTask.name }) + '\n');
    const hlsDone = await waitDone(hlsTask.id);
    const hlsFile = hlsTask.savePath;
    const seconds = fs.existsSync(hlsFile) ? ffprobeSeconds(hlsFile) : 0;
    hlsOk = hlsDone.ok && fs.existsSync(hlsFile) && seconds > 4;
    process.stderr.write('HLS_RESULT ' + JSON.stringify({ ok: hlsOk, file: hlsTask.savePath, seconds, err: hlsDone.error }) + '\n');
    if (fs.existsSync(hlsFile)) results.push(['hls-file', hlsFile]);
  } else {
    process.stderr.write('HLS_SKIP 没有 ffmpeg\n');
  }
  results.push(['hls', hlsOk]);

  // ---------- 3) DASH ----------
  let dashOk = false;
  if (built) {
    const dashTask = await call('addLink', [base + '/dash/manifest.mpd']);
    process.stderr.write('DASH_TASK ' + JSON.stringify({ id: dashTask.id, kind: dashTask.kind, name: dashTask.name }) + '\n');
    const dashDone = await waitDone(dashTask.id);
    const dashFile = dashTask.savePath;
    const seconds = fs.existsSync(dashFile) ? ffprobeSeconds(dashFile) : 0;
    dashOk = dashDone.ok && fs.existsSync(dashFile) && seconds > 4;
    process.stderr.write('DASH_RESULT ' + JSON.stringify({ ok: dashOk, file: dashTask.savePath, seconds, err: dashDone.error }) + '\n');
  } else {
    process.stderr.write('DASH_SKIP 没有 ffmpeg\n');
  }
  results.push(['dash', dashOk]);

  // 清理：删掉三个任务及其文件
  for (const t of await evalJS('JSON.stringify(Object.keys(window.__tasks))').then(JSON.parse)) {
    await call('remove', [t, true]).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 1500));

  const pass = httpOk && stopped && hlsOk && dashOk;
  process.stderr.write('SUMMARY ' + JSON.stringify({ http: httpOk, httpPause: stopped, hls: hlsOk, dash: dashOk }) + '\n');
  process.stderr.write(pass ? 'E2E_PROTOCOLS_PASS\n' : 'E2E_PROTOCOLS_FAIL\n');
  server.close();
  app.exit(pass ? 0 : 1);
}).catch((e) => {
  process.stderr.write('FATAL ' + (e && e.stack || e) + '\n');
  server.close();
  app.exit(1);
});
