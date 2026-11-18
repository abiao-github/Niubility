'use strict';

// Metalink（.meta4 / .metalink）：镜像列表 + 校验和。
// 逐个镜像尝试，全部失败才报错；下完可按 sha-256/sha-1/md5 校验。

const crypto = require('crypto');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const { fetchBuffer } = require('./http');

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function pickHash(fileNode) {
  const hashes = asArray(fileNode.hash);
  const wanted = ['sha-256', 'sha256', 'sha-1', 'sha1', 'md5'];
  for (const type of wanted) {
    for (const h of hashes) {
      const algo = String(h && h['@_type'] || '').toLowerCase();
      const value = String(h && h['#text'] != null ? h['#text'] : h || '').trim();
      if (algo === type && /^[0-9a-f]+$/i.test(value)) return { algo: type.replace('-', ''), value: value.toLowerCase() };
    }
  }
  return null;
}

function parseMetalink(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });
  const doc = parser.parse(xml);
  const root = doc.metalink || doc;
  const files = asArray(root.file);
  if (!files.length) throw new Error('Metalink 里没有 file 节点');

  // 选体积最大的那个（Metalink 可以同时描述多个文件，这里只下主文件）
  const file = files
    .map((f) => ({
      name: f['@_name'] || 'download',
      size: Number(f.size) || 0,
      urls: asArray(f.url).map((u) => String(u && u['#text'] != null ? u['#text'] : u).trim()).filter(Boolean),
      hash: pickHash(f)
    }))
    .sort((a, b) => b.size - a.size)[0];

  if (!file.urls.length) throw new Error('Metalink 里没有可用的 url');
  return file;
}

async function describe(target, { signal } = {}) {
  let xml;
  if (/^https?:\/\//i.test(target)) {
    const got = await fetchBuffer(target, { signal });
    xml = got.buffer.toString('utf8');
  } else {
    xml = fs.readFileSync(target.replace(/^file:\/\//, ''), 'utf8');
  }
  const file = parseMetalink(xml);
  return { kind: 'metalink', ...file };
}

function hashFile(filePath, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (c) => h.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

async function verify(filePath, hash) {
  if (!hash || !hash.algo) return { ok: true, skipped: true };
  let algo = hash.algo;
  if (algo === 'sha256') algo = 'sha256';
  const actual = await hashFile(filePath, algo);
  return { ok: actual === hash.value, expected: hash.value, actual };
}

module.exports = { describe, parseMetalink, verify, hashFile };
