'use strict';

const tasksEl = document.getElementById('view-tasks');
const emptyHint = document.getElementById('empty-hint');

// 首页空状态动效：有任务就停（省电），清空任务后自动恢复
let emptyFx = null;

function syncEmptyFx() {
  const empty = taskEls.size === 0;
  emptyHint.style.display = empty ? '' : 'none';
  if (!empty) {
    if (emptyFx) emptyFx.stop();
    return;
  }
  if (!emptyFx) {
    const canvas = document.getElementById('empty-fx');
    if (canvas && window.SwarmVortex) {
      emptyFx = new window.SwarmVortex(canvas, document.getElementById('empty-fx-front'));
      window.__emptyFx = emptyFx;   // 便于调试/自动化检查
    }
  }
  if (emptyFx && !document.getElementById('view-tasks').classList.contains('hidden')) emptyFx.start();
}
const expanded = new Set(); // 展开的任务 id

// ---------- 格式化 ----------

function fmtBytes(n) {
  if (n == null || !isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? Math.round(v) : v.toFixed(2)) + ' ' + u[i];
}

function fmtSpeed(n) { return n ? fmtBytes(n) + '/s' : '0 B/s'; }
function fmtPct(p) { return (p * 100).toFixed(1) + '%'; }

function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
}

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 4500);
}

// ---------- 渲染 ----------

const taskEls = new Map();

function ensureTaskEl(t) {
  let root = taskEls.get(t.id);
  if (root) return root;
  root = document.createElement('div');
  root.className = 'task';
  root.dataset.id = t.id;
  root.innerHTML = `
    <div class="task-head">
      <span class="badge kind"></span>
      <div class="task-title">
        <div class="task-name"></div>
        <div class="task-sub"></div>
      </div>
      <div class="task-status"></div>
    </div>
    <div class="progressbar"><div style="width:0%"></div></div>
    <div class="task-detail"></div>
  `;
  root.querySelector('.task-head').addEventListener('click', () => {
    if (expanded.has(t.id)) expanded.delete(t.id);
    else expanded.add(t.id);
    root.classList.toggle('expanded', expanded.has(t.id));
  });
  tasksEl.appendChild(root);
  taskEls.set(t.id, root);
  return root;
}

function renderTask(t) {
  if (!t.id) return;
  const root = ensureTaskEl(t);

  root.classList.toggle('done', t.done);
  root.classList.toggle('error', !!t.error);
  root.classList.toggle('paused', t.paused && !t.done && !t.error);
  root.classList.toggle('expanded', expanded.has(t.id));

  const kindBadge = root.querySelector('.badge.kind');
  kindBadge.textContent = t.label || t.kind.toUpperCase();
  kindBadge.className = 'badge kind k-' + t.kind;

  root.querySelector('.task-name').textContent = t.name;

  const sub = root.querySelector('.task-sub');
  sub.textContent = '';
  const parts = [];
  if (t.total) parts.push(fmtBytes(t.total));
  parts.push(fmtBytes(t.downloaded) + ' 已下载');
  if (t.kind === 'bt') parts.push('节点 ' + (t.peers || 0) + ' / 种子 ' + (t.seeds || 0));
  if (t.partsTotal && !t.total) parts.push('分片 ' + t.partsDone + '/' + t.partsTotal);
  if (t.state === 'active' || !t.done) {
    if (t.speed) parts.push('↓ ' + fmtSpeed(t.speed));
    if (t.kind === 'bt' && t.uploadSpeed) parts.push('↑ ' + fmtSpeed(t.uploadSpeed));
  }
  if (t.note) parts.push(t.note);
  for (const p of parts) {
    const s = document.createElement('span');
    s.textContent = p;
    sub.appendChild(s);
  }

  const pct = t.total ? t.progress : (t.partsTotal ? t.partsDone / t.partsTotal : 0);
  root.querySelector('.progressbar > div').style.width = (pct * 100).toFixed(1) + '%';

  const status = root.querySelector('.task-status');
  status.innerHTML = '';
  if (t.error) status.insertAdjacentHTML('beforeend', '<span class="badge err">出错</span>');
  else if (t.done) status.insertAdjacentHTML('beforeend', '<span class="badge seeding">' + (t.kind === 'bt' ? '做种中' : '已完成') + '</span>');
  else if (t.paused) status.insertAdjacentHTML('beforeend', '<span class="badge paused">已暂停</span>');
  else if (t.queued) status.insertAdjacentHTML('beforeend', '<span class="badge">排队中</span>');
  else if (!t.total && !t.partsTotal) status.insertAdjacentHTML('beforeend', '<span class="badge">准备中…</span>');
  else status.insertAdjacentHTML('beforeend', '<span class="badge">' + fmtPct(pct) + '</span>');

  renderDetail(root, t);
  syncEmptyFx();
}

