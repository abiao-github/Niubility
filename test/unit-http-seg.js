// 校验：分段下载 + 限速器 都能工作
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { downloadToFileSegmented } = require('../src/net/http');

const SIZE = 2 * 1024 * 1024;
const payload = Buffer.alloc(SIZE, 3);

const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = SIZE - 1, status = 200;
  if (m) { start = +m[1]; end = m[2] ? Math.min(+m[2], SIZE - 1) : SIZE - 1; status = 206; }
  const headers = { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${SIZE}`;
  res.writeHead(status, headers);
  res.end(payload.subarray(start, end + 1));
});

server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/f.bin`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-seg2-'));
  const file = path.join(dir, 'out.bin');

  let throttled = 0;
  const t0 = Date.now();
  const r = await downloadToFileSegmented({
    url, filePath: file, connections: 4, minSize: 256 * 1024,
    throttle: async (n) => { throttled += n; }
  });
  const ms = Date.now() - t0;
  const ok = fs.readFileSync(file).equals(payload) && r.segmented && throttled === SIZE;
  console.log(`RESULT segmented=${r.segmented} conns=${r.connections} ${ms}ms throttled=${throttled}`);
  console.log(ok ? 'UNIT_HTTP_SEG_PASS' : 'UNIT_HTTP_SEG_FAIL');
  server.close(); process.exit(0);
});
