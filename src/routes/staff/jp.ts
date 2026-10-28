/**
 * 日本仓：到货签收、分拣、回国箱发出。管理员和日本仓账号都能用（/api/staff/jp/*）。
 *
 * 这里返回的数据刻意只有干活要用的：商品名、图、货号、客户昵称、日本订单号 / 物流单号。
 * 不给货款、收款、客户 QQ 和真名——日本仓账号用不着，也不该看到。
 */
import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { nowIso, statusLogStmt } from '../../lib/db.ts';
import { badRequest, bound, intList, notFound, readJson, requireInt, requireString } from '../../lib/http.ts';
import { placeholders } from '../../lib/http.ts';
import { staffOf } from '../../lib/staff.ts';
import { normalizeTrackingNo } from '../../lib/excel.ts';
import { arriveStmts, registerStmts } from '../../lib/jpShipments.ts';

export const jpRoutes = new Hono<{ Bindings: Env }>();

interface JpItem {
  id: number;
  title: string;
  productUrl: string | null;
  hasImage: number;
  status: string;
  route: string;
  customerId: number;
  nickname: string;
  batchId: number;
  packageId: number | null;
  parcelId: number | null;
  missing: number;
  selfReturn: number;
}

const ITEM_COLUMNS = `i.id, i.title, i.product_url AS productUrl, (i.image_url IS NOT NULL) AS hasImage, i.status, i.route,
  i.customer_id AS customerId, c.nickname, i.batch_id AS batchId, i.package_id AS packageId,
  i.direct_parcel_id AS parcelId, i.missing, c.self_return AS selfReturn`;

function shape(i: JpItem) {
  return {
    id: i.id,
    title: i.title,
    productUrl: i.productUrl,
    // 图一律走自己域名的代理，客户端不直接碰外链
    imageUrl: i.hasImage ? `/img/i/${i.id}` : null,
    status: i.status,
    route: i.route,
    customerId: i.customerId,
    nickname: i.nickname,
    batchId: i.batchId,
    packageId: i.packageId,
    parcelId: i.parcelId,
    missing: !!i.missing,
    selfReturn: !!i.selfReturn,
  };
}

/**
 * 日本仓首页要的全部数据：
 *   inbound   还没签收的，按日本订单（批次）分组，带日本物流单号方便对快递；
 *   boxes     还开着的回国箱（拼团），已签收 / 未签收各几件；
 *   direct    已签收、走直邮、还没打包的，按客户分组，标出地址有没有着落。
 */