function renderDetail(root, t) {
  const detail = root.querySelector('.task-detail');
  detail.innerHTML = '';

  if (t.error) {
    const msg = document.createElement('div');
    msg.className = 'task-error';
    msg.textContent = t.error;
    detail.appendChild(msg);
  }

  if (t.canSelect && t.files.length) {
    for (const f of t.files) {
      const row = document.createElement('div');
      row.className = 'file-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = f.selected;
      cb.disabled = t.done;
      cb.addEventListener('change', () => {
        const indices = [];
        detail.querySelectorAll('.file-row input').forEach((el, i) => { if (el.checked) indices.push(i); });
        window.api.selectFiles(t.id, indices);
      });
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = f.name;
      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = fmtBytes(f.length);
      const pct = document.createElement('span');
      pct.className = 'file-pct';
      pct.textContent = f.length ? Math.round((f.downloaded / f.length) * 100) + '%' : (f.done ? '100%' : '0%');
      row.append(cb, name, size, pct);

      if (t.canSelect && f.length) {
        const bar = document.createElement('span');
        bar.className = 'file-bar';
        const fill = document.createElement('i');
        fill.style.width = Math.round((f.downloaded / f.length) * 100) + '%';
        bar.title = `已下载 ${Math.round((f.downloaded / f.length) * 100)}%`;
        bar.appendChild(fill);
        row.appendChild(bar);
      }

      if (isPlayableName(f.name)) {
        const play = document.createElement('button');
        play.className = 'btn ghost tiny play-btn';
        play.textContent = f.done ? '▶ 播放' : (f.downloaded > 0 ? '▶ 边下边播' : '▶ 播放');
        play.title = f.done ? '用内置播放器打开' : '已下载的部分可以直接播，播到哪下到哪';
        play.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openPlayer(t.id, f, play);
        });
        row.appendChild(play);
      }
      detail.appendChild(row);
    }
  } else if (!t.canSelect) {
    const info = document.createElement('div');
    info.className = 'task-path';
    info.textContent = '保存到：' + (t.savePath || '—');
    detail.appendChild(info);
  }

  const actions = document.createElement('div');
  actions.className = 'detail-actions';

  if (!t.done && !t.error) {
    const btnToggle = document.createElement('button');
    btnToggle.className = 'btn small';
    btnToggle.textContent = t.paused ? '继续' : '暂停';
    btnToggle.onclick = (e) => {
      e.stopPropagation();
      if (t.paused) window.api.resume(t.id); else window.api.pause(t.id);
    };
    actions.appendChild(btnToggle);
  }

  const btnFolder = document.createElement('button');
  btnFolder.className = 'btn small';
  btnFolder.textContent = '打开目录';
  btnFolder.onclick = (e) => { e.stopPropagation(); window.api.openFolder(t.id); };
  actions.appendChild(btnFolder);

  const btnDel = document.createElement('button');
  btnDel.className = 'btn small danger';
  btnDel.textContent = '删除任务';
  btnDel.onclick = (e) => {
    e.stopPropagation();
    askDelete(t).then((deleteFiles) => {
      if (deleteFiles === null) return;
      window.api.remove(t.id, deleteFiles);
      const el = taskEls.get(t.id);
      if (el) el.remove();
      taskEls.delete(t.id);
      expanded.delete(t.id);
      syncEmptyFx();
      toast(deleteFiles ? '任务和文件已删除' : '任务已移除（文件保留）');
    });
  };
  actions.appendChild(btnDel);

  detail.appendChild(actions);
}

// ---------- 对话框 ----------

const addDialog = document.getElementById('add-dialog');
const addInput = document.getElementById('add-input');
const addHint = document.getElementById('add-hint');

// 删除确认：true=连文件一起删，false=仅移除任务，null=取消
const deleteDialog = document.getElementById('delete-dialog');
const deleteText = document.getElementById('delete-text');
let deleteResolve = null;

function askDelete(t) {
  deleteText.textContent = '“' + t.name + '”' + (t.total ? '（' + fmtBytes(t.total) + '）' : '') +
    '\n仅移除任务：保留已下载的文件。连文件一起删除：一并删掉该任务的下载文件。';
  deleteDialog.classList.remove('hidden');
  return new Promise((resolve) => { deleteResolve = resolve; });
}

function closeDelete(value) {
  deleteDialog.classList.add('hidden');
  const r = deleteResolve;
  deleteResolve = null;
  if (r) r(value);
}

document.getElementById('delete-cancel').onclick = () => closeDelete(null);
document.getElementById('delete-keep').onclick = () => closeDelete(false);
document.getElementById('delete-files').onclick = () => closeDelete(true);

document.getElementById('btn-add').onclick = () => {
  addInput.value = '';
  addHint.textContent = '粘贴任意链接，自动识别协议 · Enter 添加，Shift+Enter 换行';
  addDialog.classList.remove('hidden');
  const sr = document.getElementById('sniff-results');
  if (sr) { sr.classList.add('hidden'); sr.innerHTML = ''; }
  addInput.focus();
};

let detectTimer = null;
addInput.addEventListener('input', () => {
  clearTimeout(detectTimer);
  const text = addInput.value.trim();
  if (!text) { addHint.textContent = '粘贴任意链接，自动识别协议 · Enter 添加，Shift+Enter 换行'; return; }
  detectTimer = setTimeout(async () => {
    try {
      const info = await window.api.detect(text);
      if (!info) { addHint.textContent = '⚠ 没认出来，检查一下链接格式'; return; }
      const map = {
        bt: 'BitTorrent', http: 'HTTP', ftp: 'FTP', hls: 'HLS 流', dash: 'DASH 流',
        metalink: 'Metalink', ipfs: 'IPFS', ed2k: 'eD2K', sftp: 'SFTP', invalid: '不支持'
      };
      addHint.textContent = '✓ 识别为 ' + (map[info.kind] || info.kind) + (info.note ? ' · ' + info.note : '');
    } catch { /* ignore */ }
  }, 180);
});

const sniffResultsEl = document.getElementById('sniff-results');

