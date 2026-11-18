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
function fetchMetadataFromPeer(infohashHex, host, port, timeoutMs, opts = {}) {
  const { signal, connectTimeoutMs = Math.min(5000, timeoutMs) } = opts;
  return new Promise((resolve, reject) => {
    const infoHashBuf = Buffer.from(infohashHex, 'hex');
    const socket = net.connect({ host, port });
    const wire = new Protocol();
    let done = false;
    // 失败阶段：connect（没连上）→ handshake（连上了但没握手）→ metadata（握手了但没给元数据）
    let stage = 'connect';

    const cleanup = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { wire.destroy(); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      if (err) { err.stage = err.stage || stage; reject(err); } else resolve(value);
    };
    const onAbort = () => cleanup(new Error('aborted'));
    if (signal) {
      if (signal.aborted) { queueMicrotask(onAbort); } else signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => cleanup(new Error('metadata timeout')), timeoutMs);
    const connectTimer = setTimeout(() => cleanup(new Error('connect timeout')), connectTimeoutMs);
    socket.on('connect', () => { clearTimeout(connectTimer); stage = 'handshake'; });

    socket.on('error', (err) => cleanup(err));
    socket.setTimeout(timeoutMs, () => cleanup(new Error('socket timeout')));

    socket.pipe(wire).pipe(socket);
    wire.use(utMetadata());
    wire.on('error', (err) => cleanup(err));

    wire.on('handshake', () => {
      stage = 'metadata';
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

const FAIL_TTL_MS = 6 * 3600 * 1000;   // 失败过的哈希 6 小时后允许重试
const FAIL_MAX = 200000;               // 失败记录上限，防止内存无限增长
const LOOKUP_QUEUE_MAX = 5000;         // 没有来源 peer 的待抓队列上限，超出丢弃最旧的
const PEERS_PER_HASH = 8;              // 对同一个哈希并发尝试的 peer 数

class Crawler {
  constructor({ store, port = 6881, nodeId = null, recvBufferBytes = 8 * 1024 * 1024, maxFetching = 16, fetchTimeout = 12000, log = () => {} }) {
    this.store = store;
    this.port = port;
    this.nodeId = nodeId;
    this.recvBufferBytes = recvBufferBytes;
    this.maxFetching = maxFetching;
    this.fetchTimeout = fetchTimeout;
    this.log = log;

    this.dht = null;
    this.hotQueue = [];      // 带来源 peer（announce_peer）的优先队列
    this.queue = [];         // 没有来源 peer（get_peers）的队列，需要先 lookup
    this.queued = new Set();
    this.fetching = 0;
    this.failed = new Map(); // hex -> 失败时间
    this.startedAt = Date.now();
    this.stats = { announces: 0, queries: 0, fetched: 0, failed: 0, dhtNodes: 0, noPeer: 0, lookups: 0, lookupHit: 0 };
    this.failStages = {};  // 失败阶段/原因计数：看是连不上、握手不了还是对端不给元数据
    this.failures = [];   // 最近若干次失败的原因，方便诊断
    this.debug = { enqueue: 0, queued: 0, skipNamed: 0, skipDup: 0, skipFail: 0, skipNoHex: 0, samples: [] };
  }

  start() {
    // bittorrent-dht v11：构造函数里会自动 bootstrap，收查询靠 client 的事件
    this.dht = new DHT({ concurrency: 16, maxTables: 2000, ...(this.nodeId ? { nodeId: this.nodeId } : {}) });
    this.dht.setMaxListeners(0);   // 每个 lookup 都会挂一个 peer 监听
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
      this.enlargeRecvBuffer();
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

  /** 内核默认的 UDP 接收缓冲区很小，突发流量会被直接丢弃；实际大小受 net.core.rmem_max 限制 */
  enlargeRecvBuffer() {
    try {
      const sock = this.dht._rpc && this.dht._rpc.socket;
      if (!sock || typeof sock.setRecvBufferSize !== 'function') return;
      sock.setRecvBufferSize(this.recvBufferBytes);
      this.log(`[crawler] UDP 接收缓冲 ${sock.getRecvBufferSize()} 字节`);
    } catch (err) {
      this.log('[crawler] 无法调整 UDP 接收缓冲: ' + err.message);
    }
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
    // announce 带来的真实 peer 值得重试，即使之前仅凭 lookup 失败过
    if (!(host && port) && this.isFailed(hex)) { this.debug.skipFail += 1; return; }
    if (this.queued.has(hex)) { this.debug.skipDup += 1; return; }
    this.queued.add(hex);
    if (host && port) {
      this.hotQueue.push({ hex, host, port });
    } else {
      this.queue.push({ hex, host: null, port: null });
      while (this.queue.length > LOOKUP_QUEUE_MAX) this.queued.delete(this.queue.shift().hex);
    }
    this.debug.queued += 1;
    if (this.debug.samples.length < 5) this.debug.samples.push({ hex: hex.slice(0, 8), host, port });
  }

  isFailed(hex) {
    const at = this.failed.get(hex);
    if (at === undefined) return false;
    if (Date.now() - at > FAIL_TTL_MS) { this.failed.delete(hex); return false; }
    return true;
  }

  markFailed(hex) {
    this.failed.set(hex, Date.now());
    if (this.failed.size > FAIL_MAX) this.failed.delete(this.failed.keys().next().value);
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
          if (seen.has(key) || peers.length >= 16) return;
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

  recordFailure(hex, peer, err) {
    const reason = String((err && err.message) || err || '');
    const bucket = (err && err.code) || reason;
    const key = (err && err.stage ? err.stage + ':' : '') + String(bucket).slice(0, 40);
    this.failStages[key] = (this.failStages[key] || 0) + 1;
    this.failures.push({ hex: hex.slice(0, 8), peer: peer ? peer.host + ':' + peer.port : '?', reason: reason.slice(0, 120), stage: err && err.stage });
    if (this.failures.length > 20) this.failures.shift();
  }

  next() {
    return this.hotQueue.shift() || this.queue.shift();
  }

  pump() {
    while (this.fetching < this.maxFetching && (this.hotQueue.length || this.queue.length)) {
      const item = this.next();
      this.queued.delete(item.hex);
      if (!item.host && this.isFailed(item.hex)) continue;
      const known = this.store.map.get(item.hex);
      if (known && known.name) continue;
      this.fetching += 1;
      this.attemptFetch(item)
        .then((meta) => {
          if (meta) {
            this.stats.fetched += 1;
            this.store.upsert({ infohash: item.hex, ...meta });
          } else {
            this.stats.failed += 1;
            this.markFailed(item.hex);
          }
        })
        .catch(() => {
          this.stats.failed += 1;
          this.markFailed(item.hex);
        })
        .finally(() => { this.fetching -= 1; });
    }
  }

  /** 先试 announce 来源 peer；不行就 DHT lookup，并发尝试多个 peer，先拿到的为准 */
  async attemptFetch(item) {
    const tried = new Set();
    const ac = new AbortController();
    const run = async (peer, timeout) => {
      const key = peer.host + ':' + peer.port;
      if (!peer.host || !peer.port || tried.has(key)) return null;
      tried.add(key);
      try {
        return await fetchMetadataFromPeer(item.hex, peer.host, peer.port, timeout, { signal: ac.signal });
      } catch (err) {
        if (err.message !== 'aborted') this.recordFailure(item.hex, peer, err);
        return null;
      }
    };

    if (item.host) {
      const first = await run({ host: item.host, port: item.port }, this.fetchTimeout);
      if (first) return first;
    }

    const found = await this.lookupPeers(item.hex);
    const batch = found.filter((p) => !tried.has(p.host + ':' + p.port)).slice(0, PEERS_PER_HASH);
    if (!batch.length) { this.stats.noPeer += 1; return null; }
    this.stats.lookupHit += 1;

    return new Promise((resolve) => {
      let pending = batch.length;
      let settled = false;
      for (const peer of batch) {
        run(peer, this.fetchTimeout).then((meta) => {
          pending -= 1;
          if (settled) return;
          if (meta) { settled = true; ac.abort(); resolve(meta); } else if (pending === 0) resolve(null);
        });
      }
    });
  }

  statsSnapshot() {
    return {
      ...this.stats,
      queue: this.queue.length + this.hotQueue.length,
      hotQueue: this.hotQueue.length,
      fetching: this.fetching,
      failedTotal: this.failed.size,
      failStages: this.failStages,
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
