/**
 * 分拣：仓库把一个日本快递箱里的东西铺在地上，照着卡片上白底黑字的 cn 分堆，点「发送」一次落定。
 *
 *   GET  /api/staff/sort/queue              还有没分拣的件的日本订单，按日本运单号分组
 *   GET  /api/staff/sort/:batchId?tn=xxx    这一箱要分的件（表里写了这个运单号的 + 没写运单号的）
 *   POST /api/staff/sort/mark               点卡片 =「找到了」，再点取消（存在服务器上，换手机、两个人一起分都对得上）
 *   POST /api/staff/sort/:batchId/commit    发送：签收、拼团分箱填回国单号、直邮按人建包裹（EMS 单号 + 整包重量）、缺件
 *   GET  /api/staff/sort/sessions/:id       某一次分拣的结果（可复制发群）
 *
 * 管理员和日本仓账号都能用；日本仓这里看得到客户 QQ（同名时区分人用）。
 */
import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { directFeeFen, directPriceFenPerKg, maxBoxesPerSort, nowIso, statusLogStmt } from '../../lib/db.ts';
import { normalizeTrackingNo } from '../../lib/excel.ts';
import { HttpError, badRequest, bound, intList, notFound, optionalString, placeholders, readJson, requireInt } from '../../lib/http.ts';
import { staffOf } from '../../lib/staff.ts';
import { arriveStmts, loadShipments } from '../../lib/jpShipments.ts';
import { resolveAddress } from './direct.ts';

export const sortRoutes = new Hono<{ Bindings: Env }>();

const MAX_WEIGHT_G = 30_000;

/** 「还没分拣」：在日本这一侧、没落定、没装进直邮包裹的件 */
const UNSORTED = `i.sorted_at IS NULL AND i.status IN ('ordered', 'jp_warehouse') AND i.direct_parcel_id IS NULL`;

interface SortItem {
  id: number;
  title: string;
  productUrl: string | null;
  hasImage: number;
  status: string;
  route: string;
  customerId: number;
  cnLabel: string;
  nickname: string;
  qq: string;
  selfReturn: number;
  jpTrackingNo: string | null;
  missing: number;
  foundAt: string | null;
  foundBy: string | null;
  packageId: number | null;
}

async function scopeItems(db: D1Database, batchId: number, tn: string | null): Promise<SortItem[]> {
  const rows = await db
    .prepare(
      `SELECT i.id, i.title, i.product_url AS productUrl, (i.image_url IS NOT NULL) AS hasImage, i.status, i.route,
              i.customer_id AS customerId, COALESCE(NULLIF(TRIM(i.cn_label), ''), c.nickname) AS cnLabel, c.nickname, c.qq,
              c.self_return AS selfReturn, i.jp_tracking_no AS jpTrackingNo, i.missing,
              i.sort_found_at AS foundAt, i.sort_found_by AS foundBy, i.package_id AS packageId
         FROM items i JOIN customers c ON c.id = i.customer_id
        WHERE i.batch_id = ? AND ${UNSORTED} ${tn ? 'AND (i.jp_tracking_no = ? OR i.jp_tracking_no IS NULL)' : ''}
        ORDER BY cnLabel COLLATE NOCASE, i.customer_id, i.id`,
    )
    .bind(...(tn ? [batchId, tn] : [batchId]))
    .all<SortItem>();
  return rows.results;
}

function shapeItem(i: SortItem) {
  return {
    id: i.id,
    title: i.title,
    productUrl: i.productUrl,
    imageUrl: i.hasImage ? `/img/i/${i.id}` : null,
    status: i.status,
    route: i.route,
    customerId: i.customerId,
    cn: i.cnLabel,
    nickname: i.nickname,
    qq: i.qq,
    selfReturn: !!i.selfReturn,
    jpTrackingNo: i.jpTrackingNo,
    missing: !!i.missing,
    found: !!i.foundAt,
    foundBy: i.foundBy,
  };
}