function renderSniff(items, note, deep) {
  sniffResultsEl.innerHTML = '';
  sniffResultsEl.classList.remove('hidden');
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'sniff-empty';
    empty.textContent = note || '没找到视频地址';
    if (!deep) {
      const more = document.createElement('button');
      more.className = 'btn small ghost';
      more.style.marginTop = '8px';
      more.textContent = '试试深度嗅探（执行网页 JS）';
      more.onclick = () => runSniff(true);
      empty.appendChild(document.createElement('br'));
      empty.appendChild(more);
    }
    sniffResultsEl.appendChild(empty);
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'sniff-item';
    const kind = document.createElement('span');
    kind.className = 'sniff-kind';
    kind.textContent = it.kind.toUpperCase();
    const url = document.createElement('span');
    url.className = 'sniff-url';
    url.textContent = it.url;
    url.title = it.url;
    const add = document.createElement('button');
    add.className = 'btn small primary';
    add.textContent = '添加';
    add.onclick = async (e) => {
      e.stopPropagation();
      try {
        await window.api.addLink(it.url);
        toast('已添加：' + it.kind.toUpperCase());
        addDialog.classList.add('hidden');
      } catch (err) { toast('添加失败：' + (err.message || err)); }
    };
    row.append(kind, url, add);
    row.onclick = () => add.click();
    sniffResultsEl.appendChild(row);
  }
}

function sniffPageUrl() {
  const lines = document.getElementById('add-input').value.split('\n').map((x) => x.trim()).filter(Boolean);
  return lines.find((x) => /^https?:\/\//i.test(x)) || '';
}

async function runSniff(deep) {
  const pageUrl = sniffPageUrl();
  if (!pageUrl) { toast('先在输入框里粘一个网页地址'); return; }
  const btn = document.getElementById(deep ? 'add-sniff-deep' : 'add-sniff');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = deep ? '深度嗅探中（约 5 秒）…' : '嗅探中…';
  try {
    const res = deep ? await window.api.sniffDeep(pageUrl) : await window.api.sniff(pageUrl);
    renderSniff(res.items || [], res.note, deep);
  } catch (err) {
    renderSniff([], '嗅探失败：' + (err.message || err).replace(/^.*Error: /, ''), deep);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

document.getElementById('add-sniff').onclick = () => runSniff(false);
document.getElementById('add-sniff-deep').onclick = () => runSniff(true);

function readAdvHeaders() {
  const ua = document.getElementById('adv-ua').value.trim();
  const ref = document.getElementById('adv-referer').value.trim();
  const cookie = document.getElementById('adv-cookie').value.trim();
  const headers = {};
  if (ua) headers['User-Agent'] = ua;
  if (ref) headers.Referer = ref;
  if (cookie) headers.Cookie = cookie;
  return Object.keys(headers).length ? headers : null;
}

async function submitAdd() {
  const text = addInput.value.trim();
  if (!text) return;
  addDialog.classList.add('hidden');
  try {
    const headers = readAdvHeaders();
    const input = headers ? { url: text, headers } : text;
    const task = await window.api.addLink(input);
    if (task && task.name) toast('已添加：' + task.name);
    else toast('已添加');
  } catch (err) {
    toast('添加失败：' + (err.message || err), true);
  }
}

document.getElementById('add-cancel').onclick = () => addDialog.classList.add('hidden');
document.getElementById('add-ok').onclick = () => submitAdd();

addInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitAdd();
  } else if (e.key === 'Escape') {
    addDialog.classList.add('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!deleteDialog.classList.contains('hidden')) closeDelete(null);
  else if (!addDialog.classList.contains('hidden')) addDialog.classList.add('hidden');
});

document.getElementById('btn-file').onclick = async () => {
  try {
    const task = await window.api.addTorrentFile();
    if (task && task.name) toast('已添加：' + task.name);
  } catch (err) {
    toast('添加失败：' + (err.message || err), true);
  }
};

// 空状态里的快捷按钮
emptyHint.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-empty-action]');
  if (!btn) return;
  const action = btn.dataset.emptyAction;
  if (action === 'search') { showView('search'); document.getElementById('search-input').focus(); }
  else if (action === 'add') { document.getElementById('btn-add').click(); }
  else if (action === 'file') { document.getElementById('btn-file').click(); }
});

// ---------- 边下边播 ----------
const MEDIA_RE = /\.(mp4|m4v|mov|webm|mkv|avi|ts|mp3|m4a|aac|flac|ogg|opus|wav)$/i;
function isPlayableName(name) { return MEDIA_RE.test(String(name || '')); }

