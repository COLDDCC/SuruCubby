/**
 * 仓库工作台。仓库只看干活要用的：客户叫什么、买了什么（大图 + 货号）、直邮还是拼邮、直邮寄哪。
 * 后端本来就不给价格和 QQ，这里也不画任何钱。
 */
import { beijingTime, copyText, escapeHtml, itemCode, statusLabel, thumb, toast } from '/shared.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const who = document.getElementById('who');
const logoutBtn = document.getElementById('logout');

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (res.status === 401 && !path.endsWith('/login')) {
    renderLogin('登录过期了，重新登一下');
    throw Object.assign(new Error(data.error || '请先登录'), { silent: true });
  }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const LANE = {
  direct: '<span class="badge warn">直邮</span>',
  group: '<span class="badge ok">拼邮</span>',
  self: '<span class="badge">自己带回</span>',
};

function today() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 同一位客户买了好几件一样的（很常见）：合成一张卡，标 ×N。 */
function groupSame(items) {
  const map = new Map();
  for (const i of items) {
    const key = i.productUrl || `t:${i.title}`;
    const g = map.get(key) || { ...i, ids: [], members: [] };
    g.ids.push(i.id);
    g.members.push(i);
    map.set(key, g);
  }
  return [...map.values()];
}

/** 一张大图卡：图 + 大号货号 + 单号胶囊。selectable 时整张卡可点选。 */
function card(g, { selectable = false, selected = false, disabled = false, note = '' } = {}) {
  const code = itemCode(g.productUrl);
  const count = g.ids.length;
  return `
    <div class="claim wh-card${selected ? ' found' : ''}${disabled ? ' wh-off' : ''}" ${selectable && !disabled ? `data-pick="${g.ids.join(',')}" role="checkbox" aria-checked="${selected}"` : ''}>
      <div class="claim-photo">${thumb(g)}${selectable && !disabled ? `<span class="pick-box${selected ? ' on' : ''}" aria-hidden="true"></span>` : ''}</div>
      <div class="wh-code">${code ? escapeHtml(code) : '<span class="muted small">没有货号</span>'}${count > 1 ? ` <b class="wh-count">×${count}</b>` : ''}</div>
      <div class="small wh-title" title="${escapeHtml(g.title)}">${escapeHtml(g.title)}</div>
      <div class="small row" style="gap:4px">
        ${g.orderNo ? `<button class="badge copy-chip mono" data-copy="${escapeHtml(g.orderNo)}">单号 ${escapeHtml(g.orderNo)}</button>` : ''}
        ${g.boxName ? `<span class="badge ok">${escapeHtml(g.boxName)}</span>` : ''}
        ${g.parcelId ? `<span class="badge warn">已打包 #${g.parcelId}</span>` : ''}
        ${note}
      </div>
    </div>`;
}

function renderLogin(message = '') {
  nav.hidden = true;
  logoutBtn.hidden = true;
  who.textContent = '';
  view.innerHTML = `
    <div class="card" style="max-width:380px;margin:40px auto">
      <h1>仓库登录</h1>
      <form id="login">
        <label for="u">账号</label><input id="u" autocomplete="username" style="width:100%">
        <label for="p">密码</label><input id="p" type="password" autocomplete="current-password" style="width:100%">
        <p><button class="btn" type="submit" style="width:100%">进入工作台</button></p>
      </form>
      <p id="err" class="unpaid small">${escapeHtml(message)}</p>
    </div>`;
  document.getElementById('login').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/wh/login', { username: document.getElementById('u').value.trim(), password: document.getElementById('p').value });
      route();
    } catch (err) {
      document.getElementById('err').textContent = err.message;
    }
  };
  document.getElementById('u').focus();
}

// ───────── 首页：拿单号进门 ─────────
async function renderHome() {
  const recent = await api('GET', '/api/wh/batches');
  view.innerHTML = `
    <div class="card scan-card">
      <h2 style="margin:0 0 4px">货到了？输单号进门</h2>
      <form id="find" class="row">
        <input id="q" placeholder="例如 0042 或 7788" style="flex:1;min-width:200px" autocomplete="off" enterkeyhint="go">
        <button class="btn" type="submit">进入</button>
      </form>
      <div id="hits"></div>
    </div>
    <div class="card">
      <h2 class="section-title">最近的订单</h2>
      ${batchList(recent.batches)}
    </div>`;
  const q = document.getElementById('q');
  q.focus();
  document.getElementById('find').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('GET', `/api/wh/lookup?q=${encodeURIComponent(q.value.trim())}`);
      if (r.batches.length === 1) {
        location.hash = `#/order/${r.batches[0].id}`;
        return;
      }
      document.getElementById('hits').innerHTML = r.batches.length ? batchList(r.batches) : '<p class="unpaid">没找到这个单号，核对一下或者找群主</p>';
    } catch (err) {
      if (!err.silent) toast(err.message, true);
    }
  };
}

