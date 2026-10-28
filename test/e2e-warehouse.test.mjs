/**
 * 日本仓日常的细节：找货、缺件 / 退回、一单分几个快递到、不拼邮别装箱、
 * 打包前看地址 + 打印、回国箱整箱重量和箱数、直邮付款可见 / 催款、菜单红点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, adminClient, qq, stamp, uniq } from './e2e-helpers.mjs';

const ctx = {};
const N = { g: `仓拼${stamp}`, s: `仓自带${stamp}`, d: `仓直邮${stamp}` };
const Q = { g: qq(), s: qq(), d: qq() };
const TN_A = 'WH-A-' + String(stamp).slice(-6);
const TN_B = 'WH-B-' + String(stamp).slice(-6);
const norm = (t) => t.replace(/[\s\-－ー]/g, '');

test('准备：导入一单，两个日本快递；建日本仓账号', async () => {
  ctx.admin = await adminClient();
  const sheet = {
    headers: ['名称', '商品链接', '实际价格', 'cn', '发货方式', '收货地址', '日本运单号'],
    rows: [
      ['拼团手办', 'https://www.suruga-ya.jp/product/detail/7788990011', 1000, N.g, '拼团', null, TN_A],
      ['拼团画集', null, 800, N.g, '拼团', null, TN_B],
      ['自带立牌', null, 500, N.s, '拼团', null, TN_A],
      ['直邮色纸', null, 300, N.d, '直邮', null, TN_A],
    ],
  };
  const r = await ctx.admin.post('/api/admin/import/commit', {
    fileName: 'wh.xlsx',
    fileHash: `wh-${stamp}`,
    sheet,
    batchName: uniq('仓库单'),
    orderNo: `WH-${stamp}`,
    assignments: Object.keys(N).map((k) => ({ cn: N[k], newCustomer: { qq: Q[k], nickname: N[k] } })),
  });
  ctx.batchId = r.batchId;
  const detail = await ctx.admin.get(`/api/admin/batches/${r.batchId}`);
  ctx.item = Object.fromEntries(detail.items.map((i) => [i.title, i]));
  const sCustomer = ctx.item['自带立牌'].customerId;
  await ctx.admin.patch(`/api/admin/customers/${sCustomer}`, { selfReturn: true });
  const name = uniq('whjp');
  await ctx.admin.post('/api/admin/staff', { username: name, displayName: '仓库小李', role: 'jp', password: 'warehouse-pw-1' });
  ctx.jp = new Client();
  await ctx.jp.post('/api/admin/login', { username: name, password: 'warehouse-pw-1' });
});

test('① 日本仓账号能搜货号尾号、cn、日本运单号；结果里没有价格', async () => {
  const byCode = await ctx.jp.get('/api/staff/items/search?q=90011');
  assert.deepEqual(byCode.items.map((i) => i.title), ['拼团手办']);
  assert.equal(byCode.items[0].code, '7788990011');
  assert.equal('goodsFeeJpy' in byCode.items[0], false);
  const byTn = await ctx.jp.get(`/api/staff/items/search?q=${encodeURIComponent(norm(TN_B))}`);
  assert.deepEqual(byTn.items.map((i) => i.title), ['拼团画集']);
  const byCn = await ctx.jp.get(`/api/staff/items/search?q=${encodeURIComponent(N.s)}`);
  assert.equal(byCn.items[0].selfReturn, 1, '不拼邮的要在结果里看得出来');
  assert.equal((await ctx.jp.get('/api/admin/items/search?q=90011', { raw: true })).status, 403, '管理员那条还是管理员专用');
});

async function sortBox(tn, { boxes = [{}], found, missing = [], direct = [] }) {
  const s = await ctx.jp.get(`/api/staff/sort/${ctx.batchId}?tn=${encodeURIComponent(tn)}`);
  const byTitle = Object.fromEntries(s.items.map((i) => [i.title, i]));
  if (found.length) await ctx.jp.post('/api/staff/sort/mark', { itemIds: found.map((t) => byTitle[t].id), found: true });
  return ctx.jp.post(`/api/staff/sort/${ctx.batchId}/commit`, {
    trackingNo: tn,
    boxes,
    missing: missing.map((t) => byTitle[t].id),
    direct,
  });
}

test('② 签错了能退回、没找到能标缺件：退回后从箱子里拿出来，下一箱还能再分', async () => {
  await sortBox(TN_A, { found: ['拼团手办', '自带立牌', '直邮色纸'] });
  let ov = await ctx.jp.get('/api/staff/jp/overview');
  const box = ov.boxes.find((b) => b.items.some((i) => i.id === ctx.item['拼团手办'].id));
  assert.ok(box, '分拣后拼团手办在一个回国箱里');
  ctx.boxA = box.id;

  // 签错了：退回未签收，箱子空了就收掉
  await ctx.jp.post('/api/staff/jp/unreceive', { itemIds: [ctx.item['拼团手办'].id] });
  ov = await ctx.jp.get('/api/staff/jp/overview');
  assert.equal(ov.boxes.some((b) => b.id === ctx.boxA), false, '空箱不再挂着');
  const queue = await ctx.jp.get('/api/staff/sort/queue');
  const entry = queue.batches.find((b) => b.batchId === ctx.batchId);
  assert.ok(entry.boxes.some((x) => x.trackingNo === norm(TN_A) && x.count === 1), '退回的件回到分拣队列');

  // 再分一次，这回标缺件
  await sortBox(TN_A, { boxes: [], found: [], missing: ['拼团手办'] });
  const missingItem = (await ctx.admin.get(`/api/admin/batches/${ctx.batchId}`)).items.find((i) => i.title === '拼团手办');
  assert.equal(missingItem.missing, 1);
  const dash = await ctx.admin.get('/api/admin/dashboard');
  assert.ok(dash.missingItems.some((m) => m.itemId === missingItem.id), '管理员待办里看得到日本仓报的缺件');

  // 已经签收的直邮件，在待打包直邮里标缺件
  const directItem = ctx.item['直邮色纸'].id;
  ov = await ctx.jp.get('/api/staff/jp/overview');
  assert.ok(ov.direct.some((g) => g.items.some((i) => i.id === directItem)));
  await ctx.jp.post('/api/staff/jp/unreceive', { itemIds: [directItem], missing: true });
  const d = (await ctx.admin.get(`/api/admin/batches/${ctx.batchId}`)).items.find((i) => i.id === directItem);
  assert.deepEqual([d.status, d.missing], ['ordered', 1]);
  assert.match(d.exceptionNote, /日本仓标缺件/);
  // 找到了：取消缺件（还没签收的件只改标记）
  await ctx.jp.post('/api/staff/jp/unreceive', { itemIds: [directItem], missing: false });
  const back = (await ctx.admin.get(`/api/admin/batches/${ctx.batchId}`)).items.find((i) => i.id === directItem);
  assert.equal(back.missing, 0);
});

test('③ 一单几个日本快递：每个单号单独签收，看得出哪个还没到；仓库能补登单号', async () => {
  let q = await ctx.jp.get('/api/staff/sort/queue');
  let b = q.batches.find((x) => x.batchId === ctx.batchId);
  const byTn = () => Object.fromEntries(b.jpShipments.map((s) => [s.trackingNo, s]));
  assert.ok(byTn()[norm(TN_A)].arrivedAt, '分拣过的快递 A 算已到');
  assert.equal(byTn()[norm(TN_A)].arrivedBy, '仓库小李');
  assert.equal(byTn()[norm(TN_B)].arrivedAt, null, '快递 B 还没到');

  // 快递 B 先签收，晚点再分拣：表里写着 B 的件变「已到日本仓」，但还在分拣队列里
  const r = await ctx.jp.post('/api/staff/jp/shipments/arrive', { batchId: ctx.batchId, trackingNo: TN_B });
  assert.equal(r.received, 1);
  q = await ctx.jp.get('/api/staff/sort/queue');
  b = q.batches.find((x) => x.batchId === ctx.batchId);
  assert.ok(byTn()[norm(TN_B)].arrivedAt);
  assert.equal(byTn()[norm(TN_B)].waiting, 1, '签收了但还没分拣');
  const item = (await ctx.admin.get(`/api/admin/batches/${ctx.batchId}`)).items.find((i) => i.title === '拼团画集');
  assert.equal(item.status, 'jp_warehouse');

  // 点错了能撤
  await ctx.jp.post('/api/staff/jp/shipments/unarrive', { batchId: ctx.batchId, trackingNo: TN_B });
  assert.equal((await ctx.admin.get(`/api/admin/batches/${ctx.batchId}`)).items.find((i) => i.title === '拼团画集').status, 'ordered');
  // 分拣过的快递 A 不能撤
  const no = await ctx.jp.post('/api/staff/jp/shipments/unarrive', { batchId: ctx.batchId, trackingNo: TN_A }, { raw: true });
  assert.equal(no.status, 400);

  // 补登第三个快递；管理员在订单页一次填几个也认
  await ctx.jp.post('/api/staff/jp/shipments', { batchId: ctx.batchId, trackingNo: 'WH-C 777' });
  await ctx.admin.patch(`/api/admin/batches/${ctx.batchId}`, { japanTrackingNo: `${TN_A}，WH-D-888` });
  const detail = await ctx.admin.get(`/api/admin/batches/${ctx.batchId}`);
  assert.deepEqual(detail.jpShipments.map((s) => s.trackingNo).sort(), [norm(TN_A), norm(TN_B), 'WHC777', 'WHD888'].sort());
  const list = (await ctx.admin.get('/api/admin/batches')).batches.find((x) => x.id === ctx.batchId);
  assert.equal(list.jpShipments.filter((s) => s.arrivedAt).length, 1, '订单总览里看得到到了几个');
  // 没到、也没有件写着它的单号可以删
  await ctx.admin.call('DELETE', `/api/admin/batches/${ctx.batchId}/shipments/WHD888`);
  const used = await ctx.admin.call('DELETE', `/api/admin/batches/${ctx.batchId}/shipments/${norm(TN_B)}`, undefined, { raw: true });
  assert.equal(used.status, 400, '表里有件写着这个单号，不能删');
});

test('④ 不拼邮的件签收后放一边，不在回国箱里；误放进箱的拦住发出，能拿出来', async () => {
  let ov = await ctx.jp.get('/api/staff/jp/overview');
  const selfId = ctx.item['自带立牌'].id;
  assert.equal(ov.boxes.some((b) => b.items.some((i) => i.id === selfId)), false, '不在任何回国箱里');
  const g = ov.selfReturn.find((x) => x.items.some((i) => i.id === selfId));
  assert.ok(g, '在「不拼邮」那一栏');

  // 分拣快递 B：拼团画集进一个箱子（不填回国单号，留在日本仓）
  await sortBox(TN_B, { found: ['拼团画集'] });
  ov = await ctx.jp.get('/api/staff/jp/overview');
  const box = ov.boxes.find((b) => b.items.some((i) => i.id === ctx.item['拼团画集'].id));
  ctx.boxB = box.id;
  // 分拣完客户才说自己带：箱里这件变成不拼邮，发出被拦
  const gCustomer = ctx.item['拼团画集'].customerId;
  await ctx.admin.patch(`/api/admin/customers/${gCustomer}`, { selfReturn: true });
  ov = await ctx.jp.get('/api/staff/jp/overview');
  assert.equal(ov.boxes.find((b) => b.id === ctx.boxB).items[0].selfReturn, true, '箱里标得出来');
  const blocked = await ctx.jp.post(`/api/staff/jp/boxes/${ctx.boxB}/ship`, { trackingNo: 'RET-X' }, { raw: true });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /不拼邮/);
  await ctx.jp.post('/api/staff/jp/set-aside', { itemIds: [ctx.item['拼团画集'].id] });
  ov = await ctx.jp.get('/api/staff/jp/overview');
  assert.equal(ov.boxes.some((b) => b.id === ctx.boxB), false, '箱子空了就收掉');
  assert.ok(ov.selfReturn.some((x) => x.items.some((i) => i.id === ctx.item['拼团画集'].id)));
  // 改回拼邮，再分进箱子，后面的用例要用
  await ctx.admin.patch(`/api/admin/customers/${gCustomer}`, { selfReturn: false });
  await ctx.jp.post('/api/staff/jp/unreceive', { itemIds: [ctx.item['拼团画集'].id] });
  await sortBox(TN_B, { found: ['拼团画集'] });
  ov = await ctx.jp.get('/api/staff/jp/overview');
  ctx.boxB = ov.boxes.find((b) => b.items.some((i) => i.id === ctx.item['拼团画集'].id)).id;
  const notSelf = await ctx.jp.post('/api/staff/jp/set-aside', { itemIds: [ctx.item['拼团画集'].id] }, { raw: true });
  assert.equal(notSelf.status, 400, '拼邮的件不让拿出来');
});

test('⑤ 打包前就看得到寄到哪；装箱单、打包单的数据接口', async () => {
  let ov = await ctx.jp.get('/api/staff/jp/overview');
  const directItem = ctx.item['直邮色纸'].id;
  // 前面把直邮色纸标过缺件又找回来了，现在还没签收：分拣快递 A 再签一次
  await sortBox(TN_A, { boxes: [], found: ['直邮色纸'] });
  ov = await ctx.jp.get('/api/staff/jp/overview');
  let g = ov.direct.find((x) => x.items.some((i) => i.id === directItem));
  assert.equal(g.address, null);
  assert.match(g.addressProblem, /还没有收货地址/);
  // 客户填了地址：待打包直邮里直接看到整行地址
  let cust = new Client();
  let r = await cust.post('/api/w/login', { qq: Q.d, password: '123456' });
  await cust.post(`/api/w/${r.token}/password`, { oldPassword: '123456', newPassword: 'mypass-888' });
  cust = new Client();
  r = await cust.post('/api/w/login', { qq: Q.d, password: 'mypass-888' });
  await cust.post(`/api/w/${r.token}/addresses`, { recipient: '山田', phone: '090-0000-1111', detail: '东京都新宿区1-2-3' });
  ov = await ctx.jp.get('/api/staff/jp/overview');
  g = ov.direct.find((x) => x.items.some((i) => i.id === directItem));
  assert.equal(g.address, '山田 090-0000-1111 东京都新宿区1-2-3');

  const box = await ctx.jp.get(`/api/staff/jp/boxes/${ctx.boxB}`);
  assert.deepEqual(box.items.map((i) => i.title), ['拼团画集']);
  assert.equal(box.items[0].cn, N.g);

  const parcel = await ctx.jp.post('/api/staff/direct/parcels', { customerId: g.customerId, itemIds: [directItem], weightG: 800 });
  ctx.parcelId = parcel.id;
  const p = await ctx.jp.get(`/api/staff/direct/parcels/${parcel.id}`);
  assert.equal(p.parcel.address.detail, '东京都新宿区1-2-3');
  assert.deepEqual(p.parcel.items.map((i) => i.title), ['直邮色纸']);
});

test('⑥ 回国箱记整箱重量和箱数：发出时填、发出后补，管理员称重台看得到', async () => {
  const noWeight = await ctx.jp.post(`/api/staff/jp/boxes/${ctx.boxB}/ship`, { trackingNo: 'RET-B', weightG: 999999 }, { raw: true });
  assert.equal(noWeight.status, 400, '100 kg 以上当成手滑');
  await ctx.jp.post(`/api/staff/jp/boxes/${ctx.boxB}/ship`, { trackingNo: 'RET-B', weightG: 12500, cartons: 2 });
  let ov = await ctx.jp.get('/api/staff/jp/overview');
  const shipped = ov.shippedBoxes.find((b) => b.id === ctx.boxB);
  assert.deepEqual([shipped.trackingNo, shipped.jpWeightG, shipped.cartonCount], ['RET-B', 12500, 2]);
  await ctx.jp.post(`/api/staff/jp/boxes/${ctx.boxB}/info`, { weightG: 12800, cartons: 3 });
  const weigh = await ctx.admin.get(`/api/admin/packages/${ctx.boxB}/weigh`);
  assert.deepEqual([weigh.package.jpWeightG, weigh.package.cartonCount], [12800, 3]);
  const list = (await ctx.admin.get('/api/admin/packages')).packages.find((p) => p.id === ctx.boxB);
  assert.equal(list.jpWeightG, 12800);

  // 分拣时当场开箱发出，也能一起填
  const tn = 'WH-E-' + String(stamp).slice(-5);
  await ctx.jp.post('/api/staff/jp/shipments', { batchId: ctx.batchId, trackingNo: tn });
  const extra = await ctx.admin.post('/api/admin/import/commit', {
    fileName: 'wh2.xlsx',
    fileHash: `wh2-${stamp}`,
    sheet: { headers: ['名称', '实际价格', 'cn', '日本运单号'], rows: [['加单徽章', 100, N.g, tn]] },
    batchName: uniq('仓库加单'),
    assignments: [{ cn: N.g, customerId: ctx.item['拼团画集'].customerId }],
  });
  const s = await ctx.jp.get(`/api/staff/sort/${extra.batchId}?tn=${encodeURIComponent(tn)}`);
  await ctx.jp.post('/api/staff/sort/mark', { itemIds: s.items.map((i) => i.id), found: true });
  const r = await ctx.jp.post(`/api/staff/sort/${extra.batchId}/commit`, {
    trackingNo: tn,
    boxes: [{ trackingNo: 'RET-E', weightG: 3000, cartons: 1 }],
  });
  assert.deepEqual([r.result.boxes[0].weightG, r.result.boxes[0].cartons], [3000, 1]);
});

test('⑦ 直邮待付款：仓库看得到等了多久、能催，管理员看得到催过；菜单红点按角色算', async () => {
  let list = await ctx.jp.get('/api/staff/direct/parcels?status=awaiting_payment');
  const p = list.parcels.find((x) => x.id === ctx.parcelId);
  assert.ok(p.weighedAt, '称重时间在，前端算等了几天');
  assert.equal(p.nudgeCount, 0);
  const r = await ctx.jp.post(`/api/staff/direct/parcels/${ctx.parcelId}/nudge`);
  assert.match(r.message, /运费 ¥/);
  assert.equal(r.qq, Q.d);
  list = await ctx.jp.get('/api/staff/direct/parcels?status=awaiting_payment');
  const after = list.parcels.find((x) => x.id === ctx.parcelId);
  assert.deepEqual([after.nudgeCount, after.nudgedBy], [1, '仓库小李']);
  const dash = await ctx.admin.get('/api/admin/dashboard');
  assert.equal(dash.directUnpaid.find((d) => d.parcelId === ctx.parcelId).nudgeCount, 1);

  const jpBadges = await ctx.jp.get('/api/staff/badges');
  assert.equal('#/requests' in jpBadges.badges, false, '日本仓看不到管理员的红点');
  const adminBefore = await ctx.admin.get('/api/staff/badges');
  assert.ok(adminBefore.detail.nudged >= 1);
  assert.ok(adminBefore.badges['#/'] >= 1);

  // 管理员确认收款 → 日本仓「直邮」红点 +1（付了款等寄出）
  const before = jpBadges.badges['#/direct'];
  await ctx.admin.post(`/api/admin/direct/${ctx.parcelId}/pay`);
  const jpAfter = await ctx.jp.get('/api/staff/badges');
  assert.equal(jpAfter.badges['#/direct'], before + 1);
  const notAgain = await ctx.jp.post(`/api/staff/direct/parcels/${ctx.parcelId}/nudge`, {}, { raw: true });
  assert.equal(notAgain.status, 400, '付过款就不用催了');
});
