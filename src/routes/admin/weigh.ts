import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, HttpError, notFound, optionalString, readJson, requireInt } from '../../lib/http.ts';
import { nextId, nowIso, statusLogStmt, intlPriceFenPerKg } from '../../lib/db.ts';
import { allocate, feeFromWeight, splitGroupFee } from '../../lib/allocate.ts';
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
      unclaimedItems: items.results.filter((i) => !i.weighGroupId && !i.missing).length,
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

/**
 * 一摞的称重口径：逐件称（basis=items，重量是各件之和）或整摞称一次（basis=group，摞内按件数均摊）。
 * 逐件称过的摞，weigh_groups.weight_g 由各件重量自动加出来（见 weigh/item）；
 * 只要还有一件没填，就以整摞那个总数为准，避免半摞的重量把分母带偏。
 */
interface GroupRow {
  id: number;
  customerId: number;
  nickname: string;
  qq: string;
  groupWeightG: number | null;
  weightG: number | null;
  itemCount: number;
  weighedCount: number;
  unitWeightG: number | null;
  basis: 'items' | 'group' | null;
}

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
    `SELECT g.id, g.customer_id AS customerId, c.nickname, c.qq, g.weight_g AS groupWeightG,
            (SELECT COUNT(*) FROM items i WHERE i.weigh_group_id = g.id AND i.missing = 0
               AND i.status NOT IN ('cancelled','refunded','shipped','delivered')) AS itemCount,
            (SELECT COUNT(*) FROM items i WHERE i.weigh_group_id = g.id AND i.missing = 0
               AND i.status NOT IN ('cancelled','refunded','shipped','delivered')
               AND i.weight_g IS NOT NULL) AS weighedCount,
            (SELECT SUM(i.weight_g) FROM items i WHERE i.weigh_group_id = g.id AND i.missing = 0
               AND i.status NOT IN ('cancelled','refunded','shipped','delivered')) AS unitWeightG
       FROM weigh_groups g
       JOIN customers c ON c.id = g.customer_id
      WHERE g.package_id = ?
      ORDER BY c.nickname`,
  )
    .bind(packageId)
    .all<GroupRow>();

  const unitRows = await env.DB.prepare(
    `SELECT id, weigh_group_id AS gid, weight_g AS weightG FROM items
      WHERE package_id = ? AND missing = 0 AND weigh_group_id IS NOT NULL
        AND status NOT IN ('cancelled','refunded','shipped','delivered')
      ORDER BY id`,
  )
    .bind(packageId)
    .all<{ id: number; gid: number; weightG: number | null }>();
  const unitsByGroup = new Map<number, Array<{ id: number; weightG: number | null }>>();
  for (const u of unitRows.results) {
    const list = unitsByGroup.get(u.gid) ?? [];
    list.push({ id: u.id, weightG: u.weightG });
    unitsByGroup.set(u.gid, list);
  }

  const unfinished=await env.DB.prepare(`SELECT COUNT(*) AS n FROM items WHERE package_id=? AND missing=0 AND status NOT IN ('cancelled','refunded','shipped','delivered') AND weigh_group_id IS NULL`).bind(packageId).first<{n:number}>();
  if(unfinished?.n) throw badRequest(`还有 ${unfinished.n} 件既没认领也没标缺件：点上面「整箱全部认领」，或者把没收到的那几件标成缺件`);
  const usable = groups.results.filter((g) => g.itemCount > 0);
  // 一摞有两种称法：逐件都称过就按各件重量分，只把整摞放秤上就按件数均摊。
  // 一件称过一件没称的摞算「整摞」—— 用整摞那个总数，免得半摞的重量把分母带偏。
  for (const g of usable) {
    if (g.weighedCount === g.itemCount) {
      g.basis = 'items';
      g.weightG = g.unitWeightG;
    } else if (g.groupWeightG && g.groupWeightG > 0) {
      g.basis = 'group';
      g.weightG = g.groupWeightG;
    } else {
      g.basis = null;
      g.weightG = null;
    }
  }
  const notWeighed = usable.filter((g) => !g.basis);
  if (usable.length === 0) throw badRequest('还没有任何已认领的物品，不能分摊');
  if (notWeighed.length > 0) {
    throw badRequest(
      `还有 ${notWeighed.length} 摞没称：${notWeighed.map((g) => g.nickname).join('、')}。整摞放秤上填一个总重就行，不用一件一件称`,
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
  const rows = usable.map((g, index) => {
    const units = unitsByGroup.get(g.id) ?? [];
    const split = splitGroupFee(result.rows[index].feeFen, units);
    return {
      weighGroupId: g.id,
      customerId: g.customerId,
      nickname: g.nickname,
      qq: g.qq,
      itemCount: g.itemCount,
      weightG: g.weightG as number,
      share: result.rows[index].share,
      feeFen: result.rows[index].feeFen,
      // 每件各自多少运费在预览就定下来了，确认写的是同一份数，不会出现预览一个数、入账另一个数
      unitMode: split.mode,
      units: split.rows,
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
 // 这一摞每件都称齐了，摞重才由各件相加；还缺件的话别把整摞称的那个总数冲成半摞之和
 c.env.DB.prepare(`UPDATE weigh_groups SET weight_g=(SELECT SUM(weight_g) FROM items WHERE weigh_group_id=? AND missing=0 AND status NOT IN ('cancelled','refunded','shipped','delivered'))
   WHERE id=? AND (SELECT COUNT(*) FROM items WHERE weigh_group_id=? AND missing=0 AND status NOT IN ('cancelled','refunded','shipped','delivered') AND weight_g IS NULL)=0`).bind(gid,gid,gid)]);
 return c.json({ok:true});
});

/** 整摞称一次：这一摞放秤上是多少就填多少，摞内每件按件数均摊。填空 = 取消整摞称法。 */
weighRoutes.post('/:id/weigh/group', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const pkg = await loadPackage(c.env, id);
  ensureNotAllocated(pkg);
  const body = await readJson<{ customerId?: unknown; weighGroupId?: unknown; weightG?: unknown }>(c);
  const db = c.env.DB;
  let groupId: number | null = null;
  if (body.weighGroupId !== undefined && body.weighGroupId !== null && body.weighGroupId !== '') {
    groupId = requireInt(body.weighGroupId, '称重组 ID');
  } else {
    const customerId = requireInt(body.customerId, '客户 ID');
    groupId = await ensureGroup(c.env, id, customerId);
  }
  const group = await db
    .prepare('SELECT id FROM weigh_groups WHERE id = ? AND package_id = ?')
    .bind(groupId, id)
    .first<{ id: number }>();
  if (!group) throw notFound('这一摞不存在');

  const weighed = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM items WHERE weigh_group_id = ? AND missing = 0 AND weight_g IS NOT NULL
         AND status NOT IN ('cancelled','refunded','shipped','delivered')`,
    )
    .bind(groupId)
    .first<{ n: number }>();
  const total = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM items WHERE weigh_group_id = ? AND missing = 0
         AND status NOT IN ('cancelled','refunded','shipped','delivered')`,
    )
    .bind(groupId)
    .first<{ n: number }>();
  if ((weighed?.n ?? 0) > 0 && (weighed?.n ?? 0) === (total?.n ?? 0)) {
    throw badRequest('这一摞已经逐件称过了，重量由每件自己加起来；要改成整摞称，先把那几件的重量清掉');
  }

  const raw = body.weightG;
  const weight = raw === undefined || raw === null || raw === '' ? null : requireInt(raw, '整摞重量');
  if (weight !== null && (weight <= 0 || weight > 1000000)) {
    throw badRequest('整摞重量必须为 1 至 1000000 克');
  }
  await db.prepare('UPDATE weigh_groups SET weight_g = ? WHERE id = ?').bind(weight, groupId).run();
  return c.json({ ok: true, weighGroupId: groupId, weightG: weight });
});

