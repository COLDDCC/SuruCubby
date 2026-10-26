export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** 可选：图片缓存桶。没绑定时图片直接外链，功能自动降级。 */
  IMAGES?: R2Bucket;
  /** 封面代理缓存。Workers 上不填，用 caches.default；Node 上是磁盘缓存。 */
  IMAGE_CACHE?: ImageCache;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
}
