'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { StreamServer, isMediaName, needsTranscode } = require('./stream-server');
const { IndexerMonitor } = require('./indexer-monitor');
const { sniffPage } = require('./net/sniff');
const { sniffWithBrowser } = require('./net/sniff-browser');
const cloud = require('./net/cloud');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { TaskManager } = require('./tasks');
const { parseLink } = require('./net/uri');
const { SearchGateway } = require('./search/gateway');
const apibay = require('./search/providers/apibay');
const nyaa = require('./search/providers/nyaa');
const dmhy = require('./search/providers/dmhy');
const { SourceStore } = require('./search/sources');
const { LocalIndex } = require('./local-index');

// 应用名要在 whenReady 之前设定，userData 路径会跟着它走
const APP_NAME = 'NiuBiliTy';
const APP_TITLE = '牛B下载器';
app.setName(APP_NAME);

const HOME = os.homedir();
const DOWNLOADS_DIR = path.join(HOME, 'NiuBiliTyDownloads');
const LEGACY_DOWNLOADS = path.join(HOME, 'MicroTorrentDownloads');
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

// 老版本（MicroTorrent）的数据搬家：下载目录 + 搜索源配置
function migrateLegacyData() {
  try {
    if (!fs.existsSync(DOWNLOADS_DIR) && fs.existsSync(LEGACY_DOWNLOADS)) {
      fs.renameSync(LEGACY_DOWNLOADS, DOWNLOADS_DIR);
    }
  } catch { /* 搬不动就用新目录，不影响启动 */ }
  try {
    const newFile = path.join(app.getPath('userData'), 'search-sources.json');
    const oldFile = path.join(app.getPath('appData'), 'micro-torrent', 'search-sources.json');
    if (!fs.existsSync(newFile) && fs.existsSync(oldFile)) {
      fs.mkdirSync(path.dirname(newFile), { recursive: true });
      fs.copyFileSync(oldFile, newFile);
    }
  } catch { /* ignore */ }
}

let win = null;
let manager = null;
let search = null;
let sourceStore = null;
let localIndex = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function getManager() {
  if (manager) return manager;
  manager = new TaskManager({
    dir: DOWNLOADS_DIR,
    statePath: path.join(app.getPath('userData'), 'tasks.json'),
    torrentCacheDir: path.join(app.getPath('userData'), 'torrents'),
    onUpdate: (meta) => send('task:update', meta),
    onError: (msg) => send('app:error', msg)
  });
  // 预热：BT 客户端的对等端口在启动时就监听，避免第一个任务要等
  manager.warmUp();
  return manager;
}

function getLocalIndex() {
  if (localIndex) return localIndex;
  localIndex = new LocalIndex({
    userDataDir: app.getPath('userData'),
    indexerDir: require('./local-index').resolveIndexerDir(),
    log: (msg) => { if (process.env.MT_DEBUG) process.stderr.write(msg + '\n'); }
  });
  return localIndex;
}

function getSources() {
  if (sourceStore) return sourceStore;
  const filePath = process.env.MT_SOURCES_FILE || path.join(app.getPath('userData'), 'search-sources.json');
  sourceStore = new SourceStore({ filePath });
  try { require('./search/translate').init({ userDataDir: app.getPath('userData') }); } catch { /* 缓存不可用不影响搜索 */ }
  return sourceStore;
}

function getSearch() {
  if (search) return search;
  // 内置来源常驻；Jackett / Prowlarr 只有用户配置过才注册（没配就不出现）
  const providers = [apibay, nyaa, dmhy, ...getSources().providers()];
  // 发现层只依赖调度层的 add()，不碰任何协议实现
  search = new SearchGateway({ providers, manager: getManager() });
  return search;
}

function resetSearch() {
  search = null;
}

