import { api } from '/admin/api.js';
import { beijingTime, empty, escapeHtml, money } from '/admin/ui.js';

export async function render(view) {
  const data = await api.get('/api/admin/batches');
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">批次</h2>
        <a class="btn small" href="#/import">导入新的 Excel</a>
      </div>
      ${
        data.batches.length
          ? `<div class="scroll-x" style="margin-top:12px"><table>
        <thead><tr><th>批次</th><th class="right">件数</th><th class="right">金额</th><th class="right">未付</th><th>导入时间</th></tr></thead>
        <tbody>${data.batches
          .map(
            (b) => `<tr>
            <td><a href="#/batches/${b.id}">${escapeHtml(b.name)}</a>
              <div class="small muted">${escapeHtml(b.sourceFile || '')}</div></td>
            <td class="right">${b.itemCount}</td>
            <td class="right money">${money(b.amountFen)}</td>
            <td class="right ${b.unpaidFen ? 'unpaid' : 'paid'} money">${money(b.unpaidFen)}</td>
            <td class="small muted" style="white-space:nowrap">${beijingTime(b.createdAt)}</td>
          </tr>`,
          )
          .join('')}</tbody></table></div>`
          : empty('还没有批次，先去导入一张 Excel')
      }
    </div>`;
}