/** 细进度条：整理了几件 / 一共几件 */
function meter(done, total) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return `<div class="meter${total && done >= total ? ' ok' : ''}" style="width:100%"><span style="width:${pct}%"></span></div>`;
}

function batchList(batches) {
  if (!batches.length) return '<p class="empty">还没有订单</p>';
  return batches
    .map(
      (b) => `<a class="list-row" href="#/order/${b.id}" style="display:flex;justify-content:space-between;gap:8px;text-decoration:none;color:inherit">
        <div class="main"><b>${escapeHtml(b.orderNo || b.name)}</b>
          <div class="small muted">${escapeHtml(b.name)}${b.japanTrackingNo ? ` · 运单 ${escapeHtml(b.japanTrackingNo)}` : ''}${b.shop ? ` · ${escapeHtml(b.shop)}` : ''}</div></div>
        <div class="side small right" style="flex-direction:column;align-items:flex-end;gap:0;min-width:120px">${b.customerCount} 人 · ${b.itemCount} 件
          <span class="${b.sortedCount >= b.itemCount && b.itemCount ? 'paid' : 'muted'}">已整理 ${b.sortedCount}/${b.itemCount}</span>
          ${meter(b.sortedCount, b.itemCount)}</div>
      </a>`,
    )
    .join('');
}

/** 拼邮 ⇄ 直邮。改了以后这位客户以后的单也默认这样走。成功返回 true。 */
async function switchLane(customerId, nickname, lane) {
  const text = lane === 'direct'
    ? `把 ${nickname} 改成直邮？以后他的单也默认直邮。地址要群主补上才能打包。`
    : `把 ${nickname} 改回拼邮？以后他的单也默认拼邮。`;
  if (!confirm(text)) return false;
  try {
    const r = await api('POST', `/api/wh/customers/${customerId}/lane`, { lane });
    toast(r.needAddress ? `已改成直邮，等群主补地址` : `已改成${lane === 'direct' ? '直邮' : '拼邮'}`);
    return true;
  } catch (err) {
    if (!err.silent) toast(err.message, true);
    return false;
  }
}

