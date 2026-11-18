// 端到端测试：应用内「在本机也跑一个 DHT 索引」开关
//   1. 初始未启用、没有本机索引源
//   2. 打开开关 → 子进程起来 → /health 可访问 → 自动生成一个指向 127.0.0.1 的 dht-index 源
//   3. 搜索能打到本机索引（空索引也应返回 0 条而不是报错）
//   4. 关闭开关 → 子进程退出 → 源被移除
// 运行：env -u ELECTRON_RUN_AS_NODE npx electron test/e2e-local-index.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

process.on('uncaughtException', (e) => { process.stderr.write('UNCAUGHT ' + (e && e.stack || e) + '\n'); });
process.on('unhandledRejection', (e) => { process.stderr.write('REJECT ' + (e && e.stack || e) + '\n'); });

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-userdata-'));
const sourcesFile = path.join(userData, 'search-sources.json');
process.env.MT_SOURCES_FILE = sourcesFile;
app.setPath('userData', userData);

require('../src/main.js');

function httpGet(url, token) {
  return new Promise((resolve) => {
    const req = http.request(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const call = (fn, args = []) => win.webContents.executeJavaScript(
    'window.api.' + fn + '(' + args.map((a) => JSON.stringify(a)).join(',') + ')', true);

  const before = await call('localIndexStatus', []);
  process.stderr.write('BEFORE ' + JSON.stringify({ enabled: before.enabled, running: before.running }) + '\n');
  const beforeProviders = (await call('searchProviders', [])).map((p) => p.id);
  const noSourceAtFirst = !beforeProviders.includes('dht-index');

  // 打开
  const on = await call('enableLocalIndex', []);
  process.stderr.write('ENABLE ' + JSON.stringify({ ok: on.ok, error: on.error, port: on.status && on.status.port, running: on.status && on.status.running }) + '\n');
  const started = on.ok && on.status && on.status.running === true;

  const health = started ? await httpGet('http://127.0.0.1:8898/health', on.status.token) : null;
  process.stderr.write('HEALTH ' + JSON.stringify(health) + '\n');

  const providersAfter = (await call('searchProviders', [])).map((p) => p.id);
  const sourceAdded = providersAfter.includes('dht-index');

  // 用力搜一次：空索引也应该正常返回（0 条），不能报错
  const searched = await call('search', ['ubuntu', { providers: ['dht-index'], timeoutMs: 8000 }]);
  process.stderr.write('SEARCH ' + JSON.stringify({ count: searched.results.length, errors: searched.errors }) + '\n');
  const searchOk = Array.isArray(searched.results) && searched.errors.length === 0;

  // 关闭
  const off = await call('disableLocalIndex', []);
  const stopped = off.ok && off.status && off.status.running === false;
  await new Promise((r) => setTimeout(r, 800));
  const afterStop = await httpGet('http://127.0.0.1:8898/health', off.status && off.status.token);
  const portClosed = afterStop === null;
  const providersFinal = (await call('searchProviders', [])).map((p) => p.id);
  const sourceRemoved = !providersFinal.includes('dht-index');

  const pass = noSourceAtFirst && started && !!health && sourceAdded && searchOk && stopped && portClosed && sourceRemoved;
  process.stderr.write('DETAIL ' + JSON.stringify({ noSourceAtFirst, started, health: !!health, sourceAdded, searchOk, stopped, portClosed, sourceRemoved }) + '\n');
  process.stderr.write(pass ? 'E2E_LOCAL_INDEX_PASS\n' : 'E2E_LOCAL_INDEX_FAIL\n');
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(pass ? 0 : 1);
}).catch((e) => {
  process.stderr.write('FATAL ' + (e && e.stack || e) + '\n');
  app.exit(1);
});
