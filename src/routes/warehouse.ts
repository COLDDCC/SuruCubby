import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../lib/env.ts';
import { badRequest, bound, intList, notFound, optionalString, placeholders, readJson, requireInt, requireString } from '../lib/http.ts';
import { nextId, nowIso, statusLogStmt } from '../lib/db.ts';
import { verifyPassword } from '../lib/password.ts';
import {
  clearWarehouseSession,
  currentWarehouseUser,
  issueWarehouseSession,
  warehouseGuard,
  type WarehouseUser,
  type WarehouseVars,
} from '../lib/warehouseSession.ts';
import {
  MAX_PHOTOS_PER_PARCEL,
  beijingDay,
  decodePhoto,
  directSaleFenPerKg,
  parcelItems,
  photoIds,
  photoResponse,
  requireWeightG,
  whCostFenPerKg,
} from '../lib/parcels.ts';

/**
 * 仓库工作台的接口。
 *
 * 规矩只有一条：仓库只看得到干活要用的东西——客户叫什么、买了哪几件（大图 + 货号）、
 * 走直邮还是拼邮、直邮寄到哪。任何价格（货款、仓库单价、群主收客户的单价）、
 * 客户 QQ / 真名、谁付没付钱，这里一个字段都不返回。
 */
export const warehouseRoutes = new Hono<WarehouseVars>();

const LOCK_MS = 15 * 60 * 1000;

warehouseRoutes.post('/login', async (c) => {
  const body = await readJson<{ username?: unknown; password?: unknown }>(c);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) throw badRequest('账号和密码都要填');
  if (username.length > 32 || password.length > 64) throw badRequest('账号或密码太长了');
  const db = c.env.DB;
  const attempt = await db
    .prepare('SELECT failures, locked_until AS lockedUntil FROM warehouse_attempts WHERE username = ?')
    .bind(username)
    .first<{ failures: number; lockedUntil: number }>();
  if (attempt && attempt.lockedUntil > Date.now()) return c.json({ error: '输错太多次了，请过 15 分钟再试' }, 429);
  const user = await db
    .prepare(
      'SELECT id, username, display_name AS displayName, password_hash AS passwordHash, disabled FROM warehouse_users WHERE username = ?',
    )
    .bind(username)
    .first<WarehouseUser & { disabled: number }>();
  if (!user || user.disabled || !(await verifyPassword(password, user.passwordHash))) {
    const failures = attempt && attempt.lockedUntil > Date.now() - LOCK_MS ? attempt.failures + 1 : 1;
    await db
      .prepare(
        'INSERT INTO warehouse_attempts (username, failures, locked_until) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until',
      )
      .bind(username, failures, failures >= 5 ? Date.now() + LOCK_MS : Date.now())
      .run();
    return c.json({ error: user?.disabled ? '这个账号已经被停用，找群主' : '账号或密码不对' }, 401);
  }
  await db.prepare('DELETE FROM warehouse_attempts WHERE username = ?').bind(username).run();
  await issueWarehouseSession(c as unknown as Context<{ Bindings: Env }>, user);
  return c.json({ ok: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
});

warehouseRoutes.post('/logout', (c) => {
  clearWarehouseSession(c);
  return c.json({ ok: true });
});

warehouseRoutes.get('/session', async (c) => {
  const user = await currentWarehouseUser(c as unknown as Context<{ Bindings: Env }>);
  return c.json(
    user ? { loggedIn: true, user: { id: user.id, username: user.username, displayName: user.displayName } } : { loggedIn: false },
  );
});

warehouseRoutes.use('/*', async (c, next) => {
  // 登录 / 退出 / 会话查询不需要钥匙，其余一律要仓库账号
  const path = new URL(c.req.url).pathname;
  if (path === '/api/wh/login' || path === '/api/wh/logout' || path === '/api/wh/session') return next();
  return warehouseGuard(c, next);
});

/** 拿日本订单号或日本运单号进门。大小写、前后空格不计较；精确对不上再按片段找。 */
warehouseRoutes.get('/lookup', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 3) throw badRequest('单号至少输 3 位');
  if (q.length > 60) throw badRequest('单号太长了');
  const db = c.env.DB;
  const select = `SELECT b.id, b.name, b.order_no AS orderNo, b.japan_tracking_no AS japanTrackingNo, b.shop,
                         b.ordered_at AS orderedAt,
                         (SELECT COUNT(*) FROM items i WHERE i.batch_id = b.id AND i.status NOT IN ('cancelled','refunded')) AS itemCount,
                         (SELECT COUNT(DISTINCT i.customer_id) FROM items i WHERE i.batch_id = b.id) AS customerCount,
                         (SELECT COUNT(*) FROM items i WHERE i.batch_id = b.id AND i.sorted_at IS NOT NULL) AS sortedCount
                    FROM batches b`;
  let rows = await db
    .prepare(`${select} WHERE LOWER(TRIM(b.order_no)) = LOWER(?) OR LOWER(TRIM(b.japan_tracking_no)) = LOWER(?) ORDER BY b.id DESC LIMIT 20`)
    .bind(q, q)
    .all();
  if (rows.results.length === 0) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    rows = await db
      .prepare(`${select} WHERE b.order_no LIKE ? OR b.japan_tracking_no LIKE ? ORDER BY b.id DESC LIMIT 20`)
      .bind(like, like)
      .all();
  }
  return c.json({ batches: rows.results });
});