// ───────── 订单操作台：点客户名字 → 他这一单的东西 ─────────
async function renderOrder(id, openCustomer) {
  const data = await api('GET', `/api/wh/batches/${id}`);
  const b = data.batch;
  const current = data.customers.find((c) => String(c.id) === String(openCustomer)) || null;
  const chips = data.customers
    .map((c) => {
      const done = c.sortedCount >= c.itemCount;
      return `<a href="#/order/${id}/${c.id}" class="wh-person${current?.id === c.id ? ' on' : ''}${done ? ' done' : ''}">
        <b>${escapeHtml(c.nickname)}</b> ${LANE[c.lane]}<br><span class="small">${done ? '✓ 已整理' : `已整理 ${c.sortedCount}/${c.itemCount}`}</span>${meter(c.sortedCount, c.itemCount)}</a>`;
    })
    .join('');
  let panel = '';
  if (current) {
    const groups = groupSame(current.items);
    const done = current.sortedCount >= current.itemCount;
    panel = `
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div>
          <h2 style="margin:0">${escapeHtml(current.nickname)} ${LANE[current.lane]}</h2>
          <p class="small muted" style="margin:4px 0">这一单 ${current.itemCount} 件 · 已整理 ${current.sortedCount} 件</p>
          <div style="max-width:240px">${meter(current.sortedCount, current.itemCount)}</div>
          ${current.lane === 'direct' && current.directAddress ? `<p class="small">寄到：<button class="badge copy-chip" data-copy="${escapeHtml(current.directAddress)}">${escapeHtml(current.directAddress)}</button></p>` : ''}
        </div>
        ${done ? '<button class="plain small" data-act="unsort">撤回整理</button>' : ''}
      </div>
      <div class="claim-grid wh-grid" style="margin-top:12px">${groups.map((g) => card(g)).join('')}</div>
      <div class="actionbar row" style="margin-top:12px">
        ${done ? '' : `<button class="btn wh-big" data-act="sort">整理完成（${current.itemCount - current.sortedCount} 件）</button>`}
        ${done && current.lane === 'direct' ? `<a class="btn wh-big" href="#/customer/${current.id}">装进直邮箱 →</a>
          <button class="btn ghost wh-big" data-lane="group">改拼邮，装拼邮箱</button>` : ''}
        ${done && current.lane === 'group' ? `<a class="btn wh-big" href="#/boxes">装进拼邮箱 →</a>
          <button class="btn ghost wh-big" data-lane="direct">改直邮，装直邮箱</button>` : ''}
        ${done && current.lane === 'self' ? '<span class="badge">自己带回</span>' : ''}
      </div>`;
  }
  view.innerHTML = `
    <div class="card">
      <p class="small" style="margin:0"><a href="#/">← 换个单号</a></p>
      <h2 style="margin:6px 0">${escapeHtml(b.orderNo || b.name)}</h2>
      <p class="small muted" style="margin:0">${escapeHtml(b.name)}${b.japanTrackingNo ? ` · 运单 ${escapeHtml(b.japanTrackingNo)}` : ''}${b.shop ? ` · ${escapeHtml(b.shop)}` : ''}</p>
      <div class="wh-people">${chips}</div>
    </div>
    ${panel ? `<div class="card">${panel}</div>` : ''}`;
  view.querySelector('[data-act="sort"]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('POST', `/api/wh/batches/${id}/customers/${current.id}/sorted`, {});
      toast(`${current.nickname} 整理完成（${r.count} 件），客户那边已显示「已分拣」`);
      renderOrder(id, current.id);
    } catch (err) {
      e.target.disabled = false;
      if (!err.silent) toast(err.message, true);
    }
  });
  view.querySelector('[data-lane]')?.addEventListener('click', async (e) => {
    const lane = e.currentTarget.dataset.lane;
    if (!(await switchLane(current.id, current.nickname, lane))) return;
    location.hash = lane === 'direct' ? `#/customer/${current.id}` : '#/boxes';
  });
  view.querySelector('[data-act="unsort"]')?.addEventListener('click', async () => {
    try {
      await api('POST', `/api/wh/batches/${id}/customers/${current.id}/sorted`, { undo: true });
      renderOrder(id, current.id);
    } catch (err) {
      if (!err.silent) toast(err.message, true);
    }
  });
}

// ───────── 直邮客户：勾东西（可跨订单）→ 单号 → 毛重 → 平铺图 ─────────

/** 平铺图在手机上拍的动辄 5MB，先压到长边 1600px 的 JPEG 再传。 */
async function compress(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`${file.name} 不是能识别的图片`);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const q of [0.82, 0.7, 0.55]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length * 0.75 < 1_400_000) return url;
  }
  throw new Error('图片压完还是太大了，换一张');
}

function photoStrip(parcel, removable) {
  if (!parcel.photoIds.length) return '<span class="small unpaid">还没传平铺图</span>';
  return parcel.photoIds
    .map(
      (pid) => `<span class="wh-photo"><a href="/api/wh/parcels/${parcel.id}/photos/${pid}" target="_blank"><img src="/api/wh/parcels/${parcel.id}/photos/${pid}" alt="平铺图"></a>
        ${removable ? `<button class="plain small" data-delphoto="${parcel.id}:${pid}">删</button>` : ''}</span>`,
    )
    .join('');
}

