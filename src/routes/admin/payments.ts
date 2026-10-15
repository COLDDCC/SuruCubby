import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, bound, notFound, optionalString, placeholders, readJson, requireInt } from '../../lib/http.ts';
import { nextId, nowIso } from '../../lib/db.ts';

export const paymentRoutes = new Hono<{ Bindings: Env }>();

paymentRoutes.get('/', async (c) => {
  const customerId = c.req.query('customerId');
  const rows = customerId
    ? await c.env.DB.prepare(
        `SELECT p.id, p.customer_id AS customerId, c.nickname, c.qq, p.kind, p.amount, p.currency,
                p.ref_type AS refType, p.ref_id AS refId, p.note, p.paid_at AS paidAt
           FROM payments p JOIN customers c ON c.id = p.customer_id
          WHERE p.customer_id = ? ORDER BY p.id DESC LIMIT 200`,
      )
        .bind(requireInt(customerId, '客户 ID'))
        .all()
    : await c.env.DB.prepare(
        `SELECT p.id, p.customer_id AS customerId, c.nickname, c.qq, p.kind, p.amount, p.currency,
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
  const note = bound(optionalString(body.note), '备注', 200);
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
        `SELECT id, goods_fee_jpy AS goodsFeeJpy, batch_id AS batchId FROM items
          WHERE id IN (${placeholders(itemIds.length)}) AND customer_id = ? AND goods_paid = 0
            AND status NOT IN ('cancelled','refunded')`,
      )
      .bind(...itemIds, customerId)
      .all<{ id: number; goodsFeeJpy: number; batchId: number }>();
    if (items.results.length !== new Set(itemIds).size)
      throw badRequest('所选商品已付、已取消或归属不符，请刷新后重试');
    if (items.results.length === 0) throw badRequest('这些物品已经付过款了');

    // 货款收的是円：客户按付款当天汇率自己折人民币，群主不预先垫差价
    const amount = items.results.reduce((sum, i) => sum + i.goodsFeeJpy, 0);
    const batchIds = [...new Set(items.results.map((i) => i.batchId))];
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO payments (id, customer_id, kind, currency, amount, ref_type, ref_id, note, paid_at)
           VALUES (?, ?, 'goods', 'JPY', ?, 'batch', ?, ?, ?)`,
        )
        .bind(paymentId, customerId, amount, batchIds.length === 1 ? batchIds[0] : null, note, at),
    ];
    for (const item of items.results) {
      statements.push(
        db.prepare('UPDATE items SET goods_paid = 1, updated_at = ? WHERE id = ?').bind(at, item.id),
        db.prepare('INSERT OR IGNORE INTO payment_items (payment_id, item_id) VALUES (?, ?)').bind(paymentId, item.id),
      );
    }
    await db.batch(statements);
    return c.json({ id: paymentId, amount, itemCount: items.results.length });
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
    const alreadyPartial = await db
      .prepare('SELECT id FROM items WHERE weigh_group_id=? AND intl_paid=1 LIMIT 1')
      .bind(weighGroupId)
      .first();
    if (alreadyPartial) throw badRequest('部分商品已收运费，请通过发货申请逐件收款');
    await db.batch([
      db.prepare('UPDATE items SET intl_paid=1 WHERE weigh_group_id=?').bind(weighGroupId),
      db
        .prepare(
          `INSERT INTO payments (id, customer_id, kind, currency, amount, ref_type, ref_id, note, paid_at)
           VALUES (?, ?, 'intl', 'CNY', ?, 'weigh_group', ?, ?, ?)`,
        )
        .bind(paymentId, customerId, group.intlFeeFen, weighGroupId, note, at),
      db.prepare('UPDATE weigh_groups SET fee_paid = 1 WHERE id = ?').bind(weighGroupId),
    ]);
    return c.json({ id: paymentId, amount: group.intlFeeFen });
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
          `INSERT INTO payments (id, customer_id, kind, currency, amount, ref_type, ref_id, note, paid_at)
           VALUES (?, ?, 'domestic', 'CNY', ?, 'shipment', ?, ?, ?)`,
        )
        .bind(paymentId, customerId, shipment.feeFen, shipmentId, note, at),
      db.prepare('UPDATE shipments SET fee_paid = 1 WHERE id = ?').bind(shipmentId),
    ]);
    return c.json({ id: paymentId, amount: shipment.feeFen });
  }

  throw badRequest('kind 只能是 goods / intl / domestic');
});

/**
 * 一键按批收货款：这一批里每个还没付的客户各记一笔 JPY 收款，
 * 省掉「一个个客户点确认、再逐件勾选」。记录仍然按人按件留着，能单独撤销。
 */
