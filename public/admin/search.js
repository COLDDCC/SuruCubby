import { api } from '/admin/api.js';
import { escapeHtml, statusLabel, thumb } from '/admin/ui.js';
import { openItemDetail } from '/admin/itemDetail.js';

const rail = document.getElementById('rail');
const input = document.getElementById('rail-q');
const tip = document.getElementById('rail-tip');
const box = document.getElementById('rail-results');

const IDLE = '货号尾号、名称、cn、客户名、日本运单号都认';
let timer = 0;
let seq = 0;
let role = 'admin';

/** 管理员和日本仓都有找货；日本仓走 /api/staff，落点也换成日本仓自己能进的页面。 */
export function showSearch(show, who = 'admin') {
  rail.hidden = !show;
  role = who;
  tip.textContent = IDLE;
}

/**
 * 搜货号：一般只打尾号（8913 命中 ZHOTI678913），也认商品名片段和客户名。
 * 站在称重台 / 包裹页时先只搜这一箱 —— 一箱几十件，先按人筛比一行行下拉快。
 * 落点按这件东西现在在哪一步来：没分摊就在称重台，算过费了在包裹详情，没进包裹就在批次。
 * 已经不在这台秤上的（不拼邮、已寄出/已签收）就送到客户详情页，称重台里找不到他。
 */
function currentPackage() {
  const hit = location.hash.match(/^#\/(?:weigh|packages)\/(\d+)/);
  return hit ? hit[1] : null;
}

/** 日本仓的落点：没分拣 → 分拣页那一箱；在直邮包裹里 → 直邮页；在回国箱里 → 日本仓首页；已离开日本 → 弹详情。 */
function jpTarget(item) {
  const onJpSide = item.status === 'ordered' || item.status === 'jp_warehouse';
  if (item.parcelId) return { hash: `#/direct?item=${item.id}`, where: '直邮' };
  if (onJpSide && !item.sortedAt) {
    const tn = item.jpTrackingNo ? `tn=${encodeURIComponent(item.jpTrackingNo)}&` : '';
    return { hash: `#/sort/${item.batchId}?${tn}item=${item.id}`, where: '分拣' };
  }
  if (onJpSide) return { hash: `#/jp?item=${item.id}`, where: '回国箱' };
  return { detail: item.id, where: '已离开日本，点开看详情' };
}

function target(item) {
  if (role === 'jp') return jpTarget(item);
  if (item.selfReturn || item.status === 'shipped' || item.status === 'delivered') {
    return { hash: `#/customers/${item.customerId}`, where: '客户详情页' };
  }
  if (!item.packageId) return { hash: `#/batches/${item.batchId}?item=${item.id}`, where: '批次' };
  return item.allocatedAt
    ? { hash: `#/packages/${item.packageId}?item=${item.id}`, where: '包裹' }
    : { hash: `#/weigh/${item.packageId}?item=${item.id}`, where: '称重台' };
}

async function query(q, packageId) {
  const url =
    role === 'jp'
      ? `/api/staff/items/search?q=${encodeURIComponent(q)}`
      : `/api/admin/items/search?q=${encodeURIComponent(q)}${packageId ? `&packageId=${packageId}` : ''}`;
  return (await api.get(url)).items;
}

async function search() {
  const q = input.value.trim();
  const mine = ++seq;
  box.innerHTML = '';
  if (q.length < 2) {
    tip.textContent = IDLE;
    return;
  }
  const scoped = role === 'jp' ? null : currentPackage();
  tip.textContent = '查着…';
  let items;
  let inThisBox = true;
  try {
    items = scoped ? await query(q, scoped) : await query(q, null);
    if (scoped && items.length === 0) {
      items = await query(q, null);
      inThisBox = false;
    }
  } catch (err) {
    if (mine !== seq) return;
    tip.textContent = err.message || '搜索失败';
    return;
  }
  if (mine !== seq) return;
  if (!items.length) {
    tip.textContent = `没有货号、名称或客户名带「${q}」的商品`;
    return;
  }
  const head =
    scoped && inThisBox ? `这一箱里 ${items.length} 件对得上` : `${items.length} 件对得上，点一条就跳过去`;
  tip.textContent = head;
  box.innerHTML = items
    .map((i) => {
      const t = target(i);
      return `
      <a class="rail-item" href="${t.hash || '#'}"${t.detail ? ` data-rail-detail="${t.detail}"` : ''}>
        <span class="rail-thumb">${thumb(i)}</span>
        <span class="rail-text">
          <span class="rail-code">${escapeHtml(i.code || '这件没货号')}</span>
          <span class="small">${escapeHtml(i.cn && i.cn !== i.nickname ? `${i.cn}（${i.nickname}）` : i.nickname)} · ${escapeHtml(statusLabel(i.status))}${
            i.selfReturn ? ' · <b class="unpaid">不拼邮</b>' : i.route === 'direct' ? ' · 直邮' : ''
          }${i.missing ? ' · <b class="unpaid">缺件</b>' : ''}</span>
          <span class="small muted">${escapeHtml(i.packageName || i.batchName)} · ${t.detail ? t.where : `在${t.where}`}</span>
        </span>
      </a>`;
    })
    .join('');
}

input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(search, 250);
});

input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = box.querySelector('.rail-item');
  if (first) first.click();
});

box.addEventListener('click', (e) => {
  const detail = e.target.closest('[data-rail-detail]');
  if (detail) {
    e.preventDefault();
    openItemDetail(Number(detail.dataset.railDetail));
  }
  input.value = '';
  box.innerHTML = '';
  tip.textContent = IDLE;
});
