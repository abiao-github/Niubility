// 定期把公开的元数据来源导入索引（默认每 7 天一次）。
// 来源清单见 sources.txt；上次完成时间记在 <INDEX_DB>.import-state.json，重启后不会重复导入。

import fs from 'node:fs';
import { importAll, readSources } from './import.js';

export function startUpdater({ store, log, sourcesFile, stateFile, intervalDays = 7, firstDelayMs = 120000, checkEveryMs = 3600000 }) {
  let running = false;

  const lastRun = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastRun || 0; } catch { return 0; }
  };

  async function tick() {
    if (running || Date.now() - lastRun() < intervalDays * 86400000) return;
    if (!fs.existsSync(sourcesFile)) return;
    running = true;
    const t0 = Date.now();
    try {
      const sources = readSources(sourcesFile);
      log(`[updater] 开始导入 ${sources.length} 个来源`);
      const r = await importAll(store, sources, log);
      await store.save(true);
      if (r.failed === 0) fs.writeFileSync(stateFile, JSON.stringify({ lastRun: Date.now(), ...r }));
      log(`[updater] 完成：新增 ${r.added}，补全名称 ${r.named}，失败来源 ${r.failed}，用时 ${Math.round((Date.now() - t0) / 1000)}s` + (r.failed ? '（有失败，下个检查周期会重试）' : ''));
    } catch (err) {
      log('[updater] 出错: ' + err.message);
    } finally {
      running = false;
    }
  }

  const first = setTimeout(tick, firstDelayMs);
  const timer = setInterval(tick, checkEveryMs);
  return () => { clearTimeout(first); clearInterval(timer); };
}
