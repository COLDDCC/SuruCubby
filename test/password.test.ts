import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_PASSWORD,
  hashPassword,
  passwordProblem,
  usingInitialPassword,
  verifyPassword,
} from '../src/lib/password.ts';

test('没设过密码的客户按初始密码认，别的都不认', async () => {
  assert.equal(usingInitialPassword(null), true);
  assert.equal(await verifyPassword(INITIAL_PASSWORD, null), true);
  assert.equal(await verifyPassword('123457', null), false);
  assert.equal(await verifyPassword('', null), false);
});

test('改过密码之后只认新密码，库里翻不出明文', async () => {
  const stored = await hashPassword('ab12cd34');
  assert.equal(usingInitialPassword(stored), false);
  assert.ok(!stored.includes('ab12cd34'), '哈希里不能带明文');
  assert.equal(await verifyPassword('ab12cd34', stored), true);
  assert.equal(await verifyPassword('ab12cd35', stored), false);
  assert.equal(await verifyPassword(INITIAL_PASSWORD, stored), false);
});

test('同一个密码两次存的串不一样（有随机盐）', async () => {
  assert.notEqual(await hashPassword('ab12cd34'), await hashPassword('ab12cd34'));
});

test('哈希串被人为改坏时认不过，不会当成空密码放人', async () => {
  assert.equal(await verifyPassword('whatever', 'garbage'), false);
  assert.equal(await verifyPassword('whatever', 'pbkdf2-sha256$0$AAA$BBB'), false);
});

test('新密码的要求说人话', () => {
  assert.equal(passwordProblem('ab12cd34'), null);
  assert.match(passwordProblem('12345'), /6 到 32/);
  assert.match(passwordProblem(INITIAL_PASSWORD), /初始密码/);
  assert.match(passwordProblem('ab cd 12'), /空格/);
});
