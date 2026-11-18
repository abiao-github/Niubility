'use strict';

// electron-builder 的 afterPack 钩子：打包完、还没做 dmg 之前，给整个 .app 做 ad-hoc 签名。
// 为什么不靠 electron-builder 自己签：没有开发者证书时它会直接跳过签名，
// 而 macOS（尤其 arm64）会拒绝启动「bundle 被改动过、签名失效」的应用。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 只保留中英文语言包：Electron 自带 55 个语言的 .lproj，合计约 45MB
const KEEP_LOCALES = new Set(['en.lproj', 'en_GB.lproj', 'en_US.lproj', 'zh_CN.lproj', 'zh_TW.lproj', 'zh_HK.lproj', 'Base.lproj']);

function pruneLocales(appPath) {
  let removed = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (!e.isDirectory()) continue;
      if (e.name.endsWith('.lproj') && !KEEP_LOCALES.has(e.name)) {
        try { fs.rmSync(full, { recursive: true, force: true }); removed += 1; } catch { /* ignore */ }
      } else {
        walk(full, depth + 1);
      }
    }
  };
  walk(path.join(appPath, 'Contents'), 0);
  return removed;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // 先瘦身（必须在签名前，否则改包会让签名失效）
  try {
    const n = pruneLocales(appPath);
    console.log(`  • 已移除 ${n} 个多余语言包`);
  } catch (err) {
    console.warn('  • 语言包清理失败:', err.message);
  }

  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log(`  • ad-hoc 签名完成: ${appName}.app`);
  } catch (err) {
    console.warn('  • ad-hoc 签名失败（应用可能无法直接启动）:', err.message);
  }
};
