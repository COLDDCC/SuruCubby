/** 后台与客户页共用的小工具。 */

export const STATUS_LABELS = {
  ordered: '已下单',
  jp_warehouse: '已到日本仓',
  direct_unpaid: '直邮待付款',
  direct_ready: '直邮待寄出',
  intl_transit: '回国中',
  cn_arrived: '回国中',
  cn_stock: '可发货',
  shipped: '已寄出',
  delivered: '已签收',
  cancelled: '缺货取消',
  refunded: '已退款',
};

export const ROUTE_LABELS = { group: '拼团', direct: '直邮' };

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

/**
 * 一件东西的完整信息（后台、日本仓、客户页共用一份排版）。
 * 单号后面都带「复制」按钮：data-copy，由页面自己绑定（copyText）。
 */
export function itemDetailHtml(d) {
  const copy = (v) => (v ? ` <button class="small plain" data-copy="${escapeHtml(v)}">复制</button>` : '');
  const row = (label, value) =>
    `<div class="dl-row"><span class="dl-k">${label}</span><span class="dl-v">${value}</span></div>`;
  const none = '<span class="muted">—</span>';
  const tn = (v) => (v ? `<b class="mono">${escapeHtml(v)}</b>${copy(v)}` : '<span class="muted">还没有</span>');
  const routeText = d.route === 'direct' ? '日本直邮' : '拼团';

  const shipping = [];
  if (d.route === 'direct') {
    shipping.push(
      row(
        '直邮单号',
        d.direct
          ? `${d.direct.carrier ? `${escapeHtml(d.direct.carrier)} ` : ''}${tn(d.direct.trackingNo)}
             <div class="small muted">直邮包裹 #${d.direct.parcelId} · ${escapeHtml(d.direct.statusLabel || '')}${
               d.direct.feeFen !== undefined && d.direct.feeFen !== null ? ` · 运费 ${money(d.direct.feeFen)}` : ''
             }</div>`
          : '<span class="muted">还没打包</span>',
      ),
    );
  } else {
    shipping.push(
      row(
        '回国单号',
        d.returnBox
          ? `${tn(d.returnBox.trackingNo)}<div class="small muted">${escapeHtml(d.returnBox.name || '')}</div>`
          : '<span class="muted">还没装箱</span>',
      ),
    );
    shipping.push(row('国内单号', d.domestic ? tn(d.domestic.trackingNo) : '<span class="muted">还没从国内寄出</span>'));
  }

  const p = d.prices;
  const prices = p
    ? row(
        '价格',
        `实际价 ${yen(p.actualPriceJpy)}${p.listPriceJpy ? ` · 平时价 ${yen(p.listPriceJpy)}` : ''} · 应付 <b>${yen(p.goodsFeeJpy)}</b>
         <span class="badge ${p.goodsPaid ? 'ok' : 'danger'}">${p.goodsPaid ? '货款已付' : '货款未付'}</span>`,
      )
    : '';

  return `
    <div class="detail">
      <div class="detail-head">
        <div class="detail-cover">${thumb(d)}</div>
        <div>
          <div class="detail-title">${
            d.product?.url
              ? `<a href="${escapeHtml(d.product.url)}" target="_blank" rel="noreferrer">${escapeHtml(d.title)}</a>`
              : escapeHtml(d.title)
          }</div>
          <div class="small" style="margin-top:4px">
            <span class="badge">${escapeHtml(d.statusLabel || '')}</span>
            <span class="badge ${d.route === 'direct' ? 'warn' : ''}">${routeText}</span>
            ${d.missing ? '<span class="badge danger">缺件</span>' : ''}
          </div>
          ${d.exceptionNote ? `<div class="small" style="color:var(--warn);margin-top:4px">${escapeHtml(d.exceptionNote)}</div>` : ''}
        </div>
      </div>
      <div class="detail-journey">${journeyHtml(journeyFromDetail(d))}</div>
      <div class="dl">
        ${row('归属', `<span class="cn-chip">${escapeHtml(d.owner.cn)}</span>${
          d.owner.nickname && d.owner.nickname !== d.owner.cn ? ` <span class="muted">（${escapeHtml(d.owner.nickname)}）</span>` : ''
        } · QQ <b class="mono">${escapeHtml(d.owner.qq)}</b>${copy(d.owner.qq)}`)}
        ${row('下单时间', escapeHtml(d.orderedAt || '—'))}
        ${row('日本订单号', d.batch.orderNo ? `<b class="mono">${escapeHtml(d.batch.orderNo)}</b>${copy(d.batch.orderNo)}` : none)}
        ${row('日本运单号', tn(d.jpTrackingNo))}
        ${shipping.join('')}
        ${row(
          '商品页',
          d.product?.url
            ? `${escapeHtml(d.product.shop || '商品页')}${d.product.code ? ` · 货号 <b class="mono">${escapeHtml(d.product.code)}</b>` : ''}
               · <a href="${escapeHtml(d.product.url)}" target="_blank" rel="noreferrer">打开 ↗</a>`
            : none,
        )}
        ${prices}
        ${row('批次', escapeHtml(d.batch.name || ''))}
      </div>
      ${
        d.timeline?.length
          ? `<details class="small" ${d.timeline.length <= 6 ? 'open' : ''}><summary>经过（${d.timeline.length} 步）</summary>
              <ol class="timeline">${d.timeline
                .map(
                  (t) => `<li><span class="muted">${beijingTime(t.at)}</span> ${escapeHtml(t.toLabel)}${
                    t.byName ? ` <span class="muted">· ${escapeHtml(t.byName)}</span>` : ''
                  }</li>`,
                )
                .join('')}</ol></details>`
          : ''
      }
    </div>`;
}

