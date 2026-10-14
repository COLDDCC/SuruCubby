/**
 * 端到端验收脚本：跑通「导入 → 客户页 → 改状态 → 称重分摊 → 收款 → 寄出」。
 *
 *   npm run test:e2e
 *
 * 脚本会自己起一个隔离实例（8791 + .wrangler/e2e 单独库），跑完关掉。
 * 这个测试会真的写库，所以不给 E2E_BASE 就直接拒绝，免得把测试批次写进你正在用的 8787。
 * 需要 .dev.vars 里的 ADMIN_PASSWORD=test-admin-pw（或用 E2E_PASSWORD 覆盖）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.E2E_BASE || refuse();
function refuse() {
  console.error('测试要写库，不往 8787 塞垃圾。用 npm run test:e2e，或自己给 E2E_BASE。');
  process.exit(1);
}
const PASSWORD = process.env.E2E_PASSWORD || 'test-admin-pw';

const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(method, path, body, { raw = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: cookieHeader(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const cookie of res.headers.getSetCookie?.() ?? []) {
    const [pair] = cookie.split(';');
    const idx = pair.indexOf('=');
    jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 忽略 */
  }
  if (raw) return { status: res.status, data };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const HEADERS = ['名称', '图片', '商品链接', '平时价格', '实际价格', 'cn', '应付日元金额'];
const stamp = Date.now();
const NAMES = [`阿狸${stamp}`, `小明${stamp}`, `小红${stamp}`];
const QQS = [`${stamp}`.slice(-9), `${stamp + 1}`.slice(-9), `${stamp + 2}`.slice(-9)];
const SHEET = {
  headers: HEADERS,
  rows: [
    ['海洋堂手办', null, 'https://www.suruga-ya.jp/product/detail/1', '3,000', '1,800', NAMES[0], '1,800'],
    ['GK 模型', null, null, '2,000', 1500, NAMES[0], 1500],
    ['漫画一套', null, null, null, 2600, NAMES[1], '2600'],
    ['手办盒蛋', null, null, null, 900, NAMES[2], '900'],
    ['', null, null, null, null, NAMES[2], '10'],
  ],
};

const ctx = {};

before(async () => {
  const health = await fetch(`${BASE}/api/meta`).catch(() => null);
  if (!health?.ok) throw new Error(`连不上 ${BASE}，先把 wrangler dev 跑起来`);
});

test('密码不对登不进去', async () => {
  const res = await call('POST', '/api/admin/login', { password: 'wrong' }, { raw: true });
  assert.equal(res.status, 401);
});

test('登录后能拿到会话', async () => {
  await call('POST', '/api/admin/login', { password: PASSWORD });
  const session = await call('GET', '/api/admin/session');
  assert.equal(session.loggedIn, true);
});

test('预览：未匹配的名字要标出来，空名称行被跳过', async () => {
  const preview = await call('POST', '/api/admin/import/preview', {
    fileName: `团购-${stamp}.xlsx`,
    fileHash: `hash-${stamp}`,
    sheet: SHEET,
  });
  assert.equal(preview.totals.rows, 4);
  assert.equal(preview.totals.customers, 3);
  assert.equal(preview.totals.amountJpy, 1800 + 1500 + 2600 + 900);
  assert.equal(preview.totals.unmatched, 3);
  assert.equal(preview.skipped.length, 1);
  assert.equal(preview.duplicate, null);
});

test('导入：建客户、建批次、自动建同名包裹', async () => {
  const result = await call('POST', '/api/admin/import/commit', {
    fileName: `团购-${stamp}.xlsx`,
    fileHash: `hash-${stamp}`,
    sheet: SHEET,
    batchName: `9月20日 第${stamp % 100}团`,
    assignments: NAMES.map((cn, i) => ({
      cn,
      newCustomer: { qq: QQS[i], nickname: cn },
    })),
  });
  assert.equal(result.itemCount, 4);
  assert.equal(result.customerCount, 3);
  assert.equal(result.createdCustomers.length, 3);
  ctx.batchId = result.batchId;
  ctx.packageId = result.packageId;
  ctx.customers = result.createdCustomers;
  for (const c of result.createdCustomers) assert.ok(c.token.length >= 16);
});

test('同一个文件再导会被拦住，确认后才放行', async () => {
  const preview = await call('POST', '/api/admin/import/preview', {
    fileHash: `hash-${stamp}`,
    sheet: SHEET,
  });
  assert.ok(preview.duplicate, '应该认出重复文件');
  const blocked = await call(
    'POST',
    '/api/admin/import/commit',
    { fileHash: `hash-${stamp}`, sheet: SHEET, batchName: '重复的一团' },
    { raw: true },
  );
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /已经导过/);
});

test('第二次用同一个名字导入时自动认人（别名生效）', async () => {
  const preview = await call('POST', '/api/admin/import/preview', {
    fileHash: `hash-${stamp}-2`,
    sheet: {
      headers: HEADERS,
      rows: [['补货一件', null, null, null, 500, NAMES[0], '500']],
    },
  });
  assert.equal(preview.totals.unmatched, 0);
  assert.equal(preview.groups[0].customer.qq, QQS[0]);
});

