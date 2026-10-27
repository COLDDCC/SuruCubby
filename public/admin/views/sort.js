import { api } from '/admin/api.js';
import { confirmBox, escapeHtml, itemCode, money, thumb, toast } from '/admin/ui.js';
import { bindItemDetails } from '/admin/itemDetail.js';

/**
 * 分拣页：东西铺在地上，照着卡片找人。
 *   第一步「找」：每件一张大图卡片，图下白底黑字写 cn；拿起一件、点它的卡片 = 找到了（绿色打勾），再点取消。
 *                 勾选存在服务器上，两个人拿两台手机一起分也对得上；每 15 秒自动同步一次别人点的。
 *   第二步「核对」：直邮按人填 EMS 单号 + 整包重量；拼团分进第 1…N 箱、填回国单号；没找到的选「标缺件」或「先留着」。
 *   发送：一次落定，跳到结果页（可复制发群）。
 */

let poller = 0;

function query() {
  return new URLSearchParams(location.hash.split('?')[1] ?? '');
}

function storeKey(batchId, tn) {
  return `sc-sort:${batchId}:${tn || ''}`;
}
function loadDraft(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function saveDraft(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式存不了就算了，只是少个草稿 */
  }
}

/** 按人分组，保持后端给的顺序（cn 排序）。 */
function people(items) {
  const map = new Map();
  for (const i of items) {
    const p = map.get(i.customerId) ?? { customerId: i.customerId, cn: i.cn, qq: i.qq, nickname: i.nickname, route: i.route, selfReturn: i.selfReturn, items: [] };
    p.items.push(i);
    map.set(i.customerId, p);
  }
  return [...map.values()];
}

function card(i) {
  const code = itemCode(i.productUrl);
  return `<div class="sort-card${i.found ? ' found' : ''}${i.route === 'direct' ? ' is-direct' : ''}" role="button" tabindex="0"
      data-id="${i.id}" data-search="${escapeHtml(`${code} ${i.title} ${i.cn} ${i.nickname} ${i.qq}`.toLowerCase())}" aria-pressed="${i.found}">
    <div class="sort-img">${thumb(i)}</div>
    <div class="cn-box">${escapeHtml(i.cn)}</div>
    <div class="sort-meta">
      <span class="badge ${i.route === 'direct' ? 'warn' : ''}">${i.route === 'direct' ? '直邮' : i.selfReturn ? '不拼邮' : '拼团'}</span>
      ${code ? `<span class="mono">${escapeHtml(code)}</span>` : ''}
      ${i.missing ? '<span class="badge danger">上次没找到</span>' : ''}
    </div>
    <div class="sort-title">${escapeHtml(i.title)}</div>
    <div class="sort-foot"><span class="small muted">QQ ${escapeHtml(i.qq)}</span>
      <button type="button" class="small plain" data-detail="${i.id}">详情</button></div>
    <span class="sort-check" aria-hidden="true">✓</span>
  </div>`;
}

