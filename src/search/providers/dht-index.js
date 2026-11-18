'use strict';

// 自建 DHT 索引（发现层 → 自己的索引服务）。
// 服务端跑在服务器上，只监听回环，客户端通过 SSH 隧道访问。
//   GET {base}/search?q=&limit=   Authorization: Bearer <token>
//   GET {base}/stats

const { fetchBuffer } = require('../../net/http');
const { normalizeResult } = require('../normalize');

function makeProvider(source) {
  const base = String(source.baseUrl || 'http://127.0.0.1:8899').replace(/\/+$/, '');
  const token = source.apiKey || '';

  return {
    id: 'dht-index',
    label: source.label || '自建 DHT 索引',
    kind: 'dht-index',
    sourceId: source.id,
    async search(query, { signal, limit } = {}) {
      const url = `${base}/search?q=${encodeURIComponent(query)}&limit=${limit || 60}`;
      const { buffer } = await fetchBuffer(url, {
        signal,
        timeout: 8000,
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      });
      let payload;
      try {
        payload = JSON.parse(buffer.toString('utf8'));
      } catch {
        throw new Error('索引服务返回的不是 JSON');
      }
      if (payload.error) throw new Error(payload.error);
      const rows = Array.isArray(payload.results) ? payload.results : [];

      return rows.map((row) => normalizeResult({
        title: row.name || row.infohash,
        infoHash: row.infohash,
        magnet: row.magnet,
        size: row.size,
        // 索引里没有做种数，只有我们观察到的 announce 次数，作为热度展示
        seeders: 0,
        leechers: 0,
        hotness: row.peers || 0,
        publishedAt: row.firstSeen ? new Date(row.firstSeen).toISOString() : null,
        category: 'other'
      }, this)).filter(Boolean);
    }
  };
}

module.exports = { makeProvider };