async function login(qq, password, cookie) {
  const res = await fetch(`${BASE}/api/w/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ qq, password }),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 忽略 */
  }
  return { res, data };
}

test('客户登录：没登录看不到，QQ 或密码不对也看不到', async () => {
  const anonymous = await fetch(`${BASE}/api/w/${ctx.customers[0].token}`);
  assert.equal(anonymous.status, 401);
  assert.equal((await login('99999999', '123456')).res.status, 401);
  assert.equal((await login(QQS[0], '999999')).res.status, 401);
});

test('客户登录：QQ + 初始密码进来，只看得到自己的东西，金额与 Excel 一致', async () => {
  const { res, data } = await login(QQS[0], '123456');
  assert.equal(res.status, 200);
  assert.equal(data.verified, true);
  assert.equal(data.token, ctx.customers[0].token);
  assert.equal(data.mustChange, true, '初始密码没改时要催他改');
  assert.equal(data.customer.nickname, NAMES[0]);
  assert.equal(data.items.length, 2);
  assert.equal(data.summary.goodsUnpaidJpy, 1800 + 1500);
  assert.ok(data.items.every((i) => i.status === 'ordered'));
  assert.ok(!JSON.stringify(data).includes(NAMES[1]), '不能出现别的客户的信息');
  ctx.cookie = res.headers.getSetCookie()[0].split(';')[0];
});

test('还是初始密码时下不了单，改成自己的之后旧密码立刻不好使', async () => {
  const token = ctx.customers[0].token;
  const blocked = await fetch(`${BASE}/api/w/${token}/addresses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ctx.cookie },
    body: JSON.stringify({ recipient: '张三', phone: '13800000000', detail: '某市某路 1 号' }),
  });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /修改密码/);

  // 太短的、还等于初始的都不收
  assert.equal(
    (
      await fetch(`${BASE}/api/w/${token}/password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ctx.cookie },
        body: JSON.stringify({ newPassword: '123456' }),
      })
    ).status,
    400,
  );

  const changed = await fetch(`${BASE}/api/w/${token}/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ctx.cookie },
    body: JSON.stringify({ newPassword: 'ab12cd34' }),
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).relogin, true, '改完密码要告诉前端重新登录');

  // 密码一换，这个 token 之前发出去的 Cookie 全作废：别人抄了链接也进不来
  const staleView = await fetch(`${BASE}/api/w/${token}`, { headers: { cookie: ctx.cookie } });
  assert.equal(staleView.status, 401, '旧 Cookie 不能再用');

  assert.equal((await login(QQS[0], '123456')).res.status, 401, '初始密码不能再登进来');
  const again = await login(QQS[0], 'ab12cd34');
  assert.equal(again.res.status, 200);
  assert.equal(again.data.mustChange, false);
  ctx.cookie = again.res.headers.getSetCookie()[0].split(';')[0];

  const saved = await fetch(`${BASE}/api/w/${token}/addresses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ctx.cookie },
    body: JSON.stringify({ recipient: '张三', phone: '13800000000', detail: '某市某路 1 号' }),
  });
  assert.equal(saved.status, 200);
  ctx.addressId = (await saved.json()).id;
});

test('群主能把客户的密码退回初始密码，也能直接替他设一个', async () => {
  const id = ctx.customers[0].id;
  const detail = await call('GET', `/api/admin/customers/${id}`);
  assert.equal(detail.passwordInitial, false);

  await call('POST', `/api/admin/customers/${id}/password`, { password: '' });
  const back = await call('GET', `/api/admin/customers/${id}`);
  assert.equal(back.passwordInitial, true, '退回后应显示还在用初始密码');
  assert.equal((await login(QQS[0], '123456')).res.status, 200);

  await call('POST', `/api/admin/customers/${id}/password`, { password: 'zhuprovider1' });
  assert.equal((await login(QQS[0], '123456')).res.status, 401);
  const res = (await login(QQS[0], 'zhuprovider1')).res;
  assert.equal(res.status, 200);
  // 群主代设密码同样把客户手上的旧会话踢掉，这里换新 Cookie 继续后面的流程
  ctx.cookie = res.headers.getSetCookie()[0].split(';')[0];
});

test('包裹改状态，客户页同步', async () => {
  const result = await call('POST', `/api/admin/packages/${ctx.packageId}/status`, {
    status: 'intl_transit',
  });
  assert.equal(result.updated, 4);
  const res = await fetch(`${BASE}/api/w/${ctx.customers[0].token}`, {
    headers: { cookie: ctx.cookie },
  });
  const data = await res.json();
  assert.ok(data.items.every((i) => i.status === 'intl_transit'));
  assert.ok(data.timeline.length >= 2);
});

test('cn_stock 之后的状态不允许在包裹层面批量改', async () => {
  const res = await call('POST', `/api/admin/packages/${ctx.packageId}/status`, { status: 'shipped' }, { raw: true });
  assert.equal(res.status, 400);
});

test('称重台：点封面认领、填重量、缺件不进分摊', async () => {
  await call('POST', `/api/admin/packages/${ctx.packageId}/status`, {
    status: 'cn_arrived',
  });
  const weigh = await call('GET', `/api/admin/packages/${ctx.packageId}/weigh`);
  assert.equal(weigh.progress.expectedItems, 4);
  assert.equal(weigh.progress.foundItems, 0);

  for (const customer of weigh.customers) {
    for (const item of customer.items) {
      await call('POST', `/api/admin/packages/${ctx.packageId}/weigh/claim`, {
        itemId: item.id,
        claimed: true,
      });
    }
  }
  const claimed = await call('GET', `/api/admin/packages/${ctx.packageId}/weigh`);
  assert.equal(claimed.progress.foundItems, 4);
  assert.equal(claimed.customers[0].items.length, 2);
  // 认领完但一件都没称：预览和确认必须给同一个答复，不能预览过了、点确认才报错
  for (const path of ['preview', 'commit']) {
    const tooEarly = await call(
      'POST',
      `/api/admin/packages/${ctx.packageId}/allocate/${path}`,
      { totalFeeYuan: '100.00' },
      { raw: true },
    );
    assert.equal(tooEarly.status, 400, `${path} 在没有重量时必须拦住`);
    assert.match(tooEarly.data.error, /称好|没称/);
  }

  for (const customer of claimed.customers) {
    // 每件各自称重，把这一摞的 1000 g 分到件上（零头给第一件）
    const each = Math.floor(1000 / customer.items.length);
    for (const [k, item] of customer.items.entries()) {
      await call('POST', `/api/admin/packages/${ctx.packageId}/weigh/item`, {
        itemId: item.id,
        weightG: k === 0 ? 1000 - each * (customer.items.length - 1) : each,
      });
    }
  }
  const after = await call('GET', `/api/admin/packages/${ctx.packageId}/weigh`);
  assert.equal(after.progress.foundItems, 4);
  assert.equal(after.progress.weighedCustomers, 3);
  assert.deepEqual(
    after.customers.map((c) => c.weightG),
    [1000, 1000, 1000],
    '一摞的重量要等于各件之和',
  );
  ctx.weighCustomers = after.customers;
});

test('不填运费也能分摊：设置里的单价（默认 100 元/kg）× 各摞重量', async () => {
  const settings = await call('GET', '/api/admin/settings');
  assert.equal(settings.intlPriceFenPerKg, 10000, '默认单价应该是 100 元/kg');

  // 三个 1000 g 的摞 = 3000 g，100 元/kg → ¥300.00，每人整 ¥100.00，没有尾差
  const auto = await call('POST', `/api/admin/packages/${ctx.packageId}/allocate/preview`, {});
  assert.equal(auto.priceFenPerKg, 10000, '自动算出来的要把单价还给前端，不然页面上说不清这钱怎么来的');
  assert.equal(auto.totalFeeFen, 30000);
  assert.deepEqual(
    auto.rows.map((r) => r.feeFen),
    [10000, 10000, 10000],
  );
  assert.equal(auto.diffFen, 0);

  // 单价改成 80 元/kg，金额跟着变；国内运费那一栏没动
  const changed = await call('POST', '/api/admin/settings', { intlPriceYuanPerKg: '80' });
  assert.equal(changed.intlPriceFenPerKg, 8000);
  assert.equal(changed.domesticFeeFen, settings.domesticFeeFen, '只改单价不该把国内运费一起改没');
  const cheaper = await call('POST', `/api/admin/packages/${ctx.packageId}/allocate/preview`, {});
  assert.equal(cheaper.totalFeeFen, 24000);

  // 手动填了金额就按填的算，不再乘单价
  const manual = await call(
    'POST',
    `/api/admin/packages/${ctx.packageId}/allocate/preview`,
    { totalFeeYuan: '100.00' },
  );
  assert.equal(manual.priceFenPerKg, null);
  assert.equal(manual.totalFeeFen, 10000);

  // 单价不许填 0：整箱运费会被静默算成 0 元。填错了直接拒，原来的单价也不动
  const zero = await call('POST', '/api/admin/settings', { intlPriceYuanPerKg: '0' }, { raw: true });
  assert.equal(zero.status, 400);
  assert.equal((await call('GET', '/api/admin/settings')).intlPriceFenPerKg, 8000, '被拒时不该改到设置');

  await call('POST', '/api/admin/settings', { intlPriceYuanPerKg: '100' });
});

test('设置里的金额：键名带 Yuan 按元收，带 Fen 按分收', async () => {
  const before = await call('GET', '/api/admin/settings');
  // 以前 *Fen 也会被再乘 100，10 元存成 1000 元；现在按字面意思办
  const saved = await call('POST', '/api/admin/settings', { domesticFeeFen: 1234 });
  assert.equal(saved.domesticFeeFen, 1234, 'Fen 就是分，不能再乘 100');
  assert.equal(saved.intlPriceFenPerKg, before.intlPriceFenPerKg, '只改一项不该动另一项');
  const yuan = await call('POST', '/api/admin/settings', { domesticFeeYuan: '12.34' });
  assert.equal(yuan.domesticFeeFen, 1234, '元换算成分要和上面一致');
  await call('POST', '/api/admin/settings', { domesticFeeFen: before.domesticFeeFen });
  for (const bad of ['abc', '-1', '1.234']) {
    assert.equal(
      (await call('POST', '/api/admin/settings', { domesticFeeFen: bad }, { raw: true })).status,
      400,
      `「${bad}」不是合法的分`,
    );
  }
});

test('分摊：¥100.00 / 三个 1000 g → 每人 ¥33.33，尾差 ¥0.01 记需求方', async () => {
  const preview = await call('POST', `/api/admin/packages/${ctx.packageId}/allocate/preview`, {
    totalFeeYuan: '100.00',
    totalWeightG: 3200,
  });
  assert.deepEqual(
    preview.rows.map((r) => r.feeFen),
    [3333, 3333, 3333],
  );
  assert.equal(preview.diffFen, 1);
  assert.equal(preview.weightDiffG, 200);

  const commit = await call('POST', `/api/admin/packages/${ctx.packageId}/allocate/commit`, {
    totalFeeYuan: '100.00',
    totalWeightG: 3200,
  });
  assert.equal(commit.itemsMovedToStock, 4);

  const detail = await call('GET', `/api/admin/packages/${ctx.packageId}`);
  assert.equal(detail.rounding.diffFen, 1);
  assert.ok(detail.items.every((i) => i.status === 'cn_stock'));
});

test('客户页能看到自己这一摞的重量和运费', async () => {
  const res = await fetch(`${BASE}/api/w/${ctx.customers[0].token}`, {
    headers: { cookie: ctx.cookie },
  });
  const data = await res.json();
  assert.equal(data.weighGroups.length, 1);
  assert.equal(data.weighGroups[0].weightG, 1000);
  assert.equal(data.weighGroups[0].intlFeeFen, 3333);
  assert.equal(data.weighGroups[0].items.length, 2);
  // 这一摞的运费要一分不差地拆到每件上：客户按件勾选，件上的钱加起来必须等于整摞
  const ownFees = data.items.filter((i) => i.intlFeeFen !== null);
  assert.equal(ownFees.length, 2);
  assert.equal(ownFees.reduce((s, i) => s + i.intlFeeFen, 0), 3333);
  assert.ok(ownFees.every((i) => i.intlFeeFen > 0), '每件都要有自己的运费，不能留空');
  assert.equal(data.summary.intlUnpaidFen, 3333);
  assert.equal(data.summary.freightUnpaidFen, 3333);
});

test('已分摊的包裹不能再乱改重量，撤销后可以', async () => {
  const itemId = ctx.weighCustomers[0].items[0].id;
  const blocked = await call(
    'POST',
    `/api/admin/packages/${ctx.packageId}/weigh/item`,
    { itemId, weightG: 1200 },
    { raw: true },
  );
  assert.equal(blocked.status, 400);
  // 逐件称过的摞，重量只由各件之和算出来，直接改整摞那个数会被拦（见下一个用例）
  assert.equal((await call('GET', `/api/admin/packages/${ctx.packageId}/weigh`)).customers[0].weightG, 1000);
  await call('POST', `/api/admin/packages/${ctx.packageId}/allocate/undo`);
  const reverted = await call('GET', `/api/admin/packages/${ctx.packageId}`);
  assert.ok(reverted.items.every((i) => i.status === 'cn_arrived'));
  await call('POST', `/api/admin/packages/${ctx.packageId}/allocate/commit`, {
    totalFeeYuan: '100.00',
  });
});

test('整箱一次到国内：一键全部认领，整摞称一个数就能摊到每件', async () => {
  // 他真实那一箱就是几十件挤在一个包裹里，一件一件称根本来不及：按那个形状再造一箱
  const box = `整箱均摊${stamp}`;
  const people = [`${box}甲`, `${box}乙`, `${box}丙`];
  const added = await call('POST', '/api/admin/import/commit', {
    batchName: box,
    fileHash: box,
    sheet: {
      headers: ['名称', 'cn', '实际价格'],
      rows: [
        ['甲的第一件', people[0], 100],
        ['甲的第二件', people[0], 100],
        ['甲的第三件', people[0], 100],
        ['乙的第一件', people[1], 100],
        ['乙的第二件', people[1], 100],
        ['丙的唯一一件', people[2], 100],
      ],
    },
    assignments: people.map((cn, i) => ({
      cn,
      newCustomer: { qq: `${stamp + 40 + i}`.slice(-9), nickname: cn },
    })),
  });
  const pkgId = added.packageId;
  await call('POST', `/api/admin/packages/${pkgId}/status`, { status: 'cn_arrived' });

  const weigh = await call('GET', `/api/admin/packages/${pkgId}/weigh`);
  assert.equal(weigh.progress.unclaimedItems, 6, '没认领的件数要直接说出来');
  const stackOf = (nickname) => weigh.customers.find((c) => c.nickname === nickname);

  const claimed = await call('POST', `/api/admin/packages/${pkgId}/weigh/claim-all`, {});
  assert.equal(claimed.claimed, 6);
  assert.equal(claimed.customers, 3, '一个客户一摞，不用一件件点');

  const tooEarly = await call('POST', `/api/admin/packages/${pkgId}/allocate/preview`, {}, { raw: true });
  assert.equal(tooEarly.status, 400);
  assert.match(tooEarly.data.error, /整摞放秤上/, '拦住的话要告诉他不称也能填整摞');

  // 丙 那件逐件称（500 g），甲乙只把整摞放秤上：2000 g、1000 g
  const bing = stackOf(people[2]);
  await call('POST', `/api/admin/packages/${pkgId}/weigh/item`, {
    itemId: bing.items[0].id,
    weightG: 500,
  });
  for (const [nickname, weightG] of [[people[0], 2000], [people[1], 1000]]) {
    await call('POST', `/api/admin/packages/${pkgId}/weigh/group`, {
      customerId: stackOf(nickname).customerId,
      weightG,
    });
  }
  const conflict = await call(
    'POST',
    `/api/admin/packages/${pkgId}/weigh/group`,
    { customerId: bing.customerId, weightG: 800 },
    { raw: true },
  );
  assert.equal(conflict.status, 400, '这一摞已经逐件称过，不能再填整摞把口径搅浑');
  assert.match(conflict.data.error, /逐件称/);

  // 3,500 g × 100 元/kg = ¥350.00；按摞重分：甲 ¥200.00、乙 ¥100.00、丙 ¥50.00
  const preview = await call('POST', `/api/admin/packages/${pkgId}/allocate/preview`, {});
  assert.equal(preview.totalFeeFen, 35000);
  const rowOf = (nickname) => preview.rows.find((r) => r.nickname === nickname);
  assert.deepEqual(
    [rowOf(people[0]).feeFen, rowOf(people[1]).feeFen, rowOf(people[2]).feeFen],
    [20000, 10000, 5000],
  );
  assert.equal(rowOf(people[0]).unitMode, 'equal');
  assert.equal(rowOf(people[2]).unitMode, 'byWeight');
  for (const row of preview.rows) {
    assert.equal(row.units.length, row.itemCount);
    assert.equal(
      row.units.reduce((sum, u) => sum + u.feeFen, 0),
      row.feeFen,
      '每件加起来要正好等于这一摞，不能差尾差',
    );
  }
  assert.deepEqual(
    rowOf(people[0]).units.map((u) => u.feeFen).sort((a, b) => b - a),
    [6667, 6667, 6666],
    '¥200.00 摊 3 件：前两件各多 1 分',
  );

  const commit = await call('POST', `/api/admin/packages/${pkgId}/allocate/commit`, {});
  assert.equal(commit.itemsMovedToStock, 6);
  const jiaDetail = await call('GET', `/api/admin/customers/${stackOf(people[0]).customerId}`);
  assert.ok(jiaDetail.items.every((i) => i.status === 'cn_stock'));
  assert.deepEqual(
    jiaDetail.items.map((i) => i.intlFeeFen).sort((a, b) => b - a),
    [6667, 6667, 6666],
  );

  // 整摞称的那几件没有逐件重量，客户页上照样有运费、照样能勾着申请发货
  const jia = added.createdCustomers.find((c) => c.nickname === people[0]);
  await call('POST', `/api/admin/customers/${jia.id}/password`, { password: 'zhengxiang-2026' });
  const sess = await login(jia.qq, 'zhengxiang-2026');
  assert.equal(sess.res.status, 200);
  const cookie = sess.res.headers.getSetCookie()[0].split(';')[0];
  const asMe = async (path, body) => {
    const res = await fetch(`${BASE}/api/w/${jia.token}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  assert.equal(sess.data.summary.stockCount, 3);
  assert.equal(sess.data.items.filter((i) => i.intlFeeFen !== null).length, 3);
  const address = await asMe('/addresses', {
    recipient: '甲',
    phone: '13800000000',
    detail: `某市某路 ${stamp} 号`,
  });
  const requested = await asMe('/requests', {
    itemIds: sess.data.items.filter((i) => i.status === 'cn_stock').map((i) => i.id),
    addressId: address.data.id,
  });
  assert.equal(requested.status, 200, JSON.stringify(requested.data));
});

