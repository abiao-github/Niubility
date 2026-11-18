'use strict';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, tokenize } from '../store.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idx-')), 'index.jsonl.gz');
}

test('upsert 与去重', () => {
  const s = new Store({ file: tmpFile() });
  const created = s.upsert({ infohash: 'a'.repeat(40), name: 'Ubuntu 24.04 ISO', size: 100, peers: 1 });
  assert.equal(created, true);
  const again = s.upsert({ infohash: 'a'.repeat(40), peers: 2 });
  assert.equal(again, false);
  const e = s.map.get('a'.repeat(40));
  assert.equal(e.peers, 3);
  assert.equal(e.name, 'Ubuntu 24.04 ISO');
  assert.equal(s.size, 1);
});

test('非法 infohash 被拒绝', () => {
  const s = new Store({ file: tmpFile() });
  assert.equal(s.upsert({ infohash: 'xyz', name: 'x' }), false);
  assert.equal(s.upsert({ infohash: 'a'.repeat(39), name: 'x' }), false);
  assert.equal(s.size, 0);
});

test('搜索：多词与中文', () => {
  const s = new Store({ file: tmpFile() });
  s.upsert({ infohash: '1'.repeat(40), name: 'Ubuntu 24.04 Desktop amd64' });
  s.upsert({ infohash: '2'.repeat(40), name: '进击的巨人 剧场版 1080p' });
  s.upsert({ infohash: '3'.repeat(40), name: 'Debian 12 netinst' });

  assert.equal(s.search('ubuntu').length, 1);
  assert.equal(s.search('ubuntu desktop').length, 1);
  assert.equal(s.search('ubuntu server').length, 0);
  assert.equal(s.search('巨人').length, 1);
  assert.equal(s.search('进击 1080p').length, 1);
});

test('搜索只保留排序靠前的有限结果', () => {
  const s = new Store({ file: tmpFile() });
  s.upsert({ infohash: '1'.repeat(40), name: 'Ubuntu Desktop', peers: 1 });
  s.upsert({ infohash: '2'.repeat(40), name: 'Ubuntu Desktop', peers: 10 });
  s.upsert({ infohash: '3'.repeat(40), name: 'Ubuntu Desktop', peers: 5 });

  assert.equal(s.search('ubuntu', { limit: 1 })[0].infohash, '2'.repeat(40));
  assert.equal(s.search('ubuntu', { limit: 0 }).length, 0);
  assert.equal(s.search('ubuntu', { limit: 999 }).length, 3);
});

test('按 infohash 前缀搜索', () => {
  const s = new Store({ file: tmpFile() });
  s.upsert({ infohash: 'abcdef' + '0'.repeat(34), name: 'x' });
  assert.equal(s.search('abcdef').length, 1);
});

test('没名字的条目不出现在普通搜索里', () => {
  const s = new Store({ file: tmpFile() });
  s.touch('f'.repeat(40));
  assert.equal(s.search('anything').length, 0);
  assert.equal(s.search('f'.repeat(40)).length, 1);
});

test('落盘再读回', async () => {
  const file = tmpFile();
  const a = new Store({ file });
  a.upsert({ infohash: 'b'.repeat(40), name: 'Big Buck Bunny', size: 123, peers: 5 });
  a.upsert({ infohash: 'c'.repeat(40), name: 'Sintel', size: 456, peers: 2 });
  await a.save(true);

  const b = new Store({ file });
  const n = await b.load();
  assert.equal(n, 2);
  assert.equal(b.search('bunny').length, 1);
  assert.equal(b.search('bunny')[0].infohash, 'b'.repeat(40));
  assert.equal(b.search('sintel')[0].size, 456);
});

test('search 返回 magnet 与热度', () => {
  const s = new Store({ file: tmpFile() });
  s.upsert({ infohash: 'd'.repeat(40), name: 'hello world', peers: 7 });
  const [r] = s.search('hello');
  assert.equal(r.magnet, 'magnet:?xt=urn:btih:' + 'd'.repeat(40) + '&dn=hello%20world');
  assert.equal(r.peers, 7);
});

test('tokenize 切分中英混合', () => {
  const t = tokenize('Ubuntu-24.04 [x265] 进击的巨人');
  assert.ok(t.includes('ubuntu'));
  assert.ok(t.includes('24'));
  assert.ok(t.includes('x265'));
  assert.ok(t.includes('进击的巨人'));
});