sortRoutes.get('/queue', async (c) => {
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT b.id AS batchId, b.name, b.order_no AS orderNo, b.ordered_at AS orderedAt, b.japan_tracking_no AS japanTrackingNo,
              i.jp_tracking_no AS tn, COUNT(*) AS n, SUM(i.sort_found_at IS NOT NULL) AS found, SUM(i.missing) AS missing
         FROM items i JOIN batches b ON b.id = i.batch_id
        WHERE ${UNSORTED}
        GROUP BY b.id, i.jp_tracking_no
        ORDER BY b.id DESC, i.jp_tracking_no`,
    )
    .all<{
      batchId: number;
      name: string;
      orderNo: string | null;
      orderedAt: string | null;
      japanTrackingNo: string | null;
      tn: string | null;
      n: number;
      found: number;
      missing: number;
    }>();
  const sessions = await db
    .prepare(
      `SELECT id, batch_id AS batchId, jp_tracking_no AS jpTrackingNo, box_count AS boxCount, parcel_count AS parcelCount,
              item_count AS itemCount, missing_count AS missingCount, created_by AS createdBy, created_at AS createdAt
         FROM sort_sessions ORDER BY id DESC LIMIT 20`,
    )
    .all();
  const batches = new Map<number, {
    batchId: number;
    name: string;
    orderNo: string | null;
    orderedAt: string | null;
    japanTrackingNo: string | null;
    boxes: Array<{ trackingNo: string; count: number; found: number }>;
    untracked: number;
    untrackedFound: number;
    missing: number;
    total: number;
  }>();
  for (const r of rows.results) {
    const b = batches.get(r.batchId) ?? {
      batchId: r.batchId,
      name: r.name,
      orderNo: r.orderNo,
      orderedAt: r.orderedAt,
      japanTrackingNo: r.japanTrackingNo,
      boxes: [],
      untracked: 0,
      untrackedFound: 0,
      missing: 0,
      total: 0,
    };
    if (r.tn) b.boxes.push({ trackingNo: r.tn, count: r.n, found: r.found });
    else {
      b.untracked += r.n;
      b.untrackedFound += r.found;
    }
    b.missing += r.missing;
    b.total += r.n;
    batches.set(r.batchId, b);
  }
  // 每单登记过的日本快递：哪个到了、哪个还没到
  const shipments = await loadShipments(db, [...batches.keys()]);
  return c.json({
    batches: [...batches.values()].map((b) => ({ ...b, jpShipments: shipments.get(b.batchId) ?? [] })),
    sessions: sessions.results,
  });
});

/** 一次分拣的结果：给结果页和「分拣记录」用。 */
sortRoutes.get('/sessions/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '分拣记录 ID');
  const row = await c.env.DB.prepare(
    'SELECT id, batch_id AS batchId, jp_tracking_no AS jpTrackingNo, summary, created_by AS createdBy, created_at AS createdAt FROM sort_sessions WHERE id = ?',
  )
    .bind(id)
    .first<{ id: number; batchId: number; jpTrackingNo: string | null; summary: string | null; createdBy: string; createdAt: string }>();
  if (!row) throw notFound('没有这次分拣记录');
  let result: unknown = null;
  try {
    result = row.summary ? JSON.parse(row.summary) : null;
  } catch {
    result = null;
  }
  return c.json({ ...row, summary: undefined, result });
});

sortRoutes.get('/:batchId', async (c) => {
  const batchId = requireInt(c.req.param('batchId'), '批次 ID');
  const tn = normalizeTrackingNo(c.req.query('tn') ?? null);
  const db = c.env.DB;
  const batch = await db
    .prepare('SELECT id, name, order_no AS orderNo, ordered_at AS orderedAt, japan_tracking_no AS japanTrackingNo FROM batches WHERE id = ?')
    .bind(batchId)
    .first<{ id: number; name: string; orderNo: string | null; orderedAt: string | null; japanTrackingNo: string | null }>();
  if (!batch) throw notFound('没有这个日本订单');
  const items = await scopeItems(db, batchId, tn);

  // 直邮客户的地址有没有着落：没着落的分完先放着，等客户填了再打包
  const directCustomers = [...new Set(items.filter((i) => i.route === 'direct').map((i) => i.customerId))];
  const addressInfo = new Map<number, { ready: boolean; text: string | null }>();
  for (const customerId of directCustomers) {
    const importAddress = (
      await db
        .prepare(`SELECT import_address AS a FROM items i WHERE i.customer_id = ? AND i.batch_id = ? AND i.route = 'direct' AND i.import_address IS NOT NULL LIMIT 1`)
        .bind(customerId, batchId)
        .first<{ a: string }>()
    )?.a;
    try {
      const resolved = await resolveAddress(db, customerId, importAddress ? [importAddress] : []);
      const a = JSON.parse(resolved.snapshot) as { raw?: string; recipient?: string; phone?: string; detail?: string };
      addressInfo.set(customerId, { ready: true, text: a.raw ?? [a.recipient, a.phone, a.detail].filter(Boolean).join(' ') });
    } catch (err) {
      addressInfo.set(customerId, { ready: false, text: err instanceof HttpError ? err.message : null });
    }
  }

  return c.json({
    batch,
    trackingNo: tn,
    maxBoxes: await maxBoxesPerSort(c.env),
    directPriceFenPerKg: await directPriceFenPerKg(c.env),
    items: items.map(shapeItem),
    directAddresses: Object.fromEntries(addressInfo),
  });
});

/** 点卡片：找到了 / 取消。只认还没分拣的件。 */
sortRoutes.post('/mark', async (c) => {
  const body = await readJson<{ itemIds?: unknown; found?: unknown }>(c);
  const itemIds = [...new Set(intList(body.itemIds, '物品 ID'))];
  if (itemIds.length > 500) throw badRequest('一次最多 500 件');
  if (typeof body.found !== 'boolean') throw badRequest('found 要是 true / false');
  const staff = staffOf(c);
  const at = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE items SET sort_found_at = ?, sort_found_by = ?
      WHERE id IN (${placeholders(itemIds.length)}) AND sorted_at IS NULL AND status IN ('ordered', 'jp_warehouse') AND direct_parcel_id IS NULL`,
  )
    .bind(body.found ? at : null, body.found ? staff.name : null, ...itemIds)
    .run();
  return c.json({ ok: true, changed: result.meta.changes });
});