test('称完一摞先算一摞：不用等全箱几十个人都称完', async () => {
  const box = `分批分摊${stamp}`;
  const people = [`${box}甲`, `${box}乙`, `${box}丙`];
  const added = await call('POST', '/api/admin/import/commit', {
    batchName: box,
    fileHash: box,
    sheet: {
      headers: ['名称', 'cn', '实际价格'],
      rows: [
        ['甲的第一件', people[0], 100],
        ['甲的第二件', people[0], 100],
        ['乙的第一件', people[1], 100],
        ['乙的第二件', people[1], 100],
        ['丙的唯一一件', people[2], 100],
      ],
    },
    assignments: people.map((cn, i) => ({
      cn,
      newCustomer: { qq: `${stamp + 50 + i}`.slice(-9), nickname: cn },
    })),
  });
  const pkgId = added.packageId;
  await call('POST', `/api/admin/packages/${pkgId}/status`, { status: 'cn_arrived' });
  await call('POST', `/api/admin/packages/${pkgId}/weigh/claim-all`, {});

  const weigh = await call('GET', `/api/admin/packages/${pkgId}/weigh`);
  const stackOf = (nickname) => weigh.customers.find((c) => c.nickname === nickname);
  const price = (await call('GET', '/api/admin/settings')).intlPriceFenPerKg;
  const feeOf = Math.round((1000 * price) / 1000);

  // 只有甲那摞称了 1000 g：预览就只能算甲，且要明说还有几摞没进来
  await call('POST', `/api/admin/packages/${pkgId}/weigh/group`, {
    customerId: stackOf(people[0]).customerId,
    weightG: 1000,
  });
  const first = await call('POST', `/api/admin/packages/${pkgId}/allocate/preview`, {});
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].nickname, people[0]);
  assert.equal(first.totalFeeFen, feeOf, '只按称好的那一摞算钱，不能把没称的也摊进去');
  assert.equal(first.fullBox, false);
  assert.equal(first.pendingStacks, 2);
  assert.deepEqual([...first.pendingNames].sort(), [people[1], people[2]].sort());

  // 手填的是转运仓整箱实收：半箱就填会把整箱运费全压在甲头上，必须拦
  for (const path of ['preview', 'commit']) {
    const manual = await call(
      'POST',
      `/api/admin/packages/${pkgId}/allocate/${path}`,
      { totalFeeYuan: '100.00' },
      { raw: true },
    );
    assert.equal(manual.status, 400, `${path} 在半箱时不该收手填总额`);
    assert.match(manual.data.error, /实收总额/);
  }

  const committed = await call('POST', `/api/admin/packages/${pkgId}/allocate/commit`, {});
  assert.equal(committed.itemsMovedToStock, 2);
  const mid = await call('GET', `/api/admin/packages/${pkgId}/weigh`);
  const midStack = (nickname) => mid.customers.find((c) => c.nickname === nickname);
  assert.equal(midStack(people[0]).intlFeeFen, feeOf);
  assert.ok(midStack(people[0]).items.every((i) => i.status === 'cn_stock'));
  assert.equal(midStack(people[1]).intlFeeFen, null);
  assert.ok(midStack(people[1]).items.every((i) => i.status === 'cn_arrived'), '没称的人状态不该动');
  assert.ok(midStack(people[2]).items.every((i) => i.status === 'cn_arrived'));

  // 已封账的那摞不能再改重量、不能再塞东西、也不能标缺件
  const jiaItem = midStack(people[0]).items[0].id;
  for (const [path, body] of [
    ['weigh/item', { itemId: jiaItem, weightG: 1200 }],
    ['weigh/group', { customerId: midStack(people[0]).customerId, weightG: 1200 }],
    ['weigh/missing', { itemId: jiaItem, missing: true }],
    ['weigh/claim', { itemId: jiaItem, claimed: false }],
  ]) {
    const res = await call('POST', `/api/admin/packages/${pkgId}/${path}`, body, { raw: true });
    assert.equal(res.status, 400, `${path} 不该让改已封账的那摞`);
    assert.match(res.data.error, /这一摞已经算过运费/);
  }

  // 甲这边不用等乙丙：直接申请发货
  const jia = added.createdCustomers.find((c) => c.nickname === people[0]);
  await call('POST', `/api/admin/customers/${jia.id}/password`, { password: 'fenpi-2026' });
  const sess = await login(jia.qq, 'fenpi-2026');
  const cookie = sess.res.headers.getSetCookie()[0].split(';')[0];
  assert.equal(sess.data.summary.stockCount, 2, '只有算过费的那两件是可发货的');
  const asMe = async (path, body) => {
    const res = await fetch(`${BASE}/api/w/${jia.token}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const addr = await asMe('/addresses', {
    recipient: '甲',
    phone: '13800000000',
    detail: `某市某路 ${stamp} 号`,
  });
  const requested = await asMe('/requests', {
    itemIds: sess.data.items.filter((i) => i.status === 'cn_stock').map((i) => i.id),
    addressId: addr.data.id,
  });
  assert.equal(requested.status, 200, JSON.stringify(requested.data));

  // 第二批：乙称好了，只算乙，甲那摞不能被算第二遍
  await call('POST', `/api/admin/packages/${pkgId}/weigh/group`, {
    customerId: midStack(people[1]).customerId,
    weightG: 1000,
  });
  const second = await call('POST', `/api/admin/packages/${pkgId}/allocate/preview`, {});
  assert.equal(second.rows.length, 1);
  assert.equal(second.rows[0].nickname, people[1]);
  assert.equal(second.chargedStacks, 1);
  assert.equal(second.totalFeeFen, feeOf);
  await call('POST', `/api/admin/packages/${pkgId}/allocate/commit`, {});
  const afterTwo = await call('GET', `/api/admin/packages/${pkgId}`);
  assert.equal(afterTwo.package.totalFeeFen, feeOf * 2, '这一箱的总额是两次分摊累加出来的');
  assert.equal(
    afterTwo.items.filter((i) => i.status === 'cn_stock').length,
    4,
    '甲那两件先可发货，乙这两件跟着进来',
  );

  // 最后一摞：全箱弄完了，手填实收总额这条路才打开
  await call('POST', `/api/admin/packages/${pkgId}/weigh/group`, {
    customerId: midStack(people[2]).customerId,
    weightG: 1000,
  });
  const last = await call('POST', `/api/admin/packages/${pkgId}/allocate/preview`, {});
  assert.equal(last.fullBox, true);
  assert.equal(last.pendingStacks, 0);
  assert.equal(last.rows.length, 1, '已经算过的两摞不再重复出现在这次分摊里');
  await call('POST', `/api/admin/packages/${pkgId}/allocate/commit`, { totalFeeYuan: '50.00' });
  const done = await call('GET', `/api/admin/packages/${pkgId}`);
  assert.equal(done.package.totalFeeFen, feeOf * 2 + 5000);
  assert.equal(done.items.filter((i) => i.status === 'cn_stock').length, 5);
  assert.equal(
    (await call('GET', `/api/admin/packages/${pkgId}/weigh`)).progress.weighedCustomers,
    3,
  );
});

test('货款收款与撤销', async () => {
  const customerId = ctx.customers[0].id;
  const payment = await call('POST', '/api/admin/payments', {
    customerId,
    kind: 'goods',
    batchId: ctx.batchId,
  });
  assert.equal(payment.amount, 1800 + 1500);
  let detail = await call('GET', `/api/admin/customers/${customerId}`);
  assert.equal(detail.summary.goodsUnpaidJpy, 0);

  await call('DELETE', `/api/admin/payments/${payment.id}`);
  detail = await call('GET', `/api/admin/customers/${customerId}`);
  assert.equal(detail.summary.goodsUnpaidJpy, 1800 + 1500);
  await call('POST', '/api/admin/payments', {
    customerId,
    kind: 'goods',
    batchId: ctx.batchId,
  });
});

test('一键按批收货款：一次给每个没付的人各记一笔，撤销只退那一笔', async () => {
  const others = ctx.customers.slice(1);
  const read = (customer) => call('GET', `/api/admin/customers/${customer.id}`);
  const before = await Promise.all(others.map(read));
  assert.deepEqual(
    before.map((detail) => detail.summary.goodsUnpaidJpy).sort((a, b) => a - b),
    [900, 2600],
  );
  const byAmount = new Map(before.map((detail) => [detail.summary.goodsUnpaidJpy, detail.customer.id]));

  const result = await call('POST', '/api/admin/payments/all-goods', { batchId: ctx.batchId });
  assert.equal(result.customers, 2);
  assert.equal(result.itemCount, 2);
  assert.equal(result.amountJpy, 2600 + 900);

  for (const id of byAmount.values()) assert.equal((await read({ id })).summary.goodsUnpaidJpy, 0);

  const again = await call('POST', '/api/admin/payments/all-goods', { batchId: ctx.batchId }, { raw: true });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /没有要收的货款/);

  // 撤销 2600 那一笔，只退这个人，另一个人的收款不动
  const bigId = byAmount.get(2600);
  const smallId = byAmount.get(900);
  const payments = await call('GET', `/api/admin/payments?customerId=${bigId}`);
  const mine = payments.payments.find((p) => p.kind === 'goods' && p.refId === ctx.batchId);
  assert.equal(mine.amount, 2600);
  await call('DELETE', `/api/admin/payments/${mine.id}`);

  assert.equal((await read({ id: bigId })).summary.goodsUnpaidJpy, 2600);
  assert.equal((await read({ id: smallId })).summary.goodsUnpaidJpy, 0);

  // 恢复原状：这一批只留客户 0 那一笔，后面的用例还要按未付来算
  const other = await call('GET', `/api/admin/payments?customerId=${smallId}`);
  const theirs = other.payments.find((p) => p.kind === 'goods' && p.refId === ctx.batchId);
  await call('DELETE', `/api/admin/payments/${theirs.id}`);
  assert.equal((await read({ id: smallId })).summary.goodsUnpaidJpy, 900);
});

test('国际运费没付就寄出会被拦住，强制继续时算上未付运费', async () => {
  const customerId = ctx.customers[0].id;
  const detail = await call('GET', `/api/admin/customers/${customerId}`);
  const itemIds = detail.items.filter((i) => i.status === 'cn_stock').map((i) => i.id);
  const blocked = await call('POST', '/api/admin/shipments', { customerId, itemIds }, { raw: true });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.unpaidIntlFen, 3333);
  assert.equal(blocked.data.totalDueFen, 1000 + 3333);

  const group = detail.weighGroups[0];
  await call('POST', '/api/admin/payments', {
    customerId,
    kind: 'intl',
    weighGroupId: group.id,
  });
  const shipment = await call('POST', '/api/admin/shipments', {
    customerId,
    itemIds,
  });
  assert.equal(shipment.feeFen, 1000);
  assert.equal(shipment.itemCount, 2);
  ctx.shipmentId = shipment.id;

  const after = await call('GET', `/api/admin/customers/${customerId}`);
  assert.ok(after.items.filter((i) => itemIds.includes(i.id)).every((i) => i.status === 'shipped'));
  assert.equal(after.summary.domesticUnpaidFen, 1000);
});

test('一键按批收运费：这个包裹每一摞各记一笔，收过的那摞不再动', async () => {
  const read = async (id) => {
    const detail = await call('GET', `/api/admin/customers/${id}`);
    return { detail, group: detail.weighGroups.find((g) => g.packageId === ctx.packageId) };
  };
  const others = ctx.customers.slice(1);
  const state = await Promise.all(others.map((c) => read(c.id)));
  for (const { group } of state) assert.ok(group && !group.feePaid);

  // 先按老办法收第一个人的那一摞，验证一键收不会重复扣他
  await call('POST', '/api/admin/payments', {
    customerId: others[0].id,
    kind: 'intl',
    weighGroupId: state[0].group.id,
  });

  const result = await call('POST', '/api/admin/payments/all-intl', { packageId: ctx.packageId });
  assert.equal(result.customers, 1);
  assert.equal(result.amountFen, state[1].group.intlFeeFen);
  assert.equal(result.skipped, 0);

  const paid = await Promise.all(others.map((c) => read(c.id)));
  for (const { detail, group } of paid) {
    assert.equal(group.feePaid, 1);
    assert.equal(detail.summary.intlUnpaidFen, 0);
  }

  // 恢复原状：撤销这两笔，后面的用例还要按未收运费算
  for (const { detail, group } of paid) {
    const list = await call('GET', `/api/admin/payments?customerId=${detail.customer.id}`);
    const mine = list.payments.find((p) => p.kind === 'intl' && p.refId === group.id);
    assert.ok(mine, '应该能找到这笔运费收款');
    await call('DELETE', `/api/admin/payments/${mine.id}`);
  }
  const reverted = await Promise.all(others.map((c) => read(c.id)));
  assert.deepEqual(
    reverted.map(({ detail, group }) => [group.feePaid, detail.summary.intlUnpaidFen]),
    state.map(({ group, detail }) => [group.feePaid, detail.summary.intlUnpaidFen]),
  );
});

test('填单号、收国内运费', async () => {
  await call('PATCH', `/api/admin/shipments/${ctx.shipmentId}`, {
    trackingNo: 'SF123456789',
  });
  await call('POST', '/api/admin/payments', {
    customerId: ctx.customers[0].id,
    kind: 'domestic',
    shipmentId: ctx.shipmentId,
  });
  const detail = await call('GET', `/api/admin/customers/${ctx.customers[0].id}`);
  assert.equal(detail.summary.goodsUnpaidJpy, 0);
  assert.equal(detail.summary.freightUnpaidFen, 0);
  assert.equal(detail.shipments[0].trackingNo, 'SF123456789');
});

test('客户申请发货：勾货 → 群主确认收款 → 填单号寄出', async () => {
  const me = ctx.customers[1];
  await call('POST', `/api/admin/customers/${me.id}/password`, { password: 'fahuo-2026' });
  const sess = await login(me.qq, 'fahuo-2026');
  assert.equal(sess.res.status, 200);
  const cookie = sess.res.headers.getSetCookie()[0].split(';')[0];
  const asMe = async (path, body, method = 'POST') => {
    const res = await fetch(`${BASE}/api/w/${me.token}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  // 地址最多存 3 个，第 4 个要拦住
  const addresses = [];
  for (const n of [1, 2, 3]) {
    const r = await asMe('/addresses', {
      recipient: `小明${n}`,
      phone: '13800000000',
      detail: `某市某路 ${n} 号`,
    });
    assert.equal(r.status, 200);
    addresses.push(r.data.id);
  }
  assert.equal(
    (await asMe('/addresses', { recipient: '小明4', phone: '13800000000', detail: '某市某路 4 号' }))
      .status,
    400,
    '最多保存 3 个地址',
  );

  const mine = sess.data.items.filter((i) => i.status === 'cn_stock');
  assert.equal(mine.length, 1);
  const foreignItem = (await call('GET', `/api/admin/customers/${ctx.customers[2].id}`)).items.find(
    (i) => i.status === 'cn_stock',
  );
  assert.ok(foreignItem, '另一个客户也该有可发货的东西，才验得出越权');
  assert.equal(
    (await asMe('/requests', { itemIds: [mine[0].id, foreignItem.id], addressId: addresses[0] })).status,
    400,
    '别人的货勾不进自己的申请',
  );

  const first = await asMe('/requests', { itemIds: [mine[0].id], addressId: addresses[0] });
  assert.equal(first.status, 200);
  assert.equal(
    (await asMe('/requests', { itemIds: [mine[0].id], addressId: addresses[0] })).status,
    400,
    '同一件不能申请两次',
  );
  assert.equal(
    (await asMe(`/requests/${first.data.id}`, undefined, 'DELETE')).status,
    200,
    '没确认收款前客户能自己撤回',
  );

  const requestId = (await asMe('/requests', { itemIds: [mine[0].id], addressId: addresses[1] })).data.id;
  assert.equal(
    (await call('POST', `/api/admin/requests/${requestId}/ship`, { trackingNo: 'YT0' }, { raw: true }))
      .status,
    400,
    '没确认收款不能直接寄出',
  );

  const list = await call('GET', '/api/admin/requests');
  const row = list.requests.find((r) => r.id === requestId);
  assert.equal(row.status, 'pending');
  assert.deepEqual(JSON.parse(row.address_snapshot), {
    recipient: '小明2',
    phone: '13800000000',
    detail: '某市某路 2 号',
  });
  assert.equal(
    list.items.filter((i) => i.request_id === requestId).reduce((s, i) => s + i.intl_fee_fen, 0),
    3333,
  );
  assert.equal(row.domestic_fee_fen, 1000);

  await call('POST', `/api/admin/requests/${requestId}/paid`);
  const paid = await call('GET', `/api/admin/payments?customerId=${me.id}`);
  assert.deepEqual(
    paid.payments.filter((p) => p.kind === 'item_intl').map((p) => [p.refId, p.amount]),
    [[mine[0].id, 3333]],
    '按件各记一笔国际运费',
  );
  const dom = paid.payments.find((p) => p.kind === 'domestic');
  assert.equal(dom.amount, 1000);
  assert.equal(dom.refId, requestId);
  assert.equal(
    (await asMe(`/requests/${requestId}`, undefined, 'DELETE')).status,
    400,
    '确认收款后客户不能反悔',
  );

  await call('POST', `/api/admin/requests/${requestId}/ship`, { trackingNo: 'YT9988776655' });
  const after = await call('GET', `/api/admin/customers/${me.id}`);
  assert.equal(after.items.find((i) => i.id === mine[0].id).status, 'shipped');
  assert.equal(after.summary.intlUnpaidFen, 0, '这一摞的国际运费收清了');
  assert.equal(after.summary.domesticUnpaidFen, 0);
  assert.equal(after.shipments[0].trackingNo, 'YT9988776655');
  // 国内运费那笔要跟着换成寄出记录，撤销收款时才知道退的是哪一趟
  assert.equal(
    (await call('GET', `/api/admin/payments?customerId=${me.id}`)).payments.find(
      (p) => p.kind === 'domestic',
    ).refId,
    after.shipments[0].id,
  );
  assert.equal((await asMe('', undefined, 'GET')).data.shipments[0].trackingNo, 'YT9988776655');
  ctx.shippedItem = mine[0].id;
});