// 聚合源（Jackett/Prowlarr）冷启动要 8~14 秒，启动后先在后台打一次空查询把它们焐热，
// 免得用户第一次搜索遇到“超时未返回”。
function warmUpSearch() {
  setTimeout(async () => {
    try {
      const gw = getSearch();
      const providers = gw.listProviders().map((p) => p.id).filter((id) => id === 'prowlarr' || id === 'jackett');
      if (!providers.length) return;
      await gw.search('ubuntu', { providers, softTimeoutMs: 30000, graceMs: 25000 });
    } catch { /* 预热失败不影响使用 */ }
  }, 2500);
}

// 半秒推一次快照，保证速度等实时数值活跃
setInterval(() => {
  if (!win || win.isDestroyed()) return;
  const m = getManager();
  send('app:stats', m.stats());
}, 800);

// Prowlarr 源健康巡检（启动 90s 后跑一次，之后每 3 小时）
let indexerMonitor = null;
function getIndexerMonitor() {
  if (!indexerMonitor) {
    indexerMonitor = new IndexerMonitor({
      userDataDir: app.getPath('userData'),
      getSource: () => getSources().enabled().find((x) => x.type === 'prowlarr') || null,
      log: (msg) => console.log('[indexer]', msg)
    });
  }
  return indexerMonitor;
}

// ---------- 偏好设置（并发 / 连接数 / 全局限速）----------
function prefsPath() { return path.join(app.getPath('userData'), 'prefs.json'); }

function loadPrefs() {
  const def = { maxConcurrent: 3, connections: 8, globalLimit: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(prefsPath(), 'utf8'));
    return { ...def, ...raw };
  } catch { return def; }
}

function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  next.maxConcurrent = Math.min(8, Math.max(1, Number(next.maxConcurrent) || 3));
  next.connections = Math.min(32, Math.max(1, Number(next.connections) || 8));
  next.globalLimit = Math.max(0, Number(next.globalLimit) || 0);
  try { fs.writeFileSync(prefsPath(), JSON.stringify(next, null, 2)); } catch { /* ignore */ }
  applyPrefs(next);
  return next;
}

function applyPrefs(p) {
  const m = getManager();
  m.opts.maxConcurrent = p.maxConcurrent;
  m.opts.connections = p.connections;
  m.opts.globalLimit = p.globalLimit;
  if (p.globalLimit > 0) {
    if (!m.limiter) m.limiter = new (require('./tasks').RateLimiter)(p.globalLimit);
    else m.limiter.rate = p.globalLimit;
  } else {
    m.limiter = null;
  }
  try {
    const client = m.btClient;
    if (client && client.throttleDownload) client.throttleDownload(p.globalLimit || -1);
  } catch { /* ignore */ }
  m.pump();
}

// ---------- 本地 HTTP API（浏览器扩展 / 命令行 / 自动化）----------
const LOCAL_API_PORT = 8977;
let localApiServer = null;

function startLocalApi() {
  if (localApiServer) return;
  const tokenFile = path.join(app.getPath('userData'), 'api-token.txt');
  let token = '';
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!token) {
    token = crypto.randomBytes(18).toString('hex');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  }
  if (process.platform !== 'win32') fs.chmodSync(tokenFile, 0o600);

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${LOCAL_API_PORT}`);
    const origin = req.headers.origin;
    const extensionOrigin = typeof origin === 'string'
      && /^(?:(?:chrome|moz)-extension:\/\/[a-zA-Z0-9_-]+|safari-web-extension:\/\/[a-f0-9-]+)$/i.test(origin);
    const cors = {
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Vary': 'Origin'
    };
    if (extensionOrigin) cors['Access-Control-Allow-Origin'] = origin;
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') {
      if (!extensionOrigin) { res.writeHead(403, cors); res.end(); return; }
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (u.pathname === '/ping') {
      return reply(200, { ok: true, app: 'NiuBiliTy', version: app.getVersion() });
    }
    if (req.headers['x-api-token'] !== token) {
      return reply(401, { ok: false, error: 'token 不对' });
    }
    if (u.pathname === '/add') {
      let links = [];
      if (req.method === 'POST') {
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
          req.on('end', () => resolve(raw));
        });
        try {
          const json = JSON.parse(body || '{}');
          links = Array.isArray(json.links) ? json.links : (json.url ? [json.url] : []);
        } catch { /* 不是 JSON，按纯文本处理 */ }
        if (!links.length && body.trim()) links = body.trim().split(/\r?\n/);
      } else {
        links = u.searchParams.getAll('url');
      }
      const added = [];
      for (const l of links) {
        try { const t = await getManager().add(String(l).trim()); added.push(t && t.id); }
        catch (e) { added.push({ error: (e.message || String(e)) }); }
      }
      focusMainWindow();
      return reply(200, { ok: true, added });
    }
    if (u.pathname === '/status') {
      return reply(200, { ok: true, stats: getManager().stats(), tasks: getManager().snapshot().length });
    }
    reply(404, { ok: false, error: 'not found' });
  });

  srv.on('error', (e) => { console.log('[api] 启动失败:', e.message); });
  srv.listen(LOCAL_API_PORT, '127.0.0.1', () => {
    console.log(`[api] 本地接口  http://127.0.0.1:${LOCAL_API_PORT}/add  (token 在 userData/api-token.txt)`);
  });
  localApiServer = srv;
}

