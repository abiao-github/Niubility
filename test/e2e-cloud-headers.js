// 端到端：带自定义请求头的直链能下下来（模拟网盘直链的 UA/Cookie/Referer 校验）
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { app } = require('electron');
require('../src/main.js');
const { TaskManager } = require('../src/tasks');

const BODY = Buffer.from('hello-netdisk-payload-'.repeat(2000));

const server = http.createServer((req, res) => {
  const okUa = req.headers['user-agent'] === 'pan.baidu.com';
  const okCookie = /BDUSS=abc/.test(req.headers.cookie || '');
  const okRef = req.headers.referer === 'https://pan.baidu.com/';
  if (!okUa || !okCookie || !okRef) { res.writeHead(403); res.end('forbidden'); return; }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const a = +m[1], b = m[2] ? Math.min(+m[2], BODY.length - 1) : BODY.length - 1;
    res.writeHead(206, { 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${BODY.length}`, 'Accept-Ranges': 'bytes' });
    res.end(BODY.subarray(a, b + 1));
  } else {
    res.writeHead(200, { 'Content-Length': BODY.length, 'Accept-Ranges': 'bytes' });
    res.end(BODY);
  }
});

server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/file.bin`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-hd-'));
  const m = new TaskManager({ dir, onUpdate: () => {}, onError: () => {} , options: { connections: 2 } });

  // 不带 header：应 403 失败
  const bad = await m.add(url).catch((e) => e);
  const badFailed = bad instanceof Error ? /403/.test(bad.message) : false;

  // 带 header：应成功
  const task = await m.add({ url, headers: {
    'User-Agent': 'pan.baidu.com',
    Cookie: 'BDUSS=abc; STOKEN=x',
    Referer: 'https://pan.baidu.com/'
  } });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const t = m.get(task.id);
    if (t && (t.state === 'done' || t.state === 'error')) break;
  }
  const t = m.get(task.id);
  const file = fs.existsSync(t.savePath) ? fs.readFileSync(t.savePath) : Buffer.alloc(0);
  const ok = badFailed && t.state === 'done' && file.equals(BODY);
  console.log(`NO_HEADER ${badFailed ? '403-ok' : 'unexpected'} | WITH_HEADER ${t.state} | size ${file.length}/${BODY.length}`);
  console.log(ok ? 'E2E_CLOUD_HEADERS_PASS' : 'E2E_CLOUD_HEADERS_FAIL');
  clearInterval(m.timer);
  server.close();
  app.exit(0);
});
