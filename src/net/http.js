'use strict';

// HTTP/HTTPS：探测（Range 支持与否、文件名、大小）+ 可续传的流式下载。
// 用 Node 内置 fetch（undici），不需要额外依赖。

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const fsp = require('fs/promises');
const { proxyFetch } = require('./proxy');
const { filenameFromDisposition, filenameFromUrl, ensureDir } = require('./util');

const DEFAULT_UA = 'NiuBiliTy/1.0 (+https://example.invalid/niubility)';

function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), ms);
  const onAbort = () => ctrl.abort(opts.signal.reason || new Error('已取消'));
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  return proxyFetch(url, { ...opts, signal: ctrl.signal }).finally(() => {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  });
}

/**
 * 探测一个 URL：大小、Content-Type、文件名、是否支持 Range。
 * 用 GET + `Range: bytes=0-0`（比 HEAD 更可靠，很多站点禁 HEAD）。
 */
async function probe(url, { signal, headers = {}, timeout = 20000 } = {}) {
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', Range: 'bytes=0-0', ...headers },
    signal
  }, timeout);
  // 拿到头就够，正文丢弃
  try { await res.body?.cancel(); } catch { /* ignore */ }

  const cd = res.headers.get('content-disposition');
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const contentRange = res.headers.get('content-range');
  const acceptsRanges = res.status === 206 || /bytes/i.test(res.headers.get('accept-ranges') || '');
  let length = Number(res.headers.get('content-length')) || 0;
  if (contentRange) {
    const m = /\/(\d+)\s*$/.exec(contentRange);
    if (m) length = Number(m[1]);
  }
  return {
    ok: res.ok || res.status === 206,
    status: res.status,
    finalUrl: res.url || url,
    contentType: type,
    length,
    acceptsRanges,
    filename: filenameFromDisposition(cd) || filenameFromUrl(res.url || url),
    headers: res.headers
  };
}

/**
 * 下载到文件，支持从已有字节处续传。
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.filePath 目标文件（会写成 .part 再改名）
 * @param {number} [opts.startAt] 续传起点
 * @param {AbortSignal} [opts.signal]
 * @param {(bytes:number)=>void} [opts.onProgress]
 * @param {object} [opts.headers]
 * @param {number} [opts.timeout]
 * @returns {Promise<{bytes:number, total:number, contentType:string, finalUrl:string}>}
 */
async function downloadToFile(opts) {
  const {
    url, filePath, startAt = 0, signal, onProgress, headers = {}, timeout = 30000, throttle
  } = opts;
  ensureDir(path.dirname(filePath));

  const reqHeaders = { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers };
  if (startAt > 0) reqHeaders.Range = `bytes=${startAt}-`;

  const res = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow', headers: reqHeaders, signal }, timeout);
  if (!res.ok && res.status !== 206) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
  }

  let offset = startAt;
  let truncated = false;
  if (startAt > 0 && res.status !== 206) {
    offset = 0;
    truncated = true;
  }

  const total = (() => {
    const cr = res.headers.get('content-range');
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) return Number(m[1]);
    }
    const len = Number(res.headers.get('content-length')) || 0;
    return len ? len + offset : 0;
  })();

  if (!res.body) throw new Error('响应没有正文');
  const src = Readable.fromWeb(res.body);

  // 用显式文件句柄按位置写：暂停时写到哪里就是哪里，续传按文件大小接上
  const fh = await fsp.open(filePath, truncated || offset === 0 ? 'w' : 'r+');
  let written = offset;

  const abortErr = () => {
    const e = new Error('已暂停');
    e.paused = true;
    e.bytes = written;
    return e;
  };

  try {
    for await (const chunk of src) {
      if (signal && signal.aborted) {
        src.destroy();
        throw abortErr();
      }
      await fh.write(chunk, 0, chunk.length, written);
      written += chunk.length;
      if (throttle) await throttle(chunk.length);
      if (onProgress) onProgress(written);
    }
    if (signal && signal.aborted) throw abortErr();
  } catch (err) {
    if (err && err.paused) throw err;
    if (signal && signal.aborted) throw abortErr();
    throw err;
  } finally {
    await fh.close();
  }

  return {
    bytes: written,
    total: total || written,
    contentType: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
    finalUrl: res.url || url
  };
}

