import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, notFound, optionalString, placeholders, readJson, requireInt } from '../../lib/http.ts';
import { nextId, nowIso } from '../../lib/db.ts';

export const paymentRoutes = new Hono<{ Bindings: Env }>();

paymentRoutes.get('/', async (c) => {
  const customerId = c.req.query('customerId');
  const rows = customerId
    ? await c.env.DB.prepare(
        `SELECT p.id, p.customer_id AS customerId, c.nickname, c.qq, p.kind, p.amount_fen AS amountFen,
                p.ref_type AS refType, p.ref_id AS refId, p.note, p.paid_at AS paidAt
           FROM payments p JOIN customers c ON c.id = p.customer_id
          WHERE p.customer_id = ? ORDER BY p.id DESC LIMIT 200`,
      )
        .bind(requireInt(customerId, '客户 ID'))
        .all()
    : await c.env.DB.prepare(
        `SELECT p.id, p.customer_id AS customerId, c.nickname, c.qq, p.kind, p.amount_fen AS amountFen,
                p.ref_type AS refType, p.ref_id AS refId, p.note, p.paid_at AS paidAt
           FROM payments p JOIN customers c ON c.id = p.customer_id
          ORDER BY p.id DESC LIMIT 200`,
      ).all();
  return c.json({ payments: rows.results });
});

interface PaymentBody {
  customerId?: unknown;
  kind?: string;
  itemIds?: unknown;
  batchId?: unknown;
  weighGroupId?: unknown;
  shipmentId?: unknown;
  note?: string;
}

