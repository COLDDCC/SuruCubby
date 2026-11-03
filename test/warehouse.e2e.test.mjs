/**
 * 三方各看各的：群主放行 → 仓库分拣 → 直邮打包 / 拼邮装箱 → 群主放行单号。
 *
 *   node scripts/sandbox.mjs --state .wrangler/e2e-wh --port 8793 -- node --test test/warehouse.e2e.test.mjs
 *
 * 重点不是「能点」，而是「谁看不到什么」：仓库拿不到任何价格，客户在放行前看不到单号，
 * 客户永远看不到仓库单价。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE || (console.error('要 E2E_BASE，别写 8787'), process.exit(1));
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
const alice = client();
const bob = client();

const stamp = Date.now();
const A = `直邮甲${stamp}`;
const B = `拼邮乙${stamp}`;
const QA = `${stamp}`.slice(-9);
const QB = `${stamp + 1}`.slice(-9);
const ORDER = `JP-WH-${stamp}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const ctx = {};

/** 仓库拿到的任何 JSON 里都不许出现钱和 QQ */
function assertNoMoney(data, where) {
  const text = JSON.stringify(data);
  for (const word of ['Jpy', 'Fen', 'fen_', 'price', 'Paid', '"qq"', 'realName', 'margin', 'cost', 'sale']) {
    assert.ok(!text.includes(word), `${where} 里漏出了「${word}」：${text.slice(0, 300)}`);
  }
}

async function loginCustomer(call, qq) {
  const r = await call('POST', '/api/w/login', { qq, password: '123456' });
  return r.token;
}

test('准备：群主登录、导入一单（默认不放行）', async () => {
  await admin('POST', '/api/admin/login', { password: PASSWORD });
  const r = await admin('POST', '/api/admin/import/commit', {
    batchName: `仓库测试 ${stamp}`,
    orderNo: ORDER,
    japanTrackingNo: `JT${stamp}`,
    fileHash: `wh-${stamp}`,
    sheet: {
      headers: ['名称', '商品链接', 'cn', '应付日元金额'],
      rows: [
        ['甲的手办', 'https://www.suruga-ya.jp/product/detail/602170001', A, '1800'],
        ['甲的同款', 'https://www.suruga-ya.jp/product/detail/602170001', A, '1800'],
        ['乙的卡片', 'https://www.suruga-ya.jp/product/detail/ZHOTI678913', B, '500'],
      ],
    },
    assignments: [
      { cn: A, newCustomer: { qq: QA, nickname: A } },
      { cn: B, newCustomer: { qq: QB, nickname: B } },
    ],
  });
  ctx.batchId = r.batchId;
  ctx.aId = r.createdCustomers.find((c) => c.nickname === A).id;
  ctx.bId = r.createdCustomers.find((c) => c.nickname === B).id;
});

test('先下单后收钱：没放行之前客户自己的仓库里什么都没有', async () => {
  ctx.aToken = await loginCustomer(alice, QA);
  const view = await alice('GET', `/api/w/${ctx.aToken}`);
  assert.equal(view.items.length, 0);
  assert.equal(view.summary.goodsUnpaidJpy, 0, '没放行的货款也不该出现');
  // 群主那边看得见，并且知道还没放行
  const adminView = await admin('GET', `/api/admin/customers/${ctx.aId}`);
  assert.equal(adminView.items.length, 2);
  assert.ok(adminView.items.every((i) => i.releasedAt === null));
  // 首页「待放行」里有这两个人
  const dash = await admin('GET', '/api/admin/dashboard');
  const mine = dash.toRelease.filter((r) => r.batchId === ctx.batchId);
  assert.deepEqual(mine.map((r) => r.customerId).sort(), [ctx.aId, ctx.bId].sort());
  assert.equal(mine.find((r) => r.customerId === ctx.aId).count, 2);
  assert.equal(mine.find((r) => r.customerId === ctx.aId).amountJpy, 3600);
  assert.ok(!dash.whBacklog.some((b) => b.batchId === ctx.batchId), '没放行的不算仓库积压');
});

