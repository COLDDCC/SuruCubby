import { api } from '/admin/api.js';
import { bindActions, empty, escapeHtml, money, openModal, promptBox, toast, yen } from '/admin/ui.js';
import { readSheet } from '/admin/xlsx.js';

export async function render(view, params, query = '') {
  const data = await api.get(`/api/admin/customers?q=${encodeURIComponent(query)}`);
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">客户</h2>
        <div class="row">
          <button class="small plain" data-action="roster">导入名单</button>
          <button class="small" data-action="new">新建客户</button>
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <input id="q" placeholder="搜 QQ / 昵称 / 真名 / 别名" value="${escapeHtml(query)}">
        <button class="small plain" data-action="search">搜索</button>
      </div>
      <p class="small muted">客户统一入口 <a href="/login" target="_blank">${escapeHtml(location.origin)}/login</a>：输自己的 QQ 号和密码就能进，初始密码 123456；专属链接照旧能用，不用挨个发。</p>
      ${
        data.customers.length
          ? data.customers
              .map((c) => {
                const goods = c.goodsUnpaidJpy;
                const freight = c.intlUnpaidFen + c.domesticUnpaidFen;
                return `<div class="list-row">
            <div class="main">
              <a href="#/customers/${c.id}">${escapeHtml(c.nickname)}</a>${
                c.realName ? `<span class="small muted">（${escapeHtml(c.realName)}）</span>` : ''
              }${c.selfReturn ? ' <span class="badge">不拼邮</span>' : ''}
              <div class="small muted">QQ ${escapeHtml(c.qq)} · ${c.itemCount} 件 · 可发货 ${c.stockCount}${
                c.passwordInitial ? ' · <span class="unpaid">还在用初始密码</span>' : ''
              }</div>
            </div>
            <div class="side">
              <span class="${goods ? 'unpaid' : 'paid'} money">${yen(goods)}</span>
              ${freight ? `<span class="small unpaid money">运费 ${money(freight)}</span>` : ''}
              <button class="small plain" data-action="copy" data-token="${escapeHtml(c.token)}">复制链接</button>
            </div>
          </div>`;
              })
              .join('')
          : empty('没有匹配的客户')
      }
    </div>`;

  const search = () => render(view, params, document.getElementById('q').value.trim());
  document.getElementById('q').onkeydown = (e) => {
    if (e.key === 'Enter') search();
  };

  bindActions(view, {
    search,
    copy: async ({ token }) => {
      const url = `${location.origin}/w/${token}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('链接已复制');
      } catch {
        await promptBox('复制这条链接发给客户', url);
      }
    },
    new: () => {
      openModal((box, close) => {
        box.innerHTML = `
          <h3>新建客户</h3>
          <label>QQ 号</label><input id="qq" inputmode="numeric" style="width:100%">
          <label>昵称（Excel 里的 cn 名字）</label><input id="nick" style="width:100%">
          <label>真名（只有后台看得到，可留空）</label><input id="real" style="width:100%">
          <div class="row" style="justify-content:flex-end;margin-top:12px">
            <button class="plain" data-no>取消</button><button data-yes>创建</button>
          </div>`;
        box.querySelector('[data-no]').onclick = close;
        box.querySelector('[data-yes]').onclick = async () => {
          try {
            await api.post('/api/admin/customers', {
              qq: box.querySelector('#qq').value.trim(),
              nickname: box.querySelector('#nick').value.trim(),
              realName: box.querySelector('#real').value.trim() || null,
            });
            close();
            toast('已创建');
            render(view, params, query);
          } catch (err) {
            toast(err.message, true);
          }
        };
      });
    },
    roster: () => rosterModal(view, params, query),
  });
}

