const api = browserApi;
const MENU = [
  { id: 'link', title: '用牛B下载器下载此链接', contexts: ['link'] },
  { id: 'video', title: '用牛B下载器下载此视频', contexts: ['video', 'audio'] },
  { id: 'page', title: '用牛B下载器下载本页视频', contexts: ['page'] }
];

api.runtime.onInstalled.addListener(() => {
  for (const item of MENU) api.contextMenus.create(item);
});

api.contextMenus.onClicked.addListener(async (info) => {
  const targets = [];
  if (info.menuItemId === 'link' && info.linkUrl) targets.push(info.linkUrl);
  else if (info.menuItemId === 'video' && info.srcUrl) targets.push(info.srcUrl);
  else if (info.menuItemId === 'page' && info.pageUrl) targets.push(info.pageUrl);
  if (!targets.length) return;
  try { await pushLinks(targets); flash('✓', '#2ea043'); }
  catch { flash('!', '#da3633'); }
});

function flash(text, color) {
  try { api.browserAction.setBadgeText({ text }); api.browserAction.setBadgeBackgroundColor({ color }); } catch {}
  setTimeout(() => { try { api.browserAction.setBadgeText({ text: '' }); } catch {} }, 1800);
}

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
