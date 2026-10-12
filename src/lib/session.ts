import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env.ts';
import { signPayload, verifyPayload } from './crypto.ts';

export const ADMIN_COOKIE = 'sc_admin';
const ADMIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CUSTOMER_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export function sessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('缺少 SESSION_SECRET，请用 wrangler secret put SESSION_SECRET 设置');
  return secret;
}

function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

export async function issueAdminSession(c: Context<{ Bindings: Env }>): Promise<void> {
  const value = await signPayload(sessionSecret(c.env)+'\0'+c.env.ADMIN_PASSWORD, {
    role: 'admin',
    exp: Date.now() + ADMIN_TTL_MS,
  });
  setCookie(c, ADMIN_COOKIE, value, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(ADMIN_TTL_MS / 1000),
  });
}

export function clearAdminSession(c: Context<{ Bindings: Env }>): void {
  deleteCookie(c, ADMIN_COOKIE, { path: '/' });
}

export async function hasAdminSession(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const payload = await verifyPayload<{ role?: string }>(
    sessionSecret(c.env)+'\0'+c.env.ADMIN_PASSWORD,
    getCookie(c, ADMIN_COOKIE),
  );
  return payload?.role === 'admin';
}

export const adminGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!(await hasAdminSession(c))) return c.json({ error: '请先登录' }, 401);
  await next();
};

export function customerCookieName(token: string): string {
  return `sc_w_${token}`;
}

export async function issueCustomerSession(
  c: Context<{ Bindings: Env }>,
  token: string,
  customerId: number,
): Promise<void> {
  const value = await signPayload(sessionSecret(c.env), {
    customerId,
    token,
    exp: Date.now() + CUSTOMER_TTL_MS,
  });
  setCookie(c, customerCookieName(token), value, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(CUSTOMER_TTL_MS / 1000),
  });
}

export function clearCustomerSession(c: Context<{ Bindings: Env }>, token: string): void {
  deleteCookie(c, customerCookieName(token), { path: '/' });
}

/** 返回已验证过的客户 ID，未验证返回 null。 */
export async function customerSession(
  c: Context<{ Bindings: Env }>,
  token: string,
): Promise<number | null> {
  const payload = await verifyPayload<{ customerId?: number; token?: string }>(
    sessionSecret(c.env),
    getCookie(c, customerCookieName(token)),
  );
  if (!payload || payload.token !== token || typeof payload.customerId !== 'number') return null;
  return payload.customerId;
}
