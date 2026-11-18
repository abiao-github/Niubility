'use strict';

// 搜索结果相关性判定。
//
// 为什么需要：有些来源（典型是海盗湾的 apibay）在关键词没命中时会返回一份「热门榜单」兜底，
// 中文查询几乎必然命中不到，于是界面上全是无关条目。网关必须自己判断相关性。
//
// 规则：
//   · 英文/混合：查询词按空格拆，命中 ≥50% 视为相关
//   · 中文：按字覆盖率判断（≥60% 且至少命中 2 个字），整串命中直接满分
//   · 完全不命中 → 0 分，直接过滤掉

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, ' ')
    .replace(/[._\-[\]()（）【】/\\+,:'"!?;、，。！？：；]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasCJK(s) {
  return /[\u4e00-\u9fff]/.test(s);
}

/** 查询串里在标题中出现的最长连续片段长度（中文没有空格，靠这个判断"是不是同一件事"） */
function longestRun(queryChars, title) {
  let best = 0;
  const n = queryChars.length;
  for (let i = 0; i < n; i++) {
    for (let j = n; j > i; j--) {
      const len = j - i;
      if (len <= best) break;
      if (title.includes(queryChars.slice(i, j).join(''))) {
        best = len;
        break;
      }
    }
  }
  return best;
}

/**
 * @returns {number} 0 表示不相关；越大越相关
 */
function relevance(title, query) {
  const q = normalize(query);
  const t = normalize(title);
  if (!q || !t) return 0;

  // 整串命中（去掉空格后比较），比如 "进击的巨人" 命中 "进击的巨人 剧场版"
  const qCompact = q.replace(/\s/g, '');
  if (qCompact && t.replace(/\s/g, '').includes(qCompact)) return 100;

  if (hasCJK(q)) {
    const chars = [...qCompact];
    const hit = chars.filter((c) => t.includes(c)).length;
    const ratio = hit / chars.length;
    // 关键：不能只看"字有没有出现"，否则「冠希哥」会命中只有「希」和「哥」的无关标题。
    // 要求标题里至少有一段长度 >= max(2, 60% 查询长度) 的连续命中。
    const needRun = Math.max(1, Math.min(chars.length, Math.max(2, Math.ceil(chars.length * 0.6))));
    const run = longestRun(chars, t);
    if (hit >= 2 && ratio >= 0.6 && run >= needRun) {
      return Math.min(95, Math.round(ratio * 40 + run * 10));
    }
    return 0;
  }

  const tokens = q.split(' ').filter(Boolean);
  if (!tokens.length) return 0;
  const hit = tokens.filter((tok) => t.includes(tok)).length;
  const ratio = hit / tokens.length;
  // 多词查询命中一半以上就算相关（比如 "ubuntu iso" ↔ "Ubuntu 24.04 Desktop"）
  if (ratio >= 0.5) return Math.round(ratio * 60);
  return 0;
}

/**
 * 过滤 + 按相关性排序（相关性优先，其次做种/热度）。
 * @param {Array} results
 * @param {string|string[]} queries 支持多个查询词（原词 + 翻译），任一命中即保留
 * @returns {{kept: Array, dropped: number}}
 */
function rankByRelevance(results, queries) {
  const list = (Array.isArray(queries) ? queries : [queries]).filter(Boolean);
  const scored = [];
  let dropped = 0;
  for (const r of results) {
    let score = 0;
    for (const q of list) {
      const s = relevance(r.title, q);
      if (s > score) score = s;
    }
    if (score <= 0) { dropped += 1; continue; }
    scored.push({ r, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const rank = (x) => (x.seeders || 0) * 1000 + Math.min(x.hotness || 0, 999);
    return rank(b.r) - rank(a.r);
  });
  return { kept: scored.map((x) => x.r), dropped };
}

module.exports = { relevance, rankByRelevance, normalize };