/** 整箱一次到国内时不用一件件点：把这一箱里还没认领的全归到各自客户的摞上。 */
weighRoutes.post('/:id/weigh/claim-all', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const pkg = await loadPackage(c.env, id);
  ensureNotAllocated(pkg);
  const db = c.env.DB;
  const pending = await db
    .prepare(
      `SELECT i.id, i.customer_id AS customerId FROM items i
        WHERE i.package_id = ? AND i.weigh_group_id IS NULL AND i.missing = 0
          AND i.status NOT IN ('cancelled','refunded','shipped','delivered')
        ORDER BY i.id`,
    )
    .bind(id)
    .all<{ id: number; customerId: number }>();
  if (!pending.results.length) return c.json({ ok: true, claimed: 0, customers: 0 });

  const byCustomer = new Map<number, number[]>();
  for (const item of pending.results) {
    const list = byCustomer.get(item.customerId) ?? [];
    list.push(item.id);
    byCustomer.set(item.customerId, list);
  }
  const statements: D1PreparedStatement[] = [];
  for (const [customerId, itemIds] of byCustomer) {
    const groupId = await ensureGroup(c.env, id, customerId);
    for (const itemId of itemIds) {
      statements.push(
        db.prepare('UPDATE items SET weigh_group_id = ?, updated_at = ? WHERE id = ?')
          .bind(groupId, nowIso(), itemId),
      );
    }
  }
  await db.batch(statements);
  return c.json({ ok: true, claimed: pending.results.length, customers: byCustomer.size });
});
/** allocate()/feeFromWeight() 是纯函数库，抛普通 Error；到接口层得变成 400，不能让群主看到「服务器出错了」 */
async function buildAllocationOr400(env: Env, packageId: number, body: AllocateBody) {
  try {
    return await buildAllocation(env, packageId, body);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest(err instanceof Error ? err.message : '分摊参数有问题');
  }
}

weighRoutes.post('/:id/allocate/preview', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  await loadPackage(c.env, id);
  const body = await readJson<AllocateBody>(c);
  return c.json(await buildAllocationOr400(c.env, id, body));
});

weighRoutes.post('/:id/allocate/commit', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const pkg = await loadPackage(c.env, id);
  ensureNotAllocated(pkg);
  const body = await readJson<AllocateBody>(c);
  const allocation = await buildAllocationOr400(c.env, id, body);

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
  // 每件各自的运费直接用书预览里算好的那份：客户页面按件勾发货，每件都得有自己的运费，
  // 而且「每件之和 = 这一摞 = 这一箱」要分毫不差，不能让确认再算一遍算出另一个数。
  for (const row of allocation.rows) {
    for (const unit of row.units) {
      statements.push(
        db.prepare('UPDATE items SET intl_fee_fen = ? WHERE id = ?').bind(unit.feeFen, unit.id),
      );
    }
    statements.push(
      db
        .prepare('UPDATE weigh_groups SET intl_fee_fen = ?, weight_g = ? WHERE id = ?')
        .bind(row.feeFen, row.weightG, row.weighGroupId),
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
