'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = require('electron');
const tests = [
  'e2e-full.js',
  'e2e-partial.js',
  'e2e-torrent-file.js',
  'e2e-protocols.js',
  'e2e-search.js',
  'e2e-search-sources.js',
  'e2e-search-index.js',
  'e2e-local-index.js',
  'e2e-drop.js',
  'e2e-stream.js',
  'e2e-transcode.js',
  'e2e-ranges.js',
  'e2e-extension-cors.js',
  'e2e-health.js',
  'e2e-persist.js',
  'e2e-cloud-headers.js',
  'e2e-cloud-direct.js',
  'e2e-sniff-deep.js'
];
const requested = process.argv.slice(2);
const selected = requested.length ? requested : tests;

for (const name of selected) {
  if (!tests.includes(name)) throw new Error(`Unknown E2E test: ${name}`);
}

for (const name of selected) {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'niubility-e2e-'));
  const env = {
    ...process.env,
    HOME: testHome,
    USERPROFILE: testHome,
    MT_TEST: '1'
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const result = spawnSync(electron, [
    `--user-data-dir=${path.join(testHome, 'userData')}`,
    path.join(__dirname, name)
  ], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'inherit'
  });

  fs.rmSync(testHome, { recursive: true, force: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    break;
  }
}
