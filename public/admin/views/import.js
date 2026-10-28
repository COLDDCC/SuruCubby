import { api } from '/admin/api.js';
import { bindActions, escapeHtml, toast, yen } from '/admin/ui.js';
import { collectCellUrls } from '/admin/sheet.js';
import { loadXlsx } from '/admin/xlsx.js';

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let state = {
  sheet: null,
  fileName: '',
  fileHash: '',
  preview: null,
  /** 管理员改过的列：Excel 列序号 → 用途（null 表示这列不用） */
  columnEdits: {},
  /** 出预览那一刻的 columnEdits 快照，用来挡住「改完没重新预览就导入」 */
  previewedEdits: '',
  assignments: new Map(),
  /** 管理员点了「不是这位」的名字：不接受自动认的结果，必须重新指认 */
  overrides: new Set(),
  customers: [],
};

export async function render(view) {
  state = {
    sheet: null,
    fileName: '',
    fileHash: '',
    preview: null,
    columnEdits: {},
    previewedEdits: '',
    assignments: new Map(),
    overrides: new Set(),
    customers: [],
  };
  view.innerHTML = `
    <div class="card">
      <h2>导入 Excel</h2>
      <p class="small muted">一张表 = 一个日本订单。必需：名称、cn。货款一律按日元记，不折人民币：有「实际价格」就按它算，也可以把某一列指认成「应付日元金额」。国际/国内运费仍然是人民币。</p>
      <input type="file" id="file" accept=".xlsx,.xls,.csv">
      <div class="form-grid" style="margin-top:8px">
        <div><label for="batchName">批次名</label>
          <input id="batchName" placeholder="例如 9月20日 第12团"></div>
        <div><label for="orderedAt">下单日期</label>
          <input id="orderedAt" type="date" value="${new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)}"></div>
        <div><label for="orderNo">日本订单号</label><input id="orderNo" placeholder="骏河屋的注文番号"></div>
        <div><label for="japanTrackingNo">日本运单号（可后补）</label><input id="japanTrackingNo" placeholder="分几个快递到的用逗号隔开；每件在表里写「日本运单号」列更准"></div>
      </div>
      <p class="small muted">表里可选的列：「发货方式」（直邮 / 拼团）、「收货地址」（直邮地址）、「日本运单号」（这一件在哪个快递箱）、「下单时间」（不写就用上面的下单日期）。</p>
      <p id="status" class="small muted"></p>
    </div>
    <div id="preview"></div>`;

  document.getElementById('file').addEventListener('change', (e) => handleFile(e.target.files[0], view));
}

async function handleFile(file, view) {
  if (!file) return;
  const status = document.getElementById('status');
  status.textContent = '正在解析…';
  try {
    const XLSX = await loadXlsx();
    const buffer = await file.arrayBuffer();
    const hash = await sha256(buffer);
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    // blankrows: true —— 中间的空行也要占位，否则后面所有行的「Excel 行号」和
    // 从公式里抽出来的地址都会对不上号
    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
    if (rows.length < 2) throw new Error('这张表没有数据行');
    const body = rows.slice(1);
    while (body.length > 0 && body[body.length - 1].every((cell) => cell === null || String(cell).trim() === '')) {
      body.pop(); // 末尾的空行没必要发给服务端
    }
    if (body.length === 0) throw new Error('这张表没有数据行');
    const colCount = Math.max(rows[0].length, ...body.map((r) => r.length));
    state.sheet = {
      headers: rows[0],
      rows: body,
      urls: collectCellUrls(ws, body.length, colCount),
    };
    state.fileName = file.name;
    state.fileHash = hash;
    state.columnEdits = {};
    const nameInput = document.getElementById('batchName');
    if (!nameInput.value.trim()) nameInput.value = file.name.replace(/\.(xlsx|xls|csv)$/i, '');
    status.textContent = `${wb.SheetNames[0]}：${rows.length - 1} 行`;
    await loadPreview(view);
  } catch (err) {
    status.textContent = '';
    toast(err.message, true);
  }
}

