/** 员工账号与角色：管理员能开账号，日本仓账号进不了管理员接口，停用 / 改密码当场掉线，写操作有日志。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, adminClient, uniq } from './e2e-helpers.mjs';

const ctx = {};

test('admin 账号 + 环境变量密码能登录，会话里带角色', async () => {
  ctx.admin = await adminClient();
  const s = await ctx.admin.get('/api/admin/session');
  assert.deepEqual([s.loggedIn, s.role, s.name], [true, 'admin', 'admin']);
});

test('只填密码（旧版登录）照样认成 admin', async () => {
  const c = new Client();
  await c.post('/api/admin/login', { password: process.env.E2E_PASSWORD || 'test-admin-pw' });
  assert.equal((await c.get('/api/admin/session')).role, 'admin');
});

test('建账号：admin 这个名字保留、密码太短拦住、重名拦住', async () => {
  const bad1 = await ctx.admin.post('/api/admin/staff', { username: 'admin', displayName: 'x', role: 'jp', password: '12345678' }, { raw: true });
  assert.equal(bad1.status, 400);
  const bad2 = await ctx.admin.post('/api/admin/staff', { username: uniq('jp'), displayName: 'x', role: 'jp', password: 'short' }, { raw: true });
  assert.equal(bad2.status, 400);
  ctx.jpName = uniq('jp');
  const made = await ctx.admin.post('/api/admin/staff', { username: ctx.jpName, displayName: '东京小王', role: 'jp', password: 'tokyo-pass-1' });
  ctx.jpId = made.id;
  const dup = await ctx.admin.post('/api/admin/staff', { username: ctx.jpName.toUpperCase(), displayName: 'x', role: 'jp', password: 'tokyo-pass-1' }, { raw: true });
  assert.equal(dup.status, 400, '账号不分大小写');
});

test('日本仓账号登录后，所有管理员接口都是 403', async () => {
  ctx.jp = new Client();
  const r = await ctx.jp.post('/api/admin/login', { username: ctx.jpName, password: 'tokyo-pass-1' });
  assert.equal(r.role, 'jp');
  for (const path of ['/api/admin/dashboard', '/api/admin/customers', '/api/admin/payments', '/api/admin/staff', '/api/admin/settings', '/api/admin/batches']) {
    const res = await ctx.jp.get(path, { raw: true });
    assert.equal(res.status, 403, path);
  }
  const write = await ctx.jp.post('/api/admin/settings', { domesticFeeYuan: '0' }, { raw: true });
  assert.equal(write.status, 403);
});

test('密码错、账号错都只说「账号或密码不对」', async () => {
  const c = new Client();
  const a = await c.post('/api/admin/login', { username: ctx.jpName, password: 'wrong-pass' }, { raw: true });
  const b = await c.post('/api/admin/login', { username: 'nobody-here', password: 'wrong-pass' }, { raw: true });
  assert.equal(a.status, 401);
  assert.equal(b.data.error, a.data.error);
  // 清掉这个 IP 的失败计数，免得后面的用例被锁
  await new Client().post('/api/admin/login', { username: 'admin', password: process.env.E2E_PASSWORD || 'test-admin-pw' });
});

test('改密码后旧登录立即失效', async () => {
  await ctx.admin.patch(`/api/admin/staff/${ctx.jpId}`, { password: 'tokyo-pass-2' });
  assert.equal((await ctx.jp.get('/api/admin/session')).loggedIn, false);
  await ctx.jp.post('/api/admin/login', { username: ctx.jpName, password: 'tokyo-pass-2' });
  assert.equal((await ctx.jp.get('/api/admin/session')).loggedIn, true);
});

test('停用后立即掉线、也登不进；启用后恢复', async () => {
  await ctx.admin.patch(`/api/admin/staff/${ctx.jpId}`, { disabled: true });
  assert.equal((await ctx.jp.get('/api/admin/session')).loggedIn, false);
  const res = await ctx.jp.post('/api/admin/login', { username: ctx.jpName, password: 'tokyo-pass-2' }, { raw: true });
  assert.equal(res.status, 401);
  await ctx.admin.patch(`/api/admin/staff/${ctx.jpId}`, { disabled: false });
  await new Client().post('/api/admin/login', { username: 'admin', password: process.env.E2E_PASSWORD || 'test-admin-pw' });
  await ctx.jp.post('/api/admin/login', { username: ctx.jpName, password: 'tokyo-pass-2' });
  assert.equal((await ctx.jp.get('/api/admin/session')).role, 'jp');
});

test('第二个管理员账号能用全部管理员接口，但不能停用自己', async () => {
  const name = uniq('cn');
  const made = await ctx.admin.post('/api/admin/staff', { username: name, displayName: '国内分发', role: 'admin', password: 'china-pass-1' });
  const cn = new Client();
  await cn.post('/api/admin/login', { username: name, password: 'china-pass-1' });
  assert.ok((await cn.get('/api/admin/dashboard')).goodsUnpaid);
  const self = await cn.patch(`/api/admin/staff/${made.id}`, { disabled: true }, { raw: true });
  assert.equal(self.status, 400);
  await cn.patch(`/api/admin/staff/${ctx.jpId}`, { displayName: '东京小王（改）' });
  ctx.cn = cn;
});

test('写操作记进操作日志，带操作人，密码不落库', async () => {
  const { logs } = await ctx.admin.get('/api/admin/staff/audit?limit=50');
  const pwChange = logs.find((l) => l.path === `/api/admin/staff/${ctx.jpId}` && l.detail?.includes('***'));
  assert.ok(pwChange, '改密码那一条要在');
  assert.equal(pwChange.staffName, 'admin');
  assert.ok(!logs.some((l) => l.detail?.includes('tokyo-pass')), '密码明文不许出现在日志里');
  const byCn = logs.find((l) => l.role === 'admin' && l.staffName === '国内分发');
  assert.ok(byCn, '第二个管理员的操作也要记上名字');
});