/** 最近的订单，仓库不记得单号时从这里点进去。 */
warehouseRoutes.get('/batches', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.name, b.order_no AS orderNo, b.japan_tracking_no AS japanTrackingNo, b.shop, b.ordered_at AS orderedAt,
            (SELECT COUNT(*) FROM items i WHERE i.batch_id = b.id AND i.status NOT IN ('cancelled','refunded')) AS itemCount,
            (SELECT COUNT(DISTINCT i.customer_id) FROM items i WHERE i.batch_id = b.id) AS customerCount,
            (SELECT COUNT(*) FROM items i WHERE i.batch_id = b.id AND i.sorted_at IS NOT NULL) AS sortedCount
       FROM batches b
      ORDER BY b.id DESC LIMIT 30`,
  ).all();
  return c.json({ batches: rows.results });
});

interface WhItem {
  id: number;
  customerId: number;
  title: string;
  imageUrl: string | null;
  productUrl: string | null;
  status: string;
  missing: number;
  sortedAt: string | null;
  parcelId: number | null;
  boxId: number | null;
  boxName: string | null;
  orderNo: string | null;
  shop: string | null;
  batchId: number;
}

const ITEM_COLUMNS = `i.id, i.customer_id AS customerId, i.title, i.image_url AS imageUrl, i.product_url AS productUrl,
        i.status, i.missing, i.sorted_at AS sortedAt, i.parcel_id AS parcelId,
        CASE WHEN p.kind = 'group' THEN p.id END AS boxId, CASE WHEN p.kind = 'group' THEN p.name END AS boxName,
        b.order_no AS orderNo, b.shop, b.id AS batchId`;

function laneOf(c: { shipMode: string; selfReturn: number }): 'direct' | 'group' | 'self' {
  if (c.selfReturn) return 'self';
  return c.shipMode === 'direct' ? 'direct' : 'group';
}

/** 一个订单的操作台：按客户分好，点名字就是他这一单的全部东西。 */
warehouseRoutes.get('/batches/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '订单 ID');
  const db = c.env.DB;
  const batch = await db
    .prepare('SELECT id, name, order_no AS orderNo, japan_tracking_no AS japanTrackingNo, shop, ordered_at AS orderedAt FROM batches WHERE id = ?')
    .bind(id)
    .first();
  if (!batch) throw notFound('没有这个订单');
  const items = await db
    .prepare(
      `SELECT ${ITEM_COLUMNS}
         FROM items i JOIN batches b ON b.id = i.batch_id LEFT JOIN packages p ON p.id = i.package_id
        WHERE i.batch_id = ? AND i.status NOT IN ('cancelled','refunded')
        ORDER BY i.customer_id, i.product_url, i.id`,
    )
    .bind(id)
    .all<WhItem>();
  const customerIds = [...new Set(items.results.map((i) => i.customerId))];
  const customers = customerIds.length
    ? (
        await db
          .prepare(
            `SELECT id, nickname, ship_mode AS shipMode, self_return AS selfReturn, direct_address AS directAddress
               FROM customers WHERE id IN (${placeholders(customerIds.length)}) ORDER BY nickname`,
          )
          .bind(...customerIds)
          .all<{ id: number; nickname: string; shipMode: string; selfReturn: number; directAddress: string | null }>()
      ).results
    : [];
  return c.json({
    batch,
    customers: customers.map((cu) => {
      const mine = items.results.filter((i) => i.customerId === cu.id);
      const lane = laneOf(cu);
      return {
        id: cu.id,
        nickname: cu.nickname,
        lane,
        directAddress: lane === 'direct' ? cu.directAddress : null,
        itemCount: mine.length,
        sortedCount: mine.filter((i) => i.sortedAt).length,
        items: mine,
      };
    }),
  });
});

/** 【整理完成】：这一单里这位客户的东西都找齐了。客户那边立刻显示「已分拣」。 */
warehouseRoutes.post('/batches/:id/customers/:cid/sorted', async (c) => {
  const batchId = requireInt(c.req.param('id'), '订单 ID');
  const customerId = requireInt(c.req.param('cid'), '客户 ID');
  const body = await readJson<{ undo?: boolean }>(c);
  const db = c.env.DB;
  const at = nowIso();
  if (body.undo) {
    // 撤回整理：只退还没装箱、没打包的；已经进了包裹的先从包裹里拿出来
    const rows = await db
      .prepare(
        `SELECT i.id FROM items i LEFT JOIN packages p ON p.id = i.package_id
          WHERE i.batch_id = ? AND i.customer_id = ? AND i.status = 'sorted' AND i.parcel_id IS NULL AND COALESCE(p.kind, '') <> 'group'`,
      )
      .bind(batchId, customerId)
      .all<{ id: number }>();
    if (rows.results.length === 0) throw badRequest('没有能撤回的：已经装箱或打包的，先从包裹里拿出来');
    await db.batch(
      rows.results.flatMap((r) => [
        db.prepare("UPDATE items SET status = 'ordered', sorted_at = NULL, updated_at = ? WHERE id = ?").bind(at, r.id),
        statusLogStmt(db, r.id, 'sorted', 'ordered', at),
      ]),
    );
    return c.json({ ok: true, count: rows.results.length });
  }
  const rows = await db
    .prepare(
      `SELECT id, status FROM items WHERE batch_id = ? AND customer_id = ? AND status IN ('ordered','jp_warehouse') AND sorted_at IS NULL`,
    )
    .bind(batchId, customerId)
    .all<{ id: number; status: string }>();
  if (rows.results.length === 0) throw badRequest('这一单里他的东西都已经整理过了');
  await db.batch(
    rows.results.flatMap((r) => [
      db.prepare("UPDATE items SET status = 'sorted', sorted_at = ?, missing = 0, updated_at = ? WHERE id = ?").bind(at, at, r.id),
      statusLogStmt(db, r.id, r.status, 'sorted', at),
    ]),
  );
  return c.json({ ok: true, count: rows.results.length });
});

/** 直邮客户：他所有订单里已分拣、还没打包的东西，加上他的包裹。合并多个订单一起发就靠这一页。 */
warehouseRoutes.get('/customers/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const db = c.env.DB;
  const cu = await db
    .prepare('SELECT id, nickname, ship_mode AS shipMode, self_return AS selfReturn, direct_address AS directAddress FROM customers WHERE id = ?')
    .bind(id)
    .first<{ id: number; nickname: string; shipMode: string; selfReturn: number; directAddress: string | null }>();
  if (!cu) throw notFound('没有这个客户');
  const lane = laneOf(cu);
  const waiting = await db
    .prepare(
      `SELECT ${ITEM_COLUMNS}
         FROM items i JOIN batches b ON b.id = i.batch_id LEFT JOIN packages p ON p.id = i.package_id
        WHERE i.customer_id = ? AND i.status IN ('ordered','jp_warehouse','sorted') AND i.parcel_id IS NULL
        ORDER BY i.batch_id, i.id`,
    )
    .bind(id)
    .all<WhItem>();
  const parcels = await listParcels(c.env, 'p.customer_id = ?', [id]);
  return c.json({
    customer: { id: cu.id, nickname: cu.nickname, lane, directAddress: lane === 'direct' ? cu.directAddress : null },
    items: waiting.results,
    parcels,
  });
});

/**
 * 仓库改客户的走法：拼邮 ⇄ 直邮。客户临时不想拼邮了，仓库当场改，以后的单也默认直邮。
 * 仓库看不到拼邮客户的地址，改成直邮后要等群主在后台补地址（群主首页会出现待办），补好才能打包。
 * 已经装进拼邮箱的东西不动，要改走直邮先从箱子里拿出来。
 */
warehouseRoutes.post('/customers/:id/lane', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const body = await readJson<{ lane?: unknown }>(c);
  if (body.lane !== 'direct' && body.lane !== 'group') throw badRequest('只能改成直邮或拼邮');
  const db = c.env.DB;
  const cu = await db
    .prepare('SELECT id, ship_mode AS shipMode, self_return AS selfReturn, direct_address AS directAddress FROM customers WHERE id = ?')
    .bind(id)
    .first<{ id: number; shipMode: string; selfReturn: number; directAddress: string | null }>();
  if (!cu) throw notFound('没有这个客户');
  if (cu.selfReturn) throw badRequest('这位自己带回，找群主改');
  if (body.lane === 'group') {
    const open = await db
      .prepare('SELECT COUNT(*) AS n FROM parcels WHERE customer_id = ? AND released_at IS NULL')
      .bind(id)
      .first<{ n: number }>();
    if (open?.n) throw badRequest('他还有没放行的直邮包裹，先作废那个包裹再改回拼邮');
  }
  await db.prepare('UPDATE customers SET ship_mode = ? WHERE id = ?').bind(body.lane, id).run();
  return c.json({ ok: true, lane: body.lane, needAddress: body.lane === 'direct' && !cu.directAddress });
});

/** 仓库看到的包裹：单号、毛重、几件、平铺图；看不到任何钱，也只知道「锁没锁」，不知道为什么锁。 */
async function listParcels(env: Env, where: string, binds: unknown[]) {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.customer_id AS customerId, c.nickname, p.tracking_no AS trackingNo, p.gross_weight_g AS grossWeightG,
            p.address_snapshot AS addressSnapshot, p.note, p.created_at AS createdAt, p.submit_day AS submitDay,
            p.released_at IS NOT NULL AS locked, u.display_name AS createdByName
       FROM parcels p JOIN customers c ON c.id = p.customer_id LEFT JOIN warehouse_users u ON u.id = p.created_by
      WHERE ${where}
      ORDER BY p.id DESC LIMIT 200`,
  )
    .bind(...binds)
    .all<{ id: number; locked: number }>();
  const ids = rows.results.map((r) => r.id);
  const items = await parcelItems(env, ids);
  const photos = await photoIds(env, ids);
  return rows.results.map((r) => ({
    ...r,
    locked: !!r.locked,
    items: (items.get(r.id) ?? []).map(({ id, title, imageUrl, productUrl, orderNo, shop }) => ({ id, title, imageUrl, productUrl, orderNo, shop })),
    photoIds: photos.get(r.id) ?? [],
  }));
}

