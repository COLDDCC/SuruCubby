/**
 * 安全：会把测试机这个 IP 的客户登录锁 15 分钟，所以单独一个文件、文件名排在最后（e2e.z-…）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, adminClient, qq, stamp } from './e2e-helpers.mjs';

const Q = { g: qq() };

test('准备：一位还拿着初始密码的客户', async () => {
  const admin = await adminClient();
  await admin.post('/api/admin/import/commit', {
    fileName: 'sec.xlsx',
    fileHash: `sec-${stamp}`,
    sheet: { headers: ['名称', 'cn', '实际价格'], rows: [['安全测试', `安全${stamp}`, 100]] },
    batchName: `安全${stamp}`,
    assignments: [{ cn: `安全${stamp}`, newCustomer: { qq: Q.g, nickname: `安全${stamp}` } }],
  });
  assert.equal((await new Client().post('/api/w/login', { qq: Q.g, password: '123456' }, { raw: true })).status, 200);
});

test('安全：同一个 IP 拿 123456 挨个撞 QQ 号会被整体锁住；响应带防套框架的安全头', async () => {
  const page = await fetch(`${process.env.E2E_BASE}/admin/`);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

  // 前面的用例已经在这个 IP 上错过几次，撞到 429 为止，最多 40 次
  let status = 0;
  let tries = 0;
  for (; tries < 40 && status !== 429; tries += 1) {
    const r = await new Client().post('/api/w/login', { qq: `${880000000 + tries}`, password: '123456' }, { raw: true });
    status = r.status;
  }
  assert.equal(status, 429, '每个号只错一次，也会按 IP 锁住');
  // 锁住之后连真实账号的正确密码也先进不来（15 分钟后自己解开）
  const real = await new Client().post('/api/w/login', { qq: Q.g, password: '123456' }, { raw: true });
  assert.equal(real.status, 429);
});