/** 名单导入：选表 → 指认三列 → 先看结果（不写库）→ 确认才落库。 */
function rosterModal(view, params, query) {
  openModal((box, close) => {
    box.innerHTML = `
      <h3>导入客户名单</h3>
      <p class="small muted">表里有「名字」和「QQ 号」两列就够，「真名」有就一起读进来，没有也能导。真名只有你在后台看得到，客户自己的页面不显示。</p>
      <input type="file" id="rosterFile" accept=".xlsx,.xls,.csv">
      <div id="rosterMap" style="display:none">
        <label>名字在哪一列</label><select id="mapNick" style="width:100%"></select>
        <label>QQ 号在哪一列</label><select id="mapQq" style="width:100%"></select>
        <label>真名在哪一列</label><select id="mapReal" style="width:100%"></select>
      </div>
      <div id="rosterReport"></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="plain" data-close>关掉</button>
        <button class="plain" data-check disabled>先看结果</button>
        <button data-yes disabled>确认导入</button>
      </div>`;

    const els = {
      file: box.querySelector('#rosterFile'),
      map: box.querySelector('#rosterMap'),
      nick: box.querySelector('#mapNick'),
      qq: box.querySelector('#mapQq'),
      real: box.querySelector('#mapReal'),
      report: box.querySelector('#rosterReport'),
      check: box.querySelector('[data-check]'),
      yes: box.querySelector('[data-yes]'),
    };
    box.querySelector('[data-close]').onclick = close;
    let sheet = null;

    const cellText = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return String(Math.round(v));
      return String(v).trim();
    };
    const guess = (words) => {
      if (!sheet) return -1;
      return sheet.headers.findIndex((h) => words.some((w) => h.toLowerCase().includes(w)));
    };
    const fillSelect = (el, selected, allowNone) => {
      const head = allowNone
        ? '<option value="-1">— 不用这列 —</option>'
        : `<option value="${selected >= 0 ? selected : ''}"${selected < 0 ? ' disabled selected' : ''}>${
            selected >= 0 ? '' : '— 选哪一列 —'
          }</option>`;
      el.innerHTML =
        head +
        sheet.headers
          .map(
            (h, i) =>
              `<option value="${i}"${i === selected ? ' selected' : ''}>${escapeHtml(h)}（第 ${i + 1} 列：${escapeHtml(
                cellText(sheet.rows[0][i]),
              )}）</option>`,
          )
          .join('');
    };

    els.file.onchange = async () => {
      const f = els.file.files[0];
      if (!f) return;
      try {
        sheet = await readSheet(f);
        els.map.style.display = '';
        fillSelect(els.nick, guess(['昵称', '名字', '称呼', 'cn', '群名片']), false);
        fillSelect(els.qq, guess(['qq', 'q号', 'q 号']), false);
        fillSelect(els.real, guess(['真名', '实名', '姓名']), true);
        els.report.innerHTML = `<p class="small">${sheet.sheetName}：读到 ${sheet.rows.length} 行。确认三列指对了再「先看结果」。</p>`;
        els.check.disabled = false;
        els.yes.disabled = true;
      } catch (err) {
        toast(err.message, true);
      }
    };

    const rows = () => {
      const pick = (el, r) => {
        const at = Number(el.value);
        return el.value === '' || Number.isNaN(at) || at < 0 ? '' : cellText(r[at]);
      };
      return sheet.rows.map((r) => ({
        nickname: pick(els.nick, r),
        qq: pick(els.qq, r),
        realName: pick(els.real, r) || null,
      }));
    };

    /** 列还没指认清楚就先别跑，指错列会把名单灌成一片乱账 */
    const columnsPicked = () => {
      if (els.nick.value === '' || els.qq.value === '') {
        toast('先把「名字」和「QQ 号」两列指出来', true);
        return false;
      }
      return true;
    };

    const run = async (dryRun) => {
      if (!columnsPicked()) return null;
      els.check.disabled = true;
      els.yes.disabled = true;
      try {
        const r = await api.post('/api/admin/customers/import', {
          dryRun,
          fileName: els.file.files[0]?.name || null,
          rows: rows(),
        });
        report(r);
        if (dryRun) els.yes.disabled = false;
        return r;
      } catch (err) {
        toast(err.message, true);
        els.report.innerHTML = `<p class="small unpaid">${escapeHtml(err.message)}</p>`;
        return null;
      } finally {
        els.check.disabled = false;
      }
    };

    const list = (items, cls) =>
      items.length
        ? `<ul class="small ${cls}">${items
            .slice(0, 12)
            .map((x) => `<li>${escapeHtml(x.reason)}</li>`)
            .join('')}${items.length > 12 ? `<li>……一共 ${items.length} 条</li>` : ''}</ul>`
        : '';

    const report = (r) => {
      const c = r.counts;
      els.report.innerHTML = `
        <p class="small" style="margin-top:10px">${
          r.dryRun ? '预演结果（还没写进库）：' : '已经写进库：'
        }新增 <strong>${c.created}</strong> 人 · 已有客户补上名字或真名 <strong>${c.updated}</strong> 人 · 冲突 <strong class="${
          c.conflicts ? 'unpaid' : ''
        }">${c.conflicts}</strong> 行 · 读不了 <strong class="${c.errors ? 'unpaid' : ''}">${c.errors}</strong> 行</p>
        ${
          c.conflicts
            ? `<p class="small unpaid">这些行没动：名字已经属于另一个人，导入不会抢别人的名字。先去客户页把那位改名或合并，再导一次。</p>${list(
                r.conflicts,
                'unpaid',
              )}`
            : ''
        }${c.errors ? list(r.errors, 'unpaid') : ''}`;
    };

    els.check.onclick = () => run(true);
    els.yes.onclick = async () => {
      const r = await run(false);
      if (!r) return;
      close();
      toast(`名单导完：新增 ${r.counts.created} 人，补了 ${r.counts.updated} 人`);
      render(view, params, query);
    };
  });
}
