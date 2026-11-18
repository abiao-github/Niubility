// Compat shim for webtorrent 2.8.x.
//
// webtorrent calls `arr2hex(parsedTorrent.infoHash)`, but as of 2.8.5 the value
// it passes is already a hex *string* while uint8-util's Node build only accepts
// binary data (Buffer / Uint8Array). The result is
//   TypeError [ERR_INVALID_ARG_TYPE] ... at arr2hex (uint8-util/dist/src/node.js)
// thrown inside Torrent._onTorrentId, which silently kills every torrent add.
//
// uint8-util is ESM with a frozen namespace and an exports map that only exposes
// ".", so it cannot be monkey-patched at runtime: patch the file on disk instead
// (npm's `postinstall` runs this script, so re-installs stay fixed).
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'node_modules/uint8-util/dist/src/node.js');
const ORIGINAL = 'export const arr2hex = (data) => Buffer.from(data.buffer';
const PATCHED = 'export const arr2hex = (data) => typeof data === "string" ? data : Buffer.from(data.buffer';

try {
  const src = fs.readFileSync(target, 'utf8');
  if (src.includes(PATCHED)) {
    console.log('[shim] uint8-util 已打过补丁');
  } else if (src.includes(ORIGINAL)) {
    fs.writeFileSync(target, src.replace(ORIGINAL, PATCHED));
    console.log('[shim] 已修补 uint8-util arr2hex');
  } else {
    console.warn('[shim] uint8-util 结构已变化，跳过修补（如出现任务无法添加请检查）');
  }
} catch (err) {
  // 依赖还没安装好（例如只装了 devDependencies）时不要阻断安装
  console.warn('[shim] 跳过: ' + err.message);
}