test('群主点客户名字放行：只放这一个人，另一个人照旧看不到', async () => {
  const r = await admin('POST', '/api/admin/quick-order/release', { batchId: ctx.batchId, customerId: ctx.aId });
  assert.equal(r.count, 2);
  const view = await alice('GET', `/api/w/${ctx.aToken}`);
  assert.equal(view.items.length, 2);
  assert.equal(view.summary.goodsUnpaidJpy, 3600);
  ctx.bToken = await loginCustomer(bob, QB);
  assert.equal((await bob('GET', `/api/w/${ctx.bToken}`)).items.length, 0);
  await admin('POST', '/api/admin/quick-order/release', { batchId: ctx.batchId, customerId: ctx.bId });
  assert.equal((await bob('GET', `/api/w/${ctx.bToken}`)).items.length, 1);
  // 收回也行
  await admin('POST', '/api/admin/quick-order/release', { batchId: ctx.batchId, customerId: ctx.bId, undo: true });
  assert.equal((await bob('GET', `/api/w/${ctx.bToken}`)).items.length, 0);
  await admin('POST', '/api/admin/quick-order/release', { batchId: ctx.batchId, customerId: ctx.bId });
  // 放行之后：从「待放行」挪到「仓库还没整理」
  const dash = await admin('GET', '/api/admin/dashboard');
  assert.ok(!dash.toRelease.some((r) => r.batchId === ctx.batchId));
  const backlog = dash.whBacklog.find((b) => b.batchId === ctx.batchId);
  assert.equal(backlog.count, 3);
  assert.equal(backlog.customerCount, 2);
});

test('群主建仓库账号；三把钥匙互不相通', async () => {
  await admin('POST', '/api/admin/warehouse-users', { username: `wh${stamp}`, displayName: '仓库小王', password: 'wh-pass-1' });
  const bad = await wh('POST', '/api/wh/login', { username: `wh${stamp}`, password: 'nope' }, { raw: true });
  assert.equal(bad.status, 401);
  await wh('POST', '/api/wh/login', { username: `wh${stamp}`, password: 'wh-pass-1' });
  assert.equal((await wh('GET', '/api/wh/session')).user.displayName, '仓库小王');
  assert.equal((await wh('GET', '/api/admin/customers', undefined, { raw: true })).status, 401, '仓库进不了群主后台');
  assert.equal((await admin('GET', '/api/wh/batches', undefined, { raw: true })).status, 401, '群主的钥匙开不了仓库');
  assert.equal((await alice('GET', '/api/wh/batches', undefined, { raw: true })).status, 401, '客户开不了仓库');
});

test('群主标直邮 / 拼邮，直邮带地址', async () => {
  await admin('PATCH', `/api/admin/customers/${ctx.aId}`, { shipMode: 'direct', directAddress: '张三 13800000000 上海市某路 1 号' });
  const list = await admin('GET', '/api/admin/customers');
  assert.equal(list.customers.find((c) => c.id === ctx.aId).shipMode, 'direct');
  assert.equal(list.customers.find((c) => c.id === ctx.bId).shipMode, 'group');
});

test('仓库拿日本订单号进门，看到按客户分好的东西：大图、货号、直邮地址，没有任何钱', async () => {
  const found = await wh('GET', `/api/wh/lookup?q=${encodeURIComponent(ORDER.toLowerCase())}`);
  assert.equal(found.batches.length, 1, '大小写不计较');
  const byTracking = await wh('GET', `/api/wh/lookup?q=JT${stamp}`);
  assert.equal(byTracking.batches[0].id, ctx.batchId, '运单号也能进门');
  const desk = await wh('GET', `/api/wh/batches/${ctx.batchId}`);
  assertNoMoney(desk, '仓库操作台');
  const a = desk.customers.find((c) => c.id === ctx.aId);
  assert.equal(a.lane, 'direct');
  assert.match(a.directAddress, /上海/);
  assert.equal(a.items.length, 2);
  assert.ok(a.items.every((i) => i.productUrl.includes('602170001')), '同款两件都在，货号靠链接算');
  const b = desk.customers.find((c) => c.id === ctx.bId);
  assert.equal(b.lane, 'group');
  assert.equal(b.directAddress, null, '拼邮的人地址不给仓库');
});

test('【整理完成】：客户那边立刻是「已分拣」', async () => {
  await wh('POST', `/api/wh/batches/${ctx.batchId}/customers/${ctx.aId}/sorted`, {});
  await wh('POST', `/api/wh/batches/${ctx.batchId}/customers/${ctx.bId}/sorted`, {});
  const again = await wh('POST', `/api/wh/batches/${ctx.batchId}/customers/${ctx.aId}/sorted`, {}, { raw: true });
  assert.equal(again.status, 400);
  const view = await alice('GET', `/api/w/${ctx.aToken}`);
  assert.ok(view.items.every((i) => i.status === 'sorted' && i.sortedAt));
  assert.equal(view.summary.sortedCount, 2);
});

