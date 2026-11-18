// 验证 BEP-9 元数据交换：用本地 webtorrent 做种端当「真实 peer」，
// 让索引服务的 fetchMetadataFromPeer 去连它，确认能拿到名字和大小。
// 运行：node test/unit-metadata.mjs
import { once } from 'node:events';
import path from 'node:path';
import assert from 'node:assert';
import WebTorrent from 'webtorrent';
import { makeFixture } from './fixture.js';

await (async () => {
  const fixture = makeFixture();
  const seeder = new WebTorrent({ dht: false, utp: false });
  await once(seeder, 'listening');
  const port = seeder.address().port;
  const torrent = await new Promise((r) => seeder.seed(fixture.dir, { announce: [] }, r));

  const { fetchMetadataFromPeer } = await import('../indexer/crawler.js');
  const meta = await fetchMetadataFromPeer(torrent.infoHash, '127.0.0.1', port, 15000);

  assert.strictEqual(meta.name, path.basename(fixture.dir), '名字应等于种子目录名');
  assert.strictEqual(meta.size, fixture.big + fixture.small, '总大小应等于两个文件之和');
  assert.strictEqual(meta.files, 2, '应该是 2 个文件');
  console.log('UNIT_METADATA_PASS', JSON.stringify(meta));

  // 顺带验证 infohash 校验：改一个字符必须失败
  const badHash = torrent.infoHash.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
  let rejected = false;
  try {
    await fetchMetadataFromPeer(badHash, '127.0.0.1', port, 6000);
  } catch {
    rejected = true;
  }
  assert.ok(rejected, 'infohash 不匹配时必须拒绝');
  console.log('UNIT_METADATA_CHECK_PASS');

  seeder.destroy(() => process.exit(0));
})().catch((err) => {
  console.error('UNIT_METADATA_FAIL', err.message);
  process.exit(1);
});
