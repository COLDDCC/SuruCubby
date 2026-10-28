import { api } from '/admin/api.js';
import { beijingTime, bindActions, codeTag, confirmBox, escapeHtml, kgToGrams, promptBox, ROUTE_LABELS, toast } from '/admin/ui.js';
import { bindItemDetails } from '/admin/itemDetail.js';

/**
 * 日本仓：四件事分四栏——
 *   待分拣     日本的快递到了：按日本运单号（一个快递箱）进分拣页，铺在地上照卡片分堆，发送一次落定；
 *   回国箱     分拣时没填回国单号的箱子，在这里填单号发出；
 *   待打包直邮 分拣时客户还没地址的直邮件，等客户填了地址在这里打包；
 *   不拼邮     客户自己带回国 / 另找转运的件，签收后放一边，不进回国箱。
 * 手机上一次看一栏（顶上切换），电脑上几栏一起列。
 */
const TABS = [
  { key: 'inbound', label: '待分拣' },
  { key: 'boxes', label: '回国箱' },
  { key: 'direct', label: '待打包直邮' },
  { key: 'self', label: '不拼邮' },
];
let currentTab = null;

function cover(item) {
  return item.imageUrl
    ? `<img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'无图'}))">`
    : '<div class="noimg">无图</div>';
}

/** 每件下面的两个小按钮：没找到（标缺件）、签错了（退回未签收）。只给已签收、还没打包发出的件。 */
function fixButtons(item) {
  if (item.status !== 'jp_warehouse') return '';
  return `<span class="jp-fix">
    <button type="button" class="small plain" data-action="markMissing" data-item="${item.id}">没找到</button>
    <button type="button" class="small plain" data-action="unreceive" data-item="${item.id}">签错了</button>
  </span>`;
}

function itemRow(item, { pick = false, checked = false, route = true, fix = false } = {}) {
  return `<label class="jp-item${item.missing ? ' is-missing' : ''}" data-focus-item="${item.id}">
    <button type="button" class="small plain jp-info" data-detail="${item.id}">详情</button>
    ${pick ? `<input type="checkbox" data-pick="${item.id}" ${checked ? 'checked' : ''}>` : ''}
    <span class="jp-cover">${cover(item)}</span>
    <span class="jp-text">
      <span class="jp-title">${escapeHtml(item.title)}</span>
      <span class="small">${codeTag(item)} <b>${escapeHtml(item.nickname ?? '')}</b>
        ${route ? `<span class="badge ${item.route === 'direct' ? 'warn' : ''}">${ROUTE_LABELS[item.route] ?? ''}</span>` : ''}
        ${item.missing ? '<span class="badge danger">缺件</span>' : ''}
        ${item.selfReturn ? '<span class="badge danger">不拼邮 · 别装回国箱</span>' : ''}</span>
      ${item.selfReturn && item.packageId && item.status === 'jp_warehouse' ? `<span class="jp-fix"><button type="button" class="small danger" data-action="setAside" data-item="${item.id}">从箱里拿出来</button></span>` : ''}
      ${fix ? fixButtons(item) : ''}
    </span>
  </label>`;
}

/**
 * 一单分几个快递到：每个日本运单号一行，到没到一眼看清；先到的可以先点「到了」签收，晚点再分拣。
 */
function shipmentsHtml(b) {
  const list = b.jpShipments || [];
  const arrived = list.filter((s) => s.arrivedAt).length;
  const rows = list
    .map(
      (s) => `<div class="jp-ship ${s.arrivedAt ? 'is-arrived' : 'is-waiting'}">
        <span><b class="mono">${escapeHtml(s.trackingNo)}</b>
          ${s.itemCount ? `<span class="small muted">表里 ${s.itemCount} 件</span>` : ''}</span>
        <span class="small">${
          s.arrivedAt
            ? `<span class="paid">已到</span> <span class="muted">${escapeHtml(s.arrivedBy || '')} ${beijingTime(s.arrivedAt)}</span>`
            : '<span class="unpaid">还没到</span>'
        }</span>
        ${
          s.arrivedAt
            ? `<button type="button" class="small plain" data-action="unarrive" data-batch="${b.batchId}" data-tn="${escapeHtml(s.trackingNo)}">点错了</button>`
            : `<button type="button" class="small" data-action="arrive" data-batch="${b.batchId}" data-tn="${escapeHtml(s.trackingNo)}">到了</button>`
        }
      </div>`,
    )
    .join('');
  return `<div class="jp-ships">
    <div class="small muted">${list.length ? `日本快递 ${list.length} 个 · 到了 ${arrived} 个${list.length > arrived ? ` · <b class="unpaid">还差 ${list.length - arrived} 个</b>` : ''}` : '这一单还没登记日本快递单号'}
      <button type="button" class="small plain" data-action="addShipment" data-batch="${b.batchId}">补登单号</button></div>
    ${rows}
  </div>`;
}

