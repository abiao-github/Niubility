'use strict';

// 把 src/renderer/icon.svg 光栅化成 assets/icon-*.png。
// 用 Electron 自带的 Chromium 渲染 canvas，不依赖 sharp / rsvg 之类的原生库。
// 用法：env -u ELECTRON_RUN_AS_NODE npx electron rasterize.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src', 'renderer', 'icon.svg');
const OUT = path.join(__dirname, 'assets');
const SIZES = [1024, 512, 256, 128, 64];

app.disableHardwareAcceleration();

function html(svgUrl, size) {
  return `<!DOCTYPE html><html><body style="margin:0;background:transparent">
  <canvas id="c" width="${size}" height="${size}"></canvas>
  <script>
    const img = new Image();
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    img.onload = function () { ctx.clearRect(0,0,${size},${size}); ctx.drawImage(img,0,0,${size},${size}); window.__png = c.toDataURL('image/png'); };
    img.onerror = function () { window.__err = 'svg load failed'; };
    img.src = ${JSON.stringify(svgUrl)};
  </script></body></html>`;
}

app.whenReady().then(async () => {
  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(fs.readFileSync(SRC, 'utf8'));
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, webPreferences: { offscreen: true } });
  fs.mkdirSync(OUT, { recursive: true });

  const render = async (size) => {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(svgUrl, size)));
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const png = await win.webContents.executeJavaScript('window.__png || null').catch(() => null);
      if (png) return Buffer.from(png.split(',')[1], 'base64');
      const err = await win.webContents.executeJavaScript('window.__err || null').catch(() => null);
      if (err) throw new Error(err);
    }
    throw new Error('渲染超时 size=' + size);
  };

  try {
    let master = null;
    for (const size of SIZES) {
      const buf = await render(size);
      fs.writeFileSync(path.join(OUT, `icon-${size}.png`), buf);
      if (size === 1024) master = buf;
      process.stderr.write(`[rasterize] icon-${size}.png ${buf.length}B\n`);
    }
    fs.writeFileSync(path.join(OUT, 'icon.png'), master);
    fs.copyFileSync(SRC, path.join(OUT, 'icon.svg'));
    process.stderr.write('RASTER_OK\n');
    win.destroy();
    setTimeout(() => app.exit(0), 400);
  } catch (err) {
    process.stderr.write('RASTER_FAIL ' + err.message + '\n');
    win.destroy();
    setTimeout(() => app.exit(1), 400);
  }
});
