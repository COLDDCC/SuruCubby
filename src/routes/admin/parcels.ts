import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, bound, intList, notFound, optionalString, placeholders, readJson, requireInt, requireString } from '../../lib/http.ts';
import { nowIso, statusLogStmt } from '../../lib/db.ts';
import { feeFen, parcelItems, photoIds, photoResponse, requirePricePerKg, requireWeightG } from '../../lib/parcels.ts';

/**
 * 群主看的直邮包裹：这里是唯一同时看得到「仓库收我多少」和「我收客户多少」的地方。
 * 仓库的接口不给价格，客户的接口只给售价算出来的运费。
 */
export const parcelRoutes = new Hono<{ Bindings: Env }>();

interface ParcelRow {
  id: number;
  customerId: number;
  nickname: string;
  qq: string;
  trackingNo: string;
  grossWeightG: number;
  costFenPerKg: number;
  saleFenPerKg: number;
  addressSnapshot: string | null;
  note: string | null;
  createdAt: string;
  submitDay: string;
  releasedAt: string | null;
  createdByName: string | null;
}

async function list(env: Env, where: string, binds: unknown[]) {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.customer_id AS customerId, c.nickname, c.qq, p.tracking_no AS trackingNo, p.gross_weight_g AS grossWeightG,
            p.cost_fen_per_kg AS costFenPerKg, p.sale_fen_per_kg AS saleFenPerKg, p.address_snapshot AS addressSnapshot,
            p.note, p.created_at AS createdAt, p.submit_day AS submitDay, p.released_at AS releasedAt,
            u.display_name AS createdByName
       FROM parcels p JOIN customers c ON c.id = p.customer_id LEFT JOIN warehouse_users u ON u.id = p.created_by
      WHERE ${where}
      ORDER BY p.submit_day DESC, p.id DESC LIMIT 500`,
  )
    .bind(...binds)
    .all<ParcelRow>();
  const ids = rows.results.map((r) => r.id);
  const items = await parcelItems(env, ids);
  const photos = await photoIds(env, ids);
  return rows.results.map((r) => {
    const costFen = feeFen(r.grossWeightG, r.costFenPerKg);
    const saleFen = feeFen(r.grossWeightG, r.saleFenPerKg);
    return { ...r, costFen, saleFen, marginFen: saleFen - costFen, items: items.get(r.id) ?? [], photoIds: photos.get(r.id) ?? [] };
  });
}

/** ?day=2026-11-03 只看那一天仓库提交的；?status=pending 只看还没放行的。 */
parcelRoutes.get('/', async (c) => {
  const day = c.req.query('day');
  const status = c.req.query('status');
  const where: string[] = ['1 = 1'];
  const binds: unknown[] = [];
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('日期格式是 2026-11-03 这样');
    where.push('p.submit_day = ?');
    binds.push(day);
  }
  if (status === 'pending') where.push('p.released_at IS NULL');
  if (status === 'released') where.push('p.released_at IS NOT NULL');
  const days = await c.env.DB.prepare(
    `SELECT submit_day AS day, COUNT(*) AS count, SUM(released_at IS NULL) AS pending FROM parcels GROUP BY submit_day ORDER BY submit_day DESC LIMIT 60`,
  ).all();
  return c.json({ parcels: await list(c.env, where.join(' AND '), binds), days: days.results });
});

parcelRoutes.get('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const [parcel] = await list(c.env, 'p.id = ?', [id]);
  if (!parcel) throw notFound('没有这个包裹');
  return c.json({ parcel });
});

/** 群主可以改单价（仓库涨价、这位客户给优惠）；单号和毛重也能替仓库改。放行后照样能改价，改完客户页跟着变。 */
parcelRoutes.patch('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '包裹 ID');
  const exists = await c.env.DB.prepare('SELECT id FROM parcels WHERE id = ?').bind(id).first();
  if (!exists) throw notFound('没有这个包裹');
  const body = await readJson<{ saleFenPerKg?: unknown; costFenPerKg?: unknown; trackingNo?: unknown; grossWeightG?: unknown; note?: unknown }>(c);
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  if (body.saleFenPerKg !== undefined) stmts.push(db.prepare('UPDATE parcels SET sale_fen_per_kg = ? WHERE id = ?').bind(requirePricePerKg(body.saleFenPerKg, '收客户的单价'), id));
  if (body.costFenPerKg !== undefined) stmts.push(db.prepare('UPDATE parcels SET cost_fen_per_kg = ? WHERE id = ?').bind(requirePricePerKg(body.costFenPerKg, '仓库单价'), id));
  if (body.trackingNo !== undefined) stmts.push(db.prepare('UPDATE parcels SET tracking_no = ? WHERE id = ?').bind(bound(requireString(body.trackingNo, '快递单号'), '快递单号', 60), id));
  if (body.grossWeightG !== undefined) stmts.push(db.prepare('UPDATE parcels SET gross_weight_g = ? WHERE id = ?').bind(requireWeightG(body.grossWeightG), id));
  if (body.note !== undefined) stmts.push(db.prepare('UPDATE parcels SET note = ? WHERE id = ?').bind(bound(optionalString(body.note), '备注', 200), id));
  if (stmts.length) await db.batch(stmts);
  return c.json({ ok: true });
});

/**
 * 【单号放行】：收完运费点这个，客户页上才出现单号和平铺图，包裹里的东西变「已寄出」。
 * 可以一次放行好几个（一天的包裹勾一排一起放）。
 */
parcelRoutes.post('/release', async (c) => {
  const body = await readJson<{ parcelIds?: unknown; undo?: boolean }>(c);
  const ids = [...new Set(intList(body.parcelIds, '包裹'))];
  if (ids.length > 90) throw badRequest('一次最多放行 90 个包裹');
  const db = c.env.DB;
  const rows = await db
    .prepare(`SELECT id, released_at AS releasedAt FROM parcels WHERE id IN (${placeholders(ids.length)})`)
    .bind(...ids)
    .all<{ id: number; releasedAt: string | null }>();
  if (rows.results.length !== ids.length) throw badRequest('有的包裹不存在，刷新一下');
  const at = nowIso();
  const targets = rows.results.filter((r) => (body.undo ? r.releasedAt : !r.releasedAt)).map((r) => r.id);
  if (targets.length === 0) throw badRequest(body.undo ? '这些包裹都还没放行' : '这些包裹都已经放行过了');
  const items = await db
    .prepare(`SELECT id, status FROM items WHERE parcel_id IN (${placeholders(targets.length)})`)
    .bind(...targets)
    .all<{ id: number; status: string }>();
  const [from, to] = body.undo ? ['shipped', 'packed'] : ['packed', 'shipped'];
  await db.batch([
    db.prepare(`UPDATE parcels SET released_at = ? WHERE id IN (${placeholders(targets.length)})`).bind(body.undo ? null : at, ...targets),
    ...items.results
      .filter((i) => i.status === from)
      .flatMap((i) => [
        db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').bind(to, at, i.id),
        statusLogStmt(db, i.id, from, to, at),
      ]),
  ]);
  return c.json({ ok: true, count: targets.length });
});

parcelRoutes.get('/:id/photos/:pid', async (c) => {
  const res = await photoResponse(c.env, requireInt(c.req.param('id'), '包裹 ID'), requireInt(c.req.param('pid'), '图片 ID'));
  return res ?? c.json({ error: '没有这张图' }, 404);
});
