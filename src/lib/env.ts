export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** 可选：图片缓存桶。没绑定时图片直接外链，功能自动降级。 */
  IMAGES?: R2Bucket;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
}