// 边下边播：本地 HTTP 服务，把 torrent 文件按 Range 读出来
let streamServer = null;
function getStreamServer() {
  if (!streamServer) {
    streamServer = new StreamServer({ getTask: (id) => getManager().get(id) });
  }
  return streamServer;
}

// ---------- IPC ----------

ipcMain.handle('task:add', async (_e, input) => {
  const m = getManager();
  return m.add(input);
});

ipcMain.handle('task:add-file', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择种子或流清单文件',
    filters: [
      { name: '种子 / 流清单', extensions: ['torrent', 'm3u8', 'mpd', 'meta4', 'metalink'] },
      { name: '全部文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const m = getManager();
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.torrent')) {
    return m.add('file://' + filePath);
  }
  if (lower.endsWith('.m3u8') || lower.endsWith('.mpd') || lower.endsWith('.meta4') || lower.endsWith('.metalink')) {
    return m.add('file://' + filePath);
  }
  // 其它文件当作本地 torrent 尝试
  return m.add('file://' + filePath);
});

// 拖拽进来的文件（种子 / 流清单 / metalink）：按路径直接加
ipcMain.handle('task:add-paths', async (_e, paths) => {
  const m = getManager();
  const added = [];
  const failed = [];
  for (const p of (Array.isArray(paths) ? paths : [paths])) {
    if (!p || typeof p !== 'string') continue;
    try {
      const task = m.add('file://' + p);
      added.push({ path: p, id: task && task.id });
    } catch (err) {
      failed.push({ path: p, error: (err && err.message) || String(err) });
    }
  }
  return { added, failed };
});

// 有些来源拖进来的 File 拿不到磁盘路径，退回"写临时文件再加"
ipcMain.handle('task:add-filedata', async (_e, { name, buffer } = {}) => {
  if (!buffer) throw new Error('文件内容为空');
  const dir = path.join(app.getPath('userData'), 'dropped');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || 'dropped.torrent').replace(/[^\w.\-\u4e00-\u9fff]+/g, '_');
  const target = path.join(dir, `${Date.now()}-${safe}`);
  fs.writeFileSync(target, Buffer.from(buffer));
  return getManager().add('file://' + target);
});

ipcMain.handle('play:url', async (_e, { id, fileIndex, forceTranscode }) => {
  const task = getManager().get(id);
  if (!task || task.kind !== 'bt') throw new Error('只有 BT 任务可以边下边播');
  const torrent = task.job && task.job.torrent;
  const file = torrent && torrent.files && torrent.files[fileIndex];
  if (!file) throw new Error('文件不存在');
  if (!isMediaName(file.name)) throw new Error('这个文件不是音视频');

  const server = getStreamServer();
  const mode = forceTranscode || needsTranscode(file.name) ? 'transcode' : 'direct';
  const url = mode === 'transcode'
    ? await server.transcodeUrlFor(id, fileIndex)
    : await server.urlFor(id, fileIndex);
  return { url, mode, name: file.name, length: file.length, done: !!file.done, hasFfmpeg: !!require('./net/media').findFfmpeg() };
});

