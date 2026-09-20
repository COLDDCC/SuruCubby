import { Hono } from 'hono';
import type { Env } from './lib/env.ts';
import { HttpError } from './lib/http.ts';
import { adminGuard } from './lib/session.ts';
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

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, ...err.extra }, err.status as 400);
  }
  console.error(err);
  const message = err instanceof Error ? err.message : '服务器出错了';
  return c.json({ error: message }, 500);
});

/**
 * 物品封面：页面统一引用 /img/i/{itemId}，真正的地址在数据库里。
 * 图片经 Worker 转一道后放进边缘缓存，不用花钱开图床；只代理库里存着的地址。
 */
app.get('/img/i/:id', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.text('找不到图片', 404);

  const cache = caches.default;
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
app.route('/api/admin/dashboard', dashboardRoutes);
app.route('/api/admin/import', importRoutes);
app.route('/api/admin/batches', batchRoutes);
app.route('/api/admin/packages', packageRoutes);
app.route('/api/admin/items', itemRoutes);
app.route('/api/admin/customers', adminCustomerRoutes);
app.route('/api/admin/shipments', shipmentRoutes);
app.route('/api/admin/payments', paymentRoutes);
app.route('/api/admin/settings', settingsRoutes);

app.route('/api/w', customerRoutes);

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

app.notFound(async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/')) return c.json({ error: '接口不存在' }, 404);
  // 客户专属页：/w/{token} 统一返回同一个页面，token 由前端从地址里取
  if (url.pathname.startsWith('/w/')) return serveAsset(c.env, url, '/customer.html');
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
