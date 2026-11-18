'use strict';

// 统一任务管理：BT / HTTP(S) / FTP(S) / HLS / DASH / Metalink / IPFS / eD2K。
// 每种协议一个适配器，对外只暴露 add/pause/resume/remove/selectFiles/snapshot。

const fs = require('fs');
const path = require('path');

const util = require('./net/util');
const http = require('./net/http');
const ftp = require('./net/ftp');
const ipfs = require('./net/ipfs');
const metalink = require('./net/metalink');
const hls = require('./net/hls');
const dash = require('./net/dash');
const media = require('./net/media');
const ed2k = require('./net/ed2k');
const { downloadTrack } = require('./net/segments');
const { parseLink, KIND_LABEL } = require('./net/uri');

const TICK_MS = 700;
const MEDIA_EXT = { hls: 'mp4', dash: 'mp4' };

/** 简单的令牌桶限速器：全局限速用 */
class RateLimiter {
  constructor(bytesPerSec) {
    this.rate = bytesPerSec;
    this.tokens = bytesPerSec;
    this.last = Date.now();
    this.waiters = [];
    this.timer = setInterval(() => this.refill(), 50);
    if (this.timer.unref) this.timer.unref();
  }

  refill() {
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    if (dt <= 0) return;
    this.last = now;
    this.tokens = Math.min(this.rate, this.tokens + this.rate * dt);
    while (this.waiters.length && this.tokens > 0) {
      const w = this.waiters[0];
      if (w.bytes <= this.tokens) {
        this.tokens -= w.bytes;
        this.waiters.shift();
        w.resolve();
      } else break;
    }
  }

  take(bytes) {
    if (bytes <= 0) return Promise.resolve();
    if (this.tokens >= bytes) { this.tokens -= bytes; return Promise.resolve(); }
    return new Promise((resolve) => this.waiters.push({ bytes, resolve }));
  }
}

function partPathOf(task) {
  return task.savePath + '.part';
}

