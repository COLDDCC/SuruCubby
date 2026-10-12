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
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
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

export function intList(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest(`${field} 不能为空`);
  return value.map((v) => requireInt(v, field));
}

/** 生成 `?,?,?` 占位符 */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}
