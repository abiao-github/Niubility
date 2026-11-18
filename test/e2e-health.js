// 源巡检：跑一轮真实体检（dryRun，不停用任何源），校验报告结构与时延
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/main.js');
const { IndexerMonitor } = require('../src/indexer-monitor');

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const ev = (c) => win.webContents.executeJavaScript(c, true);
  const cfgPath = path.join(app.getPath('userData'), 'search-sources.json');
  if (!fs.existsSync(cfgPath)) { console.log('E2E_HEALTH_SKIP 没有独立测试配置'); app.exit(0); return; }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const prowlarr = (cfg.sources || []).find((s) => s.type === 'prowlarr');
  if (!prowlarr) { console.log('E2E_HEALTH_SKIP 没有配置 Prowlarr'); app.exit(0); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-hl-'));
  const mon = new IndexerMonitor({
    userDataDir: dir,
    getSource: () => ({ baseUrl: prowlarr.baseUrl, apiKey: prowlarr.apiKey }),
    log: (m) => console.log('LOG', m),
    options: { dryRun: true, slowMs: 8000, testTimeoutMs: 20000, strikesToAct: 1 }
  });

  const report = await mon.checkOnce();
  if (!report) { console.log('E2E_HEALTH_FAIL 无报告'); app.exit(1); return; }
  const ok = Array.isArray(report.results) && report.checked >= 3 && typeof report.tookMs === 'number';
  const disabledNone = (report.disabled || []).length === 0;   // dryRun 不应停用
  const fastEnough = report.results.filter((r) => r.ms && r.ms < 8000).length;
  console.log('CHECKED', report.checked, '| SLOW', report.slow, '| FAST', fastEnough, '| TOOK', Math.round(report.tookMs / 1000) + 's');
  console.log('SAMPLE', JSON.stringify(report.results.slice(0, 3)));
  console.log(ok && disabledNone ? 'E2E_HEALTH_PASS' : 'E2E_HEALTH_FAIL');
  app.exit(0);
}).catch((e) => { console.error('FATAL', e && e.stack || e); app.exit(1); });
