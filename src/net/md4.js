'use strict';

// MD4（RFC 1320）纯 JS 实现。
// 为什么自己写：Node 22+/OpenSSL 3 默认不再提供 MD4，`crypto.createHash('md4')`
// 会抛 ERR_OSSL_EVP_UNSUPPORTED，而 eD2K 的链接哈希就是 MD4。

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

const O2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
const O3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];

function md4(input) {
  const msg = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const bitLen = msg.length * 8;
  const padded = (((msg.length + 8) >> 6) + 1) << 6; // 至少留 8 字节写长度
  const buf = Buffer.alloc(padded);
  msg.copy(buf);
  buf[msg.length] = 0x80;
  buf.writeUInt32LE(bitLen >>> 0, padded - 8);
  buf.writeUInt32LE(Math.floor(bitLen / 0x100000000) >>> 0, padded - 4);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const F = (x, y, z) => ((x & y) | (~x & z)) >>> 0;
  const G = (x, y, z) => ((x & y) | (x & z) | (y & z)) >>> 0;
  const H = (x, y, z) => (x ^ y ^ z) >>> 0;

  const X = new Array(16);
  for (let off = 0; off < padded; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = buf.readUInt32LE(off + i * 4);

    let A = a;
    let B = b;
    let C = c;
    let D = d;

    for (let i = 0; i < 16; i += 4) {
      A = rotl((A + F(B, C, D) + X[i]) >>> 0, 3);
      D = rotl((D + F(A, B, C) + X[i + 1]) >>> 0, 7);
      C = rotl((C + F(D, A, B) + X[i + 2]) >>> 0, 11);
      B = rotl((B + F(C, D, A) + X[i + 3]) >>> 0, 19);
    }

    for (let i = 0; i < 16; i += 4) {
      A = rotl((A + G(B, C, D) + X[O2[i]] + 0x5a827999) >>> 0, 3);
      D = rotl((D + G(A, B, C) + X[O2[i + 1]] + 0x5a827999) >>> 0, 5);
      C = rotl((C + G(D, A, B) + X[O2[i + 2]] + 0x5a827999) >>> 0, 9);
      B = rotl((B + G(C, D, A) + X[O2[i + 3]] + 0x5a827999) >>> 0, 13);
    }

    for (let i = 0; i < 16; i += 4) {
      A = rotl((A + H(B, C, D) + X[O3[i]] + 0x6ed9eba1) >>> 0, 3);
      D = rotl((D + H(A, B, C) + X[O3[i + 1]] + 0x6ed9eba1) >>> 0, 9);
      C = rotl((C + H(D, A, B) + X[O3[i + 2]] + 0x6ed9eba1) >>> 0, 11);
      B = rotl((B + H(C, D, A) + X[O3[i + 3]] + 0x6ed9eba1) >>> 0, 15);
    }

    a = (a + A) >>> 0;
    b = (b + B) >>> 0;
    c = (c + C) >>> 0;
    d = (d + D) >>> 0;
  }

  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0);
  out.writeUInt32LE(b, 4);
  out.writeUInt32LE(c, 8);
  out.writeUInt32LE(d, 12);
  return out;
}

function md4Hex(input) {
  return md4(input).toString('hex');
}

module.exports = md4;
module.exports.md4 = md4;
module.exports.md4Hex = md4Hex;
