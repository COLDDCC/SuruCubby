import { api } from '/admin/api.js';
import { beijingTime, bindActions, confirmBox, escapeHtml, money, toast, yen } from '/admin/ui.js';

/**
 * 待办：照新流程排——放行 → 仓库整理 → 直邮单号放行 / 拼邮箱发出 → 收货款。
 * 旧流程（称重分摊、国内寄出）的清单有数据才出现，收在最下面的折叠区。
 */

function row(main, sub, right, action) {
  return `<div class="list-row">
    <div class="main">${main}${sub ? `<div class="small muted">${sub}</div>` : ''}</div>
    <div class="side">${right}${action || ''}</div>
  </div>`;
}

function customerLink(r) {
  return `<a href="#/customers/${r.customerId}"><b>${escapeHtml(r.nickname)}</b></a>`;
}

const LANE = { direct: '<span class="badge warn">直邮</span>', group: '<span class="badge ok">拼邮</span>' };

function todoCard(id, title, count, body, foot = '') {
  return `<section class="card" id="${id}">
    <div class="card-head">
      <h2>${title}<span class="badge ${count ? 'danger' : 'ok'}">${count || '清空了'}</span></h2>
      ${foot}
    </div>
    ${body}
  </section>`;
}

/** 清单太长时只露前几行，其余收进「再看 N 条」，别让一个清单把下面几个顶到看不见 */
function capped(rows, n = 6) {
  if (rows.length <= n) return rows.join('');
  return `${rows.slice(0, n).join('')}<details><summary class="small" style="padding:8px 0 0">再看 ${rows.length - n} 条</summary>${rows.slice(n).join('')}</details>`;
}

function emptyBox(text) {
  return `<p class="empty box">${escapeHtml(text)}</p>`;
}

