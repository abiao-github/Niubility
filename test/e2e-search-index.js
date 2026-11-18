// 端到端测试：自建 DHT 索引（dht-index）作为发现层来源
//
// 本地起一个假的索引服务（和 indexer/server.js 同样的接口），验证：
//   1. 没配置时不出现 dht-index 源
//   2. 配置后出现，且 token 不回传明文
//   3. 搜索走 Bearer token；错 token 时错误被收敛成 provider 错误而不是崩掉
//   4. 结果标准化（infohash/magnet/size/热度），同 infohash 去重
//   5. 选中结果转任务 → 真的下载完成
//
// 运行：env -u ELECTRON_RUN_AS_NODE npx electron test/e2e-search-index.js
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { makeFixture } = require('./fixture');

process.on('uncaughtException', (e) => { process.stderr.write('UNCAUGHT ' + (e && e.stack || e) + '\n'); });
process.on('unhandledRejection', (e) => { process.stderr.write('REJECT ' + (e && e.stack || e) + '\n'); });

const fixture = makeFixture();
const dl = path.join(os.homedir(), 'NiuBiliTyDownloads', path.basename(fixture.dir));
fs.rmSync(dl, { recursive: true, force: true });

const sourcesFile = path.join(os.tmpdir(), 'mt-e2e-index-sources.json');
fs.rmSync(sourcesFile, { force: true });
process.env.MT_SOURCES_FILE = sourcesFile;

const TOKEN = 'index-token-test';
let HASH = null;

function payload() {
  const now = Date.now();
  return {
    query: 'fixture',
    total: 2,
    results: [
      {
        infohash: HASH,
        name: 'MT Fixture Pack (2026) 1080p',
        size: fixture.big + fixture.small,
        files: 2,
        peers: 37,
        firstSeen: now - 3600_000,
        lastSeen: now,
        magnet: `magnet:?xt=urn:btih:${HASH}&dn=MT+Fixture+Pack`
      },
      {
        // 同一个 infohash、热度更低 → 应被去重合并
        infohash: HASH,
        name: 'MT Fixture Pack (2026) 1080p (dup)',
        size: fixture.big + fixture.small,
        files: 2,
        peers: 5,
        firstSeen: now - 7200_000,
        lastSeen: now,
        magnet: `magnet:?xt=urn:btih:${HASH}`
      }
    ]
  };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (u.pathname !== '/search') return json(404, { error: 'not found' });
  if (auth !== TOKEN) return json(401, { error: 'unauthorized' });
  return json(200, payload());
});

require('../src/main.js');