paymentRoutes.post('/', async (c) => {
  const body = await readJson<PaymentBody>(c);
  const customerId = requireInt(body.customerId, '客户 ID');
  const kind = body.kind;
  const db = c.env.DB;
  const at = nowIso();
  const note = optionalString(body.note);
  const paymentId = await nextId(db, 'payments');

  if (kind === 'goods') {
    let itemIds: number[] = [];
    if (Array.isArray(body.itemIds) && body.itemIds.length > 0) {
      itemIds = body.itemIds.map((v) => requireInt(v, '物品 ID'));
    } else if (body.batchId !== undefined && body.batchId !== null) {
      const batchId = requireInt(body.batchId, '批次 ID');
      const rows = await db
        .prepare(
          `SELECT id FROM items
            WHERE customer_id = ? AND batch_id = ? AND goods_paid = 0
              AND status NOT IN ('cancelled','refunded')`,
        )
        .bind(customerId, batchId)
        .all<{ id: number }>();
      itemIds = rows.results.map((r) => r.id);
    }
    if (itemIds.length === 0) throw badRequest('没有要收款的物品');

    const items = await db
      .prepare(
        `SELECT id, goods_fee_fen AS goodsFeeFen, batch_id AS batchId FROM items
          WHERE id IN (${placeholders(itemIds.length)}) AND customer_id = ? AND goods_paid = 0
            AND status NOT IN ('cancelled','refunded')`,
      )
      .bind(...itemIds, customerId)
      .all<{ id: number; goodsFeeFen: number; batchId: number }>();
    if (items.results.length === 0) throw badRequest('这些物品已经付过款了');

    const amountFen = items.results.reduce((sum, i) => sum + i.goodsFeeFen, 0);
    const batchIds = [...new Set(items.results.map((i) => i.batchId))];
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO payments (id, customer_id, kind, amount_fen, ref_type, ref_id, note, paid_at)
           VALUES (?, ?, 'goods', ?, 'batch', ?, ?, ?)`,
        )
        .bind(paymentId, customerId, amountFen, batchIds.length === 1 ? batchIds[0] : null, note, at),
    ];
    for (const item of items.results) {
      statements.push(
        db.prepare('UPDATE items SET goods_paid = 1, updated_at = ? WHERE id = ?').bind(at, item.id),
        db
          .prepare('INSERT OR IGNORE INTO payment_items (payment_id, item_id) VALUES (?, ?)')
          .bind(paymentId, item.id),
      );
    }
    await db.batch(statements);
    return c.json({ id: paymentId, amountFen, itemCount: items.results.length });
  }

  if (kind === 'intl') {
    const weighGroupId = requireInt(body.weighGroupId, '称重组 ID');
    const group = await db
      .prepare(
        'SELECT id, intl_fee_fen AS intlFeeFen, fee_paid AS feePaid, customer_id AS customerId FROM weigh_groups WHERE id = ?',
      )
      .bind(weighGroupId)
      .first<{ id: number; intlFeeFen: number | null; feePaid: number; customerId: number }>();
    if (!group) throw notFound('称重组不存在');
    if (group.customerId !== customerId) throw badRequest('这一摞不属于这位客户');
    if (group.feePaid) throw badRequest('这一摞的运费已经收过了');
    if (group.intlFeeFen === null) throw badRequest('这个包裹还没分摊运费');
    await db.batch([
      db
        .prepare(
          `INSERT INTO payments (id, customer_id, kind, amount_fen, ref_type, ref_id, note, paid_at)
           VALUES (?, ?, 'intl', ?, 'weigh_group', ?, ?, ?)`,
        )
        .bind(paymentId, customerId, group.intlFeeFen, weighGroupId, note, at),
      db.prepare('UPDATE weigh_groups SET fee_paid = 1 WHERE id = ?').bind(weighGroupId),
    ]);
    return c.json({ id: paymentId, amountFen: group.intlFeeFen });
  }

  if (kind === 'domestic') {
    const shipmentId = requireInt(body.shipmentId, '寄出 ID');
    const shipment = await db
      .prepare(
        'SELECT id, fee_fen AS feeFen, fee_paid AS feePaid, customer_id AS customerId FROM shipments WHERE id = ?',
      )
      .bind(shipmentId)
      .first<{ id: number; feeFen: number; feePaid: number; customerId: number }>();
    if (!shipment) throw notFound('寄出记录不存在');
    if (shipment.customerId !== customerId) throw badRequest('这次寄出不属于这位客户');
    if (shipment.feePaid) throw badRequest('这次寄出的运费已经收过了');
    await db.batch([
      db
        .prepare(
          `INSERT INTO payments (id, customer_id, kind, amount_fen, ref_type, ref_id, note, paid_at)
           VALUES (?, ?, 'domestic', ?, 'shipment', ?, ?, ?)`,
        )
        .bind(paymentId, customerId, shipment.feeFen, shipmentId, note, at),
      db.prepare('UPDATE shipments SET fee_paid = 1 WHERE id = ?').bind(shipmentId),
    ]);
    return c.json({ id: paymentId, amountFen: shipment.feeFen });
  }

  throw badRequest('kind 只能是 goods / intl / domestic');
});

/** 撤销收款（误点时用）。 */
paymentRoutes.delete('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '收款 ID');
  const db = c.env.DB;
  const payment = await db
    .prepare('SELECT id, kind, ref_type AS refType, ref_id AS refId FROM payments WHERE id = ?')
    .bind(id)
    .first<{ id: number; kind: string; refType: string | null; refId: number | null }>();
  if (!payment) throw notFound('收款记录不存在');

  const at = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (payment.kind === 'goods') {
    const items = await db
      .prepare('SELECT item_id AS itemId FROM payment_items WHERE payment_id = ?')
      .bind(id)
      .all<{ itemId: number }>();
    for (const item of items.results) {
      statements.push(
        db.prepare('UPDATE items SET goods_paid = 0, updated_at = ? WHERE id = ?').bind(at, item.itemId),
      );
    }
    statements.push(db.prepare('DELETE FROM payment_items WHERE payment_id = ?').bind(id));
  } else if (payment.kind === 'intl' && payment.refId !== null) {
    statements.push(db.prepare('UPDATE weigh_groups SET fee_paid = 0 WHERE id = ?').bind(payment.refId));
  } else if (payment.kind === 'domestic' && payment.refId !== null) {
    statements.push(db.prepare('UPDATE shipments SET fee_paid = 0 WHERE id = ?').bind(payment.refId));
  }
  statements.push(db.prepare('DELETE FROM payments WHERE id = ?').bind(id));
  await db.batch(statements);
  return c.json({ ok: true });
});
