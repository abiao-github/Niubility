'use strict';

// 查询扩展：中文词自动翻成英文（或英文翻成中文），让搜索结果跨语言命中。
//
// 实现说明：
//   · 翻译走 MyMemory 的免费接口（Google gtx 在本网络被挡）；失败就退回只搜原词。
//   · 结果缓存到内存 + userData/translate-cache.json，避免重复请求、也不浪费免费额度。
//   · 纯"扩展"，不改写用户输入：原词始终会搜，翻译只是额外的候选。

const fs = require('fs');
const path = require('path');
const { fetchBuffer } = require('../net/http');

const ENDPOINT = 'https://api.mymemory.translated.net/get';
const MAX_CACHE = 500;

let memory = new Map();
let cacheFile = null;
let saveTimer = null;

function hasCJK(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''));
}

function init({ userDataDir } = {}) {
  if (!userDataDir) return;
  cacheFile = path.join(userDataDir, 'translate-cache.json');
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    for (const [k, v] of Object.entries(raw || {})) memory.set(k, v);
  } catch { /* 首次运行没有缓存 */ }
}

function scheduleSave() {
  if (!cacheFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const obj = {};
      let n = 0;
      for (const [k, v] of memory) { obj[k] = v; if (++n >= MAX_CACHE) break; }
      fs.promises.mkdir(path.dirname(cacheFile), { recursive: true }).then(() => {
        fs.promises.writeFile(cacheFile, JSON.stringify(obj), { mode: 0o600 }).catch(() => {});
      });
    } catch { /* 缓存写失败不影响搜索 */ }
  }, 2000);
  if (saveTimer.unref) saveTimer.unref();
}

/**
 * 翻译一段文本。失败返回 null（调用方退回原词）。
 * @param {string} text
 * @param {'en'|'zh-CN'} target
 */
async function translate(text, target, { signal, timeout = 6000 } = {}) {
  const q = String(text || '').trim();
  if (!q) return null;
  const key = target + '|' + q.toLowerCase();
  if (memory.has(key)) return memory.get(key);

  const langpair = target === 'en' ? 'zh-CN|en' : 'en|zh-CN';
  const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(langpair)}`;
  try {
    const { buffer } = await fetchBuffer(url, { signal, timeout });
    const data = JSON.parse(buffer.toString('utf8'));
    const out = data && data.responseData && data.responseData.translatedText;
    if (!out || typeof out !== 'string') return null;
    const cleaned = out.trim();
    // MyMemory 偶尔会回显原文或返回超长解释，过滤掉没意义的结果
    if (!cleaned || cleaned.toLowerCase() === q.toLowerCase()) return null;
    if (cleaned.length > 120) return null;
    memory.set(key, cleaned);
    scheduleSave();
    return cleaned;
  } catch {
    return null;
  }
}

/**
 * 生成查询变体。
 * @returns {Promise<{variants: string[], note: string|null}>}
 */
async function expandQuery(query, opts = {}) {
  const q = String(query || '').trim();
  if (!opts.enabled || !q) return { variants: [q], note: null };

  const target = hasCJK(q) ? 'en' : 'zh-CN';
  const translated = await translate(q, target, opts);
  const variants = [q];
  if (translated && translated.toLowerCase() !== q.toLowerCase()) variants.push(translated);

  return {
    variants,
    note: translated ? `${q} ↔ ${translated}` : null
  };
}

function clearCache() {
  memory = new Map();
}

module.exports = { expandQuery, translate, init, hasCJK, clearCache };
