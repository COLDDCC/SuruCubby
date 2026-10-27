import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env.ts';
import { signPayload, verifyPayload } from './crypto.ts';
import { BOOTSTRAP_USERNAME, isStaffRole, type Staff } from './staff.ts';

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

/**
 * 员工登录态的签名密钥：
 *   - 引导管理员（ADMIN_PASSWORD）绑着环境变量里的密码，改了环境变量旧登录全部作废；
 *   - 员工账号绑着他自己的密码哈希，改密码、被停用（守卫里查库）当场踢下线。
 */
function staffSecret(env: Env, id: number, passwordHash: string): string {
  return id === 0
    ? `${sessionSecret(env)}\0${env.ADMIN_PASSWORD ?? ''}`
    : `${sessionSecret(env)}\0staff\0${id}\0${passwordHash}`;
}

export async function issueAdminSession(
  c: Context<{ Bindings: Env }>,
  staff: Staff = { id: 0, role: 'admin', name: BOOTSTRAP_USERNAME },
  passwordHash = '',
): Promise<void> {
  const value = await signPayload(staffSecret(c.env, staff.id, passwordHash), {
    role: staff.role,
    sid: staff.id,
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

/** 不验签先看一眼 payload 里是哪个员工，好去查他的密钥；真伪由后面的 verifyPayload 决定。 */
function peekStaffId(value: string | undefined): number | null {
  if (!value) return null;
  const body = value.slice(0, Math.max(0, value.lastIndexOf('.')));
  try {
    const json = atob(body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (body.length % 4)) % 4));
    const sid = (JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (ch) => ch.charCodeAt(0)))) as { sid?: unknown }).sid;
    // 旧版 Cookie 没有 sid，就是引导管理员
    return sid === undefined ? 0 : typeof sid === 'number' && Number.isSafeInteger(sid) && sid >= 0 ? sid : null;
  } catch {
    return null;
  }
}

/** 当前登录的员工；没登录、签名不对、账号被停用都返回 null。 */
export async function currentStaff(c: Context<{ Bindings: Env }>): Promise<Staff | null> {
  const value = getCookie(c, ADMIN_COOKIE);
  const sid = peekStaffId(value);
  if (sid === null) return null;
  if (sid === 0) {
    if (!c.env.ADMIN_PASSWORD) return null;
    const payload = await verifyPayload<{ role?: string }>(staffSecret(c.env, 0, ''), value);
    return payload?.role === 'admin' ? { id: 0, role: 'admin', name: BOOTSTRAP_USERNAME } : null;
  }
  const row = await c.env.DB.prepare(
    'SELECT id, role, display_name AS name, password_hash AS passwordHash, disabled FROM staff_users WHERE id = ?',
  )
    .bind(sid)
    .first<{ id: number; role: string; name: string; passwordHash: string; disabled: number }>();
  if (!row || row.disabled || !isStaffRole(row.role)) return null;
  const payload = await verifyPayload<{ sid?: number }>(staffSecret(c.env, row.id, row.passwordHash), value);
  if (!payload || payload.sid !== row.id) return null;
  return { id: row.id, role: row.role, name: row.name };
}

export async function hasAdminSession(c: Context<{ Bindings: Env }>): Promise<boolean> {
  return (await currentStaff(c))?.role === 'admin';
}

/** 管理员接口：只有管理员能进。日本仓账号访问一律 403。 */
export const adminGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const staff = await currentStaff(c);
  if (!staff) return c.json({ error: '请先登录' }, 401);
  if (staff.role !== 'admin') return c.json({ error: '这个账号没有权限做这件事' }, 403);
  (c as unknown as { set(k: string, v: unknown): void }).set('staff', staff);
  await next();
};

/** 员工接口（日本仓那几页）：管理员和日本仓都能进。 */
export const staffGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const staff = await currentStaff(c);
  if (!staff) return c.json({ error: '请先登录' }, 401);
  (c as unknown as { set(k: string, v: unknown): void }).set('staff', staff);
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