ipcMain.handle('play:ranges', (_e, { id, fileIndex }) => {
  return getManager().fileRanges(id, fileIndex);
});

ipcMain.handle('task:pause', (_e, id) => { getManager().pause(id); });
ipcMain.handle('task:resume', (_e, id) => { getManager().resume(id); });
ipcMain.handle('task:remove', (_e, { id, deleteFiles }) => {
  getManager().remove(id, { deleteFiles: !!deleteFiles });
});
ipcMain.handle('task:select-files', (_e, { id, indices }) => {
  getManager().selectFiles(id, indices);
});
ipcMain.handle('task:open-folder', async (_e, id) => {
  const target = await getManager().openFolder(id);
  if (target) shell.showItemInFolder ? shell.openPath(target) : shell.openPath(target);
});

// ---------- 搜索（发现层） ----------

ipcMain.handle('search:providers', () => getSearch().listProviders());

ipcMain.handle('search:sources', () => ({
  sources: getSources().list(),
  types: getSources().types(),
  file: getSources().filePath
}));

ipcMain.handle('search:save-source', (_e, input) => {
  const list = getSources().save(input);
  resetSearch();
  return list;
});

ipcMain.handle('search:remove-source', (_e, id) => {
  const list = getSources().remove(id);
  resetSearch();
  return list;
});

// 保存前先探一下：能不能连通、Key 对不对
ipcMain.handle('search:test-source', async (_e, input) => {
  const { normalizeSource } = require('./search/sources');
  const cfg = normalizeSource(input);
  const mod = cfg.type === 'jackett' ? require('./search/providers/jackett') : require('./search/providers/prowlarr');
  const provider = mod.makeProvider(cfg);
  const started = Date.now();
  try {
    const results = await provider.search('ubuntu', { limit: 5 });
    return { ok: true, count: results.length, tookMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.message || String(err), tookMs: Date.now() - started };
  }
});

// ---------- 网盘 ----------
function cloudAccountPath() { return path.join(app.getPath('userData'), 'cloud-accounts.json'); }

function loadCloudAccount() {
  try { return JSON.parse(fs.readFileSync(cloudAccountPath(), 'utf8')); } catch { return {}; }
}

