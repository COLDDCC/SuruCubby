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
      ['直邮色纸', null, 300, N.d, '直邮', '东京都新宿区 某某 090-1234', TN_A],
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
