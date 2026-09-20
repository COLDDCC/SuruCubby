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

/** 生成一条状态变更日志的 SQL 语句。 */
export function statusLogStmt(
  db: D1Database,
  itemId: number,
  fromStatus: string | null,
  toStatus: string,
  at: string,
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO status_logs (item_id, from_status, to_status, at) VALUES (?, ?, ?, ?)')
    .bind(itemId, fromStatus, toStatus, at);
}