async function openPlayer(taskId, file, btn) {
  const isAudio = /\.(mp3|m4a|aac|flac|ogg|opus|wav)$/i.test(file.name);
  let info;
  try {
    if (btn) { btn.disabled = true; btn.textContent = '准备中…'; }
    info = await window.api.playUrl(taskId, file.index);
  } catch (err) {
    toast('无法播放：' + (err.message || err).replace(/^.*Error: /, ''));
    if (btn) { btn.disabled = false; btn.textContent = '▶ 播放'; }
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = '▶ 播放'; }
  let url = info.url;
  let mode = info.mode;
  if (mode === 'transcode' && !info.hasFfmpeg) {
    toast('这个格式需要 ffmpeg 转码，但没找到 ffmpeg');
    return;
  }

  const modal = document.createElement('div');
  modal.className = 'player-modal';
  modal.innerHTML = `
    <div class="player-box">
      <div class="player-head">
        <span class="player-name"></span>
        <span class="player-badge"></span>
        <button class="btn ghost tiny" data-close>关闭</button>
      </div>
      <div class="player-body"></div>
      <div class="player-timeline">
        <div class="tl-ranges"></div>
        <div class="tl-head"></div>
      </div>
      <div class="player-foot">
        <span class="tl-legend"><i class="ok"></i>已下载 <i class="miss"></i>未下载</span>
        <span class="tl-hint">点进度条可直接跳到该位置</span>
      </div>
    </div>`;
  modal.querySelector('.player-name').textContent = file.name.split('/').pop();
  const badge = modal.querySelector('.player-badge');
  const setBadge = (m) => {
    badge.textContent = m === 'transcode' ? '转码播放' : '直连播放';
    badge.classList.toggle('transcoding', m === 'transcode');
    badge.title = m === 'transcode'
      ? '容器/编码需要 ffmpeg 实时转码（HEVC、AV1、DTS、MKV 等），会占用一些 CPU/GPU'
      : '浏览器原生可播，直接读已下载的分片';
  };
  setBadge(mode);
  const body = modal.querySelector('.player-body');
  const el = document.createElement(isAudio ? 'audio' : 'video');
  el.controls = true;
  el.autoplay = true;
  el.src = url;
  if (!isAudio) el.style.width = '100%';
  body.appendChild(el);

  // 转码是"从 t 开始"的单向流，用户拖进度条后需要重新起一段转码
  let tcStart = 0;
  let seekTimer = null;
  el.addEventListener('seeking', () => {
    if (mode !== 'transcode') return;
    clearTimeout(seekTimer);
    seekTimer = setTimeout(async () => {
      const target = el.currentTime;
      if (!Number.isFinite(target) || Math.abs(target - tcStart) < 6) return;
      try {
        const t = await window.api.playUrl(taskId, file.index, { forceTranscode: true });
        tcStart = target;
        el.src = t.url + `&t=${target.toFixed(1)}`;
        el.play().catch(() => {});
        body.classList.add('seeking-transcode');
        setTimeout(() => body.classList.remove('seeking-transcode'), 1200);
      } catch { /* 忽略拖动失败 */ }
    }, 420);
  });

  // 直连播不了（比如 mp4 里装的是 HEVC/DTS）→ 自动切转码，并跳回原来的位置
  el.addEventListener('error', async () => {
    if (mode === 'transcode') return;
    const at = el.currentTime || 0;
    try {
      const t = await window.api.playUrl(taskId, file.index, { forceTranscode: true });
      mode = 'transcode';
      setBadge('transcode');
      url = t.url + (at > 1 ? `&t=${at.toFixed(1)}` : '');
      el.src = url;
      el.play().catch(() => {});
    } catch (err) {
      toast('转码失败：' + (err.message || err).replace(/^.*Error: /, ''));
    }
  });

  const tl = modal.querySelector('.player-timeline');
  const tlRanges = modal.querySelector('.tl-ranges');
  const tlHead = modal.querySelector('.tl-head');

  const paintRanges = (data) => {
    if (!data || !data.length) return;
    const total = data.length;
    const segs = (data.ranges || []).map(([a, b]) =>
      `<i style="left:${(a / total) * 100}%;width:${Math.max(0.25, ((b - a) / total) * 100)}%"></i>`).join('');
    tlRanges.innerHTML = segs;
    tlRanges.dataset.loaded = String(Math.round(((data.ranges || []).reduce((n, r) => n + (r[1] - r[0]), 0) / total) * 100));
  };

  const refreshRanges = async () => {
    try {
      const data = await window.api.playRanges(taskId, file.index);
      paintRanges(data);
    } catch { /* ignore */ }
  };
  refreshRanges();
  const rangeTimer = setInterval(refreshRanges, 1500);

  const updateHead = () => {
    const dur = el.duration;
    if (Number.isFinite(dur) && dur > 0) {
      tlHead.style.left = ((el.currentTime / dur) * 100) + '%';
    }
  };
  el.addEventListener('timeupdate', updateHead);
  el.addEventListener('loadedmetadata', updateHead);

  tl.addEventListener('click', (e) => {
    const rect = tl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const dur = el.duration;
    if (Number.isFinite(dur) && dur > 0) el.currentTime = ratio * dur;
  });

  const close = () => {
    clearInterval(rangeTimer);
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* ignore */ }
    modal.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  modal.querySelector('[data-close]').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.body.appendChild(modal);
}

// ---------- 拖拽添加（种子文件 / 磁力链接 / 下载地址） ----------
const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;

function hasDroppableContent(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && (dt.types.includes('Files') || dt.types.includes('text/uri-list') || dt.types.includes('text/plain'))) return true;
  return false;
}

window.addEventListener('dragenter', (e) => {
  if (!hasDroppableContent(e)) return;
  e.preventDefault();
  dragDepth += 1;
  dropOverlay.classList.add('on');
});

