/**
 * 日本直邮：日本仓按客户打包 → 称重算运费 → 客户扫码付款、管理员确认 → 日本仓填单号寄出 → 签收。
 *
 *   /api/staff/direct/*  管理员和日本仓都能用：打包、称重、拆包、寄出、看列表
 *   /api/admin/direct/*  只有管理员：确认收款、标签收
 *
 * 规矩：没确认收款不能寄出；付了款就封账（不能再拆包、改重量），要改先在收款记录里撤销那笔钱。
 */
import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { directFeeFen, directPriceFenPerKg, nowIso, statusLogStmt } from '../../lib/db.ts';
import { badRequest, bound, intList, notFound, optionalString, placeholders, readJson, requireInt, requireString } from '../../lib/http.ts';
import { staffOf } from '../../lib/staff.ts';

export const directStaffRoutes = new Hono<{ Bindings: Env }>();
export const directAdminRoutes = new Hono<{ Bindings: Env }>();

const MAX_WEIGHT_G = 30_000; // EMS 单件上限 30 kg，再重多半是手滑多打了零

export const PARCEL_LABELS: Record<string, string> = {
  packing: '打包中（待称重）',
  awaiting_payment: '待付款',
  paid: '已付款，待寄出',
  shipped: '已寄出',
  delivered: '已签收',
};

interface ParcelRow {
  id: number;
  customerId: number;
  nickname: string;
  addressSnapshot: string;
  addressSource: string;
  status: string;
  weightG: number | null;
  rateFenPerKg: number | null;
  feeFen: number | null;
  carrier: string | null;
  trackingNo: string | null;
  packedBy: string | null;
  shippedBy: string | null;
  createdAt: string;
  weighedAt: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
}

const PARCEL_COLUMNS = `d.id, d.customer_id AS customerId, c.nickname, d.address_snapshot AS addressSnapshot,
  d.address_source AS addressSource, d.status, d.weight_g AS weightG, d.rate_fen_per_kg AS rateFenPerKg,
  d.fee_fen AS feeFen, d.carrier, d.tracking_no AS trackingNo, d.packed_by AS packedBy, d.shipped_by AS shippedBy,
  d.created_at AS createdAt, d.weighed_at AS weighedAt, d.paid_at AS paidAt, d.shipped_at AS shippedAt,
  d.delivered_at AS deliveredAt`;

/** 包裹连同里面的件；给客户页、后台、日本仓共用。 */
export async function loadParcels(db: D1Database, where: string, args: unknown[]) {
  const parcels = await db
    .prepare(`SELECT ${PARCEL_COLUMNS} FROM direct_parcels d JOIN customers c ON c.id = d.customer_id ${where} ORDER BY d.id DESC LIMIT 300`)
    .bind(...args)
    .all<ParcelRow>();
  const ids = parcels.results.map((p) => p.id);
  const items = ids.length
    ? (
        await db
          .prepare(
            `SELECT id, title, product_url AS productUrl, (image_url IS NOT NULL) AS hasImage, status,
                    direct_parcel_id AS parcelId
               FROM items WHERE direct_parcel_id IN (${placeholders(ids.length)}) ORDER BY id`,
          )
          .bind(...ids)
          .all<{ id: number; title: string; productUrl: string | null; hasImage: number; status: string; parcelId: number }>()
      ).results
    : [];
  return parcels.results.map((p) => {
    let address: unknown = null;
    try {
      address = JSON.parse(p.addressSnapshot);
    } catch {
      address = { raw: p.addressSnapshot };
    }
    return {
      ...p,
      address,
      statusLabel: PARCEL_LABELS[p.status] ?? p.status,
      items: items
        .filter((i) => i.parcelId === p.id)
        .map((i) => ({ id: i.id, title: i.title, productUrl: i.productUrl, status: i.status, imageUrl: i.hasImage ? `/img/i/${i.id}` : null })),
    };
  });
}

async function getParcel(db: D1Database, id: number): Promise<ParcelRow> {
  const row = await db
    .prepare(`SELECT ${PARCEL_COLUMNS} FROM direct_parcels d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`)
    .bind(id)
    .first<ParcelRow>();
  if (!row) throw notFound('没有这个直邮包裹');
  return row;
}

