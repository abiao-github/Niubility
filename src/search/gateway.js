'use strict';

// 统一搜索网关（发现层）。
//
// 职责边界：
//   · provider 只知道「怎么把一个关键词变成一堆候选资源」，不认识任务、不认识协议；
//   · 网关只做聚合 / 去重 / 排序 / 标准化，不 import 任何协议适配器；
//   · 「下载」这一步只是把 SearchResult 还原成一条链接（磁力或 .torrent），
//     然后交给调度层（TaskManager.add），与用户手动粘贴磁力完全同一条路径。

const { dedupeAndSort } = require('./normalize');
const { rankByRelevance } = require('./relevance');
const { expandQuery } = require('./translate');

// 各来源轮流取：否则「没有做种数」的来源（dmhy / 自建索引）会被永远压在后面甚至被截断。
// 来源内部仍然按热度/做种排序。
function interleaveBySource(list, limit) {
  const groups = new Map();
  for (const r of list) {
    if (!groups.has(r.provider)) groups.set(r.provider, []);
    groups.get(r.provider).push(r);
  }
  if (groups.size <= 1) return list.slice(0, limit);
  const keys = [...groups.keys()];
  const out = [];
  for (let i = 0; out.length < limit; i++) {
    let pushed = false;
    for (const k of keys) {
      const g = groups.get(k);
      if (i >= g.length) continue;
      out.push(g[i]);
      pushed = true;
      if (out.length >= limit) break;
    }
    if (!pushed) break;
  }
  return out;
}

const DEFAULT_TIMEOUT = 12000;

class SearchGateway {
  /**
   * @param {object} opts
   * @param {Array<object>} opts.providers provider 列表
   * @param {{add: Function}} opts.manager 调度层（只用它的 add）
   */
  constructor({ providers = [], manager } = {}) {
    this.providers = new Map(providers.map((p) => [p.id, p]));
    this.manager = manager || null;
    this.cache = new Map(); // resultId -> SearchResult
  }

  listProviders() {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      homepage: p.homepage || null
    }));
  }

  /**
   * 并发查询多个 provider，坏掉的只记录错误、不影响其它来源。
   * @returns {Promise<{query:string, results:Array, errors:Array, tookMs:number}>}
   */
  async search(query, opts = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('搜索关键词不能为空');

    const wanted = opts.providers && opts.providers.length
      ? opts.providers.filter((id) => this.providers.has(id))
      : [...this.providers.keys()];
    if (!wanted.length) throw new Error('没有启用的搜索源');

    const perProviderMs = opts.timeoutMs || 30000;
    // Jackett / Prowlarr 这类聚合源要几秒钟（它们要并发问所有 indexer），
    // 所以宽限给到 8 秒；但如果所有来源都更快返回，Promise.all 会提前结束，不会干等。
    const softMs = opts.softTimeoutMs || 20000;   // 兜底：最长等这么久
    const graceMs = opts.graceMs || 12000;        // 首个来源返回后再等这么久（Prowlarr 冷启动实测 8–14s）
    const limit = opts.limit || 60;
    const started = Date.now();

    // 可选：把查询扩展成「原词 + 翻译」（中文↔英文），两份结果合并
    const { variants, note: expandNote } = await expandQuery(q, { enabled: !!opts.expand });
    const queries = variants.length ? variants : [q];

    // 每个 (来源 × 查询变体) 一个任务槽，错误按来源归并
    const slots = [];
    const running = [];
    for (let v = 0; v < queries.length; v++) {
      for (const id of wanted) {
        const slot = { id, variant: v, state: 'pending', results: [], error: null };
        slots.push(slot);
        const provider = this.providers.get(id);
        const signal = AbortSignal.timeout(perProviderMs);
        running.push(
          Promise.resolve()
            .then(() => provider.search(queries[v], { signal, limit }))
            .then((rs) => { slot.state = 'ok'; slot.results = rs || []; })
            .catch((err) => {
              slot.state = 'error';
              slot.error = (err && (err.message || String(err))) || '未知错误';
            })
        );
      }
    }

    // 慢的来源不该拖住整个搜索：第一个来源回来后，再等一小会儿（grace）就出结果
    const delay = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
    const anySettled = new Promise((resolve) => {
      let done = false;
      for (const p of running) p.finally(() => { if (!done) { done = true; resolve(); } });
    });
    await Promise.race([
      Promise.all(running),
      anySettled.then(() => delay(graceMs)),
      delay(softMs)
    ]);

    const merged = [];
    const errors = [];
    const seenError = new Set();
    for (const slot of slots) {
      if (slot.state === 'ok') {
        merged.push(...slot.results);
        continue;
      }
      const label = this.providers.get(slot.id).label;
      const key = slot.id + '|' + (slot.error || 'timeout');
      if (seenError.has(key)) continue;
      seenError.add(key);
      errors.push({
        provider: slot.id,
        label,
        message: slot.state === 'error' ? slot.error : '超时未返回'
      });
    }

    // 先按关键词（含翻译变体）过滤掉来源的「热门榜单兜底」结果，再排序
    const ranked = rankByRelevance(dedupeAndSort(merged), queries);
    const results = interleaveBySource(ranked.kept, limit);
    this.cache.clear();
    for (const r of results) this.cache.set(r.id, r);

    if (!results.length && ranked.dropped > 0) {
      errors.push({
        provider: 'all',
        label: '全部来源',
        message: `返回的 ${ranked.dropped} 条都不含关键词（多半是站点没这个内容、给了热门榜单兜底）`
      });
    }

    return {
      query: q,
      variants: queries,
      expandNote,
      results,
      errors,
      dropped: ranked.dropped,
      tookMs: Date.now() - started
    };
  }

  /**
   * 把一条搜索结果变成下载任务（执行层入口）。
   * 这里是发现层与执行层唯一的耦合点：只传一条链接。
   */
  async toTask(resultId, opts = {}) {
    const result = typeof resultId === 'string' ? this.cache.get(resultId) : resultId;
    if (!result) throw new Error('搜索结果已失效，请重新搜索');
    if (!this.manager) throw new Error('调度层未就绪');

    const link = result.magnet || result.torrentUrl;
    if (!link) throw new Error('这条结果没有可用链接');

    const task = await this.manager.add(link, opts);
    return { result, task };
  }
}

module.exports = { SearchGateway };
