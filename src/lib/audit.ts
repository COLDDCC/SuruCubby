import type { MiddlewareHandler } from 'hono';
import type { Env } from './env.ts';
import { nowIso } from './db.ts';
import { staffOf } from './staff.ts';

/** 请求体里这些键一律不落库。 */
const SECRET_KEY = /password|secret|token/i;
const MAX_DETAIL = 2000;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '…';
  if (Array.isArray(value)) {
    // 导入表这种几百行的数组只留个数，日志里看个大概就够了
    return value.length > 20 ? `[${value.length} 项]` : value.map((v) => redact(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '***' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}…`;
  return value;
}

/**
 * 操作日志：后台每个成功的写操作记一行「谁、什么时候、调了哪个接口、带了什么」。
 * 放在登录守卫后面（才知道是谁），在互斥锁里面（和这次写入串行）。
 */
export const auditLog: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  let detail: string | null = null;
  try {
    const text = await c.req.raw.clone().text();
    if (text) {
      try {
        detail = JSON.stringify(redact(JSON.parse(text)));
      } catch {
        detail = null;
      }
    }
  } catch {
    detail = null;
  }
  await next();
  if (c.res.status >= 400) return;
  const staff = staffOf(c);
  const path = new URL(c.req.url).pathname;
  try {
    await c.env.DB.prepare(
      'INSERT INTO audit_logs (staff_id, staff_name, role, method, path, status, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(staff.id, staff.name, staff.role, c.req.method, path, c.res.status, detail ? detail.slice(0, MAX_DETAIL) : null, nowIso())
      .run();
  } catch (err) {
    // 日志写不进去不能把已经成功的操作变成失败
    console.error('操作日志写入失败', err);
  }
};
