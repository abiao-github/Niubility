'use strict';

// eD2K：链接解析 + ed2k 分片哈希（9.28MB 一段，段内 MD4 再整体 MD4）。
// 说明：eD2K 的下载需要 eDonkey 服务器 + eMule 对等协议，甚至 Kad DHT；
// 这里只做「链接识别 + 哈希校验」，以及可选的本地客户端桥接（aMule / MLDonkey）。

const fs = require('fs');
const md4 = require('./md4');

const ED2K_CHUNK = 9728000; // 9.28 MB

function md4Hex(buf) {
  return md4.md4Hex(buf);
}

/** 计算本地文件的 ed2k 哈希 */
async function ed2kHash(filePath, { onProgress } = {}) {
  const size = fs.statSync(filePath).size;
  if (size <= ED2K_CHUNK) {
    const buf = fs.readFileSync(filePath);
    return { hash: md4Hex(buf), size, chunks: 1 };
  }
  const chunkHashes = [];
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunk = Buffer.alloc(ED2K_CHUNK);
    let pos = 0;
    while (pos < size) {
      const want = Math.min(ED2K_CHUNK, size - pos);
      let read = 0;
      while (read < want) {
        const n = fs.readSync(fd, chunk, read, want - read, pos + read);
        if (!n) break;
        read += n;
      }
      chunkHashes.push(md4.md4(chunk.subarray(0, read)));
      pos += read;
      if (onProgress) onProgress(pos, size);
    }
  } finally {
    fs.closeSync(fd);
  }
  const joined = Buffer.concat(chunkHashes);
  return { hash: md4Hex(joined), size, chunks: chunkHashes.length };
}

/** 校验本地文件是否匹配 ed2k 链接里的哈希 */
async function verifyFile(filePath, expectedHash) {
  const { hash } = await ed2kHash(filePath);
  return { ok: hash === String(expectedHash).toLowerCase(), expected: expectedHash, actual: hash };
}

/** 找一个已安装的、能接 eD2K 链接的客户端 */
function findBridge() {
  const fsx = fs;
  const candidates = [
    { name: 'aMule', bin: '/Applications/aMule.app/Contents/MacOS/amule', args: (uri) => ['--emule-uri', uri] },
    // 各平台常见安装位置（找不到就在 PATH 里找）
    { name: 'aMule (cli)', bin: process.platform === 'win32' ? 'amule.exe' : 'amule', args: (uri) => ['--emule-uri', uri] },
    { name: 'MLDonkey', bin: process.platform === 'win32' ? 'mldonkey.exe' : 'mldonkey', args: (uri) => [uri] }
  ];
  for (const c of candidates) {
    try { if (fsx.existsSync(c.bin)) return c; } catch { /* ignore */ }
  }
  return null;
}

module.exports = { ed2kHash, verifyFile, findBridge, ED2K_CHUNK, md4Hex };
