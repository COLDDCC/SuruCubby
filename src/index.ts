import { Hono } from 'hono';
import type { Env } from './lib/env.ts';
import { HttpError } from './lib/http.ts';
import { adminGuard, staffGuard } from './lib/session.ts';
import { auditLog } from './lib/audit.ts';
import { staffRoutes } from './routes/admin/staff.ts';
import { jpRoutes } from './routes/staff/jp.ts';
import { badgeRoutes } from './routes/staff/badges.ts';
import { directAdminRoutes, directStaffRoutes } from './routes/staff/direct.ts';
import { sortRoutes } from './routes/staff/sort.ts';
import { staffItemRoutes } from './routes/staff/items.ts';
import { authRoutes } from './routes/admin/auth.ts';
import { dashboardRoutes } from './routes/admin/dashboard.ts';
import { importRoutes } from './routes/admin/import.ts';
import { batchRoutes } from './routes/admin/batches.ts';
import { packageRoutes } from './routes/admin/packages.ts';
import { itemRoutes } from './routes/admin/items.ts';
import { customerRoutes as adminCustomerRoutes } from './routes/admin/customers.ts';
import { shipmentRoutes } from './routes/admin/shipments.ts';
import { paymentRoutes } from './routes/admin/payments.ts';
import { settingsRoutes } from './routes/admin/settings.ts';
import { customerRoutes } from './routes/customer.ts';
import { ITEM_STATUSES, STATUS_LABELS } from './lib/status.ts';
import { KEY_PATTERN, isHttpUrl, proxyImage } from './lib/images.ts';

import { mutationGuard } from './lib/mutations.ts';
import { requestAdminRoutes, requestCustomerRoutes } from './routes/admin/requests.ts';
const app = new Hono<{ Bindings: Env }>();

/** Workers 上用边缘缓存，Node 上用入口传进来的磁盘缓存。 */
function imageCache(env: Env): ImageCache {
  if (env.IMAGE_CACHE) return env.IMAGE_CACHE;
  return (globalThis as unknown as { caches: { default: ImageCache } }).caches.default;
}
/**
 * 所有响应都带的安全头：不许别的网站把后台 / 客户页套进 iframe（点击劫持），
 * 不许浏览器把上传的东西猜成别的类型执行。页面里还有内联事件（图片 onerror），所以 CSP 只管框架和 base。
 */
app.use('*', async (c, next) => {
  await next();
  try {
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  } catch {
    // 直接透传的 fetch 响应头是只读的：复制一份再加
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  }
});
app.use('/api/*', mutationGuard);

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, ...err.extra }, err.status as 400);
  }
  console.error(err);
  const message = '服务器出错了，请稍后重试';
  return c.json({ error: message }, 500);
});

/**
 * 物品封面：页面统一引用 /img/i/{itemId}，真正的地址在数据库里。
 * 图片经 Worker 转一道后放进边缘缓存，不用花钱开图床；只代理库里存着的地址。
 */
app.get('/img/i/:id', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.text('找不到图片', 404);

  const cache = imageCache(c.env);
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const row = await c.env.DB.prepare('SELECT image_url AS imageUrl FROM items WHERE id = ?')
    .bind(id)
    .first<{ imageUrl: string | null }>();
  if (!row?.imageUrl) return c.text('这件东西没有图', 404);

  // 已经存进 R2 的直接走 R2，不用回源
  if (row.imageUrl.startsWith('/img/') && c.env.IMAGES) {
    const object = await c.env.IMAGES.get(row.imageUrl.slice('/img/'.length));
    if (!object) return c.text('找不到图片', 404);
    const response = new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType ?? 'image/jpeg',
        'cache-control': 'public, max-age=31536000, immutable',
        etag: object.httpEtag,
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
  if (!isHttpUrl(row.imageUrl)) return c.text('找不到图片', 404);

  const response = await proxyImage(row.imageUrl);
  if (response.ok) c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

// 缓存到 R2 的图片：客户页只认自己域名下的这个地址
app.get('/img/:key', async (c) => {
  const key = c.req.param('key');
  if (!KEY_PATTERN.test(key)) return c.text('找不到图片', 404);
  const bucket = c.env.IMAGES;
  if (!bucket) return c.text('没有配置图片存储', 404);
  const object = await bucket.get(key);
  if (!object) return c.text('找不到图片', 404);
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: object.httpEtag,
    },
  });
});

