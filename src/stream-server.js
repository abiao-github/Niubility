'use strict';

// 边下边播：把 BT 任务里的某个文件通过本地 HTTP 暴露出来，支持 Range 请求。
//
// 为什么这么做：torrent 文件在磁盘上是稀疏的，直接 file:// 播放会读到空洞。
// WebTorrent 的 file.createReadStream({start, end}) 会按需请求缺失分片，
// 所以本地 HTTP 服务器只要把 Range 映射成读流，播放器就能"播到哪、下到哪"。
//
// 只监听 127.0.0.1，随机端口，路径带 taskId + fileIndex。

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { findFfmpeg } = require('./net/media');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav'
};

const MEDIA_EXT = new Set(Object.keys(MIME));

// 这些容器/编码 Chromium 播不了，必须走 ffmpeg 转码（MKV/AVI/TS 里的 HEVC、AV1、DTS 都归这里）
const TRANSCODE_EXT = new Set(['.mkv', '.avi', '.ts', '.m2ts', '.mts', '.flv', '.rmvb', '.rm', '.wmv', '.mpg', '.mpeg', '.vob', '.3gp', '.ogv']);

function needsTranscode(name) {
  const ext = String(name || '').toLowerCase().slice(String(name || '').lastIndexOf('.'));
  return TRANSCODE_EXT.has(ext);
}

function isMediaName(name) {
  return MEDIA_EXT.has(String(name || '').toLowerCase().slice(String(name || '').lastIndexOf('.')));
}

class StreamServer {
  constructor({ getTask, log = () => {} }) {
    this.getTask = getTask;
    this.log = log;
    this.server = null;
    this.port = 0;
    this.tokens = new Map(); // token -> { taskId, fileIndex }
    this.currentTranscodes = new Set();
    this.lastTranscodeError = '';
  }

  async start() {
    if (this.server) return this.port;
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    this.log(`流媒体服务已启动 127.0.0.1:${this.port}`);
    return this.port;
  }

  register(taskId, fileIndex) {
    const now = Date.now();
    for (const [key, entry] of this.tokens) {
      if (now - entry.createdAt > TOKEN_TTL_MS) this.tokens.delete(key);
    }
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, { taskId, fileIndex, createdAt: now });
    return token;
  }

  async urlFor(taskId, fileIndex) {
    await this.start();
    const token = this.register(taskId, fileIndex);
    return `http://127.0.0.1:${this.port}/play/${token}`;
  }

  async transcodeUrlFor(taskId, fileIndex) {
    await this.start();
    const token = this.register(taskId, fileIndex);
    return `http://127.0.0.1:${this.port}/transcode/${token}`;
  }

  resolveTarget(token) {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
      this.tokens.delete(token);
      return null;
    }
    const task = this.getTask(entry.taskId);
    if (!task || !task.job || !task.job.torrent) return null;
    const torrent = task.job.torrent;
    const file = torrent.files && torrent.files[entry.fileIndex];
    if (!file) return null;
    return { file, torrent, task };
  }

  handle(req, res) {
    const t = /^\/transcode\/([a-z0-9]+)/i.exec(req.url || '');
    if (t) { this.handleTranscode(req, res, t[1]); return; }

    const m = /^\/play\/([a-z0-9]+)/i.exec(req.url || '');
    if (!m) { res.writeHead(404); res.end('not found'); return; }
    const target = this.resolveTarget(m[1]);
    if (!target) { res.writeHead(404); res.end('file not found'); return; }

    const { file } = target;
    const total = file.length;
    const name = file.name || 'media';
    const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

    let start = 0;
    let end = total - 1;
    let partial = false;

    const range = req.headers.range;
    if (range) {
      const rm = /bytes=(\d*)-(\d*)/.exec(range);
      if (rm) {
        if (rm[1]) start = parseInt(rm[1], 10);
        if (rm[2]) end = parseInt(rm[2], 10);
        if (!rm[1] && rm[2]) { // bytes=-N 表示最后 N 字节
          start = Math.max(0, total - parseInt(rm[2], 10));
          end = total - 1;
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }
        end = Math.min(end, total - 1);
        partial = true;
      }
    }

    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': partial ? end - start + 1 : total
    };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    res.writeHead(partial ? 206 : 200, headers);

    if (req.method === 'HEAD') { res.end(); return; }

    let stream;
    try {
      stream = file.createReadStream({ start, end });
    } catch (err) {
      res.end();
      return;
    }
    stream.on('error', () => { try { res.end(); } catch { /* ignore */ } });
    req.on('close', () => { try { stream.destroy(); } catch { /* ignore */ } });
    stream.pipe(res);
  }

  /** 边下边转码：读 /play 的按需分片流 → ffmpeg → 分片 MP4 推给播放器 */
  handleTranscode(req, res, token) {
    const target = this.resolveTarget(token);
    if (!target) { res.writeHead(404); res.end('file not found'); return; }
    const bin = findFfmpeg();
    if (!bin) { res.writeHead(500); res.end('未找到 ffmpeg，无法转码'); return; }

    const q = new URL(req.url, 'http://127.0.0.1');
    const start = Math.max(0, parseFloat(q.searchParams.get('t') || '0') || 0);
    const source = `http://127.0.0.1:${this.port}/play/${token}`;
    const baseArgs = [
      '-hide_banner', '-loglevel', 'error',
      ...(start > 0 ? ['-ss', String(start)] : []),
      '-i', source,
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1'
    ];
    const attempts = [
      ['-c:v', 'h264_videotoolbox', '-b:v', '5M', '-maxrate', '8M', '-bufsize', '12M'], // 硬件编码，最快
      ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']                         // 兜底软编
    ];

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'none'
    });

    let idx = 0;
    let got = 0;
    let killed = false;
    const killAll = () => { killed = true; };
    req.on('close', killAll);

    const run = () => {
      if (killed) { try { res.end(); } catch { /* ignore */ } return; }
      const ff = spawn(bin, [...baseArgs.slice(0, -7), ...attempts[idx], ...baseArgs.slice(-7)], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.currentTranscodes.add(ff);
      ff.stdout.on('data', (chunk) => { got += chunk.length; res.write(chunk); });
      let err = '';
      ff.stderr.on('data', (d) => { err = (err + String(d)).slice(-600); });
      ff.on('error', () => { try { res.end(); } catch { /* ignore */ } });
      ff.on('exit', (code) => {
        this.currentTranscodes.delete(ff);
        if (killed) { try { res.end(); } catch { /* ignore */ } return; }
        // 硬件编码器不支持的情况（比如分辨率/像素格式不支持），换软编再试一次
        if (code !== 0 && got < 1024 && idx + 1 < attempts.length) {
          idx += 1;
          run();
          return;
        }
        this.lastTranscodeError = err;
        try { res.end(); } catch { /* ignore */ }
      });
    };
    run();
  }

  stop() {
    for (const ff of this.currentTranscodes) { try { ff.kill('SIGKILL'); } catch { /* ignore */ } }
    this.currentTranscodes.clear();
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
      this.port = 0;
      this.tokens.clear();
    }
  }
}

module.exports = { StreamServer, isMediaName, needsTranscode, MEDIA_EXT, MIME };
