/**
 * 端到端测试的小工具：每个 Client 有自己的 Cookie 罐子，可以同时扮演管理员、日本仓、客户。
 * 只在 sandbox 起的隔离实例上跑（npm run test:e2e），不给 E2E_BASE 就拒绝。
 */
export const BASE = process.env.E2E_BASE || refuse();
export const PASSWORD = process.env.E2E_PASSWORD || 'test-admin-pw';

function refuse() {
  console.error('测试要写库，不往 8787 塞垃圾。用 npm run test:e2e，或自己给 E2E_BASE。');
  process.exit(1);
}

export class Client {
  jar = new Map();

  async call(method, path, body, { raw = false } = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        cookie: [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const idx = pair.indexOf('=');
      const value = pair.slice(idx + 1);
      if (value === '' || /max-age=0/i.test(cookie)) this.jar.delete(pair.slice(0, idx));
      else this.jar.set(pair.slice(0, idx), value);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 不是 JSON */
    }
    if (raw) return { status: res.status, data };
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  }

  get(path, opts) {
    return this.call('GET', path, undefined, opts);
  }
  post(path, body = {}, opts) {
    return this.call('POST', path, body, opts);
  }
  patch(path, body = {}, opts) {
    return this.call('PATCH', path, body, opts);
  }
}

export async function adminClient() {
  const client = new Client();
  await client.post('/api/admin/login', { username: 'admin', password: PASSWORD });
  return client;
}

export const stamp = Date.now();
export const uniq = (prefix) => `${prefix}${stamp}${Math.floor(Math.random() * 1000)}`;
/** 9 位、不和别的测试撞的 QQ 号 */
let qqSeq = 0;
export const qq = () => `${(stamp + (qqSeq += 7)) % 1e9}`.padStart(9, '7');