async function parcelItemIds(db: D1Database, id: number): Promise<Array<{ id: number; status: string }>> {
  return (await db.prepare('SELECT id, status FROM items WHERE direct_parcel_id = ?').bind(id).all<{ id: number; status: string }>()).results;
}

function weightOf(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw badRequest('重量要填正整数（克）');
  if (n > MAX_WEIGHT_G) throw badRequest(`重量 ${n} 克超过 30 kg 了，检查一下是不是多打了零`);
  return n;
}

/**
 * 这一包寄到哪：导入表里写了地址就用表里的；没写就用客户在自己页面上选的直邮地址；
 * 客户只存了一个地址就自动用它；都没有就打不了包。
 */
async function resolveAddress(
  db: D1Database,
  customerId: number,
  importAddresses: string[],
): Promise<{ snapshot: string; source: 'import' | 'customer' }> {
  const distinct = [...new Set(importAddresses)];
  if (distinct.length > 1) throw badRequest('这几件在导入表里写的直邮地址不一样，按地址分开打包');
  if (distinct.length === 1) return { snapshot: JSON.stringify({ raw: distinct[0] }), source: 'import' };
  const customer = await db
    .prepare('SELECT direct_address_id AS chosen FROM customers WHERE id = ?')
    .bind(customerId)
    .first<{ chosen: number | null }>();
  const addresses = (
    await db
      .prepare('SELECT id, recipient, phone, detail FROM addresses WHERE customer_id = ? ORDER BY id')
      .bind(customerId)
      .all<{ id: number; recipient: string; phone: string; detail: string }>()
  ).results;
  const picked = addresses.find((a) => a.id === customer?.chosen) ?? (addresses.length === 1 ? addresses[0] : null);
  if (!picked) {
    throw badRequest(
      addresses.length
        ? '客户存了好几个地址、还没选直邮寄哪一个。请他在自己的页面上选一下'
        : '客户还没有收货地址，导入表里也没写。请他在自己的页面上填一个',
    );
  }
  return {
    snapshot: JSON.stringify({ recipient: picked.recipient, phone: picked.phone, detail: picked.detail }),
    source: 'customer',
  };
}

directStaffRoutes.get('/parcels', async (c) => {
  const status = c.req.query('status');
  const customerId = c.req.query('customerId');
  const where: string[] = [];
  const args: unknown[] = [];
  if (status === 'open') where.push("d.status IN ('packing', 'awaiting_payment', 'paid')");
  else if (status && PARCEL_LABELS[status]) {
    where.push('d.status = ?');
    args.push(status);
  }
  if (customerId) {
    where.push('d.customer_id = ?');
    args.push(requireInt(customerId, '客户 ID'));
  }
  const parcels = await loadParcels(c.env.DB, where.length ? `WHERE ${where.join(' AND ')}` : '', args);
  return c.json({ parcels, labels: PARCEL_LABELS, priceFenPerKg: await directPriceFenPerKg(c.env) });
});