test('已寄出的能标已签收，可发货和已寄出不许从外面硬设', async () => {
  assert.equal((await call('PATCH', `/api/admin/items/${ctx.shippedItem}`, { status: 'delivered' })).ok, true);
  const detail = await call('GET', `/api/admin/customers/${ctx.customers[1].id}`);
  assert.equal(detail.items.find((i) => i.id === ctx.shippedItem).status, 'delivered');
  assert.ok(detail.timeline.some((t) => t.toStatus === 'delivered'), '状态历史要留痕');

  // 没称过重、也没寄出过的件：这两个状态只能由称重确认 / 寄出流程写出来
  const box = `裸状态${stamp}`;
  const added = await call('POST', '/api/admin/import/commit', {
    batchName: box,
    fileHash: box,
    sheet: { headers: ['名称', 'cn', '实际价格'], rows: [['还没称的一件', box, 100]] },
    assignments: [{ cn: box, newCustomer: { qq: `${stamp + 31}`.slice(-9), nickname: box } }],
  });
  const rawItem = (await call('GET', `/api/admin/batches/${added.batchId}`)).items[0];
  for (const status of ['cn_stock', 'shipped']) {
    const res = await call('PATCH', `/api/admin/items/${rawItem.id}`, { status }, { raw: true });
    assert.equal(res.status, 400, `${status} 只能走称重确认 / 寄出流程`);
    assert.match(res.data.error, /称重|寄出/);
  }
});

