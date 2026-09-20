import { api } from '/admin/api.js';
import { beijingTime, bindActions, confirmBox, empty, escapeHtml, money, toast } from '/admin/ui.js';

const KIND_LABELS = { goods: '货款', intl: '国际运费', domestic: '国内运费' };

export async function render(view) {
  const data = await api.get('/api/admin/payments');
  view.innerHTML = `
    <div class="card">
      <h2>收款记录</h2>
      ${
        data.payments.length
          ? `<div class="scroll-x"><table>
        <thead><tr><th>时间</th><th>客户</th><th>类型</th><th class="right">金额</th><th>备注</th><th></th></tr></thead>
        <tbody>${data.payments
          .map(
            (p) => `<tr>
            <td class="small" style="white-space:nowrap">${beijingTime(p.paidAt)}</td>
            <td><a href="#/customers/${p.customerId}">${escapeHtml(p.nickname)}</a></td>
            <td>${KIND_LABELS[p.kind] || p.kind}</td>
            <td class="right money">${money(p.amountFen)}</td>
            <td class="small muted">${escapeHtml(p.note || '')}</td>
            <td class="right"><button class="small plain" data-action="revoke" data-id="${p.id}">撤销</button></td>
          </tr>`,
          )
          .join('')}</tbody></table></div>`
          : empty('还没有收款记录')
      }
    </div>`;

  bindActions(view, {
    revoke: async ({ id }) => {
      if (!(await confirmBox('撤销这笔收款？相关的「已付」标记会一起回退。', { danger: true, okText: '撤销' })))
        return;
      await api.del(`/api/admin/payments/${id}`);
      toast('已撤销');
      render(view);
    },
  });
}
