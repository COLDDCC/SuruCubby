import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surugaCode, surugaImageCandidates } from '../src/lib/images.ts';

test('货号从商品链接末尾取出来，数字和字母开头的编号都认', () => {
  assert.equal(surugaCode('https://www.suruga-ya.jp/product/detail/560707731'), '560707731');
  assert.equal(surugaCode('https://www.suruga-ya.jp/product/detail/ZHONA146352'), 'ZHONA146352');
  assert.equal(surugaCode('https://www.suruga-ya.jp/product/detail/560707731/'), '560707731');
  assert.equal(surugaCode('https://www.suruga-ya.jp/product/detail/560707731?mode=2#top'), '560707731');
});

test('不像货号的尾巴不乱取，免得拼出错图', () => {
  assert.equal(surugaCode('https://www.suruga-ya.jp/product/detail/'), '');
  assert.equal(surugaCode('https://www.suruga-ya.jp/shopgoods/goods_list/217363/'), '');
  assert.equal(surugaCode('https://www.suruga-ya.jp/'), '');
  assert.equal(surugaCode(''), '');
});

test('按货号拼官方 CDN 地址时统一转小写', () => {
  assert.deepEqual(surugaImageCandidates('https://www.suruga-ya.jp/product/detail/ZHONA146352'), [
    'https://cdn.suruga-ya.jp/database/pics_light/game/zhona146352.jpg',
  ]);
  assert.deepEqual(surugaImageCandidates('https://www.suruga-ya.jp/product/detail/560707731'), [
    'https://cdn.suruga-ya.jp/database/pics_light/game/560707731.jpg',
  ]);
  assert.deepEqual(surugaImageCandidates('https://www.suruga-ya.jp/'), []);
});
