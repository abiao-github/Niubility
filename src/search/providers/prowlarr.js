'use strict';

// Prowlarr：聚合搜索走它自己的 JSON API（不是 Torznab）
//   GET {base}/api/v1/search?query=QUERY&type=search&limit=N   Header: X-Api-Key
// 返回的是 ReleaseResource 数组，每个元素带 indexer / magnetUrl / infoHash / categories。
// 另外兼容：如果该地址实际是 Torznab（有人把 indexer 的 Torznab 端点填进来），自动按 XML 解析。

const { fetchBuffer } = require('../../net/http');
const { normalizeResult } = require('../normalize');
const { parseTorznabXml, extractInfoHash, categoryOf } = require('../torznab');

function buildJsonUrl(source, query, limit) {
  const base = String(source.baseUrl || '').replace(/\/+$/, '');
  const params = new URLSearchParams({
    query,
    type: 'search',
    limit: String(limit || 40)
  });
  return `${base}/api/v1/search?${params.toString()}`;
}

function pickCategories(row) {
  const cats = [];
  for (const c of (row.categories || [])) {
    if (c == null) continue;
    if (typeof c === 'number' || typeof c === 'string') cats.push(c);
    else if (c.id != null) cats.push(c.id);
  }
  if (row.category != null) cats.push(row.category);
  return cats;
}

function mapJsonRows(rows, provider, source) {
  return rows.map((row) => {
    const magnet = row.magnetUrl || row.magneturl || (String(row.guid || '').startsWith('magnet:') ? row.guid : null);
    const torrentUrl = row.downloadUrl || row.downloadurl || row.link
      || (String(row.guid || '').startsWith('http') ? row.guid : null);
    return normalizeResult({
      title: row.title,
      size: row.size,
      seeders: row.seeders != null ? row.seeders : row.seedersCount,
      leechers: row.leechers != null ? row.leechers : row.leechersCount,
      publishedAt: row.publishDate || row.publishdate || row.pubDate,
      magnet,
      torrentUrl,
      infoHash: row.infoHash || row.infohash || extractInfoHash(magnet, row.guid),
      category: categoryOf(pickCategories(row)),
      source: row.indexer || (source.label || 'Prowlarr')
    }, provider);
  }).filter(Boolean);
}

function makeProvider(source) {
  return {
    id: 'prowlarr',
    label: source.label || 'Prowlarr',
    kind: 'prowlarr',
    sourceId: source.id,
    async search(query, { signal, limit } = {}) {
      const url = buildJsonUrl(source, query, limit);
      const { buffer, contentType } = await fetchBuffer(url, {
        signal,
        timeout: 20000,
        headers: { 'X-Api-Key': source.apiKey }
      });
      const body = buffer.toString('utf8');

      if (contentType.includes('xml') || /^\s*<\?xml|^\s*<rss/i.test(body)) {
        const { items, error } = parseTorznabXml(body);
        if (error) throw new Error(error);
        return items
          .map((it) => normalizeResult({ ...it, source: it.indexer || (source.label || 'Prowlarr') }, this))
          .filter(Boolean);
      }

      let rows;
      try {
        rows = JSON.parse(body);
      } catch {
        throw new Error('Prowlarr 返回的不是 JSON（检查地址是否是 Prowlarr 而不是某个 indexer）');
      }
      if (!Array.isArray(rows)) {
        const msg = rows && (rows.message || rows.error || rows.errorMessage);
        throw new Error(msg ? 'Prowlarr 报错：' + msg : 'Prowlarr 返回格式异常');
      }
      return mapJsonRows(rows, this, source);
    }
  };
}

module.exports = { makeProvider, buildJsonUrl };
