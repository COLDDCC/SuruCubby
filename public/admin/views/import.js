import { api } from '/admin/api.js';
import { bindActions, escapeHtml, money, toast } from '/admin/ui.js';
import { collectCellUrls } from '/admin/sheet.js';

const LOCAL_XLSX = '/vendor/xlsx.full.min.js';
const CDN_XLSX = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`加载失败：${src}`));
    document.head.appendChild(el);
  });
}

/** 优先用自托管的 SheetJS（国内更快），没有就退回官方 CDN。 */
async function loadXlsx() {
  if (window.XLSX) return window.XLSX;
  try {
    await loadScript(LOCAL_XLSX);
  } catch {
    await loadScript(CDN_XLSX);
  }
  if (!window.XLSX) throw new Error('SheetJS 没加载成功，检查网络或把 xlsx.full.min.js 放到 /vendor/ 下');
  return window.XLSX;
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let state = {
  sheet: null,
  fileName: '',
  fileHash: '',
  preview: null,
  assignments: new Map(),
  customers: [],
};

export async function render(view) {
  state = { sheet: null, fileName: '', fileHash: '', preview: null, assignments: new Map(), customers: [] };
  view.innerHTML = `
    <div class="card">
      <h2>导入 Excel</h2>
      <p class="small muted">一张表 = 一个日本订单。必需：名称、客户名字。数量默认1，每件独立入库。「应付人民币金额」按整行总额拆分；只有日元「价格」时按单价×数量×汇率计算，先核对预览。</p>
      <input type="file" id="file" accept=".xlsx,.xls,.csv">
      <label for="batchName">批次名</label>
      <input id="batchName" style="width:100%" placeholder="例如 9月20日 第12团">
      <label>日本订单号</label><input id="orderNo">
      <label>日本物流单号（可后补）</label><input id="japanTrackingNo">
      <label>人民币/日元汇率（没有人民币金额列时必填）</label><input id="exchangeRate" inputmode="decimal" placeholder="例如 0.05"><button id="repreview" class="small plain">更新预览</button>
      <label for="orderedAt">下单日期（可不填）</label>
      <input id="orderedAt" type="date">
      <p id="status" class="small muted"></p>
    </div>
    <div id="preview"></div>`;

  document.getElementById('repreview').onclick=()=>state.sheet && loadPreview(view).catch(e=>toast(e.message,true));
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
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
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
    exchangeRate: Number(document.getElementById('exchangeRate').value)||undefined,
  });
  state.preview = preview;
  if (state.customers.length === 0) {
    const data = await api.get('/api/admin/customers');
    state.customers = data.customers;
  }
  renderPreview(view);
}

function renderPreview(view) {
  const p = state.preview;
  const box = document.getElementById('preview');
  const unmatched = p.groups.filter((g) => !g.customer && !state.assignments.has(g.cn));

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
    <div class="card">
      <h3>预览</h3>
      <p class="small">共 ${p.totals.rows} 行 · ${p.totals.customers} 位客户 · 合计 <span class="money">${money(
        p.totals.amountFen,
      )}</span>${unmatched.length ? ` · <span class="unpaid">${unmatched.length} 个名字要先处理</span>` : ''}</p>
      ${
        p.errors.length
          ? `<div class="card" style="border-color:var(--danger)">
              <strong class="unpaid">这些行有问题，必须先在 Excel 里改好：</strong>
              <ul class="small">${p.errors.map((e) => `<li>第 ${e.rowNo} 行：${escapeHtml(e.reason)}</li>`).join('')}</ul>
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
            const matched = g.customer || (assigned && assigned.label);
            return `<tr class="${matched ? '' : 'highlight-row'}">
              <td>${escapeHtml(g.cn)}</td>
              <td class="right">${g.count}</td>
              <td class="right money">${money(g.subtotalFen)}</td>
              <td>${
                g.customer
                  ? `${escapeHtml(g.customer.nickname)}<div class="small muted">${escapeHtml(g.customer.qq)}</div>`
                  : assigned
                    ? `${escapeHtml(assigned.label)} <button class="small plain" data-action="clear" data-cn="${escapeHtml(
                        g.cn,
                      )}">改</button>`
                    : `<div class="row">
                        <select data-pick="${escapeHtml(g.cn)}">
                          <option value="">— 选已有客户 —</option>${customerOptions}
                        </select>
                        <button class="small plain" data-action="use" data-cn="${escapeHtml(g.cn)}">用这个</button>
                      </div>
                      <div class="row" style="margin-top:6px">
                        <input style="width:130px" inputmode="numeric" placeholder="新客户 QQ 号" data-qq="${escapeHtml(g.cn)}">
                        <button class="small plain" data-action="create" data-cn="${escapeHtml(g.cn)}">新建</button>
                      </div>`
              }</td>
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

  bindActions(box, {
    use: ({ cn }) => {
      const select = box.querySelector(`[data-pick="${CSS.escape(cn)}"]`);
      const id = Number(select.value);
      if (!id) return toast('先选一个客户', true);
      const customer = state.customers.find((c) => c.id === id);
      state.assignments.set(cn, { customerId: id, label: `${customer.nickname}（沿用，加别名）` });
      renderPreview(view);
    },
    create: ({ cn }) => {
      const input = box.querySelector(`[data-qq="${CSS.escape(cn)}"]`);
      const qq = input.value.trim();
      if (!/^\d{5,15}$/.test(qq)) return toast('QQ 号格式不对', true);
      state.assignments.set(cn, { newCustomer: { qq, nickname: cn }, label: `新客户 ${qq}` });
      renderPreview(view);
    },
    clear: ({ cn }) => {
      state.assignments.delete(cn);
      renderPreview(view);
    },
    commit: async (dataset, el) => {
      const confirmDup = document.getElementById('confirmDup');
      if (p.duplicate && !confirmDup?.checked) return toast('请先勾选「我确认要重复导入」', true);
      el.disabled = true;
      try {
        const result = await api.post('/api/admin/import/commit', {
          fileName: state.fileName,
          fileHash: state.fileHash,
          sheet: state.sheet,
    exchangeRate: Number(document.getElementById('exchangeRate').value)||undefined,
          batchName: document.getElementById('batchName').value.trim(),
          orderedAt: document.getElementById('orderedAt').value || null,
          orderNo: document.getElementById('orderNo').value, japanTrackingNo:document.getElementById('japanTrackingNo').value,
          confirmDuplicate: Boolean(p.duplicate),
          assignments: [...state.assignments.entries()].map(([cn, a]) => ({
            cn,
            customerId: a.customerId,
            newCustomer: a.newCustomer,
          })),
        });
        toast(`导入成功：${result.itemCount} 件，${result.customerCount} 位客户`);
        if (result.createdCustomers.length) {
          const lines = result.createdCustomers
            .map((c) => `${c.nickname}（${c.qq}）: ${location.origin}/w/${c.token}`)
            .join('\n');
          box.innerHTML = `<div class="card"><h3>新建了这些客户，把链接发给他们</h3>
            <textarea style="width:100%;height:140px">${escapeHtml(lines)}</textarea>
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
