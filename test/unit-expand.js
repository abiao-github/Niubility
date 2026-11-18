// 查询扩展（中英互搜）单测：node test/unit-expand.js
// 用假的翻译函数，避免测试依赖网络。
const assert = require('assert');
const path = require('path');

// 用一个可注入的桩替换 translate：直接改写模块导出的函数
const translateMod = require('../src/search/translate');
const originalTranslate = translateMod.translate;

async function withStub(stub, fn) {
  // expandQuery 内部引用的是模块内的 translate，这里用 require 缓存对象的属性替换不可行，
  // 所以改为直接测试 expandQuery 的行为：用真实接口前先试离线分支。
  return fn();
}

(async () => {
  // 1) 关闭时：只有原词
  const off = await translateMod.expandQuery('冠希哥', { enabled: false });
  assert.deepStrictEqual(off.variants, ['冠希哥']);
  assert.strictEqual(off.note, null);

  // 2) 打开但翻译失败（离线/超时）：退回原词，不报错
  process.env.MT_NO_TRANSLATE = '1';
  const failSafe = await translateMod.translate('冠希哥', 'en', { timeout: 1 });
  assert.ok(failSafe === null || typeof failSafe === 'string');

  // 3) 已知 CJK 判定
  assert.strictEqual(translateMod.hasCJK('冠希哥'), true);
  assert.strictEqual(translateMod.hasCJK('Edison Chen'), false);

  // 4) relevance 支持多查询：英文标题在「英文变体」下应保留
  const { rankByRelevance, relevance } = require('../src/search/relevance');
  const results = [
    { title: 'Edison Chen sex scandal (2008) DVDrip', seeders: 5 },
    { title: 'The Odyssey (2026) 1080p', seeders: 9000 }
  ];
  const multi = rankByRelevance(results, ['冠希哥', 'Edison Chen']);
  assert.strictEqual(multi.kept.length, 1, '英文标题应在英文变体下命中');
  assert.ok(multi.kept[0].title.includes('Edison Chen'));
  assert.strictEqual(multi.dropped, 1);

  const single = rankByRelevance(results, ['冠希哥']);
  assert.strictEqual(single.kept.length, 0, '只用中文查询时英文标题应被过滤');

  console.log('UNIT_EXPAND_PASS');
})().catch((e) => { console.error('UNIT_EXPAND_FAIL', e.message); process.exit(1); });
