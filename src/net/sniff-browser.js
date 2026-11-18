'use strict';

// 深度嗅探：用一个隐藏的 BrowserWindow 真正执行页面 JS，从网络请求里抓媒体地址。
//
// 为什么这么做：静态 HTML 里没有地址（运行时拼出来、或者要等 XHR），只有让 JS 跑起来才看得见。
// 我们是 Electron 应用，本来就带 Chromium —— 不需要再引入 puppeteer/playwright（那会多 100MB+）。
//
// 安全：沙箱窗口、独立临时分区（不落盘 cookie）、禁止弹窗、禁止权限、超时自动销毁。

const { BrowserWindow, session } = require('electron');

const MEDIA_RE = /\.(mp4|m4v|webm|mkv|mov|m3u8|mpd|flv|ts|mp3|m4a|aac|ogg|opus|wav)(\?|#|$)/i;
const STREAM_HINT = /(mplaylist|mpd|m3u8|hls|dash|manifest|playlist)/i;

function classify(url, contentType) {
  const type = String(contentType || '');
  if (/mpegurl|m3u8/i.test(type) || /\.m3u8(\?|#|$)/i.test(url)) return 'hls';
  if (/dash\+xml/i.test(type) || /\.mpd(\?|#|$)/i.test(url)) return 'dash';
  if (/^video\//i.test(type) || /^audio\//i.test(type)) return 'file';
  if (MEDIA_RE.test(url)) return 'file';
  if (STREAM_HINT.test(url)) return 'hls';
  return null;
}

/**
 * @param {string} pageUrl
 * @param {{timeoutMs?:number, dwellMs?:number, userAgent?:string}} opts
 * @returns {Promise<{ok:boolean, pageUrl:string, items:Array, note:string}>}
 */
async function sniffWithBrowser(pageUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000;
  const dwellMs = opts.dwellMs || 3500;
  const collected = new Map();
  const partition = `sniff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition,
      images: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  try { win.setMenuBarVisibility(false); } catch { /* ignore */ }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const ses = session.fromPartition(partition);
  try { ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); } catch { /* ignore */ }

  const record = (url, contentType) => {
    if (!/^https?:/i.test(url)) return;
    const kind = classify(url, contentType);
    if (!kind) return;
    if (!collected.has(url)) collected.set(url, { url, kind, note: '运行时请求' });
  };

  const onStarted = (details) => {
    const { url, resourceType, responseHeaders, statusCode } = details;
    if (statusCode >= 400) return;
    const ct = responseHeaders && (responseHeaders['content-type'] || responseHeaders['Content-Type']);
    const type = Array.isArray(ct) ? ct[0] : ct;
    if (resourceType === 'media' || resourceType === 'xhr' || resourceType === 'fetch' || resourceType === 'other') {
      record(url, type);
    } else if (MEDIA_RE.test(url)) {
      record(url, type);
    }
  };

  ses.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, onStarted);

  const done = new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolve(); } };
    win.webContents.once('did-finish-load', () => setTimeout(finish, dwellMs));
    win.webContents.once('did-fail-load', () => setTimeout(finish, 500));
    setTimeout(finish, timeoutMs);
  });

  try {
    await win.loadURL(pageUrl, { userAgent: opts.userAgent });
  } catch { /* 加载失败也继续走完超时，可能已经抓到部分请求 */ }

  // 页面可能把播放挂在点击/滚动上：轻推一下
  try {
    await win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('video,audio');
      if (v) { v.muted = true; v.play && v.play().catch(() => {}); }
      window.scrollTo(0, 200);
      return true;
    })()`, true);
  } catch { /* ignore */ }

  await done;

  try { ses.webRequest.onResponseStarted(null); } catch { /* ignore */ }
  try { win.destroy(); } catch { /* ignore */ }

  const items = [...collected.values()].slice(0, 40);
  return {
    ok: true,
    pageUrl,
    items,
    note: items.length ? `浏览器深度嗅探找到 ${items.length} 个` : '深度嗅探也没找到（可能需要登录，或要手动点播放）'
  };
}

module.exports = { sniffWithBrowser };
