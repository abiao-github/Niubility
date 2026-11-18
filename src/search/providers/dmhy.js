'use strict';

// 动漫花园（share.dmhy.org）RSS 搜索：中文 ACGN 资源，实测可用。
//   https://share.dmhy.org/topics/rss/rss.xml?keyword=<query>
// 条目里只有 .torrent 直链（没有 infohash / 做种数），下载时会走 HTTP 取种子再交给 BT 引擎。

const { XMLParser } = require('fast-xml-parser');
const { fetchBuffer } = require('../../net/http');
const { normalizeResult } = require('../normalize');
const { extractInfoHash } = require('../torznab');

// dmhy 的 <category> 是中文分类名，粗略映射到我们的分类键
const CATEGORY_HINT = [
  [/动画|电影|剧集|特摄|日剧|综艺|Video/i, 'video'],
  [/音乐|无损|专辑|Audio/i, 'audio'],
  [/游戏|Game/i, 'games'],
  [/软件|Application/i, 'apps'],
  [/漫画|小说|图书|画集|Book/i, 'books'],
  [/其他|其它/i, 'other']
];

const DEFAULT_ENDPOINT = 'https://share.dmhy.org/topics/rss/rss.xml';

function endpoint() {
  return process.env.MT_DMHY_URL || DEFAULT_ENDPOINT;
}

function text(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object' && node['#text'] != null) return String(node['#text']);
  return '';
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

async function search(query, { signal } = {}) {
  const base = endpoint();
  const url = base + (base.includes('?') ? '&' : '?') + 'keyword=' + encodeURIComponent(query);
  const { buffer } = await fetchBuffer(url, { signal, timeout: 8000 });

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });
  const doc = parser.parse(buffer.toString('utf8'));
  const channel = doc && doc.rss && doc.rss.channel;
  if (!channel) throw new Error('动漫花园返回的不是 RSS');

  const items = asArray(channel.item);
  return items.map((item) => {
    const enclosure = asArray(item.enclosure)[0] || {};
    const rawUrl = String(enclosure['@_url'] || '');
    // 注意：dmhy 的 enclosure 常常直接给 magnet（btih 是 base32），length 是占位值 1
    const isMagnet = rawUrl.startsWith('magnet:');
    const magnet = isMagnet ? rawUrl : null;
    const torrentUrl = isMagnet ? null : (rawUrl || null);
    const length = Number(enclosure['@_length']) || 0;

    const catName = text(asArray(item.category)[0]);
    let category = 'other';
    for (const [re, key] of CATEGORY_HINT) {
      if (re.test(catName)) { category = key; break; }
    }

    return normalizeResult({
      title: text(item.title),
      magnet,
      torrentUrl,
      infoHash: extractInfoHash(magnet),
      // 小于 1KB 的长度基本都是占位值，当作未知
      size: length > 1024 ? length : 0,
      seeders: 0,
      leechers: 0,
      publishedAt: text(item.pubDate),
      detailsUrl: text(item.link) || text(item.guid) || null,
      category
    }, provider);
  }).filter(Boolean);
}

const provider = {
  id: 'dmhy',
  label: '动漫花园',
  kind: 'rss',
  homepage: 'https://share.dmhy.org',
  search
};

module.exports = provider;
