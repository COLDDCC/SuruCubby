import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import {
  badRequest,
  intList,
  notFound,
  optionalString,
  readJson,
  requireInt,
  requireString,
  placeholders,
} from '../../lib/http.ts';
import { nextId, nowIso, statusLogStmt } from '../../lib/db.ts';
import { BULK_SKIP_STATUSES, PACKAGE_BULK_STATUSES, isItemStatus } from '../../lib/status.ts';
import { weighRoutes } from './weigh.ts';

export const packageRoutes = new Hono<{ Bindings: Env }>();

packageRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.status, p.tracking_no AS trackingNo, p.total_fee_fen AS totalFeeFen,
            p.total_weight_g AS totalWeightG, p.allocated_at AS allocatedAt, p.created_at AS createdAt,
            (SELECT COUNT(*) FROM items i WHERE i.package_id = p.id) AS itemCount,
            (SELECT COUNT(DISTINCT i.customer_id) FROM items i WHERE i.package_id = p.id) AS customerCount
       FROM packages p
      ORDER BY p.id DESC`,
  ).all();
  return c.json({ packages: rows.results });
});

packageRoutes.post('/', async (c) => {
  const body = await readJson<{ name?: string; batchIds?: number[] }>(c);
  const name = requireString(body.name, '包裹名');
  const db = c.env.DB;
  const id = await nextId(db, 'packages');
  const statements = [
    db
      .prepare('INSERT INTO packages (id, name, status, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, name, 'ordered', nowIso()),
  ];
  for (const batchId of body.batchIds ?? []) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO package_batches (package_id, batch_id) VALUES (?, ?)')
        .bind(id, requireInt(batchId, '批次 ID')),
    );
  }
  await db.batch(statements);
  return c.json({ id });
});

packageRoutes.get('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const pkg = await c.env.DB.prepare(
    `SELECT id, name, status, tracking_no AS trackingNo, total_fee_fen AS totalFeeFen,
            total_weight_g AS totalWeightG, allocated_at AS allocatedAt, created_at AS createdAt
       FROM packages WHERE id = ?`,
  )
    .bind(id)
    .first();
  if (!pkg) throw notFound('包裹不存在');

  const items = await c.env.DB.prepare(
    `SELECT i.id, i.customer_id AS customerId, c.nickname, c.qq, i.title, i.image_url AS imageUrl,
            i.product_url AS productUrl,
            i.status, i.goods_fee_jpy AS goodsFeeJpy, i.missing, i.exception_note AS exceptionNote,
            i.weigh_group_id AS weighGroupId, i.batch_id AS batchId
       FROM items i
       JOIN customers c ON c.id = i.customer_id
      WHERE i.package_id = ?
      ORDER BY c.nickname, i.id`,
  )
    .bind(id)
    .all();

  const batches = await c.env.DB.prepare(
    `SELECT b.id, b.name FROM batches b
       JOIN package_batches pb ON pb.batch_id = b.id
      WHERE pb.package_id = ?`,
  )
    .bind(id)
    .all();

  const rounding = await c.env.DB.prepare('SELECT diff_fen AS diffFen FROM rounding_logs WHERE package_id = ?')
    .bind(id)
    .first();

  return c.json({ package: pkg, items: items.results, batches: batches.results, rounding });
});

packageRoutes.patch('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const body = await readJson<{ name?: string; trackingNo?: string }>(c);
  await c.env.DB.prepare(
    'UPDATE packages SET name = COALESCE(?, name), tracking_no = COALESCE(?, tracking_no) WHERE id = ?',
  )
    .bind(optionalString(body.name), optionalString(body.trackingNo), id)
    .run();
  if (optionalString(body.trackingNo)) {
    const pkg = await c.env.DB.prepare('SELECT allocated_at AS a FROM packages WHERE id=?')
      .bind(id)
      .first<{ a: string | null }>();
    if (pkg && !pkg.a) {
      const rows = await c.env.DB.prepare(
        "SELECT id,status FROM items WHERE package_id=? AND status IN ('ordered','jp_warehouse','intl_transit','cn_arrived')",
      )
        .bind(id)
        .all<{ id: number; status: string }>();
      const at = nowIso();
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE packages SET status='intl_transit' WHERE id=?").bind(id),
        ...rows.results.flatMap((i) => [
          c.env.DB.prepare("UPDATE items SET status='intl_transit',updated_at=? WHERE id=?").bind(at, i.id),
          statusLogStmt(c.env.DB, i.id, i.status, 'intl_transit', at),
        ]),
      ]);
    }
  }
  return c.json({ ok: true });
});

/** 批量改包裹状态：包裹内所有物品同步变更（跳过取消/退款/已称重之后的）。 */
packageRoutes.post('/:id/status', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const body = await readJson<{ status?: string }>(c);
  const status = requireString(body.status, '状态');
  if (!isItemStatus(status)) throw badRequest(`未知状态：${status}`);
  if (!PACKAGE_BULK_STATUSES.includes(status)) {
    throw badRequest(`「${status}」不能在包裹层面批量设置，可发货之后的状态由称重 / 寄出流程推进`);
  }
  const db = c.env.DB;
  const pkg = await db.prepare('SELECT id FROM packages WHERE id = ?').bind(id).first();
  if (!pkg) throw notFound('包裹不存在');

  const items = await db
    .prepare(
      `SELECT id, status FROM items
        WHERE package_id = ? AND status NOT IN (${placeholders(BULK_SKIP_STATUSES.length)}) AND status != ?`,
    )
    .bind(id, ...BULK_SKIP_STATUSES, status)
    .all<{ id: number; status: string }>();

  const at = nowIso();
  const statements: D1PreparedStatement[] = [
    db.prepare('UPDATE packages SET status = ? WHERE id = ?').bind(status, id),
  ];
  for (const item of items.results) {
    statements.push(
      db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').bind(status, at, item.id),
      statusLogStmt(db, item.id, item.status, status, at),
    );
  }
  await db.batch(statements);

  const skipped = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM items
        WHERE package_id = ? AND status IN (${placeholders(BULK_SKIP_STATUSES.length)})`,
    )
    .bind(id, ...BULK_SKIP_STATUSES)
    .first<{ count: number }>();

  return c.json({ status, updated: items.results.length, skipped: skipped?.count ?? 0 });
});