/** 打包：选一位客户的几件直邮货装成一包；带上重量就顺手称好、直接变「待付款」。 */
directStaffRoutes.post('/parcels', async (c) => {
  const body = await readJson<{ customerId?: unknown; itemIds?: unknown; weightG?: unknown }>(c);
  const customerId = requireInt(body.customerId, '客户 ID');
  const itemIds = [...new Set(intList(body.itemIds, '物品 ID'))];
  const db = c.env.DB;
  const self = await db.prepare('SELECT self_return AS s FROM customers WHERE id = ?').bind(customerId).first<{ s: number }>();
  if (!self) throw notFound('没有这个客户');
  if (self.s) throw badRequest('这位客户标了「不拼邮」（自己带回国），不走直邮');

  const rows = (
    await db
      .prepare(
        `SELECT id, customer_id AS customerId, route, status, direct_parcel_id AS parcelId, missing, import_address AS importAddress
           FROM items WHERE id IN (${placeholders(itemIds.length)})`,
      )
      .bind(...itemIds)
      .all<{ id: number; customerId: number; route: string; status: string; parcelId: number | null; missing: number; importAddress: string | null }>()
  ).results;
  if (rows.length !== itemIds.length) throw badRequest('有的件已经不在系统里了，刷新页面再打包');
  if (rows.some((r) => r.customerId !== customerId)) throw badRequest('一包只能装同一位客户的东西');
  if (rows.some((r) => r.route !== 'direct')) throw badRequest('有的件不是直邮，拼团的件进回国箱');
  if (rows.some((r) => r.parcelId)) throw badRequest('有的件已经在别的直邮包裹里了，刷新页面');
  if (rows.some((r) => r.status !== 'jp_warehouse')) throw badRequest('只能打包「已到日本仓」的件，没签收的先签收');
  if (rows.some((r) => r.missing)) throw badRequest('有的件标了缺件，先处理');

  const { snapshot, source } = await resolveAddress(
    db,
    customerId,
    rows.map((r) => r.importAddress).filter((a): a is string => !!a),
  );
  const staff = staffOf(c);
  const at = nowIso();
  const weightG = body.weightG === undefined || body.weightG === null || body.weightG === '' ? null : weightOf(body.weightG);
  const rate = weightG === null ? null : await directPriceFenPerKg(c.env);
  const fee = weightG === null || rate === null ? null : directFeeFen(weightG, rate);
  const status = weightG === null ? 'packing' : 'awaiting_payment';

  const id = ((await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM direct_parcels').first<{ n: number }>())?.n ?? 1) as number;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO direct_parcels (id, customer_id, address_snapshot, address_source, status, weight_g, rate_fen_per_kg, fee_fen,
                                     packed_by, created_at, weighed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, customerId, snapshot, source, status, weightG, rate, fee, staff.name, at, weightG === null ? null : at),
  ];
  for (const r of rows) {
    statements.push(
      db
        .prepare('UPDATE items SET direct_parcel_id = ?, status = ?, updated_at = ? WHERE id = ?')
        .bind(id, weightG === null ? 'jp_warehouse' : 'direct_unpaid', at, r.id),
    );
    if (weightG !== null) statements.push(statusLogStmt(db, r.id, 'jp_warehouse', 'direct_unpaid', at));
  }
  await db.batch(statements);
  return c.json({ ok: true, id, status, feeFen: fee });
});

/** 称重 / 重称：按当前直邮单价算运费并存档。付了款就不能再改。 */
directStaffRoutes.post('/parcels/:id/weigh', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const body = await readJson<{ weightG?: unknown }>(c);
  const weightG = weightOf(body.weightG);
  const db = c.env.DB;
  const parcel = await getParcel(db, id);
  if (!['packing', 'awaiting_payment'].includes(parcel.status)) {
    throw badRequest('这一包已经付过款了，重量封账；要改先在收款记录里撤销那笔钱');
  }
  const rate = await directPriceFenPerKg(c.env);
  const fee = directFeeFen(weightG, rate);
  const at = nowIso();
  const items = await parcelItemIds(db, id);
  await db.batch([
    db
      .prepare("UPDATE direct_parcels SET status = 'awaiting_payment', weight_g = ?, rate_fen_per_kg = ?, fee_fen = ?, weighed_at = ? WHERE id = ?")
      .bind(weightG, rate, fee, at, id),
    ...items
      .filter((i) => i.status !== 'direct_unpaid')
      .flatMap((i) => [
        db.prepare("UPDATE items SET status = 'direct_unpaid', updated_at = ? WHERE id = ?").bind(at, i.id),
        statusLogStmt(db, i.id, i.status, 'direct_unpaid', at),
      ]),
  ]);
  return c.json({ ok: true, weightG, rateFenPerKg: rate, feeFen: fee });
});

