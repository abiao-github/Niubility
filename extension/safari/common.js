
// 把链接推给本机的牛B下载器（本地 HTTP API）
// 设置里保存两项：apiBase（默认 http://127.0.0.1:8977）、token
const browserApi = typeof browser !== 'undefined' ? browser : chrome;
const DEFAULT_BASE = 'http://127.0.0.1:8977';

async function getSettings() {
  const got = await browserApi.storage.local.get(['apiBase', 'token']);
  return { apiBase: (got.apiBase || DEFAULT_BASE).replace(/\/+$/, ''), token: got.token || '' };
}

async function pushLinks(links) {
  const { apiBase, token } = await getSettings();
  if (!token) throw new Error('还没填令牌：点扩展图标 → 打开设置，粘贴"浏览器扩展令牌"');
  const res = await fetch(apiBase + '/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Token': token },
    body: JSON.stringify({ links })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

async function ping() {
  const { apiBase } = await getSettings();
  const res = await fetch(apiBase + '/ping', { method: 'GET' });
  return res.json();
}
