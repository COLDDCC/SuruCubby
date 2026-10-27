/** 物流状态定义（items.status / packages.status 共用一套）。 */

export const ITEM_STATUSES = [
  'ordered',
  'jp_warehouse',
  'direct_unpaid',
  'direct_ready',
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
  // 直邮：日本仓打包称重后等客户付运费，付了就等寄出；寄出后和拼团一样走 shipped / delivered
  direct_unpaid: '直邮待付款',
  direct_ready: '直邮待寄出',
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
  'direct_unpaid',
  'direct_ready',
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

export type Route = 'group' | 'direct';
export const ROUTE_LABELS: Record<Route, string> = { group: '拼团', direct: '直邮' };

/** 只有流程推进得到的状态：不许在物品 / 包裹上手动改成它们。 */
export const FLOW_ONLY_STATUSES: ItemStatus[] = ['direct_unpaid', 'direct_ready', 'cn_stock', 'shipped', 'delivered'];
