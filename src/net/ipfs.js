'use strict';

// IPFS：优先用本地 Kubo 网关，其次公共网关。
// 只做“按 CID 取文件”（/ipfs/<cid>），IPNS 名称交给网关解析。

const { probe } = require('./http');

const LOCAL_GATEWAYS = ['http://127.0.0.1:8080/ipfs/'];
const PUBLIC_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/'
];

function gateways(mode) {
  if (mode === 'local') return LOCAL_GATEWAYS.slice();
  if (mode === 'public') return PUBLIC_GATEWAYS.slice();
  return [...LOCAL_GATEWAYS, ...PUBLIC_GATEWAYS];
}

function buildUrls(cid, rest, mode) {
  const suffix = (cid + '/' + (rest || '')).replace(/\/+$/, '');
  return gateways(mode).map((gw) => gw + suffix);
}

/**
 * 探测哪个网关可用（本地没起也不影响）。
 * @returns {Promise<{url:string, length:number, filename:string, gateway:string}>}
 */
async function describe(cid, rest, { mode = 'auto', signal } = {}) {
  if (!cid) throw new Error('IPFS 链接缺少 CID');
  const urls = buildUrls(cid, rest, mode);
  const failures = [];
  for (const url of urls) {
    try {
      const info = await probe(url, { signal, timeout: 15000 });
      if (!info.ok) {
        failures.push(`${url} → HTTP ${info.status}`);
        continue;
      }
      return {
        kind: 'ipfs',
        url: info.finalUrl || url,
        length: info.length,
        filename: rest ? rest.split('/').filter(Boolean).pop() : (info.filename || cid),
        gateway: new URL(url).origin,
        cid
      };
    } catch (err) {
      failures.push(`${url} → ${err.message}`);
    }
  }
  const e = new Error('没有可用的 IPFS 网关。可运行本地 Kubo（127.0.0.1:8080）或配置可访问的公网网关。');
  e.details = failures;
  throw e;
}

module.exports = { describe, buildUrls, gateways };
