'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  addLink: (input) => ipcRenderer.invoke('task:add', input),
  addTorrentFile: () => ipcRenderer.invoke('task:add-file'),
  addPaths: (paths) => ipcRenderer.invoke('task:add-paths', paths),
  addFileData: (name, buffer) => ipcRenderer.invoke('task:add-filedata', { name, buffer }),
  // 拖拽进来的 File 对象 → 真实磁盘路径（Electron 32+ 不再有 File.path）
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  pause: (id) => ipcRenderer.invoke('task:pause', id),
  resume: (id) => ipcRenderer.invoke('task:resume', id),
  remove: (id, deleteFiles) => ipcRenderer.invoke('task:remove', { id, deleteFiles }),
  selectFiles: (id, indices) => ipcRenderer.invoke('task:select-files', { id, indices }),
  openFolder: (id) => ipcRenderer.invoke('task:open-folder', id),
  playUrl: (id, fileIndex, opts) => ipcRenderer.invoke('play:url', { id, fileIndex, ...(opts || {}) }),
  playRanges: (id, fileIndex) => ipcRenderer.invoke('play:ranges', { id, fileIndex }),
  downloadsDir: () => ipcRenderer.invoke('app:downloads-dir'),
  snapshot: () => ipcRenderer.invoke('app:snapshot'),
  globalStats: () => ipcRenderer.invoke('app:global-stats'),
  capabilities: () => ipcRenderer.invoke('app:capabilities'),
  detect: (input) => ipcRenderer.invoke('app:detect', input),
  sniff: (url) => ipcRenderer.invoke('app:sniff', { url }),
  sniffDeep: (url) => ipcRenderer.invoke('app:sniff', { url, deep: true }),
  prefs: (patch) => ipcRenderer.invoke('app:prefs', patch),
  apiInfo: () => ipcRenderer.invoke('app:api-info'),
  cloudAccount: (patch) => ipcRenderer.invoke('cloud:account', patch),
  cloudList: (provider, folderId) => ipcRenderer.invoke('cloud:list', { provider, folderId }),
  cloudAdd: (provider, id) => ipcRenderer.invoke('cloud:add', { provider, id }),
  cloudAddDirect: (provider, url, cookie) => ipcRenderer.invoke('cloud:add-direct', { provider, url, cookie }),
  searchProviders: () => ipcRenderer.invoke('search:providers'),
  searchHealth: (opts) => ipcRenderer.invoke('search:health', opts || {}),
  search: (query, opts) => ipcRenderer.invoke('search:query', { query, ...(opts || {}) }),
  searchToTask: (resultId) => ipcRenderer.invoke('search:to-task', { resultId }),
  searchSources: () => ipcRenderer.invoke('search:sources'),
  saveSearchSource: (source) => ipcRenderer.invoke('search:save-source', source),
  removeSearchSource: (id) => ipcRenderer.invoke('search:remove-source', id),
  testSearchSource: (source) => ipcRenderer.invoke('search:test-source', source),
  localIndexStatus: () => ipcRenderer.invoke('index:local-status'),
  enableLocalIndex: () => ipcRenderer.invoke('index:local-enable'),
  disableLocalIndex: () => ipcRenderer.invoke('index:local-disable'),
  onTaskUpdate: (cb) => ipcRenderer.on('task:update', (_e, t) => cb(t)),
  onStats: (cb) => ipcRenderer.on('app:stats', (_e, s) => cb(s)),
  onError: (cb) => ipcRenderer.on('app:error', (_e, msg) => cb(msg)),
  onToast: (cb) => ipcRenderer.on('app:toast', (_e, msg) => cb(msg))
});
