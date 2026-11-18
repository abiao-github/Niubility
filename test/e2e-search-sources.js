// 端到端测试：自建聚合源（Jackett / Prowlarr）接入发现层。
//
// 起一个本地服务器同时冒充：
//   · Jackett 的 Torznab 聚合接口  /api/v2.0/indexers/all/results/torznab/api
//   · Prowlarr 的 JSON 搜索接口    /api/v1/search
// 两者返回同一个真实 infohash（由本地做种端提供），验证：
//   1. 未配置时不出现 jackett/prowlarr 源
//   2. 保存配置后源出现（且 API Key 不回传明文）
//   3. Torznab XML / Prowlarr JSON 两条解析路径都能映射成标准 SearchResult
//   4. 跨源去重（同一 infohash 只留一条，来源合并）
//   5. 「测试连接」能区分成功 / Key 错误
//   6. 选中结果转任务 → 真的下载完成
//   7. 移除配置后源消失
//
// 运行：env -u ELECTRON_RUN_AS_NODE npx electron test/e2e-search-sources.js
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

// 配置写到临时文件，别污染真实 userData
const sourcesFile = path.join(os.tmpdir(), 'mt-e2e-sources.json');
fs.rmSync(sourcesFile, { force: true });
process.env.MT_SOURCES_FILE = sourcesFile;

const API_KEY = 'test-key-123';
let HASH = null;
let PORT = 0;

function torznabXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel>
<title>Jackett</title>
<item>
  <title>MT Fixture Pack (2026) 1080p [Jackett]</title>
  <guid>http://idx/1</guid>
  <link>http://127.0.0.1:${PORT}/download/1.torrent</link>
  <pubDate>Sun, 16 Nov 2026 08:00:00 +0000</pubDate>
  <size>${fixture.big + fixture.small}</size>
  <enclosure url="http://127.0.0.1:${PORT}/download/1.torrent" length="${fixture.big + fixture.small}" type="application/x-bittorrent"/>
  <torznab:attr name="seeders" value="37"/>
  <torznab:attr name="peers" value="40"/>
  <torznab:attr name="infohash" value="${HASH.toUpperCase()}"/>
  <torznab:attr name="jackettindexer" value="1337x"/>
  <category>3030</category>
