import { api } from '/admin/api.js';
import {
  beijingTime,
  bindActions,
  confirmBox,
  empty,
  escapeHtml,
  money,
  openModal,
  promptBox,
  toast,
} from '/admin/ui.js';

/**
 * 生成一次寄出。国际运费还没收时后端回 409 —— 群主经常先把东西寄了再补运费，
 * 所以这里不拦死，让他看一眼差额再决定要不要照样发货；他取消就返回 null。
 */
export async function createShipment(payload) {
  try {
    return await api.post('/api/admin/shipments', payload);
  } catch (err) {
    if (err.status !== 409) throw err;
    const d = err.data;
    if (
      !(await confirmBox(
        `这位客户还有国际运费没收（${money(d.unpaidIntlFen)}）。本次应收 = ${money(d.feeFen)} + ${money(
          d.unpaidIntlFen,
        )} = ${money(d.totalDueFen)}。仍要标成已发货吗？`,
        { danger: true, okText: '照样发货' },
      ))
    )
      return null;
    return api.post('/api/admin/shipments', { ...payload, force: true });
  }
}

/** 选客户 → 勾这一批 → 填单号 → 标成已发货。寄出页和客户详情共用这一套。 */
export async function shipModal(candidates, onDone) {
  // 标了「不拼邮」的人不在这条链上：后端也会拒绝，这里直接从名单里去掉
  const offList = candidates.filter((c) => c.selfReturn && c.stockCount > 0);
  const list = candidates.filter((c) => c.stockCount > 0 && !c.selfReturn);
  if (!list.length) {
    toast(
      offList.length
        ? `有可发货商品的 ${offList.length} 位都标了「不拼邮」（${offList
            .map((c) => c.nickname)
            .join('、')}），不用我们寄。其他客户还没有「可发货」的商品——得先在称重台把那一摞称完、算过分摊。`
        : '现在没有一位客户有「可发货」的商品。得先在称重台把那一摞称完、算过分摊，商品才会变成可发货。',
      true,
    );
    return;
  }
  openModal((box, close) => {
    box.innerHTML = `
      <h3>登记一次发货</h3>
      <p class="small muted">勾上这一批要寄的商品，它们当场变「已寄出」，并记一笔国内运费。快递单号现在能填，忘了也能回头在列表里补。</p>
      <label>发给哪位客户</label>
      <select id="cust" style="width:100%">
        <option value="">选一位（只剩可发货的那些）</option>
        ${list
          .map((c) => `<option value="${c.id}">${escapeHtml(c.nickname)} · QQ ${escapeHtml(c.qq)} · 可发货 ${c.stockCount}</option>`)
          .join('')}
      </select>
      <div id="pick" class="small muted" style="margin-top:10px">先选客户</div>
      <label style="margin-top:10px">国内快递单号（还没出单就留空）</label>
      <input id="track" style="width:100%" placeholder="顺丰 / 中通 / 圆通单号">
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="plain" data-no>取消</button>
        <button data-yes disabled>标成已发货</button>
      </div>`;

    const custEl = box.querySelector('#cust');
    const pickEl = box.querySelector('#pick');
    const yesEl = box.querySelector('[data-yes]');
    box.querySelector('[data-no]').onclick = close;

    const count = () => [...pickEl.querySelectorAll('input:checked')].length;
    const sync = () => {
      yesEl.disabled = count() === 0;
      yesEl.textContent = count() ? `标成已发货（${count()} 件）` : '标成已发货';
    };
    const toggleAll = () => {
      const boxes = [...pickEl.querySelectorAll('input:not(:disabled)')];
      const check = boxes.some((el) => !el.checked);
      boxes.forEach((el) => {
        el.checked = check;
      });
      sync();
    };

    custEl.onchange = async () => {
      yesEl.disabled = true;
      const id = Number(custEl.value);
      if (!id) {
        pickEl.innerHTML = '先选客户';
        return;
      }
      pickEl.innerHTML = '<span class="muted">正在读这一位的可发货商品…</span>';
      try {
        const d = await api.get(`/api/admin/customers/${id}`);
        const stock = d.items.filter((i) => i.status === 'cn_stock');
        if (!stock.length) {
          pickEl.innerHTML = '<span class="muted">这一位已经没有可发货的商品了。</span>';
          return;
        }
        pickEl.innerHTML = `
          <p class="small">可发货 ${stock.length} 件 · 国内运费固定 ${money(d.domesticFeeFen)}
            <button class="small plain" data-all>全选 / 全不选</button></p>
          ${stock
            .map(
              (i) => `<label class="row" style="margin:6px 0">
                <input type="checkbox" value="${i.id}"${i.requestId ? ' disabled' : ' checked'}>
                <span>${escapeHtml(i.title)}</span>
                <span class="small muted">${escapeHtml(i.packageName || '')}${
                  i.requestId ? ` · 已在申请 #${i.requestId} 里，去「发货申请」页寄` : ''
                }</span>
              </label>`,
            )
            .join('')}`;
        pickEl.querySelector('[data-all]').onclick = toggleAll;
        pickEl.querySelectorAll('input').forEach((el) => {
          el.onchange = sync;
        });
        sync();
      } catch (err) {
        pickEl.innerHTML = `<span class="unpaid">${escapeHtml(err.message || '这一位没读出来')}</span>`;
      }
    };

    yesEl.onclick = async () => {
      const itemIds = [...pickEl.querySelectorAll('input:checked')].map((el) => Number(el.value));
      if (!itemIds.length) return toast('先勾几件', true);
      const trackingNo = box.querySelector('#track').value.trim();
      yesEl.disabled = true;
      try {
        const result = await createShipment({ customerId: Number(custEl.value), itemIds, trackingNo });
        if (!result) {
          sync();
          return;
        }
        close();
        toast(`已标成发货：${itemIds.length} 件${trackingNo ? ` · ${trackingNo}` : ' · 单号回头补'}`);
        onDone();
      } catch (err) {
        toast(err.message || '这一步没成', true);
        sync();
      }
    };
  });
}