function appPeerPort(exclude) {
  const out = execSync('lsof -nP -iTCP -sTCP:LISTEN -a -p ' + process.pid).toString();
  return [...out.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((m) => +m[1]).find((p) => p !== exclude) || 0;
}

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const mod = await import('webtorrent');
  const W = mod.default || mod;
  const seeder = new W({ maxConns: 10, dht: false, utp: false });
  await new Promise((r) => seeder.once('listening', r));
  const seedPort = seeder.address().port;
  const st = await new Promise((r) => seeder.seed(fixture.dir, { announce: [] }, r));
  HASH = st.infoHash;

  const win = BrowserWindow.getAllWindows()[0];
  const call = (fn, args = []) => win.webContents.executeJavaScript(
    'window.api.' + fn + '(' + args.map((a) => JSON.stringify(a)).join(',') + ')', true);
  const evalJS = (code) => win.webContents.executeJavaScript(code, true);
  await evalJS('window.__tasks={}; window.api.onTaskUpdate(t=>{window.__tasks[t.id]=t;}); true;');

  const beforeIds = (await call('searchProviders', [])).map((p) => p.id);
  const hiddenAtFirst = !beforeIds.includes('dht-index');
  process.stderr.write('PROVIDERS_BEFORE ' + JSON.stringify(beforeIds.sort()) + '\n');

  const saved = await call('saveSearchSource', [{ type: 'dht-index', baseUrl: base, apiKey: TOKEN }]);
  const providers = (await call('searchProviders', [])).map((p) => p.id);
  const present = providers.includes('dht-index');
  const keyHidden = !JSON.stringify(saved).includes(TOKEN);
  const entry = saved.find((s) => s.type === 'dht-index');
  process.stderr.write('SOURCE ' + JSON.stringify(entry) + ' providers=' + JSON.stringify(providers.sort()) + '\n');

  const found = await call('search', ['fixture', { providers: ['dht-index'], timeoutMs: 6000 }]);
  const r0 = found.results && found.results[0];
  process.stderr.write('SEARCH ' + JSON.stringify({
    count: found.results && found.results.length,
    errors: found.errors,
    first: r0 && { title: r0.title, size: r0.size, hotness: r0.hotness, ih: r0.infoHash, magnet: r0.magnet && r0.magnet.slice(0, 46), src: r0.source }
  }) + '\n');

  const normalized = !!r0
    && r0.title === 'MT Fixture Pack (2026) 1080p'
    && r0.infoHash === HASH
    && r0.size === fixture.big + fixture.small
    && r0.hotness === 37
    && /^magnet:\?xt=urn:btih:/.test(r0.magnet || '')
    && found.results.length === 1;   // 同 infohash 去重

  // 错 token：错误应当进 errors，而不是抛穿整个搜索
  await call('saveSearchSource', [{ type: 'dht-index', baseUrl: base, apiKey: 'wrong-token' }]);
  const bad = await call('search', ['fixture', { providers: ['dht-index'], timeoutMs: 6000 }]);
  const wrongTokenHandled = bad.results.length === 0 && bad.errors.length === 1 && /401|unauthorized|错误/i.test(bad.errors[0].message);
  process.stderr.write('WRONG_TOKEN ' + JSON.stringify({ results: bad.results.length, errors: bad.errors }) + '\n');

  // 恢复正确 token 再测转任务
  await call('saveSearchSource', [{ id: entry.id, type: 'dht-index', baseUrl: base, apiKey: TOKEN }]);
  const again = await call('search', ['fixture', { providers: ['dht-index'], timeoutMs: 6000 }]);
  const created = await call('searchToTask', [again.results[0].id]);
  const taskOk = created && created.task && created.task.kind === 'bt' && created.task.id === HASH;

  let appPort = 0;
  for (let i = 0; i < 20 && !appPort; i++) {
    try { appPort = appPeerPort(seedPort); } catch {}
    if (!appPort) await new Promise((r) => setTimeout(r, 500));
  }
  if (appPort) seeder.torrents[0].addPeer('127.0.0.1:' + appPort);

  let done = false;
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      done = fs.statSync(path.join(dl, 'big.bin')).size === fixture.big
        && fs.statSync(path.join(dl, 'hello.txt')).size === fixture.small;
    } catch {}
  }

  const afterRemoveRaw = await call('removeSearchSource', [entry.id]);
  process.stderr.write('REMOVE_RAW ' + JSON.stringify(afterRemoveRaw) + ' entryId=' + entry.id + '\n');
  const afterRemove = afterRemoveRaw.map((s) => s.type);
  const gone = !afterRemove.includes('dht-index');

  await call('remove', [HASH, true]);
  await new Promise((r) => setTimeout(r, 1200));

  const pass = hiddenAtFirst && present && keyHidden && normalized && wrongTokenHandled && taskOk && done && gone;
  process.stderr.write('DETAIL ' + JSON.stringify({ hiddenAtFirst, present, keyHidden, normalized, wrongTokenHandled, taskOk, done, gone }) + '\n');
  process.stderr.write(pass ? 'E2E_SEARCH_INDEX_PASS\n' : 'E2E_SEARCH_INDEX_FAIL\n');
  seeder.destroy(() => { server.close(); fs.rmSync(sourcesFile, { force: true }); app.exit(pass ? 0 : 1); });
}).catch((e) => {
  process.stderr.write('FATAL ' + (e && e.stack || e) + '\n');
  server.close();
  app.exit(1);
});