function saveCloudAccount(patch) {
  const next = { ...loadCloudAccount(), ...patch };
  fs.writeFileSync(cloudAccountPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(cloudAccountPath(), 0o600);
  return next;
}

ipcMain.handle('cloud:account', (_e, patch) => {
  if (patch) saveCloudAccount(patch);
  const acc = loadCloudAccount();
  // 只回传"是否已配置"，不回传凭据明文
  return {
    aliyun: !!acc.aliyunRefreshToken,
    baidu: !!acc.baiduCookie,
    aliyunHint: acc.aliyunRefreshToken ? acc.aliyunRefreshToken.slice(0, 6) + '***' : '',
    baiduHint: acc.baiduCookie ? acc.baiduCookie.slice(0, 6) + '***' : ''
  };
});

ipcMain.handle('cloud:list', async (_e, { provider, folderId } = {}) => {
  const acc = loadCloudAccount();
  if (provider === 'aliyun') {
    if (!acc.aliyunRefreshToken) throw new Error('还没填阿里云盘的 refresh_token');
    return cloud.aliyunList(acc.aliyunRefreshToken, folderId || 'root');
  }
  if (provider === 'baidu') {
    if (!acc.baiduCookie) throw new Error('还没填百度网盘的 Cookie');
    return cloud.baiduList(acc.baiduCookie, folderId || '/');
  }
  throw new Error('未知网盘: ' + provider);
});

ipcMain.handle('cloud:add', async (_e, { provider, id } = {}) => {
  const acc = loadCloudAccount();
  if (provider === 'aliyun') {
    const d = await cloud.aliyunDownloadUrl(acc.aliyunRefreshToken, id);
    const task = await getManager().add({ url: d.url, headers: {} });
    focusMainWindow();
    return { ok: true, task, name: d.name };
  }
  if (provider === 'baidu') {
    const d = await cloud.baiduDownloadUrl(acc.baiduCookie, id);
    const task = await getManager().add({ url: d.url, headers: d.headers });
    focusMainWindow();
    return { ok: true, task, name: d.name };
  }
  throw new Error('未知网盘: ' + provider);
});

// 没有公开 API 的网盘：直链 + 该站要求的 Referer/Cookie 兜底
ipcMain.handle('cloud:add-direct', async (_e, { url, provider, cookie } = {}) => {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) throw new Error('直链必须是 http/https 地址');
  const REFERER = {
    quark: 'https://pan.quark.cn/',
    '115': 'https://115.com/',
    tianyi: 'https://cloud.189.cn/',
    direct: ''
  };
  const headers = {};
  const ref = REFERER[provider] || '';
  if (ref) headers.Referer = ref;
  if (cookie && String(cookie).trim()) headers.Cookie = String(cookie).trim();
  const task = await getManager().add({ url: value, headers: Object.keys(headers).length ? headers : undefined });
  focusMainWindow();
  return { ok: true, task, name: task && task.name };
});

ipcMain.handle('app:prefs', (_e, patch) => (patch ? savePrefs(patch) : loadPrefs()));

ipcMain.handle('app:api-info', () => {
  let token = '';
  try { token = fs.readFileSync(path.join(app.getPath('userData'), 'api-token.txt'), 'utf8').trim(); } catch { /* ignore */ }
  return { port: LOCAL_API_PORT, token };
});

ipcMain.handle('app:sniff', async (_e, { url, deep } = {}) => {
  if (deep) return sniffWithBrowser(url);
  // 先静态解析（快），没结果再由前端决定要不要深度嗅探
  const quick = await sniffPage(url);
  return quick;
});

ipcMain.handle('search:health', async (_e, { run } = {}) => {
  const mon = getIndexerMonitor();
  if (run) return mon.checkOnce();
  return mon.lastReport;
});

ipcMain.handle('search:query', async (_e, { query, providers, limit, expand } = {}) => {
  return getSearch().search(query, { providers, limit, expand: !!expand });
});

ipcMain.handle('search:to-task', async (_e, { resultId, deleteFiles } = {}) => {
  const { result, task } = await getSearch().toTask(resultId, { deleteFiles: !!deleteFiles });
  return { task, title: result.title };
});

// ---------- 本机自建索引 ----------

ipcMain.handle('index:local-status', async () => getLocalIndex().status());

ipcMain.handle('index:local-enable', async () => {
  const li = getLocalIndex();
  li.load();
  const started = await li.start();
  if (!started.ok) {
    li.enabled = false;
    li.persist();
    return { ok: false, error: started.error || '启动失败' };
  }
  li.enabled = true;
  li.persist();
  // 自动把一个「自建 DHT 索引」源指向本机实例
  getSources().save({ type: 'dht-index', label: '本机索引', baseUrl: li.url(), apiKey: li.token });
  resetSearch();
  return { ok: true, status: await li.status() };
});

ipcMain.handle('index:local-disable', async () => {
  const li = getLocalIndex();
  await li.stop();
  li.enabled = false;
  li.persist();
  // 把指向本机的源删掉（保留用户手配的服务器索引）
  for (const s of getSources().list()) {
    if (s.type === 'dht-index' && String(s.baseUrl).includes('127.0.0.1:' + li.port)) {
      getSources().remove(s.id);
    }
  }
  resetSearch();
  return { ok: true, status: await li.status() };
});

