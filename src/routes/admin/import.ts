import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { groupByCn, parseSheet, type RawSheet, type ParsedRow } from '../../lib/excel.ts';
import { badRequest, optionalString, readJson, requireString } from '../../lib/http.ts';
import { nextId, nowIso } from '../../lib/db.ts';
import { randomToken } from '../../lib/crypto.ts';

export const importRoutes = new Hono<{ Bindings: Env }>();

interface CustomerRow {
  id: number;
  qq: string;
  nickname: string;
  token: string;
}

interface PreviewBody {
  fileName?: string;
  fileHash?: string;
  sheet?: RawSheet;
  exchangeRate?: number;
}

interface Assignment {
  cn: string;
  customerId?: number;
  newCustomer?: { qq?: string; nickname?: string };
}

interface CommitBody extends PreviewBody {
  batchName?: string;
  orderedAt?: string;
  orderNo?: string;
  japanTrackingNo?: string;
  packageName?: string;
  confirmDuplicate?: boolean;
  assignments?: Assignment[];
}

function requireSheet(body: PreviewBody): RawSheet {
  const sheet = body.sheet;
  if (!sheet || !Array.isArray(sheet.headers) || !Array.isArray(sheet.rows)) {
    throw badRequest('没有收到表格数据');
  }
  return sheet;
}

async function lookupAliases(env: Env, names: string[]): Promise<Map<string, CustomerRow>> {
  const map = new Map<string, CustomerRow>();
  if (names.length === 0) return map;
  // 分片查询，D1 单条语句绑定参数有上限
  for (let i = 0; i < names.length; i += 50) {
    const chunk = names.slice(i, i + 50);
    const rows = await env.DB.prepare(
      `SELECT a.alias, c.id, c.qq, c.nickname, c.token
         FROM customer_aliases a
         JOIN customers c ON c.id = a.customer_id
        WHERE a.alias IN (${chunk.map(() => '?').join(', ')})`,
    )
      .bind(...chunk)
      .all<CustomerRow & { alias: string }>();
    for (const row of rows.results) {
      map.set(row.alias, { id: row.id, qq: row.qq, nickname: row.nickname, token: row.token });
    }
  }
  return map;
}

async function findDuplicate(env: Env, fileHash: string | null) {
  if (!fileHash) return null;
  return env.DB.prepare('SELECT id, name, created_at AS createdAt FROM batches WHERE file_hash = ?')
    .bind(fileHash)
    .first<{ id: number; name: string; createdAt: string }>();
}

importRoutes.post('/preview', async (c) => {
  const body = await readJson<PreviewBody>(c);
  const sheet = requireSheet(body);
  const parsed = parseSheet(sheet, body.exchangeRate);
  if (parsed.missingColumns.length > 0) {
    return c.json(
      {
        missingColumns: parsed.missingColumns,
        error: `表头缺少这些列：${parsed.missingColumns.join('、')}`,
      },
      400,
    );
  }
  const groups = groupByCn(parsed.rows);
  const aliasMap = await lookupAliases(
    c.env,
    groups.map((g) => g.cn),
  );
  const duplicate = await findDuplicate(c.env, optionalString(body.fileHash));

  return c.json({
    missingColumns: [],
    duplicate,
    skipped: parsed.skipped,
    errors: parsed.errors,
    totals: {
      rows: parsed.rows.length,
      amountFen: parsed.rows.reduce((sum, r) => sum + r.goodsFeeFen, 0),
      customers: groups.length,
      unmatched: groups.filter((g) => !aliasMap.has(g.cn)).length,
    },
    groups: groups.map((g) => ({
      ...g,
      customer: aliasMap.get(g.cn) ?? null,
    })),
  });
});

