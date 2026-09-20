import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

const DAY_MS = 24 * 60 * 60 * 1000;

dashboardRoutes.get('/', async (c) => {
  const db = c.env.DB;

  const goodsUnpaid = await db
    .prepare(
      `SELECT i.customer_id AS customerId, c.nickname, c.qq, i.batch_id AS batchId, b.name AS batchName,
              COUNT(*) AS count, SUM(i.goods_fee_fen) AS amountFen
         FROM items i
         JOIN customers c ON c.id = i.customer_id
         JOIN batches b ON b.id = i.batch_id
        WHERE i.goods_paid = 0 AND i.status NOT IN ('cancelled', 'refunded')
        GROUP BY i.customer_id, i.batch_id
        HAVING SUM(i.goods_fee_fen) > 0
        ORDER BY c.nickname, b.id`,
    )
    .all();

  const intlUnpaid = await db
    .prepare(
      `SELECT g.id AS weighGroupId, g.customer_id AS customerId, c.nickname, c.qq,
              g.package_id AS packageId, p.name AS packageName, g.weight_g AS weightG,
              g.intl_fee_fen AS intlFeeFen
         FROM weigh_groups g
         JOIN customers c ON c.id = g.customer_id
         JOIN packages p ON p.id = g.package_id
        WHERE g.fee_paid = 0 AND g.intl_fee_fen IS NOT NULL AND g.intl_fee_fen > 0
        ORDER BY p.id DESC, c.nickname`,
    )
    .all();

  const domesticUnpaid = await db
    .prepare(
      `SELECT s.id AS shipmentId, s.customer_id AS customerId, c.nickname, c.qq,
              s.fee_fen AS feeFen, s.tracking_no AS trackingNo, s.created_at AS createdAt,
              (SELECT COUNT(*) FROM items i WHERE i.shipment_id = s.id) AS itemCount
         FROM shipments s
         JOIN customers c ON c.id = s.customer_id
        WHERE s.fee_paid = 0
        ORDER BY s.id DESC`,
    )
    .all();

  const pendingRefunds = await db
    .prepare(
      `SELECT i.id AS itemId, i.title, i.goods_fee_fen AS goodsFeeFen, i.customer_id AS customerId,
              c.nickname, c.qq, b.name AS batchName
         FROM items i
         JOIN customers c ON c.id = i.customer_id
         JOIN batches b ON b.id = i.batch_id
        WHERE i.status = 'cancelled' AND i.goods_paid = 1
        ORDER BY c.nickname, i.id`,
    )
    .all();

  const stockRows = await db
    .prepare(
      `SELECT i.customer_id AS customerId, c.nickname, c.qq, COUNT(*) AS count,
              MIN(l.at) AS earliestAt
         FROM items i
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN (
              SELECT item_id, MIN(at) AS at FROM status_logs WHERE to_status = 'cn_stock' GROUP BY item_id
         ) l ON l.item_id = i.id
        WHERE i.status = 'cn_stock'
        GROUP BY i.customer_id`,
    )
    .all<{
      customerId: number;
      nickname: string;
      qq: string;
      count: number;
      earliestAt: string | null;
    }>();

  const now = Date.now();
  const domesticStock = stockRows.results
    .map((row) => ({
      ...row,
      days: row.earliestAt ? Math.floor((now - Date.parse(row.earliestAt)) / DAY_MS) : 0,
    }))
    .sort((a, b) => b.days - a.days);

  return c.json({
    goodsUnpaid: goodsUnpaid.results,
    intlUnpaid: intlUnpaid.results,
    domesticUnpaid: domesticUnpaid.results,
    pendingRefunds: pendingRefunds.results,
    domesticStock,
  });
});