function queueHtml(queue) {
  const batches = queue.batches;
  const recent = queue.sessions.length
    ? `<div class="card"><h3 style="margin-top:0">最近分拣</h3>${queue.sessions
        .slice(0, 8)
        .map(
          (s) => `<a class="recent-row" href="#/sort-result/${s.id}"><span>${beijingTime(s.createdAt)} · ${escapeHtml(s.createdBy)}</span>
            <span class="small muted">${s.jpTrackingNo ? `运单 ${escapeHtml(s.jpTrackingNo)} · ` : ''}${s.itemCount} 件 · ${s.boxCount} 箱 · ${s.parcelCount} 包直邮${s.missingCount ? ` · 缺 ${s.missingCount}` : ''}</span></a>`,
        )
        .join('')}</div>`
    : '';
  if (!batches.length) return `<div class="card"><p class="empty">没有要分拣的货，日本那边的都分完了。</p></div>${recent}`;
  return (
    batches
      .map(
        (b) => `<div class="card">
        <h3 style="margin:0">${escapeHtml(b.name)}</h3>
        <p class="small muted" style="margin:4px 0 8px">日本订单 <b>${escapeHtml(b.orderNo || '—')}</b> · 下单 ${escapeHtml(b.orderedAt || '—')} · 还有 ${b.total} 件没分${
          b.missing ? ` · <span class="unpaid">${b.missing} 件上次没找到</span>` : ''
        }</p>
        ${shipmentsHtml(b)}
        ${b.boxes
          .map(
            (x) => `<a class="queue-row" href="#/sort/${b.batchId}?tn=${encodeURIComponent(x.trackingNo)}">
              <span><span class="small muted">日本运单</span> <b class="mono">${escapeHtml(x.trackingNo)}</b></span>
              <span class="small">${x.count} 件${x.found ? ` · 已点 ${x.found}` : ''}${b.untracked ? ` <span class="muted">+ 没写运单号的 ${b.untracked}</span>` : ''}</span>
              <span class="btn small">分拣这一箱 →</span></a>
            <a class="small queue-print" href="#/print/sort/${b.batchId}?tn=${encodeURIComponent(x.trackingNo)}">打印这一箱的分拣单</a>`,
          )
          .join('')}
        ${
          b.untracked && !b.boxes.length
            ? `<a class="queue-row" href="#/sort/${b.batchId}">
                <span>表里没写日本运单号${b.japanTrackingNo ? `（订单上的单号 <b class="mono">${escapeHtml(b.japanTrackingNo)}</b>）` : ''}</span>
                <span class="small">${b.untracked} 件${b.untrackedFound ? ` · 已点 ${b.untrackedFound}` : ''}</span>
                <span class="btn small">开箱分拣 →</span></a>`
            : ''
        }
        ${
          b.untracked && b.boxes.length
            ? `<p class="small muted" style="margin:6px 0 0">没写运单号的 ${b.untracked} 件会出现在每一箱的分拣页里，哪箱里找到就算哪箱。</p>`
            : ''
        }
      </div>`,
      )
      .join('') + recent
  );
}

