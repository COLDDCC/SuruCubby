import type { Env } from './env.ts';

/** Workers 上用边缘缓存，Node（VPS）上用入口传进来的磁盘缓存。 */
export function imageCache(env: Env): ImageCache {
  if (env.IMAGE_CACHE) return env.IMAGE_CACHE;
  return (globalThis as unknown as { caches: { default: ImageCache } }).caches.default;
}
