import { api } from '/admin/api.js';
import { beijingTime, bindActions, codeTag, confirmBox, escapeHtml, ROUTE_LABELS, toast } from '/admin/ui.js';
import { bindItemDetails } from '/admin/itemDetail.js';

/**
 * 日本仓：三件事分三栏——
 *   待分拣     日本的快递到了：按日本运单号（一个快递箱）进分拣页，铺在地上照卡片分堆，发送一次落定；
 *   回国箱     分拣时没填回国单号的箱子，在这里填单号发出；
 *   待打包直邮 分拣时客户还没地址的直邮件，等客户填了地址在这里打包。
 * 手机上一次看一栏（顶上切换），电脑上三栏一起列。
 */
const TABS = [
  { key: 'inbound', label: '待分拣' },
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
    <button type="button" class="small plain jp-info" data-detail="${item.id}">详情</button>
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

function queueHtml(queue) {
  const batches = queue.batches;
  const recent = queue.sessions.length
    ? `<div class="card"><h3 style="margin-top:0">最近分拣</h3>${queue.sessions
        .slice(0, 8)
        .map(
          (s) => `<a class="recent-row" href="#/sort-result/${s.id}"><span>${beijingTime(s.createdAt)} · ${escapeHtml(s.createdBy)}</span>
            <span class="small muted">${s.jpTrackingNo ? `运单 ${escapeHtml(s.jpTrackingNo)} · ` : ''}${s.itemCount} 件 · ${s.boxCount} 箱 · ${s.parcelCount} 包直邮${s.missingCount ? ` · 缺 ${s.missingCount}` : ''}</span></a>`,
        )
        .join('')}</div>`
    : '';
  if (!batches.length) return `<div class="card"><p class="empty">没有要分拣的货，日本那边的都分完了。</p></div>${recent}`;
  return (
    batches
      .map(
        (b) => `<div class="card">
        <h3 style="margin:0">${escapeHtml(b.name)}</h3>
        <p class="small muted" style="margin:4px 0 8px">日本订单 <b>${escapeHtml(b.orderNo || '—')}</b> · 下单 ${escapeHtml(b.orderedAt || '—')} · 还有 ${b.total} 件没分${
          b.missing ? ` · <span class="unpaid">${b.missing} 件上次没找到</span>` : ''
        }</p>
        ${b.boxes
          .map(
            (x) => `<a class="queue-row" href="#/sort/${b.batchId}?tn=${encodeURIComponent(x.trackingNo)}">
              <span><span class="small muted">日本运单</span> <b class="mono">${escapeHtml(x.trackingNo)}</b></span>
              <span class="small">${x.count} 件${x.found ? ` · 已点 ${x.found}` : ''}${b.untracked ? ` <span class="muted">+ 没写运单号的 ${b.untracked}</span>` : ''}</span>
              <span class="btn small">分拣这一箱 →</span></a>`,
          )
          .join('')}
        ${
          b.untracked && !b.boxes.length
            ? `<a class="queue-row" href="#/sort/${b.batchId}">
                <span>表里没写日本运单号${b.japanTrackingNo ? `（订单上的单号 <b class="mono">${escapeHtml(b.japanTrackingNo)}</b>）` : ''}</span>
                <span class="small">${b.untracked} 件${b.untrackedFound ? ` · 已点 ${b.untrackedFound}` : ''}</span>
                <span class="btn small">开箱分拣 →</span></a>`
            : ''
        }
        ${
          b.untracked && b.boxes.length
            ? `<p class="small muted" style="margin:6px 0 0">没写运单号的 ${b.untracked} 件会出现在每一箱的分拣页里，哪箱里找到就算哪箱。</p>`
            : ''
        }
      </div>`,
      )
      .join('') + recent
  );
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
  const [data, queue] = await Promise.all([api.get('/api/staff/jp/overview'), api.get('/api/staff/sort/queue')]);
  const counts = {
    inbound: queue.batches.reduce((n, b) => n + b.total, 0),
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
      <section class="jp-col" data-col="inbound"><h3 class="col-title">待分拣</h3>${queueHtml(queue)}</section>
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

  bindItemDetails(view);

  const picked = (root) => [...root.querySelectorAll('[data-pick]:checked')].map((el) => Number(el.dataset.pick));

  bindActions(view, {
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
