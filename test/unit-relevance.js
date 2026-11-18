// 相关性过滤的单测：跑 node test/unit-relevance.js
// 背景：海盗湾在关键词没命中时会返回"热门榜单"，不相关性过滤就会把无关内容当结果。
const assert = require('assert');
const { relevance, rankByRelevance } = require('../src/search/relevance');

const cases = [
  // 中文：无命中
  ['The Odyssey (2026) [1080p]', '冠希哥', false],
  // 中文：字分散在标题里但不成词，不算命中
  ['哥斯拉大战金刚 希区柯克 合集', '冠希哥', false],
  // 中文：连续命中
  ['冠希哥 经典合集', '冠希哥', true],
  ['陈冠希 艳照门 完整版', '冠希哥', true],
  ['张津瑜 警花 完整版 1080p', '张津瑜警花', true],
  ['The Odyssey (2026)', '张津瑜警花', false],
  ['进击的巨人 剧场版', '进击的巨人', true],
  ['Bitcoin whitepaper', '进击的巨人', false],
  // 英文：词覆盖
  ['ubuntu-24.04.1-desktop-amd64.iso', 'ubuntu iso', true],
  ['Ubuntu 24.04 Desktop', 'ubuntu iso', true],
  ['random movie', 'ubuntu iso', false],
  ['Big Buck Bunny 1080p', 'big buck bunny', true],
];

let failed = 0;
for (const [title, q, want] of cases) {
  const score = relevance(title, q);
  const got = score > 0;
  if (got !== want) {
    failed += 1;
    console.error(`✗ 期望${want ? '命中' : '不命中'}，实际 ${score}：${q} ← ${title}`);
  }
}
assert.strictEqual(failed, 0, `${failed} 个用例不符合预期`);

// 排序：相关性高的在前
const list = [
  { title: 'The Odyssey 2026', seeders: 9999 },
  { title: '张津瑜 警花 完整版', seeders: 1 },
  { title: 'random noise', seeders: 100 },
];
const { kept, dropped } = rankByRelevance(list, '张津瑜警花');
assert.strictEqual(dropped, 2);
assert.strictEqual(kept.length, 1);
assert.ok(kept[0].title.includes('张津瑜'));

console.log('UNIT_RELEVANCE_PASS');
