/**
 * 一件东西的完整信息：后台、日本仓、客户页共用一份。
 *   下单时间、归属（cn 原文 + 昵称 + QQ）、日本订单号、日本运单号、
 *   回国箱和回国单号 / 国内快递单号 / 直邮 EMS 单号、商品页链接和货号、价格、带操作人的时间线。
 *
 * money=false 时不给价格和付款状态（日本仓账号用）。
 */
import { surugaCode } from './images.ts';
import { statusLabel } from './status.ts';

const PARCEL_LABELS: Record<string, string> = {
  packing: '打包中（待称重）',
  awaiting_payment: '待付款',
  paid: '已付款，待寄出',
  shipped: '已寄出',
  delivered: '已签收',
};

const SHOPS: Array<[RegExp, string]> = [
  [/suruga-ya\.jp/i, '骏河屋'],
  [/mercari|jp\.mercari/i, '煤炉'],
  [/amazon\.co\.jp/i, '日亚'],
  [/yahoo|paypayfleamarket/i, '雅虎'],
  [/mandarake/i, '中古 Mandarake'],
  [/animate/i, 'animate'],
  [/melonbooks/i, 'Melonbooks'],
  [/toranoana/i, '虎之穴'],
];

export function shopName(url: string | null): string | null {
  if (!url) return null;
  return SHOPS.find(([re]) => re.test(url))?.[1] ?? (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  })();
}

interface Row {
  id: number;
  title: string;
  imageUrl: string | null;
  productUrl: string | null;
  status: string;
  route: string;
  missing: number;
  exceptionNote: string | null;
  customerId: number;
  cnLabel: string | null;
  nickname: string;
  qq: string;
  itemOrderedAt: string | null;
  batchId: number;
  batchName: string;
  orderNo: string | null;
  batchOrderedAt: string | null;
  batchCreatedAt: string;
  itemTracking: string | null;
  batchTracking: string | null;
  packageId: number | null;
  packageName: string | null;
  packageTracking: string | null;
  packageStatus: string | null;
  shipmentId: number | null;
  shipmentTracking: string | null;
  shippedAt: string | null;
  parcelId: number | null;
  parcelTracking: string | null;
  parcelCarrier: string | null;
  parcelStatus: string | null;
  parcelFee: number | null;
  sortedAt: string | null;
  listPriceJpy: number | null;
  actualPriceJpy: number | null;
  goodsFeeJpy: number;
  goodsPaid: number;
  intlFeeFen: number | null;
  intlPaid: number;
}

export async function buildItemDetail(db: D1Database, itemId: number, opts: { money: boolean; customerId?: number }) {
  const row = await db
    .prepare(
      `SELECT i.id, i.title, i.image_url AS imageUrl, i.product_url AS productUrl, i.status, i.route, i.missing,
              i.exception_note AS exceptionNote, i.customer_id AS customerId, i.cn_label AS cnLabel, c.nickname, c.qq,
              i.ordered_at AS itemOrderedAt, b.id AS batchId, b.name AS batchName, b.order_no AS orderNo,
              b.ordered_at AS batchOrderedAt, b.created_at AS batchCreatedAt,
              i.jp_tracking_no AS itemTracking, b.japan_tracking_no AS batchTracking,
              p.id AS packageId, p.name AS packageName, p.tracking_no AS packageTracking, p.status AS packageStatus,
              s.id AS shipmentId, s.tracking_no AS shipmentTracking, s.shipped_at AS shippedAt,
              d.id AS parcelId, d.tracking_no AS parcelTracking, d.carrier AS parcelCarrier, d.status AS parcelStatus, d.fee_fen AS parcelFee,
              i.sorted_at AS sortedAt, i.list_price_jpy AS listPriceJpy, i.actual_price_jpy AS actualPriceJpy,
              i.goods_fee_jpy AS goodsFeeJpy, i.goods_paid AS goodsPaid, i.intl_fee_fen AS intlFeeFen, i.intl_paid AS intlPaid
         FROM items i
         JOIN customers c ON c.id = i.customer_id
         JOIN batches b ON b.id = i.batch_id
         LEFT JOIN packages p ON p.id = i.package_id
         LEFT JOIN shipments s ON s.id = i.shipment_id
         LEFT JOIN direct_parcels d ON d.id = i.direct_parcel_id
        WHERE i.id = ? ${opts.customerId !== undefined ? 'AND i.customer_id = ?' : ''}`,
    )
    .bind(...(opts.customerId !== undefined ? [itemId, opts.customerId] : [itemId]))
    .first<Row>();
  if (!row) return null;

  const logs = await db
    .prepare('SELECT from_status AS fromStatus, to_status AS toStatus, at, by_name AS byName FROM status_logs WHERE item_id = ? ORDER BY at, id')
    .bind(itemId)
    .all<{ fromStatus: string | null; toStatus: string; at: string; byName: string | null }>();

  const code = row.productUrl ? surugaCode(row.productUrl) : '';
  return {
    id: row.id,
    title: row.title,
    imageUrl: row.imageUrl ? `/img/i/${row.id}` : null,
    status: row.status,
    statusLabel: statusLabel(row.status),
    route: row.route,
    missing: !!row.missing,
    exceptionNote: row.exceptionNote,
    owner: {
      customerId: row.customerId,
      cn: row.cnLabel?.trim() || row.nickname,
      nickname: row.nickname,
      qq: row.qq,
    },
    // 件上有就用件上的（表里「下单时间」列），否则用导入时填的订单日期，再没有就用导入那天
    orderedAt: row.itemOrderedAt ?? row.batchOrderedAt ?? row.batchCreatedAt.slice(0, 10),
    batch: { id: row.batchId, name: row.batchName, orderNo: row.orderNo },
    jpTrackingNo: row.itemTracking ?? row.batchTracking,
    sortedAt: row.sortedAt,
    returnBox:
      row.route === 'group' && row.packageId
        ? { packageId: row.packageId, name: row.packageName, trackingNo: row.packageTracking, status: row.packageStatus }
        : null,
    domestic: row.shipmentId ? { shipmentId: row.shipmentId, trackingNo: row.shipmentTracking, shippedAt: row.shippedAt } : null,
    direct: row.parcelId
      ? {
          parcelId: row.parcelId,
          trackingNo: row.parcelTracking,
          carrier: row.parcelCarrier,
          status: row.parcelStatus,
          statusLabel: PARCEL_LABELS[row.parcelStatus ?? ''] ?? row.parcelStatus,
          ...(opts.money ? { feeFen: row.parcelFee } : {}),
        }
      : null,
    product: { url: row.productUrl, code: code || null, shop: shopName(row.productUrl) },
    prices: opts.money
      ? {
          listPriceJpy: row.listPriceJpy,
          actualPriceJpy: row.actualPriceJpy,
          goodsFeeJpy: row.goodsFeeJpy,
          goodsPaid: !!row.goodsPaid,
          intlFeeFen: row.intlFeeFen,
          intlPaid: !!row.intlPaid,
        }
      : null,
    timeline: logs.results.map((l) => ({ ...l, toLabel: statusLabel(l.toStatus) })),
  };
}
