import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, notFound, optionalString, readJson, requireInt } from '../../lib/http.ts';
import { nextId, nowIso, statusLogStmt, intlPriceFenPerKg } from '../../lib/db.ts';
import { allocate, feeFromWeight } from '../../lib/allocate.ts';
import { toFen } from '../../lib/money.ts';

export const weighRoutes = new Hono<{ Bindings: Env }>();

interface PackageRow {
  id: number;
  name: string;
  status: string;
  totalFeeFen: number | null;
  totalWeightG: number | null;
  allocatedAt: string | null;
}

async function loadPackage(env: Env, id: number): Promise<PackageRow> {
  const pkg = await env.DB.prepare(
    `SELECT id, name, status, total_fee_fen AS totalFeeFen, total_weight_g AS totalWeightG,
            allocated_at AS allocatedAt
       FROM packages WHERE id = ?`,
  )
    .bind(id)
    .first<PackageRow>();
  if (!pkg) throw notFound('包裹不存在');
  return pkg;
}

/** 取得（必要时创建）某包裹里某客户的称重组。 */
async function ensureGroup(env: Env, packageId: number, customerId: number): Promise<number> {
  const existing = await env.DB.prepare(
    'SELECT id FROM weigh_groups WHERE package_id = ? AND customer_id = ?',
  )
    .bind(packageId, customerId)
    .first<{ id: number }>();
  if (existing) return existing.id;
  const id = await nextId(env.DB, 'weigh_groups');
  await env.DB.prepare(
    'INSERT INTO weigh_groups (id, package_id, customer_id) VALUES (?, ?, ?)',
  )
    .bind(id, packageId, customerId)
    .run();
  return id;
}

function ensureNotAllocated(pkg: PackageRow): void {
  if (pkg.allocatedAt) {
    throw badRequest('这个包裹已经分摊过运费了，要改请先「撤销分摊」');
  }
}

weighRoutes.get('/:id/weigh', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const pkg = await loadPackage(c.env, id);

  const items = await c.env.DB.prepare(
    `SELECT i.id, i.customer_id AS customerId, c.nickname, c.qq, i.title, i.image_url AS imageUrl,
            i.product_url AS productUrl, i.status, i.missing, i.exception_note AS exceptionNote,
            i.weigh_group_id AS weighGroupId, i.goods_fee_jpy AS goodsFeeJpy, i.weight_g AS weightG
       FROM items i
       JOIN customers c ON c.id = i.customer_id
      WHERE i.package_id = ? AND i.status NOT IN ('cancelled', 'refunded')
      ORDER BY c.nickname, i.id`,
  )
    .bind(id)
    .all<{
      id: number;
      customerId: number;
      nickname: string;
      qq: string;
      title: string;
      imageUrl: string | null;
      productUrl: string | null;
      status: string;
      missing: number;
      exceptionNote: string | null;
      weighGroupId: number | null;
      goodsFeeJpy: number;
    }>();

  const groups = await c.env.DB.prepare(
    `SELECT id, customer_id AS customerId, weight_g AS weightG, intl_fee_fen AS intlFeeFen,
            fee_paid AS feePaid
       FROM weigh_groups WHERE package_id = ?`,
  )
    .bind(id)
    .all<{
      id: number;
      customerId: number;
      weightG: number | null;
      intlFeeFen: number | null;
      feePaid: number;
    }>();
  const groupByCustomer = new Map(groups.results.map((g) => [g.customerId, g]));

  const byCustomer = new Map<
    number,
    {
      customerId: number;
      nickname: string;
      qq: string;
      items: typeof items.results;
      weightG: number | null;
      intlFeeFen: number | null;
      feePaid: number;
      expected: number;
      found: number;
      missing: number;
    }
  >();
  for (const item of items.results) {
    let entry = byCustomer.get(item.customerId);
    if (!entry) {
      const group = groupByCustomer.get(item.customerId);
      entry = {
        customerId: item.customerId,
        nickname: item.nickname,
        qq: item.qq,
        items: [],
        weightG: group?.weightG ?? null,
        intlFeeFen: group?.intlFeeFen ?? null,
        feePaid: group?.feePaid ?? 0,
        expected: 0,
        found: 0,
        missing: 0,
      };
      byCustomer.set(item.customerId, entry);
    }
    entry.items.push(item);
    entry.expected += 1;
    if (item.missing) entry.missing += 1;
    else if (item.weighGroupId) entry.found += 1;
  }

  const customers = [...byCustomer.values()].sort((a, b) =>
    a.nickname.localeCompare(b.nickname, 'zh-Hans-CN'),
  );
  const expected = items.results.length;
  const found = items.results.filter((i) => i.weighGroupId && !i.missing).length;
  const weighed = customers.filter((c2) => c2.weightG !== null && c2.weightG > 0).length;

  return c.json({
    package: pkg,
    customers,
    intlPriceFenPerKg: await intlPriceFenPerKg(c.env),
    progress: {
      expectedItems: expected,
      foundItems: found,
      missingItems: items.results.filter((i) => i.missing).length,
      weighedCustomers: weighed,
      totalCustomers: customers.length,
    },
  });
});

