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

/**
 * 客户会话的签名里带上他当前的密码哈希：
 * 客户自己改密码、群主代设密码、群主退回初始密码、重置链接，任何一个发生，
 * 之前发出去的 180 天 Cookie 就验不过了——不用另存一张会话表。
 */
function customerSecret(env: Env, token: string, passwordHash: string | null): string {
  return `${sessionSecret(env)}\0${token}\0${passwordHash ?? 'initial'}`;
}

export async function issueCustomerSession(
  c: Context<{ Bindings: Env }>,
  token: string,
  customerId: number,
  passwordHash: string | null,
): Promise<void> {
  const value = await signPayload(customerSecret(c.env, token, passwordHash), {
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

/** 中间件里带 Variables 的上下文也要能传进来，所以不限死泛型。 */
type EnvLike = { Bindings: Env; Variables?: object };

export function clearCustomerSession<E extends EnvLike>(c: Context<E>, token: string): void {
  deleteCookie(c, customerCookieName(token), { path: '/' });
}

/** 返回这个 token 对应的客户（含密码哈希）；没登录、token 已换过都算无效。 */
export async function customerSession<E extends EnvLike>(
  c: Context<E>,
  token: string,
): Promise<{ id: number; passwordHash: string | null } | null> {
  const row = await c.env.DB.prepare(
    'SELECT id, password_hash AS passwordHash FROM customers WHERE token = ?',
  )
    .bind(token)
    .first<{ id: number; passwordHash: string | null }>();
  if (!row) return null;
  const payload = await verifyPayload<{ customerId?: number; token?: string }>(
    customerSecret(c.env, token, row.passwordHash),
    getCookie(c, customerCookieName(token)),
  );
  if (!payload || payload.token !== token || payload.customerId !== row.id) return null;
  return row;
}
