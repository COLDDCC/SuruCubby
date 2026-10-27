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
          AND i.status IN ('ordered', 'jp_warehouse')
        GROUP BY p.id ORDER BY p.id`,
    )
    .all<{ id: number; name: string; trackingNo: string | null; status: string; received: number; waiting: number }>();
  const boxIds = boxRows.results.map((b) => b.id);
  const boxItems = boxIds.length
    ? (
        await db
          .prepare(
            `SELECT ${ITEM_COLUMNS} FROM items i JOIN customers c ON c.id = i.customer_id
              WHERE i.package_id IN (${placeholders(boxIds.length)}) AND i.status IN ('ordered', 'jp_warehouse')
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

/** 点错了签收，退回「已下单」。已经装进直邮包裹、或箱子已经发出的不能退。 */
jpRoutes.post('/unreceive', async (c) => {
  const body = await readJson<{ itemIds?: unknown }>(c);
  const itemIds = [...new Set(intList(body.itemIds, '物品 ID'))];
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT id, status, package_id AS packageId, direct_parcel_id AS parcelId, weigh_group_id AS weighGroupId
         FROM items WHERE id IN (${placeholders(itemIds.length)})`,
    )
    .bind(...itemIds)
    .all<{ id: number; status: string; packageId: number | null; parcelId: number | null; weighGroupId: number | null }>();
  const bad = rows.results.filter((r) => r.status !== 'jp_warehouse' || r.parcelId || r.weighGroupId);
  if (bad.length || rows.results.length !== itemIds.length) {
    throw badRequest('只有「已到日本仓」、还没打包的件能退回未签收');
  }
  const at = nowIso();
  const statements: D1PreparedStatement[] = rows.results.flatMap((r) => [
    db.prepare("UPDATE items SET status = 'ordered', updated_at = ? WHERE id = ?").bind(at, r.id),
    statusLogStmt(db, r.id, 'jp_warehouse', 'ordered', at, staffOf(c).name),
  ]);
  for (const id of new Set(rows.results.map((r) => r.packageId).filter((x): x is number => x !== null))) {
    statements.push(
      db.prepare("UPDATE packages SET status = 'ordered' WHERE id = ? AND status = 'jp_warehouse' AND allocated_at IS NULL").bind(id),
    );
  }
  await db.batch(statements);
  return c.json({ ok: true, count: rows.results.length });
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
