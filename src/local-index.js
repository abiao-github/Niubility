'use strict';

// 本机自建索引：把 indexer/ 作为子进程跑起来（用 Electron 自带的 Node，无需另装运行时）。
// 用户勾选「在本机也跑一个索引」时启用；数据落在 userData 里。
//
// ⚠️ 前提：本机需要有可被外网连到的 UDP 端口（端口映射 / 公网 IP），
//    否则只能收到极少量 announce —— 这是 DHT 爬虫的固有要求，不是 bug。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const PORT = Number(process.env.NIUBILITY_LOCAL_INDEX_PORT) || 8898;
const DHT_PORT = Number(process.env.NIUBILITY_LOCAL_DHT_PORT) || 6881;
const WORKERS = 2; // 本机跑，别太激进

// 打包后 indexer/ 在 Contents/Resources/indexer（asar 内没法 spawn），开发时在仓库里
function resolveIndexerDir() {
  const { app } = require('electron');
  if (app.isPackaged) return path.join(process.resourcesPath, 'indexer');
  return path.join(__dirname, '..', 'indexer');
}

class LocalIndex {
  constructor({ userDataDir, indexerDir, log = () => {} }) {
    this.dir = path.join(userDataDir, 'local-index');
    this.indexerDir = indexerDir;
    this.configFile = path.join(userDataDir, 'local-index.json');
    this.log = log;
    this.child = null;
    this.token = null;
    this.enabled = false;
    this.lastError = null;
    this.port = PORT;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      this.enabled = !!raw.enabled;
      this.token = raw.token || null;
    } catch {
      this.enabled = false;
      this.token = null;
    }
    if (!this.token) this.token = crypto.randomBytes(18).toString('base64url');
    return this.enabled;
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify({ enabled: this.enabled, token: this.token }, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log('[local-index] 保存配置失败: ' + err.message);
    }
  }

  url() {
    return 'http://127.0.0.1:' + PORT;
  }

  async start() {
    if (this.child) return { ok: true, already: true };
    fs.mkdirSync(this.dir, { recursive: true });
    const entry = path.join(this.indexerDir, 'run.js');
    if (!fs.existsSync(entry)) return { ok: false, error: '索引服务代码缺失：' + entry };

    const env = {
      ...process.env,
      // 用 Electron 自己的二进制当 node 跑子进程，避免依赖用户机器上的 node
      ELECTRON_RUN_AS_NODE: '1',
      INDEX_PORT: String(PORT),
      INDEX_HOST: '127.0.0.1',
      INDEX_TOKEN: this.token,
      DHT_PORT: String(DHT_PORT),
      DHT_WORKERS: String(WORKERS),
      INDEX_DB: path.join(this.dir, 'index.jsonl.gz'),
      INDEX_MAX_FETCHING: '4'
    };

    this.log('[local-index] 启动 ' + entry);
    this.child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => this.log('[local-index] ' + String(d).trim()));
    this.child.stderr.on('data', (d) => this.log('[local-index:err] ' + String(d).trim()));
    this.child.on('exit', (code, signal) => {
      this.log(`[local-index] 退出 code=${code} signal=${signal}`);
      this.child = null;
    });

    // 等它真的能响应
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const health = await this.health();
      if (health) return { ok: true, port: PORT };
    }
    return { ok: false, error: '索引服务启动超时' };
  }

  async stop() {
    if (!this.child) return { ok: true };
    const child = this.child;
    this.child = null;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 500));
    try { if (!child.killed) child.kill('SIGKILL'); } catch { /* ignore */ }
    return { ok: true };
  }

  request(pathname, timeout = 4000) {
    return new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        headers: { Authorization: 'Bearer ' + this.token }
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      });
      req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  async health() {
    const h = await this.request('/health');
    return h && h.ok ? h : null;
  }

  async status() {
    const running = !!this.child;
    let stats = null;
    if (running) stats = await this.request('/stats');
    return {
      enabled: this.enabled,
      running,
      port: PORT,
      url: this.url(),
      token: this.token,
      stats: stats && stats.store ? stats.store : null,
      crawler: stats && stats.crawler ? stats.crawler : null,
      lastError: this.lastError
    };
  }
}

module.exports = { LocalIndex, LOCAL_INDEX_PORT: PORT, resolveIndexerDir };