/** 拆包：整包拆掉，件退回「已到日本仓」等重新打包。付了款的不能拆。 */
directStaffRoutes.post('/parcels/:id/cancel', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const db = c.env.DB;
  const parcel = await getParcel(db, id);
  if (!['packing', 'awaiting_payment'].includes(parcel.status)) {
    throw badRequest('付过款的包裹不能拆；要拆先在收款记录里撤销那笔钱');
  }
  const at = nowIso();
  const items = await parcelItemIds(db, id);
  await db.batch([
    ...items.flatMap((i) => [
      db.prepare("UPDATE items SET direct_parcel_id = NULL, status = 'jp_warehouse', updated_at = ? WHERE id = ?").bind(at, i.id),
      ...(i.status !== 'jp_warehouse' ? [statusLogStmt(db, i.id, i.status, 'jp_warehouse', at)] : []),
    ]),
    db.prepare('DELETE FROM direct_parcels WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true, count: items.length });
});

/** 从包里拿出几件：重量变了，包裹退回「打包中」等重新称。拿空了就整包拆掉。 */
directStaffRoutes.post('/parcels/:id/remove', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const body = await readJson<{ itemIds?: unknown }>(c);
  const itemIds = [...new Set(intList(body.itemIds, '物品 ID'))];
  const db = c.env.DB;
  const parcel = await getParcel(db, id);
  if (!['packing', 'awaiting_payment'].includes(parcel.status)) throw badRequest('付过款的包裹不能再拿东西出来');
  const items = await parcelItemIds(db, id);
  const picked = items.filter((i) => itemIds.includes(i.id));
  if (picked.length !== itemIds.length) throw badRequest('有的件不在这个包裹里，刷新页面');
  const at = nowIso();
  const left = items.length - picked.length;
  await db.batch([
    ...picked.flatMap((i) => [
      db.prepare("UPDATE items SET direct_parcel_id = NULL, status = 'jp_warehouse', updated_at = ? WHERE id = ?").bind(at, i.id),
      ...(i.status !== 'jp_warehouse' ? [statusLogStmt(db, i.id, i.status, 'jp_warehouse', at)] : []),
    ]),
    ...(left
      ? [
          db.prepare("UPDATE direct_parcels SET status = 'packing', weight_g = NULL, rate_fen_per_kg = NULL, fee_fen = NULL, weighed_at = NULL WHERE id = ?").bind(id),
          ...items
            .filter((i) => !itemIds.includes(i.id) && i.status !== 'jp_warehouse')
            .flatMap((i) => [
              db.prepare("UPDATE items SET status = 'jp_warehouse', updated_at = ? WHERE id = ?").bind(at, i.id),
              statusLogStmt(db, i.id, i.status, 'jp_warehouse', at),
            ]),
        ]
      : [db.prepare('DELETE FROM direct_parcels WHERE id = ?').bind(id)]),
  ]);
  return c.json({ ok: true, left, removed: picked.length });
});

/** 寄出：只有确认收款之后才能填单号寄出。 */
directStaffRoutes.post('/parcels/:id/ship', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const body = await readJson<{ trackingNo?: unknown; carrier?: unknown }>(c);
  const trackingNo = bound(requireString(body.trackingNo, '国际单号'), '国际单号', 60) as string;
  const carrier = bound(optionalString(body.carrier), '承运商', 30);
  const db = c.env.DB;
  const parcel = await getParcel(db, id);
  if (parcel.status === 'packing' || parcel.status === 'awaiting_payment') {
    throw badRequest('这一包还没确认收款，不能寄出。等客户付款、管理员确认收款后再寄');
  }
  if (parcel.status !== 'paid') throw badRequest('这一包已经寄出了；单号填错了用「改单号」');
  const at = nowIso();
  const items = await parcelItemIds(db, id);
  await db.batch([
    db
      .prepare("UPDATE direct_parcels SET status = 'shipped', tracking_no = ?, carrier = ?, shipped_by = ?, shipped_at = ? WHERE id = ?")
      .bind(trackingNo, carrier, staffOf(c).name, at, id),
    ...items.flatMap((i) => [
      db.prepare("UPDATE items SET status = 'shipped', updated_at = ? WHERE id = ?").bind(at, i.id),
      statusLogStmt(db, i.id, i.status, 'shipped', at),
    ]),
  ]);
  return c.json({ ok: true });
});

