/**
 * 起一个和你在用的开发库完全隔离的 surucubby 实例：单独的端口、单独的本地数据库文件。
 * 演示数据、端到端测试都在这里跑，跑完说再见，不会往 8787 那个正经仓库里塞垃圾批次。
 *
 *   node scripts/sandbox.mjs --state .wrangler/e2e --port 8791 -- node --test test/e2e.test.mjs
 *
 * --state 目录每次开跑前都会删掉重来，所以每次都是干净库。
 * --keep 表示命令跑完之后实例继续开着（演示数据要看页面），Ctrl+C 再一起关掉。
 */
import { spawn, spawnSync } from 'node:child_process';
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

const WRANGLER = path.resolve('node_modules/wrangler/bin/wrangler.js');
if (!fs.existsSync(WRANGLER)) die('找不到 node_modules/wrangler，先 npm install');

const base = `http://127.0.0.1:${opts.port}`;
const childEnv = { ...process.env, E2E_BASE: base, SEED_BASE: base };

// 上一轮被硬杀时，wrangler/workerd 会赖在端口和库文件上不走，先收干净再删目录
squash();
try {
  fs.rmSync(opts.state, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 });
} catch {
  die(`删不掉 ${opts.state}，有进程还占着它。手动结束 wrangler / workerd 之后重试。`);
}

// 端口还有人应答就说明上一轮的实例没死干净。这时下面那个「有 HTTP 响应就算起来了」的探针
// 会误判成自己的实例，测试就写进别人的库里去了，所以直接拒绝开跑。
const squatters = pidsOnPort();
if (squatters.length) die(`端口 ${opts.port} 还被进程 ${squatters.join(' / ')} 占着，先结束它再跑。`);

// 先把迁移打进这个空库，免得 wrangler dev 卡在「要不要应用迁移」的提问上
const migrated = spawnSync(
  process.execPath,
  [WRANGLER, 'd1', 'migrations', 'apply', 'surucubby', '--local', '--persist-to', opts.state],
  { stdio: 'ignore', env: childEnv },
);
if (migrated.status !== 0) die('迁移没打上：' + migrated.stderr?.toString().slice(0, 500));

const log = [];
const dev = spawn(process.execPath, [WRANGLER, 'dev', '--port', String(opts.port), '--ip', '127.0.0.1', '--persist-to', opts.state], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: childEnv,
});
const record = (chunk) => log.push(String(chunk));
dev.stdout.on('data', record);
dev.stderr.on('data', record);
dev.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`隔离实例退出了（${code}）：\n${log.join('').slice(-2000)}`);
    process.exit(1);
  }
});

// 轮询到有任何 HTTP 响应为止；/api/admin/session 不需要登录，最适合当探针
const deadline = Date.now() + 120_000;
for (;;) {
  if (Date.now() > deadline) {
    console.error(`等不到 ${base} 起来：\n${log.join('').slice(-2000)}`);
    stop();
    process.exit(1);
  }
  try {
    const res = await fetch(`${base}/api/admin/session`, { method: 'GET' });
    if (res.status < 500) break;
  } catch {
    /* 还没监听，继续等 */
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const ran = await new Promise((resolve) => {
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: childEnv });
  child.on('exit', (code) => resolve(code ?? 1));
});

if (opts.keep) {
  console.log(`\n实例还开着：${base}　（演示数据在里面，Ctrl+C 关掉）`);
  await new Promise(() => {});
} else {
  teardown();
}
process.exit(ran);

// wrangler 会派生 workerd 子进程；只杀父进程在 Windows 上会留下占着端口和库文件的孤儿，
// 所以下次开跑时按端口再兜一遍，把上一轮的残渣收掉。
// 上一轮被硬杀留下的实例会同时赖着端口和库文件。要收的是带我们这个端口参数的进程
// （wrangler 的 node 父进程会重新生 workerd，只杀 workerd 没用），外加正在监听的孤儿。
function squash() {
  const finder =
    `Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='workerd.exe' or Name='npx.exe'" | ` +
    `Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -like '*--port ${opts.port}*' } | ` +
    'Select-Object -ExpandProperty ProcessId';
  const out = spawnSync('powershell', ['-NoProfile', '-Command', finder], { encoding: 'utf8' }).stdout ?? '';
  const pids = new Set([
    ...out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s)),
    ...pidsOnPort(),
  ]);
  for (const pid of pids) {
    spawnSync('taskkill', ['//PID', pid, '//T', '//F'], { stdio: 'ignore' });
  }
  for (let i = 0; i < 10 && pidsOnPort().length; i += 1) {
    pidsOnPort().forEach((pid) => spawnSync('taskkill', ['//PID', pid, '//T', '//F'], { stdio: 'ignore' }));
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300'], { stdio: 'ignore' });
  }
}

function teardown() {
  if (dev.pid) spawnSync('taskkill', ['//PID', String(dev.pid), '//T', '//F'], { stdio: 'ignore' });
  squash();
}

function pidsOnPort() {
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? '';
  return out
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[0] === 'TCP' && cols[1] === `127.0.0.1:${opts.port}` && cols[3] === 'LISTENING')
    .map((cols) => cols[4]);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    teardown();
    process.exit(0);
  });
}
process.on('exit', teardown);