test('同一个直邮客户的第二单（单独下单）也分拣好，两单合成一个包裹', async () => {
  const r = await admin('POST', '/api/admin/quick-order', {
    customerId: ctx.aId,
    kind: 'buy',
    orderNo: `${ORDER}-2`,
    lines: [{ url: 'https://www.suruga-ya.jp/product/detail/128000111', priceJpy: '2,000' }],
  });
  assert.equal(r.itemCount, 1);
  assert.equal(r.released, false, '自己下单的默认不放行');
  await admin('POST', '/api/admin/quick-order/release', { batchId: r.batchId });
  ctx.batch2 = r.batchId;
  await wh('POST', `/api/wh/batches/${r.batchId}/customers/${ctx.aId}/sorted`, {});
  const page = await wh('GET', `/api/wh/customers/${ctx.aId}`);
  assertNoMoney(page, '仓库客户页');
  assert.equal(page.items.length, 3, '两单的东西都在这一页');
  const notMine = await wh('POST', '/api/wh/parcels', {
    customerId: ctx.aId, itemIds: [...page.items.map((i) => i.id), (await admin('GET', `/api/admin/customers/${ctx.bId}`)).items[0].id],
    trackingNo: 'SF1', grossWeightG: 100,
  }, { raw: true });
  assert.equal(notMine.status, 400, '别人的东西不能塞进来');
  const created = await wh('POST', '/api/wh/parcels', {
    customerId: ctx.aId,
    itemIds: page.items.map((i) => i.id),
    trackingNo: `SF${stamp}`,
    grossWeightG: 1234,
    photos: [PNG],
  });
  ctx.parcelId = created.id;
  const groupTry = await wh('POST', '/api/wh/parcels', { customerId: ctx.bId, itemIds: [1], trackingNo: 'X', grossWeightG: 1 }, { raw: true });
  assert.equal(groupTry.status, 400, '拼邮的人不打直邮包裹');
});

test('放行之前：客户只知道「已打包」，单号、毛重、运费、平铺图一概看不到', async () => {
  const view = await alice('GET', `/api/w/${ctx.aToken}`);
  const p = view.parcels.find((x) => x.id === ctx.parcelId);
  assert.equal(p.released, false);
  for (const key of ['trackingNo', 'grossWeightG', 'feeFen', 'photoIds', 'costFen', 'saleFenPerKg']) assert.equal(p[key], undefined, key);
  assert.ok(!JSON.stringify(view).includes(`SF${stamp}`), '单号一个字都不许出现');
  assert.ok(view.items.every((i) => i.status === 'packed'));
  const photo = await alice('GET', `/api/w/${ctx.aToken}/parcels/${ctx.parcelId}/photos/1`, undefined, { raw: true });
  assert.equal(photo.status, 404);
  // 群主首页「等单号放行」里有这个包裹，应收按售价算
  const dash = await admin('GET', '/api/admin/dashboard');
  const pending = dash.parcelsPending.find((x) => x.id === ctx.parcelId);
  assert.equal(pending.customerId, ctx.aId);
  assert.equal(pending.grossWeightG, 1234);
  assert.equal(pending.saleFen, 9872, '1234 g × 80 元/kg');
  assert.equal(pending.costFen, undefined, '首页清单不带仓库价');
});

test('仓库的包裹列表也没有钱；群主那边两个价都有、差价算好', async () => {
  const mine = await wh('GET', '/api/wh/parcels');
  assertNoMoney(mine, '仓库包裹列表');
  assert.ok(mine.parcels.some((p) => p.id === ctx.parcelId && p.trackingNo === `SF${stamp}`));
  const day = mine.day;
  const list = await admin('GET', `/api/admin/parcels?day=${day}`);
  const p = list.parcels.find((x) => x.id === ctx.parcelId);
  assert.equal(p.costFen, 8638, '1234 g × 70 元/kg');
  assert.equal(p.saleFen, 9872, '1234 g × 80 元/kg（默认售价）');
  assert.equal(p.marginFen, 9872 - 8638);
  assert.equal(p.items.length, 2 + 1);
  assert.deepEqual([...new Set(p.items.map((i) => i.orderNo))].sort(), [ORDER, `${ORDER}-2`].sort(), '每件来自哪个订单');
  await admin('PATCH', `/api/admin/parcels/${ctx.parcelId}`, { saleFenPerKg: 8500 });
  const after = (await admin('GET', `/api/admin/parcels/${ctx.parcelId}`)).parcel;
  assert.equal(after.saleFen, 10489, '这个包裹单独改成 85 元/kg');
  const tooHigh = await admin('PATCH', `/api/admin/parcels/${ctx.parcelId}`, { saleFenPerKg: 99999999 }, { raw: true });
  assert.equal(tooHigh.status, 400);
});

