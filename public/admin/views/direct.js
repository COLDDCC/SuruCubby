import { api } from '/admin/api.js';
import { currentSession } from '/admin/app.js';
import { beijingTime, bindActions, codeTag, confirmBox, escapeHtml, money, promptBox, toast } from '/admin/ui.js';
import { bindItemDetails } from '/admin/itemDetail.js';

/**
 * 直邮包裹：打包中 → 待付款 → 已付款待寄出 → 已寄出 → 已签收。
 * 日本仓能称重、拆包、寄出；确认收款和标签收只有管理员能点（后端也拦）。
 */
const FILTERS = [
  { key: 'open', label: '进行中' },
  { key: 'packing', label: '待称重' },
  { key: 'awaiting_payment', label: '待付款' },
  { key: 'paid', label: '待寄出' },
  { key: 'shipped', label: '已寄出' },
  { key: '', label: '全部' },
];
let filter = 'open';

const BADGE = { packing: 'warn', awaiting_payment: 'danger', paid: 'ok', shipped: '', delivered: 'ok' };

function addressText(a) {
  if (!a) return '';
  if (a.raw) return a.raw;
  return [a.recipient, a.phone, a.detail].filter(Boolean).join(' ');
}

function parcelCard(p, isAdmin, priceFenPerKg) {
  const addr = addressText(p.address);
  const actions = [];
  if (p.status === 'packing' || p.status === 'awaiting_payment') {
    actions.push(`<div class="row ship-row">
      <input data-weight="${p.id}" inputmode="numeric" placeholder="重量（克）" value="${p.weightG ?? ''}">
      <button ${p.status === 'packing' ? '' : 'class="plain"'} data-action="weigh" data-id="${p.id}">${p.status === 'packing' ? '称重算运费' : '重称'}</button>
    </div>
    <p class="small muted">按 ${money(priceFenPerKg)} / kg 算，结果向上取整到分；称好后单价存档，之后改价不影响这一包。</p>`);
  }
  if (p.status === 'awaiting_payment') {
    actions.push(
      isAdmin
        ? `<p><button data-action="pay" data-id="${p.id}" data-fee="${p.feeFen}">客户已付 ${money(p.feeFen)}，确认收款</button></p>`
        : '<p class="small muted">等客户扫码付运费、管理员确认收款后，这里会变成「待寄出」。</p>',
    );
  }
  if (p.status === 'paid') {
    actions.push(`<div class="row ship-row">
      <input data-carrier="${p.id}" placeholder="承运商" value="${escapeHtml(p.carrier || 'EMS')}" style="max-width:120px">
      <input data-tracking="${p.id}" placeholder="国际单号" value="${escapeHtml(p.trackingNo || '')}">
      <button data-action="ship" data-id="${p.id}">寄出</button>
    </div>`);
  }
  if (p.status === 'shipped' || p.status === 'delivered') {
    actions.push(`<p>${escapeHtml(p.carrier || '')} <b>${escapeHtml(p.trackingNo || '')}</b>
      <button class="small plain" data-copy="${escapeHtml(p.trackingNo || '')}">复制单号</button>
      <button class="small plain" data-action="tracking" data-id="${p.id}" data-tracking="${escapeHtml(p.trackingNo || '')}" data-carrier="${escapeHtml(p.carrier || '')}">改单号</button>
      ${isAdmin && p.status === 'shipped' ? `<button class="small plain" data-action="delivered" data-id="${p.id}">客户收到了</button>` : ''}</p>`);
  }
  if (p.status === 'packing' || p.status === 'awaiting_payment') {
    actions.push(`<p><button class="small danger" data-action="cancel" data-id="${p.id}">拆包</button>
      <span class="small muted">件退回「已到日本仓」，可以重新打包。</span></p>`);
  }

  return `<div class="card parcel" data-parcel="${p.id}">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <h3 style="margin:0">#${p.id} · ${escapeHtml(p.nickname)} <span class="small muted">${p.items.length} 件</span></h3>
        <span class="badge ${BADGE[p.status] ?? ''}">${escapeHtml(p.statusLabel)}</span>
      </div>
      <div class="right">
        ${p.feeFen !== null ? `<div class="money ${p.status === 'awaiting_payment' ? 'unpaid' : ''}">${money(p.feeFen)}</div>` : ''}
        ${p.weightG ? `<div class="small muted">${Number(p.weightG).toLocaleString()} g × ${money(p.rateFenPerKg)}/kg</div>` : ''}
      </div>
    </div>
    <div class="addr">
      <span class="small muted">${p.addressSource === 'import' ? '寄到（导入表）' : '寄到（客户选的）'}</span>
      <div>${escapeHtml(addr)} <button class="small plain" data-copy="${escapeHtml(addr)}">复制地址</button></div>
    </div>
    ${
      p.trackingNo && !['shipped', 'delivered'].includes(p.status)
        ? `<p class="small" style="margin:8px 0 0">${escapeHtml(p.carrier || 'EMS')} 单号 <b class="mono">${escapeHtml(p.trackingNo)}</b>（分拣时填的，寄出时不用再填）</p>`
        : ''
    }
    <ul class="parcel-items">${p.items
      .map(
        (i) => `<li data-focus-item="${i.id}"><a href="#" data-detail="${i.id}">${escapeHtml(i.title)}</a> ${codeTag(i)}
          ${
            p.status === 'packing' || p.status === 'awaiting_payment'
              ? `<button class="small plain" data-action="remove" data-id="${p.id}" data-item="${i.id}" title="拿出这一件">拿出</button>`
              : ''
          }</li>`,
      )
      .join('')}</ul>
    ${actions.join('')}
    <p class="small muted" style="margin-bottom:0">打包 ${beijingTime(p.createdAt)}${p.packedBy ? ` · ${escapeHtml(p.packedBy)}` : ''}${
      p.paidAt ? ` · 收款 ${beijingTime(p.paidAt)}` : ''
    }${p.shippedAt ? ` · 寄出 ${beijingTime(p.shippedAt)}${p.shippedBy ? ` · ${escapeHtml(p.shippedBy)}` : ''}` : ''}</p>
  </div>`;
}

