import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalToScaledInt, fenToYuan, toFen, toFenStrict, toJpy } from '../src/lib/money.ts';

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

test('群主手填的钱只能到分', () => {
  assert.equal(toFenStrict('12.34'), 1234);
  assert.equal(toFenStrict('¥1,234.50'), 123450);
  assert.equal(toFenStrict(12.34), 1234);
  // 末尾多写的零不算精度问题
  assert.equal(toFenStrict('12.340'), 1234);
  assert.equal(toFenStrict(0.1 + 0.2), 30);
  // 细于分的要拒绝：0.005 元悄悄变成 1 分，这一分会摊进整箱运费，纸上算不平
  assert.equal(toFenStrict('0.005'), null);
  assert.equal(toFenStrict('12.345'), null);
  assert.equal(toFenStrict(0.005), null);
  assert.equal(toFenStrict('abc'), null);
  assert.equal(toFenStrict(''), null);
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
