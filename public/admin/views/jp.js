import { api } from '/admin/api.js';
import { bindActions, codeTag, confirmBox, escapeHtml, ROUTE_LABELS, toast } from '/admin/ui.js';

/**
 * 日本仓：三件事分三栏——
 *   待签收     日本的快递到了，按日本订单逐件或整单签收；
 *   回国箱     拼团的件装箱，齐了填回国单号发出；
 *   待打包直邮 按客户把直邮的件装成一包（可顺手填重量），之后去「直邮」页收款寄出。
 * 手机上一次看一栏（顶上切换），电脑上三栏一起列。
 */
const TABS = [
  { key: 'inbound', label: '待签收' },
  { key: 'boxes', label: '回国箱' },
  { key: 'direct', label: '待打包直邮' },
];
let currentTab = null;

function cover(item) {
  return item.imageUrl
    ? `<img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'无图'}))">`
    : '<div class="noimg">无图</div>';
}

function itemRow(item, { pick = false, checked = false, route = true } = {}) {
  return `<label class="jp-item${item.missing ? ' is-missing' : ''}" data-focus-item="${item.id}">
    ${pick ? `<input type="checkbox" data-pick="${item.id}" ${checked ? 'checked' : ''}>` : ''}
    <span class="jp-cover">${cover(item)}</span>
    <span class="jp-text">
      <span class="jp-title">${escapeHtml(item.title)}</span>
      <span class="small">${codeTag(item)} <b>${escapeHtml(item.nickname ?? '')}</b>
        ${route ? `<span class="badge ${item.route === 'direct' ? 'warn' : ''}">${ROUTE_LABELS[item.route] ?? ''}</span>` : ''}
        ${item.missing ? '<span class="badge danger">缺件</span>' : ''}</span>
    </span>
  </label>`;
}

function inboundHtml(list) {
  if (!list.length) return '<div class="card"><p class="empty">没有待签收的件，日本那边的货都到了。</p></div>';
  return list
    .map(
      (b) => `<div class="card" data-batch="${b.id}">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h3 style="margin:0">${escapeHtml(b.name)}</h3>
            <p class="small muted" style="margin:4px 0 0">日本订单 <b>${escapeHtml(b.orderNo || '—')}</b> · 日本单号
              ${b.japanTrackingNo ? `<b>${escapeHtml(b.japanTrackingNo)}</b> <button class="small plain" data-copy="${escapeHtml(b.japanTrackingNo)}">复制</button>` : '—'}</p>
          </div>
          <button data-action="receiveAll" data-batch="${b.id}">整单签收（${b.items.length} 件）</button>
        </div>
        <div class="jp-list">${b.items.map((i) => itemRow(i, { pick: true })).join('')}</div>
        <p style="margin:8px 0 0"><button class="small plain" data-action="receivePicked" data-batch="${b.id}">只签收勾上的</button>
          <span class="small muted">没到的别勾，告诉管理员标缺货。</span></p>
      </div>`,
    )
    .join('');
}

function boxesHtml(list) {
  if (!list.length) return '<div class="card"><p class="empty">没有开着的回国箱。拼团的件导入后会自动放进这一批的箱子。</p></div>';
  return list
    .map((b) => {
      const ready = !b.waiting && b.received > 0;
      return `<div class="card" data-box="${b.id}">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">${escapeHtml(b.name)}</h3>
          <span class="small">已签收 <b>${b.received}</b> · 未签收 <b class="${b.waiting ? 'unpaid' : ''}">${b.waiting}</b></span>
        </div>
        <details ${b.items.length <= 12 ? 'open' : ''}><summary>箱里 ${b.items.length} 件</summary>
          <div class="jp-list">${b.items
            .map((i) => itemRow({ ...i, title: `${i.status === 'ordered' ? '【未签收】' : ''}${i.title}` }, { route: false }))
            .join('')}</div>
        </details>
        <div class="row ship-row">
          <input data-box-tracking="${b.id}" placeholder="回国单号" value="${escapeHtml(b.trackingNo || '')}" ${ready ? '' : 'disabled'}>
          <button data-action="shipBox" data-box="${b.id}" ${ready ? '' : 'disabled'}>封箱发出</button>
        </div>
        ${b.waiting ? `<p class="small muted">还有 ${b.waiting} 件没签收，签收齐了才能发出；真没到的告诉管理员处理。</p>` : ''}
      </div>`;
    })
    .join('');
}

