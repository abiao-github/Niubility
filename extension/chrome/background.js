importScripts('common.js');

const api = browserApi;
const actionApi = api.action || api.browserAction;
const MENU = [
  { id: 'link', title: '用牛B下载器下载此链接', contexts: ['link'] },
  { id: 'video', title: '用牛B下载器下载此视频', contexts: ['video', 'audio'] },
  { id: 'page', title: '用牛B下载器下载本页视频', contexts: ['page'] }
];

api.runtime.onInstalled.addListener(() => {
  for (const m of MENU) api.contextMenus.create(m);
});

api.contextMenus.onClicked.addListener(async (info) => {
  const targets = [];
  if (info.menuItemId === 'link' && info.linkUrl) targets.push(info.linkUrl);
  else if (info.menuItemId === 'video' && info.srcUrl) targets.push(info.srcUrl);
  else if (info.menuItemId === 'page' && info.pageUrl) targets.push(info.pageUrl);
  if (!targets.length) return;
  try {
    await pushLinks(targets);
    badge('✓', '#2ea043');
  } catch (e) {
    badge('!', '#da3633');
    notify('添加失败', String(e.message || e));
  }
});

function badge(text, color) {
  try { actionApi.setBadgeText({ text }); actionApi.setBadgeBackgroundColor({ color }); } catch {}
  setTimeout(() => { try { actionApi.setBadgeText({ text: '' }); } catch {} }, 1800);
}

function notify(title, message) {
  try {
    if (api.notifications) api.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message });
  } catch {}
}

// popup 会来问连通性
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'ping') {
    ping().then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg && msg.type === 'add') {
    pushLinks(msg.links || []).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
});
