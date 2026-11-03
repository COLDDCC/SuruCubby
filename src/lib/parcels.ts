import type { Env } from './env.ts';
import { badRequest } from './http.ts';
import { getSetting } from './db.ts';

/** 单价上限：和国际运费同一条规矩，手滑多打几个零当场拦住。 */
export const MAX_FEN_PER_KG = 100_000;
/** 一个直邮包裹的毛重上限 100 kg，超了多半是把克当成了别的单位。 */
export const MAX_PARCEL_WEIGHT_G = 100_000;
/** 平铺图压缩后单张上限。前端会压到 1600px 的 JPEG，一般两三百 KB。 */
export const MAX_PHOTO_BYTES = 1_500_000;
export const MAX_PHOTOS_PER_PARCEL = 6;

export async function whCostFenPerKg(env: Env): Promise<number> {
  const n = Number.parseInt(await getSetting(env, 'wh_cost_fen_per_kg', '7000'), 10);
  return Number.isFinite(n) && n > 0 ? n : 7000;
}

export async function directSaleFenPerKg(env: Env): Promise<number> {
  const n = Number.parseInt(await getSetting(env, 'direct_sale_fen_per_kg', '8000'), 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

/** 毛重 × 单价，四舍五入到分。 */
export function feeFen(weightG: number, fenPerKg: number): number {
  return Math.round((weightG * fenPerKg) / 1000);
}

export function requirePricePerKg(value: unknown, label: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw badRequest(`${label}要是大于 0 的整数（分 / kg）`);
  if (n > MAX_FEN_PER_KG) throw badRequest(`${label}最多 1000 元 / kg，是不是多打了零`);
  return n;
}

export function requireWeightG(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw badRequest('毛重要填大于 0 的整数（克）');
  if (n > MAX_PARCEL_WEIGHT_G) throw badRequest('毛重超过 100 kg 了，是不是单位填错了（这里是克）');
  return n;
}

/** 北京时间的日期 YYYY-MM-DD：仓库「每一天放出来的包裹」按这个分批。 */
export function beijingDay(iso: string = new Date().toISOString()): string {
  return new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** data:image/jpeg;base64,... → 字节。只认常见图片格式，别的一律拒掉。 */
export function decodePhoto(dataUrl: unknown): { mime: string; bytes: Uint8Array } {
  if (typeof dataUrl !== 'string') throw badRequest('平铺图格式不对');
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw badRequest('平铺图只收 JPG / PNG / WebP');
  const binary = atob(m[2]);
  if (binary.length > MAX_PHOTO_BYTES) throw badRequest('平铺图太大了，压缩后还超过 1.5 MB');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { mime: m[1], bytes };
}

/** D1 把 BLOB 读成数字数组（本地有时是 ArrayBuffer），统一成字节。 */
export function blobBytes(data: unknown): Uint8Array<ArrayBuffer> {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  throw new Error('图片数据读不出来');
}

export async function photoResponse(env: Env, parcelId: number, photoId: number): Promise<Response | null> {
  const row = await env.DB.prepare('SELECT mime, data FROM parcel_photos WHERE id = ? AND parcel_id = ?')
    .bind(photoId, parcelId)
    .first<{ mime: string; data: unknown }>();
  if (!row) return null;
  return new Response(blobBytes(row.data), {
    headers: { 'content-type': row.mime, 'cache-control': 'private, max-age=86400' },
  });
}

/** D1 一条语句最多绑 100 个参数，IN (...) 要分批查。 */
export function chunks<T>(list: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** 一个包裹里装了哪些东西，每件来自哪个日本订单：客户最关心的就是这个。 */
export async function parcelItems(env: Env, parcelIds: number[]) {
  const map = new Map<number, ParcelItem[]>();
  for (const part of chunks(parcelIds)) {
    const rows = await env.DB.prepare(
      `SELECT i.id, i.parcel_id AS parcelId, i.title, i.image_url AS imageUrl, i.product_url AS productUrl,
              i.status, b.order_no AS orderNo, b.shop AS shop, b.name AS batchName, b.japan_tracking_no AS japanTrackingNo
         FROM items i JOIN batches b ON b.id = i.batch_id
        WHERE i.parcel_id IN (${part.map(() => '?').join(',')})
        ORDER BY i.batch_id, i.id`,
    )
      .bind(...part)
      .all<ParcelItem>();
    for (const r of rows.results) map.set(r.parcelId, [...(map.get(r.parcelId) ?? []), r]);
  }
  return map;
}

export interface ParcelItem {
  id: number;
  parcelId: number;
  title: string;
  imageUrl: string | null;
  productUrl: string | null;
  status: string;
  orderNo: string | null;
  shop: string | null;
  batchName: string;
  japanTrackingNo: string | null;
}

export async function photoIds(env: Env, parcelIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  for (const part of chunks(parcelIds)) {
    const rows = await env.DB.prepare(
      `SELECT id, parcel_id AS parcelId FROM parcel_photos WHERE parcel_id IN (${part.map(() => '?').join(',')}) ORDER BY id`,
    )
      .bind(...part)
      .all<{ id: number; parcelId: number }>();
    for (const r of rows.results) map.set(r.parcelId, [...(map.get(r.parcelId) ?? []), r.id]);
  }
  return map;
}
