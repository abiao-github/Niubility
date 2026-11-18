'use strict';

// Jackett：走 Torznab 聚合接口
//   {base}/api/v2.0/indexers/all/results/torznab/api?apikey=KEY&t=search&q=QUERY
// 如果配置里带了 indexerId，就只查那一个 indexer。

const { fetchBuffer } = require('../../net/http');
const { normalizeResult } = require('../normalize');
const { parseTorznabXml } = require('../torznab');

function buildUrl(source, query, limit) {
  const base = String(source.baseUrl || '').replace(/\/+$/, '');
  const indexer = source.indexerId ? encodeURIComponent(source.indexerId) : 'all';
  const params = new URLSearchParams({
    apikey: source.apiKey,
    t: 'search',
    q: query,
    limit: String(limit || 40)
  });
  return `${base}/api/v2.0/indexers/${indexer}/results/torznab/api?${params.toString()}`;
}

function makeProvider(source) {
  return {
    id: 'jackett',
    label: source.label || 'Jackett',
    kind: 'torznab',
    sourceId: source.id,
    async search(query, { signal, limit } = {}) {
      const url = buildUrl(source, query, limit);
      const { buffer } = await fetchBuffer(url, { signal, timeout: 20000 });
      const { items, error } = parseTorznabXml(buffer.toString('utf8'));
      if (error) throw new Error(error);
      return items
        .map((it) => normalizeResult({ ...it, source: it.indexer || (source.label || 'Jackett') }, this))
        .filter(Boolean);
    }
  };
}

module.exports = { makeProvider, buildUrl };
