import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { timingSafeEqual } from '../../lib/crypto.ts';
import { clearAdminSession, hasAdminSession, issueAdminSession } from '../../lib/session.ts';
import { badRequest, readJson } from '../../lib/http.ts';

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.post('/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'local';
  const attempt = await c.env.DB.prepare('SELECT failures,locked_until FROM admin_attempts WHERE ip=?').bind(ip).first<{failures:number;locked_until:number}>();
  if (attempt && attempt.locked_until > Date.now()) return c.json({error:'密码输错太多，请15分钟后重试'},429);
  const body = await readJson<{ password?: string }>(c);
  const expected = c.env.ADMIN_PASSWORD;
  if (!expected) throw badRequest('服务端还没设置 ADMIN_PASSWORD');
  if (typeof body.password !== 'string' || !timingSafeEqual(body.password, expected)) {
    const failures = attempt && attempt.locked_until > Date.now()-900000 ? attempt.failures+1 : 1;
    await c.env.DB.prepare('INSERT INTO admin_attempts VALUES(?,?,?) ON CONFLICT(ip) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until').bind(ip,failures, failures>=5 ? Date.now()+900000 : Date.now()).run();
    return c.json({ error: '密码不对' }, 401);
  }
  await c.env.DB.prepare('DELETE FROM admin_attempts WHERE ip=?').bind(ip).run();
  await issueAdminSession(c);
  return c.json({ ok: true });
});

authRoutes.post('/logout', (c) => {
  clearAdminSession(c);
  return c.json({ ok: true });
});

authRoutes.get('/session', async (c) => c.json({ loggedIn: await hasAdminSession(c) }));
