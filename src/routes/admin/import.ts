import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { FIELD_LABELS, groupByCn, parseSheet, type RawSheet, type ParsedRow } from '../../lib/excel.ts';
import { badRequest, bound, optionalString, readJson, requireString } from '../../lib/http.ts';
import { nextId, nowIso } from '../../lib/db.ts';
import { randomToken } from '../../lib/crypto.ts';
import type { FieldKey } from '../../lib/excel.ts';
import { buildNameIndex, matchName, normalizeName, type NameIndex, type NameMatch } from '../../lib/nameMatch.ts';

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
  /** 管理员在预览里指认的「Excel 列 → 用途」，key 用中文用途名或英文字段名都认 */
  columns?: Record<string, unknown>;
}

function columnOverrides(body: PreviewBody): Record<string, FieldKey | null> | undefined {
  const raw = body.columns;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, FieldKey | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\d+$/.test(key)) continue;
    if (value === null) out[key] = null;
    else if (typeof value === 'string' && value !== '') out[key] = value as FieldKey;
  }
  return Object.keys(out).length ? out : undefined;
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

async function findDuplicate(env: Env, fileHash: string | null) {
  if (!fileHash) return null;
  return env.DB.prepare('SELECT id, name, created_at AS createdAt FROM batches WHERE file_hash = ?')
    .bind(fileHash)
    .first<{ id: number; name: string; createdAt: string }>();
}

/** 管理员手动指认过的算最高优先级，没指认的才让程序自己认。 */
function resolveGroups(index: NameIndex, groups: Array<{ cn: string }>, assignments: Map<string, Assignment>) {
  return groups.map((group) => {
    const assignment = assignments.get(group.cn);
    if (assignment && (assignment.customerId !== undefined || assignment.newCustomer)) {
      return { group, assignment, match: null as NameMatch | null };
    }
    return { group, assignment: null, match: matchName(index, group.cn) };
  });
}

importRoutes.post('/preview', async (c) => {
  const body = await readJson<PreviewBody>(c);
  const sheet = requireSheet(body);
  const parsed = parseSheet(sheet, { columns: columnOverrides(body) });
  if (parsed.missingColumns.length > 0) {
    return c.json(
      {
        missingColumns: parsed.missingColumns,
        fields: FIELD_LABELS,
        columns: parsed.columns,
        error: `表头缺少这些列：${parsed.missingColumns.join('、')}`,
      },
      400,
    );
  }
  const groups = groupByCn(parsed.rows);
  const index = await buildNameIndex(c.env.DB);
  const matched = groups.map((g) => ({
    group: g,
    match: matchName(index, g.cn),
  }));
  const duplicate = await findDuplicate(c.env, optionalString(body.fileHash));

  return c.json({
    missingColumns: [],
    fields: FIELD_LABELS,
    columns: parsed.columns,
    duplicate,
    skipped: parsed.skipped,
    errors: parsed.errors,
    totals: {
      rows: parsed.rows.length,
      amountJpy: parsed.rows.reduce((sum, r) => sum + r.goodsFeeJpy, 0),
      customers: groups.length,
      unmatched: matched.filter((m) => !m.match.customer).length,
    },
    groups: matched.map(({ group, match }) => ({
      ...group,
      customer: match.customer,
      matchedBy: match.by,
      candidates: match.candidates,
    })),
  });
});