/**
 * 一件东西走到哪一步了、现在在哪个包裹里。客户页每件商品、物品详情都用这一份。
 * 传进来的字段（缺的就当没有）：
 *   route, status, missing, sortedAt, jpTrackingNo,
 *   packageName, returnTrackingNo,                     拼团的回国箱
 *   shipmentTrackingNo,                                国内寄出
 *   directParcelId, parcelStatus, parcelTrackingNo, parcelCarrier   直邮包裹
 */
const JOURNEY_STEPS = {
  group: ['下单', '日本仓', '回国中', '国内仓', '已寄出', '签收'],
  direct: ['下单', '日本仓', '待付款', '待寄出', '已寄出', '签收'],
};

export function journey(i) {
  const route = i.route === 'direct' ? 'direct' : 'group';
  const steps = JOURNEY_STEPS[route];
  const tn = (label, no) => (no ? `${label} <b class="mono">${escapeHtml(no)}</b>` : '');
  const join = (...parts) => parts.filter(Boolean).join(' · ');
  if (i.status === 'cancelled' || i.status === 'refunded') {
    return { steps, current: -1, tone: 'dead', where: i.status === 'refunded' ? '已退款' : '缺货取消，钱会退给你' };
  }
  let current = 0;
  let where = '';
  const parcel = i.directParcelId ? `直邮包裹 #${i.directParcelId}` : '';
  const ems = tn(i.parcelCarrier || 'EMS', i.parcelTrackingNo);
  switch (i.status) {
    case 'ordered':
      current = 0;
      where = join('还在日本，等店家发货到日本仓', tn('日本运单', i.jpTrackingNo));
      break;
    case 'jp_warehouse':
      current = 1;
      if (route === 'direct') {
        where = parcel ? join(`已装进${parcel}，等称重算运费`, ems) : i.sortedAt ? '已到日本仓、分拣好了，等打包（要有收货地址）' : '已到日本仓，等分拣';
      } else {
        where = i.sortedAt && i.packageName ? `已分进「${escapeHtml(i.packageName)}」，等这一箱发出` : '已到日本仓，等分拣';
      }
      break;
    case 'direct_unpaid':
      current = 2;
      where = join(`在${parcel || '直邮包裹'}里，运费待付`, ems);
      break;
    case 'direct_ready':
      current = 3;
      where = join(`在${parcel || '直邮包裹'}里，运费已付，等日本仓寄出`, ems);
      break;
    case 'intl_transit':
      current = 2;
      where = join(i.packageName ? `在「${escapeHtml(i.packageName)}」里回国中` : '回国中', tn('回国单号', i.returnTrackingNo));
      break;
    case 'cn_arrived':
      current = 3;
      where = join(i.packageName ? `「${escapeHtml(i.packageName)}」已到国内，等称重算运费` : '已到国内，等称重算运费', tn('回国单号', i.returnTrackingNo));
      break;
    case 'cn_stock':
      current = 3;
      where = '在国内仓，可以申请发货了';
      break;
    case 'shipped':
      current = 4;
      where = route === 'direct' ? join(`${parcel || '直邮包裹'}已从日本寄出`, ems) : join('已从国内寄出', tn('快递单号', i.shipmentTrackingNo));
      break;
    case 'delivered':
      current = 5;
      where = route === 'direct' ? join('已签收', ems) : join('已签收', tn('快递单号', i.shipmentTrackingNo));
      break;
    default:
      where = escapeHtml(statusLabel(i.status));
  }
  if (i.missing) where = join(where, '<span class="unpaid">这一件没到齐，群主在跟</span>');
  return { steps, current, tone: current === 5 ? 'done' : 'live', where };
}

/** 进度条 + 「现在在哪」一行。 */
export function journeyHtml(i) {
  const j = journey(i);
  if (j.current < 0) return `<div class="where dead">${j.where}</div>`;
  return `<ol class="journey" aria-label="进度：${escapeHtml(j.steps[j.current])}">${j.steps
    .map((s, k) => `<li class="${k < j.current ? 'done' : k === j.current ? 'now' : ''}"><span>${s}</span></li>`)
    .join('')}</ol>
    <div class="where">${j.where}</div>`;
}

/** 把物品详情接口的结构摊平成 journey() 要的字段。 */
export function journeyFromDetail(d) {
  return {
    route: d.route,
    status: d.status,
    missing: d.missing,
    sortedAt: d.sortedAt,
    jpTrackingNo: d.jpTrackingNo,
    packageName: d.returnBox?.name,
    returnTrackingNo: d.returnBox?.trackingNo,
    shipmentTrackingNo: d.domestic?.trackingNo,
    directParcelId: d.direct?.parcelId,
    parcelStatus: d.direct?.status,
    parcelTrackingNo: d.direct?.trackingNo,
    parcelCarrier: d.direct?.carrier,
  };
}
