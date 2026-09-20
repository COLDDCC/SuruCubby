/**
 * 打一个「不用部署也能点」的预览包：真页面 + 真样式 + 假数据。
 *
 *   npm run dev                       # 另开终端，灌好演示数据
 *   node scripts/seed-demo.mjs
 *   node scripts/build-preview.mjs    # 产出 preview-build/
 *
 * 产物可以直接用任何静态服务器打开，也可以整包发布成 Artifact。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, process.argv[2] || 'preview-build');
const BASE = process.env.SEED_BASE || 'http://127.0.0.1:8787';
const PASSWORD = process.env.SEED_PASSWORD || 'test-admin-pw';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'admin', 'views'), { recursive: true });

/** 页面里的绝对路径（/shared.js 之类）在预览包里要改成相对路径 */
function rewrite(code, depth) {
  const up = depth === 0 ? './' : '../'.repeat(depth);
  return code
    .replace(/(['"])\/admin\/views\//g, `$1${depth === 0 ? './admin/views/' : depth === 1 ? './views/' : '../views/'}`)
    .replace(/(['"])\/admin\//g, `$1${depth === 0 ? './admin/' : depth === 1 ? './' : '../'}`)
    .replace(/(['"])\/shared\.js/g, `$1${up}shared.js`);
}

function copy(from, to, depth) {
  fs.writeFileSync(path.join(OUT, to), rewrite(fs.readFileSync(path.join(ROOT, from), 'utf8'), depth));
}

copy('public/style.css', 'style.css', 0);
copy('public/shared.js', 'shared.js', 0);
copy('public/customer.js', 'customer.js', 0);
for (const name of fs.readdirSync(path.join(ROOT, 'public/admin')).filter((f) => f.endsWith('.js'))) {
  copy(`public/admin/${name}`, `admin/${name}`, 1);
}
for (const name of fs.readdirSync(path.join(ROOT, 'public/admin/views'))) {
  copy(`public/admin/views/${name}`, `admin/views/${name}`, 2);
}
fs.copyFileSync(path.join(ROOT, 'public/favicon.svg'), path.join(OUT, 'favicon.svg'));
fs.copyFileSync(path.join(ROOT, 'scripts/preview/mock.js'), path.join(OUT, 'mock.js'));
fs.copyFileSync(path.join(ROOT, 'scripts/preview/index.html'), path.join(OUT, 'index.html'));

// 「验一下你的表」用的是线上同一份解析代码
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/lib/excel.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: path.join(OUT, 'excel.js'),
});

// 把真接口的返回导出来当演示数据
const jar = new Map();
async function call(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
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
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

await call('POST', '/api/admin/login', { password: PASSWORD });
const seed = {};
for (const p of [
  '/api/admin/dashboard',
  '/api/admin/batches',
  '/api/admin/batches/1',
  '/api/admin/packages',
  '/api/admin/packages/1',
  '/api/admin/packages/1/weigh',
  '/api/admin/customers',
  '/api/admin/shipments',
  '/api/admin/payments',
  '/api/admin/settings',
]) {
  seed[p] = await call('GET', p);
}
for (const c of seed['/api/admin/customers'].customers) {
  seed[`/api/admin/customers/${c.id}`] = await call('GET', `/api/admin/customers/${c.id}`);
}
async function customerView(nickname) {
  const c = seed['/api/admin/customers'].customers.find((x) => x.nickname === nickname);
  const res = await fetch(`${BASE}/api/w/${c.token}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ qq: c.qq }),
  });
  return [await res.json(), c.qq];
}
[seed.__customer__, seed.__customerQq__] = await customerView('阿狸');
[seed.__customer2__, seed.__customer2Qq__] = await customerView('小K');

// 演示封面：真实场景里是骏河屋的图片地址，预览里换成本地生成的 SVG，离线也能看
const COVERS = [
  ['手办', '#e8eef9', '#2f4f8f'],
  ['模型', '#eaf4ec', '#2c6b43'],
  ['漫画', '#fdf1e3', '#9a5a1d'],
  ['景品', '#f6ecf7', '#6b3d80'],
];
function cover(title) {
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const [label, bg, fg] = COVERS[hash % COVERS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">` +
    `<rect width="200" height="200" fill="${bg}"/>` +
    `<circle cx="100" cy="76" r="42" fill="${fg}" opacity=".2"/>` +
    `<rect x="30" y="136" width="140" height="11" rx="5" fill="${fg}" opacity=".28"/>` +
    `<rect x="30" y="157" width="92" height="11" rx="5" fill="${fg}" opacity=".16"/>` +
    `<text x="100" y="86" font-size="30" text-anchor="middle" fill="${fg}" font-family="sans-serif">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
(function paintCovers(node) {
  if (Array.isArray(node)) return node.forEach(paintCovers);
  if (!node || typeof node !== 'object') return;
  if (typeof node.title === 'string' && 'goodsFeeFen' in node) node.imageUrl = cover(node.title);
  Object.values(node).forEach(paintCovers);
})(seed);

// 转成纯 ASCII，免得将来哪个静态服务器不发 charset 把中文弄花
const seedLiteral = JSON.stringify(seed).replace(/[\u007f-\uffff]/g, (c) =>
  `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
fs.writeFileSync(path.join(OUT, 'seed.js'), `window.__SEED__ = ${seedLiteral};\n`);

/** 把真页面的壳子改成预览版：相对路径 + 先装假后端 */
function shell(from, to, extra = '') {
  let html = fs.readFileSync(path.join(ROOT, from), 'utf8');
  html = html
    .replace('href="/style.css"', 'href="./style.css"')
    .replace('href="/favicon.svg"', 'href="./favicon.svg"')
    .replace('src="/admin/app.js"', 'src="./admin/app.js"')
    .replace('src="/customer.js"', 'src="./customer.js"')
    .replace('<script type="module"', `${extra}<script src="./seed.js"></script>\n<script src="./mock.js"></script>\n<script type="module"`);
  fs.writeFileSync(path.join(OUT, to), html);
}
shell('public/admin/index.html', 'admin.html');
shell('public/customer.html', 'customer-page.html');

const files = fs.readdirSync(OUT, { recursive: true }).filter((f) => fs.statSync(path.join(OUT, f)).isFile());
console.log(`预览包已生成：${OUT}（${files.length} 个文件）`);
console.log('本地看：npx http-server ' + OUT + ' 或任意静态服务器');
