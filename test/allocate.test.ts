import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, feeFromWeight } from '../src/lib/allocate.ts';

test('验收用例：3 个客户各 1000 g，总运费 ¥100.00', () => {
  const result = allocate(10000, [
    { id: 1, weightG: 1000 },
    { id: 2, weightG: 1000 },
    { id: 3, weightG: 1000 },
  ]);
  assert.deepEqual(
    result.rows.map((r) => r.feeFen),
    [3333, 3333, 3333],
  );
  assert.equal(result.diffFen, 1); // ¥0.01 尾差记在需求方名下
  assert.equal(result.totalWeightG, 3000);
});

test('按重量比例分摊，尾差永远 >= 0 且小于组数', () => {
  const result = allocate(12345, [
    { id: 1, weightG: 1240 },
    { id: 2, weightG: 3100 },
    { id: 3, weightG: 455 },
  ]);
  const sum = result.rows.reduce((acc, r) => acc + r.feeFen, 0);
  assert.equal(sum + result.diffFen, 12345);
  assert.ok(result.diffFen >= 0 && result.diffFen < 3);
  assert.ok(result.rows[1].feeFen > result.rows[0].feeFen);
});

test('没称重 / 没有组 / 负运费都要报错', () => {
  assert.throws(() => allocate(100, []), /没有可分摊/);
  assert.throws(() => allocate(100, [{ id: 1, weightG: 0 }]), /大于 0 的重量/);
  assert.throws(() => allocate(-1, [{ id: 1, weightG: 10 }]), /非负整数/);
});

test('运费为 0 时人人都是 0', () => {
  const result = allocate(0, [
    { id: 1, weightG: 500 },
    { id: 2, weightG: 700 },
  ]);
  assert.deepEqual(
    result.rows.map((r) => r.feeFen),
    [0, 0],
  );
  assert.equal(result.diffFen, 0);
});

test('按单价从重量推运费：100 元/kg 时 5130 g 就是 ¥513.00', () => {
  assert.equal(feeFromWeight(5130, 10000), 51300);
  assert.equal(feeFromWeight(1000, 10000), 10000);
  assert.equal(feeFromWeight(0, 10000), 0);
  // 单价 23.37 元/kg、1 g 时不满 1 分，四舍五入
  assert.equal(feeFromWeight(1, 2337), 2);
  assert.equal(feeFromWeight(999, 1), 1);
});

test('单价或重量写法不对就拦住，不许拿浮点凑数', () => {
  assert.throws(() => feeFromWeight(1000.5, 10000), /整数克/);
  assert.throws(() => feeFromWeight(-1, 10000), /整数克/);
  assert.throws(() => feeFromWeight(1000, 1.5), /整数分/);
  assert.throws(() => feeFromWeight(1000, -1), /整数分/);
});

import { imageKey, isCached, isHttpUrl, KEY_PATTERN } from '../src/lib/images.ts';

test('图片 key 由源地址决定，同一张图不会存两份', async () => {
  const a = await imageKey('https://img/a.png', 'image/png');
  const b = await imageKey('https://img/a.png', 'image/png');
  const c = await imageKey('https://img/b.png', 'image/png');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, KEY_PATTERN);
  assert.ok(a.endsWith('.png'));
  assert.ok((await imageKey('https://img/a', 'image/jpeg; charset=utf-8')).endsWith('.jpg'));
});

test('区分站内缓存路径和外链', () => {
  assert.ok(isCached('/img/abc.png'));
  assert.ok(!isCached('https://img/a.png'));
  assert.ok(isHttpUrl('https://img/a.png'));
  assert.ok(!isHttpUrl('/img/abc.png'));
  assert.ok(!KEY_PATTERN.test('../../secret'));
});