/** 取小文件（播放列表、密钥、metalink、torrent）到内存 */
async function fetchBuffer(url, { signal, headers = {}, timeout = 30000, maxBytes = 32 * 1024 * 1024 } = {}) {
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers },
    signal
  }, timeout);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
  const len = Number(res.headers.get('content-length')) || 0;
  if (len > maxBytes) throw new Error(`响应过大（${len} 字节），不是清单文件`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('响应过大，不是清单文件');
  return {
    buffer: buf,
    contentType: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
    finalUrl: res.url || url,
    headers: res.headers
  };
}


/**
 * 多连接分段下载（对齐 IDM 的核心能力）。
 *
 * 策略：
 *   · 先探测总长度与是否支持 Range；不支持 / 太小 / 长度未知 → 退回单连接
 *   · 切成 N 段，每段一条 Range 请求，用文件句柄按偏移写同一个文件
 *   · 每段独立重试（3 次，指数退避），某段彻底失败就整体降级为单连接续传
 *
 * @param {object} opts
 * @param {number} [opts.connections=8]
 * @param {number} [opts.minSize] 小于这个体积不分段
 */
async function downloadToFileSegmented(opts) {
  const {
    url, filePath, startAt: rawStart = 0, signal, onProgress,
    headers = {}, timeout = 30000, connections = 8, minSize = 2 * 1024 * 1024, throttle
  } = opts;

  ensureDir(path.dirname(filePath));

  // 1) 探测：只取 1 字节，拿总长与 Range 支持情况
  const probeHeaders = { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers, Range: 'bytes=0-0' };
  let total = 0;
  let ranged = false;
  let acceptRanges = '';
  try {
    const probe = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow', headers: probeHeaders, signal }, timeout);
    try { await probe.body?.cancel(); } catch { /* ignore */ }
    acceptRanges = probe.headers.get('accept-ranges') || '';
    const cr = probe.headers.get('content-range');
    if (probe.status === 206 && cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) { total = Number(m[1]); ranged = true; }
    } else if (probe.status === 200) {
      total = Number(probe.headers.get('content-length')) || 0;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    // 探测失败就直接走单连接，让单连接自己去报真正的错误
    return downloadToFile(opts);
  }

  const startAt = Math.max(0, rawStart);
  const remaining = total ? total - startAt : 0;
  const canSplit = ranged && total > 0 && remaining > minSize;

  if (!canSplit) {
    return downloadToFile({ ...opts, startAt });
  }

  // 2) 分段：按体积自动决定连接数（每 2MB 一条，最多到上限）
  const autoBySize = Math.ceil(remaining / (2 * 1024 * 1024));
  const n = Math.max(1, Math.min(connections, autoBySize, Math.ceil(remaining / (256 * 1024))));
  const segSize = Math.ceil(remaining / n);
  const segments = [];
  for (let i = 0; i < n; i++) {
    const from = startAt + i * segSize;
    const to = Math.min(total - 1, from + segSize - 1);
    if (from <= to) segments.push({ from, to, got: 0, done: false });
  }

  // 3) 预分配文件（稀疏写，不会真的写满磁盘）
  const fh = await fsp.open(filePath, fs.existsSync(filePath) && startAt > 0 ? 'r+' : 'w+');
  try { await fh.truncate(total); } catch { /* 有些文件系统不支持预分配，忽略 */ }

  const progress = () => {
    if (!onProgress) return;
    let sum = 0;
    for (const s of segments) sum += s.got;
    onProgress(startAt + sum);
  };

  const abortErr = () => {
    const e = new Error('已暂停');
    e.paused = true;
    let sum = 0;
    for (const s of segments) sum += s.got;
    e.bytes = startAt + sum;
    return e;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function worker(seg) {
    let attempt = 0;
    while (!seg.done) {
      if (signal && signal.aborted) throw abortErr();
      attempt += 1;
      const from = seg.from + seg.got;
      try {
        const res = await fetchWithTimeout(url, {
          method: 'GET',
          redirect: 'follow',
          headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers, Range: `bytes=${from}-${seg.to}` },
          signal
        }, timeout);
        if (res.status !== 206) throw new Error(`分段请求返回 ${res.status}（服务器可能不支持 Range）`);
        if (!res.body) throw new Error('分段响应没有正文');
        const src = Readable.fromWeb(res.body);
        for await (const chunk of src) {
          if (signal && signal.aborted) { src.destroy(); throw abortErr(); }
          await fh.write(chunk, 0, chunk.length, seg.from + seg.got);
          seg.got += chunk.length;
          if (throttle) await throttle(chunk.length);
          if (seg.got >= seg.to - seg.from + 1) { seg.done = true; break; }
          progress();
        }
        if (seg.got >= seg.to - seg.from + 1) { seg.done = true; break; }
      } catch (err) {
        if (err && err.paused) throw err;
        if (signal && signal.aborted) throw abortErr();
        if (attempt >= 3) throw err;
        await sleep(300 * attempt);
      }
    }
    progress();
  }

  try {
    await Promise.all(segments.map((s) => worker(s)));
    progress();
  } catch (err) {
    // 任何一段失败：关掉句柄，把已下载部分留给单连接续传
    await fh.close();
    if (err && err.paused) throw err;
    const single = await downloadToFile({ ...opts, startAt: fs.existsSync(filePath) ? Math.min(fs.statSync(filePath).size, total) : startAt });
    return single;
  }

  await fh.close();
  const size = fs.statSync(filePath).size;
  if (onProgress) onProgress(size);
  return { bytes: size, total, contentType: '', finalUrl: url, segmented: true, connections: segments.length };
}