interface CommitBody {
  trackingNo?: unknown;
  boxes?: unknown;
  assign?: unknown;
  direct?: unknown;
  missing?: unknown;
}

interface DirectPile {
  customerId: number;
  trackingNo: string | null;
  carrier: string | null;
  weightG: number | null;
}

function parseDirect(value: unknown): DirectPile[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('direct 要是数组');
  return value.map((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    let weightG: number | null = null;
    if (o.weightG !== undefined && o.weightG !== null && o.weightG !== '') {
      const n = typeof o.weightG === 'string' ? Number(o.weightG) : o.weightG;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw badRequest('直邮整包重量要填正整数（克）');
      if (n > MAX_WEIGHT_G) throw badRequest(`整包重量 ${n} 克超过 30 kg 了，检查一下是不是多打了零`);
      weightG = n;
    }
    return {
      customerId: requireInt(o.customerId, '客户 ID'),
      trackingNo: bound(normalizeTrackingNo(optionalString(o.trackingNo)), 'EMS 单号', 40),
      carrier: bound(optionalString(o.carrier), '承运商', 30),
      weightG,
    };
  });
}

/**
 * 发送：一次落定这一箱的分拣。
 *   - 点到的件：签收（已下单 → 已到日本仓）、记上这一箱的日本运单号、标「已分拣」；
 *   - 拼团的件：按 assign 分进第 1…N 箱（N ≤ 设置里的上限），每箱建一个回国箱，填了回国单号就当场发出（回国中）；
 *   - 直邮的件：按人建包裹，填 EMS 单号、整包重量（有重量就算出运费、变「待付款」）；没地址的先放着，等客户填；
 *   - 不拼邮（自己带回国）的拼团件：只签收、不进箱；
 *   - missing 里的件：标缺件，下一箱到了还能再点。
 */