warehouseRoutes.get('/parcels', async (c) => {
  const day = c.req.query('day') || beijingDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('日期格式是 2026-11-03 这样');
  return c.json({ day, parcels: await listParcels(c.env, 'p.submit_day = ?', [day]) });
});

async function lockedParcel(env: Env, id: number) {
  const p = await env.DB.prepare('SELECT id, customer_id AS customerId, released_at AS releasedAt FROM parcels WHERE id = ?')
    .bind(id)
    .first<{ id: number; customerId: number; releasedAt: string | null }>();
  if (!p) throw notFound('没有这个包裹');
  if (p.releasedAt) throw badRequest('这个包裹已经锁定了，要改找群主');
  return p;
}

/** 检查一组物品都能装进这位直邮客户的包裹：是他的、已分拣、还没进别的包裹。 */
async function packableItems(env: Env, customerId: number, itemIds: number[], parcelId: number | null) {
  const rows = await env.DB.prepare(
    `SELECT i.id, i.customer_id AS customerId, i.status, i.parcel_id AS parcelId, COALESCE(p.kind, '') AS packageKind
       FROM items i LEFT JOIN packages p ON p.id = i.package_id WHERE i.id IN (${placeholders(itemIds.length)})`,
  )
    .bind(...itemIds)
    .all<{ id: number; customerId: number; status: string; parcelId: number | null; packageKind: string }>();
  if (rows.results.length !== new Set(itemIds).size) throw badRequest('有的东西不存在，刷新一下');
  for (const r of rows.results) {
    if (r.customerId !== customerId) throw badRequest('勾进来的东西不全是这位客户的');
    if (r.parcelId !== null && r.parcelId !== parcelId) throw badRequest('有的东西已经在别的包裹里了');
    if (r.parcelId === null && r.status !== 'sorted') throw badRequest('只有点过【整理完成】的东西才能打包');
    if (r.parcelId === null && r.packageKind === 'group') throw badRequest('有的东西还在拼邮箱里，先从箱子里拿出来');
  }
  return rows.results;
}

