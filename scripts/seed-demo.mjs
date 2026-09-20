/**
 * 往本地开发库里灌一份演示数据，用来看页面长什么样（预览、截图、录屏都靠它）。
 *
 *   npm run dev                 # 另开一个终端
 *   node scripts/seed-demo.mjs  # 默认连 http://127.0.0.1:8787
 *
 * 图片用内联 SVG，不依赖外网。
 */
const BASE = process.env.SEED_BASE || 'http://127.0.0.1:8787';
const PASSWORD = process.env.SEED_PASSWORD || 'test-admin-pw';

const jar = new Map();
async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const cookie of res.headers.getSetCookie?.() ?? []) {
    const [pair] = cookie.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const KINDS = ['figure', 'kit', 'book', 'prize'];

const ITEMS = [
  ['海洋堂 山口式 EVA 初号机', 0, 4800, 2980, '168.00', '阿狸'],
  ['GSC 粘土人 后藤ひとり', 0, 3500, 2200, '125.00', '阿狸'],
  ['一番赏 五等分的新娘 中野二乃', 3, 2000, 1400, '79.00', '阿狸'],
  ['BANDAI MG 强袭自由高达 Ver.Ka', 1, 6800, 4500, '255.00', '团子'],
  ['周刊少年 JUMP 1998 合订本', 2, 1200, 800, '45.00', '团子'],
  ['寿屋 ARTFX 初音未来', 0, 5600, 3800, '215.00', '小K'],
  ['龙珠 一番赏 孙悟空', 3, 1800, 1100, '62.00', '小K'],
  ['灌篮高手 完全版 全31卷', 2, 8000, 5200, '295.00', '小K'],
  ['Q posket 鬼灭之刃 祢豆子', 3, 1500, 900, '51.00', '芋圆'],
  ['S.H.Figuarts 假面骑士 空我', 0, 4200, 2900, '164.00', '芋圆'],
];

const QQ = { 阿狸: '123456789', 团子: '234567891', 小K: '345678912', 芋圆: '456789123' };
const WEIGHTS = { 阿狸: 1240, 团子: 2050, 小K: 3600, 芋圆: 980 };

const sheet = {
  headers: ['名称', '图片', '商品链接', '平时价格', '实际价格', 'cn', '应付人民币金额'],
  rows: ITEMS.map(([title, kind, list, actual, fee, cn], i) => [
    title,
    `https://images.suruga-ya.jp/database/pics/${KINDS[kind]}/DEMO${1001 + i}.jpg`,
    `https://www.suruga-ya.jp/product/detail/DEMO${1001 + i}`,
    list,
    actual,
    cn,
    fee,
  ]),
};

await call('POST', '/api/admin/login', { password: PASSWORD });

const imported = await call('POST', '/api/admin/import/commit', {
  fileName: '9月18日第12团.xlsx',
  fileHash: `demo-${Date.now()}`,
  batchName: '9月18日 第12团',
  orderedAt: new Date().toISOString().slice(0, 10),
  sheet,
  assignments: Object.entries(QQ).map(([cn, qq]) => ({ cn, newCustomer: { qq, nickname: cn } })),
});
console.log(`导入 ${imported.itemCount} 件，批次 #${imported.batchId}，包裹 #${imported.packageId}`);

const packageId = imported.packageId;
for (const status of ['jp_warehouse', 'intl_transit', 'cn_arrived']) {
  await call('POST', `/api/admin/packages/${packageId}/status`, { status });
}

// 称重：除了小K的一件漫画之外全部认领，那一件标成缺件
const weigh = await call('GET', `/api/admin/packages/${packageId}/weigh`);
for (const customer of weigh.customers) {
  for (const item of customer.items) {
    if (item.title.startsWith('灌篮高手')) {
      await call('POST', `/api/admin/packages/${packageId}/weigh/missing`, {
        itemId: item.id,
        missing: true,
        note: '骏河屋漏发，已联系补寄',
      });
      continue;
    }
    await call('POST', `/api/admin/packages/${packageId}/weigh/claim`, { itemId: item.id, claimed: true });
  }
  await call('POST', `/api/admin/packages/${packageId}/weigh/group`, {
    customerId: customer.customerId,
    weightG: WEIGHTS[customer.nickname],
  });
}
const allocated = await call('POST', `/api/admin/packages/${packageId}/allocate/commit`, {
  totalFeeYuan: '238.00',
  totalWeightG: 8100,
});
console.log(`分摊完成，尾差 ${allocated.diffFen} 分，${allocated.itemsMovedToStock} 件进入国内在库`);

const customers = (await call('GET', '/api/admin/customers')).customers;
const byName = Object.fromEntries(customers.map((c) => [c.nickname, c]));

// 阿狸：货款、国际运费都付了，已经寄出一次，国内运费还没收
const ali = await call('GET', `/api/admin/customers/${byName['阿狸'].id}`);
await call('POST', '/api/admin/payments', { customerId: ali.customer.id, kind: 'goods', batchId: imported.batchId });
await call('POST', '/api/admin/payments', {
  customerId: ali.customer.id,
  kind: 'intl',
  weighGroupId: ali.weighGroups[0].id,
});
const shipment = await call('POST', '/api/admin/shipments', {
  customerId: ali.customer.id,
  itemIds: ali.items.filter((i) => i.status === 'cn_stock').slice(0, 2).map((i) => i.id),
});
await call('PATCH', `/api/admin/shipments/${shipment.id}`, { trackingNo: 'SF1234567890' });

// 小K：有一件被骏河屋砍单，货款已经付过了 → 进待退款
const k = await call('GET', `/api/admin/customers/${byName['小K'].id}`);
const cancelled = k.items.find((i) => i.title.startsWith('龙珠'));
await call('POST', '/api/admin/payments', { customerId: k.customer.id, kind: 'goods', itemIds: [cancelled.id] });
await call('PATCH', `/api/admin/items/${cancelled.id}`, { status: 'cancelled', exceptionNote: '骏河屋砍单' });

console.log('\n演示客户的专属链接：');
for (const c of (await call('GET', '/api/admin/customers')).customers) {
  console.log(`  ${c.nickname.padEnd(4)} QQ ${c.qq}  ${BASE}/w/${c.token}`);
}
