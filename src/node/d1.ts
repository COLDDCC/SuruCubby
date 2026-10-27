/**
 * 用 Node 自带的 SQLite（node:sqlite）实现业务代码用到的那部分 D1 接口。
 *
 * 业务代码一行不改：prepare / bind / first / all / run / batch 的行为和 D1 对齐——
 *   - batch 是一个事务，中间任何一句失败整批回滚；
 *   - 外键约束默认打开（D1 也是）；
 *   - bind 不接受 undefined（D1 会报错，这里也报错，免得悄悄写进 NULL）；布尔值写成 1/0。
 * node:sqlite 是同步 API，单进程里天然串行，事务不会被别的请求插进来。
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

type Bindable = null | number | bigint | string | Uint8Array;

function normalize(value: unknown, index: number): Bindable {
  if (value === undefined) {
    throw new Error(`D1_TYPE_ERROR: 第 ${index + 1} 个参数是 undefined`);
  }
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(`D1_TYPE_ERROR: 第 ${index + 1} 个参数类型不支持（${typeof value}）`);
}

/** node:sqlite 返回的行是无原型对象，转成普通对象，序列化和比较都省心。 */
function plain<T>(row: unknown): T {
  return row ? ({ ...(row as object) } as T) : (row as T);
}

class Statement implements D1PreparedStatement {
  readonly #db: SqliteD1;
  readonly sql: string;
  readonly params: Bindable[];

  constructor(db: SqliteD1, sql: string, params: Bindable[] = []) {
    this.#db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new Statement(this.#db, this.sql, values.map(normalize));
  }

  /** 同步执行，batch 在事务里直接调用。 */
  execute<T>(): D1Result<T> {
    const stmt = this.#db.statement(this.sql);
    if (stmt.columns().length > 0) {
      const rows = stmt.all(...this.params).map((r) => plain<T>(r));
      return { results: rows, success: true, meta: { changes: 0, last_row_id: 0 } };
    }
    const info = stmt.run(...this.params);
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }

  async first<T>(column?: string): Promise<T | null> {
    const stmt = this.#db.statement(this.sql);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (column !== undefined) {
      if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: ${column}`);
      return (row[column] ?? null) as T;
    }
    return plain<T>(row);
  }

  async all<T>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  async run<T>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }
}

export class SqliteD1 implements D1Database {
  readonly raw: DatabaseSync;
  readonly #cache = new Map<string, StatementSync>();

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
  }

  statement(sql: string): StatementSync {
    let stmt = this.#cache.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      if (this.#cache.size > 500) this.#cache.clear();
      this.#cache.set(sql, stmt);
    }
    return stmt;
  }

  prepare(query: string): D1PreparedStatement {
    return new Statement(this, query);
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const list = statements as Statement[];
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const results = list.map((s) => s.execute<T>());
      this.raw.exec('COMMIT');
      return results;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.#cache.clear();
    this.raw.close();
  }
}

/**
 * 按文件名顺序打迁移，已打过的记在 d1_migrations（和 wrangler 用的是同一张表、同样的列），
 * 以后要从 D1 导出数据搬过来也对得上。
 */
export function applyMigrations(db: SqliteD1, dir: string): string[] {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const done = new Set(
    (db.raw.prepare('SELECT name FROM d1_migrations').all() as Array<{ name: string }>).map((r) => r.name),
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.raw.exec('BEGIN');
    try {
      db.raw.exec(sql);
      db.raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
      db.raw.exec('COMMIT');
    } catch (err) {
      db.raw.exec('ROLLBACK');
      throw new Error(`迁移 ${file} 失败：${(err as Error).message}`);
    }
    applied.push(file);
  }
  return applied;
}
