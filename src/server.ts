/**
 * VPS / 本机用的 Node 入口：同一个 Hono 应用，换一套底座。
 *
 *   node --disable-warning=ExperimentalWarning src/server.ts
 *
 * 环境变量（也可以写进项目根目录的 .env）：
 *   PORT              监听端口，默认 8787
 *   HOST              监听地址，默认 127.0.0.1（前面放 Caddy 反代；要直接对外才改成 0.0.0.0）
 *   DATA_DIR          数据目录，默认 ./data（数据库、图片、缓存都在这）
 *   ADMIN_PASSWORD    后台引导密码（账号 admin）
 *   SESSION_SECRET    Cookie 签名密钥
 *   TRUST_PROXY       设为 1 时信任反代传来的 X-Forwarded-For / X-Forwarded-Proto
 *   IMAGE_CACHE_MB    封面磁盘缓存上限，默认 2048
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import app from './index.ts';
import type { Env } from './lib/env.ts';
import { SqliteD1, applyMigrations } from './node/d1.ts';
import { createAssets } from './node/assets.ts';
import { DiskBucket, DiskImageCache } from './node/storage.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 25 * 1024 * 1024;

/** 最简单的 .env 读取：KEY=VALUE 一行一个，已经在环境里的不覆盖。 */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export interface ServerOptions {
  port: number;
  host: string;
  dataDir: string;
  adminPassword?: string;
  sessionSecret?: string;
  trustProxy: boolean;
  imageCacheBytes: number;
}

export function createServer(opts: ServerOptions): { server: http.Server; db: SqliteD1 } {
  const db = new SqliteD1(opts.dataDir === ':memory:' ? ':memory:' : path.join(opts.dataDir, 'surucubby.db'));
  const applied = applyMigrations(db, path.join(ROOT, 'migrations'));
  if (applied.length) console.log(`已打迁移：${applied.join('、')}`);

  const filesDir = opts.dataDir === ':memory:' ? path.join(ROOT, '.data-memory') : opts.dataDir;
  const env: Env = {
    DB: db,
    ASSETS: createAssets(path.join(ROOT, 'public')),
    IMAGES: new DiskBucket(path.join(filesDir, 'images')),
    IMAGE_CACHE: new DiskImageCache(path.join(filesDir, 'image-cache'), opts.imageCacheBytes),
    ADMIN_PASSWORD: opts.adminPassword,
    SESSION_SECRET: opts.sessionSecret,
  };

  const pending = new Set<Promise<unknown>>();
  const ctx: ExecutionContext & { props: Record<string, unknown> } = {
    props: {},
    waitUntil(promise) {
      const p = promise.catch((err) => console.error('后台任务出错', err)).finally(() => pending.delete(p));
      pending.add(p);
    },
    passThroughOnException() {},
  };

  const server = http.createServer(async (req, res) => {
    try {
      const request = await toRequest(req, opts.trustProxy);
      if (!request) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' }).end('请求太大');
        return;
      }
      const response = await app.fetch(request, env, ctx);
      await sendResponse(res, response, req.method === 'HEAD');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('服务器出错了');
    }
  });
  server.on('close', () => db.close());
  return { server, db };
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'local';
}

async function toRequest(req: http.IncomingMessage, trustProxy: boolean): Promise<Request | null> {
  const proto = trustProxy ? String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() : 'http';
  const host = req.headers.host ?? 'localhost';
  const url = `${proto === 'https' ? 'https' : 'http'}://${host}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.set(key, value);
  }
  // 登录限流按 IP 计数，代码里读的是 Cloudflare 的头；这里由入口填真实 IP，客户端自己带的一律覆盖掉
  headers.set('cf-connecting-ip', clientIp(req, trustProxy));

  let body: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return null;
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body: body?.length ? new Uint8Array(body) : undefined });
}

async function sendResponse(res: http.ServerResponse, response: Response, head: boolean): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === 'set-cookie') return;
    headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (head || !response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    res.write(chunk);
  }
  res.end();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadDotEnv(path.join(process.cwd(), '.env'));
  loadDotEnv(path.join(process.cwd(), '.dev.vars'));
  const opts: ServerOptions = {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? '127.0.0.1',
    dataDir: path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data')),
    adminPassword: process.env.ADMIN_PASSWORD,
    sessionSecret: process.env.SESSION_SECRET,
    trustProxy: process.env.TRUST_PROXY === '1',
    imageCacheBytes: Number(process.env.IMAGE_CACHE_MB ?? 2048) * 1024 * 1024,
  };
  if (!opts.sessionSecret) console.warn('警告：没有设置 SESSION_SECRET，登录会失败。');
  const { server } = createServer(opts);
  server.listen(opts.port, opts.host, () => {
    console.log(`速达云仓 已启动：http://${opts.host}:${opts.port}  数据目录 ${opts.dataDir}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
