/** 后台与客户页共用的小工具。 */

export const STATUS_LABELS = {
  ordered: '已下单',
  jp_warehouse: '已到日本仓',
  intl_transit: '国际运输中',
  cn_arrived: '已到国内，待称重',
  cn_stock: '国内在库',
  shipped: '已寄出',
  delivered: '已签收',
  cancelled: '缺货取消',
  refunded: '已退款',
};

export const PACKAGE_BULK_STATUSES = ['ordered', 'jp_warehouse', 'intl_transit', 'cn_arrived'];

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

/** 分 → "¥12.34" */
export function money(fen) {
  const n = Number(fen || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(n));
  return `${sign}¥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** "12.34" → 1234（前端只做展示回填，真正的换算在服务端） */
export function yuanToFen(text) {
  const n = Number(String(text).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function jpy(value) {
  if (value === null || value === undefined) return '—';
  return `¥${Number(value).toLocaleString('ja-JP')}`;
}

/** UTC ISO → 北京时间展示 */
export function beijingTime(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: withTime ? '2-digit' : undefined,
    minute: withTime ? '2-digit' : undefined,
    hour12: false,
  }).format(d);
  return parts;
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 4200 : 2200);
}

export function thumb(item) {
  if (item.imageUrl) {
    return `<img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy"
             onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'无图'}))">`;
  }
  return '<div class="noimg">无图</div>';
}
