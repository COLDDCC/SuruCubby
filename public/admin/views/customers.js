import { api } from '/admin/api.js';
import { bindActions, empty, escapeHtml, money, openModal, promptBox, toast } from '/admin/ui.js';

export async function render(view, params, query = '') {
  const data = await api.get(`/api/admin/customers?q=${encodeURIComponent(query)}`);
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">客户</h2>
        <button class="small" data-action="new">新建客户</button>
      </div>
      <div class="row" style="margin-top:10px">
        <input id="q" placeholder="搜 QQ / 昵称 / 别名" value="${escapeHtml(query)}">
        <button class="small plain" data-action="search">搜索</button>
      </div>
      ${
        data.customers.length
          ? data.customers
              .map((c) => {
                const due = c.goodsUnpaidFen + c.intlUnpaidFen + c.domesticUnpaidFen;
                return `<div class="list-row">
            <div class="main">
              <a href="#/customers/${c.id}">${escapeHtml(c.nickname)}</a>
              <div class="small muted">QQ ${escapeHtml(c.qq)} · ${c.itemCount} 件 · 在库 ${c.stockCount}</div>
            </div>
            <div class="side">
              <span class="${due ? 'unpaid' : 'paid'} money">${money(due)}</span>
              <button class="small plain" data-action="copy" data-token="${escapeHtml(c.token)}">复制链接</button>
            </div>
          </div>`;
              })
              .join('')
          : empty('没有匹配的客户')
      }
    </div>`;

  const search = () => render(view, params, document.getElementById('q').value.trim());
  document.getElementById('q').onkeydown = (e) => {
    if (e.key === 'Enter') search();
  };

  bindActions(view, {
    search,
    copy: async ({ token }) => {
      const url = `${location.origin}/w/${token}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('链接已复制');
      } catch {
        await promptBox('复制这条链接发给客户', url);
      }
    },
    new: () => {
      openModal((box, close) => {
        box.innerHTML = `
          <h3>新建客户</h3>
          <label>QQ 号</label><input id="qq" inputmode="numeric" style="width:100%">
          <label>昵称（Excel 里的 cn 名字）</label><input id="nick" style="width:100%">
          <div class="row" style="justify-content:flex-end;margin-top:12px">
            <button class="plain" data-no>取消</button><button data-yes>创建</button>
          </div>`;
        box.querySelector('[data-no]').onclick = close;
        box.querySelector('[data-yes]').onclick = async () => {
          try {
            await api.post('/api/admin/customers', {
              qq: box.querySelector('#qq').value.trim(),
              nickname: box.querySelector('#nick').value.trim(),
            });
            close();
            toast('已创建');
            render(view, params, query);
          } catch (err) {
            toast(err.message, true);
          }
        };
      });
    },
  });
}
