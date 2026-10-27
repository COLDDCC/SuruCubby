import { api } from '/admin/api.js';
import { copyText, escapeHtml, itemDetailHtml, openModal, toast } from '/admin/ui.js';

/** 弹出一件东西的完整信息。管理员看得到价格，日本仓看不到（后端控制）。 */
export function openItemDetail(id) {
  openModal(async (box, close) => {
    box.innerHTML = '<p class="muted">加载中…</p>';
    try {
      const d = await api.get(`/api/staff/items/${id}`);
      box.innerHTML = `${itemDetailHtml(d)}
        <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="plain" data-close>关闭</button></div>`;
    } catch (err) {
      box.innerHTML = `<p class="unpaid">${escapeHtml(err.message)}</p><p><button class="plain" data-close>关闭</button></p>`;
    }
    box.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
    box.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = async () => toast((await copyText(b.dataset.copy)) ? '已复制' : '复制不了，长按手动复制', false);
    });
  });
}

/** 容器里所有 [data-detail="物品ID"] 点了就弹详情。 */
export function bindItemDetails(root) {
  root.querySelectorAll('[data-detail]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openItemDetail(Number(el.dataset.detail));
    });
  });
}
