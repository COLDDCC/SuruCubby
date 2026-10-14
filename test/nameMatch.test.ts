import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchName, normalizeName, type NameIndex, type NameCustomer } from '../src/lib/nameMatch.ts';

const ali: NameCustomer = {
  id: 1,
  qq: '123456789',
  nickname: '阿狸',
  token: 't1',
};
const ali2: NameCustomer = {
  id: 2,
  qq: '987654321',
  nickname: '阿 狸',
  token: 't2',
};
const meow: NameCustomer = {
  id: 3,
  qq: '555555',
  nickname: 'Meow酱',
  token: 't3',
};

const index: NameIndex = {
  exact: new Map([
    ['阿狸', ali],
    ['阿 狸', ali2],
    ['Meow酱', meow],
  ]),
  normalized: new Map([
    ['阿狸', [ali, ali2]],
    ['meow酱', [meow]],
  ]),
};

test('归一化只动写法不动含义', () => {
  assert.equal(normalizeName(' 阿狸 '), '阿狸');
  assert.equal(normalizeName('Ａ　li'), 'ali');
  assert.equal(normalizeName('Meow酱'), 'meow酱');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
  // 括号是区分两个人的线索，不能抹掉
  assert.equal(normalizeName('阿狸(小号)'), '阿狸(小号)');
});

test('写法一模一样就直接认，全角带空格也能唯一对上', () => {
  assert.equal(matchName(index, '阿狸').by, 'exact');
  assert.equal(matchName(index, 'Ｍｅｏｗ酱').by, 'normalized');
  assert.equal(matchName(index, 'Ｍｅｏｗ酱').customer!.id, 3);
});

test('归一化后撞在两个人身上时不猜，把候选交给人', () => {
  // 全角空格这种写法两位都不完全一样，但归一化后都撞得上
  const hit = matchName(index, '阿　狸');
  assert.equal(hit.by, 'ambiguous');
  assert.equal(hit.customer, null);
  assert.deepEqual(
    hit.candidates.map((c) => c.qq),
    ['123456789', '987654321'],
  );
});

test('完全没见过的名字才要新建客户', () => {
  assert.equal(matchName(index, '没见过的人').by, 'none');
});
