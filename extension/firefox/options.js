const api = (typeof browser !== "undefined") ? browser : chrome;
const baseEl = document.getElementById("base");
const tokenEl = document.getElementById("token");
const msgEl = document.getElementById("msg");

api.storage.local.get(["apiBase", "token"]).then((v) => {
  baseEl.value = v.apiBase || "http://127.0.0.1:8977";
  tokenEl.value = v.token || "";
});

document.getElementById("save").onclick = async () => {
  const apiBase = (baseEl.value || "http://127.0.0.1:8977").replace(/\/+$/, "");
  const token = tokenEl.value.trim();
  await api.storage.local.set({ apiBase, token });
  try {
    const ping = await fetch(apiBase + "/ping").then((r) => r.json());
    const res = await fetch(apiBase + "/status", { headers: { "X-Api-Token": token } }).then((r) => r.json());
    msgEl.style.color = res.ok ? "#35e0a1" : "#ff7b72";
    msgEl.textContent = res.ok
      ? "连接成功 ✓  " + ping.app + " v" + ping.version + "，当前 " + res.tasks + " 个任务"
      : "令牌不对：" + (res.error || "");
  } catch (e) {
    msgEl.style.color = "#ff7b72";
    msgEl.textContent = "连不上 " + apiBase + "：" + e.message;
  }
};