function boxesHtml(list) {
  if (!list.length) return '<div class="card"><p class="empty">没有开着的回国箱。拼团的件导入后会自动放进这一批的箱子。</p></div>';
  return list
    .map((b) => {
      const ready = !b.waiting && b.received > 0;
      return `<div class="card" data-box="${b.id}">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">${escapeHtml(b.name)}</h3>
          <span class="small">已签收 <b>${b.received}</b> · 未签收 <b class="${b.waiting ? 'unpaid' : ''}">${b.waiting}</b>
            · <a href="#/print/box/${b.id}">打印装箱单</a></span>
        </div>
        <details ${b.items.length <= 12 ? 'open' : ''}><summary>箱里 ${b.items.length} 件</summary>
          <div class="jp-list">${b.items
            .map((i) => itemRow({ ...i, title: `${i.status === 'ordered' ? '【未签收】' : ''}${i.title}` }, { route: false, fix: true }))
            .join('')}</div>
        </details>
        <div class="row ship-row">
          <input data-box-tracking="${b.id}" placeholder="回国单号" value="${escapeHtml(b.trackingNo || '')}" ${ready ? '' : 'disabled'}>
          <input class="box-num" data-box-kg="${b.id}" inputmode="decimal" placeholder="整箱 kg" value="${b.jpWeightG ? (b.jpWeightG / 1000).toString() : ''}" ${ready ? '' : 'disabled'}>
          <input class="box-num" data-box-cartons="${b.id}" inputmode="numeric" placeholder="几箱" value="${b.cartonCount || ''}" ${ready ? '' : 'disabled'}>
          <button data-action="shipBox" data-box="${b.id}" ${ready ? '' : 'disabled'}>封箱发出</button>
        </div>
        <p class="small muted" style="margin:4px 0 0">整箱重量（毛重）和箱数国内对账用：一个回国单号几箱一起走就填几箱。</p>
        ${b.waiting ? `<p class="small muted">还有 ${b.waiting} 件没签收，签收齐了才能发出；真没到的告诉管理员处理。</p>` : ''}
      </div>`;
    })
    .join('');
}

function shippedHtml(list) {
  if (!list.length) return '';
  return `<div class="card"><h3 style="margin-top:0">已发出、国内还没称的箱子</h3>
    <p class="small muted" style="margin-top:0">发出后才称的整箱重量、箱数在这里补；国内称重分摊之后就改不了了。</p>
    ${list
      .map(
        (b) => `<div class="list-row">
          <div class="main">${escapeHtml(b.name)} <span class="small muted">${b.itemCount} 件</span>
            <div class="small">回国单号 <b class="mono">${escapeHtml(b.trackingNo || '—')}</b> · ${
              b.jpWeightG ? `整箱 ${(b.jpWeightG / 1000).toFixed(2)} kg` : '<span class="unpaid">重量没填</span>'
            } · ${b.cartonCount ? `${b.cartonCount} 箱` : '<span class="unpaid">箱数没填</span>'}</div></div>
          <div class="side"><button class="small plain" data-action="boxInfo" data-box="${b.id}"
            data-kg="${b.jpWeightG ? b.jpWeightG / 1000 : ''}" data-cartons="${b.cartonCount || ''}" data-tn="${escapeHtml(b.trackingNo || '')}">补填 / 改</button>
            <a class="small" href="#/print/box/${b.id}">装箱单</a></div>
        </div>`,
      )
      .join('')}</div>`;
}

function selfHtml(list) {
  if (!list.length) {
    return '<div class="card"><p class="empty">没有放在一边等自己来拿的件。标了「不拼邮」的客户的东西签收后会出现在这里，不进回国箱、不打直邮包。</p></div>';
  }
  return list
    .map(
      (g) => `<div class="card">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">${escapeHtml(g.nickname)} <span class="small muted">${g.items.length} 件</span></h3>
          <span class="badge danger">自己带回国 / 另找转运</span>
        </div>
        <p class="small muted" style="margin:4px 0 0">单独放一边，别装进回国箱。交给他之后告诉管理员，在客户页标「已当面给他」。</p>
        <div class="jp-list">${g.items.map((i) => itemRow({ ...i, selfReturn: false }, { route: false, fix: true })).join('')}</div>
      </div>`,
    )
    .join('');
}

