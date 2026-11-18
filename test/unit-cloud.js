// 网盘对接：用本地 mock 服务器模拟阿里云盘 / 百度的接口形状
const http = require('http');
const cloud = require('../src/net/cloud');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  // 阿里云盘
  if (u.pathname === '/oauth/access_token') return send(200, { access_token: 'tok-123' });
  if (u.pathname === '/adrive/v1.0/user/getDriveInfo') {
    if (req.headers.authorization !== 'Bearer tok-123') return send(401, { message: 'bad token' });
    return send(200, { resource_drive_id: 'drive-1' });
  }
  if (u.pathname === '/adrive/v2/file/list') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      if (json.drive_id !== 'drive-1') return send(400, { message: 'no drive' });
      send(200, { items: [
        { file_id: 'f1', name: '电影.mkv', size: 1024, type: 'file' },
        { file_id: 'd1', name: '剧集', size: 0, type: 'folder' }
      ] });
    });
    return;
  }
  if (u.pathname === '/adrive/v1.0/openFile/getDownloadUrl') {
    return send(200, { url: 'https://cdn.alipan.test/f1.mkv', name: '电影.mkv', size: 1024 });
  }

  // 百度
  if (u.pathname === '/api/list') {
    if (!/BDUSS=/.test(req.headers.cookie || '')) return send(200, { errno: -6, list: [] });
    return send(200, { errno: 0, list: [{ fs_id: 42, server_filename: 'a.iso', size: 2048, isdir: 0, path: '/a.iso' }] });
  }
  if (u.pathname === '/rest/2.0/xpan/multimedia') {
    if (!/BDUSS=/.test(req.headers.cookie || '')) return send(200, { errno: -6 });
    return send(200, { errno: 0, list: [{ fs_id: 42, filename: 'a.iso', size: 2048, dlink: 'https://d.pcs.baidu.com/file/42' }] });
  }
  send(404, { message: 'not found' });
});

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoints = { aliyun: base, baidu: base };
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };

  try {
    const tok = await cloud.aliyunToken('rt-1', endpoints);
    check('阿里云盘 换 token', tok === 'tok-123');

    const list = await cloud.aliyunList('rt-1', 'root', endpoints);
    check('阿里云盘 列目录', list.length === 2 && list[0].name === '电影.mkv', JSON.stringify(list.map(x => x.name)));

    const dl = await cloud.aliyunDownloadUrl('rt-1', 'f1', endpoints);
    check('阿里云盘 取直链', /alipan\.test/.test(dl.url));

    const bad = await cloud.baiduList('', '/', endpoints).then(() => null).catch((e) => e);
    check('百度 无 Cookie 报错', !!bad && /缺少 Cookie/.test(bad.message));

    const blist = await cloud.baiduList('BDUSS=abc', '/', endpoints);
    check('百度 列目录', blist.length === 1 && blist[0].name === 'a.iso');

    const bdl = await cloud.baiduDownloadUrl('BDUSS=abc', [42], endpoints);
    check('百度 取直链 + 必需请求头', /pcs\.baidu/.test(bdl.url) && bdl.headers['User-Agent'] === 'pan.baidu.com' && /BDUSS/.test(bdl.headers.Cookie));
  } catch (e) {
    fail++; console.log('✗ 异常', e.message);
  }

  console.log(pass && !fail ? 'UNIT_CLOUD_PASS' : 'UNIT_CLOUD_FAIL');
  server.close();
  process.exit(0);
});
