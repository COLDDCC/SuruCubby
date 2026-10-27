import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { timingSafeEqual } from '../../lib/crypto.ts';
import { nowIso } from '../../lib/db.ts';
import { verifyPassword } from '../../lib/password.ts';
import { clearAdminSession, currentStaff, issueAdminSession } from '../../lib/session.ts';
import { BOOTSTRAP_USERNAME, isStaffRole } from '../../lib/staff.ts';
import { readJson } from '../../lib/http.ts';

export const authRoutes = new Hono<{ Bindings: Env }>();

const LOCK_MS = 900_000;
const MAX_FAILS = 5;

/**
 * 员工登录：账号 + 密码。
 *   - 账号 admin（或不填账号，兼容旧版只填密码的登录）→ 对环境变量 ADMIN_PASSWORD；
 *   - 其余账号 → 员工表，停用的进不来。
 * 输错按 IP 计，15 分钟内错 5 次锁 15 分钟（与以前一致）。
 */
authRoutes.post('/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'local';
  const attempt = await c.env.DB.prepare('SELECT failures,locked_until FROM admin_attempts WHERE ip=?')
    .bind(ip)
    .first<{ failures: number; locked_until: number }>();
  if (attempt && attempt.locked_until > Date.now()) return c.json({ error: '密码输错太多，请15分钟后重试' }, 429);

  const body = await readJson<{ username?: unknown; password?: unknown }>(c);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const fail = async (message: string) => {
    const failures = attempt && attempt.locked_until > Date.now() - LOCK_MS ? attempt.failures + 1 : 1;
    await c.env.DB.prepare(
      'INSERT INTO admin_attempts VALUES(?,?,?) ON CONFLICT(ip) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until',
    )
      .bind(ip, failures, failures >= MAX_FAILS ? Date.now() + LOCK_MS : Date.now())
      .run();
    return c.json({ error: message }, 401);
  };

  if (password === '' || password.length > 128 || username.length > 64) return fail('账号或密码不对');

  if (username === '' || username.toLowerCase() === BOOTSTRAP_USERNAME) {
    const expected = c.env.ADMIN_PASSWORD;
    if (!expected) return c.json({ error: '服务端还没设置 ADMIN_PASSWORD，admin 账号用不了' }, 400);
    if (!timingSafeEqual(password, expected)) return fail(username === '' ? '密码不对' : '账号或密码不对');
    await c.env.DB.prepare('DELETE FROM admin_attempts WHERE ip=?').bind(ip).run();
    await issueAdminSession(c);
    return c.json({ ok: true, role: 'admin', name: BOOTSTRAP_USERNAME });
  }

  const row = await c.env.DB.prepare(
    'SELECT id, role, display_name AS name, password_hash AS passwordHash, disabled FROM staff_users WHERE username = ?',
  )
    .bind(username)
    .first<{ id: number; role: string; name: string; passwordHash: string; disabled: number }>();
  if (!row || !isStaffRole(row.role) || !(await verifyPassword(password, row.passwordHash))) {
    return fail('账号或密码不对');
  }
  if (row.disabled) return fail('这个账号已经停用，找管理员');

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM admin_attempts WHERE ip=?').bind(ip),
    c.env.DB.prepare('UPDATE staff_users SET last_login_at = ? WHERE id = ?').bind(nowIso(), row.id),
  ]);
  await issueAdminSession(c, { id: row.id, role: row.role, name: row.name }, row.passwordHash);
  return c.json({ ok: true, role: row.role, name: row.name });
});

authRoutes.post('/logout', (c) => {
  clearAdminSession(c);
  return c.json({ ok: true });
});

authRoutes.get('/session', async (c) => {
  const staff = await currentStaff(c);
  return c.json(staff ? { loggedIn: true, role: staff.role, name: staff.name, id: staff.id } : { loggedIn: false });
});