function directHtml(list) {
  if (!list.length) {
    return '<div class="card"><p class="empty">没有待打包的直邮件。打好的包裹在 <a href="#/direct">直邮</a> 页收款、寄出。</p></div>';
  }
  return list
    .map(
      (g) => `<div class="card" data-customer="${g.customerId}">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">${escapeHtml(g.nickname)} <span class="small muted">${g.items.length} 件</span></h3>
          <a class="small" href="#/print/direct?customer=${g.customerId}">打印打包单</a>
        </div>
        ${
          g.address
            ? `<div class="jp-addr"><span class="small muted">${g.addressSource === 'import' ? '寄到（导入表）' : '寄到（客户选的）'}</span>
                <div>${escapeHtml(g.address)} <button type="button" class="small plain" data-copy="${escapeHtml(g.address)}">复制</button></div></div>`
            : `<p class="small unpaid">${escapeHtml(g.addressProblem || '还没有地址')}</p>`
        }
        <div class="jp-list">${g.items.map((i) => itemRow(i, { pick: true, checked: true, route: false, fix: true })).join('')}</div>
        ${
          g.addressReady
            ? `<div class="row ship-row">
                <input data-weight="${g.customerId}" inputmode="numeric" placeholder="重量（克，可以先空着）">
                <button data-action="pack" data-customer="${g.customerId}">把勾上的打成一包</button>
              </div>`
            : '<p class="small muted">请客户在自己的页面上填一个收货地址（只存一个就自动用它），这里就能打包了。</p>'
        }
      </div>`,
    )
    .join('');
}

