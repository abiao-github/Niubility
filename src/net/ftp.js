'use strict';

// FTP / FTPS：用 basic-ftp（成熟库），支持断点续传（startAt）与暂停（断开连接）。

const ftp = require('basic-ftp');
const fs = require('fs');

function parseFtpUrl(raw) {
  const u = new URL(raw);
  const secure = u.protocol === 'ftps:';
  const port = Number(u.port) || (secure ? 990 : 21);
  const username = decodeURIComponent(u.username || 'anonymous');
  const password = decodeURIComponent(u.password || (u.username ? '' : 'anonymous@'));
  const remotePath = decodeURIComponent(u.pathname || '/');
  return {
    host: u.hostname,
    port,
    username,
    password,
    remotePath: remotePath.startsWith('/') ? remotePath : '/' + remotePath,
    secure
  };
}

/**
 * 探测：文件大小 + 文件名。
 */
async function probe(rawUrl, { timeout = 20000 } = {}) {
  const cfg = parseFtpUrl(rawUrl);
  const client = new ftp.Client(timeout);
  try {
    await client.access(cfg);
    const size = await client.size(cfg.remotePath);
    return {
      ok: true,
      length: size,
      filename: cfg.remotePath.split('/').filter(Boolean).pop() || 'download',
      acceptsRanges: true,
      secure: cfg.secure,
      config: cfg
    };
  } finally {
    client.close();
  }
}

/**
 * 下载（可续传）。
 * @param {object} opts
 * @param {object} opts.config parseFtpUrl 的结果
 * @param {string} opts.remotePath
 * @param {string} opts.filePath 目标文件
 * @param {number} [opts.startAt]
 * @param {(bytes:number)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
async function download(opts) {
  const { config, remotePath, filePath, startAt = 0, onProgress, signal, timeout = 30000 } = opts;
  const client = new ftp.Client(timeout);
  const onAbort = () => { try { client.close(); } catch { /* ignore */ } };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    await client.access(config);
    if (startAt > 0) {
      // 已下载的部分保留，从 startAt 继续写
      if (!fs.existsSync(filePath)) startAt = 0;
    }
    client.trackProgress((info) => {
      if (onProgress) onProgress(startAt + info.bytes);
    });
    await client.downloadTo(filePath, remotePath, startAt > 0 ? { startAt } : startAt === 0 ? {} : {});
    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    return { bytes: size, total: size };
  } catch (err) {
    if (signal && signal.aborted) {
      const e = new Error('已暂停');
      e.paused = true;
      throw e;
    }
    throw err;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    client.close();
  }
}

module.exports = { probe, download, parseFtpUrl };