/** 调整包裹包含的批次（同时把这些批次里还没进包裹的物品挂进来）。 */
packageRoutes.post('/:id/batches', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const body = await readJson<{ batchIds?: unknown; moveItems?: boolean }>(c);
  const batchIds = Array.isArray(body.batchIds) ? body.batchIds.map((v) => requireInt(v, '批次 ID')) : [];
  const db = c.env.DB;
  await assertMovable(db, id, undefined, batchIds);
  const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM package_batches WHERE package_id = ?').bind(id)];
  for (const batchId of batchIds) {
    statements.push(
      db.prepare('INSERT OR IGNORE INTO package_batches (package_id, batch_id) VALUES (?, ?)').bind(id, batchId),
    );
    if (body.moveItems !== false) {
      statements.push(
        db
          .prepare(
            `UPDATE items SET package_id = ?, weigh_group_id=NULL, weight_g=NULL, intl_fee_fen=NULL, updated_at = ?
              WHERE batch_id = ? AND (package_id IS NULL OR status IN ('ordered','jp_warehouse','intl_transit','cn_arrived'))`,
          )
          .bind(id, nowIso(), batchId),
      );
    }
  }
  await db.batch(statements);
  return c.json({ ok: true, batchIds });
});

/** 把指定物品移入 / 移出包裹。 */
packageRoutes.post('/:id/items', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const body = await readJson<{ itemIds?: unknown; action?: string }>(c);
  const itemIds = intList(body.itemIds, '物品 ID');
  const action = body.action === 'remove' ? 'remove' : 'add';
  const at = nowIso();
  const db = c.env.DB;
  await assertMovable(db, id, itemIds);
  const statements = itemIds.map((itemId) =>
    action === 'add'
      ? db
          .prepare(
            'UPDATE items SET package_id = ?, weigh_group_id=NULL, weight_g=NULL, intl_fee_fen=NULL, updated_at = ? WHERE id = ?',
          )
          .bind(id, at, itemId)
      : db
          .prepare(
            'UPDATE items SET package_id = NULL, weigh_group_id = NULL, weight_g=NULL, intl_fee_fen=NULL, updated_at = ? WHERE id = ? AND package_id = ?',
          )
          .bind(at, itemId, id),
  );
  await db.batch(statements);
  return c.json({ ok: true, action, count: itemIds.length });
});

async function assertMovable(db: D1Database, target: number, itemIds?: number[], batchIds?: number[]) {
  const pkg = await db
    .prepare('SELECT allocated_at AS a FROM packages WHERE id=?')
    .bind(target)
    .first<{ a: string | null }>();
  if (!pkg) throw notFound('包裹不存在');
  if (pkg.a) throw badRequest('目标包裹已计费，不能改商品');
  const ids = itemIds ?? batchIds ?? [];
  if (!ids.length) return;
  const rows = await db
    .prepare(
      `SELECT i.id, (i.status IN ('shipped','delivered')) AS handed FROM items i LEFT JOIN packages p ON p.id=i.package_id WHERE ${itemIds ? 'i.id' : 'i.batch_id'} IN (${placeholders(ids.length)}) AND (p.allocated_at IS NOT NULL OR i.shipment_id IS NOT NULL OR i.status IN ('shipped','delivered') OR EXISTS(SELECT 1 FROM request_items ri WHERE ri.item_id=i.id))`,
    )
    .bind(...ids)
    .all<{ id: number; handed: number }>();
  // 已经不在这条链上的货（寄出过、或不拼邮当面结掉的）挪它只会把物流记录搞乱
  if (rows.results.some((r) => r.handed)) throw badRequest('有东西已经寄出或当面签收过了，不用再挪包裹');
  if (rows.results.length) throw badRequest('有物品已计费或已申请发货，请先撤销对应流程');
}
packageRoutes.route('/', weighRoutes);
