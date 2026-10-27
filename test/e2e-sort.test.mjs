/**
 * 分拣全流程：一个日本订单分两箱到 → 按日本运单号分拣 → 点卡片「找到了」 → 发送：
 * 拼团分进多个回国箱并当场填回国单号、直邮按人建包裹（EMS 单号 + 整包重量）、没地址的先放着、缺件；
 * 客户页看到单号和包里有哪几件；物品详情信息齐全。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, adminClient, qq, stamp, uniq } from './e2e-helpers.mjs';

const ctx = {};
const N = { a: `直甲${stamp}`, b: `直乙${stamp}`, c: `拼丙${stamp}`, d: `拼丁${stamp}` };
const Q = { a: qq(), b: qq(), c: qq(), d: qq() };
const TN1 = '4908-1111-0001';
const TN2 = '490811110002';

async function customer(qqNo) {
  const c = new Client();
  const r = await c.post('/api/w/login', { qq: qqNo, password: '123456' });
  c.token = r.token;
  return c;
}

const titles = (list) => list.map((i) => i.title).sort();

test('导入：表里写了日本运单号和下单时间', async () => {
  ctx.admin = await adminClient();
  const sheet = {
    headers: ['名称', '商品链接', '实际价格', 'cn', '发货方式', '收货地址', '日本运单号', '下单时间'],
    rows: [
      ['甲的手办', 'https://www.suruga-ya.jp/product/detail/602000001', 1000, N.a, '直邮', '大阪市 甲 090', TN1, '2026/10/18'],
      ['甲的画集', null, 800, N.a, '直邮', '大阪市 甲 090', TN1, null],
      ['乙的漫画', null, 500, N.b, '直邮', null, TN1, null],
      ['丙的徽章', null, 300, N.c, '拼团', null, TN1, null],
      ['丙的挂件', null, 300, N.c, '拼团', null, null, null],
      ['丁的立牌', null, 200, N.d, '拼团', null, TN1, null],
      ['丁的色纸', null, 200, N.d, '', null, TN2, null],
      ['丙的海报', null, 100, N.c, '拼团', null, TN2, null],
    ],
  };
  const preview = await ctx.admin.post('/api/admin/import/preview', { fileName: 's.xlsx', fileHash: `sort-${stamp}`, sheet });
  assert.deepEqual(
    preview.totals.jpTrackingNos.map((t) => [t.trackingNo, t.count]).sort(),
    [['490811110001', 5], ['490811110002', 2]],
  );
  const r = await ctx.admin.post('/api/admin/import/commit', {
    fileName: 's.xlsx',
    fileHash: `sort-${stamp}`,
    sheet,
    batchName: uniq('分拣单'),
    orderNo: 'SG-777',
    orderedAt: '2026-10-20',
    assignments: Object.keys(N).map((k) => ({ cn: N[k], newCustomer: { qq: Q[k], nickname: N[k] } })),
  });
  ctx.batchId = r.batchId;
  ctx.importPackage = r.packageId;
  const name = uniq('sorter');
  await ctx.admin.post('/api/admin/staff', { username: name, displayName: '分拣员', role: 'jp', password: 'sorter-pass-1' });
  ctx.jp = new Client();
  await ctx.jp.post('/api/admin/login', { username: name, password: 'sorter-pass-1' });
});

test('待分拣：按日本运单号分组，没写运单号的单独算', async () => {
  const q = await ctx.jp.get('/api/staff/sort/queue');
  const b = q.batches.find((x) => x.batchId === ctx.batchId);
  assert.deepEqual(b.boxes.map((x) => [x.trackingNo, x.count]), [['490811110001', 5], ['490811110002', 2]]);
  assert.equal(b.untracked, 1);
});

test('分拣页：运单 1 的件 + 没写运单号的件；卡片上是 cn 原文和 QQ', async () => {
  const s = await ctx.jp.get(`/api/staff/sort/${ctx.batchId}?tn=${encodeURIComponent(TN1)}`);
  assert.equal(s.trackingNo, '490811110001');
  assert.deepEqual(titles(s.items), ['丁的立牌', '丙的徽章', '丙的挂件', '乙的漫画', '甲的手办', '甲的画集'].sort());
  const a = s.items.find((i) => i.title === '甲的手办');
  assert.equal(a.cn, N.a);
  assert.equal(a.qq, Q.a);
  assert.equal(s.directAddresses[a.customerId].ready, true);
  const b = s.items.find((i) => i.title === '乙的漫画');
  assert.equal(s.directAddresses[b.customerId].ready, false);
  assert.equal(s.maxBoxes, 9);
  ctx.items = Object.fromEntries(s.items.map((i) => [i.title, i]));
});

test('点卡片：找到 / 取消，存在服务器上', async () => {
  const ids = ['甲的手办', '甲的画集', '乙的漫画', '丙的徽章', '丙的挂件', '丁的立牌'].map((t) => ctx.items[t].id);
  await ctx.jp.post('/api/staff/sort/mark', { itemIds: ids, found: true });
  await ctx.jp.post('/api/staff/sort/mark', { itemIds: [ctx.items['丙的挂件'].id], found: false });
  const other = new Client();
  await other.post('/api/admin/login', { username: 'admin', password: process.env.E2E_PASSWORD || 'test-admin-pw' });
  const s = await other.get(`/api/staff/sort/${ctx.batchId}?tn=${TN1}`);
  assert.equal(s.items.filter((i) => i.found).length, 5, '另一台设备看到的是同一份勾选');
  assert.equal(s.items.find((i) => i.title === '甲的手办').foundBy, '分拣员');
});

test('发送前的检查：拼团没开箱、空箱、超过上限都拦下', async () => {
  const url = `/api/staff/sort/${ctx.batchId}/commit`;
  const noBox = await ctx.jp.post(url, { trackingNo: TN1, boxes: [] }, { raw: true });
  assert.equal(noBox.status, 400);
  const empty = await ctx.jp.post(url, { trackingNo: TN1, boxes: [{}, {}], assign: { [ctx.items['丙的徽章'].id]: 1, [ctx.items['丁的立牌'].id]: 1 } }, { raw: true });
  assert.match(empty.data.error, /第 2 箱是空的/);
  await ctx.admin.post('/api/admin/settings', { maxBoxesPerSort: 1 });
  const many = await ctx.jp.post(url, { trackingNo: TN1, boxes: [{}, {}], assign: {} }, { raw: true });
  assert.match(many.data.error, /最多开 1 箱/);
  await ctx.admin.post('/api/admin/settings', { maxBoxesPerSort: 9 });
});

test('发送：两箱拼团当场发出，直邮按人建包裹，没地址的先放着，没找到的标缺件', async () => {
  const r = await ctx.jp.post(`/api/staff/sort/${ctx.batchId}/commit`, {
    trackingNo: TN1,
    boxes: [{ trackingNo: 'RET001' }, { trackingNo: 'RET002' }],
    assign: { [ctx.items['丙的徽章'].id]: 1, [ctx.items['丁的立牌'].id]: 2 },
    direct: [{ customerId: ctx.items['甲的手办'].customerId, trackingNo: 'EB 111 222 333 JP', weightG: 1500 }],
    missing: [ctx.items['丙的挂件'].id],
  });
  ctx.session = r.sessionId;
  const res = r.result;
  assert.equal(res.parcels.length, 1);
  assert.equal(res.parcels[0].trackingNo, 'EB111222333JP');
  assert.equal(res.parcels[0].feeFen, 18000, '1500 g × 120 元/kg');
  assert.deepEqual(res.parcels[0].items.map((i) => i.title).sort(), ['甲的手办', '甲的画集']);
  assert.deepEqual(res.boxes.map((b) => [b.trackingNo, b.people.map((p) => p.cn)]), [['RET001', [N.c]], ['RET002', [N.d]]]);
  assert.equal(res.unpacked.length, 1);
  assert.match(res.unpacked[0].reason, /地址/);
  assert.deepEqual(res.missing.map((m) => m.title), ['丙的挂件']);
  ctx.boxes = res.boxes;
});

test('客户页：拼团看到回国单号，直邮看到 EMS 单号和包里每一件', async () => {
  const c = await customer(Q.c);
  const vc = await c.get(`/api/w/${c.token}`);
  const badge = vc.items.find((i) => i.title === '丙的徽章');
  assert.equal(badge.status, 'intl_transit');
  assert.equal(badge.returnTrackingNo, 'RET001');
  const a = await customer(Q.a);
  const va = await a.get(`/api/w/${a.token}`);
  assert.equal(va.directParcels[0].trackingNo, 'EB111222333JP');
  assert.equal(va.directParcels[0].status, 'awaiting_payment');
  assert.deepEqual(va.directParcels[0].items.map((i) => i.title).sort(), ['甲的手办', '甲的画集']);
  // 每一件自己带着「在哪个包裹、单号多少」，客户页的进度条和「我的东西在哪」靠它
  const fig = va.items.find((i) => i.title === '甲的手办');
  assert.deepEqual([fig.route, fig.parcelTrackingNo, fig.parcelStatus, !!fig.sortedAt], ['direct', 'EB111222333JP', 'awaiting_payment', true]);
  assert.equal(fig.orderedAt, '2026-10-18');
  assert.equal(badge.packageName.endsWith('第1箱'), true);
  assert.equal(badge.jpTrackingNo, '490811110001');
  ctx.ca = a;
});

test('物品详情：日本仓看得到 QQ 看不到价格；管理员看得到价格；客户只能看自己的', async () => {
  const id = ctx.items['甲的手办'].id;
  const jp = await ctx.jp.get(`/api/staff/items/${id}`);
  assert.equal(jp.owner.qq, Q.a);
  assert.equal(jp.owner.cn, N.a);
  assert.equal(jp.prices, null);
  assert.equal(jp.orderedAt, '2026-10-18', '表里写的下单时间优先');
  assert.equal(jp.batch.orderNo, 'SG-777');
  assert.equal(jp.jpTrackingNo, '490811110001');
  assert.equal(jp.direct.trackingNo, 'EB111222333JP');
  assert.deepEqual([jp.product.code, jp.product.shop], ['602000001', '骏河屋']);
  assert.ok(jp.timeline.some((t) => t.toStatus === 'jp_warehouse' && t.byName === '分拣员'));
  const admin = await ctx.admin.get(`/api/staff/items/${ctx.items['甲的画集'].id}`);
  assert.equal(admin.prices.goodsFeeJpy, 800);
  assert.equal(admin.orderedAt, '2026-10-20', '表里没写就用导入时填的订单日期');
  const mine = await ctx.ca.get(`/api/w/${ctx.ca.token}/items/${id}`);
  assert.equal(mine.prices.actualPriceJpy, 1000);
  const notMine = await ctx.ca.get(`/api/w/${ctx.ca.token}/items/${ctx.items['丙的徽章'].id}`, { raw: true });
  assert.equal(notMine.status, 404);
  const box = await ctx.jp.get(`/api/staff/items/${ctx.items['丁的立牌'].id}`);
  assert.equal(box.returnBox.trackingNo, 'RET002');
});

test('已有 EMS 单号的直邮：收款后寄出不用再填单号', async () => {
  const parcelId = (await ctx.ca.get(`/api/w/${ctx.ca.token}`)).directParcels[0].id;
  await ctx.admin.post(`/api/admin/direct/${parcelId}/pay`);
  await ctx.jp.post(`/api/staff/direct/parcels/${parcelId}/ship`, {});
  const va = await ctx.ca.get(`/api/w/${ctx.ca.token}`);
  assert.equal(va.directParcels[0].status, 'shipped');
  assert.equal(va.directParcels[0].trackingNo, 'EB111222333JP');
});

test('第二箱：缺件的那件也能再点到；分完后导入时那个整单箱子收掉', async () => {
  const s = await ctx.jp.get(`/api/staff/sort/${ctx.batchId}?tn=${TN2}`);
  assert.deepEqual(titles(s.items), ['丁的色纸', '丙的挂件', '丙的海报'].sort());
  assert.equal(s.items.find((i) => i.title === '丙的挂件').missing, true);
  await ctx.jp.post('/api/staff/sort/mark', { itemIds: s.items.map((i) => i.id), found: true });
  const r = await ctx.jp.post(`/api/staff/sort/${ctx.batchId}/commit`, { trackingNo: TN2, boxes: [{}] });
  assert.equal(r.result.boxes[0].no, 3, '箱号接着上一次往下数');
  assert.equal(r.result.boxes[0].trackingNo, null);
  const q = await ctx.jp.get('/api/staff/sort/queue');
  assert.ok(!q.batches.some((b) => b.batchId === ctx.batchId), '这一单分完了');
  const gone = await ctx.admin.get(`/api/admin/packages/${ctx.importPackage}`, { raw: true });
  assert.equal(gone.status, 404);
  // 没填回国单号的箱子之后在「回国箱」里填单号发出
  await ctx.jp.post(`/api/staff/jp/boxes/${r.result.boxes[0].packageId}/ship`, { trackingNo: 'RET003' });
  const item = await ctx.jp.get(`/api/staff/items/${s.items.find((i) => i.title === '丙的挂件').id}`);
  assert.deepEqual([item.status, item.missing, item.returnBox.trackingNo], ['intl_transit', false, 'RET003']);
});

test('分拣记录能翻回来看', async () => {
  const s = await ctx.jp.get(`/api/staff/sort/sessions/${ctx.session}`);
  assert.equal(s.result.boxes.length, 2);
  assert.equal(s.createdBy, '分拣员');
});