jpRoutes.get('/overview', async (c) => {
  const db = c.env.DB;
  const inboundRows = await db
    .prepare(
      `SELECT ${ITEM_COLUMNS} FROM items i JOIN customers c ON c.id = i.customer_id
        WHERE i.status = 'ordered' ORDER BY i.batch_id, i.route DESC, c.nickname, i.id`,
    )
    .all<JpItem>();
  const batchIds = [...new Set(inboundRows.results.map((i) => i.batchId))];
  const batches = batchIds.length
    ? (
        await db
          .prepare(
            `SELECT id, name, order_no AS orderNo, japan_tracking_no AS japanTrackingNo, created_at AS createdAt
               FROM batches WHERE id IN (${placeholders(batchIds.length)}) ORDER BY id`,
          )
          .bind(...batchIds)
          .all<{ id: number; name: string; orderNo: string | null; japanTrackingNo: string | null; createdAt: string }>()
      ).results
    : [];

  const boxRows = await db
    .prepare(
      `SELECT p.id, p.name, p.tracking_no AS trackingNo, p.status,
              SUM(i.status = 'jp_warehouse') AS received,
              SUM(i.status = 'ordered') AS waiting
         FROM packages p JOIN items i ON i.package_id = p.id
        WHERE p.allocated_at IS NULL AND p.status IN ('ordered', 'jp_warehouse')
          AND i.status IN ('ordered', 'jp_warehouse') AND i.sorted_at IS NOT NULL
        GROUP BY p.id ORDER BY p.id`,
    )
    .all<{ id: number; name: string; trackingNo: string | null; status: string; received: number; waiting: number }>();
  const boxIds = boxRows.results.map((b) => b.id);
  const boxItems = boxIds.length
    ? (
        await db
          .prepare(
            `SELECT ${ITEM_COLUMNS} FROM items i JOIN customers c ON c.id = i.customer_id
              WHERE i.package_id IN (${placeholders(boxIds.length)}) AND i.status IN ('ordered', 'jp_warehouse') AND i.sorted_at IS NOT NULL
              ORDER BY c.nickname, i.id`,
          )
          .bind(...boxIds)
          .all<JpItem>()
      ).results
    : [];

  const directRows = await db
    .prepare(
      `SELECT ${ITEM_COLUMNS}, i.import_address AS importAddress, c.direct_address_id AS directAddressId
         FROM items i JOIN customers c ON c.id = i.customer_id
        WHERE i.route = 'direct' AND i.status = 'jp_warehouse' AND i.direct_parcel_id IS NULL
        ORDER BY c.nickname, i.id`,
    )
    .all<JpItem & { importAddress: string | null; directAddressId: number | null }>();
  const customerIds = [...new Set(directRows.results.map((i) => i.customerId))];
  const addressCounts = customerIds.length
    ? (
        await db
          .prepare(
            `SELECT customer_id AS customerId, COUNT(*) AS n,
                    SUM(id = (SELECT direct_address_id FROM customers WHERE id = customer_id)) AS chosen
               FROM addresses WHERE customer_id IN (${placeholders(customerIds.length)}) GROUP BY customer_id`,
          )
          .bind(...customerIds)
          .all<{ customerId: number; n: number; chosen: number }>()
      ).results
    : [];
  const direct = customerIds.map((customerId) => {
    const list = directRows.results.filter((i) => i.customerId === customerId);
    const counts = addressCounts.find((a) => a.customerId === customerId);
    const importAddress = list.find((i) => i.importAddress)?.importAddress ?? null;
    // 地址的着落：导入表写了 > 客户选定了 > 客户只存了一个地址（自动用它）
    const addressReady = !!importAddress || !!counts?.chosen || counts?.n === 1;
    return {
      customerId,
      nickname: list[0].nickname,
      addressReady,
      addressSource: importAddress ? 'import' : counts?.chosen || counts?.n === 1 ? 'customer' : null,
      items: list.map(shape),
    };
  });

  return c.json({
    inbound: batches.map((b) => ({
      ...b,
      items: inboundRows.results.filter((i) => i.batchId === b.id).map(shape),
    })),
    boxes: boxRows.results.map((b) => ({
      ...b,
      items: boxItems.filter((i) => i.packageId === b.id).map(shape),
    })),
    direct,
  });
});

/** 回国箱里还没签收的件都签收了，箱子状态跟着变成「已到日本仓」。 */
function syncBoxStatus(db: D1Database, packageIds: number[]): D1PreparedStatement[] {
  return packageIds.map((id) =>
    db
      .prepare(
        `UPDATE packages SET status = 'jp_warehouse'
          WHERE id = ? AND status = 'ordered' AND allocated_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM items WHERE package_id = ? AND status = 'ordered')`,
      )
      .bind(id, id),
  );
}

