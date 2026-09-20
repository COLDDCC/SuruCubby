import { api } from '/admin/api.js';
import { bindActions, confirmBox, escapeHtml, money, openModal, promptBox, thumb, toast } from '/admin/ui.js';

export async function render(view, [id]) {
  const data = await api.get(`/api/admin/packages/${id}/weigh`);
  const p = data.progress;
  const pkg = data.package;
  const allocated = Boolean(pkg.allocatedAt);

  view.innerHTML = `
    <div class="progress-bar">
      <span>应有 <strong>${p.expectedItems}</strong> 件 / 已找到 <strong>${p.foundItems}</strong> 件</span>
      <span>已称 <strong>${p.weighedCustomers}</strong> 人 / 共 <strong>${p.totalCustomers}</strong> 人</span>
      ${p.missingItems ? `<span class="badge warn">缺件 ${p.missingItems}</span>` : ''}
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${escapeHtml(pkg.name)} · 称重台</h2>
        <a class="btn small ghost" href="#/packages/${pkg.id}">包裹详情</a>
      </div>
      <p class="small muted">拆包时拿起一件，点一下它的封面就算「已找到」。某人的东西找齐后，堆成一摞称重量填进去。</p>
      ${
        allocated
          ? `<p class="small">已分摊：国际运费 <span class="money">${money(pkg.totalFeeFen)}</span>
              · <button class="small danger" data-action="undo">撤销分摊</button></p>`
          : ''
      }
    </div>
    ${data.customers
      .map(
        (c) => `
      <div class="card" data-customer-card="${c.customerId}">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">${escapeHtml(c.nickname)}
            <span class="muted small">${c.found}/${c.expected} 件${c.missing ? ` · 缺 ${c.missing}` : ''}</span></h3>
          <div class="row">
            <input class="small" style="width:110px" inputmode="numeric" placeholder="重量 g"
                   data-weight-for="${c.customerId}" value="${c.weightG ?? ''}" ${allocated ? 'disabled' : ''}>
            <button class="small" data-action="saveWeight" data-customer="${c.customerId}" ${allocated ? 'disabled' : ''}>存</button>
          </div>
        </div>
        ${
          c.intlFeeFen !== null
            ? `<p class="small">分摊运费 <span class="money ${c.feePaid ? 'paid' : 'unpaid'}">${money(c.intlFeeFen)}</span>${c.feePaid ? ' 已付' : ''}</p>`
            : ''
        }
        <div class="claim-grid" style="margin-top:10px">
          ${c.items
            .map(
              (i) => `
            <div class="claim ${i.missing ? 'missing' : i.weighGroupId ? 'found' : ''}" data-item="${i.id}">
              <div data-action="toggle" data-item="${i.id}" data-claimed="${i.weighGroupId && !i.missing ? '1' : ''}">
                ${thumb(i)}
                <div class="name">${escapeHtml(i.title)}</div>
              </div>
              <button class="small plain" style="width:100%;margin-top:4px"
                      data-action="missing" data-item="${i.id}" data-missing="${i.missing ? '1' : ''}">
                ${i.missing ? '取消缺件' : '缺件'}
              </button>
            </div>`,
            )
            .join('')}
        </div>
      </div>`,
      )
      .join('')}
    ${
      allocated
        ? ''
        : `<div class="card">
      <h3>算国际运费分摊</h3>
      <label>这个包裹转运仓实际收的国际运费（元）</label>
      <input id="fee" inputmode="decimal" placeholder="例如 100.00">
      <label>转运仓给的总重量（克，可不填，仅用于对账）</label>
      <input id="declared" inputmode="numeric" placeholder="例如 3200">
      <p class="small muted">分母是各摞重量之和，包装箱重量按比例摊给所有人；尾差算需求方的。</p>
      <button data-action="preview">计算分摊</button>
    </div>`
    }`;

  const reload = () => render(view, [id]);

  bindActions(view, {
    toggle: async ({ item, claimed }) => {
      try {
        await api.post(`/api/admin/packages/${id}/weigh/claim`, {
          itemId: Number(item),
          claimed: !claimed,
        });
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    },
    missing: async ({ item, missing }) => {
      if (missing) {
        await api.post(`/api/admin/packages/${id}/weigh/missing`, { itemId: Number(item), missing: false });
        reload();
        return;
      }
      const note = await promptBox('缺件说明（例如「骏河屋漏发」）', '');
      if (note === null) return;
      await api.post(`/api/admin/packages/${id}/weigh/missing`, {
        itemId: Number(item),
        missing: true,
        note,
      });
      toast('已标记缺件，不参与分摊');
      reload();
    },
    saveWeight: async ({ customer }) => {
      const input = view.querySelector(`[data-weight-for="${customer}"]`);
      const value = input.value.trim();
      try {
        await api.post(`/api/admin/packages/${id}/weigh/group`, {
          customerId: Number(customer),
          weightG: value === '' ? null : Number(value),
        });
        toast('重量已存');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    },
    preview: async () => {
      const fee = document.getElementById('fee').value.trim();
      const declared = document.getElementById('declared').value.trim();
      if (fee === '') return toast('先填国际运费', true);
      let preview;
      try {
        preview = await api.post(`/api/admin/packages/${id}/allocate/preview`, {
          totalFeeYuan: fee,
          totalWeightG: declared === '' ? null : Number(declared),
        });
      } catch (err) {
        return toast(err.message, true);
      }
      openModal((box, close) => {
        box.innerHTML = `
          <h3>分摊预览</h3>
          <div class="scroll-x"><table>
            <thead><tr><th>客户</th><th class="right">重量</th><th class="right">占比</th><th class="right">应付运费</th></tr></thead>
            <tbody>${preview.rows
              .map(
                (r) => `<tr>
                <td>${escapeHtml(r.nickname)}<div class="small muted">${r.itemCount} 件</div></td>
                <td class="right">${r.weightG.toLocaleString()} g</td>
                <td class="right">${(r.share * 100).toFixed(1)}%</td>
                <td class="right money">${money(r.feeFen)}</td>
              </tr>`,
              )
              .join('')}</tbody></table></div>
          <p class="small">各摞合计 ${preview.totalWeightG.toLocaleString()} g，运费合计 ${money(
            preview.totalFeeFen,
          )}，尾差 <strong>${money(preview.diffFen)}</strong> 记在需求方名下。</p>
          ${
            preview.weightDiffG === null
              ? ''
              : `<p class="small muted">转运仓重量 − 各摞之和 = ${preview.weightDiffG.toLocaleString()} g（仅供参考）</p>`
          }
          <div class="row" style="justify-content:flex-end;margin-top:12px">
            <button class="plain" data-no>再改改</button><button data-yes>确认分摊</button>
          </div>`;
        box.querySelector('[data-no]').onclick = close;
        box.querySelector('[data-yes]').onclick = async () => {
          try {
            const result = await api.post(`/api/admin/packages/${id}/allocate/commit`, {
              totalFeeYuan: fee,
              totalWeightG: declared === '' ? null : Number(declared),
            });
            close();
            toast(`已分摊，${result.itemsMovedToStock} 件进入国内在库`);
            reload();
          } catch (err) {
            toast(err.message, true);
          }
        };
      });
    },
    undo: async () => {
      if (!(await confirmBox('撤销分摊？物品会退回「已到国内，待称重」。', { danger: true, okText: '撤销' })))
        return;
      try {
        await api.post(`/api/admin/packages/${id}/allocate/undo`);
        toast('已撤销分摊');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    },
  });
}
