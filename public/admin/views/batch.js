import { api } from '/admin/api.js';
import {
  beijingTime,
  bindActions,
  codeTag,
  confirmBox,
  escapeHtml,
  openModal,
  orderTag,
  statusBadge,
  thumb,
  yen,
  toast,
  promptBox,
} from '/admin/ui.js';

const live = (i) => i.status !== 'cancelled' && i.status !== 'refunded';

/** 封面图那一行：进度 + 抓不到的那几件（重抓 / 手动换图）。 */
function imageCard(img) {
  if (!img || !img.total) return '';
  const done = img.stored;
  const want = img.total - img.noSource;
  const pct = want ? Math.round((done / want) * 100) : 100;
  const state = img.running
    ? '<span class="badge info dot">正在抓</span>'
    : img.failed.length
      ? `<span class="badge danger dot">${img.failed.length} 张没抓到</span>`
      : img.pending
        ? `<span class="badge warn dot">还有 ${img.pending} 张没抓</span>`
        : '<span class="badge ok dot">都存好了</span>';
  return `
    <div class="card" id="imgCard">
      <div class="card-head" style="margin-bottom:6px">
        <h3 style="margin:0">封面图 ${done}/${want}${img.noSource ? `<span class="small muted">（${img.noSource} 件没有链接）</span>` : ''}</h3>
        <div class="row">${state}
          ${!img.running && (img.failed.length || img.pending) ? '<button class="small" data-action="refetch">重抓</button>' : ''}</div>
      </div>
      <div class="meter${pct >= 100 ? ' ok' : ''}" style="max-width:320px"><span style="width:${pct}%"></span></div>
      ${img.failed.length
        ? `<div class="scroll-x" style="margin-top:8px"><table><tbody>${img.failed
            .map(
              (f) => `<tr><td>${escapeHtml(f.title)}<div class="small unpaid">${escapeHtml(f.reason)}</div></td>
                <td class="right"><button class="small plain" data-action="setImage" data-item="${f.itemId}" data-title="${escapeHtml(f.title)}">换图</button></td></tr>`,
            )
            .join('')}</tbody></table></div>`
        : ''}
    </div>`;
}

/** 选图 / 粘贴图 / 贴地址，给一件东西换封面。 */
function imageDialog(itemId, title, done) {
  openModal((box, close) => {
    box.innerHTML = `
      <h3 style="margin-top:0">换图：${escapeHtml(title)}</h3>
      <label class="btn ghost" style="display:inline-block">选图片<input type="file" accept="image/*" hidden id="imgFile"></label>
      <div id="pasteZone" class="paste-zone" tabindex="0">在这里 Ctrl+V 粘贴截图</div>
      <label for="imgUrl">或者贴图片地址</label>
      <div class="row"><input id="imgUrl" style="flex:1" placeholder="https://…"><button id="imgUrlGo" class="small">用这个地址</button></div>
      <p class="row" style="justify-content:flex-end;margin-bottom:0"><button class="plain" id="imgClose">关闭</button></p>`;
    const send = async (payload) => {
      try {
        await api.post(`/api/admin/items/${itemId}/image`, payload);
        toast('图换好了');
        close();
        done();
      } catch (err) {
        toast(err.message, true);
      }
    };
    const fromFile = (file) => {
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) return toast('图片太大了（最多 5 MB）', true);
      const reader = new FileReader();
      reader.onload = () => send({ dataUrl: reader.result });
      reader.readAsDataURL(file);
    };
    box.querySelector('#imgFile').onchange = (e) => fromFile(e.target.files[0]);
    const zone = box.querySelector('#pasteZone');
    zone.addEventListener('paste', (e) => {
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        fromFile(file);
      }
    });
    box.querySelector('#imgUrlGo').onclick = () => {
      const url = box.querySelector('#imgUrl').value.trim();
      if (url) send({ url });
    };
    box.querySelector('#imgClose').onclick = close;
    zone.focus();
  });
}

let pollTimer = null;