export async function render(view, [batchId]) {
  clearInterval(poller);
  const tnParam = query().get('tn') || '';
  const data = await api.get(`/api/staff/sort/${batchId}${tnParam ? `?tn=${encodeURIComponent(tnParam)}` : ''}`);
  const key = storeKey(batchId, data.trackingNo);
  const draft = loadDraft(key) ?? {};
  const state = {
    mode: 'pick',
    filter: 'all',
    q: '',
    trackingNo: data.trackingNo || draft.trackingNo || (data.items.every((i) => !i.jpTrackingNo) ? data.batch.japanTrackingNo || '' : ''),
    boxes: draft.boxes ?? [{ trackingNo: '' }],
    pileBox: draft.pileBox ?? {},
    itemBox: draft.itemBox ?? {},
    direct: draft.direct ?? {},
    missing: draft.missing ?? {},
  };
  const items = data.items;
  const byId = new Map(items.map((i) => [i.id, i]));
  const persist = () =>
    saveDraft(key, { trackingNo: state.trackingNo, boxes: state.boxes, pileBox: state.pileBox, itemBox: state.itemBox, direct: state.direct, missing: state.missing });

  const counts = () => ({ found: items.filter((i) => i.found).length, total: items.length });

  // ───── 第一步：找 ─────
  function renderPick() {
    const c = counts();
    view.innerHTML = `
      <div class="card sort-head">
        <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap">
          <div style="min-width:0">
            <h2 style="margin:0">${escapeHtml(data.batch.name)}</h2>
            <p class="small muted" style="margin:4px 0 0">日本订单 <b>${escapeHtml(data.batch.orderNo || '—')}</b> · 下单 ${escapeHtml(data.batch.orderedAt || '—')}${
              data.trackingNo ? ` · 日本运单 <b class="mono">${escapeHtml(data.trackingNo)}</b>` : ''
            }</p>
          </div>
          <a class="small nowrap" href="#/jp">← 待分拣</a>
        </div>
        ${
          data.trackingNo
            ? ''
            : `<label for="sort-tn">这一箱的日本运单号</label>
               <input id="sort-tn" class="mono" value="${escapeHtml(state.trackingNo)}" placeholder="开箱看面单上的号码（可不填）">`
        }
        <details class="small muted" style="margin-top:6px"><summary>怎么分</summary>
          拿起一件，点它的卡片（变绿打勾）就是找到了，放到卡片上白框里写的那个人那一堆；点错了再点一下取消。
          两个人一起分也行，别人点的 15 秒内同步过来。全部找完点下面「核对并发送」。</details>
      </div>
      <div class="sort-tools">
        <input id="sort-q" inputmode="search" placeholder="搜货号尾号 / 商品名 / cn / QQ" value="${escapeHtml(state.q)}" autocomplete="off">
        <div class="seg">
          <button data-filter="all" class="${state.filter === 'all' ? 'active' : ''}">全部 ${c.total}</button>
          <button data-filter="todo" class="${state.filter === 'todo' ? 'active' : ''}">没找到 <span id="cnt-todo">${c.total - c.found}</span></button>
          <button data-filter="found" class="${state.filter === 'found' ? 'active' : ''}">已找到 <span id="cnt-found">${c.found}</span></button>
        </div>
      </div>
      ${
        items.length
          ? `<div class="sort-grid">${items.map(card).join('')}</div>`
          : '<div class="card"><p class="empty">这一箱没有要分的件了。</p></div>'
      }
      <div class="sort-bar">
        <div class="sort-bar-inner">
          <div><b id="bar-found">${c.found}</b> / ${c.total} 件找到了</div>
          <button id="to-review" ${c.found ? '' : 'disabled'}>核对并发送 →</button>
        </div>
      </div>`;
    document.body.classList.add('has-sortbar');

    const applyFilter = () => {
      const q = state.q.trim().toLowerCase();
      view.querySelectorAll('.sort-card').forEach((el) => {
        const i = byId.get(Number(el.dataset.id));
        const show =
          (state.filter === 'all' || (state.filter === 'found') === !!i.found) && (!q || el.dataset.search.includes(q));
        el.hidden = !show;
      });
    };
    const refreshCounts = () => {
      const now = counts();
      view.querySelector('#cnt-todo').textContent = now.total - now.found;
      view.querySelector('#cnt-found').textContent = now.found;
      view.querySelector('#bar-found').textContent = now.found;
      view.querySelector('#to-review').disabled = !now.found;
    };
    const paint = (i) => {
      const el = view.querySelector(`.sort-card[data-id="${i.id}"]`);
      if (!el) return;
      el.classList.toggle('found', !!i.found);
      el.setAttribute('aria-pressed', String(!!i.found));
    };

    view.querySelectorAll('.sort-card').forEach((el) => {
      const toggle = async () => {
        const i = byId.get(Number(el.dataset.id));
        i.found = !i.found;
        paint(i);
        refreshCounts();
        if (state.filter !== 'all') applyFilter();
        try {
          await api.post('/api/staff/sort/mark', { itemIds: [i.id], found: i.found });
        } catch (err) {
          i.found = !i.found;
          paint(i);
          refreshCounts();
          toast(err.message, true);
        }
      };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });
    bindItemDetails(view);
    view.querySelectorAll('[data-filter]').forEach((b) => {
      b.onclick = () => {
        state.filter = b.dataset.filter;
        view.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
        applyFilter();
      };
    });
    const qInput = view.querySelector('#sort-q');
    qInput.oninput = () => {
      state.q = qInput.value;
      applyFilter();
    };
    const tnInput = view.querySelector('#sort-tn');
    if (tnInput) {
      tnInput.oninput = () => {
        state.trackingNo = tnInput.value.trim();
        persist();
      };
    }
    view.querySelector('#to-review').onclick = () => {
      state.mode = 'review';
      renderReview();
      window.scrollTo(0, 0);
    };
    applyFilter();

    // 别的设备点的也同步过来（只改勾选状态，不打断正在输入的搜索）
    poller = setInterval(async () => {
      if (!document.body.contains(view.querySelector('.sort-grid') || document.createElement('i')) || state.mode !== 'pick') return;
      if (document.hidden) return;
      try {
        const fresh = await api.get(`/api/staff/sort/${batchId}${data.trackingNo ? `?tn=${encodeURIComponent(data.trackingNo)}` : ''}`);
        let changed = false;
        for (const f of fresh.items) {
          const i = byId.get(f.id);
          if (i && i.found !== f.found) {
            i.found = f.found;
            paint(i);
            changed = true;
          }
        }
        if (changed) {
          refreshCounts();
          applyFilter();
        }
      } catch {
        /* 网络抖一下就下次再同步 */
      }
    }, 15000);
  }

  // ───── 第二步：核对 ─────
  function renderReview() {
    clearInterval(poller);
    const found = items.filter((i) => i.found);
    const notFound = items.filter((i) => !i.found);
    const directPeople = people(found.filter((i) => i.route === 'direct'));
    const groupPeople = people(found.filter((i) => i.route === 'group' && !i.selfReturn));
    const selfPeople = people(found.filter((i) => i.route === 'group' && i.selfReturn));
    if (!groupPeople.length) state.boxes = [];
    else if (!state.boxes.length) state.boxes = [{ trackingNo: '' }];
    const n = state.boxes.length;
    const clamp = (k) => Math.min(Math.max(Number(k) || 1, 1), Math.max(n, 1));
    const boxOfItem = (i) => clamp(state.itemBox[i.id] ?? state.pileBox[i.customerId] ?? 1);
    const rate = data.directPriceFenPerKg;

    const directHtml = directPeople.length
      ? directPeople
          .map((p) => {
            const addr = data.directAddresses[p.customerId] ?? { ready: false, text: null };
            const pile = state.direct[p.customerId] ?? {};
            const w = Number(pile.weightG);
            return `<div class="pile" data-direct="${p.customerId}">
              <div class="pile-head"><span class="cn-chip">${escapeHtml(p.cn)}</span>
                <span class="small muted">QQ ${escapeHtml(p.qq)} · ${p.items.length} 件</span></div>
              <ul class="small pile-items">${p.items.map((i) => `<li>${escapeHtml(i.title)} <span class="mono muted">${escapeHtml(itemCode(i.productUrl))}</span></li>`).join('')}</ul>
              ${
                addr.ready
                  ? `<div class="addr small"><span class="muted">寄到</span> ${escapeHtml(addr.text || '')}</div>
                     <div class="form-grid" style="margin-top:6px">
                       <div><label>EMS 单号</label><input class="mono" data-direct-tn="${p.customerId}" value="${escapeHtml(pile.trackingNo || '')}" placeholder="EB…JP（可后补）"></div>
                       <div><label>整包重量（克）</label><input inputmode="numeric" data-direct-w="${p.customerId}" value="${escapeHtml(pile.weightG ?? '')}" placeholder="打好包称一下"></div>
                     </div>
                     <p class="small" data-fee="${p.customerId}">${w > 0 ? `运费 <b>${money(Math.ceil((w * rate) / 1000))}</b>（${money(rate)} / kg），客户付了才能寄` : `<span class="muted">填了重量就按 ${money(rate)} / kg 算运费</span>`}</p>`
                  : `<p class="small unpaid">${escapeHtml(addr.text || '还没有收货地址')}——这几件先找出来放一边，等客户填好地址再在「待打包直邮」里打包。</p>`
              }
            </div>`;
          })
          .join('')
      : '<p class="small muted">这一箱没有直邮的件。</p>';

    const boxOptions = (k) =>
      state.boxes.map((_, idx) => `<option value="${idx + 1}" ${k === idx + 1 ? 'selected' : ''}>第 ${idx + 1} 箱</option>`).join('');
    const boxesHtml = groupPeople.length
      ? `<div class="boxes">${state.boxes
          .map((b, idx) => {
            const inBox = groupPeople.flatMap((p) => p.items).filter((i) => boxOfItem(i) === idx + 1);
            return `<div class="box-row">
              <b>第 ${idx + 1} 箱</b>
              <input class="mono" data-box-tn="${idx}" value="${escapeHtml(b.trackingNo || '')}" placeholder="回国单号">
              <span class="small muted">${inBox.length} 件 · ${new Set(inBox.map((i) => i.customerId)).size} 人</span>
              ${n > 1 ? `<button class="small plain" data-del-box="${idx}">删掉</button>` : ''}
            </div>`;
          })
          .join('')}
          ${n < data.maxBoxes ? `<button class="small" id="add-box">＋ 再开一箱</button>` : `<span class="small muted">最多 ${data.maxBoxes} 箱（设置里能改）</span>`}
        </div>
        ${groupPeople
          .map((p) => {
            const mixed = new Set(p.items.map(boxOfItem)).size > 1;
            return `<div class="pile">
              <div class="pile-head"><span class="cn-chip">${escapeHtml(p.cn)}</span>
                <span class="small muted">QQ ${escapeHtml(p.qq)} · ${p.items.length} 件</span>
                ${n > 1 ? `<select data-pile-box="${p.customerId}">${mixed ? '<option value="">分在几箱里</option>' : ''}${boxOptions(mixed ? 0 : boxOfItem(p.items[0]))}</select>` : ''}
              </div>
              ${
                n > 1
                  ? `<details ${mixed ? 'open' : ''}><summary class="small">一件件分</summary>
                      ${p.items
                        .map(
                          (i) => `<div class="row small" style="justify-content:space-between;margin:4px 0">
                            <span>${escapeHtml(i.title)}</span><select data-item-box="${i.id}">${boxOptions(boxOfItem(i))}</select></div>`,
                        )
                        .join('')}</details>`
                  : `<ul class="small pile-items">${p.items.map((i) => `<li>${escapeHtml(i.title)}</li>`).join('')}</ul>`
              }
            </div>`;
          })
          .join('')}`
      : '<p class="small muted">这一箱没有拼团的件。</p>';

    const missingHtml = notFound.length
      ? notFound
          .map(
            (i) => `<div class="row small miss-row">
              <span class="cn-chip">${escapeHtml(i.cn)}</span><span style="flex:1;min-width:0">${escapeHtml(i.title)}</span>
              <label class="row"><input type="radio" name="m-${i.id}" value="keep" ${state.missing[i.id] !== 'missing' ? 'checked' : ''} data-miss="${i.id}"> 先留着</label>
              <label class="row"><input type="radio" name="m-${i.id}" value="missing" ${state.missing[i.id] === 'missing' ? 'checked' : ''} data-miss="${i.id}"> 标缺件</label>
            </div>`,
          )
          .join('')
      : '<p class="small paid">全部找到了。</p>';

    view.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h2 style="margin:0">核对：${escapeHtml(data.batch.name)}</h2>
          <button class="small plain" id="back-pick">← 回去接着找</button>
        </div>
        <p class="small muted" style="margin:6px 0 0">日本运单 <b class="mono">${escapeHtml(state.trackingNo || '没填')}</b> · 找到 ${found.length} 件，没找到 ${notFound.length} 件</p>
      </div>
      <div class="review-cols">
        <div class="card"><h3>直邮 <span class="small muted">${directPeople.length} 人，一人一包</span></h3>${directHtml}</div>
        <div class="card"><h3>拼团 <span class="small muted">${groupPeople.length} 人</span></h3>${boxesHtml}
          ${selfPeople.length ? `<p class="small muted">不拼邮（自己带回国）：${selfPeople.map((p) => `${escapeHtml(p.cn)} ${p.items.length} 件`).join('、')}——只签收，不进箱。</p>` : ''}</div>
      </div>
      <div class="card"><h3>没找到的 <span class="small muted">${notFound.length} 件</span></h3>
        <p class="small muted">「先留着」：下一箱到了还会出现在分拣页；「标缺件」：告诉管理员这件没到。</p>${missingHtml}</div>
      <div class="sort-bar"><div class="sort-bar-inner">
        <div class="small">直邮 ${directPeople.length} 包 · 拼团 ${state.boxes.length} 箱 · 缺件 ${Object.values(state.missing).filter((v) => v === 'missing').length}</div>
        <button id="send">发送</button>
      </div></div>`;

    const rerender = () => {
      persist();
      const y = window.scrollY;
      renderReview();
      window.scrollTo(0, y);
    };
    view.querySelector('#back-pick').onclick = () => {
      state.mode = 'pick';
      renderPick();
    };
    view.querySelectorAll('[data-direct-tn]').forEach((el) => {
      el.oninput = () => {
        (state.direct[el.dataset.directTn] ??= {}).trackingNo = el.value.trim();
        persist();
      };
    });
    view.querySelectorAll('[data-direct-w]').forEach((el) => {
      el.oninput = () => {
        const id = el.dataset.directW;
        (state.direct[id] ??= {}).weightG = el.value.trim();
        persist();
        const w = Number(el.value);
        view.querySelector(`[data-fee="${id}"]`).innerHTML =
          w > 0 ? `运费 <b>${money(Math.ceil((w * rate) / 1000))}</b>（${money(rate)} / kg），客户付了才能寄` : `<span class="muted">填了重量就按 ${money(rate)} / kg 算运费</span>`;
      };
    });
    view.querySelectorAll('[data-box-tn]').forEach((el) => {
      el.oninput = () => {
        state.boxes[Number(el.dataset.boxTn)].trackingNo = el.value.trim();
        persist();
      };
    });
    view.querySelector('#add-box')?.addEventListener('click', () => {
      state.boxes.push({ trackingNo: '' });
      rerender();
    });
    view.querySelectorAll('[data-del-box]').forEach((el) => {
      el.onclick = () => {
        const k = Number(el.dataset.delBox) + 1;
        state.boxes.splice(k - 1, 1);
        // 删掉的那箱里的东西退回第 1 箱，后面的箱号往前挪
        const shift = (v) => (v === k ? 1 : v > k ? v - 1 : v);
        for (const key of Object.keys(state.pileBox)) state.pileBox[key] = shift(state.pileBox[key]);
        for (const key of Object.keys(state.itemBox)) state.itemBox[key] = shift(state.itemBox[key]);
        rerender();
      };
    });
    view.querySelectorAll('[data-pile-box]').forEach((el) => {
      el.onchange = () => {
        if (!el.value) return;
        const cid = el.dataset.pileBox;
        state.pileBox[cid] = Number(el.value);
        for (const i of items.filter((x) => String(x.customerId) === cid)) delete state.itemBox[i.id];
        rerender();
      };
    });
    view.querySelectorAll('[data-item-box]').forEach((el) => {
      el.onchange = () => {
        state.itemBox[el.dataset.itemBox] = Number(el.value);
        rerender();
      };
    });
    view.querySelectorAll('[data-miss]').forEach((el) => {
      el.onchange = () => {
        state.missing[el.dataset.miss] = el.value;
        persist();
      };
    });

    view.querySelector('#send').onclick = async (e) => {
      const btn = e.currentTarget;
      const groupItems = groupPeople.flatMap((p) => p.items);
      const empty = state.boxes.findIndex((_, idx) => !groupItems.some((i) => boxOfItem(i) === idx + 1));
      if (groupItems.length && empty >= 0) return toast(`第 ${empty + 1} 箱是空的，删掉它或者分几件进去`, true);
      const noTn = state.boxes.filter((b) => !b.trackingNo).length;
      const directNoTn = directPeople.filter((p) => data.directAddresses[p.customerId]?.ready && !state.direct[p.customerId]?.trackingNo).length;
      const missingIds = notFound.filter((i) => state.missing[i.id] === 'missing').map((i) => i.id);
      const lines = [
        `找到 ${found.length} 件：直邮 ${directPeople.length} 人，拼团 ${groupPeople.length} 人分 ${state.boxes.length} 箱。`,
        noTn ? `有 ${noTn} 箱没填回国单号（之后在「回国箱」里补，填了才算发出）。` : '',
        directNoTn ? `有 ${directNoTn} 包直邮没填 EMS 单号（之后在「直邮」页补）。` : '',
        missingIds.length ? `标缺件 ${missingIds.length} 件。` : '',
        '发送后客户页面马上能看到。',
      ].filter(Boolean);
      if (!(await confirmBox(lines.join('\n'), { okText: '发送' }))) return;
      btn.disabled = true;
      try {
        const assign = {};
        for (const i of groupItems) assign[i.id] = boxOfItem(i);
        const r = await api.post(`/api/staff/sort/${batchId}/commit`, {
          trackingNo: state.trackingNo || null,
          boxes: state.boxes.map((b) => ({ trackingNo: b.trackingNo || null })),
          assign,
          direct: directPeople.map((p) => ({
            customerId: p.customerId,
            trackingNo: state.direct[p.customerId]?.trackingNo || null,
            weightG: state.direct[p.customerId]?.weightG ? Number(state.direct[p.customerId].weightG) : null,
          })),
          missing: missingIds,
        });
        try {
          localStorage.removeItem(key);
        } catch {
          /* 无所谓 */
        }
        document.body.classList.remove('has-sortbar');
        location.hash = `#/sort-result/${r.sessionId}`;
      } catch (err) {
        btn.disabled = false;
        toast(err.message, true);
      }
    };
  }

  renderPick();
  window.addEventListener(
    'hashchange',
    () => {
      clearInterval(poller);
      document.body.classList.remove('has-sortbar');
    },
    { once: true },
  );
}