class TaskManager {
  constructor({ dir, onUpdate, onError, statePath, torrentCacheDir, options }) {
    this.opts = { maxConcurrent: 3, connections: 8, globalLimit: 0, ...(options || {}) };
    this.queue = [];
    this.limiter = this.opts.globalLimit > 0 ? new RateLimiter(this.opts.globalLimit) : null;
    this.dir = util.ensureDir(dir);
    this.statePath = statePath || null;
    this.torrentCacheDir = torrentCacheDir || null;
    if (this.torrentCacheDir) util.ensureDir(this.torrentCacheDir);
    this.tasks = new Map();
    this.saveTimer = null;
    this.onUpdate = onUpdate || (() => {});
    this.onError = onError || (() => {});
    this.btClient = null;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  // ---------- 持久化 ----------

  /** 保存任务列表（写临时文件再 rename，避免写一半断电损坏） */
  serialize() {
    const out = [];
    for (const t of this.tasks.values()) {
      if (!t.source) continue;
      out.push({
        id: t.id,
        kind: t.kind,
        source: t.source,
        name: t.name,
        savePath: t.savePath,
        total: t.total || 0,
        downloaded: t.downloaded || 0,
        state: t.state,
        addedAt: t.addedAt || Date.now(),
        selection: t.selection ? [...t.selection] : null
      });
    }
    return out;
  }

  scheduleSave() {
    if (!this.statePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1500);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  saveNow() {
    if (!this.statePath) return;
    try {
      const tmp = this.statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: this.serialize() }, null, 2));
      fs.renameSync(tmp, this.statePath);
    } catch (err) {
      this.onError('保存任务列表失败: ' + (err.message || err));
    }
  }

  torrentCachePath(infoHash) {
    return this.torrentCacheDir ? path.join(this.torrentCacheDir, `${infoHash}.torrent`) : null;
  }

  /** 启动时恢复上次的任务 */
  async restore() {
    if (!this.statePath || !fs.existsSync(this.statePath)) return { restored: 0, skipped: 0 };
    let data = null;
    try { data = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { return { restored: 0, skipped: 0 }; }
    const list = Array.isArray(data && data.tasks) ? data.tasks : [];
    let restored = 0;
    let skipped = 0;

    for (const entry of list) {
      try {
        // 已完成且文件还在：不复用下载，直接登记为完成态
        if (entry.state === 'done' && entry.savePath && fs.existsSync(entry.savePath)) {
          const task = {
            id: entry.id,
            kind: entry.kind,
            source: entry.source,
            name: entry.name,
            savePath: entry.savePath,
            total: entry.total || fs.statSync(entry.savePath).size,
            downloaded: entry.total || fs.statSync(entry.savePath).size,
            state: 'done',
            addedAt: entry.addedAt,
            job: null,
            selection: null,
            speed: 0
          };
          this.tasks.set(task.id, task);
          this.emit(task);
          restored += 1;
          continue;
        }

        // BT 优先用本地缓存的 .torrent 恢复（不用等 DHT 拿元数据）
        let source = entry.source;
        if (entry.kind === 'bt' && entry.id) {
          const cached = this.torrentCachePath(entry.id);
          if (cached && fs.existsSync(cached)) source = 'file://' + cached;
        }

        const task = await this.add(source, { restoring: true });
        if (!task) { skipped += 1; continue; }

        if (entry.selection && entry.selection.length) {
          try { await this.selectFiles(task.id, entry.selection); } catch { /* 忽略 */ }
        }
        if (entry.state === 'paused' || entry.state === 'error') {
          this.pause(task.id);
        }
        restored += 1;
      } catch (err) {
        skipped += 1;
        console.log('[restore] 跳过任务:', entry && entry.name, (err && err.message) || err);
      }
    }

    return { restored, skipped };
  }

  // ---------- 查询 ----------

  get(id) {
    return this.tasks.get(id);
  }

  meta(task) {
    return {
      id: task.id,
      kind: task.kind,
      label: KIND_LABEL[task.kind] || task.kind.toUpperCase(),
      name: task.name,
      source: task.source,
      total: task.total,
      downloaded: task.downloaded,
      progress: task.total ? Math.min(1, task.downloaded / task.total) : 0,
      speed: task.state === 'active' ? (task.speed || 0) : 0,
      uploadSpeed: task.uploadSpeed || 0,
      peers: task.peers || 0,
      seeds: task.seeds || 0,
      paused: task.state === 'paused',
      queued: task.state === 'queued',
      done: task.state === 'done',
      error: task.error || null,
      files: this.filesOf(task),
      canSelect: task.kind === 'bt',
      partsDone: task.partsDone || 0,
      partsTotal: task.partsTotal || 0,
      savePath: task.savePath,
      openPath: task.openPath || task.savePath,
      note: task.note || null
    };
  }

  // 某个文件已下载的字节区间（用于播放器上"可播放范围"提示）
  fileRanges(id, fileIndex) {
    const task = this.tasks.get(id);
    const torrent = task && task.job && task.job.torrent;
    if (!torrent || !torrent.files) return null;
    const file = torrent.files[fileIndex];
    if (!file) return null;
    if (file.done) return { length: file.length, ranges: [[0, file.length]], pieceLength: torrent.pieceLength || 0 };

    const pieceLength = torrent.pieceLength || 0;
    const start = file.offset;
    const end = file.offset + file.length;
    if (!pieceLength || !torrent.bitfield) return { length: file.length, ranges: [], pieceLength };

    const first = Math.floor(start / pieceLength);
    const last = Math.floor((end - 1) / pieceLength);
    const ranges = [];
    let cur = null;
    for (let i = first; i <= last; i++) {
      const done = torrent.bitfield.get(i);
      const pStart = Math.max(i * pieceLength, start) - start;
      const pEnd = Math.min((i + 1) * pieceLength, end) - start;
      if (done) {
        if (cur && cur[1] === pStart) cur[1] = pEnd;
        else { cur = [pStart, pEnd]; ranges.push(cur); }
      } else {
        cur = null;
      }
    }
    return { length: file.length, ranges, pieceLength };
  }

  // BT 的文件列表必须实时算：勾选状态变了要立刻反映到 UI
  filesOf(task) {
    if (task.kind !== 'bt') return [];
    const torrent = task.job && task.job.torrent;
    if (!torrent || !torrent.files) return [];
    return torrent.files.map((f, i) => ({
      index: i,
      name: f.path,
      length: f.length,
      done: !!f.done,
      downloaded: f.downloaded || 0,
      selected: !task.selection || task.selection.has(i)
    }));
  }

  // 启动时预热 BT 客户端：这样对等端口尽早起来，界面一加任务就能连
  async warmUp() {
    try { await this.getBtClient(); } catch { /* 依赖缺失时忽略 */ }
  }

  snapshot() {
    return [...this.tasks.values()].map((t) => this.meta(t));
  }

  stats() {
    let downloadSpeed = 0;
    let uploadSpeed = 0;
    for (const t of this.tasks.values()) {
      if (t.state === 'active') downloadSpeed += t.speed || 0;
      uploadSpeed += t.uploadSpeed || 0;
    }
    return { downloadSpeed, uploadSpeed, numTorrents: this.tasks.size };
  }

  emit(task) {
    try { this.onUpdate(this.meta(task)); } catch { /* ignore */ }
    this.scheduleSave();
  }

  tick() {
    for (const task of this.tasks.values()) {
      if (task.state === 'active') {
        task.speed = task.meter.update(task.downloaded);
      } else {
        task.speed = 0;
      }
      this.emit(task);
    }
  }

  // ---------- 生命周期 ----------

  createTask(fields) {
    const task = {
      id: fields.id || util.newId(),
      kind: fields.kind,
      name: fields.name || '未命名',
      source: fields.source || '',
      savePath: fields.savePath,
      openPath: fields.openPath || fields.savePath,
      state: 'active',
      error: null,
      note: fields.note || null,
      total: fields.total || 0,
      downloaded: 0,
      partsDone: 0,
      partsTotal: fields.partsTotal || 0,
      peers: 0,
      seeds: 0,
      speed: 0,
      files: [],
      meter: new util.SpeedMeter(),
      ctrl: null,
      job: fields.job || {},
      createdAt: Date.now()
    };
    this.tasks.set(task.id, task);
    this.emit(task);
    return task;
  }

  async add(input, opts = {}) {
    // 允许传 { url, headers } 形式：网盘直链常需要 Cookie / Referer / 特定 UA
    if (input && typeof input === 'object' && input.url) {
      opts = { ...opts, ...input };
      input = input.url;
    }
    const parsed = parseLink(input);
    if (!parsed) {
      throw new Error('无法识别这个链接。支持：磁力 / infohash / .torrent / HTTP(S) / FTP(S) / HLS(m3u8) / DASH(mpd) / Metalink / IPFS / 迅雷 / 旋风 / 快车 / ed2k');
    }
    if (parsed.kind === 'invalid') throw new Error(parsed.note || '链接无效');
    if (parsed.note) opts.note = parsed.note;

    switch (parsed.kind) {
      case 'bt': return this.addBt(parsed, opts);
      case 'http': return this.addHttp(parsed, opts);
      case 'ftp': return this.addFtp(parsed, opts);
      case 'ipfs': return this.addIpfs(parsed, opts);
      case 'metalink': return this.addMetalink(parsed, opts);
      case 'hls': return this.addManifest(parsed, 'hls', opts);
      case 'dash': return this.addManifest(parsed, 'dash', opts);
      case 'ed2k': return this.addEd2k(parsed, opts);
      case 'sftp':
        throw new Error('SFTP 未内置（需要 SSH 协议栈）。可以先用 sshfs / scp 取到本地，或把文件放到可访问的 HTTP/FTP 上。');
      default:
        throw new Error('不支持的协议: ' + parsed.kind);
    }
  }

  pause(id) {
    const task = this.get(id);
    if (!task || task.state !== 'active') return;
    if (task.kind === 'bt') {
      task.job.torrent.pause();
      task.state = 'paused';
      this.emit(task);
      return;
    }
    task.state = 'paused';
    if (task.ctrl) task.ctrl.abort();
    this.emit(task);
    setTimeout(() => this.pump(), 0);
  }

  resume(id) {
    const task = this.get(id);
    if (!task || task.state !== 'paused') return;
    if (task.kind === 'bt') {
      task.job.torrent.resume();
      task.state = 'active';
      this.emit(task);
      return;
    }
    task.state = 'active';
    task.error = null;
    this.emit(task);
    this.runJob(task);
  }

  remove(id, { deleteFiles = false } = {}) {
    setTimeout(() => this.pump(), 0);
    const task = this.get(id);
    if (!task) return;
    this.tasks.delete(id);
    if (task.ctrl) { try { task.ctrl.abort(); } catch { /* ignore */ } }
    if (task.kind === 'bt') {
      const torrent = task.job.torrent;
      const target = torrent && torrent.name ? path.join(torrent.path, torrent.name) : task.savePath;
      const done = () => { if (deleteFiles) util.rmrf(target); };
      if (this.btClient && torrent) this.btClient.remove(torrent, done);
      else done();
      return;
    }
    if (deleteFiles) {
      util.rmrf(task.savePath);
      util.rmrf(partPathOf(task));
      util.rmrf(task.savePath + '.part.video');
      util.rmrf(task.savePath + '.part.audio');
      util.rmrf(task.savePath + '.tracks');
    }
  }

  async openFolder(id) {
    const task = this.get(id);
    if (!task) return null;
    const target = task.openPath && fs.existsSync(task.openPath) ? task.openPath : this.dir;
    return target;
  }

  selectFiles(id, indices) {
    const task = this.get(id);
    if (!task || task.kind !== 'bt') return;
    if (!Array.isArray(indices)) return;
    task.selection = new Set(indices.filter((i) => Number.isInteger(i) && i >= 0));
    applyBtSelection(task, true);
    this.emit(task);
  }

  // ---------- 错误 / 完成 ----------

  handleError(task, err) {
    if (this.queue.length) setTimeout(() => this.pump(), 0);
    if (err && err.paused) {
      if (task.state !== 'paused') task.state = 'paused';
      this.emit(task);
      return;
    }
    task.state = 'error';
    task.error = (err && err.message) || String(err);
    this.emit(task);
    this.onError(`${task.name}: ${task.error}`);
  }

  finish(task, extra = {}) {
    task.state = 'done';
    if (this.queue.length) setTimeout(() => this.pump(), 0);
    task.downloaded = task.total || task.downloaded;
    task.speed = 0;
    Object.assign(task, extra);
    this.emit(task);
  }

  // ---------- BT ----------

  async getBtClient() {
    if (this.btClient) return this.btClient;
    const mod = await import('webtorrent');
    const WebTorrent = mod.default || mod;
    this.btClient = new WebTorrent({ maxConns: 55 });
    this.btClient.on('error', (err) => this.onError('WebTorrent: ' + (err.message || err)));
    return this.btClient;
  }

  async addBt(parsed, opts) {
    const client = await this.getBtClient();
    let source = parsed.source;
    if (parsed.path) source = fs.readFileSync(parsed.path);
    else if (parsed.url) {
      const got = await http.fetchBuffer(parsed.url);
      if (got.contentType === 'text/html') throw new Error('这个地址返回的是网页，不是 .torrent 文件');
      source = got.buffer;
    } else if (parsed.hash) {
      source = /^[0-9a-f]{40}$/i.test(parsed.hash)
        ? `magnet:?xt=urn:btih:${parsed.hash}`
        : `magnet:?xt=urn:btih:${parsed.hash}`;
    }

    let torrent;
    try {
      torrent = client.add(source, { path: this.dir });
    } catch (err) {
      // 同一个种子重复拖进来：直接返回已有任务，而不是报"解析失败"
      const dup = /duplicate torrent\s*([0-9a-f]{40})?/i.exec((err && err.message) || '');
      if (dup) {
        const hash = (dup[1] || '').toLowerCase();
        const existing = hash && this.tasks.get(hash);
        if (existing) return existing;
        throw new Error('这个种子已经在任务列表里了');
      }
      throw err;
    }

    const id = await new Promise((resolve) => {
      if (torrent.infoHash) return resolve(torrent.infoHash);
      const timer = setTimeout(() => resolve(torrent.infoHash || null), 15000);
      torrent.once('_infoHash', () => { clearTimeout(timer); resolve(torrent.infoHash); });
      torrent.once('error', (err) => {
        clearTimeout(timer);
        const dup = /duplicate torrent\s*([0-9a-f]{40})?/i.exec((err && err.message) || '');
        resolve(dup ? (dup[1] || null) : null);
      });
    });
    if (!id) {
      try { client.remove(torrent, () => {}); } catch { /* ignore */ }
      throw new Error('种子解析失败（不是有效的 .torrent 或磁力链接）');
    }

    // 缓存 .torrent：下次启动恢复时直接用它，省掉等 DHT 拿元数据。
    // 注意磁力链接在元数据到达前 torrentFile 是 undefined，必须等到 ready。
    const writeCache = () => {
      try {
        const cachePath = this.torrentCachePath(id);
        if (!cachePath || fs.existsSync(cachePath)) return;
        const buf = torrent.torrentFile;
        if (!buf || !buf.length) return;
        fs.writeFileSync(cachePath, buf);
      } catch { /* 缓存失败不影响下载 */ }
    };
    if (torrent.ready || torrent.metadata) writeCache();
    else torrent.once('ready', writeCache);

    const task = this.createTask({
      id,
      kind: 'bt',
      name: torrent.name || '获取元数据中…',
      source: parsed.source,
      savePath: path.join(this.dir, torrent.name || id),
      openPath: path.join(this.dir, torrent.name || id),
      total: torrent.length || 0,
      note: opts.note || null,
      job: { torrent }
    });
    task.selection = null;

    const sync = () => {
      if (!this.tasks.has(task.id)) return;
      task.name = torrent.name || task.name;
      task.total = torrent.length || task.total;
      task.downloaded = torrent.downloaded || 0;
      task.peers = torrent.numPeers || 0;
      task.seeds = torrent.wires ? torrent.wires.filter((w) => w.isSeeder).length : 0;
      task.uploadSpeed = torrent.uploadSpeed || 0;
      task.files = this.filesOf(task);
      if (torrent.name) {
        task.savePath = path.join(torrent.path || this.dir, torrent.name);
        task.openPath = task.savePath;
      }
      // 注意：webtorrent 在没有元数据时 done 就是 true（downloaded === length === 0），
      // 必须等 ready 且 length > 0 才算真的下完
      const reallyDone = !!torrent.ready && torrent.length > 0 && torrent.done;
      if (reallyDone && task.state === 'active') {
        this.finish(task);
      } else {
        this.emit(task);
      }
    };

    torrent.on('metadata', () => { applyBtSelection(task, true); sync(); });
    torrent.on('ready', () => { applyBtSelection(task, true); sync(); });
    torrent.on('download', sync);
    torrent.on('upload', sync);
    torrent.on('done', () => {
      sync();
      if (task.state === 'active' && torrent.length > 0) this.finish(task);
    });
    // DHT 的 "No nodes to query" 是很常见的良性警告，别当成任务备注显示
    torrent.on('warning', (err) => {
      const msg = (err && err.message) || '';
      if (/no nodes to query/i.test(msg)) return;
      task.note = msg;
    });
    torrent.on('error', (err) => this.handleError(task, err));
    sync();
    return this.meta(task);
  }

  // ---------- 单文件下载（HTTP / FTP / IPFS / Metalink） ----------

  async addHttp(parsed, opts) {
    const reqHeaders = opts.headers && typeof opts.headers === 'object' ? opts.headers : undefined;
    const info = await http.probe(parsed.url, { headers: reqHeaders });
    if (!info.ok) throw new Error(`HTTP ${info.status}`);

    // 用内容类型纠正：可能是播放列表或种子
    if (/mpegurl/i.test(info.contentType) || /application\/x-mpegurl/i.test(info.contentType)) {
      return this.addManifest({ ...parsed, kind: 'hls' }, 'hls', opts);
    }
    if (/dash\+xml/i.test(info.contentType)) {
      return this.addManifest({ ...parsed, kind: 'dash' }, 'dash', opts);
    }
    if (/bittorrent/i.test(info.contentType)) {
      return this.addBt({ ...parsed, kind: 'bt', url: parsed.url }, opts);
    }

    const name = util.sanitizeName(info.filename || 'download');
    const savePath = util.uniquePath(this.dir, name);
    const task = this.createTask({
      kind: 'http',
      name,
      source: parsed.source,
      savePath,
      total: info.length,
      note: opts.note || null,
      job: { url: parsed.url, info, headers: reqHeaders }
    });
    this.runJob(task);
    return this.meta(task);
  }

  async addIpfs(parsed, opts) {
    const info = await ipfs.describe(parsed.cid, parsed.path, { mode: opts.gatewayMode || 'auto' });
    const name = util.sanitizeName(info.filename || parsed.cid);
    const savePath = util.uniquePath(this.dir, name);
    const task = this.createTask({
      kind: 'ipfs',
      name,
      source: parsed.source,
      savePath,
      total: info.length,
      note: `网关 ${info.gateway}`,
      job: { url: info.url }
    });
    this.runJob(task);
    return this.meta(task);
  }

  async addFtp(parsed, opts) {
    const info = await ftp.probe(parsed.url);
    const name = util.sanitizeName(info.filename || 'download');
    const savePath = util.uniquePath(this.dir, name);
    const task = this.createTask({
      kind: 'ftp',
      name,
      source: parsed.source,
      savePath,
      total: info.length,
      note: (info.secure ? 'FTPS' : 'FTP') + (opts.note ? ' · ' + opts.note : ''),
      job: { url: parsed.url, config: info.config, remotePath: info.config.remotePath }
    });
    this.runJob(task);
    return this.meta(task);
  }

  async addMetalink(parsed, opts) {
    const desc = await metalink.describe(parsed.url || parsed.path);
    const name = util.sanitizeName(desc.name || 'download');
    const savePath = util.uniquePath(this.dir, name);
    const task = this.createTask({
      kind: 'metalink',
      name,
      source: parsed.source,
      savePath,
      total: desc.size || 0,
      note: `${desc.urls.length} 个镜像` + (desc.hash ? ` · ${desc.hash.algo}` : ''),
      job: { urls: desc.urls, hash: desc.hash }
    });
    this.runJob(task);
    return this.meta(task);
  }

  async addManifest(parsed, kind, opts) {
    const target = parsed.url || parsed.path;
    const desc = kind === 'hls'
      ? await hls.describe(target)
      : await dash.describe(target);

    // 有 ffmpeg 时统一封装成 mp4，文件名也跟着走
    const outExt = desc.ext === 'ts' && media.findFfmpeg() ? 'mp4' : desc.ext;
    const name = util.sanitizeName(manifestName(target, outExt, kind));
    const savePath = util.uniquePath(this.dir, name);
    const task = this.createTask({
      kind,
      name,
      source: parsed.source,
      savePath,
      total: 0,
      partsTotal: desc.tracks.reduce((n, t) => n + t.parts.length, 0),
      note: [
        desc.isLive ? '直播流（仅抓取当前可见分片）' : null,
        desc.duration ? `${Math.round(desc.duration)}s` : null,
        desc.tracks.length > 1 ? `${desc.tracks.length} 条轨道` : null,
        opts.note || null
      ].filter(Boolean).join(' · ') || null,
      job: { desc, progress: {} }
    });
    this.runJob(task);
    return this.meta(task);
  }

  async addEd2k(parsed, opts) {
    // 先算一下链接信息，给出明确的替代方案
    const size = util.humanBytes(parsed.size || 0);
    const bridge = ed2k.findBridge();
    throw new Error(
      `eD2K 直连下载暂未实现（需要 eDonkey 服务器 + eMule 对等协议 + Kad DHT）。` +
      `已识别：${parsed.name || '未命名'}${parsed.size ? ' · ' + size : ''} · ${parsed.hash}。` +
      (bridge ? `检测到本机装有 ${bridge.name}，可把链接粘给它。` : '可安装 aMule / MLDonkey 等客户端下载；本地文件可用 ed2k 哈希校验。')
    );
  }

  // ---------- 任务执行 ----------

  activeCount() {
    let n = 0;
    for (const t of this.tasks.values()) if (t.state === 'active') n += 1;
    return n;
  }

  /** 有位置就启动队列里的任务 */
  pump() {
    while (this.queue.length && this.activeCount() < this.opts.maxConcurrent) {
      const id = this.queue.shift();
      const task = this.tasks.get(id);
      if (!task || task.state !== 'queued') continue;
      task.state = 'active';
      this.emit(task);
      this.runJob(task);
    }
  }

  async runJob(task) {
    // 并发上限：满了就排队，等别的任务结束再起
    const others = this.activeCount() - (task.state === 'active' ? 1 : 0);
    if (others >= this.opts.maxConcurrent && !this.queue.includes(task.id)) {
      task.state = 'queued';
      this.queue.push(task.id);
      this.emit(task);
      return;
    }
    if (task.kind === 'hls' || task.kind === 'dash') return this.runMediaJob(task);
    return this.runFileJob(task);
  }

  /** 全局限速：按 token 消耗，超了就让调用方等一会儿 */
  async throttle(bytes) {
    if (this.limiter) await this.limiter.take(bytes);
  }

  async runFileJob(task) {
    task.ctrl = new AbortController();
    const partPath = partPathOf(task);
    const startAt = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
    task.downloaded = startAt;
    this.emit(task);

    const onProgress = (bytes) => {
      task.downloaded = bytes;
    };

    try {
      if (task.kind === 'ftp') {
        await ftp.download({
          config: task.job.config,
          remotePath: task.job.remotePath,
          filePath: partPath,
          startAt,
          onProgress,
          signal: task.ctrl.signal
        });
      } else if (task.kind === 'metalink') {
        await this.downloadMirrors(task, partPath, startAt, onProgress);
      } else {
        const res = await http.downloadToFileChunked({
          headers: task.job.headers,
          url: task.job.url,
          filePath: partPath,
          startAt,
          onProgress: (n) => { onProgress(n); },
          signal: task.ctrl.signal,
          connections: this.opts.connections,
          throttle: (n) => this.throttle(n)
        });
        if (res.total) task.total = res.total;
      }

      if (task.kind === 'metalink' && task.job.hash) {
        const check = await metalink.verify(partPath, task.job.hash);
        if (!check.ok) {
          util.rmrf(partPath);
          throw new Error(`校验和不匹配（期望 ${check.expected}，实际 ${check.actual}）`);
        }
        task.note = `${task.job.hash.algo} 校验通过`;
      }

      fs.renameSync(partPath, task.savePath);
      task.downloaded = task.total = fs.statSync(task.savePath).size;
      this.finish(task);
    } catch (err) {
      this.handleError(task, err);
    }
  }

  async downloadMirrors(task, partPath, startAt, onProgress) {
    const urls = task.job.urls;
    const errors = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        task.note = `镜像 ${i + 1}/${urls.length}`;
        this.emit(task);
        const res = await http.downloadToFile({
          url,
          filePath: partPath,
          startAt,
          onProgress,
          signal: task.ctrl.signal
        });
        if (res.total) task.total = res.total;
        return res;
      } catch (err) {
        if (err.paused) throw err;
        errors.push(`${url} → ${err.message}`);
        startAt = 0;
        util.rmrf(partPath);
        if (task.ctrl.signal.aborted) throw err;
      }
    }
    const e = new Error('所有镜像都失败了：' + errors.join('；'));
    throw e;
  }

  async runMediaJob(task) {
    const { desc } = task.job;
    task.ctrl = new AbortController();
    const signal = task.ctrl.signal;
    const base = task.savePath;

    const trackFiles = [];
    try {
      for (const track of desc.tracks) {
        const prog = task.job.progress[track.name] || { index: 0, offset: 0 };
        const filePath = desc.tracks.length > 1 ? `${base}.part.${track.name}` : `${base}.part`;
        trackFiles.push({ track, filePath });

        const onBytes = (bytes) => {
          // 汇总所有轨道已下载字节
          let sum = bytes;
          for (const other of desc.tracks) {
            if (other.name === track.name) continue;
            const st = task.job.progress[other.name];
            if (st) sum += st.offset || 0;
          }
          task.downloaded = sum;
        };

        const res = await downloadTrack({
          parts: track.parts,
          init: track.init,
          filePath,
          signal,
          startIndex: prog.index,
          startOffset: prog.offset,
          onBytes,
          onPart: (done, total) => {
            task.partsDone = done;
            task.partsTotal = total;
          }
        });
        task.job.progress[track.name] = { index: track.parts.length, offset: res.bytes };
        task.partsDone = track.parts.length;
      }

      task.note = desc.isLive ? '直播流：已抓取可见分片' : null;

      // 封装：单轨 → 直接 remux；双轨 → mux
      const out = task.savePath;
      const tmpOut = out + '.tmp.mp4';
      if (trackFiles.length > 1) {
        if (!media.findFfmpeg()) throw new Error('这个 DASH 流把音视频分开传输，需要 ffmpeg 合成');
        await media.muxTracks(trackFiles[0].filePath, trackFiles[1].filePath, tmpOut);
      } else if (desc.ext === 'ts') {
        if (media.findFfmpeg()) await media.remuxFile(trackFiles[0].filePath, tmpOut);
        else fs.copyFileSync(trackFiles[0].filePath, tmpOut);
      } else {
        fs.copyFileSync(trackFiles[0].filePath, tmpOut);
      }
      fs.renameSync(tmpOut, out);
      for (const t of trackFiles) util.rmrf(t.filePath);

      task.downloaded = task.total = fs.statSync(out).size;
      this.finish(task);
    } catch (err) {
      this.handleError(task, err);
    }
  }
}

