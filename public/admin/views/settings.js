import { api } from '/admin/api.js';
import { money, toast } from '/admin/ui.js';

export async function render(view) {
  const data = await api.get('/api/admin/settings');
  view.innerHTML = `
    <div class="card">
      <h2>设置</h2>
      <label for="fee">国内寄出每次收费（元）</label>
      <input id="fee" inputmode="decimal" value="${(data.domesticFeeFen / 100).toFixed(2)}">
      <p class="small muted">当前：${money(data.domesticFeeFen)} / 次，与件数无关。改动只影响之后新建的寄出。</p>
      <label for="price">国际运费单价（元 / kg）</label>
      <input id="price" inputmode="decimal" value="${(data.intlPriceFenPerKg / 100).toFixed(2)}">
      <p class="small muted">当前：${money(data.intlPriceFenPerKg)} / kg。称重台点「算分摊」就按这个单价从各摞重量推出这一箱的运费，不用手填；转运仓收得不一样，可以在分摊预览里改成实收金额。</p>
      <p><button id="save">保存</button></p>
    </div>`;
  document.getElementById('save').onclick = async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const r = await api.post('/api/admin/settings', {
        domesticFeeYuan: document.getElementById('fee').value.trim(),
        intlPriceYuanPerKg: document.getElementById('price').value.trim(),
      });
      toast(`已保存：国内 ${money(r.domesticFeeFen)} / 次，国际 ${money(r.intlPriceFenPerKg)} / kg`);
      await render(view);
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
    }
  };
}
