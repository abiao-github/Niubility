'use strict';

// 网页视频嗅探：给一个网页地址，把页面里的视频/流地址挖出来。
//
// 说明：这里不执行 JS（那需要无头浏览器，体积和复杂度都不划算），
// 所以能覆盖的是"视频地址直接写在 HTML 里"的站点（大部分站点的 `<video>`、
// HLS/DASH 播放列表、og:video 都会出现在源码里）。需要跑 JS 的站点可以尝试深度嗅探；
// 深度嗅探使用独立沙箱，不会带上用户在常用浏览器里的登录态。

const { fetchBuffer } = require('./http');

const MEDIA_EXT_RE = /\.(mp4|m4v|webm|mkv|mov|m3u8|mpd|flv|ts|mp3|m4a)(\?|#|$)/i;

function absolutize(src, base) {
  try { return new URL(src, base).toString(); } catch { return null; }
}

function unescapeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/');
}

/** 从 HTML 文本里提取候选媒体地址 */
function extractFromHtml(html, pageUrl) {
  const found = new Map();

  const add = (raw, kind, note) => {
    if (!raw) return;
    let url = unescapeHtml(String(raw).trim());
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return;
    url = absolutize(url, pageUrl);
    if (!url) return;
    if (!MEDIA_EXT_RE.test(url) && !/mime_type=video|format=m3u8|mime=video/i.test(url)) return;
    if (!found.has(url)) found.set(url, { url, kind, note });
  };

  // <video src> / <source src>
  for (const m of html.matchAll(/<(?:video|source|audio)[^>]+src=["']([^"']+)["']/gi)) add(m[1], 'html');
  // <video><source src>
  for (const m of html.matchAll(/<source[^>]+src=["']([^"']+)["']/gi)) add(m[1], 'html');
  // og:video / twitter:player:stream
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:video(?::url|:secure_url)?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi)) {
    add(m[1], 'meta');
  }
  // 反过来的属性顺序
  for (const m of html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::url|:secure_url)?|twitter:player:stream)["']/gi)) {
    add(m[1], 'meta');
  }
  // 脚本里的 .m3u8 / .mpd / .mp4 字符串
  for (const m of html.matchAll(/["']([^"']+\.(?:m3u8|mpd|mp4|webm))[^"']*["']/gi)) add(m[1], 'script');

  return [...found.values()];
}

/**
 * 嗅探一个网页里的视频地址。
 * @returns {Promise<{ok:boolean, pageUrl:string, items:Array, note?:string}>}
 */
async function sniffPage(pageUrl, { signal, timeout = 20000 } = {}) {
  if (!/^https?:\/\//i.test(pageUrl || '')) throw new Error('只能嗅探 http/https 网页');
  const { buffer, contentType } = await fetchBuffer(pageUrl, { signal, timeout });
  const type = String(contentType || '');

  // 直接命中媒体地址：不用解析
  if (MEDIA_EXT_RE.test(pageUrl) || /^(video|audio)\//.test(type) || /mpegurl|dash\+xml/.test(type)) {
    const kind = /m3u8|mpegurl/i.test(type + pageUrl) ? 'hls' : (/mpd|dash/i.test(type + pageUrl) ? 'dash' : 'file');
    return { ok: true, pageUrl, items: [{ url: pageUrl, kind, note: '直接是媒体地址' }] };
  }

  const html = buffer.toString('utf8');
  const items = extractFromHtml(html, pageUrl);

  // 给每个候选加上类型提示，便于 UI 显示
  const withKind = items.map((x) => ({
    ...x,
    kind: /\.m3u8(\?|#|$)/i.test(x.url) ? 'hls'
      : /\.mpd(\?|#|$)/i.test(x.url) ? 'dash'
        : 'file'
  }));

  return {
    ok: true,
    pageUrl,
    items: withKind.slice(0, 30),
    note: withKind.length ? `找到 ${withKind.length} 个候选` : '没找到直接的视频地址（可能需要跑 JS 或登录）'
  };
}

module.exports = { sniffPage, extractFromHtml };