function parcelCard(p, { showCustomer = false } = {}) {
  return `
    <div class="card wh-parcel" data-parcel="${p.id}">
      <div class="card-head" style="margin-bottom:6px">
        <h3>#${p.id} ${showCustomer ? `<a href="#/customer/${p.customerId}">${escapeHtml(p.nickname)}</a>` : ''}</h3>
        ${p.locked ? '<span class="badge ok dot">群主已放行 · 锁定</span>' : '<span class="badge warn dot">等群主放行 · 还能改</span>'}
      </div>
      <p style="margin:6px 0">单号 <button class="badge copy-chip mono" data-copy="${escapeHtml(p.trackingNo)}">${escapeHtml(p.trackingNo)}</button>
        · 毛重 <b>${p.grossWeightG.toLocaleString()} g</b> · ${p.items.length} 件
        <span class="small muted">· ${escapeHtml(p.createdByName || '')} ${beijingTime(p.createdAt)}</span></p>
      ${p.addressSnapshot ? `<p class="small muted" style="margin:4px 0">寄到 ${escapeHtml(p.addressSnapshot)}</p>` : ''}
      <div class="small">${p.items.map((i) => `${escapeHtml(itemCode(i.productUrl) || i.title)}${i.orderNo ? `<span class="muted">（${escapeHtml(i.orderNo)}）</span>` : ''}`).join('、')}</div>
      <div class="row" style="margin-top:8px">${photoStrip(p, !p.locked)}</div>
      ${
        p.locked
          ? ''
          : `<div class="row" style="margin-top:8px">
              <label class="btn ghost small" style="margin:0">加平铺图<input type="file" accept="image/*" multiple hidden data-addphoto="${p.id}"></label>
              <button class="plain small" data-edit="${p.id}">改单号 / 毛重</button>
              <button class="danger small" data-del="${p.id}">作废这个包裹</button>
            </div>`
      }
    </div>`;
}

function bindParcelActions(root, rerender) {
  const run = (fn) => async (e) => {
    e.preventDefault();
    try {
      await fn(e);
      await rerender();
    } catch (err) {
      if (!err.silent) toast(err.message, true);
    }
  };
  root.querySelectorAll('[data-addphoto]').forEach((input) =>
    input.addEventListener(
      'change',
      run(async () => {
        for (const f of input.files) await api('POST', `/api/wh/parcels/${input.dataset.addphoto}/photos`, { photo: await compress(f) });
        toast('平铺图传好了');
      }),
    ),
  );
  root.querySelectorAll('[data-delphoto]').forEach((b) =>
    b.addEventListener(
      'click',
      run(async () => {
        const [pid, photo] = b.dataset.delphoto.split(':');
        await api('DELETE', `/api/wh/parcels/${pid}/photos/${photo}`);
      }),
    ),
  );
  root.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener(
      'click',
      run(async () => {
        const trackingNo = prompt('快递单号', b.closest('[data-parcel]').querySelector('.mono').textContent.trim());
        if (trackingNo === null) throw Object.assign(new Error(''), { silent: true });
        const weight = prompt('毛重（克）');
        const body = { trackingNo };
        if (weight) body.grossWeightG = Number(weight);
        await api('PATCH', `/api/wh/parcels/${b.dataset.edit}`, body);
        toast('改好了');
      }),
    ),
  );
  root.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener(
      'click',
      run(async () => {
        if (!confirm('作废这个包裹？里面的东西会退回「已分拣」，可以重新打包。')) throw Object.assign(new Error(''), { silent: true });
        await api('DELETE', `/api/wh/parcels/${b.dataset.del}`);
        toast('已作废');
      }),
    ),
  );
}

