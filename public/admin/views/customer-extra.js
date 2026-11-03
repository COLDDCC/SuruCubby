/**
 * 客户详情里新加的一块：直邮 / 拼邮、放行、单独录入（自己下单 / 转运）、直邮包裹。
 * 单独一个文件，原来的客户页基本不动。
 */
import { api } from '/admin/api.js';
import { bindActions, codeTag, confirmBox, escapeHtml, itemCode, money, promptBox, statusLabel, thumb, toast, yen } from '/admin/ui.js';

/** 「SG-123 https://…/detail/602170001 1800 x2」这种一行一件的粘贴文本 → 行 */
export function parseLines(text, { forward = false } = {}) {
  return String(text)
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const url = raw.match(/https?:\/\/\S+/)?.[0] ?? '';
      const rest = raw.replace(url, ' ');
      const qty = Number(rest.match(/[x×*]\s*(\d{1,2})\b/i)?.[1] ?? 1);
      // 转运的东西没有价格，名称里的数字（「第3卷」）原样留着
      if (forward) return { url, title: rest.replace(/[x×*]\s*\d{1,2}\b/i, ' ').trim(), priceJpy: '', qty };
      const price = rest.replace(/[x×*]\s*\d{1,2}\b/i, ' ').match(/(\d[\d,]*)\s*(円|日元|yen)?/i)?.[1] ?? '';
      const title = rest.replace(/[x×*]\s*\d{1,2}\b/i, ' ').replace(/(\d[\d,]*)\s*(円|日元|yen)?/i, ' ').trim();
      return { url, title: url ? title : title || raw, priceJpy: price, qty };
    });
}

