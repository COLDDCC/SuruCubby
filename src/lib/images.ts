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
