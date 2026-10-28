import { api } from '/admin/api.js';
import { beijingTime, escapeHtml, itemCode, money } from '/admin/ui.js';

/**
 * 打印用的单子：白底黑字、没有按钮和菜单，A4 竖着打。
 *
 *   #/print/box/:id               回国箱装箱单（贴箱 / 封箱前对货）
 *   #/print/sort/:batchId?tn=xxx  分拣单（一个日本快递里每件该去哪堆）
 *   #/print/parcel/:id            直邮包裹打包单（收件地址 + 包里几件）
 *   #/print/direct                待打包直邮：每人一张，地址 + 要装的件
 *
 * 页面上只有一个「打印」按钮；浏览器的打印对话框里选「另存为 PDF」也行。
 */

function query() {
  return new URLSearchParams(location.hash.split('?')[1] ?? '');
}

const ROUTE_TEXT = { group: '拼团', direct: '直邮' };

function itemTable(items, { route = false } = {}) {
  return `<table class="print-table">
    <thead><tr><th class="ck">✓</th><th>cn</th><th>货号</th><th>名称</th>${route ? '<th>去向</th>' : ''}</tr></thead>
    <tbody>${items
      .map(
        (i) => `<tr>
          <td class="ck">□</td>
          <td class="cn">${escapeHtml(i.cn || i.nickname || '')}</td>
          <td class="mono">${escapeHtml(itemCode(i.productUrl) || '—')}</td>
          <td>${escapeHtml(i.title)}${i.missing ? ' <b>【上次没找到】</b>' : ''}</td>
          ${route ? `<td>${i.selfReturn ? '<b>不拼邮·放一边</b>' : ROUTE_TEXT[i.route] || ''}</td>` : ''}
        </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function sheet(title, meta, body) {
  return `<article class="print-sheet">
    <header><h1>${escapeHtml(title)}</h1><div class="print-meta">${meta}</div></header>
    ${body}
    <footer>速达云仓 · 打印于 ${beijingTime(new Date().toISOString())}</footer>
  </article>`;
}

async function boxSheet(id) {
  const { box, items } = await api.get(`/api/staff/jp/boxes/${id}`);
  const people = new Set(items.map((i) => i.customerId)).size;
  return sheet(
    `回国箱装箱单 · ${box.name}`,
    `订单 ${escapeHtml(box.batchNames || '—')} · 回国单号 <b>${escapeHtml(box.trackingNo || '（未填）')}</b>
     · ${items.length} 件 / ${people} 人${box.jpWeightG ? ` · 整箱 ${(box.jpWeightG / 1000).toFixed(2)} kg` : ''}${
       box.cartonCount ? ` · ${box.cartonCount} 箱` : ''
     }`,
    itemTable(items),
  );
}

async function sortSheet(batchId) {
  const tn = query().get('tn') || '';
  const data = await api.get(`/api/staff/sort/${batchId}${tn ? `?tn=${encodeURIComponent(tn)}` : ''}`);
  const directPeople = [...new Set(data.items.filter((i) => i.route === 'direct' && !i.selfReturn).map((i) => i.customerId))];
  const addresses = directPeople
    .map((cid) => {
      const who = data.items.find((i) => i.customerId === cid);
      const a = data.directAddresses?.[cid];
      return `<tr><td class="cn">${escapeHtml(who.cn)}</td><td>${a?.ready ? escapeHtml(a.text || '') : `<b>没地址：</b>${escapeHtml(a?.text || '')}`}</td></tr>`;
    })
    .join('');
  return sheet(
    `分拣单 · ${data.batch.name}`,
    `日本订单 ${escapeHtml(data.batch.orderNo || '—')} · 日本运单 <b>${escapeHtml(data.trackingNo || '（表里没写运单号的件）')}</b> · ${data.items.length} 件`,
    `${itemTable(data.items, { route: true })}
     ${addresses ? `<h2>直邮寄到</h2><table class="print-table"><tbody>${addresses}</tbody></table>` : ''}`,
  );
}

function parcelBody(p) {
  const a = p.address || {};
  const addr = a.raw ?? [a.recipient, a.phone, a.detail].filter(Boolean).join(' ');
  return `<div class="print-address"><div class="small">寄到</div><div class="addr">${escapeHtml(addr)}</div></div>
    ${itemTable(p.items.map((i) => ({ ...i, cn: p.nickname })))}`;
}

async function parcelSheet(id) {
  const { parcel: p } = await api.get(`/api/staff/direct/parcels/${id}`);
  return sheet(
    `直邮打包单 · 包裹 #${p.id}`,
    `${escapeHtml(p.nickname)} · ${p.items.length} 件${p.weightG ? ` · ${p.weightG} g` : ''}${p.feeFen != null ? ` · 运费 ${money(p.feeFen)}` : ''}
     · ${escapeHtml(p.statusLabel)}${p.trackingNo ? ` · ${escapeHtml(p.carrier || '')} ${escapeHtml(p.trackingNo)}` : ''}`,
    parcelBody(p),
  );
}

async function directSheets() {
  const data = await api.get('/api/staff/jp/overview');
  const only = query().get('customer');
  const groups = data.direct.filter((g) => !only || String(g.customerId) === only);
  if (!groups.length) return sheet('待打包直邮', '', '<p>没有待打包的直邮件。</p>');
  return groups
    .map((g) =>
      sheet(
        `直邮打包单 · ${g.nickname}`,
        `${g.items.length} 件 · 还没打包`,
        `<div class="print-address"><div class="small">寄到</div><div class="addr">${
          g.address ? escapeHtml(g.address) : `<b>还没有地址：</b>${escapeHtml(g.addressProblem || '')}`
        }</div></div>${itemTable(g.items.map((i) => ({ ...i, cn: g.nickname })))}`,
      ),
    )
    .join('');
}

export async function render(view, [kind, id]) {
  let html;
  if (kind === 'box') html = await boxSheet(id);
  else if (kind === 'sort') html = await sortSheet(id);
  else if (kind === 'parcel') html = await parcelSheet(id);
  else html = await directSheets();
  view.innerHTML = `
    <div class="card no-print row" style="justify-content:space-between">
      <a class="small" href="javascript:history.back()">← 返回</a>
      <button id="do-print">打印</button>
    </div>
    <div class="print-root">${html}</div>`;
  view.querySelector('#do-print').onclick = () => window.print();
}
