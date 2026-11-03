/** 物流状态定义（items.status / packages.status 共用一套）。 */

export const ITEM_STATUSES = [
  'ordered',
  'jp_warehouse',
  'sorted',
  'packed',
  'intl_transit',
  'cn_arrived',
  'cn_stock',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
] as const;

export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const STATUS_LABELS: Record<ItemStatus, string> = {
  ordered: '已下单',
  jp_warehouse: '已到日本仓',
  // 仓库点了【整理完成】：客户看到这一步就知道东西到了、分好了，不用天天来问
  sorted: '已分拣',
  // 直邮：仓库已经打好包、填好单号，等群主收完运费放行单号
  packed: '已打包',
  intl_transit: '回国中',
  cn_arrived: '回国中',
  // 方案里叫「国内在库」，界面统一显示「可发货」：分摊完客户就能申请，只看 key 看不出这一步能做什么
  cn_stock: '可发货',
  shipped: '已寄出',
  delivered: '已签收',
  cancelled: '缺货取消',
  refunded: '已退款',
};

/** 允许在包裹层面批量设置的状态。cn_stock 及之后由称重 / 寄出流程推进。 */
export const PACKAGE_BULK_STATUSES: ItemStatus[] = [
  'ordered',
  'jp_warehouse',
  'intl_transit',
  'cn_arrived',
];

/** 批量改包裹状态时不跟随变更的物品状态。 */
export const BULK_SKIP_STATUSES: ItemStatus[] = [
  'sorted',
  'packed',
  'cn_stock',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
];

export function isItemStatus(value: unknown): value is ItemStatus {
  return typeof value === 'string' && (ITEM_STATUSES as readonly string[]).includes(value);
}

export function statusLabel(value: string): string {
  return (STATUS_LABELS as Record<string, string>)[value] ?? value;
}
