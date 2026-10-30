import { api } from '/admin/api.js';
import { copyText, toast } from '/admin/ui.js';
import { showSearch } from '/admin/search.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');

const routes = [
  {pattern:/^\/requests$/, module:()=>import('/admin/views/requests.js')},
  { pattern: /^\/?$/, module: () => import('/admin/views/dashboard.js') },
  { pattern: /^\/import$/, module: () => import('/admin/views/import.js') },
  { pattern: /^\/batches$/, module: () => import('/admin/views/batches.js') },
  { pattern: /^\/batches\/(\d+)$/, module: () => import('/admin/views/batch.js') },
  { pattern: /^\/packages$/, module: () => import('/admin/views/packages.js') },
  { pattern: /^\/packages\/(\d+)$/, module: () => import('/admin/views/package.js') },
  { pattern: /^\/weigh\/(\d+)$/, module: () => import('/admin/views/weigh.js') },
  { pattern: /^\/customers$/, module: () => import('/admin/views/customers.js') },
  { pattern: /^\/customers\/(\d+)$/, module: () => import('/admin/views/customer.js') },
  { pattern: /^\/shipments$/, module: () => import('/admin/views/shipments.js') },
  { pattern: /^\/payments$/, module: () => import('/admin/views/payments.js') },
  { pattern: /^\/settings$/, module: () => import('/admin/views/settings.js') },
];

function currentPath() {
  return location.hash.replace(/^#/, '').split('?')[0] || '/';
}

/** 侧栏搜完货号会跳到 #/packages/1?item=61 这种地址，把落点那一件圈出来。 */
function focusTarget() {
  const query = location.hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get('item');
}

function highlightItem() {
  view.querySelectorAll('.hit').forEach((el) => el.classList.remove('hit'));
  const id = focusTarget();
  if (!id) return;
  const el = view.querySelector(`[data-focus-item="${id}"]`);
  if (!el) return;
  el.classList.add('hit');
  el.scrollIntoView({ block: 'center' });
}

function markNav() {
  const path = currentPath();
  nav.querySelectorAll('a').forEach((a) => {
    const target = a.getAttribute('href').replace(/^#/, '');
    const active = target === '/' ? path === '/' : path.startsWith(target);
    a.classList.toggle('active', active);
  });
}

function renderLogin(message = '') {
  showSearch(false);
  view.innerHTML = `
    <div class="card" style="max-width:360px;margin:40px auto">
      <h1>后台登录</h1>
      <label for="pw">管理员密码</label>
      <div class="row">
        <input id="pw" type="password" autocomplete="current-password">
        <button id="go">登录</button>
      </div>
      <p id="err" class="unpaid small">${message}</p>
    </div>`;
  const input = document.getElementById('pw');
  const submit = async () => {
    try {
      await api.post('/api/admin/login', { password: input.value });
      route();
    } catch (err) {
      document.getElementById('err').textContent = err.message;
    }
  };
  document.getElementById('go').onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
  };
  input.focus();
}

let loggedIn = false;

export async function route() {
  markNav();
  if (!loggedIn) {
    const session = await api.get('/api/admin/session').catch(() => ({ loggedIn: false }));
    loggedIn = session.loggedIn;
    showSearch(loggedIn);
    if (!loggedIn) {
      renderLogin();
      return;
    }
  }
  const path = currentPath();
  const match = routes.find((r) => r.pattern.test(path));
  if (!match) {
    view.innerHTML = '<div class="card"><p>页面不存在</p></div>';
    return;
  }
  const params = path.match(match.pattern).slice(1);
  view.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const mod = await match.module();
    await mod.render(view, params);
    highlightItem();
  } catch (err) {
    if (err?.status === 401) return;
    console.error(err);
    view.innerHTML = `<div class="card"><p class="unpaid">${err.message || '出错了'}</p></div>`;
  }
}

/**
 * 货号底下的单号 / 来源是拿去群里对货的，点一下就复制。
 * 挂成 document 上的委托，视图重画多少次都不用重新绑。
 */
document.addEventListener('click', async (e) => {
  const chip = e.target instanceof Element ? e.target.closest('[data-copy]') : null;
  if (!chip || !view.contains(chip)) return;
  e.preventDefault();
  const text = chip.dataset.copy;
  const done = await copyText(text);
  toast(done ? `已复制 ${text}` : '这个浏览器不让网页复制，手动选中这段字拷一下', !done);
});

document.addEventListener('need-login', () => {
  loggedIn = false;
  renderLogin('登录已过期，请重新登录');
});

document.getElementById('logout').onclick = async () => {
  await api.post('/api/admin/logout').catch(() => {});
  loggedIn = false;
  renderLogin('已退出');
  toast('已退出');
};

window.addEventListener('hashchange', route);
route();