/** 到货签收：已下单 → 已到日本仓。可以一件件点，也可以整单一起。 */
jpRoutes.post('/receive', async (c) => {
  const body = await readJson<{ itemIds?: unknown }>(c);
  const itemIds = [...new Set(intList(body.itemIds, '物品 ID'))];
  const db = c.env.DB;
  const rows = await db
    .prepare(`SELECT id, status, package_id AS packageId FROM items WHERE id IN (${placeholders(itemIds.length)})`)
    .bind(...itemIds)
    .all<{ id: number; status: string; packageId: number | null }>();
  if (rows.results.length !== itemIds.length) throw badRequest('有的件已经不在系统里了，刷新页面再签收');
  const todo = rows.results.filter((r) => r.status === 'ordered');
  const at = nowIso();
  const statements: D1PreparedStatement[] = todo.flatMap((r) => [
    db.prepare("UPDATE items SET status = 'jp_warehouse', updated_at = ? WHERE id = ? AND status = 'ordered'").bind(at, r.id),
    statusLogStmt(db, r.id, 'ordered', 'jp_warehouse', at, staffOf(c).name),
  ]);
  const boxes = [...new Set(todo.map((r) => r.packageId).filter((id): id is number => id !== null))];
  statements.push(...syncBoxStatus(db, boxes));
  if (statements.length) await db.batch(statements);
  return c.json({ ok: true, received: todo.length, skipped: itemIds.length - todo.length });
});

async function requireBatch(db: D1Database, value: unknown): Promise<number> {
  const batchId = requireInt(value, '日本订单 ID');
  if (!(await db.prepare('SELECT id FROM batches WHERE id = ?').bind(batchId).first())) throw notFound('没有这个日本订单');
  return batchId;
}

function requireTracking(value: unknown): string {
  const tn = normalizeTrackingNo(typeof value === 'string' ? value : null);
  if (!tn) throw badRequest('日本运单号不能为空（最多 40 位）');
  return tn;
}

/** 补登一个日本快递：骏河屋发货通知里又多了一个单号，管理员没录的，仓库自己加。 */
jpRoutes.post('/shipments', async (c) => {
  const body = await readJson<{ batchId?: unknown; trackingNo?: unknown }>(c);
  const db = c.env.DB;
  const batchId = await requireBatch(db, body.batchId);
  const tn = requireTracking(body.trackingNo);
  await db.batch(registerStmts(db, batchId, [tn], nowIso()));
  return c.json({ ok: true, trackingNo: tn });
});

/**
 * 这个快递到了：先签收、晚点再分拣也行。表里写着这个运单号、还没签收的件一起变「已到日本仓」。
 * 没写运单号的件不知道在不在这个快递里，不动，分拣时点到才算。
 */
jpRoutes.post('/shipments/arrive', async (c) => {
  const body = await readJson<{ batchId?: unknown; trackingNo?: unknown }>(c);
  const db = c.env.DB;
  const batchId = await requireBatch(db, body.batchId);
  const tn = requireTracking(body.trackingNo);
  const staff = staffOf(c);
  const at = nowIso();
  const todo = await db
    .prepare(
      `SELECT id, package_id AS packageId FROM items
        WHERE batch_id = ? AND jp_tracking_no = ? AND status = 'ordered' AND missing = 0 AND direct_parcel_id IS NULL`,
    )
    .bind(batchId, tn)
    .all<{ id: number; packageId: number | null }>();
  await db.batch([
    ...arriveStmts(db, batchId, tn, staff.name, at),
    ...todo.results.flatMap((r) => [
      db.prepare("UPDATE items SET status = 'jp_warehouse', updated_at = ? WHERE id = ? AND status = 'ordered'").bind(at, r.id),
      statusLogStmt(db, r.id, 'ordered', 'jp_warehouse', at, staff.name),
    ]),
  ]);
  return c.json({ ok: true, trackingNo: tn, received: todo.results.length });
});

