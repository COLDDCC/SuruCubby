/**
 * 菜单上的红点：有新活就在对应菜单上标个数，不用一页页点进去看。
 * 只算「现在就能动手」的活，不算还在路上、等别人的：
 *
 *   日本仓  签收了还没分拣的件 + 签收齐了等封箱的回国箱 + 有地址等打包的直邮客户
 *   直邮    日本仓：付了款等寄出的包裹；管理员：等收款确认的包裹
 *   发货申请（管理员）客户提交了、还没确认收款的申请
 *   待办  （管理员）日本仓报的缺件 + 被催过还没确认收款的直邮包裹
 */
import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { staffOf } from '../../lib/staff.ts';

export const badgeRoutes = new Hono<{ Bindings: Env }>();

async function count(db: D1Database, sql: string): Promise<number> {
  return (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

badgeRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const role = staffOf(c).role;

  const arrivedUnsorted = await count(
    db,
    `SELECT COUNT(*) AS n FROM items i JOIN customers c ON c.id = i.customer_id
      WHERE i.status = 'jp_warehouse' AND i.sorted_at IS NULL AND i.direct_parcel_id IS NULL`,
  );
  const boxesReady = await count(
    db,
    `SELECT COUNT(*) AS n FROM packages p
      WHERE p.allocated_at IS NULL AND p.status IN ('ordered', 'jp_warehouse')
        AND EXISTS (SELECT 1 FROM items i WHERE i.package_id = p.id AND i.status = 'jp_warehouse' AND i.sorted_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.package_id = p.id AND i.status = 'ordered')`,
  );
  // 等打包的直邮客户：地址的细判（导入表 / 选定 / 只有一个）交给日本仓页面，这里粗算「有地址可用」
  const directToPack = await count(
    db,
    `SELECT COUNT(DISTINCT i.customer_id) AS n FROM items i JOIN customers c ON c.id = i.customer_id
      WHERE i.route = 'direct' AND i.status = 'jp_warehouse' AND i.direct_parcel_id IS NULL AND c.self_return = 0
        AND (i.import_address IS NOT NULL OR c.direct_address_id IS NOT NULL
             OR (SELECT COUNT(*) FROM addresses a WHERE a.customer_id = c.id) = 1)`,
  );
  const paidToShip = await count(db, `SELECT COUNT(*) AS n FROM direct_parcels WHERE status = 'paid'`);

  const badges: Record<string, number> = { '#/jp': arrivedUnsorted + boxesReady + directToPack };
  const detail: Record<string, number> = { arrivedUnsorted, boxesReady, directToPack, paidToShip };

  if (role === 'admin') {
    const awaitingPayment = await count(db, `SELECT COUNT(*) AS n FROM direct_parcels WHERE status = 'awaiting_payment'`);
    const nudged = await count(
      db,
      `SELECT COUNT(*) AS n FROM direct_parcels WHERE status = 'awaiting_payment' AND nudge_count > 0`,
    );
    const requests = await count(db, `SELECT COUNT(*) AS n FROM shipping_requests WHERE status = 'pending'`);
    const missing = await count(db, `SELECT COUNT(*) AS n FROM items WHERE missing = 1 AND status = 'ordered'`);
    badges['#/direct'] = awaitingPayment;
    badges['#/requests'] = requests;
    badges['#/'] = missing + nudged;
    Object.assign(detail, { awaitingPayment, nudged, requests, missing });
  } else {
    badges['#/direct'] = paidToShip;
  }
  const total = Object.values(badges).reduce((a, b) => a + b, 0);
  return c.json({ badges, detail, total });
});
