/**
 * 发货方式 + 日本仓 + 直邮全流程：
 * 导入时写好直邮 / 拼团 → 日本仓签收 → 直邮按客户打包称重 → 客户付款、管理员确认 → 日本仓寄出 → 客户看到单号和包裹清单；
 * 拼团的件照旧装回国箱发出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, adminClient, qq, stamp, uniq } from './e2e-helpers.mjs';

const ctx = {};
const X = `直邮甲${stamp}`;
const Y = `直邮乙${stamp}`;
const QX = qq();
const QY = qq();

async function customerLogin(qqNo, password) {
  const c = new Client();
  const r = await c.post('/api/w/login', { qq: qqNo, password });
  c.token = r.token;
  return c;
}

test('导入：发货方式列认出来，直邮的件不进回国箱', async () => {
  ctx.admin = await adminClient();
  const sheet = {
    headers: ['名称', '实际价格', 'cn', '发货方式', '收货地址'],
    rows: [
      ['直邮手办A', 1000, X, '直邮', '上海市徐汇区某路 1 号 甲 13800000001'],
      ['直邮漫画B', 500, Y, '直邮', null],
      ['拼团徽章C', 300, X, '拼团', null],
      ['拼团挂件D', 200, Y, '', null],
    ],
  };
  const preview = await ctx.admin.post('/api/admin/import/preview', { fileName: 'direct.xlsx', fileHash: `direct-${stamp}`, sheet });
  assert.equal(preview.totals.direct, 2);
  const r = await ctx.admin.post('/api/admin/import/commit', {
    fileName: 'direct.xlsx',
    fileHash: `direct-${stamp}`,
    sheet,
    batchName: uniq('直邮批次'),
    orderNo: 'SURUGA-1',
    japanTrackingNo: 'JP-TRACK-9',
    assignments: [
      { cn: X, newCustomer: { qq: QX, nickname: X } },
      { cn: Y, newCustomer: { qq: QY, nickname: Y } },
    ],
  });
  assert.equal(r.directCount, 2);
  ctx.batchId = r.batchId;
  ctx.packageId = r.packageId;
  const batch = await ctx.admin.get(`/api/admin/batches/${r.batchId}`);
  const byTitle = Object.fromEntries(batch.items.map((i) => [i.title, i]));
  ctx.items = byTitle;
  assert.equal(byTitle['直邮手办A'].packageId, null);
  assert.equal(byTitle['直邮漫画B'].packageId, null);
  assert.equal(byTitle['拼团徽章C'].packageId, r.packageId);
});

test('日本仓账号：看得到待签收，看不到 QQ 和钱', async () => {
  const name = uniq('tokyo');
  await ctx.admin.post('/api/admin/staff', { username: name, displayName: '东京仓', role: 'jp', password: 'tokyo-pass-1' });
  ctx.jp = new Client();
  await ctx.jp.post('/api/admin/login', { username: name, password: 'tokyo-pass-1' });
  const o = await ctx.jp.get('/api/staff/jp/overview');
  const mine = o.inbound.find((b) => b.id === ctx.batchId);
  assert.ok(mine, '这一单要在待签收里');
  assert.equal(mine.japanTrackingNo, 'JPTRACK9', '运单号去掉横线存');
  assert.equal(mine.items.length, 4);
  const raw = JSON.stringify(o);
  assert.ok(!raw.includes(QX) && !raw.includes(QY), '日本仓数据里不能有 QQ');
  assert.ok(!/goodsFee|amountJpy|goods_fee/.test(raw), '日本仓数据里不能有货款');
});

test('回国箱里还有没签收的件就不让发出', async () => {
  const res = await ctx.jp.post(`/api/staff/jp/boxes/${ctx.packageId}/ship`, { trackingNo: 'BOX-1' }, { raw: true });
  assert.equal(res.status, 400);
  assert.equal(res.data.waiting, 2);
});

test('签收：整单签收后箱子变「已到日本仓」，直邮的件按客户分好', async () => {
  const ids = Object.values(ctx.items).map((i) => i.id);
  const r = await ctx.jp.post('/api/staff/jp/receive', { itemIds: ids });
  assert.equal(r.received, 4);
  const again = await ctx.jp.post('/api/staff/jp/receive', { itemIds: ids });
  assert.equal(again.received, 0, '重复签收不重复记');
  const pkg = await ctx.admin.get(`/api/admin/packages/${ctx.packageId}`);
  assert.equal(pkg.package?.status ?? pkg.status, 'jp_warehouse');
  const o = await ctx.jp.get('/api/staff/jp/overview');
  const gx = o.direct.find((d) => d.nickname === X);
  const gy = o.direct.find((d) => d.nickname === Y);
  assert.deepEqual([gx.addressReady, gx.addressSource], [true, 'import']);
  assert.equal(gy.addressReady, false);
});

test('改发货方式：没装箱的能改，回国箱自动对上', async () => {
  const c = ctx.items['拼团徽章C'].id;
  await ctx.admin.post('/api/admin/items/route', { itemIds: [c], route: 'direct' });
  let batch = await ctx.admin.get(`/api/admin/batches/${ctx.batchId}`);
  assert.equal(batch.items.find((i) => i.id === c).packageId, null);
  await ctx.admin.post('/api/admin/items/route', { itemIds: [c], route: 'group' });
  batch = await ctx.admin.get(`/api/admin/batches/${ctx.batchId}`);
  assert.equal(batch.items.find((i) => i.id === c).packageId, ctx.packageId);
  const jpTry = await ctx.jp.post('/api/admin/items/route', { itemIds: [c], route: 'direct' }, { raw: true });
  assert.equal(jpTry.status, 403, '改发货方式是管理员的事');
});

test('客户没地址时打不了包；客户填了唯一的地址就能打包称重', async () => {
  const b = ctx.items['直邮漫画B'];
  const fail = await ctx.jp.post('/api/staff/direct/parcels', { customerId: b.customerId, itemIds: [b.id] }, { raw: true });
  assert.equal(fail.status, 400);
  assert.match(fail.data.error, /地址/);

  let cy = await customerLogin(QY, '123456');
  await cy.post(`/api/w/${cy.token}/password`, { oldPassword: '123456', newPassword: 'yi-pass-2026' });
  cy = await customerLogin(QY, 'yi-pass-2026');
  await cy.post(`/api/w/${cy.token}/addresses`, { recipient: '乙', phone: '13900000002', detail: '北京市朝阳区某街 2 号' });
  ctx.cy = cy;

  const r = await ctx.jp.post('/api/staff/direct/parcels', { customerId: b.customerId, itemIds: [b.id], weightG: 1234 });
  assert.equal(r.status, 'awaiting_payment');
  assert.equal(r.feeFen, Math.ceil((1234 * 12000) / 1000), '默认 120 元/kg，向上取整到分');
  ctx.parcelY = r.id;
  const view = await cy.get(`/api/w/${cy.token}`);
  assert.equal(view.summary.directUnpaidFen, r.feeFen);
  assert.equal(view.directParcels[0].address.recipient, '乙');
  assert.equal(view.directParcels[0].items[0].title, '直邮漫画B');
});

test('打包不称重 → 称重；改单价不影响已称好的包裹', async () => {
  const a = ctx.items['直邮手办A'];
  const r = await ctx.jp.post('/api/staff/direct/parcels', { customerId: a.customerId, itemIds: [a.id] });
  assert.equal(r.status, 'packing');
  ctx.parcelX = r.id;
  const w = await ctx.jp.post(`/api/staff/direct/parcels/${r.id}/weigh`, { weightG: 500 });
  assert.equal(w.feeFen, 6000);
  await ctx.admin.post('/api/admin/settings', { directPriceYuanPerKg: '200' });
  const { parcels } = await ctx.jp.get('/api/staff/direct/parcels?status=open');
  assert.equal(parcels.find((p) => p.id === r.id).feeFen, 6000, '已称好的包裹运费存档不变');
  assert.equal(parcels.find((p) => p.id === r.id).address.raw, '上海市徐汇区某路 1 号 甲 13800000001');
  await ctx.admin.post('/api/admin/settings', { directPriceYuanPerKg: '120' });
  const bad = await ctx.jp.post(`/api/staff/direct/parcels/${r.id}/weigh`, { weightG: 300000 }, { raw: true });
  assert.equal(bad.status, 400, '超过 30kg 拦住');
});

test('没确认收款不能寄出；收款只有管理员能点', async () => {
  const ship = await ctx.jp.post(`/api/staff/direct/parcels/${ctx.parcelX}/ship`, { trackingNo: 'EMS1' }, { raw: true });
  assert.equal(ship.status, 400);
  const jpPay = await ctx.jp.post(`/api/admin/direct/${ctx.parcelX}/pay`, {}, { raw: true });
  assert.equal(jpPay.status, 403);
  const dash = await ctx.admin.get('/api/admin/dashboard');
  assert.ok(dash.directUnpaid.some((d) => d.parcelId === ctx.parcelX && d.feeFen === 6000));
});

test('确认收款 → 撤销 → 再确认；付了款就不能拆包改重量', async () => {
  const pay = await ctx.admin.post(`/api/admin/direct/${ctx.parcelX}/pay`);
  const locked = await ctx.jp.post(`/api/staff/direct/parcels/${ctx.parcelX}/cancel`, {}, { raw: true });
  assert.equal(locked.status, 400);
  const reweigh = await ctx.jp.post(`/api/staff/direct/parcels/${ctx.parcelX}/weigh`, { weightG: 600 }, { raw: true });
  assert.equal(reweigh.status, 400);
  await ctx.admin.call('DELETE', `/api/admin/payments/${pay.paymentId}`);
  let { parcels } = await ctx.jp.get('/api/staff/direct/parcels?status=open');
  assert.equal(parcels.find((p) => p.id === ctx.parcelX).status, 'awaiting_payment');
  await ctx.admin.post(`/api/admin/direct/${ctx.parcelX}/pay`);
  ({ parcels } = await ctx.jp.get('/api/staff/direct/parcels?status=open'));
  assert.equal(parcels.find((p) => p.id === ctx.parcelX).status, 'paid');
  assert.ok(parcels.find((p) => p.id === ctx.parcelX).items.every((i) => i.status === 'direct_ready'));
});

test('日本仓填单号寄出，客户看到单号和包裹里的每一件', async () => {
  await ctx.jp.post(`/api/staff/direct/parcels/${ctx.parcelX}/ship`, { trackingNo: 'EB123456789JP', carrier: 'EMS' });
  const cx0 = await customerLogin(QX, '123456');
  const view = await cx0.get(`/api/w/${cx0.token}`);
  const p = view.directParcels.find((d) => d.id === ctx.parcelX);
  assert.equal(p.trackingNo, 'EB123456789JP');
  assert.equal(p.status, 'shipped');
  assert.deepEqual(p.items.map((i) => i.title), ['直邮手办A']);
  assert.equal(view.items.find((i) => i.title === '直邮手办A').status, 'shipped');
  const again = await ctx.jp.post(`/api/staff/direct/parcels/${ctx.parcelX}/ship`, { trackingNo: 'X' }, { raw: true });
  assert.equal(again.status, 400, '不能寄两次');
  await ctx.jp.post(`/api/staff/direct/parcels/${ctx.parcelX}/tracking`, { trackingNo: 'EB000000000JP', carrier: 'EMS' });
  await ctx.admin.post(`/api/admin/direct/${ctx.parcelX}/delivered`);
  const after = await cx0.get(`/api/w/${cx0.token}`);
  assert.equal(after.directParcels.find((d) => d.id === ctx.parcelX).trackingNo, 'EB000000000JP');
  assert.equal(after.items.find((i) => i.title === '直邮手办A').status, 'delivered');
});

test('装进直邮包裹的件不能改发货方式、不能手动改状态', async () => {
  const b = ctx.items['直邮漫画B'].id;
  const route = await ctx.admin.post('/api/admin/items/route', { itemIds: [b], route: 'group' }, { raw: true });
  assert.equal(route.status, 400);
  const status = await ctx.admin.patch(`/api/admin/items/${b}`, { status: 'jp_warehouse' }, { raw: true });
  assert.equal(status.status, 400);
});

test('拼团的件照旧：签收齐了就能封箱发出', async () => {
  await ctx.jp.post(`/api/staff/jp/boxes/${ctx.packageId}/ship`, { trackingNo: 'BOX-RETURN-1' });
  const pkg = await ctx.admin.get(`/api/admin/packages/${ctx.packageId}`);
  const items = pkg.items ?? pkg.package?.items;
  assert.ok(items.every((i) => i.status === 'intl_transit'));
});

test('拆包：件退回「已到日本仓」，包裹消失', async () => {
  await ctx.jp.post(`/api/staff/direct/parcels/${ctx.parcelY}/cancel`);
  const o = await ctx.jp.get('/api/staff/jp/overview');
  const gy = o.direct.find((d) => d.nickname === Y);
  assert.equal(gy.items.length, 1);
  assert.equal(gy.addressReady, true);
  const view = await ctx.cy.get(`/api/w/${ctx.cy.token}`);
  assert.equal(view.directParcels.length, 0);
  assert.equal(view.summary.directUnpaidFen, 0);
});
