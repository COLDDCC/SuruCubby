/**
 * 直邮包裹（只有群主能看）：仓库每天提交的包裹，两个价格摆一起，勾选 → 单号放行 / 导出 Excel 去收钱。
 */
import { api } from '/admin/api.js';
import { loadXlsx } from '/admin/xlsx.js';
import { beijingTime, bindActions, confirmBox, escapeHtml, itemCode, money, promptBox, toast } from '/admin/ui.js';

const STATUS_KEY = 'sc_parcels_status';

function readStatus() {
  try {
    return localStorage.getItem(STATUS_KEY) || 'all';
  } catch {
    return 'all';
  }
}

export async function render(view) {
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const focus = query.get('focus');
  let day = query.get('day') || '';
  let status = readStatus();
  const selected = new Set();
  let data;

  async function load() {
    const qs = new URLSearchParams();
    if (day) qs.set('day', day);
    if (status !== 'all') qs.set('status', status);
    data = await api.get(`/api/admin/parcels?${qs}`);
    if (!day && !focus && data.days.length && !query.get('all')) {
      // 默认看最近一天：仓库每天放出来一批，你一般是一批一批收钱
      day = data.days[0].day;
      return load();
    }
    draw();
  }

  function draw() {
    const rows = data.parcels;
    const picked = rows.filter((p) => selected.has(p.id));
    const sum = (list, k) => list.reduce((s, p) => s + p[k], 0);
    view.innerHTML = `
      <div class="card">
        <h2>直邮包裹</h2>
        <p class="small muted">仓库价和你收客户的价只在这一页同时出现：仓库那边看不到任何价格，客户只看到你收他的运费。</p>
        <div class="row">
          <label style="margin:0">仓库提交日期</label>
          <select id="day">
            <option value="">全部日期</option>
            ${data.days.map((d) => `<option value="${d.day}" ${d.day === day ? 'selected' : ''}>${d.day}（${d.count} 个${d.pending ? `，${d.pending} 个没放行` : ''}）</option>`).join('')}
          </select>
          <select id="status">
            <option value="all" ${status === 'all' ? 'selected' : ''}>全部</option>
            <option value="pending" ${status === 'pending' ? 'selected' : ''}>还没放行</option>
            <option value="released" ${status === 'released' ? 'selected' : ''}>已放行</option>
          </select>
        </div>
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <label style="margin:0"><input type="checkbox" id="all" ${rows.length && picked.length === rows.length ? 'checked' : ''}> 全选（${rows.length} 个）</label>
          <div class="row">
            <span class="small">已选 ${picked.length} 个 · 毛重 ${sum(picked, 'grossWeightG').toLocaleString()} g · 仓库 ${money(sum(picked, 'costFen'))} · 应收 <b>${money(sum(picked, 'saleFen'))}</b> · 差价 <b class="paid">${money(sum(picked, 'marginFen'))}</b></span>
            <button data-action="export" ${picked.length ? '' : 'disabled'}>导出 Excel</button>
            <button data-action="release" ${picked.some((p) => !p.releasedAt) ? '' : 'disabled'}>勾选的单号放行</button>
          </div>
        </div>
        <div class="scroll-x" style="margin-top:8px"><table>
          <thead><tr><th></th><th>客户</th><th>单号</th><th class="right">毛重</th><th class="right">仓库</th><th class="right">收客户</th><th class="right">差价</th><th>状态</th></tr></thead>
          <tbody>${rows
            .map(
              (p) => `<tr data-focus-item="${p.id}" class="${String(p.id) === focus ? 'hit' : ''}">
              <td><input type="checkbox" data-pick="${p.id}" ${selected.has(p.id) ? 'checked' : ''}></td>
              <td><a href="#/customers/${p.customerId}">${escapeHtml(p.nickname)}</a><div class="small muted">${p.submitDay} · ${p.items.length} 件</div></td>
              <td><button class="badge copy-chip mono" data-copy="${escapeHtml(p.trackingNo)}">${escapeHtml(p.trackingNo)}</button>
                <div class="small"><button class="small plain" data-action="detail" data-id="${p.id}">看东西和平铺图（${p.photoIds.length}）</button></div></td>
              <td class="right">${p.grossWeightG.toLocaleString()} g</td>
              <td class="right small">${money(p.costFen)}<div class="muted">${money(p.costFenPerKg)}/kg</div></td>
              <td class="right"><b>${money(p.saleFen)}</b><div class="small"><button class="small plain" data-action="price" data-id="${p.id}" data-cur="${p.saleFenPerKg}">${money(p.saleFenPerKg)}/kg 改</button></div></td>
              <td class="right paid">${money(p.marginFen)}</td>
              <td>${p.releasedAt ? `<span class="badge ok">已放行</span><div class="small muted">${beijingTime(p.releasedAt)}</div><button class="small plain" data-action="unrelease" data-id="${p.id}">收回</button>` : '<span class="badge warn">等收运费</span>'}</td>
            </tr>
            <tr hidden data-detail="${p.id}"><td></td><td colspan="7">
              <div class="small">${p.addressSnapshot ? `寄到 ${escapeHtml(p.addressSnapshot)} · ` : ''}仓库 ${escapeHtml(p.createdByName || '')} ${beijingTime(p.createdAt)} 提交</div>
              <ul class="small">${p.items.map((i) => `<li>${escapeHtml(itemCode(i.productUrl) || '')} ${escapeHtml(i.title)} <span class="muted">— 订单 ${escapeHtml(i.orderNo || i.batchName)}</span></li>`).join('')}</ul>
              <div class="parcel-photos">${p.photoIds.map((pid) => `<a href="/api/admin/parcels/${p.id}/photos/${pid}" target="_blank"><img src="/api/admin/parcels/${p.id}/photos/${pid}" alt="平铺图" loading="lazy"></a>`).join('') || '<span class="unpaid">仓库还没传平铺图</span>'}</div>
            </td></tr>`,
            )
            .join('') || '<tr><td colspan="8" class="empty">没有包裹</td></tr>'}</tbody>
        </table></div>
      </div>`;

    view.querySelector('#day').onchange = (e) => {
      day = e.target.value;
      selected.clear();
      if (!day) query.set('all', '1');
      load();
    };
    view.querySelector('#status').onchange = (e) => {
      status = e.target.value;
      try {
        localStorage.setItem(STATUS_KEY, status);
      } catch {
        /* 无痕模式 */
      }
      selected.clear();
      load();
    };
    view.querySelector('#all').onchange = (e) => {
      rows.forEach((p) => (e.target.checked ? selected.add(p.id) : selected.delete(p.id)));
      draw();
    };
    view.querySelectorAll('[data-pick]').forEach((el) => {
      el.onchange = () => {
        const id = Number(el.dataset.pick);
        el.checked ? selected.add(id) : selected.delete(id);
        draw();
      };
    });
    bindActions(view, {
      detail: async (ds) => {
        const row = view.querySelector(`[data-detail="${ds.id}"]`);
        row.hidden = !row.hidden;
      },
      price: async (ds) => {
        const v = await promptBox('这个包裹收客户的单价（元 / kg）', (Number(ds.cur) / 100).toFixed(2));
        if (v === null) return;
        const fen = Math.round(Number(v) * 100);
        if (!Number.isFinite(fen) || fen <= 0) return toast('单价要是大于 0 的数', true);
        await api.patch(`/api/admin/parcels/${ds.id}`, { saleFenPerKg: fen });
        await load();
      },
      release: async () => {
        const ids = picked.filter((p) => !p.releasedAt).map((p) => p.id);
        if (!(await confirmBox(`这 ${ids.length} 个包裹的运费都收了？放行后客户就能看到单号和平铺图。`, { okText: '单号放行' }))) return;
        await api.post('/api/admin/parcels/release', { parcelIds: ids });
        toast(`放行了 ${ids.length} 个`);
        await load();
      },
      unrelease: async (ds) => {
        if (!(await confirmBox('收回之后客户又看不到单号和平铺图了，仓库可以再改这个包裹。确定？', { okText: '收回', danger: true }))) return;
        await api.post('/api/admin/parcels/release', { parcelIds: [Number(ds.id)], undo: true });
        await load();
      },
      export: async () => exportSheet(picked),
    });
  }

  await load();
}

