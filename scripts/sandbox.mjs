/**
 * 起一个和你在用的开发库完全隔离的 surucubby 实例：单独的端口、单独的数据目录。
 * 演示数据、端到端测试都在这里跑，跑完说再见，不会往 8787 那个正经仓库里塞垃圾批次。
 *
 *   node scripts/sandbox.mjs --state .sandbox/e2e --port 8791 -- node --test test/e2e.test.mjs
 *
 * --state 目录每次开跑前都会删掉重来，所以每次都是干净库。
 * --keep 表示命令跑完之后实例继续开着（演示数据要看页面），Ctrl+C 再一起关掉。
 *
 * 实例就是 src/server.ts（Node 版），和线上 VPS 跑的是同一个入口；
 * 后台密码固定 test-admin-pw（可用 E2E_PASSWORD 覆盖），只给测试用。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opts = { state: '', port: 0, keep: false };
let rest = 0;
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i];
  if (flag === '--state') opts.state = argv[(i += 1)];
  else if (flag === '--port') opts.port = Number(argv[(i += 1)]);
  else if (flag === '--keep') opts.keep = true;
  else if (flag === '--') {
    rest = i + 1;
    break;
  } else {
    die(`不认识的参数 ${flag}`);
  }
}
const command = argv.slice(rest);
if (!opts.state || !opts.port || !command.length) {
  die('用法：node scripts/sandbox.mjs --state <目录> --port <端口> [--keep] -- <命令>');
}

function die(message) {
  console.error(message);
  process.exit(1);
}

const base = `http://127.0.0.1:${opts.port}`;
const password = process.env.E2E_PASSWORD || 'test-admin-pw';
const childEnv = { ...process.env, E2E_BASE: base, SEED_BASE: base, E2E_PASSWORD: password };

// 端口还有人应答就说明上一轮的实例没死干净，测试会写进别人的库里去，直接拒绝开跑
try {
  await fetch(`${base}/api/meta`, { signal: AbortSignal.timeout(800) });
  die(`端口 ${opts.port} 已经有服务在应答，先结束它再跑。`);
} catch {
  /* 没人应答，正好 */
}

try {
  fs.rmSync(opts.state, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
} catch {
  die(`删不掉 ${opts.state}，有进程还占着它。`);
}
fs.mkdirSync(opts.state, { recursive: true });

const log = [];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.resolve('src/server.ts')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(opts.port),
    HOST: '127.0.0.1',
    DATA_DIR: path.resolve(opts.state),
    ADMIN_PASSWORD: password,
    SESSION_SECRET: crypto.randomBytes(24).toString('hex'),
    TRUST_PROXY: '0',
  },
});
const record = (chunk) => log.push(String(chunk));
server.stdout.on('data', record);
server.stderr.on('data', record);
let stopping = false;
server.on('exit', (code) => {
  if (!stopping && code) {
    console.error(`隔离实例退出了（${code}）：\n${log.join('').slice(-2000)}`);
    process.exit(1);
  }
});

const deadline = Date.now() + 30_000;
for (;;) {
  if (Date.now() > deadline) {
    console.error(`等不到 ${base} 起来：\n${log.join('').slice(-2000)}`);
    teardown();
    process.exit(1);
  }
  try {
    const res = await fetch(`${base}/api/meta`);
    if (res.ok) break;
  } catch {
    /* 还没监听，继续等 */
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const ran = await new Promise((resolve) => {
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: childEnv, shell: process.platform === 'win32' });
  child.on('exit', (code) => resolve(code ?? 1));
});

if (opts.keep) {
  console.log(`\n实例还开着：${base}　（后台密码 ${password}，Ctrl+C 关掉）`);
  await new Promise(() => {});
} else {
  teardown();
}
process.exit(ran);

function teardown() {
  stopping = true;
  if (server.exitCode === null) server.kill();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    teardown();
    process.exit(0);
  });
}
process.on('exit', teardown);