importRoutes.post('/commit', async (c) => {
  const body = await readJson<CommitBody>(c);
  const sheet = requireSheet(body);
  // 和后台改名/改单号同一套上限：导入这条路以前不卡，粘一整页进来能直接入库
  const batchName = bound(requireString(body.batchName, '批次名'), '批次名', 60) as string;
  const orderNo = bound(optionalString(body.orderNo), '日本订单号', 60);
  const japanTrackingNo = bound(optionalString(body.japanTrackingNo), '日本物流单号', 60);
  const packageNameInput = bound(optionalString(body.packageName), '包裹名', 60);
  const orderedAtInput = bound(optionalString(body.orderedAt), '下单日期', 30);
  const fileName = bound(optionalString(body.fileName), '文件名', 200);
  const parsed = parseSheet(sheet, { columns: columnOverrides(body) });
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
  const index = await buildNameIndex(c.env.DB);
  const assignments = new Map<string, Assignment>();
  for (const a of body.assignments ?? []) {
    if (typeof a?.cn === 'string') assignments.set(a.cn.trim(), a);
  }

  const now = nowIso();
  const db = c.env.DB;
  const statements: D1PreparedStatement[] = [];

  let nextCustomerId = await nextId(db, 'customers');
  const resolved = new Map<string, number>();
  const newAliases: Array<{ alias: string; customerId: number; force?: boolean }> = [];
  const createdCustomers: Array<{
    id: number;
    qq: string;
    nickname: string;
    token: string;
  }> = [];

  const pendingQq = new Map<string, number>();
  // 这一批里刚建的人也算「认得」，免得同一个人写两种名字就被建成两个客户、欠款分两处
  const pendingName = new Map<string, number>();
  const knownName = (name: string) => {
    const key = normalizeName(name);
    const byKey = key ? pendingName.get(key) : undefined;
    if (byKey !== undefined) return byKey;
    const hit = matchName(index, name);
    return hit.customer?.id;
  };

  for (const { group, assignment, match } of resolveGroups(index, groups, assignments)) {
    if (match?.customer) {
      resolved.set(group.cn, match.customer.id);
      // 「阿狸 」这种写法这次认出来了，就把它记成别名，下次不用靠运气
      if (match.by === 'normalized' && !index.exact.has(group.cn)) {
        newAliases.push({ alias: group.cn, customerId: match.customer.id });
      }
      continue;
    }
    if (!assignment) {
      throw badRequest(
        match?.by === 'ambiguous'
          ? `「${group.cn}」有好几个客户都对得上（${match.candidates.map((x) => `${x.nickname} QQ ${x.qq}`).join('、')}），请指定是哪一位`
          : `「${group.cn}」还没有指定客户`,
      );
    }

    if (assignment.customerId !== undefined && assignment.customerId !== null) {
      const existing = await db
        .prepare('SELECT id FROM customers WHERE id = ?')
        .bind(assignment.customerId)
        .first<{ id: number }>();
      if (!existing) throw badRequest(`客户 #${assignment.customerId} 不存在`);
      resolved.set(group.cn, existing.id);
      // 管理员亲自指认的，名字要能改绑：之前自动认错了人，这次得纠正过来
      newAliases.push({ alias: group.cn, customerId: existing.id, force: true });
      continue;
    }

    const qq = requireString(assignment.newCustomer?.qq, `「${group.cn}」的 QQ 号`);
    if (!/^\d{5,15}$/.test(qq)) throw badRequest(`「${group.cn}」的 QQ 号格式不对：${qq}`);
    const nickname = optionalString(assignment.newCustomer?.nickname) ?? group.cn;
    if (pendingQq.has(qq)) {
      const sameId = pendingQq.get(qq)!;
      resolved.set(group.cn, sameId);
      newAliases.push({ alias: group.cn, customerId: sameId, force: true });
      continue;
    }
    const byQq = await db.prepare('SELECT id FROM customers WHERE qq = ?').bind(qq).first<{ id: number }>();
    if (byQq) {
      resolved.set(group.cn, byQq.id);
      newAliases.push({ alias: group.cn, customerId: byQq.id, force: true });
      continue;
    }
    // 名字已经认得某人、QQ 却是新的：多半是手滑，绑错了以后他自己看不见自己的货
    const sameNameId = knownName(nickname) ?? knownName(group.cn);
    if (sameNameId !== undefined) {
      const clash = await db
        .prepare('SELECT qq, nickname FROM customers WHERE id = ?')
        .bind(sameNameId)
        .first<{ qq: string; nickname: string }>();
      throw badRequest(
        `「${nickname}」已经是客户 ${clash?.nickname}（QQ ${clash?.qq}）的名字了，你填的 QQ ${qq} 会新建另一个人。是同一个人就选那位已有客户，不是的话给他换个叫法`,
      );
    }
    const id = nextCustomerId;
    nextCustomerId += 1;
    const token = randomToken();
    pendingQq.set(qq, id);
    pendingName.set(normalizeName(nickname), id);
    createdCustomers.push({ id, qq, nickname, token });
    statements.push(
      db
        .prepare('INSERT INTO customers (id, qq, nickname, token, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, qq, nickname, token, now),
    );
    resolved.set(group.cn, id);
    newAliases.push({ alias: group.cn, customerId: id });
    // 昵称也得是能对上的名字，否则改天表里写昵称就又不认得了
    if (nickname !== group.cn) newAliases.push({ alias: nickname, customerId: id });
  }

  for (const alias of newAliases) {
    statements.push(
      db
        .prepare(
          alias.force
            ? 'INSERT INTO customer_aliases (alias, customer_id) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET customer_id = excluded.customer_id'
            : 'INSERT OR IGNORE INTO customer_aliases (alias, customer_id) VALUES (?, ?)',
        )
        .bind(alias.alias, alias.customerId),
    );
  }

  const batchId = await nextId(db, 'batches');
  const packageId = await nextId(db, 'packages');
  const packageName = packageNameInput ?? batchName;
  const orderedAt = orderedAtInput;

  statements.push(
    db
      .prepare(
        'INSERT INTO batches (id, name, ordered_at, source_file, file_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(batchId, batchName, orderedAt, fileName, fileHash, now),
    db
      .prepare('INSERT INTO packages (id, name, status, created_at) VALUES (?, ?, ?, ?)')
      .bind(packageId, packageName, 'ordered', now),
    db.prepare('INSERT INTO package_batches (package_id, batch_id) VALUES (?, ?)').bind(packageId, batchId),
  );

  let itemId = await nextId(db, 'items');
  const insertItem = db.prepare(
    `INSERT INTO items (id, batch_id, customer_id, package_id, row_no, title, image_url, product_url,
                        list_price_jpy, actual_price_jpy, goods_fee_jpy, status, goods_paid, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ordered', 0, ?, ?)`,
  );
  const insertLog = db.prepare('INSERT INTO status_logs (item_id, from_status, to_status, at) VALUES (?, NULL, ?, ?)');

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
        row.goodsFeeJpy,
        now,
        now,
      ),
      insertLog.bind(itemId, 'ordered', now),
    );
    rowsByCustomer.set(customerId, (rowsByCustomer.get(customerId) ?? 0) + 1);
    itemId += 1;
  }

  statements.push(
    db
      .prepare('UPDATE batches SET order_no=?,japan_tracking_no=? WHERE id=?')
      .bind(orderNo, japanTrackingNo, batchId),
  );
  await db.batch(statements);

  return c.json({
    batchId,
    packageId,
    itemCount: parsed.rows.length,
    amountJpy: parsed.rows.reduce((sum, r) => sum + r.goodsFeeJpy, 0),
    customerCount: rowsByCustomer.size,
    createdCustomers,
    skipped: parsed.skipped,
  });
});
