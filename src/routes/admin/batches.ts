import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { notFound, optionalString, readJson, requireInt } from '../../lib/http.ts';
import { fetchOgImage } from '../../lib/ogImage.ts';
import { nowIso } from '../../lib/db.ts';

export const batchRoutes = new Hono<{ Bindings: Env }>();

batchRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.name, b.ordered_at AS orderedAt, b.source_file AS sourceFile,
            b.created_at AS createdAt,
            (SELECT COUNT(*) FROM items i WHERE i.batch_id = b.id) AS itemCount,
            (SELECT COALESCE(SUM(i.goods_fee_fen), 0) FROM items i WHERE i.batch_id = b.id) AS amountFen,
            (SELECT COALESCE(SUM(i.goods_fee_fen), 0) FROM items i
              WHERE i.batch_id = b.id AND i.goods_paid = 0 AND i.status NOT IN ('cancelled','refunded')) AS unpaidFen
       FROM batches b
      ORDER BY b.id DESC`,
  ).all();
  return c.json({ batches: rows.results });
});

batchRoutes.get('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '批次 ID');
  const batch = await c.env.DB.prepare(
    'SELECT id, name, ordered_at AS orderedAt, source_file AS sourceFile, created_at AS createdAt FROM batches WHERE id = ?',
  )
    .bind(id)
    .first();
  if (!batch) throw notFound('批次不存在');

  const items = await c.env.DB.prepare(
    `SELECT i.id, i.customer_id AS customerId, c.nickname, c.qq, i.title, i.image_url AS imageUrl,
            i.product_url AS productUrl, i.actual_price_jpy AS actualPriceJpy,
            i.list_price_jpy AS listPriceJpy, i.goods_fee_fen AS goodsFeeFen, i.status,
            i.goods_paid AS goodsPaid, i.missing, i.exception_note AS exceptionNote,
            i.row_no AS rowNo, i.package_id AS packageId
       FROM items i
       JOIN customers c ON c.id = i.customer_id
      WHERE i.batch_id = ?
      ORDER BY c.nickname, i.row_no`,
  )
    .bind(id)
    .all();

  const packages = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.status FROM packages p
       JOIN package_batches pb ON pb.package_id = p.id
      WHERE pb.batch_id = ?`,
  )
    .bind(id)
    .all();

  return c.json({ batch, items: items.results, packages: packages.results });
});

batchRoutes.patch('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '批次 ID');
  const body = await readJson<{ name?: string; orderedAt?: string }>(c);
  const name = optionalString(body.name);
  const orderedAt = optionalString(body.orderedAt);
  await c.env.DB.prepare(
    'UPDATE batches SET name = COALESCE(?, name), ordered_at = COALESCE(?, ordered_at) WHERE id = ?',
  )
    .bind(name, orderedAt, id)
    .run();
  return c.json({ ok: true });
});

/**
 * 补封面图：对这一批里「有商品链接、但没有图片」的物品，去抓商品页的 og:image。
 * 一次最多处理 20 件，抓不到就算了（客户页会显示占位图）。
 */
batchRoutes.post('/:id/fetch-images', async (c) => {
  const id = requireInt(c.req.param('id'), '批次 ID');
  const rows = await c.env.DB.prepare(
    `SELECT id, product_url AS productUrl FROM items
      WHERE batch_id = ? AND image_url IS NULL AND product_url IS NOT NULL
      LIMIT 20`,
  )
    .bind(id)
    .all<{ id: number; productUrl: string }>();

  const at = nowIso();
  const statements: D1PreparedStatement[] = [];
  let filled = 0;
  for (const row of rows.results) {
    const image = await fetchOgImage(row.productUrl);
    if (!image) continue;
    filled += 1;
    statements.push(
      c.env.DB.prepare('UPDATE items SET image_url = ?, updated_at = ? WHERE id = ?').bind(image, at, row.id),
    );
  }
  if (statements.length > 0) await c.env.DB.batch(statements);

  const left = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM items
      WHERE batch_id = ? AND image_url IS NULL AND product_url IS NOT NULL`,
  )
    .bind(id)
    .first<{ count: number }>();

  return c.json({ tried: rows.results.length, filled, left: left?.count ?? 0 });
});
