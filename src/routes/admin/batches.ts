import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { bound, notFound, optionalString, readJson, requireInt } from '../../lib/http.ts';
import { fetchOgImage } from '../../lib/ogImage.ts';
import { cacheImage, isHttpUrl, liveImageUrl, surugaImageCandidates } from '../../lib/images.ts';
import { nowIso } from '../../lib/db.ts';

export const batchRoutes = new Hono<{ Bindings: Env }>();

batchRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.name, b.ordered_at AS orderedAt, b.source_file AS sourceFile,
            b.created_at AS createdAt,
            (SELECT COUNT(*) FROM items i WHERE i.batch_id = b.id) AS itemCount,
            (SELECT COALESCE(SUM(i.goods_fee_jpy), 0) FROM items i WHERE i.batch_id = b.id) AS amountJpy,
            (SELECT COALESCE(SUM(i.goods_fee_jpy), 0) FROM items i
              WHERE i.batch_id = b.id AND i.goods_paid = 0 AND i.status NOT IN ('cancelled','refunded')) AS unpaidJpy
       FROM batches b
      ORDER BY b.id DESC`,
  ).all();
  return c.json({ batches: rows.results });
});

batchRoutes.get('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '批次 ID');
  const batch = await c.env.DB.prepare(
    'SELECT id, name, ordered_at AS orderedAt, source_file AS sourceFile, created_at AS createdAt,order_no AS orderNo,japan_tracking_no AS japanTrackingNo FROM batches WHERE id = ?',
  )
    .bind(id)
    .first();
  if (!batch) throw notFound('批次不存在');

  const items = await c.env.DB.prepare(
    `SELECT i.id, i.customer_id AS customerId, c.nickname, c.qq, i.title, i.image_url AS imageUrl,
            i.product_url AS productUrl, i.actual_price_jpy AS actualPriceJpy,
            i.list_price_jpy AS listPriceJpy, i.goods_fee_jpy AS goodsFeeJpy, i.status,
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
  const body = await readJson<{ name?: string; orderedAt?: string; orderNo?: string; japanTrackingNo?: string }>(c);
  const name = bound(optionalString(body.name), '批次名', 60);
  const orderedAt = optionalString(body.orderedAt);
  await c.env.DB.prepare(
    'UPDATE batches SET name = COALESCE(?, name), ordered_at = COALESCE(?, ordered_at) WHERE id = ?',
  )
    .bind(name, orderedAt, id)
    .run();
  if (body.orderNo !== undefined || body.japanTrackingNo !== undefined)
    await c.env.DB.prepare(
      'UPDATE batches SET order_no=COALESCE(?,order_no),japan_tracking_no=COALESCE(?,japan_tracking_no) WHERE id=?',
    )
      .bind(optionalString(body.orderNo), optionalString(body.japanTrackingNo), id)
      .run();
  return c.json({ ok: true });
});

/**
 * 固化封面图：对这一批里还没有站内图片的物品，
 *   1. 有外链图片地址就用它（=IMAGE("...") 公式里的地址在导入时已经被抽出来了）；
 *   2. 没有就去商品链接的页面抓 og:image；
 *   3. 商品页抓不到（骏河屋对国外 IP 直接 403）就按货号拼官方 CDN 的地址，
 *      取回来确认是图片才认，取不到就当没图；
 *   4. 绑了 R2 就把图抓下来存进自己的桶，图片地址换成 /img/{key}，从此不怕对方改地址或防盗链；
 *      没绑 R2 就退回直接外链。
 * 一次最多处理 20 件，按钮可以反复点直到 left 为 0。
 */
batchRoutes.post('/:id/images', async (c) => {
  const id = requireInt(c.req.param('id'), '批次 ID');
  const bucket = c.env.IMAGES;
  const limit = 20;

  // 还需要处理的是哪些：
  //   没开 R2 —— 只管「压根没有图」的（去商品页抓 og:image）；已有外链的就算完成了，
  //              页面走 /img/i/{id} 代理 + 边缘缓存，不用再动。
  //   开了 R2 —— 只要还没进桶（不是 /img/ 开头）就都要处理。
  const pending = bucket
    ? `(image_url IS NULL OR image_url NOT LIKE '/img/%')
         AND (image_url IS NOT NULL OR product_url IS NOT NULL)`
    : 'image_url IS NULL AND product_url IS NOT NULL';

  const rows = await c.env.DB.prepare(
    `SELECT id, image_url AS imageUrl, product_url AS productUrl FROM items
      WHERE batch_id = ? AND ${pending}
      ORDER BY id
      LIMIT ?`,
  )
    .bind(id, limit)
    .all<{ id: number; imageUrl: string | null; productUrl: string | null }>();
  const at = nowIso();
  const statements: D1PreparedStatement[] = [];
  const failures: Array<{ itemId: number; reason: string }> = [];
  let cached = 0;
  let linked = 0;

  for (const row of rows.results) {
    let source = isHttpUrl(row.imageUrl) ? row.imageUrl : null;
    if (!source && row.productUrl) source = await fetchOgImage(row.productUrl);
    if (!source && row.productUrl) {
      for (const candidate of surugaImageCandidates(row.productUrl)) {
        source = await liveImageUrl(candidate);
        if (source) break;
      }
    }
    if (!source) {
      failures.push({ itemId: row.id, reason: '商品页和货号都找不到图' });
      continue;
    }
    if (bucket) {
      const result = await cacheImage(bucket, source);
      if (result.path) {
        cached += 1;
        statements.push(
          c.env.DB.prepare('UPDATE items SET image_url = ?, updated_at = ? WHERE id = ?').bind(result.path, at, row.id),
        );
        continue;
      }
      failures.push({ itemId: row.id, reason: result.reason ?? '抓取失败' });
    }
    if (source !== row.imageUrl) {
      linked += 1;
      statements.push(
        c.env.DB.prepare('UPDATE items SET image_url = ?, updated_at = ? WHERE id = ?').bind(source, at, row.id),
      );
    }
  }
  if (statements.length > 0) await c.env.DB.batch(statements);

  const left = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM items WHERE batch_id = ? AND ${pending}`)
    .bind(id)
    .first<{ count: number }>();

  return c.json({
    r2: Boolean(bucket),
    tried: rows.results.length,
    cached,
    linked,
    failures,
    left: left?.count ?? 0,
  });
});
