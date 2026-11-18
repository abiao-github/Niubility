// 对比：固定切段 vs 分块队列（工作窃取），用"连接速度不均"的服务器模拟真实限速场景
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { downloadToFileSegmented, downloadToFileChunked } = require('../src/net/http');

const SIZE = 12 * 1024 * 1024;
const payload = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) payload[i] = (i * 13) % 251;

// 每个连接随机分配速度：有的 1MB/s，有的 150KB/s —— 固定切段会被慢连接拖住
const server = http.createServer((req, res) => {
  if (req.method === 'HEAD') {   // HEAD 只回头，不能写正文，否则会拖住客户端
    res.writeHead(200, { 'Content-Length': SIZE, 'Accept-Ranges': 'bytes' });
    res.end();
    return;
  }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let a = 0, b = SIZE - 1, code = 200;
  if (m) { a = +m[1]; b = m[2] ? Math.min(+m[2], SIZE - 1) : SIZE - 1; code = 206; }
  const h = { 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' };
  if (code === 206) h['Content-Range'] = `bytes ${a}-${b}/${SIZE}`;
  res.writeHead(code, h);

  const slow = Math.random() < 0.5;                 // 一半连接很慢
  const perTick = slow ? 24 * 1024 : 160 * 1024;    // 每 40ms 发多少
  let pos = a;
  const tick = () => {
    if (pos > b) { res.end(); return; }
    const to = Math.min(b, pos + perTick - 1);
    res.write(payload.subarray(pos, to + 1));
    pos = to + 1;
    setTimeout(tick, 40);
  };
  tick();
  req.on('close', () => { pos = b + 1; });
});

server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/big.bin`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-chunk-'));

  const t1 = Date.now();
  const r1 = await downloadToFileSegmented({ url, filePath: path.join(dir, 'fixed.bin'), connections: 8 });
  const fixedMs = Date.now() - t1;

  const t2 = Date.now();
  const r2 = await downloadToFileChunked({ url, filePath: path.join(dir, 'chunk.bin'), connections: 8 });
  const chunkMs = Date.now() - t2;

  const a = fs.readFileSync(path.join(dir, 'fixed.bin'));
  const b = fs.readFileSync(path.join(dir, 'chunk.bin'));
  const same = a.length === b.length && a.equals(b) && a.length === SIZE;

  console.log(`FIXED ${fixedMs}ms  |  CHUNKED ${chunkMs}ms  |  ${(fixedMs / chunkMs).toFixed(2)}x faster  |  块数 ${r2.chunks}`);
  console.log('CONTENT', same ? 'identical' : 'MISMATCH');
  console.log(same && r2.segmented ? 'UNIT_CHUNKED_PASS' : 'UNIT_CHUNKED_FAIL');
  server.close();
  process.exit(0);
});
