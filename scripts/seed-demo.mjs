/**
 * 灌一份演示数据，用来看页面长什么样（预览、截图、录屏都靠它）。
 *
 *   npm run seed          # 自己起一个隔离实例（8790 + 单独的库），演示数据不会进你正在用的仓库
 *
 * 图片用内联 SVG，不依赖外网。
 */
const BASE = process.env.SEED_BASE || die();
function die() {
  console.error('演示数据不往 8787 那个正经仓库里灌。用 npm run seed，或者自己指定 SEED_BASE。');
  process.exit(1);
}
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
  ['海洋堂 山口式 EVA 初号机', 0, 4800, 2980, '阿狸', 520],
  ['GSC 粘土人 后藤ひとり', 0, 3500, 2200, '阿狸', 340],
  ['一番赏 五等分的新娘 中野二乃', 3, 2000, 1400, '阿狸', 380],
  ['BANDAI MG 强袭自由高达 Ver.Ka', 1, 6800, 4500, '团子', 1600],
  ['周刊少年 JUMP 1998 合订本', 2, 1200, 800, '团子', 450],
  ['寿屋 ARTFX 初音未来', 0, 5600, 3800, '小K', 1500],
  ['龙珠 一番赏 孙悟空', 3, 1800, 1100, '小K', null],
  ['灌篮高手 完全版 全31卷', 2, 8000, 5200, '小K', null],
  ['Q posket 鬼灭之刃 祢豆子', 3, 1500, 900, '芋圆', 430],
  ['S.H.Figuarts 假面骑士 空我', 0, 4200, 2900, '芋圆', 550],
  ['一番赏 链锯人 玛奇玛', 3, 2500, 1600, '喵酱', 400],
  ['POP UP PARADE 雷姆', 0, 3200, 2100, '喵酱', 620],
];

const QQ = { 阿狸: '123456789', 团子: '234567891', 小K: '345678912', 芋圆: '456789123', 喵酱: '567891234' };