paymentRoutes.post('/all-goods', async (c) => {
  const body = await readJson<{ batchId?: unknown; note?: string }>(c);
  const batchId = requireInt(body.batchId, '批次 ID');
  const db = c.env.DB;
  const at = nowIso();
  const note = bound(optionalString(body.note), '备注', 200);

  const rows = await db
    .prepare(
      `SELECT customer_id AS customerId, COUNT(*) AS itemCount, SUM(goods_fee_jpy) AS amountJpy
         FROM items
        WHERE batch_id = ? AND goods_paid = 0 AND status NOT IN ('cancelled','refunded')
        GROUP BY customer_id
        ORDER BY customer_id`,
    )
    .bind(batchId)
    .all<{ customerId: number; itemCount: number; amountJpy: number }>();
  if (!rows.results.length) throw badRequest('这一批没有要收的货款');

  let paymentId = await nextId(db, 'payments');
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    statements.push(
      db
        .prepare(
          `INSERT INTO payments (id, customer_id, kind, currency, amount, ref_type, ref_id, note, paid_at)
           VALUES (?, ?, 'goods', 'JPY', ?, 'batch', ?, ?, ?)`,
        )
        .bind(paymentId, row.customerId, row.amountJpy, batchId, note, at),
      // 先把这件批里未付的物品挂到这笔收款上（撤销时才知道该退哪几件），再改状态
      db
        .prepare(
          `INSERT OR IGNORE INTO payment_items (payment_id, item_id)
           SELECT ?, id FROM items
            WHERE batch_id = ? AND customer_id = ? AND goods_paid = 0 AND status NOT IN ('cancelled','refunded')`,
        )
        .bind(paymentId, batchId, row.customerId),
      db
        .prepare(
          `UPDATE items SET goods_paid = 1, updated_at = ?
            WHERE batch_id = ? AND customer_id = ? AND goods_paid = 0 AND status NOT IN ('cancelled','refunded')`,
        )
        .bind(at, batchId, row.customerId),
    );
    paymentId += 1;
  }
  await db.batch(statements);

  return c.json({
    customers: rows.results.length,
    itemCount: rows.results.reduce((sum, r) => sum + r.itemCount, 0),
    amountJpy: rows.results.reduce((sum, r) => sum + r.amountJpy, 0),
  });
});

/** 一键按批收国际运费：这个包裹里每一摞已分摊、还没收的运费各记一笔 CNY 收款。 */
paymentRoutes.post('/all-intl', async (c) => {
  const body = await readJson<{ packageId?: unknown; note?: string }>(c);
  const packageId = requireInt(body.packageId, '包裹 ID');
  const db = c.env.DB;
  const at = nowIso();
  const note = bound(optionalString(body.note), '备注', 200);

  const rows = await db
    .prepare(
      `SELECT g.id AS groupId, g.customer_id AS customerId, g.intl_fee_fen AS intlFeeFen,
              (SELECT COUNT(*) FROM items i WHERE i.weigh_group_id = g.id AND i.intl_paid = 1) AS paidItems
         FROM weigh_groups g
        WHERE g.package_id = ? AND g.fee_paid = 0 AND g.intl_fee_fen IS NOT NULL
        ORDER BY g.id`,
    )
    .bind(packageId)
    .all<{ groupId: number; customerId: number; intlFeeFen: number; paidItems: number }>();
  // 按发货申请收过部分运费的那一摞，金额已经和整摞对不上了，只能继续逐件收
  const groups = rows.results.filter((g) => !g.paidItems);
  if (!groups.length) throw badRequest('这个包裹没有要收的运费（可能还没分摊）');

  let paymentId = await nextId(db, 'payments');
  const statements: D1PreparedStatement[] = [];
  for (const group of groups) {
    statements.push(
      db
        .prepare(
          `INSERT INTO payments (id, customer_id, kind, currency, amount, ref_type, ref_id, note, paid_at)
           VALUES (?, ?, 'intl', 'CNY', ?, 'weigh_group', ?, ?, ?)`,
        )
        .bind(paymentId, group.customerId, group.intlFeeFen, group.groupId, note, at),
      db.prepare('UPDATE items SET intl_paid = 1, updated_at = ? WHERE weigh_group_id = ?').bind(at, group.groupId),
      db.prepare('UPDATE weigh_groups SET fee_paid = 1 WHERE id = ?').bind(group.groupId),
    );
    paymentId += 1;
  }
  await db.batch(statements);

  return c.json({
    customers: groups.length,
    skipped: rows.results.length - groups.length,
    amountFen: groups.reduce((sum, g) => sum + g.intlFeeFen, 0),
  });
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
      statements.push(db.prepare('UPDATE items SET goods_paid = 0, updated_at = ? WHERE id = ?').bind(at, item.itemId));
    }
    statements.push(db.prepare('DELETE FROM payment_items WHERE payment_id = ?').bind(id));
  } else if (payment.kind === 'item_intl' && payment.refId !== null) {
    const item = await db
      .prepare('SELECT weigh_group_id AS gid FROM items WHERE id=?')
      .bind(payment.refId)
      .first<{ gid: number }>();
    statements.push(db.prepare('UPDATE items SET intl_paid=0 WHERE id=?').bind(payment.refId));
    if (item) statements.push(db.prepare('UPDATE weigh_groups SET fee_paid=0 WHERE id=?').bind(item.gid));
  } else if (payment.kind === 'intl' && payment.refId !== null) {
    statements.push(db.prepare('UPDATE items SET intl_paid=0 WHERE weigh_group_id=?').bind(payment.refId));
    statements.push(db.prepare('UPDATE weigh_groups SET fee_paid = 0 WHERE id = ?').bind(payment.refId));
  } else if (payment.kind === 'domestic' && payment.refId !== null && payment.refType === 'request') {
    statements.push(
      db.prepare("UPDATE shipping_requests SET status='pending',paid_at=NULL WHERE id=?").bind(payment.refId),
    );
  } else if (payment.kind === 'domestic' && payment.refId !== null) {
    statements.push(db.prepare('UPDATE shipments SET fee_paid = 0 WHERE id = ?').bind(payment.refId));
  }
  statements.push(db.prepare('DELETE FROM payments WHERE id = ?').bind(id));
  await db.batch(statements);
  return c.json({ ok: true });
});
