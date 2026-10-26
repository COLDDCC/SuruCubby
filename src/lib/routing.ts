/**
 * 发货路线（拼团 / 直邮）的改动规则，管理员改、导入、测试都走这一处。
 *
 * 能改的前提：东西还在日本这一侧、没有进任何账——
 *   状态是「已下单」或「已到日本仓」，没称重、没装进直邮包裹、没寄出、没申请发货。
 * 改成直邮：从回国箱里拿出来（package_id 置空）；
 * 改成拼团：放回这一批的回国箱（还没算运费、还没发出的那个），没有就新建一个「（补）」箱。
 */
import { nextId, nowIso } from './db.ts';
import { badRequest } from './http.ts';
import type { Route } from './status.ts';

interface ItemRow {
  id: number;
  batchId: number;
  status: string;
  route: string;
  weighGroupId: number | null;
  parcelId: number | null;
  shipmentId: number | null;
  requested: number;
}

export async function changeRoute(db: D1Database, itemIds: number[], route: Route): Promise<{ changed: number; packageIds: number[] }> {
  const marks = itemIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT i.id, i.batch_id AS batchId, i.status, i.route, i.weigh_group_id AS weighGroupId,
              i.direct_parcel_id AS parcelId, i.shipment_id AS shipmentId,
              EXISTS (SELECT 1 FROM request_items ri WHERE ri.item_id = i.id) AS requested
         FROM items i WHERE i.id IN (${marks})`,
    )
    .bind(...itemIds)
    .all<ItemRow>();
  if (rows.results.length !== itemIds.length) throw badRequest('有的件已经不在系统里了，刷新页面再改');

  const locked = rows.results.filter(
    (r) =>
      !['ordered', 'jp_warehouse'].includes(r.status) || r.weighGroupId || r.parcelId || r.shipmentId || r.requested,
  );
  if (locked.length) {
    throw badRequest(
      `有 ${locked.length} 件已经装箱称重、打进直邮包裹或者发出了，不能再改发货方式（只有「已下单」「已到日本仓」且没装箱的件能改）`,
      { itemIds: locked.map((r) => r.id) },
    );
  }

  const todo = rows.results.filter((r) => r.route !== route);
  if (!todo.length) return { changed: 0, packageIds: [] };
  const at = nowIso();
  const statements: D1PreparedStatement[] = [];

  if (route === 'direct') {
    for (const r of todo) {
      statements.push(
        db.prepare("UPDATE items SET route = 'direct', package_id = NULL, updated_at = ? WHERE id = ?").bind(at, r.id),
      );
    }
    await db.batch(statements);
    return { changed: todo.length, packageIds: [] };
  }

  // 改回拼团：每一批找一个还开着的回国箱
  const byBatch = new Map<number, ItemRow[]>();
  for (const r of todo) byBatch.set(r.batchId, [...(byBatch.get(r.batchId) ?? []), r]);
  let newPackageId = await nextId(db, 'packages');
  const packageIds: number[] = [];
  for (const [batchId, list] of byBatch) {
    const open = await db
      .prepare(
        `SELECT p.id FROM packages p JOIN package_batches pb ON pb.package_id = p.id
          WHERE pb.batch_id = ? AND p.allocated_at IS NULL AND p.status IN ('ordered', 'jp_warehouse')
          ORDER BY p.id LIMIT 1`,
      )
      .bind(batchId)
      .first<{ id: number }>();
    let packageId = open?.id;
    if (!packageId) {
      const batch = await db.prepare('SELECT name FROM batches WHERE id = ?').bind(batchId).first<{ name: string }>();
      packageId = newPackageId;
      newPackageId += 1;
      statements.push(
        db
          .prepare('INSERT INTO packages (id, name, status, created_at) VALUES (?, ?, ?, ?)')
          .bind(packageId, `${batch?.name ?? `批次 ${batchId}`}（补）`, 'ordered', at),
        db.prepare('INSERT INTO package_batches (package_id, batch_id) VALUES (?, ?)').bind(packageId, batchId),
      );
    }
    packageIds.push(packageId);
    for (const r of list) {
      statements.push(
        db.prepare("UPDATE items SET route = 'group', package_id = ?, updated_at = ? WHERE id = ?").bind(packageId, at, r.id),
      );
    }
  }
  await db.batch(statements);
  return { changed: todo.length, packageIds };
}
