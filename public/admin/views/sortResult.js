import { api } from '/admin/api.js';
import { beijingTime, copyText, escapeHtml, money, toast } from '/admin/ui.js';
import { bindItemDetails } from '/admin/itemDetail.js';

/** 发群用的纯文字：直邮一人一段（单号 + 里面有什么），拼团一箱一段（单号 + 谁几件）。 */
function groupText(r) {
  const out = [`【分拣结果】${r.batchName}${r.jpTrackingNo ? `｜日本运单 ${r.jpTrackingNo}` : ''}`];
  if (r.parcels.length) {
    out.push('', `■ 直邮（${r.parcels.length} 包）`);
    for (const p of r.parcels) {
      out.push(
        `${p.cn}（QQ ${p.qq}）${p.carrier || 'EMS'} ${p.trackingNo || '单号待填'}${p.weightG ? `｜${p.weightG}g 运费 ${money(p.feeFen)}` : ''}`,
      );
      for (const i of p.items) out.push(`  · ${i.title}`);
    }
  }
  if (r.boxes.length) {
    out.push('', `■ 拼团（${r.boxes.length} 箱）`);
    for (const b of r.boxes) {
      out.push(`第${b.no}箱 回国单号 ${b.trackingNo || '待填'}${b.weightG ? `｜整箱 ${(b.weightG / 1000).toFixed(2)}kg` : ''}${b.cartons > 1 ? `｜${b.cartons} 箱` : ''}`);
      for (const p of b.people) out.push(`  ${p.cn}（QQ ${p.qq}）${p.items.length} 件：${p.items.map((i) => i.title).join('、')}`);
    }
  }
  if (r.unpacked.length) {
    out.push('', '■ 直邮还没打包（缺地址，请在自己页面上填）');
    for (const u of r.unpacked) out.push(`  ${u.cn}（QQ ${u.qq}）${u.items.length} 件`);
  }
  if (r.missing.length) {
    out.push('', '■ 这一箱没找到');
    for (const m of r.missing) out.push(`  ${m.cn}：${m.title}`);
  }
  return out.join('\n');
}

const itemLink = (i) => `<a href="#" data-detail="${i.id}">${escapeHtml(i.title)}</a>`;

export async function render(view, [id]) {
  const s = await api.get(`/api/staff/sort/sessions/${id}`);
  const r = s.result;
  if (!r) {
    view.innerHTML = '<div class="card"><p>这次分拣没有留下结果。</p></div>';
    return;
  }
  const text = groupText(r);
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div>
          <h2 style="margin:0">分拣完成</h2>
          <p class="small muted" style="margin:4px 0 0">${escapeHtml(r.batchName)}${r.jpTrackingNo ? ` · 日本运单 <b class="mono">${escapeHtml(r.jpTrackingNo)}</b>` : ''} · ${escapeHtml(s.createdBy)} · ${beijingTime(s.createdAt)}</p>
        </div>
        <a class="small" href="#/jp">← 待分拣</a>
      </div>
      <p class="small" style="margin-bottom:0">客户页面已经能看到自己的单号和这一包 / 这一箱里有哪几件。${
        r.leftover ? `这一箱还有 ${r.leftover} 件没点到，下一箱到了在分拣页接着分。` : ''
      }</p>
      <p><button id="copy-text">复制结果发群</button></p>
    </div>
    <div class="review-cols">
      <div class="card"><h3>直邮 <span class="small muted">${r.parcels.length} 包</span></h3>
        ${
          r.parcels.length
            ? r.parcels
                .map(
                  (p) => `<div class="pile">
              <div class="pile-head"><span class="cn-chip">${escapeHtml(p.cn)}</span><span class="small muted">QQ ${escapeHtml(p.qq)}</span></div>
              <div>${escapeHtml(p.carrier || 'EMS')} <b class="mono">${escapeHtml(p.trackingNo || '单号待填')}</b>
                ${p.weightG ? `<span class="small muted">· ${p.weightG} g · 运费 ${money(p.feeFen)}</span>` : '<span class="small muted">· 还没称重</span>'}</div>
              <div class="small muted">寄到 ${escapeHtml(p.address)}</div>
              <ul class="small pile-items">${p.items.map((i) => `<li>${itemLink(i)}</li>`).join('')}</ul>
            </div>`,
                )
                .join('')
            : '<p class="small muted">没有。</p>'
        }
        ${
          r.unpacked.length
            ? `<p class="small unpaid">还没打包：${r.unpacked.map((u) => `${escapeHtml(u.cn)} ${u.items.length} 件（${escapeHtml(u.reason)}）`).join('；')}</p>`
            : ''
        }
      </div>
      <div class="card"><h3>拼团 <span class="small muted">${r.boxes.length} 箱</span></h3>
        ${
          r.boxes.length
            ? r.boxes
                .map(
                  (b) => `<div class="pile">
              <div class="pile-head"><b>第 ${b.no} 箱</b> <span>回国单号 <b class="mono">${escapeHtml(b.trackingNo || '待填')}</b>${b.weightG ? ` · 整箱 ${(b.weightG / 1000).toFixed(2)} kg` : ''}${b.cartons > 1 ? ` · ${b.cartons} 箱` : ''}</span></div>
              ${b.people
                .map(
                  (p) => `<div class="small" style="margin:4px 0"><span class="cn-chip">${escapeHtml(p.cn)}</span> ${p.items.length} 件：${p.items
                    .map(itemLink)
                    .join('、')}</div>`,
                )
                .join('')}
              ${b.trackingNo ? '' : '<p class="small muted">没填回国单号：发箱时在「日本仓 → 回国箱」里填。</p>'}
            </div>`,
                )
                .join('')
            : '<p class="small muted">没有。</p>'
        }
        ${r.selfReturn.length ? `<p class="small muted">不拼邮：${r.selfReturn.map((p) => `${escapeHtml(p.cn)} ${p.items.length} 件`).join('、')}</p>` : ''}
      </div>
    </div>
    ${
      r.missing.length
        ? `<div class="card"><h3>标了缺件 <span class="small muted">${r.missing.length} 件</span></h3>
            ${r.missing.map((m) => `<div class="small"><span class="cn-chip">${escapeHtml(m.cn)}</span> ${itemLink(m)}</div>`).join('')}</div>`
        : ''
    }
    <div class="card"><details><summary>发群文字预览</summary><pre class="copy-text">${escapeHtml(text)}</pre></details></div>`;

  view.querySelector('#copy-text').onclick = async () => {
    toast((await copyText(text)) ? '已复制，去群里粘贴' : '复制不了，展开下面的预览手动复制', false);
  };
  bindItemDetails(view);
}