window.addEventListener('dragover', (e) => {
  if (!hasDroppableContent(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (e) => {
  if (!hasDroppableContent(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.remove('on');
});

window.addEventListener('drop', async (e) => {
  if (!hasDroppableContent(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('on');

  const dt = e.dataTransfer;
  const files = Array.from(dt.files || []);

  // 1) 拖进来的是文件：优先走"磁盘路径"，拿不到路径就读内容写临时文件
  if (files.length) {
    const paths = [];
    const blobs = [];
    for (const f of files) {
      const p = window.api.getPathForFile ? window.api.getPathForFile(f) : '';
      if (p) paths.push(p);
      else blobs.push(f);
    }
    let ok = 0;
    if (paths.length) {
      try {
        const res = await window.api.addPaths(paths);
        ok += (res.added || []).length;
        for (const bad of res.failed || []) toast(`添加失败：${bad.path.split('/').pop()} — ${bad.error}`);
      } catch (err) { toast('添加失败：' + (err.message || err)); }
    }
    for (const f of blobs) {
      try {
        const buf = await f.arrayBuffer();
        await window.api.addFileData(f.name, buf);
        ok += 1;
      } catch (err) { toast(`添加失败：${f.name}`); }
    }
    if (ok) toast(`已添加 ${ok} 个文件`);
    return;
  }

  // 2) 拖进来的是文本（磁力链接 / 下载地址 / 迅雷 ed2k 等）
  const text = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim();
  if (!text) return;
  const links = text.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
  let ok = 0;
  for (const link of links) {
    try { await window.api.addLink(link); ok += 1; } catch (err) { toast('添加失败：' + (err.message || err)); }
  }
  if (ok) toast(`已添加 ${ok} 个链接`);
});

// ---------- 事件 ----------

window.api.onTaskUpdate(renderTask);
window.api.onError((msg) => toast(msg, true));

window.api.onStats((s) => {
  document.getElementById('g-dl').textContent = '↓ ' + fmtSpeed(s.downloadSpeed);
  document.getElementById('g-ul').textContent = '↑ ' + fmtSpeed(s.uploadSpeed);
  document.getElementById('g-count').textContent = s.numTorrents + ' 个任务';
});

window.api.downloadsDir().then((d) => {
  document.getElementById('g-dir').textContent = d;
});

// 启动时补齐已有任务（比如热重载）
window.api.snapshot().then((list) => {
  for (const t of list) renderTask(t);
  syncEmptyFx();
}).catch(() => { syncEmptyFx(); });

// ---------- 视图切换 ----------

function showView(name) {
  if (name !== 'tasks' && emptyFx) emptyFx.stop();
  document.getElementById('view-tasks').classList.toggle('hidden', name !== 'tasks');
  document.getElementById('view-search').classList.toggle('hidden', name !== 'search');
  document.getElementById('tab-tasks').classList.toggle('active', name === 'tasks');
  document.getElementById('tab-search').classList.toggle('active', name === 'search');
  if (name === 'search') document.getElementById('search-input').focus();
}

document.getElementById('tab-tasks').onclick = () => { showView('tasks'); syncEmptyFx(); };
document.getElementById('tab-search').onclick = () => showView('search');

// ---------- 搜索（发现层） ----------

const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
const searchStatusEl = document.getElementById('search-status');
const providerBox = document.getElementById('search-providers');
let selectedProviders = [];

function fmtSize(n) { return n ? fmtBytes(n) : '—'; }

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days < 30) return days + ' 天前';
  if (days < 365) return Math.floor(days / 30) + ' 个月前';
  return Math.floor(days / 365) + ' 年前';
}

function renderSearchResults(payload) {
  const { results, errors, tookMs } = payload;
  searchResultsEl.innerHTML = '';

  const errText = errors && errors.length
    ? ' · ' + errors.map((e) => e.label + '：' + e.message).join('；')
    : '';
  searchStatusEl.innerHTML = '';
  const line = document.createElement('span');
  line.textContent = `找到 ${results.length} 条结果`
    + (payload.dropped ? `（已过滤 ${payload.dropped} 条不相关）` : '')
    + (payload.expandNote ? ` · 中英互搜: ${payload.expandNote}` : '')
    + ` · 用时 ${tookMs} ms`;
  searchStatusEl.appendChild(line);
  if (errText) {
    const err = document.createElement('span');
    err.className = 'err';
    err.textContent = errText;
    searchStatusEl.appendChild(err);
  }

  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'result-empty';
    empty.textContent = '没有匹配的结果，换个关键词试试（中文关键词在英文站点上命中率较低）。';
    searchResultsEl.appendChild(empty);
    return;
  }

  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'result-row';

    const title = document.createElement('div');
    title.className = 'result-title';
    title.textContent = r.title;
    title.title = r.title + (r.infoHash ? '\ninfohash: ' + r.infoHash : '');
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = r.source + (r.alsoOn && r.alsoOn.length ? ' +' + r.alsoOn.length : '');
    title.appendChild(src);

    const size = document.createElement('div');
    size.className = 'result-meta';
    size.textContent = fmtSize(r.size);

    const cat = document.createElement('div');
    cat.className = 'result-meta';
    cat.textContent = r.categoryLabel;

    const seed = document.createElement('div');
    seed.className = 'result-seed' + (r.seeders || r.hotness ? '' : ' zero');
    if (r.seeders) {
      seed.textContent = r.seeders + ' 做种';
      seed.title = r.leechers + ' 下载中';
    } else if (r.hotness) {
      seed.textContent = '热度 ' + r.hotness;
      seed.title = '索引里观察到的 announce 次数';
    } else {
      seed.textContent = '— 做种';
    }

    const date = document.createElement('div');
    date.className = 'result-meta';
    date.textContent = fmtDate(r.publishedAt);

    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = '下载';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '添加中…';
      try {
        const out = await window.api.searchToTask(r.id);
        toast('已开始下载：' + (out.title || r.title));
        showView('tasks');
      } catch (err) {
        toast('添加失败：' + (err.message || err), true);
        btn.disabled = false;
        btn.textContent = '下载';
      }
    };

    row.append(title, size, cat, seed, date, btn);
    searchResultsEl.appendChild(row);
  }
}

const expandToggle = document.getElementById('search-expand');

async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  searchStatusEl.textContent = expandToggle.checked ? '搜索中（含中英互搜）…' : '搜索中…';
  searchResultsEl.innerHTML = '';
  try {
    const payload = await window.api.search(q, {
      providers: selectedProviders,
      expand: expandToggle.checked
    });
    renderSearchResults(payload);
  } catch (err) {
    searchStatusEl.textContent = '搜索失败：' + (err.message || err);
  }
}

expandToggle.checked = localStorage.getItem('mt-expand') === '1';
expandToggle.addEventListener('change', () => {
  localStorage.setItem('mt-expand', expandToggle.checked ? '1' : '0');
});

document.getElementById('search-go').onclick = runSearch;
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch();
});