test('【单号放行】：客户看到单号、毛重、运费（只有售价）、平铺图、每件的订单号；仓库不能再改', async () => {
  await admin('POST', '/api/admin/parcels/release', { parcelIds: [ctx.parcelId] });
  const view = await alice('GET', `/api/w/${ctx.aToken}`);
  const p = view.parcels.find((x) => x.id === ctx.parcelId);
  assert.equal(p.released, true);
  assert.equal(p.trackingNo, `SF${stamp}`);
  assert.equal(p.grossWeightG, 1234);
  assert.equal(p.feeFen, 10489);
  assert.equal(p.costFen, undefined, '仓库单价永远不给客户');
  assert.equal(p.marginFen, undefined);
  assert.equal(p.photoIds.length, 1);
  assert.ok(p.items.every((i) => i.orderNo));
  assert.ok(!JSON.stringify(view).includes('costFen'));
  assert.ok(view.items.every((i) => i.status === 'shipped'));
  const photo = await alice('GET', `/api/w/${ctx.aToken}/parcels/${ctx.parcelId}/photos/${p.photoIds[0]}`, undefined, { raw: true });
  assert.equal(photo.status, 200);
  assert.equal(photo.type, 'image/png');
  const stranger = await bob('GET', `/api/w/${ctx.bToken}/parcels/${ctx.parcelId}/photos/${p.photoIds[0]}`, undefined, { raw: true });
  assert.notEqual(stranger.status, 200, '别人的平铺图看不到');
  const locked = await wh('PATCH', `/api/wh/parcels/${ctx.parcelId}`, { trackingNo: 'changed' }, { raw: true });
  assert.equal(locked.status, 400);
  assert.ok(!(await admin('GET', '/api/admin/dashboard')).parcelsPending.some((x) => x.id === ctx.parcelId), '放行后不再是待办');
  const lockedList = await wh('GET', '/api/wh/parcels');
  assert.equal(lockedList.parcels.find((x) => x.id === ctx.parcelId).locked, true);
});

test('拼邮箱：装进乙的东西、填回国单号、发出 → 乙看到回国单号和回国日期', async () => {
  const box = await wh('POST', '/api/wh/boxes', {});
  const detail = await wh('GET', `/api/wh/boxes/${box.id}`);
  assertNoMoney(detail, '拼邮箱');
  const bobItem = detail.waiting.find((i) => i.customerId === ctx.bId);
  assert.ok(bobItem, '乙分拣好的东西在待装箱里');
  assert.ok(!detail.waiting.some((i) => i.customerId === ctx.aId), '直邮的不出现在拼邮待装箱里');
  await wh('POST', `/api/wh/boxes/${box.id}/items`, { itemIds: [bobItem.id] });
  const early = await wh('POST', `/api/wh/boxes/${box.id}/ship`, {}, { raw: true });
  assert.equal(early.status, 400, '没填回国单号不能发出');
  await wh('PATCH', `/api/wh/boxes/${box.id}`, { trackingNo: `EMS${stamp}` });
  await wh('POST', `/api/wh/boxes/${box.id}/ship`, { returnedAt: '2026-11-03' });
  const view = await bob('GET', `/api/w/${ctx.bToken}`);
  assert.equal(view.items[0].returnTrackingNo, `EMS${stamp}`);
  assert.equal(view.items[0].returnedAt, '2026-11-03');
  assert.equal(view.items[0].status, 'intl_transit');
});

