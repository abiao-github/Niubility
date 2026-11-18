'use strict';

// 用户自建的聚合服务（Jackett / Prowlarr）配置。
// 存在 userData/search-sources.json；没配就完全不注册 provider（界面上也就不出现）。

const fs = require('fs');
const path = require('path');
const { newId } = require('../net/util');
const jackett = require('./providers/jackett');
const prowlarr = require('./providers/prowlarr');
const dhtIndex = require('./providers/dht-index');

const TYPES = {
  jackett: { label: 'Jackett', hint: '通常是 http://127.0.0.1:9117', provider: jackett },
  prowlarr: { label: 'Prowlarr', hint: '通常是 http://127.0.0.1:9696', provider: prowlarr },
  // 自建 DHT 索引：地址是本机隧道口，Key 是服务端 INDEX_TOKEN
  'dht-index': { label: '自建 DHT 索引', hint: '通常是 http://127.0.0.1:8899', provider: dhtIndex }
};

function normalizeSource(input) {
  const type = String(input.type || '').toLowerCase();
  if (!TYPES[type]) throw new Error('类型只能是 jackett / prowlarr / dht-index');
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('地址必须以 http:// 或 https:// 开头');
  const apiKey = String(input.apiKey || '').trim();
  if (!apiKey) throw new Error('API Key 不能为空');
  return {
    id: input.id || newId(),
    type,
    label: String(input.label || '').trim() || TYPES[type].label,
    baseUrl,
    apiKey,
    indexerId: input.indexerId ? String(input.indexerId).trim() : null,
    enabled: input.enabled !== false
  };
}

class SourceStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.sources = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.sources;
      this.sources = (list || []).map((s) => normalizeSource(s)).filter(Boolean);
    } catch {
      this.sources = [];
    }
    return this.sources;
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, sources: this.sources }, null, 2), { mode: 0o600 });
    } catch (err) {
      throw new Error('保存搜索源失败: ' + err.message);
    }
  }

  /** 给 UI 用：永远不回传 apiKey 明文 */
  list() {
    return this.sources.map((s) => ({
      id: s.id,
      type: s.type,
      label: s.label,
      baseUrl: s.baseUrl,
      indexerId: s.indexerId,
      enabled: s.enabled,
      hasKey: !!s.apiKey,
      keyPreview: s.apiKey ? s.apiKey.slice(0, 3) + '***' : ''
    }));
  }

  save(input) {
    const next = normalizeSource(input);
    let idx = this.sources.findIndex((s) => s.id === next.id);
    // 没给 id 时，如果同类型已经存在，就覆盖它（provider id 按类型命名，多份会互相顶掉）
    if (idx < 0 && !input.id) idx = this.sources.findIndex((s) => s.type === next.type);
    // 覆盖时沿用原来的 id：否则界面上「移除」按钮会对不上，也容易重复插入
    if (idx >= 0 && !input.id) next.id = this.sources[idx].id;
    if (idx >= 0) this.sources[idx] = next;
    else this.sources.push(next);
    this.persist();
    return this.list();
  }

  remove(id) {
    this.sources = this.sources.filter((s) => s.id !== id);
    this.persist();
    return this.list();
  }

  enabled() {
    return this.sources.filter((s) => s.enabled);
  }

  /** 生成 provider 实例（每次配置变化后调用） */
  providers() {
    return this.enabled().map((s) => TYPES[s.type].provider.makeProvider(s));
  }

  types() {
    return Object.entries(TYPES).map(([id, t]) => ({ id, label: t.label, hint: t.hint }));
  }
}

module.exports = { SourceStore, normalizeSource, TYPES };