refreshProviderCheckboxes().catch(() => {});

// ---------- 搜索源配置（Jackett / Prowlarr） ----------

const sourcesDialog = document.getElementById('sources-dialog');
const sourcesListEl = document.getElementById('sources-list');
const sourceMsg = document.getElementById('source-msg');

function renderSources(list) {
  sourcesListEl.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'result-empty';
    empty.textContent = '还没有配置自建搜索源（内置 apibay / nyaa 不受影响）。';
    sourcesListEl.appendChild(empty);
    return;
  }
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'source-item';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.label.toLowerCase() === s.type ? s.label : s.label + ' (' + s.type + ')';
    const url = document.createElement('span');
    url.className = 'url';
    url.textContent = s.baseUrl + (s.indexerId ? ' · ' + s.indexerId : '') + ' · ' + s.keyPreview;
    const del = document.createElement('button');
    del.className = 'btn small danger';
    del.textContent = '移除';
    del.onclick = async () => {
      const next = await window.api.removeSearchSource(s.id);
      renderSources(next);
      refreshProviderCheckboxes();
      toast('已移除搜索源：' + s.label);
    };
    row.append(name, url, del);
    sourcesListEl.appendChild(row);
  }
}

async function renderHealth() {
  const el = document.getElementById('source-health');
  if (!el) return;
  try {
    const rep = await window.api.searchHealth();
    if (!rep) { el.textContent = '源体检：还没跑过（启动 90 秒后自动开始，之后每 3 小时一次）'; return; }
    const when = new Date(rep.at);
    const slow = (rep.results || []).filter((r) => r.slow);
    const parts = [`源体检：${rep.checked} 个源 · 慢 ${rep.slow} 个 · 用时 ${Math.round(rep.tookMs / 1000)}s`,
      `（${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}）`];
    if (slow.length) parts.push(' · 慢源：' + slow.map((r) => r.name).join('、'));
    if ((rep.disabled || []).length) parts.push(' · 已停用：' + rep.disabled.map((d) => d.name).join('、'));
    el.textContent = parts.join('');
    const btn = document.getElementById('source-health-run');
    if (btn) btn.disabled = false;
  } catch { el.textContent = '源体检：读取失败'; }
}

async function openSources() {
  sourcesDialog.classList.remove('hidden');
  sourceMsg.textContent = '';
  sourceMsg.className = 'source-msg';
  const info = await window.api.searchSources();
  renderSources(info.sources);
  renderHealth();
}

const healthBtn = document.getElementById('source-health-run');
if (healthBtn) {
  healthBtn.onclick = async () => {
    healthBtn.disabled = true;
    const el = document.getElementById('source-health');
    if (el) el.textContent = '源体检中…（逐个测速，可能需要 30 秒）';
    await window.api.searchHealth({ run: true });
    await renderHealth();
    healthBtn.disabled = false;
  };
}

// ---------- 网盘 ----------
const cloudDialog = document.getElementById('cloud-dialog');
const cloudListEl = document.getElementById('cloud-list');
const cloudHintEl = document.getElementById('cloud-hint');
const cloudCredInput = document.getElementById('cloud-cred-input');
let cloudProvider = 'aliyun';
let cloudFolder = null;

const CLOUD_HINT = {
  aliyun: '阿里云盘：粘贴 refresh_token（官方开放 API 用），保存后即可读取网盘文件。<br>token 只存在本机 userData/cloud-accounts.json（权限 600）。',
  baidu: '百度网盘：粘贴浏览器里的 Cookie（要包含 BDUSS=）。<br>百度对第三方客户端有风控，Cookie 过期或触发验证时需要重新获取；下载直链会带 UA/Cookie 才能通过。',
  quark: '夸克网盘没有公开 API。用浏览器/导出工具拿到直链后粘在下面，<br>会自动带上 Referer=https://pan.quark.cn/；需要 Cookie 时一并填。',
  '115': '115 网盘没有公开 API。拿到直链后粘在下面，自动带 Referer=https://115.com/。',
  tianyi: '天翼云盘没有公开 API。拿到直链后粘在下面，自动带 Referer=https://cloud.189.cn/。',
  direct: '任何网盘的直链都可以粘在下面；不确定要什么请求头时先留空试试。'
};

const API_MODES = new Set(['aliyun', 'baidu']);

