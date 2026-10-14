import { api } from '/admin/api.js';
import { bindActions, confirmBox, empty, escapeHtml, money, toast, yen } from '/admin/ui.js';

function row(main, sub, right, action) {
  return `<div class="list-row">
    <div class="main">${main}${sub ? `<div class="small muted">${sub}</div>` : ''}</div>
    <div class="side">${right}${action || ''}</div>
  </div>`;
}

function customerLink(r) {
  return `<a href="#/customers/${r.customerId}">${escapeHtml(r.nickname)}</a>`;
}

export async function render(view) {
  const data = await api.get('/api/admin/dashboard');

  const goods = data.goodsUnpaid.length
    ? data.goodsUnpaid
        .map((r) =>
          row(
            customerLink(r),
            `${escapeHtml(r.batchName)} · ${r.count} 件 · QQ ${escapeHtml(r.qq)}`,
            `<span class="unpaid money">${yen(r.amountJpy)}</span>`,
            `<button class="small" data-action="payGoods" data-customer="${r.customerId}" data-batch="${r.batchId}">已收款</button>`,
          ),
        )
        .join('')
    : empty('没有未付的货款');

  const intl = data.intlUnpaid.length
    ? data.intlUnpaid
        .map((r) =>
          row(
            customerLink(r),
            `${escapeHtml(r.packageName)} · ${Number(r.weightG || 0).toLocaleString()} g`,
            `<span class="unpaid money">${money(r.intlFeeFen)}</span>`,
            `<button class="small" data-action="payIntl" data-customer="${r.customerId}" data-group="${r.weighGroupId}">已收款</button>`,
          ),
        )
        .join('')
    : empty('没有未付的国际运费');

  const domestic = data.domesticUnpaid.length
    ? data.domesticUnpaid
        .map((r) =>
          row(
            customerLink(r),
            `${r.trackingNo ? escapeHtml(r.trackingNo) : '单号待填'} · ${r.itemCount} 件`,
            `<span class="unpaid money">${money(r.feeFen)}</span>`,
            `<button class="small" data-action="payDomestic" data-customer="${r.customerId}" data-shipment="${r.shipmentId}">已收款</button>`,
          ),
        )
        .join('')
    : empty('没有未付的国内运费');

  const refunds = data.pendingRefunds.length
    ? data.pendingRefunds
        .map((r) =>
          row(
            `${customerLink(r)} · ${escapeHtml(r.title)}`,
            escapeHtml(r.batchName),
            `<span class="money">${yen(r.goodsFeeJpy)}</span>`,
            `<button class="small" data-action="refunded" data-item="${r.itemId}">已退款</button>`,
          ),
        )
        .join('')
    : empty('没有待退款的物品');

  const stock = data.domesticStock.length
    ? data.domesticStock
        .map((r) =>
          row(
            customerLink(r),
            `可发货 ${r.count} 件 · 最早一件已放 <span class="${r.days >= 30 ? 'unpaid' : ''}">${r.days} 天</span>`,
            '',
            `<a class="btn small ghost" href="#/customers/${r.customerId}">安排寄出</a>`,
          ),
        )
        .join('')
    : empty('还没有可发货的物品');

  view.innerHTML = `
    <div class="card"><h2>① 货款未付</h2>${goods}</div>
    <div class="card"><h2>② 国际运费未付</h2>${intl}</div>
    <div class="card"><h2>③ 国内运费未付</h2>${domestic}</div>
    <div class="card"><h2>④ 待退款</h2>${refunds}</div>
    <div class="card"><h2>⑤ 可发货<span class="muted small"> · 包裹分摊后立刻进入这里，按天数倒序</span></h2>${stock}</div>`;

  bindActions(view, {
    payGoods: async ({ customer, batch }) => {
      if (!(await confirmBox('确认这一批货款已经收到？'))) return;
      await api.post('/api/admin/payments', {
        customerId: Number(customer),
        kind: 'goods',
        batchId: Number(batch),
      });
      toast('已记账');
      render(view);
    },
    payIntl: async ({ customer, group }) => {
      if (!(await confirmBox('确认这一摞的国际运费已经收到？'))) return;
      await api.post('/api/admin/payments', {
        customerId: Number(customer),
        kind: 'intl',
        weighGroupId: Number(group),
      });
      toast('已记账');
      render(view);
    },
    payDomestic: async ({ customer, shipment }) => {
      if (!(await confirmBox('确认这次寄出的运费已经收到？'))) return;
      await api.post('/api/admin/payments', {
        customerId: Number(customer),
        kind: 'domestic',
        shipmentId: Number(shipment),
      });
      toast('已记账');
      render(view);
    },
    refunded: async ({ item }) => {
      if (!(await confirmBox('确认已经把钱退给客户了？'))) return;
      await api.patch(`/api/admin/items/${item}`, { status: 'refunded' });
      toast('已标记退款');
      render(view);
    },
  });
}