export async function render(view) {
  const [data, queue] = await Promise.all([api.get('/api/staff/jp/overview'), api.get('/api/staff/sort/queue')]);
  const counts = {
    inbound: queue.batches.reduce((n, b) => n + b.total, 0),
    boxes: data.boxes.length,
    direct: data.direct.reduce((n, g) => n + g.items.length, 0),
    self: (data.selfReturn || []).reduce((n, g) => n + g.items.length, 0),
  };
  if (!currentTab) currentTab = TABS.find((t) => counts[t.key])?.key ?? 'inbound';

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">日本仓</h2>
        <a class="small" href="#/direct">直邮包裹 →</a>
      </div>
      <div class="seg" role="tablist">
        ${TABS.map(
          (t) => `<button role="tab" class="${t.key === currentTab ? 'active' : ''}" data-tab="${t.key}">${t.label}
            <span class="seg-count">${counts[t.key]}</span></button>`,
        ).join('')}
      </div>
    </div>
    <div class="jp-cols">
      <section class="jp-col" data-col="inbound"><h3 class="col-title">待分拣</h3>${queueHtml(queue)}</section>
      <section class="jp-col" data-col="boxes"><h3 class="col-title">回国箱</h3>${boxesHtml(data.boxes)}${shippedHtml(data.shippedBoxes || [])}</section>
      <section class="jp-col" data-col="direct"><h3 class="col-title">待打包直邮</h3>${directHtml(data.direct)}</section>
      <section class="jp-col" data-col="self"><h3 class="col-title">不拼邮（放一边）</h3>${selfHtml(data.selfReturn || [])}</section>
    </div>`;

  const applyTab = () => {
    view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
    view.querySelectorAll('[data-col]').forEach((s) => s.classList.toggle('is-current', s.dataset.col === currentTab));
  };
  view.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      currentTab = b.dataset.tab;
      applyTab();
    };
  });
  applyTab();

  view.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async (e) => {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('已复制');
      } catch {
        toast('复制不了，长按单号手动复制', true);
      }
    };
  });

  bindItemDetails(view);

  const picked = (root) => [...root.querySelectorAll('[data-pick]:checked')].map((el) => Number(el.dataset.pick));

  bindActions(view, {
    async arrive({ batch, tn }) {
      const r = await api.post('/api/staff/jp/shipments/arrive', { batchId: Number(batch), trackingNo: tn });
      toast(r.received ? `签收了，表里写着这个单号的 ${r.received} 件变成「已到日本仓」` : '记上了：这个快递已到');
      await render(view);
    },
    async unarrive({ batch, tn }) {
      if (!(await confirmBox(`撤销「${tn} 已到」？表里写着这个单号、还没分拣的件退回「已下单」。`, { okText: '撤销' }))) return;
      await api.post('/api/staff/jp/shipments/unarrive', { batchId: Number(batch), trackingNo: tn });
      toast('已撤销');
      await render(view);
    },
    async addShipment({ batch }) {
      const tn = await promptBox('补登一个日本运单号（骏河屋发货通知里的）');
      if (!tn) return;
      await api.post('/api/staff/jp/shipments', { batchId: Number(batch), trackingNo: tn });
      toast('登记好了');
      await render(view);
    },
    async boxInfo({ box, kg, cartons, tn }) {
      const trackingNo = await promptBox('回国单号', tn || '');
      if (trackingNo === null) return;
      const weight = await promptBox('整箱重量（kg，毛重）', kg || '', { type: 'text' });
      if (weight === null) return;
      const count = await promptBox('这个回国单号下一共几箱', cartons || '1');
      if (count === null) return;
      await api.post(`/api/staff/jp/boxes/${box}/info`, {
        trackingNo,
        weightG: kgToGrams(weight),
        cartons: count === '' ? null : Number(count),
      });
      toast('记上了');
      await render(view);
    },
    async setAside({ item }) {
      await api.post('/api/staff/jp/set-aside', { itemIds: [Number(item)] });
      toast('拿出来了，在「不拼邮」那一栏');
      await render(view);
    },
    async markMissing({ item }) {
      if (!(await confirmBox('这件在仓库里找不到？标成缺件后它退回「未签收」、从箱子里拿出来，管理员会看到；下一个快递到了还会出现在分拣页里。', { okText: '标缺件', danger: true }))) return;
      await api.post('/api/staff/jp/unreceive', { itemIds: [Number(item)], missing: true });
      toast('已标缺件，管理员那边看得到');
      await render(view);
    },
    async unreceive({ item }) {
      if (!(await confirmBox('签错了，退回「未签收」？这件会从箱子里拿出来，等它真到了再在分拣页点。', { okText: '退回' }))) return;
      await api.post('/api/staff/jp/unreceive', { itemIds: [Number(item)] });
      toast('已退回未签收');
      await render(view);
    },
    async shipBox({ box }) {
      const trackingNo = view.querySelector(`[data-box-tracking="${box}"]`).value.trim();
      if (!trackingNo) return toast('先填回国单号', true);
      const weightG = kgToGrams(view.querySelector(`[data-box-kg="${box}"]`).value);
      const cartons = view.querySelector(`[data-box-cartons="${box}"]`).value.trim() || 1;
      if (!weightG && !(await confirmBox('整箱重量还没填，国内对账会少一个依据。先不填直接发出？（发出后还能在这里补）', { okText: '先发出' }))) return;
      if (!(await confirmBox(`封箱发出，回国单号 ${trackingNo}${weightG ? `，整箱 ${(weightG / 1000).toFixed(2)} kg` : ''}，${cartons} 箱？箱里的件会变成「回国中」，客户页面能看到这个单号。`, { okText: '发出' }))) return;
      const r = await api.post(`/api/staff/jp/boxes/${box}/ship`, { trackingNo, weightG, cartons: Number(cartons) });
      toast(`已发出，${r.count} 件变成回国中`);
      await render(view);
    },
    async pack({ customer }) {
      const card = view.querySelector(`[data-customer="${customer}"]`);
      const ids = picked(card);
      if (!ids.length) return toast('先勾上要装进这一包的件', true);
      const weight = card.querySelector(`[data-weight="${customer}"]`).value.trim();
      const r = await api.post('/api/staff/direct/parcels', {
        customerId: Number(customer),
        itemIds: ids,
        weightG: weight === '' ? undefined : Number(weight),
      });
      toast(r.status === 'packing' ? `打好了包裹 #${r.id}，称完重在直邮页填重量` : `打好了包裹 #${r.id}，等客户付运费`);
      await render(view);
    },
  });
}
