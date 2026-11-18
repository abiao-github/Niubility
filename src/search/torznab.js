'use strict';

// Torznab（Newznab 的种子变体）解析。
// Jackett 的聚合入口：  {base}/api/v2.0/indexers/all/results/torznab/api?apikey=KEY&t=search&q=QUERY
// Prowlarr 的单 indexer：{base}/{indexerId}/api?apikey=KEY&t=search&q=QUERY

const { XMLParser } = require('fast-xml-parser');

const CATEGORY_MAP = {
  1: 'audio',
  2: 'video',
  3: 'apps',
  4: 'games',
  5: 'porn',
  7: 'books'
};

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    if (node['#text'] != null) return String(node['#text']);
    if (node['@_value'] != null) return String(node['@_value']);
  }
  return '';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Torznab 数字分类 → 我们自己的分类键（1000 音频 / 2000 视频 / 3000 软件 / 4000 游戏 / 5000 成人 / 7000 图书） */
function categoryOf(cats) {
  for (const c of cats) {
    const major = String(c).trim()[0];
    if (major && CATEGORY_MAP[major]) return CATEGORY_MAP[major];
  }
  return 'other';
}

/** 从 magnet 或 40 位 hex 里抠 infohash（Torznab 经常不专门给） */
function extractInfoHash(...candidates) {
  for (const raw of candidates) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (/^[0-9a-f]{40}$/i.test(s)) return s.toLowerCase();
    const m = /xt=urn:btih:([0-9a-z]{32,40})/i.exec(s);
    if (m) {
      const hash = m[1].toLowerCase();
      return hash.length === 32 ? base32ToHex(hash) : hash;
    }
  }
  return null;
}

function base32ToHex(b32) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = '';
  for (const ch of b32.toLowerCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) return null;
    bits += idx.toString(2).padStart(5, '0');
  }
  const hex = [];
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex.push(parseInt(bits.slice(i, i + 4), 2).toString(16));
  }
  return hex.join('').slice(0, 40);
}

/**
 * 解析 Torznab RSS。
 * @returns {{items: Array<object>, error: string|null}}
 */
function parseTorznabXml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: true
  });
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    return { items: [], error: 'Torznab 返回的不是合法 XML' };
  }

  // Torznab 出错时可能 HTTP 200 + <error code=".." description=".."/>
  const errNode = doc && (doc.error || (doc.rss && doc.rss.error));
  if (errNode) {
    const desc = text(errNode['@_description']) || text(errNode.description) || text(errNode);
    return { items: [], error: '接口报错：' + (desc || '未知错误') };
  }

  const channel = doc && doc.rss && doc.rss.channel;
  if (!channel) return { items: [], error: '响应里没有 RSS channel' };

  const items = asArray(channel.item).map((item) => {
    const attrs = {};
    for (const a of asArray(item['torznab:attr'] || item['newznab:attr'] || item.attr)) {
      const name = String((a && a['@_name']) || '').toLowerCase();
      if (name) attrs[name] = a['@_value'];
    }

    const enclosure = asArray(item.enclosure)[0] || {};
    const cats = asArray(item.category).map((c) => text(c)).filter(Boolean);
    const magnet = attrs.magneturl
      || (String(item.link || '').startsWith('magnet:') ? text(item.link) : null)
      || (String(enclosure['@_url'] || '').startsWith('magnet:') ? enclosure['@_url'] : null);
    const torrentUrl = attrs.downloadurl
      || (String(item.link || '').startsWith('http') ? text(item.link) : null)
      || (String(enclosure['@_url'] || '').startsWith('http') ? enclosure['@_url'] : null);

    return {
      title: text(item.title),
      infoHash: extractInfoHash(attrs.infohash, magnet, item.guid),
      magnet,
      torrentUrl,
      size: num(item.size) || num(enclosure['@_length']) || num(attrs.size),
      seeders: num(attrs.seeders),
      leechers: Math.max(0, num(attrs.peers) - num(attrs.seeders)),
      publishedAt: text(item.pubDate) || text(item.publishDate) || null,
      categories: cats,
      category: categoryOf(cats),
      detailsUrl: text(item.guid) && text(item.guid).startsWith('http') ? text(item.guid) : null,
      files: 0,
      indexer: attrs.jackettindexer || null
    };
  }).filter((it) => it.title && (it.magnet || it.torrentUrl));

  return { items, error: null };
}

module.exports = { parseTorznabXml, extractInfoHash, categoryOf, base32ToHex };
