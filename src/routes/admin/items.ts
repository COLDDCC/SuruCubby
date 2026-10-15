import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, bound, notFound, optionalString, readJson, requireInt } from '../../lib/http.ts';
import { nowIso, statusLogStmt } from '../../lib/db.ts';
import { isItemStatus } from '../../lib/status.ts';
import { surugaCode } from '../../lib/images.ts';

export const itemRoutes = new Hono<{ Bindings: Env }>();

/**
 * 后台货号搜索：一般只输入编号的尾巴几个字（例如 8913 命中 ZHOTI678913），
 * 商品名里的片段、客户名字（含别名）也认。给 packageId 时只在这一箱里找——
 * 一箱几十件时先按人筛，比整库翻得快。
 * 返回每一件在哪个包裹 / 批次，前端好直接跳过去。
 */
itemRoutes.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').replace(/[%_\\]/g, '').trim();
  if (q.length < 2) return c.json({ items: [] });
  const rawPackage = c.req.query('packageId');
  const packageId = rawPackage && /^\d+$/.test(rawPackage) ? Number(rawPackage) : null;
  const like = `%${q}%`;
  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.title, i.image_url AS imageUrl, i.product_url AS productUrl, i.status,
            i.package_id AS packageId, i.batch_id AS batchId, i.customer_id AS customerId,
            c.nickname, c.self_return AS selfReturn, b.name AS batchName, p.name AS packageName, p.allocated_at AS allocatedAt
       FROM items i
       JOIN customers c ON c.id = i.customer_id
       JOIN batches b ON b.id = i.batch_id
       LEFT JOIN packages p ON p.id = i.package_id
      WHERE (i.product_url LIKE ? OR i.title LIKE ? OR c.nickname LIKE ?
             OR EXISTS (SELECT 1 FROM customer_aliases ca WHERE ca.customer_id = i.customer_id AND ca.alias LIKE ?))
        ${packageId ? 'AND i.package_id = ?' : ''}
      ORDER BY i.id
      LIMIT 30`,
  )
    .bind(...(packageId ? [like, like, like, like, packageId] : [like, like, like, like]))
    .all<{
      id: number;
      title: string;
      imageUrl: string | null;
      productUrl: string | null;
      status: string;
      packageId: number | null;
      batchId: number;
      customerId: number;
      nickname: string;
      selfReturn: number;
      batchName: string;
      packageName: string | null;
      allocatedAt: string | null;
    }>();
  return c.json({
    items: rows.results.map((r) => ({ ...r, code: surugaCode(r.productUrl ?? '') })),
  });
});

/** 单件手动改状态 / 记异常（处理砍单、损坏等）。 */
itemRoutes.patch('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '物品 ID');
  const body = await readJson<{
    status?: string;
    exceptionNote?: string;
    missing?: boolean;
    goodsPaid?: boolean;
  }>(c);

  const db = c.env.DB;
  const item = await db
    .prepare('SELECT id, status, goods_paid AS goodsPaid FROM items WHERE id = ?')
    .bind(id)
    .first<{ id: number; status: string; goodsPaid: number }>();
  if (!item) throw notFound('物品不存在');

  if (body.goodsPaid !== undefined) throw badRequest('请在收款页面记账或撤销收款');
  // 「已签收」是寄出之后的正常一步；可发货、已寄出仍然只能走称重/寄出流程
  const markingDelivered = body.status === 'delivered' && item.status === 'shipped';
  if (body.status && ['cn_stock','shipped','delivered'].includes(body.status) && body.status !== item.status) {
    if (!markingDelivered) throw badRequest('请通过称重确认或寄出流程设置此状态');
  }
  if (!markingDelivered) {
    const linked = await db.prepare('SELECT weigh_group_id AS gid, shipment_id AS sid FROM items WHERE id=?').bind(id).first<{gid:number|null;sid:number|null}>();
    const reserved = await db.prepare('SELECT item_id FROM request_items WHERE item_id=?').bind(id).first();
    if (reserved || linked?.sid || linked?.gid && await db.prepare('SELECT id FROM weigh_groups WHERE id=? AND intl_fee_fen IS NOT NULL').bind(linked.gid).first()) throw badRequest('物品已计费或已申请发货，请先撤销对应流程');
  }
  const at = nowIso();
  const statements: D1PreparedStatement[] = [];

  if (body.status !== undefined) {
    if (!isItemStatus(body.status)) throw badRequest(`未知状态：${body.status}`);
    if (body.status !== item.status) {
      statements.push(
        db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').bind(body.status, at, id),
        statusLogStmt(db, id, item.status, body.status, at),
      );
    }
  }
  if (body.exceptionNote !== undefined) {
    statements.push(
      db
        .prepare('UPDATE items SET exception_note = ?, updated_at = ? WHERE id = ?')
        .bind(bound(optionalString(body.exceptionNote), '异常备注', 200), at, id),
    );
  }
  if (body.missing !== undefined) {
    statements.push(
      db
        .prepare('UPDATE items SET missing = ?, updated_at = ? WHERE id = ?')
        .bind(body.missing ? 1 : 0, at, id),
    );
  }
  if (body.goodsPaid !== undefined) {
    statements.push(
      db
        .prepare('UPDATE items SET goods_paid = ?, updated_at = ? WHERE id = ?')
        .bind(body.goodsPaid ? 1 : 0, at, id),
    );
  }

  if (statements.length > 0) await db.batch(statements);
  return c.json({ ok: true });
});
