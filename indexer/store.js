'use strict';

// 索引存储：内存 Map + 定期落盘（gzip JSONL）。
// 条目很小（hash + 名字 + 大小 + 热度），几十万条也只占几百 MB。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    // 中文按字切，英文按词切
    .split(/[\s._\-\[\]\(\)（）【】\/\\+,'"!?:;]+/)
    .filter(Boolean);
}

class Store {
  constructor({ file, log = () => {} }) {
    this.file = file;
    this.log = log;
    this.map = new Map();
    this.dirty = false;
    this.saving = false;
    this.lastSave = 0;
  }

  get size() {
    return this.map.size;
  }

  upsert(entry) {
    if (!entry || !/^[0-9a-f]{40}$/.test(entry.infohash || '')) return false;
    const now = Date.now();
    const prev = this.map.get(entry.infohash);
    if (prev) {
      prev.lastSeen = now;
      prev.peers = (prev.peers || 0) + (entry.peers || 1);
      if (entry.name && !prev.name) prev.name = entry.name;
      if (entry.size && !prev.size) prev.size = entry.size;
      if (entry.files && !prev.files) prev.files = entry.files;
      this.dirty = true;
      return false;
    }
    this.map.set(entry.infohash, {
      infohash: entry.infohash,
      name: entry.name || '',
      size: entry.size || 0,
      files: entry.files || 0,
      peers: entry.peers || 1,
      firstSeen: now,
      lastSeen: now
    });
    this.dirty = true;
    return true;
  }

  /** 只记录 announce，还没抓到元数据（名字未知） */
  touch(infohash, peers = 1) {
    if (!/^[0-9a-f]{40}$/.test(infohash)) return;
    return this.upsert({ infohash, peers });
  }

  needsMetadata(infohash) {
    const e = this.map.get(infohash);
    return !!e && !e.name;
  }

  search(query, { limit = 60 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const tokens = tokenize(q);
    if (!tokens.length) return [];
    const requestedLimit = Number(limit);
    const maxResults = Number.isFinite(requestedLimit)
      ? Math.max(0, Math.min(200, Math.floor(requestedLimit)))
      : 60;
    if (!maxResults) return [];
    // 也支持直接按 infohash 前缀搜
    const looksLikeHash = /^[0-9a-f]{6,40}$/.test(q);

    const hits = [];
    const addHit = (hit) => {
      let low = 0;
      let high = hits.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const current = hits[mid];
        const before = hit.score > current.score
          || (hit.score === current.score && hit.e.lastSeen > current.e.lastSeen);
        if (before) high = mid;
        else low = mid + 1;
      }
      if (low >= maxResults) return;
      hits.splice(low, 0, hit);
      if (hits.length > maxResults) hits.pop();
    };

    for (const e of this.map.values()) {
      if (!e.name && !looksLikeHash) continue;
      if (looksLikeHash && e.infohash.startsWith(q)) {
        addHit({ e, score: 1e9 });
        continue;
      }
      const hay = (e.name || '').toLowerCase();
      let ok = true;
      for (const t of tokens) {
        if (!hay.includes(t)) { ok = false; break; }
      }
      if (!ok) continue;
      // 精确短语 > 全词命中；热度（announce 次数）做次级排序
      const phrase = hay.includes(q) ? 1 : 0;
      addHit({ e, score: phrase * 1e6 + Math.min(e.peers || 0, 9999) });
    }

    const now = Date.now();
    return hits.map(({ e }) => ({
      infohash: e.infohash,
      name: e.name,
      size: e.size,
      files: e.files,
      peers: e.peers,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      ageHours: Math.round((now - e.firstSeen) / 3600000),
      magnet: 'magnet:?xt=urn:btih:' + e.infohash + (e.name ? '&dn=' + encodeURIComponent(e.name) : '')
    }));
  }

  stats() {
    let named = 0;
    for (const e of this.map.values()) if (e.name) named += 1;
    return { total: this.map.size, named };
  }

  async load() {
    if (!fs.existsSync(this.file)) return 0;
    const stream = fs.createReadStream(this.file).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let n = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && e.infohash) { this.map.set(e.infohash, e); n += 1; }
      } catch { /* 跳过坏行 */ }
    }
    this.log(`[store] 载入 ${n} 条`);
    return n;
  }

  async save(force = false) {
    if (this.saving) return;
    if (!force && (!this.dirty || Date.now() - this.lastSave < 30000)) return;
    this.saving = true;
    this.dirty = false;
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const out = fs.createWriteStream(tmp);
      const gz = zlib.createGzip({ level: 6 });
      gz.pipe(out);
      for (const e of this.map.values()) {
        if (!gz.write(JSON.stringify(e) + '\n')) {
          await new Promise((r) => gz.once('drain', r));
        }
      }
      await new Promise((resolve, reject) => {
        gz.end(() => out.end(() => resolve()));
        out.on('error', reject);
      });
      fs.renameSync(tmp, this.file);
      this.lastSave = Date.now();
      this.log(`[store] 已保存 ${this.map.size} 条 → ${this.file}`);
    } catch (err) {
      this.log('[store] 保存失败: ' + err.message);
      this.dirty = true;
    } finally {
      this.saving = false;
    }
  }
}

export { Store, tokenize };
