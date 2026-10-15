import type { Env } from './env.ts';

/** 客户仓库视图：客户专属页和后台「客户详情」共用同一份数据。 */
export async function buildCustomerView(env: Env, customerId: number) {
  const db = env.DB;

  const customer = await db
    .prepare('SELECT id, qq, nickname, note, token, self_return AS selfReturn, created_at AS createdAt FROM customers WHERE id = ?')
    .bind(customerId)
    .first<{
      id: number;
      qq: string;
      nickname: string;
      note: string | null;
      token: string;
      selfReturn: number;
      createdAt: string;
    }>();
  if (!customer) return null;

  const items = await db
    .prepare(
      `SELECT i.id, i.title, i.image_url AS imageUrl, i.product_url AS productUrl,
              i.list_price_jpy AS listPriceJpy, i.actual_price_jpy AS actualPriceJpy,
              i.goods_fee_jpy AS goodsFeeJpy, i.status, i.goods_paid AS goodsPaid,
              i.missing, i.exception_note AS exceptionNote, i.batch_id AS batchId,
              b.name AS batchName, i.package_id AS packageId, p.name AS packageName,
              i.weigh_group_id AS weighGroupId, i.shipment_id AS shipmentId, i.updated_at AS updatedAt,
              i.weight_g AS weightG, i.intl_fee_fen AS intlFeeFen, i.intl_paid AS intlPaid, p.tracking_no AS returnTrackingNo,
              b.order_no AS orderNo,b.japan_tracking_no AS japanTrackingNo,
              (SELECT request_id FROM request_items ri WHERE ri.item_id=i.id) AS requestId
         FROM items i
         JOIN batches b ON b.id = i.batch_id
         LEFT JOIN packages p ON p.id = i.package_id
        WHERE i.customer_id = ?
        ORDER BY i.id DESC`,
    )
    .bind(customerId)
    .all();

  const weighGroups = await db
    .prepare(
      `SELECT g.id, g.package_id AS packageId, p.name AS packageName, g.weight_g AS weightG,
              g.intl_fee_fen AS intlFeeFen, g.fee_paid AS feePaid
         FROM weigh_groups g
         JOIN packages p ON p.id = g.package_id
        WHERE g.customer_id = ? AND g.intl_fee_fen IS NOT NULL
        ORDER BY g.id DESC`,
    )
    .bind(customerId)
    .all<{
      id: number;
      packageId: number;
      packageName: string;
      weightG: number | null;
      intlFeeFen: number | null;
      feePaid: number;
    }>();

  const shipments = await db
    .prepare(
      `SELECT s.id, s.tracking_no AS trackingNo, s.fee_fen AS feeFen, s.fee_paid AS feePaid,
              s.shipped_at AS shippedAt, s.created_at AS createdAt,
              (SELECT COUNT(*) FROM items i WHERE i.shipment_id = s.id) AS itemCount
         FROM shipments s
        WHERE s.customer_id = ?
        ORDER BY s.id DESC`,
    )
    .bind(customerId)
    .all();

  const timeline = await db
    .prepare(
      `SELECT l.id, l.item_id AS itemId, i.title, l.from_status AS fromStatus,
              l.to_status AS toStatus, l.at
         FROM status_logs l
         JOIN items i ON i.id = l.item_id
        WHERE i.customer_id = ?
        ORDER BY l.at DESC, l.id DESC
        LIMIT 30`,
    )
    .bind(customerId)
    .all();

  const batches = await db
    .prepare(
      `SELECT i.batch_id AS batchId, b.name AS batchName, COUNT(*) AS count,
              SUM(i.goods_fee_jpy) AS amountJpy,
              SUM(CASE WHEN i.goods_paid = 0 AND i.status NOT IN ('cancelled','refunded')
                       THEN i.goods_fee_jpy ELSE 0 END) AS unpaidJpy
         FROM items i
         JOIN batches b ON b.id = i.batch_id
        WHERE i.customer_id = ?
        GROUP BY i.batch_id
        ORDER BY i.batch_id DESC`,
    )
    .bind(customerId)
    .all<{ batchId: number; batchName: string; count: number; amountJpy: number; unpaidJpy: number }>();

  const itemRows = items.results as Array<{
    status: string;
    goodsPaid: number;
    goodsFeeJpy: number;
    weighGroupId: number | null;
  }>;
  const goodsUnpaidJpy = itemRows
    .filter((i) => !i.goodsPaid && i.status !== 'cancelled' && i.status !== 'refunded')
    .reduce((sum, i) => sum + i.goodsFeeJpy, 0);
  const unitFees=await db.prepare(`SELECT COALESCE(SUM(intl_fee_fen),0) AS n FROM items WHERE customer_id=? AND intl_paid=0 AND intl_fee_fen IS NOT NULL AND status NOT IN ('cancelled','refunded')`).bind(customerId).first<{n:number}>();
  const intlUnpaidFen=(unitFees?.n??0)+weighGroups.results.filter(g=>!g.feePaid && !(items.results as any[]).some(i=>i.weighGroupId===g.id && i.intlFeeFen!==null)).reduce((s,g)=>s+(g.intlFeeFen??0),0);
  const shipmentRows = shipments.results as Array<{ feePaid: number; feeFen: number }>;
  const pendingDomestic=await db.prepare("SELECT COALESCE(SUM(domestic_fee_fen),0) AS n FROM shipping_requests WHERE customer_id=? AND status='pending'").bind(customerId).first<{n:number}>();
  const domesticUnpaidFen = (pendingDomestic?.n??0) + shipmentRows
    .filter((s) => !s.feePaid)
    .reduce((sum, s) => sum + s.feeFen, 0);
  const stockCount = itemRows.filter((i) => i.status === 'cn_stock').length;

  // 每一摞包含哪些物品
  const groupItems = new Map<number, Array<{ id: number; title: string }>>();
  for (const item of items.results as Array<{ id: number; title: string; weighGroupId: number | null }>) {
    if (item.weighGroupId === null) continue;
    const list = groupItems.get(item.weighGroupId) ?? [];
    list.push({ id: item.id, title: item.title });
    groupItems.set(item.weighGroupId, list);
  }
  const shipmentItems = new Map<number, Array<{ id: number; title: string }>>();
  for (const item of items.results as Array<{ id: number; title: string; shipmentId: number | null }>) {
    if (item.shipmentId === null) continue;
    const list = shipmentItems.get(item.shipmentId) ?? [];
    list.push({ id: item.id, title: item.title });
    shipmentItems.set(item.shipmentId, list);
  }

  const addresses = await db.prepare('SELECT id,recipient,phone,detail FROM addresses WHERE customer_id=? ORDER BY id').bind(customerId).all();
  const requests = await db.prepare('SELECT id,address_snapshot AS addressSnapshot,domestic_fee_fen AS domesticFeeFen,status,created_at AS createdAt, (SELECT COUNT(*) FROM request_items ri WHERE ri.request_id=shipping_requests.id) AS itemCount FROM shipping_requests WHERE customer_id=? ORDER BY id DESC').bind(customerId).all();
  return {
    domesticFeeFen: Number((await db.prepare("SELECT value FROM settings WHERE key='domestic_fee_fen'").first<{value:string}>())?.value ?? 1000),
    addresses: addresses.results, requests: requests.results,
    customer: { id: customer.id, qq: customer.qq, nickname: customer.nickname, selfReturn: !!customer.selfReturn, createdAt: customer.createdAt },
    summary: {
      goodsUnpaidJpy,
      intlUnpaidFen,
      domesticUnpaidFen,
      // 货款是日元、运费是人民币，汇率随时在变，两者不能加成一个数
      freightUnpaidFen: intlUnpaidFen + domesticUnpaidFen,
      stockCount,
      itemCount: itemRows.length,
    },
    batches: batches.results,
    items: items.results,
    weighGroups: weighGroups.results.map((g) => ({ ...g, items: groupItems.get(g.id) ?? [] })),
    shipments: (shipments.results as Array<{ id: number }>).map((s) => ({
      ...s,
      items: shipmentItems.get(s.id) ?? [],
    })),
    timeline: timeline.results,
  };
}
