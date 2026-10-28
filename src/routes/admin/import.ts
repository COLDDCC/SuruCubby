import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { FIELD_LABELS, groupByCn, parseSheet, type RawSheet, type ParsedRow, parseDateCell } from '../../lib/excel.ts';
import { badRequest, bound, optionalString, readJson, requireString } from '../../lib/http.ts';
import { nextId, nowIso } from '../../lib/db.ts';
import { parseTrackingList, registerStmts } from '../../lib/jpShipments.ts';
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
  orderNo?: string;
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

/** 同一个日本订单号已经录过：骏河屋改了单重新导出的表，文件指纹对不上，靠订单号认出来。 */
async function findSameOrder(env: Env, orderNo: string | null) {
  if (!orderNo) return null;
  return env.DB.prepare('SELECT id, name, created_at AS createdAt FROM batches WHERE order_no = ? ORDER BY id DESC')
    .bind(orderNo)
    .first<{ id: number; name: string; createdAt: string }>();
}

/**
 * 这张表里有多少件已经在库里了（同一个人、同名、同链接）：表格改过一个字再导一次，
 * 文件指纹就变了，靠这个提醒「是不是重复导了」。同一个人买两件一样的是正常的，
 * 所以按件数抵扣——库里已有 2 件，表里同样的前 2 件才算重复。只提醒，不拦。
 */
async function findOverlaps(db: D1Database, rows: Array<{ customerId: number; row: ParsedRow }>) {
  if (!rows.length) return [];
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const existing: Array<{ customerId: number; title: string; productUrl: string | null; batchId: number; batchName: string }> = [];
  for (let i = 0; i < customerIds.length; i += 50) {
    const ids = customerIds.slice(i, i + 50);
    const found = await db
      .prepare(
        `SELECT i.customer_id AS customerId, i.title, i.product_url AS productUrl, i.batch_id AS batchId, b.name AS batchName
           FROM items i JOIN batches b ON b.id = i.batch_id
          WHERE i.customer_id IN (${ids.map(() => '?').join(', ')}) AND i.status NOT IN ('cancelled', 'refunded')`,
      )
      .bind(...ids)
      .all<{ customerId: number; title: string; productUrl: string | null; batchId: number; batchName: string }>();
    existing.push(...found.results);
  }
  const key = (customerId: number, title: string, url: string | null) => `${customerId}\u0000${title}\u0000${url ?? ''}`;
  const pool = new Map<string, Array<{ batchId: number; batchName: string }>>();
  for (const e of existing) {
    const k = key(e.customerId, e.title, e.productUrl);
    pool.set(k, [...(pool.get(k) ?? []), { batchId: e.batchId, batchName: e.batchName }]);
  }
  const byBatch = new Map<number, { batchId: number; name: string; count: number }>();
  for (const { customerId, row } of rows) {
    const list = pool.get(key(customerId, row.title, row.productUrl));
    const hit = list?.shift();
    if (!hit) continue;
    const entry = byBatch.get(hit.batchId) ?? { batchId: hit.batchId, name: hit.batchName, count: 0 };
    entry.count += 1;
    byBatch.set(hit.batchId, entry);
  }
  return [...byBatch.values()].sort((a, b) => b.count - a.count);
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
        headerRow: parsed.headerRow,
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
  const sameOrder = await findSameOrder(c.env, optionalString(body.orderNo));
  const overlaps = await findOverlaps(
    c.env.DB,
    matched.flatMap(({ group, match }) =>
      match.customer ? parsed.rows.filter((r) => r.cn === group.cn).map((r) => ({ customerId: match.customer!.id, row: r })) : [],
    ),
  );

  return c.json({
    missingColumns: [],
    fields: FIELD_LABELS,
    columns: parsed.columns,
    headerRow: parsed.headerRow,
    duplicate,
    sameOrder,
    overlaps,
    skipped: parsed.skipped,
    errors: parsed.errors,
    totals: {
      rows: parsed.rows.length,
      amountJpy: parsed.rows.reduce((sum, r) => sum + r.goodsFeeJpy, 0),
      customers: groups.length,
      unmatched: matched.filter((m) => !m.match.customer).length,
      direct: parsed.rows.filter((r) => r.route === 'direct').length,
      // 表里写了日本运单号的：这一单分几个快递箱、每箱几件
      jpTrackingNos: [...new Set(parsed.rows.map((r) => r.jpTrackingNo).filter((t): t is string => !!t))].map((t) => ({
        trackingNo: t,
        count: parsed.rows.filter((r) => r.jpTrackingNo === t).length,
      })),
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
  // 一单分几个快递到时可以一次填几个（逗号、顿号、换行隔开），每个单号都登记成一个待到的快递
  const japanTrackingNos = parseTrackingList(bound(optionalString(body.japanTrackingNo), '日本物流单号', 200));
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
    const sameOrder = await findSameOrder(c.env, orderNo);
    if (sameOrder) {
      throw badRequest(`日本订单号 ${orderNo} 已经录过（「${sameOrder.name}」），确认要再录一次吗`, { duplicate: sameOrder });
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
  // 下单日期：导入页填的为准（默认当天，东京时间）；表里有「下单时间」列的件另记在件上
  const orderedAt = parseDateCell(orderedAtInput) ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

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
                        list_price_jpy, actual_price_jpy, goods_fee_jpy, status, goods_paid, created_at, updated_at,
                        route, import_address, cn_label, jp_tracking_no, ordered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ordered', 0, ?, ?, ?, ?, ?, ?, ?)`,
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
        // 直邮的件不进回国箱：日本仓直接按客户打包寄出
        row.route === 'direct' ? null : packageId,
        row.rowNo,
        row.title,
        row.imageUrl,
        row.productUrl,
        row.listPriceJpy,
        row.actualPriceJpy,
        row.goodsFeeJpy,
        now,
        now,
        row.route,
        row.directAddress,
        row.cn,
        row.jpTrackingNo,
        row.orderedAt,
      ),
      insertLog.bind(itemId, 'ordered', now),
    );
    rowsByCustomer.set(customerId, (rowsByCustomer.get(customerId) ?? 0) + 1);
    itemId += 1;
  }

  statements.push(
    db
      .prepare('UPDATE batches SET order_no=?,japan_tracking_no=? WHERE id=?')
      .bind(orderNo, japanTrackingNos.length ? japanTrackingNos.join('、') : null, batchId),
  );
  statements.push(
    ...registerStmts(db, batchId, [
      ...new Set([...japanTrackingNos, ...parsed.rows.map((r) => r.jpTrackingNo).filter((t): t is string => !!t)]),
    ], now),
  );
  await db.batch(statements);

  return c.json({
    batchId,
    packageId,
    itemCount: parsed.rows.length,
    directCount: parsed.rows.filter((r) => r.route === 'direct').length,
    amountJpy: parsed.rows.reduce((sum, r) => sum + r.goodsFeeJpy, 0),
    customerCount: rowsByCustomer.size,
    createdCustomers,
    skipped: parsed.skipped,
  });
});
