import { api } from '/admin/api.js';
import { PACKAGE_BULK_STATUSES, STATUS_LABELS, beijingTime, bindActions, escapeHtml, money, openModal, promptBox, statusLabel, toast, yen } from '/admin/ui.js';

export async function render(view, [id]) {
  const data = await api.get(`/api/admin/packages/${id}`);
  const pkg = data.package;
  const byCustomer = new Map();
  for (const item of data.items) {
    const entry = byCustomer.get(item.customerId) || { ...item, items: [] };
    entry.items.push(item);
    byCustomer.set(item.customerId, entry);
  }

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${escapeHtml(pkg.name)}</h2>
        <a class="btn small" href="#/weigh/${pkg.id}">进入称重台</a>
      </div>
      <p class="small muted">
        建于 ${beijingTime(pkg.createdAt)} ·
        ${data.items.length} 件 ·
        批次：${data.batches.map((b) => `<a href="#/batches/${b.id}">${escapeHtml(b.name)}</a>`).join('、') || '无'}
      </p>
      <div class="row">
        <label style="margin:0">状态</label>
        <select id="status">
          ${PACKAGE_BULK_STATUSES.map(
            (s) => `<option value="${s}" ${s === pkg.status ? 'selected' : ''}>${statusLabel(s)}</option>`,
          ).join('')}
          ${PACKAGE_BULK_STATUSES.includes(pkg.status) ? '' : `<option value="${pkg.status}" selected>${statusLabel(pkg.status)}</option>`}
        </select>
        <button class="small plain" data-action="tracking">回国单号：${escapeHtml(pkg.trackingNo || '待填')}</button>
      </div>
      <p><button data-action="moveItems" class="small plain">拆包 / 合包：移动勾选商品</button></p>
      <p class="small muted">改状态会同步包裹里所有物品，已取消 / 已退款 / 已在国内在库之后的物品不受影响。</p>
      ${
        pkg.totalFeeFen === null
          ? '<p class="small muted">还没分摊国际运费。</p>'
          : `<p class="small">国际运费 <span class="money">${money(pkg.totalFeeFen)}</span>
              ${pkg.totalWeightG ? `· 总重 ${Number(pkg.totalWeightG).toLocaleString()} g` : ''}
              ${data.rounding ? `· 尾差 ${money(data.rounding.diffFen)}（需求方承担）` : ''}
              · 分摊于 ${beijingTime(pkg.allocatedAt)}</p>`
      }
    </div>
    ${[...byCustomer.values()]
      .map(
        (g) => `<div class="card">
        <h3><a href="#/customers/${g.customerId}">${escapeHtml(g.nickname)}</a>
          <span class="muted small">${g.items.length} 件</span></h3>
        <div class="scroll-x"><table>
          <thead><tr><th>名称</th><th>状态</th><th class="right">应付</th><th></th></tr></thead>
          <tbody>${g.items
            .map(
              (i) => `<tr>
              <td><input type="checkbox" data-move-item="${i.id}"> ${escapeHtml(i.title)}${i.missing ? ' <span class="badge warn">缺件</span>' : ''}</td>
              <td class="small">${escapeHtml(statusLabel(i.status))}</td>
              <td class="right money">${yen(i.goodsFeeJpy)}</td>
              <td class="right"><button class="small plain" data-action="itemStatus" data-item="${i.id}" data-status="${i.status}">改状态</button></td>
            </tr>`,
            )
            .join('')}</tbody></table></div>
      </div>`,
      )
      .join('')}`;

  document.getElementById('status').addEventListener('change', async (e) => {
    try {
      const result = await api.post(`/api/admin/packages/${id}/status`, { status: e.target.value });
      toast(`已更新 ${result.updated} 件${result.skipped ? `，跳过 ${result.skipped} 件` : ''}`);
      render(view, [id]);
    } catch (err) {
      toast(err.message, true);
    }
  });

  bindActions(view, {
    moveItems: async()=>{
      const itemIds=[...view.querySelectorAll('[data-move-item]:checked')].map(el=>Number(el.dataset.moveItem));
      if(!itemIds.length)return toast('先勾选商品',true);
      const d=await api.get('/api/admin/packages');const available=d.packages.filter(p=>p.id!==Number(id)&&!p.allocatedAt);
      const target=await promptBox('目标包裹ID（'+available.map(p=>p.id+':'+p.name).join('；')+'）。输入“新建”创建包裹','');if(target===null)return;
      let targetId=Number(target);
      if(target==='新建'){const name=await promptBox('新包裹名称','');if(!name)return;targetId=(await api.post('/api/admin/packages',{name})).id;}
      if(!targetId)return toast('请输入有效包裹ID',true);
      try{await api.post(`/api/admin/packages/${targetId}/items`,{itemIds,action:'add'});await render(view,[id]);toast('已移动商品');}catch(e){toast(e.message,true);}
    },
    tracking: async () => {
      const value = await promptBox('回国单号', pkg.trackingNo || '');
      if (value === null) return;
      await api.patch(`/api/admin/packages/${id}`, { trackingNo: value });
      toast('已保存');
      render(view, [id]);
    },
    itemStatus: async ({ item, status }) => {
      const next = await pickStatus(status);
      if (next === null || next === status) return;
      await api.patch(`/api/admin/items/${item}`, { status: next });
      toast('已改状态');
      render(view, [id]);
    },
  });
}

/** 单件改状态：给一个下拉，处理砍单、损坏这类异常。 */
function pickStatus(current) {
  return new Promise((resolve) => {
    openModal((box, close) => {
      box.innerHTML = `
        <h3>改这一件的状态</h3>
        <select id="pick" style="width:100%">
          ${Object.keys(STATUS_LABELS)
            .map((s) => `<option value="${s}" ${s === current ? 'selected' : ''}>${statusLabel(s)}</option>`)
            .join('')}
        </select>
        <div class="row" style="justify-content:flex-end;margin-top:12px">
          <button class="plain" data-no>取消</button><button data-yes>保存</button>
        </div>`;
      box.querySelector('[data-no]').onclick = () => {
        close();
        resolve(null);
      };
      box.querySelector('[data-yes]').onclick = () => {
        const value = box.querySelector('#pick').value;
        close();
        resolve(value);
      };
    });
  });
}
