'use strict';

// HLS：解析 m3u8（主播放列表 / 媒体播放列表），产出分片列表供 segments.js 下载。
// 支持 EXT-X-KEY(AES-128)、EXT-X-BYTERANGE、EXT-X-MAP、多码率自动选最高。

const fs = require('fs');
const path = require('path');
const { Parser } = require('m3u8-parser');
const { fetchBuffer } = require('./http');

function isRemote(target) {
  return /^https?:\/\//i.test(target);
}

async function readPlaylist(target, { signal } = {}) {
  if (isRemote(target)) {
    const { buffer, finalUrl } = await fetchBuffer(target, { signal });
    return { text: buffer.toString('utf8'), baseUrl: finalUrl };
  }
  const filePath = target.replace(/^file:\/\//, '');
  return { text: fs.readFileSync(filePath, 'utf8'), baseUrl: 'file://' + path.resolve(filePath) };
}

function parseText(text) {
  const parser = new Parser();
  parser.push(text);
  parser.end();
  return parser.manifest;
}

function resolveUrl(base, rel) {
  if (!rel) return rel;
  if (/^(https?:|file:|data:)/i.test(rel)) return rel;
  if (base.startsWith('file://')) {
    const dir = path.dirname(base.slice('file://'.length));
    return 'file://' + path.resolve(dir, rel);
  }
  return new URL(rel, base).toString();
}

function ivFromSequence(seq) {
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(seq >>> 0, 12);
  return buf;
}

function ivFromKey(key, index, mediaSequence) {
  if (key && key.iv) {
    // m3u8-parser 把 IV 拆成 4 个 32 位整数
    const buf = Buffer.alloc(16);
    const words = key.iv;
    if (Buffer.isBuffer(words)) return words;
    for (let i = 0; i < 4; i++) buf.writeUInt32BE((words[i] || 0) >>> 0, i * 4);
    return buf;
  }
  return ivFromSequence(mediaSequence + index);
}

/**
 * 解析 HLS 清单，返回轨道描述。
 * @returns {Promise<{tracks: Array<{name:string, parts:Array, init?:object}>, ext:string, variants?:Array}>}
 */
async function describe(target, { signal } = {}) {
  let { text, baseUrl } = await readPlaylist(target, { signal });
  let manifest = parseText(text);

  // 主播放列表：选码率最高的变体再解析一次
  let variants = null;
  if (manifest.playlists && manifest.playlists.length) {
    variants = manifest.playlists.map((p, i) => ({
      index: i,
      bandwidth: (p.attributes && p.attributes.BANDWIDTH) || 0,
      resolution: (p.attributes && p.attributes.RESOLUTION) || null,
      codecs: (p.attributes && p.attributes.CODECS) || null,
      url: resolveUrl(baseUrl, p.uri)
    }));
    const best = variants.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
    ({ text, baseUrl } = await readPlaylist(best.url, { signal }));
    manifest = parseText(text);
  }

  const segments = manifest.segments || [];
  if (!segments.length) throw new Error('播放列表里没有分片');

  const keyCache = new Map();
  const parts = [];
  let mapPart = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let part = {
      url: resolveUrl(baseUrl, seg.uri),
      range: seg.byterange ? { offset: seg.byterange.offset || 0, length: seg.byterange.length || 0 } : null,
      key: null,
      iv: null
    };

    if (seg.key && seg.key.method && seg.key.method !== 'NONE') {
      if (seg.key.method !== 'AES-128') {
        throw new Error('不支持的 HLS 加密方式: ' + seg.key.method);
      }
      const keyUrl = resolveUrl(baseUrl, seg.key.uri);
      let keyBuf = keyCache.get(keyUrl);
      if (!keyBuf) {
        const got = await fetchBuffer(keyUrl, { signal });
        keyBuf = got.buffer;
        if (keyBuf.length !== 16) throw new Error('AES-128 密钥长度不是 16 字节');
        keyCache.set(keyUrl, keyBuf);
      }
      part.key = keyBuf;
      part.iv = ivFromKey(seg.key, i, manifest.mediaSequence || 0);
    }

    if (seg.map && seg.map.uri && !mapPart) {
      mapPart = {
        url: resolveUrl(baseUrl, seg.map.uri),
        range: seg.map.byterange ? { offset: seg.map.byterange.offset || 0, length: seg.map.byterange.length || 0 } : null
      };
    }

    parts.push(part);
  }

  // 输出扩展名：TS 分片拼出来还是 TS；fMP4（有 EXT-X-MAP 或 .m4s）拼出来是 MP4
  const exts = parts.map((p) => (/\.[a-z0-9]+(?:[?#]|$)/i.exec(p.url) || [''])[0].toLowerCase());
  const fmp4 = !!mapPart || exts.some((e) => e.startsWith('.m4s') || e.startsWith('.mp4') || e.startsWith('.m4v'));
  const ext = fmp4 ? 'mp4' : 'ts';
  const last = segments[segments.length - 1];
  const totalDuration = segments.reduce((acc, s) => acc + (s.duration || 0), 0);

  return {
    kind: 'hls',
    ext,
    duration: totalDuration,
    targetDuration: manifest.targetDuration || (last && last.duration) || 0,
    isLive: !manifest.endList,
    variants,
    tracks: [{ name: 'media', parts, init: mapPart }]
  };
}

module.exports = { describe };
