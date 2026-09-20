import { api } from '/admin/api.js';
import { beijingTime, bindActions, confirmBox, empty, escapeHtml, money, promptBox, toast } from '/admin/ui.js';

export async function render(view) {
  const data = await api.get('/api/admin/shipments');
  view.innerHTML = `
    <div class="card">
      <h2>国内寄出</h2>
      <p class="small muted">生成寄出在「客户详情」页操作：勾选国内在库的物品即可。</p>
      ${
        data.shipments.length
          ? data.shipments
              .map(
                (s) => `<div class="list-row">
          <div class="main">
            <a href="#/customers/${s.customerId}">${escapeHtml(s.nickname)}</a>
            · ${s.trackingNo ? escapeHtml(s.trackingNo) : '<span class="muted">单号待填</span>'}
            <div class="small muted">${s.itemCount} 件 · ${beijingTime(s.shippedAt || s.createdAt)}</div>
          </div>
          <div class="side">
            <span class="${s.feePaid ? 'paid' : 'unpaid'} money">${money(s.feeFen)}${s.feePaid ? ' 已付' : ''}</span>
            <button class="small plain" data-action="track" data-id="${s.id}" data-current="${escapeHtml(s.trackingNo || '')}">单号</button>
            ${s.feePaid ? '' : `<button class="small" data-action="pay" data-id="${s.id}" data-customer="${s.customerId}">已收款</button>`}
            ${s.feePaid ? '' : `<button class="small danger" data-action="cancel" data-id="${s.id}">撤销</button>`}
          </div>
        </div>`,
              )
              .join('')
          : empty('还没有寄出记录')
      }
    </div>`;

  bindActions(view, {
    track: async ({ id, current }) => {
      const value = await promptBox('填写国内快递单号', current);
      if (value === null) return;
      await api.patch(`/api/admin/shipments/${id}`, { trackingNo: value });
      toast('已保存');
      render(view);
    },
    pay: async ({ id, customer }) => {
      await api.post('/api/admin/payments', {
        customerId: Number(customer),
        kind: 'domestic',
        shipmentId: Number(id),
      });
      toast('已记账');
      render(view);
    },
    cancel: async ({ id }) => {
      if (!(await confirmBox('撤销这次寄出？物品会退回「国内在库」。', { danger: true, okText: '撤销' }))) return;
      await api.del(`/api/admin/shipments/${id}`);
      toast('已撤销');
      render(view);
    },
  });
}
