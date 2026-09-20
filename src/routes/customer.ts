import { Hono } from 'hono';
import type { Env } from '../lib/env.ts';
import { badRequest, readJson } from '../lib/http.ts';
import { nowIso } from '../lib/db.ts';
import { buildCustomerView } from '../lib/customerView.ts';
import { clearCustomerSession, customerSession, issueCustomerSession } from '../lib/session.ts';

export const customerRoutes = new Hono<{ Bindings: Env }>();

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

interface AttemptRow {
  token: string;
  fail_count: number;
  window_start: string;
  locked_until: string | null;
}

async function checkLock(env: Env, token: string): Promise<number | null> {
  const row = await env.DB.prepare('SELECT * FROM token_attempts WHERE token = ?')
    .bind(token)
    .first<AttemptRow>();
  if (!row?.locked_until) return null;
  const until = Date.parse(row.locked_until);
  if (Number.isFinite(until) && until > Date.now()) return until;
  return null;
}

async function recordFailure(env: Env, token: string): Promise<{ locked: boolean; left: number }> {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT * FROM token_attempts WHERE token = ?')
    .bind(token)
    .first<AttemptRow>();

  let failCount = 1;
  let windowStart = new Date(now).toISOString();
  if (row) {
    const started = Date.parse(row.window_start);
    if (Number.isFinite(started) && now - started < WINDOW_MS) {
      failCount = row.fail_count + 1;
      windowStart = row.window_start;
    }
  }
  const locked = failCount >= MAX_FAILS;
  const lockedUntil = locked ? new Date(now + LOCK_MS).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO token_attempts (token, fail_count, window_start, locked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET fail_count = excluded.fail_count,
                                      window_start = excluded.window_start,
                                      locked_until = excluded.locked_until`,
  )
    .bind(token, locked ? 0 : failCount, locked ? new Date(now).toISOString() : windowStart, lockedUntil)
    .run();
  return { locked, left: Math.max(0, MAX_FAILS - failCount) };
}

async function clearFailures(env: Env, token: string): Promise<void> {
  await env.DB.prepare('DELETE FROM token_attempts WHERE token = ?').bind(token).run();
}

customerRoutes.post('/:token/verify', async (c) => {
  const token = c.req.param('token');
  if (token.length > 64) throw badRequest('链接不对');
  const body = await readJson<{ qq?: string }>(c);
  const qq = typeof body.qq === 'string' ? body.qq.trim() : '';
  if (qq === '') throw badRequest('请输入 QQ 号');

  const lockedUntil = await checkLock(c.env, token);
  if (lockedUntil) {
    return c.json(
      { error: '输错太多次了，请过 15 分钟再试', lockedUntil: new Date(lockedUntil).toISOString() },
      429,
    );
  }

  const customer = await c.env.DB.prepare('SELECT id, qq FROM customers WHERE token = ?')
    .bind(token)
    .first<{ id: number; qq: string }>();

  if (!customer || customer.qq !== qq) {
    const result = await recordFailure(c.env, token);
    return c.json(
      {
        error: result.locked ? '输错太多次了，请过 15 分钟再试' : 'QQ 号对不上',
        left: result.left,
        locked: result.locked,
      },
      result.locked ? 429 : 401,
    );
  }

  await clearFailures(c.env, token);
  await issueCustomerSession(c, token, customer.id);
  const view = await buildCustomerView(c.env, customer.id);
  return c.json({ verified: true, ...view, serverTime: nowIso() });
});

customerRoutes.get('/:token', async (c) => {
  const token = c.req.param('token');
  const customerId = await customerSession(c, token);
  if (customerId === null) return c.json({ verified: false }, 401);

  // token 被重置后旧 Cookie 立即失效
  const customer = await c.env.DB.prepare('SELECT id FROM customers WHERE id = ? AND token = ?')
    .bind(customerId, token)
    .first<{ id: number }>();
  if (!customer) {
    clearCustomerSession(c, token);
    return c.json({ verified: false }, 401);
  }

  const view = await buildCustomerView(c.env, customerId);
  if (!view) return c.json({ verified: false }, 401);
  return c.json({ verified: true, ...view, serverTime: nowIso() });
});

customerRoutes.post('/:token/logout', (c) => {
  clearCustomerSession(c, c.req.param('token'));
  return c.json({ ok: true });
});
