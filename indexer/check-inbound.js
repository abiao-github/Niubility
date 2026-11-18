'use strict';

// 诊断：从任意机器向索引服务的 DHT 端口发一个原始 ping，确认入站 UDP 是否通。
// 用法：node check-inbound.js <公网IP或域名> [端口]
// 如果打印 NO_REPLY，说明 NAT/防火墙挡住了入站，爬虫只能收到极少量 announce。

import dgram from 'node:dgram';
import crypto from 'node:crypto';

const host = process.argv[2];
const port = Number(process.argv[3] || 6881);
if (!host) {
  console.error('用法: node check-inbound.js <host> [port]');
  process.exit(1);
}

const id = crypto.randomBytes(20);
// d1:ad2:id20:<20 bytes>e1:q4:ping1:t2:aa1:y1:qe
const packet = Buffer.concat([Buffer.from('d1:ad2:id20:'), id, Buffer.from('e1:q4:ping1:t2:aa1:y1:qe')]);

const sock = dgram.createSocket('udp4');
let answered = false;
sock.on('message', (buf) => {
  const s = buf.toString('latin1');
  if (s.startsWith('d') && s.includes('1:y1:r')) answered = true;
});
sock.send(packet, port, host, (err) => {
  if (err) {
    console.error('发送失败: ' + err.message);
    process.exit(1);
  }
  console.log(`已向 ${host}:${port}/udp 发送 DHT ping，等待 6 秒…`);
});
setTimeout(() => {
  if (answered) {
    console.log('REACHABLE：收到了 pong，入站 UDP 正常，爬虫应该能看到大量 announce');
  } else {
    console.log('NO_REPLY：没有回应。多半是防火墙/NAT 挡住了入站 UDP，');
    console.log('          需要在服务器上放行该端口，例如：sudo ufw allow 6881/udp');
  }
  sock.close();
  process.exit(answered ? 0 : 2);
}, 6000);