test('请求体不是 JSON 对象时报 400，不甩 500', async () => {
  for (const body of ['null', '[1,2]', '"abc"', '123', '{', '']) {
    const res = await fetch(`${BASE}/api/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader() },
      body,
    });
    assert.equal(res.status, 400, `后台收到「${body}」应该是 400`);
  }
  const me = ctx.customers[1];
  const cookie = (await login(me.qq, 'fahuo-2026')).res.headers.getSetCookie()[0].split(';')[0];
  const res = await fetch(`${BASE}/api/w/${me.token}/addresses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: '[{"recipient":"a"}]',
  });
  assert.equal(res.status, 400, '客户页也是同样口径');
});

test('计费后禁止直接砍单；未计费取消件和已付退款清单仍正常', async () => {
  const detail = await call('GET', `/api/admin/customers/${ctx.customers[1].id}`);
  const blocked = await call('PATCH', `/api/admin/items/${detail.items[0].id}`, { status: 'cancelled' }, { raw: true });
  assert.equal(blocked.status, 400);
  const name = `退款${stamp}`;
  const added = await call('POST', '/api/admin/import/commit', {
    batchName: name,
    fileHash: name,
    sheet: {
      headers: HEADERS,
      rows: [['待退款', null, null, null, 100, name, 10]],
    },
    assignments: [{ cn: name, customerId: ctx.customers[1].id }],
  });
  const fresh = await call('GET', `/api/admin/batches/${added.batchId}`);
  const item = fresh.items[0];
  await call('POST', '/api/admin/payments', {
    customerId: ctx.customers[1].id,
    kind: 'goods',
    itemIds: [item.id],
  });
  await call('PATCH', `/api/admin/items/${item.id}`, { status: 'cancelled' });
  const dashboard = await call('GET', '/api/admin/dashboard');
  assert(dashboard.pendingRefunds.some((r) => r.itemId === item.id));
});

