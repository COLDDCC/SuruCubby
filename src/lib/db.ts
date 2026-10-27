import type { Env } from './env.ts';

export function nowIso(): string {
  return new Date().toISOString();
}

/** D1 的 batch 是一个事务，但拿不到自增 ID，所以写入前先自己分配主键。 */
export async function nextId(db: D1Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM ${table}`).first<{
    next: number;
  }>();
  return row?.next ?? 1;
}

export async function getSetting(env: Env, key: string, fallback: string): Promise<string> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? fallback;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
    .bind(key, value)
    .run();
}

export async function domesticFeeFen(env: Env): Promise<number> {
  const raw = await getSetting(env, 'domestic_fee_fen', '1000');
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;
}

/** 国际运费单价（分 / kg），默认 100 元 /kg。 */
export async function intlPriceFenPerKg(env: Env): Promise<number> {
  const raw = await getSetting(env, 'intl_price_fen_per_kg', '10000');
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10000;
}

/** 日本直邮单价（分 / kg），默认 120 元 /kg；称重时按这个价算并存档。 */
export async function directPriceFenPerKg(env: Env): Promise<number> {
  const raw = await getSetting(env, 'direct_price_fen_per_kg', '12000');
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12000;
}

/** 直邮运费：⌈重量克 × 单价分 ÷ 1000⌉，整数分，不出现小数。 */
export function directFeeFen(weightG: number, rateFenPerKg: number): number {
  return Math.ceil((weightG * rateFenPerKg) / 1000);
}

/**
 * 这位客户标了「不拼邮」（自己带回国 / 另找转运）：
 * 认领、称重、国际运费分摊、发货申请、国内寄出这条链一步都不该再算他，货款照旧。
 */
export async function isSelfReturn(db: D1Database, customerId: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT self_return AS n FROM customers WHERE id = ?')
    .bind(customerId)
    .first<{ n: number }>();
  return !!row?.n;
}

/** 生成一条状态变更日志的 SQL 语句；byName 是操作人（日本仓、分拣、寄出时填）。 */
export function statusLogStmt(
  db: D1Database,
  itemId: number,
  fromStatus: string | null,
  toStatus: string,
  at: string,
  byName: string | null = null,
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO status_logs (item_id, from_status, to_status, at, by_name) VALUES (?, ?, ?, ?, ?)')
    .bind(itemId, fromStatus, toStatus, at, byName);
}

/** 一次分拣最多开几箱（设置里可改，默认 9）。 */
export async function maxBoxesPerSort(env: Env): Promise<number> {
  const raw = await getSetting(env, 'max_boxes_per_sort', '9');
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : 9;
}
