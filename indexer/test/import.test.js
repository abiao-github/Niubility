import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.js';
import { importInto, readSources } from '../import.js';

test('导入 dhtdump TSV 与 JSONL，并给已有的无名条目补名称', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  const h1 = '0'.repeat(39) + '1';
  const h2 = '0'.repeat(39) + '2';
  const h3 = '0'.repeat(39) + '3';
  const tsv = path.join(dir, 'a.tsv');
  fs.writeFileSync(tsv, `${h1}\t     3\t     2\tUbuntu 24.04 ISO\nbadline\n${h2}\t 1\t 1\t\n`);
  const jsonl = path.join(dir, 'b.jsonl');
  fs.writeFileSync(jsonl, JSON.stringify({ infohash: h3.toUpperCase(), name: '中文 资源', size: 5, files: 1 }) + '\n');

  const store = new Store({ file: path.join(dir, 'db.gz') });
  store.upsert({ infohash: h1 });
  const r1 = await importInto(store, tsv);
  assert.deepEqual([r1.added, r1.named, r1.bad], [0, 1, 2]);
  assert.equal(store.map.get(h1).name, 'Ubuntu 24.04 ISO');
  assert.equal(store.map.get(h1).size, 2 * 1024 * 1024);
  await importInto(store, jsonl);
  assert.equal(store.map.get(h3).name, '中文 资源');

  const h4 = '0'.repeat(39) + '4';
  const csv = path.join(dir, 'c.csv');
  fs.writeFileSync(csv, `infohash,name,size_bytes,created_unix,seeders\n${h4},"Show, ""Pilot"" 1080p",100,1,7\n`);
  await importInto(store, csv);
  assert.equal(store.map.get(h4).name, 'Show, "Pilot" 1080p');
  assert.equal(store.map.get(h4).peers, 7);
  fs.rmSync(dir, { recursive: true });
});

test('TPB/rutracker 备份（base64 哈希、名称含分号）与重复导入不虚增热度', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  const hex = '00112233445566778899aabbccddeeff00112233';
  const b64 = Buffer.from(hex, 'hex').toString('base64');
  const f = path.join(dir, 'tpb.csv');
  fs.writeFileSync(f, `#ADDED;HASH(B64);NAME;SIZE(BYTES)\r\n2015-Oct-27 04:10:22;${b64};"A; ""B"" 1080p";42\r\n`);
  const store = new Store({ file: path.join(dir, 'db.gz') });
  await importInto(store, f);
  await importInto(store, f);
  const e = store.map.get(hex);
  assert.equal(e.name, 'A; "B" 1080p');
  assert.equal(e.size, 42);
  assert.equal(e.peers, 1);
  fs.rmSync(dir, { recursive: true });
});

test('来源清单展开 {hex2} 并忽略注释', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  const f = path.join(dir, 's.txt');
  fs.writeFileSync(f, '# c\nhttps://x/a.csv\nhttps://x/h-{hex2}.tsv\n');
  const s = readSources(f);
  assert.equal(s.length, 257);
  assert.equal(s[256], 'https://x/h-ff.tsv');
  fs.rmSync(dir, { recursive: true });
});
