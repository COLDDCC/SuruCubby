/**
 * 端到端验收脚本：跑通「导入 → 客户页 → 改状态 → 称重分摊 → 收款 → 寄出」。
 *
 * 先另开一个终端：
 *   npx wrangler d1 migrations apply surucubby --local
 *   npx wrangler dev --port 8787
 * 再执行：
 *   node --test test/e2e.test.mjs
 *
 * 需要 .dev.vars 里的 ADMIN_PASSWORD=test-admin-pw（或用环境变量覆盖）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8787';
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

const HEADERS = ['名称', '图片', '商品链接', '平时价格', '实际价格', 'cn', '应付人民币金额'];
const stamp = Date.now();
const NAMES = [`阿狸${stamp}`, `小明${stamp}`, `小红${stamp}`];
const QQS = [`${stamp}`.slice(-9), `${stamp + 1}`.slice(-9), `${stamp + 2}`.slice(-9)];
const SHEET = {
  headers: HEADERS,
  rows: [
    ['海洋堂手办', null, 'https://www.suruga-ya.jp/product/detail/1', '3,000', '1,800', NAMES[0], '¥98.50'],
    ['GK 模型', null, null, '2,000', 1500, NAMES[0], 80],
    ['漫画一套', null, null, null, 2600, NAMES[1], '120.00'],
    ['手办盒蛋', null, null, null, 900, NAMES[2], '45.5'],
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
  assert.equal(preview.totals.amountFen, 9850 + 8000 + 12000 + 4550);
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
    assignments: NAMES.map((cn, i) => ({ cn, newCustomer: { qq: QQS[i], nickname: cn } })),
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
    sheet: { headers: HEADERS, rows: [['补货一件', null, null, null, 500, NAMES[0], '20']] },
  });
  assert.equal(preview.totals.unmatched, 0);
  assert.equal(preview.groups[0].customer.qq, QQS[0]);
});

test('客户页：没验证看不到，QQ 输错也看不到', async () => {
  const token = ctx.customers[0].token;
  const anonymous = await fetch(`${BASE}/api/w/${token}`);
  assert.equal(anonymous.status, 401);
  const wrong = await fetch(`${BASE}/api/w/${token}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ qq: '99999999' }),
  });
  assert.equal(wrong.status, 401);
});

test('客户页：QQ 对上后只看得到自己的东西，金额与 Excel 一致', async () => {
  const token = ctx.customers[0].token;
  const res = await fetch(`${BASE}/api/w/${token}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ qq: QQS[0] }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.verified, true);
  assert.equal(data.customer.nickname, NAMES[0]);
  assert.equal(data.items.length, 2);
  assert.equal(data.summary.goodsUnpaidFen, 9850 + 8000);
  assert.ok(data.items.every((i) => i.status === 'ordered'));
  assert.ok(!JSON.stringify(data).includes(NAMES[1]), '不能出现别的客户的信息');
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
  const res = await call(
    'POST',
    `/api/admin/packages/${ctx.packageId}/status`,
    { status: 'shipped' },
    { raw: true },
  );
  assert.equal(res.status, 400);
});

test('称重台：点封面认领、填重量、缺件不进分摊', async () => {
  await call('POST', `/api/admin/packages/${ctx.packageId}/status`, { status: 'cn_arrived' });
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
    await call('POST', `/api/admin/packages/${ctx.packageId}/weigh/group`, {
      customerId: customer.customerId,
      weightG: 1000,
    });
  }
  const after = await call('GET', `/api/admin/packages/${ctx.packageId}/weigh`);
  assert.equal(after.progress.foundItems, 4);
  assert.equal(after.progress.weighedCustomers, 3);
  ctx.weighCustomers = after.customers;
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
  assert.equal(data.summary.intlUnpaidFen, 3333);
  assert.equal(data.summary.totalUnpaidFen, 9850 + 8000 + 3333);
});

test('已分摊的包裹不能再乱改重量，撤销后可以', async () => {
  const blocked = await call(
    'POST',
    `/api/admin/packages/${ctx.packageId}/weigh/group`,
    { customerId: ctx.weighCustomers[0].customerId, weightG: 1200 },
    { raw: true },
  );
  assert.equal(blocked.status, 400);
  await call('POST', `/api/admin/packages/${ctx.packageId}/allocate/undo`);
  const reverted = await call('GET', `/api/admin/packages/${ctx.packageId}`);
  assert.ok(reverted.items.every((i) => i.status === 'cn_arrived'));
  await call('POST', `/api/admin/packages/${ctx.packageId}/allocate/commit`, { totalFeeYuan: '100.00' });
});

test('货款收款与撤销', async () => {
  const customerId = ctx.customers[0].id;
  const payment = await call('POST', '/api/admin/payments', {
    customerId,
    kind: 'goods',
    batchId: ctx.batchId,
  });
  assert.equal(payment.amountFen, 9850 + 8000);
  let detail = await call('GET', `/api/admin/customers/${customerId}`);
  assert.equal(detail.summary.goodsUnpaidFen, 0);

  await call('DELETE', `/api/admin/payments/${payment.id}`);
  detail = await call('GET', `/api/admin/customers/${customerId}`);
  assert.equal(detail.summary.goodsUnpaidFen, 9850 + 8000);
  await call('POST', '/api/admin/payments', { customerId, kind: 'goods', batchId: ctx.batchId });
});

test('国际运费没付就寄出会被拦住，强制继续时算上未付运费', async () => {
  const customerId = ctx.customers[0].id;
  const detail = await call('GET', `/api/admin/customers/${customerId}`);
  const itemIds = detail.items.filter((i) => i.status === 'cn_stock').map((i) => i.id);
  const blocked = await call(
    'POST',
    '/api/admin/shipments',
    { customerId, itemIds },
    { raw: true },
  );
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.unpaidIntlFen, 3333);
  assert.equal(blocked.data.totalDueFen, 1000 + 3333);

  const group = detail.weighGroups[0];
  await call('POST', '/api/admin/payments', { customerId, kind: 'intl', weighGroupId: group.id });
  const shipment = await call('POST', '/api/admin/shipments', { customerId, itemIds });
  assert.equal(shipment.feeFen, 1000);
  assert.equal(shipment.itemCount, 2);
  ctx.shipmentId = shipment.id;

  const after = await call('GET', `/api/admin/customers/${customerId}`);
  assert.ok(after.items.filter((i) => itemIds.includes(i.id)).every((i) => i.status === 'shipped'));
  assert.equal(after.summary.domesticUnpaidFen, 1000);
});

test('填单号、收国内运费', async () => {
  await call('PATCH', `/api/admin/shipments/${ctx.shipmentId}`, { trackingNo: 'SF123456789' });
  await call('POST', '/api/admin/payments', {
    customerId: ctx.customers[0].id,
    kind: 'domestic',
    shipmentId: ctx.shipmentId,
  });
  const detail = await call('GET', `/api/admin/customers/${ctx.customers[0].id}`);
  assert.equal(detail.summary.totalUnpaidFen, 0);
  assert.equal(detail.shipments[0].trackingNo, 'SF123456789');
});

test('砍单：未付直接扣掉；已付进待退款清单', async () => {
  const customerId = ctx.customers[1].id;
  const detail = await call('GET', `/api/admin/customers/${customerId}`);
  const item = detail.items[0];
  await call('PATCH', `/api/admin/items/${item.id}`, { status: 'cancelled', exceptionNote: '骏河屋砍单' });
  const after = await call('GET', `/api/admin/customers/${customerId}`);
  assert.equal(after.summary.goodsUnpaidFen, 0, '未付的取消件应直接从应付里扣掉');

  await call('PATCH', `/api/admin/items/${item.id}`, { goodsPaid: true });
  const dashboard = await call('GET', '/api/admin/dashboard');
  assert.ok(dashboard.pendingRefunds.some((r) => r.itemId === item.id));
});

test('重置链接后旧链接立刻失效', async () => {
  const customerId = ctx.customers[0].id;
  const oldToken = ctx.customers[0].token;
  await call('POST', `/api/admin/customers/${customerId}/reset-token`);
  const res = await fetch(`${BASE}/api/w/${oldToken}`, { headers: { cookie: ctx.cookie } });
  assert.equal(res.status, 401);
});

test('客户合并：物品、别名、称重组都挪过去', async () => {
  const sourceId = ctx.customers[2].id;
  const targetId = ctx.customers[1].id;
  const before = await call('GET', `/api/admin/customers/${sourceId}`);
  await call('POST', '/api/admin/customers/merge', { sourceId, targetId });
  const merged = await call('GET', `/api/admin/customers/${targetId}`);
  assert.ok(merged.aliases.includes(NAMES[2]));
  for (const item of before.items) {
    assert.ok(merged.items.some((i) => i.id === item.id));
  }
  const gone = await call('GET', `/api/admin/customers/${sourceId}`, undefined, { raw: true });
  assert.equal(gone.status, 404);
});

test('QQ 连错 5 次会锁定 15 分钟', async () => {
  const fresh = await call('POST', '/api/admin/customers', {
    qq: `${stamp + 3}`.slice(-9),
    nickname: `锁定测试${stamp}`,
  });
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await fetch(`${BASE}/api/w/${fresh.token}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qq: '10000' }),
    });
  }
  assert.equal(last.status, 429);
});

test('图片：飞书 =IMAGE("...") 公式认得出来，抓下来存进 R2，之后只走自己的域名', async () => {
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
          // 飞书导出后单元格里就是这么一串公式
          ['公式图片', `=IMAGE("${origin}/a.png")`, null, null, 1000, cn, '10'],
          // 没有图片列，只有商品链接 → 去抓 og:image
          ['靠商品页补图', null, `${origin}/p/1`, null, 1000, cn, '10'],
        ],
      },
      assignments: [{ cn, newCustomer: { qq: `${stamp + 7}`.slice(-9), nickname: cn } }],
    });

    const result = await call('POST', `/api/admin/batches/${imported.batchId}/images`);
    assert.equal(result.tried, 2, '两件都该被处理');
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
    assert.equal(again.tried, result.r2 ? 0 : 1);
  } finally {
    server.close();
  }
});

test('/img/ 只认规范 key，乱传路径拿不到东西', async () => {
  const res = await fetch(`${BASE}/img/..%2F..%2Fsecret`);
  assert.equal(res.status, 404);
});