function setCloudProvider(p) {
  cloudProvider = p;
  cloudFolder = null;
  for (const b of document.querySelectorAll('.cloud-tab')) b.classList.toggle('on', b.dataset.provider === p);
  const isApi = API_MODES.has(p);
  document.querySelector('.cloud-cred').classList.toggle('hidden', !isApi);
  document.getElementById('cloud-direct').classList.toggle('hidden', isApi);
  cloudListEl.classList.toggle('hidden', !isApi);
  if (isApi) {
    cloudCredInput.placeholder = p === 'aliyun' ? '阿里云盘 refresh_token' : '百度网盘 Cookie（含 BDUSS=）';
    cloudListEl.innerHTML = '<div class="cloud-empty">点「读取文件」加载目录</div>';
  }
  cloudHintEl.innerHTML = CLOUD_HINT[p] || '';
}

async function renderCloudList(items) {
  cloudListEl.innerHTML = '';
  if (!items.length) {
    cloudListEl.innerHTML = '<div class="cloud-empty">这个目录是空的</div>';
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'cloud-item' + (it.type === 'folder' ? ' folder' : '');
    const name = document.createElement('span');
    name.className = 'n';
    name.textContent = (it.type === 'folder' ? '📁 ' : '🎬 ') + it.name;
    const size = document.createElement('span');
    size.className = 's';
    size.textContent = it.type === 'folder' ? '' : fmtBytes(it.size);
    row.append(name, size);

    if (it.type === 'folder') {
      name.onclick = () => loadCloudFolder(it.id);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn small primary';
      btn.textContent = '下载';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = '准备中…';
        try {
          const r = await window.api.cloudAdd(cloudProvider, it.id);
          toast('已添加：' + (r.name || it.name));
          cloudDialog.classList.add('hidden');
        } catch (err) {
          toast('添加失败：' + (err.message || err).replace(/^.*Error: /, ''));
          btn.disabled = false;
          btn.textContent = '下载';
        }
      };
      row.appendChild(btn);
    }
    cloudListEl.appendChild(row);
  }
}

async function loadCloudFolder(folderId) {
  cloudFolder = folderId;
  cloudListEl.innerHTML = '<div class="cloud-empty">读取中…</div>';
  try {
    const items = await window.api.cloudList(cloudProvider, folderId || undefined);
    renderCloudList(items);
  } catch (err) {
    const message = document.createElement('div');
    message.className = 'cloud-empty';
    message.textContent = (err && err.message ? err.message : String(err)).replace(/^.*Error: /, '');
    cloudListEl.replaceChildren(message);
  }
}

document.getElementById('btn-cloud').onclick = async () => {
  cloudDialog.classList.remove('hidden');
  setCloudProvider('aliyun');
  try {
    const acc = await window.api.cloudAccount();
    if (acc.aliyun) cloudCredInput.placeholder = '已保存（' + acc.aliyunHint + '），重新粘贴可覆盖';
    if (acc.baidu) cloudCredInput.placeholder = '已保存（' + acc.baiduHint + '），重新粘贴可覆盖';
  } catch { /* ignore */ }
};

for (const b of document.querySelectorAll('.cloud-tab')) {
  b.onclick = () => setCloudProvider(b.dataset.provider);
}

document.getElementById('cloud-save').onclick = async () => {
  const v = cloudCredInput.value.trim();
  if (!v) { toast('先粘贴凭据'); return; }
  const patch = cloudProvider === 'aliyun' ? { aliyunRefreshToken: v } : { baiduCookie: v };
  await window.api.cloudAccount(patch);
  cloudCredInput.value = '';
  toast('已保存（只存在本机）');
};

document.getElementById('cloud-load').onclick = () => loadCloudFolder(null);
document.getElementById('cloud-direct-add').onclick = async () => {
  const url = document.getElementById('cloud-direct-url').value.trim();
  const cookie = document.getElementById('cloud-direct-cookie').value.trim();
  if (!url) { toast('先粘贴直链'); return; }
  const btn = document.getElementById('cloud-direct-add');
  btn.disabled = true;
  btn.textContent = '添加中…';
  try {
    const r = await window.api.cloudAddDirect(cloudProvider, url, cookie);
    toast('已添加：' + ((r.task && r.task.name) || '网盘文件'));
    document.getElementById('cloud-direct-url').value = '';
    cloudDialog.classList.add('hidden');
  } catch (err) {
    toast('添加失败：' + (err.message || err).replace(/^.*Error: /, ''));
  } finally {
    btn.disabled = false;
    btn.textContent = '添加下载';
  }
};

document.getElementById('cloud-close').onclick = () => cloudDialog.classList.add('hidden');

// ---------- 设置 ----------
const prefsDialog = document.getElementById('prefs-dialog');

