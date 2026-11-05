import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { bound, notFound, optionalString, readJson, requireInt } from '../../lib/http.ts';
import { batchImageStatus, startBatchImages, startInBackground } from '../../lib/imageJobs.ts';
import { nowIso } from '../../lib/db.ts';

export const batchRoutes = new Hono<{ Bindings: Env }>();

/**
 * 订单总览：一张 Excel = 一个日本订单，群主在这里看自己录过的每一单。
 * 除了件数金额，还要一眼看出这单走到哪了（各状态件数）、几个人、装进了哪个包裹、
 * 日本订单号/物流单号填没填——以前这些得一单单点进去才知道。
 */
batchRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT b.id, b.name, b.ordered_at AS orderedAt, b.source_file AS sourceFile,
              b.created_at AS createdAt, b.shop AS shop, b.order_no AS orderNo, b.japan_tracking_no AS japanTrackingNo,
              COUNT(i.id) AS itemCount,
              COUNT(DISTINCT i.customer_id) AS customerCount,
              COALESCE(SUM(i.goods_fee_jpy), 0) AS amountJpy,
              COALESCE(SUM(CASE WHEN i.goods_paid = 0 AND i.status NOT IN ('cancelled','refunded')
                                THEN i.goods_fee_jpy ELSE 0 END), 0) AS unpaidJpy,
              COALESCE(SUM(i.missing), 0) AS missingCount
         FROM batches b
         LEFT JOIN items i ON i.batch_id = b.id
        GROUP BY b.id
        ORDER BY b.id DESC`,
    )
    .all<Record<string, unknown> & { id: number }>();

  const statusRows = await db
    .prepare('SELECT batch_id AS batchId, status, COUNT(*) AS count FROM items GROUP BY batch_id, status')
    .all<{ batchId: number; status: string; count: number }>();
  const packageRows = await db
    .prepare(
      `SELECT pb.batch_id AS batchId, p.id, p.name, p.status, p.tracking_no AS trackingNo
         FROM package_batches pb JOIN packages p ON p.id = pb.package_id
        ORDER BY p.id`,
    )
    .all<{ batchId: number; id: number; name: string; status: string; trackingNo: string | null }>();
  // 搜客户名用：每单里有谁。昵称 + 真名都给，前端本地过滤，不用每敲一个字就打一次后端。
  const peopleRows = await db
    .prepare(
      `SELECT DISTINCT i.batch_id AS batchId, c.nickname, c.real_name AS realName
         FROM items i JOIN customers c ON c.id = i.customer_id
        ORDER BY c.nickname`,
    )
    .all<{ batchId: number; nickname: string; realName: string | null }>();

  const statusCounts = new Map<number, Record<string, number>>();
  for (const r of statusRows.results) {
    const entry = statusCounts.get(r.batchId) ?? {};
    entry[r.status] = r.count;
    statusCounts.set(r.batchId, entry);
  }
  const packages = new Map<number, Array<{ id: number; name: string; status: string; trackingNo: string | null }>>();
  for (const { batchId, ...pkg } of packageRows.results) {
    packages.set(batchId, [...(packages.get(batchId) ?? []), pkg]);
  }
  const people = new Map<number, string[]>();
  for (const r of peopleRows.results) {
    const names = people.get(r.batchId) ?? [];
    names.push(r.realName && r.realName !== r.nickname ? `${r.nickname}（${r.realName}）` : r.nickname);
    people.set(r.batchId, names);
  }

  const batches = rows.results.map((b) => ({
    ...b,
    statusCounts: statusCounts.get(b.id) ?? {},
    packages: packages.get(b.id) ?? [],
    customers: people.get(b.id) ?? [],
  }));
  return c.json({ batches });
});

batchRoutes.get('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '批次 ID');
  const batch = await c.env.DB.prepare(
    'SELECT id, name, ordered_at AS orderedAt, source_file AS sourceFile, created_at AS createdAt,order_no AS orderNo,shop AS shop,japan_tracking_no AS japanTrackingNo FROM batches WHERE id = ?',
  )
    .bind(id)
    .first();
  if (!batch) throw notFound('批次不存在');

  const items = await c.env.DB.prepare(
    `SELECT i.id, i.customer_id AS customerId, c.nickname, c.qq, i.title, i.image_url AS imageUrl,
            i.product_url AS productUrl, i.actual_price_jpy AS actualPriceJpy,
            i.list_price_jpy AS listPriceJpy, i.goods_fee_jpy AS goodsFeeJpy, i.status,
            i.goods_paid AS goodsPaid, i.missing, i.exception_note AS exceptionNote,
            i.row_no AS rowNo, i.package_id AS packageId,
            i.released_at AS releasedAt, i.sorted_at AS sortedAt, i.parcel_id AS parcelId, c.ship_mode AS shipMode,
            b.order_no AS orderNo, b.shop AS shop
       FROM items i
       JOIN customers c ON c.id = i.customer_id
       JOIN batches b ON b.id = i.batch_id
      WHERE i.batch_id = ?
      ORDER BY c.nickname, i.row_no`,
  )
    .bind(id)
    .all();

  const packages = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.status FROM packages p
       JOIN package_batches pb ON pb.package_id = p.id
      WHERE pb.batch_id = ?`,
  )
    .bind(id)
    .all();

  return c.json({ batch, items: items.results, packages: packages.results });
});