async function renderCustomer(id) {
  const data = await api('GET', `/api/wh/customers/${id}`);
  const cu = data.customer;
  const ready = data.items.filter((i) => i.status === 'sorted' && !i.boxId);
  const notYet = data.items.filter((i) => i.status !== 'sorted' || i.boxId);
  const picked = new Set(ready.map((i) => i.id));
  const photos = [];

  const draw = () => {
    const readyGroups = groupSame(ready);
    view.innerHTML = `
      <div class="card">
        <p class="small" style="margin:0"><a href="javascript:history.back()">← 返回</a></p>
        <h2 style="margin:6px 0">${escapeHtml(cu.nickname)} ${LANE[cu.lane]}</h2>
        ${cu.lane === 'direct'
          ? cu.directAddress
            ? `<p>寄到：<button class="badge copy-chip" data-copy="${escapeHtml(cu.directAddress)}">${escapeHtml(cu.directAddress)}</button></p>`
            : '<p class="unpaid">等群主补地址</p>'
          : ''}
        ${cu.lane === 'group' ? '<button class="btn ghost" data-lane="direct">改直邮，装直邮箱</button>' : ''}
        ${cu.lane === 'direct' ? '<button class="plain small" data-lane="group">改回拼邮</button>' : ''}
      </div>
      ${cu.lane === 'direct' ? `
      <div class="card">
        <h3>直邮箱</h3>
        ${readyGroups.length ? `<div class="claim-grid wh-grid">${readyGroups.map((g) => card(g, { selectable: true, selected: g.ids.every((x) => picked.has(x)) })).join('')}</div>` : '<p class="empty">没有整理好待打包的东西</p>'}
        ${notYet.length ? `<details style="margin-top:10px"><summary class="small">还有 ${notYet.length} 件不能装</summary>
          <div class="claim-grid wh-grid">${groupSame(notYet).map((g) => card(g, { disabled: true, note: g.boxId ? '' : '<span class="badge">还没整理</span>' })).join('')}</div></details>` : ''}
        ${readyGroups.length && cu.directAddress ? `
        <form id="pack" style="margin-top:12px">
          <div class="row">
            <div style="flex:2;min-width:200px"><label for="tn">快递单号</label><input id="tn" style="width:100%;font-size:18px" autocomplete="off" required></div>
            <div style="flex:1;min-width:120px"><label for="gw">毛重（克）</label><input id="gw" type="number" inputmode="numeric" min="1" style="width:100%;font-size:18px" required></div>
          </div>
          <label>平铺图</label>
          <label class="btn ghost" style="display:inline-block">拍照 / 选图<input id="ph" type="file" accept="image/*" multiple hidden></label>
          <span id="phn" class="small muted">${photos.length ? `已选 ${photos.length} 张` : ''}</span>
          <div class="actionbar" style="margin-top:12px"><button class="btn wh-big" type="submit">提交包裹（${picked.size} 件）</button></div>
        </form>` : ''}
      </div>` : ''}
      <h3>他的包裹</h3>
      ${data.parcels.length ? data.parcels.map((p) => parcelCard(p)).join('') : '<p class="empty">还没有包裹</p>'}`;

    view.querySelectorAll('[data-pick]').forEach((el) =>
      el.addEventListener('click', (e) => {
        if (e.target.closest('a,button')) return;
        const ids = el.dataset.pick.split(',').map(Number);
        const on = ids.every((x) => picked.has(x));
        ids.forEach((x) => (on ? picked.delete(x) : picked.add(x)));
        const tn = document.getElementById('tn')?.value;
        const gw = document.getElementById('gw')?.value;
        draw();
        if (tn) document.getElementById('tn').value = tn;
        if (gw) document.getElementById('gw').value = gw;
      }),
    );
    document.getElementById('ph')?.addEventListener('change', async (e) => {
      try {
        for (const f of e.target.files) photos.push(await compress(f));
        document.getElementById('phn').textContent = `已选 ${photos.length} 张`;
      } catch (err) {
        toast(err.message, true);
      }
    });
    document.getElementById('pack')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        if (!picked.size) throw new Error('一件都没勾');
        await api('POST', '/api/wh/parcels', {
          customerId: cu.id,
          itemIds: [...picked],
          trackingNo: document.getElementById('tn').value.trim(),
          grossWeightG: Number(document.getElementById('gw').value),
          photos,
        });
        toast('包裹提交好了，等群主放行单号');
        renderCustomer(id);
      } catch (err) {
        btn.disabled = false;
        if (!err.silent) toast(err.message, true);
      }
    });
    view.querySelector('[data-lane]')?.addEventListener('click', async (e) => {
      if (await switchLane(cu.id, cu.nickname, e.currentTarget.dataset.lane)) renderCustomer(id);
    });
    bindParcelActions(view, () => renderCustomer(id));
  };
  draw();
}

async function renderParcels(day) {
  const d = day || today();
  const data = await api('GET', `/api/wh/parcels?day=${d}`);
  view.innerHTML = `
    <div class="card">
      <h2>直邮包裹</h2>
      <div class="row"><label for="day" style="margin:0">提交日期</label><input id="day" type="date" value="${d}">
        <span class="small muted">这一天提交了 ${data.parcels.length} 个</span></div>
    </div>
    ${data.parcels.map((p) => parcelCard(p, { showCustomer: true })).join('') || '<p class="empty">这一天没有提交包裹</p>'}`;
  document.getElementById('day').onchange = (e) => (location.hash = `#/parcels/${e.target.value}`);
  bindParcelActions(view, () => renderParcels(d));
}