test('转运来的东西（不是群主买的）：只录名称 / 图 + 单号，货款 0，录进来就放行', async () => {
  const noNo = await admin('POST', '/api/admin/quick-order', { customerId: ctx.bId, kind: 'forward', lines: [{ title: '朋友寄来的书' }] }, { raw: true });
  assert.equal(noNo.status, 400, '转运没有单号仓库找不到');
  const r = await admin('POST', '/api/admin/quick-order', {
    customerId: ctx.bId,
    kind: 'forward',
    japanTrackingNo: `FWD${stamp}`,
    lines: [{ title: '朋友寄来的书', imageUrl: 'https://example.com/book.jpg' }],
  });
  assert.equal(r.released, true);
  const view = await bob('GET', `/api/w/${ctx.bToken}`);
  const item = view.items.find((i) => i.japanTrackingNo === `FWD${stamp}`);
  assert.equal(item.goodsFeeJpy, 0);
  assert.equal(item.shop, '转运');
  const found = await wh('GET', `/api/wh/lookup?q=FWD${stamp}`);
  assert.equal(found.batches[0].id, r.batchId);
});

test('直邮名单导入：先预演，确认才写库；认不出来的人列出来', async () => {
  const rows = [
    { name: B, address: '李四 13900000000 北京市' },
    { name: `没这个人${stamp}`, address: 'x' },
  ];
  const dry = await admin('POST', '/api/admin/quick-order/direct-roster', { rows });
  assert.equal(dry.matched, 1);
  assert.equal(dry.problems, 1);
  assert.equal((await admin('GET', '/api/admin/customers')).customers.find((c) => c.id === ctx.bId).shipMode, 'group', '预演不写库');
  await admin('POST', '/api/admin/quick-order/direct-roster', { rows, commit: true });
  const after = (await admin('GET', '/api/admin/customers')).customers.find((c) => c.id === ctx.bId);
  assert.equal(after.shipMode, 'direct');
  assert.match(after.directAddress, /北京/);
});

test('设置里两个单价分开存；停用仓库账号当场掉线', async () => {
  const s = await admin('POST', '/api/admin/settings', { whCostYuanPerKg: '72', directSaleYuanPerKg: '88.5' });
  assert.equal(s.whCostFenPerKg, 7200);
  assert.equal(s.directSaleFenPerKg, 8850);
  const users = await admin('GET', '/api/admin/warehouse-users');
  const me = users.users.find((u) => u.username === `wh${stamp}`);
  await admin('PATCH', `/api/admin/warehouse-users/${me.id}`, { disabled: true });
  assert.equal((await wh('GET', '/api/wh/batches', undefined, { raw: true })).status, 401);
});

test('清理已经走完的旧订单：预演不删，确认才删；没走完的订单一件不碰', async () => {
  // 再录一单还没分拣的：它不该被清理
  const open = await admin('POST', '/api/admin/quick-order', { customerId: ctx.aId, kind: 'buy', orderNo: `OPEN-${stamp}`, lines: [{ title: '还在路上' }] });
  const bad = await admin('POST', '/api/admin/cleanup', { before: '12/01' }, { raw: true });
  assert.equal(bad.status, 400);
  const dry = await admin('POST', '/api/admin/cleanup', { before: '2099-01-01' });
  assert.equal(dry.committed, false);
  const ids = dry.batches.map((b) => b.id);
  assert.ok(ids.includes(ctx.batch2), '直邮放行的那单走完了');
  assert.ok(ids.includes(ctx.batchId), '第一单：甲已寄出、乙回国中，都算走完');
  assert.ok(!ids.includes(open.batchId), '还没分拣的不碰');
  assert.ok(dry.photoCount >= 1);
  assert.equal((await alice('GET', `/api/w/${ctx.aToken}`)).parcels.length, 1, '预演不删');
  const done = await admin('POST', '/api/admin/cleanup', { before: '2099-01-01', commit: true });
  assert.equal(done.committed, true);
  const view = await alice('GET', `/api/w/${ctx.aToken}`);
  assert.equal(view.parcels.length, 0, '包裹和平铺图一起删掉');
  assert.deepEqual(view.items.map((i) => i.orderNo), [`OPEN-${stamp}`].filter(() => false), '没放行的那单客户本来就看不到');
  const adminView = await admin('GET', `/api/admin/customers/${ctx.aId}`);
  assert.deepEqual(adminView.items.map((i) => i.orderNo), [`OPEN-${stamp}`], '只剩没走完的那单');
  assert.equal((await admin('GET', `/api/admin/batches/${ctx.batchId}`, undefined, { raw: true })).status, 404);
});
