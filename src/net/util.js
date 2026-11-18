'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 去掉路径分隔符和非法字符，避免 URL 里的名字跑出下载目录
function sanitizeName(name, fallback) {
  let out = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  out = out.replace(/^\.+/, '');
  if (!out || out === '_') out = fallback || 'download';
  return out.slice(0, 180);
}

function uniquePath(dir, name) {
  const base = sanitizeName(name);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let candidate = path.join(dir, base);
  let i = 1;
  while (fs.existsSync(candidate) || fs.existsSync(candidate + '.part')) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    i += 1;
    if (i > 999) break;
  }
  return candidate;
}

function filenameFromDisposition(header) {
  if (!header) return null;
  // RFC5987: filename*=UTF-8''...
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[2].trim()); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  if (plain) return plain[1].trim();
  return null;
}

function filenameFromUrl(url, fallback) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch { /* ignore */ }
  return fallback;
}

function newId() {
  return crypto.randomUUID();
}

// 滑动窗口测速：每 500ms 采样一次，取最近 3 秒的平均
class SpeedMeter {
  constructor() {
    this.samples = [];
    this.lastBytes = 0;
    this.speed = 0;
  }

  update(bytes) {
    const now = Date.now();
    this.samples.push({ t: now, b: bytes });
    while (this.samples.length > 2 && now - this.samples[0].t > 3000) this.samples.shift();
    const first = this.samples[0];
    const dt = (now - first.t) / 1000;
    this.speed = dt > 0.2 ? Math.max(0, (bytes - first.b) / dt) : this.speed;
    this.lastBytes = bytes;
    return this.speed;
  }
}

function humanBytes(n) {
  if (n == null || !isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? Math.round(v) : v.toFixed(2)) + ' ' + units[i];
}

function rmrf(target) {
  if (!target) return;
  fs.rm(target, { recursive: true, force: true }, () => {});
}

module.exports = {
  ensureDir,
  sanitizeName,
  uniquePath,
  filenameFromDisposition,
  filenameFromUrl,
  newId,
  SpeedMeter,
  humanBytes,
  rmrf
};
