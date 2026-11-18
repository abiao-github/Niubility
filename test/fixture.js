// 测试用的固定种子内容：确定性字节，便于校验下载结果。
// 每次运行都会重建（内容相同，piece hash 也就相同）。
const fs = require('fs');
const path = require('path');
const os = require('os');

const PAYLOAD_DIR = path.join(os.tmpdir(), 'mt-e2e-payload');

function makeFixture({ big = 307200, small = 100000 } = {}) {
  fs.rmSync(PAYLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
  const bigBuf = Buffer.alloc(big);
  for (let i = 0; i < bigBuf.length; i++) bigBuf[i] = i % 251;
  const smallBuf = Buffer.alloc(small);
  for (let i = 0; i < smallBuf.length; i++) smallBuf[i] = (i * 7) % 253;
  fs.writeFileSync(path.join(PAYLOAD_DIR, 'big.bin'), bigBuf);
  fs.writeFileSync(path.join(PAYLOAD_DIR, 'hello.txt'), smallBuf);
  return { dir: PAYLOAD_DIR, big: bigBuf.length, small: smallBuf.length };
}

module.exports = { makeFixture, PAYLOAD_DIR };