test('重置链接后旧链接立刻失效', async () => {
  const customerId = ctx.customers[0].id;
  const oldToken = ctx.customers[0].token;
  await call('POST', `/api/admin/customers/${customerId}/reset-token`);
  const res = await fetch(`${BASE}/api/w/${oldToken}`, {
    headers: { cookie: ctx.cookie },
  });
  assert.equal(res.status, 401);
});

test('有运费账目冲突时禁止合并；没有计费的客户可安全合并', async () => {
  const unsafe = await call(
    'POST',
    '/api/admin/customers/merge',
    { sourceId: ctx.customers[2].id, targetId: ctx.customers[1].id },
    { raw: true },
  );
  assert.equal(unsafe.status, 400);
  const a = await call('POST', '/api/admin/customers', {
    qq: '5' + QQS[0],
    nickname: 'mergeA' + stamp,
  });
  const b = await call('POST', '/api/admin/customers', {
    qq: '6' + QQS[0],
    nickname: 'mergeB' + stamp,
  });
  await call('POST', '/api/admin/customers/merge', {
    sourceId: a.id,
    targetId: b.id,
  });
  const merged = await call('GET', `/api/admin/customers/${b.id}`);
  assert(merged.aliases.includes('mergeA' + stamp));
  const gone = await call('GET', `/api/admin/customers/${a.id}`, undefined, {
    raw: true,
  });
  assert.equal(gone.status, 404);
});

test('QQ 连错 5 次会锁定 15 分钟', async () => {
  await call('POST', '/api/admin/customers', {
    qq: `${stamp + 3}`.slice(-9),
    nickname: `锁定测试${stamp}`,
  });
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = (await login('10000', '123456')).res;
  }
  assert.equal(last.status, 429);
});