export async function render(view) {
  const isAdmin = currentSession().role === 'admin';
  const data = await api.get(`/api/staff/direct/parcels${filter ? `?status=${filter}` : ''}`);
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">直邮包裹</h2>
        <a class="small" href="#/jp">← 日本仓打包</a>
      </div>
      <div class="seg">${FILTERS.map(
        (f) => `<button class="${f.key === filter ? 'active' : ''}" data-filter="${f.key}">${f.label}</button>`,
      ).join('')}</div>
      <p class="small muted" style="margin-bottom:0">没确认收款的包裹不能寄出；付过款的不能拆包、改重量（要改先在收款记录里撤销）。</p>
    </div>
    <div class="parcel-grid">${
      data.parcels.length
        ? data.parcels.map((p) => parcelCard(p, isAdmin, data.priceFenPerKg)).join('')
        : '<div class="card"><p class="empty">这一栏没有包裹。</p></div>'
    }</div>`;

  view.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => {
      filter = b.dataset.filter;
      render(view);
    };
  });
  view.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('已复制');
      } catch {
        toast('复制不了，长按文字手动复制', true);
      }
    };
  });

  bindItemDetails(view);
  bindActions(view, {
    async weigh({ id }) {
      const weightG = Number(view.querySelector(`[data-weight="${id}"]`).value.trim());
      if (!weightG) return toast('先填重量（克）', true);
      const r = await api.post(`/api/staff/direct/parcels/${id}/weigh`, { weightG });
      toast(`运费 ${money(r.feeFen)}，客户页面已经能看到`);
      await render(view);
    },
    async pay({ id, fee }) {
      if (!(await confirmBox(`确认已经收到 ${money(Number(fee))} 直邮运费？收款后日本仓就能寄出。`, { okText: '确认收款' }))) return;
      await api.post(`/api/admin/direct/${id}/pay`);
      toast('已记收款');
      await render(view);
    },
    async ship({ id }) {
      const trackingNo = view.querySelector(`[data-tracking="${id}"]`).value.trim();
      const carrier = view.querySelector(`[data-carrier="${id}"]`).value.trim();
      if (!trackingNo) return toast('先填国际单号', true);
      await api.post(`/api/staff/direct/parcels/${id}/ship`, { trackingNo, carrier });
      toast('已寄出，客户页面能看到单号了');
      await render(view);
    },
    async tracking({ id, tracking, carrier }) {
      const trackingNo = await promptBox('改成哪个单号？', tracking);
      if (!trackingNo) return;
      await api.post(`/api/staff/direct/parcels/${id}/tracking`, { trackingNo, carrier });
      await render(view);
    },
    async delivered({ id }) {
      await api.post(`/api/admin/direct/${id}/delivered`);
      await render(view);
    },
    async cancel({ id }) {
      if (!(await confirmBox(`拆掉包裹 #${id}？里面的件退回「已到日本仓」。`, { okText: '拆包', danger: true }))) return;
      await api.post(`/api/staff/direct/parcels/${id}/cancel`);
      await render(view);
    },
    async remove({ id, item }) {
      const r = await api.post(`/api/staff/direct/parcels/${id}/remove`, { itemIds: [Number(item)] });
      toast(r.left ? '拿出来了，包裹要重新称重' : '包裹拿空了，已经拆掉');
      await render(view);
    },
  });
}
