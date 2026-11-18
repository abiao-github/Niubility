// 直链模式（夸克/115/天翼）：验证自动带上对应 Referer + 可选 Cookie
const http = require('http');
const { app, BrowserWindow } = require('electron');
require('../src/main.js');

const BODY = Buffer.from('quark-direct-payload');

const server = http.createServer((req, res) => {
  const okRef = (req.headers.referer || '') === 'https://pan.quark.cn/';
  const okCookie = /BDUSS=abc/.test(req.headers.cookie || '');
  if (!okRef || !okCookie) { res.writeHead(403); res.end('forbidden'); return; }
  res.writeHead(200, { 'Content-Length': BODY.length, 'Accept-Ranges': 'bytes' });
  res.end(BODY);
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const win = BrowserWindow.getAllWindows()[0];
  const ev = (c) => win.webContents.executeJavaScript(c, true);

  // 不带 Cookie：直链要求 Cookie，应失败
  const bad = await ev(`window.api.cloudAddDirect('quark', 'http://127.0.0.1:${port}/f.bin', '')
    .then(() => 'no-error').catch(e => String(e.message || e))`);
  const badFailed = /403/.test(bad);

  // 带 Cookie：Referer 自动补 https://pan.quark.cn/，应成功
  const good = JSON.parse(await ev(`window.api.cloudAddDirect('quark', 'http://127.0.0.1:${port}/f.bin', 'BDUSS=abc')
    .then(r => JSON.stringify({ ok: true, name: r.task && r.task.name }))
    .catch(e => JSON.stringify({ ok: false, err: String(e.message || e) }))`));

  console.log('NO_COOKIE', badFailed ? '403-ok' : bad, '| WITH_COOKIE', JSON.stringify(good));
  console.log(badFailed && good.ok ? 'E2E_CLOUD_DIRECT_PASS' : 'E2E_CLOUD_DIRECT_FAIL');
  server.close();
  app.exit(0);
}).catch((e) => { console.error('FATAL', e && e.message); app.exit(1); });
