import { api } from '/admin/api.js';
import { bindActions, escapeHtml, money, promptBox, toast } from '/admin/ui.js';

/** 默认清到本月 1 号之前：11 月走完的，12 月来删 */
function firstOfMonth() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export async function render(view) {
  const [data, wh] = await Promise.all([api.get('/api/admin/settings'), api.get('/api/admin/warehouse-users')]);
  view.innerHTML = `
    <div class="card">
      <h2>直邮运费单价</h2>
      <p class="small muted">这两个数只有你看得到：仓库那边一个价格都看不到，客户只看到「毛重 × 收客户的单价」算出来的运费。</p>
      <div class="row">
        <div><label for="cost">仓库收我的（元 / kg）</label><input id="cost" inputmode="decimal" value="${(data.whCostFenPerKg / 100).toFixed(2)}"></div>
        <div><label for="sale">我收客户的（元 / kg）</label><input id="sale" inputmode="decimal" value="${(data.directSaleFenPerKg / 100).toFixed(2)}"></div>
      </div>
      <p class="small muted">仓库提交包裹那一刻按这里的数记下来；之后改这里不影响已经提交的包裹。单个包裹想给优惠，去「直邮包裹」页单独改。</p>
      <p><button id="saveDirect">保存直邮单价</button></p>
    </div>

    <div class="card">
      <h2>仓库账号</h2>
      <p class="small muted">每个仓库人员一个账号，登录地址是 <code>${escapeHtml(location.origin)}/wh/</code>（首页点「我是仓库」也能进）。改密码或停用会让他当场掉线。</p>
      <table>
        <thead><tr><th>账号</th><th>名字</th><th class="right">提交过的包裹</th><th></th></tr></thead>
        <tbody>${wh.users
          .map(
            (u) => `<tr>
          <td class="mono">${escapeHtml(u.username)}</td>
          <td>${escapeHtml(u.displayName)} ${u.disabled ? '<span class="badge danger">已停用</span>' : ''}</td>
          <td class="right">${u.parcelCount}</td>
          <td class="right">
            <button class="small plain" data-action="pw" data-id="${u.id}">改密码</button>
            <button class="small plain" data-action="toggle" data-id="${u.id}" data-disabled="${u.disabled}">${u.disabled ? '恢复' : '停用'}</button>
          </td></tr>`,
          )
          .join('') || '<tr><td colspan="4" class="empty">还没有仓库账号</td></tr>'}</tbody>
      </table>
      <div class="row" style="margin-top:10px">
        <input id="whUser" placeholder="账号（字母数字）" autocomplete="off">
        <input id="whName" placeholder="名字，比如 仓库小王">
        <input id="whPw" placeholder="初始密码（6 位以上）" autocomplete="new-password">
        <button data-action="add">新建仓库账号</button>
      </div>
    </div>

    <div class="card">
      <h2>清理走完的旧订单</h2>
      <p class="small muted">只删每一件都已经寄出 / 回国 / 取消的订单，连同它们的直邮包裹和平铺图；还在路上的一件不碰。客户账号、地址、收款记录都留着。删了找不回来，先「看看会删什么」。</p>
      <div class="row">
        <label for="cleanBefore" style="margin:0">最后一次变动早于</label>
        <input id="cleanBefore" type="date" value="${firstOfMonth()}">
        <button class="plain" data-action="cleanPreview">看看会删什么</button>
      </div>
      <div id="cleanReport"></div>
    </div>

    <div class="card">
      <h2>老流程的设置</h2>
      <p class="small muted">「称重分摊 → 客户申请发货 → 你寄出」那套流程现在不用了，这两个数只在你还用老页面时才起作用。</p>
      <label for="fee">国内寄出每次收费（元）</label>
      <input id="fee" inputmode="decimal" value="${(data.domesticFeeFen / 100).toFixed(2)}">
      <label for="price">国际运费单价（元 / kg）</label>
      <input id="price" inputmode="decimal" value="${(data.intlPriceFenPerKg / 100).toFixed(2)}">
      <p><button id="save" class="plain">保存</button></p>
    </div>`;

  const save = (body, done) => async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const r = await api.post('/api/admin/settings', body());
      toast(done(r));
      await render(view);
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
    }
  };
  document.getElementById('saveDirect').onclick = save(
    () => ({ whCostYuanPerKg: document.getElementById('cost').value.trim(), directSaleYuanPerKg: document.getElementById('sale').value.trim() }),
    (r) => `已保存：仓库 ${money(r.whCostFenPerKg)} / kg，收客户 ${money(r.directSaleFenPerKg)} / kg`,
  );
  document.getElementById('save').onclick = save(
    () => ({ domesticFeeYuan: document.getElementById('fee').value.trim(), intlPriceYuanPerKg: document.getElementById('price').value.trim() }),
    (r) => `已保存：国内 ${money(r.domesticFeeFen)} / 次，国际 ${money(r.intlPriceFenPerKg)} / kg`,
  );
  const report = view.querySelector('#cleanReport');
  bindActions(view, {
    cleanPreview: async () => {
      const before = view.querySelector('#cleanBefore').value;
      const r = await api.post('/api/admin/cleanup', { before });
      if (!r.batchCount) {
        report.innerHTML = `<p class="small">${escapeHtml(before)} 之前没有走完的订单。</p>`;
        return;
      }
      report.innerHTML = `<p>会删 <b>${r.batchCount}</b> 个订单、${r.itemCount} 件东西、${r.parcelCount} 个直邮包裹、${r.photoCount} 张平铺图：</p>
        <p class="small muted">${r.batches.map((b) => escapeHtml(b.orderNo || b.name)).join('、')}${r.batchCount > r.batches.length ? ' …' : ''}</p>
        <button class="danger" id="cleanGo">确认删除这 ${r.batchCount} 个订单</button>`;
      report.querySelector('#cleanGo').onclick = async (e) => {
        e.target.disabled = true;
        try {
          const done = await api.post('/api/admin/cleanup', { before, commit: true });
          toast(`删掉了 ${done.batchCount} 个订单`);
          render(view);
        } catch (err) {
          e.target.disabled = false;
          toast(err.message, true);
        }
      };
    },
    add: async () => {
      await api.post('/api/admin/warehouse-users', {
        username: document.getElementById('whUser').value.trim(),
        displayName: document.getElementById('whName').value.trim(),
        password: document.getElementById('whPw').value,
      });
      toast('建好了，把账号密码私发给他');
      render(view);
    },
    pw: async (ds) => {
      const pw = await promptBox('新密码（6 位以上）', '');
      if (!pw) return;
      await api.patch(`/api/admin/warehouse-users/${ds.id}`, { password: pw });
      toast('改好了，他得用新密码重新登录');
    },
    toggle: async (ds) => {
      await api.patch(`/api/admin/warehouse-users/${ds.id}`, { disabled: ds.disabled !== '1' });
      render(view);
    },
  });
}
