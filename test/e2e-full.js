// 端到端测试：启动真实的 Electron app（src/main.js），通过 preload 暴露的
// window.api 驱动，用一个本地 WebTorrent 做种端喂数据。
//
// 覆盖：磁力链接添加 → 下载完成 → 文件勾选（状态与 DOM）→ 暂停/继续 →
//       删除任务并删除数据。
//
// 运行：env -u ELECTRON_RUN_AS_NODE npx electron test/e2e-full.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { makeFixture } = require('./fixture');

process.on('uncaughtException', (e) => { process.stderr.write('UNCAUGHT ' + (e && e.stack || e) + '\n'); });
process.on('unhandledRejection', (e) => { process.stderr.write('REJECT ' + (e && e.stack || e) + '\n'); });

// 用稍大的载荷：本地环回太快，太小的话「下载中暂停」根本来不及测
const fixture = makeFixture({ big: 2 * 1024 * 1024 });
const dl = path.join(os.homedir(), 'NiuBiliTyDownloads', path.basename(fixture.dir));
fs.rmSync(dl, { recursive: true, force: true });
require('../src/main.js');

function appPeerPort(exclude) {
  const out = execSync('lsof -nP -iTCP -sTCP:LISTEN -a -p ' + process.pid).toString();
  return [...out.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((m) => +m[1]).find((p) => p !== exclude) || 0;
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  // call('remove', [id, true]) => window.api.remove(id, true)
  const call = (fn, args = []) => win.webContents.executeJavaScript(
    'window.api.' + fn + '(' + args.map((a) => JSON.stringify(a)).join(',') + ')', true);
  const evalJS = (code) => win.webContents.executeJavaScript(code, true);
  await evalJS('window.__last=null; window.api.onTaskUpdate(t=>{window.__last=t;}); true;');

  const mod = await import('webtorrent');
  const W = mod.default || mod;
  const seeder = new W({ maxConns: 10, dht: false, utp: false });
  await new Promise((r) => seeder.once('listening', r));
  const seedPort = seeder.address().port;
  const st = await new Promise((r) => seeder.seed(fixture.dir, { announce: [] }, r));
  const HASH = st.infoHash;
  process.stderr.write('SEEDING ' + HASH + ' port=' + seedPort + '\n');

  // 限制做种端上行，否则本地环回几毫秒就传完，「下载中暂停」测不到
  seeder.throttleUpload(512 * 1024);

  let appPort = 0;
  for (let i = 0; i < 20 && !appPort; i++) {
    try { appPort = appPeerPort(seedPort); } catch {}
    if (!appPort) await new Promise((r) => setTimeout(r, 500));
  }
  process.stderr.write('APP_PORT ' + appPort + '\n');

  await call('addLink', ['magnet:?xt=urn:btih:' + HASH]);

  // 下载完成前暂停/继续（完成后暂停是 no-op，不该拿来断言）
  await new Promise((r) => setTimeout(r, 400));
  await call('pause', [HASH]);
  await new Promise((r) => setTimeout(r, 900));
  const p1 = await evalJS('window.__last.paused');
  await call('resume', [HASH]);
  await new Promise((r) => setTimeout(r, 900));
  const p2 = await evalJS('window.__last.paused');
  process.stderr.write('PAUSE ' + p1 + ' RESUME ' + p2 + '\n');

  seeder.torrents[0].addPeer('127.0.0.1:' + appPort);

  let done = false;
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      done = fs.statSync(path.join(dl, 'big.bin')).size === fixture.big &&
             fs.statSync(path.join(dl, 'hello.txt')).size === fixture.small;
    } catch {}
  }
  process.stderr.write('DOWNLOAD_DONE ' + done + '\n');

  await new Promise((r) => setTimeout(r, 1600));
  const s0 = await evalJS('window.__last && JSON.stringify({files:window.__last.files.length, sel:window.__last.files.map(f=>f.selected), done:window.__last.done})');
  process.stderr.write('STATE0 ' + s0 + '\n');

  await call('selectFiles', [HASH, [1]]);
  await new Promise((r) => setTimeout(r, 1800));
  const s1 = await evalJS('JSON.stringify(window.__last.files.map(f=>f.selected))');
  const domSel = await evalJS("JSON.stringify([...document.querySelectorAll('#view-tasks .file-row input')].map(e=>e.checked))");
  process.stderr.write('AFTER_SEL_ONE ' + s1 + ' DOM ' + domSel + '\n');

  await call('selectFiles', [HASH, [0, 1]]);
  await new Promise((r) => setTimeout(r, 1800));
  const s2 = await evalJS('JSON.stringify(window.__last.files.map(f=>f.selected))');
  process.stderr.write('AFTER_SEL_BOTH ' + s2 + '\n');

  // 走界面上的删除按钮：点「删除任务」→ 确认框里选「连文件一起删除」
  const clicked = await evalJS(`(() => {
    const el = [...document.querySelectorAll('#view-tasks .task')].find((n) => n.dataset.id === ${JSON.stringify(HASH)});
    if (!el) return 'no-task';
    if (!el.classList.contains('expanded')) el.querySelector('.task-head').click();
    const btn = [...el.querySelectorAll('.detail-actions .btn')].find((b) => b.textContent.includes('删除任务'));
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`);
  process.stderr.write('DELETE_BTN ' + clicked + '\n');
  await new Promise((r) => setTimeout(r, 300));
  const dialogShown = await evalJS("!document.getElementById('delete-dialog').classList.contains('hidden')");
  const filesBtn = await evalJS("(() => { const b = document.getElementById('delete-files'); b.click(); return true; })()");
  process.stderr.write('DELETE_DIALOG ' + dialogShown + ' ' + filesBtn + '\n');
  await new Promise((r) => setTimeout(r, 3000));
  let gone = false;
  try { fs.statSync(dl); } catch { gone = true; }
  process.stderr.write('REMOVED ' + gone + '\n');

  const selOk = s1 === '[false,true]' && s2 === '[true,true]' && domSel === '[false,true]';
  const pauseOk = p1 === true && p2 === false;
  const pass = done && selOk && pauseOk && clicked === 'clicked' && dialogShown === true && gone;
  seeder.destroy(() => {
    process.stderr.write('selOk=' + selOk + ' pauseOk=' + pauseOk + ' gone=' + gone + '\n');
    process.stderr.write(pass ? 'E2E_FULL_PASS\n' : 'E2E_FULL_FAIL\n');
    app.exit(pass ? 0 : 1);
  });
}).catch((e) => { process.stderr.write('FATAL ' + (e && e.stack || e) + '\n'); app.exit(1); });
