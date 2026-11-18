'use strict';

// 搜索结果的标准化：所有 provider 都必须产出这个形状，
// 上层（网关 / UI / 调度层）只认这个结构，不认任何 provider 的原始字段。

const { newId } = require('../net/util');

const CATEGORY_LABEL = {
  audio: '音乐',
  video: '视频',
  apps: '软件',
  games: '游戏',
  porn: '成人',
  books: '图书',
  other: '其它'
};

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'number') return new Date(value * 1000).toISOString();
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildMagnet(infoHash, title) {
  if (!/^[0-9a-f]{40}$/i.test((infoHash || '').trim())) return null;
  const xt = 'xt=urn:btih:' + infoHash.toLowerCase();
  const dn = title ? '&dn=' + encodeURIComponent(title) : '';
  return `magnet:?${xt}${dn}`;
}

function normalizeCategory(raw) {
  const v = String(raw || '').toLowerCase();
  for (const key of Object.keys(CATEGORY_LABEL)) {
    if (v.includes(key)) return key;
  }
  // apibay 的数字分类：1xx 音乐 2xx 视频 3xx 软件 4xx 游戏 5xx 成人
  if (/^\d+$/.test(v)) {
    const major = v[0];
    return { 1: 'audio', 2: 'video', 3: 'apps', 4: 'games', 5: 'porn', 6: 'other', 7: 'books' }[major] || 'other';
  }
  return 'other';
}

/**
 * 把 provider 的原始条目变成标准 SearchResult。
 * @param {object} raw
 * @param {object} provider {id,label}
 */
function normalizeResult(raw, provider) {
  const title = String(raw.title || '').trim();
  if (!title) return null;

  let infoHash = (raw.infoHash || '').trim().toLowerCase() || null;
  if (!infoHash) {
    for (const cand of [raw.magnet, raw.torrentUrl, raw.detailsUrl]) {
      const m = /xt=urn:btih:([0-9a-z]{32,40})/i.exec(String(cand || ''));
      if (m) { infoHash = m[1].toLowerCase(); break; }
    }
  }
  const magnet = raw.magnet || buildMagnet(infoHash, title);
  const torrentUrl = raw.torrentUrl || null;
  if (!magnet && !torrentUrl) return null;

  const category = normalizeCategory(raw.category);
  return {
    id: newId(),
    provider: provider.id,
    providerLabel: provider.label,
    source: raw.source || provider.label,
    title,
    infoHash,
    magnet,
    torrentUrl,
    size: toNumber(raw.size),
    seeders: toNumber(raw.seeders),
    leechers: toNumber(raw.leechers),
    // 没有做种数时用热度（索引里观察到的 announce 次数）参与排序和展示
    hotness: toNumber(raw.hotness),
    files: toNumber(raw.files),
    category,
    categoryLabel: CATEGORY_LABEL[category] || '其它',
    publishedAt: toIso(raw.publishedAt),
    detailsUrl: raw.detailsUrl || null
  };
}

function resultKey(r) {
  if (r.infoHash) return 'h:' + r.infoHash;
  return 't:' + r.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 120) + ':' + r.size;
}

/** 去重（同一 infohash 只留做种最多的那条）+ 按做种数排序 */
function dedupeAndSort(results) {
  const best = new Map();
  for (const r of results) {
    if (!r) continue;
    const key = resultKey(r);
    const prev = best.get(key);
    if (!prev) { best.set(key, r); continue; }
    if (r.seeders > prev.seeders) {
      // 保留更好的那条，但记住还有别的来源
      best.set(key, { ...r, alsoOn: [...(prev.alsoOn || []), prev.providerLabel] });
    } else {
      prev.alsoOn = [...(prev.alsoOn || []), r.providerLabel];
    }
  }
  const rank = (r) => (r.seeders || 0) * 1000 + Math.min(r.hotness || 0, 999);
  return [...best.values()].sort((a, b) => {
    const d = rank(b) - rank(a);
    if (d) return d;
    return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
  });
}

module.exports = { normalizeResult, dedupeAndSort, buildMagnet, toIso, toNumber, CATEGORY_LABEL };
