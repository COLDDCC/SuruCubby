import { api } from '/admin/api.js';
import {
  beijingTime,
  bindActions,
  codeTag,
  confirmBox,
  empty,
  escapeHtml,
  jpy,
  money,
  promptBox,
  statusLabel,
  thumb,
  toast,
  yen,
} from '/admin/ui.js';

export async function render(view, [id]) {
  const data = await api.get(`/api/admin/customers/${id}`);
  const s = data.summary;
  const stock = data.items.filter((i) => i.status === 'cn_stock');

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${escapeHtml(data.customer.nickname)}
          <span class="muted small">${escapeHtml(data.customer.qq)}</span></h2>
        <div class="row">
          <button class="small plain" data-action="copy">复制专属链接</button>
          <button class="small plain" data-action="reset">重置链接</button>
          <button class="small plain" data-action="merge">合并客户</button>
        </div>
      </div>
      <div class="grid" style="margin-top:12px">
        <div class="stat"><div class="label">货款待付（日元）</div><div class="value money">${yen(s.goodsUnpaidJpy)}</div></div>
        <div class="stat"><div class="label">国际运费待付</div><div class="value money">${money(s.intlUnpaidFen)}</div></div>
        <div class="stat"><div class="label">国内运费待付</div><div class="value money">${money(s.domesticUnpaidFen)}</div></div>
        <div class="stat big"><div class="label">运费待付</div><div class="value money">${money(s.freightUnpaidFen)}</div></div>
      </div>
      <p class="small muted">货款按日元记，客户付款当天按汇率折成人民币；运费是人民币，两者不合并算总数。</p>
      <p class="small muted">别名：${data.aliases.map((a) => escapeHtml(a)).join('、') || '无'}
        <button class="small plain" data-action="addAlias">加别名</button></p>
      <p class="small muted">真名（只有后台看得到，客户自己的页面不显示）：${
        data.realName ? escapeHtml(data.realName) : '没填'
      } <button class="small plain" data-action="realName">改</button></p>
      <p class="small ${data.passwordInitial ? 'unpaid' : 'paid'}">登录密码：${
        data.passwordInitial ? '还是初始密码 123456（他下次进去会被要求改成自己的）' : '已经改成自己的了'
      } <button class="small plain" data-action="password">改密码</button></p>
    </div>

    <div class="card">
      <h3>按批次的货款</h3>
      ${
        data.batches.length
          ? data.batches
              .map(
                (b) => `<div class="list-row">
          <div class="main">
            <a href="#/batches/${b.batchId}">${escapeHtml(b.batchName)}</a>
            <div class="small muted">${b.count} 件 · 合计 ${yen(b.amountJpy)}</div>
          </div>
          <div class="side">
            <span class="${b.unpaidJpy ? 'unpaid' : 'paid'} money">${b.unpaidJpy ? `未付 ${yen(b.unpaidJpy)}` : '已付清'}</span>
            ${
              b.unpaidJpy
                ? `<button class="small" data-action="payBatch" data-batch="${b.batchId}">这一批全部已收</button>`
                : ''
            }
          </div>
        </div>`,
              )
              .join('')
          : empty('还没有物品')
      }
    </div>

    <div class="card">
      <h3>可发货（${stock.length} 件）</h3>
      ${
        stock.length
          ? `<form id="shipForm">
          ${stock
            .map(
              (i) => `<label class="row" style="margin:6px 0">
              <input type="checkbox" name="item" value="${i.id}" checked>
              <span>${escapeHtml(i.title)}</span>
              <span class="small muted">${escapeHtml(i.packageName || '')}</span>
            </label>`,
            )
            .join('')}
          <button type="button" data-action="ship">生成一次寄出</button>
          <span class="small muted">每次固定收国内运费，与件数无关。</span>
        </form>`
          : empty('没有可发货物品')
      }
    </div>

    <div class="card">
      <h3>国际运费（按包裹分摊）</h3>
      ${
        data.weighGroups.length
          ? data.weighGroups
              .map(
                (g) => `<div class="list-row">
          <div class="main">
            <a href="#/packages/${g.packageId}">${escapeHtml(g.packageName)}</a>
            <div class="small muted">这一摞 ${Number(g.weightG || 0).toLocaleString()} g · ${g.items.length} 件</div>
          </div>
          <div class="side">
            <span class="${g.feePaid ? 'paid' : 'unpaid'} money">${money(g.intlFeeFen)}</span>
            ${
              g.feePaid
                ? '<span class="paid small">已收</span>'
                : `<button class="small" data-action="payIntl" data-group="${g.id}">已收款</button>`
            }
          </div>
        </div>`,
              )
              .join('')
          : empty('还没有分摊过国际运费')
      }
    </div>

    <div class="card">
      <h3>寄出记录</h3>
      ${
        data.shipments.length
          ? data.shipments
              .map(
                (sh) => `<div class="list-row">
          <div class="main">
            ${sh.trackingNo ? escapeHtml(sh.trackingNo) : '<span class="muted">单号待填</span>'}
            <div class="small muted">${sh.items.length} 件 · ${beijingTime(sh.shippedAt || sh.createdAt)}</div>
          </div>
          <div class="side">
            <span class="${sh.feePaid ? 'paid' : 'unpaid'} money">${money(sh.feeFen)}</span>
            <button class="small plain" data-action="track" data-id="${sh.id}" data-current="${escapeHtml(sh.trackingNo || '')}">单号</button>
            ${sh.feePaid ? '' : `<button class="small" data-action="payDomestic" data-id="${sh.id}">已收款</button>`}
          </div>
        </div>`,
              )
              .join('')
          : empty('还没寄过')
      }
    </div>

    <div class="card">
      <h3>全部物品</h3>
      <div class="scroll-x"><table>
        <thead><tr><th>图</th><th>名称</th><th>批次</th><th class="right">实际价格</th><th class="right">应付</th><th>状态</th><th>货款</th></tr></thead>
        <tbody>${data.items
          .map(
            (i) => `<tr data-focus-item="${i.id}">
            <td class="cell-thumb">${thumb(i)}</td>
            <td>${escapeHtml(i.title)}${i.missing ? ' <span class="badge warn">缺件</span>' : ''}
              <div>${codeTag(i)}</div></td>
            <td class="small muted">${escapeHtml(i.batchName)}</td>
            <td class="right small">${jpy(i.actualPriceJpy)}</td>
            <td class="right money">${yen(i.goodsFeeJpy)}</td>
            <td class="small">${escapeHtml(statusLabel(i.status))}</td>
            <td class="small ${i.goodsPaid ? 'paid' : 'unpaid'}">${i.goodsPaid ? '已付' : '未付'}</td>
          </tr>`,
          )
          .join('')}</tbody></table></div>
    </div>

    <div class="card">
      <h3>收款记录</h3>
      ${
        data.payments.length
          ? `<table><tbody>${data.payments
              .map(
                (p) => `<tr>
              <td class="small muted" style="white-space:nowrap">${beijingTime(p.paidAt)}</td>
              <td class="small">${escapeHtml(p.kind)}</td>
              <td class="right money">${p.currency === 'JPY' ? yen(p.amount) : money(p.amount)}</td>
              <td class="right"><button class="small plain" data-action="revoke" data-id="${p.id}">撤销</button></td>
            </tr>`,
              )
              .join('')}</tbody></table>`
          : empty('还没有收款')
      }
    </div>`;

  const reload = () => render(view, [id]);

  bindActions(view, {
    copy: async () => {
      const url = `${location.origin}/w/${data.token}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('链接已复制');
      } catch {
        await promptBox('复制这条链接发给客户', url);
      }
    },
    reset: async () => {
      if (!(await confirmBox('重置后旧链接立刻失效，确定？', { danger: true, okText: '重置' }))) return;
      const result = await api.post(`/api/admin/customers/${id}/reset-token`);
      await promptBox('新的专属链接', `${location.origin}/w/${result.token}`);
      reload();
    },
    addAlias: async () => {
      const alias = await promptBox('Excel 里还用过哪个名字？');
      if (!alias) return;
      await api.post(`/api/admin/customers/${id}/aliases`, { alias });
      toast('已添加');
      reload();
    },
    realName: async () => {
      const real = await promptBox('真名（只有你在后台看得到）', data.realName || '');
      if (!real) return;
      await api.patch(`/api/admin/customers/${id}`, { realName: real });
      toast('已记下');
      reload();
    },
    password: async () => {
      const pw = await promptBox(
        data.passwordInitial
          ? '给他设一个密码（留空＝还是初始密码 123456，他下次进去自己改）'
          : '给他设一个新密码（留空＝退回初始密码 123456，他下次进去自己改）',
        '',
      );
      if (pw === null) return;
      if (pw === '' && !data.passwordInitial) {
        if (!(await confirmBox('退回初始密码 123456？他下次登录要先改成自己的。', { danger: true, okText: '退回' })))
          return;
      }
      await api.post(`/api/admin/customers/${id}/password`, { password: pw });
      toast(pw === '' ? '已退回初始密码 123456' : '密码已设好，私发给他');
      reload();
    },
    merge: async () => {
      const sourceId = await promptBox('把哪个客户（ID）合并进来？合并后那个客户会被删除');
      if (!sourceId) return;
      if (!(await confirmBox(`确定把 #${sourceId} 的所有数据并到这里？`, { danger: true, okText: '合并' }))) return;
      await api.post('/api/admin/customers/merge', { sourceId: Number(sourceId), targetId: Number(id) });
      toast('已合并');
      reload();
    },
    payBatch: async ({ batch }) => {
      const items = data.items.filter(
        (i) => i.batchId === Number(batch) && !i.goodsPaid && i.status !== 'cancelled' && i.status !== 'refunded',
      );
      const total = items.reduce((sum, i) => sum + i.goodsFeeJpy, 0);
      if (
        !(await confirmBox(`这一批还有 ${items.length} 件没记，合计 ${yen(total)}。全部记为已收？`, {
          okText: '全记上',
        }))
      )
        return;
      try {
        await api.post('/api/admin/payments', { customerId: Number(id), kind: 'goods', batchId: Number(batch) });
        toast('已记账');
      } catch (err) {
        toast(err.message, true);
      }
      reload();
    },
    payIntl: async ({ group }) => {
      await api.post('/api/admin/payments', { customerId: Number(id), kind: 'intl', weighGroupId: Number(group) });
      toast('已记账');
      reload();
    },
    payDomestic: async ({ id: shipmentId }) => {
      await api.post('/api/admin/payments', {
        customerId: Number(id),
        kind: 'domestic',
        shipmentId: Number(shipmentId),
      });
      toast('已记账');
      reload();
    },
    track: async ({ id: shipmentId, current }) => {
      const value = await promptBox('填写国内快递单号', current);
      if (value === null) return;
      await api.patch(`/api/admin/shipments/${shipmentId}`, { trackingNo: value });
      toast('已保存');
      reload();
    },
    revoke: async ({ id: paymentId }) => {
      if (!(await confirmBox('撤销这笔收款？', { danger: true, okText: '撤销' }))) return;
      await api.del(`/api/admin/payments/${paymentId}`);
      toast('已撤销');
      reload();
    },
    ship: async () => {
      const itemIds = [...view.querySelectorAll('#shipForm input[name=item]:checked')].map((el) => Number(el.value));
      if (itemIds.length === 0) return toast('先勾几件', true);
      try {
        const result = await api.post('/api/admin/shipments', { customerId: Number(id), itemIds });
        toast(`已生成寄出，应收 ${money(result.feeFen)}`);
        reload();
      } catch (err) {
        if (err.status !== 409) throw err;
        const d = err.data;
        const ok = await confirmBox(
          `这位客户还有国际运费没付（${money(d.unpaidIntlFen)}）。本次应收 = ${money(d.feeFen)} + ${money(
            d.unpaidIntlFen,
          )} = ${money(d.totalDueFen)}。仍要生成寄出吗？`,
          { danger: true, okText: '强制生成' },
        );
        if (!ok) return;
        const result = await api.post('/api/admin/shipments', {
          customerId: Number(id),
          itemIds,
          force: true,
        });
        toast(`已生成寄出，应收 ${money(result.totalDueFen)}`);
        reload();
      }
    },
  });
}
