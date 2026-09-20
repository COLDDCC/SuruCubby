import { beijingTime, escapeHtml, jpy, money, statusLabel, thumb, toast } from '/shared.js';

const token = decodeURIComponent(location.pathname.replace(/^\/w\//, '').replace(/\/$/, ''));
const app = document.getElementById('app');

const GROUPS = [
  { title: '在日本', statuses: ['ordered', 'jp_warehouse'], note: '' },
  { title: '运输中', statuses: ['intl_transit', 'cn_arrived'], note: '' },
  {
    title: '国内在库，等你发货',
    statuses: ['cn_stock'],
    note: '攒够了在群里说一声，每次寄出 10 元（全国包邮）。',
  },
  { title: '已寄出 / 已签收', statuses: ['shipped', 'delivered'], note: '' },
];

async function api(path, options) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 忽略非 JSON 响应 */
  }
  return { ok: res.ok, status: res.status, data };
}

function renderVerify(message) {
  app.innerHTML = `
    <div class="card">
      <h1>我的仓库</h1>
      <p class="muted">第一次打开请输入你的 QQ 号，确认是本人。之后 180 天内不用再输。</p>
      <label for="qq">QQ 号</label>
      <div class="row">
        <input id="qq" inputmode="numeric" autocomplete="off" placeholder="例如 123456789">
        <button id="go">进入</button>
      </div>
      <p id="err" class="unpaid small">${message ? escapeHtml(message) : ''}</p>
    </div>`;
  const input = document.getElementById('qq');
  const button = document.getElementById('go');
  const err = document.getElementById('err');
  const submit = async () => {
    button.disabled = true;
    const { ok, data } = await api(`/api/w/${encodeURIComponent(token)}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qq: input.value.trim() }),
    });
    button.disabled = false;
    if (!ok) {
      err.textContent = data.error || '验证失败';
      return;
    }
    render(data);
  };
  button.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
  };
  input.focus();
}

function itemCard(item) {
  const paid = item.goodsPaid
    ? '<span class="badge ok">货款已付</span>'
    : '<span class="badge danger">货款未付</span>';
  const title = item.productUrl
    ? `<a href="${escapeHtml(item.productUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>`
    : escapeHtml(item.title);
  const note = item.exceptionNote
    ? `<div class="small" style="color:var(--warn)">${escapeHtml(item.exceptionNote)}</div>`
    : '';
  return `
    <div class="item">
      ${thumb(item)}
      <div class="body">
        <div class="title">${title}</div>
        <div class="small muted">
          实际价格 ${jpy(item.actualPriceJpy)} ·
          应付 <span class="money">${money(item.goodsFeeFen)}</span>
        </div>
        <div class="small row" style="gap:6px;margin-top:4px">
          <span class="badge">${escapeHtml(statusLabel(item.status))}</span>${paid}
        </div>
        ${note}
      </div>
    </div>`;
}

function render(data) {
  const s = data.summary;
  const items = data.items || [];
  const shownStatuses = new Set(GROUPS.flatMap((g) => g.statuses));
  const closed = items.filter((i) => !shownStatuses.has(i.status));

  const groupsHtml = GROUPS.map((group) => {
    const list = items.filter((i) => group.statuses.includes(i.status));
    if (list.length === 0) return '';
    return `
      <div class="card">
        <h2>${group.title}<span class="muted small"> · ${list.length} 件</span></h2>
        ${group.note ? `<p class="small muted">${group.note}</p>` : ''}
        ${list.map(itemCard).join('')}
      </div>`;
  }).join('');

  const intlHtml = (data.weighGroups || []).length
    ? `<div class="card">
        <h2>国际运费</h2>
        ${data.weighGroups
          .map(
            (g) => `
          <div class="item" style="display:block">
            <div class="row" style="justify-content:space-between">
              <strong>${escapeHtml(g.packageName)}</strong>
              <span class="${g.feePaid ? 'paid' : 'unpaid'} money">
                ${money(g.intlFeeFen)} ${g.feePaid ? '已付' : '未付'}
              </span>
            </div>
            <div class="small muted">你这一摞 ${Number(g.weightG || 0).toLocaleString()} g，共 ${g.items.length} 件</div>
            <details class="small"><summary>看看是哪些东西</summary>
              <ul>${g.items.map((i) => `<li>${escapeHtml(i.title)}</li>`).join('')}</ul>
            </details>
          </div>`,
          )
          .join('')}
       </div>`
    : '';

  const shipHtml = (data.shipments || []).length
    ? `<div class="card">
        <h2>寄出记录</h2>
        ${data.shipments
          .map(
            (s2) => `
          <div class="item" style="display:block">
            <div class="row" style="justify-content:space-between">
              <strong>${s2.trackingNo ? escapeHtml(s2.trackingNo) : '单号待填'}</strong>
              <span class="${s2.feePaid ? 'paid' : 'unpaid'} money">${money(s2.feeFen)} ${s2.feePaid ? '已付' : '未付'}</span>
            </div>
            <div class="small muted">${s2.items.length} 件 · ${beijingTime(s2.shippedAt || s2.createdAt)}</div>
            <details class="small"><summary>看看寄了哪些</summary>
              <ul>${s2.items.map((i) => `<li>${escapeHtml(i.title)}</li>`).join('')}</ul>
            </details>
          </div>`,
          )
          .join('')}
       </div>`
    : '';

  const closedHtml = closed.length
    ? `<div class="card">
        <details><summary>已取消 / 已退款（${closed.length} 件）</summary>
        ${closed.map(itemCard).join('')}
        </details>
       </div>`
    : '';

  const timelineHtml = (data.timeline || []).length
    ? `<div class="card">
        <h2>最近动态</h2>
        <table><tbody>
        ${data.timeline
          .map(
            (t) => `<tr>
              <td class="small muted" style="white-space:nowrap">${beijingTime(t.at)}</td>
              <td class="small">${escapeHtml(t.title)}</td>
              <td class="small">${escapeHtml(statusLabel(t.toStatus))}</td>
            </tr>`,
          )
          .join('')}
        </tbody></table>
       </div>`
    : '';

  app.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h1 style="margin:0">${escapeHtml(data.customer.nickname)} 的仓库</h1>
        <span class="muted small">${items.length} 件</span>
      </div>
      <div class="grid" style="margin-top:12px">
        <div class="stat"><div class="label">货款待付</div><div class="value money">${money(s.goodsUnpaidFen)}</div></div>
        <div class="stat"><div class="label">国际运费待付</div><div class="value money">${money(s.intlUnpaidFen)}</div></div>
        <div class="stat"><div class="label">国内运费待付</div><div class="value money">${money(s.domesticUnpaidFen)}</div></div>
        <div class="stat big"><div class="label">合计待付</div><div class="value money">${money(s.totalUnpaidFen)}</div></div>
      </div>
      <p class="small muted" style="margin-bottom:0">国内在库 ${s.stockCount} 件，随时可以要求发货。</p>
    </div>
    ${groupsHtml}
    ${intlHtml}
    ${shipHtml}
    ${closedHtml}
    ${timelineHtml}
    <p class="small muted">金额有疑问就在群里问一声。页面数据实时更新。</p>`;
}

async function boot() {
  if (!token) {
    app.innerHTML = '<div class="card"><p class="unpaid">链接不完整，请找需求方要一份新的。</p></div>';
    return;
  }
  const { ok, status, data } = await api(`/api/w/${encodeURIComponent(token)}`);
  if (ok && data.verified) {
    render(data);
    return;
  }
  if (status === 401) {
    renderVerify('');
    return;
  }
  toast(data.error || '打不开，稍后再试', true);
  renderVerify(data.error || '');
}

boot();
