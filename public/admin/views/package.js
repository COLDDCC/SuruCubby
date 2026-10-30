import { api } from '/admin/api.js';
import {
  PACKAGE_BULK_STATUSES,
  STATUS_LABELS,
  beijingTime,
  bindActions,
  codeTag,
  escapeHtml,
  money,
  openModal,
  orderTag,
  promptBox,
  statusLabel,
  thumb,
  toast,
  yen,
} from '/admin/ui.js';

export async function render(view, [id]) {
  const data = await api.get(`/api/admin/packages/${id}`);
  const pkg = data.package;
  const byCustomer = new Map();
  for (const item of data.items) {
    const entry = byCustomer.get(item.customerId) || { ...item, items: [] };
    entry.items.push(item);
    byCustomer.set(item.customerId, entry);
  }
  const stockCount = data.items.filter((i) => i.status === 'cn_stock').length;

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
      <p class="small muted">改状态会同步包裹里所有物品，已取消 / 已退款 / 已经是「可发货」或已寄出的物品不受影响。</p>
      ${
        pkg.totalFeeFen === null
          ? '<p class="small muted">还没分摊国际运费。</p>'
          : `<p class="small">国际运费 <span class="money">${money(pkg.totalFeeFen)}</span>
              ${pkg.totalWeightG ? `· 总重 ${Number(pkg.totalWeightG).toLocaleString()} g` : ''}
              ${data.rounding ? `· 尾差 ${money(data.rounding.diffFen)}（需求方承担）` : ''}
              · 分摊于 ${beijingTime(pkg.allocatedAt)}</p>
            ${
              stockCount
                ? `<p class="small paid">这 ${stockCount} 件已是「可发货」，客户页面能直接勾选申请发货。</p>`
                : '<p class="small muted">这一箱还没有可发货的物品。</p>'
            }`
      }
    </div>
    ${[...byCustomer.values()]
      .map(
        (g) => {
          const stackFee = g.items.reduce((sum, i) => sum + (i.intlFeeFen ?? 0), 0);
          return `<div class="card">
        <h3><a href="#/customers/${g.customerId}">${escapeHtml(g.nickname)}</a>
          ${g.selfReturn ? '<span class="badge">不拼邮</span>' : ''}
          <span class="muted small">${g.items.length} 件${
            stackFee ? ` · 这一摞运费 ${money(stackFee)}` : ''
          }</span></h3>
          ${
            g.selfReturn
              ? '<p class="small muted">这一位不拼邮：这几件不进这一箱的运费分摊，也不发国内快递；货款照旧按表里记。</p>'
              : ''
          }
        <div class="scroll-x"><table>
          <thead><tr><th>图</th><th>名称</th><th>状态</th><th class="right">应付</th><th class="right">重量</th><th class="right">国际运费</th><th></th></tr></thead>
          <tbody>${g.items
            .map(
              (i) => `<tr data-focus-item="${i.id}">
              <td class="cell-thumb">${thumb(i)}</td>
              <td><input type="checkbox" data-move-item="${i.id}"> ${escapeHtml(i.title)}${i.missing ? ' <span class="badge warn">缺件</span>' : ''}
                <div>${codeTag(i)}</div>${orderTag(i)}</td>
              <td class="small">${escapeHtml(statusLabel(i.status))}</td>
              <td class="right money">${yen(i.goodsFeeJpy)}</td>
              <td class="right small">${i.weightG ? `${Number(i.weightG).toLocaleString()} g` : '—'}</td>
              <td class="right money">${i.intlFeeFen === null || i.intlFeeFen === undefined ? '—' : money(i.intlFeeFen)}</td>
              <td class="right"><button class="small plain" data-action="itemStatus" data-item="${i.id}" data-status="${i.status}">改状态</button></td>
            </tr>`,
            )
            .join('')}</tbody></table></div>
      </div>`;
        },
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
    moveItems: async () => {
      const itemIds = [...view.querySelectorAll('[data-move-item]:checked')].map((el) => Number(el.dataset.moveItem));
      if (!itemIds.length) return toast('先勾选商品', true);
      const d = await api.get('/api/admin/packages');
      // 已分摊的包裹不能收新东西：那一箱的运费早按当时的重量算完了
      const available = d.packages.filter((p) => p.id !== Number(id) && !p.allocatedAt);
      const targetId = await pickPackage(available, `${itemIds.length} 件`);
      if (targetId === null) return;
      try {
        await api.post(`/api/admin/packages/${targetId}/items`, { itemIds, action: 'add' });
        await render(view, [id]);
        toast('已移动商品');
      } catch (e) {
        toast(e.message, true);
      }
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

/**
 * 单件改状态：给一个下拉，处理砍单、损坏这类异常。
 * 只列后端收得了的状态：可发货要走称重确认、已寄出要走寄出流程，
 * 已签收只在「已寄出 → 已签收」这一步允许。
 */
function pickStatus(current) {
  const legal = Object.keys(STATUS_LABELS).filter((s) => {
    if (s === current) return true;
    if (s === 'cn_stock' || s === 'shipped') return false;
    if (s === 'delivered') return current === 'shipped';
    return true;
  });
  return new Promise((resolve) => {
    openModal((box, close) => {
      box.innerHTML = `
        <h3>改这一件的状态</h3>
        <select id="pick" style="width:100%">
          ${legal
            .map((s) => `<option value="${s}" ${s === current ? 'selected' : ''}>${statusLabel(s)}</option>`)
            .join('')}
        </select>
        <p class="small muted">要变「可发货」请去称重台算分摊；要寄出请在发货申请里填单号。</p>
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

/** 拆包 / 合包时选目标包裹：从列表里点，别手输 ID。返回包裹 ID，取消返回 null。 */
function pickPackage(available, hint) {
  return new Promise((resolve) => {
    openModal((box, close) => {
      box.innerHTML = `
        <h3>移到哪个包裹（${escapeHtml(hint)}）</h3>
        <div class="row" style="flex-direction:column;align-items:flex-start;gap:6px">
          ${
            available.length
              ? available
                  .map(
                    (p, i) => `<label><input type="radio" name="to" value="${p.id}" ${i === 0 ? 'checked' : ''}>
                      ${escapeHtml(p.name)} <span class="small muted">#${p.id}</span></label>`,
                  )
                  .join('')
              : '<p class="small muted">现在没有能收东西的包裹（已分摊的不能再加），新建一个吧。</p>'
          }
          <label><input type="radio" name="to" value="new"> 新建一个包裹：
            <input id="newName" placeholder="比如 10 月回国第二箱"></label>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:12px">
          <button class="plain" data-no>取消</button><button data-yes>移动</button>
        </div>`;
      const done = (value) => {
        close();
        resolve(value);
      };
      box.querySelector('[data-no]').onclick = () => done(null);
      box.querySelector('[data-yes]').onclick = async () => {
        const chosen = box.querySelector('input[name="to"]:checked');
        if (!chosen) return toast('先选一个包裹', true);
        if (chosen.value === 'new') {
          const name = box.querySelector('#newName').value.trim();
          if (!name) return toast('给新包裹起个名字', true);
          try {
            done((await api.post('/api/admin/packages', { name })).id);
          } catch (err) {
            toast(err.message, true);
          }
          return;
        }
        done(Number(chosen.value));
      };
    });
  });
}