/** 点封面认领 / 取消认领。 */
weighRoutes.post('/:id/weigh/claim', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const pkg = await loadPackage(c.env, id);
  ensureNotAllocated(pkg);
  const body = await readJson<{ itemId?: unknown; claimed?: boolean }>(c);
  const itemId = requireInt(body.itemId, '物品 ID');
  const claimed = body.claimed !== false;

  const item = await c.env.DB.prepare(
    'SELECT id, customer_id AS customerId, status FROM items WHERE id = ? AND package_id = ?',
  )
    .bind(itemId, id)
    .first<{ id: number; customerId: number; status: string }>();
  if (!item) throw notFound('这件东西不在这个包裹里');
  if (item.status === 'cancelled' || item.status === 'refunded') {
    throw badRequest('已取消 / 已退款的物品不参与称重');
  }

  if (claimed) {
    const groupId = await ensureGroup(c.env, id, item.customerId);
    await c.env.DB.prepare(
      'UPDATE items SET weigh_group_id = ?, missing = 0, updated_at = ? WHERE id = ?',
    )
      .bind(groupId, nowIso(), itemId)
      .run();
    return c.json({ ok: true, claimed: true, weighGroupId: groupId });
  }
  await c.env.DB.prepare('UPDATE items SET weigh_group_id = NULL, updated_at = ? WHERE id = ?')
    .bind(nowIso(), itemId)
    .run();
  return c.json({ ok: true, claimed: false });
});

/** 标记 / 取消「缺件」。 */
weighRoutes.post('/:id/weigh/missing', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const pkg = await loadPackage(c.env, id);
  ensureNotAllocated(pkg);
  const body = await readJson<{ itemId?: unknown; missing?: boolean; note?: string }>(c);
  const itemId = requireInt(body.itemId, '物品 ID');
  const missing = body.missing !== false;
  const note = optionalString(body.note);

  const item = await c.env.DB.prepare('SELECT id FROM items WHERE id = ? AND package_id = ?')
    .bind(itemId, id)
    .first();
  if (!item) throw notFound('这件东西不在这个包裹里');

  if (missing) {
    await c.env.DB.prepare(
      'UPDATE items SET missing = 1, weigh_group_id = NULL, exception_note = ?, updated_at = ? WHERE id = ?',
    )
      .bind(note, nowIso(), itemId)
      .run();
  } else {
    await c.env.DB.prepare('UPDATE items SET missing = 0, updated_at = ? WHERE id = ?')
      .bind(nowIso(), itemId)
      .run();
  }
  return c.json({ ok: true, missing });
});

