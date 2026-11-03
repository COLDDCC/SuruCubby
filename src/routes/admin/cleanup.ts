import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, readJson } from '../../lib/http.ts';
import { chunks } from '../../lib/parcels.ts';

/**
 * 清理已经走完的旧订单：比如 11 月发出去的，12 月统一删掉，给免费版 D1 腾地方（平铺图最占空间）。
 *
 * 一个订单只有「每一件都走完了」才会被删：已寄出 / 已签收 / 回国中（拼邮箱已发出）/ 取消 / 退款，
 * 而且最后一次变动早于给定日期。还在路上、还没打包的订单一件都不碰。
 * 收款记录本身留着（只是不再关联到具体物品），客户账号、地址、仓库账号都不动。
 */
export const cleanupRoutes = new Hono<{ Bindings: Env }>();

const DONE = "('shipped','delivered','intl_transit','cn_arrived','cn_stock','cancelled','refunded')";

cleanupRoutes.post('/', async (c) => {
  const body = await readJson<{ before?: unknown; commit?: boolean }>(c);
  const before = typeof body.before === 'string' ? body.before.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) throw badRequest('日期格式是 2026-12-01 这样');
  // 北京时间那一天的 0 点
  const cutoff = new Date(`${before}T00:00:00+08:00`).toISOString();
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT b.id, b.name, b.order_no AS orderNo, COUNT(i.id) AS itemCount, MAX(i.updated_at) AS lastAt
         FROM batches b LEFT JOIN items i ON i.batch_id = b.id
        GROUP BY b.id
       HAVING SUM(CASE WHEN i.id IS NOT NULL AND i.status NOT IN ${DONE} THEN 1 ELSE 0 END) = 0
          AND COALESCE(MAX(i.updated_at), b.created_at) < ?
        ORDER BY b.id`,
    )
    .bind(cutoff)
    .all<{ id: number; name: string; orderNo: string | null; itemCount: number; lastAt: string | null }>();
  const ids = rows.results.map((r) => r.id);
  let parcelCount = 0;
  let photoCount = 0;
  for (const part of chunks(ids)) {
    const q = part.map(() => '?').join(',');
    const p = await db
      .prepare(
        `SELECT COUNT(DISTINCT i.parcel_id) AS parcels,
                (SELECT COUNT(*) FROM parcel_photos ph WHERE ph.parcel_id IN (SELECT parcel_id FROM items WHERE batch_id IN (${q}))) AS photos
           FROM items i WHERE i.batch_id IN (${q})`,
      )
      .bind(...part, ...part)
      .first<{ parcels: number; photos: number }>();
    parcelCount += p?.parcels ?? 0;
    photoCount += p?.photos ?? 0;
  }
  const summary = {
    before,
    batchCount: ids.length,
    itemCount: rows.results.reduce((s, r) => s + r.itemCount, 0),
    parcelCount,
    photoCount,
    batches: rows.results.slice(0, 200),
  };
  if (!body.commit || ids.length === 0) return c.json({ committed: false, ...summary });

  // 顺序有讲究：D1 会检查外键，先删引用物品的，再删物品，最后删订单
  for (const part of chunks(ids, 30)) {
    const q = part.map(() => '?').join(',');
    const sub = `(SELECT id FROM items WHERE batch_id IN (${q}))`;
    await db.batch([
      db.prepare(`DELETE FROM payment_items WHERE item_id IN ${sub}`).bind(...part),
      db.prepare(`DELETE FROM request_items WHERE item_id IN ${sub}`).bind(...part),
      db.prepare(`DELETE FROM status_logs WHERE item_id IN ${sub}`).bind(...part),
      db.prepare(`DELETE FROM items WHERE batch_id IN (${q})`).bind(...part),
      db.prepare(`DELETE FROM package_batches WHERE batch_id IN (${q})`).bind(...part),
      db.prepare(`DELETE FROM batches WHERE id IN (${q})`).bind(...part),
    ]);
  }
  // 东西都删光了的包裹、平铺图、空箱子一起收掉（新开的空箱子不动）
  await db.batch([
    db.prepare('DELETE FROM parcel_photos WHERE parcel_id IN (SELECT p.id FROM parcels p WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.parcel_id = p.id))'),
    db.prepare('DELETE FROM parcels WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.parcel_id = parcels.id)'),
    db
      .prepare(
        `DELETE FROM packages WHERE created_at < ?
           AND NOT EXISTS (SELECT 1 FROM items i WHERE i.package_id = packages.id)
           AND NOT EXISTS (SELECT 1 FROM package_batches pb WHERE pb.package_id = packages.id)
           AND NOT EXISTS (SELECT 1 FROM weigh_groups g WHERE g.package_id = packages.id)
           AND NOT EXISTS (SELECT 1 FROM rounding_logs r WHERE r.package_id = packages.id)`,
      )
      .bind(cutoff),
  ]);
  return c.json({ committed: true, ...summary });
});
