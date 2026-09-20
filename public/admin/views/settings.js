import { api } from '/admin/api.js';
import { money, toast } from '/admin/ui.js';

export async function render(view) {
  const data = await api.get('/api/admin/settings');
  view.innerHTML = `
    <div class="card">
      <h2>设置</h2>
      <label for="fee">国内寄出每次收费（元）</label>
      <div class="row">
        <input id="fee" inputmode="decimal" value="${(data.domesticFeeFen / 100).toFixed(2)}">
        <button id="save">保存</button>
      </div>
      <p class="small muted">当前：${money(data.domesticFeeFen)} / 次，与件数无关。改动只影响之后新建的寄出。</p>
    </div>`;
  document.getElementById('save').onclick = async () => {
    const value = document.getElementById('fee').value.trim();
    await api.post('/api/admin/settings', { domesticFeeYuan: value });
    toast('已保存');
    render(view);
  };
}
