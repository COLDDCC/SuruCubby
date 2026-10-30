import { api } from '/admin/api.js';
import {
  beijingTime,
  bindActions,
  codeTag,
  confirmBox,
  escapeHtml,
  orderTag,
  statusLabel,
  thumb,
  yen,
  toast,
  promptBox,
} from '/admin/ui.js';

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
      const total = g.items.reduce((sum, i) => sum + i.goodsFeeJpy, 0);
      const unpaid = g.items
        .filter((i) => !i.goodsPaid && i.status !== 'cancelled' && i.status !== 'refunded')
        .reduce((sum, i) => sum + i.goodsFeeJpy, 0);
      return `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0"><a href="#/customers/${g.customerId}">${escapeHtml(g.nickname)}</a>
            <span class="muted small">${escapeHtml(g.qq)} · ${g.items.length} 件</span></h3>
          <div class="right">
            <div class="money">合计 ${yen(total)}</div>
            <div class="small ${unpaid ? 'unpaid' : 'paid'} money">${unpaid ? `未付 ${yen(unpaid)}` : '已付清'}</div>
          </div>
        </div>
        <div class="scroll-x" style="margin-top:8px"><table>
          <thead><tr><th>图</th><th>行</th><th>名称</th><th class="right">实际价格</th><th class="right">应付</th><th>状态</th><th>货款</th></tr></thead>
          <tbody>${g.items
            .map(
              (i) => `<tr data-focus-item="${i.id}">
              <td class="cell-thumb">${thumb(i)}</td>
              <td class="small muted">${i.rowNo ?? ''}</td>
              <td>${i.productUrl ? `<a href="${escapeHtml(i.productUrl)}" target="_blank" rel="noreferrer">${escapeHtml(i.title)}</a>` : escapeHtml(i.title)}
                <div>${codeTag(i)}</div>${orderTag(i)}</td>
              <td class="right small">${yen(i.actualPriceJpy)}</td>
              <td class="right money">${yen(i.goodsFeeJpy)}</td>
              <td class="small">${escapeHtml(statusLabel(i.status))}</td>
              <td class="small ${i.goodsPaid ? 'paid' : 'unpaid'}">${i.goodsPaid ? '已付' : '未付'}</td>
            </tr>`,
            )
            .join('')}</tbody></table></div>
      </div>`;
    })
    .join('');

  const unpaidItems = data.items.filter((i) => !i.goodsPaid && i.status !== 'cancelled' && i.status !== 'refunded');
  const unpaidPeople = new Set(unpaidItems.map((i) => i.customerId)).size;
  const unpaidTotal = unpaidItems.reduce((sum, i) => sum + i.goodsFeeJpy, 0);

  view.innerHTML = `
    <div class="card">
      <p class="small" style="margin:0"><a href="#/batches">← 全部订单</a></p>
      <h2>${escapeHtml(data.batch.name)}</h2>
      <p><button data-action="orderTracking" class="small plain">来源 ${escapeHtml(data.batch.shop || '待填')} · 日本订单 ${escapeHtml(data.batch.orderNo || '待填')} · 日本单号 ${escapeHtml(data.batch.japanTrackingNo || '待填')}</button></p>
      <p class="small muted">
        导入于 ${beijingTime(data.batch.createdAt)} ·
        文件 ${escapeHtml(data.batch.sourceFile || '—')} ·
        共 ${data.items.length} 件
      </p>
      ${
        unpaidItems.length
          ? `<p><button data-action="payAll">这批货款全收（${unpaidPeople} 人 · ${yen(unpaidTotal)}）</button>
              <span class="small muted">点一次给每个人都记一笔，不用一个个客户确认；谁其实没付，去他页面撤销那一笔</span></p>`
          : '<p class="small paid">这一批货款都记完了。</p>'
      }
      <p class="small"><button class="small plain" data-action="fetchImages">固化封面图</button>
        <span class="small muted">缺图的去商品页抓 og:image；绑了 R2 就把图存进自己的桶，一次 20 件</span></p>
      <p class="small">关联包裹：${
        data.packages.length
          ? data.packages.map((p) => `<a href="#/packages/${p.id}">${escapeHtml(p.name)}</a>`).join('、')
          : '<span class="muted">无</span>'
      }</p>
    </div>
    ${groups}`;

  bindActions(view, {
    orderTracking: async () => {
      const shop = await promptBox('来源店铺（骏河屋 / 骏河屋秋叶原店 / booth …）', data.batch.shop || '');
      if (shop === null) return;
      const orderNo = await promptBox('日本订单号', data.batch.orderNo || '');
      if (orderNo === null) return;
      const japanTrackingNo = await promptBox('日本物流单号', data.batch.japanTrackingNo || '');
      if (japanTrackingNo === null) return;
      await api.patch(`/api/admin/batches/${id}`, { shop, orderNo, japanTrackingNo });
      await render(view, [id]);
    },
    fetchImages: async (dataset, el) => {
      el.disabled = true;
      el.textContent = '正在抓…';
      try {
        const result = await api.post(`/api/admin/batches/${id}/images`);
        const done = result.cached ? `存进 R2 ${result.cached} 张` : `补上外链 ${result.linked} 张`;
        toast(`${done}，还差 ${result.left} 件${result.r2 ? '' : '（没绑 R2，只能外链）'}`);
        render(view, [id]);
      } catch (err) {
        el.disabled = false;
        el.textContent = '固化封面图';
        toast(err.message, true);
      }
    },
    payAll: async () => {
      if (
        !(await confirmBox(`把这批还没付的货款全部记为已收？${unpaidPeople} 个人，合计 ${yen(unpaidTotal)}。`, {
          okText: '全记上',
        }))
      )
        return;
      try {
        const r = await api.post('/api/admin/payments/all-goods', { batchId: Number(id) });
        toast(`已记 ${r.customers} 个人的货款，合计 ${yen(r.amountJpy)}`);
      } catch (err) {
        toast(err.message, true);
      }
      render(view, [id]);
    },
  });
}