document.getElementById('btn-prefs').onclick = async () => {
  const p = await window.api.prefs();
  document.getElementById('prefs-conc').value = p.maxConcurrent;
  document.getElementById('prefs-conn').value = p.connections;
  document.getElementById('prefs-limit').value = p.globalLimit ? Math.round(p.globalLimit / 1024) : 0;
  try {
    const info = await window.api.apiInfo();
    document.getElementById('prefs-token').value = info.token;
    document.getElementById('prefs-port').textContent = info.port;
  } catch { /* ignore */ }
  prefsDialog.classList.remove('hidden');
};
document.getElementById('prefs-token-copy').onclick = async () => {
  const el = document.getElementById('prefs-token');
  try { await navigator.clipboard.writeText(el.value); toast('令牌已复制'); }
  catch { el.select(); document.execCommand('copy'); toast('令牌已复制'); }
};
document.getElementById('prefs-cancel').onclick = () => prefsDialog.classList.add('hidden');
document.getElementById('prefs-save').onclick = async () => {
  const patch = {
    maxConcurrent: Number(document.getElementById('prefs-conc').value) || 3,
    connections: Number(document.getElementById('prefs-conn').value) || 8,
    globalLimit: Math.round((Number(document.getElementById('prefs-limit').value) || 0) * 1024)
  };
  await window.api.prefs(patch);
  prefsDialog.classList.add('hidden');
  toast(`设置已保存：并发 ${patch.maxConcurrent} · 连接 ${patch.connections} · 限速 ${patch.globalLimit ? Math.round(patch.globalLimit / 1024) + ' KB/s' : '不限'}`);
};

document.getElementById('btn-sources').onclick = () => { openSources(); refreshLocalIndex(); };
document.getElementById('sources-close').onclick = () => sourcesDialog.classList.add('hidden');

function currentSourceInput() {
  return {
    type: document.getElementById('source-type').value,
    baseUrl: document.getElementById('source-url').value.trim(),
    apiKey: document.getElementById('source-key').value.trim(),
    indexerId: document.getElementById('source-indexer').value.trim() || null
  };
}

document.getElementById('source-test').onclick = async () => {
  sourceMsg.className = 'source-msg';
  sourceMsg.textContent = '测试中…';
  try {
    const out = await window.api.testSearchSource(currentSourceInput());
    if (out.ok) {
      sourceMsg.className = 'source-msg ok';
      sourceMsg.textContent = `连接成功，返回 ${out.count} 条（${out.tookMs} ms）`;
    } else {
      sourceMsg.className = 'source-msg err';
      sourceMsg.textContent = '失败：' + out.error;
    }
  } catch (err) {
    sourceMsg.className = 'source-msg err';
    sourceMsg.textContent = '失败：' + (err.message || err);
  }
};

document.getElementById('source-save').onclick = async () => {
  sourceMsg.className = 'source-msg';
  try {
    const list = await window.api.saveSearchSource(currentSourceInput());
    renderSources(list);
    await refreshProviderCheckboxes();
    sourceMsg.className = 'source-msg ok';
    sourceMsg.textContent = '已保存';
    document.getElementById('source-key').value = '';
  } catch (err) {
    sourceMsg.className = 'source-msg err';
    sourceMsg.textContent = '保存失败：' + (err.message || err);
  }
};

async function refreshProviderCheckboxes() {
  const list = await window.api.searchProviders();
  selectedProviders = list.map((p) => p.id);
  providerBox.innerHTML = '';
  for (const p of list) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.id = p.id;
    cb.addEventListener('change', () => {
      selectedProviders = [...providerBox.querySelectorAll('input')]
        .filter((el) => el.checked)
        .map((el) => el.dataset.id);
    });
    label.append(cb, document.createTextNode(p.label));
    providerBox.appendChild(label);
  }
}


// ---------- 本机自建索引 ----------

const localToggle = document.getElementById('local-index-toggle');
const localStatusEl = document.getElementById('local-index-status');

function renderLocalStatus(st) {
  if (!st) { localStatusEl.textContent = '状态未知'; localStatusEl.className = 'local-index-status'; return; }
  localToggle.checked = !!st.enabled;
  if (st.running) {
    const total = st.stats ? st.stats.total : 0;
    const ann = st.crawler ? st.crawler.announces : 0;
    localStatusEl.textContent = `运行中（127.0.0.1:${st.port}）· 已索引 ${total} 条 · announce ${ann}`;
    localStatusEl.className = 'local-index-status on';
  } else if (st.enabled) {
    localStatusEl.textContent = '已启用但未运行，稍等或重启应用';
    localStatusEl.className = 'local-index-status';
  } else {
    localStatusEl.textContent = '未启用';
    localStatusEl.className = 'local-index-status';
  }
}

async function refreshLocalIndex() {
  try { renderLocalStatus(await window.api.localIndexStatus()); } catch { /* ignore */ }
}

localToggle.addEventListener('change', async () => {
  localStatusEl.className = 'local-index-status';
  if (localToggle.checked) {
    localStatusEl.textContent = '启动中…';
    try {
      const r = await window.api.enableLocalIndex();
      if (!r.ok) {
        toast('本机索引启动失败：' + r.error, true);
        localStatusEl.textContent = '启动失败';
        localStatusEl.className = 'local-index-status err';
        localToggle.checked = false;
        return;
      }
      renderLocalStatus(r.status);
      await refreshProviderCheckboxes();
      toast('本机索引已启动，已加入搜索源');
    } catch (e) {
      toast('本机索引启动失败：' + (e.message || e), true);
      localToggle.checked = false;
    }
  } else {
    localStatusEl.textContent = '停止中…';
    try {
      const r = await window.api.disableLocalIndex();
      renderLocalStatus(r.status);
      await refreshProviderCheckboxes();
      toast('本机索引已停止');
    } catch (e) {
      toast('停止失败：' + (e.message || e), true);
    }
  }
});

setInterval(() => {
  if (!document.getElementById('sources-dialog').classList.contains('hidden')) refreshLocalIndex();
}, 3000);

window.api.onToast && window.api.onToast((msg) => toast(msg));
