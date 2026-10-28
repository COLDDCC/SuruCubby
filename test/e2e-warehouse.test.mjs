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