/** 点错了「到了」：还没分拣过这一箱才能撤，件退回「已下单」。 */
jpRoutes.post('/shipments/unarrive', async (c) => {
  const body = await readJson<{ batchId?: unknown; trackingNo?: unknown }>(c);
  const db = c.env.DB;
  const batchId = await requireBatch(db, body.batchId);
  const tn = requireTracking(body.trackingNo);
  const sorted = await db
    .prepare('SELECT COUNT(*) AS n FROM items WHERE batch_id = ? AND jp_tracking_no = ? AND sorted_at IS NOT NULL')
    .bind(batchId, tn)
    .first<{ n: number }>();
  if (sorted?.n) throw badRequest(`这个快递已经分拣过 ${sorted.n} 件了，不能撤；签错的件在回国箱里一件件点「签错了」`);
  const staff = staffOf(c);
  const at = nowIso();
  const back = await db
    .prepare(
      `SELECT id FROM items WHERE batch_id = ? AND jp_tracking_no = ? AND status = 'jp_warehouse'
          AND sorted_at IS NULL AND direct_parcel_id IS NULL`,
    )
    .bind(batchId, tn)
    .all<{ id: number }>();
  await db.batch([
    db.prepare('UPDATE jp_shipments SET arrived_at = NULL, arrived_by = NULL WHERE batch_id = ? AND tracking_no = ?').bind(batchId, tn),
    ...back.results.flatMap((r) => [
      db.prepare("UPDATE items SET status = 'ordered', updated_at = ? WHERE id = ?").bind(at, r.id),
      statusLogStmt(db, r.id, 'jp_warehouse', 'ordered', at, staff.name),
    ]),
  ]);
  return c.json({ ok: true, count: back.results.length });
});

/**
 * 日本仓发出的箱子分空了就收掉：没有件、没有称重组、只属于这一单、还没发出也没算费。
 * 分拣发送和「退回 / 缺件」都会把件从箱子里拿走，留个空箱挂在后台只会让人以为还有东西没发。
 */
export async function dropEmptyBoxes(db: D1Database, packageIds: number[]): Promise<void> {
  const ids = [...new Set(packageIds)];
  if (!ids.length) return;
  const empties = await db
    .prepare(
      `SELECT p.id FROM packages p
        WHERE p.id IN (${placeholders(ids.length)}) AND p.allocated_at IS NULL AND p.status IN ('ordered', 'jp_warehouse')
          AND NOT EXISTS (SELECT 1 FROM items WHERE package_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM weigh_groups WHERE package_id = p.id)`,
    )
    .bind(...ids)
    .all<{ id: number }>();
  if (!empties.results.length) return;
  await db.batch(
    empties.results.flatMap((p) => [
      db.prepare('DELETE FROM package_batches WHERE package_id = ?').bind(p.id),
      db.prepare('DELETE FROM packages WHERE id = ?').bind(p.id),
    ]),
  );
}

/**
 * 签错了退回 / 标缺件（同一个口子，missing 决定要不要挂「缺件」）。
 *
 *   已到日本仓、还没打包也没发出的件：退回「已下单」、撤掉分拣、从还没发的回国箱里拿出来——
 *     等于这件没到过，下一个快递到了它还会出现在分拣页里；
 *   还没签收的件：只改缺件标记（missing=false 就是「找到了，取消缺件」）。
 *
 * 已经装进直邮包裹、称过重、箱子已发出的件不能退：那边已经记账或者出了日本。
 */