function directHtml(list) {
  if (!list.length) {
    return '<div class="card"><p class="empty">没有待打包的直邮件。打好的包裹在 <a href="#/direct">直邮</a> 页收款、寄出。</p></div>';
  }
  return list
    .map(
      (g) => `<div class="card" data-customer="${g.customerId}">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">${escapeHtml(g.nickname)} <span class="small muted">${g.items.length} 件</span></h3>
          <span class="small ${g.addressReady ? 'paid' : 'unpaid'}">${
            g.addressReady ? (g.addressSource === 'import' ? '地址：导入表里有' : '地址：客户已选') : '还没有地址'
          }</span>
        </div>
        <div class="jp-list">${g.items.map((i) => itemRow(i, { pick: true, checked: true, route: false })).join('')}</div>
        ${
          g.addressReady
            ? `<div class="row ship-row">
                <input data-weight="${g.customerId}" inputmode="numeric" placeholder="重量（克，可以先空着）">
                <button data-action="pack" data-customer="${g.customerId}">把勾上的打成一包</button>
              </div>`
            : '<p class="small muted">导入表里没写地址，客户也还没选。请客户在自己的页面上填一个收货地址（只存一个就自动用它），这里就能打包了。</p>'
        }
      </div>`,
    )
    .join('');
}

export async function render(view) {
  const data = await api.get('/api/staff/jp/overview');
  const counts = {
    inbound: data.inbound.reduce((n, b) => n + b.items.length, 0),
    boxes: data.boxes.length,
    direct: data.direct.reduce((n, g) => n + g.items.length, 0),
  };
  if (!currentTab) currentTab = TABS.find((t) => counts[t.key])?.key ?? 'inbound';

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">日本仓</h2>
        <a class="small" href="#/direct">直邮包裹 →</a>
      </div>
      <div class="seg" role="tablist">
        ${TABS.map(
          (t) => `<button role="tab" class="${t.key === currentTab ? 'active' : ''}" data-tab="${t.key}">${t.label}
            <span class="seg-count">${counts[t.key]}</span></button>`,
        ).join('')}
      </div>
    </div>
    <div class="jp-cols">
      <section class="jp-col" data-col="inbound"><h3 class="col-title">待签收</h3>${inboundHtml(data.inbound)}</section>
      <section class="jp-col" data-col="boxes"><h3 class="col-title">回国箱</h3>${boxesHtml(data.boxes)}</section>
      <section class="jp-col" data-col="direct"><h3 class="col-title">待打包直邮</h3>${directHtml(data.direct)}</section>
    </div>`;

  const applyTab = () => {
    view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
    view.querySelectorAll('[data-col]').forEach((s) => s.classList.toggle('is-current', s.dataset.col === currentTab));
  };
  view.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      currentTab = b.dataset.tab;
      applyTab();
    };
  });
  applyTab();

  view.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async (e) => {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('已复制');
      } catch {
        toast('复制不了，长按单号手动复制', true);
      }
    };
  });

  const picked = (root) => [...root.querySelectorAll('[data-pick]:checked')].map((el) => Number(el.dataset.pick));

  bindActions(view, {
    async receiveAll({ batch }) {
      const card = view.querySelector(`[data-batch="${batch}"]`);
      const ids = [...card.querySelectorAll('[data-pick]')].map((el) => Number(el.dataset.pick));
      if (!(await confirmBox(`这一单 ${ids.length} 件全部签收？`, { okText: '全部签收' }))) return;
      const r = await api.post('/api/staff/jp/receive', { itemIds: ids });
      toast(`签收了 ${r.received} 件`);
      await render(view);
    },
    async receivePicked({ batch }) {
      const ids = picked(view.querySelector(`[data-batch="${batch}"]`));
      if (!ids.length) return toast('先勾上到了的件', true);
      const r = await api.post('/api/staff/jp/receive', { itemIds: ids });
      toast(`签收了 ${r.received} 件`);
      await render(view);
    },
    async shipBox({ box }) {
      const trackingNo = view.querySelector(`[data-box-tracking="${box}"]`).value.trim();
      if (!trackingNo) return toast('先填回国单号', true);
      if (!(await confirmBox(`封箱发出，回国单号 ${trackingNo}？箱里的件会变成「回国中」，客户页面能看到这个单号。`, { okText: '发出' }))) return;
      const r = await api.post(`/api/staff/jp/boxes/${box}/ship`, { trackingNo });
      toast(`已发出，${r.count} 件变成回国中`);
      await render(view);
    },
    async pack({ customer }) {
      const card = view.querySelector(`[data-customer="${customer}"]`);
      const ids = picked(card);
      if (!ids.length) return toast('先勾上要装进这一包的件', true);
      const weight = card.querySelector(`[data-weight="${customer}"]`).value.trim();
      const r = await api.post('/api/staff/direct/parcels', {
        customerId: Number(customer),
        itemIds: ids,
        weightG: weight === '' ? undefined : Number(weight),
      });
      toast(r.status === 'packing' ? `打好了包裹 #${r.id}，称完重在直邮页填重量` : `打好了包裹 #${r.id}，等客户付运费`);
      await render(view);
    },
  });
}
