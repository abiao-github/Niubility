'use strict';

// DHT 爬虫：
//   1) 跑一个 DHT 节点，监听 announce_peer / get_peers，收集 infohash；
//   2) 对 announce 的来源 peer 直接做 BEP-9 元数据交换（bittorrent-protocol + ut_metadata），
//      拿到名字和大小；用 sha1(metadata) 校验 infohash，防投毒；
//   3) 写进索引。
//
// 没有用 webtorrent：它带 node-datachannel（WebRTC）这类需要本地编译的原生依赖，
// 服务器上没有编译工具链，而且爬虫根本用不到 WebRTC。

import crypto from 'node:crypto';
import net from 'node:net';
import DHT from 'bittorrent-dht';
import Protocol from 'bittorrent-protocol';
import utMetadata from 'ut_metadata';
import bencode from 'bencode';

const PEER_ID = Buffer.concat([Buffer.from('-NB0100-'), crypto.randomBytes(12)]);

// bittorrent-dht v11 内部用 Uint8Array，事件里给的不一定是 Node Buffer —— 统一转 hex
function toHex(value) {
  if (!value) return null;
  if (typeof value === 'string') return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
  const bytes = Buffer.isBuffer(value) ? value : (value instanceof Uint8Array ? Buffer.from(value) : null);
  return bytes && bytes.length === 20 ? bytes.toString('hex') : null;
}

// ut_metadata 不同版本的事件负载不一样：
//   v4（webtorrent 用的）发的是 bencode.encode({ info: <info dict> })
//   v5 可能直接发 info dict 本体
// 两种都兼容，并统一取出 info dict 的原始字节（infohash 就是它的 sha1）
function extractInfo(raw) {
  const decoded = bencode.decode(raw);
  if (decoded && decoded.info) {
    return { info: decoded.info, infoBuf: bencode.encode(decoded.info) };
  }
  return { info: decoded, infoBuf: raw };
}

// bencode v4 返回的是 Uint8Array，不是 Node Buffer，必须显式转
function toText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value);
}

function parseMetadata(raw) {
  const info = bencode.decode(raw);
  if (!info || !info.name) return null;
  const name = toText(info.name);
  let size = Number(info.length) || 0;
  let files = 0;
  if (info.files) {
    files = info.files.length;
    size = 0;
    for (const f of info.files) size += Number(f.length) || 0;
  } else {
    files = 1;
  }
  return { name, size, files };
}

/** BEP-9：连到 peer，握手后请求 metadata，校验 infohash */
function fetchMetadataFromPeer(infohashHex, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const infoHashBuf = Buffer.from(infohashHex, 'hex');
    const socket = net.connect({ host, port });
    const wire = new Protocol();
    let done = false;

    const cleanup = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { wire.destroy(); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(value);
    };

    const timer = setTimeout(() => cleanup(new Error('metadata timeout')), timeoutMs);

    socket.on('error', (err) => cleanup(err));
    socket.setTimeout(timeoutMs, () => cleanup(new Error('socket timeout')));

    socket.pipe(wire).pipe(socket);
    wire.use(utMetadata());
    wire.on('error', (err) => cleanup(err));

    wire.on('handshake', () => {
      try { wire.ut_metadata.fetch(); } catch (err) { cleanup(err); }
    });

    wire.ut_metadata.on('metadata', (raw) => {
      try {
        const { info, infoBuf } = extractInfo(raw);
        const actual = crypto.createHash('sha1').update(infoBuf).digest('hex');
        if (actual !== infohashHex) {
          return cleanup(new Error(`infohash 校验失败（得到 ${actual.slice(0, 8)}，期望 ${infohashHex.slice(0, 8)}）`));
        }
        const meta = parseMetadata(infoBuf);
        if (!meta || !meta.name) return cleanup(new Error('metadata 无法解析'));
        cleanup(null, meta);
      } catch (err) {
        cleanup(err);
      }
    });
    wire.ut_metadata.on('warning', () => { /* 对端没有 ut_metadata，等超时 */ });

    try {
      wire.handshake(infoHashBuf, PEER_ID, { dht: true });
    } catch (err) {
      cleanup(err);
    }
  });
}

