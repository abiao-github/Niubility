'use strict';

// Prowlarr 源健康巡检：隔一段时间自动测速，把"卡死/超时"的源剔除。
//
// 为什么需要：Prowlarr 的聚合搜索要等所有源返回，一个卡 50 秒的源就能把整次搜索
// 拖过应用的超时宽限，结果就是"所有源都没结果"。实测过：Bangumi Moe 卡 50s →
// 聚合 21.8s → 应用 20s 宽限直接丢弃整批 Prowlarr 结果。
//
// 策略：
//   · 应用启动 90 秒后跑第一次，之后每 3 小时一次
//   · 逐个 POST /api/v1/indexer/test（顺带清掉 Prowlarr 的失败冷却）
//   · 单个源 >15s 或测试失败 = 慢源，连续 2 轮才处理
//   · 处理方式默认是「停用」而不是删除（可手动恢复），至少保留 3 个可用源

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  firstDelayMs: 90_000,
  intervalMs: 3 * 60 * 60 * 1000,
  slowMs: 15_000,
  testTimeoutMs: 25_000,
  strikesToAct: 2,
  minEnabled: 3,
  dryRun: false
};

class IndexerMonitor {
  constructor({ getSource, userDataDir, log = () => {}, options = {} }) {
    this.getSource = getSource;
    this.log = log;
    this.opts = { ...DEFAULTS, ...options };
    this.stateFile = path.join(userDataDir, 'indexer-health.json');
    this.state = this.loadState();
    this.timer = null;
    this.running = false;
    this.lastReport = this.state.lastReport || null;
  }

  loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return { strikes: raw.strikes || {}, lastReport: raw.lastReport || null, disabled: raw.disabled || {} };
    } catch {
      return { strikes: {}, lastReport: null, disabled: {} };
    }
  }

  saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch { /* 状态写失败不影响巡检 */ }
  }

  start() {
    if (this.timer) return;
    const tick = () => { this.checkOnce().catch((e) => this.log('巡检失败: ' + (e.message || e))); };
    setTimeout(tick, this.opts.firstDelayMs).unref?.();
    this.timer = setInterval(tick, this.opts.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.log(`源健康巡检已启动（首次 ${Math.round(this.opts.firstDelayMs / 1000)}s 后，之后每 ${Math.round(this.opts.intervalMs / 3600000)} 小时）`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  static async request(baseUrl, apiKey, apiPath, { method = 'GET', body, timeout = 20000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(baseUrl.replace(/\/+$/, '') + apiPath, {
        method,
        headers: {
          'X-Api-Key': apiKey,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { ok: res.ok, status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  async checkOnce() {
    if (this.running) return this.lastReport;
    const source = this.getSource && this.getSource();
    if (!source || !source.baseUrl || !source.apiKey) {
      return null; // 没配 Prowlarr，跳过
    }
    this.running = true;
    const startedAt = Date.now();
    const results = [];
    const acted = [];
    try {
      const list = await IndexerMonitor.request(source.baseUrl, source.apiKey, '/api/v1/indexer', { timeout: 15000 });
      if (!list.ok || !Array.isArray(list.data)) throw new Error(`读取源列表失败 (${list.status})`);

      const enabled = list.data.filter((x) => x.enable !== false);
      let enabledLeft = enabled.length;

      for (const ix of enabled) {
        const t0 = Date.now();
        let ok = false;
        let error = '';
        try {
          const res = await IndexerMonitor.request(source.baseUrl, source.apiKey, '/api/v1/indexer/test', {
            method: 'POST',
            body: ix,
            timeout: this.opts.testTimeoutMs
          });
          ok = res.ok;
          if (!ok) error = (res.data && (res.data.message || res.data.description)) || `HTTP ${res.status}`;
        } catch (err) {
          error = (err && err.name === 'AbortError') ? '超时' : ((err && err.message) || String(err));
        }
        const ms = Date.now() - t0;
        const slow = !ok || ms > this.opts.slowMs;

        if (slow) this.state.strikes[ix.id] = (this.state.strikes[ix.id] || 0) + 1;
        else this.state.strikes[ix.id] = 0;

        results.push({ id: ix.id, name: ix.name, ms: slow && !ok ? null : ms, ok, slow, error: error.slice(0, 120), strikes: this.state.strikes[ix.id] });

        // 连续 N 轮都慢 → 停用（保留至少 minEnabled 个）
        if (this.state.strikes[ix.id] >= this.opts.strikesToAct && enabledLeft > this.opts.minEnabled && !this.opts.dryRun) {
          const body = { ...ix, enable: false };
          const res = await IndexerMonitor.request(source.baseUrl, source.apiKey, `/api/v1/indexer/${ix.id}`, {
            method: 'PUT',
            body,
            timeout: 15000
          });
          if (res.ok || res.status === 202) {
            enabledLeft -= 1;
            this.state.disabled[ix.id] = { name: ix.name, at: new Date().toISOString(), reason: error || `耗时 ${ms}ms` };
            acted.push({ id: ix.id, name: ix.name, reason: error || `${Math.round(ms / 1000)}s` });
            this.log(`已停用慢源: ${ix.name}（${error || Math.round(ms / 1000) + 's'}）`);
          }
        }
      }

      const report = {
        at: new Date().toISOString(),
        tookMs: Date.now() - startedAt,
        checked: results.length,
        slow: results.filter((r) => r.slow).length,
        disabled: acted,
        results
      };
      this.state.lastReport = report;
      this.lastReport = report;
      this.saveState();
      this.log(`源体检完成: ${report.checked} 个，慢 ${report.slow} 个，停用 ${acted.length} 个，用时 ${Math.round(report.tookMs / 1000)}s`);
      return report;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { IndexerMonitor };
