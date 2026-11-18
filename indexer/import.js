#!/usr/bin/env node
'use strict';

// 把公开的种子元数据导入索引库。
// 用法：INDEX_DB=/path/index.jsonl.gz node import.js <文件或 URL>...
// 支持三种行格式（以 .tsv / .jsonl / .csv 结尾自动识别，URL 也一样）：
//   CSV   ：infohash,name,size_bytes,created_unix,seeders,…   （torrents-csv，含做种数）
//   TSV   ：infohash \t 文件数 \t 大小(MB) \t 名称         （wangroot/dhtdump 的格式）
//   JSONL ：{"infohash":"…","name":"…","size":字节,"files":数量}
// 注意：导入时请不要让索引服务同时写同一个库文件（服务会在下次保存时覆盖）。

import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Store } from './store.js';

const MB = 1024 * 1024;

function openSource(src, redirects = 5) {
  if (!/^https:\/\//.test(src)) return Promise.resolve(fs.createReadStream(src));
  return new Promise((resolve, reject) => {
    // family: 4 —— 部分服务器没有可用的 IPv6，会导致连接失败
    https.get(src, { family: 4 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(openSource(new URL(res.headers.location, src).toString(), redirects - 1));
      } else if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`${src} → HTTP ${res.statusCode}`));
      } else resolve(res);
    }).on('error', reject);
  });
}

// 解析一行 CSV（支持双引号字段与 "" 转义）
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseLine(line, format) {
  if (format === 'csv') {
    // torrents-csv：infohash,name,size_bytes,created_unix,seeders,leechers,completed,...
    const f = splitCsv(line);
    if (f[0] === 'infohash') throw new Error('header');
    return { infohash: f[0].trim().toLowerCase(), name: (f[1] || '').trim(), size: parseInt(f[2], 10) || 0, peers: Math.max(1, parseInt(f[4], 10) || 0) };
  }
  if (format === 'jsonl') {
    const e = JSON.parse(line);
    return { infohash: String(e.infohash || '').toLowerCase(), name: e.name, size: e.size, files: e.files };
  }
  if (format === 'tpb') {
    // thepiratebay / rutracker 备份：时间;infohash(base64);名称;大小(字节)
    const m = /^[^;]*;([^;]+);(.*);(\d+)\s*$/.exec(line);
    if (!m) throw new Error('bad');
    const hash = Buffer.from(m[1], 'base64');
    if (hash.length !== 20) throw new Error('bad');
    let name = m[2].trim();
    if (name.length > 1 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/""/g, '"');
    return { infohash: hash.toString('hex'), name, size: parseInt(m[3], 10) || 0 };
  }
  const [hash, files, sizeMb, ...rest] = line.split('\t');
  return {
    infohash: hash.trim().toLowerCase(),
    files: parseInt(files, 10) || 0,
    size: Math.round((parseFloat(sizeMb) || 0) * MB),
    name: rest.join('\t').trim()
  };
}

// 已有条目：只补全缺失字段，热度取较大值（重复导入不会让热度虚增）
function merge(store, e) {
  const prev = store.map.get(e.infohash);
  if (!prev) return store.upsert(e) ? 'added' : 'skip';
  let changed = false;
  if (e.name && !prev.name) { prev.name = e.name; changed = true; }
  if (e.size && !prev.size) { prev.size = e.size; changed = true; }
  if (e.files && !prev.files) { prev.files = e.files; changed = true; }
  if (e.peers && e.peers > (prev.peers || 0)) { prev.peers = e.peers; changed = true; }
  if (changed) store.dirty = true;
  return changed ? 'merged' : 'skip';
}

export async function importInto(store, src, log = () => {}) {
  let format = /\.jsonl(\?|$)/.test(src) ? 'jsonl' : /\.csv(\?|$)/.test(src) ? 'csv' : 'tsv';
  const rl = readline.createInterface({ input: await openSource(src), crlfDelay: Infinity });
  let added = 0;
  let named = 0;
  let bad = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (line.startsWith('#ADDED;')) { format = 'tpb'; continue; }
    if (line.startsWith('#')) continue;
    let e;
    try { e = parseLine(line, format); } catch (err) { if (err.message !== 'header') bad += 1; continue; }
    if (!e.name || !/^[0-9a-f]{40}$/.test(e.infohash)) { bad += 1; continue; }
    const hadName = !!(store.map.get(e.infohash) || {}).name;
    const r = merge(store, e);
    if (r === 'added') added += 1;
    else if (r === 'merged' && !hadName) named += 1;
  }
  log(`[import] ${src}：新增 ${added}，补全名称 ${named}，跳过 ${bad}`);
  return { added, named, bad };
}

// 带重试的批量导入（GitHub raw 偶尔会 503 限流）
export async function importAll(store, sources, log = () => {}) {
  const total = { added: 0, named: 0, bad: 0, failed: 0 };
  for (const src of sources) {
    let ok = false;
    for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
      try {
        const r = await importInto(store, src, log);
        total.added += r.added; total.named += r.named; total.bad += r.bad;
        ok = true;
      } catch (err) {
        log(`[import] ${src} 失败（第 ${attempt} 次）：${err.message || err.code || err}`);
        await new Promise((r) => setTimeout(r, attempt * 3000));
      }
    }
    if (!ok) total.failed += 1;
  }
  return total;
}

// 读取来源清单：每行一个文件或 URL，# 开头为注释；{hex2} 会展开成 00..ff
export function readSources(file) {
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.includes('{hex2}')) {
      for (let i = 0; i < 256; i++) out.push(line.replace('{hex2}', i.toString(16).padStart(2, '0')));
    } else out.push(line);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('用法：INDEX_DB=… node import.js <文件或 URL>...   或   node import.js --list sources.txt');
    process.exit(2);
  }
  const sources = args[0] === '--list' ? readSources(args[1]) : args;
  const file = process.env.INDEX_DB || path.join(os.homedir(), 'niubility-index', 'index.jsonl.gz');
  const log = (m) => console.log(new Date().toISOString(), m);
  const store = new Store({ file, log });
  await store.load();
  await importAll(store, sources, log);
  await store.save(true);
  log(`[import] 完成，共 ${store.size} 条，其中有名称 ${store.stats().named}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
