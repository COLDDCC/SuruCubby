import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, notFound, optionalString, readJson, requireInt } from '../../lib/http.ts';
import { nowIso, statusLogStmt } from '../../lib/db.ts';
import { isItemStatus } from '../../lib/status.ts';

export const itemRoutes = new Hono<{ Bindings: Env }>();

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
        .bind(optionalString(body.exceptionNote), at, id),
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