/**
 * 分块队列 + 工作窃取（对齐 IDM 的动态分段思路）。
 *
 * 和固定切段的区别：
 *   · 把文件切成很多小块（512KB~8MB），N 个 worker 共享队列，谁先完成谁领下一块
 *   · 某条连接特别慢时，它只是领得少，不会拖死整体（固定切段会被最慢那段卡住）
 *   · 遇到 429/503 自动降并发并退避，避免把服务器惹毛
 */
async function downloadToFileChunked(opts) {
  const {
    url, filePath, startAt: rawStart = 0, signal, onProgress,
    headers = {}, timeout = 30000, connections = 8, minSize = 2 * 1024 * 1024, throttle
  } = opts;

  ensureDir(path.dirname(filePath));

  // 探测：优先 HEAD，拿不到长度再用 1 字节 GET
  let total = 0;
  let ranged = false;
  try {
    const head = await fetchWithTimeout(url, {
      method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': DEFAULT_UA, ...headers }, signal
    }, timeout);
    if (head.ok) {
      total = Number(head.headers.get('content-length')) || 0;
      ranged = /bytes/i.test(head.headers.get('accept-ranges') || '');
    }
    if (!total || !ranged) {
      const probe = await fetchWithTimeout(url, {
        method: 'GET', redirect: 'follow',
        headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers, Range: 'bytes=0-0' }, signal
      }, timeout);
      try { await probe.body?.cancel(); } catch { /* ignore */ }
      if (probe.status === 206) {
        const m = /\/(\d+)\s*$/.exec(probe.headers.get('content-range') || '');
        if (m) { total = Number(m[1]); ranged = true; }
      } else if (probe.status === 200 && !total) {
        total = Number(probe.headers.get('content-length')) || 0;
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    return downloadToFile(opts);
  }

  const startAt = Math.max(0, rawStart);
  const remaining = total ? total - startAt : 0;
  if (!ranged || !total || remaining <= minSize) {
    return downloadToFile({ ...opts, startAt });
  }

  // 切块：块小一点才能窃取；大文件块也大一点，减少请求数
  const chunkSize = Math.max(512 * 1024, Math.min(8 * 1024 * 1024, Math.ceil(remaining / Math.max(1, connections * 4))));
  const chunks = [];
  for (let pos = startAt; pos < total; pos += chunkSize) {
    chunks.push({ from: pos, to: Math.min(total - 1, pos + chunkSize - 1), got: 0, done: false });
  }

  const fh = await fsp.open(filePath, fs.existsSync(filePath) && startAt > 0 ? 'r+' : 'w+');
  try { await fh.truncate(total); } catch { /* ignore */ }

  let nextIndex = 0;
  let written = 0;
  const abortErr = () => {
    const e = new Error('已暂停');
    e.paused = true;
    e.bytes = startAt + written;
    return e;
  };
  const contiguousBytes = () => {
    let bytes = startAt;
    for (const chunk of chunks) {
      const length = chunk.to - chunk.from + 1;
      bytes += chunk.got;
      if (chunk.got < length) break;
    }
    return bytes;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 自适应并发：初始 connections，遇到 429/503 减半，顺利时缓慢回升
  let activeTarget = Math.min(connections, chunks.length);
  let consecutiveOk = 0;
  const takeChunk = () => (nextIndex < chunks.length ? chunks[nextIndex++] : null);

  async function worker() {
    for (;;) {
      if (signal && signal.aborted) throw abortErr();
      const chunk = takeChunk();
      if (!chunk) return;
      let attempt = 0;
      let ok = false;
      while (!ok) {
        if (signal && signal.aborted) throw abortErr();
        attempt += 1;
        const from = chunk.from + chunk.got;
        try {
          const res = await fetchWithTimeout(url, {
            method: 'GET', redirect: 'follow',
            headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers, Range: `bytes=${from}-${chunk.to}` },
            signal
          }, timeout);
          if (res.status === 429 || res.status === 503) {
            try { await res.body?.cancel(); } catch { /* ignore */ }
            // 服务器不欢迎高并发：降档后重试
            activeTarget = Math.max(2, Math.floor(activeTarget / 2));
            consecutiveOk = 0;
            if (attempt >= 5) throw new Error(`服务器限流（HTTP ${res.status}），已降并发仍失败`);
            await sleep(400 * attempt);
            continue;
          }
          if (res.status !== 206) throw new Error(`分段请求返回 ${res.status}`);
          if (!res.body) throw new Error('分段响应没有正文');
          const src = Readable.fromWeb(res.body);
          for await (const piece of src) {
            if (signal && signal.aborted) { src.destroy(); throw abortErr(); }
            await fh.write(piece, 0, piece.length, chunk.from + chunk.got);
            chunk.got += piece.length;
            written += piece.length;
            if (throttle) await throttle(piece.length);
            if (onProgress) onProgress(startAt + written);
          }
          ok = true;
          consecutiveOk += 1;
          if (consecutiveOk > 8 && activeTarget < connections) { activeTarget += 1; consecutiveOk = 0; }
        } catch (err) {
          if (err && err.paused) throw err;
          if (signal && signal.aborted) throw abortErr();
          if (attempt >= 3) throw err;
          await sleep(250 * attempt);
        }
      }
    }
  }

  try {
    activeTarget = Math.min(activeTarget, chunks.length);
    const workers = Array.from({ length: activeTarget }, () => worker());
    try {
      await Promise.all(workers);
    } catch (err) {
      await Promise.allSettled(workers);
      if (err && err.paused) {
        err.bytes = contiguousBytes();
        await fh.truncate(err.bytes);
        if (onProgress) onProgress(err.bytes);
      }
      throw err;
    }
  } finally {
    await fh.close();
  }

  const size = fs.statSync(filePath).size;
  if (size !== total) throw new Error(`长度不符：期望 ${total}，实际 ${size}`);
  if (onProgress) onProgress(size);
  return { bytes: size, total, contentType: '', finalUrl: url, segmented: true, connections: activeTarget, chunks: chunks.length };
}

module.exports = {
  downloadToFileSegmented,
  downloadToFileChunked, probe, downloadToFile, fetchBuffer, DEFAULT_UA, fetchWithTimeout };