importRoutes.post('/commit', async (c) => {
  const body = await readJson<CommitBody>(c);
  const sheet = requireSheet(body);
  const batchName = requireString(body.batchName, '批次名');
  const parsed = parseSheet(sheet, body.exchangeRate);
  if (parsed.missingColumns.length > 0) {
    throw badRequest(`表头缺少这些列：${parsed.missingColumns.join('、')}`);
  }
  if (parsed.errors.length > 0) {
    throw badRequest('还有问题行没处理，不能导入', { errors: parsed.errors });
  }
  if (parsed.rows.length === 0) throw badRequest('这张表没有可导入的行');

  const fileHash = optionalString(body.fileHash);
  if (!body.confirmDuplicate) {
    const duplicate = await findDuplicate(c.env, fileHash);
    if (duplicate) {
      throw badRequest('这张表可能已经导过', { duplicate });
    }
  }

  const groups = groupByCn(parsed.rows);
  const aliasMap = await lookupAliases(
    c.env,
    groups.map((g) => g.cn),
  );
  const assignments = new Map<string, Assignment>();
  for (const a of body.assignments ?? []) {
    if (typeof a?.cn === 'string') assignments.set(a.cn.trim(), a);
  }

  const now = nowIso();
  const db = c.env.DB;
  const statements: D1PreparedStatement[] = [];

  let nextCustomerId = await nextId(db, 'customers');
  const resolved = new Map<string, number>();
  const newAliases: Array<{ alias: string; customerId: number }> = [];
  const createdCustomers: Array<{ id: number; qq: string; nickname: string; token: string }> = [];

  const pendingQq = new Map<string, number>();
  for (const group of groups) {
    const known = aliasMap.get(group.cn);
    if (known) {
      resolved.set(group.cn, known.id);
      continue;
    }
    const assignment = assignments.get(group.cn);
    if (!assignment) throw badRequest(`「${group.cn}」还没有指定客户`);

    if (assignment.customerId !== undefined && assignment.customerId !== null) {
      const existing = await db
        .prepare('SELECT id FROM customers WHERE id = ?')
        .bind(assignment.customerId)
        .first<{ id: number }>();
      if (!existing) throw badRequest(`客户 #${assignment.customerId} 不存在`);
      resolved.set(group.cn, existing.id);
      newAliases.push({ alias: group.cn, customerId: existing.id });
      continue;
    }

    const qq = requireString(assignment.newCustomer?.qq, `「${group.cn}」的 QQ 号`);
    if (!/^\d{5,15}$/.test(qq)) throw badRequest(`「${group.cn}」的 QQ 号格式不对：${qq}`);
    const nickname = optionalString(assignment.newCustomer?.nickname) ?? group.cn;
    if (pendingQq.has(qq)) {
      const sameId = pendingQq.get(qq)!; resolved.set(group.cn,sameId); newAliases.push({alias:group.cn,customerId:sameId}); continue;
    }
    const byQq = await db
      .prepare('SELECT id FROM customers WHERE qq = ?')
      .bind(qq)
      .first<{ id: number }>();
    if (byQq) {
      resolved.set(group.cn, byQq.id);
      newAliases.push({ alias: group.cn, customerId: byQq.id });
      continue;
    }
    const id = nextCustomerId;
    nextCustomerId += 1;
    const token = randomToken();
    pendingQq.set(qq,id);
    createdCustomers.push({ id, qq, nickname, token });
    statements.push(
      db
        .prepare('INSERT INTO customers (id, qq, nickname, token, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, qq, nickname, token, now),
    );
    resolved.set(group.cn, id);
    newAliases.push({ alias: group.cn, customerId: id });
  }

  for (const alias of newAliases) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO customer_aliases (alias, customer_id) VALUES (?, ?)')
        .bind(alias.alias, alias.customerId),
    );
  }

  const batchId = await nextId(db, 'batches');
  const packageId = await nextId(db, 'packages');
  const packageName = optionalString(body.packageName) ?? batchName;
  const orderedAt = optionalString(body.orderedAt);

  statements.push(
    db
      .prepare(
        'INSERT INTO batches (id, name, ordered_at, source_file, file_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(batchId, batchName, orderedAt, optionalString(body.fileName), fileHash, now),
    db
      .prepare('INSERT INTO packages (id, name, status, created_at) VALUES (?, ?, ?, ?)')
      .bind(packageId, packageName, 'ordered', now),
    db
      .prepare('INSERT INTO package_batches (package_id, batch_id) VALUES (?, ?)')
      .bind(packageId, batchId),
  );

  let itemId = await nextId(db, 'items');
  const insertItem = db.prepare(
    `INSERT INTO items (id, batch_id, customer_id, package_id, row_no, title, image_url, product_url,
                        list_price_jpy, actual_price_jpy, goods_fee_fen, status, goods_paid, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ordered', 0, ?, ?)`,
  );
  const insertLog = db.prepare(
    'INSERT INTO status_logs (item_id, from_status, to_status, at) VALUES (?, NULL, ?, ?)',
  );

  const rowsByCustomer = new Map<number, number>();
  for (const row of parsed.rows as ParsedRow[]) {
    const customerId = resolved.get(row.cn);
    if (customerId === undefined) throw badRequest(`「${row.cn}」还没有指定客户`);
    statements.push(
      insertItem.bind(
        itemId,
        batchId,
        customerId,
        packageId,
        row.rowNo,
        row.title,
        row.imageUrl,
        row.productUrl,
        row.listPriceJpy,
        row.actualPriceJpy,
        row.goodsFeeFen,
        now,
        now,
      ),
      insertLog.bind(itemId, 'ordered', now),
    );
    rowsByCustomer.set(customerId, (rowsByCustomer.get(customerId) ?? 0) + 1);
    itemId += 1;
  }

  statements.push(db.prepare('UPDATE batches SET order_no=?,japan_tracking_no=? WHERE id=?').bind(optionalString(body.orderNo),optionalString(body.japanTrackingNo),batchId));
  await db.batch(statements);

  return c.json({
    batchId,
    packageId,
    itemCount: parsed.rows.length,
    amountFen: parsed.rows.reduce((sum, r) => sum + r.goodsFeeFen, 0),
    customerCount: rowsByCustomer.size,
    createdCustomers,
    skipped: parsed.skipped,
  });
});
