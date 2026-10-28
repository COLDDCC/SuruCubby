/**
 * 找货：管理员的侧栏和日本仓共用一处查询。
 *
 * 一般只打货号的尾巴（8913 命中 ZHOTI678913），商品名片段、客户名（含别名）、
 * cn 原文、日本运单号、日本订单号也都认——仓库手里拿着快递面单或卡片时，抄哪个就搜哪个。
 * 结果只有干活要用的字段，没有价格和付款，日本仓账号拿到也不越权。
 */
import { surugaCode } from './images.ts';

export interface FoundItem {
  id: number;
  title: string;
  imageUrl: string | null;
  productUrl: string | null;
  status: string;
  route: string;
  packageId: number | null;
  batchId: number;
  customerId: number;
  nickname: string;
  cn: string;
  selfReturn: number;
  missing: number;
  batchName: string;
  orderNo: string | null;
  jpTrackingNo: string | null;
  packageName: string | null;
  allocatedAt: string | null;
  parcelId: number | null;
  sortedAt: string | null;
  code: string | null;
}

export async function searchItems(
  db: D1Database,
  rawQuery: string,
  opts: { packageId?: number | null; limit?: number } = {},
): Promise<FoundItem[]> {
  const q = rawQuery.replace(/[%_\\]/g, '').trim();
  if (q.length < 2) return [];
  const like = `%${q}%`;
  const packageId = opts.packageId ?? null;
  const rows = await db
    .prepare(
      `SELECT i.id, i.title, i.image_url AS imageUrl, i.product_url AS productUrl, i.status, i.route,
              i.package_id AS packageId, i.batch_id AS batchId, i.customer_id AS customerId,
              c.nickname, COALESCE(NULLIF(TRIM(i.cn_label), ''), c.nickname) AS cn,
              c.self_return AS selfReturn, i.missing, b.name AS batchName, b.order_no AS orderNo,
              COALESCE(i.jp_tracking_no, b.japan_tracking_no) AS jpTrackingNo,
              p.name AS packageName, p.allocated_at AS allocatedAt,
              i.direct_parcel_id AS parcelId, i.sorted_at AS sortedAt
         FROM items i
         JOIN customers c ON c.id = i.customer_id
         JOIN batches b ON b.id = i.batch_id
         LEFT JOIN packages p ON p.id = i.package_id
        WHERE (i.product_url LIKE ?1 OR i.title LIKE ?1 OR c.nickname LIKE ?1 OR i.cn_label LIKE ?1
               OR i.jp_tracking_no LIKE ?1 OR b.japan_tracking_no LIKE ?1 OR b.order_no LIKE ?1
               OR EXISTS (SELECT 1 FROM customer_aliases ca WHERE ca.customer_id = i.customer_id AND ca.alias LIKE ?1))
          ${packageId ? 'AND i.package_id = ?2' : ''}
        ORDER BY i.id DESC
        LIMIT ${Math.min(opts.limit ?? 30, 50)}`,
    )
    .bind(...(packageId ? [like, packageId] : [like]))
    .all<Omit<FoundItem, 'code'>>();
  return rows.results.map((r) => ({ ...r, code: surugaCode(r.productUrl ?? '') }));
}
