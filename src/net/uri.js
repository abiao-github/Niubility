'use strict';

// 链接识别与归一化：把用户能粘贴的各种东西统一成
//   { kind, url?, hash?, size?, name?, source, note? }
// kind: bt | http | ftp | hls | dash | metalink | ipfs | ed2k
//
// 支持：磁力、裸 infohash（hex/base32）、http(s)、ftp(s)、ipfs/ipns、
//       迅雷 thunder://、旋风 qqdl://、快车 flashget://、ed2k://、file://

const BTIH_RE = /^urn:btih:([0-9a-z]+)$/i;
const BTMH_RE = /^urn:btmh:([0-9a-z]+)$/i;
const ED2K_XT_RE = /^urn:ed2k:([0-9a-f]{32})$/i;
const HEX40_RE = /^[0-9a-f]{40}$/i;
const BASE32_RE = /^[a-z2-7]{32}$/i;
const CID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{20,}|bafk[a-z2-7]{20,}|bafz[a-z2-7]{20,})$/;
const MANIFEST_RE = /\.(m3u8|mpd|meta4|metalink)(?:[?#]|$)/i;
const TORRENT_RE = /\.torrent(?:[?#]|$)/i;

function b64decode(str) {
  // 迅雷等链接常用 URL-safe base64，且可能缺 padding
  const s = str.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return Buffer.from(s + pad, 'base64').toString('utf8');
}

// 迅雷：thunder://<base64("AA" + url + "ZZ")>
function decodeThunder(raw) {
  let s = raw.slice('thunder://'.length);
  let out;
  try { out = b64decode(s); } catch { return null; }
  if (out.startsWith('AA') && out.endsWith('ZZ')) out = out.slice(2, -2);
  return out || null;
}

// 快车：flashget://<base64("[FLASHGET]" + url + "[FLASHGET]")>
function decodeFlashget(raw) {
  try {
    let out = b64decode(raw.slice('flashget://'.length));
    out = out.replace(/^\[FLASHGET\]/, '').replace(/\[FLASHGET\]$/, '');
    return out || null;
  } catch { return null; }
}

function decodeUrlsafe(raw, scheme) {
  try {
    const out = b64decode(raw.slice(scheme.length));
    return out || null;
  } catch { return null; }
}

function parseMagnet(source) {
  const query = source.slice(source.indexOf('?') + 1);
  const params = new URLSearchParams(query);
  const xts = params.getAll('xt');
  let btih = null;
  let btmh = null;
  let ed2kHash = null;
  for (const xt of xts) {
    let m;
    if (!btih && (m = BTIH_RE.exec(xt))) btih = m[1];
    else if (!btmh && (m = BTMH_RE.exec(xt))) btmh = m[1];
    else if (!ed2kHash && (m = ED2K_XT_RE.exec(xt))) ed2kHash = m[1];
  }
  const xl = Number(params.get('xl')) || 0;
  const dn = params.get('dn') || '';
  if (ed2kHash && xl) {
    return { kind: 'ed2k', hash: ed2kHash.toLowerCase(), size: xl, name: dn || ('ed2k-' + ed2kHash.slice(0, 8)), source };
  }
  if (btih || btmh) {
    return { kind: 'bt', hash: btih || btmh, source, note: btmh && !btih ? 'BitTorrent v2' : undefined };
  }
  return null;
}

function parseEd2k(source) {
  // ed2k://|file|<name>|<size>|<hash>|/
  // ed2k://|file|<name>|<size>|<hash>|p=<part hashes>|/
  const m = /^ed2k:\/\/\|file\|([^|]*)\|(\d+)\|([0-9a-fA-F]{32})\|/i.exec(source);
  if (!m) return null;
  return { kind: 'ed2k', name: m[1], size: Number(m[2]), hash: m[3].toLowerCase(), source };
}

function parseHttpUrl(source) {
  let u;
  try { u = new URL(source); } catch { return null; }
  if (MANIFEST_RE.test(u.pathname)) {
    if (/\.m3u8$/i.test(u.pathname)) return { kind: 'hls', url: source, source };
    if (/\.mpd$/i.test(u.pathname)) return { kind: 'dash', url: source, source };
    return { kind: 'metalink', url: source, source };
  }
  if (TORRENT_RE.test(u.pathname)) return { kind: 'bt', url: source, source };
  const ipfs = /^\/(ipfs|ipns)\/([^/?#]+)(.*)$/.exec(u.pathname);
  if (ipfs) return { kind: 'ipfs', cid: ipfs[2], path: ipfs[3] || '', source };
  return { kind: 'http', url: source, source };
}

/**
 * 解析用户输入。
 * @returns {object|null} 识别结果；null 表示完全看不懂
 */
function parseLink(input) {
  if (typeof input !== 'string') return null;
  const source = input.trim();
  if (!source) return null;
  const lower = source.toLowerCase();

  if (lower.startsWith('magnet:')) return parseMagnet(source) || { kind: 'bt', source, note: '磁力链接缺少有效 xt' };
  if (lower.startsWith('thunder://')) {
    const inner = decodeThunder(source);
    if (!inner) return { kind: 'invalid', source, note: '迅雷链接解码失败' };
    const parsed = parseLink(inner);
    return parsed ? { ...parsed, source, note: '迅雷链接 → ' + (parsed.note || parsed.kind.toUpperCase()) } : { kind: 'invalid', source, note: '迅雷链接内不含可识别的地址' };
  }
  if (lower.startsWith('qqdl://')) {
    const inner = decodeUrlsafe(source, 'qqdl://');
    if (!inner) return { kind: 'invalid', source, note: '旋风链接解码失败' };
    const parsed = parseLink(inner);
    return parsed ? { ...parsed, source, note: '旋风链接 → ' + (parsed.note || parsed.kind.toUpperCase()) } : { kind: 'invalid', source, note: '旋风链接内不含可识别的地址' };
  }
  if (lower.startsWith('flashget://')) {
    const inner = decodeFlashget(source);
    if (!inner) return { kind: 'invalid', source, note: '快车链接解码失败' };
    const parsed = parseLink(inner);
    return parsed ? { ...parsed, source, note: '快车链接 → ' + (parsed.note || parsed.kind.toUpperCase()) } : { kind: 'invalid', source, note: '快车链接内不含可识别的地址' };
  }
  if (lower.startsWith('ed2k://')) return parseEd2k(source) || { kind: 'invalid', source, note: 'eD2K 链接格式不对' };
  if (lower.startsWith('ipfs://')) {
    const rest = source.slice('ipfs://'.length).replace(/^ipfs\//, '');
    const [cid, ...tail] = rest.split('/');
    return { kind: 'ipfs', cid, path: tail.join('/'), source };
  }
  if (lower.startsWith('ipns://')) {
    const rest = source.slice('ipns://'.length);
    const [name, ...tail] = rest.split('/');
    return { kind: 'ipfs', cid: name, path: tail.join('/'), source, note: 'IPNS 名称需经网关解析' };
  }
  if (/^(https?):\/\//i.test(source)) return parseHttpUrl(source);
  if (/^(ftp|ftps):\/\//i.test(source)) return { kind: 'ftp', url: source, source };
  if (/^(sftp|scp):\/\//i.test(source)) return { kind: 'sftp', url: source, source };
  if (lower.startsWith('file://')) {
    const p = decodeURIComponent(source.slice('file://'.length));
    if (TORRENT_RE.test(p)) return { kind: 'bt', path: p, source };
    if (/\.m3u8$/i.test(p)) return { kind: 'hls', path: p, source };
    if (/\.mpd$/i.test(p)) return { kind: 'dash', path: p, source };
    if (/\.(meta4|metalink)$/i.test(p)) return { kind: 'metalink', path: p, source };
    return { kind: 'invalid', source, note: '本地文件仅支持 .torrent / .m3u8 / .mpd / .meta4' };
  }
  if (HEX40_RE.test(source)) return { kind: 'bt', hash: source.toLowerCase(), source, note: '裸 infohash' };
  if (BASE32_RE.test(source)) return { kind: 'bt', hash: source.toLowerCase(), source, note: '裸 infohash (base32)' };
  if (CID_RE.test(source)) return { kind: 'ipfs', cid: source, path: '', source, note: 'IPFS CID' };
  return null;
}

const KIND_LABEL = {
  bt: 'BT',
  http: 'HTTP',
  ftp: 'FTP',
  sftp: 'SFTP',
  hls: 'HLS',
  dash: 'DASH',
  metalink: 'Metalink',
  ipfs: 'IPFS',
  ed2k: 'eD2K',
  invalid: '不支持'
};

module.exports = { parseLink, KIND_LABEL, decodeThunder, decodeFlashget };