export async function render(view) {
  const data = await api.get('/api/admin/shipments');
  const waiting = data.shipments.filter((s) => !s.trackingNo).length;
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">国内寄出</h2>
        <button data-action="new">登记一次发货</button>
      </div>
      <p class="small muted">
        一次发货 = 勾这一批商品 → 标成「已寄出」→ 填国内快递单号。单号忘了填就点下面的「补单号」，客户页面会跟着把单号显示出来（还有个「复制」按钮）。
        ${waiting ? `现在有 <span class="unpaid">${waiting} 次还没填单号</span>。` : ''}
      </p>
      ${
        data.shipments.length
          ? data.shipments
              .map(
                (s) => `<div class="list-row">
          <div class="main">
            <a href="#/customers/${s.customerId}">${escapeHtml(s.nickname)}</a>
            ${
              s.trackingNo
                ? `${escapeHtml(s.trackingNo)}`
                : '<span class="badge warn">单号待填</span>'
            }
            <div class="small muted">${s.itemCount} 件 · ${
          s.shippedAt ? `发货于 ${beijingTime(s.shippedAt)}` : `创建于 ${beijingTime(s.createdAt)}（还没填单号）`
        }</div>
          </div>
          <div class="side">
            <span class="${s.feePaid ? 'paid' : 'unpaid'} money">${money(s.feeFen)}${s.feePaid ? ' 已付' : ''}</span>
            <button class="small${s.trackingNo ? ' plain' : ''}" data-action="track" data-id="${s.id}" data-current="${escapeHtml(
              s.trackingNo || '',
            )}">${s.trackingNo ? '改单号' : '补单号'}</button>
            ${s.feePaid ? '' : `<button class="small" data-action="pay" data-id="${s.id}" data-customer="${s.customerId}">已收款</button>`}
            ${s.feePaid ? '' : `<button class="small danger" data-action="cancel" data-id="${s.id}">撤销</button>`}
          </div>
        </div>`,
              )
              .join('')
          : empty('还没有寄出记录')
      }
    </div>`;

  bindActions(view, {
    new: async () => {
      const { customers } = await api.get('/api/admin/customers');
      await shipModal(customers, () => render(view));
    },
    track: async ({ id, current }) => {
      const value = await promptBox(current ? '改国内快递单号' : '填写国内快递单号', current);
      if (value === null) return;
      if (!value) return toast('单号是空的，没改', true);
      await api.patch(`/api/admin/shipments/${id}`, { trackingNo: value });
      toast('已保存');
      render(view);
    },
    pay: async ({ id, customer }) => {
      await api.post('/api/admin/payments', {
        customerId: Number(customer),
        kind: 'domestic',
        shipmentId: Number(id),
      });
      toast('已记账');
      render(view);
    },
    cancel: async ({ id }) => {
      if (!(await confirmBox('撤销这次寄出？物品会退回「可发货」。', { danger: true, okText: '撤销' }))) return;
      await api.del(`/api/admin/shipments/${id}`);
      toast('已撤销');
      render(view);
    },
  });
}
