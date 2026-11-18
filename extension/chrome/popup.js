const api = (typeof browser !== "undefined") ? browser : chrome;
const statusEl = document.getElementById("status");

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = "status " + (ok ? "ok" : "bad");
}

api.runtime.sendMessage({ type: "ping" }).then((r) => {
  if (r && r.ok) setStatus("已连上下载器 v" + (r.version || ""), true);
  else setStatus("没连上：" + ((r && r.error) || "下载器没启动？"), false);
}).catch(() => setStatus("没连上：下载器没启动？", false));

async function currentTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

document.getElementById("add-page").onclick = async () => {
  const tab = await currentTab();
  if (!tab) return;
  setStatus("发送中…", true);
  const r = await api.runtime.sendMessage({ type: "add", links: [tab.url] });
  setStatus(r && r.ok ? "已发送，App 会嗅探本页视频" : "失败：" + ((r && r.error) || ""), !!(r && r.ok));
};

document.getElementById("add-tab").onclick = async () => {
  const tab = await currentTab();
  if (!tab) return;
  const r = await api.runtime.sendMessage({ type: "add", links: [tab.url] });
  setStatus(r && r.ok ? "已发送" : "失败：" + ((r && r.error) || ""), !!(r && r.ok));
};

document.getElementById("open-options").onclick = () => api.runtime.openOptionsPage();
document.getElementById("help").onclick = (e) => { e.preventDefault(); api.runtime.openOptionsPage(); };
