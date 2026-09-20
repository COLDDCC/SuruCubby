import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { timingSafeEqual } from '../../lib/crypto.ts';
import { clearAdminSession, hasAdminSession, issueAdminSession } from '../../lib/session.ts';
import { badRequest, readJson } from '../../lib/http.ts';

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.post('/login', async (c) => {
  const body = await readJson<{ password?: string }>(c);
  const expected = c.env.ADMIN_PASSWORD;
  if (!expected) throw badRequest('服务端还没设置 ADMIN_PASSWORD');
  if (typeof body.password !== 'string' || !timingSafeEqual(body.password, expected)) {
    return c.json({ error: '密码不对' }, 401);
  }
  await issueAdminSession(c);
  return c.json({ ok: true });
});

authRoutes.post('/logout', (c) => {
  clearAdminSession(c);
  return c.json({ ok: true });
});

authRoutes.get('/session', async (c) => c.json({ loggedIn: await hasAdminSession(c) }));