export async function renderExtra(box, data, id, reload) {
  const cu = data.customer;
  const unreleased = data.items.filter((i) => !i.releasedAt);
  const parcels = data.parcels || [];
  box.innerHTML = `
    <div class="card">
      <h3>直邮 / 拼邮</h3>
      <p>${cu.shipMode === 'direct' ? '<span class="badge warn">直邮</span> 仓库直接寄给他' : '<span class="badge ok">拼邮</span> 和你一个箱子回国，客户只看回国单号'}
        <button class="small plain" data-action="lane">${cu.shipMode === 'direct' ? '改成拼邮' : '改成直邮'}</button></p>
      ${cu.shipMode === 'direct' ? `<p class="small">直邮地址（仓库看得到）：${cu.directAddress ? escapeHtml(cu.directAddress) : '<span class="unpaid">没填，仓库不知道寄哪</span>'}
        <button class="small plain" data-action="addr">改地址</button></p>` : ''}
    </div>

    <div class="card">
      <h3>放进他的仓库</h3>
      ${unreleased.length
        ? `<p class="unpaid">还有 ${unreleased.length} 件没放行，他自己的页面上看不到（${yen(unreleased.reduce((s, i) => s + (i.goodsFeeJpy || 0), 0))}）。收完钱点一下：</p>
           <div class="row">${[...new Map(unreleased.map((i) => [i.batchId, i])).values()]
             .map((i) => `<button class="small" data-action="release" data-batch="${i.batchId}">放行「${escapeHtml(i.batchName)}」${unreleased.filter((x) => x.batchId === i.batchId).length} 件</button>`)
             .join('')}</div>`
        : '<p class="small paid">他的东西都已经放进他自己的仓库了。</p>'}
    </div>

    <div class="card">
      <h3>直接给他录东西</h3>
      <div class="row">
        <label style="margin:0"><input type="radio" name="qkind" value="buy" checked> 他单独下单（我买的）</label>
        <label style="margin:0"><input type="radio" name="qkind" value="forward"> 转运来的（不是我买的）</label>
      </div>
      <div class="row" style="margin-top:6px">
        <input id="qOrder" placeholder="日本订单号" style="flex:1;min-width:140px">
        <input id="qTrack" placeholder="日本运单号 / 转运单号" style="flex:1;min-width:140px">
        <input id="qShop" placeholder="来源店铺（可空）" style="flex:1;min-width:120px">
      </div>
      <label for="qLines">一行一件：商品链接 + 价格（日元，可不填）+ ×数量（可不填）。转运的写名称，也可以贴图片地址</label>
      <textarea id="qLines" rows="5" style="width:100%" placeholder="https://www.suruga-ya.jp/product/detail/602170001 1800&#10;https://www.suruga-ya.jp/product/detail/ZHOTI678913 500 ×2"></textarea>
      <div class="row">
        <label style="margin:0" id="qRelWrap"><input type="checkbox" id="qRelease"> 已经收过钱，录完直接放进他的仓库</label>
        <button data-action="quick">录进去</button>
      </div>
      <p class="small muted">每次录入算一个独立的订单，仓库拿订单号或运单号就能找到。没给图片时会按骏河屋货号自动找图。</p>
    </div>

    <div class="card">
      <h3>直邮包裹</h3>
      ${parcels.length
        ? parcels
            .map(
              (p) => `<div class="list-row">
          <div class="main"><a href="#/parcels?focus=${p.id}">#${p.id}</a> ${escapeHtml(p.trackingNo)} · ${p.grossWeightG} g · ${p.itemCount} 件
            <div class="small muted">${escapeHtml(p.submitDay)} 提交 · 仓库 ${money(p.costFen)}（${money(p.costFenPerKg)}/kg）→ 收他 ${money(p.feeFen)}（${money(p.saleFenPerKg)}/kg）· 差价 ${money(p.marginFen)}</div></div>
          <div class="side">${p.released ? '<span class="badge ok">已放行</span>' : `<button class="small" data-action="releaseParcel" data-id="${p.id}">单号放行</button>`}</div>
        </div>`,
            )
            .join('')
        : '<p class="empty">还没有直邮包裹</p>'}
    </div>`;

  const kindInputs = box.querySelectorAll('input[name=qkind]');
  kindInputs.forEach((r) => (r.onchange = () => (box.querySelector('#qRelWrap').hidden = r.value === 'forward' && r.checked)));

  bindActions(box, {
    lane: async () => {
      await api.patch(`/api/admin/customers/${id}`, { shipMode: cu.shipMode === 'direct' ? 'group' : 'direct' });
      reload();
    },
    addr: async () => {
      const v = await promptBox('直邮地址（收件人 电话 地址，仓库照这个寄）', cu.directAddress || '');
      if (v === null) return;
      await api.patch(`/api/admin/customers/${id}`, { directAddress: v });
      reload();
    },
    release: async (ds) => {
      const r = await api.post('/api/admin/quick-order/release', { batchId: Number(ds.batch), customerId: Number(id) });
      toast(`放行了 ${r.count} 件，他现在能看到了`);
      reload();
    },
    releaseParcel: async (ds) => {
      if (!(await confirmBox('确认运费已经收了？放行后他就能看到单号和平铺图。', { okText: '单号放行' }))) return;
      await api.post('/api/admin/parcels/release', { parcelIds: [Number(ds.id)] });
      toast('已放行');
      reload();
    },
    quick: async () => {
      const kind = box.querySelector('input[name=qkind]:checked').value;
      const lines = parseLines(box.querySelector('#qLines').value, { forward: kind === 'forward' }).map((l) =>
        kind === 'forward' && !l.url && /^https?:/.test(l.title) ? { imageUrl: l.title, title: '转运物品' } : kind === 'forward' && l.url && !/suruga-ya/.test(l.url) ? { imageUrl: l.url, title: l.title || '转运物品' } : l,
      );
      if (!lines.length) return toast('先贴几行', true);
      const r = await api.post('/api/admin/quick-order', {
        customerId: Number(id),
        kind,
        orderNo: box.querySelector('#qOrder').value,
        japanTrackingNo: box.querySelector('#qTrack').value,
        shop: box.querySelector('#qShop').value,
        release: box.querySelector('#qRelease').checked,
        lines,
      });
      toast(`录进去 ${r.itemCount} 件（${r.withImage} 件找到图）${r.released ? '，已放行' : '，还没放行'}`);
      reload();
    },
  });
}

export { codeTag, itemCode, statusLabel, thumb };
