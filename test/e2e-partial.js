// 端到端测试：只勾选种子里的 hello.txt，验证「部分下载」。
//
// 关键点：选择必须在数据开始流动之前设置好（addMagnet 之后、连接做种端之前），
// 否则本地环回速度太快，等界面显示出文件列表时早已下载完。
//
// 运行：env -u ELECTRON_RUN_AS_NODE npx electron test/e2e-partial.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { makeFixture } = require('./fixture');

process.on('uncaughtException', (e) => { process.stderr.write('UNCAUGHT ' + (e && e.stack || e) + '\n'); });
process.on('unhandledRejection', (e) => { process.stderr.write('REJECT ' + (e && e.stack || e) + '\n'); });

const fixture = makeFixture();
const dl = path.join(os.homedir(), 'NiuBiliTyDownloads', path.basename(fixture.dir));
fs.rmSync(dl, { recursive: true, force: true });
require('../src/main.js');

function appPeerPort(exclude) {
  const out = execSync('lsof -nP -iTCP -sTCP:LISTEN -a -p ' + process.pid).toString();
  return [...out.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((m) => +m[1]).find((p) => p !== exclude) || 0;
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
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

  let appPort = 0;
  for (let i = 0; i < 20 && !appPort; i++) {
    try { appPort = appPeerPort(seedPort); } catch {}
    if (!appPort) await new Promise((r) => setTimeout(r, 500));
  }

  // 先选文件，再连做种端
  await call('addLink', ['magnet:?xt=urn:btih:' + HASH]);
  await call('selectFiles', [HASH, [1]]);
  process.stderr.write('selected hello.txt only, appPort=' + appPort + '\n');
  seeder.torrents[0].addPeer('127.0.0.1:' + appPort);

  let helloOk = false;
  for (let i = 0; i < 60 && !helloOk; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { helloOk = fs.statSync(path.join(dl, 'hello.txt')).size === fixture.small; } catch {}
  }
  await new Promise((r) => setTimeout(r, 3000));

  // big.bin 与 hello.txt 共用最后一个 piece，所以文件会按全长创建（稀疏文件）；
  // 真正的判据是抓取量，以及 big.bin 开头是否还是全 0。
  let head = Buffer.alloc(0);
  try { head = fs.readFileSync(path.join(dl, 'big.bin')).subarray(0, 4096); } catch {}
  const headZero = head.length > 0 && head.every((b) => b === 0);
  const state = await evalJS('JSON.stringify({dl:window.__last.downloaded, sel:window.__last.files.map(f=>f.selected), done:window.__last.done, files:window.__last.files.map(f=>({n:f.name,dl:f.downloaded,done:f.done}))})');
  const totalDl = JSON.parse(state).dl;
  process.stderr.write('hello=' + helloOk + ' bigHeadAllZero=' + headZero + ' state=' + state + '\n');

  await call('remove', [HASH, true]);
  await new Promise((r) => setTimeout(r, 2500));
  let gone = false;
  try { fs.statSync(dl); } catch { gone = true; }

  const pass = helloOk && totalDl < 200000 && headZero && gone;
  seeder.destroy(() => {
    process.stderr.write('dl=' + totalDl + ' gone=' + gone + '\n');
    process.stderr.write(pass ? 'E2E_PARTIAL_PASS\n' : 'E2E_PARTIAL_FAIL\n');
    app.exit(pass ? 0 : 1);
  });
}).catch((e) => { process.stderr.write('FATAL ' + (e && e.stack || e) + '\n'); app.exit(1); });
