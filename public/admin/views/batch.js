import { api } from '/admin/api.js';
import {
  beijingTime,
  bindActions,
  codeTag,
  confirmBox,
  escapeHtml,
  statusLabel,
  thumb,
  yen,
  toast,
  promptBox,
  ROUTE_LABELS,
} from '/admin/ui.js';
import { bindItemDetails } from '/admin/itemDetail.js';

/** 还在日本这一侧、没装箱没打包的件才能改发货方式（和后端 changeRoute 同一个口径）。 */
function routeEditable(i) {
  return ['ordered', 'jp_warehouse'].includes(i.status) && !i.weighGroupId && !i.directParcelId && !i.shipmentId;
}

function routeTag(i) {
  const label = ROUTE_LABELS[i.route] ?? i.route;
  return `<span class="badge ${i.route === 'direct' ? 'warn' : ''}" title="${i.route === 'direct' && i.importAddress ? `直邮地址：${escapeHtml(i.importAddress)}` : ''}">${label}</span>`;
}

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
          <thead><tr><th><input type="checkbox" data-pick-all="${g.customerId}" aria-label="全选"></th><th>图</th><th>名称</th><th class="right">应付</th><th>发货</th><th>状态</th><th>货款</th></tr></thead>
          <tbody>${g.items
            .map(
              (i) => `<tr data-focus-item="${i.id}">
              <td><input type="checkbox" data-pick="${i.id}" data-owner="${g.customerId}" ${routeEditable(i) ? '' : 'disabled title="已装箱、打包或发出，不能再改发货方式"'}></td>
              <td class="cell-thumb">${thumb(i)}</td>
              <td>${i.productUrl ? `<a href="${escapeHtml(i.productUrl)}" target="_blank" rel="noreferrer">${escapeHtml(i.title)}</a>` : escapeHtml(i.title)}
                <div>${codeTag(i)} <span class="small muted">第 ${i.rowNo ?? '?'} 行 · 实际价格 ${yen(i.actualPriceJpy)}</span>
                  <button class="small plain" data-detail="${i.id}">详情</button></div></td>
              <td class="right money">${yen(i.goodsFeeJpy)}</td>
              <td>${routeTag(i)}</td>
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
      <h2>${escapeHtml(data.batch.name)}</h2>
      <p><button data-action="orderTracking" class="small plain">日本订单 ${escapeHtml(data.batch.orderNo || '待填')} · 日本单号 ${escapeHtml(data.batch.japanTrackingNo || '待填')}</button></p>
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
      <div class="row route-bar">
        <span class="small muted">勾选的件改成：</span>
        <button class="small" data-action="route" data-route="direct">直邮</button>
        <button class="small plain" data-action="route" data-route="group">拼团</button>
        <span class="small muted">只有已下单 / 已到日本仓、还没装箱打包的件能改；改回拼团会自动放回这一批的回国箱。</span>
      </div>
      <p class="small">关联包裹：${
        data.packages.length
          ? data.packages.map((p) => `<a href="#/packages/${p.id}">${escapeHtml(p.name)}</a>`).join('、')
          : '<span class="muted">无</span>'
      }</p>
    </div>
    ${groups}`;

  view.querySelectorAll('[data-pick-all]').forEach((all) => {
    all.onchange = () => {
      view
        .querySelectorAll(`[data-pick][data-owner="${all.dataset.pickAll}"]:not(:disabled)`)
        .forEach((el) => (el.checked = all.checked));
    };
  });

  bindItemDetails(view);
  bindActions(view, {
    route: async ({ route }) => {
      const ids = [...view.querySelectorAll('[data-pick]:checked')].map((el) => Number(el.dataset.pick));
      if (!ids.length) {
        toast('先勾上要改的件', true);
        return;
      }
      const r = await api.post('/api/admin/items/route', { itemIds: ids, route });
      toast(r.changed ? `已把 ${r.changed} 件改成${ROUTE_LABELS[route]}` : `这几件本来就是${ROUTE_LABELS[route]}`);
      await render(view, [id]);
    },
    orderTracking: async () => {
      const orderNo = await promptBox('日本订单号', data.batch.orderNo || '');
      if (orderNo === null) return;
      const japanTrackingNo = await promptBox('日本物流单号', data.batch.japanTrackingNo || '');
      if (japanTrackingNo === null) return;
      await api.patch(`/api/admin/batches/${id}`, { orderNo, japanTrackingNo });
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
