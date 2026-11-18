// 端到端测试：走界面上的「+ 种子文件」这条路径。
//
// 真实入口是 task:add-file（主进程弹系统文件对话框 → 读文件 → addTorrent(Buffer)）。
// 对话框没法自动点，所以在 require 之前把 dialog.showOpenDialog 换成返回固定路径的桩，
// 其余（IPC、preload、读文件、加种子、下载、删除）全都是真实代码。
//
// 顺带验证非法磁力链接会被拒绝并给出中文报错。
//
// 运行：env -u ELECTRON_RUN_AS_NODE npx electron test/e2e-torrent-file.js
const electron = require('electron');
const { app, BrowserWindow, dialog, shell } = electron;
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { makeFixture } = require('./fixture');

process.on('uncaughtException', (e) => { process.stderr.write('UNCAUGHT ' + (e && e.stack || e) + '\n'); });
process.on('unhandledRejection', (e) => { process.stderr.write('REJECT ' + (e && e.stack || e) + '\n'); });

const testHome = path.join(os.tmpdir(), `mt-e2e-torrent-file-${process.pid}`);
fs.rmSync(testHome, { recursive: true, force: true });
fs.mkdirSync(path.join(testHome, 'userData'), { recursive: true });
process.env.HOME = testHome;
app.setPath('userData', path.join(testHome, 'userData'));

let torrentFilePath = null;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [torrentFilePath] });
// 「打开目录」会真的弹 Finder，测试里换成记录参数
let openedPath = null;
shell.openPath = async (p) => { openedPath = p; return ''; };

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

  // ---- 非法磁力链接应当被拒绝 ----
  let badMsg = '';
  try {
    await call('addLink', ['just some random text, not a link']);
  } catch (e) {
    badMsg = String(e && e.message || e);
  }
  const badRejected = /无法识别|磁力链接/.test(badMsg);
  process.stderr.write('BAD_MAGNET_REJECTED ' + badRejected + ' msg=' + badMsg.split('\n')[0] + '\n');

  // ---- 种子文件路径 ----
  const mod = await import('webtorrent');
  const W = mod.default || mod;
  const seeder = new W({ maxConns: 10, dht: false, utp: false });
  await new Promise((r) => seeder.once('listening', r));
  const seedPort = seeder.address().port;
  const st = await new Promise((r) => seeder.seed(fixture.dir, { announce: [] }, r));
  const HASH = st.infoHash;

  torrentFilePath = path.join(os.tmpdir(), 'mt-e2e-fixture.torrent');
  fs.writeFileSync(torrentFilePath, st.torrentFile);
  process.stderr.write('TORRENT_FILE ' + torrentFilePath + ' (' + st.torrentFile.length + ' bytes) hash=' + HASH + '\n');

  let appPort = 0;
  for (let i = 0; i < 20 && !appPort; i++) {
    try { appPort = appPeerPort(seedPort); } catch {}
    if (!appPort) await new Promise((r) => setTimeout(r, 500));
  }

  // 真实入口：点「+ 种子文件」
  const added = await call('addTorrentFile', []);
  const addedId = added && (added.id || added);
  process.stderr.write('ADDED_FROM_FILE ' + addedId + '\n');
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
  const state = await evalJS('JSON.stringify({name:window.__last.name, files:window.__last.files.length, done:window.__last.done, sel:window.__last.files.map(f=>f.selected)})');
  process.stderr.write('STATE ' + state + '\n');

  // 内容校验：逐字节比对，确认不是「文件建出来但内容错」
  let contentOk = false;
  try {
    const a = fs.readFileSync(path.join(dl, 'big.bin'));
    const b = fs.readFileSync(path.join(fixture.dir, 'big.bin'));
    contentOk = a.equals(b);
  } catch {}
  process.stderr.write('CONTENT_MATCH ' + contentOk + '\n');

  // 打开目录应指向该任务自己的文件夹，而不是整个下载目录
  await call('openFolder', [HASH]);
  await new Promise((r) => setTimeout(r, 500));
  const folderOk = openedPath === dl;
  process.stderr.write('OPEN_FOLDER ' + folderOk + ' path=' + openedPath + '\n');

  await call('remove', [HASH, true]);
  await new Promise((r) => setTimeout(r, 2500));
  let gone = false;
  try { fs.statSync(dl); } catch { gone = true; }
  try { fs.unlinkSync(torrentFilePath); } catch {}

  const pass = badRejected && addedId === HASH && done && contentOk && folderOk && gone;
  seeder.destroy(() => {
    process.stderr.write('badRejected=' + badRejected + ' added=' + addedId + ' done=' + done + ' content=' + contentOk + ' folder=' + folderOk + ' gone=' + gone + '\n');
    process.stderr.write(pass ? 'E2E_TORRENT_FILE_PASS\n' : 'E2E_TORRENT_FILE_FAIL\n');
    fs.rmSync(testHome, { recursive: true, force: true });
    app.exit(pass ? 0 : 1);
  });
}).catch((e) => {
  process.stderr.write('FATAL ' + (e && e.stack || e) + '\n');
  fs.rmSync(testHome, { recursive: true, force: true });
  app.exit(1);
});
