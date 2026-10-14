import { Hono } from 'hono';
import type { Env } from '../lib/env.ts';
import { badRequest, readJson } from '../lib/http.ts';
import { nowIso } from '../lib/db.ts';
import { buildCustomerView } from '../lib/customerView.ts';
import {
  clearCustomerSession,
  customerSession,
  issueCustomerSession,
} from '../lib/session.ts';
import { hashPassword, passwordProblem, usingInitialPassword, verifyPassword } from '../lib/password.ts';

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

customerRoutes.post('/login', async (c) => {
  const body = await readJson<{ qq?: string; password?: string }>(c);
  const qq = typeof body.qq === 'string' ? body.qq.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (qq === '') throw badRequest('请输入 QQ 号');
  if (password === '') throw badRequest('请输入密码');
  if (qq.length > 32 || password.length > 64) throw badRequest('账号或密码太长了');

  // 锁定按 QQ 计，换成统一入口也照样防得住挨个试密码
  const key = `qq:${qq}`;
  const lockedUntil = await checkLock(c.env, key);
  if (lockedUntil) {
    return c.json(
      { error: '输错太多次了，请过 15 分钟再试', lockedUntil: new Date(lockedUntil).toISOString() },
      429,
    );
  }

  const customer = await c.env.DB.prepare(
    'SELECT id, qq, token, password_hash AS passwordHash FROM customers WHERE qq = ?',
  )
    .bind(qq)
    .first<{ id: number; qq: string; token: string; passwordHash: string | null }>();

  if (!customer || !(await verifyPassword(password, customer.passwordHash ?? null))) {
    const result = await recordFailure(c.env, key);
    return c.json(
      {
        error: result.locked
          ? '输错太多次了，请过 15 分钟再试'
          : 'QQ 号或密码不对',
        left: result.left,
        locked: result.locked,
      },
      result.locked ? 429 : 401,
    );
  }

  await clearFailures(c.env, key);
  await issueCustomerSession(c, customer.token, customer.id);
  const view = await buildCustomerView(c.env, customer.id);
  return c.json({
    verified: true,
    token: customer.token,
    mustChange: usingInitialPassword(customer.passwordHash ?? null),
    ...view,
    serverTime: nowIso(),
  });
});

/** 登录后设自己的密码；换完就不再是「还在用初始密码」。 */
customerRoutes.post('/:token/password', async (c) => {
  const token = c.req.param('token');
  const customerId = await customerSession(c, token);
  if (customerId === null) return c.json({ error: '请先登录' }, 401);
  const body = await readJson<{ newPassword?: string }>(c);
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  const problem = passwordProblem(newPassword);
  if (problem) throw badRequest(problem);

  const result = await c.env.DB.prepare('UPDATE customers SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(newPassword), customerId)
    .run();
  if (!result.meta.changes) throw badRequest('客户不存在');
  return c.json({ ok: true });
});

customerRoutes.get('/:token', async (c) => {
  const token = c.req.param('token');
  const customerId = await customerSession(c, token);
  if (customerId === null) return c.json({ verified: false }, 401);

  // token 被重置后旧 Cookie 立即失效
  const customer = await c.env.DB.prepare(
    'SELECT id, password_hash AS passwordHash FROM customers WHERE id = ? AND token = ?',
  )
    .bind(customerId, token)
    .first<{ id: number; passwordHash: string | null }>();
  if (!customer) {
    clearCustomerSession(c, token);
    return c.json({ verified: false }, 401);
  }

  const view = await buildCustomerView(c.env, customerId);
  if (!view) return c.json({ verified: false }, 401);
  return c.json({
    verified: true,
    mustChange: usingInitialPassword(customer.passwordHash ?? null),
    ...view,
    serverTime: nowIso(),
  });
});

customerRoutes.post('/:token/logout', (c) => {
  clearCustomerSession(c, c.req.param('token'));
  return c.json({ ok: true });
});