batchRoutes.patch('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '批次 ID');
  const body = await readJson<{ name?: string; orderedAt?: string; orderNo?: string; shop?: string; japanTrackingNo?: string }>(c);
  const exists = await c.env.DB.prepare('SELECT id FROM batches WHERE id = ?').bind(id).first();
  // 以前改一个不存在的批次也回 ok，前端以为存上了
  if (!exists) throw notFound('批次不存在');
  const name = bound(optionalString(body.name), '批次名', 60);
  const orderedAt = bound(optionalString(body.orderedAt), '下单日期', 30);
  await c.env.DB.prepare(
    'UPDATE batches SET name = COALESCE(?, name), ordered_at = COALESCE(?, ordered_at) WHERE id = ?',
  )
    .bind(name, orderedAt, id)
    .run();
  // 订单号 / 日本单号：传了就照传的存，传空串就是清掉。以前用 COALESCE，
  // 填错了的单号删成空提交，看着成功了，刷新一看错号还在。
  const sets: string[] = [];
  const values: Array<string | null> = [];
  if (body.orderNo !== undefined) {
    sets.push('order_no = ?');
    values.push(bound(optionalString(body.orderNo), '日本订单号', 60));
  }
  if (body.japanTrackingNo !== undefined) {
    sets.push('japan_tracking_no = ?');
    values.push(bound(optionalString(body.japanTrackingNo), '日本物流单号', 60));
  }
  if (sets.length > 0)
    await c.env.DB.prepare(`UPDATE batches SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values, id)
      .run();
  // 店铺单独一条：这一格要能清空（填错了改回「照链接认」），COALESCE 会把空串吃掉
  if (body.shop !== undefined)
    await c.env.DB.prepare('UPDATE batches SET shop=? WHERE id=?')
      .bind(bound(optionalString(body.shop), '来源店铺', 40), id)
      .run();
  return c.json({ ok: true });
});

/** 这一单封面图的进度：存好几张、还在抓几张、哪些抓不到。 */
batchRoutes.get('/:id/images', async (c) => {
  const id = requireInt(c.req.param('id'), '批次 ID');
  return c.json(await batchImageStatus(c.env, id));
});

/**
 * 重新抓图：把还没存好的（包括之前抓失败的）再抓一遍，整单一次抓完，在后台跑。
 * wait=1 时等抓完再返回（测试和脚本用）。
 */
batchRoutes.post('/:id/images', async (c) => {
  const id = requireInt(c.req.param('id'), '批次 ID');
  if (c.req.query('wait')) await startBatchImages(c.env, id, { retryFailed: true });
  else startInBackground(c, id, { retryFailed: true });
  return c.json(await batchImageStatus(c.env, id));
});