/** 保存某客户这一摞的重量（可同时一次性提交已找到的物品）。 */
weighRoutes.post('/:id/weigh/group', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const pkg = await loadPackage(c.env, id);
  ensureNotAllocated(pkg);
  const body = await readJson<{ customerId?: unknown; weightG?: unknown; itemIds?: unknown }>(c);
  const customerId = requireInt(body.customerId, '客户 ID');

  let weightG: number | null = null;
  if (body.weightG !== undefined && body.weightG !== null && body.weightG !== '') {
    weightG = requireInt(body.weightG, '重量（克）');
    if (weightG <= 0) throw badRequest('重量要大于 0 克');
  }

  const groupId = await ensureGroup(c.env, id, customerId);
  const at = nowIso();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare('UPDATE weigh_groups SET weight_g = ? WHERE id = ?').bind(weightG, groupId),
  ];

  if (Array.isArray(body.itemIds)) {
    const itemIds = body.itemIds.map((v) => requireInt(v, '物品 ID'));
    statements.push(
      c.env.DB.prepare(
        `UPDATE items SET weigh_group_id = NULL, updated_at = ?
          WHERE package_id = ? AND customer_id = ?`,
      ).bind(at, id, customerId),
    );
    for (const itemId of itemIds) {
      statements.push(
        c.env.DB.prepare(
          `UPDATE items SET weigh_group_id = ?, missing = 0, updated_at = ?
            WHERE id = ? AND package_id = ? AND customer_id = ? AND status NOT IN ('cancelled','refunded')`,
        ).bind(groupId, at, itemId, id, customerId),
      );
    }
  }

  await c.env.DB.batch(statements);
  return c.json({ ok: true, weighGroupId: groupId, weightG });
});

interface AllocateBody {
  totalFeeFen?: unknown;
  totalFeeYuan?: unknown;
  totalWeightG?: unknown;
}

async function buildAllocation(env: Env, packageId: number, body: AllocateBody) {
  let totalFeeFen: number | null = null;
  if (body.totalFeeFen !== undefined && body.totalFeeFen !== null && body.totalFeeFen !== '') {
    totalFeeFen = requireInt(body.totalFeeFen, '国际运费（分）');
  } else if (body.totalFeeYuan !== undefined && body.totalFeeYuan !== null && body.totalFeeYuan !== '') {
    totalFeeFen = toFen(body.totalFeeYuan);
  }
  if (totalFeeFen !== null && totalFeeFen < 0) throw badRequest('国际运费不能是负数');

  const groups = await env.DB.prepare(
    `SELECT g.id, g.customer_id AS customerId, c.nickname, c.qq, g.weight_g AS weightG,
            (SELECT COUNT(*) FROM items i WHERE i.weigh_group_id = g.id AND i.missing = 0) AS itemCount
       FROM weigh_groups g
       JOIN customers c ON c.id = g.customer_id
      WHERE g.package_id = ?
      ORDER BY c.nickname`,
  )
    .bind(packageId)
    .all<{
      id: number;
      customerId: number;
      nickname: string;
      qq: string;
      weightG: number | null;
      itemCount: number;
    }>();

  const unfinished=await env.DB.prepare(`SELECT COUNT(*) AS n FROM items WHERE package_id=? AND missing=0 AND status NOT IN ('cancelled','refunded','shipped','delivered') AND weigh_group_id IS NULL`).bind(packageId).first<{n:number}>();
  if(unfinished?.n) throw badRequest('还有商品未称重或未明确标记缺件，不能确认费用');
  const weighedUnits=await env.DB.prepare(`SELECT weigh_group_id AS gid, SUM(weight_g) AS w,COUNT(*) AS n,COUNT(weight_g) AS weighted FROM items WHERE package_id=? AND missing=0 AND status NOT IN ('cancelled','refunded','shipped','delivered') GROUP BY weigh_group_id`).bind(packageId).all<{gid:number;w:number;n:number;weighted:number}>();
  for(const u of weighedUnits.results){if(u.weighted>0 && u.weighted!==u.n) throw badRequest('还有商品未填写重量');if(u.weighted===u.n){const g=groups.results.find(g=>g.id===u.gid);if(g)g.weightG=u.w;}}
  const usable = groups.results.filter((g) => g.itemCount > 0);
  const notWeighed = usable.filter((g) => !g.weightG || g.weightG <= 0);
  if (usable.length === 0) throw badRequest('还没有任何已认领的物品，不能分摊');
  if (notWeighed.length > 0) {
    throw badRequest(
      `还有 ${notWeighed.length} 位客户没称重：${notWeighed.map((g) => g.nickname).join('、')}`,
    );
  }

  // 没给金额就按设置里的单价从重量推：100 元 /kg 是常用价，称重台不用每次手填
  let priceFenPerKg: number | null = null;
  if (totalFeeFen === null) {
    priceFenPerKg = await intlPriceFenPerKg(env);
    if (priceFenPerKg <= 0) throw badRequest('设置里的国际运费单价是 0，先填单价或手动给金额');
    totalFeeFen = feeFromWeight(
      usable.reduce((sum, g) => sum + (g.weightG as number), 0),
      priceFenPerKg,
    );
  }

  const result = allocate(
    totalFeeFen,
    usable.map((g) => ({ id: g.id, weightG: g.weightG as number })),
  );
  const byId = new Map(usable.map((g) => [g.id, g]));
  const rows = result.rows.map((row) => {
    const g = byId.get(row.id)!;
    return {
      weighGroupId: row.id,
      customerId: g.customerId,
      nickname: g.nickname,
      qq: g.qq,
      itemCount: g.itemCount,
      weightG: row.weightG,
      share: row.share,
      feeFen: row.feeFen,
    };
  });

  let declaredWeightG: number | null = null;
  if (body.totalWeightG !== undefined && body.totalWeightG !== null && body.totalWeightG !== '') {
    declaredWeightG = requireInt(body.totalWeightG, '转运仓总重量（克）');
  }

  return {
    totalFeeFen,
    priceFenPerKg,
    totalWeightG: result.totalWeightG,
    declaredWeightG,
    weightDiffG: declaredWeightG === null ? null : declaredWeightG - result.totalWeightG,
    diffFen: result.diffFen,
    rows,
  };
}