/** 提交一个直邮包裹：勾东西（可以跨好几个订单）→ 单号 → 毛重 → 平铺图（可以稍后补）。 */
warehouseRoutes.post('/parcels', async (c) => {
  const user = c.get('warehouseUser');
  const body = await readJson<{ customerId?: unknown; itemIds?: unknown; trackingNo?: unknown; grossWeightG?: unknown; note?: unknown; photos?: unknown }>(c);
  const customerId = requireInt(body.customerId, '客户');
  const itemIds = intList(body.itemIds, '要打包的东西');
  const trackingNo = bound(requireString(body.trackingNo, '快递单号'), '快递单号', 60) as string;
  const grossWeightG = requireWeightG(body.grossWeightG);
  const note = bound(optionalString(body.note), '备注', 200);
  const photos = Array.isArray(body.photos) ? body.photos.map(decodePhoto) : [];
  if (photos.length > MAX_PHOTOS_PER_PARCEL) throw badRequest(`平铺图最多 ${MAX_PHOTOS_PER_PARCEL} 张`);
  const db = c.env.DB;
  const cu = await db
    .prepare('SELECT ship_mode AS shipMode, self_return AS selfReturn, direct_address AS directAddress FROM customers WHERE id = ?')
    .bind(customerId)
    .first<{ shipMode: string; selfReturn: number; directAddress: string | null }>();
  if (!cu) throw notFound('没有这个客户');
  if (laneOf(cu) !== 'direct') throw badRequest('这位客户不是直邮，他的东西走拼邮箱');
  if (!cu.directAddress) throw badRequest('群主还没填这位的地址，等地址出来再打包');
  const rows = await packableItems(c.env, customerId, itemIds, null);
  const at = nowIso();
  const id = await nextId(db, 'parcels');
  let photoId = await nextId(db, 'parcel_photos');
  await db.batch([
    db
      .prepare(
        `INSERT INTO parcels (id, customer_id, tracking_no, gross_weight_g, cost_fen_per_kg, sale_fen_per_kg, address_snapshot, note, created_by, created_at, submit_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, customerId, trackingNo, grossWeightG, await whCostFenPerKg(c.env), await directSaleFenPerKg(c.env), cu.directAddress, note, user.id, at, beijingDay(at)),
    ...rows.flatMap((r) => [
      db.prepare("UPDATE items SET parcel_id = ?, status = 'packed', updated_at = ? WHERE id = ?").bind(id, at, r.id),
      statusLogStmt(db, r.id, r.status, 'packed', at),
    ]),
    ...photos.map((p) =>
      db.prepare('INSERT INTO parcel_photos (id, parcel_id, mime, data, created_at) VALUES (?, ?, ?, ?, ?)').bind(photoId++, id, p.mime, p.bytes, at),
    ),
  ]);
  return c.json({ ok: true, id });
});

/** 放行之前仓库都能改：单号写错、毛重重称、少装多装。 */
warehouseRoutes.patch('/parcels/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const parcel = await lockedParcel(c.env, id);
  const body = await readJson<{ trackingNo?: unknown; grossWeightG?: unknown; note?: unknown; itemIds?: unknown }>(c);
  const db = c.env.DB;
  const at = nowIso();
  const stmts: D1PreparedStatement[] = [];
  if (body.trackingNo !== undefined) {
    stmts.push(db.prepare('UPDATE parcels SET tracking_no = ? WHERE id = ?').bind(bound(requireString(body.trackingNo, '快递单号'), '快递单号', 60), id));
  }
  if (body.grossWeightG !== undefined) {
    stmts.push(db.prepare('UPDATE parcels SET gross_weight_g = ? WHERE id = ?').bind(requireWeightG(body.grossWeightG), id));
  }
  if (body.note !== undefined) {
    stmts.push(db.prepare('UPDATE parcels SET note = ? WHERE id = ?').bind(bound(optionalString(body.note), '备注', 200), id));
  }
  if (body.itemIds !== undefined) {
    const itemIds = intList(body.itemIds, '要打包的东西');
    const rows = await packableItems(c.env, parcel.customerId, itemIds, id);
    const current = await db.prepare('SELECT id FROM items WHERE parcel_id = ?').bind(id).all<{ id: number }>();
    const keep = new Set(itemIds);
    for (const r of current.results) {
      if (keep.has(r.id)) continue;
      stmts.push(
        db.prepare("UPDATE items SET parcel_id = NULL, status = 'sorted', updated_at = ? WHERE id = ?").bind(at, r.id),
        statusLogStmt(db, r.id, 'packed', 'sorted', at),
      );
    }
    for (const r of rows) {
      if (r.parcelId === id) continue;
      stmts.push(
        db.prepare("UPDATE items SET parcel_id = ?, status = 'packed', updated_at = ? WHERE id = ?").bind(id, at, r.id),
        statusLogStmt(db, r.id, r.status, 'packed', at),
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
  return c.json({ ok: true });
});

/** 整个包裹作废（打错了重来）：里面的东西退回「已分拣」。 */
warehouseRoutes.delete('/parcels/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  await lockedParcel(c.env, id);
  const db = c.env.DB;
  const at = nowIso();
  const items = await db.prepare('SELECT id FROM items WHERE parcel_id = ?').bind(id).all<{ id: number }>();
  await db.batch([
    ...items.results.flatMap((r) => [
      db.prepare("UPDATE items SET parcel_id = NULL, status = 'sorted', updated_at = ? WHERE id = ?").bind(at, r.id),
      statusLogStmt(db, r.id, 'packed', 'sorted', at),
    ]),
    db.prepare('DELETE FROM parcel_photos WHERE parcel_id = ?').bind(id),
    db.prepare('DELETE FROM parcels WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

warehouseRoutes.post('/parcels/:id/photos', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  await lockedParcel(c.env, id);
  const body = await readJson<{ photo?: unknown }>(c);
  const photo = decodePhoto(body.photo);
  const db = c.env.DB;
  const count = await db.prepare('SELECT COUNT(*) AS n FROM parcel_photos WHERE parcel_id = ?').bind(id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PHOTOS_PER_PARCEL) throw badRequest(`平铺图最多 ${MAX_PHOTOS_PER_PARCEL} 张，先删一张`);
  const photoId = await nextId(db, 'parcel_photos');
  await db
    .prepare('INSERT INTO parcel_photos (id, parcel_id, mime, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(photoId, id, photo.mime, photo.bytes, nowIso())
    .run();
  return c.json({ ok: true, id: photoId });
});

warehouseRoutes.delete('/parcels/:id/photos/:pid', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  await lockedParcel(c.env, id);
  await c.env.DB.prepare('DELETE FROM parcel_photos WHERE id = ? AND parcel_id = ?').bind(requireInt(c.req.param('pid'), '图片 ID'), id).run();
  return c.json({ ok: true });
});

warehouseRoutes.get('/parcels/:id/photos/:pid', async (c) => {
  const res = await photoResponse(c.env, requireInt(c.req.param('id'), '包裹 ID'), requireInt(c.req.param('pid'), '图片 ID'));
  return res ?? c.json({ error: '没有这张图' }, 404);
});

// ───────────────────────── 拼邮箱 ─────────────────────────
// 拼邮的人和群主一个箱子回国。客户只需要知道这个回国单号。

async function boxRows(env: Env, where: string, binds: unknown[]) {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.tracking_no AS trackingNo, p.returned_at AS returnedAt, p.created_at AS createdAt,
            (SELECT COUNT(*) FROM items i WHERE i.package_id = p.id) AS itemCount,
            (SELECT COUNT(DISTINCT i.customer_id) FROM items i WHERE i.package_id = p.id) AS customerCount
       FROM packages p WHERE p.kind = 'group' AND ${where} ORDER BY p.id DESC LIMIT 50`,
  )
    .bind(...binds)
    .all();
  return rows.results;
}

warehouseRoutes.get('/boxes', async (c) => c.json({ boxes: await boxRows(c.env, '1 = 1', []) }));

warehouseRoutes.post('/boxes', async (c) => {
  const body = await readJson<{ name?: unknown }>(c);
  const at = nowIso();
  const name = bound(optionalString(body.name), '箱子名', 60) ?? `拼邮箱 ${beijingDay(at)}`;
  const id = await nextId(c.env.DB, 'packages');
  await c.env.DB.prepare("INSERT INTO packages (id, name, status, kind, created_at) VALUES (?, ?, 'jp_warehouse', 'group', ?)")
    .bind(id, name, at)
    .run();
  return c.json({ ok: true, id });
});

async function loadBox(env: Env, id: number) {
  const box = await env.DB.prepare(
    "SELECT id, name, tracking_no AS trackingNo, returned_at AS returnedAt FROM packages WHERE id = ? AND kind = 'group'",
  )
    .bind(id)
    .first<{ id: number; name: string; trackingNo: string | null; returnedAt: string | null }>();
  if (!box) throw notFound('没有这个拼邮箱');
  return box;
}

warehouseRoutes.get('/boxes/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '箱子 ID');
  const box = await loadBox(c.env, id);
  const items = await c.env.DB.prepare(
    `SELECT ${ITEM_COLUMNS}, cu.nickname
       FROM items i JOIN batches b ON b.id = i.batch_id LEFT JOIN packages p ON p.id = i.package_id
       JOIN customers cu ON cu.id = i.customer_id
      WHERE i.package_id = ? ORDER BY cu.nickname, i.id`,
  )
    .bind(id)
    .all();
  // 还没装箱的拼邮件：已分拣、客户走拼邮、还不在任何拼邮箱里
  const waiting = await c.env.DB.prepare(
    `SELECT ${ITEM_COLUMNS}, cu.nickname
       FROM items i JOIN batches b ON b.id = i.batch_id LEFT JOIN packages p ON p.id = i.package_id
       JOIN customers cu ON cu.id = i.customer_id
      WHERE i.status = 'sorted' AND i.parcel_id IS NULL AND COALESCE(p.kind, '') <> 'group'
        AND cu.ship_mode = 'group' AND cu.self_return = 0
      ORDER BY cu.nickname, i.id LIMIT 500`,
  ).all();
  return c.json({ box, items: items.results, waiting: waiting.results });
});

/** 往拼邮箱里装 / 拿出东西。拿出来的退回它原来那个订单的包裹。 */
warehouseRoutes.post('/boxes/:id/items', async (c) => {
  const id = requireInt(c.req.param('id'), '箱子 ID');
  const box = await loadBox(c.env, id);
  const body = await readJson<{ itemIds?: unknown; remove?: boolean }>(c);
  const itemIds = intList(body.itemIds, '东西');
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT i.id, i.status, i.batch_id AS batchId, i.parcel_id AS parcelId, i.package_id AS packageId, p.kind,
              cu.ship_mode AS shipMode, cu.self_return AS selfReturn
         FROM items i JOIN customers cu ON cu.id = i.customer_id LEFT JOIN packages p ON p.id = i.package_id
        WHERE i.id IN (${placeholders(itemIds.length)})`,
    )
    .bind(...itemIds)
    .all<{ id: number; status: string; batchId: number; parcelId: number | null; packageId: number | null; kind: string | null; shipMode: string; selfReturn: number }>();
  if (rows.results.length !== new Set(itemIds).size) throw badRequest('有的东西不存在，刷新一下');
  const at = nowIso();
  const stmts: D1PreparedStatement[] = [];
  if (body.remove) {
    for (const r of rows.results) {
      if (r.packageId !== id) throw badRequest('有的东西不在这个箱子里');
      // 退回这个订单导入时建的那个包裹
      stmts.push(
        db
          .prepare(
            `UPDATE items SET package_id = (SELECT pb.package_id FROM package_batches pb JOIN packages p ON p.id = pb.package_id
                                             WHERE pb.batch_id = ? AND p.kind <> 'group' ORDER BY pb.package_id LIMIT 1),
                              status = CASE WHEN status = 'intl_transit' THEN 'sorted' ELSE status END, updated_at = ? WHERE id = ?`,
          )
          .bind(r.batchId, at, r.id),
      );
      if (r.status === 'intl_transit') stmts.push(statusLogStmt(db, r.id, 'intl_transit', 'sorted', at));
    }
  } else {
    for (const r of rows.results) {
      if (r.selfReturn || r.shipMode !== 'group') throw badRequest('有的东西是直邮客户的，不进拼邮箱');
      if (r.parcelId !== null) throw badRequest('有的东西已经打进直邮包裹了');
      if (r.status !== 'sorted') throw badRequest('只有点过【整理完成】的东西才能装箱');
      if (r.kind === 'group' && r.packageId !== id) throw badRequest('有的东西已经在别的拼邮箱里了');
      // 箱子已经发出了，后装进来的也跟着是「回国中」
      const next = box.returnedAt ? 'intl_transit' : 'sorted';
      stmts.push(db.prepare('UPDATE items SET package_id = ?, status = ?, updated_at = ? WHERE id = ?').bind(id, next, at, r.id));
      stmts.push(db.prepare('INSERT OR IGNORE INTO package_batches (package_id, batch_id) VALUES (?, ?)').bind(id, r.batchId));
      if (next !== r.status) stmts.push(statusLogStmt(db, r.id, r.status, next, at));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return c.json({ ok: true, count: rows.results.length });
});

/** 填回国单号 / 回国日期。填了单号，拼邮的客户页上就能复制这个单号。 */
warehouseRoutes.patch('/boxes/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '箱子 ID');
  await loadBox(c.env, id);
  const body = await readJson<{ trackingNo?: unknown; name?: unknown }>(c);
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  if (body.trackingNo !== undefined) {
    stmts.push(db.prepare('UPDATE packages SET tracking_no = ? WHERE id = ?').bind(bound(optionalString(body.trackingNo), '回国单号', 60), id));
  }
  if (body.name !== undefined) {
    stmts.push(db.prepare('UPDATE packages SET name = ? WHERE id = ?').bind(bound(requireString(body.name, '箱子名'), '箱子名', 60), id));
  }
  if (stmts.length) await db.batch(stmts);
  return c.json({ ok: true });
});

/** 箱子发出：记回国日期，箱里的东西变「回国中」。 */
warehouseRoutes.post('/boxes/:id/ship', async (c) => {
  const id = requireInt(c.req.param('id'), '箱子 ID');
  const box = await loadBox(c.env, id);
  const body = await readJson<{ returnedAt?: unknown }>(c);
  if (!box.trackingNo) throw badRequest('先填回国单号再发出');
  const day = optionalString(body.returnedAt) ?? beijingDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('回国日期格式是 2026-11-03 这样');
  const db = c.env.DB;
  const at = nowIso();
  const items = await db.prepare("SELECT id FROM items WHERE package_id = ? AND status = 'sorted'").bind(id).all<{ id: number }>();
  if (!box.returnedAt && items.results.length === 0) throw badRequest('箱子是空的');
  await db.batch([
    db.prepare("UPDATE packages SET returned_at = ?, status = 'intl_transit' WHERE id = ?").bind(day, id),
    ...items.results.flatMap((r) => [
      db.prepare("UPDATE items SET status = 'intl_transit', updated_at = ? WHERE id = ?").bind(at, r.id),
      statusLogStmt(db, r.id, 'sorted', 'intl_transit', at),
    ]),
  ]);
  return c.json({ ok: true, count: items.results.length });
});
