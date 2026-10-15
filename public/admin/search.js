import { api } from '/admin/api.js';
import { escapeHtml, statusLabel, thumb } from '/admin/ui.js';

const rail = document.getElementById('rail');
const input = document.getElementById('rail-q');
const tip = document.getElementById('rail-tip');
const box = document.getElementById('rail-results');

const IDLE = '货号尾号、名称片段、客户名都认';
let timer = 0;
let seq = 0;

export function showSearch(show) {
  rail.hidden = !show;
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

function target(item) {
  if (item.selfReturn || item.status === 'shipped' || item.status === 'delivered') {
    return { hash: `#/customers/${item.customerId}`, where: '客户详情页' };
  }
  if (!item.packageId) return { hash: `#/batches/${item.batchId}?item=${item.id}`, where: '批次' };
  return item.allocatedAt
    ? { hash: `#/packages/${item.packageId}?item=${item.id}`, where: '包裹' }
    : { hash: `#/weigh/${item.packageId}?item=${item.id}`, where: '称重台' };
}

async function query(q, packageId) {
  const url = `/api/admin/items/search?q=${encodeURIComponent(q)}${packageId ? `&packageId=${packageId}` : ''}`;
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
  const scoped = currentPackage();
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
      <a class="rail-item" href="${t.hash}">
        <span class="rail-thumb">${thumb(i)}</span>
        <span class="rail-text">
          <span class="rail-code">${escapeHtml(i.code || '这件没货号')}</span>
          <span class="small">${escapeHtml(i.nickname)} · ${escapeHtml(statusLabel(i.status))}</span>
          <span class="small muted">${escapeHtml(i.packageName || i.batchName)} · 在${t.where}</span>
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

box.addEventListener('click', () => {
  input.value = '';
  box.innerHTML = '';
  tip.textContent = IDLE;
});