/** 寄出后改单号 / 承运商（填错了），发货时间不动。 */
directStaffRoutes.post('/parcels/:id/tracking', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const body = await readJson<{ trackingNo?: unknown; carrier?: unknown }>(c);
  const trackingNo = bound(requireString(body.trackingNo, '国际单号'), '国际单号', 60) as string;
  const carrier = bound(optionalString(body.carrier), '承运商', 30);
  const parcel = await getParcel(c.env.DB, id);
  if (!['shipped', 'delivered'].includes(parcel.status)) throw badRequest('还没寄出，寄出时再填单号');
  await c.env.DB.prepare('UPDATE direct_parcels SET tracking_no = ?, carrier = ? WHERE id = ?').bind(trackingNo, carrier, id).run();
  return c.json({ ok: true });
});

/** 管理员确认收款：记一笔直邮运费，包裹变「已付款，待寄出」。 */
directAdminRoutes.post('/:id/pay', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const body = await readJson<{ note?: unknown }>(c);
  const db = c.env.DB;
  const parcel = await getParcel(db, id);
  if (parcel.status === 'packing') throw badRequest('这一包还没称重，没有运费可收');
  if (parcel.status !== 'awaiting_payment') throw badRequest('这一包已经收过款了');
  const at = nowIso();
  const items = await parcelItemIds(db, id);
  const paymentId = ((await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM payments').first<{ n: number }>())?.n ?? 1) as number;
  await db.batch([
    db
      .prepare(
        `INSERT INTO payments (id, customer_id, kind, amount, currency, ref_type, ref_id, note, paid_at)
         VALUES (?, ?, 'direct', ?, 'CNY', 'direct_parcel', ?, ?, ?)`,
      )
      .bind(paymentId, parcel.customerId, parcel.feeFen ?? 0, id, bound(optionalString(body.note), '备注', 200), at),
    ...items.map((i) => db.prepare('INSERT INTO payment_items (payment_id, item_id) VALUES (?, ?)').bind(paymentId, i.id)),
    db.prepare("UPDATE direct_parcels SET status = 'paid', paid_at = ? WHERE id = ?").bind(at, id),
    ...items.flatMap((i) => [
      db.prepare("UPDATE items SET status = 'direct_ready', updated_at = ? WHERE id = ?").bind(at, i.id),
      statusLogStmt(db, i.id, i.status, 'direct_ready', at),
    ]),
  ]);
  return c.json({ ok: true, paymentId });
});

/** 标签收（客户说收到了）。 */
directAdminRoutes.post('/:id/delivered', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const db = c.env.DB;
  const parcel = await getParcel(db, id);
  if (parcel.status !== 'shipped') throw badRequest('只有已寄出的包裹能标签收');
  const at = nowIso();
  const items = await parcelItemIds(db, id);
  await db.batch([
    db.prepare("UPDATE direct_parcels SET status = 'delivered', delivered_at = ? WHERE id = ?").bind(at, id),
    ...items.flatMap((i) => [
      db.prepare("UPDATE items SET status = 'delivered', updated_at = ? WHERE id = ?").bind(at, i.id),
      statusLogStmt(db, i.id, i.status, 'delivered', at),
    ]),
  ]);
  return c.json({ ok: true });
});

/** 撤销直邮收款时用：包裹退回「待付款」，件退回「直邮待付款」。已经寄出的不让撤。 */
export async function revertDirectPayment(db: D1Database, parcelId: number): Promise<D1PreparedStatement[]> {
  const parcel = await db.prepare('SELECT status FROM direct_parcels WHERE id = ?').bind(parcelId).first<{ status: string }>();
  if (!parcel) return [];
  if (parcel.status === 'shipped' || parcel.status === 'delivered') {
    throw badRequest('这一包已经寄出了，不能撤销运费收款');
  }
  const at = nowIso();
  const items = await parcelItemIds(db, parcelId);
  return [
    db.prepare("UPDATE direct_parcels SET status = 'awaiting_payment', paid_at = NULL WHERE id = ?").bind(parcelId),
    ...items
      .filter((i) => i.status === 'direct_ready')
      .flatMap((i) => [
        db.prepare("UPDATE items SET status = 'direct_unpaid', updated_at = ? WHERE id = ?").bind(at, i.id),
        statusLogStmt(db, i.id, 'direct_ready', 'direct_unpaid', at),
      ]),
  ];
}
