import { api } from '/admin/api.js';
import { beijingTime, bindActions, confirmBox, escapeHtml, jpy, money, statusLabel, toast } from '/admin/ui.js';

export async function render(view, [id]) {
  const data = await api.get(`/api/admin/batches/${id}`);
  const byCustomer = new Map();
  for (const item of data.items) {
    const entry = byCustomer.get(item.customerId) || {
      customerId: item.customerId,
      nickname: item.nickname,
      qq: item.qq,
      items: [],
    };
    entry.items.push(item);
    byCustomer.set(item.customerId, entry);
  }

  const groups = [...byCustomer.values()]
    .map((g) => {
      const total = g.items.reduce((sum, i) => sum + i.goodsFeeFen, 0);
      const unpaid = g.items
        .filter((i) => !i.goodsPaid && i.status !== 'cancelled' && i.status !== 'refunded')
        .reduce((sum, i) => sum + i.goodsFeeFen, 0);
      return `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0"><a href="#/customers/${g.customerId}">${escapeHtml(g.nickname)}</a>
            <span class="muted small">${escapeHtml(g.qq)} · ${g.items.length} 件</span></h3>
          <div class="right">
            <div class="money">合计 ${money(total)}</div>
            <div class="small ${unpaid ? 'unpaid' : 'paid'} money">${unpaid ? `未付 ${money(unpaid)}` : '已付清'}</div>
          </div>
        </div>
        ${
          unpaid
            ? `<button class="small" data-action="pay" data-customer="${g.customerId}">这一批货款已收</button>`
            : ''
        }
        <div class="scroll-x" style="margin-top:8px"><table>
          <thead><tr><th>行</th><th>名称</th><th class="right">实际价格</th><th class="right">应付</th><th>状态</th><th>货款</th></tr></thead>
          <tbody>${g.items
            .map(
              (i) => `<tr>
              <td class="small muted">${i.rowNo ?? ''}</td>
              <td>${i.productUrl ? `<a href="${escapeHtml(i.productUrl)}" target="_blank" rel="noreferrer">${escapeHtml(i.title)}</a>` : escapeHtml(i.title)}</td>
              <td class="right small">${jpy(i.actualPriceJpy)}</td>
              <td class="right money">${money(i.goodsFeeFen)}</td>
              <td class="small">${escapeHtml(statusLabel(i.status))}</td>
              <td class="small ${i.goodsPaid ? 'paid' : 'unpaid'}">${i.goodsPaid ? '已付' : '未付'}</td>
            </tr>`,
            )
            .join('')}</tbody></table></div>
      </div>`;
    })
    .join('');

  view.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(data.batch.name)}</h2>
      <p class="small muted">
        导入于 ${beijingTime(data.batch.createdAt)} ·
        文件 ${escapeHtml(data.batch.sourceFile || '—')} ·
        共 ${data.items.length} 件
      </p>
      <p class="small"><button class="small plain" data-action="fetchImages">给没图的物品补封面</button>
        <span class="small muted">从商品链接的页面抓 og:image，一次 20 件</span></p>
      <p class="small">关联包裹：${
        data.packages.length
          ? data.packages.map((p) => `<a href="#/packages/${p.id}">${escapeHtml(p.name)}</a>`).join('、')
          : '<span class="muted">无</span>'
      }</p>
    </div>
    ${groups}`;

  bindActions(view, {
    fetchImages: async (dataset, el) => {
      el.disabled = true;
      el.textContent = '正在抓…';
      try {
        const result = await api.post(`/api/admin/batches/${id}/fetch-images`);
        toast(`补上 ${result.filled} 张，还差 ${result.left} 件`);
        render(view, [id]);
      } catch (err) {
        el.disabled = false;
        el.textContent = '给没图的物品补封面';
        toast(err.message, true);
      }
    },
    pay: async ({ customer }) => {
      if (!(await confirmBox('确认这位客户这一批的货款已经收到？'))) return;
      await api.post('/api/admin/payments', {
        customerId: Number(customer),
        kind: 'goods',
        batchId: Number(id),
      });
      toast('已记账');
      render(view, [id]);
    },
  });
}
