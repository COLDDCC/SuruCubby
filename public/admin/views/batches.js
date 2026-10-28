import { api } from '/admin/api.js';
import { beijingTime, empty, escapeHtml, statusLabel, yen } from '/admin/ui.js';

/**
 * 订单总览：群主录过的每一个日本订单（一张 Excel = 一单）都在这里。
 * 一行看清：单号填没填、几个人几件、走到哪一步、钱收齐没有、装进了哪个包裹。
 * 搜索和筛选都在本地做，订单量再大也就几百行，不必每敲一个字打一次后端。
 */

// 状态从早到晚排，进度条和徽章都按这个顺序
const STAGES = [
  { key: 'ordered', cls: '' },
  { key: 'jp_warehouse', cls: '' },
  { key: 'intl_transit', cls: 'warn', merge: ['intl_transit', 'cn_arrived'] },
  { key: 'cn_stock', cls: 'ok' },
  { key: 'shipped', cls: '' },
  { key: 'delivered', cls: '' },
  { key: 'cancelled', cls: 'danger' },
  { key: 'refunded', cls: 'danger' },
];
const DONE = new Set(['delivered', 'cancelled', 'refunded']);

const FILTERS = [
  { key: 'all', label: '全部', test: () => true },
  { key: 'active', label: '进行中', test: (b) => !isDone(b) },
  { key: 'done', label: '已完结', test: isDone },
  { key: 'unpaid', label: '货款没收齐', test: (b) => b.unpaidJpy > 0 },
  { key: 'noNo', label: '单号没填', test: (b) => !b.orderNo || !b.japanTrackingNo },
];

const STORE_KEY = 'orders.filter';

function loadFilter() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    return FILTERS.some((f) => f.key === saved) ? saved : 'all';
  } catch {
    return 'all';
  }
}
function saveFilter(key) {
  try {
    localStorage.setItem(STORE_KEY, key);
  } catch {
    /* 隐私模式等存不了就算了，只是下次不记得筛选 */
  }
}

function isDone(b) {
  if (!b.itemCount) return false;
  return Object.entries(b.statusCounts).every(([status, n]) => !n || DONE.has(status));
}

function stageCounts(b) {
  return STAGES.map((s) => ({
    ...s,
    count: (s.merge ?? [s.key]).reduce((sum, k) => sum + (b.statusCounts[k] || 0), 0),
  })).filter((s) => s.count > 0);
}

function searchText(b) {
  return [b.name, b.orderNo, b.japanTrackingNo, b.sourceFile, ...b.customers, ...b.packages.map((p) => p.name)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function orderRow(b) {
  const stages = stageCounts(b);
  const bar = b.itemCount
    ? `<div class="order-bar" title="${stages.map((s) => `${statusLabel(s.key)} ${s.count}`).join(' · ')}">${stages
        .map((s) => `<span class="seg ${s.cls}" style="flex:${s.count}"></span>`)
        .join('')}</div>`
    : '';
  const badges = stages
    .map((s) => `<span class="badge ${s.cls}">${escapeHtml(statusLabel(s.key))} ${s.count}</span>`)
    .join(' ');
  const people =
    b.customers.length > 4
      ? `${b.customers.slice(0, 4).map(escapeHtml).join('、')} 等 ${b.customers.length} 人`
      : b.customers.map(escapeHtml).join('、');
  const pkgs = b.packages.length
    ? b.packages
        .map(
          (p) =>
            `<a href="#/packages/${p.id}">${escapeHtml(p.name)}</a>${p.trackingNo ? ` <span class="muted">${escapeHtml(p.trackingNo)}</span>` : ''}`,
        )
        .join('、')
    : '<span class="muted">无</span>';

  return `<div class="order-row">
    <div class="order-head">
      <div class="order-title">
        <a href="#/batches/${b.id}"><b>${escapeHtml(b.name)}</b></a>
        ${isDone(b) ? '<span class="badge ok">已完结</span>' : ''}
        ${b.missingCount ? `<span class="badge danger">缺件 ${b.missingCount}</span>` : ''}
      </div>
      <div class="order-money">
        <div class="money">${yen(b.amountJpy)}</div>
        <div class="small money ${b.unpaidJpy ? 'unpaid' : 'paid'}">${b.unpaidJpy ? `未收 ${yen(b.unpaidJpy)}` : '已收齐'}</div>
      </div>
    </div>
    <div class="small">
      日本订单 ${b.orderNo ? `<b>${escapeHtml(b.orderNo)}</b>` : '<span class="unpaid">待填</span>'}
      · 日本单号 ${b.japanTrackingNo ? `<b>${escapeHtml(b.japanTrackingNo)}</b>` : '<span class="unpaid">待填</span>'}
    </div>
    <div class="small muted">
      ${b.orderedAt ? `下单 ${escapeHtml(b.orderedAt)} · ` : ''}录入 ${beijingTime(b.createdAt)}
      · ${b.customerCount} 人 ${b.itemCount} 件${people ? `：${people}` : ''}
    </div>
    ${bar}
    <div class="order-foot small">
      <div>${badges || '<span class="muted">这单没有商品</span>'}</div>
      <div>包裹：${pkgs}</div>
    </div>
  </div>`;
}

export async function render(view) {
  const data = await api.get('/api/admin/batches');
  const orders = data.batches.map((b) => ({ ...b, _q: searchText(b) }));
  let filter = loadFilter();
  let query = '';

  const totals = {
    items: orders.reduce((s, b) => s + b.itemCount, 0),
    amount: orders.reduce((s, b) => s + b.amountJpy, 0),
    unpaid: orders.reduce((s, b) => s + b.unpaidJpy, 0),
    active: orders.filter((b) => !isDone(b)).length,
  };

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">我的订单</h2>
        <a class="btn small" href="#/import">录入新订单</a>
      </div>
      <p class="small muted" style="margin:6px 0 0">
        共 ${orders.length} 单 · ${totals.active} 单进行中 · ${totals.items} 件 · 货款 ${yen(totals.amount)}
        ${totals.unpaid ? ` · <span class="unpaid">未收 ${yen(totals.unpaid)}</span>` : ''}
      </p>
      ${
        orders.length
          ? `<input id="order-q" inputmode="search" autocomplete="off" style="width:100%;margin-top:12px"
               placeholder="搜日本订单号 / 物流单号 / 订单名 / 客户名 / 包裹名">
             <div class="order-filters" id="order-filters"></div>
             <div id="order-list"></div>`
          : empty('还没有订单，先去录入一张 Excel')
      }
    </div>`;
  if (!orders.length) return;

  const listEl = view.querySelector('#order-list');
  const filtersEl = view.querySelector('#order-filters');
  const input = view.querySelector('#order-q');

  const draw = () => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = orders.filter((b) => words.every((w) => b._q.includes(w)));
    filtersEl.innerHTML = FILTERS.map((f) => {
      const n = matched.filter(f.test).length;
      return `<button class="small ${f.key === filter ? '' : 'plain'}" data-filter="${f.key}">${f.label} ${n}</button>`;
    }).join('');
    const shown = matched.filter(FILTERS.find((f) => f.key === filter).test);
    listEl.innerHTML = shown.length ? shown.map(orderRow).join('') : empty('没有符合条件的订单');
  };

  filtersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    filter = btn.dataset.filter;
    saveFilter(filter);
    draw();
  });
  input.addEventListener('input', () => {
    query = input.value;
    draw();
  });
  draw();
}