sortRoutes.post('/:batchId/commit', async (c) => {
  const batchId = requireInt(c.req.param('batchId'), '批次 ID');
  const body = await readJson<CommitBody>(c);
  const tn = bound(normalizeTrackingNo(optionalString(body.trackingNo)), '日本运单号', 40);
  const db = c.env.DB;
  const staff = staffOf(c);
  const batch = await db.prepare('SELECT id, name FROM batches WHERE id = ?').bind(batchId).first<{ id: number; name: string }>();
  if (!batch) throw notFound('没有这个日本订单');

  const scope = await scopeItems(db, batchId, tn);
  const byId = new Map(scope.map((i) => [i.id, i]));
  const found = scope.filter((i) => i.foundAt);
  const missingIds = body.missing === undefined || body.missing === null || (Array.isArray(body.missing) && !body.missing.length)
    ? []
    : [...new Set(intList(body.missing, '缺件 ID'))];
  for (const id of missingIds) {
    const item = byId.get(id);
    if (!item) throw badRequest('缺件里有不在这一箱的件，刷新页面');
    if (item.foundAt) throw badRequest(`「${item.title}」已经点了找到，不能同时标缺件`);
  }
  if (!found.length && !missingIds.length) throw badRequest('一件都还没点「找到了」，没东西可发送');

  // ---- 拼团：分箱 ----
  const boxesRaw = Array.isArray(body.boxes) ? body.boxes : [];
  const boxes = boxesRaw.map((b, k) => ({
    trackingNo: bound(normalizeTrackingNo(optionalString((b as Record<string, unknown> | null)?.trackingNo)), `第 ${k + 1} 箱的回国单号`, 40),
  }));
  const maxBoxes = await maxBoxesPerSort(c.env);
  if (boxes.length > maxBoxes) throw badRequest(`一次最多开 ${maxBoxes} 箱（设置里可以改）`);
  const assign = (body.assign ?? {}) as Record<string, unknown>;
  const groupFound = found.filter((i) => i.route === 'group' && !i.selfReturn);
  const selfReturnFound = found.filter((i) => i.route === 'group' && i.selfReturn);
  const boxOf = new Map<number, number>();
  for (const item of groupFound) {
    const raw = assign[String(item.id)] ?? (boxes.length === 1 ? 1 : undefined);
    const k = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > boxes.length) {
      throw badRequest(boxes.length ? `「${item.title}」（${item.cnLabel}）还没分到箱子里` : '有拼团的件，至少要开一箱');
    }
    boxOf.set(item.id, k);
  }
  for (let k = 1; k <= boxes.length; k += 1) {
    if (![...boxOf.values()].includes(k)) throw badRequest(`第 ${k} 箱是空的，删掉这一箱或者分几件进去`);
  }

  // ---- 直邮：按人 ----
  const piles = new Map(parseDirect(body.direct).map((p) => [p.customerId, p]));
  const directFound = found.filter((i) => i.route === 'direct');
  const directCustomers = [...new Set(directFound.map((i) => i.customerId))];

  const at = nowIso();
  const statements: D1PreparedStatement[] = [];
  const sessionId = ((await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM sort_sessions').first<{ n: number }>())?.n ?? 1) as number;

  // 这个日本快递算到了
  if (tn) statements.push(...arriveStmts(db, batchId, tn, staff.name, at));

  // 所有点到的件：签收 + 记运单号 + 已分拣（缺件标记清掉）
  for (const item of found) {
    statements.push(
      db
        .prepare(
          `UPDATE items SET status = CASE WHEN status = 'ordered' THEN 'jp_warehouse' ELSE status END,
                  jp_tracking_no = COALESCE(jp_tracking_no, ?), sorted_at = ?, sort_session_id = ?, missing = 0, updated_at = ?
            WHERE id = ?`,
        )
        .bind(tn, at, sessionId, at, item.id),
    );
    if (item.status === 'ordered') statements.push(statusLogStmt(db, item.id, 'ordered', 'jp_warehouse', at, staff.name));
  }

  // 不拼邮（自己带回国）的件：签收后单独放着，不留在导入时的整单箱子里——
  // 留在箱里，回国箱列表就会把它当成要发回国的货
  for (const item of selfReturnFound) {
    if (item.packageId) statements.push(db.prepare('UPDATE items SET package_id = NULL, updated_at = ? WHERE id = ?').bind(at, item.id));
  }

  // 回国箱
  const priorBoxes = (
    await db.prepare('SELECT COALESCE(SUM(box_count), 0) AS n FROM sort_sessions WHERE batch_id = ?').bind(batchId).first<{ n: number }>()
  )?.n ?? 0;
  let packageId = ((await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM packages').first<{ n: number }>())?.n ?? 1) as number;
  const boxResults: Array<{ no: number; packageId: number; name: string; trackingNo: string | null; items: SortItem[] }> = [];
  boxes.forEach((box, idx) => {
    const k = idx + 1;
    const name = `${batch.name} 第${priorBoxes + k}箱`;
    const shipped = !!box.trackingNo;
    statements.push(
      db
        .prepare('INSERT INTO packages (id, name, tracking_no, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(packageId, name, box.trackingNo, shipped ? 'intl_transit' : 'jp_warehouse', at),
      db.prepare('INSERT INTO package_batches (package_id, batch_id) VALUES (?, ?)').bind(packageId, batchId),
    );
    const inBox = groupFound.filter((i) => boxOf.get(i.id) === k);
    for (const item of inBox) {
      statements.push(
        db
          .prepare(
            `UPDATE items SET package_id = ?, weigh_group_id = NULL, weight_g = NULL, intl_fee_fen = NULL,
                    status = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(packageId, shipped ? 'intl_transit' : 'jp_warehouse', at, item.id),
      );
      if (shipped) statements.push(statusLogStmt(db, item.id, 'jp_warehouse', 'intl_transit', at, staff.name));
    }
    boxResults.push({ no: priorBoxes + k, packageId, name, trackingNo: box.trackingNo, items: inBox });
    packageId += 1;
  });

  // 直邮包裹
  const rate = await directPriceFenPerKg(c.env);
  let parcelId = ((await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM direct_parcels').first<{ n: number }>())?.n ?? 1) as number;
  const parcelResults: Array<{ id: number; customerId: number; trackingNo: string | null; carrier: string | null; weightG: number | null; feeFen: number | null; address: string; items: SortItem[] }> = [];
  const unpacked: Array<{ customerId: number; reason: string; items: SortItem[] }> = [];
  for (const customerId of directCustomers) {
    const mine = directFound.filter((i) => i.customerId === customerId);
    if (mine[0].selfReturn) {
      unpacked.push({ customerId, reason: '标了不拼邮（自己带回国），不走直邮', items: mine });
      continue;
    }
    const importAddresses = (
      await db
        .prepare(`SELECT import_address AS a FROM items WHERE id IN (${placeholders(mine.length)}) AND import_address IS NOT NULL`)
        .bind(...mine.map((i) => i.id))
        .all<{ a: string }>()
    ).results.map((r) => r.a);
    let address: { snapshot: string; source: 'import' | 'customer' };
    try {
      address = await resolveAddress(db, customerId, importAddresses);
    } catch (err) {
      unpacked.push({ customerId, reason: err instanceof HttpError ? err.message : '地址没着落', items: mine });
      continue;
    }
    const pile = piles.get(customerId) ?? { customerId, trackingNo: null, carrier: null, weightG: null };
    const fee = pile.weightG === null ? null : directFeeFen(pile.weightG, rate);
    const status = pile.weightG === null ? 'packing' : 'awaiting_payment';
    statements.push(
      db
        .prepare(
          `INSERT INTO direct_parcels (id, customer_id, address_snapshot, address_source, status, weight_g, rate_fen_per_kg, fee_fen,
                                       carrier, tracking_no, packed_by, created_at, weighed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          parcelId,
          customerId,
          address.snapshot,
          address.source,
          status,
          pile.weightG,
          pile.weightG === null ? null : rate,
          fee,
          pile.trackingNo ? pile.carrier ?? 'EMS' : pile.carrier,
          pile.trackingNo,
          staff.name,
          at,
          pile.weightG === null ? null : at,
        ),
    );
    for (const item of mine) {
      statements.push(
        db
          .prepare('UPDATE items SET direct_parcel_id = ?, status = ?, updated_at = ? WHERE id = ?')
          .bind(parcelId, pile.weightG === null ? 'jp_warehouse' : 'direct_unpaid', at, item.id),
      );
      if (pile.weightG !== null) statements.push(statusLogStmt(db, item.id, 'jp_warehouse', 'direct_unpaid', at, staff.name));
    }
    const a = JSON.parse(address.snapshot) as { raw?: string; recipient?: string; phone?: string; detail?: string };
    parcelResults.push({
      id: parcelId,
      customerId,
      trackingNo: pile.trackingNo,
      carrier: pile.trackingNo ? pile.carrier ?? 'EMS' : pile.carrier,
      weightG: pile.weightG,
      feeFen: fee,
      address: a.raw ?? [a.recipient, a.phone, a.detail].filter(Boolean).join(' '),
      items: mine,
    });
    parcelId += 1;
  }

  // 缺件
  for (const id of missingIds) {
    statements.push(
      db
        .prepare("UPDATE items SET missing = 1, exception_note = ?, sort_found_at = NULL, updated_at = ? WHERE id = ?")
        .bind(`日本仓分拣时没找到${tn ? `（日本运单 ${tn}）` : ''}`, at, id),
    );
  }

  // 结果：给结果页和发群用
  const who = (i: SortItem) => ({ customerId: i.customerId, cn: i.cnLabel, qq: i.qq });
  const people = (list: SortItem[]) => {
    const map = new Map<number, { customerId: number; cn: string; qq: string; items: Array<{ id: number; title: string }> }>();
    for (const i of list) {
      const p = map.get(i.customerId) ?? { ...who(i), items: [] };
      p.items.push({ id: i.id, title: i.title });
      map.set(i.customerId, p);
    }
    return [...map.values()];
  };
  const result = {
    batchName: batch.name,
    jpTrackingNo: tn,
    by: staff.name,
    at,
    parcels: parcelResults.map((p) => ({
      id: p.id,
      ...who(p.items[0]),
      trackingNo: p.trackingNo,
      carrier: p.carrier,
      weightG: p.weightG,
      feeFen: p.feeFen,
      address: p.address,
      items: p.items.map((i) => ({ id: i.id, title: i.title })),
    })),
    boxes: boxResults.map((b) => ({ no: b.no, packageId: b.packageId, name: b.name, trackingNo: b.trackingNo, people: people(b.items) })),
    selfReturn: people(selfReturnFound),
    unpacked: unpacked.map((u) => ({ ...who(u.items[0]), reason: u.reason, items: u.items.map((i) => ({ id: i.id, title: i.title })) })),
    missing: missingIds.map((id) => {
      const i = byId.get(id)!;
      return { id, title: i.title, ...who(i) };
    }),
    leftover: scope.filter((i) => !i.foundAt && !missingIds.includes(i.id)).length,
  };

  statements.push(
    db
      .prepare(
        `INSERT INTO sort_sessions (id, batch_id, jp_tracking_no, box_count, parcel_count, item_count, missing_count, summary, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(sessionId, batchId, tn, boxes.length, parcelResults.length, found.length, missingIds.length, JSON.stringify(result), staff.name, at),
  );

  await db.batch(statements);

  // 导入时自动建的那个「整单」箱子分空了就收掉，免得后台挂一个空包裹
  const empties = await db
    .prepare(
      `SELECT p.id FROM packages p JOIN package_batches pb ON pb.package_id = p.id
        WHERE pb.batch_id = ? AND p.allocated_at IS NULL AND p.status IN ('ordered', 'jp_warehouse')
          AND NOT EXISTS (SELECT 1 FROM items WHERE package_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM weigh_groups WHERE package_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM package_batches pb2 WHERE pb2.package_id = p.id AND pb2.batch_id != ?)`,
    )
    .bind(batchId, batchId)
    .all<{ id: number }>();
  const created = new Set(boxResults.map((b) => b.packageId));
  const drop = empties.results.filter((p) => !created.has(p.id));
  if (drop.length) {
    await db.batch(
      drop.flatMap((p) => [
        db.prepare('DELETE FROM package_batches WHERE package_id = ?').bind(p.id),
        db.prepare('DELETE FROM packages WHERE id = ?').bind(p.id),
      ]),
    );
  }

  return c.json({ ok: true, sessionId, result });
});
