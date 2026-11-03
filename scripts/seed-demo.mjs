/**
 * 演示数据：照新流程（群主放行 → 仓库分拣 → 直邮打包 / 拼邮装箱 → 单号放行）铺好一半，剩下的自己点。
 *
 *   npm run seed          # 自己起一个隔离实例（8790 + 单独的库），演示数据不会进你正在用的仓库
 *
 * 三种身份的账号最后会打印出来。
 */
const BASE = process.env.SEED_BASE || die();
function die() {
  console.error('演示数据不往 8787 那个正经仓库里灌。用 npm run seed，或者自己指定 SEED_BASE。');
  process.exit(1);
}
const PASSWORD = process.env.SEED_PASSWORD || process.env.E2E_PASSWORD || 'test-admin-pw';

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

// 名称、骏河屋货号、日元、cn
const ITEMS = [
  ['寿屋 ARTFX 初音未来', '602170001', 3800, '小鱼'],
  ['寿屋 ARTFX 初音未来', '602170001', 3800, '小鱼'],
  ['吧唧 链锯人 玛奇玛', 'ZHOTI678913', 500, '小鱼'],
  ['GSC 粘土人 后藤ひとり', '608001234', 2200, '阿狸'],
  ['镭射票 孤独摇滚', '128000111', 900, '阿狸'],
  ['灌篮高手 完全版 第1卷', '102003456', 800, '团子'],
  ['一番赏 五等分的新娘', '605009999', 1400, '团子'],
  ['POP UP PARADE 雷姆', '412000777', 2100, '饭团'],
];
const QQ = { 小鱼: '123456789', 阿狸: '234567891', 团子: '345678912', 饭团: '456789123' };

await call('POST', '/api/admin/login', { password: PASSWORD });

const imported = await call('POST', '/api/admin/import/commit', {
  fileName: '11月第13团.xlsx',
  fileHash: `demo-${Date.now()}`,
  batchName: '11月1日 第13团',
  orderNo: 'SG-20261101-0042',
  japanTrackingNo: '4912-3456-7788',
  shop: '骏河屋',
  orderedAt: '2026-11-01',
  sheet: {
    headers: ['名称', '商品链接', '应付日元金额', 'cn'],
    rows: ITEMS.map(([title, code, jpy, cn]) => [title, `https://www.suruga-ya.jp/product/detail/${code}`, String(jpy), cn]),
  },
  assignments: Object.entries(QQ).map(([cn, qq]) => ({ cn, newCustomer: { qq, nickname: cn } })),
});
const byName = Object.fromEntries((await call('GET', '/api/admin/customers')).customers.map((c) => [c.nickname, c]));

// 收了钱的三个人放行；饭团还没付，留给你在订单页点「放进他的仓库」
for (const name of ['小鱼', '阿狸', '团子']) {
  await call('POST', '/api/admin/quick-order/release', { batchId: imported.batchId, customerId: byName[name].id });
}

// 小鱼、饭团走直邮，地址给仓库看；阿狸、团子拼邮
await call('PATCH', `/api/admin/customers/${byName['小鱼'].id}`, { shipMode: 'direct', directAddress: '王小鱼 138-0000-1234 上海市徐汇区漕溪北路 88 号 1203' });
await call('PATCH', `/api/admin/customers/${byName['饭团'].id}`, { shipMode: 'direct', directAddress: '陈饭团 139-1111-2222 杭州市西湖区文三路 9 号' });

// 小鱼另外单独下了一单（演示「两单合成一个直邮包裹」）
const solo = await call('POST', '/api/admin/quick-order', {
  customerId: byName['小鱼'].id,
  kind: 'buy',
  orderNo: 'SG-20261028-0007',
  release: true,
  lines: [{ url: 'https://www.suruga-ya.jp/product/detail/601234567', title: '景品 手办 鬼灭之刃 祢豆子', priceJpy: 2300 }],
});

// 阿狸有一件朋友转运来的（不是群主买的）
await call('POST', '/api/admin/quick-order', {
  customerId: byName['阿狸'].id,
  kind: 'forward',
  japanTrackingNo: 'FWD-7788-0001',
  lines: [{ title: '朋友从东京寄来的同人本' }],
});

await call('POST', '/api/admin/warehouse-users', { username: 'cang', displayName: '仓库小王', password: 'cang1234' });

const line = (s) => console.log(s);
line('\n演示数据铺好了。三种身份分别用三个浏览器窗口（或一个普通窗口 + 无痕窗口 + 手机）打开：');
line(`\n  首页     ${BASE}/`);
line(`  群主     选「我是群主」，密码 ${PASSWORD}`);
line('  仓库     选「我是仓库」，账号 cang  密码 cang1234');
line('  团员     选「我是团员」，QQ 见下，初始密码 123456（进去会让改，可以先点「先随便看看」）');
for (const [name, qq] of Object.entries(QQ)) {
  const c = byName[name];
  const lane = c && ['小鱼', '饭团'].includes(name) ? '直邮' : '拼邮';
  line(`           ${name}  QQ ${qq}  ${lane}${name === '饭团' ? '  ← 还没放行，他现在什么都看不到' : ''}`);
}
line(`\n  仓库进门用的单号：SG-20261101-0042（第13团）、SG-20261028-0007（小鱼单独下的）、FWD-7788-0001（阿狸的转运）`);
line(`  第13团订单页：${BASE}/admin/#/batches/${imported.batchId}`);
void solo;
