import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { nowIso } from '../../lib/db.ts';
import { hashPassword } from '../../lib/password.ts';
import { badRequest, bound, notFound, readJson, requireInt, requireString } from '../../lib/http.ts';
import {
  ROLE_LABELS,
  isStaffRole,
  staffOf,
  staffPasswordProblem,
  usernameProblem,
} from '../../lib/staff.ts';

/** 员工账号管理（只有管理员能进）。 */
export const staffRoutes = new Hono<{ Bindings: Env }>();

interface StaffRow {
  id: number;
  username: string;
  displayName: string;
  role: string;
  disabled: number;
  createdAt: string;
  lastLoginAt: string | null;
}

const SELECT = `SELECT id, username, display_name AS displayName, role, disabled,
  created_at AS createdAt, last_login_at AS lastLoginAt FROM staff_users`;

staffRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(`${SELECT} ORDER BY disabled, role, id`).all<StaffRow>();
  return c.json({
    me: staffOf(c),
    roles: ROLE_LABELS,
    staff: rows.results.map((r) => ({ ...r, disabled: !!r.disabled })),
  });
});

staffRoutes.post('/', async (c) => {
  const body = await readJson<{ username?: unknown; displayName?: unknown; role?: unknown; password?: unknown }>(c);
  const username = requireString(body.username, '账号');
  const problem = usernameProblem(username);
  if (problem) throw badRequest(problem);
  const displayName = bound(requireString(body.displayName, '名字'), '名字', 20) as string;
  if (!isStaffRole(body.role)) throw badRequest('角色只能是管理员或日本仓');
  const password = typeof body.password === 'string' ? body.password : '';
  const pwProblem = staffPasswordProblem(password);
  if (pwProblem) throw badRequest(pwProblem);

  const exists = await c.env.DB.prepare('SELECT id FROM staff_users WHERE username = ?').bind(username).first();
  if (exists) throw badRequest(`账号 ${username} 已经有了`);
  const result = await c.env.DB.prepare(
    'INSERT INTO staff_users (username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(username, displayName, body.role, await hashPassword(password), nowIso())
    .run();
  return c.json({ ok: true, id: result.meta.last_row_id });
});

/** 改名字、改角色、停用 / 启用、重置密码；改密码和停用都会让他当场掉线。 */
staffRoutes.patch('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '员工 ID');
  const row = await c.env.DB.prepare(`${SELECT} WHERE id = ?`).bind(id).first<StaffRow>();
  if (!row) throw notFound('没有这个员工账号');
  const body = await readJson<{ displayName?: unknown; role?: unknown; disabled?: unknown; password?: unknown }>(c);
  const me = staffOf(c);

  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.displayName !== undefined) {
    sets.push('display_name = ?');
    args.push(bound(requireString(body.displayName, '名字'), '名字', 20));
  }
  if (body.role !== undefined) {
    if (!isStaffRole(body.role)) throw badRequest('角色只能是管理员或日本仓');
    if (me.id === id && body.role !== 'admin') throw badRequest('不能把自己降成日本仓，免得把自己锁在门外');
    sets.push('role = ?');
    args.push(body.role);
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') throw badRequest('disabled 要是 true / false');
    if (me.id === id && body.disabled) throw badRequest('不能停用自己');
    sets.push('disabled = ?');
    args.push(body.disabled ? 1 : 0);
  }
  if (body.password !== undefined) {
    const password = typeof body.password === 'string' ? body.password : '';
    const problem = staffPasswordProblem(password);
    if (problem) throw badRequest(problem);
    sets.push('password_hash = ?');
    args.push(await hashPassword(password));
  }
  if (!sets.length) throw badRequest('没有要改的内容');
  await c.env.DB.prepare(`UPDATE staff_users SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run();
  return c.json({ ok: true });
});

/** 操作日志，最新的在前。 */
staffRoutes.get('/audit', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500);
  const staffId = c.req.query('staffId');
  const rows = await c.env.DB.prepare(
    `SELECT id, staff_id AS staffId, staff_name AS staffName, role, method, path, status, detail, at
       FROM audit_logs ${staffId ? 'WHERE staff_id = ?' : ''} ORDER BY id DESC LIMIT ?`,
  )
    .bind(...(staffId ? [requireInt(staffId, '员工 ID'), limit] : [limit]))
    .all();
  return c.json({ logs: rows.results });
});
