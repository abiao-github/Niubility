'use strict';

// 索引服务入口：DHT 爬虫 + HTTP 查询接口
// 环境变量：INDEX_PORT(8899) INDEX_HOST(127.0.0.1) INDEX_TOKEN DHT_PORT(6881)
//          INDEX_DB(~/niubility-index/index.jsonl.gz) INDEX_MAX_FETCHING(16)
//          DHT_WORKERS(4) DHT_RCVBUF(8388608)

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.js';
import { Crawler } from './crawler.js';
import { createServer } from './server.js';
import { startUpdater } from './updater.js';

const PORT = Number(process.env.INDEX_PORT) || 8899;
const HOST = process.env.INDEX_HOST || '127.0.0.1';
const TOKEN = process.env.INDEX_TOKEN || '';
const DHT_PORT = Number(process.env.DHT_PORT) || 6881;
const DHT_WORKERS = Math.max(1, Math.min(Number(process.env.DHT_WORKERS) || 4, 16));
const DB = process.env.INDEX_DB || path.join(os.homedir(), 'niubility-index', 'index.jsonl.gz');

process.on('uncaughtException', (err) => {
  process.stdout.write(new Date().toISOString() + ' [run] 未捕获异常: ' + (err && err.stack || err) + '\n');
});
process.on('unhandledRejection', (err) => {
  process.stdout.write(new Date().toISOString() + ' [run] 未处理的 Promise 拒绝: ' + (err && err.stack || err) + '\n');
});

function log(...args) {
  process.stdout.write(new Date().toISOString() + ' ' + args.join(' ') + '\n');
}

(async () => {
  if (!TOKEN) throw new Error('INDEX_TOKEN 必须设置为非空随机值');
  const store = new Store({ file: DB, log });
  await store.load();

  // 同时跑多个 DHT 节点：每个节点有自己的路由表和 ID，能覆盖到不同的 announce 流
  // 节点 ID 的前两个字节均匀铺开，各节点负责不同区段的 announce 流
  const crawlers = [];
  for (let i = 0; i < DHT_WORKERS; i++) {
    const nodeId = crypto.randomBytes(20);
    nodeId.writeUInt16BE(Math.floor((i * 65536) / DHT_WORKERS), 0);
    const c = new Crawler({
      store,
      port: DHT_PORT + i,
      nodeId,
      recvBufferBytes: Number(process.env.DHT_RCVBUF) || 8 * 1024 * 1024,
      maxFetching: Number(process.env.INDEX_MAX_FETCHING) || 16,
      log: (msg) => log(msg.replace('[crawler]', `[crawler#${i}]`))
    });
    c.start();
    crawlers.push(c);
  }
  log(`[run] 启动了 ${DHT_WORKERS} 个 DHT 节点（UDP ${DHT_PORT}-${DHT_PORT + DHT_WORKERS - 1}）`);

  const crawler = {
    statsSnapshot() {
      const out = { announces: 0, queries: 0, fetched: 0, failed: 0, noPeer: 0, queue: 0, hotQueue: 0, fetching: 0, failedTotal: 0, lookups: 0, lookupHit: 0, nodes: crawlers.length, failStages: {}, failures: [] };
      for (const c of crawlers) {
        const s = c.statsSnapshot();
        for (const k of ['announces', 'queries', 'fetched', 'failed', 'noPeer', 'queue', 'hotQueue', 'fetching', 'failedTotal', 'lookups', 'lookupHit']) out[k] += s[k] || 0;
        for (const [k, v] of Object.entries(s.failStages || {})) out.failStages[k] = (out.failStages[k] || 0) + v;
        if (Array.isArray(s.failures)) out.failures.push(...s.failures);
        if (s.debug) {
          out.debug = out.debug || { enqueue: 0, queued: 0, skipNamed: 0, skipDup: 0, skipFail: 0, skipNoHex: 0, samples: [] };
          for (const k of ['enqueue', 'queued', 'skipNamed', 'skipDup', 'skipFail', 'skipNoHex']) out.debug[k] += s.debug[k] || 0;
          if (out.debug.samples.length < 5) out.debug.samples.push(...(s.debug.samples || []));
        }
        out.uptimeSec = Math.max(out.uptimeSec || 0, s.uptimeSec);
      }
      out.failures = out.failures.slice(-8);
      return out;
    },
    async stop() { for (const c of crawlers) await c.stop().catch(() => {}); }
  };

  const server = createServer({ store, crawler, token: TOKEN, log });
  server.listen(PORT, HOST, () => log(`[server] http://${HOST}:${PORT} 就绪（token=${TOKEN ? '已设置' : '未设置！'}）`));

  const saveTimer = setInterval(() => store.save().catch(() => {}), 60000);

  // 定期导入公开来源（INDEX_SOURCES 清单；INDEX_IMPORT_DAYS=0 关闭）
  const importDays = process.env.INDEX_IMPORT_DAYS === undefined ? 7 : Number(process.env.INDEX_IMPORT_DAYS);
  const stopUpdater = importDays > 0 ? startUpdater({
    store,
    log,
    sourcesFile: process.env.INDEX_SOURCES || new URL('./sources.txt', import.meta.url).pathname,
    stateFile: DB + '.import-state.json',
    intervalDays: importDays
  }) : () => {};

  const shutdown = async () => {
    log('[run] 退出中，保存索引…');
    clearInterval(saveTimer);
    stopUpdater();
    await store.save(true).catch(() => {});
    server.close();
    await crawler.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((err) => {
  process.stderr.write('FATAL ' + (err && err.stack || err) + '\n');
  process.exit(1);
});
