const tabUser = document.getElementById('tab-user');
const tabAdmin = document.getElementById('tab-admin');
const formUser = document.getElementById('form-user');
const formAdmin = document.getElementById('form-admin');
const msg = document.getElementById('msg');
const qqInput = document.getElementById('qq');
const userPw = document.getElementById('user-pw');
const adminPw = document.getElementById('admin-pw');

function say(text, kind = 'err') {
  msg.hidden = !text;
  msg.className = `small ${kind === 'ok' ? 'paid' : 'unpaid'}`;
  msg.textContent = text || '';
}

function showAdmin(show) {
  tabAdmin.className = show ? 'btn' : 'btn ghost';
  tabUser.className = show ? 'btn ghost' : 'btn';
  formAdmin.hidden = !show;
  formUser.hidden = show;
  say('');
  (show ? adminPw : qqInput).focus();
}

tabUser.addEventListener('click', () => showAdmin(false));
tabAdmin.addEventListener('click', () => showAdmin(true));

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应就当空，别让一句报错变成整页卡住 */
  }
  return { ok: res.ok, data };
}

function busy(form, on) {
  form.querySelector('button[type="submit"]').disabled = on;
}

let adminLoggedIn = false;

formUser.addEventListener('submit', async (e) => {
  e.preventDefault();
  busy(formUser, true);
  const { ok, data } = await post('/api/w/login', {
    qq: qqInput.value.trim(),
    password: userPw.value,
  });
  busy(formUser, false);
  if (!ok) {
    // 后端会报还剩几次，别说一半让人试到被锁 15 分钟
    say(data.left ? `${data.error}（还能再试 ${data.left} 次）` : data.error || '登录失败');
    return;
  }
  localStorage.setItem('surucubby_qq', qqInput.value.trim());
  location.href = `/w/${encodeURIComponent(data.token)}`;
});

formAdmin.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (adminLoggedIn) {
    location.href = '/admin/';
    return;
  }
  busy(formAdmin, true);
  const { ok, data } = await post('/api/admin/login', { password: adminPw.value });
  busy(formAdmin, false);
  if (!ok) {
    say(data.error || '密码不对');
    return;
  }
  location.href = '/admin/';
});

qqInput.value = localStorage.getItem('surucubby_qq') || '';
if (new URLSearchParams(location.search).get('out')) say('已经退出了，再进来要用 QQ 号和密码', 'ok');

// 后台的登录状态是浏览器记着的，已经登过就不必再让群主输一遍密码
fetch('/api/admin/session')
  .then((r) => r.json())
  .then((s) => {
    if (!s.loggedIn) return;
    adminLoggedIn = true;
    formAdmin.querySelector('button[type="submit"]').textContent = '直接进后台';
    adminPw.placeholder = '这台电脑已经登录过，不用填';
  })
  .catch(() => {});

if (qqInput.value) userPw.focus();