export async function render(view) {
  const data = await api.get('/api/admin/dashboard');
  const toRelease = data.toRelease || [];
  const parcels = data.parcelsPending || [];
  const backlog = data.whBacklog || [];
  const boxes = data.openBoxes || [];

  const releasePeople = new Set(toRelease.map((r) => r.customerId)).size;
  const goodsUnpaidJpy = data.goodsUnpaid.reduce((s, r) => s + r.amountJpy, 0);
  const backlogItems = backlog.reduce((s, r) => s + r.count, 0);
  const parcelSale = parcels.reduce((s, p) => s + p.saleFen, 0);

  const kpi = (href, label, value, unit, hint, tone) =>
    `<a class="stat${tone ? ` tone-${tone}` : ''}" href="${href}">
      <div class="label">${label}</div>
      <div class="value">${value}<small>${unit}</small></div>
      <div class="hint">${hint}</div>
    </a>`;

  const kpis = `<div class="grid kpis">
    ${kpi('#/?go=todo-release', '待放行', releasePeople, '人', `${toRelease.reduce((s, r) => s + r.count, 0)} 件还看不到`, releasePeople ? 'warn' : 'ok')}
    ${kpi('#/?go=todo-parcels', '等单号放行', parcels.length, '个包裹', parcels.length ? `应收 ${money(parcelSale)}` : '没有压着的单号', parcels.length ? 'danger' : 'ok')}
    ${kpi('#/?go=todo-goods', '货款未收', yen(goodsUnpaidJpy).replace('円', ''), '円', `${new Set(data.goodsUnpaid.map((r) => r.customerId)).size} 个人`, goodsUnpaidJpy ? 'danger' : 'ok')}
    ${kpi('#/?go=todo-backlog', '仓库未整理', backlogItems, '件', `${backlog.length} 个订单`, backlogItems ? 'info' : 'ok')}
  </div>`;

  // ① 待放行：收了钱就点，放进他自己的仓库
  const releaseHtml = toRelease.length
    ? capped(
      toRelease
        .map((r) =>
          row(
            `${customerLink(r)} ${LANE[r.shipMode] || ''}`,
            `<a href="#/batches/${r.batchId}">${escapeHtml(r.orderNo || r.batchName)}</a> · ${r.count} 件 · ${yen(r.amountJpy)}`,
            r.goodsPaid ? '<span class="badge ok dot">货款已收</span>' : '<span class="badge dot">货款未收</span>',
            r.goodsPaid
              ? `<button class="small" data-action="release" data-batch="${r.batchId}" data-customer="${r.customerId}" data-name="${escapeHtml(r.nickname)}">放进他的仓库</button>`
              : `<button class="small" data-action="payGoods" data-batch="${r.batchId}" data-customer="${r.customerId}" data-name="${escapeHtml(r.nickname)}">已收款</button>`,
          ),
        )
      )
    : emptyBox('所有人的东西都放行了');

  // ② 直邮包裹等单号放行：按仓库提交日分组，点过去在直邮包裹页一起勾选放行
  const byDay = new Map();
  for (const p of parcels) byDay.set(p.submitDay, [...(byDay.get(p.submitDay) || []), p]);
  const parcelHtml = parcels.length
    ? [...byDay]
        .map(
          ([day, list]) => `<div class="list-row">
            <div class="main"><b>${escapeHtml(day)}</b> 仓库提交 ${list.length} 个
              <div class="small muted">${list.map((p) => `${escapeHtml(p.nickname)}（${p.itemCount} 件 · ${p.grossWeightG.toLocaleString()} g）`).join('、')}</div></div>
            <div class="side"><span class="money">${money(list.reduce((s, p) => s + p.saleFen, 0))}</span>
              <a class="btn small" href="#/parcels?day=${encodeURIComponent(day)}">去收钱 / 放行</a></div>
          </div>`,
        )
        .join('')
    : emptyBox('没有压着单号的直邮包裹');

  // ③ 仓库还没整理（只读：让你知道卡在哪一单）
  const backlogHtml = backlog.length
    ? capped(
      backlog
        .map((b) =>
          row(
            `<a href="#/batches/${b.batchId}"><b>${escapeHtml(b.orderNo || b.batchName)}</b></a>`,
            `${escapeHtml(b.batchName)}${b.japanTrackingNo ? ` · 运单 ${escapeHtml(b.japanTrackingNo)}` : ' · <span class="unpaid">运单号没填</span>'} · 放行于 ${beijingTime(b.since, false)}`,
            `<span class="small">${b.customerCount} 人 · <b>${b.count}</b> 件</span>`,
          ),
        )
      )
    : emptyBox('仓库手上没有积压');

  // ④ 拼邮箱
  const boxHtml = boxes.length
    ? boxes
        .map((b) =>
          row(
            `<b>${escapeHtml(b.name)}</b>`,
            `${b.customerCount} 人 · ${b.itemCount} 件 · 开箱 ${beijingTime(b.createdAt, false)}`,
            b.trackingNo ? `<span class="badge info dot">单号 ${escapeHtml(b.trackingNo)}</span>` : '<span class="badge warn dot">回国单号没填</span>',
          ),
        )
        .join('')
    : emptyBox('没有开着的拼邮箱');

  const needAddress = data.needAddress || [];
  const addressHtml = capped(
    needAddress.map((r) =>
      row(customerLink(r), `${r.count} 件等着直邮`, '<span class="badge warn dot">没有地址</span>', `<a class="btn small" href="#/customers/${r.customerId}">填地址</a>`),
    ),
  );

  // ⑤ 货款未收（老逻辑不变）
  const goods = data.goodsUnpaid.length
    ? capped(
      data.goodsUnpaid
        .map((r) =>
          row(
            customerLink(r),
            `${escapeHtml(r.batchName)} · ${r.count} 件 · QQ ${escapeHtml(r.qq)}`,
            `<span class="unpaid money">${yen(r.amountJpy)}</span>`,
            `<button class="small" data-action="payGoods" data-customer="${r.customerId}" data-batch="${r.batchId}" data-name="${escapeHtml(r.nickname)}">已收款</button>`,
          ),
        )
      )
    : emptyBox('没有未付的货款');

  // ───── 旧流程：有数据才画 ─────
  const legacy = [];
  if (data.intlUnpaid.length)
    legacy.push(
      `<div class="card"><h3>国际运费未付</h3>${data.intlUnpaid
        .map((r) =>
          row(
            customerLink(r),
            `${escapeHtml(r.packageName)} · ${Number(r.weightG || 0).toLocaleString()} g`,
            `<span class="unpaid money">${money(r.intlFeeFen)}</span>`,
            `<button class="small" data-action="payIntl" data-customer="${r.customerId}" data-group="${r.weighGroupId}">已收款</button>`,
          ),
        )
        .join('')}</div>`,
    );
  if (data.domesticUnpaid.length)
    legacy.push(
      `<div class="card"><h3>国内运费未付</h3>${data.domesticUnpaid
        .map((r) =>
          row(
            customerLink(r),
            `${r.trackingNo ? escapeHtml(r.trackingNo) : '单号待填'} · ${r.itemCount} 件`,
            `<span class="unpaid money">${money(r.feeFen)}</span>`,
            `<button class="small" data-action="payDomestic" data-customer="${r.customerId}" data-shipment="${r.shipmentId}">已收款</button>`,
          ),
        )
        .join('')}</div>`,
    );
  if (data.domesticStock.length)
    legacy.push(
      `<div class="card"><h3>可发货（称重分摊后）</h3>${data.domesticStock
        .map((r) =>
          row(
            customerLink(r),
            `可发货 ${r.count} 件 · 最早一件已放 <span class="${r.days >= 30 ? 'unpaid' : ''}">${r.days} 天</span>`,
            '',
            `<a class="btn small ghost" href="#/customers/${r.customerId}">安排寄出</a>`,
          ),
        )
        .join('')}</div>`,
    );
  // 待退款不属于哪条流程，有就一直摆在外面
  const refunds = data.pendingRefunds.length
    ? todoCard(
        'todo-refund',
        '待退款',
        data.pendingRefunds.length,
        data.pendingRefunds
          .map((r) =>
            row(
              `${customerLink(r)} · ${escapeHtml(r.title)}`,
              escapeHtml(r.batchName),
              `<span class="money">${yen(r.goodsFeeJpy)}</span>`,
              `<button class="small" data-action="refunded" data-item="${r.itemId}">已退款</button>`,
            ),
          )
          .join(''),
      )
    : '';

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">待办</h1>
      </div>
      <div class="page-actions">
        <a class="btn ghost" href="#/batches">全部订单</a>
        <a class="btn" href="#/import">录入新订单</a>
      </div>
    </div>
    ${kpis}
    <div class="todo-grid">
      ${needAddress.length ? todoCard('todo-address', '直邮待补地址', needAddress.length, addressHtml) : ''}
      ${todoCard('todo-release', '① 待放行', releasePeople, releaseHtml)}
      ${todoCard('todo-parcels', '② 直邮包裹等单号放行', parcels.length, parcelHtml, '<a class="small" href="#/parcels">直邮包裹 →</a>')}
      ${todoCard('todo-goods', '③ 货款未收', data.goodsUnpaid.length, goods)}
      ${todoCard('todo-backlog', '④ 仓库还没整理', backlog.length, backlogHtml)}
      ${todoCard('todo-boxes', '⑤ 拼邮箱还没发出', boxes.length, boxHtml)}
      ${refunds}
    </div>
    ${legacy.length ? `<details class="legacy-zone"><summary>旧流程（称重分摊 / 国内寄出）还有 ${legacy.length} 类没清</summary>${legacy.join('')}</details>` : ''}`;

  // KPI 卡点一下滚到对应清单
  const go = new URLSearchParams(location.hash.split('?')[1] || '').get('go');
  if (go) view.querySelector(`#${CSS.escape(go)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  bindActions(view, {
    release: async ({ batch, customer, name }) => {
      const r = await api.post('/api/admin/quick-order/release', { batchId: Number(batch), customerId: Number(customer) });
      toast(`放行了 ${r.count} 件，${name} 现在看得到了`);
      render(view);
    },
    payGoods: async ({ customer, batch, name }) => {
      await api.post('/api/admin/payments/batch-customer', { customerId: Number(customer), batchId: Number(batch), paid: true });
      toast(`${name || ''} 货款已记，东西已放进他的仓库`);
      render(view);
    },
    payIntl: async ({ customer, group }) => {
      if (!(await confirmBox('确认这一摞的国际运费已经收到？'))) return;
      await api.post('/api/admin/payments', {
        customerId: Number(customer),
        kind: 'intl',
        weighGroupId: Number(group),
      });
      toast('已记账');
      render(view);
    },
    payDomestic: async ({ customer, shipment }) => {
      if (!(await confirmBox('确认这次寄出的运费已经收到？'))) return;
      await api.post('/api/admin/payments', {
        customerId: Number(customer),
        kind: 'domestic',
        shipmentId: Number(shipment),
      });
      toast('已记账');
      render(view);
    },
    refunded: async ({ item }) => {
      if (!(await confirmBox('确认已经把钱退给客户了？'))) return;
      await api.patch(`/api/admin/items/${item}`, { status: 'refunded' });
      toast('已标记退款');
      render(view);
    },
  });
}
