/**
 * 图片「一劳永逸」方案：把图片抓一次存进自己的 R2，页面只引用自己域名下的
 * /img/{key}。这样外站图床改地址、防盗链、国内加载慢、飞书链接要登录，
 * 这些问题都一次性解决。没配 R2 时自动降级成直接外链。
 */

const MAX_BYTES = 5 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

export const CACHED_PREFIX = '/img/';

/** 只有这种形状的 key 才会去 R2 里取，避免被拿来探路径。 */
export const KEY_PATTERN = /^[0-9a-f]{32}\.[a-z]{3,4}$/;

export function isHttpUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export function isCached(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(CACHED_PREFIX);
}

/** 同一个源地址永远算出同一个 key，重复抓取不会在 R2 里留下两份。 */
export async function imageKey(sourceUrl: string, contentType: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceUrl));
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
  const ext = EXTENSIONS[contentType.split(';')[0].trim().toLowerCase()] ?? 'jpg';
  return `${hex}.${ext}`;
}

export interface CacheResult {
  path: string | null;
  reason?: string;
}

/** 抓一张图存进 R2，返回站内路径；抓不到就返回原因。 */
export async function cacheImage(bucket: R2Bucket, sourceUrl: string): Promise<CacheResult> {
  if (!isHttpUrl(sourceUrl)) return { path: null, reason: '不是 http(s) 地址' };
  let res: Response;
  try {
    res = await fetch(sourceUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; SuruCubby/1.0)' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { path: null, reason: '抓不到（超时或网络不通）' };
  }
  if (!res.ok) return { path: null, reason: `对方返回 ${res.status}` };

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    return { path: null, reason: '返回的不是图片（可能需要登录）' };
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) return { path: null, reason: '图片太大' };

  const body = await res.arrayBuffer();
  if (body.byteLength === 0) return { path: null, reason: '图片是空的' };
  if (body.byteLength > MAX_BYTES) return { path: null, reason: '图片太大' };

  const key = await imageKey(sourceUrl, contentType);
  await bucket.put(key, body, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { source: sourceUrl.slice(0, 900) },
  });
  return { path: `${CACHED_PREFIX}${key}` };
}

/**
 * 不想花钱开 R2 时的免费做法：图片经过自己的 Worker 转一道，
 * 结果放进 Cloudflare 边缘缓存（caches.default）。
 *   - 页面只引用自己域名下的 /img/i/{itemId}，换图床不用改数据；
 *   - 命中边缘缓存后不再回源，国内访问走就近节点；
 *   - 只代理数据库里存着的地址，不是开放代理。
 * 代价：边缘缓存会过期，对方把图删了就真没了（那种情况要永久保存还是得开 R2）。
 */
export async function proxyImage(sourceUrl: string): Promise<Response> {
  if (!isHttpUrl(sourceUrl)) return new Response('地址不对', { status: 404 });
  let upstream: Response;
  try {
    upstream = await fetch(sourceUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; SuruCubby/1.0)', accept: 'image/*' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return new Response('图片取不回来', { status: 504 });
  }
  if (!upstream.ok) return new Response('对方没给图', { status: 502 });

  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    return new Response('返回的不是图片', { status: 502 });
  }
  if (Number(upstream.headers.get('content-length') ?? '0') > MAX_BYTES) {
    return new Response('图片太大', { status: 502 });
  }

  const headers = new Headers({
    'content-type': contentType,
    // 商品图基本不会变，缓一周；真换了图可以改数据库里的地址
    'cache-control': 'public, max-age=604800',
  });
  const etag = upstream.headers.get('etag');
  if (etag) headers.set('etag', etag);
  return new Response(upstream.body, { status: 200, headers });
}
