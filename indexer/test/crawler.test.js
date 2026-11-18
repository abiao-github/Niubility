import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Crawler, fetchMetadataFromPeer } from '../crawler.js';

const HEX_A = 'a'.repeat(40);
const HEX_B = 'b'.repeat(40);
const HEX_C = 'c'.repeat(40);

function makeCrawler() {
  const map = new Map();
  const store = { map, touch() {}, upsert() {} };
  return new Crawler({ store });
}

test('带来源 peer 的哈希排在没有来源的前面', () => {
  const c = makeCrawler();
  c.enqueue(HEX_A, null, null);
  c.enqueue(HEX_B, '1.2.3.4', 6881);
  assert.equal(c.next().hex, HEX_B);
  assert.equal(c.next().hex, HEX_A);
});

test('没有来源 peer 的队列有上限，丢弃最旧的', () => {
  const c = makeCrawler();
  for (let i = 0; i < 5200; i++) c.enqueue(i.toString(16).padStart(40, '0'), null, null);
  assert.equal(c.queue.length, 5000);
  assert.equal(c.queued.size, 5000);
});

test('失败记录会过期，允许重试', () => {
  const c = makeCrawler();
  c.markFailed(HEX_C);
  assert.equal(c.isFailed(HEX_C), true);
  c.failed.set(HEX_C, Date.now() - 7 * 3600 * 1000);
  assert.equal(c.isFailed(HEX_C), false);
});

test('连不上的 peer 会在连接超时内失败并标明阶段', async () => {
  // 监听后立刻不 accept 不够可靠；用一个已关闭的端口得到 ECONNREFUSED
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  await assert.rejects(
    fetchMetadataFromPeer(HEX_A, '127.0.0.1', port, 3000),
    (err) => err.stage === 'connect'
  );
});

test('取消信号会立刻终止抓取', async () => {
  const server = net.createServer((sock) => { sock.on('error', () => {}); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const ac = new AbortController();
  const p = fetchMetadataFromPeer(HEX_A, '127.0.0.1', port, 10000, { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, /aborted/);
  server.close();
});