class Crawler {
  constructor({ store, port = 6881, maxFetching = 8, fetchTimeout = 20000, log = () => {} }) {
    this.store = store;
    this.port = port;
    this.maxFetching = maxFetching;
    this.fetchTimeout = fetchTimeout;
    this.log = log;

    this.dht = null;
    this.queue = [];
    this.queued = new Set();
    this.fetching = 0;
    this.failed = new Set();
    this.startedAt = Date.now();
    this.stats = { announces: 0, queries: 0, fetched: 0, failed: 0, dhtNodes: 0, noPeer: 0, lookups: 0 };
    this.failures = [];   // 最近若干次失败的原因，方便诊断
    this.debug = { enqueue: 0, queued: 0, skipNamed: 0, skipDup: 0, skipFail: 0, skipNoHex: 0, samples: [] };
  }

  start() {
    // bittorrent-dht v11：构造函数里会自动 bootstrap，收查询靠 client 的事件
    this.dht = new DHT({ concurrency: 16, maxTables: 2000 });
    this.dht.on('ready', () => {
      this.log('[crawler] DHT ready');
      this.seedPresence(12);            // 先把自己塞进一批节点的路由表
    });

    // 有些实现走 announce 事件，两个都收
    this.dht.on('announce', (peer, infoHash) => {
      this.stats.queries += 1;
      this.stats.announces += 1;
      const hex = toHex(infoHash);
      if (hex) this.enqueue(hex, peer && peer.host, peer && peer.port);
    });
    this.dht.on('error', (err) => this.log('[crawler] DHT error: ' + err.message));

    // 有人宣告「我要下载某个种子」—— 这是爬虫最重要的信号
    this.dht.on('announce_peer', (infoHash, peer) => {
      this.stats.queries += 1;
      this.stats.announces += 1;
      const hex = toHex(infoHash);
      if (hex) this.enqueue(hex, peer && peer.host, peer && peer.port);
    });

    // 有人查询某个种子的 peer —— 同样说明这个种子是活跃的
    this.dht.on('get_peers', (infoHash) => {
      this.stats.queries += 1;
      const hex = toHex(infoHash);
      if (!hex) return;
      this.store.touch(hex, 1);
      // get_peers 说明这个种子正在被寻找 —— 也值得抓一次元数据（没有来源 peer，靠 lookup 找）
      this.enqueue(hex, null, null);
      this.bumpNodes();
    });

    this.dht.listen(this.port, () => {
      this.log('[crawler] DHT 监听 UDP ' + this.dht.address().port);
    });

    // 让别人把我们放进路由表：对随机目标做 lookup（v11 没有公开的 find_node）
    this.maintainTimer = setInterval(() => {
      this.seedPresence(3);
      this.bumpNodes();
    }, 5000);

    // 每分钟打一行状态，方便确认爬虫真的在动
    this.reportTimer = setInterval(() => {
      this.bumpNodes();
      const st = this.statsSnapshot();
      this.log(`[crawler] nodes=${st.dhtNodes} queries=${st.queries} announces=${st.announces} fetched=${st.fetched} failed=${st.failed} queue=${st.queue} indexed=${this.store.size}`);
    }, 60000);

    this.pumpTimer = setInterval(() => this.pump(), 400);
  }

  seedPresence(times) {
    for (let i = 0; i < times; i++) {
      try { this.dht.lookup(crypto.randomBytes(20), () => {}); } catch { /* ignore */ }
    }
  }

  bumpNodes() {
    try {
      if (!this.dht) { this.stats.dhtNodes = 0; return; }
      if (Array.isArray(this.dht.nodes)) { this.stats.dhtNodes = this.dht.nodes.length; return; }
      const snap = this.dht.toJSON ? this.dht.toJSON() : null;
      this.stats.dhtNodes = snap && Array.isArray(snap.nodes) ? snap.nodes.length : 0;
    } catch { this.stats.dhtNodes = 0; }
  }