async function loadPreview(view) {
  const preview = await api.post('/api/admin/import/preview', {
    fileName: state.fileName,
    fileHash: state.fileHash,
    sheet: state.sheet,
    columns: state.columnEdits,
  });
  state.preview = preview;
  state.previewedEdits = JSON.stringify(state.columnEdits);
  if (state.customers.length === 0) {
    const data = await api.get('/api/admin/customers');
    state.customers = data.customers;
  }
  renderPreview(view);
}

function columnsCard(p) {
  const options = (current) =>
    [
      `<option value="">不使用</option>`,
      ...p.fields.map(
        (f) => `<option value="${f.field}" ${current === f.field ? 'selected' : ''}>${escapeHtml(f.label)}</option>`,
      ),
    ].join('');
  return `<div class="card">
    <h3>列对应关系</h3>
    <p class="small muted">程序按表头猜的，猜错了直接在下面改。表头写着「数量」但底下是 1500、4230 这种数，就把这列改成「平时价格」。</p>
    <div class="scroll-x"><table>
      <thead><tr><th>Excel 列</th><th>当作</th><th>第一个值</th></tr></thead>
      <tbody>${p.columns
        .map(
          (col) => `<tr class="${col.field ? '' : 'highlight-row'}">
            <td>${escapeHtml(col.header || `第 ${col.index + 1} 列`)}</td>
            <td><select data-col="${col.index}">${options(col.field)}</select>${col.manual ? ' <span class="badge">已改</span>' : ''}</td>
            <td class="small muted">${escapeHtml(String(state.sheet.rows.find((r) => r[col.index] !== null && String(r[col.index]).trim() !== '')?.[col.index] ?? '—')).slice(0, 40)}</td>
          </tr>`,
        )
        .join('')}</tbody></table></div>
  </div>`;
}

