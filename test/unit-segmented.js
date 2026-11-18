// 多连接分段下载：起一个限速的本地服务器，验证分段确实更快且内容正确
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadToFile, downloadToFileSegmented } = require('../src/net/http');

const SIZE = 8 * 1024 * 1024;
const payload = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) payload[i] = (i * 7) % 251;

// 每个连接限速 512KB/s，模拟"服务器按连接限速"
function makeServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      let start = 0, end = SIZE - 1;
      let status = 200;
      if (range) {
        start = parseInt(range[1], 10);
        end = range[2] ? Math.min(parseInt(range[2], 10), SIZE - 1) : SIZE - 1;
        status = 206;
      }
      const len = end - start + 1;
      const headers = { 'Content-Length': len, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${SIZE}`;
      res.writeHead(status, headers);
      // 分片发送并限速
      let pos = start;
      const CHUNK = 16 * 1024;
      const tick = () => {
        if (pos > end) { res.end(); return; }
        const to = Math.min(end, pos + CHUNK - 1);
        res.write(payload.subarray(pos, to + 1));
        pos = to + 1;
        setTimeout(tick, 16);   // 16KB / 16ms ≈ 1MB/s 每连接
      };
      tick();
      req.on('close', () => { pos = end + 1; });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await makeServer();
  const url = `http://127.0.0.1:${server.address().port}/big.bin`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-seg-'));

  const t0 = Date.now();
  await downloadToFile({ url, filePath: path.join(dir, 'single.bin') });
  const singleMs = Date.now() - t0;

  const t1 = Date.now();
  const r = await downloadToFileSegmented({ url, filePath: path.join(dir, 'multi.bin'), connections: 8 });
  const multiMs = Date.now() - t1;

  const a = fs.readFileSync(path.join(dir, 'single.bin'));
  const b = fs.readFileSync(path.join(dir, 'multi.bin'));
  const same = a.length === b.length && a.equals(b);
  console.log(`SINGLE ${singleMs}ms | MULTI ${multiMs}ms | speedup ${(singleMs / multiMs).toFixed(1)}x | 连接 ${r.connections}`);
  console.log('CONTENT', same ? 'identical' : 'MISMATCH', '| size', b.length, '/', SIZE);
  console.log(same && r.segmented && multiMs < singleMs ? 'UNIT_SEGMENTED_PASS' : 'UNIT_SEGMENTED_FAIL');
  server.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