// ───────── 拼邮箱 ─────────
async function renderBoxes() {
  const data = await api('GET', '/api/wh/boxes');
  view.innerHTML = `
    <div class="card">
      <h2>拼邮箱</h2>
      <button class="btn" id="newbox">新开一个拼邮箱</button>
    </div>
    ${data.boxes
      .map(
        (b) => `<a class="card list-row" href="#/box/${b.id}" style="display:flex;justify-content:space-between;text-decoration:none;color:inherit">
          <div><b>${escapeHtml(b.name)}</b><div class="small muted">${b.customerCount} 人 · ${b.itemCount} 件</div></div>
          <div class="small right">${b.trackingNo ? `回国单号 ${escapeHtml(b.trackingNo)}` : '<span class="unpaid">没填回国单号</span>'}<br>
            ${b.returnedAt ? `<span class="paid">${escapeHtml(b.returnedAt)} 已发出</span>` : '<span class="muted">还没发出</span>'}</div></a>`,
      )
      .join('')}`;
  document.getElementById('newbox').onclick = async () => {
    try {
      const r = await api('POST', '/api/wh/boxes', {});
      location.hash = `#/box/${r.id}`;
    } catch (err) {
      if (!err.silent) toast(err.message, true);
    }
  };
}

function byPerson(items) {
  const map = new Map();
  for (const i of items) map.set(i.customerId, [...(map.get(i.customerId) || []), i]);
  return [...map.values()];
}

async function renderBox(id) {
  const data = await api('GET', `/api/wh/boxes/${id}`);
  const box = data.box;
  const picked = new Set();
  const draw = () => {
    view.innerHTML = `
      <div class="card">
        <p class="small" style="margin:0"><a href="#/boxes">← 全部拼邮箱</a></p>
        <h2 style="margin:6px 0">${escapeHtml(box.name)}</h2>
        <form id="tn" class="row">
          <label for="t" style="margin:0">回国单号</label>
          <input id="t" value="${escapeHtml(box.trackingNo || '')}" style="flex:1;min-width:180px;font-size:18px" autocomplete="off">
          <button class="btn ghost" type="submit">存单号</button>
        </form>
        <div class="row" style="margin-top:8px">
          ${box.returnedAt
            ? `<span class="paid">${escapeHtml(box.returnedAt)} 已发出</span>`
            : `<label for="d" style="margin:0">回国日期</label><input id="d" type="date" value="${today()}"><button class="btn wh-big" id="ship">箱子发出</button>`}
        </div>
      </div>
      <div class="card">
        <h3>箱子里（${data.items.length} 件）</h3>
        ${byPerson(data.items)
          .map(
            (list) => `<h4 style="margin:10px 0 6px">${escapeHtml(list[0].nickname)} · ${list.length} 件
              <button class="plain small" data-out="${list.map((i) => i.id).join(',')}">整个人拿出来</button></h4>
              <div class="claim-grid wh-grid">${groupSame(list).map((g) => card(g)).join('')}</div>`,
          )
          .join('') || '<p class="empty">还是空箱子</p>'}
      </div>
      <div class="card">
        <h3>等着装箱的拼邮件</h3>
        ${byPerson(data.waiting)
          .map(
            (list) => `<h4 style="margin:10px 0 6px">${escapeHtml(list[0].nickname)} · ${list.length} 件
                <button class="plain small" data-pickall="${list.map((i) => i.id).join(',')}">全选他</button>
                <button class="plain small" data-todirect="${list[0].customerId}" data-name="${escapeHtml(list[0].nickname)}">改直邮</button></h4>
              <div class="claim-grid wh-grid">${groupSame(list).map((g) => card(g, { selectable: true, selected: g.ids.every((x) => picked.has(x)) })).join('')}</div>`,
          )
          .join('') || '<p class="empty">没有等着装箱的</p>'}
        ${data.waiting.length ? `<div class="actionbar" style="margin-top:12px"><button class="btn wh-big" id="add" ${picked.size ? '' : 'disabled'}>装进这个箱子（${picked.size} 件）</button></div>` : ''}
      </div>`;
    const reload = () => renderBox(id);
    const act = (fn) => async (e) => {
      e.preventDefault();
      try {
        await fn(e);
      } catch (err) {
        if (!err.silent) toast(err.message, true);
      }
    };
    view.querySelectorAll('[data-pick]').forEach((el) =>
      el.addEventListener('click', (e) => {
        if (e.target.closest('a,button')) return;
        const ids = el.dataset.pick.split(',').map(Number);
        const on = ids.every((x) => picked.has(x));
        ids.forEach((x) => (on ? picked.delete(x) : picked.add(x)));
        draw();
      }),
    );
    view.querySelectorAll('[data-pickall]').forEach((b) =>
      b.addEventListener('click', () => {
        b.dataset.pickall.split(',').forEach((x) => picked.add(Number(x)));
        draw();
      }),
    );
    view.querySelectorAll('[data-todirect]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (await switchLane(Number(b.dataset.todirect), b.dataset.name, 'direct')) location.hash = `#/customer/${b.dataset.todirect}`;
      }),
    );
    view.querySelectorAll('[data-out]').forEach((b) =>
      b.addEventListener(
        'click',
        act(async () => {
          await api('POST', `/api/wh/boxes/${id}/items`, { itemIds: b.dataset.out.split(',').map(Number), remove: true });
          reload();
        }),
      ),
    );
    document.getElementById('add')?.addEventListener(
      'click',
      act(async () => {
        await api('POST', `/api/wh/boxes/${id}/items`, { itemIds: [...picked] });
        toast(`装进去 ${picked.size} 件`);
        reload();
      }),
    );
    document.getElementById('tn').addEventListener(
      'submit',
      act(async () => {
        await api('PATCH', `/api/wh/boxes/${id}`, { trackingNo: document.getElementById('t').value.trim() });
        toast('回国单号存好了');
        reload();
      }),
    );
    document.getElementById('ship')?.addEventListener(
      'click',
      act(async () => {
        const r = await api('POST', `/api/wh/boxes/${id}/ship`, { returnedAt: document.getElementById('d').value });
        toast(`发出了，${r.count} 件变成「${statusLabel('intl_transit')}」`);
        reload();
      }),
    );
  };
  draw();
}

