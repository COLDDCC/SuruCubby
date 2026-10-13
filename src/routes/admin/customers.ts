import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, notFound, optionalString, readJson, requireInt, requireString } from '../../lib/http.ts';
import { nextId, nowIso } from '../../lib/db.ts';
import { randomToken } from '../../lib/crypto.ts';
import { buildCustomerView } from '../../lib/customerView.ts';

export const customerRoutes = new Hono<{ Bindings: Env }>();

customerRoutes.get('/', async (c) => {
  const q = c.req.query('q')?.trim() ?? '';
  const like = `%${q}%`;
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.qq, c.nickname, c.token, c.note, c.created_at AS createdAt,
            (SELECT COUNT(*) FROM items i WHERE i.customer_id = c.id) AS itemCount,
            (SELECT COUNT(*) FROM items i WHERE i.customer_id = c.id AND i.status = 'cn_stock') AS stockCount,
            (SELECT COALESCE(SUM(i.goods_fee_jpy), 0) FROM items i
              WHERE i.customer_id = c.id AND i.goods_paid = 0 AND i.status NOT IN ('cancelled','refunded')) AS goodsUnpaidJpy,
            (SELECT COALESCE(SUM(g.intl_fee_fen - COALESCE((SELECT SUM(i.intl_fee_fen) FROM items i WHERE i.weigh_group_id=g.id AND i.intl_paid=1),0)), 0) FROM weigh_groups g
              WHERE g.customer_id = c.id AND g.fee_paid = 0 AND g.intl_fee_fen IS NOT NULL) AS intlUnpaidFen,
            (SELECT COALESCE(SUM(s.fee_fen), 0) FROM shipments s
              WHERE s.customer_id = c.id AND s.fee_paid = 0) AS domesticUnpaidFen
       FROM customers c
      WHERE (? = '' OR c.qq LIKE ? OR c.nickname LIKE ?
             OR EXISTS (SELECT 1 FROM customer_aliases a WHERE a.customer_id = c.id AND a.alias LIKE ?))
      ORDER BY c.nickname`,
  )
    .bind(q, like, like, like)
    .all();
  return c.json({ customers: rows.results });
});

customerRoutes.post('/', async (c) => {
  const body = await readJson<{ qq?: string; nickname?: string; note?: string; alias?: string }>(c);
  const qq = requireString(body.qq, 'QQ 号');
  if (!/^\d{5,15}$/.test(qq)) throw badRequest('QQ 号格式不对');
  const nickname = requireString(body.nickname, '昵称');
  const db = c.env.DB;
  const exists = await db.prepare('SELECT id FROM customers WHERE qq = ?').bind(qq).first();
  if (exists) throw badRequest('这个 QQ 号已经有客户了');
  const id = await nextId(db, 'customers');
  const token = randomToken();
  await db.batch([
    db
      .prepare('INSERT INTO customers (id, qq, nickname, token, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, qq, nickname, token, optionalString(body.note), nowIso()),
    db
      .prepare('INSERT OR IGNORE INTO customer_aliases (alias, customer_id) VALUES (?, ?)')
      .bind(optionalString(body.alias) ?? nickname, id),
  ]);
  return c.json({ id, token });
});

customerRoutes.get('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const view = await buildCustomerView(c.env, id);
  if (!view) throw notFound('客户不存在');
  const aliases = await c.env.DB.prepare(
    'SELECT alias FROM customer_aliases WHERE customer_id = ? ORDER BY alias',
  )
    .bind(id)
    .all<{ alias: string }>();
  const row = await c.env.DB.prepare('SELECT token, note FROM customers WHERE id = ?')
    .bind(id)
    .first<{ token: string; note: string | null }>();
  const payments = await c.env.DB.prepare(
    `SELECT id, kind, currency, amount, ref_type AS refType, ref_id AS refId, note, paid_at AS paidAt
       FROM payments WHERE customer_id = ? ORDER BY id DESC LIMIT 50`,
  )
    .bind(id)
    .all();
  return c.json({
    ...view,
    aliases: aliases.results.map((a) => a.alias),
    token: row?.token,
    note: row?.note ?? null,
    payments: payments.results,
  });
});

customerRoutes.patch('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const body = await readJson<{ nickname?: string; qq?: string; note?: string }>(c);
  const qq = optionalString(body.qq);
  if (qq !== null && !/^\d{5,15}$/.test(qq)) throw badRequest('QQ 号格式不对');
  await c.env.DB.prepare(
    'UPDATE customers SET nickname = COALESCE(?, nickname), qq = COALESCE(?, qq), note = COALESCE(?, note) WHERE id = ?',
  )
    .bind(optionalString(body.nickname), qq, optionalString(body.note), id)
    .run();
  return c.json({ ok: true });
});

customerRoutes.post('/:id/reset-token', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const token = randomToken();
  const result = await c.env.DB.prepare('UPDATE customers SET token = ? WHERE id = ?')
    .bind(token, id)
    .run();
  if (!result.meta.changes) throw notFound('客户不存在');
  await c.env.DB.prepare('DELETE FROM token_attempts WHERE token = ?').bind(token).run();
  return c.json({ token });
});

customerRoutes.post('/:id/aliases', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const body = await readJson<{ alias?: string }>(c);
  const alias = requireString(body.alias, '别名');
  const existing = await c.env.DB.prepare(
    'SELECT customer_id AS customerId FROM customer_aliases WHERE alias = ?',
  )
    .bind(alias)
    .first<{ customerId: number }>();
  if (existing && existing.customerId !== id) throw badRequest('这个名字已经绑在别的客户身上了');
  await c.env.DB.prepare('INSERT OR IGNORE INTO customer_aliases (alias, customer_id) VALUES (?, ?)')
    .bind(alias, id)
    .run();
  return c.json({ ok: true });
});

customerRoutes.delete('/:id/aliases/:alias', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const alias = decodeURIComponent(c.req.param('alias'));
  await c.env.DB.prepare('DELETE FROM customer_aliases WHERE alias = ? AND customer_id = ?')
    .bind(alias, id)
    .run();
  return c.json({ ok: true });
});

/** 合并误建的重复客户：把 source 的一切挪到 target，然后删掉 source。 */
customerRoutes.post('/merge', async (c) => {
  const body = await readJson<{ sourceId?: unknown; targetId?: unknown }>(c);
  const sourceId = requireInt(body.sourceId, '被合并客户 ID');
  const targetId = requireInt(body.targetId, '保留客户 ID');
  if (sourceId === targetId) throw badRequest('不能自己合并自己');

  const db = c.env.DB;
  const source = await db.prepare('SELECT id FROM customers WHERE id = ?').bind(sourceId).first();
  const target = await db.prepare('SELECT id FROM customers WHERE id = ?').bind(targetId).first();
  if (!source || !target) throw notFound('客户不存在');

  // 同一包裹里两边都有称重组时，把物品并到 target 的组，重量与运费相加
  const conflicts = await db
    .prepare(
      `SELECT s.id AS sourceGroupId, t.id AS targetGroupId
         FROM weigh_groups s
         JOIN weigh_groups t ON t.package_id = s.package_id AND t.customer_id = ?
        WHERE s.customer_id = ?`,
    )
    .bind(targetId, sourceId)
    .all<{ sourceGroupId: number; targetGroupId: number }>();

  if (conflicts.results.length) {
    const charged = await db.prepare(`SELECT id FROM weigh_groups WHERE customer_id IN (?,?) AND (intl_fee_fen IS NOT NULL OR fee_paid=1) LIMIT 1`).bind(sourceId,targetId).first();
    if (charged) throw badRequest('已有运费账目的客户不能合并，请先核对并撤销相关收款和分摊');
  }
  const addressCount = await db.prepare('SELECT COUNT(*) AS n FROM addresses WHERE customer_id IN (?,?)').bind(sourceId,targetId).first<{n:number}>();
  if ((addressCount?.n ?? 0)>3) throw badRequest('合并后地址超过3个，请先删除多余地址');
  const active = await db.prepare(`SELECT id FROM shipping_requests WHERE customer_id IN (?,?) AND status IN ('pending','paid') LIMIT 1`).bind(sourceId,targetId).first();
  if (active) throw badRequest('有待处理发货申请，不能合并');
  const statements: D1PreparedStatement[] = [];
  for (const conflict of conflicts.results) {
    statements.push(
      db
        .prepare('UPDATE items SET weigh_group_id = ? WHERE weigh_group_id = ?')
        .bind(conflict.targetGroupId, conflict.sourceGroupId),
      db
        .prepare(
          `UPDATE weigh_groups SET
              weight_g = COALESCE(weight_g, 0) + COALESCE((SELECT weight_g FROM weigh_groups WHERE id = ?), 0),
              intl_fee_fen = COALESCE(intl_fee_fen, 0) + COALESCE((SELECT intl_fee_fen FROM weigh_groups WHERE id = ?), 0)
            WHERE id = ?`,
        )
        .bind(conflict.sourceGroupId, conflict.sourceGroupId, conflict.targetGroupId),
      db.prepare('DELETE FROM weigh_groups WHERE id = ?').bind(conflict.sourceGroupId),
    );
  }
  statements.push(
    db.prepare('UPDATE weigh_groups SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('UPDATE items SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('UPDATE addresses SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('UPDATE shipping_requests SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('UPDATE shipments SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('UPDATE payments SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db
      .prepare('UPDATE OR REPLACE customer_aliases SET customer_id = ? WHERE customer_id = ?')
      .bind(targetId, sourceId),
    db.prepare('DELETE FROM customers WHERE id = ?').bind(sourceId),
  );
  await db.batch(statements);
  return c.json({ ok: true, targetId });
});