app.get('/api/meta', (c) => c.json({ statuses: ITEM_STATUSES, statusLabels: STATUS_LABELS }));

// 登录相关不需要会话
app.route('/api/admin', authRoutes);

// 其余管理接口一律校验会话
app.use('/api/admin/*', adminGuard);
app.use('/api/admin/*', auditLog);
// 日本仓那几页：管理员和日本仓账号都能进
app.use('/api/staff/*', staffGuard);
app.use('/api/staff/*', auditLog);
app.route('/api/admin/staff', staffRoutes);
app.route('/api/staff/jp', jpRoutes);
app.route('/api/staff/direct', directStaffRoutes);
app.route('/api/staff/sort', sortRoutes);
app.route('/api/staff/items', staffItemRoutes);
app.route('/api/staff/badges', badgeRoutes);
app.route('/api/admin/direct', directAdminRoutes);
app.route('/api/admin/dashboard', dashboardRoutes);
app.route('/api/admin/import', importRoutes);
app.route('/api/admin/batches', batchRoutes);
app.route('/api/admin/packages', packageRoutes);
app.route('/api/admin/items', itemRoutes);
app.route('/api/admin/customers', adminCustomerRoutes);
app.route('/api/admin/shipments', shipmentRoutes);
app.route('/api/admin/payments', paymentRoutes);
app.route('/api/admin/settings', settingsRoutes);
app.route('/api/admin/requests', requestAdminRoutes);

app.route('/api/w', customerRoutes);
app.route('/api/w', requestCustomerRoutes);

/**
 * 取一个静态资源并把内容直接返回。
 * 资源服务会把 /customer.html 重定向到 /customer，如果把重定向透给浏览器，
 * 地址里的 token 就丢了，所以这里自己把重定向跟完再返回 200。
 */
async function serveAsset(env: Env, base: URL, path: string): Promise<Response> {
  let target = new URL(path, base);
  for (let hop = 0; hop < 3; hop += 1) {
    const res = await env.ASSETS.fetch(new Request(target, { method: 'GET' }));
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      target = new URL(location, base);
      continue;
    }
    return new Response(res.body, { status: res.status, headers: res.headers });
  }
  return new Response('找不到页面', { status: 404 });
}

/** 404 页要回显客户输错的那段地址，所以先转义，不能把 URL 原样拼进 HTML。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function notFoundPage(path: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>找不到这个页面</title><link rel="stylesheet" href="/style.css"></head>
<body><div class="wrap"><div class="card">
<h1>找不到这个页面</h1>
<p class="muted">地址是 <code>${escapeHtml(path)}</code>，本站没有这一页。可能是链接少了一段，或者群主后来换过。</p>
<p>买家请用群主发的 QQ 号和密码登录：<a href="/login">/login</a>（账号就是 QQ 号，初始密码 123456）。</p>
<p class="small muted">群主后台在 <a href="/admin/">/admin/</a>。</p>
</div></div></body></html>`;
}

app.notFound(async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/')) return c.json({ error: '接口不存在' }, 404);
  // 尾随斜杠和不带 token 的 /w 都算同一个入口，别让手机端撞出一片空白
  const clean = url.pathname.replace(/\/+$/, '') || '/';
  // 客户专属页：/w/{token} 统一返回同一个页面，token 由前端从地址里取
  // 统一入口：客户输 QQ 号 + 密码自己进，不用群主挨个发链接
  if (clean === '/login' || clean === '/me' || clean === '/w' || clean.startsWith('/w/')) {
    return serveAsset(c.env, url, '/customer.html');
  }
  const assets = await c.env.ASSETS.fetch(c.req.raw);
  // 静态资源找不到时返回的是空正文 404，手机上就是一整片白，这里换成有话说的页面
  if (assets.status === 404 && assets.headers.get('content-type') === null) {
    return new Response(notFoundPage(url.pathname), {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return assets;
});

export default app;
