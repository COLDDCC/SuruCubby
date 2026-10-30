/** 后台与客户页共用的小工具。 */

export const STATUS_LABELS = {
  ordered: '已下单',
  jp_warehouse: '已到日本仓',
  intl_transit: '回国中',
  cn_arrived: '回国中',
  cn_stock: '可发货',
  shipped: '已寄出',
  delivered: '已签收',
  cancelled: '缺货取消',
  refunded: '已退款',
};

export const PACKAGE_BULK_STATUSES = ['ordered', 'jp_warehouse', 'intl_transit'];

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

/** 円 → "1,234円"。货款一律按日元记，和 money()（人民币分）不能混着显示。 */
export function yen(value) {
  if (value === null || value === undefined) return '—';
  const n = Math.trunc(Number(value) || 0);
  return `${n.toLocaleString('en-US')}円`;
}

/** 分 → "12.34"，往输入框里回填用（不带 ¥）。 */
export function fenToYuan(fen) {
  return money(fen).replace('¥', '');
}

/** "12.34" → 1234（前端只做展示回填，真正的换算在服务端） */
export function yuanToFen(text) {
  const n = Number(String(text).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
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

/**
 * 复制一段文本。`navigator.clipboard` 只在 HTTPS 或 localhost 下存在，
 * 客户从局域网 http 地址打开时没有它，硬调会直接抛异常，所以留一条兜底。
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 被权限拦了，继续走兜底 */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let done = false;
  try {
    done = document.execCommand('copy');
  } catch {
    done = false;
  }
  ta.remove();
  return done;
}

/**
 * 封面图统一走自己域名下的 /img/i/{id}：Worker 转一道 + 边缘缓存，
 * 国内快一些，换图床也不用改页面。万一代理不通（对方防盗链等），
 * 自动退回直接外链，再不行才显示「无图」。
 */
export function thumb(item) {
  if (!item.imageUrl) return '<div class="noimg">无图</div>';
  const inline = item.imageUrl.startsWith('data:');
  const proxied = item.id && !inline ? `/img/i/${item.id}` : item.imageUrl;
  const fallback = inline || item.imageUrl.startsWith('/') ? '' : item.imageUrl;
  return `<img src="${escapeHtml(proxied)}" alt="" loading="lazy"
           data-fallback="${escapeHtml(fallback)}"
           onerror="(function(el){var f=el.dataset.fallback;if(f&&el.src.indexOf(f)!==0){el.dataset.fallback='';el.src=f;return;}el.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'无图'}));})(this)">`;
}

/**
 * 对货用的「单号」= 骏河屋链接里 /product/detail/ 后面那段商品番号。
 * 箱子里的东西只有这个号能对得上，商品名反而不可靠。
 * 认不出来（链接不是详情页、或者结尾是一段商品名 slug）就返回空，不硬编。
 */
export function itemCode(productUrl) {
  if (!productUrl) return '';
  const path = String(productUrl).split(/[?#]/)[0].replace(/\/+$/, '');
  const candidates = [/\/product\/[^/]+\/([^/]+)/i, /\/([^/]+)$/].map((re) => {
    const m = path.match(re);
    return m ? decodeURIComponent(m[1]).trim() : '';
  });
  return candidates.find((c) => /^[0-9]{4,24}$|^[A-Za-z][A-Za-z0-9_-]{3,23}$/.test(c) && /[0-9]/.test(c)) || '';
}

/** 货号 + 能点开的商品页；没货号就只给链接。 */
export function codeTag(item) {
  if (!item.productUrl) return '';
  const code = itemCode(item.productUrl);
  const url = escapeHtml(item.productUrl);
  if (!code) return `<a class="code" href="${url}" target="_blank" rel="noreferrer">商品页</a>`;
  return `<a class="code" href="${url}" target="_blank" rel="noreferrer" title="${url}">${escapeHtml(code)}</a>`;
}

/** 商品链接的域名 → 店铺名。只在批次上没填店铺时兜底用。 */
const SHOP_BY_HOST = [
  [/(^|\.)suruga-ya\.jp$/i, '骏河屋'],
  [/(^|\.)booth\.pm$/i, 'booth'],
];

/**
 * 这件东西是从哪家店买的。
 * 批次上填了的优先（「骏河屋秋叶原店」这种链接里根本看不出来的，只能靠人手填）；
 * 没填就照商品链接的域名认；都认不出来返回空，不硬编一个店名。
 */
export function shopOf(item) {
  const filled = String(item.shop ?? '').trim();
  if (filled) return filled;
  try {
    const host = new URL(item.productUrl).hostname;
    return SHOP_BY_HOST.find(([re]) => re.test(host))?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * 货号底下的「单号 + 店铺」：都是要贴进群里的短串，点一下就复制走。
 * 两样都没有就什么都不画，不占地方。
 */
export function orderTag(item) {
  const orderNo = String(item.orderNo ?? '').trim();
  const shop = shopOf(item);
  if (!orderNo && !shop) return '';
  const order = orderNo
    ? `<button class="badge copy-chip mono" data-copy="${escapeHtml(orderNo)}" title="点一下复制单号">单号 ${escapeHtml(orderNo)}</button>`
    : '';
  const shopTag = shop
    ? `<button class="badge copy-chip" data-copy="${escapeHtml(shop)}" title="点一下复制来源">${escapeHtml(shop)}</button>`
    : '';
  return `<div class="small row" style="gap:6px;margin-top:3px">${order}${shopTag}</div>`;
}
