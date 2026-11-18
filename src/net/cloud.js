'use strict';

// 网盘对接：阿里云盘（官方开放 API）与百度网盘（网页 API + Cookie）。
//
// 说明：
//   · 阿里云盘走官方 openapi，只需一个 refresh_token，最稳。token 由用户自己从
//     浏览器登录态或第三方工具导出，本程序不上传、只存本地（权限 600）。
//   · 百度网盘没有面向第三方的公开下载 API，这里用「网页版接口 + 你的 Cookie」，
//     属于个人自用范畴；百度对第三方客户端有风控，Cookie 过期或触发验证就需要重新拿。
//   · 夸克/115/天翼 没有可用接口，只能粘贴直链 + 自定义请求头（走通用 HTTP 下载）。

const DEFAULT_ENDPOINTS = {
  aliyun: 'https://openapi.alipan.com',
  baidu: 'https://pan.baidu.com'
};

const BAIDU_UA = 'pan.baidu.com';

class CloudError extends Error {}

async function jsonFetch(url, { method = 'GET', headers = {}, body, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error_description || data.error)) || text.slice(0, 120) || `HTTP ${res.status}`;
      throw new CloudError(`${res.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 阿里云盘 ----------

async function aliyunToken(refreshToken, endpoints = DEFAULT_ENDPOINTS) {
  if (!refreshToken) throw new CloudError('缺少 refresh_token');
  const data = await jsonFetch(`${endpoints.aliyun}/oauth/access_token`, {
    method: 'POST',
    body: { grant_type: 'refresh_token', refresh_token: refreshToken }
  });
  if (!data || !data.access_token) throw new CloudError('refresh_token 无效或已过期');
  return data.access_token;
}

async function aliyunDriveId(refreshToken, endpoints = DEFAULT_ENDPOINTS) {
  const token = await aliyunToken(refreshToken, endpoints);
  const info = await jsonFetch(`${endpoints.aliyun}/adrive/v1.0/user/getDriveInfo`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const driveId = (info && (info.resource_drive_id || info.default_drive_id || info.backup_drive_id)) || (info && info.drive_id);
  if (!driveId) throw new CloudError('这个账号没有可用云盘');
  return { token, driveId };
}

async function aliyunList(refreshToken, folderId = 'root', endpoints = DEFAULT_ENDPOINTS) {
  const { token, driveId } = await aliyunDriveId(refreshToken, endpoints);
  const res = await jsonFetch(`${endpoints.aliyun}/adrive/v2/file/list`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: { drive_id: driveId, parent_file_id: folderId, limit: 100, order_by: 'name', order_direction: 'ASC' }
  });
  const items = (res && res.items) || [];
  return items.map((x) => ({
    id: x.file_id,
    name: x.name,
    size: Number(x.size) || 0,
    type: x.type,                     // file | folder
    updatedAt: x.updated_at || null
  }));
}

async function aliyunDownloadUrl(refreshToken, fileId, endpoints = DEFAULT_ENDPOINTS) {
  const { token, driveId } = await aliyunDriveId(refreshToken, endpoints);
  const res = await jsonFetch(`${endpoints.aliyun}/adrive/v1.0/openFile/getDownloadUrl`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: { drive_id: driveId, file_id: fileId, expire_sec: 14400 }
  });
  const url = res && (res.url || (res.streams_quota && res.url));
  if (!url) throw new CloudError('没拿到下载地址');
  return { url, name: res.name || '', size: Number(res.size) || 0, expireSec: res.expiration || 14400 };
}

// ---------- 百度网盘 ----------

function baiduHeaders(cookie) {
  return {
    'User-Agent': BAIDU_UA,
    Cookie: String(cookie || '').trim(),
    Referer: 'https://pan.baidu.com/'
  };
}

async function baiduList(cookie, dir = '/', endpoints = DEFAULT_ENDPOINTS) {
  if (!cookie) throw new CloudError('缺少 Cookie');
  const url = `${endpoints.baidu}/api/list?dir=${encodeURIComponent(dir)}&web=1&num=100`;
  const res = await jsonFetch(url, { headers: baiduHeaders(cookie) });
  if (res && res.errno && res.errno !== 0) {
    throw new CloudError(`百度返回 errno=${res.errno}（Cookie 可能过期，或触发了安全验证）`);
  }
  return (res.list || []).map((x) => ({
    id: String(x.fs_id),
    name: x.server_filename,
    size: Number(x.size) || 0,
    type: x.isdir ? 'folder' : 'file',
    path: x.path
  }));
}

async function baiduDownloadUrl(cookie, fsIds, endpoints = DEFAULT_ENDPOINTS) {
  if (!cookie) throw new CloudError('缺少 Cookie');
  const ids = Array.isArray(fsIds) ? fsIds : [fsIds];
  const q = ids.map((id) => `fsids[]=${encodeURIComponent(id)}`).join('&');
  const url = `${endpoints.baidu}/rest/2.0/xpan/multimedia?method=filemetas&dlink=1&${q}`;
  const res = await jsonFetch(url, { headers: baiduHeaders(cookie) });
  if (res && res.errno && res.errno !== 0) {
    throw new CloudError(`百度返回 errno=${res.errno}`);
  }
  const item = (res.list || [])[0];
  if (!item || !item.dlink) throw new CloudError('没拿到下载直链（可能需要 VIP 或文件已被屏蔽）');
  // 百度的下载直链必须带 UA + Cookie + Referer，否则 403
  return { url: item.dlink, name: item.filename, size: Number(item.size) || 0, headers: baiduHeaders(cookie) };
}

module.exports = {
  DEFAULT_ENDPOINTS,
  CloudError,
  aliyunToken,
  aliyunDriveId,
  aliyunList,
  aliyunDownloadUrl,
  baiduList,
  baiduDownloadUrl,
  baiduHeaders
};