weighRoutes.post('/:id/weigh/item',async c=>{
 const id=requireInt(c.req.param('id'),'包裹 ID'); const pkg=await loadPackage(c.env,id); ensureNotAllocated(pkg);
 const body=await readJson<{itemId:unknown;weightG:unknown}>(c); const itemId=requireInt(body.itemId,'物品 ID'); const weight=requireInt(body.weightG,'重量');
 if(weight<=0 || weight>1000000) throw badRequest('重量必须为1至1000000克');
 const item=await c.env.DB.prepare("SELECT customer_id AS cid FROM items WHERE id=? AND package_id=? AND status NOT IN ('cancelled','refunded','shipped','delivered')").bind(itemId,id).first<{cid:number}>();
 if(!item) throw notFound('物品不在此包裹'); const gid=await ensureGroup(c.env,id,item.cid);
 await c.env.DB.batch([
 c.env.DB.prepare('UPDATE items SET weight_g=?,weigh_group_id=?,missing=0,updated_at=? WHERE id=?').bind(weight,gid,nowIso(),itemId),
 c.env.DB.prepare('UPDATE weigh_groups SET weight_g=(SELECT SUM(weight_g) FROM items WHERE weigh_group_id=? AND missing=0) WHERE id=?').bind(gid,gid)]);
 return c.json({ok:true});
});
weighRoutes.post('/:id/allocate/preview', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  await loadPackage(c.env, id);
  const body = await readJson<AllocateBody>(c);
  return c.json(await buildAllocation(c.env, id, body));
});

