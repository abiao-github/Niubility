// 任务持久化：写入 → 新实例 restore → 任务还在，且完成态不会重新下载
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/main.js');
const { TaskManager } = require('../src/tasks');

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-persist-'));
  const state = path.join(dir, 'tasks.json');
  const torrentCache = path.join(dir, 'torrents');
  const dlDir = path.join(dir, 'dl');

  // 造一个已完成的任务记录
  fs.mkdirSync(dlDir, { recursive: true });
  const doneFile = path.join(dlDir, 'done.bin');
  fs.writeFileSync(doneFile, Buffer.alloc(2048, 7));

  const m1 = new TaskManager({ dir: dlDir, statePath: state, torrentCacheDir: torrentCache, onUpdate: () => {}, onError: () => {} });
  m1.tasks.set('done1', {
    id: 'done1', kind: 'http', name: 'done.bin', source: 'http://example.com/done.bin',
    savePath: doneFile, total: 2048, downloaded: 2048, state: 'done', job: null, speed: 0
  });
  m1.saveNow();
  const savedOk = fs.existsSync(state);
  console.log('SAVED', savedOk, fs.statSync(state).size + 'B');

  // 新实例恢复
  const seen = [];
  const m2 = new TaskManager({ dir: dlDir, statePath: state, torrentCacheDir: torrentCache, onUpdate: (t) => seen.push(t), onError: () => {} });
  const r = await m2.restore();
  const task = m2.get('done1');
  console.log('RESTORE', JSON.stringify(r), '| task', task ? `${task.name} ${task.state} ${task.downloaded}` : 'missing');
  console.log('EVENTS', seen.length);

  // ---- BT 任务：加一个磁力 → 保存 → 新实例恢复（应命中本地 .torrent 缓存）----
  const { makeFixture } = require('./fixture');
  const fixture = makeFixture();
  // 加一个大文件，保证"还没下完就暂停"的场景可复现
  fs.writeFileSync(path.join(fixture.dir, 'huge.bin'), Buffer.alloc(24 * 1024 * 1024, 9));
  const mod = await import('webtorrent');
  const W = mod.default || mod;
  const seeder = new W({ maxConns: 8, dht: false, utp: false });
  if (seeder.throttleUpload) seeder.throttleUpload(120 * 1024);   // 限速，制造"没下完"的中间状态
  await new Promise((res) => seeder.once('listening', res));
  const st = await new Promise((res) => seeder.seed(fixture.dir, { announce: [] }, res));

  const btDir = path.join(dir, 'dl2');
  const m3 = new TaskManager({ dir: btDir, statePath: path.join(dir, 't2.json'), torrentCacheDir: torrentCache, onUpdate: () => {}, onError: () => {} });
  const btTask = await m3.add(`magnet:?xt=urn:btih:${st.infoHash}`);
  const btId = btTask.id;
  // 等元数据就绪（这样 .torrent 缓存才写得进去）
  for (let i = 0; i < 30; i++) {
    if (btTask.job && btTask.job.torrent && btTask.job.torrent.ready) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 500));
  m3.pause(btId);
  m3.saveNow();
  const cached = fs.existsSync(path.join(torrentCache, `${btId}.torrent`));
  console.log('BT', btId.slice(0, 10), '| cache', cached);

  const m4 = new TaskManager({ dir: btDir, statePath: path.join(dir, 't2.json'), torrentCacheDir: torrentCache, onUpdate: () => {}, onError: () => {} });
  const r2 = await m4.restore();
  const bt2 = m4.get(btId);
  console.log('BT_RESTORE', JSON.stringify(r2), '| state', bt2 && bt2.state,
    '| files', bt2 && bt2.job && bt2.job.torrent ? bt2.job.torrent.files.length : 0);

  // 恢复后应保持暂停，且分片信息完整（说明是用缓存的 .torrent 恢复的）
  const pausedOk = !!bt2 && bt2.state === 'paused' && !!(bt2.job && bt2.job.torrent && bt2.job.torrent.files.length);
  console.log('PAUSED_OK', pausedOk);

  const ok = savedOk && r.restored === 1 && task && task.state === 'done' && task.downloaded === 2048
    && cached && bt2 && pausedOk;
  console.log(ok ? 'E2E_PERSIST_PASS' : 'E2E_PERSIST_FAIL');
  m1.timer && clearInterval(m1.timer); m2.timer && clearInterval(m2.timer);
  m3.timer && clearInterval(m3.timer); m4.timer && clearInterval(m4.timer);
  seeder.destroy(() => {});
  app.exit(0);
}).catch((e) => { console.error('FATAL', e && e.stack || e); app.exit(1); });
