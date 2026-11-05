/**
 * 第三版改动：订单页逐人勾「已收款」（收款即放行、分几天收不丢进度）、
 * 仓库把拼邮客户改成直邮（群主待办补地址）、手动换封面图、飞书设置的校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE || (console.error('要 E2E_BASE'), process.exit(1));
const PASSWORD = process.env.E2E_PASSWORD || 'test-admin-pw';

function client() {
  const jar = new Map();
  return async function call(method, path, body, { raw = false } = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const ck of res.headers.getSetCookie?.() ?? []) {
      const [pair] = ck.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
    if (raw) return { status: res.status, data, type };
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}

const admin = client();
const wh = client();
const stamp = Date.now();
const C = `收款丙${stamp}`;
const D = `改直邮丁${stamp}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const ctx = {};

const batch = () => admin('GET', `/api/admin/batches/${ctx.batchId}`);
const itemsOf = (data, customerId) => data.items.filter((i) => i.customerId === customerId);

test('准备：导入一单两个人，默认不放行', async () => {
  await admin('POST', '/api/admin/login', { password: PASSWORD });
  const r = await admin('POST', '/api/admin/import/commit', {
    batchName: `v3 ${stamp}`,
    orderNo: `JP-V3-${stamp}`,
    fileHash: `v3-${stamp}`,
    sheet: {
      headers: ['名称', '商品链接', 'cn', '应付日元金额'],
      rows: [
        ['丙的一件', 'https://www.suruga-ya.jp/product/detail/602170101', C, '1000'],
        ['丙的两件', 'https://www.suruga-ya.jp/product/detail/602170102', C, '2000'],
        ['丁的一件', 'https://www.suruga-ya.jp/product/detail/602170103', D, '500'],
      ],
    },
    assignments: [
      { cn: C, newCustomer: { qq: `${stamp}`.slice(-9), nickname: C } },
      { cn: D, newCustomer: { qq: `${stamp + 1}`.slice(-9), nickname: D } },
    ],
  });
  ctx.batchId = r.batchId;
  ctx.cId = r.createdCustomers.find((c) => c.nickname === C).id;
  ctx.dId = r.createdCustomers.find((c) => c.nickname === D).id;
});

test('勾「已收款」：只记这个人、马上放行；取消勾只撤销收款，放行不动', async () => {
  await admin('POST', '/api/admin/payments/batch-customer', { batchId: ctx.batchId, customerId: ctx.cId, paid: true });
  let data = await batch();
  assert.ok(itemsOf(data, ctx.cId).every((i) => i.goodsPaid && i.releasedAt), '丙：已付 + 已放行');
  assert.ok(itemsOf(data, ctx.dId).every((i) => !i.goodsPaid && !i.releasedAt), '丁不受影响');
  const pays = await admin('GET', `/api/admin/payments?customerId=${ctx.cId}`);
  assert.equal(pays.payments.filter((p) => p.kind === 'goods').length, 1);
  assert.equal(pays.payments[0].amount, 3000);

  // 再勾一次不会重复记账
  await admin('POST', '/api/admin/payments/batch-customer', { batchId: ctx.batchId, customerId: ctx.cId, paid: true });
  assert.equal((await admin('GET', `/api/admin/payments?customerId=${ctx.cId}`)).payments.length, 1);

  await admin('POST', '/api/admin/payments/batch-customer', { batchId: ctx.batchId, customerId: ctx.cId, paid: false });
  data = await batch();
  assert.ok(itemsOf(data, ctx.cId).every((i) => !i.goodsPaid && i.releasedAt), '撤销收款后还是放行着的');
  assert.equal((await admin('GET', `/api/admin/payments?customerId=${ctx.cId}`)).payments.length, 0);
});

test('一笔收款跨了两单：在这一单取消勾，只把这一单的部分拆出来', async () => {
  const second = await admin('POST', '/api/admin/quick-order', {
    customerId: ctx.cId,
    kind: 'buy',
    orderNo: `JP-V3-${stamp}-2`,
    lines: [{ url: 'https://www.suruga-ya.jp/product/detail/602170104', priceJpy: 700 }],
  });
  const ids = (await admin('GET', `/api/admin/customers/${ctx.cId}`)).items.map((i) => i.id);
  await admin('POST', '/api/admin/payments', { customerId: ctx.cId, kind: 'goods', itemIds: ids });
  let pays = (await admin('GET', `/api/admin/payments?customerId=${ctx.cId}`)).payments;
  assert.equal(pays.length, 1);
  assert.equal(pays[0].amount, 3700);

  await admin('POST', '/api/admin/payments/batch-customer', { batchId: ctx.batchId, customerId: ctx.cId, paid: false });
  pays = (await admin('GET', `/api/admin/payments?customerId=${ctx.cId}`)).payments;
  assert.equal(pays.length, 1, '收款记录还在（另一单的部分）');
  assert.equal(pays[0].amount, 700);
  const other = await admin('GET', `/api/admin/batches/${second.batchId}`);
  assert.ok(other.items.every((i) => i.goodsPaid), '另一单照旧是已付');
  assert.ok(itemsOf(await batch(), ctx.cId).every((i) => !i.goodsPaid));
});

test('剩下的人全收：每人一笔并放行', async () => {
  const r = await admin('POST', '/api/admin/payments/all-goods', { batchId: ctx.batchId });
  assert.equal(r.customers, 2);
  assert.equal(r.amountJpy, 3500);
  const data = await batch();
  assert.ok(data.items.every((i) => i.goodsPaid && i.releasedAt));
});

test('仓库把拼邮客户改成直邮：没地址打不了包，群主首页出现「待补地址」；补上就能打', async () => {
  await admin('POST', '/api/admin/warehouse-users', { username: `v3wh${stamp}`.slice(0, 30), displayName: '仓库 v3', password: 'wh-pass-3' });
  await wh('POST', '/api/wh/login', { username: `v3wh${stamp}`.slice(0, 30), password: 'wh-pass-3' });
  await wh('POST', `/api/wh/batches/${ctx.batchId}/customers/${ctx.dId}/sorted`, {});

  const r = await wh('POST', `/api/wh/customers/${ctx.dId}/lane`, { lane: 'direct' });
  assert.equal(r.needAddress, true);
  const view = await wh('GET', `/api/wh/customers/${ctx.dId}`);
  assert.equal(view.customer.lane, 'direct');
  assert.equal(view.customer.directAddress, null);

  const dash = await admin('GET', '/api/admin/dashboard');
  assert.ok(dash.needAddress.some((x) => x.customerId === ctx.dId), '首页有待补地址');

  const itemIds = view.items.map((i) => i.id);
  const noAddr = await wh('POST', '/api/wh/parcels', { customerId: ctx.dId, itemIds, trackingNo: `SF${stamp}`, grossWeightG: 300 }, { raw: true });
  assert.equal(noAddr.status, 400);
  assert.match(noAddr.data.error, /地址/);

  await admin('PATCH', `/api/admin/customers/${ctx.dId}`, { shipMode: 'direct', directAddress: '丁 13900000000 北京某路 2 号' });
  assert.ok(!(await admin('GET', '/api/admin/dashboard')).needAddress.some((x) => x.customerId === ctx.dId));
  const parcel = await wh('POST', '/api/wh/parcels', { customerId: ctx.dId, itemIds, trackingNo: `SF${stamp}`, grossWeightG: 300 });
  assert.ok(parcel.id);

  // 有没放行的直邮包裹时不能改回拼邮
  const back = await wh('POST', `/api/wh/customers/${ctx.dId}/lane`, { lane: 'group' }, { raw: true });
  assert.equal(back.status, 400);
  // 改法只能是直邮 / 拼邮
  assert.equal((await wh('POST', `/api/wh/customers/${ctx.dId}/lane`, { lane: 'self' }, { raw: true })).status, 400);
});

test('拼邮箱里的东西不能直接打进直邮包裹', async () => {
  // 丙放行了、分拣、装进拼邮箱，然后改直邮
  await wh('POST', `/api/wh/batches/${ctx.batchId}/customers/${ctx.cId}/sorted`, {});
  const box = await wh('POST', '/api/wh/boxes', {});
  const waiting = (await wh('GET', `/api/wh/boxes/${box.id}`)).waiting.filter((i) => i.customerId === ctx.cId);
  await wh('POST', `/api/wh/boxes/${box.id}/items`, { itemIds: waiting.map((i) => i.id) });
  await wh('POST', `/api/wh/customers/${ctx.cId}/lane`, { lane: 'direct' });
  await admin('PATCH', `/api/admin/customers/${ctx.cId}`, { shipMode: 'direct', directAddress: '丙 地址' });
  const r = await wh('POST', '/api/wh/parcels', { customerId: ctx.cId, itemIds: waiting.map((i) => i.id), trackingNo: `X${stamp}`, grossWeightG: 100 }, { raw: true });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /拼邮箱/);
});

test('手动换封面：上传的图存进自己服务器，/img/i/{id} 马上是新图', async () => {
  const item = (await batch()).items[0];
  const r = await admin('POST', `/api/admin/items/${item.id}/image`, { dataUrl: PNG });
  assert.match(r.imageUrl, /^\/img\/[0-9a-f]{32}\.png$/);
  const res = await fetch(`${BASE}/img/i/${item.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const bad = await admin('POST', `/api/admin/items/${item.id}/image`, { dataUrl: 'data:text/html;base64,PGI+' }, { raw: true });
  assert.equal(bad.status, 400);
  const status = await admin('GET', `/api/admin/batches/${ctx.batchId}/images`);
  assert.ok(!status.failed.some((f) => f.itemId === item.id));
});

test('飞书：没填凭据时导入给出明白的提示；ID 和 Secret 填成一样的当场拦住', async () => {
  const none = await admin('POST', '/api/admin/import/feishu', { url: 'https://x.feishu.cn/sheets/shtcnABC' }, { raw: true });
  assert.equal(none.status, 400);
  assert.match(none.data.error, /App ID/);
  const same = await admin('POST', '/api/admin/settings/feishu', { appId: 'cli_aa0782cfa9f8dcdd', appSecret: 'cli_aa0782cfa9f8dcdd' }, { raw: true });
  assert.equal(same.status, 400);
  assert.match(same.data.error, /一样/);
  const badId = await admin('POST', '/api/admin/settings/feishu', { appId: 'abc', appSecret: 'x' }, { raw: true });
  assert.equal(badId.status, 400);
  const s = await admin('GET', '/api/admin/settings');
  assert.equal(s.feishuHasSecret, false);
  assert.ok(!JSON.stringify(s).includes('feishuAppSecret'), 'Secret 不回传');
});
