/**
 * Node 上的静态资源服务，行为对齐 Workers 的 ASSETS 绑定（默认的 html_handling）：
 *   /admin/        → public/admin/index.html
 *   /customer      → public/customer.html
 *   /customer.html → 307 到 /customer（src/index.ts 的 serveAsset 会自己跟完）
 *   找不到         → 404、空正文、没有 content-type（src/index.ts 据此换成有话说的 404 页）
 */
import fs from 'node:fs';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function createAssets(root: string): Fetcher {
  const base = path.resolve(root);

  /** 把 URL 路径映射到 public 下的文件，越界一律当找不到。 */
  function resolve(pathname: string): { file: string } | { redirect: string } | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    const target = path.resolve(base, '.' + decoded);
    if (target !== base && !target.startsWith(base + path.sep)) return null;

    if (decoded.endsWith('/')) {
      const index = path.join(target, 'index.html');
      return isFile(index) ? { file: index } : null;
    }
    if (decoded.endsWith('.html')) {
      if (!isFile(target)) return null;
      const pretty = decoded.endsWith('/index.html') ? decoded.slice(0, -'index.html'.length) : decoded.slice(0, -5);
      return { redirect: pretty };
    }
    if (isFile(target)) return { file: target };
    if (isFile(target + '.html')) return { file: target + '.html' };
    if (isFile(path.join(target, 'index.html'))) return { redirect: decoded + '/' };
    return null;
  }

  return {
    async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const hit = resolve(url.pathname);
      if (!hit) return new Response(null, { status: 404 });
      if ('redirect' in hit) {
        return new Response(null, { status: 307, headers: { location: hit.redirect + url.search } });
      }
      const stat = fs.statSync(hit.file);
      const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      const headers = new Headers({
        'content-type': TYPES[path.extname(hit.file).toLowerCase()] ?? 'application/octet-stream',
        // 和 Workers 静态资源一样：每次都问一下有没有更新，没变就 304，改了代码不用强刷
        'cache-control': 'public, max-age=0, must-revalidate',
        etag,
      });
      if (request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers });
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
      return new Response(fs.readFileSync(hit.file), { status: 200, headers });
    },
  };
}