weighRoutes.post('/:id/allocate/commit', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const pkg = await loadPackage(c.env, id);
  ensureNotAllocated(pkg);
  const body = await readJson<AllocateBody>(c);
  const allocation = await buildAllocation(c.env, id, body);

  const db = c.env.DB;
  const at = nowIso();
  const items = await db
    .prepare(
      `SELECT id, status FROM items
        WHERE package_id = ? AND missing = 0 AND weigh_group_id IS NOT NULL
          AND status NOT IN ('cancelled','refunded','cn_stock','shipped','delivered')`,
    )
    .bind(id)
    .all<{ id: number; status: string }>();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        'UPDATE packages SET total_fee_fen = ?, total_weight_g = ?, allocated_at = ?, status = ? WHERE id = ?',
      )
      .bind(
        allocation.totalFeeFen,
        allocation.declaredWeightG ?? allocation.totalWeightG,
        at,
        'cn_stock',
        id,
      ),
    db
      .prepare(
        'INSERT INTO rounding_logs (package_id, diff_fen) VALUES (?, ?) ON CONFLICT(package_id) DO UPDATE SET diff_fen = excluded.diff_fen',
      )
      .bind(id, allocation.diffFen),
  ];
  const unitRows=await db.prepare("SELECT id,weigh_group_id AS gid,weight_g AS weight FROM items WHERE package_id=? AND missing=0 AND status NOT IN ('cancelled','refunded','shipped','delivered')").bind(id).all<{id:number;gid:number;weight:number|null}>();
  const anyUnitWeight=unitRows.results.some(i=>i.weight!==null);
  if(anyUnitWeight && unitRows.results.some(i=>!i.weight)) throw badRequest('请填写每件商品的重量');
  for (const row of allocation.rows) {
    const units=unitRows.results.filter(i=>i.gid===row.weighGroupId);
    if(anyUnitWeight) {
      const unitAllocation=allocate(row.feeFen,units.map(i=>({id:i.id,weightG:i.weight!})));
      let remainder=unitAllocation.diffFen;
      for(const u of unitAllocation.rows) {
        statements.push(db.prepare('UPDATE items SET intl_fee_fen=? WHERE id=?').bind(u.feeFen+(remainder-->0?1:0),u.id));
      }
    }
    statements.push(
      db
        .prepare('UPDATE weigh_groups SET intl_fee_fen = ?, weight_g=? WHERE id = ?')
        .bind(row.feeFen,row.weightG,row.weighGroupId),
    );
  }
  for (const item of items.results) {
    statements.push(
      db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').bind('cn_stock', at, item.id),
      statusLogStmt(db, item.id, item.status, 'cn_stock', at),
    );
  }
  await db.batch(statements);

  return c.json({ ...allocation, itemsMovedToStock: items.results.length });
});

weighRoutes.post('/:id/allocate/undo', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const pkg = await loadPackage(c.env, id);
  if (!pkg.allocatedAt) throw badRequest('这个包裹还没分摊过');

  const db = c.env.DB;
  const partial=await db.prepare('SELECT id FROM items WHERE package_id=? AND intl_paid=1 LIMIT 1').bind(id).first();
  if(partial) throw badRequest('已有商品收过国际运费，请先撤销收款');
  const requested=await db.prepare('SELECT ri.item_id FROM request_items ri JOIN items i ON i.id=ri.item_id WHERE i.package_id=? LIMIT 1').bind(id).first();
  if(requested) throw badRequest('已有客户申请发货，先取消申请');
  const paid = await db
    .prepare('SELECT COUNT(*) AS count FROM weigh_groups WHERE package_id = ? AND fee_paid = 1')
    .bind(id)
    .first<{ count: number }>();
  if ((paid?.count ?? 0) > 0) throw badRequest('已经有人付过这个包裹的国际运费，不能撤销分摊');

  const shipped = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM items
        WHERE package_id = ? AND status IN ('shipped','delivered')`,
    )
    .bind(id)
    .first<{ count: number }>();
  if ((shipped?.count ?? 0) > 0) throw badRequest('这个包裹里已经有东西寄出了，不能撤销分摊');

  const items = await db
    .prepare("SELECT id FROM items WHERE package_id = ? AND status = 'cn_stock'")
    .bind(id)
    .all<{ id: number }>();

  const at = nowIso();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE packages SET total_fee_fen = NULL, allocated_at = NULL, status = 'cn_arrived' WHERE id = ?",
      )
      .bind(id),
    db.prepare('UPDATE weigh_groups SET intl_fee_fen = NULL WHERE package_id = ?').bind(id),
    db.prepare('UPDATE items SET intl_fee_fen=NULL WHERE package_id=?').bind(id),
    db.prepare('DELETE FROM rounding_logs WHERE package_id = ?').bind(id),
  ];
  for (const item of items.results) {
    statements.push(
      db
        .prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?')
        .bind('cn_arrived', at, item.id),
      statusLogStmt(db, item.id, 'cn_stock', 'cn_arrived', at),
    );
  }
  await db.batch(statements);
  return c.json({ ok: true, itemsReverted: items.results.length });
});
