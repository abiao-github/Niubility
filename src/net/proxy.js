'use strict';

// 代理支持：发现层很多站点（动漫花园、部分 BT 站）需要走代理才通。
//
// 取值顺序：
//   1. MT_PROXY 环境变量（http://127.0.0.1:7897 或 socks5://...，undici 只支持 http(s) 代理）
//   2. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 环境变量
//   3. MT_PROXY=auto 或什么都没配时，探测本机常见 Clash / Surge 端口（7897/7890/1087/6152）
//
// 结果缓存 30 秒，避免每次请求都探测端口。

const net = require('net');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const CANDIDATES = [7897, 7890, 1087, 6152, 8080];
let cache = { at: 0, url: null };

function portOpen(port, timeout = 200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function fromEnv() {
  const raw = process.env.MT_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!raw || raw === 'auto' || raw === 'none') return null;
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : null;
}

async function detect() {
  const now = Date.now();
  if (now - cache.at < 30000) return cache.url;
  const envProxy = fromEnv();
  if (envProxy) {
    cache = { at: now, url: envProxy };
    return envProxy;
  }
  if ((process.env.MT_PROXY || '').toLowerCase() === 'none') {
    cache = { at: now, url: null };
    return null;
  }
  for (const port of CANDIDATES) {
    if (await portOpen(port)) {
      const url = 'http://127.0.0.1:' + port;
      cache = { at: now, url };
      return url;
    }
  }
  cache = { at: now, url: null };
  return null;
}

let agents = new Map();
function agentFor(proxyUrl) {
  if (!proxyUrl) return null;
  if (!agents.has(proxyUrl)) agents.set(proxyUrl, new ProxyAgent(proxyUrl));
  return agents.get(proxyUrl);
}

// 每个域名记住「直连还是走代理」，避免每次都先失败一次：
// 能直连的站点（比如 apibay）保持直连，被墙的（比如动漫花园）第一次失败后固定走代理。
const hostState = new Map();
const DIRECT_PROBE_MS = 2500;  // 直连探测窗口（只对公网域名生效，本地地址直接放行）

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url); }
}

// 本机/内网地址绝不走代理：否则本地服务（Prowlarr/Jackett/索引）会被 Clash 转一圈甚至转死
function isLocalHost(host) {
  const name = String(host).replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0.0.0.0') return true;
  if (/^127\./.test(name) || /^10\./.test(name) || /^192\.168\./.test(name)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(name)) return true;
  if (name.endsWith('.local')) return true;
  return false;
}

async function viaProxy(url, options) {
  const proxyUrl = await detect();
  if (!proxyUrl) return undiciFetch(url, options);
  return undiciFetch(url, { ...options, dispatcher: agentFor(proxyUrl) });
}

/**
 * 带代理回退的 fetch：能直连就直连，直连失败再走代理。
 * 用法与全局 fetch 一致。
 */
async function proxyFetch(url, options = {}) {
  const host = hostOf(url);
  if (isLocalHost(host)) return undiciFetch(url, options);   // 本地服务直连
  const known = hostState.get(host);
  if (known === 'proxy') return viaProxy(url, options);
  if (known === 'direct') return undiciFetch(url, options);

  const proxyUrl = await detect();
  if (!proxyUrl) return undiciFetch(url, options);

  // 首次访问：先给直连一个很短的窗口，失败再切代理
  const timeout = AbortSignal.timeout(DIRECT_PROBE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const res = await undiciFetch(url, { ...options, signal });
    hostState.set(host, 'direct');
    return res;
  } catch (err) {
    if (options.signal && options.signal.aborted) throw err;
    hostState.set(host, 'proxy');
    return viaProxy(url, options);
  }
}

async function currentProxy() {
  return detect();
}

function resetCache() {
  cache = { at: 0, url: null };
  agents = new Map();
  hostState.clear();
}

module.exports = { proxyFetch, currentProxy, detect, resetCache, CANDIDATES };