export async function render(view, [id]) {
  clearTimeout(pollTimer);
  const [data, img] = await Promise.all([
    api.get(`/api/admin/batches/${id}`),
    api.get(`/api/admin/batches/${id}/images`).catch(() => null),
  ]);
  const byCustomer = new Map();
  for (const item of data.items) {
    const entry = byCustomer.get(item.customerId) || {
      customerId: item.customerId,
      nickname: item.nickname,
      qq: item.qq,
      shipMode: item.shipMode,
      items: [],
    };
    entry.items.push(item);
    byCustomer.set(item.customerId, entry);
  }
  const people = [...byCustomer.values()].map((g) => {
    const payable = g.items.filter(live);
    const total = payable.reduce((sum, i) => sum + i.goodsFeeJpy, 0);
    const unpaid = payable.filter((i) => !i.goodsPaid).reduce((sum, i) => sum + i.goodsFeeJpy, 0);
    return { ...g, total, unpaid, paid: payable.every((i) => i.goodsPaid) };
  });

  const paidPeople = people.filter((p) => p.paid).length;
  const totalJpy = people.reduce((s, p) => s + p.total, 0);
  const paidJpy = people.reduce((s, p) => s + p.total - p.unpaid, 0);
  const payPct = people.length ? Math.round((paidPeople / people.length) * 100) : 0;
  const unpaidPeople = people.length - paidPeople;

  const groups = people
    .map((g) => {
      const hidden = g.items.filter((i) => !i.releasedAt).length;
      const sorted = g.items.filter((i) => i.sortedAt).length;
      const pct = g.items.length ? Math.round((sorted / g.items.length) * 100) : 0;
      return `
      <div class="card" id="cu-${g.customerId}">
        <div class="card-head">
          <div class="row" style="align-items:flex-start;gap:14px">
            <label class="pay-check"><input type="checkbox" data-pay="${g.customerId}" ${g.paid ? 'checked' : ''}> 已收款</label>
            <div>
              <h3><a href="#/customers/${g.customerId}">${escapeHtml(g.nickname)}</a>
                ${g.shipMode === 'direct' ? '<span class="badge warn">直邮</span>' : '<span class="badge ok">拼邮</span>'}
                ${hidden ? `<span class="badge dot">他还看不到 ${hidden} 件</span>` : '<span class="badge ok dot">他看得到</span>'}</h3>
              <div class="sub">QQ ${escapeHtml(g.qq)} · ${g.items.length} 件 · 仓库已整理 ${sorted}/${g.items.length}</div>
              <div class="meter${sorted >= g.items.length ? ' ok' : ''}" style="max-width:220px"><span style="width:${pct}%"></span></div>
            </div>
          </div>
          <div class="actions">
            <div class="right">
              <div class="money"><b>${yen(g.total)}</b></div>
              <div class="small ${g.unpaid ? 'unpaid' : 'paid'} money">${g.unpaid ? `未付 ${yen(g.unpaid)}` : '已付清'}</div>
            </div>
            ${hidden
              ? `<button class="small ghost" data-action="release" data-customer="${g.customerId}">只放行</button>`
              : `<button class="small plain" data-action="unrelease" data-customer="${g.customerId}">收回</button>`}
          </div>
        </div>
        <div class="scroll-x"><table>
          <thead><tr><th>图</th><th>行</th><th>名称</th><th class="right">实际价格</th><th class="right">应付</th><th>状态</th><th>货款</th></tr></thead>
          <tbody>${g.items
            .map(
              (i) => `<tr data-focus-item="${i.id}">
              <td class="cell-thumb sm">${thumb(i)}</td>
              <td class="small muted">${i.rowNo ?? ''}</td>
              <td>${i.productUrl ? `<a href="${escapeHtml(i.productUrl)}" target="_blank" rel="noreferrer">${escapeHtml(i.title)}</a>` : escapeHtml(i.title)}
                <div>${codeTag(i)}</div>${orderTag(i)}</td>
              <td class="right small money">${yen(i.actualPriceJpy)}</td>
              <td class="right money">${yen(i.goodsFeeJpy)}</td>
              <td>${statusBadge(i.status)}</td>
              <td><span class="badge ${i.goodsPaid ? 'ok' : 'danger'}">${i.goodsPaid ? '已付' : '未付'}</span></td>
            </tr>`,
            )
            .join('')}</tbody></table></div>
      </div>`;
    })
    .join('');

  view.innerHTML = `
    <div class="card">
      <p class="small" style="margin:0 0 6px"><a href="#/batches">← 全部订单</a></p>
      <div class="card-head" style="margin-bottom:8px">
        <h1 style="margin:0">${escapeHtml(data.batch.name)}</h1>
        <button data-action="orderTracking" class="small plain">改来源 / 单号</button>
      </div>
      <div class="row small">
        <span class="badge outline">来源 ${escapeHtml(data.batch.shop || '待填')}</span>
        ${data.batch.orderNo ? `<button class="badge copy-chip mono" data-copy="${escapeHtml(data.batch.orderNo)}">日本订单 ${escapeHtml(data.batch.orderNo)}</button>` : '<span class="badge warn">日本订单号待填</span>'}
        ${data.batch.japanTrackingNo ? `<button class="badge copy-chip mono" data-copy="${escapeHtml(data.batch.japanTrackingNo)}">日本单号 ${escapeHtml(data.batch.japanTrackingNo)}</button>` : '<span class="badge warn">日本单号待填</span>'}
      </div>
      <p class="small muted">
        导入于 ${beijingTime(data.batch.createdAt)} ·
        ${escapeHtml(data.batch.sourceFile || '—')} ·
        共 ${data.items.length} 件
      </p>
      <div class="pay-progress">
        <div class="row" style="justify-content:space-between">
          <b>已收 ${paidPeople}/${people.length} 人 · <span class="money">${yen(paidJpy)}</span> / <span class="money">${yen(totalJpy)}</span></b>
          ${unpaidPeople ? `<button class="small plain" data-action="payAll">剩下 ${unpaidPeople} 人全收</button>` : '<span class="badge ok dot">收齐了</span>'}
        </div>
        <div class="meter${payPct >= 100 ? ' ok' : ''}"><span style="width:${payPct}%"></span></div>
      </div>
      <p class="small">关联包裹：${
        data.packages.length
          ? data.packages.map((p) => `<a href="#/packages/${p.id}">${escapeHtml(p.name)}</a>`).join('、')
          : '<span class="muted">无</span>'
      }</p>
    </div>
    ${imageCard(img)}
    ${groups}`;

  // 勾一下就存：收款 + 放行；取消勾 = 撤销这一单的货款记录
  view.querySelectorAll('[data-pay]').forEach((box) =>
    box.addEventListener('change', async () => {
      const customerId = Number(box.dataset.pay);
      const name = byCustomer.get(customerId)?.nickname || '';
      const paid = box.checked;
      box.disabled = true;
      try {
        if (!paid && !(await confirmBox(`撤销 ${name} 这一单的收款记录？`, { okText: '撤销', danger: true }))) {
          box.checked = true;
          return;
        }
        await api.post('/api/admin/payments/batch-customer', { batchId: Number(id), customerId, paid });
        toast(paid ? `${name} 已收款，东西已放进他的仓库` : `已撤销 ${name} 的收款`);
        const y = window.scrollY;
        await render(view, [id]);
        window.scrollTo(0, y);
      } catch (err) {
        box.checked = !paid;
        toast(err.message, true);
      } finally {
        box.disabled = false;
      }
    }),
  );

  const rerender = async () => {
    const y = window.scrollY;
    await render(view, [id]);
    window.scrollTo(0, y);
  };

  const handlers = {
    release: async (ds) => {
      const r = await api.post('/api/admin/quick-order/release', { batchId: Number(id), customerId: Number(ds.customer) });
      toast(`放行了 ${r.count} 件`);
      rerender();
    },
    unrelease: async (ds) => {
      if (!(await confirmBox('收回之后他自己的页面上就看不到这一单的东西了。确定？', { okText: '收回', danger: true }))) return;
      await api.post('/api/admin/quick-order/release', { batchId: Number(id), customerId: Number(ds.customer), undo: true });
      rerender();
    },
    orderTracking: async () => {
      const shop = await promptBox('来源店铺（骏河屋 / 骏河屋秋叶原店 / booth …）', data.batch.shop || '');
      if (shop === null) return;
      const orderNo = await promptBox('日本订单号', data.batch.orderNo || '');
      if (orderNo === null) return;
      const japanTrackingNo = await promptBox('日本物流单号', data.batch.japanTrackingNo || '');
      if (japanTrackingNo === null) return;
      await api.patch(`/api/admin/batches/${id}`, { shop, orderNo, japanTrackingNo });
      await render(view, [id]);
    },
    refetch: async () => {
      await api.post(`/api/admin/batches/${id}/images`);
      toast('开始重抓');
      rerender();
    },
    setImage: async (ds) => imageDialog(Number(ds.item), ds.title, rerender),
    payAll: async () => {
      if (!(await confirmBox(`剩下 ${unpaidPeople} 个人全部记为已收款并放行？`, { okText: '全记上' }))) return;
      const r = await api.post('/api/admin/payments/all-goods', { batchId: Number(id) });
      toast(`已记 ${r.customers} 个人，合计 ${yen(r.amountJpy)}`);
      rerender();
    },
  };
  bindActions(view, handlers);

  // 后台还在抓图：每 3 秒刷新一下那一块，抓完自动停
  if (img?.running) {
    const poll = async () => {
      if (!document.body.contains(view.querySelector('#imgCard'))) return;
      const next = await api.get(`/api/admin/batches/${id}/images`).catch(() => null);
      if (!next) return;
      const card = view.querySelector('#imgCard');
      if (!next.running) return rerender();
      if (card) {
        card.outerHTML = imageCard(next);
        bindActions(view.querySelector('#imgCard'), handlers);
      }
      pollTimer = setTimeout(poll, 3000);
    };
    pollTimer = setTimeout(poll, 3000);
  }
}