test('图片：=IMAGE("...") 公式认得出来，抓下来存进 R2，之后只走自己的域名', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const server = http.createServer((req, res) => {
    if (req.url === '/a.png' || req.url === '/og.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    } else if (req.url === '/p/1') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><meta property="og:image" content="/og.png"></head></html>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  try {
    const cn = `图片测试${stamp}`;
    const imported = await call('POST', '/api/admin/import/commit', {
      fileHash: `hash-${stamp}-img`,
      batchName: `图片批次 ${stamp}`,
      sheet: {
        headers: HEADERS,
        rows: [
          // 在线版 Excel 存出来的单元格里就是这么一串公式
          ['公式图片', `=IMAGE("${origin}/a.png")`, null, null, 1000, cn, '10'],
          // 没有图片列，只有商品链接 → 去抓 og:image
          ['靠商品页补图', null, `${origin}/p/1`, null, 1000, cn, '10'],
        ],
      },
      assignments: [{ cn, newCustomer: { qq: `${stamp + 7}`.slice(-9), nickname: cn } }],
    });

    const result = await call('POST', `/api/admin/batches/${imported.batchId}/images`);
    // 没开 R2 时只需要处理「压根没有图」的那件；开了 R2 两件都要抓进桶
    assert.equal(result.tried, result.r2 ? 2 : 1);
    if (result.r2) {
      assert.equal(result.cached, 2, `应该抓下来两张：${JSON.stringify(result.failures)}`);
    } else {
      assert.equal(result.linked, 1, '没绑 R2 时至少把 og:image 外链补上');
    }
    assert.equal(result.left, 0);

    const detail = await call('GET', `/api/admin/batches/${imported.batchId}`);
    for (const item of detail.items) {
      if (result.r2) {
        assert.match(item.imageUrl, /^\/img\/[0-9a-f]{32}\.png$/, item.title);
        const res = await fetch(`${BASE}${item.imageUrl}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/png');
        assert.equal((await res.arrayBuffer()).byteLength, png.byteLength);
      } else {
        assert.ok(item.imageUrl.startsWith(origin), item.title);
      }
    }

    // 再点一次不会重复抓
    const again = await call('POST', `/api/admin/batches/${imported.batchId}/images`);
    assert.equal(again.tried, 0, '处理过的不该再抓一遍');

    // 页面用的是 /img/i/{id}：Worker 转一道 + 边缘缓存，不用开图床
    const first = detail.items.find((i) => i.title === '公式图片');
    const proxied = await fetch(`${BASE}/img/i/${first.id}`);
    assert.equal(proxied.status, 200);
    assert.equal(proxied.headers.get('content-type'), 'image/png');
    assert.equal((await proxied.arrayBuffer()).byteLength, png.byteLength);
    assert.match(proxied.headers.get('cache-control') ?? '', /max-age=/);

    // 再取一次（可能命中边缘缓存）结果一样
    const twice = await fetch(`${BASE}/img/i/${first.id}`);
    assert.equal(twice.status, 200);
  } finally {
    server.close();
  }
});

test('/img/ 只认规范 key，乱传路径拿不到东西', async () => {
  const res = await fetch(`${BASE}/img/..%2F..%2Fsecret`);
  assert.equal(res.status, 404);
});

test('图片代理只认库里存着的物品，不是开放代理', async () => {
  const missing = await fetch(`${BASE}/img/i/99999999`);
  assert.equal(missing.status, 404);
  const bad = await fetch(`${BASE}/img/i/abc`);
  assert.equal(bad.status, 404);
});

test('改过昵称的客户，表里写新名字、旧名字、带空格都还能自动对上', async () => {
  await call('POST', '/api/admin/login', { password: PASSWORD });
  const qqOld = '1000000';
  const person = await call('POST', '/api/admin/customers', {
    qq: qqOld,
    nickname: `旧名${stamp}`,
  });
  await call('PATCH', `/api/admin/customers/${person.id}`, {
    nickname: `新名${stamp}`,
  });

  const sheet = {
    headers: ['名称', 'cn', '实际价格'],
    rows: [
      ['A', `新名${stamp}`, 100],
      ['B', ` 旧名${stamp} `, 100],
      ['C', `Ｍｅｏｗ${stamp}`, 100],
    ],
  };
  await call('POST', '/api/admin/customers', {
    qq: '1000001',
    nickname: `Meow${stamp}`,
  });

  const preview = await call('POST', '/api/admin/import/preview', { sheet });
  const byName = Object.fromEntries(preview.groups.map((g) => [g.cn, g]));
  assert.equal(byName[`新名${stamp}`].matchedBy, 'exact', '改过的昵称本身就该能认出来');
  assert.equal(byName[`旧名${stamp}`].matchedBy, 'exact', '旧名字留着别名，早前的表还能对上');
  assert.equal(byName[`Ｍｅｏｗ${stamp}`].matchedBy, 'normalized', '全角写法要靠归一化认，不是碰运气');
  assert.equal(byName[`Ｍｅｏｗ${stamp}`].customer.qq, '1000001');
  assert.equal(preview.totals.unmatched, 0, '三个写法都不用人工指认');

  const committed = await call('POST', '/api/admin/import/commit', {
    batchName: `别名${stamp}`,
    sheet,
  });
  assert.equal(committed.createdCustomers.length, 0, '不该凭空多出客户');
  assert.equal(committed.customerCount, 2, '旧名/新名是同一个人，全角 Meow 是另一个');
  const detail = await call('GET', `/api/admin/customers/${byName[`新名${stamp}`].customer.id}`);
  assert.equal(detail.items.filter((i) => i.batchId === committed.batchId).length, 2, '表里两种写法都并到同一个人身上');
});

test('名字撞在好几个人身上时不许瞎猜，要给新 QQ 建重名人时拦住说清楚', async () => {
  await call('POST', '/api/admin/login', { password: PASSWORD });
  const a = await call('POST', '/api/admin/customers', {
    qq: '1000002',
    nickname: `双${stamp}`,
  });
  await call('POST', '/api/admin/customers', {
    qq: '1000003',
    nickname: `双 ${stamp}`,
  });

  const sheet = {
    headers: ['名称', 'cn', '实际价格'],
    // 中间两个空格：跟哪位的写法都不完全一样，归一化后又都撞得上
    rows: [['A', `双  ${stamp}`, 100]],
  };
  const preview = await call('POST', '/api/admin/import/preview', { sheet });
  assert.equal(preview.groups[0].matchedBy, 'ambiguous');
  assert.equal(preview.groups[0].candidates.length, 2);

  const blocked = await call('POST', '/api/admin/import/commit', { batchName: `歧义${stamp}`, sheet }, { raw: true });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /好几个客户/);

  const clash = await call(
    'POST',
    '/api/admin/import/commit',
    {
      batchName: `撞名${stamp}`,
      sheet: {
        headers: ['名称', 'cn', '实际价格'],
        rows: [['A', `撞名${stamp}`, 100]],
      },
      assignments: [
        {
          cn: `撞名${stamp}`,
          newCustomer: {
            qq: '1000004',
            nickname: `双${stamp}`,
          },
        },
      ],
    },
    { raw: true },
  );
  assert.equal(clash.status, 400);
  assert.match(clash.data.error, /已经是客户/);

  const picked = await call('POST', '/api/admin/import/commit', {
    batchName: `选定${stamp}`,
    sheet,
    assignments: [{ cn: `双  ${stamp}`, customerId: a.id }],
  });
  assert.equal(picked.createdCustomers.length, 0);
});

test('自动认错了人：管理员改指认后，货跟着指认走，名字也换到人身上', async () => {
  await call('POST', '/api/admin/login', { password: PASSWORD });
  const wrong = await call('POST', '/api/admin/customers', { qq: '1000005', nickname: `认错${stamp}` });
  const right = await call('POST', '/api/admin/customers', { qq: '1000006', nickname: `该是这位${stamp}` });
  const sheet = { headers: ['名称', 'cn', '实际价格'], rows: [['A', `认错${stamp}`, 100]] };

  const before = await call('POST', '/api/admin/import/preview', { sheet });
  assert.equal(before.groups[0].customer.id, wrong.id, '表里的名字默认自动认成第一位');

  const committed = await call('POST', '/api/admin/import/commit', {
    batchName: `纠正${stamp}`,
    sheet,
    assignments: [{ cn: `认错${stamp}`, customerId: right.id }],
  });
  assert.equal(committed.customerCount, 1);
  const batchItems = await call('GET', `/api/admin/batches/${committed.batchId}`);
  assert.equal(batchItems.items[0].customerId, right.id, '这一批的货记到指认的那位');
  assert.equal(batchItems.items[0].goodsFeeJpy, 100, '日元货款不受指认影响');

  const after = await call('POST', '/api/admin/import/preview', {
    sheet: { headers: ['名称', 'cn', '实际价格'], rows: [['B', `认错${stamp}`, 50]] },
  });
  assert.equal(after.groups[0].customer.id, right.id, '下次同样写法自动认的是纠正后的那位');

  const wrongDetail = await call('GET', `/api/admin/customers/${wrong.id}`);
  assert.ok(!wrongDetail.aliases.includes(`认错${stamp}`), '名字要从认错的客户身上放掉');
  const rightDetail = await call('GET', `/api/admin/customers/${right.id}`);
  assert.ok(rightDetail.aliases.includes(`认错${stamp}`), '名字要挂到指认的客户身上');
});

test('名单导入：一次把客户建齐，真名只进后台，撞名的行不动', async () => {
  await call('POST', '/api/admin/login', { password: PASSWORD });
  const roster = [
    { nickname: `名单甲${stamp}`, qq: '2000001', realName: `甲真实${stamp}` },
    { nickname: `名单乙${stamp}`, qq: '2000002', realName: null },
    { nickname: `名单乙${stamp}`, qq: '2000002', realName: null },
    { nickname: `名单丙${stamp}`, qq: 'abc', realName: null },
    { nickname: `名单甲${stamp}`, qq: '2000004', realName: null },
  ];

  const dry = await call('POST', '/api/admin/customers/import', { dryRun: true, rows: roster });
  assert.equal(dry.counts.created, 2, '两个没见过的 QQ');
  assert.equal(dry.counts.conflicts, 1);
  assert.equal(dry.counts.errors, 1);
  assert.match(dry.conflicts[0].reason, /已经是/);
  assert.match(dry.errors[0].reason, /不像 QQ 号/);

  const afterDry = await call('GET', `/api/admin/customers?q=${encodeURIComponent('名单甲')}`);
  assert.equal(afterDry.customers.length, 0, '预演不能写库');

  const done = await call('POST', '/api/admin/customers/import', { dryRun: false, rows: roster });
  assert.equal(done.counts.created, 2);
  assert.equal(done.counts.updated, 0, '同一个人重复出现不该算成第二个人');

  const byName = await call('GET', `/api/admin/customers?q=${encodeURIComponent('名单甲')}`);
  assert.equal(byName.customers.length, 1, '撞名那行没多出一个人');
  const jia = byName.customers[0];
  assert.equal(jia.qq, '2000001');
  assert.equal(jia.realName, `甲真实${stamp}`);

  const byReal = await call('GET', `/api/admin/customers?q=${encodeURIComponent('甲真实')}`);
  assert.equal(byReal.customers.length, 1, '后台能按真名搜到人');

  const detail = await call('GET', `/api/admin/customers/${jia.id}`);
  const own = await login('2000001', '123456');
  assert.equal(own.res.status, 200);
  const ownText = JSON.stringify(own.data);
  assert.ok(ownText.includes(`名单甲${stamp}`), '他自己的名字照常用');
  assert.ok(!ownText.includes(`甲真实${stamp}`), '真名不出现在客户自己的页面');

  const second = await call('POST', '/api/admin/customers/import', {
    dryRun: false,
    rows: [
      { nickname: `名单甲${stamp}`, qq: '2000001', realName: '写错了别用' },
      { nickname: `名单乙${stamp}`, qq: '2000002', realName: `乙真实${stamp}` },
      { nickname: `乙的小号${stamp}`, qq: '2000002', realName: null },
    ],
  });
  assert.equal(second.counts.created, 0, '都认得了，不该再建');
  assert.equal(second.counts.updated, 2, '乙补上真名，乙的小号补成一个名字');

  const jiaAgain = await call('GET', `/api/admin/customers/${jia.id}`);
  assert.equal(jiaAgain.realName, `甲真实${stamp}`, '已有真名不被覆盖');
  const yi = (await call('GET', `/api/admin/customers?q=${encodeURIComponent('名单乙')}`)).customers[0];
  assert.equal(yi.realName, `乙真实${stamp}`);

  const preview = await call('POST', '/api/admin/import/preview', {
    sheet: { headers: ['名称', 'cn', '实际价格'], rows: [['x', `乙的小号${stamp}`, 100]] },
  });
  assert.equal(preview.groups[0].matchedBy, 'exact');
  assert.equal(preview.groups[0].customer.qq, '2000002', '名单里加过的叫法，导货表时直接认得出');
});

test('后台找货：只输货号尾巴就能定位到这一件，跳过去该去哪一步看', async () => {
  await call('POST', '/api/admin/login', { password: PASSWORD });
  const cn = `找货${stamp}`;
  // 每次跑都造一个没见过的编号；带字母是为了让编号的尾巴不会撞进客户名的数字里
  const code = `ZH${`${stamp}`.slice(-6)}Q7`;
  const imported = await call('POST', '/api/admin/import/commit', {
    batchName: `找货批次${stamp}`,
    fileHash: `hash-${stamp}-search`,
    sheet: {
      headers: ['名称', '商品链接', 'cn', '实际价格'],
      rows: [
        [`尾号测试手办${stamp}`, `https://www.suruga-ya.jp/product/detail/${code}`, cn, 1200],
        ['没给链接的一件', null, cn, 300],
      ],
    },
    assignments: [{ cn, newCustomer: { qq: `${stamp + 11}`.slice(-9), nickname: cn } }],
  });
  const mine = (items) => items.filter((i) => i.batchId === imported.batchId);

  const tail = await call('GET', `/api/admin/items/search?q=${encodeURIComponent(code.slice(-5))}`);
  assert.equal(mine(tail.items).length, 1, `搜尾号 ${code.slice(-5)} 应该只命中这一件`);
  const hit = mine(tail.items)[0];
  assert.equal(hit.code, code, '要把完整货号还给前端，光对上尾号看不清是哪件');
  assert.equal(hit.batchId, imported.batchId);
  assert.equal(hit.packageId, imported.packageId);
  assert.equal(hit.allocatedAt, null, '还没分摊，落点应该在称重台而不是包裹页');
  assert.equal(hit.nickname, cn);

  const byName = await call('GET', `/api/admin/items/search?q=${encodeURIComponent('尾号测试')}`);
  assert.equal(mine(byName.items).length, 1, '没货号的行也能靠名字片段找到，但只命中这一批的那一件');
  assert.ok(byName.items.some((i) => i.id === hit.id), '有货号的这件名字里也带片段，应该一起出现');

  // 一箱几十件时先按人筛：搜客户名要能把这人的两件都捞出来
  const byPerson = await call('GET', `/api/admin/items/search?q=${encodeURIComponent(cn)}`);
  assert.equal(mine(byPerson.items).length, 2, '搜人名应该把这个人这一批的两件都列出来');

  // 站在称重台上只搜这一箱，别把别的箱的东西混进来
  const scoped = await call(
    'GET',
    `/api/admin/items/search?q=${encodeURIComponent('尾号测试')}&packageId=${imported.packageId}`,
  );
  assert.equal(scoped.items.length, 1, '限定了包裹就只该出这一箱的');
  assert.equal(scoped.items[0].id, hit.id);
  const wrongBox = await call(
    'GET',
    `/api/admin/items/search?q=${encodeURIComponent('尾号测试')}&packageId=${imported.packageId + 9999}`,
  );
  assert.deepEqual(wrongBox.items, [], '这一箱里没有就是没有，不拿别的箱的凑数');

  assert.deepEqual((await call('GET', `/api/admin/items/search?q=${encodeURIComponent(`zzz${stamp}`)}`)).items, []);
  assert.deepEqual((await call('GET', '/api/admin/items/search?q=1')).items, [], '只给一个字符不查，免得把整库列出来');

  const anonymous = await fetch(`${BASE}/api/admin/items/search?q=${code.slice(-5)}`);
  assert.equal(anonymous.status, 401, '搜库不能不登录');
});

test('群主重置链接时把 QQ 连错锁定一起清掉', async () => {
  const qq = `${stamp + 21}`.slice(-9);
  const created = await call('POST', '/api/admin/customers', { qq, nickname: `锁定重置${stamp}` });
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await login(qq, '乱猜的密码')).res.status, 401);
  }
  assert.equal((await login(qq, '乱猜的密码')).res.status, 429, '第 5 次错就锁 15 分钟');
  assert.equal((await login(qq, '123456')).res.status, 429, '锁定期内密码对也进不去');

  // 人被锁住时群主手里唯一的解药就是这个按钮，锁定必须跟着一起清
  await call('POST', `/api/admin/customers/${created.id}/reset-token`);
  const again = await login(qq, '123456');
  assert.equal(again.res.status, 200, '重置后马上能登进来');
  assert.equal(again.data.mustChange, true, '重置链接不动密码，还是初始那一个');
});
