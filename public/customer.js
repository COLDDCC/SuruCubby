import { beijingTime, escapeHtml, jpy, money, statusLabel, thumb, toast, yen } from '/shared.js';

const token = decodeURIComponent(location.pathname.replace(/^\/w\//, '').replace(/\/$/, ''));
const app = document.getElementById('app');

const GROUPS = [
  { title: '在日本', statuses: ['ordered', 'jp_warehouse'], note: '' },
  { title: '运输中', statuses: ['intl_transit', 'cn_arrived'], note: '' },
  {
    title: '可发货',
    statuses: ['cn_stock'],
    note: '勾选要寄的商品，选择地址后提交申请。扫码转账后由群主确认。',
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
      ${item.status==='cn_stock' ? `<label><input type="checkbox" data-ship-item="${item.id}" ${item.requestId ? 'disabled' : ''}>${item.requestId ? '已申请' : '发货'}</label>` : ''}
      ${thumb(item)}
      <div class="body">
        <div class="title">${title}</div>
        <div class="small muted">
          实际价格 ${jpy(item.actualPriceJpy)} ·
          应付 <span class="money">${yen(item.goodsFeeJpy)}</span>
        </div>
        <div class="small row" style="gap:6px;margin-top:4px">
          <span class="badge ${item.status==='cn_stock' ? 'ok' : ''}">${escapeHtml(statusLabel(item.status))}</span>${paid}
        </div>
        ${item.returnTrackingNo ? `<div class="small">回国单号：<span>${escapeHtml(item.returnTrackingNo)}</span> <button class="small plain" data-copy="${escapeHtml(item.returnTrackingNo)}">复制</button></div>` : ''}
        ${item.orderNo ? `<div class="small muted">日本订单：${escapeHtml(item.orderNo)}</div>` : ''}
        ${item.weightG ? `<div class="small muted">${item.weightG} g · 国际运费 ${money(item.intlFeeFen)} ${item.intlPaid ? '已付' : '待付'}</div>` : ''}
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
                ${money(g.intlFeeFen)} ${g.feePaid ? '已付' : `待付 ${money(items.filter(i=>i.weighGroupId===g.id && !i.intlPaid && i.status!=='cancelled' && i.status!=='refunded').some(i=>i.intlFeeFen!==null) ? items.filter(i=>i.weighGroupId===g.id && !i.intlPaid && i.status!=='cancelled' && i.status!=='refunded').reduce((s,i)=>s+(i.intlFeeFen??0),0) : g.intlFeeFen)}`}
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
        <div class="stat"><div class="label">货款待付（日元）</div><div class="value money">${yen(s.goodsUnpaidJpy)}</div></div>
        <div class="stat"><div class="label">国际运费待付</div><div class="value money">${money(s.intlUnpaidFen)}</div></div>
        <div class="stat"><div class="label">国内运费待付</div><div class="value money">${money(s.domesticUnpaidFen)}</div></div>
        <div class="stat big"><div class="label">运费待付</div><div class="value money">${money(s.freightUnpaidFen)}</div></div>
      </div>
      <p class="small muted" style="margin-bottom:0">货款是日元，转账当天按汇率折成人民币给群主；运费是人民币。可发货 ${s.stockCount} 件，随时可以要求发货。</p>
    </div>
    <div class="card"><h2>收货地址（最多3个）</h2>
      ${(data.addresses||[]).map(a=>`<label class="row"><input name="ship-address" type="radio" value="${a.id}"><span>${escapeHtml(a.recipient)} · ${escapeHtml(a.phone)} · ${escapeHtml(a.detail)}</span><button class="small plain" data-delete-address="${a.id}">删除</button></label>`).join('')}
      ${(data.addresses||[]).length<3 ? '<label>收件人</label><input id="recipient"><label>电话</label><input id="phone"><label>详细地址</label><input id="detail"><p><button id="add-address">保存地址</button></p>' : ''}
      <p id="shipping-total" class="small"></p><button id="request-shipping">提交发货申请</button>
    </div>
    ${(data.requests||[]).length ? `<div class="card"><h2>发货申请</h2>${data.requests.map(r=>`<p>申请 #${r.id} · ${escapeHtml({pending:'待确认收款',paid:'已收款，待寄出',shipped:'已寄出',cancelled:'已取消'}[r.status])}${r.status==='pending'?` <button class="small plain" data-cancel-request="${r.id}">取消</button>`:''}</p>`).join('')}</div>`:''}
    ${groupsHtml}
    ${intlHtml}
    ${shipHtml}
    ${closedHtml}
    ${timelineHtml}
    <p class="small muted">金额有疑问就在群里问一声。页面刷新后更新。</p>`;
  bindWarehouse(data);
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

function bindWarehouse(data){
 const endpoint=`/api/w/${encodeURIComponent(token)}`;
 const send=async(path,method,body)=>{const r=await api(endpoint+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error(r.data.error||'保存失败');await boot();};
 const handle=fn=>async e=>{const el=e.currentTarget;el.disabled=true;try{await fn();}catch(err){toast(err.message,true);}finally{el.disabled=false;}};
 app.querySelectorAll('[data-copy]').forEach(el=>el.onclick=handle(async()=>{await navigator.clipboard.writeText(el.dataset.copy);toast('单号已复制');}));
 app.querySelectorAll('[data-delete-address]').forEach(el=>el.onclick=handle(()=>send(`/addresses/${el.dataset.deleteAddress}`,'DELETE')));
 app.querySelectorAll('[data-cancel-request]').forEach(el=>el.onclick=handle(()=>send(`/requests/${el.dataset.cancelRequest}`,'DELETE')));
 const add=app.querySelector('#add-address');if(add)add.onclick=handle(()=>send('/addresses','POST',{recipient:app.querySelector('#recipient').value,phone:app.querySelector('#phone').value,detail:app.querySelector('#detail').value}));
 const selected=()=>[...app.querySelectorAll('[data-ship-item]:checked')].map(el=>Number(el.dataset.shipItem));
 const refresh=()=>{const ids=selected();const intl=data.items.filter(i=>ids.includes(i.id)&&!i.intlPaid).reduce((s,i)=>s+(i.intlFeeFen??0),0);app.querySelector('#shipping-total').textContent=ids.length?`已选${ids.length}件，国际运费 ${money(intl)} + 国内运费 ${money(data.domesticFeeFen)} = ${money(intl+data.domesticFeeFen)}。扫码转账给群主。`: '勾选绿色「可发货」商品后提交。';};
 app.querySelectorAll('[data-ship-item]').forEach(el=>el.onchange=refresh);refresh();
 app.querySelector('#request-shipping').onclick=handle(()=>{const address=app.querySelector('[name="ship-address"]:checked');if(!address)throw Error('请选择收货地址');return send('/requests','POST',{itemIds:selected(),addressId:Number(address.value)});});
}
