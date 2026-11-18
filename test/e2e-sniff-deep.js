// 深度嗅探：页面用 JS 动态拼出视频地址（静态 HTML 里没有），只有执行 JS 才能抓到
const http = require('http');
const { app, BrowserWindow } = require('electron');
require('../src/main.js');

const VIDEO = Buffer.alloc(4096, 1);

const server = http.createServer((req, res) => {
  if (req.url === '/watch') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <h1>deep sniff test</h1>
      <div id="player"></div>
      <script>
        setTimeout(() => {
          const id = 4242;
          const v = document.createElement('video');
          v.src = '/dyn/clip-' + id + '.mp4';        // 运行时拼出来的地址
          v.muted = true;
          document.getElementById('player').appendChild(v);
          v.play().catch(() => {});
        }, 400);
      </script>
    </body></html>`);
    return;
  }
  if (/^\/dyn\/clip-\d+\.mp4/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': VIDEO.length, 'Accept-Ranges': 'bytes' });
    res.end(VIDEO);
    return;
  }
  res.writeHead(404); res.end('nope');
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const page = `http://127.0.0.1:${server.address().port}/watch`;
  const win = BrowserWindow.getAllWindows()[0];
  const ev = (c) => win.webContents.executeJavaScript(c, true);

  const quick = await ev(`window.api.sniff('${page}')`);
  const deep = await ev(`window.api.sniffDeep('${page}')`);

  const quickUrls = (quick.items || []).map((x) => x.url);
  const deepUrls = (deep.items || []).map((x) => x.url);
  const deepHit = deepUrls.some((u) => /clip-4242\.mp4/.test(u));
  const quickMiss = !quickUrls.some((u) => /clip-4242\.mp4/.test(u));

  console.log('STATIC', quickUrls.length, '个 | DEEP', deepUrls.length, '个 | 动态地址被抓到:', deepHit, '| 静态确实漏了:', quickMiss);
  console.log(deepHit && quickMiss ? 'E2E_SNIFF_DEEP_PASS' : 'E2E_SNIFF_DEEP_FAIL');
  server.close();
  app.exit(0);
}).catch((e) => { console.error('FATAL', e && e.message); app.exit(1); });
