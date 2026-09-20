import { api } from '/admin/api.js';
import { PACKAGE_BULK_STATUSES, beijingTime, bindActions, empty, escapeHtml, money, statusLabel, toast } from '/admin/ui.js';

export async function render(view) {
  const data = await api.get('/api/admin/packages');
  view.innerHTML = `
    <div class="card">
      <h2>包裹</h2>
      ${
        data.packages.length
          ? `<div class="scroll-x"><table>
        <thead><tr><th>包裹</th><th>状态</th><th class="right">件数</th><th class="right">国际运费</th><th></th></tr></thead>
        <tbody>${data.packages
          .map(
            (p) => `<tr>
            <td><a href="#/packages/${p.id}">${escapeHtml(p.name)}</a>
              <div class="small muted">${p.customerCount} 位客户 · ${beijingTime(p.createdAt, false)}</div></td>
            <td>
              <select data-status-for="${p.id}" class="small">
                ${PACKAGE_BULK_STATUSES.map(
                  (s) => `<option value="${s}" ${s === p.status ? 'selected' : ''}>${statusLabel(s)}</option>`,
                ).join('')}
                ${PACKAGE_BULK_STATUSES.includes(p.status) ? '' : `<option value="${p.status}" selected>${statusLabel(p.status)}</option>`}
              </select>
            </td>
            <td class="right">${p.itemCount}</td>
            <td class="right money">${p.totalFeeFen === null ? '<span class="muted">未分摊</span>' : money(p.totalFeeFen)}</td>
            <td class="right"><a class="btn small ghost" href="#/weigh/${p.id}">称重台</a></td>
          </tr>`,
          )
          .join('')}</tbody></table></div>`
          : empty('还没有包裹。导入 Excel 时会自动建一个同名包裹。')
      }
    </div>`;

  view.querySelectorAll('[data-status-for]').forEach((select) => {
    select.addEventListener('change', async () => {
      const id = select.dataset.statusFor;
      try {
        const result = await api.post(`/api/admin/packages/${id}/status`, { status: select.value });
        toast(`已更新 ${result.updated} 件${result.skipped ? `，跳过 ${result.skipped} 件` : ''}`);
      } catch (err) {
        toast(err.message, true);
        render(view);
      }
    });
  });

  bindActions(view, {});
}