/** 给群主收钱用的表：一行一个包裹，两个价格、差价都在。这张表别发给仓库或客户。 */
async function exportSheet(list) {
  const header = ['提交日期', '客户', 'QQ', '快递单号', '毛重(g)', '件数', '仓库单价(元/kg)', '仓库运费(元)', '收客户单价(元/kg)', '应收运费(元)', '差价(元)', '状态', '东西（货号 · 订单号）', '地址'];
  const yuan = (fen) => Math.round(fen) / 100;
  const rows = list.map((p) => [
    p.submitDay,
    p.nickname,
    p.qq,
    p.trackingNo,
    p.grossWeightG,
    p.items.length,
    yuan(p.costFenPerKg),
    yuan(p.costFen),
    yuan(p.saleFenPerKg),
    yuan(p.saleFen),
    yuan(p.marginFen),
    p.releasedAt ? '已放行' : '等收运费',
    p.items.map((i) => `${itemCode(i.productUrl) || i.title} · ${i.orderNo || i.batchName}`).join('\n'),
    p.addressSnapshot || '',
  ]);
  const total = ['合计', '', '', '', list.reduce((s, p) => s + p.grossWeightG, 0), list.reduce((s, p) => s + p.items.length, 0), '', yuan(list.reduce((s, p) => s + p.costFen, 0)), '', yuan(list.reduce((s, p) => s + p.saleFen, 0)), yuan(list.reduce((s, p) => s + p.marginFen, 0)), '', '', ''];
  const days = [...new Set(list.map((p) => p.submitDay))].sort();
  const name = `直邮包裹_${days[0]}${days.length > 1 ? `_${days[days.length - 1]}` : ''}`;
  try {
    const XLSX = await loadXlsx();
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows, total]);
    ws['!cols'] = header.map((h, i) => ({ wch: i === 12 ? 40 : i === 13 ? 30 : Math.max(8, h.length * 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '直邮包裹');
    XLSX.writeFile(wb, `${name}.xlsx`);
  } catch {
    // SheetJS 加载不了（国内 CDN 不通又没自托管）就退回 CSV，Excel 一样能开
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = '﻿' + [header, ...rows, total].map((r) => r.map(esc).join(',')).join('\r\n');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `${name}.csv` });
    a.click();
    toast('Excel 组件没加载上，先导出成 CSV（Excel 能直接打开）');
  }
}
