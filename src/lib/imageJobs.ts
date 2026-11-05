/**
 * 封面图一次抓完：导入（Excel / 飞书 / 单个客户录入）之后在后台自动跑，
 * 把这一单所有还没存到自己服务器上的图一口气抓下来。
 *   - 同时抓 4 张，每张最多试 3 次（隔 1 秒、3 秒再试）；
 *   - 来源依次是：表里给的图片地址 → 商品页 og:image → 骏河屋按货号推的官方图；
 *   - 有图片存储（VPS 上就是服务器硬盘，Workers 上是 R2）就存进去，页面只从自己服务器出图；
 *     没有存储（Workers 没开 R2）才退回记外链；
 *   - 抓不到的记下原因（items.image_error），群主可以「重抓」或手动上传。
 */
import type { Env } from './env.ts';
import { nowIso } from './db.ts';
import { fetchOgImage } from './ogImage.ts';
import { cacheImage, CACHED_PREFIX, imageKey, isHttpUrl, liveImageUrl, surugaImageCandidates } from './images.ts';

const CONCURRENCY = 4;
const RETRY_DELAYS = [1000, 3000];

/** 同一个进程里，同一单不会同时跑两个抓图任务。 */
const running = new Map<number, Promise<void>>();

interface Row {
  id: number;
  imageUrl: string | null;
  productUrl: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 「还要处理」的条件：没进自己的存储、又有地方可以找图。 */
function pendingWhere(hasBucket: boolean, retryFailed: boolean): string {
  const base = hasBucket
    ? `(image_url IS NULL OR image_url NOT LIKE '${CACHED_PREFIX}%') AND (image_url IS NOT NULL OR product_url IS NOT NULL)`
    : 'image_url IS NULL AND product_url IS NOT NULL';
  return retryFailed ? base : `${base} AND image_error IS NULL`;
}

async function withRetry<T>(fn: () => Promise<T | null>): Promise<T | null> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await fn();
    if (result !== null) return result;
    if (attempt >= RETRY_DELAYS.length) return null;
    await sleep(RETRY_DELAYS[attempt]);
  }
}

async function candidates(row: Row): Promise<string[]> {
  const out: string[] = [];
  if (isHttpUrl(row.imageUrl)) out.push(row.imageUrl);
  if (row.productUrl) {
    const og = await withRetry(() => fetchOgImage(row.productUrl!));
    if (og && !out.includes(og)) out.push(og);
    for (const c of surugaImageCandidates(row.productUrl)) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** 处理一件：成功返回新的 image_url，失败返回原因。 */
async function processOne(env: Env, row: Row): Promise<{ url: string } | { error: string }> {
  const list = await candidates(row);
  if (!list.length) return { error: '表里没有图片地址，商品页也找不到图' };
  let lastReason = '抓不到';
  for (const source of list) {
    if (env.IMAGES) {
      let reason = '';
      const path = await withRetry(async () => {
        const r = await cacheImage(env.IMAGES!, source);
        reason = r.reason ?? '';
        return r.path;
      });
      if (path) return { url: path };
      lastReason = reason || lastReason;
    } else {
      const live = await withRetry(() => liveImageUrl(source));
      if (live) return { url: live };
    }
  }
  return { error: lastReason };
}

async function run(env: Env, batchId: number, retryFailed: boolean): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, image_url AS imageUrl, product_url AS productUrl FROM items
      WHERE batch_id = ? AND ${pendingWhere(Boolean(env.IMAGES), retryFailed)} ORDER BY id`,
  )
    .bind(batchId)
    .all<Row>();
  const queue = [...rows.results];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const result = await processOne(env, row);
      const at = nowIso();
      if ('url' in result) {
        await env.DB.prepare('UPDATE items SET image_url = ?, image_error = NULL, updated_at = ? WHERE id = ?')
          .bind(result.url, at, row.id)
          .run();
      } else {
        await env.DB.prepare('UPDATE items SET image_error = ? WHERE id = ?').bind(result.error.slice(0, 200), row.id).run();
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/** 开始（或接着）抓这一单的图。已经在跑就返回同一个任务。 */
export function startBatchImages(env: Env, batchId: number, { retryFailed = false } = {}): Promise<void> {
  const current = running.get(batchId);
  if (current) return current;
  const job = run(env, batchId, retryFailed)
    .catch((err) => console.error(`订单 ${batchId} 抓图出错`, err))
    .finally(() => running.delete(batchId));
  running.set(batchId, job);
  return job;
}

/** 让任务在响应发出后继续跑（Node 上一直跑完；Workers 上能跑多久跑多久，剩下的点「重抓」）。 */
export function startInBackground(
  c: { env: Env; readonly executionCtx: { waitUntil(p: Promise<unknown>): void } },
  batchId: number,
  opts?: { retryFailed?: boolean },
): void {
  const job = startBatchImages(c.env, batchId, opts);
  try {
    c.executionCtx.waitUntil(job);
  } catch {
    /* 没有执行上下文（单元测试）时任务照样在跑 */
  }
}

export interface ImageStatus {
  total: number;
  stored: number;
  pending: number;
  noSource: number;
  running: boolean;
  storage: boolean;
  failed: Array<{ itemId: number; title: string; reason: string }>;
}

export async function batchImageStatus(env: Env, batchId: number): Promise<ImageStatus> {
  const storage = Boolean(env.IMAGES);
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN ${storage ? `image_url LIKE '${CACHED_PREFIX}%'` : 'image_url IS NOT NULL'} THEN 1 ELSE 0 END) AS stored,
            SUM(CASE WHEN image_url IS NULL AND product_url IS NULL THEN 1 ELSE 0 END) AS noSource,
            SUM(CASE WHEN ${pendingWhere(storage, false)} THEN 1 ELSE 0 END) AS pending
       FROM items WHERE batch_id = ?`,
  )
    .bind(batchId)
    .first<{ total: number; stored: number | null; noSource: number | null; pending: number | null }>();
  const failed = await env.DB.prepare(
    `SELECT id AS itemId, title, image_error AS reason FROM items
      WHERE batch_id = ? AND image_error IS NOT NULL AND ${pendingWhere(storage, true)} ORDER BY id`,
  )
    .bind(batchId)
    .all<{ itemId: number; title: string; reason: string }>();
  return {
    total: counts?.total ?? 0,
    stored: counts?.stored ?? 0,
    pending: counts?.pending ?? 0,
    noSource: counts?.noSource ?? 0,
    running: running.has(batchId),
    storage,
    failed: failed.results,
  };
}

/** 群主手动给一件东西上传 / 粘贴封面（data:image/...;base64,...），存进自己的存储。 */
export async function storeUploadedImage(env: Env, dataUrl: string): Promise<string> {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error('只收 JPG / PNG / WebP / GIF 图片');
  const binary = atob(m[2]);
  if (binary.length > 5 * 1024 * 1024) throw new Error('图片太大了（最多 5 MB）');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (!env.IMAGES) return dataUrl; // 没有存储时直接存在数据库里
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = await imageKey(`upload:${hex}`, m[1]);
  await env.IMAGES.put(key, bytes, {
    httpMetadata: { contentType: m[1], cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { source: 'upload' },
  });
  return `${CACHED_PREFIX}${key}`;
}
