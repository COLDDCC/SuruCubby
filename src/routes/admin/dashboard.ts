import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { feeFen } from '../../lib/parcels.ts';

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

const DAY_MS = 24 * 60 * 60 * 1000;

dashboardRoutes.get('/', async (c) => {
  const db = c.env.DB;

  const goodsUnpaid = await db
    .prepare(
      `SELECT i.customer_id AS customerId, c.nickname, c.qq, i.batch_id AS batchId, b.name AS batchName,
              COUNT(*) AS count, SUM(i.goods_fee_jpy) AS amountJpy
         FROM items i
         JOIN customers c ON c.id = i.customer_id
         JOIN batches b ON b.id = i.batch_id
        WHERE i.goods_paid = 0 AND i.status NOT IN ('cancelled', 'refunded')
        GROUP BY i.customer_id, i.batch_id
        HAVING SUM(i.goods_fee_jpy) > 0
        ORDER BY c.nickname, b.id`,
    )
    .all();

  const intlUnpaid = await db
    .prepare(
      `SELECT g.id AS weighGroupId, g.customer_id AS customerId, c.nickname, c.qq,
              g.package_id AS packageId, p.name AS packageName, g.weight_g AS weightG,
              g.intl_fee_fen - COALESCE((SELECT SUM(i.intl_fee_fen) FROM items i WHERE i.weigh_group_id=g.id AND i.intl_paid=1),0) AS intlFeeFen
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
      `SELECT i.id AS itemId, i.title, i.goods_fee_jpy AS goodsFeeJpy, i.customer_id AS customerId,
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

  // ───── 新流程待办（只读）：放行 → 仓库整理 → 直邮单号放行 / 拼邮箱发出 ─────

  // ① 还没放进客户仓库的：按「订单 × 客户」，收完货款的排前面（那些可以马上放）
  const toRelease = await db
    .prepare(
      `SELECT i.batch_id AS batchId, b.name AS batchName, b.order_no AS orderNo,
              i.customer_id AS customerId, c.nickname, c.ship_mode AS shipMode,
              COUNT(*) AS count, COALESCE(SUM(i.goods_fee_jpy), 0) AS amountJpy,
              MIN(i.goods_paid) AS goodsPaid
         FROM items i
         JOIN customers c ON c.id = i.customer_id
         JOIN batches b ON b.id = i.batch_id
        WHERE i.released_at IS NULL AND i.status NOT IN ('cancelled', 'refunded')
        GROUP BY i.batch_id, i.customer_id
        ORDER BY MIN(i.goods_paid) DESC, b.id DESC, c.nickname`,
    )
    .all();

  // ② 仓库打好包、还没单号放行的直邮包裹
  const parcelRows = await db
    .prepare(
      `SELECT p.id, p.customer_id AS customerId, c.nickname, p.submit_day AS submitDay,
              p.gross_weight_g AS grossWeightG, p.sale_fen_per_kg AS saleFenPerKg,
              (SELECT COUNT(*) FROM items i WHERE i.parcel_id = p.id) AS itemCount
         FROM parcels p
         JOIN customers c ON c.id = p.customer_id
        WHERE p.released_at IS NULL
        ORDER BY p.submit_day DESC, p.id DESC`,
    )
    .all<{ id: number; customerId: number; nickname: string; submitDay: string; grossWeightG: number; saleFenPerKg: number; itemCount: number }>();
  const parcelsPending = parcelRows.results.map(({ saleFenPerKg, ...p }) => ({ ...p, saleFen: feeFen(p.grossWeightG, saleFenPerKg) }));

  // ③ 已经放行、仓库还没点【整理完成】的：按订单
  const whBacklog = await db
    .prepare(
      `SELECT i.batch_id AS batchId, b.name AS batchName, b.order_no AS orderNo,
              b.japan_tracking_no AS japanTrackingNo,
              COUNT(*) AS count, COUNT(DISTINCT i.customer_id) AS customerCount,
              MIN(i.released_at) AS since
         FROM items i
         JOIN batches b ON b.id = i.batch_id
        WHERE i.released_at IS NOT NULL AND i.sorted_at IS NULL
          AND i.status IN ('ordered', 'jp_warehouse')
        GROUP BY i.batch_id
        ORDER BY MIN(i.released_at)`,
    )
    .all();

  // ④ 仓库开着、还没发出的拼邮箱
  const openBoxes = await db
    .prepare(
      `SELECT p.id, p.name, p.tracking_no AS trackingNo, p.created_at AS createdAt,
              (SELECT COUNT(*) FROM items i WHERE i.package_id = p.id) AS itemCount,
              (SELECT COUNT(DISTINCT i.customer_id) FROM items i WHERE i.package_id = p.id) AS customerCount
         FROM packages p
        WHERE p.kind = 'group' AND p.returned_at IS NULL
        ORDER BY p.id DESC`,
    )
    .all();

  // ⑤ 走直邮、但还没填地址、手上还有没寄的东西（多半是仓库刚改成直邮的）
  const needAddress = await db
    .prepare(
      `SELECT c.id AS customerId, c.nickname,
              (SELECT COUNT(*) FROM items i WHERE i.customer_id = c.id AND i.parcel_id IS NULL
                 AND i.status IN ('ordered','jp_warehouse','sorted')) AS count
         FROM customers c
        WHERE c.ship_mode = 'direct' AND c.self_return = 0 AND COALESCE(TRIM(c.direct_address), '') = ''
          AND EXISTS (SELECT 1 FROM items i WHERE i.customer_id = c.id AND i.parcel_id IS NULL
                        AND i.status IN ('ordered','jp_warehouse','sorted'))
        ORDER BY c.nickname`,
    )
    .all();

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
    toRelease: toRelease.results,
    parcelsPending,
    whBacklog: whBacklog.results,
    openBoxes: openBoxes.results,
    needAddress: needAddress.results,
  });
});
