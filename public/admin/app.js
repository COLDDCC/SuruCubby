import { api } from '/admin/api.js';
import { toast } from '/admin/ui.js';
import { showSearch } from '/admin/search.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const tabbar = document.getElementById('tabbar');
const sheet = document.getElementById('more-sheet');

/**
 * 菜单只在这里定义一份：桌面端排成顶部横栏，手机端前几个进底部标签栏、其余收进「更多」。
 * roles 决定谁看得见；primary 是手机底栏上常驻的那几个（最多 4 个，再加一个「更多」）。
 */
const NAV = [
  { href: '#/', label: '待办', roles: ['admin'], primary: true },
  // also：不在菜单上、但属于这一项的页面（分拣页、分拣结果），点亮菜单和权限都按它算
  { href: '#/jp', label: '日本仓', roles: ['admin', 'jp'], primary: true, also: ['/sort', '/sort-result'] },
  { href: '#/import', label: '导入', roles: ['admin'] },
  { href: '#/batches', label: '批次', roles: ['admin'] },
  { href: '#/packages', label: '包裹', roles: ['admin'], primary: true },
  { href: '#/customers', label: '客户', roles: ['admin'], primary: true },
  { href: '#/requests', label: '发货申请', roles: ['admin'] },
  { href: '#/shipments', label: '寄出', roles: ['admin'] },
  { href: '#/direct', label: '直邮', roles: ['admin', 'jp'] },
  { href: '#/payments', label: '收款', roles: ['admin'] },
  { href: '#/settings', label: '设置', roles: ['admin'] },
];

let session = { loggedIn: false, role: 'admin', name: '' };

function menuFor(role) {
  return NAV.filter((n) => n.roles.includes(role));
}

function renderMenus() {
  const items = session.loggedIn ? menuFor(session.role) : [];
  const link = (n) => `<a href="${n.href}">${n.label}</a>`;
  nav.innerHTML = items.map(link).join('');
  // 菜单不多（日本仓账号只有两项）就全放底栏；「更多」一直在，退出登录在里面
  const primary = items.length <= 4 ? items : items.filter((n) => n.primary).slice(0, 4);
  tabbar.innerHTML = primary.map(link).join('') + '<button type="button" id="more-open">更多</button>';
  document.getElementById('more-links').innerHTML = items.map(link).join('');
  tabbar.hidden = !session.loggedIn;
  document.body.classList.toggle('has-tabbar', session.loggedIn);
  document.getElementById('search-toggle').hidden = !session.loggedIn || session.role !== 'admin';
  document.getElementById('logout').hidden = !session.loggedIn;
  const who = session.loggedIn ? `${session.name || ''}${session.role === 'jp' ? '（日本仓）' : ''}` : '';
  document.getElementById('who').textContent = who;
  document.getElementById('who-sheet').textContent = who ? `当前账号：${who}` : '';
  const more = document.getElementById('more-open');
  if (more) more.onclick = () => openSheet(true);
  markNav();
}

function openSheet(open) {
  sheet.hidden = !open;
  document.body.classList.toggle('sheet-open', open);
}
sheet.addEventListener('click', (e) => {
  if (e.target === sheet || e.target.closest('[data-close-sheet]') || e.target.closest('a')) openSheet(false);
});

/** 顶栏高度写进 CSS 变量，称重台的进度条等粘性元素贴在它下面，而不是被它盖住。 */
const topbar = document.getElementById('topbar');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
}).observe(topbar);

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
  { pattern: /^\/jp$/, module: () => import('/admin/views/jp.js') },
  { pattern: /^\/sort\/(\d+)$/, module: () => import('/admin/views/sort.js') },
  { pattern: /^\/sort-result\/(\d+)$/, module: () => import('/admin/views/sortResult.js') },
  { pattern: /^\/direct$/, module: () => import('/admin/views/direct.js') },
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

function navMatches(n, path) {
  const target = n.href.replace(/^#/, '');
  if (target === '/') return path === '/';
  return [target, ...(n.also ?? [])].some((t) => path === t || path.startsWith(t + '/'));
}

function markNav() {
  const path = currentPath();
  document.querySelectorAll('#nav a, #tabbar a, #more-links a').forEach((a) => {
    const n = NAV.find((x) => x.href === a.getAttribute('href'));
    a.classList.toggle('active', !!n && navMatches(n, path));
  });
  // 当前页不在底栏上（收在「更多」里）时，把「更多」点亮，让人知道自己在哪
  const more = document.getElementById('more-open');
  if (more) more.classList.toggle('active', !tabbar.querySelector('a.active') && !!document.querySelector('#more-links a.active'));
}

function renderLogin(message = '') {
  showSearch(false);
  session = { loggedIn: false, role: 'admin', name: '' };
  renderMenus();
  view.innerHTML = `
    <div class="card login-card">
      <h1>后台登录</h1>
      <form id="login-form">
        <label for="user">账号</label>
        <input id="user" autocomplete="username" autocapitalize="off" spellcheck="false" value="admin">
        <label for="pw">密码</label>
        <input id="pw" type="password" autocomplete="current-password">
        <p><button id="go" type="submit" class="block">登录</button></p>
      </form>
      <p class="small muted">管理员和日本仓都从这里进；账号由管理员在「设置 → 员工」里开。</p>
      <p id="err" class="unpaid small">${message}</p>
    </div>`;
  const user = document.getElementById('user');
  const input = document.getElementById('pw');
  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/admin/login', { username: user.value.trim(), password: input.value });
      route();
    } catch (err) {
      document.getElementById('err').textContent = err.message;
    }
  };
  (user.value ? input : user).focus();
}

export function currentSession() {
  return session;
}

export async function route() {
  openSheet(false);
  document.body.classList.remove('rail-open');
  if (!session.loggedIn) {
    const s = await api.get('/api/admin/session').catch(() => ({ loggedIn: false }));
    if (!s.loggedIn) {
      renderLogin();
      return;
    }
    session = { loggedIn: true, role: s.role || 'admin', name: s.name || '' };
    renderMenus();
    showSearch(session.role === 'admin');
  }
  markNav();
  let path = currentPath();
  // 日本仓账号没有「待办」，首页直接是日本仓
  if (session.role === 'jp' && path === '/') path = '/jp';
  const allowed = menuFor(session.role).some((n) => navMatches(n, path));
  const match = routes.find((r) => r.pattern.test(path));
  if (!match || (session.role !== 'admin' && !allowed)) {
    view.innerHTML = '<div class="card"><p>页面不存在，或者这个账号看不了这一页。</p></div>';
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

document.addEventListener('need-login', () => {
  renderLogin('登录已过期，请重新登录');
});

async function logout() {
  openSheet(false);
  await api.post('/api/admin/logout').catch(() => {});
  renderLogin('已退出');
  toast('已退出');
}
document.getElementById('logout').onclick = logout;
document.getElementById('logout-sheet').onclick = logout;

const searchToggle = document.getElementById('search-toggle');
searchToggle.onclick = () => {
  const open = !document.body.classList.contains('rail-open');
  document.body.classList.toggle('rail-open', open);
  searchToggle.setAttribute('aria-expanded', String(open));
  if (open) document.getElementById('rail-q').focus();
};

window.addEventListener('hashchange', route);
route();