ipcMain.handle('app:downloads-dir', () => DOWNLOADS_DIR);
ipcMain.handle('app:snapshot', () => getManager().snapshot());
ipcMain.handle('app:global-stats', () => getManager().stats());
ipcMain.handle('app:capabilities', () => ({
  ffmpeg: !!require('./net/media').findFfmpeg(),
  downloadsDir: DOWNLOADS_DIR
}));

// 把用户拖进来的链接/文本交给解析器，同时在日志里留痕
ipcMain.handle('app:detect', (_e, input) => {
  const parsed = parseLink(input);
  return parsed ? { kind: parsed.kind, url: parsed.url || null, hash: parsed.hash || null, note: parsed.note || null } : null;
});

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    title: APP_TITLE,
    icon: ICON_PATH,
    backgroundColor: '#1e1f24',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// 只允许一个实例：第二个实例的参数（magnet: / .torrent）交给已有实例处理。
// 测试模式（MT_TEST=1）跳过，否则测试会和正在运行的正式实例抢锁、直接退出。
const gotTheLock = process.env.MT_TEST ? true : app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    focusMainWindow();
    for (const arg of argv) handleOpenTarget(arg);
  });
}

function focusMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 处理系统送进来的 magnet: / .torrent / 普通链接 */
function handleOpenTarget(target) {
  if (!target || typeof target !== 'string') return;
  const value = target.trim();
  if (!value) return;
  if (/^magnet:/i.test(value) || /\.torrent$/i.test(value) || /^https?:\/\//i.test(value)) {
    const input = /\.torrent$/i.test(value) && !/^file:/i.test(value) ? 'file://' + value : value;
    getManager().add(input)
      .then((t) => { focusMainWindow(); bootLog('已从系统打开: ' + (t && t.name || value.slice(0, 60))); })
      .catch((e) => bootLog('打开失败: ' + (e.message || e)));
  }
}

function bootLog(msg) {
  console.log('[open]', msg);
  send('app:toast', msg);
}

app.on('will-finish-launching', () => {
  app.on('open-url', (event, url) => { event.preventDefault(); handleOpenTarget(url); });
  app.on('open-file', (event, filePath) => { event.preventDefault(); handleOpenTarget(filePath); });
});

app.whenReady().then(async () => {
  migrateLegacyData();
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(ICON_PATH); } catch { /* ignore */ }
  }
  createWindow();
  getManager();

  // 注册 magnet: 协议（配合 electron-builder 的 protocols 配置）
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('magnet', process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient('magnet');
    }
  } catch { /* 注册失败不影响使用 */ }

  // 冷启动带参数（从浏览器点 magnet 链接、双击 .torrent）
  for (const arg of process.argv.slice(1)) {
    if (/^magnet:/i.test(arg) || /\.torrent$/i.test(arg)) handleOpenTarget(arg);
  }

  startLocalApi();
  try { applyPrefs(loadPrefs()); } catch (e) { console.log('[prefs] 应用失败:', e.message); }
  // 恢复上次的任务（BT 用本地缓存的 .torrent，不用等 DHT）
  getManager().restore()
    .then((r) => { if (r && r.restored) console.log(`[restore] 已恢复 ${r.restored} 个任务，跳过 ${r.skipped} 个`); })
    .catch((e) => console.log('[restore] 失败:', e.message));
  warmUpSearch();
  try {
    const mon = getIndexerMonitor();
    global.__indexerMonitor = mon;   // 便于自测/排障
    mon.start();
  } catch (e) { console.log('[indexer] 巡检启动失败:', e.message); }

  // 上次勾了「本机也跑一个索引」就自动拉起
  const li = getLocalIndex();
  if (li.load()) {
    li.start().then((r) => { if (!r.ok) li.log && li.log('[local-index] 恢复失败: ' + r.error); });
  }
  app.on('before-quit', () => {
  try { getManager().saveNow(); } catch { /* ignore */ }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (manager && manager.btClient) manager.btClient.destroy(() => {});
  if (localIndex) localIndex.stop();
});
