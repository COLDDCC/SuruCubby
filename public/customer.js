import { beijingTime, codeTag, copyText, escapeHtml, money, statusLabel, thumb, toast, yen } from '/shared.js';

const pathToken = (location.pathname.match(/^\/w\/([^/?#]+)/) || [])[1] ?? '';
let token = pathToken ? decodeURIComponent(pathToken) : '';
const app = document.getElementById('app');

/** 重新渲染后要留下的东西：勾过的商品和滚到的位置 */
const keep = { selected: new Set(), scrollY: 0 };

const GROUPS = [
  {
    title: '可发货',
    statuses: ['cn_stock'],
    note: '勾选要寄的商品，选择地址后提交申请。扫码转账后由群主确认。',
  },
  { title: '在日本', statuses: ['ordered', 'jp_warehouse'], note: '' },
  { title: '直邮待付款 / 待寄出', statuses: ['direct_unpaid', 'direct_ready'], note: '运费、寄到哪、单号都在「直邮包裹」里。' },
  { title: '运输中', statuses: ['intl_transit', 'cn_arrived'], note: '' },
  { title: '已寄出 / 已签收', statuses: ['shipped', 'delivered'], note: '' },
];

const REQUEST_LABEL = {
  pending: '待群主确认收款',
  paid: '已收款，等群主寄出',
  shipped: '已寄出',
  cancelled: '已取消',
};

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
  app.classList.remove('wide');
  lastData = null;
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
  app.classList.remove('wide');
  lastData = null;
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
 * 能勾去发货的件，和后端 `POST /:token/requests` 查的一模一样：
 * 可发货、没标缺件、运费已经拆到这一件上。少一条就是点了必被拦，别摆出来让人白点。
 */
function shippableOf(item) {
  return item.status === 'cn_stock' && !item.missing && item.intlFeeFen !== null;
}

function itemCard(item) {
  // 汇总卡按后端口径把取消/退款的件剔掉了，件上就不该再显示「未付」，不然上下两个数对不上
  const dead = item.status === 'cancelled' || item.status === 'refunded';
  const paid = dead
    ? ''
    : item.goodsPaid
      ? '<span class="badge ok">货款已付</span>'
      : '<span class="badge danger">货款未付</span>';
  const missing = item.missing ? '<span class="badge warn">缺件</span>' : '';
  const title = item.productUrl
    ? `<a href="${escapeHtml(item.productUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>`
    : escapeHtml(item.title);
  const note = item.exceptionNote
    ? `<div class="small" style="color:var(--warn)">${escapeHtml(item.exceptionNote)}</div>`
    : '';
  const selectable = shippableOf(item);
  // 已经报过申请的、群主标了缺件的、运费还没拆到这件的都勾不了，得说清楚为什么勾不了
  const picker = selectable
    ? `<label class="pick"><input type="checkbox" data-ship-item="${item.id}" ${item.requestId ? 'disabled' : ''}>${
        item.requestId ? '已申请' : '发货'
      }</label>`
    : '';
  const noFee =
    item.status === 'cn_stock' && !item.missing && item.intlFeeFen === null
      ? '<div class="small muted">这一摞的运费还没拆到这一件上，在群里说一声，群主重算一次分摊就能勾。</div>'
      : '';
  return `
    <div class="item">
      ${picker}
      ${thumb(item)}
      <div class="body">
        <div class="title">${title}</div>
        <div class="small row" style="gap:6px;margin-top:2px">
          ${codeTag(item)}
          ${item.route === 'direct' ? '<span class="badge warn">直邮</span>' : ''}
          <span class="muted">${escapeHtml(item.packageName || item.batchName || '')}</span>
        </div>
        <div class="small muted">
          实际价格 ${yen(item.actualPriceJpy)} ·
          应付 <span class="money">${yen(item.goodsFeeJpy)}</span>
        </div>
        <div class="small row" style="gap:6px;margin-top:4px">
          <span class="badge ${item.status==='cn_stock' ? 'ok' : ''}">${escapeHtml(statusLabel(item.status))}</span>${paid}${missing}
        </div>
        ${item.returnTrackingNo ? `<div class="small">回国单号：<span>${escapeHtml(item.returnTrackingNo)}</span> <button class="small plain" data-copy="${escapeHtml(item.returnTrackingNo)}">复制</button></div>` : ''}
        ${item.orderNo ? `<div class="small muted">日本订单：${escapeHtml(item.orderNo)}</div>` : ''}
        ${item.intlFeeFen === null || dead ? '' : `<div class="small muted">${item.weightG ? `${item.weightG} g` : '整摞均摊'} · 国际运费 ${money(item.intlFeeFen)} ${item.intlPaid ? '已付' : '待付'}</div>`}
        ${item.missing ? '<div class="small muted">这件东西没到齐，发货的时候不会带上它。</div>' : ''}
        ${noFee}
        ${note}
      </div>
    </div>`;
}

/**
 * 一摞的运费：件上的数加起来就是这一摞（分摊确认时是同一份数）。
 * 老账里有的摞只记了摞的钱、没拆到件上，那种就照摞说。
 */
function stackFee(group, items) {
  const live = items.filter(
    (i) => i.weighGroupId === group.id && i.status !== 'cancelled' && i.status !== 'refunded',
  );
  const withFee = live.filter((i) => i.intlFeeFen !== null);
  if (!withFee.length) {
    const total = Number(group.intlFeeFen ?? 0);
    return { total, unpaid: group.feePaid ? 0 : total };
  }
  return {
    total: withFee.reduce((s, i) => s + i.intlFeeFen, 0),
    unpaid: withFee.filter((i) => !i.intlPaid).reduce((s, i) => s + i.intlFeeFen, 0),
  };
}

function addressForm(count) {
  if (count >= 3) return '<p class="small muted">地址最多 3 个。要换就先删掉一个再填新的。</p>';
  return `
    <label for="recipient">收件人</label>
    <input id="recipient" maxlength="100" placeholder="收件人姓名">
    <label for="phone">电话</label>
    <input id="phone" maxlength="40" inputmode="tel" placeholder="手机号">
    <label for="detail">详细地址</label>
    <input id="detail" maxlength="500" placeholder="省市区 + 小区门牌，写全一点">
    <p><button id="add-address">保存地址</button></p>`;
}

/** 勾了东西才给提交；一件都勾不了的时候别杵着一个死按钮。 */
function shipPanel(data) {
  const addresses = data.addresses || [];
  const items = data.items || [];
  // 群主标了「这一批你自己带回国 / 另找转运」：这一栏整个就不归我们管了，摆着只会让人瞎勾
  if (data.customer?.selfReturn) {
    return `
    <div class="card">
      <h2>发货</h2>
      <p class="small">群主把你这一批标成了「不拼邮」，后面的称重、国际运费和国内快递都不走我们这条线，货款照旧按下单表算。
        要是改主意要跟群里一起拼回来，在群里说一声，群主在后台改回来这里就恢复了。</p>
      ${
        addresses.length
          ? `<p class="small muted" style="margin:0 0 4px">已经存过的收货地址</p>
             ${addresses
               .map(
                 (a) =>
                   `<p class="small" style="margin:2px 0">${escapeHtml(a.recipient)} · ${escapeHtml(a.phone)} · ${escapeHtml(a.detail)}</p>`,
               )
               .join('')}`
          : ''
      }
    </div>`;
  }
  const shippable = items.filter(shippableOf);
  const open = shippable.filter((i) => !i.requestId);

  // 初始密码下后端拦住一切写操作，填地址、提交都会撞 403 —— 那就别放按钮，只指上面那条横幅
  if (data.mustChange) {
    return `
    <div class="card">
      <h2>申请发货</h2>
      <p class="small">先把上面那个共用的初始密码改成你自己的，这一栏才让填地址、勾商品。</p>
      ${
        addresses.length
          ? `<p class="small muted" style="margin:0 0 4px">已经存过的收货地址</p>
             ${addresses
               .map(
                 (a) =>
                   `<p class="small" style="margin:2px 0">${escapeHtml(a.recipient)} · ${escapeHtml(a.phone)} · ${escapeHtml(a.detail)}</p>`,
               )
               .join('')}`
          : ''
      }
    </div>`;
  }

  // 一件东西都还没有的新客户：给他地址表单只会让人瞎填
  if (!items.length && !addresses.length) return '';

  const rows = addresses.map(
    (a) => `<label class="row">
      <input name="ship-address" type="radio" value="${a.id}" ${addresses.length === 1 ? 'checked' : ''}>
      <span>${escapeHtml(a.recipient)} · ${escapeHtml(a.phone)} · ${escapeHtml(a.detail)}</span>
      <button class="small plain" data-delete-address="${a.id}">删除</button>
    </label>`,
  );
  let hint = '';
  if (!open.length) {
    hint = shippable.length
      ? '<p class="small muted">能发的几件都已经报过申请了，等群主确认收款。</p>'
      : items.length
        ? '<p class="small muted">现在还没有能发的商品。东西到国内、群主算完运费，这里就会让你勾。</p>'
        : '<p class="small muted">群主还没把你买的东西录进仓库。录进来这一页自己会更新，不用你做什么。</p>';
  } else if (!rows.length) {
    hint = '<p class="small muted">还没有收货地址，填一个保存后勾选的商品才提交得了。</p>';
  }
  return `
    <div class="card">
      <h2>申请发货</h2>
      <p class="small muted" style="margin:0 0 4px">收货地址（最多 3 个）</p>
      ${rows.join('')}
      ${addressForm(addresses.length)}
      ${hint}
    </div>`;
}

function addressLine(a) {
  if (!a) return '';
  if (a.raw) return a.raw;
  return [a.recipient, a.phone, a.detail].filter(Boolean).join(' · ');
}

const PARCEL_HINT = {
  packing: '日本仓正在打包，称好重量后这里会显示运费。',
  awaiting_payment: '按显示的运费扫码转给群主，群主确认后日本仓就寄出。',
  paid: '运费已收到，等日本仓寄出，寄出后这里会出单号。',
  shipped: '已经从日本寄出了，复制单号去查物流。',
  delivered: '已签收。',
};

/** 直邮包裹：每一包的状态、运费、单号、寄到哪、里面是哪几本。 */
function directParcelsHtml(data) {
  const parcels = data.directParcels || [];
  if (!parcels.length) return '';
  return `<div class="card">
    <h2>直邮包裹<span class="muted small"> · ${parcels.length} 包</span></h2>
    ${parcels
      .map(
        (p) => `<div class="item" style="display:block">
          <div class="row" style="justify-content:space-between">
            <strong>${escapeHtml(p.statusLabel)}</strong>
            ${
              p.feeFen !== null
                ? `<span class="money ${p.status === 'awaiting_payment' ? 'unpaid' : 'paid'}">${money(p.feeFen)} ${p.status === 'awaiting_payment' ? '待付' : '已付'}</span>`
                : ''
            }
          </div>
          ${
            p.trackingNo
              ? `<div class="row" style="gap:6px;margin-top:4px"><span class="small muted">${escapeHtml(p.carrier || '国际单号')}</span>
                  <b>${escapeHtml(p.trackingNo)}</b> <button class="small plain" data-copy="${escapeHtml(p.trackingNo)}">复制</button></div>`
              : ''
          }
          ${p.weightG ? `<div class="kv"><span>重量</span><b>${Number(p.weightG).toLocaleString()} g</b></div>` : ''}
          ${p.weightG ? `<div class="kv"><span>单价</span><b>${money(p.rateFenPerKg)} / kg</b></div>` : ''}
          <div class="small muted" style="margin-top:4px">寄到：${escapeHtml(addressLine(p.address))}</div>
          <div class="small" style="margin-top:6px">这一包里有 ${p.items.length} 件：</div>
          <ul class="small" style="margin:2px 0 0;padding-left:18px">${p.items.map((i) => `<li>${escapeHtml(i.title)}</li>`).join('')}</ul>
          <p class="small muted" style="margin:6px 0 0">${PARCEL_HINT[p.status] ?? ''}</p>
        </div>`,
      )
      .join('')}
  </div>`;
}

/**
 * 直邮寄到哪：只在「有直邮的件还没打包、导入表里也没写地址」时出现。
 * 只有一个地址时自动用它，这一栏只是告诉客户一声。
 */
function directAddressPanel(data) {
  if (data.mustChange) return '';
  const waiting = (data.items || []).filter(
    (i) => i.route === 'direct' && !i.directParcelId && !i.hasImportAddress && ['ordered', 'jp_warehouse'].includes(i.status),
  );
  if (!waiting.length) return '';
  const addresses = data.addresses || [];
  const chosen = data.customer?.directAddressId;
  let body;
  if (!addresses.length) {
    body = '<p class="small unpaid">你还没有收货地址。在下面「申请发货」那里先存一个地址，日本仓才能给你打包。</p>';
  } else if (addresses.length === 1) {
    body = `<p class="small">会寄到：${escapeHtml(addressLine(addresses[0]))}</p>
      <p class="small muted">只存了一个地址就自动用它；想换就先在下面加一个新地址，再回来选。</p>`;
  } else {
    body = addresses
      .map(
        (a) => `<label class="row"><input type="radio" name="direct-address" value="${a.id}" ${a.id === chosen ? 'checked' : ''}>
          <span class="small">${escapeHtml(addressLine(a))}</span></label>`,
      )
      .join('');
    if (!addresses.some((a) => a.id === chosen)) body += '<p class="small unpaid">选一个，日本仓才能打包。</p>';
  }
  return `<div class="card">
    <h2>直邮寄到哪</h2>
    <p class="small muted" style="margin-top:0">你有 ${waiting.length} 件是从日本直接寄给你的（不跟拼团回国）。</p>
    ${body}
  </div>`;
}

/**
 * 底部常驻的结算条：手机上要翻着勾几十件，合计和提交按钮得一直看得见，
 * 藏在面板里就得来回滚（抄的 ShipLocker / fish-groupbuy-order 那套底部条做法）。
 * 勾不了件、或者还没地址时不出现——不摆点不动的按钮。
 */
function shipBar(data) {
  if (data.mustChange || data.customer?.selfReturn) return '';
  const items = data.items || [];
  const open = items.filter((i) => shippableOf(i) && !i.requestId);
  if (!open.length || !(data.addresses || []).length) return '';
  return `
    <div class="shipbar">
      <div class="shipbar-inner${WIDE.matches ? ' wide' : ''}">
        <div class="total" id="shipping-total">勾上要寄的商品</div>
        <button id="request-shipping" disabled>提交发货申请</button>
      </div>
    </div>`;
}

/**
 * 宽屏（电脑）两栏：左边是东西，右边常驻发货面板，勾完不用往下翻；
 * 手机一栏，「可发货」和「申请发货」紧挨着。跨过断点（转屏、拉窗口）时按当前数据重画一次。
 */
const WIDE = window.matchMedia('(min-width: 1100px)');
let lastData = null;
WIDE.addEventListener('change', () => {
  if (lastData) render(lastData);
});

function render(data) {
  lastData = data;
  const wide = WIDE.matches;
  app.classList.toggle('wide', wide);
  // 增删地址会整页重画，勾过的商品和滚到的位置得留住
  keep.scrollY = window.scrollY;
  keep.selected = new Set(
    [...app.querySelectorAll('[data-ship-item]:checked')].map((el) => Number(el.dataset.shipItem)),
  );

  const s = data.summary;
  const items = data.items || [];
  const shownStatuses = new Set(GROUPS.flatMap((g) => g.statuses));
  const closed = items.filter((i) => !shownStatuses.has(i.status));

  // 「可发货」那一组紧贴着发货面板，勾完就能提交；别让它被其它组隔开
  const stockGroup = GROUPS.find((g) => g.statuses.includes('cn_stock'));
  const stockHtml = (() => {
    const list = items.filter((i) => stockGroup.statuses.includes(i.status));
    if (list.length === 0) return '';
    return `
      <div class="card">
        <h2>${stockGroup.title}<span class="muted small"> · ${list.length} 件</span></h2>
        ${stockGroup.note ? `<p class="small muted">${stockGroup.note}</p>` : ''}
        ${list.map(itemCard).join('')}
      </div>`;
  })();
  const groupsHtml = GROUPS.filter((g) => g !== stockGroup)
    .map((group) => {
      const list = items.filter((i) => group.statuses.includes(i.status));
      if (list.length === 0) return '';
      return `
      <div class="card">
        <h2>${group.title}<span class="muted small"> · ${list.length} 件</span></h2>
        ${group.note ? `<p class="small muted">${group.note}</p>` : ''}
        ${list.map(itemCard).join('')}
      </div>`;
    })
    .join('');

  const intlHtml = (data.weighGroups || []).length
    ? `<div class="card">
        <h2>国际运费</h2>
        ${data.weighGroups
          .map((g) => {
            const fee = stackFee(g, items);
            // 整摞都没付时别再写两遍一样的数
            const shown = fee.unpaid
              ? fee.unpaid === fee.total
                ? `${money(fee.total)} 待付`
                : `${money(fee.total)} 待付 ${money(fee.unpaid)}`
              : `${money(fee.total)} 已付`;
            return `
          <div class="item" style="display:block">
            <div class="row" style="justify-content:space-between">
              <strong>${escapeHtml(g.packageName)}</strong>
            </div>
            <div class="kv"><span>你这一摞重量</span><b>${Number(g.weightG || 0).toLocaleString()} g</b></div>
            <div class="kv"><span>件数</span><b>${g.items.length} 件</b></div>
            <div class="kv"><span>这一摞国际运费</span><b class="${fee.unpaid ? 'unpaid' : 'paid'} money">${shown}</b></div>
            <details class="small"><summary>看看是哪些东西</summary>
              <ul>${g.items.map((i) => `<li>${escapeHtml(i.title)}</li>`).join('')}</ul>
            </details>
          </div>`;
          })
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
              <strong>${
                s2.trackingNo
                  ? `${escapeHtml(s2.trackingNo)} <button class="small plain" data-copy="${escapeHtml(s2.trackingNo)}">复制</button>`
                  : '单号待填'
              }</strong>
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

  const requestsHtml = (data.requests || []).length
    ? `<div class="card">
        <h2>发货申请</h2>
        ${data.requests
          .map((r) => {
            let to = '';
            try {
              const a = JSON.parse(r.addressSnapshot);
              if (a && a.recipient) to = `${a.recipient} ${a.phone || ''} ${a.detail || ''}`;
            } catch {
              /* 快照不是 JSON 就别让整页白屏 */
            }
            const list = items.filter((i) => i.requestId === r.id);
            return `<div class="item" style="display:block">
              <div class="row" style="justify-content:space-between">
                <strong>#${r.id} · ${r.itemCount} 件 · ${escapeHtml(REQUEST_LABEL[r.status] || r.status)}</strong>
                <span class="money">${money(r.domesticFeeFen)} 国内运费</span>
              </div>
              <div class="small muted">${beijingTime(r.createdAt)}${to ? ` · 寄到 ${escapeHtml(to)}` : ''}</div>
              ${list.length ? `<details class="small"><summary>看看申请了哪些</summary><ul>${list
                .map((i) => `<li>${escapeHtml(i.title)}${
                  i.intlPaid || i.status === 'cancelled' || i.status === 'refunded'
                    ? ''
                    : ` · 国际运费 ${money(i.intlFeeFen ?? 0)} 待付`
                }</li>`)
                .join('')}</ul></details>` : ''}
              ${r.status === 'pending' ? `<p><button class="small plain" data-cancel-request="${r.id}">取消申请</button></p>` : ''}
            </div>`;
          })
          .join('')}
        <p class="small muted">国际运费在上面「国际运费」那一摞里一起算，这里只列国内运费。</p>
       </div>`
    : '';

  const directHtml = directParcelsHtml(data);
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

  const pwNotice = data.mustChange
    ? `<div class="card" style="border-color:var(--warn);background:var(--warn-bg)">
        <h2>密码还是大家共用的那个初始密码</h2>
        <p class="small">谁都知道这个密码，别人填你的 QQ 就能登进来。改成只有你知道的才能下单、填地址（改完要重新登一次）。</p>
        <button id="change-pw">改密码</button>
       </div>`
    : '';

  const barHtml = shipBar(data);

  app.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h1 style="margin:0">${escapeHtml(data.customer.nickname)} 的仓库</h1>
        <span class="row small muted">${items.length} 件 <button id="logout" class="small plain">退出登录</button></span>
      </div>
      <div class="grid" style="margin-top:12px">
        <div class="stat"><div class="label">货款待付（日元）</div><div class="value money">${yen(s.goodsUnpaidJpy)}</div></div>
        <div class="stat"><div class="label">国际运费待付</div><div class="value money">${money(s.intlUnpaidFen)}</div></div>
        ${
          s.directUnpaidFen
            ? `<div class="stat"><div class="label">直邮运费待付</div><div class="value money">${money(s.directUnpaidFen)}</div></div>`
            : `<div class="stat"><div class="label">国内运费待付</div><div class="value money">${money(s.domesticUnpaidFen)}</div></div>`
        }
        <div class="stat big"><div class="label">运费待付</div><div class="value money" ${
          s.freightUnpaidFen ? '' : 'style="color:var(--ok)"'
        }>${money(s.freightUnpaidFen)}</div></div>
      </div>
      <p class="small muted" style="margin-bottom:0">货款是日元，转账当天按汇率折成人民币给群主；运费是人民币。${
        s.stockCount
          ? `可发货 ${s.stockCount} 件，随时可以要求发货。`
          : items.length
            ? '现在还没有能发的商品——东西回到国内、群主把运费算好，这一页就会让你勾。'
            : '群主还没把你买的东西录进仓库，录进来之后这一页自己会更新。'
      }</p>
    </div>
    ${pwNotice}
    ${
      wide
        ? `<div class="cols">
            <div class="main">${stockHtml}${directHtml}${groupsHtml}${intlHtml}${shipHtml}${closedHtml}${timelineHtml}</div>
            <aside class="side">${directAddressPanel(data)}${shipPanel(data)}${requestsHtml}</aside>
          </div>`
        : `${directHtml}${directAddressPanel(data)}${stockHtml}${shipPanel(data)}${requestsHtml}${groupsHtml}${intlHtml}${shipHtml}${closedHtml}${timelineHtml}`
    }
    <p class="small muted">金额有疑问就在群里问一声。页面刷新后更新。</p>
    ${barHtml}`;
  bindWarehouse(data);
  document.body.classList.toggle('has-shipbar', barHtml !== '');

  app.querySelectorAll('[data-ship-item]').forEach((el) => {
    if (!el.disabled && keep.selected.has(Number(el.dataset.shipItem))) el.checked = true;
  });
  keep.selected = new Set(
    [...app.querySelectorAll('[data-ship-item]:checked')].map((el) => Number(el.dataset.shipItem)),
  );
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
 app.querySelectorAll('[data-copy]').forEach(el=>el.onclick=handle(async()=>{if(!await copyText(el.dataset.copy))throw Error('这个浏览器不让网页复制，手动选中单号拷一下');toast('单号已复制');}));
 app.querySelectorAll('[data-delete-address]').forEach(el=>el.onclick=handle(()=>send(`/addresses/${el.dataset.deleteAddress}`,'DELETE')));
 app.querySelectorAll('[data-cancel-request]').forEach(el=>el.onclick=handle(()=>send(`/requests/${el.dataset.cancelRequest}`,'DELETE')));
 app.querySelectorAll('input[name="direct-address"]').forEach(el=>el.onchange=handle(()=>send('/direct-address','POST',{addressId:Number(el.value)})));
 const changePw=app.querySelector('#change-pw');if(changePw)changePw.onclick=()=>renderMustChange(data);
 const logout=app.querySelector('#logout');
 // 退出不走 send()：那玩意会立刻重新拉一次仓库，白跑一趟还先把页面画出来
 if(logout)logout.onclick=handle(async()=>{await api(`${endpoint}/logout`,{method:'POST'});token='';history.replaceState(null,'','/login');renderVerify('已经退出了，再进来要用 QQ 号和密码','ok');});
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
