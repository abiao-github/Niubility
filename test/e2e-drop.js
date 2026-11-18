// 拖拽添加的自动化验证：直接走 IPC（真实拖拽事件的 DataTransfer 无法在 headless 里构造）
// 校验：task:add-paths 能加 .torrent；task:add-filedata 能落盘再加
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/main.js');
const { makeFixture } = require('./fixture');

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const ev = (c) => win.webContents.executeJavaScript(c, true);
  const fixture = makeFixture();

  // 先用 webtorrent 生成一个真实的 .torrent 文件
  const mod = await import('webtorrent');
  const W = mod.default || mod;
  const seeder = new W({ maxConns: 6, dht: false, utp: false });
  await new Promise((r) => seeder.once('listening', r));
  const st = await new Promise((r) => seeder.seed(fixture.dir, { announce: [] }, r));
  const torrentPath = path.join(os.tmpdir(), `mt-drop-${Date.now()}.torrent`);
  fs.writeFileSync(torrentPath, st.torrentFile);

  const r1 = await ev(`window.api.addPaths(${JSON.stringify([torrentPath])})`);
  const okPath = r1 && r1.added && r1.added.length === 1;
  console.log('ADD_PATHS', okPath ? 'ok' : 'fail', JSON.stringify(r1 && r1.failed));

  // 落在同一路径再加一次：应被识别为"已在列表里"，而不是报解析失败
  const r1b = await ev(`window.api.addPaths(${JSON.stringify([torrentPath])})`);
  // 现在重复添加不再报错，而是复用已有任务（added 里还是同一个 id）
  const dupHandled = !!(r1b && r1b.added && r1b.added.length === 1 && r1b.added[0].id === r1.added[0].id);
  console.log('DUPLICATE', dupHandled ? 'handled' : JSON.stringify(r1b && r1b.failed));

  // 拿不到路径时的兜底：把内容当作 ArrayBuffer 传过去（换一个种子避免重复）
  const fixture2 = makeFixture();
  fs.writeFileSync(path.join(fixture2.dir, 'unique-' + Date.now() + '.txt'), String(Math.random()));
  const st2 = await new Promise((r) => seeder.seed(fixture2.dir, { announce: [] }, r));
  const buf = Buffer.from(st2.torrentFile);
  const r2 = await ev(`(async () => {
    const arr = Uint8Array.from(${JSON.stringify(Array.from(buf))});
    const task = await window.api.addFileData('drop-test.torrent', arr.buffer);
    return task && task.id ? 'ok' : 'fail';
  })()`);
  console.log('ADD_FILEDATA', r2);

  const snap = await ev(`window.api.snapshot().then(l => l.length)`);
  console.log('TASKS', snap);

  const overlay = await ev(`(() => {
    const el = document.getElementById('drop-overlay');
    return el ? 'present' : 'missing';
  })()`);
  console.log('OVERLAY', overlay);

  console.log(okPath && dupHandled && r2 === 'ok' && snap >= 2 && overlay === 'present' ? 'E2E_DROP_PASS' : 'E2E_DROP_FAIL');
  seeder.destroy(() => setTimeout(() => app.exit(0), 300));
}).catch((e) => { console.error('FATAL', e && e.stack || e); app.exit(1); });
