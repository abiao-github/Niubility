'use strict';

// 分片下载器：HLS / DASH 共用。
// 支持：并发抓取 + 顺序落盘、AES-128-CBC 解密、byte-range 分片、暂停/续传。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { fetchWithTimeout, DEFAULT_UA } = require('./http');
const { ensureDir } = require('./util');

function decrypt(buf, key, iv) {
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([d.update(buf), d.final()]);
  } catch (err) {
    throw new Error('分片解密失败: ' + err.message);
  }
}

async function fetchPart(part, signal) {
  const headers = { 'User-Agent': DEFAULT_UA, Accept: '*/*' };
  if (part.range && part.range.length) {
    headers.Range = `bytes=${part.range.offset}-${part.range.offset + part.range.length - 1}`;
  }
  const res = await fetchWithTimeout(part.url, { headers, redirect: 'follow', signal }, 30000);
  if (!res.ok && res.status !== 206) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new Error(`分片 HTTP ${res.status}: ${part.url}`);
  }
  let buf = Buffer.from(await res.arrayBuffer());
  if (part.key) buf = decrypt(buf, part.key, part.iv);
  return buf;
}

/**
 * 下载一条轨道：并发抓取、按顺序拼接写入同一个文件。
 * 暂停时抛出 { paused: true, bytes }，调用方用返回的 index/offset 续传。
 *
 * @param {object} opts
 * @param {Array<{url:string, range?:{offset:number,length:number}, key?:Buffer, iv?:Buffer}>} opts.parts
 * @param {object} [opts.init] 初始化分片（DASH 的 init-stream，或 HLS 的 EXT-X-MAP）
 * @param {string} opts.filePath
 * @param {AbortSignal} [opts.signal]
 * @param {(bytes:number)=>void} [opts.onBytes]
 * @param {(done:number,total:number)=>void} [opts.onPart]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.startIndex] 从第几个分片续传
 * @param {number} [opts.startOffset] 续传时文件已有的字节数
 */
async function downloadTrack(opts) {
  const {
    parts, init, filePath, signal, onBytes, onPart,
    concurrency = 4, startIndex = 0, startOffset = 0
  } = opts;

  ensureDir(path.dirname(filePath));

  let offset = startOffset;
  if (startIndex === 0 && startOffset === 0) {
    await fsp.writeFile(filePath, Buffer.alloc(0));
  } else if (fs.existsSync(filePath)) {
    // 续传：文件长度应等于已写入字节数，多出来的部分截掉
    const size = fs.statSync(filePath).size;
    if (size > startOffset) await fsp.truncate(filePath, startOffset);
  } else {
    offset = 0;
    await fsp.writeFile(filePath, Buffer.alloc(0));
  }

  const fh = await fsp.open(filePath, 'r+');
  const writeAt = async (buf, pos) => {
    let written = 0;
    while (written < buf.length) {
      const { bytesWritten } = await fh.write(buf, written, buf.length - written, pos + written);
      written += bytesWritten;
    }
  };

  try {
    if (startIndex === 0 && startOffset === 0 && init) {
      const head = await fetchPart(init, signal);
      await writeAt(head, offset);
      offset += head.length;
      if (onBytes) onBytes(offset);
    }

    const total = parts.length;
    const buffers = new Map();
    let nextToWrite = startIndex;
    let launchPtr = startIndex;
    let failure = null;

    const pump = async () => {
      while (nextToWrite < total) {
        while (!failure && launchPtr < total && (launchPtr - nextToWrite) < concurrency) {
          const idx = launchPtr;
          launchPtr += 1;
          fetchPart(parts[idx], signal).then(
            (buf) => { buffers.set(idx, buf); },
            (err) => { failure = failure || err; }
          );
        }
        if (failure) throw failure;
        while (!buffers.has(nextToWrite)) {
          if (failure) throw failure;
          await new Promise((r) => setTimeout(r, 10));
        }
        const buf = buffers.get(nextToWrite);
        buffers.delete(nextToWrite);
        await writeAt(buf, offset);
        offset += buf.length;
        nextToWrite += 1;
        if (onBytes) onBytes(offset);
        if (onPart) onPart(nextToWrite, total);
      }
      if (failure) throw failure;
    };

    await pump();
    return { bytes: offset };
  } catch (err) {
    if (signal && signal.aborted) {
      const e = new Error('已暂停');
      e.paused = true;
      e.bytes = offset;
      throw e;
    }
    throw err;
  } finally {
    await fh.close();
  }
}

module.exports = { downloadTrack, fetchPart, decrypt };