  enqueue(infoHash, host, port) {
    this.debug.enqueue += 1;
    const hex = toHex(infoHash);
    if (!hex) { this.debug.skipNoHex += 1; return; }
    this.store.touch(hex, 1);
    const entry = this.store.map.get(hex);
    if (entry && entry.name) { this.debug.skipNamed += 1; return; }
    if (!host || !port) this.stats.noPeer += 1;
    if (this.failed.has(hex)) { this.debug.skipFail += 1; return; }
    if (this.queued.has(hex)) { this.debug.skipDup += 1; return; }
    this.queued.add(hex);
    this.queue.push({ hex, host: host || null, port: port || null });
    this.debug.queued += 1;
    if (this.debug.samples.length < 5) this.debug.samples.push({ hex: hex.slice(0, 8), host, port });
  }

  /** 对某个 infohash 做一次 DHT lookup，收集 peer 列表 */
  lookupPeers(hex, waitMs = 7000) {
    return new Promise((resolve) => {
      const wanted = hex.toLowerCase();
      const peers = [];
      const seen = new Set();
      const onPeer = (peer, infoHash) => {
        try {
          if (infoHash && infoHash.toString('hex').toLowerCase() !== wanted) return;
          const key = peer.host + ':' + peer.port;
          if (seen.has(key) || peers.length >= 8) return;
          seen.add(key);
          peers.push(peer);
        } catch { /* ignore */ }
      };
      this.stats.lookups += 1;
      this.dht.on('peer', onPeer);
      const finish = () => {
        clearTimeout(timer);
        this.dht.removeListener('peer', onPeer);
        resolve(peers);
      };
      const timer = setTimeout(finish, waitMs);
      try {
        this.dht.lookup(Buffer.from(hex, 'hex'), finish);
      } catch {
        finish();
      }
    });
  }

  recordFailure(hex, peer, reason) {
    this.failures.push({ hex: hex.slice(0, 8), peer: peer ? peer.host + ':' + peer.port : '?', reason: String(reason || '').slice(0, 120) });
    if (this.failures.length > 20) this.failures.shift();
  }

  pump() {
    while (this.fetching < this.maxFetching && this.queue.length) {
      const item = this.queue.shift();
      this.queued.delete(item.hex);
      // 没有来源 peer 的（来自 get_peers）也要继续：attemptFetch 会先用 lookup 找 peer
      if (this.failed.has(item.hex)) continue;
      this.fetching += 1;
      this.attemptFetch(item)
        .then((meta) => {
          if (meta) {
            this.stats.fetched += 1;
            this.store.upsert({ infohash: item.hex, ...meta });
          } else {
            this.stats.failed += 1;
            this.failed.add(item.hex);
          }
        })
        .catch(() => {
          this.stats.failed += 1;
          this.failed.add(item.hex);
        })
        .finally(() => { this.fetching -= 1; });
    }
  }

  /** 先试 announce 来源，再靠 DHT lookup 找几个 peer 重试 */
  async attemptFetch(item) {
    const tried = new Set();
    const tryPeer = async (host, port) => {
      const key = host + ':' + port;
      if (!host || !port || tried.has(key)) return null;
      tried.add(key);
      try {
        return await fetchMetadataFromPeer(item.hex, host, port, this.fetchTimeout);
      } catch (err) {
        this.recordFailure(item.hex, { host, port }, err.message);
        return null;
      }
    };

    const first = item.host ? await tryPeer(item.host, item.port) : null;
    if (first) return first;

    // 失败一次后，用 lookup 补几个 peer 再试（最多 3 个，避免拖太久）
    const peers = await this.lookupPeers(item.hex);
    let attempts = 0;
    for (const peer of peers) {
      if (attempts >= 6) break;
      attempts += 1;
      const meta = await tryPeer(peer.host, peer.port);
      if (meta) return meta;
    }
    return null;
  }

  statsSnapshot() {
    return {
      ...this.stats,
      queue: this.queue.length,
      fetching: this.fetching,
      failedTotal: this.failed.size,
      failures: this.failures.slice(-5),
      debug: this.debug,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000)
    };
  }

  async stop() {
    clearInterval(this.maintainTimer);
    clearInterval(this.pumpTimer);
    clearInterval(this.reportTimer);
    if (this.dht) await new Promise((r) => this.dht.destroy(r));
  }
}

export { Crawler, fetchMetadataFromPeer, parseMetadata };
