'use strict';

// 索引的 HTTP 接口，只监听回环，靠 SSH 隧道给客户端用。
//   GET /search?q=&limit=   → 结果（带 magnet）
//   GET /stats              → 抓取/索引概况
//   GET /health             → 存活检查
// 鉴权：Authorization: Bearer <token>

import http from 'node:http';

function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function createServer({ store, crawler, token, log = () => {} }) {
  if (!token) throw new Error('INDEX_TOKEN 必须配置');
  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (given !== token) return send(res, 401, { error: 'unauthorized' });

    if (url.pathname === '/health') return send(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
    if (url.pathname === '/stats') {
      return send(res, 200, { store: store.stats(), crawler: crawler ? crawler.statsSnapshot() : null, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
    }
    if (url.pathname === '/search') {
      const q = (url.searchParams.get('q') || '').trim();
      const limit = Math.min(Number(url.searchParams.get('limit')) || 40, 200);
      if (!q) return send(res, 400, { error: 'q 不能为空' });
      const t0 = Date.now();
      const results = store.search(q, { limit });
      return send(res, 200, { query: q, tookMs: Date.now() - t0, total: store.size, results });
    }
    return send(res, 404, { error: 'not found' });
  });
  server.on('error', (err) => log('[server] ' + err.message));
  return server;
}

export { createServer };
