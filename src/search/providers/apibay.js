'use strict';

// apibay（The Pirate Bay 的 JSON 接口）：GET /q.php?q=<query>&cat=0
// 返回数组：{id, name, info_hash, leechers, seeders, size, added, category, status}

const { fetchBuffer } = require('../../net/http');
const { normalizeResult } = require('../normalize');

const DEFAULT_ENDPOINT = 'https://apibay.org/q.php';
const EMPTY_HASH = '0000000000000000000000000000000000000000';

function endpoint() {
  // 允许指向镜像 / 本地测试服务器
  return process.env.MT_APIC_URL || DEFAULT_ENDPOINT;
}

async function search(query, { signal } = {}) {
  const base = endpoint();
  const url = base + (base.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(query) + '&cat=0';
  const { buffer } = await fetchBuffer(url, { signal, timeout: 20000 });
  let rows;
  try {
    rows = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('搜索接口返回的不是 JSON');
  }
  if (!Array.isArray(rows)) throw new Error('搜索接口返回格式异常');

  return rows
    .filter((r) => r && r.info_hash && r.info_hash.toLowerCase() !== EMPTY_HASH && Number(r.size) > 0)
    .map((r) => normalizeResult({
      title: r.name,
      infoHash: r.info_hash,
      size: r.size,
      seeders: r.seeders,
      leechers: r.leechers,
      category: r.category,
      publishedAt: r.added,
      // apibay 不直接给 .torrent，用磁力即可；详情页留给 UI 展示
      detailsUrl: 'https://thepiratebay.org/description.php?id=' + r.id,
      files: r.num_files
    }, provider))
    .filter(Boolean);
}

const provider = {
  id: 'apibay',
  label: 'The Pirate Bay',
  kind: 'json',
  homepage: 'https://thepiratebay.org',
  search
};

module.exports = provider;
