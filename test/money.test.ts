import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalToScaledInt, fenToYuan, toFen, toJpy } from '../src/lib/money.ts';

test('元 → 分：常见写法都能吃下', () => {
  assert.equal(toFen('12.34'), 1234);
  assert.equal(toFen('¥1,234.50'), 123450);
  assert.equal(toFen('1234.5 元'), 123450);
  assert.equal(toFen('１２.３４'), 1234);
  assert.equal(toFen(12.34), 1234);
  assert.equal(toFen(0), 0);
  assert.equal(toFen(''), null);
  assert.equal(toFen('  '), null);
  assert.equal(toFen('待定'), null);
});

test('元 → 分：四舍五入到分，不受浮点影响', () => {
  assert.equal(toFen('0.615'), 62);
  assert.equal(toFen('0.614'), 61);
  assert.equal(toFen('1.005'), 101);
  assert.equal(toFen(0.615), 62);
});

test('日元按整数取，带符号和千分位也行', () => {
  assert.equal(toJpy('¥1,200'), 1200);
  assert.equal(toJpy('1200円'), 1200);
  assert.equal(toJpy(1200.4), 1200);
  assert.equal(toJpy(1200.5), 1201);
  assert.equal(toJpy(null), null);
});

test('decimalToScaledInt 只接受数字串', () => {
  assert.equal(decimalToScaledInt('abc', 2), null);
  assert.equal(decimalToScaledInt('-3.5', 2), -350);
  assert.equal(decimalToScaledInt('.5', 2), 50);
});

test('分 → 元展示', () => {
  assert.equal(fenToYuan(1234), '12.34');
  assert.equal(fenToYuan(5), '0.05');
  assert.equal(fenToYuan(-1234), '-12.34');
});
