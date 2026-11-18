// 端到端测试：搜索（发现层）→ 选中结果 → 变成下载任务（执行层）。
//
// 用本地 HTTP 服务器冒充 apibay 接口，返回「真实存在的 infohash」（由本地做种端提供），
// 这样整条链路（provider 解析 → 网关标准化/去重/排序 → toTask → TaskManager.add →
// 下载完成）都是真的，只有搜索结果的数据源换成了本地。
//
// 运行：env -u ELECTRON_RUN_AS_NODE npx electron test/e2e-search.js
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

let searchPayload = []; // apibay 格式的假数据，等做种端起来后填

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/q.php') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(searchPayload));
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
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.MT_APIC_URL = base + '/q.php'; // provider 支持指向镜像/测试服务器

  // 做种端：给搜索结果提供一个真的能下的资源
  const mod = await import('webtorrent');
  const W = mod.default || mod;
  const seeder = new W({ maxConns: 10, dht: false, utp: false });
  await new Promise((r) => seeder.once('listening', r));
  const seedPort = seeder.address().port;
  const st = await new Promise((r) => seeder.seed(fixture.dir, { announce: [] }, r));
  const HASH = st.infoHash;

  const now = Math.floor(Date.now() / 1000);
  searchPayload = [
    {
      id: '111', name: 'MT Fixture Pack (2026) 1080p', info_hash: HASH.toUpperCase(),
      leechers: '3', seeders: '42', size: String(fixture.big + fixture.small),
      num_files: '2', username: 'tester', added: String(now - 3600),
      status: 'trusted', category: '303', imdb: ''
    },
    {
      // 同一个 infohash、做种更少：应当被去重合并掉
      id: '112', name: 'MT Fixture Pack (2026) 1080p [copy]', info_hash: HASH.toUpperCase(),
      leechers: '1', seeders: '5', size: String(fixture.big + fixture.small),
      num_files: '2', username: 'tester', added: String(now - 7200),
      status: 'member', category: '303', imdb: ''
    },
    {
      // 无效条目（空 infohash）应被过滤
      id: '0', name: 'No results returned', info_hash: '0000000000000000000000000000000000000000',
      leechers: '0', seeders: '0', size: '0', num_files: '0', username: '', added: '0',
      status: 'member', category: '0', imdb: ''
    }
  ];

  const win = BrowserWindow.getAllWindows()[0];
  const call = (fn, args = []) => win.webContents.executeJavaScript(
    'window.api.' + fn + '(' + args.map((a) => JSON.stringify(a)).join(',') + ')', true);
  const evalJS = (code) => win.webContents.executeJavaScript(code, true);
  await evalJS('window.__tasks={}; window.api.onTaskUpdate(t=>{window.__tasks[t.id]=t;}); true;');

  // ---- 1) 搜索 ----
  const found = await call('search', ['fixture pack', { providers: ['apibay'] }]);
  const r0 = found.results && found.results[0];
  process.stderr.write('SEARCH ' + JSON.stringify({
    count: found.results && found.results.length,
    took: found.tookMs,
    errors: found.errors,
    result: r0 && {
      title: r0.title, source: r0.source, size: r0.size, seeders: r0.seeders,
      category: r0.categoryLabel, publishedAt: r0.publishedAt,
      magnet: r0.magnet && r0.magnet.slice(0, 52), infoHash: r0.infoHash
    }
  }) + '\n');

  const normalized = !!r0
    && r0.title === 'MT Fixture Pack (2026) 1080p'
    && r0.seeders === 42
    && r0.size === fixture.big + fixture.small
    && r0.categoryLabel === '软件'
    && typeof r0.publishedAt === 'string' && r0.publishedAt.endsWith('Z')
    && r0.magnet.startsWith('magnet:?xt=urn:btih:' + HASH)
    && found.results.length === 1; // 去重 + 过滤空条目

  // ---- 2) 选中结果 → 转任务 ----
  const created = await call('searchToTask', [r0.id]);
  const task = created.task;
  process.stderr.write('TO_TASK ' + JSON.stringify({ id: task && task.id, kind: task && task.kind, name: task && task.name }) + '\n');
  const taskOk = !!task && task.kind === 'bt' && task.id === HASH;

  // ---- 3) 走完下载 ----
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

  // ---- 4) 无效 id 应该报错而不是新建任务 ----
  let staleErr = '';
  try {
    await call('searchToTask', ['not-a-real-result-id']);
  } catch (e) {
    staleErr = String(e && e.message || e);
  }
  const staleRejected = /失效|重新搜索/.test(staleErr);

  // ---- 5) 空关键词应当被拒绝 ----
  let emptyErr = '';
  try {
    await call('search', ['   ', { providers: ['apibay'] }]);
  } catch (e) {
    emptyErr = String(e && e.message || e);
  }
  const emptyRejected = /不能为空/.test(emptyErr);

  await call('remove', [HASH, true]);
  await new Promise((r) => setTimeout(r, 1500));

  const pass = normalized && taskOk && done && staleRejected && emptyRejected;
  process.stderr.write('DETAIL ' + JSON.stringify({ normalized, taskOk, done, staleRejected, emptyRejected }) + '\n');
  process.stderr.write(pass ? 'E2E_SEARCH_PASS\n' : 'E2E_SEARCH_FAIL\n');
  seeder.destroy(() => { server.close(); app.exit(pass ? 0 : 1); });
}).catch((e) => {
  process.stderr.write('FATAL ' + (e && e.stack || e) + '\n');
  server.close();
  app.exit(1);
});
