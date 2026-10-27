import { api } from '/admin/api.js';
import { beijingTime, bindActions, confirmBox, escapeHtml, money, promptBox, toast } from '/admin/ui.js';

const ROLE = { admin: '管理员', jp: '日本仓' };

/** 日志里的接口路径翻成人话，翻不出来的照原样显示。 */
const ACTIONS = [
  [/^POST \/api\/admin\/import\/commit$/, '导入订单'],
  [/^POST \/api\/admin\/payments/, '记收款'],
  [/^DELETE \/api\/admin\/payments/, '撤销收款'],
  [/^POST \/api\/admin\/staff$/, '新建员工'],
  [/^PATCH \/api\/admin\/staff\//, '改员工账号'],
  [/^POST \/api\/admin\/settings$/, '改设置'],
  [/^POST \/api\/admin\/shipments/, '登记寄出'],
  [/^PATCH \/api\/admin\/shipments/, '改寄出'],
  [/^POST \/api\/admin\/packages\/\d+\/weigh/, '称重 / 分摊'],
  [/^PATCH \/api\/admin\/packages/, '改包裹'],
  [/^POST \/api\/admin\/requests/, '处理发货申请'],
  [/^POST \/api\/staff\/jp\/receive/, '日本仓签收'],
  [/^POST \/api\/staff\/jp\/route/, '改发货方式'],
  [/^POST \/api\/staff\/direct/, '直邮操作'],
  [/^(POST|PATCH) \/api\/admin\/items/, '改物品'],
  [/^(POST|PATCH|DELETE) \/api\/admin\/customers/, '改客户'],
  [/^(POST|PATCH|DELETE) \/api\/admin\/batches/, '改批次'],
];

function actionLabel(log) {
  const key = `${log.method} ${log.path}`;
  return ACTIONS.find(([re]) => re.test(key))?.[1] ?? key;
}

export async function render(view) {
  const [data, staff, audit] = await Promise.all([
    api.get('/api/admin/settings'),
    api.get('/api/admin/staff'),
    api.get('/api/admin/staff/audit?limit=60'),
  ]);

  const staffRows = staff.staff
    .map(
      (s) => `<tr class="${s.disabled ? 'muted' : ''}">
        <td><strong>${escapeHtml(s.displayName)}</strong><div class="small muted"><code>${escapeHtml(s.username)}</code></div></td>
        <td>${ROLE[s.role] ?? s.role}${s.disabled ? ' <span class="badge warn">已停用</span>' : ''}</td>
        <td class="small muted">${s.lastLoginAt ? beijingTime(s.lastLoginAt) : '还没登录过'}</td>
        <td class="actions">
          <button class="small plain" data-action="password" data-id="${s.id}" data-name="${escapeHtml(s.displayName)}">重设密码</button>
          ${
            s.id === staff.me.id
              ? ''
              : `<button class="small plain" data-action="role" data-id="${s.id}" data-role="${s.role}">改成${s.role === 'admin' ? '日本仓' : '管理员'}</button>
                 <button class="small ${s.disabled ? 'plain' : 'danger'}" data-action="toggle" data-id="${s.id}" data-disabled="${s.disabled ? 1 : 0}" data-name="${escapeHtml(s.displayName)}">${s.disabled ? '启用' : '停用'}</button>`
          }
        </td>
      </tr>`,
    )
    .join('');

  const logRows = audit.logs
    .map(
      (l) => `<tr>
        <td class="small muted nowrap">${beijingTime(l.at)}</td>
        <td class="small">${escapeHtml(l.staffName)}${l.role === 'jp' ? '<span class="muted">（日本仓）</span>' : ''}</td>
        <td class="small">${escapeHtml(actionLabel(l))}
          ${l.detail ? `<details><summary>内容</summary><code class="small wrap-any">${escapeHtml(l.detail)}</code></details>` : ''}</td>
      </tr>`,
    )
    .join('');

  view.innerHTML = `
    <div class="card">
      <h2>运费和分拣设置</h2>
      <div class="form-grid">
        <div>
          <label for="fee">国内寄出每次收费（元）</label>
          <input id="fee" inputmode="decimal" value="${(data.domesticFeeFen / 100).toFixed(2)}">
          <p class="small muted">当前：${money(data.domesticFeeFen)} / 次，与件数无关。改动只影响之后新建的寄出。</p>
        </div>
        <div>
          <label for="price">拼团国际运费单价（元 / kg）</label>
          <input id="price" inputmode="decimal" value="${(data.intlPriceFenPerKg / 100).toFixed(2)}">
          <p class="small muted">当前：${money(data.intlPriceFenPerKg)} / kg。称重台「算分摊」按这个单价推出这一箱的运费。</p>
        </div>
        ${
          data.directPriceFenPerKg === undefined
            ? ''
            : `<div>
          <label for="direct-price">日本直邮单价（元 / kg）</label>
          <input id="direct-price" inputmode="decimal" value="${(data.directPriceFenPerKg / 100).toFixed(2)}">
          <p class="small muted">当前：${money(data.directPriceFenPerKg)} / kg。直邮包裹称重时按这个价算运费并存档，之后改价不影响已称好的包裹。</p>
        </div>`
        }
        <div>
          <label for="max-boxes">一次分拣最多开几箱（拼团）</label>
          <input id="max-boxes" inputmode="numeric" value="${data.maxBoxesPerSort ?? 9}">
          <p class="small muted">分拣页「再开一箱」最多到这个数。现在一般 9 箱以内，要更多就改大（最多 50）。</p>
        </div>
      </div>
      <p><button id="save">保存设置</button></p>
    </div>

    <div class="card">
      <h2>员工账号</h2>
      <p class="small muted">每人一个账号，操作都会记下是谁做的。<b>管理员</b>什么都能做（国内分发的人也开管理员）；
        <b>日本仓</b>只看得到签收、分拣、直邮打包这几页，看不到货款、收款和客户 QQ。
        环境变量里的密码一直可以用账号 <code>admin</code> 登录，作为兜底。</p>
      <div class="table-scroll"><table>
        <thead><tr><th>名字 / 账号</th><th>角色</th><th>最近登录</th><th></th></tr></thead>
        <tbody>${staffRows || '<tr><td colspan="4" class="muted">还没有员工账号，下面新建一个。</td></tr>'}</tbody>
      </table></div>
      <h3 style="margin-top:16px">新建账号</h3>
      <form id="new-staff" class="form-grid">
        <div><label for="ns-user">账号（登录用）</label><input id="ns-user" autocomplete="off" autocapitalize="off" placeholder="例如 tokyo"></div>
        <div><label for="ns-name">名字（显示用）</label><input id="ns-name" maxlength="20" placeholder="例如 东京小王"></div>
        <div><label for="ns-role">角色</label>
          <select id="ns-role"><option value="jp">日本仓</option><option value="admin">管理员</option></select></div>
        <div><label for="ns-pw">初始密码（至少 8 位）</label><input id="ns-pw" type="text" autocomplete="new-password"></div>
        <div class="form-grid-full"><button type="submit">新建账号</button>
          <span class="small muted">建好后把账号和密码私发给他，登录地址就是这个后台。</span></div>
      </form>
    </div>

    <div class="card">
      <h2>操作记录</h2>
      <p class="small muted">最近 ${audit.logs.length} 条写操作，最新的在上面。密码一律不记。</p>
      <div class="table-scroll"><table><tbody>${logRows || '<tr><td class="muted">还没有记录</td></tr>'}</tbody></table></div>
    </div>`;

  document.getElementById('save').onclick = async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const body = {
        domesticFeeYuan: document.getElementById('fee').value.trim(),
        intlPriceYuanPerKg: document.getElementById('price').value.trim(),
      };
      const direct = document.getElementById('direct-price');
      if (direct) body.directPriceYuanPerKg = direct.value.trim();
      body.maxBoxesPerSort = document.getElementById('max-boxes').value.trim();
      const r = await api.post('/api/admin/settings', body);
      toast(`已保存：国内 ${money(r.domesticFeeFen)} / 次，拼团 ${money(r.intlPriceFenPerKg)} / kg`);
      await render(view);
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
    }
  };

  document.getElementById('new-staff').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/admin/staff', {
        username: document.getElementById('ns-user').value.trim(),
        displayName: document.getElementById('ns-name').value.trim(),
        role: document.getElementById('ns-role').value,
        password: document.getElementById('ns-pw').value,
      });
      toast('账号建好了');
      await render(view);
    } catch (err) {
      toast(err.message, true);
    }
  };

  bindActions(view, {
    async password({ id, name }) {
      const pw = await promptBox(`给 ${name} 设一个新密码（至少 8 位）。设完他会当场掉线，要用新密码重新登录。`, '', { okText: '设好了' });
      if (!pw) return;
      await api.patch(`/api/admin/staff/${id}`, { password: pw });
      toast('密码已重设，记得私发给他');
    },
    async role({ id, role }) {
      const next = role === 'admin' ? 'jp' : 'admin';
      if (!(await confirmBox(`改成「${ROLE[next]}」？${next === 'admin' ? '管理员能看到所有账目和客户信息。' : ''}`))) return;
      await api.patch(`/api/admin/staff/${id}`, { role: next });
      await render(view);
    },
    async toggle({ id, disabled, name }) {
      const disabling = disabled !== '1';
      if (disabling && !(await confirmBox(`停用 ${name}？他会当场掉线、登不进来，操作记录保留。`, { okText: '停用', danger: true }))) return;
      await api.patch(`/api/admin/staff/${id}`, { disabled: disabling });
      await render(view);
    },
  });
}
