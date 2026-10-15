import type { Context } from 'hono';

export class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function badRequest(message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(400, message, extra);
}

export function notFound(message = '没找到'): HttpError {
  return new HttpError(404, message);
}

export async function readJson<T>(c: Context): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
  // null / 数组 / 数字都会在下游 body.xxx 上抛 TypeError，变成 500
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('请求体要是一个 JSON 对象');
  }
  return parsed as T;
}

export function requireInt(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw badRequest(`${field} 必须是整数`);
  return n;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${field} 不能为空`);
  return value.trim();
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 入库前卡长度。粘错一整页文字进来不会报错，但会把后台的表格顶成一堵墙，
 * 而且这笔账以后谁也看不清——宁可当场拦一句「太长了」。
 */
export function bound(value: string | null, label: string, max: number): string | null {
  if (value !== null && value.length > max) throw badRequest(`${label}太长了，最多 ${max} 个字（现在 ${value.length} 个）`);
  return value;
}

export function intList(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest(`${field} 不能为空`);
  return value.map((v) => requireInt(v, field));
}

/** 生成 `?,?,?` 占位符 */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}
