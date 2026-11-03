import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env.ts';
import { sessionSecret } from './session.ts';
import { signPayload, verifyPayload } from './crypto.ts';

/**
 * 仓库人员的登录态：和群主、客户是三把不同的钥匙，谁也开不了别人的门。
 * 签名里绑着这个人当前的密码哈希：群主在后台给他改密码或停用，旧 Cookie 当场作废。
 */
export const WAREHOUSE_COOKIE = 'sc_wh';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface WarehouseUser {
  id: number;
  username: string;
  displayName: string;
  passwordHash: string;
}

export type WarehouseVars = { Bindings: Env; Variables: { warehouseUser: WarehouseUser } };

function secretFor(env: Env, user: { id: number; passwordHash: string }): string {
  return `${sessionSecret(env)}\0warehouse\0${user.id}\0${user.passwordHash}`;
}

export async function issueWarehouseSession(c: Context<{ Bindings: Env }>, user: WarehouseUser): Promise<void> {
  const value = await signPayload(secretFor(c.env, user), { uid: user.id, exp: Date.now() + TTL_MS });
  setCookie(c, WAREHOUSE_COOKIE, value, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(TTL_MS / 1000),
  });
}

export function clearWarehouseSession(c: Context): void {
  deleteCookie(c, WAREHOUSE_COOKIE, { path: '/' });
}

/** Cookie 里只带 uid，先按 uid 把人取出来，再用他的密码哈希验签名。 */
export async function currentWarehouseUser(c: Context<{ Bindings: Env }>): Promise<WarehouseUser | null> {
  const raw = getCookie(c, WAREHOUSE_COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  let uid: unknown;
  try {
    const body = raw.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
    uid = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body + '='.repeat((4 - (body.length % 4)) % 4)), (ch) => ch.charCodeAt(0)))).uid;
  } catch {
    return null;
  }
  if (typeof uid !== 'number') return null;
  const user = await c.env.DB.prepare(
    'SELECT id, username, display_name AS displayName, password_hash AS passwordHash FROM warehouse_users WHERE id = ? AND disabled = 0',
  )
    .bind(uid)
    .first<WarehouseUser>();
  if (!user) return null;
  const payload = await verifyPayload<{ uid?: number }>(secretFor(c.env, user), raw);
  return payload?.uid === user.id ? user : null;
}

export const warehouseGuard: MiddlewareHandler<WarehouseVars> = async (c, next) => {
  const user = await currentWarehouseUser(c as unknown as Context<{ Bindings: Env }>);
  if (!user) return c.json({ error: '请先登录仓库账号' }, 401);
  c.set('warehouseUser', user);
  await next();
};