function manifestName(target, ext, kind) {
  let base = 'stream';
  try {
    if (/^https?:/i.test(target)) {
      const u = new URL(target);
      const parts = u.pathname.split('/').filter(Boolean);
      const last = parts.pop() || '';
      const stem = last.replace(/\.[^.]+$/, '');
      const parent = parts.pop() || '';
      base = /^(index|master|manifest|playlist|media|main)$/i.test(stem) && parent ? parent : stem || parent;
    } else {
      const p = target.replace(/^file:\/\//, '');
      base = path.basename(p).replace(/\.[^.]+$/, '');
    }
  } catch { /* ignore */ }
  return `${base || kind}.${ext || 'mp4'}`;
}

// ---------- BT 文件选择（按 piece 区间，避免相邻文件共享 piece 被误删） ----------

function wantedPieces(torrent, selection) {
  const n = torrent.pieces.length;
  const wanted = new Array(n).fill(false);
  (torrent.files || []).forEach((f, i) => {
    if (selection && !selection.has(i)) return;
    const from = Math.max(0, f._startPiece);
    const to = Math.min(n - 1, f._endPiece);
    for (let p = from; p <= to; p++) wanted[p] = true;
  });
  return wanted;
}

function applyBtSelection(task, force) {
  const torrent = task.job && task.job.torrent;
  if (!torrent || torrent.destroyed || !torrent.files || !torrent.files.length) return;
  if (!torrent.pieces || !torrent.pieces.length) return;
  const wanted = wantedPieces(torrent, task.selection);
  const key = wanted.map((b) => (b ? '1' : '0')).join('');
  if (!force && task.appliedKey === key) return;
  task.appliedKey = key;
  const n = wanted.length;
  let p = 0;
  while (p < n) {
    const cur = wanted[p];
    let q = p;
    while (q + 1 < n && wanted[q + 1] === cur) q += 1;
    try {
      if (cur) torrent.select(p, q); else torrent.deselect(p, q);
    } catch { /* torrent 可能正在退出 */ }
    p = q + 1;
  }
}

module.exports = { TaskManager, RateLimiter, applyBtSelection, wantedPieces };
