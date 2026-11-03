import { beijingTime, codeTag, copyText, escapeHtml, money, orderTag, statusBadge, thumb, toast, yen } from '/shared.js';

const pathToken = (location.pathname.match(/^\/w\/([^/?#]+)/) || [])[1] ?? '';
let token = pathToken ? decodeURIComponent(pathToken) : '';
const app = document.getElementById('app');

/** 重新渲染后要留下的东西：勾过的商品和滚到的位置 */
const keep = { selected: new Set(), scrollY: 0 };

const GROUPS = [
  { title: '已下单，等仓库收货', statuses: ['ordered', 'jp_warehouse'], note: '' },
  { title: '仓库已分拣', statuses: ['sorted'], note: '仓库已经收到并找齐了，接下来打包。' },
  { title: '已打包，等付运费', statuses: ['packed'], note: '' },
  { title: '回国中', statuses: ['intl_transit', 'cn_arrived'], note: '' },
  { title: '到了，找群主拿', statuses: ['cn_stock'], note: '东西已经在群主手上，发货在群里找群主。' },
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

function renderVerify(message, kind = 'err') {
  document.body.classList.remove('has-shipbar');
  app.innerHTML = `
    <div class="card">
      <h1>我的仓库</h1>
      <p class="muted">输入你的 QQ 号和密码。第一次进来密码是群主发的初始密码，进去之后会让你换成自己的。</p>
      <label for="qq">QQ 号</label>
      <input id="qq" inputmode="numeric" autocomplete="username" placeholder="例如 123456789">
      <label for="pw">密码</label>
      <div class="row">
        <input id="pw" type="password" autocomplete="current-password" placeholder="初始密码见群主发给你的那条">
        <button id="go">进入</button>
      </div>
      <p id="err" class="${kind === 'ok' ? 'paid' : 'unpaid'} small">${message ? escapeHtml(message) : ''}</p>
      <p class="small muted">密码忘了或者被别人改过？在群里问一声群主，他能给你重设一个初始密码。</p>
    </div>`;
  const input = document.getElementById('qq');
  const pw = document.getElementById('pw');
  const button = document.getElementById('go');
  const err = document.getElementById('err');
  const submit = async () => {
    button.disabled = true;
    const { ok, data } = await api('/api/w/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qq: input.value.trim(), password: pw.value }),
    });
    button.disabled = false;
    if (!ok) {
      // 服务端会告诉还剩几次机会，别让人试到被锁 15 分钟
      err.textContent = data.left ? `${data.error}（还能再试 ${data.left} 次）` : data.error || '验证失败';
      return;
    }
    token = data.token;
    // 统一入口登录后把专属地址补进地址栏，刷新不用再输密码
    history.replaceState(null, '', `/w/${encodeURIComponent(token)}`);
    if (data.mustChange) renderMustChange(data);
    else render(data);
  };
  button.onclick = submit;
  pw.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') pw.focus();
  };
  input.focus();
}

/** 还在用统一的初始密码时先进这一屏：不改密码就下不了单。 */
function renderMustChange(data) {
  document.body.classList.remove('has-shipbar');
  app.innerHTML = `
    <div class="card">
      <h1>先改一下密码</h1>
      <p class="muted">群主发的初始密码大家都一样，谁都可能登进你的页面。设一个只有你自己知道的，之后下单、填地址才认。</p>
      <label for="np">新密码（6 到 32 位，不要有空格）</label>
      <input id="np" type="password" autocomplete="new-password" maxlength="32">
      <label for="np2">再输一次</label>
      <div class="row">
        <input id="np2" type="password" autocomplete="new-password" maxlength="32">
        <button id="save">保存</button>
        <button id="peek" class="plain">先随便看看</button>
      </div>
      <p id="err" class="unpaid small"></p>
    </div>`;
  const err = document.getElementById('err');
  document.getElementById('save').onclick = async (e) => {
    const a = document.getElementById('np').value;
    const b = document.getElementById('np2').value;
    e.target.disabled = true;
    if (a !== b) {
      err.textContent = '两次输的不一样';
      e.target.disabled = false;
      return;
    }
    const { ok, data: r } = await api(`/api/w/${encodeURIComponent(token)}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: a }),
    });
    e.target.disabled = false;
    if (!ok) {
      err.textContent = r.error || '保存失败';
      return;
    }
    // 改密码会让这个 token 之前的登录状态全部作废，退回登录页让客户用新密码进
    token = '';
    renderVerify('密码已改好，用 QQ 号和新密码再登一次');
  };
  document.getElementById('peek').onclick = () => render(data);
}

/**
 * 进度管线的几站（AfterShip 那种一条线）。直邮和拼邮第三、四站不一样。
 * 每一站下面写这一站现在有几件，比一句「部分已寄出」清楚。
 */
const PIPES = {
  direct: [
    { name: '已下单', statuses: ['ordered', 'jp_warehouse'] },
    { name: '已分拣', statuses: ['sorted'] },
    { name: '已打包', statuses: ['packed'] },
    { name: '已寄出', statuses: ['shipped', 'delivered'] },
  ],
  group: [
    { name: '已下单', statuses: ['ordered', 'jp_warehouse'] },
    { name: '已分拣', statuses: ['sorted', 'packed'] },
    { name: '回国中', statuses: ['intl_transit', 'cn_arrived'] },
    { name: '到群主手上', statuses: ['cn_stock', 'shipped', 'delivered'] },
  ],
};

function pipeline(items, direct) {
  const steps = PIPES[direct ? 'direct' : 'group'].map((st) => ({ ...st, n: items.filter((i) => st.statuses.includes(i.status)).length }));
  if (!steps.some((st) => st.n)) return '';
  // 走得最远的那一件到了哪一站：这一站和之前的线都点亮
  let far = 0;
  steps.forEach((st, k) => {
    if (st.n) far = k;
  });
  const last = steps.length - 1;
  return `<ol class="pipeline" style="--steps:${steps.length}" aria-label="进度">${steps
    .map((st, k) => {
      const cls = k < far ? 'lit' : k === far ? `${k === last ? 'lit' : 'lit-left'} now` : '';
      return `<li class="pipe-step ${cls}${st.n ? '' : ' zero'}"><span class="dot"></span><span class="name">${st.name}</span><span class="n">${st.n} 件</span></li>`;
    })
    .join('')}</ol>`;
}

function itemCard(item) {
  // 汇总卡按后端口径把取消/退款的件剔掉了，件上就不该再显示「未付」，不然上下两个数对不上
  const dead = item.status === 'cancelled' || item.status === 'refunded';
  const paid = dead
    ? ''
    : item.goodsPaid
      ? '<span class="badge ok">货款已付</span>'
      : item.goodsFeeJpy
        ? '<span class="badge danger">货款未付</span>'
        : '';
  const missing = item.missing ? '<span class="badge warn">缺件</span>' : '';
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
        <div class="small row" style="gap:6px;margin-top:4px">
          ${codeTag(item)}
          <span class="muted">${escapeHtml(item.batchName || '')}</span>
        </div>
        ${orderTag(item)}
        <div class="small row" style="gap:6px;margin-top:6px">
          ${statusBadge(item.status)}${paid}${missing}
          ${item.goodsFeeJpy ? `<span class="muted">应付 <span class="money">${yen(item.goodsFeeJpy)}</span></span>` : ''}
        </div>
        ${item.returnTrackingNo ? `<div class="small" style="margin-top:6px">回国单号 <button class="badge copy-chip mono" data-copy="${escapeHtml(item.returnTrackingNo)}">${escapeHtml(item.returnTrackingNo)}</button>${item.returnedAt ? ` <span class="muted">· ${escapeHtml(item.returnedAt)} 回国</span>` : ''}</div>` : ''}
        ${item.intlFeeFen === null || item.intlFeeFen === undefined || dead ? '' : `<div class="small muted">${item.weightG ? `${item.weightG} g` : '整摞均摊'} · 国际运费 ${money(item.intlFeeFen)} ${item.intlPaid ? '已付' : '待付'}</div>`}
        ${item.missing ? '<div class="small muted">这件东西没到齐。</div>' : ''}
        ${note}
      </div>
    </div>`;
}

/** 运单卡（17TRACK 那种）：放行之前只说「打好包了」，放行之后单号、毛重、运费、平铺图、每件来自哪个订单都摆出来。 */
function parcelCard(p) {
  const list = `<ul class="parcel-items">${p.items
    .map(
      (i) => `<li><span class="thumb">${thumb(i)}</span>
        <div class="t"><div>${escapeHtml(i.title)}</div>
          <div class="row" style="gap:6px;margin-top:2px">${codeTag(i) || ''}${i.orderNo ? `<button class="badge copy-chip mono" data-copy="${escapeHtml(i.orderNo)}">订单 ${escapeHtml(i.orderNo)}</button>` : `<span class="muted">${escapeHtml(i.batchName)}</span>`}</div></div></li>`,
    )
    .join('')}</ul>`;
  if (!p.released) {
    return `<div class="parcel waiting">
      <div class="parcel-head">
        <div><span class="tracking"><b style="font-size:16px">仓库已经打好包 · ${p.itemCount} 件</b></span>
          <div class="small muted">${escapeHtml(p.submitDay)} 打包</div></div>
        <span class="badge warn dot">等付运费</span>
      </div>
      <ol class="steps"><li class="step done">仓库打包</li><li class="step now">付运费</li><li class="step">寄出</li></ol>
      <p class="small muted" style="margin:0">群主会找你说运费，付完之后这里会出现快递单号和平铺图。</p>
      ${list}
    </div>`;
  }
  const photos = (p.photoIds || [])
    .map((pid) => {
      const src = `/api/w/${encodeURIComponent(token)}/parcels/${p.id}/photos/${pid}`;
      return `<a href="${src}" target="_blank"><img src="${src}" alt="平铺图" loading="lazy"></a>`;
    })
    .join('');
  return `<div class="parcel">
    <div class="parcel-head">
      <div class="tracking">
        <div><span class="lbl">快递单号</span><span class="no">${escapeHtml(p.trackingNo)}</span></div>
        <button class="small ghost" data-copy="${escapeHtml(p.trackingNo)}">复制单号</button>
      </div>
      <span class="badge ok dot">已寄出</span>
    </div>
    <ol class="steps"><li class="step done">仓库打包</li><li class="step done">付运费</li><li class="step done">寄出</li></ol>
    <div class="kv"><span>毛重</span><b>${Number(p.grossWeightG).toLocaleString()} g</b></div>
    <div class="kv"><span>运费</span><b class="money">${money(p.feeFen)}</b></div>
    <div class="kv"><span>里面有</span><b>${p.itemCount} 件</b></div>
    ${photos ? `<div class="parcel-photos">${photos}</div>` : ''}
    ${list}
  </div>`;
}

function timelineItem(t) {
  return `<li class="tl-item">
    <div class="tl-time">${beijingTime(t.at)}</div>
    <div class="tl-body"><span>${escapeHtml(t.title)}</span>${statusBadge(t.toStatus)}</div>
  </li>`;
}

function render(data) {
  keep.scrollY = window.scrollY;
  const s = data.summary;
  const items = data.items || [];
  const parcels = data.parcels || [];
  const direct = data.customer.shipMode === 'direct';
  const shownStatuses = new Set(GROUPS.flatMap((g) => g.statuses));
  const closed = items.filter((i) => !shownStatuses.has(i.status));

  const groupsHtml = GROUPS.map((group) => {
    const list = items.filter((i) => group.statuses.includes(i.status));
    if (list.length === 0) return '';
    return `
      <div class="card">
        <h2 class="section-title">${group.title}<span class="count">${list.length} 件</span></h2>
        ${group.note ? `<p class="small muted" style="margin:0 0 4px">${group.note}</p>` : ''}
        ${list.map(itemCard).join('')}
      </div>`;
  }).join('');

  const parcelHtml = parcels.length
    ? `<div class="card">
        <h2 class="section-title">我的直邮包裹<span class="count">${parcels.length} 个</span></h2>
        ${parcels.map(parcelCard).join('')}
      </div>`
    : '';

  // 老流程（称重分摊 / 寄出）留下的记录：有才显示
  const intlHtml = (data.weighGroups || []).length
    ? `<div class="card"><details><summary>以前的国际运费记录</summary>
        ${data.weighGroups
          .map((g) => `<div class="kv"><span>${escapeHtml(g.packageName)} · ${Number(g.weightG || 0).toLocaleString()} g</span><b class="${g.feePaid ? 'paid' : 'unpaid'} money">${money(g.intlFeeFen)} ${g.feePaid ? '已付' : '待付'}</b></div>`)
          .join('')}</details></div>`
    : '';
  const shipHtml = (data.shipments || []).length
    ? `<div class="card"><details><summary>以前的寄出记录</summary>
        ${data.shipments
          .map((s2) => `<div class="kv"><span>${s2.trackingNo ? `${escapeHtml(s2.trackingNo)} <button class="small plain" data-copy="${escapeHtml(s2.trackingNo)}">复制</button>` : '单号待填'} · ${s2.items.length} 件</span><b class="${s2.feePaid ? 'paid' : 'unpaid'} money">${money(s2.feeFen)}</b></div>`)
          .join('')}</details></div>`
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
        <h2 class="section-title">最近动态</h2>
        <ol class="timeline">${data.timeline.slice(0, 8).map(timelineItem).join('')}</ol>
        ${data.timeline.length > 8 ? `<details><summary class="small" style="margin-top:10px">再看 ${data.timeline.length - 8} 条更早的</summary><ol class="timeline" style="margin-top:10px">${data.timeline.slice(8).map(timelineItem).join('')}</ol></details>` : ''}
       </div>`
    : '';

  const pwNotice = data.mustChange
    ? `<div class="card tone-warn">
        <div class="card-head" style="margin:0">
          <div><h2 style="margin:0">密码还是大家共用的那个初始密码</h2>
            <p class="small" style="margin:4px 0 0">谁都知道这个密码，别人填你的 QQ 就能登进来，改成只有你知道的（改完要重新登一次）。</p></div>
          <button id="change-pw">改密码</button>
        </div>
       </div>`
    : '';

  const where = !items.length
    ? '群主还没把你买的东西放进来。付完货款、群主放行之后，这一页自己会更新。'
    : s.parcelsWaiting
      ? `仓库给你打好了 ${s.parcelsWaiting} 个包裹，等你付运费；付完群主放行，这里就有单号和平铺图。`
      : s.sortedCount
        ? `仓库已经分拣好 ${s.sortedCount} 件${direct ? '，下一步打包直邮给你' : '，下一步装进拼邮箱回国'}。`
        : '东西都在路上，有变化这一页会跟着变。';

  const live = items.filter((i) => i.status !== 'cancelled' && i.status !== 'refunded');
  app.innerHTML = `
    <div class="card hero">
      <div class="hero-top">
        <h1>${escapeHtml(data.customer.nickname)} 的仓库</h1>
        <span class="row small muted">${direct ? '<span class="badge warn">直邮</span>' : '<span class="badge ok">拼邮</span>'} ${items.length} 件 <button id="logout" class="small plain">退出登录</button></span>
      </div>
      <p class="hero-where">${where}</p>
      ${pipeline(live, direct)}
      <div class="grid" style="margin-top:14px">
        <div class="stat${s.goodsUnpaidJpy ? ' tone-danger' : ' tone-ok'}"><div class="label">货款待付（日元）</div><div class="value money">${yen(s.goodsUnpaidJpy)}</div></div>
        <div class="stat${s.parcelsWaiting ? ' tone-warn' : ''}"><div class="label">等付运费的包裹</div><div class="value">${s.parcelsWaiting}<small>个</small></div></div>
      </div>
      ${direct ? '' : '<p class="hero-note">拼邮的东西跟群主一个箱子回国，回国单号在每件东西下面，可以复制去查。</p>'}
    </div>
    ${pwNotice}
    ${parcelHtml}
    ${groupsHtml}
    ${intlHtml}
    ${shipHtml}
    ${closedHtml}
    ${timelineHtml}
    <p class="small muted" style="text-align:center">有疑问就在群里问一声。页面刷新后更新。</p>`;
  bindWarehouse(data);
  document.body.classList.remove('has-shipbar');
  if (keep.scrollY) window.scrollTo(0, keep.scrollY);
}

async function boot() {
  if (!token) {
    renderVerify('');
    return;
  }
  const { ok, status, data } = await api(`/api/w/${encodeURIComponent(token)}`);
  if (ok && data.verified) {
    if (data.mustChange) renderMustChange(data);
    else render(data);
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
 app.querySelectorAll('[data-copy]').forEach(el=>el.onclick=handle(async()=>{if(!await copyText(el.dataset.copy))throw Error('这个浏览器不让网页复制，手动选中这段字拷一下');toast(`已复制 ${el.dataset.copy}`);}));
 app.querySelectorAll('[data-delete-address]').forEach(el=>el.onclick=handle(()=>send(`/addresses/${el.dataset.deleteAddress}`,'DELETE')));
 app.querySelectorAll('[data-cancel-request]').forEach(el=>el.onclick=handle(()=>send(`/requests/${el.dataset.cancelRequest}`,'DELETE')));
 const changePw=app.querySelector('#change-pw');if(changePw)changePw.onclick=()=>renderMustChange(data);
 const logout=app.querySelector('#logout');
 // 退出不走 send()：那玩意会立刻重新拉一次仓库，白跑一趟还先把页面画出来
 if(logout)logout.onclick=handle(async()=>{await api(`${endpoint}/logout`,{method:'POST'});token='';location.href='/?out=1';});
 const add=app.querySelector('#add-address');
 if(add)add.onclick=handle(()=>{
  const v=(id)=>(app.querySelector(id)?.value ?? '').trim();
  const recipient=v('#recipient'),phone=v('#phone'),detail=v('#detail');
  if(!recipient||!phone||!detail)throw Error('收件人、电话、地址都要填全');
  return send('/addresses','POST',{recipient,phone,detail});
 });
 const selected=()=>[...app.querySelectorAll('[data-ship-item]:checked')].map(el=>Number(el.dataset.shipItem));
 const totalEl=app.querySelector('#shipping-total');
 const submit=app.querySelector('#request-shipping');
 const refresh=()=>{
  if(!totalEl||!submit)return;
  const ids=selected();
  const intl=data.items.filter(i=>ids.includes(i.id)&&!i.intlPaid).reduce((s,i)=>s+(i.intlFeeFen??0),0);
  submit.disabled=!ids.length;
  totalEl.innerHTML=ids.length
    // 只拼 money() 出来的数字和件数，不拼任何客户能写的文本
    ? `已选 ${ids.length} 件 · <b>${money(intl+data.domesticFeeFen)}</b><small>国际运费 ${money(intl)} + 国内运费 ${money(data.domesticFeeFen)}，扫码转给群主</small>`
    : '勾上要寄的商品';
 };
 app.querySelectorAll('[data-ship-item]').forEach(el=>el.onchange=refresh);refresh();
 if(submit)submit.onclick=handle(()=>{
  const ids=selected();
  if(!ids.length)throw Error('先勾选要寄的商品');
  const address=app.querySelector('[name="ship-address"]:checked');
  if(!address)throw Error('请选择收货地址');
  return send('/requests','POST',{itemIds:ids,addressId:Number(address.value)});
 });
}
