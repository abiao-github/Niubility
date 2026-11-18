'use strict';

// nyaa.si 的 RSS 接口：https://nyaa.si/?page=rss&q=<query>&c=0_0&f=0
// item: <title> <link>(.torrent) <guid>(详情页) <pubDate> <nyaa:seeders> <nyaa:size> <nyaa:infoHash>

const { XMLParser } = require('fast-xml-parser');
const { fetchBuffer } = require('../../net/http');
const { normalizeResult } = require('../normalize');

const DEFAULT_ENDPOINT = 'https://nyaa.si/';

function endpoint() {
  return process.env.MT_NYAA_URL || DEFAULT_ENDPOINT;
}

function text(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && node['#text'] != null) return String(node['#text']);
  return String(node);
}

function parseSize(raw) {
  const s = String(raw || '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^([\d.]+)\s*([KMGT]?)i?B$/i.exec(s);
  if (!m) return 0;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

async function search(query, { signal } = {}) {
  const base = endpoint();
  const url = base + (base.includes('?') ? '&' : '?') + 'page=rss&q=' + encodeURIComponent(query) + '&c=0_0&f=0';
  const { buffer } = await fetchBuffer(url, { signal, timeout: 15000 });

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });
  const doc = parser.parse(buffer.toString('utf8'));
  const items = doc && doc.rss && doc.rss.channel && doc.rss.channel.item;
  const list = items == null ? [] : (Array.isArray(items) ? items : [items]);

  return list.map((item) => normalizeResult({
    title: text(item.title),
    infoHash: text(item['nyaa:infoHash']),
    size: parseSize(text(item['nyaa:size'])),
    seeders: text(item['nyaa:seeders']),
    leechers: text(item['nyaa:leechers']),
    category: text(item.category),
    publishedAt: text(item.pubDate),
    torrentUrl: text(item.link) || null,
    detailsUrl: text(item.guid) || null
  }, provider)).filter(Boolean);
}

const provider = {
  id: 'nyaa',
  label: 'Nyaa',
  kind: 'rss',
  homepage: 'https://nyaa.si',
  search
};

module.exports = provider;
