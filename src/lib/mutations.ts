import type { MiddlewareHandler } from 'hono';
import type { Env } from './env.ts';
import { randomToken } from './crypto.ts';
/** Serialize read/check/write workflows, including requests from multiple admin tabs. */
export const mutationGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: '不允许跨站操作' }, 403);
  if (!c.req.header('Content-Type')?.includes('application/json') && c.req.header('Content-Length') !== '0' && c.req.method !== 'DELETE') {
    // Empty POSTs (logout, undo) are allowed; cross-origin requests still require same origin.
    const body = await c.req.raw.clone().text();
    if (body) return c.json({ error: '请使用 JSON 请求' }, 415);
  }
  const owner = randomToken();
  const acquired = await c.env.DB.prepare(`INSERT INTO mutation_lock(id,owner,expires_at) VALUES(1,?,?)
    ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE mutation_lock.expires_at < ?`)
    .bind(owner, Date.now() + 600000, Date.now()).run();
  if (!acquired.meta.changes) return c.json({ error: '另一个操作正在保存，请稍后重试' }, 409);
  try { await next(); } finally {
    await c.env.DB.prepare('DELETE FROM mutation_lock WHERE id=1 AND owner=?').bind(owner).run();
  }
};
