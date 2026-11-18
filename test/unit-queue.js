// 队列/并发上限：maxConcurrent=2 时，第 3 个任务应排队而不是同时跑
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { TaskManager } = require('../src/tasks');

const SIZE = 3 * 1024 * 1024;
const payload = Buffer.alloc(SIZE, 5);

const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let a = 0, b = SIZE - 1, code = 200;
  if (m) { a = +m[1]; b = m[2] ? Math.min(+m[2], SIZE - 1) : SIZE - 1; code = 206; }
  const h = { 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' };
  if (code === 206) h['Content-Range'] = `bytes ${a}-${b}/${SIZE}`;
  res.writeHead(code, h);
  let pos = a;
  const tick = () => {              // 慢速吐数据，保证任务不会瞬间完成
    if (pos > b) { res.end(); return; }
    const to = Math.min(b, pos + 32 * 1024 - 1);
    res.write(payload.subarray(pos, to + 1));
    pos = to + 1;
    setTimeout(tick, 60);
  };
  tick();
  req.on('close', () => { pos = b + 1; });
});

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-q-'));
  const m = new TaskManager({ dir, options: { maxConcurrent: 2, connections: 1 }, onUpdate: () => {}, onError: () => {} });

  const t1 = await m.add(base + '/1.bin');
  const t2 = await m.add(base + '/2.bin');
  const t3 = await m.add(base + '/3.bin');
  await new Promise((r) => setTimeout(r, 800));

  const states = [t1, t2, t3].map((t) => m.get(t.id).state);
  console.log('STATES', JSON.stringify(states));
  const queuedOk = states.filter((s) => s === 'active').length <= 2 && states.includes('queued');

  // 暂停一个，队列应自动补位
  const activeOne = [t1, t2, t3].find((t) => m.get(t.id).state === 'active');
  m.pause(activeOne.id);
  await new Promise((r) => setTimeout(r, 600));
  const after = [t1, t2, t3].map((t) => m.get(t.id).state);
  console.log('AFTER_PAUSE', JSON.stringify(after));
  const pumpOk = after.includes('active') && !after.every((s) => s === 'queued');

  console.log(queuedOk && pumpOk ? 'UNIT_QUEUE_PASS' : 'UNIT_QUEUE_FAIL');
  clearInterval(m.timer);
  server.close();
  process.exit(0);
});