function renderPreview(view) {
  const p = state.preview;
  const box = document.getElementById('preview');
  // 自动认出来的可以当场改指认；点了「不是这位」却没重新选的，算还没处理
  const needsPick = (g) => {
    if (state.assignments.has(g.cn)) return false;
    return state.overrides.has(g.cn) || !g.customer;
  };
  const unmatched = p.groups.filter(needsPick);

  const customerOptions = state.customers
    .map((c) => `<option value="${c.id}">${escapeHtml(c.nickname)}（${escapeHtml(c.qq)}）</option>`)
    .join('');

  box.innerHTML = `
    ${
      p.duplicate
        ? `<div class="card" style="border-color:var(--warn)">
            <p class="badge warn">这张表可能已经导过</p>
            <p class="small">已有批次「${escapeHtml(p.duplicate.name)}」用的是同一个文件。确认要再导一次吗？</p>
            <label class="row"><input type="checkbox" id="confirmDup"> 我确认要重复导入</label>
          </div>`
        : ''
    }
    ${p.columns && p.columns.length ? columnsCard(p) : ''}
    <div class="card">
      <h3>预览</h3>
      <p class="small">共 ${p.totals.rows} 行 · ${p.totals.customers} 位客户 · 货款合计 <span class="money">${yen(
        p.totals.amountJpy,
      )}</span>${unmatched.length ? ` · <span class="unpaid">${unmatched.length} 个名字要先处理</span>` : ''}</p>
      ${
        (p.totals.jpTrackingNos || []).length
          ? `<p class="small">日本运单号：${p.totals.jpTrackingNos.map((t) => `<code>${escapeHtml(t.trackingNo)}</code> ${t.count} 件`).join(' · ')}
              ${p.totals.jpTrackingNos.reduce((n, t) => n + t.count, 0) < p.totals.rows ? `<span class="muted">（其余 ${p.totals.rows - p.totals.jpTrackingNos.reduce((n, t) => n + t.count, 0)} 件没写，分拣时再记）</span>` : ''}</p>`
          : ''
      }
      <p class="small">发货方式：拼团 <b>${p.totals.rows - (p.totals.direct || 0)}</b> 件 · 直邮 <b>${p.totals.direct || 0}</b> 件
        <span class="muted">（表里「发货方式」写直邮 / 拼团，空着算拼团；直邮的件不进回国箱，「收货地址」列会存成直邮地址。导入后也能在批次页改。）</span></p>
      ${
        p.errors.length
          ? `<div class="card" style="border-color:var(--danger)">
              <strong class="unpaid">这些行有问题，改好之前不能导入：</strong>
              <ul class="small">${p.errors.map((e) => `<li>${e.rowNo ? `第 ${e.rowNo} 行：` : ''}${escapeHtml(e.reason)}</li>`).join('')}</ul>
            </div>`
          : ''
      }
      ${
        p.skipped.length
          ? `<details class="small"><summary>跳过 / 需要留意的 ${p.skipped.length} 行</summary>
              <ul>${p.skipped.map((e) => `<li>第 ${e.rowNo} 行：${escapeHtml(e.reason)}</li>`).join('')}</ul>
            </details>`
          : ''
      }
      <div class="scroll-x" style="margin-top:10px"><table>
        <thead><tr><th>Excel 里的名字</th><th class="right">件数</th><th class="right">小计</th><th>归属客户</th></tr></thead>
        <tbody>${p.groups
          .map((g) => {
            const assigned = state.assignments.get(g.cn);
            const overridden = state.overrides.has(g.cn);
            const autoName = g.customer ? `${g.customer.nickname}（QQ ${g.customer.qq}）` : '';
            const ambiguous =
              g.matchedBy === 'ambiguous' && !assigned
                ? `<div class="small unpaid">好几个客户名字都对得上：${g.candidates
                    .map((x) => `${escapeHtml(x.nickname)}（QQ ${escapeHtml(x.qq)}）`)
                    .join('、')}，请指定是哪一位</div>`
                : '';
            const pick = `<div class="row">
                  <select data-pick="${escapeHtml(g.cn)}">
                    <option value="">— 选已有客户 —</option>${customerOptions}
                  </select>
                  <button class="small plain" data-action="use" data-cn="${escapeHtml(g.cn)}">用这个</button>
                </div>
                <div class="row" style="margin-top:6px">
                  <input style="width:130px" inputmode="numeric" placeholder="新客户 QQ 号" data-qq="${escapeHtml(g.cn)}">
                  <button class="small plain" data-action="create" data-cn="${escapeHtml(g.cn)}">新建</button>
                </div>`;
            let cell;
            if (assigned) {
              cell = `<div>${escapeHtml(assigned.label)}</div>
                <div class="row">
                  <button class="small plain" data-action="clear" data-cn="${escapeHtml(g.cn)}">重新选</button>${
                    overridden && g.customer
                      ? `<button class="small plain" data-action="unoverride" data-cn="${escapeHtml(
                          g.cn,
                        )}">还是用${escapeHtml(autoName)}</button>`
                      : ''
                  }
                </div>`;
            } else if (overridden && g.customer) {
              cell = `<div class="small unpaid">不要自动认的 ${escapeHtml(autoName)}</div>${pick}`;
            } else if (g.customer) {
              cell = `<div>${escapeHtml(g.customer.nickname)}<span class="small muted"> · ${escapeHtml(g.customer.qq)}${
                g.matchedBy === 'normalized' && g.cn !== g.customer.nickname
                  ? `<span class="small muted"> · 表里写的「${escapeHtml(g.cn)}」，自动对上</span>`
                  : ''
              }</span></div>
              <button class="small plain" data-action="override" data-cn="${escapeHtml(g.cn)}">不是这位？改</button>`;
            } else {
              cell = ambiguous + pick;
            }
            return `<tr class="${needsPick(g) ? 'highlight-row' : ''}">
              <td>${escapeHtml(g.cn)}</td>
              <td class="right">${g.count}</td>
              <td class="right money">${yen(g.subtotalJpy)}</td>
              <td>${cell}</td>
            </tr>`;
          })
          .join('')}</tbody></table></div>
      <div class="row" style="margin-top:12px">
        <button data-action="commit" ${p.errors.length || unmatched.length ? 'disabled' : ''}>确认导入</button>
        <span class="small muted">${
          unmatched.length ? '还有黄色行没处理' : p.errors.length ? '先修掉问题行' : '会自动建一个同名包裹'
        }</span>
      </div>
    </div>`;

  box.querySelectorAll('[data-col]').forEach((select) => {
    select.onchange = () => {
      const at = select.dataset.col;
      const value = select.value;
      if (value === (state.columnEdits[at] ?? '')) return;
      if (value === '') state.columnEdits[at] = null;
      else state.columnEdits[at] = value;
      loadPreview(view).catch((e) => toast(e.message, true));
    };
  });

  bindActions(box, {
    use: ({ cn }) => {
      const select = box.querySelector(`[data-pick="${CSS.escape(cn)}"]`);
      const id = Number(select.value);
      if (!id) return toast('先选一个客户', true);
      const customer = state.customers.find((c) => c.id === id);
      state.assignments.set(cn, {
        customerId: id,
        label: `${customer.nickname}（沿用，加别名）`,
      });
      renderPreview(view);
    },
    create: ({ cn }) => {
      const input = box.querySelector(`[data-qq="${CSS.escape(cn)}"]`);
      const qq = input.value.trim();
      if (!/^\d{5,15}$/.test(qq)) return toast('QQ 号格式不对', true);
      state.assignments.set(cn, {
        newCustomer: { qq, nickname: cn },
        label: `新客户 ${qq}`,
      });
      renderPreview(view);
    },
    clear: ({ cn }) => {
      state.assignments.delete(cn);
      renderPreview(view);
    },
    // 自动认错了人：不接受这个结果，重新指认，导入时这条指认会盖掉自动匹配
    override: ({ cn }) => {
      state.overrides.add(cn);
      state.assignments.delete(cn);
      renderPreview(view);
    },
    unoverride: ({ cn }) => {
      state.overrides.delete(cn);
      state.assignments.delete(cn);
      renderPreview(view);
    },
    commit: async (dataset, el) => {
      const confirmDup = document.getElementById('confirmDup');
      if (p.duplicate && !confirmDup?.checked) return toast('请先勾选「我确认要重复导入」', true);
      // 预览之后又改过列的对应关系，屏幕上核对过的金额已经不是要导入的那批了
      if (JSON.stringify(state.columnEdits) !== state.previewedEdits) {
        return toast('列的对应关系改过了，等预览刷新完再导入', true);
      }
      el.disabled = true;
      try {
        const result = await api.post('/api/admin/import/commit', {
          fileName: state.fileName,
          fileHash: state.fileHash,
          sheet: state.sheet,
          columns: state.columnEdits,
          batchName: document.getElementById('batchName').value.trim(),
          orderedAt: document.getElementById('orderedAt').value || null,
          orderNo: document.getElementById('orderNo').value,
          japanTrackingNo: document.getElementById('japanTrackingNo').value,
          confirmDuplicate: Boolean(p.duplicate),
          assignments: [...state.assignments.entries()].map(([cn, a]) => ({
            cn,
            customerId: a.customerId,
            newCustomer: a.newCustomer,
          })),
        });
        toast(`导入成功：${result.itemCount} 件（其中直邮 ${result.directCount || 0} 件），${result.customerCount} 位客户`);
        if (result.createdCustomers.length) {
          const lines = result.createdCustomers
            .map((c) => `${c.nickname}（QQ ${c.qq}）: ${location.origin}/w/${c.token} 初始密码 123456`)
            .join('\n');
          box.innerHTML = `<div class="card"><h3>新建了这些客户，把链接发给他们</h3>
            <textarea style="width:100%;height:140px">${escapeHtml(lines)}</textarea>
            <p class="small muted">不想挨个发链接也行：让他们打开 ${escapeHtml(location.origin)}/login，账号是自己的 QQ 号，初始密码 123456，进去先改成自己的。</p>
            <p><a class="btn" href="#/batches/${result.batchId}">查看这一批</a></p></div>`;
        } else {
          location.hash = `#/batches/${result.batchId}`;
        }
      } catch (err) {
        el.disabled = false;
        toast(err.message, true);
      }
    },
  });
}
