import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, intList, notFound, optionalString, placeholders, readJson, requireInt } from '../../lib/http.ts';
import { domesticFeeFen, nextId, nowIso, statusLogStmt } from '../../lib/db.ts';

export const shipmentRoutes = new Hono<{ Bindings: Env }>();

shipmentRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.customer_id AS customerId, c.nickname, c.qq, s.tracking_no AS trackingNo,
            s.fee_fen AS feeFen, s.fee_paid AS feePaid, s.shipped_at AS shippedAt,
            s.created_at AS createdAt,
            (SELECT COUNT(*) FROM items i WHERE i.shipment_id = s.id) AS itemCount
       FROM shipments s
       JOIN customers c ON c.id = s.customer_id
      ORDER BY s.id DESC`,
  ).all();
  return c.json({ shipments: rows.results });
});

shipmentRoutes.get('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '寄出 ID');
  const shipment = await c.env.DB.prepare(
    `SELECT s.id, s.customer_id AS customerId, c.nickname, c.qq, s.tracking_no AS trackingNo,
            s.fee_fen AS feeFen, s.fee_paid AS feePaid, s.shipped_at AS shippedAt, s.created_at AS createdAt
       FROM shipments s JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`,
  )
    .bind(id)
    .first();
  if (!shipment) throw notFound('寄出记录不存在');
  const items = await c.env.DB.prepare(
    'SELECT id, title, image_url AS imageUrl, status FROM items WHERE shipment_id = ? ORDER BY id',
  )
    .bind(id)
    .all();
  return c.json({ shipment, items: items.results });
});

/** 生成一次国内寄出。运费未付时默认拦截，force = true 可强制继续。 */
shipmentRoutes.post('/', async (c) => {
  const body = await readJson<{ customerId?: unknown; itemIds?: unknown; force?: boolean; trackingNo?: string }>(c);
  const customerId = requireInt(body.customerId, '客户 ID');
  const itemIds = intList(body.itemIds, '物品 ID');
  const db = c.env.DB;

  const items = await db
    .prepare(
      `SELECT id, status, weigh_group_id AS weighGroupId FROM items
        WHERE id IN (${placeholders(itemIds.length)}) AND customer_id = ?`,
    )
    .bind(...itemIds, customerId)
    .all<{ id: number; status: string; weighGroupId: number | null }>();
  if (items.results.length !== itemIds.length) throw badRequest('有物品不属于这位客户');
  const notInStock = items.results.filter((i) => i.status !== 'cn_stock');
  if (notInStock.length > 0) {
    throw badRequest(`有 ${notInStock.length} 件东西不在「国内在库」状态，不能寄出`);
  }

  const groupIds = [...new Set(items.results.map((i) => i.weighGroupId).filter((v): v is number => v !== null))];
  let unpaidGroups: Array<{ id: number; packageName: string; intlFeeFen: number }> = [];
  if (groupIds.length > 0) {
    const rows = await db
      .prepare(
        `SELECT g.id, p.name AS packageName, g.intl_fee_fen AS intlFeeFen
           FROM weigh_groups g JOIN packages p ON p.id = g.package_id
          WHERE g.id IN (${placeholders(groupIds.length)}) AND g.fee_paid = 0
            AND g.intl_fee_fen IS NOT NULL AND g.intl_fee_fen > 0`,
      )
      .bind(...groupIds)
      .all<{ id: number; packageName: string; intlFeeFen: number }>();
    unpaidGroups = rows.results;
  }
  const unpaidIntlFen = unpaidGroups.reduce((sum, g) => sum + g.intlFeeFen, 0);
  const feeFen = await domesticFeeFen(c.env);

  if (unpaidIntlFen > 0 && !body.force) {
    return c.json(
      {
        error: '这位客户还有国际运费没付',
        blocked: true,
        unpaidIntlFen,
        unpaidGroups,
        feeFen,
        totalDueFen: feeFen + unpaidIntlFen,
      },
      409,
    );
  }

  const at = nowIso();
  const id = await nextId(db, 'shipments');
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        'INSERT INTO shipments (id, customer_id, tracking_no, fee_fen, fee_paid, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      )
      .bind(id, customerId, optionalString(body.trackingNo), feeFen, at),
  ];
  for (const item of items.results) {
    statements.push(
      db
        .prepare("UPDATE items SET shipment_id = ?, status = 'shipped', updated_at = ? WHERE id = ?")
        .bind(id, at, item.id),
      statusLogStmt(db, item.id, item.status, 'shipped', at),
    );
  }
  await db.batch(statements);

  return c.json({ id, feeFen, itemCount: items.results.length, unpaidIntlFen, totalDueFen: feeFen + unpaidIntlFen });
});

shipmentRoutes.patch('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '寄出 ID');
  const body = await readJson<{ trackingNo?: string; shippedAt?: string; feePaid?: boolean }>(c);
  const db = c.env.DB;
  const shipment = await db.prepare('SELECT id FROM shipments WHERE id = ?').bind(id).first();
  if (!shipment) throw notFound('寄出记录不存在');

  const trackingNo = optionalString(body.trackingNo);
  const shippedAt = trackingNo && !body.shippedAt ? nowIso() : optionalString(body.shippedAt);
  await db
    .prepare(
      `UPDATE shipments SET tracking_no = COALESCE(?, tracking_no),
              shipped_at = COALESCE(?, shipped_at),
              fee_paid = COALESCE(?, fee_paid)
        WHERE id = ?`,
    )
    .bind(trackingNo, shippedAt, body.feePaid === undefined ? null : body.feePaid ? 1 : 0, id)
    .run();
  return c.json({ ok: true });
});

/** 撤销一次寄出（填错时用），物品退回「国内在库」。 */
shipmentRoutes.delete('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '寄出 ID');
  const db = c.env.DB;
  const shipment = await db
    .prepare('SELECT id, fee_paid AS feePaid FROM shipments WHERE id = ?')
    .bind(id)
    .first<{ id: number; feePaid: number }>();
  if (!shipment) throw notFound('寄出记录不存在');
  if (shipment.feePaid) throw badRequest('这次寄出的运费已经收过了，先撤销收款再撤销寄出');

  const items = await db
    .prepare('SELECT id, status FROM items WHERE shipment_id = ?')
    .bind(id)
    .all<{ id: number; status: string }>();
  const at = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const item of items.results) {
    statements.push(
      db
        .prepare("UPDATE items SET shipment_id = NULL, status = 'cn_stock', updated_at = ? WHERE id = ?")
        .bind(at, item.id),
      statusLogStmt(db, item.id, item.status, 'cn_stock', at),
    );
  }
  statements.push(db.prepare('DELETE FROM shipments WHERE id = ?').bind(id));
  await db.batch(statements);
  return c.json({ ok: true, itemsReverted: items.results.length });
});