</item>
</channel>
</rss>`;
}

function prowlarrJson() {
  return JSON.stringify([{
    guid: 'http://127.0.0.1:' + PORT + '/details/2',
    title: 'MT Fixture Pack (2026) 1080p [Prowlarr]',
    size: fixture.big + fixture.small,
    seeders: 12,
    leechers: 2,
    publishDate: '2026-11-15T09:00:00Z',
    indexer: 'Nyaa',
    magnetUrl: `magnet:?xt=urn:btih:${HASH}`,
    infoHash: HASH,
    categories: [{ id: 2040, name: 'Movies/HD' }]
  }]);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const key = u.searchParams.get('apikey') || req.headers['x-api-key'];

  if (u.pathname.startsWith('/api/v2.0/indexers/')) {
    if (key !== API_KEY) {
      res.setHeader('Content-Type', 'application/xml');
      return res.end('<?xml version="1.0"?><rss><error code="100" description="Invalid API Key"/></rss>');
    }
    res.setHeader('Content-Type', 'application/xml');
    return res.end(torznabXml());
  }
  if (u.pathname === '/api/v1/search') {
    if (key !== API_KEY) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ message: 'Unauthorized' }));
    }
    res.setHeader('Content-Type', 'application/json');
    return res.end(prowlarrJson());
  }
  res.statusCode = 404;
  res.end('nope');
});

require('../src/main.js');

function appPeerPort(exclude) {
  const out = execSync('lsof -nP -iTCP -sTCP:LISTEN -a -p ' + process.pid).toString();
  return [...out.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((m) => +m[1]).find((p) => p !== exclude) || 0;
}

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  const base = `http://127.0.0.1:${PORT}`;

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

  // 1) 初始状态：只有内置源
  const before = await call('searchProviders', []);
  const beforeIds = before.map((p) => p.id).sort();
  process.stderr.write('PROVIDERS_BEFORE ' + JSON.stringify(beforeIds) + '\n');
  const hiddenAtFirst = !beforeIds.includes('jackett') && !beforeIds.includes('prowlarr');

  // 2) 保存两个自建源
  const savedJ = await call('saveSearchSource', [{ type: 'jackett', baseUrl: base, apiKey: API_KEY }]);
  const savedP = await call('saveSearchSource', [{ type: 'prowlarr', baseUrl: base, apiKey: API_KEY }]);
  const after = await call('searchProviders', []);
  const afterIds = after.map((p) => p.id).sort();
  process.stderr.write('PROVIDERS_AFTER ' + JSON.stringify(afterIds) + '\n');
  const allPresent = ['apibay', 'jackett', 'nyaa', 'prowlarr'].every((id) => afterIds.includes(id));
  const keyHidden = savedJ.every((s) => !JSON.stringify(s).includes(API_KEY)) && savedP.length === 2;

  // 3) 两个源并发搜索（内置源会超时但被软超时放行）
  const found = await call('search', ['fixture', { providers: ['jackett', 'prowlarr'], timeoutMs: 8000 }]);
  process.stderr.write('SEARCH ' + JSON.stringify({
    count: found.results.length,
    errors: found.errors,
    rows: found.results.map((r) => ({ title: r.title, source: r.source, seeders: r.seeders, size: r.size, cat: r.categoryLabel, ih: r.infoHash && r.infoHash.slice(0, 8), magnet: !!r.magnet }))
  }) + '\n');

  const byHash = found.results.every((r) => r.infoHash === HASH);
  const deduped = found.results.length === 1;                 // 两条不同来源，同 infohash → 合并
  const winner = found.results[0];
  const keptBest = winner && winner.seeders === 37;          // 保留做种多的那条
  const merged = winner && Array.isArray(winner.alsoOn) && winner.alsoOn.includes('Prowlarr');
  const mapped = winner && winner.size === fixture.big + fixture.small
    && typeof winner.publishedAt === 'string' && winner.publishedAt.endsWith('Z')
    && winner.categoryLabel === '软件'
    && !!winner.magnet;

  // 4) 测试连接：对的 Key 成功、错的 Key 失败
  const okTest = await call('testSearchSource', [{ type: 'jackett', baseUrl: base, apiKey: API_KEY }]);
  const badTest = await call('testSearchSource', [{ type: 'jackett', baseUrl: base, apiKey: 'wrong-key' }]);
  process.stderr.write('TEST_SOURCE ok=' + JSON.stringify(okTest) + ' bad=' + JSON.stringify(badTest) + '\n');
  const testWorks = okTest.ok === true && okTest.count >= 1 && badTest.ok === false && /API Key|报错|401/i.test(badTest.error || '');

  // 5) 选中结果 → 任务 → 下载
  const created = await call('searchToTask', [winner.id]);
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
  process.stderr.write('DOWNLOAD_DONE ' + done + '\n');

  // 6) 移除两个源 → provider 消失
  const list = await call('searchSources', []);
  for (const s of list.sources) await call('removeSearchSource', [s.id]);
  const afterRemove = (await call('searchProviders', [])).map((p) => p.id).sort();
  process.stderr.write('PROVIDERS_AFTER_REMOVE ' + JSON.stringify(afterRemove) + '\n');
  const removedOk = !afterRemove.includes('jackett') && !afterRemove.includes('prowlarr');

  await call('remove', [HASH, true]);
  await new Promise((r) => setTimeout(r, 1500));

  const pass = hiddenAtFirst && allPresent && keyHidden && byHash && deduped && keptBest
    && merged && mapped && testWorks && taskOk && done && removedOk;
  process.stderr.write('DETAIL ' + JSON.stringify({
    hiddenAtFirst, allPresent, keyHidden, byHash, deduped, keptBest, merged, mapped, testWorks, taskOk, done, removedOk
  }) + '\n');
  process.stderr.write(pass ? 'E2E_SEARCH_SOURCES_PASS\n' : 'E2E_SEARCH_SOURCES_FAIL\n');
  seeder.destroy(() => { server.close(); fs.rmSync(sourcesFile, { force: true }); app.exit(pass ? 0 : 1); });
}).catch((e) => {
  process.stderr.write('FATAL ' + (e && e.stack || e) + '\n');
  server.close();
  app.exit(1);
});