// ───────── 路由 ─────────
let me = null;

async function route() {
  if (!me) {
    const s = await api('GET', '/api/wh/session').catch(() => ({ loggedIn: false }));
    if (!s.loggedIn) return renderLogin();
    me = s.user;
  }
  nav.hidden = false;
  logoutBtn.hidden = false;
  who.textContent = me.displayName;
  const path = location.hash.replace(/^#/, '') || '/';
  nav.querySelectorAll('a').forEach((a) => {
    const t = a.getAttribute('href').slice(1);
    a.classList.toggle('active', t === '/' ? path === '/' || path.startsWith('/order') || path.startsWith('/customer') : path.startsWith(t) || (t === '/boxes' && path.startsWith('/box')));
  });
  view.innerHTML = '<p class="muted">加载中…</p>';
  try {
    let m;
    if ((m = path.match(/^\/order\/(\d+)(?:\/(\d+))?$/))) await renderOrder(m[1], m[2]);
    else if ((m = path.match(/^\/customer\/(\d+)$/))) await renderCustomer(m[1]);
    else if ((m = path.match(/^\/parcels(?:\/(\d{4}-\d{2}-\d{2}))?$/))) await renderParcels(m[1]);
    else if (path === '/boxes') await renderBoxes();
    else if ((m = path.match(/^\/box\/(\d+)$/))) await renderBox(m[1]);
    else await renderHome();
  } catch (err) {
    if (err.silent) return;
    view.innerHTML = `<div class="card"><p class="unpaid">${escapeHtml(err.message)}</p></div>`;
  }
}

document.addEventListener('click', async (e) => {
  const chip = e.target instanceof Element ? e.target.closest('[data-copy]') : null;
  if (!chip) return;
  e.preventDefault();
  const ok = await copyText(chip.dataset.copy);
  toast(ok ? `已复制 ${chip.dataset.copy}` : '这个浏览器不让复制，手动选一下', !ok);
});

logoutBtn.onclick = async () => {
  await api('POST', '/api/wh/logout').catch(() => {});
  me = null;
  renderLogin('已退出');
};

window.addEventListener('hashchange', route);
route();