jpRoutes.post('/unreceive', async (c) => {
  const body = await readJson<{ itemIds?: unknown; missing?: unknown }>(c);
  const itemIds = [...new Set(intList(body.itemIds, '物品 ID'))];
  if (itemIds.length > 500) throw badRequest('一次最多 500 件');
  if (body.missing !== undefined && typeof body.missing !== 'boolean') throw badRequest('missing 要是 true / false');
  const missing = body.missing === true;
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT i.id, i.title, i.status, i.package_id AS packageId, i.direct_parcel_id AS parcelId,
              i.weigh_group_id AS weighGroupId, p.status AS boxStatus, p.allocated_at AS boxAllocated
         FROM items i LEFT JOIN packages p ON p.id = i.package_id
        WHERE i.id IN (${placeholders(itemIds.length)})`,
    )
    .bind(...itemIds)
    .all<{
      id: number;
      title: string;
      status: string;
      packageId: number | null;
      parcelId: number | null;
      weighGroupId: number | null;
      boxStatus: string | null;
      boxAllocated: string | null;
    }>();
  if (rows.results.length !== itemIds.length) throw badRequest('有的件已经不在系统里了，刷新页面再试');
  const locked = rows.results.filter(
    (r) =>
      !['ordered', 'jp_warehouse'].includes(r.status) ||
      r.parcelId ||
      r.weighGroupId ||
      (r.packageId && (r.boxAllocated || !['ordered', 'jp_warehouse'].includes(r.boxStatus ?? ''))),
  );
  if (locked.length) {
    throw badRequest(
      `「${locked[0].title}」${locked.length > 1 ? `等 ${locked.length} 件` : ''}已经打进直邮包裹、称过重或者箱子已经发出了，不能退回。直邮包裹先拆包再退`,
      { itemIds: locked.map((r) => r.id) },
    );
  }
  const staff = staffOf(c);
  const at = nowIso();
  const note = missing ? `日本仓标缺件（${staff.name}）` : null;
  const statements: D1PreparedStatement[] = [];
  for (const r of rows.results) {
    statements.push(
      db
        .prepare(
          `UPDATE items SET status = 'ordered', sorted_at = NULL, sort_session_id = NULL, sort_found_at = NULL, sort_found_by = NULL,
                  package_id = CASE WHEN status = 'jp_warehouse' THEN NULL ELSE package_id END,
                  missing = ?, exception_note = CASE WHEN ? THEN ? ELSE exception_note END, updated_at = ?
            WHERE id = ?`,
        )
        .bind(missing ? 1 : 0, missing ? 1 : 0, note, at, r.id),
    );
    if (r.status === 'jp_warehouse') statements.push(statusLogStmt(db, r.id, 'jp_warehouse', 'ordered', at, staff.name));
  }
  await db.batch(statements);
  await dropEmptyBoxes(
    db,
    rows.results.filter((r) => r.status === 'jp_warehouse' && r.packageId).map((r) => r.packageId as number),
  );
  return c.json({
    ok: true,
    count: rows.results.length,
    returned: rows.results.filter((r) => r.status === 'jp_warehouse').length,
    missing,
  });
});

/**
 * 回国箱封箱发出：填回国单号，箱里已签收的件变「回国中」。
 * 箱里还有没签收的件就拦下——发出去以后它们就对不上了：先签收，真没到的告诉管理员（标缺货或挪箱）。
 */
jpRoutes.post('/boxes/:id/ship', async (c) => {
  const id = requireInt(c.req.param('id'), '回国箱 ID');
  const body = await readJson<{ trackingNo?: unknown }>(c);
  const trackingNo = bound(requireString(body.trackingNo, '回国单号'), '回国单号', 60) as string;
  const db = c.env.DB;
  const pkg = await db
    .prepare('SELECT id, status, allocated_at AS allocatedAt FROM packages WHERE id = ?')
    .bind(id)
    .first<{ id: number; status: string; allocatedAt: string | null }>();
  if (!pkg) throw notFound('没有这个回国箱');
  if (pkg.allocatedAt || !['ordered', 'jp_warehouse'].includes(pkg.status)) {
    throw badRequest('这个箱子已经发出或者算过运费了');
  }
  const items = await db
    .prepare("SELECT id, status FROM items WHERE package_id = ? AND status IN ('ordered', 'jp_warehouse')")
    .bind(id)
    .all<{ id: number; status: string }>();
  const waiting = items.results.filter((i) => i.status === 'ordered').length;
  if (waiting) {
    throw badRequest(`箱里还有 ${waiting} 件没签收。先签收；真没到的告诉管理员标缺货或挪到别的箱，再发出`, { waiting });
  }
  if (!items.results.length) throw badRequest('箱子是空的，没东西可发');
  const at = nowIso();
  await db.batch([
    db.prepare("UPDATE packages SET status = 'intl_transit', tracking_no = ? WHERE id = ?").bind(trackingNo, id),
    ...items.results.flatMap((i) => [
      db.prepare("UPDATE items SET status = 'intl_transit', updated_at = ? WHERE id = ?").bind(at, i.id),
      statusLogStmt(db, i.id, i.status, 'intl_transit', at, staffOf(c).name),
    ]),
  ]);
  return c.json({ ok: true, count: items.results.length });
});