const sheet = {
  headers: ['名称', '图片', '商品链接', '平时价格', '实际价格', 'cn'],
  rows: ITEMS.map(([title, kind, list, actual, cn], i) => [
    title,
    `https://images.suruga-ya.jp/database/pics/${KINDS[kind]}/DEMO${1001 + i}.jpg`,
    `https://www.suruga-ya.jp/product/detail/DEMO${1001 + i}`,
    list,
    actual,
    cn,
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

const customers = (await call('GET', '/api/admin/customers')).customers;
const byName = Object.fromEntries(customers.map((c) => [c.nickname, c]));

// 喵酱这次自己带回国：标「不拼邮」，货款照记，但称重、摊运费、发快递这一条链都不算她。
// 标了之后这一箱的「整箱弄完了」不会被她那两件未认领的卡住，下面的实收总额照样能填。
await call('PATCH', `/api/admin/customers/${byName['喵酱'].id}`, { selfReturn: true });

// 小K：有一件被骏河屋砍单，货款已经付过了 → 进待退款
// 必须在称重分摊之前做：砍单要趁物品还没计费，已计费的后端会挡住
const k = await call('GET', `/api/admin/customers/${byName['小K'].id}`);
const cancelled = k.items.find((i) => i.title.startsWith('龙珠'));
await call('POST', '/api/admin/payments', { customerId: k.customer.id, kind: 'goods', itemIds: [cancelled.id] });
await call('PATCH', `/api/admin/items/${cancelled.id}`, { status: 'cancelled', exceptionNote: '骏河屋砍单' });

// 称重：逐件填克数（旧版整摞填一次的话，每件商品的重量和运费都会是空的）
// 砍单件不会出现在称重台上，灌篮高手标成缺件，其余全部认领
const weightByTitle = new Map(ITEMS.map(([title, , , , , weightG]) => [title, weightG]));
const weigh = await call('GET', `/api/admin/packages/${packageId}/weigh`);
for (const customer of weigh.customers) {
  // 不拼邮的那位根本不进称重台的操作范围，点她的封面会被后端拦住
  if (customer.selfReturn) continue;
  for (const item of customer.items) {
    await call('POST', `/api/admin/packages/${packageId}/weigh/claim`, { itemId: item.id, claimed: true });
    if (item.title.startsWith('灌篮高手')) {
      await call('POST', `/api/admin/packages/${packageId}/weigh/missing`, {
        itemId: item.id,
        missing: true,
        note: '骏河屋漏发，已联系补寄',
      });
      continue;
    }
    await call('POST', `/api/admin/packages/${packageId}/weigh/item`, {
      itemId: item.id,
      weightG: weightByTitle.get(item.title),
    });
  }
}
const allocated = await call('POST', `/api/admin/packages/${packageId}/allocate/commit`, {
  totalFeeYuan: '238.00',
  totalWeightG: 6000,
});
console.log(`分摊完成，尾差 ${allocated.diffFen} 分，${allocated.itemsMovedToStock} 件变为可发货`);

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

// 第二单：日本直邮 + 拼团混在一张表里，骏河屋分两个快递箱到（表里写了日本运单号）
const pic = (k, i) => `https://images.suruga-ya.jp/database/pics/${k}/DEMO${2001 + i}.jpg`;
const url = (i) => `https://www.suruga-ya.jp/product/detail/DEMO${2001 + i}`;
const SECOND = [
  ['GSC figma 初音未来 V4X', 'figure', 5200, '团子', '直邮', null, '4908-1234-5678'],
  ['MegaHouse G.E.M. 鬼灭之刃 炭治郎', 'figure', 3900, '团子', '直邮', null, '4908-1234-5678'],
  ['ONE PIECE 全彩版 1-12', 'book', 4400, '芋圆', '直邮', '广东省深圳市南山区科技园某栋 1201 芋圆 13800001234', '4908-1234-5678'],
  ['一番赏 间谍过家家 阿尼亚', 'prize', 1300, '小K', '拼团', null, '4908-1234-5678'],
  ['figma 进击的巨人 利威尔', 'figure', 4100, '阿狸', '', null, '4908-1234-5678'],
  ['咒术回战 0 剧场版 设定集', 'book', 2600, '阿狸', '拼团', null, '4908-1234-5678'],
  ['Nendoroid 孤独摇滚 喜多郁代', 'figure', 3300, '小K', '拼团', null, '4908-1234-5678'],
  ['电锯人 1-16 卷', 'book', 3800, '团子', '拼团', null, '4908-1234-5678'],
  ['偶像大师 闪耀色彩 色纸', 'prize', 900, '芋圆', '拼团', null, '4908-8765-4321'],
  ['蓝色监狱 一番赏 潔世一', 'prize', 1500, '小K', '拼团', null, '4908-8765-4321'],
  ['葬送的芙莉莲 画集', 'book', 3000, '阿狸', '直邮', null, '4908-8765-4321'],
];
const second = await call('POST', '/api/admin/import/commit', {
  fileName: '第13团.xlsx',
  fileHash: 'demo-13',
  batchName: '10月20日 第13团',
  orderNo: 'SURUGA-20261020',
  orderedAt: '2026-10-20',
  sheet: {
    headers: ['名称', '图片', '商品链接', '实际价格', 'cn', '发货方式', '收货地址', '日本运单号'],
    rows: SECOND.map(([t, k, price, cn, route, addr, tn], i) => [t, pic(k, i), url(i), price, cn, route, addr, tn]),
  },
  assignments: [],
});
console.log(`第二单：${second.itemCount} 件，其中直邮 ${second.directCount} 件，分两个日本快递箱`);
await call('POST', '/api/admin/staff', { username: 'tokyo', displayName: '东京仓小王', role: 'jp', password: 'tokyo-demo' });
// 团子自己登录、改了密码、存了一个地址（直邮自动用它）
const tz = await call('POST', '/api/w/login', { qq: '234567891', password: '123456' });
await call('POST', `/api/w/${tz.token}/password`, { oldPassword: '123456', newPassword: 'tuanzi2026' });
await call('POST', '/api/w/login', { qq: '234567891', password: 'tuanzi2026' });
await call('POST', `/api/w/${tz.token}/addresses`, { recipient: '团子', phone: '13900002222', detail: '上海市浦东新区某路 88 弄 6 号 502' });
console.log('团子的密码已改成 tuanzi2026（演示客户页的直邮包裹）');
// 第一箱已经分好、发出去了：演示分拣结果；第二箱留着演示分拣页
const box1 = await call('GET', `/api/staff/sort/${second.batchId}?tn=490812345678`);
await call('POST', '/api/staff/sort/mark', { itemIds: box1.items.filter((i) => i.title !== 'figma 进击的巨人 利威尔').map((i) => i.id), found: true });
const byTitle = Object.fromEntries(box1.items.map((i) => [i.title, i]));
const sorted = await call('POST', `/api/staff/sort/${second.batchId}/commit`, {
  trackingNo: '490812345678',
  boxes: [{ trackingNo: 'SF1500098765' }, { trackingNo: 'SF1500098766' }],
  assign: {
    [byTitle['一番赏 间谍过家家 阿尼亚'].id]: 1,
    [byTitle['Nendoroid 孤独摇滚 喜多郁代'].id]: 1,
    [byTitle['咒术回战 0 剧场版 设定集'].id]: 2,
    [byTitle['电锯人 1-16 卷'].id]: 2,
  },
  direct: [
    { customerId: byTitle['ONE PIECE 全彩版 1-12'].customerId, trackingNo: 'EB123456789JP', weightG: 1850 },
    { customerId: byTitle['GSC figma 初音未来 V4X'].customerId, trackingNo: 'EB223456789JP', weightG: 2400 },
  ],
});
console.log(`第一箱分拣完：结果页 ${BASE}/admin/#/sort-result/${sorted.sessionId}`);
console.log('日本仓演示账号：tokyo / tokyo-demo');

console.log('\n演示客户登录（统一入口 /login，或点下面的专属链接）：');
for (const c of (await call('GET', '/api/admin/customers')).customers) {
  console.log(
    `  ${c.nickname.padEnd(4)} QQ ${c.qq}  密码 123456  ${BASE}/w/${c.token}${
      c.selfReturn ? '  ← 这一位不拼邮，后面的运费和快递都不算她' : ''
    }`,
  );
}
