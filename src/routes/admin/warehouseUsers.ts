import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, bound, notFound, optionalString, readJson, requireInt, requireString } from '../../lib/http.ts';
import { nextId, nowIso } from '../../lib/db.ts';
import { hashPassword } from '../../lib/password.ts';

/** 仓库账号：每个仓库人员一个，群主建、改密码、停用。改密码或停用，他那边当场掉线。 */
export const warehouseUserRoutes = new Hono<{ Bindings: Env }>();

function checkPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 6 || value.length > 64) throw badRequest('密码要 6 到 64 位');
  if (/\s/.test(value)) throw badRequest('密码里不要有空格');
  return value;
}

warehouseUserRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.display_name AS displayName, u.disabled, u.created_at AS createdAt,
            (SELECT COUNT(*) FROM parcels p WHERE p.created_by = u.id) AS parcelCount
       FROM warehouse_users u ORDER BY u.disabled, u.id`,
  ).all();
  return c.json({ users: rows.results });
});

warehouseUserRoutes.post('/', async (c) => {
  const body = await readJson<{ username?: unknown; displayName?: unknown; password?: unknown }>(c);
  const username = requireString(body.username, '账号');
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw badRequest('账号只能用字母、数字、_ . -，3 到 32 位');
  const displayName = bound(optionalString(body.displayName) ?? username, '名字', 30) as string;
  const password = checkPassword(body.password);
  const db = c.env.DB;
  const taken = await db.prepare('SELECT id FROM warehouse_users WHERE username = ?').bind(username).first();
  if (taken) throw badRequest(`账号 ${username} 已经有了`);
  const id = await nextId(db, 'warehouse_users');
  await db
    .prepare('INSERT INTO warehouse_users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, username, displayName, await hashPassword(password), nowIso())
    .run();
  return c.json({ ok: true, id });
});

warehouseUserRoutes.patch('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '账号 ID');
  const body = await readJson<{ displayName?: unknown; password?: unknown; disabled?: unknown }>(c);
  const db = c.env.DB;
  const exists = await db.prepare('SELECT id FROM warehouse_users WHERE id = ?').bind(id).first();
  if (!exists) throw notFound('没有这个仓库账号');
  const stmts: D1PreparedStatement[] = [];
  if (body.displayName !== undefined) stmts.push(db.prepare('UPDATE warehouse_users SET display_name = ? WHERE id = ?').bind(bound(requireString(body.displayName, '名字'), '名字', 30), id));
  if (body.password !== undefined) stmts.push(db.prepare('UPDATE warehouse_users SET password_hash = ? WHERE id = ?').bind(await hashPassword(checkPassword(body.password)), id));
  if (body.disabled !== undefined) stmts.push(db.prepare('UPDATE warehouse_users SET disabled = ? WHERE id = ?').bind(body.disabled ? 1 : 0, id));
  if (stmts.length) await db.batch(stmts);
  return c.json({ ok: true });
});
